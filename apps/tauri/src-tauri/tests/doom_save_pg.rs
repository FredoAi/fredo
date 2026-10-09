//! Spec #3011 round-2 regression pin — the Doom save PG round-trip.
//!
//! Drives the REAL [`fredo_lib::doom::save::store`] against the REAL embedded
//! PostgreSQL server (the slice-1 bounded `PgRuntime`) and asserts the upsert
//! round-trips through the `feature_doom_save` table keyed on the `id` column.
//!
//! The round-1 defect: `store` passed the row VALUE `"singleton"`
//! (`DOOM_SAVE_ROW_ID`) as the primary-key COLUMN list, so
//! `ApplicationStore::upsert` emitted `ON CONFLICT("singleton")` and PostgreSQL
//! rejected it with `column "singleton" does not exist` — every save failed
//! (best-effort) and NO row ever persisted. This pin fails if the PK list and
//! the row value are ever conflated again: the first `store` would return `Err`.
//!
//! # Offline gate
//!
//! The binary is gated behind `FREDO_TEST_PG=1`: a normal `cargo test --locked`
//! executes it as an immediate no-op — no server, no network, no filesystem
//! work. Run the real suite with:
//!
//! ```text
//! FREDO_TEST_PG=1 cargo test --locked --test doom_save_pg
//! ```
//!
//! The PG path is selected only when `FREDO_DOOM_SAVE_STATE_DIR` is UNSET (the
//! state-dir seam short-circuits before the PG feature table).
//!
//! # G-263 safety
//!
//! Exactly ONE embedded server per binary, started ONCE and torn down by a single
//! owning scope via `PgRuntime::stop_bounded` (finite bound + hard-kill + the
//! RAII `Drop` backstop), and the post-stop port is re-probed.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fredo_lib::doom::save::{
    self, DoomSave, DOOM_DEFAULT_SEED, DOOM_DEFAULT_SKILL, DOOM_SAVE_FEATURE_ID, DOOM_SAVE_ROW_ID,
    DOOM_SAVE_STATE_DIR_ENV, DOOM_SAVE_TABLE_NAME, DOOM_SAVE_VERSION,
};
use fredo_lib::infrastructure::storage::application_store::ApplicationStore;
use fredo_lib::infrastructure::storage::{EngineHandle, PgEngine, StoreEngine};
use fredo_lib::PgRuntime;

const GATE_ENV: &str = "FREDO_TEST_PG";
const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
/// Finite teardown bound (G-263).
const STOP_BOUND: Duration = Duration::from_secs(30);

fn pg_enabled() -> bool {
    matches!(std::env::var(GATE_ENV).as_deref(), Ok("1"))
}

/// `<repo>/.opencode/tmp/3011` — the sanctioned scratch dir for this issue.
fn repo_tmp() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(".opencode")
        .join("tmp")
        .join("3011")
}

fn unique_schema(tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{tag}_{nanos}")
}

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
    pool
}

fn sample() -> DoomSave {
    DoomSave {
        version: DOOM_SAVE_VERSION,
        episode: 1,
        map: 2,
        skill: DOOM_DEFAULT_SKILL,
        seed: DOOM_DEFAULT_SEED,
        completed: false,
        updated_at: "2026-10-05T12:00:00+00:00".to_string(),
    }
}

/// The defect pin: one `store` must succeed (PK column `id`, not the row value)
/// and read back; repeated `store`s must collapse to a single `id='singleton'`
/// row.
async fn doom_save_round_trips_through_the_id_keyed_upsert(pool: &sqlx::PgPool, url: &str) {
    // The PG feature table is only used when the state-dir seam is unset.
    assert!(
        std::env::var(DOOM_SAVE_STATE_DIR_ENV).is_err(),
        "the PG round-trip requires {DOOM_SAVE_STATE_DIR_ENV} to be UNSET"
    );

    let handle = EngineHandle::new_pending();
    let store = ApplicationStore::open(handle.clone()).expect("application store");
    handle.install(StoreEngine::Postgres(Arc::new(PgEngine {
        pool: pool.clone(),
        url: url.to_string(),
    })));

    save::ensure_table_on_pg(pool).expect("ensure feature_doom_save");

    // One store succeeds and the SAME record reads back — the pre-fix code
    // returned `Err` here (ON CONFLICT("singleton") → column does not exist).
    let first = sample();
    save::store(&store, &first).expect("first store must succeed with the `id` PK column");
    assert_eq!(
        save::load(&store),
        Some(first.clone()),
        "the stored save must round-trip through load"
    );

    // Repeated stores collapse to exactly ONE `id='singleton'` row (the atomic
    // upsert — never delete-then-insert).
    let mut second = sample();
    second.map = 5;
    second.updated_at = "2026-10-05T13:00:00+00:00".to_string();
    save::store(&store, &second).expect("second store must succeed");
    let rows = store
        .query(DOOM_SAVE_FEATURE_ID, DOOM_SAVE_TABLE_NAME, None, None, None)
        .expect("query all doom save rows");
    assert_eq!(rows.len(), 1, "exactly one singleton row after repeated stores");
    assert_eq!(
        rows[0].get("id").and_then(|value| value.as_str()),
        Some(DOOM_SAVE_ROW_ID),
        "the single row is keyed id='singleton'"
    );
    assert_eq!(
        save::load(&store),
        Some(second),
        "the last durable save reads back"
    );
}

/// The whole Doom-save suite runs inside ONE owning scope so the single embedded
/// `PgRuntime` has a guaranteed teardown on every exit path (G-263).
#[tokio::test(flavor = "multi_thread")]
async fn doom_save_pg_suite() {
    if !pg_enabled() {
        eprintln!("doom_save_pg: skipping — set {GATE_ENV}=1 to run the gated PG suite");
        return;
    }

    let tmp = repo_tmp();
    std::fs::create_dir_all(&tmp).expect("create .opencode/tmp/3011");
    let data_dir = tmp.join("pgdata-doom-save");
    let app_dir = tmp.join("pgtest-app-doom-save");
    std::fs::create_dir_all(&data_dir).expect("create the FS-1 data dir");
    std::fs::create_dir_all(&app_dir).expect("create the runtime app dir");
    std::env::set_var(PG_DATA_DIR_ENV, &data_dir);

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

    let pool = build_pool(&url, &unique_schema("doom_save")).await;
    doom_save_round_trips_through_the_id_keyed_upsert(&pool, &url).await;
    pool.close().await;

    // ── G-263 teardown: finite bound + guaranteed hard-kill + no orphan ──────
    let started = Instant::now();
    let outcome = runtime.stop_bounded(STOP_BOUND).await;
    let elapsed = started.elapsed();
    eprintln!("doom_save_pg: stop_bounded -> {outcome:?} in {elapsed:?}");
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
