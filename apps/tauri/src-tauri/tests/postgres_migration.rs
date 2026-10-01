//! ST-7 — gated cross-engine integration test for the one-shot `fredo.db` →
//! PostgreSQL data migration (Spec #2977, slice 4 / CU-D).
//!
//! This integration binary drives the production migration leg
//! ([`run_pre_install`]) against a **real** embedded PostgreSQL server (the
//! slice-1 bounded `PgRuntime`, the same harness as `tests/storage_engine_pg.rs`)
//! over a **committed, deterministic, in-repo fixture** built by
//! [`migration_fixture`]. It asserts:
//!
//! * per-table row-count **AND** SHA-256 content-checksum parity for EVERY
//!   physical table in the fixture;
//! * marker byte-identity (`rtdb.backfill.completed`,
//!   `rtdb.backfill.provider.completed.v2`, each
//!   `feature_data_tables.backfill_done`);
//! * a legacy/ignored `settings` key survives the copy byte-for-byte;
//! * a second startup with `migration.postgres.completed` set SKIPS the export;
//! * a forced mismatch (`FREDO_MIGRATION_FORCE_MISMATCH`) fails the run closed —
//!   no marker, no engine install, source untouched;
//! * `verify_snapshot` + `restore_snapshot` round-trip (restored counts/checksums
//!   equal the pre-cutover values).
//!
//! # Offline gate (G-279)
//!
//! The whole binary is gated behind `FREDO_TEST_PG=1`: a normal
//! `cargo test --locked` (or `cargo nextest run`) executes this test as an
//! immediate no-op — no server, no network, no filesystem work. Run the real
//! suite with the gate set inside a script (never inline in a shell command the
//! outer shell expands):
//!
//! ```text
//! FREDO_TEST_PG=1 cargo test --locked --test postgres_migration -- --nocapture
//! ```
//!
//! The **AC5** measurement phase additionally runs when
//! `FREDO_MIGRATION_MEASURE=1` is set (a >100k-row generated fixture).
//!
//! # G-263 safety
//!
//! Exactly ONE embedded server per binary, started ONCE and torn down by a
//! single owning scope. Every start/stop leg is finitely bounded by `PgRuntime`
//! (`Settings::timeout` + `run_bounded` + the stop watchdog + `taskkill`
//! fallback), and its RAII `Drop` hard-kills the postmaster tree on the normal,
//! error, AND panic-unwind paths. The post-stop assertion re-probes the resolved
//! port and fails if the postmaster still accepts connections.
//!
//! # G-264
//!
//! The source is ALWAYS the generated in-repo fixture served through
//! `FREDO_DATA_DIR`; the live `%APPDATA%\com.fredo.app\fredo.db` is never read.

#[path = "support/migration_fixture.rs"]
mod migration_fixture;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fredo_lib::infrastructure::feature_data::store::FeatureDataStore;
use fredo_lib::infrastructure::storage::engine::{
    ensure_settings_schema, Dialect, EngineChoice, PgEngine, StorageEngineState,
};
use fredo_lib::infrastructure::storage::migration::snapshot::SNAPSHOT_FILENAME;
use fredo_lib::infrastructure::storage::migration::{
    enumerate_tables, resolve_app_data_dir, resolve_migration_dir, restore_snapshot, run_pre_install,
    verify_snapshot, MigrationStatus, MIGRATION_CHUNK_ROWS, MIGRATION_COMPLETED_KEY,
};
use fredo_lib::infrastructure::storage::{EngineHandle, SqliteEngine, StoreEngine};
use fredo_lib::PgRuntime;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

// ── Binding names (G-255) ────────────────────────────────────────────────────

const GATE_ENV: &str = "FREDO_TEST_PG";
const MEASURE_ENV: &str = "FREDO_MIGRATION_MEASURE";
const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
const DATA_DIR_ENV: &str = "FREDO_DATA_DIR";
const MIGRATION_DIR_ENV: &str = "FREDO_MIGRATION_DIR";
const FORCE_MISMATCH_ENV: &str = "FREDO_MIGRATION_FORCE_MISMATCH";

