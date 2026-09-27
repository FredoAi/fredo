//! ST-6 — cross-engine parity + bounded-runtime safety for the storage engine
//! seam (Spec #2975, slice 2).
//!
//! This integration binary drives the migrated `AppStore` / `FeatureStore` /
//! `FeatureDataStore` through BOTH engines — the default SQLite engine and the
//! real embedded PostgreSQL server (the slice-1 bounded `PgRuntime`) — and
//! asserts they are **byte-equal**: per-table row counts and SHA-256 content
//! checksums, plus the AC4 edge cases (duplicate-PK idempotency, `BYTEA` byte
//! identity, unknown key → `None`, hyphenated feature id → the same physical
//! table name) and the AC2 statement-translation probes (`to_regclass` /
//! `information_schema` / quoted identifiers).
//!
//! # Offline gate
//!
//! The whole binary is gated behind `FREDO_TEST_PG=1`: a normal
//! `cargo test --locked` (or `cargo nextest run`) executes this test as an
//! immediate no-op — no server, no network, no filesystem work. Run the real
//! suite with:
//!
//! ```text
//! FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg
//! ```
//!
//! # G-263 safety
//!
//! There is exactly ONE embedded server per binary, started ONCE and torn down
//! by a single owning scope. Every start/finish leg is finitely bounded by
//! `PgRuntime` (`Settings::timeout` + `run_bounded` + the stop watchdog +
//! `taskkill` fallback), and `PgRuntime`'s RAII `Drop` hard-kills the postmaster
//! tree on the normal, error, AND panic-unwind paths — so the server can never
//! be left running. The data dir is the FS-1 override
//! `FREDO_PG_DATA_DIR=<repo>/.opencode/tmp/2975/pgdata-e`. The post-stop
//! assertion re-probes the resolved port and fails if the postmaster still
//! accepts connections.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::Row as _;

use fredo_lib::infrastructure::feature_data::declaration::{
    ColumnOwner, DataSource, DeclaredColumn, DeclaredColumnType, FeatureDataDeclaration,
    FeatureDataTableDeclaration, Retention, SessionRollupKind, SessionRollupProjection,
};
use fredo_lib::infrastructure::feature_data::registry::DeclarationRegistry;
use fredo_lib::infrastructure::feature_data::store::{FeatureDataStore, TableMeta, Tombstone};
use fredo_lib::infrastructure::rtdb::rows::RowState;
use fredo_lib::infrastructure::storage::engine::{ensure_settings_schema, StorageEngineState};
use fredo_lib::infrastructure::storage::feature_store::{ColumnDef, ColumnType, FeatureStore};
use fredo_lib::infrastructure::storage::{
    AppStore, EngineChoice, EngineHandle, PgEngine, SqliteEngine, StoreEngine,
};
use fredo_lib::PgRuntime;

// ── Fixture identity ─────────────────────────────────────────────────────────

const GATE_ENV: &str = "FREDO_TEST_PG";
const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
const FEATURE_ID: &str = "mission-monitor";
/// The hyphen is normalized to `_` identically on both engines (EARS-4.4).
const PHYSICAL_TABLE: &str = "feature_mission_monitor_items";
const T0: &str = "2026-09-27T00:00:00Z";
const T1: &str = "2026-09-27T01:00:00Z";
const T2: &str = "2026-09-27T02:00:00Z";
/// Finite teardown bound (G-263) — never an unbounded wait on the postmaster.
const STOP_BOUND: Duration = Duration::from_secs(30);

fn pg_enabled() -> bool {
    matches!(std::env::var(GATE_ENV).as_deref(), Ok("1"))
}

/// `<repo>/.opencode/tmp/2975` — the sanctioned scratch dir for this issue.
fn repo_tmp() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(".opencode")
        .join("tmp")
        .join("2975")
}

/// A per-scenario PostgreSQL schema name (valid unquoted identifier).
fn unique_schema(tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{tag}_{nanos}")
}

// ── The ONE gated test (one embedded server per binary) ──────────────────────

