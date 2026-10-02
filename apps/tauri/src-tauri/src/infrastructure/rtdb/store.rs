//! RtdbStore — authoritative storage for RTDB rows
//! (Spec #2788, P1.2; PostgreSQL migration Spec #2976, ST-2; PG-only #2979 CU-2).
//!
//! Owns the `chat_rows` / `tool_use_rows` / `agent_session_rows` tables. Every
//! read and write routes through the ONE shared [`EngineHandle`] (Spec #2975):
//! the shared PostgreSQL pool once the managed server installs it — no per-store
//! `Mutex<Connection>`, no second pool. `telemetry_spans` is NEVER touched —
//! the RTDB is a read-only consumer of the telemetry pipeline, never a writer.
//!
//! ## Write model
//!
//! Upserts write the FULL row keyed on the composite primary key
//! `(session_id, correlation_id)`; `updated_at` is stamped by the patch/merge
//! layer before the row reaches the store. Writes land in batches driven by the
//! write-behind task in [`crate::infrastructure::rtdb::cache`], using
//! `INSERT … ON CONFLICT(<pk>) DO UPDATE SET <every non-PK col> = EXCLUDED.<col>`,
//! chunked to at most [`RtdbStore::UPSERT_STATEMENT_CHUNK`] rows per statement
//! (Q-15) so a large burst never becomes one giant statement.
//!
//! ## Durable per-key seq
//!
//! `seq` is monotonic per composite key `(session_id, correlation_id)` PER row
//! kind. [`RtdbStore::next_seq`] serves from an in-memory counter map that is
//! SEEDED from `MAX(seq)` on the ACTIVE engine on first use of a key (and
//! therefore on every process start) — a restart over the same store never
//! resets the seq. Gaps are acceptable (a shed storage write skips a seq value);
//! monotonicity is not.
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
//! write-behind task; knobs are re-read fresh at every prune cycle. `prune`
//! returns the evicted `(kind, key)` set — the routing layer passes each
//! eviction to the subscription registry for `kind: remove` deliveries (R-2d:
//! the ONLY remove producer). The whole prune cycle runs on ONE acquired pooled
//! connection (so the session-scoped `prune_batch` TEMP table survives between
//! statements); PostgreSQL autovacuum owns reclaim.

use anyhow::Result;
use chrono::Utc;
use sqlx::{PgPool, Row as _};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::infrastructure::rtdb::attrs::PROVIDER_UNKNOWN;
use crate::infrastructure::rtdb::project::{RowKey, RowSnapshot};
use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, RowState, ToolUseRow};
use crate::infrastructure::storage::{EngineHandle, StoreEngine};

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

// ── PostgreSQL DDL (1:1 translation) ─────────────────────────────────────────
//
// The C1 type map: `TEXT→TEXT`, `INTEGER→BIGINT`, `REAL→DOUBLE PRECISION` (the
// ns-epoch / token counters do not fit int4). Identical column sets, indexes,
// and the composite primary key. Statements are executed one at a time (the
// extended query protocol is single-statement).
const PG_DDL: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS chat_rows (
        session_id                  TEXT NOT NULL,
        correlation_id              TEXT NOT NULL,
        seq                         BIGINT NOT NULL,
        started_at_ns               BIGINT,
        ended_at_ns                 BIGINT,
        updated_at                  TEXT NOT NULL,
        state                       TEXT NOT NULL,
        user_message                TEXT,
        agent_reply                 TEXT,
        prompt_tokens               BIGINT,
        completion_tokens           BIGINT,
        cache_read_tokens           BIGINT,
        cost_usd                    DOUBLE PRECISION,
        model                       TEXT,
        parent_session_id           TEXT,
        composited_child_session_id TEXT,
        raw_json                    TEXT NOT NULL,
        provider                    TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY (session_id, correlation_id)
    )",
    "CREATE INDEX IF NOT EXISTS idx_chat_started ON chat_rows (started_at_ns)",
    "CREATE INDEX IF NOT EXISTS idx_chat_session_time ON chat_rows (session_id, started_at_ns)",
    "CREATE INDEX IF NOT EXISTS idx_chat_updated ON chat_rows (updated_at)",
    "CREATE TABLE IF NOT EXISTS tool_use_rows (
        session_id       TEXT NOT NULL,
        correlation_id   TEXT NOT NULL,
        seq              BIGINT NOT NULL,
        started_at_ns    BIGINT,
        ended_at_ns      BIGINT,
        updated_at       TEXT NOT NULL,
        state            TEXT NOT NULL,
        tool_name        TEXT,
        tool_success     BIGINT,
        tool_error       TEXT,
        duration_ms      BIGINT,
        tool_input_json  TEXT,
        tool_output_json TEXT,
        is_subagent      BIGINT,
        raw_json         TEXT NOT NULL,
        provider         TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY (session_id, correlation_id)
    )",
    "CREATE INDEX IF NOT EXISTS idx_tool_started ON tool_use_rows (started_at_ns)",
    "CREATE INDEX IF NOT EXISTS idx_tool_session_time ON tool_use_rows (session_id, started_at_ns)",
    "CREATE INDEX IF NOT EXISTS idx_tool_updated ON tool_use_rows (updated_at)",
    "CREATE TABLE IF NOT EXISTS agent_session_rows (
        session_id       TEXT NOT NULL,
        correlation_id   TEXT NOT NULL,
        seq              BIGINT NOT NULL,
        started_at_ns    BIGINT,
        ended_at_ns      BIGINT,
        updated_at       TEXT NOT NULL,
        state            TEXT NOT NULL,
        total_tokens     BIGINT,
        total_messages   BIGINT,
        total_cost_usd   DOUBLE PRECISION,
        agent_name       TEXT,
        raw_json         TEXT NOT NULL,
        provider         TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY (session_id, correlation_id)
    )",
    "CREATE INDEX IF NOT EXISTS idx_agent_started ON agent_session_rows (started_at_ns)",
    "CREATE INDEX IF NOT EXISTS idx_agent_session_time ON agent_session_rows (session_id, started_at_ns)",
    "CREATE INDEX IF NOT EXISTS idx_agent_updated ON agent_session_rows (updated_at)",
];

