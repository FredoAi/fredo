//! PostgreSQL storage regression suite (Spec #2975 ST-6; PG-only since Spec
//! #2979 CU-2).
//!
//! This integration binary drives the migrated `SettingsStore` / `DynamicTableStore` /
//! `ApplicationDataStore` against the REAL embedded PostgreSQL server (the slice-1
//! bounded `PgRuntime`) and pins the consolidated PostgreSQL behavior:
//! schema init, quoted identifiers, declared-table quoting, the Mission Monitor
//! declaration, the fixture run, and the bounded-runtime teardown contract.
//!
//! Since Spec #2979 CU-2 removed the SQLite data plane, the previous cross-engine
//! (SQLite ↔ PostgreSQL) comparisons are gone; every PostgreSQL-side scenario and
//! assertion is retained.
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

use fredo_lib::infrastructure::application_data::declaration::{
    ColumnOwner, DataSource, DeclaredColumn, DeclaredColumnType, ApplicationDataDeclaration,
    ApplicationDataTableDeclaration, Retention, SessionRollupKind, SessionRollupProjection,
};
use fredo_lib::infrastructure::application_data::registry::DeclarationRegistry;
use fredo_lib::infrastructure::application_data::lifecycle::prune_declared_tables_at;
use fredo_lib::infrastructure::application_data::projection::DeclaredChangeKind;
use fredo_lib::infrastructure::application_data::store::{ApplicationDataStore, TableMeta, Tombstone};
use fredo_lib::infrastructure::rtdb::rows::RowState;
use fredo_lib::infrastructure::storage::engine::{
    begin_read_only, ensure_settings_schema, StorageEngineState,
};
use fredo_lib::infrastructure::storage::application_store::{
    DynamicTableStore, ColumnDef, ColumnType, IdentifierError,
};
use fredo_lib::infrastructure::storage::{
    SettingsStore, EngineHandle, PgEngine, StoreEngine,
};
use fredo_lib::PgRuntime;

// ── Fixture identity ─────────────────────────────────────────────────────────

const GATE_ENV: &str = "FREDO_TEST_PG";
const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
const FEATURE_ID: &str = "mission-monitor";
/// The hyphen is normalized to `_` (EARS-4.4).
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

