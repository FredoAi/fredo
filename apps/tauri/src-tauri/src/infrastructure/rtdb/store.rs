//! RtdbStore — SQLite-authoritative storage for RTDB rows (Spec #2788, P1.2).
//!
//! Owns the `chat_rows` / `tool_use_rows` / `agent_session_rows` tables in the
//! SAME `fredo.db` as `AppStore`, `FeatureStore`, `SpanStore`, and
//! `ContractEventStore` (SpanStore pattern: own `Mutex<Connection>`, WAL,
//! schema via `ensure_schema()`). `telemetry_spans` is NEVER touched — the
//! RTDB is a read-only consumer of the telemetry pipeline, never a writer.
//!
//! ## Write model
//!
//! Upserts write the FULL row (`INSERT OR REPLACE` keyed on the composite
//! primary key `(session_id, correlation_id)`); `updated_at` is stamped by the
//! patch/merge layer before the row reaches the store. Writes land in batches
//! (one transaction per batch) driven by the write-behind task in
//! [`crate::infrastructure::rtdb::cache`].
//!
//! ## Durable per-key seq
//!
//! `seq` is monotonic per composite key `(session_id, correlation_id)` PER row
//! kind. [`RtdbStore::next_seq`] serves from an in-memory counter map that is
//! SEEDED from `MAX(seq)` in SQLite on first use of a key (and therefore on
//! every process start) — a restart over the same DB never resets the seq.
//! Gaps are acceptable (a shed storage write skips a seq value); monotonicity
//! is not.
//!
//! ## Retention
//!
//! Two AppStore KV knobs (the binding config-first mechanism, mirroring
//! `contracts.retention_days` / `tracing.retention_days`):
//! - [`RTDB_RETENTION_DAYS_KEY`] `rtdb.retention_days` (default
//!   [`RTDB_DEFAULT_RETENTION_DAYS`]) — age-based prune on `updated_at`
//! - [`RTDB_MAX_ROWS_KEY`] `rtdb.max_rows` (default [`RTDB_DEFAULT_MAX_ROWS`])
//!   — GLOBAL row cap across all three tables, oldest-`updated_at` first
//!
//! Pruning runs at app startup and on a 60-minute interval inside the
//! write-behind task; knobs are re-read fresh at every prune cycle. Since
//! P2.3, `prune` returns the evicted `(kind, key)` set — the routing layer
//! passes each eviction to the subscription registry for `kind: remove`
//! deliveries (R-2d: the ONLY remove producer).

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use crate::infrastructure::rtdb::project::{RowKey, RowSnapshot};
use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, RowState, ToolUseRow};

// ── Constants ────────────────────────────────────────────────────────────────

/// AppStore key: retention window in days for RTDB rows.
pub const RTDB_RETENTION_DAYS_KEY: &str = "rtdb.retention_days";
/// AppStore key: global row cap across all RTDB tables.
pub const RTDB_MAX_ROWS_KEY: &str = "rtdb.max_rows";
/// Default retention window (days).
pub const RTDB_DEFAULT_RETENTION_DAYS: i64 = 7;
/// Default global row cap.
pub const RTDB_DEFAULT_MAX_ROWS: i64 = 100_000;
/// Rows per prune delete batch.
const PRUNE_BATCH: i64 = 1000;

// ── Row kind ─────────────────────────────────────────────────────────────────

/// Which RTDB table a seq counter / upsert / prune concerns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RowKind {
    Chat,
    ToolUse,
    AgentSession,
}

impl RowKind {
    /// Backing table name.
    pub fn table(self) -> &'static str {
        match self {
            RowKind::Chat => "chat_rows",
            RowKind::ToolUse => "tool_use_rows",
            RowKind::AgentSession => "agent_session_rows",
        }
    }
}

/// Parse the stored snake_case `state` machine name back to a [`RowState`].
/// The error type is `rusqlite::Error` so the row-mapping closures can `?` it
/// directly.
fn parse_row_state(s: &str) -> Result<RowState, rusqlite::Error> {
    match s {
        "init" => Ok(RowState::Init),
        "update" => Ok(RowState::Update),
        "response" => Ok(RowState::Response),
        "timeout" => Ok(RowState::Timeout),
        "error" => Ok(RowState::Error),
        other => Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown rtdb row state: {other}"),
            ),
        ))),
    }
}

/// An owned row of any RTDB kind — the snapshot-select result element
/// (P2.3 replay). Matches the [`RowSnapshot`] variant rules.
#[derive(Clone, Debug, PartialEq)]
pub enum StoredRow {
    Chat(ChatRow),
    ToolUse(ToolUseRow),
    AgentSession(AgentSessionRow),
}

impl StoredRow {
    /// The composite row identity.
    pub fn key(&self) -> RowKey {
        let (session_id, correlation_id) = match self {
            StoredRow::Chat(row) => (&row.session_id, &row.correlation_id),
            StoredRow::ToolUse(row) => (&row.session_id, &row.correlation_id),
            StoredRow::AgentSession(row) => (&row.session_id, &row.correlation_id),
        };
        RowKey {
            session_id: session_id.clone(),
            correlation_id: correlation_id.clone(),
        }
    }

    /// Borrowed matcher/projector view.
    pub fn as_snapshot(&self) -> RowSnapshot<'_> {
        match self {
            StoredRow::Chat(row) => RowSnapshot::Chat(row),
            StoredRow::ToolUse(row) => RowSnapshot::ToolUse(row),
            StoredRow::AgentSession(row) => RowSnapshot::AgentSession(row),
        }
    }
}