/// The whole cross-engine suite runs inside ONE owning scope so the single
/// embedded `PgRuntime` has a guaranteed teardown on every exit path (normal,
/// error, panic) — the G-263 contract. Each phase below gets its OWN
/// `CREATE SCHEMA` + pool `search_path`, so the phases are isolated.
#[tokio::test(flavor = "multi_thread")]
async fn cross_engine_postgres_suite() {
    if !pg_enabled() {
        eprintln!("storage_engine_pg: skipping — set {GATE_ENV}=1 to run the gated PG suite");
        return;
    }

    let tmp = repo_tmp();
    std::fs::create_dir_all(&tmp).expect("create .opencode/tmp/2975");
    let data_dir = tmp.join("pgdata-e");
    let app_dir = tmp.join("pgtest-app-e");
    std::fs::create_dir_all(&data_dir).expect("create the FS-1 data dir");
    std::fs::create_dir_all(&app_dir).expect("create the runtime app dir");
    std::env::set_var(PG_DATA_DIR_ENV, &data_dir);

    // ONE embedded server. Every call below is internally bounded; `Drop` is the
    // panic/error hard-kill backstop.
    let mut runtime = PgRuntime::new(&app_dir, "fredo-test-password".to_string());
    runtime.setup().await.expect("embedded PostgreSQL setup (bounded)");
    runtime
        .apply_server_knobs()
        .expect("server-memory knob overlay");
    runtime
        .start()
        .await
        .expect("embedded PostgreSQL start (bounded)");
    runtime
        .probe_ready()
        .await
        .expect("embedded PostgreSQL readiness (bounded)");
    let url = runtime.connection_url();
    let port = runtime.port();

    // Phase 1: the SQLite↔PG equivalence fixture + AC4 edges + translation probes.
    cross_engine_scenario(&url, &unique_schema("baseline")).await;
    // Phase 2: quoted identifiers (case-preserving dynamic DDL).
    quoted_identifier_scenario(&url, &unique_schema("quoted")).await;
    // Phase 3: the ST-2 startup schema-init registry on the candidate pool
    // (ST-6 rework — pins the boot contract whose gap failed round 1).
    schema_init_scenario(&url, &unique_schema("schema_init")).await;
    // Phase 4: the declared-table DDL builder quotes every identifier, so a
    // mixed-case declared table is created case-preserved on PG and the quoted
    // upsert path agrees with it (ST-2 rework; pins the round-2 defect class).
    declared_table_quoting_scenario(&url, &unique_schema("declared")).await;

    // ── G-263 teardown: finite bound + guaranteed hard-kill + no orphan ──────
    let started = Instant::now();
    let outcome = runtime.stop_bounded(STOP_BOUND).await;
    let elapsed = started.elapsed();
    eprintln!("storage_engine_pg: stop_bounded -> {outcome:?} in {elapsed:?}");
    assert!(
        elapsed < STOP_BOUND + Duration::from_secs(15),
        "teardown must be bounded, took {elapsed:?}"
    );
    let addr = format!("127.0.0.1:{port}");
    let still_up = std::net::TcpStream::connect_timeout(
        &addr.parse().expect("parse the resolved port"),
        Duration::from_millis(500),
    )
    .is_ok();
    assert!(
        !still_up,
        "the postmaster must not accept connections on {addr} after stop_bounded"
    );
}

// ── Phase 1: SQLite ↔ PostgreSQL equivalence ─────────────────────────────────