/// Finite teardown bound (G-263) — never an unbounded wait on the postmaster.
const STOP_BOUND: Duration = Duration::from_secs(30);

fn pg_enabled() -> bool {
    matches!(std::env::var(GATE_ENV).as_deref(), Ok("1"))
}

fn measure_enabled() -> bool {
    matches!(std::env::var(MEASURE_ENV).as_deref(), Ok("1"))
}

/// `<repo>/.opencode/tmp/2977` — the sanctioned scratch dir for this issue.
fn repo_tmp() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(".opencode")
        .join("tmp")
        .join("2977")
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

#[tokio::test(flavor = "multi_thread")]
async fn cross_engine_migration_suite() {
    if !pg_enabled() {
        eprintln!("postgres_migration: skipping — set {GATE_ENV}=1 to run the gated PG suite");
        return;
    }

    let tmp = repo_tmp();
    let fixture_dir = tmp.join("fixture");
    let migration_dir = tmp.join("migration");
    let pg_data_dir = tmp.join("pgdata-d");
    let app_dir = tmp.join("pgtest-app-d");
    let scratch_dir = tmp.join("scratch");
    for dir in [&fixture_dir, &migration_dir, &pg_data_dir, &app_dir, &scratch_dir] {
        std::fs::create_dir_all(dir).expect("create the scratch dir");
    }

    // G-275 levers: the fixture is served through `FREDO_DATA_DIR`, the
    // scratch/snapshot dir through `FREDO_MIGRATION_DIR`; the FS-1 PG data dir
    // keeps the embedded server's data OUT of the app data dir.
    std::env::set_var(PG_DATA_DIR_ENV, &pg_data_dir);
    std::env::set_var(DATA_DIR_ENV, &fixture_dir);
    std::env::set_var(MIGRATION_DIR_ENV, &migration_dir);

    // Deterministic in-repo fixture (never the live %APPDATA% fredo.db — G-264).
    let source_db = fixture_dir.join("fredo.db");
    migration_fixture::build_fixture(&source_db, &migration_fixture::FixtureScale::SMALL)
        .expect("build the deterministic fixture");
    let source_sha_before = sha256_file(&source_db);

    // The levers resolve the SAME source + scratch the test generated.
    assert_eq!(
        resolve_app_data_dir(Path::new("C:/os/appdata")),
        fixture_dir,
        "{DATA_DIR_ENV} must redirect the app data root"
    );
    assert_eq!(
        resolve_migration_dir(&fixture_dir),
        migration_dir,
        "{MIGRATION_DIR_ENV} must redirect the scratch/snapshot dir"
    );

    // ONE embedded server. Every call below is internally bounded; `Drop` is the
    // panic/error hard-kill backstop.
    let mut runtime = PgRuntime::new(&app_dir, "fredo-test-password".to_string());
    runtime
        .setup()
        .await
        .expect("embedded PostgreSQL setup (bounded)");
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

    // ── Phase A: one-shot carry + per-table parity + markers ────────────────
    let carry_schema = unique_schema("carry");
    let carry_pool = build_pool(&url, &carry_schema).await;
    let carry_state = sqlite_state(&scratch_dir.join("carry.db"));
    register_schema_inits(&carry_state);
    carry_state
        .run_pg_schema_inits(&carry_pool)
        .expect("the startup schema inits must run on the candidate pool");

    // The supervisor holds the exclusive barrier ACROSS the install (R-3.5);
    // model that exact sequence here.
    let carry_gate = carry_state.migration_gate();
    let guard = carry_gate
        .migration_enter()
        .await
        .expect("the exclusive migration barrier must be acquired");
    let carry_outcome = run_pre_install(&source_db, &migration_dir, &carry_pool, &guard)
        .await
        .expect("the one-shot carry must complete");
    assert_eq!(
        carry_outcome.status,
        MigrationStatus::Completed,
        "a clean fixture must complete"
    );
    carry_state.install_postgres(PgEngine {
        pool: carry_pool.clone(),
        url: url.clone(),
    });
    drop(guard);
    assert_eq!(
        carry_state.status().engine,
        Dialect::Postgres,
        "the engine flips to PostgreSQL on a parity-clean run"
    );

    let source_conn = Connection::open_with_flags(&source_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open the fixture read-only");
    let source_tables = enumerate_tables(&source_conn).expect("enumerate the fixture tables");
    assert!(
        !source_tables.is_empty(),
        "the fixture must contain at least one physical table"
    );
    assert!(
        source_tables
            .iter()
            .any(|spec| spec.name == migration_fixture::DYNAMIC_FEATURE_TABLE),
        "the fixture must contain the dynamic {} table",
        migration_fixture::DYNAMIC_FEATURE_TABLE
    );

    // AC1/AC2: every fixture table has a parity pair and BOTH comparisons pass.
    for spec in &source_tables {
        let parity = carry_outcome
            .tables
            .iter()
            .find(|parity| parity.table == spec.name)
            .unwrap_or_else(|| panic!("no parity recorded for '{}'", spec.name));
        assert!(
            parity.count_match,
            "row-count parity for '{}': source {} target {}",
            parity.table, parity.source_rows, parity.target_rows
        );
        assert!(
            parity.checksum_match,
            "content-checksum parity for '{}': source {} target {}",
            parity.table, parity.source_checksum, parity.target_checksum
        );
        assert!(
            parity.read_only_source,
            "the source read must be read-only for '{}'",
            parity.table
        );
        assert!(
            pg_has_table(&carry_pool, &carry_schema, &spec.name).await,
            "'{}' must exist in the target schema",
            spec.name
        );
    }
    assert_eq!(
        carry_outcome.tables.len(),
        source_tables.len(),
        "every fixture table must be carried"
    );

    // AC4: marker byte-identity + the legacy/ignored settings key.
    for key in [
        "rtdb.backfill.completed",
        "rtdb.backfill.provider.completed.v2",
        "legacy.ignored.key",
    ] {
        let source_value = sqlite_setting(&source_db, key);
        assert!(
            source_value.is_some(),
            "the fixture must carry the settings key '{key}'"
        );
        let target_value = pg_setting(&carry_pool, key).await;
        assert_eq!(
            target_value, source_value,
            "settings key '{key}' must survive the copy byte-for-byte"
        );
    }

    let source_backfill = sqlite_backfill(&source_db);
    assert!(
        source_backfill.iter().any(|(_, _, done)| *done == 0)
            && source_backfill.iter().any(|(_, _, done)| *done == 1),
        "the fixture must carry both backfill_done states: {source_backfill:?}"
    );
    assert_eq!(
        pg_backfill(&carry_pool).await,
        source_backfill,
        "each feature_data_tables.backfill_done must be carried verbatim"
    );

    assert!(
        pg_setting(&carry_pool, MIGRATION_COMPLETED_KEY).await.is_some(),
        "a parity-clean run must set {MIGRATION_COMPLETED_KEY}"
    );

    // ── Phase B: a second startup with the marker set SKIPS the export ──────
    let marker_before = pg_setting(&carry_pool, MIGRATION_COMPLETED_KEY)
        .await
        .expect("the marker must be present after phase A");
    sqlx::query("DELETE FROM chat_rows WHERE ctid IN (SELECT ctid FROM chat_rows LIMIT 1)")
        .execute(&carry_pool)
        .await
        .expect("mutate the target to detect a re-copy");
    let target_chat_after_delete: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM chat_rows")
            .fetch_one(&carry_pool)
            .await
            .expect("count the target chat_rows");

    let guard = carry_gate
        .migration_enter()
        .await
        .expect("the exclusive migration barrier must be re-acquired");
    let skip_outcome = run_pre_install(&source_db, &migration_dir, &carry_pool, &guard)
        .await
        .expect("a marker-set second startup must return cleanly");
    drop(guard);
    assert_eq!(
        skip_outcome.status,
        MigrationStatus::Skipped,
        "a present {MIGRATION_COMPLETED_KEY} must SKIP the export"
    );
    assert!(
        skip_outcome.tables.is_empty(),
        "a skipped run must not re-run any per-table copy"
    );
    let target_chat_after_skip: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM chat_rows")
            .fetch_one(&carry_pool)
            .await
            .expect("count the target chat_rows after the skip");
    assert_eq!(
        target_chat_after_skip, target_chat_after_delete,
        "a skipped startup must NOT re-copy (the deleted target row stays deleted)"
    );
    let marker_after = pg_setting(&carry_pool, MIGRATION_COMPLETED_KEY)
        .await
        .expect("the marker must still be present");
    assert_eq!(
        marker_after, marker_before,
        "the completion marker must be byte-identical across a skip"
    );

    // ── Phase C: snapshot verify + restore round-trip (AC3) ─────────────────
    let snapshot = migration_dir.join(SNAPSHOT_FILENAME);
    assert!(
        snapshot.exists(),
        "the carry phase must leave the single pre-cutover snapshot"
    );
    let verified = verify_snapshot(&snapshot).expect("verify the snapshot");
    for parity in &carry_outcome.tables {
        let snapshot_parity = verified
            .iter()
            .find(|candidate| candidate.table == parity.table)
            .unwrap_or_else(|| panic!("no snapshot parity for '{}'", parity.table));
        assert_eq!(
            snapshot_parity.source_rows, parity.source_rows,
            "snapshot row count for '{}'",
            parity.table
        );
        assert_eq!(
            snapshot_parity.source_checksum, parity.source_checksum,
            "snapshot checksum for '{}'",
            parity.table
        );
    }

    let restored = scratch_dir.join("restored").join("fredo.db");
    restore_snapshot(&snapshot, &restored).expect("restore the snapshot");
    let restored_parity = verify_snapshot(&restored).expect("verify the restored database");
    for parity in &carry_outcome.tables {
        let restored_table = restored_parity
            .iter()
            .find(|candidate| candidate.table == parity.table)
            .unwrap_or_else(|| panic!("no restored parity for '{}'", parity.table));
        assert_eq!(
            restored_table.source_rows, parity.source_rows,
            "restored row count for '{}' must equal the pre-cutover value",
            parity.table
        );
        assert_eq!(
            restored_table.source_checksum, parity.source_checksum,
            "restored checksum for '{}' must equal the pre-cutover value",
            parity.table
        );
    }
    carry_pool.close().await;

    // ── Phase D: forced mismatch → fail-closed, nothing installed ───────────
    for (fault, label) in [
        ("settings", "drop_row"),
        ("1", "first_non_empty"),
        ("chat_rows:export_error", "export_error"),
    ] {
        let schema = unique_schema(&format!("mismatch_{label}"));
        let pool = build_pool(&url, &schema).await;
        let state = sqlite_state(&scratch_dir.join(format!("mismatch-{label}.db")));
        register_schema_inits(&state);
        state
            .run_pg_schema_inits(&pool)
            .expect("schema inits on the mismatch candidate");

        let mismatch_dir = tmp.join(format!("migration-mismatch-{label}"));
        std::env::set_var(FORCE_MISMATCH_ENV, fault);
        let gate = state.migration_gate();
        let guard = gate
            .migration_enter()
            .await
            .expect("the exclusive migration barrier must be acquired");
        let result = run_pre_install(&source_db, &mismatch_dir, &pool, &guard).await;
        drop(guard);
        std::env::remove_var(FORCE_MISMATCH_ENV);

        assert!(
            result.is_err(),
            "the fault seam '{fault}' must fail the run closed, saw {result:?}"
        );
        assert!(
            pg_setting(&pool, MIGRATION_COMPLETED_KEY).await.is_none(),
            "a fail-closed run must NOT set the marker ('{fault}')"
        );
        assert_eq!(
            state.status().engine,
            Dialect::Sqlite,
            "a fail-closed run must NOT install PostgreSQL ('{fault}')"
        );
        pool.close().await;
    }

    // The migration leg (successful and fail-closed) never mutates the source.
    assert_eq!(
        sha256_file(&source_db),
        source_sha_before,
        "the migration leg must never mutate fredo.db"
    );

    // ── AC5 measurement (opt-in, >100k-row generated fixture) ───────────────
    if measure_enabled() {
        measurement_phase(&tmp, &scratch_dir, &url).await;
    }

    // ── G-263 teardown: finite bound + guaranteed hard-kill + no orphan ─────
    let started = Instant::now();
    let outcome = runtime.stop_bounded(STOP_BOUND).await;
    let elapsed = started.elapsed();
    eprintln!("postgres_migration: stop_bounded -> {outcome:?} in {elapsed:?}");
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

/// The **AC5** measurement: a generated >100k-row fixture copied through the
/// production leg, with wall-clock + peak working set recorded under
/// `.opencode/tmp/2977/measurement.md`.
async fn measurement_phase(tmp: &Path, scratch_dir: &Path, url: &str) {
    let scale = migration_fixture::FixtureScale::LARGE;
    assert!(
        scale.largest_table_rows() > MIGRATION_CHUNK_ROWS * 2,
        "the measurement fixture must exercise multiple {MIGRATION_CHUNK_ROWS}-row chunks"
    );

    let large_dir = tmp.join("fixture-large");
    let large_db = large_dir.join("fredo.db");
    migration_fixture::build_fixture(&large_db, &scale).expect("build the large deterministic fixture");
    let fixture_bytes = std::fs::metadata(&large_db)
        .expect("stat the large fixture")
        .len();

    let schema = unique_schema("measure");
    let pool = build_pool(url, &schema).await;
    let state = sqlite_state(&scratch_dir.join("measure.db"));
    register_schema_inits(&state);
    state
        .run_pg_schema_inits(&pool)
        .expect("schema inits on the measurement candidate");

    let migration_dir = tmp.join("migration-large");
    let gate = state.migration_gate();
    let guard = gate
        .migration_enter()
        .await
        .expect("the exclusive migration barrier must be acquired");
    let started = Instant::now();
    let outcome = run_pre_install(&large_db, &migration_dir, &pool, &guard)
        .await
        .expect("the large copy must complete within MIGRATION_BOUND");
    let wall_clock = started.elapsed();
    drop(guard);
    assert_eq!(outcome.status, MigrationStatus::Completed);
    assert!(
        outcome
            .tables
            .iter()
            .all(|parity| parity.count_match && parity.checksum_match),
        "every large-fixture table must pass both parity comparisons"
    );

    let peak_working_set = peak_working_set_bytes();
    let largest = scale.largest_table_rows();
    let chunks = largest.div_ceil(MIGRATION_CHUNK_ROWS);
    let report = format!(
        "# AC5 measurement — one-shot `fredo.db` → PostgreSQL copy\n\n\
         - **Fixture:** a GENERATED deterministic fixture (NOT the live dev DB); \
         source `{}` ({} bytes)\n\
         - **Scale:** largest table `chat_rows` = {} rows; total fixture rows = {}; \
         `MIGRATION_CHUNK_ROWS` = {} ⇒ ~{} chunks in the largest table\n\
         - **Wall clock (snapshot + copy + parity + marker):** {} ms\n\
         - **`MigrationOutcome.elapsed_ms`:** {}\n\
         - **Peak working set** (`Get-Process PeakWorkingSet64`): {}\n\
         - **Parity:** {} tables, every count + checksum matched\n",
        large_db.display(),
        fixture_bytes,
        largest,
        scale.total_rows(),
        MIGRATION_CHUNK_ROWS,
        chunks,
        wall_clock.as_millis(),
        outcome.elapsed_ms,
        peak_working_set
            .map(|bytes| format!("{bytes} bytes ({:.1} MiB)", bytes as f64 / 1_048_576.0))
            .unwrap_or_else(|| "unavailable".to_string()),
        outcome.tables.len(),
    );
    std::fs::write(tmp.join("measurement.md"), &report).expect("write the measurement evidence");
    eprintln!("MIGRATION_MEASURE {}", report.replace('\n', " | "));
    pool.close().await;
}

/// The test process's PEAK working set (Windows `PROCESS_MEMORY_COUNTERS`),
/// read through `Get-Process` so no new dependency is introduced.
fn peak_working_set_bytes() -> Option<u64> {
    let pid = std::process::id();
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid}).PeakWorkingSet64"),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

// ── Pool / engine helpers ────────────────────────────────────────────────────

/// Build a pool whose every connection resolves unqualified identifiers inside
/// `schema`, and create the shared `settings` schema on it.
async fn build_pool(url: &str, schema: &str) -> PgPool {
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

/// A `StorageEngineState` whose swap-once handle starts on SQLite, exactly like
/// `lib.rs` before the supervisor installs PostgreSQL.
fn sqlite_state(db_path: &Path) -> Arc<StorageEngineState> {
    let engine = SqliteEngine::open(db_path).expect("open the scratch SQLite engine");
    let handle = EngineHandle::new(StoreEngine::Sqlite(engine));
    StorageEngineState::new(handle, EngineChoice::Postgres)
}

/// Register the SAME startup schema initializers `lib.rs` wires, so the
/// candidate pool carries the full startup schema set BEFORE the migration (the
/// production order: schema inits → `run_pre_install` → install).
fn register_schema_inits(state: &Arc<StorageEngineState>) {
    state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
        FeatureDataStore::ensure_schema_on_pg(pool)
    }));
    state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
        fredo_lib::ensure_terminal_table_on_pg(pool)
    }));
    state.register_slice3_pg_schema_inits();
}

