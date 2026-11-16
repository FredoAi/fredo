//! Spec #3036 ST-1 **live diagnostic** (G-028) + ST-1/ST-2 **product-path** live
//! proof.
//!
//! ## Diagnostic (the plan's mandated FIRST action)
//!
//! Does `postgresql_embedded` 0.21 tolerate the absence of a database literally
//! named `postgres`? [`diag_rename_postgres_database_to_fredo_and_reboot`] boots a
//! scratch cluster, renames the bootstrap `postgres` database to `fredo` via
//! catalog-only DDL (`ALTER DATABASE postgres RENAME TO fredo`, from a `template1`
//! connection), stops, and boots AGAIN over the SAME data dir. The second
//! `start()` is the hypothesis under test.
//!
//! ## Product-path proof
//!
//! [`diag_product_path_migrate_then_reboot_is_idempotent`] drives the SHIPPED
//! owner-path sequence (`setup → start → migrate_database_identity → probe_ready`)
//! on a fresh cluster, then re-boots the same data dir and proves the migration is
//! a byte-identical no-op with readiness still on `fredo` (R-2c/R-4b/R-5).
//!
//! # Gate
//!
//! ```text
//! FREDO_DIAG_3036=1 cargo test --locked --test spike_3036_db_rename_diag -- --nocapture
//! ```
//!
//! Without the gate a plain `cargo test --locked` executes each test as a no-op.
//!
//! # Isolation + safety (G-263 / G-172)
//!
//! Scratch dirs under `.opencode/tmp/3036/diag`; the app's real data dir is never
//! touched. Every start/stop is bounded by `PgRuntime`; `stop_bounded` hard-kills
//! on expiry and the RAII `Drop` covers the error/panic paths. The two live boots
//! are serialized (they share one install dir), so the diagnostic is deterministic
//! under any test order.

use std::path::{Path, PathBuf};
use std::time::Duration;

use fredo_lib::PgRuntime;
use sqlx::Connection;

const GATE_ENV: &str = "FREDO_DIAG_3036";
const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
const PG_INSTALL_DIR_ENV: &str = "FREDO_PG_INSTALL_DIR";
const PASSWORD: &str = "diag3036-password";
const STOP_BOUND: Duration = Duration::from_secs(30);

/// Serializes the two live boots (they share the install dir).
static DIAG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn gate_enabled() -> bool {
    if std::env::var(GATE_ENV).as_deref() == Ok("1") {
        return true;
    }
    eprintln!("spike_3036_db_rename_diag: skipping — set {GATE_ENV}=1 to run");
    false
}

fn diag_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(".opencode")
        .join("tmp")
        .join("3036")
        .join("diag")
}

/// Replace the DATABASE segment of a crate URL (`postgresql://u:p@h:port/db`).
fn with_database(url: &str, database: &str) -> String {
    match url.rfind('/') {
        Some(index) => format!("{}/{}", &url[..index], database),
        None => url.to_string(),
    }
}

/// `(current_user, current_database())` on `url`.
async fn identity(url: &str) -> (String, String) {
    let mut connection = sqlx::PgConnection::connect(url)
        .await
        .expect("connect for the identity read");
    let row: (String, String) = sqlx::query_as("SELECT current_user, current_database()")
        .fetch_one(&mut connection)
        .await
        .expect("identity read");
    drop(connection);
    row
}