async fn cross_engine_scenario(url: &str, schema: &str) {
    // SQLite side: the default engine, a temp `fredo.db`.
    let sqlite_dir = tempfile::tempdir().expect("tempdir");
    let sqlite_engine =
        SqliteEngine::open(&sqlite_dir.path().join("fredo.db")).expect("sqlite engine");
    let sqlite_handle = EngineHandle::new(StoreEngine::Sqlite(sqlite_engine.clone()));
    let sqlite_app = AppStore::open(sqlite_handle.clone()).expect("sqlite app store");
    let sqlite_features = FeatureStore::open(sqlite_handle.clone()).expect("sqlite feature store");
    let sqlite_data = FeatureDataStore::open(sqlite_handle).expect("sqlite data store");

    // PG side: stores start on SQLite (the production order — `AppStore::open`
    // captures the synchronous control plane) and are swapped to PostgreSQL once.
    let pg_scratch = tempfile::tempdir().expect("tempdir");
    let pg_sqlite = SqliteEngine::open(&pg_scratch.path().join("fredo.db")).expect("sqlite engine");
    let pg_handle = EngineHandle::new(StoreEngine::Sqlite(pg_sqlite));
    let pg_app = AppStore::open(pg_handle.clone()).expect("app store");
    let pg_features = FeatureStore::open(pg_handle.clone()).expect("feature store");
    let pg_data = FeatureDataStore::open(pg_handle.clone()).expect("data store");

    let pool = build_pool(url, schema).await;
    assert!(
        current_search_path(&pool).await.contains(schema),
        "the test pool must resolve unqualified tables inside schema {schema}"
    );
    pg_handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    // Run the IDENTICAL fixture on both engines.
    let sqlite_obs = run_fixture(&sqlite_app, &sqlite_features, &sqlite_data).await;
    let pg_obs = run_fixture(&pg_app, &pg_features, &pg_data).await;
    assert_eq!(
        pg_obs, sqlite_obs,
        "cross-engine fixture observables must be identical"
    );
    assert!(
        sqlite_obs.contains(&format!("blob.a={}", hex(&[0, 1, 2, 127, 128, 254, 255]))),
        "the BLOB must round-trip byte-identically (EARS-4.2), observables: {sqlite_obs:?}"
    );

    // Per-table row count + content checksum must be byte-equal (QA-N.1 / F-17).
    let sqlite_sums = sqlite_table_sums(&sqlite_engine);
    let pg_sums = pg_table_sums(&pool).await;
    assert_eq!(
        pg_sums, sqlite_sums,
        "SQLite and PostgreSQL must be byte-equal (row count + content checksum)"
    );

    // EARS-4.4 / F-13: the hyphenated feature id yields the SAME physical name.
    assert!(
        sqlite_has_table(&sqlite_engine, PHYSICAL_TABLE),
        "SQLite must hold {PHYSICAL_TABLE}"
    );
    let pg_physical: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
        .bind(PHYSICAL_TABLE)
        .fetch_one(&pool)
        .await
        .expect("to_regclass probe");
    assert_eq!(
        pg_physical.as_deref(),
        Some(PHYSICAL_TABLE),
        "PostgreSQL must resolve the same physical table name"
    );

    // EARS-2.3 / F-7: existence + type probes use the PG catalogs (not sqlite_master).
    let types = pg_column_types(&pool, schema, PHYSICAL_TABLE).await;
    assert_eq!(types.get("label").map(String::as_str), Some("text"));
    assert_eq!(types.get("count").map(String::as_str), Some("bigint"));
    assert_eq!(types.get("ratio").map(String::as_str), Some("double precision"));
    assert_eq!(types.get("payload").map(String::as_str), Some("bytea"));
    assert_eq!(
        types.get("_row_version").map(String::as_str),
        Some("bigint"),
        "the reserved `_row_version` column must be a bigint (C1 map)"
    );

    pool.close().await;
}

/// Phase 2: a mixed-case dynamic identifier proves double-quoting (an unquoted
/// identifier would be folded to lowercase by PostgreSQL).
async fn quoted_identifier_scenario(url: &str, schema: &str) {
    let dir = tempfile::tempdir().expect("tempdir");
    let sqlite = SqliteEngine::open(&dir.path().join("fredo.db")).expect("sqlite engine");
    let handle = EngineHandle::new(StoreEngine::Sqlite(sqlite));
    let features = FeatureStore::open(handle.clone()).expect("feature store");

    let pool = build_pool(url, schema).await;
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    let cols = vec![ColumnDef {
        name: "id".to_string(),
        col_type: ColumnType::TEXT,
        nullable: false,
        primary_key: true,
    }];
    features
        .ensure_table("CaseTest", "widgets", &cols)
        .expect("create a mixed-case table");

    let folded: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('feature_CaseTest_widgets')::text")
            .fetch_one(&pool)
            .await
            .expect("folded to_regclass");
    let quoted: Option<String> = sqlx::query_scalar(
        "SELECT relname FROM pg_class WHERE oid = to_regclass('\"feature_CaseTest_widgets\"')",
    )
    .fetch_optional(&pool)
    .await
    .expect("quoted to_regclass");
    assert!(
        folded.is_none(),
        "an unquoted lookup must fold to lowercase, saw {folded:?}"
    );
    assert_eq!(
        quoted.as_deref(),
        Some("feature_CaseTest_widgets"),
        "the identifier must be stored double-quoted and case-preserving"
    );

    let mut row = Map::new();
    row.insert("id".to_string(), json!("w1"));
    assert_eq!(
        features
            .insert("CaseTest", "widgets", &[row])
            .expect("insert"),
        1
    );
    let got = features
        .query("CaseTest", "widgets", None, None, None)
        .expect("query");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["id"], "w1");

    pool.close().await;
}

// ── Phase 3: ST-2 startup schema-init registry (boot-gap pin) ────────────────