// ── Column sets (the ONE source of column order) ─────────────────────────────

const CHAT_COLUMNS: &[&str] = &[
    "session_id",
    "correlation_id",
    "seq",
    "started_at_ns",
    "ended_at_ns",
    "updated_at",
    "state",
    "user_message",
    "agent_reply",
    "prompt_tokens",
    "completion_tokens",
    "cache_read_tokens",
    "cost_usd",
    "model",
    "parent_session_id",
    "composited_child_session_id",
    "raw_json",
    "provider",
];

const TOOL_USE_COLUMNS: &[&str] = &[
    "session_id",
    "correlation_id",
    "seq",
    "started_at_ns",
    "ended_at_ns",
    "updated_at",
    "state",
    "tool_name",
    "tool_success",
    "tool_error",
    "duration_ms",
    "tool_input_json",
    "tool_output_json",
    "is_subagent",
    "raw_json",
    "provider",
];

const AGENT_SESSION_COLUMNS: &[&str] = &[
    "session_id",
    "correlation_id",
    "seq",
    "started_at_ns",
    "ended_at_ns",
    "updated_at",
    "state",
    "total_tokens",
    "total_messages",
    "total_cost_usd",
    "agent_name",
    "raw_json",
    "provider",
];

/// The physical columns of a row kind, in storage order. The composite primary
/// key is always the FIRST two (`session_id`, `correlation_id`).
fn columns_of(kind: RowKind) -> &'static [&'static str] {
    match kind {
        RowKind::Chat => CHAT_COLUMNS,
        RowKind::ToolUse => TOOL_USE_COLUMNS,
        RowKind::AgentSession => AGENT_SESSION_COLUMNS,
    }
}

/// The comma-joined column list for `kind`'s SELECT / INSERT statements.
fn column_list(kind: RowKind) -> String {
    columns_of(kind).join(", ")
}

// ── SqlValue (PG-native query-param enum) ────────────────────────────────────

/// A PostgreSQL-native bind value used by
/// [`RtdbStore::select_snapshot`]'s param vec. No `Null` variant: the query
/// pushdown never binds a null literal (a null arg stays an in-memory match), so
/// every filter param carries a real value.
#[derive(Clone, Debug, PartialEq)]
pub enum SqlValue {
    Text(String),
    Integer(i64),
    Real(f64),
    Blob(Vec<u8>),
}

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
fn parse_row_state(s: &str) -> Result<RowState> {
    match s {
        "init" => Ok(RowState::Init),
        "update" => Ok(RowState::Update),
        "response" => Ok(RowState::Response),
        "timeout" => Ok(RowState::Timeout),
        "error" => Ok(RowState::Error),
        other => Err(anyhow::anyhow!("unknown rtdb row state: {other}")),
    }
}