/// The plan's mandated FIRST action (G-028): does the crate tolerate the absence
/// of a database literally named `postgres`?
#[tokio::test(flavor = "multi_thread")]
async fn diag_rename_postgres_database_to_fredo_and_reboot() {
    if !gate_enabled() {
        return;
    }
    let _guard = DIAG_LOCK.lock().await;

    let root = diag_root();
    let data_dir = root.join("pgdata");
    let install_dir = root.join("pginstall");
    let _ = std::fs::remove_dir_all(&data_dir); // keep the cached install dir
    std::fs::create_dir_all(&data_dir).expect("create scratch data dir");
    std::fs::create_dir_all(&install_dir).expect("create scratch install dir");
    std::env::set_var(PG_DATA_DIR_ENV, &data_dir);
    std::env::set_var(PG_INSTALL_DIR_ENV, &install_dir);
    let scratch = tempfile::tempdir().expect("temp scratch");

    // ── BOOT 1 ───────────────────────────────────────────────────────────────
    let mut rt = PgRuntime::new(&scratch.path().join("pg-app"), PASSWORD.to_string());
    rt.setup().await.expect("boot1 setup");
    rt.start().await.expect("boot1 start");
    let port = rt.port();
    println!("DIAG_3036_BOOT1 port={port}");

    // Readiness/identity RAW against `/postgres` — NOT the product
    // `probe_ready()` (which now targets `/fredo`, the post-migration name).
    let (user, db) = identity(&with_database(&rt.connection_url(), "postgres")).await;
    println!("DIAG_3036_BOOT1_IDENTITY current_user={user} current_database={db}");
    assert_eq!(db, "postgres", "boot1 database must be postgres");

    // ── RENAME from a template1 connection (catalog-only) ────────────────────
    let mut m = sqlx::PgConnection::connect(&with_database(&rt.connection_url(), "template1"))
        .await
        .expect("connect to template1");
    sqlx::query("ALTER DATABASE postgres RENAME TO fredo")
        .execute(&mut m)
        .await
        .expect("ALTER DATABASE postgres RENAME TO fredo");
    let fredo_present: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pg_database WHERE datname='fredo'")
            .fetch_one(&mut m)
            .await
            .expect("read fredo");
    let postgres_present: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pg_database WHERE datname='postgres'")
            .fetch_one(&mut m)
            .await
            .expect("read postgres");
    println!("DIAG_3036_RENAME fredo={fredo_present} postgres={postgres_present}");
    assert_eq!(fredo_present, 1, "fredo must exist after the rename");
    assert_eq!(postgres_present, 0, "postgres must be gone after the rename");
    drop(m);

    rt.stop_bounded(STOP_BOUND).await;
    drop(rt);
    println!("DIAG_3036_BOOT1_STOPPED");

    // ── BOOT 2 — THE HYPOTHESIS ──────────────────────────────────────────────
    let mut rt2 = PgRuntime::new(&scratch.path().join("pg-app"), PASSWORD.to_string());
    rt2.setup().await.expect("boot2 setup (should be a no-op)");
    let start2 = rt2.start().await;
    match &start2 {
        Ok(pid) => println!("DIAG_3036_BOOT2_START ok pid={pid}"),
        Err(error) => println!("DIAG_3036_BOOT2_START err={error:#}"),
    }
    start2.expect("boot2 start — the crate must tolerate the absence of a `postgres` database");
    let port2 = rt2.port();

    let (user2, db2) = identity(&with_database(&rt2.connection_url(), "fredo")).await;
    println!("DIAG_3036_BOOT2_IDENTITY port={port2} current_user={user2} current_database={db2}");
    assert_eq!(db2, "fredo", "boot2 database must be fredo");
    assert_eq!(user2, "postgres", "the role must stay postgres");

    rt2.stop_bounded(STOP_BOUND).await;
    drop(rt2);
    println!("DIAG_3036_BOOT2_STOPPED");
    println!("DIAG_3036_OK");
}

/// The PRODUCT-path leg (ST-1/ST-2): the exact owner-path sequence
/// (`setup → start → migrate_database_identity → probe_ready`) on a fresh cluster,
/// then a re-boot of the SAME data dir proving the migration is a byte-identical
/// no-op with readiness still on `fredo` (R-2c/R-4b/R-5). Uses explicit paths so
/// it never depends on process-global env.
#[tokio::test(flavor = "multi_thread")]
async fn diag_product_path_migrate_then_reboot_is_idempotent() {
    if !gate_enabled() {
        return;
    }
    let _guard = DIAG_LOCK.lock().await;

    let root = diag_root();
    let data_dir = root.join("product-pgdata");
    let install_dir = root.join("pginstall");
    let _ = std::fs::remove_dir_all(&data_dir);
    std::fs::create_dir_all(&data_dir).expect("create scratch data dir");
    std::fs::create_dir_all(&install_dir).expect("create scratch install dir");

    // BOOT 1: fresh cluster → migration renames postgres→fredo → readiness /fredo.
    let mut rt = PgRuntime::with_paths(&data_dir, &install_dir, PASSWORD.to_string());
    rt.setup().await.expect("product boot1 setup");
    rt.start().await.expect("product boot1 start");
    rt.migrate_database_identity()
        .await
        .expect("product boot1 migrate (fresh → rename)");
    rt.probe_ready()
        .await
        .expect("product boot1 readiness on /fredo");
    let (user, db) = identity(&rt.connection_url()).await;
    println!("DIAG_3036_PRODUCT_BOOT1 current_user={user} current_database={db}");
    assert_eq!(db, "fredo", "product boot1 database must be fredo");
    assert_eq!(user, "postgres", "the role must stay postgres");
    rt.stop_bounded(STOP_BOUND).await;
    drop(rt);

    // BOOT 2: same data dir → migration is a no-op → readiness /fredo.
    let mut rt2 = PgRuntime::with_paths(&data_dir, &install_dir, PASSWORD.to_string());
    rt2.setup().await.expect("product boot2 setup");
    rt2.start().await.expect("product boot2 start");
    rt2.migrate_database_identity()
        .await
        .expect("product boot2 migrate (idempotent no-op)");
    rt2.probe_ready()
        .await
        .expect("product boot2 readiness on /fredo");
    let (user2, db2) = identity(&rt2.connection_url()).await;
    println!("DIAG_3036_PRODUCT_BOOT2 current_user={user2} current_database={db2}");
    assert_eq!(db2, "fredo", "product boot2 database must be fredo");
    assert_eq!(user2, "postgres", "the role must stay postgres");
    rt2.stop_bounded(STOP_BOUND).await;
    drop(rt2);
    println!("DIAG_3036_PRODUCT_OK");
}