/// The startup schema-init registry creates the FULL startup schema set on the
/// **candidate** PostgreSQL pool BEFORE install, so a feature-data operation
/// succeeds with NO pre-called `ensure_schema()` — the exact boot gap that made
/// the PG-selected app fail `no existe la relación «feature_data_tables»`
/// (ST-6 rework, ST-2 contract).
async fn schema_init_scenario(url: &str, schema: &str) {
    let dir = tempfile::tempdir().expect("tempdir");
    let sqlite = SqliteEngine::open(&dir.path().join("fredo.db")).expect("sqlite engine");
    let handle = EngineHandle::new(StoreEngine::Sqlite(sqlite));

    // The candidate pool, exactly what `build_pg_pool` hands the registry.
    let pool = build_pool(url, schema).await;

    // The ST-2 registry, populated exactly as `lib.rs` does at startup.
    let state = StorageEngineState::new(handle.clone(), EngineChoice::Postgres);
    state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
        FeatureDataStore::ensure_schema_on_pg(pool)
    }));
    state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
        fredo_lib::ensure_terminal_table_on_pg(pool)
    }));

    // Before the registry runs, the candidate pool holds ONLY `settings`
    // (`build_pg_pool` creates just that) — this is the round-1 defect state.
    assert!(
        pg_has_table(&pool, schema, "settings").await,
        "the candidate pool must carry the `settings` schema before the registry"
    );
    assert!(
        !pg_has_table(&pool, schema, "feature_data_tables").await,
        "the feature-data schema must NOT exist on the candidate pool pre-registry"
    );

    state
        .run_pg_schema_inits(&pool)
        .expect("the schema-init registry must run cleanly on the candidate pool");

    // The full startup schema set now exists on PostgreSQL, pre-install.
    for table in [
        "settings",
        "feature_data_tables",
        "feature_data_tombstones",
        "feature_terminal_sessions",
    ] {
        assert!(
            pg_has_table(&pool, schema, table).await,
            "{table} must exist on the candidate pool after the registry runs"
        );
    }

    // Idempotent: the DDL is `CREATE TABLE IF NOT EXISTS`, so a re-run is clean.
    state
        .run_pg_schema_inits(&pool)
        .expect("a registry re-run must be an idempotent no-op");

    // Install, then a feature-data op must succeed WITHOUT any prior
    // `ensure_schema()` — the boot contract the round-1 defect violated.
    let data = FeatureDataStore::open(handle.clone()).expect("data store");
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));
    data.put_table(&meta(FEATURE_ID, "sessions", false, 0))
        .expect("put_table must succeed on the registry-created schema");
    let loaded = data
        .get_table(FEATURE_ID, "sessions")
        .expect("get_table must succeed with no pre-called ensure_schema")
        .expect("the row must be present");
    assert_eq!(loaded.table_name, "sessions");

    pool.close().await;
}

// ── Phase 4: declared-table DDL quoting (mix-case identifier pin) ────────────

