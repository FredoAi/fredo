//! ST-10 — upgrade-path verification (round-2 fix): a pre-existing legacy
//! `fredo.db` is REPAIRED in place, never wiped.
//!
//! Round 1 shipped with the declared `mission-monitor.sessions` physical name
//! colliding with the legacy Mission Monitor table left behind by the deleted
//! `lib/persistence.ts`: `CREATE TABLE IF NOT EXISTS` silently no-op'd, so the
//! declared schema was never created, every projection failed with
//! `no such column: sessionId`, and the one-time backfill marker was set
//! anyway. Every unit test used a fresh temp DB and therefore could not see it.
//!
//! This test builds a temp `fredo.db`, seeds the EXACT legacy DDL captured from
//! the live DB (plus a legacy deletion tombstone and canonical `chat_rows`),
//! then drives the real composition (`DeclarationRegistry` + `ProjectionEngine`
//! + `backfill_pending`) and asserts the full upgrade path:
//!
//! 1. declaring MM `sessions` creates the DECLARED columns and preserves the
//!    legacy table verbatim under `__legacy_*` (never dropped, row count
//!    unchanged);
//! 2. the stale `backfill_done = true` marker is re-armed to `false` with
//!    `last_version = 0`;
//! 3. the backfill projects one declared row per qualifying live session and
//!    only THEN sets `backfill_done = true` (and advances `last_version`);
//! 4. a subsequent `materialize_persisted` preserves the declared rows and
//!    rebuilds nothing;
//! 5. the migrated legacy tombstone keeps the deleted session out of the
//!    declared table;
//! 6. a deliberately broken declared table neither suppresses a healthy sibling
//!    nor gets its own `backfill_done` set.
//!
//! No product code is changed by this capsule, and the real `%APPDATA%` DB is
//! never touched — every fixture lives in a `tempfile::TempDir`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{json, Map, Value as JsonValue};

use fredo_lib::infrastructure::feature_data::backfill::backfill_pending;
use fredo_lib::infrastructure::feature_data::declaration::{
    ActivitySource, ColumnOwner, DataSource, DeclaredColumn, DeclaredColumnType,
    FeatureDataDeclaration, FeatureDataTableDeclaration, FieldMapping, RowProjection,
    RowProjectionKind,
};
use fredo_lib::infrastructure::feature_data::projection::ProjectionEngine;
use fredo_lib::infrastructure::feature_data::registry::DeclarationRegistry;
use fredo_lib::infrastructure::feature_data::store::{FeatureDataStore, TableMeta};
use fredo_lib::infrastructure::rtdb::rows::{ChatRow, RowState};
use fredo_lib::infrastructure::rtdb::store::RtdbStore;
use fredo_lib::infrastructure::storage::feature_store::FeatureStore;

const FEATURE_ID: &str = "mission-monitor";
const DECLARED_TABLE: &str = "sessions";
const DECLARED_REVISION: &str = "mm.sessions.v1";
const LEGACY_SESSIONS_TABLE: &str = "feature_mission_monitor_sessions";
const LEGACY_DELETED_TABLE: &str = "feature_mission_monitor_deleted_sessions";

/// Captured VERBATIM from the live `%APPDATA%\com.fredo.app\fredo.db` (the
/// legacy Mission Monitor table created by the now-deleted `lib/persistence.ts`).
const LEGACY_MM_DDL: &str = "CREATE TABLE feature_mission_monitor_sessions (session_id TEXT PRIMARY KEY, label TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT, delivery_count INTEGER NOT NULL);";

/// The stores `lib.rs` opens over ONE `fredo.db` (temp here, never the real one).
struct Harness {
    _dir: tempfile::TempDir,
    data_dir: PathBuf,
    rtdb_store: Arc<RtdbStore>,
    meta: Arc<FeatureDataStore>,
    tables: Arc<FeatureStore>,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let data_dir = dir.path().to_path_buf();
    let rtdb_store = Arc::new(RtdbStore::open(data_dir.clone()).expect("rtdb store"));
    rtdb_store.ensure_schema().expect("rtdb schema");
    let meta = Arc::new(FeatureDataStore::open(data_dir.clone()).expect("feature data store"));
    meta.ensure_schema().expect("feature data schema");
    let tables = Arc::new(FeatureStore::open(data_dir.clone()).expect("feature store"));
    Harness {
        _dir: dir,
        data_dir,
        rtdb_store,
        meta,
        tables,
    }
}

