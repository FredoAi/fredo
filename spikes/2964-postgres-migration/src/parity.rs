//! Spike #2964 ST-4 — `parity` binary: the C2 migration / parity-check harness.
//!
//! Emits the C2 contract JSON (see `docs/research/2964-postgres-migration-approach/data-migration.md`)
//! at `results/parity.json` (override with `--out`). It **never opens the real
//! `fredo.db`** — it builds a small deterministic fixture *SQLite* file under its
//! own `target/spike-tmp/parity/` and carries it into a throwaway embedded
//! PostgreSQL, one-shot, exactly the way the design says a production cutover
//! would.
//!
//! ## What it demonstrates
//!
//! 1. **Per-store carry** for every `fredo.db` store named by R-5a —
//!    `chat_rows` / `tool_use_rows` / `agent_session_rows`
//!    (`infrastructure/rtdb/store.rs:310-385`), `telemetry_spans`
//!    (`infrastructure/storage/span_store.rs:66-93`), the `settings` KV
//!    (`infrastructure/storage/mod.rs:23-26`), the dynamic FeatureStore
//!    `feature_{id}_{table}` tables (`…/feature_store.rs:132-135,240-271`), and
//!    `feature_data_tables` / `feature_data_tombstones`
//!    (`infrastructure/feature_data/store.rs:67-82`).
//! 2. **`telemetry_spans` stays the READ-ONLY source** — the harness only ever
//!    `SELECT`s it (`read_only_source: true`); the design preserves the
//!    `SQLITE_OPEN_READ_ONLY` / `PRAGMA query_only=ON` invariant
//!    (`infrastructure/rtdb/backfill.rs:218,367`,
//!    `infrastructure/feature_data/backfill.rs:288`).
//! 3. **One-shot markers are DATA**, carried verbatim — `rtdb.backfill.completed`
//!    (`rtdb/backfill.rs:101`), `rtdb.backfill.provider.completed.v2`
//!    (`rtdb/backfill.rs:113`), and the per-table
//!    `feature_data_tables.backfill_done` (`feature_data/store.rs:73-74`). The
//!    harness asserts they arrive unchanged; re-deriving them would replay
//!    already-classified history.
//! 4. **Parity** — per table, a row-count comparison AND a SHA-256 content
//!    checksum computed identically on both legs.
//! 5. **Rollback** — a pre-cutover `VACUUM INTO` snapshot is re-opened and its
//!    per-table checksums re-verified against the pre-cutover source, proving the
//!    SQLite backout path (R-5b).
//!
//! ## The checksum rule (must be identical on both engines)
//!
//! Per table: rows ordered by PRIMARY KEY; each row encoded as the columns in a
//! fixed declared order, NULL as the single sentinel `N`, a value as `V` + its
//! normalized text, columns joined with `U+001F`, rows terminated with `U+001E`;
//! SHA-256 over the UTF-8 bytes (the shared [`postgres_migration_spike::harness`]
//! `encode_row` / `checksum_rows` helpers, already validated by ST-1's `schema`
//! check `content_checksum_match`). Normalization: integers decimal, REALs
//! `{:.6}` (so SQLite `REAL` and PG `DOUBLE PRECISION` agree), BLOBs lowercase
//! hex (SQLite blob bytes vs PG `bytea::text` `\x…`).
//!
//! ## Bounds / teardown (G-263/G-264)
//!
//! Embedded PostgreSQL runs through the shared bounded harness
//! (`harness::PgRuntime`): finite bound on every `pg_ctl` control command,
//! bounded `setup`/`start`/`stop` with a hard-kill fallback, guaranteed teardown
//! on every path, and a PID-reuse-guarded orphan sweep. The fixture data is tiny,
//! so the run is finite and bounded.
//!
//! ## Harness simplification (not the production design)
//!
//! Columns are bound to PostgreSQL as text and cast to the target column type
//! (`$n::<type>`); the production migration binds typed values. ST-1 already
//! validated typed statement translation; this harness is about *carry + parity*,
//! so the text bridge keeps it small and total.

use anyhow::{Context, Result};
use postgres::Row;
use postgres_migration_spike::harness::{self, PgRuntime};
use postgres_migration_spike::schema_defs as defs;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

// ── fixture DDL / rows (synthetic; never the real fredo.db) ──────────────────