/// Bind a canonical provider token for the physical `provider` column
/// (Spec #2932 ST-4).
///
/// The column is `NOT NULL DEFAULT 'unknown'`; the Rust field stays
/// `Option<String>` because an empty-row bootstrap is built unattributed and
/// filled by its first patch. A row that reaches the store still `None` (a
/// patch never carried an attribution) therefore persists as the documented
/// fallback [`PROVIDER_UNKNOWN`] rather than tripping the NOT NULL constraint —
/// never NULL, never empty (R7).
fn provider_token(provider: &Option<String>) -> &str {
    provider.as_deref().unwrap_or(PROVIDER_UNKNOWN)
}

/// True when `column` physically exists on `table` (PostgreSQL
/// `information_schema.columns`).
async fn column_exists_pg(pool: &PgPool, table: &str, column: &str) -> Result<bool> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2",
    )
    .bind(table)
    .bind(column)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
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

// ── Row mappers (PostgreSQL) ─────────────────────────────────────────────────
//
// `tool_success` / `is_subagent` are physically BIGINT (the C1 `INTEGER→BIGINT`
// map), so they are read as `Option<i64>` and normalized to `Option<bool>` — the
// value shape the row struct (and every consumer) expects.

fn chat_from_pg_row(row: &sqlx::postgres::PgRow) -> Result<ChatRow> {
    let state: String = row.try_get(6)?;
    Ok(ChatRow {
        session_id: row.try_get(0)?,
        correlation_id: row.try_get(1)?,
        seq: row.try_get(2)?,
        started_at_ns: row.try_get(3)?,
        ended_at_ns: row.try_get(4)?,
        updated_at: row.try_get(5)?,
        state: parse_row_state(&state)?,
        user_message: row.try_get(7)?,
        agent_reply: row.try_get(8)?,
        prompt_tokens: row.try_get(9)?,
        completion_tokens: row.try_get(10)?,
        cache_read_tokens: row.try_get(11)?,
        cost_usd: row.try_get(12)?,
        model: row.try_get(13)?,
        parent_session_id: row.try_get(14)?,
        composited_child_session_id: row.try_get(15)?,
        raw_json: row.try_get(16)?,
        provider: Some(row.try_get(17)?),
    })
}

fn tool_from_pg_row(row: &sqlx::postgres::PgRow) -> Result<ToolUseRow> {
    let state: String = row.try_get(6)?;
    Ok(ToolUseRow {
        session_id: row.try_get(0)?,
        correlation_id: row.try_get(1)?,
        seq: row.try_get(2)?,
        started_at_ns: row.try_get(3)?,
        ended_at_ns: row.try_get(4)?,
        updated_at: row.try_get(5)?,
        state: parse_row_state(&state)?,
        tool_name: row.try_get(7)?,
        tool_success: row.try_get::<Option<i64>, _>(8)?.map(|v| v != 0),
        tool_error: row.try_get(9)?,
        duration_ms: row.try_get(10)?,
        tool_input_json: row.try_get(11)?,
        tool_output_json: row.try_get(12)?,
        is_subagent: row.try_get::<Option<i64>, _>(13)?.map(|v| v != 0),
        raw_json: row.try_get(14)?,
        provider: Some(row.try_get(15)?),
    })
}

fn agent_session_from_pg_row(row: &sqlx::postgres::PgRow) -> Result<AgentSessionRow> {
    let state: String = row.try_get(6)?;
    Ok(AgentSessionRow {
        session_id: row.try_get(0)?,
        correlation_id: row.try_get(1)?,
        seq: row.try_get(2)?,
        started_at_ns: row.try_get(3)?,
        ended_at_ns: row.try_get(4)?,
        updated_at: row.try_get(5)?,
        state: parse_row_state(&state)?,
        total_tokens: row.try_get(7)?,
        total_messages: row.try_get(8)?,
        total_cost_usd: row.try_get(9)?,
        agent_name: row.try_get(10)?,
        raw_json: row.try_get(11)?,
        provider: Some(row.try_get(12)?),
    })
}

// ── Bindable cell values ─────────────────────────────────────────────────────

/// One bindable cell of a full row. `None` inside a typed variant is a typed SQL
/// NULL (so PostgreSQL infers the parameter's type from the target column). The
/// type carries no `Null` variant on [`SqlValue`]; row binding is a separate
/// concern from filter params.
enum CellValue {
    Text(Option<String>),
    Integer(Option<i64>),
    Real(Option<f64>),
}