/// A raw read-only-ish handle to the SAME temp `fredo.db`, for `pragma_table_info`
/// / `sqlite_master` inspection the public API does not expose.
fn raw(h: &Harness) -> Connection {
    Connection::open(h.data_dir.join("fredo.db")).expect("open temp fredo.db")
}

/// Physical column names of `table`, in `pragma_table_info` order.
fn columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .expect("prepare column query");
    let rows = stmt
        .query_map(rusqlite::params![table], |row| row.get::<_, String>(0))
        .expect("query columns");
    rows.map(|row| row.expect("column row")).collect()
}

/// Every `feature_mission_monitor_sessions__legacy_*` quarantine table.
fn quarantine_tables(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name GLOB 'feature_mission_monitor_sessions__legacy_*'
             ORDER BY name",
        )
        .expect("prepare quarantine query");
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query quarantine tables");
    rows.map(|row| row.expect("quarantine row")).collect()
}

fn row_count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .expect("count rows")
}

/// The shipped Mission-Monitor declaration shape, parsed from its wire JSON
/// (camelCase, `kind: "sessionRollup"`, the closed fact columns + the
/// feature-owned `customName`).
fn mm_declaration() -> FeatureDataDeclaration {
    FeatureDataDeclaration::parse(json!({
        "featureId": FEATURE_ID,
        "declarationRevision": DECLARED_REVISION,
        "tables": [{
            "name": DECLARED_TABLE,
            "primaryKey": ["sessionId"],
            "columns": [
                { "name": "sessionId", "type": "TEXT", "owner": "backend" },
                { "name": "startedAtNs", "type": "INTEGER", "owner": "backend", "nullable": true },
                { "name": "latestAt", "type": "TEXT", "owner": "backend" },
                { "name": "chatRowCount", "type": "INTEGER", "owner": "backend" },
                { "name": "nonSubagentChatRowCount", "type": "INTEGER", "owner": "backend" },
                { "name": "visibleTurnCount", "type": "INTEGER", "owner": "backend" },
                { "name": "userDispatchCount", "type": "INTEGER", "owner": "backend" },
                { "name": "derivedName", "type": "TEXT", "owner": "backend", "nullable": true },
                { "name": "agentName", "type": "TEXT", "owner": "backend", "nullable": true },
                { "name": "customName", "type": "TEXT", "owner": "feature", "nullable": true }
            ],
            "source": {
                "kind": "sessionRollup",
                "excludeDispatchNames": ["build", "plan"],
                "terminalStates": ["Response", "Timeout"]
            },
            "retention": { "maxRows": 500 }
        }]
    }))
    .expect("the shipped Mission-Monitor declaration must validate")
}