/// The declared-table DDL builder must quote every identifier so a mixed-case
/// declared schema is created **case-preserved** on PostgreSQL and the (already
/// quoted) upsert path agrees with it. This is the round-2 defect class: the
/// unquoted `create_table_sql` let PostgreSQL fold `sessionId → sessionid`, so
/// every declared-row projection write failed `no existe la columna «sessionId»`
/// and Mission Monitor rendered nothing on the PG-selected boot (ST-2 rework).
async fn declared_table_quoting_scenario(url: &str, schema: &str) {
    let dir = tempfile::tempdir().expect("tempdir");
    let sqlite = SqliteEngine::open(&dir.path().join("fredo.db")).expect("sqlite engine");
    let handle = EngineHandle::new(StoreEngine::Sqlite(sqlite));

    let pool = build_pool(url, schema).await;
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    let data = Arc::new(FeatureDataStore::open(handle.clone()).expect("data store"));
    let features = Arc::new(FeatureStore::open(handle.clone()).expect("feature store"));
    data.ensure_schema()
        .expect("create the feature-data schema on the candidate pool");

    // Declare the MM-shaped table through the SAME registry path a live
    // `feature_data_declare` takes (mixed-case PK `sessionId` + `chatRowCount`).
    let registry = DeclarationRegistry::new(data.clone(), features.clone());
    let materialized = registry
        .declare(&mm_sessions_declaration())
        .expect("the mixed-case declared table must materialize");
    assert_eq!(materialized.len(), 1, "one declared table materialized");
    assert!(
        materialized[0].created,
        "a fresh declared table must be created, saw {materialized:?}"
    );

    // (i) The physical columns are case-preserved on PostgreSQL (NOT folded).
    let types = pg_column_types(&pool, schema, "feature_mission_monitor_sessions").await;
    assert!(
        types.contains_key("sessionId"),
        "the declared PK column must be stored as `sessionId`, saw {types:?}"
    );
    assert!(
        types.contains_key("chatRowCount"),
        "the declared column must be stored as `chatRowCount`, saw {types:?}"
    );
    assert!(
        !types.contains_key("sessionid") && !types.contains_key("chatrowcount"),
        "PostgreSQL must NOT fold the declared mixed-case columns, saw {types:?}"
    );

    // (ii) The primary key physically keys on the case-preserved `sessionId`.
    let pk_cols: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname
           FROM pg_index i
           JOIN pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = to_regclass($1) AND i.indisprimary
          ORDER BY a.attname",
    )
    .bind(format!(
        "\"{schema}\".\"feature_mission_monitor_sessions\""
    ))
    .fetch_all(&pool)
    .await
    .expect("pg_index primary-key probe");
    assert_eq!(
        pk_cols,
        vec!["sessionId".to_string()],
        "the declared primary key must physically key on the case-preserved `sessionId`"
    );

    // (iii) The quoted write path (FeatureStore::upsert) agrees with the created
    // schema — the exact write that failed on the folded table.
    let mut row = Map::new();
    row.insert("sessionId".to_string(), json!("s1"));
    row.insert("chatRowCount".to_string(), json!(5));
    row.insert("_row_version".to_string(), json!(1));
    row.insert("_updated_at".to_string(), json!(T0));
    let written = features
        .upsert(
            "mission-monitor",
            "sessions",
            &["sessionId".to_string()],
            &[row],
        )
        .expect("a declared-row upsert must succeed on the quoted declared schema");
    assert_eq!(written, 1, "the declared-row upsert must write exactly one row");

    let read_back = features
        .query("mission-monitor", "sessions", None, None, None)
        .expect("query the declared table");
    assert_eq!(read_back.len(), 1, "the upserted row must read back");
    assert_eq!(read_back[0]["sessionId"], "s1");
    assert_eq!(read_back[0]["chatRowCount"], 5);

    pool.close().await;
}

/// The MM-shaped declaration whose unquoted DDL PostgreSQL folded — mirrors the
/// registry unit-test declaration (`registry.rs` `declaration(..)`): mixed-case
/// PK `sessionId`, mixed-case column `chatRowCount`.
fn mm_sessions_declaration() -> FeatureDataDeclaration {
    FeatureDataDeclaration {
        feature_id: "mission-monitor".to_string(),
        declaration_revision: "mm.sessions.v1".to_string(),
        tables: vec![FeatureDataTableDeclaration {
            name: "sessions".to_string(),
            primary_key: vec!["sessionId".to_string()],
            columns: vec![
                DeclaredColumn {
                    name: "sessionId".to_string(),
                    col_type: DeclaredColumnType::Text,
                    nullable: false,
                    owner: ColumnOwner::Backend,
                },
                DeclaredColumn {
                    name: "chatRowCount".to_string(),
                    col_type: DeclaredColumnType::Integer,
                    nullable: true,
                    owner: ColumnOwner::Backend,
                },
            ],
            source: Some(DataSource::SessionRollup(SessionRollupProjection {
                kind: SessionRollupKind::SessionRollup,
                exclude_dispatch_names: vec!["build".to_string(), "plan".to_string()],
                terminal_states: vec![RowState::Response, RowState::Timeout],
            })),
            retention: Some(Retention {
                max_rows: Some(500),
                ttl_days: None,
            }),
        }],
    }
}

// ── The shared fixture (identical operations on both engines) ────────────────