fn chat_cells(row: &ChatRow) -> Vec<CellValue> {
    vec![
        CellValue::Text(Some(row.session_id.clone())),
        CellValue::Text(Some(row.correlation_id.clone())),
        CellValue::Integer(Some(row.seq)),
        CellValue::Integer(row.started_at_ns),
        CellValue::Integer(row.ended_at_ns),
        CellValue::Text(Some(row.updated_at.clone())),
        CellValue::Text(Some(row.state.as_str().to_string())),
        CellValue::Text(row.user_message.clone()),
        CellValue::Text(row.agent_reply.clone()),
        CellValue::Integer(row.prompt_tokens),
        CellValue::Integer(row.completion_tokens),
        CellValue::Integer(row.cache_read_tokens),
        CellValue::Real(row.cost_usd),
        CellValue::Text(row.model.clone()),
        CellValue::Text(row.parent_session_id.clone()),
        CellValue::Text(row.composited_child_session_id.clone()),
        CellValue::Text(Some(row.raw_json.clone())),
        CellValue::Text(Some(provider_token(&row.provider).to_string())),
    ]
}

fn tool_cells(row: &ToolUseRow) -> Vec<CellValue> {
    vec![
        CellValue::Text(Some(row.session_id.clone())),
        CellValue::Text(Some(row.correlation_id.clone())),
        CellValue::Integer(Some(row.seq)),
        CellValue::Integer(row.started_at_ns),
        CellValue::Integer(row.ended_at_ns),
        CellValue::Text(Some(row.updated_at.clone())),
        CellValue::Text(Some(row.state.as_str().to_string())),
        CellValue::Text(row.tool_name.clone()),
        CellValue::Integer(row.tool_success.map(i64::from)),
        CellValue::Text(row.tool_error.clone()),
        CellValue::Integer(row.duration_ms),
        CellValue::Text(row.tool_input_json.clone()),
        CellValue::Text(row.tool_output_json.clone()),
        CellValue::Integer(row.is_subagent.map(i64::from)),
        CellValue::Text(Some(row.raw_json.clone())),
        CellValue::Text(Some(provider_token(&row.provider).to_string())),
    ]
}

fn agent_session_cells(row: &AgentSessionRow) -> Vec<CellValue> {
    vec![
        CellValue::Text(Some(row.session_id.clone())),
        CellValue::Text(Some(row.correlation_id.clone())),
        CellValue::Integer(Some(row.seq)),
        CellValue::Integer(row.started_at_ns),
        CellValue::Integer(row.ended_at_ns),
        CellValue::Text(Some(row.updated_at.clone())),
        CellValue::Text(Some(row.state.as_str().to_string())),
        CellValue::Integer(row.total_tokens),
        CellValue::Integer(row.total_messages),
        CellValue::Real(row.total_cost_usd),
        CellValue::Text(row.agent_name.clone()),
        CellValue::Text(Some(row.raw_json.clone())),
        CellValue::Text(Some(provider_token(&row.provider).to_string())),
    ]
}

/// Bind one cell onto a PostgreSQL query. Values are cloned (the batch binding
/// loop borrows the row cells); each variant maps to its own `Option<T>`, so a
/// typed NULL keeps the parameter's inferred type.
fn bind_cell<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    cell: &CellValue,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match cell {
        CellValue::Text(v) => query.bind(v.clone()),
        CellValue::Integer(v) => query.bind(*v),
        CellValue::Real(v) => query.bind(*v),
    }
}

// ── Statement builders ───────────────────────────────────────────────────────

/// PostgreSQL full-row upsert with `ON CONFLICT(<pk>) DO UPDATE SET
/// <every non-PK col> = EXCLUDED.<col>`. `rows` is the multi-row VALUES count
/// (≤ [`RtdbStore::UPSERT_STATEMENT_CHUNK`]); the composite PK is the first two
/// columns. Table/column names are static (never caller input).
fn pg_upsert_sql(table: &str, columns: &[&str], rows: usize) -> String {
    let ncols = columns.len();
    let mut value_rows = Vec::with_capacity(rows);
    for r in 0..rows {
        let row: Vec<String> = (0..ncols)
            .map(|c| format!("${}", r * ncols + c + 1))
            .collect();
        value_rows.push(format!("({})", row.join(", ")));
    }
    let updates: Vec<String> = columns[2..]
        .iter()
        .map(|column| format!("{column} = EXCLUDED.{column}"))
        .collect();
    format!(
        "INSERT INTO {table} ({}) VALUES {} ON CONFLICT (session_id, correlation_id) DO UPDATE SET {}",
        columns.join(", "),
        value_rows.join(", "),
        updates.join(", "),
    )
}

/// Translate the caller's `?N` placeholders to PostgreSQL's `$N` (the C1 map).
/// `where_sql` is built by the query pushdown from validated args — never raw
/// user input — so this is a pure token substitution.
fn pg_placeholders(where_sql: &str) -> String {
    let mut out = String::with_capacity(where_sql.len());
    let mut chars = where_sql.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '?' {
            let mut digits = String::new();
            while let Some(d) = chars.peek() {
                if d.is_ascii_digit() {
                    digits.push(*d);
                    chars.next();
                } else {
                    break;
                }
            }
            out.push('$');
            out.push_str(&digits);
        } else {
            out.push(c);
        }
    }
    out
}