/// A canonical chat row (non-terminal `Init` state so the group has a visible
/// turn and therefore qualifies for the rollup).
fn chat(
    session_id: &str,
    correlation_id: &str,
    user_message: Option<&str>,
    started_at_ns: Option<i64>,
    updated_at: &str,
) -> ChatRow {
    ChatRow {
        session_id: session_id.to_string(),
        correlation_id: correlation_id.to_string(),
        seq: 1,
        started_at_ns,
        ended_at_ns: None,
        updated_at: updated_at.to_string(),
        state: RowState::Init,
        user_message: user_message.map(str::to_string),
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

/// The declared `mission-monitor.sessions` rows.
fn declared_rows(h: &Harness) -> Vec<Map<String, JsonValue>> {
    h.tables
        .query(FEATURE_ID, DECLARED_TABLE, None, None, None)
        .expect("query the declared sessions table")
}

fn persisted_meta(h: &Harness) -> TableMeta {
    h.meta
        .get_table(FEATURE_ID, DECLARED_TABLE)
        .expect("read declared table metadata")
        .expect("the declared table must be persisted")
}

/// Seed the EXACT legacy upgrade fixture: the colliding legacy sessions table
/// (with rows), the legacy deletion tombstones, all before any declaration.
fn seed_legacy_upgrade_fixture(h: &Harness) {
    let conn = raw(h);
    conn.execute_batch(LEGACY_MM_DDL)
        .expect("seed the exact legacy MM DDL");
    conn.execute_batch(
        "INSERT INTO feature_mission_monitor_sessions
             (session_id, label, start_time, end_time, delivery_count)
         VALUES ('legacy-1', 'Legacy One', '2026-01-01T00:00:00Z', NULL, 7),
                ('legacy-2', 'Legacy Two', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 3);",
    )
    .expect("seed legacy sessions rows");
    conn.execute_batch(
        "CREATE TABLE feature_mission_monitor_deleted_sessions (session_id TEXT, deleted_at TEXT);
         INSERT INTO feature_mission_monitor_deleted_sessions (session_id, deleted_at)
         VALUES ('ses_deleted', '2026-02-01T00:00:00Z');",
    )
    .expect("seed the legacy deletion tombstone");
}

/// A `row`-sourced declared table projecting `correlationId`/`agentReply`.
fn row_table(name: &str) -> FeatureDataTableDeclaration {
    FeatureDataTableDeclaration {
        name: name.to_string(),
        primary_key: vec!["id".to_string()],
        columns: vec![
            DeclaredColumn {
                name: "id".to_string(),
                col_type: DeclaredColumnType::Text,
                nullable: false,
                owner: ColumnOwner::Backend,
            },
            DeclaredColumn {
                name: "reply".to_string(),
                col_type: DeclaredColumnType::Text,
                nullable: true,
                owner: ColumnOwner::Backend,
            },
        ],
        source: Some(DataSource::Row(RowProjection {
            kind: RowProjectionKind::Row,
            from: ActivitySource::Chat,
            r#where: None,
            select: BTreeMap::from([
                (
                    "id".to_string(),
                    FieldMapping::Field {
                        field: "correlationId".to_string(),
                    },
                ),
                (
                    "reply".to_string(),
                    FieldMapping::Field {
                        field: "agentReply".to_string(),
                    },
                ),
            ]),
        })),
        retention: None,
    }
}

// ── (1)–(5): the legacy upgrade path ────────────────────────────────────────

#[test]
fn legacy_upgrade_path_repairs_the_declared_sessions_table() {
    let h = harness();
    let declaration = mm_declaration();
    let table_decl = &declaration.tables[0];

    // The upgrade fixture: legacy tables + rows + tombstone, and the STALE
    // metadata the round-1 collision produced (`backfill_done = true` with 0
    // declared rows — the exact live symptom).
    seed_legacy_upgrade_fixture(&h);
    h.meta
        .put_table(&TableMeta {
            feature_id: FEATURE_ID.to_string(),
            table_name: DECLARED_TABLE.to_string(),
            declaration_json: serde_json::to_string(table_decl).expect("serialize declaration"),
            declaration_revision: DECLARED_REVISION.to_string(),
            last_version: 0,
            backfill_done: true,
        })
        .expect("seed the stale collision metadata");

    // Canonical history: two live sessions plus one the user deleted through the
    // old MM affordance (the legacy tombstone names it).
    h.rtdb_store
        .upsert_chat_rows(&[
            chat(
                "ses_live_1",
                "ses_live_1_1",
                Some("first prompt"),
                Some(1_000),
                "2026-03-01T00:00:01+00:00",
            ),
            chat(
                "ses_live_2",
                "ses_live_2_1",
                Some("second prompt"),
                Some(2_000),
                "2026-03-01T00:00:02+00:00",
            ),
            chat(
                "ses_deleted",
                "ses_deleted_1",
                Some("deleted prompt"),
                Some(3_000),
                "2026-03-01T00:00:03+00:00",
            ),
        ])
        .expect("seed canonical chat rows");

    // Pre-condition: the declared name is owned by the LEGACY schema, with rows.
    {
        let conn = raw(&h);
        assert_eq!(
            columns(&conn, LEGACY_SESSIONS_TABLE).join(","),
            "session_id,label,start_time,end_time,delivery_count",
            "the fixture must start as the exact legacy schema"
        );
        assert_eq!(row_count(&conn, LEGACY_SESSIONS_TABLE), 2);
        assert!(
            quarantine_tables(&conn).is_empty(),
            "no quarantine exists before the repair"
        );
    }

    // ── ACT: declare over the collision ─────────────────────────────────────
    let registry = DeclarationRegistry::new(h.meta.clone(), h.tables.clone());
    let materialized = registry
        .declare(&declaration)
        .expect("declare must repair the legacy collision");
    assert_eq!(materialized.len(), 1);
    assert!(
        materialized[0].created,
        "the rebuild creates the declared schema"
    );

    // ── (1) declared columns present; legacy preserved verbatim ─────────────
    {
        let conn = raw(&h);
        let declared = columns(&conn, LEGACY_SESSIONS_TABLE);
        assert!(declared.contains(&"sessionId".to_string()), "{declared:?}");
        assert!(declared.contains(&"_row_version".to_string()), "{declared:?}");
        assert!(declared.contains(&"_updated_at".to_string()), "{declared:?}");
        assert!(
            !declared.contains(&"label".to_string()),
            "the declared schema must replace the legacy one: {declared:?}"
        );

        let quarantine = quarantine_tables(&conn);
        assert_eq!(quarantine.len(), 1, "exactly one quarantine table");
        assert_eq!(
            columns(&conn, &quarantine[0]).join(","),
            "session_id,label,start_time,end_time,delivery_count",
            "the legacy DDL is preserved verbatim under __legacy_*"
        );
        assert_eq!(
            row_count(&conn, &quarantine[0]),
            2,
            "the legacy rows are never dropped"
        );
    }

    // ── (2) metadata re-armed ───────────────────────────────────────────────
    let meta = persisted_meta(&h);
    assert!(
        !meta.backfill_done,
        "the stale backfill_done=true is re-armed to false"
    );
    assert_eq!(meta.last_version, 0, "the scope version restarts at 0");

    // ── (5, precondition) the legacy deletion was migrated ──────────────────
    let deleted_key = serde_json::to_string(&json!(["ses_deleted"])).expect("tombstone key json");
    assert!(
        h.meta
            .is_tombstoned(FEATURE_ID, DECLARED_TABLE, &deleted_key)
            .expect("read the migrated tombstone"),
        "the legacy deletion tombstone is migrated into the declared layer"
    );
    {
        let conn = raw(&h);
        let legacy_deleted_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                rusqlite::params![LEGACY_DELETED_TABLE],
                |row| row.get(0),
            )
            .expect("probe the legacy deleted-sessions table");
        assert_eq!(
            legacy_deleted_present, 1,
            "the legacy tombstone table is preserved read-only (never migrated away)"
        );
    }

    // ── (3) backfill projects the declared rows, THEN sets the marker ───────
    assert!(
        declared_rows(&h).is_empty(),
        "the declared table is empty before the one-time backfill"
    );
    let engine = Arc::new(
        ProjectionEngine::new(h.data_dir.clone(), h.meta.clone(), h.tables.clone())
            .expect("projection engine"),
    );
    let fed = backfill_pending(&h.data_dir, &h.meta, &engine, &h.rtdb_store)
        .expect("the backfill runs");
    assert_eq!(
        fed, 3,
        "one representative canonical row per distinct session is fed"
    );

    let rows = declared_rows(&h);
    let projected: BTreeSet<String> = rows
        .iter()
        .filter_map(|row| {
            row.get("sessionId")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        projected,
        BTreeSet::from(["ses_live_1".to_string(), "ses_live_2".to_string()]),
        "exactly one declared row per qualifying live session"
    );
    for row in &rows {
        assert_eq!(
            row.get("chatRowCount"),
            Some(&json!(1)),
            "the fact columns are populated from the canonical history"
        );
    }
    let meta = persisted_meta(&h);
    assert!(
        meta.backfill_done,
        "the marker is set only after the projection ran"
    );
    assert!(
        meta.last_version > 0,
        "the projection advanced the table scope version"
    );

    // ── (5) the deleted session is absent from the declared table ───────────
    assert!(
        !projected.contains("ses_deleted"),
        "the migrated tombstone keeps the deleted session out of the declared table"
    );

    // ── (4) a later startup materialization does not rebuild ────────────────
    let again = registry
        .materialize_persisted()
        .expect("startup materialization");
    assert_eq!(again.len(), 1);
    assert!(
        !again[0].created,
        "the declared table is already correct — no second rebuild"
    );
    assert_eq!(
        declared_rows(&h).len(),
        2,
        "the declared rows survive the startup materialization"
    );
    {
        let conn = raw(&h);
        assert_eq!(
            quarantine_tables(&conn).len(),
            1,
            "a no-op startup materialization does not quarantine again"
        );
    }
    let meta = persisted_meta(&h);
    assert!(
        meta.backfill_done,
        "the completed marker is not reset by a no-op materialization"
    );
}

// ── (6): per-table projection isolation ─────────────────────────────────────

#[test]
fn broken_declared_table_does_not_suppress_a_sibling_or_set_its_marker() {
    let h = harness();

    let declaration = FeatureDataDeclaration {
        feature_id: "probe".to_string(),
        declaration_revision: "probe.two.v1".to_string(),
        tables: vec![row_table("broken"), row_table("healthy")],
    };
    let registry = DeclarationRegistry::new(h.meta.clone(), h.tables.clone());
    registry
        .declare(&declaration)
        .expect("declare the two-table feature");

    h.rtdb_store
        .upsert_chat_rows(&[
            chat(
                "ses_a",
                "ses_a_1",
                Some("alpha"),
                Some(1_000),
                "2026-03-01T00:00:01+00:00",
            ),
            chat(
                "ses_b",
                "ses_b_1",
                Some("beta"),
                Some(2_000),
                "2026-03-01T00:00:02+00:00",
            ),
        ])
        .expect("seed canonical chat rows");

    // Damage the `broken` physical table: recreate it WITHOUT the declared
    // `reply` column, so every projection against it fails independently.
    {
        let conn = raw(&h);
        conn.execute_batch(
            "DROP TABLE feature_probe_broken;
             CREATE TABLE feature_probe_broken
                 (id TEXT PRIMARY KEY, _row_version INTEGER, _updated_at TEXT);",
        )
        .expect("damage the broken physical table");
    }

    let engine = Arc::new(
        ProjectionEngine::new(h.data_dir.clone(), h.meta.clone(), h.tables.clone())
            .expect("projection engine"),
    );
    let fed = backfill_pending(&h.data_dir, &h.meta, &engine, &h.rtdb_store)
        .expect("the backfill runs despite the broken table");
    assert_eq!(fed, 2, "both canonical rows are fed through the engine");

    let healthy = h
        .tables
        .query("probe", "healthy", None, None, None)
        .expect("query the healthy sibling");
    assert_eq!(
        healthy.len(),
        2,
        "the healthy sibling still projects every canonical row"
    );
    assert!(
        h.tables
            .query("probe", "broken", None, None, None)
            .expect("query the broken table")
            .is_empty(),
        "the broken table projects nothing"
    );

    let healthy_meta = h
        .meta
        .get_table("probe", "healthy")
        .expect("read healthy metadata")
        .expect("healthy is persisted");
    assert!(
        healthy_meta.backfill_done,
        "the healthy sibling completes its backfill"
    );
    let broken_meta = h
        .meta
        .get_table("probe", "broken")
        .expect("read broken metadata")
        .expect("broken is persisted");
    assert!(
        !broken_meta.backfill_done,
        "a table with a failed projection keeps backfill_done unset and retries"
    );
}