/// Run the identical operations against one engine's store set and return a
/// sorted list of `name=value` observables. Two engines produce equal lists iff
/// they behaved identically.
async fn run_fixture(
    app: &AppStore,
    features: &FeatureStore,
    data: &FeatureDataStore,
) -> Vec<String> {
    let mut out = Vec::new();

    // ── settings KV (EARS-2.1, EARS-4.3) ─────────────────────────────────────
    app.set("theme", "dark").await.expect("set theme");
    app.set("theme", "light").await.expect("upsert theme");
    app.set("unicode", "héllo ✅ 漢字").await.expect("set unicode");
    app.set("rtdb.backfill.completed", "true")
        .await
        .expect("set marker");
    out.push(format!(
        "settings.theme={}",
        app.get("theme").await.expect("get theme").expect("present")
    ));
    out.push(format!(
        "settings.unicode={}",
        app.get("unicode").await.expect("get unicode").expect("present")
    ));
    out.push(format!(
        "settings.marker={}",
        app.get("rtdb.backfill.completed")
            .await
            .expect("get marker")
            .expect("present")
    ));
    out.push(format!(
        "settings.unknown={:?}",
        app.get("never-written-key").await.expect("get unknown")
    ));

    // ── dynamic feature_* (EARS-2.2, EARS-2.4, EARS-4.1, EARS-4.2, EARS-4.4) ─
    features
        .ensure_table(FEATURE_ID, "items", &item_columns())
        .expect("ensure table");
    features
        .ensure_table(FEATURE_ID, "items", &item_columns())
        .expect("ensure table is idempotent");

    let bytes_a: &[u8] = &[0, 1, 2, 127, 128, 254, 255];
    let seed = vec![
        item("a", "alpha", 10, 1.5, bytes_a, 1, T0),
        item("b", "beta", 20, 2.25, &[9, 9], 1, T0),
        item("c", "gamma", 30, 0.5, &[], 1, T0),
    ];
    out.push(format!(
        "insert.first={}",
        features.insert(FEATURE_ID, "items", &seed).expect("insert")
    ));

    // EARS-4.1: a duplicate PK is silently ignored — the original row wins.
    let dup = vec![item("a", "SHOULD-NOT-WIN", 999, 9.5, &[7], 99, T0)];
    out.push(format!(
        "insert.dup={}",
        features.insert(FEATURE_ID, "items", &dup).expect("dup insert")
    ));
    let a = features
        .query(FEATURE_ID, "items", Some(&where_eq(&[("id", "a")])), None, None)
        .expect("query a");
    out.push(format!("row.a.label={}", a[0]["label"]));

    // EARS-2.1 / F-7: `ON CONFLICT DO UPDATE ... EXCLUDED`.
    let updated = vec![item("b", "beta-updated", 20, 2.25, &[9, 9], 2, T1)];
    out.push(format!(
        "upsert.b={}",
        features
            .upsert(FEATURE_ID, "items", &["id".to_string()], &updated)
            .expect("upsert")
    ));
    let b = features
        .query(FEATURE_ID, "items", Some(&where_eq(&[("id", "b")])), None, None)
        .expect("query b");
    out.push(format!("row.b.label={}", b[0]["label"]));
    out.push(format!("row.b.version={}", b[0]["_row_version"]));

    // F-7: a multi-parameter query (`$n` / `?n`, order preserved).
    let multi = features
        .query(
            FEATURE_ID,
            "items",
            Some(&where_eq(&[("id", "a"), ("label", "alpha")])),
            None,
            None,
        )
        .expect("multi-param query");
    out.push(format!("multi.len={}", multi.len()));

    out.push(format!("blob.a={}", hex(&bytes_of(&a[0]["payload"]))));
    out.push(format!(
        "all.len={}",
        features
            .query(FEATURE_ID, "items", None, Some("id"), None)
            .expect("query all")
            .len()
    ));

    // ── feature_data_* (EARS-2.2, EARS-2.3) ──────────────────────────────────
    data.ensure_schema().expect("ensure schema");
    data.ensure_schema().expect("ensure schema is idempotent");
    data.put_table(&meta(FEATURE_ID, "sessions", false, 0))
        .expect("put table");
    data.put_table(&meta(FEATURE_ID, "sessions", true, 7))
        .expect("re-put table (upsert)");
    let loaded = data
        .get_table(FEATURE_ID, "sessions")
        .expect("get table")
        .expect("present");
    out.push(format!("meta.backfill_done={}", loaded.backfill_done));
    out.push(format!("meta.last_version={}", loaded.last_version));
    out.push(format!(
        "meta.missing={:?}",
        data.get_table(FEATURE_ID, "absent").expect("get missing")
    ));

    data.put_tombstone(&tombstone(FEATURE_ID, "sessions", "[\"s1\"]", T0))
        .expect("put tombstone");
    data.put_tombstone(&tombstone(FEATURE_ID, "sessions", "[\"s1\"]", T2))
        .expect("re-put tombstone (EXCLUDED update)");
    let tombstones = data
        .list_tombstones(FEATURE_ID, "sessions")
        .expect("list tombstones");
    out.push(format!("tombstone.count={}", tombstones.len()));
    out.push(format!("tombstone.deleted_at={}", tombstones[0].deleted_at));
    out.push(format!(
        "tombstone.is={}",
        data.is_tombstoned(FEATURE_ID, "sessions", "[\"s1\"]")
            .expect("is tombstoned")
    ));

    out.sort();
    out
}