async fn pg_has_table(pool: &PgPool, schema: &str, table: &str) -> bool {
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

// ── Source (SQLite) reads ────────────────────────────────────────────────────

fn sha256_file(path: &Path) -> String {
    let bytes = std::fs::read(path).expect("read the file to hash");
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("{:x}", hasher.finalize())
}

fn sqlite_setting(path: &Path, key: &str) -> Option<String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open the fixture read-only");
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .expect("read a settings value")
}

fn sqlite_backfill(path: &Path) -> Vec<(String, String, i64)> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open the fixture read-only");
    let mut statement = conn
        .prepare(
            "SELECT feature_id, table_name, backfill_done FROM feature_data_tables
             ORDER BY feature_id, table_name",
        )
        .expect("prepare the backfill read");
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .expect("query the backfill rows")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect the backfill rows")
}

// ── Target (PostgreSQL) reads ────────────────────────────────────────────────

async fn pg_setting(pool: &PgPool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .expect("read a PostgreSQL settings value")
}

async fn pg_backfill(pool: &PgPool) -> Vec<(String, String, i64)> {
    sqlx::query_as(
        "SELECT feature_id, table_name, backfill_done FROM feature_data_tables
         ORDER BY feature_id, table_name",
    )
    .fetch_all(pool)
    .await
    .expect("read the PostgreSQL backfill rows")
}