const FIXTURE_EXTRA_DDL: &str = "\
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
    provider                   TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_started ON tool_use_rows(started_at_ns);
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
    provider                   TEXT NOT NULL DEFAULT 'unknown',
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
CREATE INDEX IF NOT EXISTS idx_telemetry_spans_session
    ON telemetry_spans(session_id, start_time_ns);
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
CREATE TABLE IF NOT EXISTS feature_mission_monitor_items (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    severity     TEXT,
    _row_version INTEGER NOT NULL,
    _updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feature_notes_entries (
    id           TEXT PRIMARY KEY,
    body         TEXT,
    pinned       INTEGER,
    _row_version INTEGER NOT NULL,
    _updated_at  TEXT NOT NULL
);";

const FIXTURE_EXTRA_ROWS: &str = "\
INSERT INTO tool_use_rows
 (session_id, correlation_id, seq, started_at_ns, ended_at_ns, updated_at, state,
  tool_name, tool_success, tool_error, duration_ms, tool_input_json, tool_output_json,
  is_subagent, raw_json, provider) VALUES
 ('s001','s001_1',1,1700000000000000000,1700000000005000000,'2026-01-01T00:00:01Z','closed',
  'read',1,NULL,42,'{\"path\":\"src/a.rs\"}','{\"ok\":true}',0,'{\"k\":1}','opencode'),
 ('s001','s001_2',2,1700000001000000000,NULL,'2026-01-01T00:00:02Z','running',
  'bash',0,'exit 1',900,'{\"cmd\":\"ls\"}',NULL,0,'{\"k\":2}','opencode'),
 ('s002','s002_1',1,1700000002000000000,1700000002001000000,'2026-01-01T00:00:03Z','closed',
  'grep',1,NULL,12,NULL,NULL,1,'{\"k\":3}','claude');

INSERT INTO agent_session_rows
 (session_id, correlation_id, seq, started_at_ns, ended_at_ns, updated_at, state,
  total_tokens, total_messages, total_cost_usd, agent_name, raw_json, provider) VALUES
 ('s001','agent:s001',1,1700000000000000000,1700000060000000000,'2026-01-01T00:01:00Z','closed',
  1234,8,0.012345,'build','{\"agent\":\"build\"}','opencode'),
 ('s002','agent:s002',1,1700000002000000000,NULL,'2026-01-01T00:02:00Z','running',
  55,2,NULL,'plan','{\"agent\":\"plan\"}','claude');

INSERT INTO telemetry_spans
 (trace_id, span_id, parent_span_id, span_name, span_kind, start_time_ns, end_time_ns,
  status_code, status_message, session_id, attributes_json, events_json, provider,
  transport, event_type, ingested_at) VALUES
 ('trace1','span1',NULL,'chat','INTERNAL',1700000000000000000,1700000000005000000,'UNSET',NULL,
  's001','{\"gen_ai.operation.name\":\"chat\"}','[]','opencode','otlp','chat.message','2026-01-01T00:00:01Z'),
 ('trace1','span2','span1','tool.read','INTERNAL',1700000001000000000,1700000001002000000,'OK',NULL,
  's001','{\"gen_ai.operation.name\":\"tool.read\"}',NULL,NULL,'otlp','tool','2026-01-01T00:00:02Z'),
 ('trace2','span3',NULL,'session','INTERNAL',1700000002000000000,NULL,'ERROR','boom',
  's002',NULL,NULL,NULL,'otlp',NULL,'2026-01-01T00:00:03Z');

INSERT INTO feature_data_tables
 (feature_id, table_name, declaration_json, declaration_revision, last_version, backfill_done) VALUES
 ('mission-monitor','items','{\"tableName\":\"items\",\"source\":{\"kind\":\"row\",\"from\":\"Chat\"}}','rev-1',7,1),
 ('notes','entries','{\"tableName\":\"entries\",\"source\":{\"kind\":\"row\",\"from\":\"ToolUse\"}}','rev-2',3,0);

INSERT INTO feature_data_tombstones (feature_id, table_name, key_json, deleted_at) VALUES
 ('notes','entries','{\"id\":\"n-9\"}','2026-01-02T00:00:00Z'),
 ('mission-monitor','items','{\"id\":\"m-3\"}','2026-01-03T00:00:00Z');

INSERT INTO feature_mission_monitor_items (id, label, severity, _row_version, _updated_at) VALUES
 ('m-1','Alpha','high',1,'2026-01-01T00:00:00Z'),
 ('m-2','Beta',NULL,3,'2026-01-01T01:00:00Z');

INSERT INTO feature_notes_entries (id, body, pinned, _row_version, _updated_at) VALUES
 ('n-1','hello',1,1,'2026-01-01T00:00:00Z'),
 ('n-2',NULL,0,2,'2026-01-01T02:00:00Z'),
 ('n-3','unicode héllo ✅ 漢字',1,5,'2026-01-01T03:00:00Z');";

/// PostgreSQL for the fixture tables that `schema_defs::PG_DDL` does not create
/// (it covers only `chat_rows` + `settings` — the ST-1 pair).
const PG_EXTRA_DDL: &str = "\
CREATE TABLE IF NOT EXISTS tool_use_rows (
    session_id                 TEXT NOT NULL,
    correlation_id             TEXT NOT NULL,
    seq                        BIGINT NOT NULL,
    started_at_ns              BIGINT,
    ended_at_ns                BIGINT,
    updated_at                 TEXT NOT NULL,
    state                      TEXT NOT NULL,
    tool_name                  TEXT,
    tool_success               BIGINT,
    tool_error                 TEXT,
    duration_ms                BIGINT,
    tool_input_json            TEXT,
    tool_output_json           TEXT,
    is_subagent                BIGINT,
    raw_json                   TEXT NOT NULL,
    provider                   TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_started ON tool_use_rows(started_at_ns);
CREATE TABLE IF NOT EXISTS agent_session_rows (
    session_id                 TEXT NOT NULL,
    correlation_id             TEXT NOT NULL,
    seq                        BIGINT NOT NULL,
    started_at_ns              BIGINT,
    ended_at_ns                BIGINT,
    updated_at                 TEXT NOT NULL,
    state                      TEXT NOT NULL,
    total_tokens               BIGINT,
    total_messages             BIGINT,
    total_cost_usd             DOUBLE PRECISION,
    agent_name                 TEXT,
    raw_json                   TEXT NOT NULL,
    provider                   TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE TABLE IF NOT EXISTS telemetry_spans (
    trace_id        TEXT NOT NULL,
    span_id         TEXT PRIMARY KEY,
    parent_span_id  TEXT,
    span_name       TEXT NOT NULL,
    span_kind       TEXT NOT NULL DEFAULT 'INTERNAL',
    start_time_ns   BIGINT NOT NULL,
    end_time_ns     BIGINT,
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
CREATE INDEX IF NOT EXISTS idx_telemetry_spans_session
    ON telemetry_spans(session_id, start_time_ns);
CREATE TABLE IF NOT EXISTS feature_data_tables (
    feature_id            TEXT NOT NULL,
    table_name            TEXT NOT NULL,
    declaration_json      TEXT NOT NULL,
    declaration_revision  TEXT NOT NULL,
    last_version          BIGINT NOT NULL DEFAULT 0,
    backfill_done         BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (feature_id, table_name)
);
CREATE TABLE IF NOT EXISTS feature_data_tombstones (
    feature_id  TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    key_json    TEXT NOT NULL,
    deleted_at  TEXT NOT NULL,
    PRIMARY KEY (feature_id, table_name, key_json)
);";

// ── column model ─────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ColKind {
    Text,
    Int,
    Real,
    Blob,
}

impl ColKind {
    /// C1: SQLite type → PostgreSQL type (`docs`/`schema_defs.rs:14-22`).
    fn c1(self) -> &'static str {
        match self {
            ColKind::Text => "TEXT",
            ColKind::Int => "BIGINT",
            ColKind::Real => "DOUBLE PRECISION",
            ColKind::Blob => "BYTEA",
        }
    }

    fn from_sqlite_type(t: &str) -> Self {
        match t.to_ascii_uppercase().as_str() {
            "INTEGER" => ColKind::Int,
            "REAL" => ColKind::Real,
            "BLOB" => ColKind::Blob,
            _ => ColKind::Text,
        }
    }

    /// PostgreSQL type name for the column (C1 target).
    fn pg_type(self) -> &'static str {
        match self {
            ColKind::Text => "text",
            ColKind::Int => "bigint",
            ColKind::Real => "double precision",
            ColKind::Blob => "bytea",
        }
    }
}