/// The whole PostgreSQL suite runs inside ONE owning scope so the single
/// embedded `PgRuntime` has a guaranteed teardown on every exit path (normal,
/// error, panic) — the G-263 contract. Each phase below gets its OWN
/// `CREATE SCHEMA` + pool `search_path`, so the phases are isolated.
#[tokio::test(flavor = "multi_thread")]
async fn postgres_storage_suite() {
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
    // Spec #3036 renamed the bootstrap database `postgres` → `fredo`. Every real
    // owner path runs this migration between `start` and `probe_ready`; the
    // harness must too, or a fresh cluster probes a database that does not exist
    // yet (the ST-4 round-1 readiness failure). Idempotent on an already-migrated
    // cluster — a pure read.
    runtime
        .migrate_database_identity()
        .await
        .expect("database-identity migration (bounded): bootstrap postgres → fredo");
    runtime
        .probe_ready()
        .await
        .expect("embedded PostgreSQL readiness (bounded)");
    let url = runtime.connection_url();
    let port = runtime.port();

    // Phase 1: the PostgreSQL fixture + catalog/type assertions.
    postgres_fixture_scenario(&url, &unique_schema("baseline")).await;
    // Phase 2: quoted identifiers (case-preserving dynamic DDL).
    quoted_identifier_scenario(&url, &unique_schema("quoted")).await;
    // Phase 3: the ST-2 startup schema-init registry on the candidate pool
    // (ST-6 rework — pins the boot contract whose gap failed round 1).
    schema_init_scenario(&url, &unique_schema("schema_init")).await;
    // Phase 4: the declared-table DDL builder quotes every identifier, so a
    // mixed-case declared table is created case-preserved on PG and the quoted
    // upsert path agrees with it (ST-2 rework; pins the round-2 defect class).
    declared_table_quoting_scenario(&url, &unique_schema("declared")).await;
    // Phase 5: fresh-install / legacy-ignore (Spec #3005 ST-5 re-home) — the
    // one-shot SQLite migration subsystem is deleted, so a pre-existing
    // legacy SQLite file must be IGNORED byte-for-byte and the app must still
    // reach ready PostgreSQL (R-4.1/R-4.2, G-290).
    legacy_ignore_scenario(&url, &unique_schema("legacy_ignore")).await;
    // Phase 6: the read-only canonical seam (Spec #3005 ST-6 re-home) — the
    // retired SQLite read-only guard is now PostgreSQL's
    // `START TRANSACTION READ ONLY` (`begin_read_only`), so a write through the
    // canonical reader's transaction must be rejected (G-290).
    read_only_seam_scenario(&url, &unique_schema("read_only")).await;
    // Phase 7 (Spec #3075 ST-4): the order_by / where_cols sink at the REAL
    // PostgreSQL boundary — every injection payload class rejected with NO SQL
    // executed, every verified caller's order_by (declared-read bare
    // `field ASC|DESC`, retention `latestAt ASC` / `_updated_at ASC`, terminal
    // `last_active_at DESC`) ordered correctly through the quoted sink, the
    // `None` legs unaffected, and `where_cols` values still parameterized.
    order_by_validation_scenario(&url, &unique_schema("order_by")).await;

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

// ── Phase 1: the PostgreSQL fixture ──────────────────────────────────────────

async fn postgres_fixture_scenario(url: &str, schema: &str) {
    // The production order: stores start pending; the supervisor installs the
    // PostgreSQL pool once the server is ready.
    let app_scratch = tempfile::tempdir().expect("tempdir");
    let handle = EngineHandle::new_pending();
    let app = SettingsStore::open(handle.clone(), app_scratch.path()).expect("app store");
    let applications = DynamicTableStore::open(handle.clone()).expect("application store");
    let data = ApplicationDataStore::open(handle.clone()).expect("data store");

    let pool = build_pool(url, schema).await;
    assert!(
        current_search_path(&pool).await.contains(schema),
        "the test pool must resolve unqualified tables inside schema {schema}"
    );
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    // Run the fixture against PostgreSQL.
    let obs = run_fixture(&app, &applications, &data).await;
    assert!(
        obs.contains(&format!("blob.a={}", hex(&[0, 1, 2, 127, 128, 254, 255]))),
        "the BLOB must round-trip byte-identically (EARS-4.2), observables: {obs:?}"
    );

    // EARS-4.4 / F-13: the hyphenated application id yields the physical name.
    let pg_physical: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
        .bind(PHYSICAL_TABLE)
        .fetch_one(&pool)
        .await
        .expect("to_regclass probe");
    assert_eq!(
        pg_physical.as_deref(),
        Some(PHYSICAL_TABLE),
        "PostgreSQL must resolve the physical table name"
    );

    // EARS-2.3 / F-7: existence + type probes use the PG catalogs.
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

    // The fixture wrote exactly the three seeded rows (duplicate insert ignored,
    // upsert updated in place).
    let item_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM feature_mission_monitor_items")
        .fetch_one(&pool)
        .await
        .expect("count application items");
    assert_eq!(item_count, 3, "three distinct fixture rows persist on PostgreSQL");

    pool.close().await;
}

/// Phase 2: a mixed-case dynamic identifier proves double-quoting (an unquoted
/// identifier would be folded to lowercase by PostgreSQL).
async fn quoted_identifier_scenario(url: &str, schema: &str) {
    let handle = EngineHandle::new_pending();
    let applications = DynamicTableStore::open(handle.clone()).expect("application store");

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
    applications
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
        applications
            .insert("CaseTest", "widgets", &[row])
            .expect("insert"),
        1
    );
    let got = applications
        .query("CaseTest", "widgets", None, None, None)
        .expect("query");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["id"], "w1");

    pool.close().await;
}

// ── Phase 3: ST-2 startup schema-init registry (boot-gap pin) ────────────────