/// A key evicted by a retention prune — routed to the subscription registry
/// for `kind: remove` deliveries (P2.3, R-2d: the ONLY remove producer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvictedKey {
    pub kind: RowKind,
    pub session_id: String,
    pub correlation_id: String,
}

/// The result of one prune cycle: rows deleted and the per-row eviction set.
#[derive(Clone, Debug, Default)]
pub struct PruneOutcome {
    pub deleted: u64,
    pub evicted: Vec<EvictedKey>,
}

/// Run a `DELETE ... RETURNING session_id, correlation_id` and collect the
/// evicted keys tagged with `kind`. `rusqlite::execute` rejects statements
/// that return rows, so the DELETE is stepped manually.
fn delete_returning(
    conn: &Connection,
    sql: &str,
    kind: RowKind,
    params: impl rusqlite::Params,
    evicted: &mut Vec<EvictedKey>,
) -> Result<u64> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query(params)?;
    let mut count = 0u64;
    while let Some(row) = rows.next()? {
        evicted.push(EvictedKey {
            kind,
            session_id: row.get(0)?,
            correlation_id: row.get(1)?,
        });
        count += 1;
    }
    Ok(count)
}

/// Row mapper shared by the per-key selects and the snapshot select.
fn chat_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatRow> {
    let state: String = row.get(6)?;
    Ok(ChatRow {
        session_id: row.get(0)?,
        correlation_id: row.get(1)?,
        seq: row.get(2)?,
        started_at_ns: row.get(3)?,
        ended_at_ns: row.get(4)?,
        updated_at: row.get(5)?,
        state: parse_row_state(&state)?,
        user_message: row.get(7)?,
        agent_reply: row.get(8)?,
        prompt_tokens: row.get(9)?,
        completion_tokens: row.get(10)?,
        cache_read_tokens: row.get(11)?,
        cost_usd: row.get(12)?,
        model: row.get(13)?,
        parent_session_id: row.get(14)?,
        composited_child_session_id: row.get(15)?,
        raw_json: row.get(16)?,
    })
}

/// Row mapper shared by the per-key selects and the snapshot select.
fn tool_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolUseRow> {
    let state: String = row.get(6)?;
    Ok(ToolUseRow {
        session_id: row.get(0)?,
        correlation_id: row.get(1)?,
        seq: row.get(2)?,
        started_at_ns: row.get(3)?,
        ended_at_ns: row.get(4)?,
        updated_at: row.get(5)?,
        state: parse_row_state(&state)?,
        tool_name: row.get(7)?,
        tool_success: row.get(8)?,
        tool_error: row.get(9)?,
        duration_ms: row.get(10)?,
        tool_input_json: row.get(11)?,
        tool_output_json: row.get(12)?,
        is_subagent: row.get(13)?,
        raw_json: row.get(14)?,
    })
}

/// Row mapper shared by the per-key selects and the snapshot select.
fn agent_session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSessionRow> {
    let state: String = row.get(6)?;
    Ok(AgentSessionRow {
        session_id: row.get(0)?,
        correlation_id: row.get(1)?,
        seq: row.get(2)?,
        started_at_ns: row.get(3)?,
        ended_at_ns: row.get(4)?,
        updated_at: row.get(5)?,
        state: parse_row_state(&state)?,
        total_tokens: row.get(7)?,
        total_messages: row.get(8)?,
        total_cost_usd: row.get(9)?,
        agent_name: row.get(10)?,
        raw_json: row.get(11)?,
    })
}

// ── RtdbStore ────────────────────────────────────────────────────────────────

/// SQLite-backed authoritative store for RTDB rows.
///
/// Uses the same `fredo.db` as `AppStore` / `SpanStore` /
/// `ContractEventStore`, with its own `Mutex<Connection>` for thread-safe
/// access. Owns the three `*_rows` tables — it never touches
/// `telemetry_spans` or any other store's tables.
pub struct RtdbStore {
    conn: Mutex<Connection>,
    /// Per-`(kind, session_id, correlation_id)` in-memory seq counters,
    /// seeded from `MAX(seq)` in SQLite on first use (durable semantics).
    seq_counters: Mutex<HashMap<(RowKind, String, String), i64>>,
}