/// One table to carry + compare. `not_null` is only used to emit the PG DDL of
/// a dynamic (FeatureStore) table; fixed tables are created from the DDL above.
struct TableSpec {
    name: String,
    columns: Vec<(String, ColKind)>,
    not_null: Vec<bool>,
    pk: Vec<String>,
}

impl TableSpec {
    fn fixed(name: &str, columns: &[(&str, ColKind)], pk: &[&str]) -> Self {
        Self {
            name: name.to_string(),
            columns: columns
                .iter()
                .map(|(n, k)| (n.to_string(), *k))
                .collect(),
            not_null: Vec::new(),
            pk: pk.iter().map(|c| c.to_string()).collect(),
        }
    }

    fn ordered_cols(&self) -> Vec<String> {
        let cols = if self.pk.is_empty() {
            self.columns.iter().map(|(n, _)| n.clone()).collect()
        } else {
            self.pk.clone()
        };
        cols
    }

    fn order_by(&self) -> String {
        self.ordered_cols()
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn fixed_specs() -> Vec<TableSpec> {
    use ColKind::*;
    vec![
        TableSpec::fixed(
            "chat_rows",
            &[
                ("session_id", Text),
                ("correlation_id", Text),
                ("seq", Int),
                ("started_at_ns", Int),
                ("ended_at_ns", Int),
                ("updated_at", Text),
                ("state", Text),
                ("user_message", Text),
                ("agent_reply", Text),
                ("prompt_tokens", Int),
                ("completion_tokens", Int),
                ("cache_read_tokens", Int),
                ("cost_usd", Real),
                ("model", Text),
                ("parent_session_id", Text),
                ("composited_child_session_id", Text),
                ("raw_json", Text),
                ("provider", Text),
            ],
            &["session_id", "correlation_id"],
        ),
        TableSpec::fixed(
            "tool_use_rows",
            &[
                ("session_id", Text),
                ("correlation_id", Text),
                ("seq", Int),
                ("started_at_ns", Int),
                ("ended_at_ns", Int),
                ("updated_at", Text),
                ("state", Text),
                ("tool_name", Text),
                ("tool_success", Int),
                ("tool_error", Text),
                ("duration_ms", Int),
                ("tool_input_json", Text),
                ("tool_output_json", Text),
                ("is_subagent", Int),
                ("raw_json", Text),
                ("provider", Text),
            ],
            &["session_id", "correlation_id"],
        ),
        TableSpec::fixed(
            "agent_session_rows",
            &[
                ("session_id", Text),
                ("correlation_id", Text),
                ("seq", Int),
                ("started_at_ns", Int),
                ("ended_at_ns", Int),
                ("updated_at", Text),
                ("state", Text),
                ("total_tokens", Int),
                ("total_messages", Int),
                ("total_cost_usd", Real),
                ("agent_name", Text),
                ("raw_json", Text),
                ("provider", Text),
            ],
            &["session_id", "correlation_id"],
        ),
        TableSpec::fixed(
            "telemetry_spans",
            &[
                ("trace_id", Text),
                ("span_id", Text),
                ("parent_span_id", Text),
                ("span_name", Text),
                ("span_kind", Text),
                ("start_time_ns", Int),
                ("end_time_ns", Int),
                ("status_code", Text),
                ("status_message", Text),
                ("session_id", Text),
                ("attributes_json", Text),
                ("events_json", Text),
                ("provider", Text),
                ("transport", Text),
                ("event_type", Text),
                ("ingested_at", Text),
            ],
            &["span_id"],
        ),
        TableSpec::fixed("settings", &[("key", Text), ("value", Text)], &["key"]),
        TableSpec::fixed(
            "feature_data_tables",
            &[
                ("feature_id", Text),
                ("table_name", Text),
                ("declaration_json", Text),
                ("declaration_revision", Text),
                ("last_version", Int),
                ("backfill_done", Int),
            ],
            &["feature_id", "table_name"],
        ),
        TableSpec::fixed(
            "feature_data_tombstones",
            &[
                ("feature_id", Text),
                ("table_name", Text),
                ("key_json", Text),
                ("deleted_at", Text),
            ],
            &["feature_id", "table_name", "key_json"],
        ),
    ]
}

// ── JSON report (the C2 contract) ────────────────────────────────────────────

#[derive(Serialize)]
struct Engine {
    source: String,
    target: String,
    mode: String,
    acquisition_mode: String,
}

#[derive(Serialize)]
struct Checksum {
    sqlite: String,
    pg: String,
    #[serde(rename = "match")]
    matches: bool,
}

#[derive(Serialize)]
struct FeatureTableParity {
    feature_id: String,
    table_name: String,
    name: String,
    sqlite_rows: i64,
    pg_rows: i64,
    row_count_match: bool,
    checksum_match: bool,
}

#[derive(Serialize)]
struct TableParity {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_only_source: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enumerated_from: Option<String>,
    sqlite_rows: i64,
    pg_rows: i64,
    row_count_match: bool,
    content_checksum: Checksum,
    #[serde(rename = "match", skip_serializing_if = "Option::is_none")]
    matches: Option<bool>,
    primary_key: Vec<String>,
    ordered_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    per_table: Option<Vec<FeatureTableParity>>,
}

#[derive(Serialize)]
struct Markers {
    #[serde(rename = "rtdb.backfill.completed")]
    rtdb_backfill_completed: Option<String>,
    #[serde(rename = "rtdb.backfill.provider.completed.v2")]
    rtdb_backfill_provider_completed_v2: Option<String>,
    #[serde(rename = "feature_data_tables.backfill_done")]
    feature_data_tables_backfill_done: BTreeMap<String, bool>,
    carried_unchanged: bool,
    read_only_source: bool,
}

#[derive(Serialize)]
struct RollbackDemo {
    backout_executed: bool,
    restored_checksums_match: bool,
    snapshot: String,
}

#[derive(Serialize)]
struct Rollback {
    backout: String,
    verified: bool,
    mechanism: String,
    fixture_demonstration: RollbackDemo,
}

#[derive(Serialize)]
struct Environment {
    os: String,
    arch: String,
    profile: String,
    crate_version: String,
}

#[derive(Serialize)]
struct Summary {
    tables_total: usize,
    tables_matched: usize,
    markers_carried: bool,
    rollback_demo_ok: bool,
    all_parity_ok: bool,
}

#[derive(Serialize)]
struct Report {
    issue: u32,
    engine: Engine,
    tables: Vec<TableParity>,
    one_shot_markers: Markers,
    rollback: Rollback,
    environment: Environment,
    summary: Summary,
    duration_ms: u128,
}

// ── fixture + encoding helpers ───────────────────────────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn sqlite_cell(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<Option<String>> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(idx)? {
        ValueRef::Null => None,
        ValueRef::Integer(v) => Some(v.to_string()),
        ValueRef::Real(f) => Some(format!("{f:.6}")),
        ValueRef::Text(b) => Some(String::from_utf8_lossy(b).into_owned()),
        ValueRef::Blob(b) => Some(to_hex(b)),
    })
}