/// The startup schema-init registry creates the FULL startup schema set on the
/// **candidate** PostgreSQL pool BEFORE install, so an application-data operation
/// succeeds with NO pre-called `ensure_schema()` — the exact boot gap that made
/// the PG-selected app fail `no existe la relación «feature_data_tables»`
/// (ST-6 rework, ST-2 contract).
async fn schema_init_scenario(url: &str, schema: &str) {
    let handle = EngineHandle::new_pending();

    // The candidate pool, exactly what `build_pg_pool` hands the registry.
    let pool = build_pool(url, schema).await;

    // The ST-2 registry, populated exactly as `lib.rs` does at startup.
    let state = StorageEngineState::new(handle.clone());
    state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
        ApplicationDataStore::ensure_schema_on_pg(pool)
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
        "the application-data schema must NOT exist on the candidate pool pre-registry"
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

    // Install, then an application-data op must succeed WITHOUT any prior
    // `ensure_schema()` — the boot contract the round-1 defect violated.
    let data = ApplicationDataStore::open(handle.clone()).expect("data store");
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
    let handle = EngineHandle::new_pending();

    let pool = build_pool(url, schema).await;
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    let data = Arc::new(ApplicationDataStore::open(handle.clone()).expect("data store"));
    let applications = Arc::new(DynamicTableStore::open(handle.clone()).expect("application store"));
    data.ensure_schema()
        .expect("create the application-data schema on the candidate pool");

    // Declare the MM-shaped table through the SAME registry path a live
    // `application_data_declare` takes (mixed-case PK `sessionId` + `chatRowCount`).
    let registry = DeclarationRegistry::new(data.clone(), applications.clone());
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

    // (i-b) ST-4 rework: the declared physical types must come from the AC2 C1
    // map — an `int4`/`real` regression fails here (the live defect:
    // `startedAtNs INTEGER → int4` overflowed on the ns epoch).
    assert_eq!(
        types.get("sessionId").map(String::as_str),
        Some("text"),
        "declared TEXT must be `text` on PG, saw {types:?}"
    );
    assert_eq!(
        types.get("startedAtNs").map(String::as_str),
        Some("bigint"),
        "declared INTEGER must be `bigint` on PG (not int4), saw {types:?}"
    );
    assert_eq!(
        types.get("tokenRatio").map(String::as_str),
        Some("double precision"),
        "declared REAL must be `double precision` on PG (not real), saw {types:?}"
    );
    assert_eq!(
        types.get("chatRowCount").map(String::as_str),
        Some("bigint"),
        "declared INTEGER must be `bigint` on PG, saw {types:?}"
    );
    assert_eq!(
        types.get("_row_version").map(String::as_str),
        Some("bigint"),
        "the reserved `_row_version` must be `bigint` on PG, saw {types:?}"
    );
    assert_eq!(
        types.get("_updated_at").map(String::as_str),
        Some("text"),
        "the reserved `_updated_at` must be `text` on PG, saw {types:?}"
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

    // (iii) The quoted write path (DynamicTableStore::upsert) agrees with the created
    // schema — the exact write that failed on the folded table.
    let mut row = Map::new();
    row.insert("sessionId".to_string(), json!("s1"));
    row.insert("chatRowCount".to_string(), json!(5));
    // ST-4 rework: the EXACT ns epoch that overflowed int4 in the live defect.
    row.insert(
        "startedAtNs".to_string(),
        json!(1_790_380_389_452_000_000i64),
    );
    row.insert("tokenRatio".to_string(), json!(0.25));
    row.insert("_row_version".to_string(), json!(1));
    row.insert("_updated_at".to_string(), json!(T0));
    let written = applications
        .upsert(
            "mission-monitor",
            "sessions",
            &["sessionId".to_string()],
            &[row],
        )
        .expect("a declared-row upsert must succeed on the quoted declared schema");
    assert_eq!(written, 1, "the declared-row upsert must write exactly one row");

    let read_back = applications
        .query("mission-monitor", "sessions", None, None, None)
        .expect("query the declared table");
    assert_eq!(read_back.len(), 1, "the upserted row must read back");
    assert_eq!(read_back[0]["sessionId"], "s1");
    assert_eq!(read_back[0]["chatRowCount"], 5);

    // (iv) ST-4 rework: the ns-epoch round-trip. With `startedAtNs` created as
    // `int4` this upsert would already have failed `entero fuera de rango`; the
    // i64 must survive the PG write + read byte-equal.
    assert_eq!(
        read_back[0]["startedAtNs"].as_i64(),
        Some(1_790_380_389_452_000_000),
        "the declared `startedAtNs` bigint must round-trip the ns epoch, saw {:?}",
        read_back[0]["startedAtNs"]
    );
    assert_eq!(
        read_back[0]["tokenRatio"].as_f64(),
        Some(0.25),
        "the declared `tokenRatio` double precision must round-trip"
    );

    pool.close().await;
}

// ── Phase 5: fresh-install / legacy-ignore (ST-5 re-home) ────────────────────

/// Spec #3005 ST-5 re-home (G-290): the legacy one-shot SQLite →
/// PostgreSQL migration subsystem is deleted, so PostgreSQL is fresh-install-only.
/// A pre-existing legacy SQLite file in the app-data dir must be IGNORED — never
/// opened, never carried, never mutated (byte-for-byte identical), with no
/// `-wal`/`-shm` side files — and the app must still reach ready PostgreSQL
/// through the post-migration install order (schema inits → install).
async fn legacy_ignore_scenario(url: &str, schema: &str) {
    let app_dir = tempfile::tempdir().expect("tempdir");
    let legacy = app_dir.path().join("legacy.db");
    let payload: &[u8] = b"SQLite format 3\0legacy-sqlite-file-that-must-never-be-read";
    std::fs::write(&legacy, payload).expect("seed a legacy SQLite file");
    let before = std::fs::read(&legacy).expect("read the legacy file before boot");

    let handle = EngineHandle::new_pending();
    let app = SettingsStore::open(handle.clone(), app_dir.path()).expect("app store");
    let pool = build_pool(url, schema).await;

    // The post-migration install order: schema inits on the candidate pool, then
    // install — no migration leg, no carry.
    let state = StorageEngineState::new(handle.clone());
    state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
        ApplicationDataStore::ensure_schema_on_pg(pool)
    }));
    state
        .run_pg_schema_inits(&pool)
        .expect("the schema-init registry must run on the candidate pool");
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    // The engine is ready and a data-plane write serves from PostgreSQL.
    assert!(
        state.status().ready,
        "a fresh install (legacy SQLite file present) must still reach ready PostgreSQL"
    );
    app.set("theme", "dark")
        .await
        .expect("the PostgreSQL data plane must serve the write");
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'theme'")
            .fetch_optional(&pool)
            .await
            .expect("read the persisted settings row");
    assert_eq!(
        stored.as_deref(),
        Some("dark"),
        "the write must persist on PostgreSQL (no carry from a legacy file)"
    );

    // The legacy file was never read or mutated, and no SQLite side files exist.
    let after = std::fs::read(&legacy).expect("read the legacy file after boot");
    assert_eq!(
        after, before,
        "the legacy SQLite file must be ignored byte-for-byte (never read/mutated)"
    );
    let side_files: Vec<String> = std::fs::read_dir(app_dir.path())
        .expect("list the app-data dir")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with("-wal") || name.ends_with("-shm"))
        .collect();
    assert!(
        side_files.is_empty(),
        "no SQLite -wal/-shm side files may appear, saw {side_files:?}"
    );

    pool.close().await;
}

