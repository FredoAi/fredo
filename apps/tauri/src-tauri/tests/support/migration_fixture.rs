//! Deterministic `fredo.db` fixture generator for the one-shot SQLite →
//! PostgreSQL data migration (Spec #2977, ST-7 / CU-D).
//!
//! Builds a SQLite database containing every physical table the migration must
//! carry:
//!
//! * `settings` (including the `rtdb.backfill.*` markers and a legacy key),
//! * `feature_data_tables` / `feature_data_tombstones`,
//! * `chat_rows` / `tool_use_rows` / `agent_session_rows`,
//! * `telemetry_spans` / `telemetry_logs` / `telemetry_metrics`,
//! * one dynamic `feature_*` table (`feature_mission_monitor_items`).
//!
//! The generator is fully deterministic — every value is derived from the row
//! index (no RNG, no clock, no locale) — and NEVER reads the live
//! `%APPDATA%\com.fredo.app\fredo.db` (G-264). The fixture is served to the app
//! through the **G-275** `FREDO_DATA_DIR` override.
//!
//! The DDL mirrors the production SQLite schema (`feature_data/store.rs`,
//! `rtdb/store.rs`, `storage/span_store.rs`) so the migration's
//! `pragma_table_info` introspection sees the same physical tables the app
//! ships. It is a fixture, not a second product schema implementation; the
//! migration itself derives its PostgreSQL DDL from these tables at runtime.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};

/// The dynamic `feature_*` table the fixture materializes. It is NOT created by
/// a startup schema init, so the migration derives its target DDL from source
/// introspection (the dynamic-table path).
pub const DYNAMIC_FEATURE_TABLE: &str = "feature_mission_monitor_items";

/// Row counts per table for one fixture build.
#[derive(Clone, Copy, Debug)]
pub struct FixtureScale {
    pub chat_rows: usize,
    pub tool_use_rows: usize,
    pub agent_session_rows: usize,
    pub telemetry_spans: usize,
    pub telemetry_logs: usize,
    pub telemetry_metrics: usize,
    pub feature_items: usize,
    pub tombstones: usize,
}

impl FixtureScale {
    /// The small deterministic fixture the parity / marker / rollback
    /// assertions run against (every table populated, with NULL + REAL + BLOB
    /// edges).
    pub const SMALL: FixtureScale = FixtureScale {
        chat_rows: 6,
        tool_use_rows: 4,
        agent_session_rows: 3,
        telemetry_spans: 5,
        telemetry_logs: 4,
        telemetry_metrics: 4,
        feature_items: 5,
        tombstones: 2,
    };

    /// The **AC5** measurement fixture: > 100k rows in the largest table, so
    /// the copy exercises many `MIGRATION_CHUNK_ROWS = 512` chunks. ST-8e:
    /// `telemetry_metrics` (the real corpus' dominant table) is raised to 120k
    /// so this fixture exercises that table's shape — it is still ~87× smaller
    /// than the real corpus (10,480,700 rows), so the live cutover, not this
    /// fixture, is the AC5 receipt.
    pub const LARGE: FixtureScale = FixtureScale {
        chat_rows: 120_000,
        tool_use_rows: 20_000,
        agent_session_rows: 4_000,
        telemetry_spans: 100_000,
        telemetry_logs: 20_000,
        telemetry_metrics: 120_000,
        feature_items: 20_000,
        tombstones: 100,
    };

    /// The row count of the largest table (the AC5 scale headline).
    pub fn largest_table_rows(&self) -> usize {
        [
            self.chat_rows,
            self.tool_use_rows,
            self.agent_session_rows,
            self.telemetry_spans,
            self.telemetry_logs,
            self.telemetry_metrics,
            self.feature_items,
        ]
        .into_iter()
        .max()
        .unwrap_or(0)
    }

    /// The total number of rows across every generated table.
    pub fn total_rows(&self) -> usize {
        self.chat_rows
            + self.tool_use_rows
            + self.agent_session_rows
            + self.telemetry_spans
            + self.telemetry_logs
            + self.telemetry_metrics
            + self.feature_items
            + self.tombstones
    }
}