// ── Fixture values ───────────────────────────────────────────────────────────

fn item_columns() -> Vec<ColumnDef> {
    vec![
        column("id", ColumnType::TEXT, false, true),
        column("label", ColumnType::TEXT, false, false),
        column("count", ColumnType::INTEGER, false, false),
        column("ratio", ColumnType::REAL, false, false),
        column("payload", ColumnType::BLOB, true, false),
        column("_row_version", ColumnType::INTEGER, false, false),
        column("_updated_at", ColumnType::TEXT, false, false),
    ]
}

fn column(name: &str, col_type: ColumnType, nullable: bool, primary_key: bool) -> ColumnDef {
    ColumnDef {
        name: name.to_string(),
        col_type,
        nullable,
        primary_key,
    }
}

fn item(
    id: &str,
    label: &str,
    count: i64,
    ratio: f64,
    bytes: &[u8],
    row_version: i64,
    updated_at: &str,
) -> Map<String, JsonValue> {
    let mut row = Map::new();
    row.insert("id".to_string(), json!(id));
    row.insert("label".to_string(), json!(label));
    row.insert("count".to_string(), json!(count));
    row.insert("ratio".to_string(), json!(ratio));
    row.insert(
        "payload".to_string(),
        json!(bytes.iter().map(|b| u64::from(*b)).collect::<Vec<u64>>()),
    );
    row.insert("_row_version".to_string(), json!(row_version));
    row.insert("_updated_at".to_string(), json!(updated_at));
    row
}

fn where_eq(pairs: &[(&str, &str)]) -> Map<String, JsonValue> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), json!(value)))
        .collect()
}

fn meta(feature: &str, table: &str, backfill_done: bool, last_version: i64) -> TableMeta {
    TableMeta {
        feature_id: feature.to_string(),
        table_name: table.to_string(),
        declaration_json: format!(r#"{{"featureId":"{feature}","table":"{table}"}}"#),
        declaration_revision: "mm.sessions.v2".to_string(),
        last_version,
        backfill_done,
    }
}

fn tombstone(feature: &str, table: &str, key_json: &str, deleted_at: &str) -> Tombstone {
    Tombstone {
        feature_id: feature.to_string(),
        table_name: table.to_string(),
        key_json: key_json.to_string(),
        deleted_at: deleted_at.to_string(),
    }
}

fn bytes_of(value: &JsonValue) -> Vec<u8> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_u64().map(|n| n as u8))
                .collect()
        })
        .unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Pool / catalog helpers ───────────────────────────────────────────────────

/// Build a pool whose every connection resolves unqualified identifiers inside
/// `schema` (per-scenario isolation).
async fn build_pool(url: &str, schema: &str) -> sqlx::PgPool {
    let options: sqlx::postgres::PgConnectOptions =
        url.parse().expect("parse the embedded connection URL");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .min_connections(1)
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options.options([("search_path", schema)]))
        .await
        .expect("connect the PostgreSQL pool");
    sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\""))
        .execute(&pool)
        .await
        .expect("create the per-scenario schema");
    ensure_settings_schema(&pool)
        .await
        .expect("create the settings schema");
    pool
}

async fn current_search_path(pool: &sqlx::PgPool) -> String {
    sqlx::query_scalar::<_, String>("SELECT current_setting('search_path')")
        .fetch_one(pool)
        .await
        .expect("current_setting('search_path')")
}

/// `true` when `table` exists in `schema` on the PostgreSQL pool (catalog probe,
/// not `sqlite_master`).
async fn pg_has_table(pool: &sqlx::PgPool, schema: &str, table: &str) -> bool {
    let found: Option<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .expect("information_schema.tables probe");
    found.is_some()
}

async fn pg_column_types(pool: &sqlx::PgPool, schema: &str, table: &str) -> HashMap<String, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .expect("information_schema.columns probe");
    rows.into_iter().collect()
}

// ── Row count + content checksum (SQLite vs PostgreSQL) ──────────────────────

const SETTINGS_SQL: &str = "SELECT key, value FROM settings ORDER BY key";
// The BLOB is hex-encoded on BOTH sides and lower-cased so the comparison is
// case-insensitive: SQLite's `hex()` emits UPPERCASE while PostgreSQL's
// `encode(..,'hex')` emits lowercase (ST-6 rework; the round-1 checksum
// mismatch at this table was this case difference, not data loss).
const ITEMS_SQL_SQLITE: &str = "SELECT id, label, CAST(count AS TEXT), CAST(ratio AS TEXT), \
     lower(hex(payload)), CAST(_row_version AS TEXT), _updated_at \
     FROM feature_mission_monitor_items ORDER BY id";