/// Normalize a PostgreSQL `::text` rendering to the canonical row encoding.
fn pg_cell(row: &Row, idx: usize, kind: ColKind) -> Option<String> {
    let raw: Option<String> = row.get(idx);
    let raw = raw?;
    Some(match kind {
        ColKind::Text => raw,
        ColKind::Int => raw.parse::<i64>().map(|v| v.to_string()).unwrap_or(raw),
        ColKind::Real => format!("{:.6}", raw.parse::<f64>().unwrap_or(f64::NAN)),
        ColKind::Blob => raw
            .strip_prefix("\\x")
            .unwrap_or(&raw)
            .to_ascii_lowercase(),
    })
}

fn build_fixture(conn: &Connection) -> Result<()> {
    conn.execute_batch(defs::SQLITE_DDL)?;
    conn.execute_batch(FIXTURE_EXTRA_DDL)?;
    // Reuse ST-1's deterministic chat workload + production upsert path.
    let chats = harness::generate(24, 21, 2964);
    harness::sqlite_apply(conn, &chats)?;
    conn.execute_batch(FIXTURE_EXTRA_ROWS)?;
    // The three one-shot markers the migration must carry verbatim, plus
    // unrelated settings so the settings parity leg is not marker-only.
    for (k, v) in [
        ("rtdb.backfill.completed", "2026-09-20T10:00:00+00:00"),
        ("rtdb.backfill.provider.completed.v2", "2026-09-21T11:30:00+00:00"),
        ("rtdb.retention.days", "30"),
        ("theme", "dark"),
    ] {
        conn.execute(defs::SQLITE_SETTINGS_UPSERT, rusqlite::params![k, v])?;
    }
    Ok(())
}