/// The production SQLite DDL for every physical table the migration carries.
const FIXTURE_DDL: &str = "
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feature_data_tables (
    feature_id            TEXT NOT NULL,
    table_name            TEXT NOT NULL,
    declaration_json      TEXT NOT NULL,
    declaration_revision  TEXT NOT NULL,
    last_version          INTEGER NOT NULL DEFAULT 0,
    backfill_done         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (feature_id, table_name)
);
CREATE TABLE IF NOT EXISTS feature_data_tombstones (
    feature_id  TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    key_json    TEXT NOT NULL,
    deleted_at  TEXT NOT NULL,
    PRIMARY KEY (feature_id, table_name, key_json)
);
CREATE TABLE IF NOT EXISTS chat_rows (
    session_id                  TEXT NOT NULL,
    correlation_id              TEXT NOT NULL,
    seq                         INTEGER NOT NULL,
    started_at_ns               INTEGER,
    ended_at_ns                 INTEGER,
    updated_at                  TEXT NOT NULL,
    state                       TEXT NOT NULL,
    user_message                TEXT,
    agent_reply                 TEXT,
    prompt_tokens               INTEGER,
    completion_tokens           INTEGER,
    cache_read_tokens           INTEGER,
    cost_usd                    REAL,
    model                       TEXT,
    parent_session_id           TEXT,
    composited_child_session_id TEXT,
    raw_json                    TEXT NOT NULL,
    provider                    TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE TABLE IF NOT EXISTS tool_use_rows (
    session_id         TEXT NOT NULL,
    correlation_id     TEXT NOT NULL,
    seq                INTEGER NOT NULL,
    started_at_ns      INTEGER,
    ended_at_ns        INTEGER,
    updated_at         TEXT NOT NULL,
    state              TEXT NOT NULL,
    tool_name          TEXT,
    tool_success       INTEGER,
    tool_error         TEXT,
    duration_ms        INTEGER,
    tool_input_json    TEXT,
    tool_output_json   TEXT,
    is_subagent        INTEGER,
    raw_json           TEXT NOT NULL,
    provider           TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE TABLE IF NOT EXISTS agent_session_rows (
    session_id       TEXT NOT NULL,
    correlation_id   TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    started_at_ns    INTEGER,
    ended_at_ns      INTEGER,
    updated_at       TEXT NOT NULL,
    state            TEXT NOT NULL,
    total_tokens     INTEGER,
    total_messages   INTEGER,
    total_cost_usd   REAL,
    agent_name       TEXT,
    raw_json         TEXT NOT NULL,
    provider         TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE TABLE IF NOT EXISTS telemetry_spans (
    trace_id        TEXT NOT NULL,
    span_id         TEXT PRIMARY KEY,
    parent_span_id  TEXT,
    span_name       TEXT NOT NULL,
    span_kind       TEXT NOT NULL DEFAULT 'INTERNAL',
    start_time_ns   INTEGER NOT NULL,
    end_time_ns     INTEGER,
    status_code     TEXT NOT NULL DEFAULT 'UNSET',
    status_message  TEXT,
    session_id      TEXT NOT NULL,
    attributes_json TEXT,
    events_json     TEXT,
    provider        TEXT,
    transport       TEXT,
    event_type      TEXT,
    ingested_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    level           TEXT NOT NULL,
    target          TEXT NOT NULL,
    message         TEXT NOT NULL,
    attributes_json TEXT DEFAULT '{}',
    trace_id        TEXT,
    span_id         TEXT,
    session_id      TEXT
);
CREATE TABLE IF NOT EXISTS telemetry_metrics (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name          TEXT NOT NULL,
    metric_type          TEXT NOT NULL,
    labels_json          TEXT DEFAULT '{}',
    value                REAL NOT NULL,
    timestamp            TEXT NOT NULL,
    aggregation_window_s INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feature_mission_monitor_items (
    id           TEXT NOT NULL,
    label        TEXT NOT NULL,
    \"count\"      INTEGER NOT NULL,
    ratio        REAL NOT NULL,
    payload      BLOB,
    _row_version INTEGER NOT NULL,
    _updated_at  TEXT NOT NULL,
    PRIMARY KEY (id)
);
";

/// Build (or rebuild) the deterministic fixture at `path`.
///
/// Any previous file + sidecars are removed first, so the result is a pure
/// function of `scale`.
pub fn build_fixture(path: &Path, scale: &FixtureScale) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create fixture dir '{}'", parent.display()))?;
    }
    remove_if_present(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        remove_if_present(&PathBuf::from(format!("{}{suffix}", path.display())))?;
    }

    let conn = Connection::open(path)
        .with_context(|| format!("open fixture '{}'", path.display()))?;
    // A rollback-journal database keeps the migration's pre-snapshot
    // `wal_checkpoint(TRUNCATE)` a true no-op, so the source bytes stay stable.
    conn.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;")
        .context("configure the fixture journal mode")?;
    conn.execute_batch(FIXTURE_DDL)
        .context("create the fixture schema")?;

    seed_settings(&conn)?;
    seed_feature_data_tables(&conn)?;
    seed_tombstones(&conn, scale.tombstones)?;
    seed_chat_rows(&conn, scale.chat_rows)?;
    seed_tool_use_rows(&conn, scale.tool_use_rows)?;
    seed_agent_session_rows(&conn, scale.agent_session_rows)?;
    seed_telemetry_spans(&conn, scale.telemetry_spans)?;
    seed_telemetry_logs(&conn, scale.telemetry_logs)?;
    seed_telemetry_metrics(&conn, scale.telemetry_metrics)?;
    seed_feature_items(&conn, scale.feature_items)?;
    drop(conn);
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove '{}'", path.display())),
    }
}

/// A deterministic ISO-8601-ish timestamp from the row index (no clock).
fn stamp(index: usize) -> String {
    format!(
        "2026-09-27T{:02}:{:02}:{:02}.000Z",
        index / 3600 % 24,
        index / 60 % 60,
        index % 60
    )
}

fn seed_settings(conn: &Connection) -> Result<()> {
    // The two one-shot backfill markers (carried as data, never re-derived), a
    // legacy/ignored key with an unusual charset + the unit separator, and a
    // plain KV pair.
    let rows: [(&str, &str); 4] = [
        ("rtdb.backfill.completed", "true"),
        (
            "rtdb.backfill.provider.completed.v2",
            "2026-09-27T00:00:00.000Z",
        ),
        ("legacy.ignored.key", "legacy:v1/\u{fc}n\u{ef}code\u{1f}value"),
        ("theme", "dark"),
    ];
    for (key, value) in rows {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    Ok(())
}

fn seed_feature_data_tables(conn: &Connection) -> Result<()> {
    // PRODUCTION-SHAPED declarations (ST-7a / F-15). The persisted-declaration
    // reader deserializes `declaration_json` into
    // `FeatureDataTableDeclaration` (`registry.rs:216-226`), which REQUIRES
    // `name`/`primaryKey`/`columns` (`declaration.rs:225-235`); a
    // `sessionRollup` `source` additionally requires BOTH `excludeDispatchNames`
    // and `terminalStates` (`declaration.rs:458-466`). These strings mirror the
    // real Mission Monitor declaration (`dataDeclaration.ts:40-67`) — the exact
    // value the product serializes at `registry.rs:340`.
    //
    // `sessions` stays `backfill_done = 0` so the `sessionRollup` projection
    // recomputes the (fixture-absent) physical table once after cutover from the
    // carried canonical chat/tool rows; `tools` is `1`. One row of each keeps
    // the AC4 unset(0)/set(1) edge.
    let sessions_declaration = r#"{"name":"sessions","primaryKey":["sessionId"],"columns":[{"name":"sessionId","type":"TEXT","owner":"backend"},{"name":"provider","type":"TEXT","owner":"backend","nullable":true},{"name":"startedAtNs","type":"INTEGER","owner":"backend","nullable":true},{"name":"latestAt","type":"TEXT","owner":"backend"},{"name":"chatRowCount","type":"INTEGER","owner":"backend"},{"name":"nonSubagentChatRowCount","type":"INTEGER","owner":"backend"},{"name":"visibleTurnCount","type":"INTEGER","owner":"backend"},{"name":"userDispatchCount","type":"INTEGER","owner":"backend"},{"name":"derivedName","type":"TEXT","owner":"backend","nullable":true},{"name":"agentName","type":"TEXT","owner":"backend","nullable":true},{"name":"customName","type":"TEXT","owner":"feature","nullable":true}],"source":{"kind":"sessionRollup","excludeDispatchNames":["build","plan"],"terminalStates":["Response","Timeout"]},"retention":{"maxRows":500}}"#;
    let tools_declaration = r#"{"name":"tools","primaryKey":["toolUseId"],"columns":[{"name":"toolUseId","type":"TEXT","owner":"backend"},{"name":"toolName","type":"TEXT","owner":"backend","nullable":true}]}"#;
    let rows: [(&str, &str, &str, &str, i64, i64); 2] = [
        (
            "mission-monitor",
            "sessions",
            sessions_declaration,
            "mm.sessions.v2",
            7,
            0,
        ),
        (
            "mission-monitor",
            "tools",
            tools_declaration,
            "mm.tools.v1",
            3,
            1,
        ),
    ];
    for (feature, table, declaration, revision, version, backfill) in rows {
        conn.execute(
            "INSERT INTO feature_data_tables
                (feature_id, table_name, declaration_json, declaration_revision, last_version, backfill_done)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![feature, table, declaration, revision, version, backfill],
        )?;
    }
    Ok(())
}

fn seed_tombstones(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        tx.execute(
            "INSERT INTO feature_data_tombstones (feature_id, table_name, key_json, deleted_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                "mission-monitor",
                "sessions",
                format!("[\"s{index:05}\"]"),
                stamp(index)
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_chat_rows(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        let i = index as i64;
        let session = format!("s{index:06}");
        let correlation = format!("s{index:06}_c0");
        let started = 1_790_000_000_000_000_000i64 + i * 1_000_000;
        let ended = if index % 3 == 0 {
            None
        } else {
            Some(started + 500_000_000)
        };
        let user_message = if index % 5 == 0 {
            None
        } else {
            Some(format!("user message {index}"))
        };
        let cache_read = if index % 4 == 0 { None } else { Some(i * 2) };
        let cost = if index % 7 == 0 {
            None
        } else {
            Some(i as f64 * 0.001)
        };
        // LOWERCASE canonical storage form (`RowState::as_str()`,
        // `rows.rs:44-55`) — the persisted `state` column, NOT the PascalCase
        // wire enum. `streaming`/`complete` are not parseable by the row
        // mapper (`store.rs:356-370`).
        let state = ["update", "response", "error"][index % 3];
        let provider = if index % 2 == 0 { "opencode" } else { "copilot" };
        tx.execute(
            "INSERT INTO chat_rows
                (session_id, correlation_id, seq, started_at_ns, ended_at_ns, updated_at, state,
                 user_message, agent_reply, prompt_tokens, completion_tokens, cache_read_tokens,
                 cost_usd, model, parent_session_id, composited_child_session_id, raw_json, provider)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                session,
                correlation,
                i + 1,
                started,
                ended,
                stamp(index),
                state,
                user_message,
                Some(format!("agent reply {index}")),
                Some(i * 3 + 1),
                Some(i + 1),
                cache_read,
                cost,
                Some("claude-sonnet-4"),
                Option::<String>::None,
                Option::<String>::None,
                format!("{{\"i\":{index}}}"),
                provider,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_tool_use_rows(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        let i = index as i64;
        let session = format!("s{index:06}");
        let correlation = format!("s{index:06}_t0");
        // ST-7d / F-12: start each tool STRICTLY AFTER its parent chat row
        // (chat_start + 1 ms). The product's tool→chat association rule requires
        // `parentStart < callStart` (`useMissionMonitor.ts:349`), so a tie (the
        // old formula used the identical `+ i * 1_000_000`) resolves no parent
        // and the `── TOOLS (N) ──` section never renders. The parent chat row's
        // end (`chat_start + 500 ms` when closed, `NULL` when open) still admits
        // the call. Both SMALL and LARGE scales inherit this offset.
        let started = 1_790_000_000_000_000_000i64 + i * 1_000_000 + 1_000_000;
        let tool_name = ["read", "bash", "edit"][index % 3];
        let tool_error = if index % 4 == 0 {
            Some("injected tool error")
        } else {
            None
        };
        tx.execute(
            "INSERT INTO tool_use_rows
                (session_id, correlation_id, seq, started_at_ns, ended_at_ns, updated_at, state,
                 tool_name, tool_success, tool_error, duration_ms, tool_input_json, tool_output_json,
                 is_subagent, raw_json, provider)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                session,
                correlation,
                i + 1,
                started,
                Some(started + 1_000_000),
                stamp(index),
                "response",
                tool_name,
                Some(if index % 2 == 0 { 1i64 } else { 0 }),
                tool_error,
                Some(i * 5 + 1),
                Some(format!("{{\"tool\":\"{tool_name}\",\"i\":{index}}}")),
                Some(format!("{{\"ok\":{}}}", index % 2 == 0)),
                Some(0i64),
                format!("{{\"i\":{index}}}"),
                if index % 2 == 0 { "opencode" } else { "copilot" },
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_agent_session_rows(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        let i = index as i64;
        let session = format!("s{index:06}");
        let correlation = format!("s{index:06}_a0");
        let started = 1_790_000_000_000_000_000i64 + i * 1_000_000;
        let cost = if index % 3 == 0 {
            None
        } else {
            Some(i as f64 * 0.25)
        };
        tx.execute(
            "INSERT INTO agent_session_rows
                (session_id, correlation_id, seq, started_at_ns, ended_at_ns, updated_at, state,
                 total_tokens, total_messages, total_cost_usd, agent_name, raw_json, provider)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                session,
                correlation,
                i + 1,
                started,
                Some(started + 2_000_000),
                stamp(index),
                "response",
                Some(i * 100 + 1),
                Some(i + 1),
                cost,
                Some("build"),
                format!("{{\"i\":{index}}}"),
                "opencode",
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_telemetry_spans(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        let i = index as i64;
        let span_id = format!("span-{index:06}");
        let trace_id = format!("trace-{:06}", index / 2);
        let started = 1_790_000_000_000_000_000i64 + i * 1_000_000;
        let status = ["OK", "ERROR", "UNSET"][index % 3];
        let status_message = if index % 3 == 1 {
            Some("boom")
        } else {
            None
        };
        tx.execute(
            "INSERT INTO telemetry_spans
                (trace_id, span_id, parent_span_id, span_name, span_kind, start_time_ns, end_time_ns,
                 status_code, status_message, session_id, attributes_json, events_json, provider,
                 transport, event_type, ingested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                trace_id,
                span_id,
                Option::<String>::None,
                "chat",
                "INTERNAL",
                started,
                Some(started + 10_000_000),
                status,
                status_message,
                format!("s{index:06}"),
                Some(format!("{{\"i\":{index}}}")),
                Option::<String>::None,
                Some("opencode"),
                Some("otlp"),
                Some("chat.message"),
                stamp(index),
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_telemetry_logs(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        let level = ["INFO", "WARN", "ERROR"][index % 3];
        tx.execute(
            "INSERT INTO telemetry_logs
                (id, timestamp, level, target, message, attributes_json, trace_id, span_id, session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                (index as i64) + 1,
                stamp(index),
                level,
                "fredo::test",
                format!("log line {index}"),
                Some("{}"),
                Some(format!("trace-{:06}", index / 2)),
                Some(format!("span-{index:06}")),
                Some(format!("s{index:06}")),
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_telemetry_metrics(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        tx.execute(
            "INSERT INTO telemetry_metrics
                (id, metric_name, metric_type, labels_json, value, timestamp, aggregation_window_s)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                (index as i64) + 1,
                "gen_ai.client.token.usage",
                "histogram",
                Some("{}"),
                (index as f64) * 1.5,
                stamp(index),
                60i64,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn seed_feature_items(conn: &Connection, count: usize) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for index in 0..count {
        let i = index as i64;
        let payload = if index % 5 == 0 {
            None
        } else {
            Some(vec![(index % 256) as u8, 0, 255])
        };
        tx.execute(
            "INSERT INTO feature_mission_monitor_items
                (id, label, \"count\", ratio, payload, _row_version, _updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                format!("item-{index:06}"),
                format!("item label {index}"),
                i * 2,
                (i as f64) * 0.125,
                payload,
                i + 1,
                stamp(index),
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}