// ── RtdbStore ────────────────────────────────────────────────────────────────

/// Engine-selected authoritative store for RTDB rows.
///
/// Holds an `Arc` clone of the ONE shared [`EngineHandle`] (Spec #2975) — no
/// per-store `Mutex<Connection>`, no second pool. Owns the three `*_rows`
/// tables; it never touches `telemetry_spans` or any other store's tables.
pub struct RtdbStore {
    engine: Arc<EngineHandle>,
    /// Per-`(kind, session_id, correlation_id)` in-memory seq counters,
    /// seeded from `MAX(seq)` on the active engine on first use (durable).
    seq_counters: Mutex<HashMap<(RowKind, String, String), i64>>,
}

impl RtdbStore {
    /// Rows per INSERT statement on PostgreSQL (Q-15): a large burst is chunked
    /// into multi-row statements of at most this many rows.
    pub const UPSERT_STATEMENT_CHUNK: usize = 512;

    /// Wrap the shared engine handle. Every read/write routes through the active
    /// engine; the store never opens its own connection.
    pub fn open(engine: Arc<EngineHandle>) -> Result<Self> {
        Ok(RtdbStore {
            engine,
            seq_counters: Mutex::new(HashMap::new()),
        })
    }

    /// Create the three RTDB tables (and their indexes) if they don't exist
    /// (idempotent).
    pub async fn ensure_schema(&self) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                for statement in PG_DDL {
                    sqlx::query(statement).execute(&pg.pool).await?;
                }
                // The guarded-ALTER probes `information_schema.columns` (the
                // `pragma_table_info` 1:1 replacement).
                for table in [
                    RowKind::Chat.table(),
                    RowKind::ToolUse.table(),
                    RowKind::AgentSession.table(),
                ] {
                    if !column_exists_pg(&pg.pool, table, "provider").await? {
                        sqlx::query(&format!(
                            "ALTER TABLE {table} ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'"
                        ))
                        .execute(&pg.pool)
                        .await?;
                    }
                }
            }
        }
        Ok(())
    }

    // ── Upserts (full-row writes, batched) ──────────────────────────────────

    /// Upsert a batch of [`ChatRow`]s. Writes the FULL row keyed on the
    /// composite PK; returns the number of rows written.
    pub async fn upsert_chat_rows(&self, rows: &[ChatRow]) -> Result<usize> {
        let cells: Vec<Vec<CellValue>> = rows.iter().map(chat_cells).collect();
        self.upsert_rows(RowKind::Chat, cells).await
    }

    /// Upsert a batch of [`ToolUseRow`]s.
    pub async fn upsert_tool_use_rows(&self, rows: &[ToolUseRow]) -> Result<usize> {
        let cells: Vec<Vec<CellValue>> = rows.iter().map(tool_cells).collect();
        self.upsert_rows(RowKind::ToolUse, cells).await
    }

    /// Upsert a batch of [`AgentSessionRow`]s.
    pub async fn upsert_agent_session_rows(&self, rows: &[AgentSessionRow]) -> Result<usize> {
        let cells: Vec<Vec<CellValue>> = rows.iter().map(agent_session_cells).collect();
        self.upsert_rows(RowKind::AgentSession, cells).await
    }

    /// Shared upsert: one transaction per batch on SQLite; ≤
    /// [`Self::UPSERT_STATEMENT_CHUNK`]-row statements on PostgreSQL.
    async fn upsert_rows(&self, kind: RowKind, cells: Vec<Vec<CellValue>>) -> Result<usize> {
        if cells.is_empty() {
            return Ok(0);
        }
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let mut total = 0usize;
                for chunk in cells.chunks(Self::UPSERT_STATEMENT_CHUNK) {
                    let sql = pg_upsert_sql(kind.table(), columns_of(kind), chunk.len());
                    let mut query = sqlx::query(&sql);
                    for row_cells in chunk {
                        for cell in row_cells {
                            query = bind_cell(query, cell);
                        }
                    }
                    total += query.execute(&pg.pool).await?.rows_affected() as usize;
                }
                Ok(total)
            }
        }
    }

    // ── Selects (cache-miss reload + snapshot path) ─────────────────────────

    /// Load one chat row by composite key.
    pub async fn get_chat_row(
        &self,
        session_id: &str,
        correlation_id: &str,
    ) -> Result<Option<ChatRow>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT {} FROM chat_rows WHERE session_id = $1 AND correlation_id = $2",
                    column_list(RowKind::Chat)
                );
                let row = sqlx::query(&sql)
                    .bind(session_id)
                    .bind(correlation_id)
                    .fetch_optional(&pg.pool)
                    .await?;
                row.map(|row| chat_from_pg_row(&row)).transpose()
            }
        }
    }

    /// Load one tool-use row by composite key.
    pub async fn get_tool_use_row(
        &self,
        session_id: &str,
        correlation_id: &str,
    ) -> Result<Option<ToolUseRow>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT {} FROM tool_use_rows WHERE session_id = $1 AND correlation_id = $2",
                    column_list(RowKind::ToolUse)
                );
                let row = sqlx::query(&sql)
                    .bind(session_id)
                    .bind(correlation_id)
                    .fetch_optional(&pg.pool)
                    .await?;
                row.map(|row| tool_from_pg_row(&row)).transpose()
            }
        }
    }

    /// Load one agent-session row by composite key.
    pub async fn get_agent_session_row(
        &self,
        session_id: &str,
        correlation_id: &str,
    ) -> Result<Option<AgentSessionRow>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT {} FROM agent_session_rows WHERE session_id = $1 AND correlation_id = $2",
                    column_list(RowKind::AgentSession)
                );
                let row = sqlx::query(&sql)
                    .bind(session_id)
                    .bind(correlation_id)
                    .fetch_optional(&pg.pool)
                    .await?;
                row.map(|row| agent_session_from_pg_row(&row)).transpose()
            }
        }
    }

    /// Snapshot select for the replay path (P2.3): every row of `kind` matching
    /// the caller-built WHERE clause (`where_sql` is appended verbatim after
    /// `WHERE`; pass "1=1" for an unconstrained select; `?N` placeholders bind
    /// positionally against `params`, translated to `$N` for PostgreSQL). The
    /// caller builds the clause from schema-validated args against the typed
    /// column lists — never from raw user input.
    pub async fn select_snapshot(
        &self,
        kind: RowKind,
        where_sql: &str,
        params: Vec<SqlValue>,
    ) -> Result<Vec<StoredRow>> {
        let columns = column_list(kind);
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT {columns} FROM {} WHERE {}",
                    kind.table(),
                    pg_placeholders(where_sql)
                );
                let mut query = sqlx::query(&sql);
                for param in params {
                    query = match param {
                        SqlValue::Text(v) => query.bind(v),
                        SqlValue::Integer(v) => query.bind(v),
                        SqlValue::Real(v) => query.bind(v),
                        SqlValue::Blob(v) => query.bind(v),
                    };
                }
                let rows = query.fetch_all(&pg.pool).await?;
                rows.iter()
                    .map(|row| match kind {
                        RowKind::Chat => Ok(StoredRow::Chat(chat_from_pg_row(row)?)),
                        RowKind::ToolUse => Ok(StoredRow::ToolUse(tool_from_pg_row(row)?)),
                        RowKind::AgentSession => {
                            Ok(StoredRow::AgentSession(agent_session_from_pg_row(row)?))
                        }
                    })
                    .collect()
            }
        }
    }

    // ── Durable per-key seq ─────────────────────────────────────────────────

    /// Next monotonic `seq` for the composite key, per row kind.
    ///
    /// Served from an in-memory counter that is seeded from `MAX(seq)` on the
    /// ACTIVE engine on first use of the key — so a fresh store instance over
    /// the same store (a "restart") continues where the previous process left
    /// off.
    pub async fn next_seq(
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
        // Seed from storage OUTSIDE the counter lock (the guard is released
        // before the `.await`; no std lock is held across the await).
        let seeded = self.max_seq(kind, session_id, correlation_id).await?;
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

    /// `MAX(seq)` for the composite key from the active engine (0 when unknown).
    async fn max_seq(&self, kind: RowKind, session_id: &str, correlation_id: &str) -> Result<i64> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT COALESCE(MAX(seq), 0) FROM {} WHERE session_id = $1 AND correlation_id = $2",
                    kind.table()
                );
                let max: i64 = sqlx::query_scalar(&sql)
                    .bind(session_id)
                    .bind(correlation_id)
                    .fetch_one(&pg.pool)
                    .await?;
                Ok(max)
            }
        }
    }

    // ── Retention prune ─────────────────────────────────────────────────────

    /// Retention prune: (1) delete rows whose `updated_at` is older than
    /// `retention_days`, per table; then (2) enforce the `max_rows` GLOBAL cap
    /// across all three tables by deleting the oldest-`updated_at` rows first.
    /// Deletes run in [`PRUNE_BATCH`]-row batches. Returns the deleted count AND
    /// the evicted `(kind, key)` set — P2.3 routes each eviction through the
    /// subscription registry as a `kind: remove` delivery (R-2d).
    ///
    /// On PostgreSQL the WHOLE cycle runs on ONE acquired pooled connection, so
    /// the session-scoped `prune_batch` TEMP table survives between statements.
    pub async fn prune(&self, retention_days: i64, max_rows: i64) -> Result<PruneOutcome> {
        let cutoff = (Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => prune_pg(&pg.pool, &cutoff, max_rows).await,
        }
    }

    /// Row counts per table `(chat, tool_use, agent_session)` — test/diagnostic.
    pub async fn row_counts(&self) -> Result<(i64, i64, i64)> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let counts: (i64, i64, i64) = sqlx::query_as(
                    "SELECT (SELECT COUNT(*) FROM chat_rows),
                            (SELECT COUNT(*) FROM tool_use_rows),
                            (SELECT COUNT(*) FROM agent_session_rows)",
                )
                .fetch_one(&pg.pool)
                .await?;
                Ok(counts)
            }
        }
    }

    // ── Lock helpers (poison recovery — no unwrap) ──────────────────────────

    fn lock_seq(&self) -> MutexGuard<'_, HashMap<(RowKind, String, String), i64>> {
        match self.seq_counters.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