// ── Phase 6: read-only canonical seam (ST-6 re-home) ─────────────────────────

/// Spec #3005 ST-6 re-home (G-290): the retired SQLite read-only guard pinned
/// that a read-only connection sees committed data but rejects writes (`PRAGMA
/// query_only=ON`). The PostgreSQL equivalent is [`begin_read_only`]
/// (`START TRANSACTION READ ONLY`): a committed row is visible through the
/// canonical read-only transaction, an INSERT through it is rejected by the
/// server, and the rejected write persists nothing.
async fn read_only_seam_scenario(url: &str, schema: &str) {
    let pool = build_pool(url, schema).await;

    sqlx::query("INSERT INTO settings (key, value) VALUES ('read_only_probe', 'visible')")
        .execute(&pool)
        .await
        .expect("seed a committed row");

    let mut tx = begin_read_only(&pool)
        .await
        .expect("begin a read-only transaction");

    // A committed row is visible through the read-only transaction.
    let visible: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'read_only_probe'")
            .fetch_optional(&mut *tx)
            .await
            .expect("a read through the read-only transaction must succeed");
    assert_eq!(
        visible.as_deref(),
        Some("visible"),
        "the read-only reader must see committed data"
    );

    // A write through the read-only transaction is rejected by PostgreSQL.
    let write = sqlx::query("INSERT INTO settings (key, value) VALUES ('should_not_write', 'x')")
        .execute(&mut *tx)
        .await;
    assert!(
        write.is_err(),
        "a read-only transaction must reject writes (START TRANSACTION READ ONLY)"
    );
    drop(tx);

    // The rejected write left no row behind.
    let leaked: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'should_not_write'")
            .fetch_optional(&pool)
            .await
            .expect("probe the rejected write");
    assert!(
        leaked.is_none(),
        "the rejected write must not persist, saw {leaked:?}"
    );

    pool.close().await;
}

// ── Phase 7: order_by / where_cols at the real sink + caller wiring (ST-4) ───