impl RtdbStore {
    /// Open (or create) `fredo.db` with WAL journal mode + `synchronous=NORMAL`
    /// (the durability/perf point WAL is designed for — commits no longer fsync
    /// per transaction, crash safety is preserved up to a power cut).
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("fredo.db");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
        Ok(RtdbStore {
            conn: Mutex::new(conn),
            seq_counters: Mutex::new(HashMap::new()),
        })
    }

    /// Create the three RTDB tables and their indexes if they don't exist.
    pub fn ensure_schema(&self) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_rows (
                session_id                 TEXT NOT NULL,
                correlation_id             TEXT NOT NULL,
                seq                        INTEGER NOT NULL,
                started_at_ns              INTEGER,
                ended_at_ns                INTEGER,
                updated_at                 TEXT NOT NULL,
                state                      TEXT NOT NULL,
                user_message               TEXT,
                agent_reply                TEXT,
                prompt_tokens              INTEGER,
                completion_tokens          INTEGER,
                cache_read_tokens          INTEGER,
                cost_usd                   REAL,
                model                      TEXT,
                parent_session_id          TEXT,
                composited_child_session_id TEXT,
                raw_json                   TEXT NOT NULL,
                PRIMARY KEY (session_id, correlation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_started
                ON chat_rows(started_at_ns);
            CREATE INDEX IF NOT EXISTS idx_chat_session_time
                ON chat_rows(session_id, started_at_ns);
            CREATE INDEX IF NOT EXISTS idx_chat_updated
                ON chat_rows(updated_at);

            CREATE TABLE IF NOT EXISTS tool_use_rows (
                session_id                 TEXT NOT NULL,
                correlation_id             TEXT NOT NULL,
                seq                        INTEGER NOT NULL,
                started_at_ns              INTEGER,
                ended_at_ns                INTEGER,
                updated_at                 TEXT NOT NULL,
                state                      TEXT NOT NULL,
                tool_name                  TEXT,
                tool_success               INTEGER,
                tool_error                 TEXT,
                duration_ms                INTEGER,
                tool_input_json            TEXT,
                tool_output_json           TEXT,
                is_subagent                INTEGER,
                raw_json                   TEXT NOT NULL,
                PRIMARY KEY (session_id, correlation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_tool_started
                ON tool_use_rows(started_at_ns);
            CREATE INDEX IF NOT EXISTS idx_tool_session_time
                ON tool_use_rows(session_id, started_at_ns);
            CREATE INDEX IF NOT EXISTS idx_tool_updated
                ON tool_use_rows(updated_at);

            CREATE TABLE IF NOT EXISTS agent_session_rows (
                session_id                 TEXT NOT NULL,
                correlation_id             TEXT NOT NULL,
                seq                        INTEGER NOT NULL,
                started_at_ns              INTEGER,
                ended_at_ns                INTEGER,
                updated_at                 TEXT NOT NULL,
                state                      TEXT NOT NULL,
                total_tokens               INTEGER,
                total_messages             INTEGER,
                total_cost_usd             REAL,
                agent_name                 TEXT,
                raw_json                   TEXT NOT NULL,
                PRIMARY KEY (session_id, correlation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_started
                ON agent_session_rows(started_at_ns);
            CREATE INDEX IF NOT EXISTS idx_agent_session_time
                ON agent_session_rows(session_id, started_at_ns);
            CREATE INDEX IF NOT EXISTS idx_agent_updated
                ON agent_session_rows(updated_at);",
        )?;
        Ok(())
    }

    // ── Upserts (full-row writes, batched in one transaction) ────────────────

    /// Upsert a batch of [`ChatRow`]s in one transaction. Writes the FULL row
    /// (`INSERT OR REPLACE` on the composite PK). Returns the number of rows
    /// written.
    pub fn upsert_chat_rows(&self, rows: &[ChatRow]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        let conn = self.lock_conn();
        conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<usize> {
            let mut total = 0usize;
            for row in rows {
                conn.execute(
                    "INSERT OR REPLACE INTO chat_rows
                     (session_id, correlation_id, seq, started_at_ns, ended_at_ns,
                      updated_at, state, user_message, agent_reply, prompt_tokens,
                      completion_tokens, cache_read_tokens, cost_usd, model,
                      parent_session_id, composited_child_session_id, raw_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                    params![
                        row.session_id,
                        row.correlation_id,
                        row.seq,
                        row.started_at_ns,
                        row.ended_at_ns,
                        row.updated_at,
                        row.state.as_str(),
                        row.user_message,
                        row.agent_reply,
                        row.prompt_tokens,
                        row.completion_tokens,
                        row.cache_read_tokens,
                        row.cost_usd,
                        row.model,
                        row.parent_session_id,
                        row.composited_child_session_id,
                        row.raw_json,
                    ],
                )?;
                total += 1;
            }
            Ok(total)
        })();
        match result {
            Ok(total) => {
                conn.execute_batch("COMMIT;")?;
                Ok(total)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    /// Upsert a batch of [`ToolUseRow`]s in one transaction.
    pub fn upsert_tool_use_rows(&self, rows: &[ToolUseRow]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        let conn = self.lock_conn();
        conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<usize> {
            let mut total = 0usize;
            for row in rows {
                conn.execute(
                    "INSERT OR REPLACE INTO tool_use_rows
                     (session_id, correlation_id, seq, started_at_ns, ended_at_ns,
                      updated_at, state, tool_name, tool_success, tool_error,
                      duration_ms, tool_input_json, tool_output_json, is_subagent, raw_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        row.session_id,
                        row.correlation_id,
                        row.seq,
                        row.started_at_ns,
                        row.ended_at_ns,
                        row.updated_at,
                        row.state.as_str(),
                        row.tool_name,
                        row.tool_success,
                        row.tool_error,
                        row.duration_ms,
                        row.tool_input_json,
                        row.tool_output_json,
                        row.is_subagent,
                        row.raw_json,
                    ],
                )?;
                total += 1;
            }
            Ok(total)
        })();
        match result {
            Ok(total) => {
                conn.execute_batch("COMMIT;")?;
                Ok(total)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    /// Upsert a batch of [`AgentSessionRow`]s in one transaction.
    pub fn upsert_agent_session_rows(&self, rows: &[AgentSessionRow]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        let conn = self.lock_conn();
        conn.execute_batch("BEGIN TRANSACTION;")?;
        let result = (|| -> Result<usize> {
            let mut total = 0usize;
            for row in rows {
                conn.execute(
                    "INSERT OR REPLACE INTO agent_session_rows
                     (session_id, correlation_id, seq, started_at_ns, ended_at_ns,
                      updated_at, state, total_tokens, total_messages,
                      total_cost_usd, agent_name, raw_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        row.session_id,
                        row.correlation_id,
                        row.seq,
                        row.started_at_ns,
                        row.ended_at_ns,
                        row.updated_at,
                        row.state.as_str(),
                        row.total_tokens,
                        row.total_messages,
                        row.total_cost_usd,
                        row.agent_name,
                        row.raw_json,
                    ],
                )?;
                total += 1;
            }
            Ok(total)
        })();
        match result {
            Ok(total) => {
                conn.execute_batch("COMMIT;")?;
                Ok(total)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

// ── Selects (cache-miss reload + snapshot path — SQLite is authoritative) ──

/// Load one chat row by composite key.
pub fn get_chat_row(&self, session_id: &str, correlation_id: &str) -> Result<Option<ChatRow>> {
    let conn = self.lock_conn();
    let result = conn.query_row(
        "SELECT session_id, correlation_id, seq, started_at_ns, ended_at_ns,
                updated_at, state, user_message, agent_reply, prompt_tokens,
                completion_tokens, cache_read_tokens, cost_usd, model,
                parent_session_id, composited_child_session_id, raw_json
         FROM chat_rows WHERE session_id = ?1 AND correlation_id = ?2",
        params![session_id, correlation_id],
        chat_from_row,
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Load one tool-use row by composite key.
pub fn get_tool_use_row(
    &self,
    session_id: &str,
    correlation_id: &str,
) -> Result<Option<ToolUseRow>> {
    let conn = self.lock_conn();
    let result = conn.query_row(
        "SELECT session_id, correlation_id, seq, started_at_ns, ended_at_ns,
                updated_at, state, tool_name, tool_success, tool_error,
                duration_ms, tool_input_json, tool_output_json, is_subagent, raw_json
         FROM tool_use_rows WHERE session_id = ?1 AND correlation_id = ?2",
        params![session_id, correlation_id],
        tool_from_row,
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Load one agent-session row by composite key.
pub fn get_agent_session_row(
    &self,
    session_id: &str,
    correlation_id: &str,
) -> Result<Option<AgentSessionRow>> {
    let conn = self.lock_conn();
    let result = conn.query_row(
        "SELECT session_id, correlation_id, seq, started_at_ns, ended_at_ns,
                updated_at, state, total_tokens, total_messages,
                total_cost_usd, agent_name, raw_json
         FROM agent_session_rows WHERE session_id = ?1 AND correlation_id = ?2",
        params![session_id, correlation_id],
        agent_session_from_row,
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Snapshot select for the replay path (P2.3): every row of `kind` matching
/// the caller-built WHERE clause (`where_sql` is appended verbatim after
/// `WHERE`; pass "1=1" for an unconstrained select; `?N` placeholders bind
/// positionally against `params`). The caller builds the clause from
/// schema-validated args against the typed column lists — never from raw
/// user input.
pub fn select_snapshot(
    &self,
    kind: RowKind,
    where_sql: &str,
    params: Vec<rusqlite::types::Value>,
) -> Result<Vec<StoredRow>> {
    let columns = match kind {
        RowKind::Chat => {
            "session_id, correlation_id, seq, started_at_ns, ended_at_ns,
             updated_at, state, user_message, agent_reply, prompt_tokens,
             completion_tokens, cache_read_tokens, cost_usd, model,
             parent_session_id, composited_child_session_id, raw_json"
        }
        RowKind::ToolUse => {
            "session_id, correlation_id, seq, started_at_ns, ended_at_ns,
             updated_at, state, tool_name, tool_success, tool_error,
             duration_ms, tool_input_json, tool_output_json, is_subagent, raw_json"
        }
        RowKind::AgentSession => {
            "session_id, correlation_id, seq, started_at_ns, ended_at_ns,
             updated_at, state, total_tokens, total_messages,
             total_cost_usd, agent_name, raw_json"
        }
    };
    let sql = format!(
        "SELECT {columns} FROM {} WHERE {where_sql}",
        kind.table()
    );
    let conn = self.lock_conn();
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(match kind {
            RowKind::Chat => StoredRow::Chat(chat_from_row(row)?),
            RowKind::ToolUse => StoredRow::ToolUse(tool_from_row(row)?),
            RowKind::AgentSession => StoredRow::AgentSession(agent_session_from_row(row)?),
        });
    }
    Ok(out)
}

    // ── Durable per-key seq ─────────────────────────────────────────────────

    /// Next monotonic `seq` for the composite key, per row kind.
    ///
    /// Served from an in-memory counter that is seeded from `MAX(seq)` in
    /// SQLite on first use of the key — so a fresh store instance over the
    /// same DB (a "restart") continues where the previous process left off.
    pub fn next_seq(
        &self,
        kind: RowKind,
        session_id: &str,
        correlation_id: &str,
    ) -> Result<i64> {
        let key = (kind, session_id.to_string(), correlation_id.to_string());
        {
            let mut counters = self.lock_seq();
            if let Some(value) = counters.get_mut(&key) {
                *value += 1;
                return Ok(*value);
            }
        }
        // Seed from storage OUTSIDE the counter lock (no nested locks).
        let seeded = self.max_seq(kind, session_id, correlation_id)?;
        let mut counters = self.lock_seq();
        // Double-check: a concurrent caller may have seeded the same key.
        match counters.get_mut(&key) {
            Some(value) => {
                *value += 1;
                Ok(*value)
            }
            None => {
                let next = seeded + 1;
                counters.insert(key, next);
                Ok(next)
            }
        }
    }

    /// `MAX(seq)` for the composite key from SQLite (0 when the key is unknown).
    fn max_seq(&self, kind: RowKind, session_id: &str, correlation_id: &str) -> Result<i64> {
        let conn = self.lock_conn();
        let max: i64 = conn.query_row(
            &format!(
                "SELECT COALESCE(MAX(seq), 0) FROM {} WHERE session_id = ?1 AND correlation_id = ?2",
                kind.table()
            ),
            params![session_id, correlation_id],
            |row| row.get(0),
        )?;
        Ok(max)
    }

    // ── Retention prune ─────────────────────────────────────────────────────

    /// Retention prune: (1) delete rows whose `updated_at` is older than
    /// `retention_days`, per table; then (2) enforce the `max_rows` GLOBAL cap
    /// across all three tables by deleting the oldest-`updated_at` rows first.
    /// Deletes run in 1000-row batches. Returns the deleted count AND the
    /// evicted `(kind, key)` set — P2.3 routes each eviction through the
    /// subscription registry as a `kind: remove` delivery (R-2d).
    pub fn prune(&self, retention_days: i64, max_rows: i64) -> Result<PruneOutcome> {
        let cutoff = (Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
        let conn = self.lock_conn();
        let mut outcome = PruneOutcome::default();

        // 1. Age-based prune (updated_at index per table). The DELETE ...
        //    RETURNING captures exactly which rows were evicted.
        for kind in [RowKind::Chat, RowKind::ToolUse, RowKind::AgentSession] {
            let table = kind.table();
            loop {
                let deleted = delete_returning(
                    &conn,
                    &format!(
                        "DELETE FROM {table} WHERE (session_id, correlation_id) IN (
                            SELECT session_id, correlation_id FROM {table}
                            WHERE updated_at < ?1 LIMIT ?2
                        ) RETURNING session_id, correlation_id"
                    ),
                    kind,
                    params![cutoff, PRUNE_BATCH],
                    &mut outcome.evicted,
                )?;
                if deleted == 0 {
                    break;
                }
                outcome.deleted += deleted;
                conn.execute_batch("PRAGMA incremental_vacuum;")?;
            }
        }

        // 2. Global row-cap prune across all three tables, oldest-first.
        //    The count is re-read each batch so concurrent inserts are
        //    respected; the newest rows are always the last to go.
        loop {
            let count: i64 = conn.query_row(
                "SELECT (SELECT COUNT(*) FROM chat_rows)
                       + (SELECT COUNT(*) FROM tool_use_rows)
                       + (SELECT COUNT(*) FROM agent_session_rows)",
                [],
                |row| row.get(0),
            )?;
            let excess = count - max_rows;
            if excess <= 0 {
                break;
            }
            let batch = excess.min(PRUNE_BATCH);
            // Materialize the eviction candidate keys ONCE so the three
            // per-table deletes all target the SAME fixed batch (recomputing
            // the subquery per table would re-select after earlier deletes
            // and over-evict). Each candidate row belongs to exactly one
            // table, so the union of the three deletes removes ≤ `batch` rows.
            conn.execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS prune_batch (
                    session_id     TEXT NOT NULL,
                    correlation_id TEXT NOT NULL,
                    PRIMARY KEY (session_id, correlation_id)
                );
                DELETE FROM prune_batch;",
            )?;
            conn.execute(
                "INSERT INTO prune_batch (session_id, correlation_id)
                 SELECT session_id, correlation_id FROM (
                    SELECT session_id, correlation_id, updated_at, seq FROM chat_rows
                    UNION ALL
                    SELECT session_id, correlation_id, updated_at, seq FROM tool_use_rows
                    UNION ALL
                    SELECT session_id, correlation_id, updated_at, seq FROM agent_session_rows
                 ) ORDER BY updated_at ASC, seq ASC LIMIT ?1",
                params![batch],
            )?;
            let deleted_chat = delete_returning(
                &conn,
                "DELETE FROM chat_rows WHERE (session_id, correlation_id) IN (
                    SELECT session_id, correlation_id FROM prune_batch
                ) RETURNING session_id, correlation_id",
                RowKind::Chat,
                [],
                &mut outcome.evicted,
            )?;
            let deleted_tool = delete_returning(
                &conn,
                "DELETE FROM tool_use_rows WHERE (session_id, correlation_id) IN (
                    SELECT session_id, correlation_id FROM prune_batch
                ) RETURNING session_id, correlation_id",
                RowKind::ToolUse,
                [],
                &mut outcome.evicted,
            )?;
            let deleted_agent = delete_returning(
                &conn,
                "DELETE FROM agent_session_rows WHERE (session_id, correlation_id) IN (
                    SELECT session_id, correlation_id FROM prune_batch
                ) RETURNING session_id, correlation_id",
                RowKind::AgentSession,
                [],
                &mut outcome.evicted,
            )?;
            let _ = conn.execute_batch("DELETE FROM prune_batch;");
            let deleted = deleted_chat + deleted_tool + deleted_agent;
            if deleted == 0 {
                break;
            }
            outcome.deleted += deleted;
            conn.execute_batch("PRAGMA incremental_vacuum;")?;
        }

        Ok(outcome)
    }

    /// Row counts per table `(chat, tool_use, agent_session)` — test/diagnostic.
    pub fn row_counts(&self) -> Result<(i64, i64, i64)> {
        let conn = self.lock_conn();
        let chat: i64 =
            conn.query_row("SELECT COUNT(*) FROM chat_rows", [], |row| row.get(0))?;
        let tool: i64 = conn.query_row("SELECT COUNT(*) FROM tool_use_rows", [], |row| {
            row.get(0)
        })?;
        let agent: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_session_rows",
            [],
            |row| row.get(0),
        )?;
        Ok((chat, tool, agent))
    }

    // ── Lock helpers (poison recovery — no unwrap) ──────────────────────────

    fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_seq(&self) -> MutexGuard<'_, HashMap<(RowKind, String, String), i64>> {
        match self.seq_counters.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_store() -> (tempfile::TempDir, RtdbStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = RtdbStore::open(dir.path().to_path_buf()).expect("open");
        store.ensure_schema().expect("schema");
        (dir, store)
    }

    fn chat_row(session: &str, corr: &str, seq: i64, updated_at: &str) -> ChatRow {
        ChatRow {
            session_id: session.to_string(),
            correlation_id: corr.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: updated_at.to_string(),
            state: RowState::Init,
            user_message: Some("fix the bug".to_string()),
            agent_reply: None,
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cost_usd: None,
            model: None,
            parent_session_id: None,
            composited_child_session_id: None,
            raw_json: "{}".to_string(),
        }
    }

    fn tool_row(session: &str, corr: &str, seq: i64, updated_at: &str) -> ToolUseRow {
        ToolUseRow {
            session_id: session.to_string(),
            correlation_id: corr.to_string(),
            seq,
            started_at_ns: Some(2_000),
            ended_at_ns: Some(3_000),
            updated_at: updated_at.to_string(),
            state: RowState::Response,
            tool_name: Some("bash".to_string()),
            tool_success: Some(false),
            tool_error: Some("exit code 1".to_string()),
            duration_ms: Some(1_000),
            tool_input_json: Some(r#"{"command":"ls"}"#.to_string()),
            tool_output_json: None,
            is_subagent: Some(true),
            raw_json: "{}".to_string(),
        }
    }

    fn session_row(session: &str, corr: &str, seq: i64, updated_at: &str) -> AgentSessionRow {
        AgentSessionRow {
            session_id: session.to_string(),
            correlation_id: corr.to_string(),
            seq,
            started_at_ns: Some(3_000),
            ended_at_ns: Some(9_000),
            updated_at: updated_at.to_string(),
            state: RowState::Update,
            total_tokens: Some(23_262),
            total_messages: Some(57),
            total_cost_usd: Some(0.512),
            agent_name: Some("self-improver".to_string()),
            raw_json: "{}".to_string(),
        }
    }

    // ── DDL ─────────────────────────────────────────────────────────────────

    #[test]
    fn ensure_schema_creates_all_three_tables_and_indexes() {
        let (_dir, store) = make_store();
        let conn = store.lock_conn();
        for table in ["chat_rows", "tool_use_rows", "agent_session_rows"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .expect("query");
            assert_eq!(count, 1, "{table} table should exist");
        }
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index'")
            .expect("prepare");
        let indexes: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query_map")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        for expected in [
            "idx_chat_started",
            "idx_chat_session_time",
            "idx_chat_updated",
            "idx_tool_started",
            "idx_tool_session_time",
            "idx_tool_updated",
            "idx_agent_started",
            "idx_agent_session_time",
            "idx_agent_updated",
        ] {
            assert!(indexes.contains(&expected.to_string()), "index {expected} should exist");
        }
    }

    // ── Round-trip upsert/select per row type ───────────────────────────────

    #[test]
    fn chat_row_round_trips_through_upsert_and_select() {
        let (_dir, store) = make_store();
        let row = ChatRow {
            state: RowState::Response,
            agent_reply: Some("full reply".to_string()),
            prompt_tokens: Some(25),
            completion_tokens: Some(75),
            cache_read_tokens: Some(177),
            cost_usd: Some(0.0234),
            model: Some("claude-sonnet-4".to_string()),
            parent_session_id: Some("ses_parent".to_string()),
            composited_child_session_id: Some("ses_child".to_string()),
            ended_at_ns: Some(9_000),
            ..chat_row("ses_a", "ses_a_1", 4, "2026-08-31T00:00:02+00:00")
        };
        let written = store.upsert_chat_rows(&[row.clone()]).expect("upsert");
        assert_eq!(written, 1);

        let loaded = store
            .get_chat_row("ses_a", "ses_a_1")
            .expect("select")
            .expect("row exists");
        assert_eq!(loaded, row);
        assert!(store.get_chat_row("ses_a", "nope").expect("select").is_none());
    }

    #[test]
    fn tool_use_row_round_trips_through_upsert_and_select() {
        let (_dir, store) = make_store();
        let row = tool_row("ses_a", "ses_a_2", 2, "2026-08-31T00:00:03+00:00");
        let written = store.upsert_tool_use_rows(&[row.clone()]).expect("upsert");
        assert_eq!(written, 1);

        let loaded = store
            .get_tool_use_row("ses_a", "ses_a_2")
            .expect("select")
            .expect("row exists");
        assert_eq!(loaded, row, "tool_success=false and None fields survive the round trip");
        assert!(store.get_tool_use_row("ses_a", "nope").expect("select").is_none());
    }

    #[test]
    fn agent_session_row_round_trips_through_upsert_and_select() {
        let (_dir, store) = make_store();
        let row = session_row("ses_a", "ses_a", 3, "2026-08-31T00:00:04+00:00");
        let written = store.upsert_agent_session_rows(&[row.clone()]).expect("upsert");
        assert_eq!(written, 1);

        let loaded = store
            .get_agent_session_row("ses_a", "ses_a")
            .expect("select")
            .expect("row exists");
        assert_eq!(loaded, row);
        assert!(store.get_agent_session_row("ses_a", "nope").expect("select").is_none());
    }

    #[test]
    fn upsert_replaces_the_full_row_on_same_key() {
        let (_dir, store) = make_store();
        let v1 = chat_row("ses_a", "ses_a_1", 1, "2026-08-31T00:00:00+00:00");
        store.upsert_chat_rows(&[v1]).expect("upsert v1");

        let mut v2 = chat_row("ses_a", "ses_a_1", 2, "2026-08-31T00:00:01+00:00");
        v2.state = RowState::Response;
        v2.agent_reply = Some("done".to_string());
        store.upsert_chat_rows(&[v2.clone()]).expect("upsert v2");

        let (chat, _, _) = store.row_counts().expect("counts");
        assert_eq!(chat, 1, "same composite key upserts in place");
        let loaded = store
            .get_chat_row("ses_a", "ses_a_1")
            .expect("select")
            .expect("row exists");
        assert_eq!(loaded, v2, "the newest full row wins");
    }

    #[test]
    fn batch_upserts_are_counted_and_empty_slices_are_noops() {
        let (_dir, store) = make_store();
        let rows: Vec<ChatRow> = (0..5)
            .map(|i| chat_row("ses_b", &format!("ses_b_{i}"), i, "2026-08-31T00:00:00+00:00"))
            .collect();
        assert_eq!(store.upsert_chat_rows(&rows).expect("upsert"), 5);
        assert_eq!(store.upsert_chat_rows(&[]).expect("noop"), 0);
        assert_eq!(store.upsert_tool_use_rows(&[]).expect("noop"), 0);
        assert_eq!(store.upsert_agent_session_rows(&[]).expect("noop"), 0);
        let (chat, _, _) = store.row_counts().expect("counts");
        assert_eq!(chat, 5);
    }

    // ── Durable per-key seq ─────────────────────────────────────────────────

    #[test]
    fn next_seq_is_monotonic_per_composite_key_and_independent_across_keys() {
        let (_dir, store) = make_store();
        // Seed rows so MAX(seq) is non-trivial.
        store
            .upsert_chat_rows(&[chat_row("ses_a", "ses_a_1", 3, "t")])
            .expect("upsert");

        assert_eq!(store.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq"), 4);
        assert_eq!(store.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq"), 5);
        // A different key counts independently from 0.
        assert_eq!(store.next_seq(RowKind::Chat, "ses_a", "ses_a_2").expect("seq"), 1);
        // A different row kind counts independently even on the same key.
        assert_eq!(store.next_seq(RowKind::ToolUse, "ses_a", "ses_a_1").expect("seq"), 1);
    }

    #[test]
    fn seq_is_durable_across_a_restart_over_the_same_db() {
        let (dir, store) = make_store();
        for i in 1..=3 {
            store
                .upsert_chat_rows(&[chat_row("ses_a", "ses_a_1", i, "t")])
                .expect("upsert");
            assert_eq!(
                store.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq"),
                i + 1
            );
        }
        drop(store);

        // "Restart": a brand-new store instance over the same fredo.db.
        let reopened = RtdbStore::open(dir.path().to_path_buf()).expect("reopen");
        reopened.ensure_schema().expect("schema");
        assert_eq!(
            reopened.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq"),
            4,
            "next_seq must seed from MAX(seq) in storage — never reset on restart"
        );
    }

    #[test]
    fn seq_does_not_reset_when_storage_writes_are_shed() {
        // Simulate a shed write: seq advances without a storage upsert. The
        // in-memory counter keeps moving forward; a restart reseeds from
        // MAX(seq) (the last PERSISTED value) and stays monotonic in storage.
        let (dir, store) = make_store();
        store
            .upsert_chat_rows(&[chat_row("ses_a", "ses_a_1", 1, "t")])
            .expect("upsert");
        let after_persist = store.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq");
        assert_eq!(after_persist, 2);
        // Shed the write for seq 2 — no upsert — then allocate seq 3.
        assert_eq!(store.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq"), 3);
        drop(store);

        let reopened = RtdbStore::open(dir.path().to_path_buf()).expect("reopen");
        reopened.ensure_schema().expect("schema");
        // Restart reseeds from MAX(seq) — the last PERSISTED value (1). The
        // shed seq 2 was never written, so storage continues monotonically
        // from it; the un-persisted in-memory seq 3 simply becomes a gap.
        assert_eq!(
            reopened.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq"),
            2,
            "never resets below the persisted MAX(seq) — monotonicity in storage holds"
        );
        // ...and the counter keeps moving forward from there.
        assert_eq!(
            reopened.next_seq(RowKind::Chat, "ses_a", "ses_a_1").expect("seq"),
            3,
            "gaps are acceptable; monotonicity is not violated"
        );
    }

    // ── Retention prune: age + global cap ───────────────────────────────────

    #[test]
    fn prune_deletes_rows_older_than_retention_window() {
        let (_dir, store) = make_store();
        let old = chat_row("ses_old", "ses_old", 1, "2020-01-01T00:00:00+00:00");
        let fresh = chat_row("ses_fresh", "ses_fresh", 1, "2026-08-31T00:00:00+00:00");
        store.upsert_chat_rows(&[old, fresh]).expect("upsert");
        store
            .upsert_tool_use_rows(&[tool_row("ses_old", "t_old", 1, "2020-01-01T00:00:00+00:00")])
            .expect("upsert");

        let outcome = store.prune(7, 100_000).expect("prune");
        assert_eq!(outcome.deleted, 2, "one aged chat row + one aged tool row");
        assert_eq!(outcome.evicted.len(), 2, "each deletion is reported as an eviction");
        let kinds: Vec<(RowKind, String, String)> = outcome
            .evicted
            .iter()
            .map(|e| (e.kind, e.session_id.clone(), e.correlation_id.clone()))
            .collect();
        assert!(kinds.contains(&(RowKind::Chat, "ses_old".to_string(), "ses_old".to_string())));
        assert!(kinds.contains(&(RowKind::ToolUse, "ses_old".to_string(), "t_old".to_string())));
        assert!(
            !kinds.iter().any(|(_, sid, _)| sid == "ses_fresh"),
            "the fresh row survives and is never reported evicted"
        );

        let (chat, tool, _) = store.row_counts().expect("counts");
        assert_eq!(chat, 1, "fresh chat row survives");
        assert_eq!(tool, 0, "aged tool row is gone");
        assert!(
            store.get_chat_row("ses_fresh", "ses_fresh").expect("select").is_some(),
            "fresh row still selectable"
        );
    }

    #[test]
    fn prune_enforces_the_global_cap_oldest_first_across_tables() {
        let (_dir, store) = make_store();
        // 4 rows total across two tables; cap at 2 → the 2 oldest globally go.
        store
            .upsert_chat_rows(&[
                chat_row("s", "oldest", 1, "2020-01-01T00:00:00+00:00"),
                chat_row("s", "newest", 2, "2026-08-31T00:00:00+00:00"),
            ])
            .expect("upsert");
        store
            .upsert_tool_use_rows(&[
                tool_row("s", "middle", 1, "2024-01-01T00:00:00+00:00"),
                tool_row("s", "second", 2, "2026-01-01T00:00:00+00:00"),
            ])
            .expect("upsert");

        let outcome = store.prune(365, 2).expect("prune");
        assert_eq!(outcome.deleted, 2, "cap 4→2 deletes the two oldest rows globally");
        let kinds: Vec<(RowKind, String)> = outcome
            .evicted
            .iter()
            .map(|e| (e.kind, e.correlation_id.clone()))
            .collect();
        assert!(
            kinds.contains(&(RowKind::Chat, "oldest".to_string())),
            "cap-prune evictions are tagged with the table they were deleted from"
        );
        assert!(kinds.contains(&(RowKind::ToolUse, "middle".to_string())));

        assert!(store.get_chat_row("s", "oldest").expect("select").is_none(), "oldest gone");
        assert!(store.get_tool_use_row("s", "middle").expect("select").is_none(), "middle gone");
        assert!(store.get_chat_row("s", "newest").expect("select").is_some(), "newest survives");
        assert!(store.get_tool_use_row("s", "second").expect("select").is_some(), "second survives");
    }

    #[test]
    fn prune_at_exact_cap_and_under_limits_deletes_nothing() {
        let (_dir, store) = make_store();
        store
            .upsert_chat_rows(&[
                chat_row("s", "a", 1, "2026-08-31T00:00:00+00:00"),
                chat_row("s", "b", 2, "2026-08-31T00:00:01+00:00"),
            ])
            .expect("upsert");

        assert_eq!(store.prune(365, 2).expect("prune").deleted, 0, "exactly-at-cap: no off-by-one");
        assert_eq!(store.prune(365, 100_000).expect("prune").deleted, 0);
        assert_eq!(
            store.prune(7, 100_000).expect("prune").deleted,
            0,
            "fresh rows survive age prune"
        );
        let (chat, _, _) = store.row_counts().expect("counts");
        assert_eq!(chat, 2);
    }

    // ── Snapshot select (P2.3 replay) ────────────────────────────────────────

    #[test]
    fn select_snapshot_returns_all_rows_of_a_kind_matching_the_where_clause() {
        let (_dir, store) = make_store();
        let mut hit = chat_row("s", "a", 1, "2026-08-31T00:00:00+00:00");
        hit.prompt_tokens = Some(25);
        let mut miss = chat_row("s", "b", 1, "2026-08-31T00:00:00+00:00");
        miss.prompt_tokens = Some(0);
        let tool = tool_row("s", "t", 1, "2026-08-31T00:00:00+00:00");
        store.upsert_chat_rows(&[hit.clone(), miss]).expect("upsert");
        store.upsert_tool_use_rows(&[tool]).expect("upsert");

        // Unconstrained select per kind.
        let chats = store.select_snapshot(RowKind::Chat, "1=1", Vec::new()).expect("select");
        assert_eq!(chats.len(), 2, "snapshot select never crosses row kinds");
        assert!(matches!(chats[0], StoredRow::Chat(_)));

        // Pushdown narrowing on a typed column; NULL prompt_tokens compares
        // false in SQL exactly like the registry's missing-field rule.
        let rows = store
            .select_snapshot(
                RowKind::Chat,
                "prompt_tokens > ?1",
                vec![rusqlite::types::Value::Integer(0)],
            )
            .expect("select narrowed");
        assert_eq!(rows.len(), 1);
        match &rows[0] {
            StoredRow::Chat(row) => {
                assert_eq!(row.correlation_id, "a");
                assert_eq!(row.prompt_tokens, Some(25));
            }
            other => panic!("expected a chat row, got {other:?}"),
        }
        assert_eq!(rows[0].key().session_id, "s");
        assert!(matches!(rows[0].as_snapshot(), RowSnapshot::Chat(_)));
    }

    // ── telemetry_spans is untouchable ─────────────────────────────────────

    #[test]
    fn rtdb_never_creates_or_touches_telemetry_tables() {
        let (_dir, store) = make_store();
        let conn = store.lock_conn();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'telemetry%'",
                [],
                |row| row.get(0),
            )
            .expect("query");
        assert_eq!(count, 0, "RTDB must never create telemetry tables");
    }
}