const ITEMS_SQL_PG: &str = "SELECT id, label, count::text, ratio::text, lower(encode(payload, 'hex')), \
     _row_version::text, _updated_at \
     FROM feature_mission_monitor_items ORDER BY id";
const META_SQL: &str = "SELECT feature_id, table_name, declaration_json, declaration_revision, \
     CAST(last_version AS TEXT), CAST(backfill_done AS TEXT) \
     FROM feature_data_tables ORDER BY feature_id, table_name";
const META_SQL_PG: &str = "SELECT feature_id, table_name, declaration_json, declaration_revision, \
     last_version::text, backfill_done::text \
     FROM feature_data_tables ORDER BY feature_id, table_name";
const TOMBSTONE_SQL: &str = "SELECT feature_id, table_name, key_json, deleted_at \
     FROM feature_data_tombstones ORDER BY feature_id, table_name, key_json";

fn sqlite_table_sums(engine: &SqliteEngine) -> Vec<String> {
    let mut out = Vec::new();
    for (label, sql, table) in [
        ("settings", SETTINGS_SQL, "settings"),
        ("feature_items", ITEMS_SQL_SQLITE, PHYSICAL_TABLE),
        ("feature_data_tables", META_SQL, "feature_data_tables"),
        (
            "feature_data_tombstones",
            TOMBSTONE_SQL,
            "feature_data_tombstones",
        ),
    ] {
        let rows = sqlite_rows(engine, sql);
        let count = sqlite_count(engine, table);
        out.push(format!("{label}:count={count}:sum={}", checksum(&rows)));
    }
    out.sort();
    out
}

async fn pg_table_sums(pool: &sqlx::PgPool) -> Vec<String> {
    let mut out = Vec::new();
    for (label, sql, table) in [
        ("settings", SETTINGS_SQL, "settings"),
        ("feature_items", ITEMS_SQL_PG, PHYSICAL_TABLE),
        ("feature_data_tables", META_SQL_PG, "feature_data_tables"),
        (
            "feature_data_tombstones",
            TOMBSTONE_SQL,
            "feature_data_tombstones",
        ),
    ] {
        let rows = pg_rows(pool, sql).await;
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(pool)
            .await
            .expect("count");
        out.push(format!("{label}:count={count}:sum={}", checksum(&rows)));
    }
    out.sort();
    out
}

fn sqlite_rows(engine: &SqliteEngine, sql: &str) -> Vec<Vec<Option<String>>> {
    let conn = engine.read_only_conn();
    let mut stmt = conn.prepare(sql).expect("prepare sqlite query");
    let columns = stmt.column_count();
    stmt.query_map([], |row| {
        let mut values = Vec::with_capacity(columns);
        for index in 0..columns {
            values.push(row.get::<_, Option<String>>(index)?);
        }
        Ok(values)
    })
    .expect("query sqlite rows")
    .collect::<rusqlite::Result<Vec<_>>>()
    .expect("collect sqlite rows")
}

fn sqlite_count(engine: &SqliteEngine, table: &str) -> i64 {
    engine
        .read_only_conn()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("sqlite count")
}

fn sqlite_has_table(engine: &SqliteEngine, table: &str) -> bool {
    engine
        .read_only_conn()
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            rusqlite::params![table],
            |_| Ok(()),
        )
        .is_ok()
}

async fn pg_rows(pool: &sqlx::PgPool, sql: &str) -> Vec<Vec<Option<String>>> {
    let rows = sqlx::query(sql).fetch_all(pool).await.expect("query pg rows");
    rows.iter()
        .map(|row| {
            (0..row.len())
                .map(|index| row.try_get::<Option<String>, _>(index).expect("cell"))
                .collect()
        })
        .collect()
}

/// Order-independent SHA-256 over the stringified rows.
fn checksum(rows: &[Vec<Option<String>>]) -> String {
    let mut lines: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| cell.clone().unwrap_or_else(|| "<null>".to_string()))
                .collect::<Vec<_>>()
                .join("\u{1f}")
        })
        .collect();
    lines.sort();
    let mut hasher = Sha256::new();
    for line in &lines {
        hasher.update(line.as_bytes());
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}