/// Spec #3075 ST-4 — the caller-integration + gated sink regression suite.
///
/// Drives the PUBLIC sink methods (`ensure_table` / `insert` / `query` /
/// `update` / `delete`) against the real embedded PostgreSQL server so the
/// hardening is proven at the boundary, not just on the pure parse/render legs
/// (ST-1's unit tests):
///
/// 1. a declared-shaped table whose camelCase column is physically `"latestAt"`;
/// 2. every injection payload class returns a typed [`IdentifierError`] AND
///    executes no SQL (the table still resolves, the row count is unchanged);
/// 3. every VALID order the verified callers pass (`id`, `latestAt`,
///    `last_active_at`, `_updated_at`) returns rows in the requested order;
/// 4. `None` / `Some("")` emit no `ORDER BY` (the result set is unaffected);
/// 5. `where_cols`: an unknown key is rejected before any SQL, a valid key
///    matches, a VALUE carrying `'; DROP … --` binds as a parameter;
/// 6. the REAL retention prune (`lifecycle`) evicts the oldest row by the
///    quoted camelCase `latestAt` — the latent pre-fix failure.
async fn order_by_validation_scenario(url: &str, schema: &str) {
    eprintln!("storage_engine_pg: phase order_by_validation_scenario (schema {schema}) starting");
    const TABLE: &str = "order_probe";
    const FULL: &str = "feature_mission_monitor_order_probe";
    const RETENTION_TABLE: &str = "retention_probe";
    const RETENTION_FULL: &str = "feature_mission_monitor_retention_probe";

    let app_scratch = tempfile::tempdir().expect("tempdir");
    let handle = EngineHandle::new_pending();
    let app = SettingsStore::open(handle.clone(), app_scratch.path()).expect("app store");
    let applications = DynamicTableStore::open(handle.clone()).expect("application store");
    let data = ApplicationDataStore::open(handle.clone()).expect("data store");

    let pool = build_pool(url, schema).await;
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    // (1) The declared-shaped table: `latestAt` is created quoted, so PostgreSQL
    // stores it case-preserved (`"latestAt"`) rather than folding it.
    applications
        .ensure_table(FEATURE_ID, TABLE, &order_probe_columns())
        .expect("create the order-probe table");
    let types = pg_column_types(&pool, schema, FULL).await;
    assert!(
        types.contains_key("latestAt"),
        "the physical column must be the case-preserved `latestAt`, saw {types:?}"
    );
    assert!(
        !types.contains_key("latestat"),
        "PostgreSQL must NOT fold `latestAt`, saw {types:?}"
    );

    // Insert order (a, c, b) deliberately differs from every asserted order, so
    // each assertion proves the ORDER BY rather than the heap/insertion order.
    let seed = vec![
        probe_row("a", T1, 100, T1),
        probe_row("c", T2, 300, T2),
        probe_row("b", T0, 200, T0),
    ];
    assert_eq!(
        applications
            .insert(FEATURE_ID, TABLE, &seed)
            .expect("seed the order-probe table"),
        3
    );
    assert_eq!(pg_row_count(&pool, FULL).await, 3);

    // (2) Every injection payload class: a typed IdentifierError at the String
    // boundary, and NO SQL executed (table resolves, row count unchanged).
    for payload in [
        // statement terminator / extra tokens
        "id; DROP TABLE feature_mission_monitor_order_probe",
        "id ;",
        "id\n;",
        "id\n; DROP TABLE x",
        // paren / subquery
        "id) DROP TABLE x",
        "(SELECT 1)",
        "id, (SELECT 1)",
        "(SELECT pg_read_file('/etc/passwd'))",
        // multi-column
        "a, b",
        "a , b",
        // bad direction / third token
        "id SIDEWAYS",
        "id ASC extra",
        // whitespace-only (never a bare ORDER BY)
        "   ",
    ] {
        assert_rejected(
            applications
                .query(FEATURE_ID, TABLE, None, Some(payload), None)
                .map(|_| ()),
            payload,
            RejectionClass::InvalidOrderBy,
        );
        assert_no_sql_executed(&pool, FULL, payload).await;
    }
    for payload in [
        // a single token that is not a physical column
        "id;",
        "id;--",
        "id)",
        "a,b",
        "a,",
        "id,",
        "nope",
        // case mismatch: the physical column is `latestAt`
        "latestat",
    ] {
        assert_rejected(
            applications
                .query(FEATURE_ID, TABLE, None, Some(payload), None)
                .map(|_| ()),
            payload,
            RejectionClass::UnknownOrderColumn,
        );
        assert_no_sql_executed(&pool, FULL, payload).await;
    }

    // (3) Every valid order the verified callers pass, through the real sink.
    // `latestAt` is the latent pre-fix failure (unquoted → folded → missing col).
    assert_ordered(&applications, TABLE, Some("id ASC"), &["a", "b", "c"], "id ASC");
    assert_ordered(&applications, TABLE, Some("id DESC"), &["c", "b", "a"], "id DESC");
    assert_ordered(&applications, TABLE, Some("id"), &["a", "b", "c"], "id (default ASC)");
    assert_ordered(
        &applications,
        TABLE,
        Some("latestAt ASC"),
        &["b", "a", "c"],
        "latestAt ASC (camelCase repair)",
    );
    assert_ordered(
        &applications,
        TABLE,
        Some("latestAt DESC"),
        &["c", "a", "b"],
        "latestAt DESC",
    );
    assert_ordered(
        &applications,
        TABLE,
        Some("last_active_at DESC"),
        &["c", "b", "a"],
        "terminal list `last_active_at DESC`",
    );
    assert_ordered(
        &applications,
        TABLE,
        Some("_updated_at ASC"),
        &["b", "a", "c"],
        "retention `_updated_at ASC` fallback",
    );

    // (4) `None` / `Some("")` emit no ORDER BY — the result set is unaffected
    // (all three rows, in any order).
    for order_by in [None, Some("")] {
        let rows = applications
            .query(FEATURE_ID, TABLE, None, order_by, None)
            .expect("an absent/empty order_by must be accepted");
        let mut got = row_ids(&rows);
        got.sort();
        assert_eq!(
            got,
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            "{order_by:?} must return the whole unchanged set (no ORDER BY)"
        );
    }

    // (5) where_cols: a valid key matches; an unknown key is rejected with NO SQL
    // (query, update, and delete); a VALUE stays a bound parameter.
    let rows = applications
        .query(FEATURE_ID, TABLE, Some(&where_eq(&[("id", "b")])), None, None)
        .expect("a valid where key must query");
    assert_eq!(row_ids(&rows), vec!["b".to_string()]);

    for (label, result) in [
        (
            "query",
            applications
                .query(FEATURE_ID, TABLE, Some(&where_eq(&[("nope", "x")])), None, None)
                .map(|_| ()),
        ),
        (
            "update",
            applications
                .update(
                    FEATURE_ID,
                    TABLE,
                    &where_eq(&[("latestAt", T2)]),
                    &where_eq(&[("nope", "x")]),
                )
                .map(|_| ()),
        ),
        (
            "delete",
            applications
                .delete(FEATURE_ID, TABLE, &where_eq(&[("nope", "x")]))
                .map(|_| ()),
        ),
    ] {
        assert_rejected(result, "unknown where key", RejectionClass::UnknownWhereColumnNamed("nope"));
        assert_no_sql_executed(&pool, FULL, label).await;
    }

    // A VALUE carrying a statement terminator binds as `$1` — never executed.
    let injected_value = "x'; DROP TABLE feature_mission_monitor_order_probe --";
    let rows = applications
        .query(
            FEATURE_ID,
            TABLE,
            Some(&where_eq(&[("id", injected_value)])),
            None,
            None,
        )
        .expect("a where VALUE is always a bound parameter");
    assert!(
        rows.is_empty(),
        "the injected VALUE must match literally (zero rows), saw {rows:?}"
    );
    assert_no_sql_executed(&pool, FULL, "parameterized where value").await;

    // (6) The REAL retention prune: a declared `latestAt` table with `maxRows: 2`
    // must evict the oldest row by the quoted camelCase column (b @ T0) — the
    // exact caller leg the unquoted pre-fix SQL failed.
    applications
        .ensure_table(FEATURE_ID, RETENTION_TABLE, &retention_probe_columns())
        .expect("create the retention-probe table");
    let seed = vec![
        latest_row("a", T1),
        latest_row("c", T2),
        latest_row("b", T0),
    ];
    assert_eq!(
        applications
            .insert(FEATURE_ID, RETENTION_TABLE, &seed)
            .expect("seed the retention-probe table"),
        3
    );
    data.ensure_schema().expect("create the application-data schema");
    let declaration = retention_probe_declaration();
    let mut table_meta = meta(FEATURE_ID, RETENTION_TABLE, true, 0);
    table_meta.declaration_json =
        serde_json::to_string(&declaration).expect("serialize the retention declaration");
    data.put_table(&table_meta)
        .expect("persist the retention declaration");
    let evicted = prune_declared_tables_at(&data, &applications, &app, T2)
        .expect("the declared-latestAt prune must order by the quoted camelCase column");
    assert_eq!(
        evicted.len(),
        1,
        "maxRows: 2 over three rows evicts exactly the cap excess, saw {evicted:?}"
    );
    assert_eq!(evicted[0].kind, DeclaredChangeKind::Remove);
    assert_eq!(
        evicted[0].key,
        vec![json!("b")],
        "the oldest by `latestAt` (b @ {T0}) must be the evicted row, saw {evicted:?}"
    );
    assert_ordered(
        &applications,
        RETENTION_TABLE,
        Some("id ASC"),
        &["a", "c"],
        "rows remaining after the declared-latestAt prune",
    );
    assert_eq!(pg_row_count(&pool, RETENTION_FULL).await, 2);

    eprintln!(
        "storage_engine_pg: phase order_by_validation_scenario PASSED — \
         21 rejection payloads (typed IdentifierError, no SQL), 7 valid orders, \
         None/empty unaffected, where_cols accept/reject/parameterized, \
         declared-latestAt prune evicted the oldest row"
    );

    pool.close().await;
}