// ── Retention prune per engine ───────────────────────────────────────────────

/// PostgreSQL prune. Acquires ONE pooled connection for the whole cycle so the
/// session-scoped `prune_batch` TEMP table survives between statements (a plain
/// SQL `ON CONFLICT` cycle cannot rely on `ON COMMIT DROP` outside a
/// transaction block — the table is created once and explicitly dropped here).
async fn prune_pg(pool: &PgPool, cutoff: &str, max_rows: i64) -> Result<PruneOutcome> {
    let mut conn = pool.acquire().await?;
    let mut outcome = PruneOutcome::default();

    // 1. Age-based prune, one table at a time.
    for kind in [RowKind::Chat, RowKind::ToolUse, RowKind::AgentSession] {
        let table = kind.table();
        loop {
            let sql = format!(
                "DELETE FROM {table} WHERE (session_id, correlation_id) IN (
                    SELECT session_id, correlation_id FROM {table}
                    WHERE updated_at < $1 LIMIT $2
                ) RETURNING session_id, correlation_id"
            );
            let rows: Vec<(String, String)> = sqlx::query_as(&sql)
                .bind(cutoff)
                .bind(PRUNE_BATCH)
                .fetch_all(&mut *conn)
                .await?;
            let deleted = rows.len() as u64;
            if deleted == 0 {
                break;
            }
            for (session_id, correlation_id) in rows {
                outcome.evicted.push(EvictedKey {
                    kind,
                    session_id,
                    correlation_id,
                });
            }
            outcome.deleted += deleted;
        }
    }

    // 2. Global row-cap prune across all three tables, oldest-first. The
    //    candidate keys are materialized ONCE per batch into the TEMP table.
    sqlx::query(
        "CREATE TEMP TABLE IF NOT EXISTS prune_batch (
            session_id     TEXT NOT NULL,
            correlation_id TEXT NOT NULL,
            PRIMARY KEY (session_id, correlation_id)
        )",
    )
    .execute(&mut *conn)
    .await?;
    loop {
        let count: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM chat_rows)
                   + (SELECT COUNT(*) FROM tool_use_rows)
                   + (SELECT COUNT(*) FROM agent_session_rows)",
        )
        .fetch_one(&mut *conn)
        .await?;
        let excess = count - max_rows;
        if excess <= 0 {
            break;
        }
        let batch = excess.min(PRUNE_BATCH);
        sqlx::query("DELETE FROM prune_batch")
            .execute(&mut *conn)
            .await?;
        sqlx::query(
            "INSERT INTO prune_batch (session_id, correlation_id)
             SELECT session_id, correlation_id FROM (
                SELECT session_id, correlation_id, updated_at, seq FROM chat_rows
                UNION ALL
                SELECT session_id, correlation_id, updated_at, seq FROM tool_use_rows
                UNION ALL
                SELECT session_id, correlation_id, updated_at, seq FROM agent_session_rows
             ) AS all_rows ORDER BY updated_at ASC, seq ASC LIMIT $1",
        )
        .bind(batch)
        .execute(&mut *conn)
        .await?;
        let mut deleted = 0u64;
        for kind in [RowKind::Chat, RowKind::ToolUse, RowKind::AgentSession] {
            let table = kind.table();
            let sql = format!(
                "DELETE FROM {table} WHERE (session_id, correlation_id) IN (
                    SELECT session_id, correlation_id FROM prune_batch
                ) RETURNING session_id, correlation_id"
            );
            let rows: Vec<(String, String)> = sqlx::query_as(&sql).fetch_all(&mut *conn).await?;
            deleted += rows.len() as u64;
            for (session_id, correlation_id) in rows {
                outcome.evicted.push(EvictedKey {
                    kind,
                    session_id,
                    correlation_id,
                });
            }
        }
        let _ = sqlx::query("DELETE FROM prune_batch").execute(&mut *conn).await;
        if deleted == 0 {
            break;
        }
        outcome.deleted += deleted;
    }
    // The TEMP table is connection-scoped; drop it so the pooled connection is
    // returned clean for other users.
    sqlx::query("DROP TABLE IF EXISTS prune_batch")
        .execute(&mut *conn)
        .await?;

    Ok(outcome)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn chat_row(session: &str, corr: &str, seq: i64, updated_at: &str) -> ChatRow {
        ChatRow {
            session_id: session.to_string(),
            correlation_id: corr.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: updated_at.to_string(),
            state: RowState::Init,
            provider: Some("open_code".to_string()),
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
            provider: Some("open_code".to_string()),
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
            provider: Some("open_code".to_string()),
            total_tokens: Some(23_262),
            total_messages: Some(57),
            total_cost_usd: Some(0.512),
            agent_name: Some("self-improver".to_string()),
            raw_json: "{}".to_string(),
        }
    }

    // ── Column sets + statement builders (PG parity by construction) ────────

    #[test]
    fn column_sets_are_18_16_13_with_the_composite_pk_first() {
        assert_eq!(columns_of(RowKind::Chat).len(), 18);
        assert_eq!(columns_of(RowKind::ToolUse).len(), 16);
        assert_eq!(columns_of(RowKind::AgentSession).len(), 13);
        for kind in [RowKind::Chat, RowKind::ToolUse, RowKind::AgentSession] {
            let columns = columns_of(kind);
            assert_eq!(columns[0], "session_id", "composite PK first leg");
            assert_eq!(columns[1], "correlation_id", "composite PK second leg");
            assert_eq!(columns[columns.len() - 1], "provider", "provider is LAST");
        }
        assert_eq!(chat_cells(&chat_row("s", "c", 1, "t")).len(), 18);
        assert_eq!(tool_cells(&tool_row("s", "c", 1, "t")).len(), 16);
        assert_eq!(agent_session_cells(&session_row("s", "c", 1, "t")).len(), 13);
    }

    #[test]
    fn upsert_statement_chunk_is_512() {
        assert_eq!(RtdbStore::UPSERT_STATEMENT_CHUNK, 512);
    }

    #[test]
    fn pg_upsert_sql_is_full_row_on_conflict_excluded() {
        let sql = pg_upsert_sql("chat_rows", CHAT_COLUMNS, 1);
        assert!(
            sql.contains("ON CONFLICT (session_id, correlation_id) DO UPDATE SET"),
            "composite-PK conflict target: {sql}"
        );
        // Every non-PK column is updated from EXCLUDED (never a partial write).
        for column in &CHAT_COLUMNS[2..] {
            assert!(
                sql.contains(&format!("{column} = EXCLUDED.{column}")),
                "missing EXCLUDED update for {column}: {sql}"
            );
        }
        // One row → exactly the 18 placeholders $1..$18.
        for i in 1..=18 {
            assert!(sql.contains(&format!("${i}")), "missing ${i}: {sql}");
        }
        assert!(!sql.contains("$19"), "no extra placeholders: {sql}");
    }

    #[test]
    fn pg_upsert_sql_numbers_placeholders_across_a_chunk() {
        // Two 3-column rows → $1..$6 (global numbering across the VALUES rows).
        let sql = pg_upsert_sql("t", &["a", "b", "c"], 2);
        assert_eq!(
            sql,
            "INSERT INTO t (a, b, c) VALUES ($1, $2, $3), ($4, $5, $6) \
             ON CONFLICT (session_id, correlation_id) DO UPDATE SET c = EXCLUDED.c"
        );
    }

    #[test]
    fn pg_placeholders_translate_question_marks_to_dollar_params() {
        assert_eq!(pg_placeholders("prompt_tokens > ?1"), "prompt_tokens > $1");
        assert_eq!(
            pg_placeholders("a = ?1 AND b = ?2"),
            "a = $1 AND b = $2"
        );
        assert_eq!(pg_placeholders("1=1"), "1=1");
    }
}