// ── Fixture generator entry point (committed, deterministic) ─────────────────

/// The committed generator is a pure function of its scale: two builds produce
/// byte-identical databases (no RNG, no clock). Runs ungated (fast, no PG).
#[test]
fn fixture_generator_is_deterministic() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("first.db");
    let second = dir.path().join("second.db");
    migration_fixture::build_fixture(&first, &migration_fixture::FixtureScale::SMALL)
        .expect("build the first fixture");
    migration_fixture::build_fixture(&second, &migration_fixture::FixtureScale::SMALL)
        .expect("build the second fixture");
    assert_eq!(
        std::fs::read(&first).expect("read the first fixture"),
        std::fs::read(&second).expect("read the second fixture"),
        "the fixture generator must be byte-deterministic"
    );
}

/// Rebuild the canonical small fixture at `.opencode/tmp/2977/fixture/fredo.db`
/// without running the migration — for QA to serve to the app via
/// `FREDO_DATA_DIR`. Ignored by default so it never races the gated suite.
#[test]
#[ignore = "fixture generator: run with --ignored to (re)build .opencode/tmp/2977/fixture/fredo.db"]
fn generate_migration_fixture() {
    let path = repo_tmp().join("fixture").join("fredo.db");
    migration_fixture::build_fixture(&path, &migration_fixture::FixtureScale::SMALL)
        .expect("build the deterministic fixture");
    eprintln!("wrote deterministic fixture: {}", path.display());
}