/// Which typed error class a rejected call must surface.
enum RejectionClass {
    /// Any `IdentifierError::InvalidOrderBy`.
    InvalidOrderBy,
    /// Any `IdentifierError::UnknownOrderColumn` (the Display must name it).
    UnknownOrderColumn,
    /// `IdentifierError::UnknownWhereColumn` whose column is the given name.
    UnknownWhereColumnNamed(&'static str),
}

/// Assert a sink call failed with the expected typed error class, and that the
/// String boundary (`map_err(|e| e.to_string())`) carries a non-empty message.
fn assert_rejected(result: anyhow::Result<()>, label: &str, class: RejectionClass) {
    let error = result.expect_err(&format!("{label:?} must be rejected"));
    let boundary = error.to_string();
    assert!(
        !boundary.is_empty(),
        "{label:?} must surface a non-empty String at the IPC boundary"
    );
    let typed = error
        .downcast::<IdentifierError>()
        .unwrap_or_else(|e| panic!("{label:?} must be a typed IdentifierError, got: {e}"));
    match class {
        RejectionClass::InvalidOrderBy => assert!(
            matches!(typed, IdentifierError::InvalidOrderBy { .. }),
            "{label:?} must be InvalidOrderBy, saw {typed:?}"
        ),
        RejectionClass::UnknownOrderColumn => {
            let IdentifierError::UnknownOrderColumn { column } = &typed else {
                panic!("{label:?} must be UnknownOrderColumn, saw {typed:?}");
            };
            assert!(
                boundary.contains(column.as_str()),
                "{label:?}: the boundary message must name the column, saw {boundary:?}"
            );
        }
        RejectionClass::UnknownWhereColumnNamed(expected) => {
            let IdentifierError::UnknownWhereColumn { column } = &typed else {
                panic!("{label:?} must be UnknownWhereColumn, saw {typed:?}");
            };
            assert_eq!(column, expected, "{label:?}");
            assert!(
                boundary.contains(column.as_str()),
                "{label:?}: the boundary message must name the column, saw {boundary:?}"
            );
        }
    }
}

/// Assert the rejected call executed no SQL: the target table still resolves and
/// the row count is unchanged.
async fn assert_no_sql_executed(pool: &sqlx::PgPool, full_table: &str, label: &str) {
    assert!(
        table_resolves(pool, full_table).await,
        "{label:?} must execute no SQL — {full_table} no longer resolves"
    );
    assert_eq!(
        pg_row_count(pool, full_table).await,
        3,
        "{label:?} must execute no SQL — the row count changed"
    );
}

/// Drive one valid `order_by` through the sink and assert the exact row order.
fn assert_ordered(
    applications: &DynamicTableStore,
    table: &str,
    order_by: Option<&str>,
    expected: &[&str],
    label: &str,
) {
    let rows = applications
        .query(FEATURE_ID, table, None, order_by, None)
        .unwrap_or_else(|e| panic!("order by {label} must succeed: {e}"));
    let got = row_ids(&rows);
    let want: Vec<String> = expected.iter().map(|id| (*id).to_string()).collect();
    assert_eq!(got, want, "order by {label} must return {expected:?}, saw {got:?}");
}

fn row_ids(rows: &[Map<String, JsonValue>]) -> Vec<String> {
    rows.iter()
        .map(|row| row.get("id").and_then(JsonValue::as_str).unwrap_or_default().to_string())
        .collect()
}

/// A row for the order-probe table (camelCase `latestAt` + terminal/retention
/// order columns).
fn probe_row(
    id: &str,
    latest_at: &str,
    last_active_at: i64,
    updated_at: &str,
) -> Map<String, JsonValue> {
    let mut row = Map::new();
    row.insert("id".to_string(), json!(id));
    row.insert("latestAt".to_string(), json!(latest_at));
    row.insert("last_active_at".to_string(), json!(last_active_at));
    row.insert("_updated_at".to_string(), json!(updated_at));
    row
}

fn latest_row(id: &str, latest_at: &str) -> Map<String, JsonValue> {
    let mut row = Map::new();
    row.insert("id".to_string(), json!(id));
    row.insert("latestAt".to_string(), json!(latest_at));
    row
}

fn order_probe_columns() -> Vec<ColumnDef> {
    vec![
        column("id", ColumnType::TEXT, false, true),
        column("latestAt", ColumnType::TEXT, true, false),
        column("last_active_at", ColumnType::INTEGER, true, false),
        column("_updated_at", ColumnType::TEXT, true, false),
    ]
}

fn retention_probe_columns() -> Vec<ColumnDef> {
    vec![
        column("id", ColumnType::TEXT, false, true),
        column("latestAt", ColumnType::TEXT, true, false),
    ]
}

/// The declared retention table the prune scenario materializes: `latestAt`
/// declared (so the prune must order by the camelCase column) and `maxRows: 2`.
fn retention_probe_declaration() -> ApplicationDataTableDeclaration {
    ApplicationDataTableDeclaration {
        name: "retention_probe".to_string(),
        primary_key: vec!["id".to_string()],
        columns: vec![
            DeclaredColumn {
                name: "id".to_string(),
                col_type: DeclaredColumnType::Text,
                nullable: false,
                owner: ColumnOwner::Backend,
            },
            DeclaredColumn {
                name: "latestAt".to_string(),
                col_type: DeclaredColumnType::Text,
                nullable: true,
                owner: ColumnOwner::Backend,
            },
        ],
        source: None,
        retention: Some(Retention {
            max_rows: Some(2),
            ttl_days: None,
        }),
    }
}

/// The MM-shaped declaration whose unquoted DDL PostgreSQL folded — mirrors the
/// registry unit-test declaration: mixed-case PK `sessionId`, mixed-case column
/// `chatRowCount`.
fn mm_sessions_declaration() -> ApplicationDataDeclaration {
    ApplicationDataDeclaration {
        feature_id: "mission-monitor".to_string(),
        declaration_revision: "mm.sessions.v1".to_string(),
        tables: vec![ApplicationDataTableDeclaration {
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
                // ST-4 rework: a ns-epoch timestamp (Integer → bigint on PG) and
                // a ratio (Real → double precision on PG). Mixed case is kept so
                // the quoting pin above still holds.
                DeclaredColumn {
                    name: "startedAtNs".to_string(),
                    col_type: DeclaredColumnType::Integer,
                    nullable: true,
                    owner: ColumnOwner::Backend,
                },
                DeclaredColumn {
                    name: "tokenRatio".to_string(),
                    col_type: DeclaredColumnType::Real,
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

// ── The shared fixture ───────────────────────────────────────────────────────

/// Run the fixture against one engine's store set and return a sorted list of
/// `name=value` observables.
async fn run_fixture(
    app: &SettingsStore,
    applications: &DynamicTableStore,
    data: &ApplicationDataStore,
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
    applications
        .ensure_table(FEATURE_ID, "items", &item_columns())
        .expect("ensure table");
    applications
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
        applications.insert(FEATURE_ID, "items", &seed).expect("insert")
    ));

    // EARS-4.1: a duplicate PK is silently ignored — the original row wins.
    let dup = vec![item("a", "SHOULD-NOT-WIN", 999, 9.5, &[7], 99, T0)];
    out.push(format!(
        "insert.dup={}",
        applications.insert(FEATURE_ID, "items", &dup).expect("dup insert")
    ));
    let a = applications
        .query(FEATURE_ID, "items", Some(&where_eq(&[("id", "a")])), None, None)
        .expect("query a");
    out.push(format!("row.a.label={}", a[0]["label"]));

    // EARS-2.1 / F-7: `ON CONFLICT DO UPDATE ... EXCLUDED`.
    let updated = vec![item("b", "beta-updated", 20, 2.25, &[9, 9], 2, T1)];
    out.push(format!(
        "upsert.b={}",
        applications
            .upsert(FEATURE_ID, "items", &["id".to_string()], &updated)
            .expect("upsert")
    ));
    let b = applications
        .query(FEATURE_ID, "items", Some(&where_eq(&[("id", "b")])), None, None)
        .expect("query b");
    out.push(format!("row.b.label={}", b[0]["label"]));
    out.push(format!("row.b.version={}", b[0]["_row_version"]));

    // F-7: a multi-parameter query (`$n`, order preserved).
    let multi = applications
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
        applications
            .query(FEATURE_ID, "items", None, Some("id"), None)
            .expect("query all")
            .len()
    ));

    // ── application_data_* (EARS-2.2, EARS-2.3) ──────────────────────────────────
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

fn meta(application: &str, table: &str, backfill_done: bool, last_version: i64) -> TableMeta {
    TableMeta {
        feature_id: application.to_string(),
        table_name: table.to_string(),
        declaration_json: format!(r#"{{"applicationId":"{application}","table":"{table}"}}"#),
        declaration_revision: "mm.sessions.v2".to_string(),
        last_version,
        backfill_done,
    }
}

fn tombstone(application: &str, table: &str, key_json: &str, deleted_at: &str) -> Tombstone {
    Tombstone {
        feature_id: application.to_string(),
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

/// `true` when `table` exists in `schema` on the PostgreSQL pool (catalog probe).
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

/// `true` when the fully-qualified table still resolves (the "no SQL executed"
/// probe for a rejected dynamic identifier).
async fn table_resolves(pool: &sqlx::PgPool, full_table: &str) -> bool {
    let found: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
        .bind(full_table)
        .fetch_one(pool)
        .await
        .expect("to_regclass probe");
    found.is_some()
}

/// Row count of the fully-qualified table (unchanged after a rejected call).
async fn pg_row_count(pool: &sqlx::PgPool, full_table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{full_table}\""))
        .fetch_one(pool)
        .await
        .expect("COUNT(*) probe")
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