struct FeatureTable {
    feature_id: String,
    table_name: String,
    full_name: String,
}

/// Enumerate the dynamic FeatureStore tables FROM `feature_data_tables` (the
/// C2 `enumerated_from` rule), applying the store's namespace rule
/// (`feature_store.rs:132-135`: hyphens → underscores).
fn enumerate_feature_tables(conn: &Connection) -> Result<Vec<FeatureTable>> {
    let mut stmt = conn.prepare(
        "SELECT feature_id, table_name FROM feature_data_tables
         ORDER BY feature_id, table_name",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(feature_id, table_name)| FeatureTable {
            full_name: format!(
                "feature_{}_{}",
                feature_id.replace('-', "_"),
                table_name
            ),
            feature_id,
            table_name,
        })
        .collect())
}

fn dynamic_spec(conn: &Connection, full_name: &str) -> Result<TableSpec> {
    let mut stmt = conn.prepare(
        "SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1) ORDER BY cid",
    )?;
    let rows = stmt
        .query_map([full_name], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut columns = Vec::with_capacity(rows.len());
    let mut not_null = Vec::with_capacity(rows.len());
    let mut pk = Vec::new();
    for (name, ty, nn, is_pk) in rows {
        columns.push((name.clone(), ColKind::from_sqlite_type(&ty)));
        not_null.push(nn != 0);
        if is_pk != 0 {
            pk.push(name);
        }
    }
    Ok(TableSpec {
        name: full_name.to_string(),
        columns,
        not_null,
        pk,
    })
}

/// Create the PostgreSQL counterpart of a dynamic FeatureStore table using the
/// C1 type mapping read from the SQLite `pragma_table_info`.
fn create_pg_dynamic_table(client: &mut postgres::Client, spec: &TableSpec) -> Result<()> {
    let mut defs_out: Vec<String> = Vec::with_capacity(spec.columns.len());
    for (i, (name, kind)) in spec.columns.iter().enumerate() {
        let mut d = format!("\"{name}\" {}", kind.c1());
        if spec.not_null.get(i).copied().unwrap_or(false) {
            d.push_str(" NOT NULL");
        }
        if spec.pk.len() == 1 && spec.pk[0] == *name {
            d.push_str(" PRIMARY KEY");
        }
        defs_out.push(d);
    }
    if spec.pk.len() > 1 {
        defs_out.push(format!(
            "PRIMARY KEY ({})",
            spec.pk
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS \"{}\" ({});",
        spec.name,
        defs_out.join(", ")
    );
    client
        .batch_execute(&sql)
        .with_context(|| format!("create pg table {}", spec.name))?;
    Ok(())
}

// ── snapshots (counts + checksums, identical encoding on both engines) ───────

fn snapshot_sqlite(
    conn: &Connection,
    specs: &[TableSpec],
) -> Result<BTreeMap<String, (i64, String)>> {
    let mut out = BTreeMap::new();
    for spec in specs {
        let select = format!(
            "SELECT {} FROM \"{}\" ORDER BY {}",
            spec.columns
                .iter()
                .map(|(n, _)| format!("\"{n}\""))
                .collect::<Vec<_>>()
                .join(", "),
            spec.name,
            spec.order_by()
        );
        let mut stmt = conn.prepare(&select)?;
        let mut rows = stmt.query([])?;
        let mut encoded = Vec::new();
        while let Some(row) = rows.next()? {
            let mut cells = Vec::with_capacity(spec.columns.len());
            for i in 0..spec.columns.len() {
                cells.push(sqlite_cell(row, i)?);
            }
            encoded.push(harness::encode_row(&cells));
        }
        out.insert(
            spec.name.clone(),
            (encoded.len() as i64, harness::checksum_rows(&encoded)),
        );
    }
    Ok(out)
}

fn snapshot_pg(
    client: &mut postgres::Client,
    specs: &[TableSpec],
) -> Result<BTreeMap<String, (i64, String)>> {
    let mut out = BTreeMap::new();
    for spec in specs {
        let select = format!(
            "SELECT {} FROM \"{}\" ORDER BY {}",
            spec.columns
                .iter()
                .map(|(n, _)| format!("\"{n}\"::text"))
                .collect::<Vec<_>>()
                .join(", "),
            spec.name,
            spec.order_by()
        );
        let rows = client
            .query(select.as_str(), &[])
            .with_context(|| format!("pg snapshot {}", spec.name))?;
        let mut encoded = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut cells = Vec::with_capacity(spec.columns.len());
            for (i, (_, kind)) in spec.columns.iter().enumerate() {
                cells.push(pg_cell(row, i, *kind));
            }
            encoded.push(harness::encode_row(&cells));
        }
        out.insert(
            spec.name.clone(),
            (rows.len() as i64, harness::checksum_rows(&encoded)),
        );
    }
    Ok(out)
}

/// One-shot copy of every column, ordered by PK, into PostgreSQL. Columns are
/// bound as text and cast to the target type (see the module note).
fn migrate_table(conn: &Connection, client: &mut postgres::Client, spec: &TableSpec) -> Result<()> {
    let col_list = spec
        .columns
        .iter()
        .map(|(n, _)| format!("\"{n}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let select = format!(
        "SELECT {col_list} FROM \"{}\" ORDER BY {}",
        spec.name,
        spec.order_by()
    );
    let mut stmt = conn.prepare(&select)?;
    let mut rows = stmt.query([])?;
    let mut batch: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(row) = rows.next()? {
        let mut vals = Vec::with_capacity(spec.columns.len());
        for i in 0..spec.columns.len() {
            vals.push(sqlite_cell(row, i)?);
        }
        batch.push(vals);
    }
    drop(rows);
    drop(stmt);

    let casted = spec
        .columns
        .iter()
        .enumerate()
        .map(|(i, (_, kind))| format!("${}::text::{}", i + 1, kind.pg_type()))
        .collect::<Vec<_>>()
        .join(", ");
    let insert = format!(
        "INSERT INTO \"{}\" ({col_list}) VALUES ({casted}) ON CONFLICT DO NOTHING",
        spec.name
    );
    let insert_stmt = client.prepare(&insert)?;
    let mut tx = client.transaction()?;
    for row in &batch {
        let params: Vec<&(dyn postgres::types::ToSql + Sync)> =
            row.iter().map(|v| v as &(dyn postgres::types::ToSql + Sync)).collect();
        tx.execute(&insert_stmt, &params)?;
    }
    tx.commit()?;
    Ok(())
}

// ── one-shot markers (DATA, carried verbatim) ────────────────────────────────

#[derive(PartialEq, Eq, Debug)]
struct RawMarkers {
    completed: Option<String>,
    provider: Option<String>,
    backfill_done: BTreeMap<String, bool>,
}

fn read_markers_sqlite(conn: &Connection) -> Result<RawMarkers> {
    let get = |key: &str| -> Result<Option<String>> {
        Ok(conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |r| r.get(0),
            )
            .optional()?)
    };
    let mut stmt = conn.prepare(
        "SELECT feature_id, table_name, backfill_done FROM feature_data_tables
         ORDER BY feature_id, table_name",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(RawMarkers {
        completed: get("rtdb.backfill.completed")?,
        provider: get("rtdb.backfill.provider.completed.v2")?,
        backfill_done: rows
            .into_iter()
            .map(|(f, t, d)| (format!("{f}.{t}"), d != 0))
            .collect(),
    })
}

fn pg_setting(client: &mut postgres::Client, key: &str) -> Result<Option<String>> {
    Ok(client
        .query_opt("SELECT value FROM settings WHERE key = $1", &[&key])?
        .map(|r| r.get(0)))
}

fn read_markers_pg(client: &mut postgres::Client) -> Result<RawMarkers> {
    let rows = client.query(
        "SELECT feature_id, table_name, backfill_done FROM feature_data_tables
         ORDER BY feature_id, table_name",
        &[],
    )?;
    Ok(RawMarkers {
        completed: pg_setting(client, "rtdb.backfill.completed")?,
        provider: pg_setting(client, "rtdb.backfill.provider.completed.v2")?,
        backfill_done: rows
            .iter()
            .map(|r| {
                (
                    format!("{}.{}", r.get::<_, String>(0), r.get::<_, String>(1)),
                    r.get::<_, i64>(2) != 0,
                )
            })
            .collect(),
    })
}

/// SHA-256 over the concatenation of `name + ":" + digest + "\n"` in sort order
/// — the aggregate digest of the dynamic `feature_*` tables.
fn combine_digests(parts: &[(String, String)]) -> String {
    let mut sorted = parts.to_vec();
    sorted.sort();
    let mut h = Sha256::new();
    for (name, digest) in &sorted {
        h.update(name.as_bytes());
        h.update(b":");
        h.update(digest.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

fn make_entry(
    spec: &TableSpec,
    sqlite: &BTreeMap<String, (i64, String)>,
    pg: &BTreeMap<String, (i64, String)>,
) -> TableParity {
    let (s_rows, s_sum) = sqlite.get(&spec.name).cloned().unwrap_or_default();
    let (p_rows, p_sum) = pg.get(&spec.name).cloned().unwrap_or_default();
    TableParity {
        name: spec.name.clone(),
        read_only_source: None,
        enumerated_from: None,
        sqlite_rows: s_rows,
        pg_rows: p_rows,
        row_count_match: s_rows == p_rows,
        content_checksum: Checksum {
            sqlite: s_sum.clone(),
            pg: p_sum.clone(),
            matches: s_sum == p_sum,
        },
        matches: None,
        primary_key: spec.ordered_cols(),
        ordered_by: spec.ordered_cols(),
        per_table: None,
    }
}

fn run_all(
    url: &str,
    port: u16,
    source_db: &Path,
    snapshot_db: &Path,
    restore_db: &Path,
) -> Result<Report> {
    let start = Instant::now();
    for p in [source_db, snapshot_db, restore_db] {
        if p.exists() {
            std::fs::remove_file(p)?;
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
    }

    // 1) Fixture + pre-cutover snapshot.
    let sqlite = Connection::open(source_db).context("open fixture sqlite")?;
    build_fixture(&sqlite)?;
    let feature_tables = enumerate_feature_tables(&sqlite)?;

    let mut specs = fixed_specs();
    for ft in &feature_tables {
        specs.push(dynamic_spec(&sqlite, &ft.full_name)?);
    }

    let source = snapshot_sqlite(&sqlite, &specs)?;
    let src_markers = read_markers_sqlite(&sqlite)?;
    sqlite.execute_batch(&format!(
        "VACUUM INTO '{}'",
        snapshot_db.display().to_string().replace('\'', "''")
    ))?;

    // 2) PostgreSQL: schema + one-shot carry.
    let mut client = harness::connect_until_ready(url).context("connect embedded postgres")?;
    client.batch_execute(defs::PG_DDL)?;
    client.batch_execute(PG_EXTRA_DDL)?;
    for ft in &feature_tables {
        let spec = dynamic_spec(&sqlite, &ft.full_name)?;
        create_pg_dynamic_table(&mut client, &spec)?;
    }
    for spec in &specs {
        migrate_table(&sqlite, &mut client, spec)
            .with_context(|| format!("migrate {}", spec.name))?;
    }

    // 3) PostgreSQL snapshot + marker verification.
    let pg = snapshot_pg(&mut client, &specs)?;
    let pg_markers = read_markers_pg(&mut client)?;
    let markers_carried = src_markers == pg_markers;

    // 4) Parity entries: the fixed stores, then the aggregated feature_* group.
    let fixed_names = [
        "chat_rows",
        "tool_use_rows",
        "agent_session_rows",
        "telemetry_spans",
        "settings",
        "feature_data_tables",
        "feature_data_tombstones",
    ];
    let mut entries = Vec::new();
    for name in fixed_names {
        let Some(spec) = specs.iter().find(|s| s.name == name) else {
            continue;
        };
        let mut entry = make_entry(spec, &source, &pg);
        if name == "telemetry_spans" {
            entry.read_only_source = Some(true);
        }
        entries.push(entry);
    }

    let mut feature_parts_sqlite: Vec<(String, String)> = Vec::new();
    let mut feature_parts_pg: Vec<(String, String)> = Vec::new();
    let mut feature_rows_sqlite = 0i64;
    let mut feature_rows_pg = 0i64;
    let mut feature_checksums_match = true;
    let mut per_table = Vec::new();
    for ft in &feature_tables {
        let (s_rows, s_sum) = source.get(&ft.full_name).cloned().unwrap_or_default();
        let (p_rows, p_sum) = pg.get(&ft.full_name).cloned().unwrap_or_default();
        feature_rows_sqlite += s_rows;
        feature_rows_pg += p_rows;
        feature_parts_sqlite.push((ft.full_name.clone(), s_sum.clone()));
        feature_parts_pg.push((ft.full_name.clone(), p_sum.clone()));
        feature_checksums_match &= s_sum == p_sum;
        per_table.push(FeatureTableParity {
            feature_id: ft.feature_id.clone(),
            table_name: ft.table_name.clone(),
            name: ft.full_name.clone(),
            sqlite_rows: s_rows,
            pg_rows: p_rows,
            row_count_match: s_rows == p_rows,
            checksum_match: s_sum == p_sum,
        });
    }
    let feature_sqlite_digest = combine_digests(&feature_parts_sqlite);
    let feature_pg_digest = combine_digests(&feature_parts_pg);
    entries.push(TableParity {
        name: "feature_*".to_string(),
        read_only_source: None,
        enumerated_from: Some("feature_data_tables".to_string()),
        sqlite_rows: feature_rows_sqlite,
        pg_rows: feature_rows_pg,
        row_count_match: feature_rows_sqlite == feature_rows_pg,
        content_checksum: Checksum {
            sqlite: feature_sqlite_digest,
            pg: feature_pg_digest,
            matches: feature_checksums_match,
        },
        matches: Some(feature_checksums_match && feature_rows_sqlite == feature_rows_pg),
        primary_key: vec![],
        ordered_by: vec![],
        per_table: Some(per_table),
    });

    // 5) Rollback demonstration: restore the pre-cutover snapshot and re-verify
    //    that its per-table content equals the pre-cutover source.
    std::fs::copy(snapshot_db, restore_db).context("copy pre-cutover snapshot")?;
    let restored = Connection::open(restore_db).context("open restored snapshot")?;
    let restored_snap = snapshot_sqlite(&restored, &specs)?;
    let restored_checksums_match = specs
        .iter()
        .all(|s| source.get(&s.name) == restored_snap.get(&s.name));

    let all_parity_ok = entries.iter().all(|e| {
        e.row_count_match
            && e.content_checksum.matches
            && e.matches.unwrap_or(true)
    });
    let matched = entries
        .iter()
        .filter(|e| e.row_count_match && e.content_checksum.matches)
        .count();
    let tables_total = entries.len();

    Ok(Report {
        issue: 2964,
        engine: Engine {
            source: "sqlite:fredo.db".to_string(),
            target: format!("postgresql:127.0.0.1:{port}"),
            mode: "one-shot".to_string(),
            acquisition_mode: harness::ACQUISITION_MODE.to_string(),
        },
        tables: entries,
        one_shot_markers: Markers {
            rtdb_backfill_completed: src_markers.completed.clone(),
            rtdb_backfill_provider_completed_v2: src_markers.provider.clone(),
            feature_data_tables_backfill_done: src_markers.backfill_done.clone(),
            carried_unchanged: markers_carried,
            read_only_source: true,
        },
        rollback: Rollback {
            backout: "restore fredo.db from pre-cutover copy".to_string(),
            // The production cutover has not been performed, so the production
            // rollback is not verified; the fixture demonstration below proves
            // the mechanism.
            verified: false,
            mechanism: "VACUUM INTO a pre-cutover snapshot, re-open it and re-verify \
                        per-table row counts + content checksums against the source"
                .to_string(),
            fixture_demonstration: RollbackDemo {
                backout_executed: true,
                restored_checksums_match,
                snapshot: "target/spike-tmp/parity/snapshot/fredo.pre-cutover.db".to_string(),
            },
        },
        environment: Environment {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
            .to_string(),
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        summary: Summary {
            tables_total,
            tables_matched: matched,
            markers_carried,
            rollback_demo_ok: restored_checksums_match,
            all_parity_ok,
        },
        duration_ms: start.elapsed().as_millis(),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = manifest.join("target/spike-tmp/parity");
    let source_db = base.join("source/fredo.fixture.db");
    let snapshot_db = base.join("snapshot/fredo.pre-cutover.db");
    let restore_db = base.join("restore/fredo.db");
    let pg_data = base.join("pg-data");
    let install_dir = harness::arg_value("--install-dir")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-pg-install"));
    let out = harness::arg_value("--out")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| manifest.join("results/parity.json"));

    if pg_data.exists() {
        let _ = std::fs::remove_dir_all(&pg_data);
    }
    std::fs::create_dir_all(&pg_data).context("create pg data dir")?;
    if let Some(pid) = harness::sweep_orphans(&pg_data) {
        println!("swept orphan postmaster pid {pid} before start");
    }

    println!("spike #2964 ST-4 — data-migration parity + rollback harness");
    println!("acquisition mode : {}", harness::ACQUISITION_MODE);
    println!("fixture source   : {}", source_db.display());
    println!("installation dir : {}", install_dir.display());

    let mut pg = PgRuntime::new(pg_data.clone(), install_dir);
    pg.setup().await.context("embedded postgres setup")?;
    pg.start().await.context("embedded postgres start")?;
    let port = pg.port();
    let url = pg.url();
    println!("server up on 127.0.0.1:{port}");

    let result = tokio::task::spawn_blocking({
        let url = url.clone();
        let source_db = source_db.clone();
        let snapshot_db = snapshot_db.clone();
        let restore_db = restore_db.clone();
        move || run_all(&url, port, &source_db, &snapshot_db, &restore_db)
    })
    .await
    .context("join parity task")?;

    // Bounded teardown on the normal path (Drop covers error/panic paths).
    pg.shutdown().await;

    let report = result?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).context("create results dir")?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)
        .with_context(|| format!("write {}", out.display()))?;

    for entry in &report.tables {
        println!(
            "  [{}] {} — sqlite={} pg={} rows_match={} checksum_match={}",
            if entry.row_count_match && entry.content_checksum.matches {
                "ok"
            } else {
                "FAIL"
            },
            entry.name,
            entry.sqlite_rows,
            entry.pg_rows,
            entry.row_count_match,
            entry.content_checksum.matches
        );
    }
    println!(
        "tables {}/{} matched; markers carried unchanged={}; rollback demo ok={}",
        report.summary.tables_matched,
        report.summary.tables_total,
        report.summary.markers_carried,
        report.summary.rollback_demo_ok
    );
    println!("results written to {}", out.display());
    println!(
        "OK — fixture migration parity + marker carry + rollback demonstrated ({:.0} ms, bounded teardown)",
        report.duration_ms as f64
    );

    anyhow::ensure!(
        report.summary.all_parity_ok && report.summary.markers_carried && report.summary.rollback_demo_ok,
        "parity failed; see {}",
        out.display()
    );
    Ok(())
}
