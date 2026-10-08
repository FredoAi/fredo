//! Headless `fredo ingest` daemon (Spec #2992, ST-5).
//!
//! A non-GUI process that OWNS the embedded PostgreSQL cluster and serves the
//! OTLP receivers, so agent telemetry keeps persisting while the desktop app is
//! closed. It reuses the existing paths end-to-end — the same shared data dir,
//! the same control-plane credential, the same `IngestClassifier` (canonical
//! `chat_rows`) and `SpanStore` (raw `telemetry_spans`) — with **no alternate
//! row-emission route** and no subscription gating.
//!
//! # Lifecycle (in order)
//!
//! 1. [`resolve_os_app_data_dir`] — a Tauri-free resolver returning the SAME dir
//!    the GUI uses on Windows (`%APPDATA%\com.fredo.app`); it honours
//!    `FREDO_DATA_DIR`.
//! 2. `PgDataDirLock::acquire_in(resolve_lock_dir(app_data_dir))` — a held lock is
//!    a clear fail-fast (exit 1), no cluster started.
//! 3. `AppStore::open` → `ensure_password` (the shared control-plane credential).
//! 4. **R-5b guard** (see [`migration_blocks`]): a legacy `fredo.db` with no
//!    completed one-shot migration ⇒ refuse + exit 1, deferring to a GUI boot.
//! 5. `PgRuntime` setup → knobs → start → `probe_ready`; the `HeadlessDescriptor`
//!    is published ONLY after readiness succeeds.
//! 6. `build_pg_pool` → `ensure_schema` on `RtdbStore`/`SpanStore` → `RtdbCache`/
//!    `Rtdb` with a **no-op `RowEmitter`** → `IngestClassifier` →
//!    [`otlp::start_with_ports`]; the ST-4 writer core drains the write-behind
//!    queue.
//! 7. Await shutdown: SIGINT, the `FREDO_INGEST_SHUTDOWN_FILE` appearing, or
//!    `FREDO_INGEST_RUN_MS` elapsing.
//! 8. Bounded teardown (G-263): drain the queue, close the pool,
//!    `PgRuntime::stop_bounded`, and clear the descriptor + PID marker + lock on
//!    EVERY exit path (normal/error/panic).
//!
//! # G-296 (seam semantics)
//!
//! Every option is resolved with the precedence **CLI flag > env > default** and
//! passed EXPLICITLY to the consumer; the daemon never calls
//! `std::env::set_var`, so a caller-supplied value is never overridden and the
//! default GUI boot is byte-identical (every seam is inert when unset).
//!
//! # Hard non-goals (R-5)
//!
//! No `run_startup_backfill`; no `rtdb.backfill.*` read/write; no `fredo.db`
//! migration (the daemon refuses instead, R-5b); no SQLite **data** store — the
//! only SQLite access is the shared control-plane `control.db` (credential + PID
//! marker), which the SAME-credential requirement mandates.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use crate::infrastructure::otlp::{self, ReceiverContext};
use crate::infrastructure::rtdb::cache::{run_writer_task_core, RtdbCache};
use crate::infrastructure::rtdb::commands::Rtdb;
use crate::infrastructure::rtdb::flush::{FlushLoop, RowEmitter};
use crate::infrastructure::rtdb::ingest::IngestClassifier;
use crate::infrastructure::rtdb::store::RtdbStore;
use crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry;
use crate::infrastructure::storage::engine::{build_pg_pool, EngineHandle, StoreEngine};
use crate::infrastructure::storage::boot_config::resolve_app_data_dir;
use crate::infrastructure::storage::migration::MIGRATION_COMPLETED_KEY;
use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::storage::AppStore;

use super::descriptor::{self, HeadlessDescriptor};
use super::lock::PgDataDirLock;
use super::runtime::PgRuntime;
use super::state::ensure_password;
use super::sweep::persist_pid;
use super::{PG_LOCK_FILENAME, PG_STOP_BOUND};

/// The frozen names-block CLI type. The clap struct lives in the CLI command
/// module (`infrastructure/cli/commands/ingest.rs`); this re-export makes it
/// reachable as `applications::pg_supervisor::headless::IngestDaemonArgs`.
pub use crate::infrastructure::cli::commands::ingest::IngestArgs as IngestDaemonArgs;

/// The Tauri app identifier (`tauri.conf.json`), i.e. the `%APPDATA%\<id>` leaf
/// the GUI's `app.path().app_data_dir()` resolves on Windows.
pub const APP_IDENTIFIER: &str = "com.fredo.app";

/// **G-275** bounded-run seam: when set to a positive millisecond count the
/// daemon self-terminates after that long. Unset ⇒ long-lived.
pub const RUN_MS_ENV: &str = "FREDO_INGEST_RUN_MS";
/// **G-275** shutdown-file seam: when this file exists the daemon shuts down
/// gracefully. Unset ⇒ the signal path only.
pub const SHUTDOWN_FILE_ENV: &str = "FREDO_INGEST_SHUTDOWN_FILE";
/// **G-275** stop-bound seam: overrides [`PG_STOP_BOUND`], clamped to
/// [`STOP_BOUND_MAX_MS`].
pub const STOP_BOUND_MS_ENV: &str = "FREDO_INGEST_STOP_BOUND_MS";
/// **G-275** OTLP gRPC port seam.
pub const GRPC_PORT_ENV: &str = "FREDO_INGEST_GRPC_PORT";
/// **G-275** OTLP HTTP port seam.
pub const HTTP_PORT_ENV: &str = "FREDO_INGEST_HTTP_PORT";

/// Default OTLP gRPC port (mirrors [`otlp::grpc::DEFAULT_GRPC_PORT`]).
pub const DEFAULT_GRPC_PORT: u16 = otlp::grpc::DEFAULT_GRPC_PORT;
/// Default OTLP HTTP port (mirrors [`otlp::http::DEFAULT_HTTP_PORT`]).
pub const DEFAULT_HTTP_PORT: u16 = otlp::http::DEFAULT_HTTP_PORT;
/// Hard ceiling on the shutdown stop bound (`FREDO_INGEST_STOP_BOUND_MS` is
/// clamped here, G-263 — never unbounded).
pub const STOP_BOUND_MAX_MS: u64 = 120_000;

/// Poll cadence for the shutdown-file / `--run-ms` checks (the signal path is
/// event-driven). Bounded.
const SHUTDOWN_POLL_MS: u64 = 200;
/// How long to let the ST-4 writer core flush the write-behind queue after the
/// receivers stop and before it is cancelled (two flush windows; the core drains
/// every ~30 ms). Bounded.
const DRAIN_WINDOW: Duration = Duration::from_millis(100);

/// Why the daemon began shutting down.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShutdownCause {
    /// SIGINT / Ctrl+C.
    Signal,
    /// The `FREDO_INGEST_SHUTDOWN_FILE` appeared.
    ShutdownFile,
    /// The `FREDO_INGEST_RUN_MS` / `--run-ms` bound elapsed.
    RunElapsed,
    /// An OTLP receiver stopped early (e.g. a busy port) — a fail-fast.
    ReceiverExited(String),
}

/// Clear the descriptor, the PID marker, and release the exclusive lock on EVERY
/// exit path (normal, error, and panic unwind) — R-2 / G-263.
struct DaemonCleanup {
    lock: Option<PgDataDirLock>,
    lock_dir: PathBuf,
    app_store: Arc<AppStore>,
}

impl DaemonCleanup {
    fn new(lock: PgDataDirLock, lock_dir: PathBuf, app_store: Arc<AppStore>) -> Self {
        Self {
            lock: Some(lock),
            lock_dir,
            app_store,
        }
    }
}

impl Drop for DaemonCleanup {
    fn drop(&mut self) {
        // Idempotent on a missing file.
        let _ = descriptor::clear(&self.lock_dir);
        persist_pid(&self.app_store, None);
        // Dropping the lock handle releases the exclusive data-dir lock.
        drop(self.lock.take());
    }
}

/// Run the headless ingest daemon. Returns `Ok(())` on a graceful shutdown (exit
/// 0) and `Err` on every fail-fast (exit 1; the caller maps it to the process
/// exit code).
pub async fn run_ingest_daemon(args: IngestDaemonArgs) -> Result<()> {
    // ── 1. Shared app-data dir: CLI flag > FREDO_DATA_DIR > OS default ────────
    let app_data_dir = match args.data_dir.clone() {
        Some(dir) => dir,
        None => resolve_os_app_data_dir()?,
    };
    tracing::info!(
        target: "fredo::ingest",
        data_dir = %app_data_dir.display(),
        "headless ingest daemon starting"
    );

    // ── 2. Exclusive data-dir lock, BEFORE any sweep or spawn (R-4.5) ─────────
    let lock_dir = match args.lock_dir.clone() {
        Some(dir) => dir,
        None => super::resolve_lock_dir(&app_data_dir),
    };
    let lock = match PgDataDirLock::acquire_in(&lock_dir) {
        Ok(lock) => lock,
        Err(error) => {
            let lock_path = lock_dir.join(PG_LOCK_FILENAME);
            eprintln!(
                "[ingest] cannot start: the PostgreSQL data dir is locked by another process ({})",
                lock_path.display()
            );
            eprintln!(
                "[ingest] another `fredo ingest` daemon or the Fredo desktop app already owns it"
            );
            eprintln!("[ingest] detail: {error:#}");
            return Err(error.context("acquire the exclusive PostgreSQL data-dir lock"));
        }
    };

    // ── 3. Control-plane credential (the SAME control.db the GUI uses) ────────
    let engine = EngineHandle::new_pending();
    let app_store = Arc::new(
        AppStore::open(engine.clone(), &app_data_dir)
            .context("open the control-plane store (control.db)")?,
    );
    let password = ensure_password(&app_store);

    // RAII teardown: descriptor + PID marker + lock on every exit path. Declared
    // BEFORE the runtime so the runtime's `Drop` (hard-kill) runs first on panic.
    let _cleanup = DaemonCleanup::new(lock, lock_dir.clone(), app_store.clone());

    // R-5b: whether a legacy data store needs the GUI's one-shot migration. The
    // marker lives only in PostgreSQL, so the decision is finalized after the
    // candidate pool exists (step 6) — see `migration_blocks`.
    let fredo_db_exists = app_data_dir.join("fredo.db").exists();

    // ── 5. Bounded cluster start (setup → knobs → start → readiness) ──────────
    let pg_data_dir = match args.pg_data_dir.clone() {
        Some(dir) => dir,
        None => super::resolve_data_dir(&app_data_dir),
    };
    let install_dir = super::resolve_install_dir(&app_data_dir);
    let mut runtime = PgRuntime::with_paths(&pg_data_dir, &install_dir, password);

    runtime
        .setup()
        .await
        .context("[ingest] embedded PostgreSQL setup")?;
    runtime
        .apply_server_knobs()
        .context("[ingest] apply the server-memory knobs")?;
    let postmaster_pid = runtime
        .start()
        .await
        .context("[ingest] embedded PostgreSQL start")?;
    persist_pid(&app_store, Some(postmaster_pid));
    runtime
        .probe_ready()
        .await
        .context("[ingest] embedded PostgreSQL readiness")?;
    let port = runtime.port();
    tracing::info!(
        target: "fredo::ingest",
        port,
        pid = std::process::id(),
        "embedded PostgreSQL ready"
    );

    // Publish the descriptor ONLY after readiness (R-1): the GUI attaches only to
    // a live pid + reachable port.
    let descriptor = HeadlessDescriptor {
        pid: std::process::id(),
        port,
        data_dir: runtime.data_dir().display().to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
        exe: std::env::current_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    };
    descriptor::write(&lock_dir, &descriptor).context("publish the headless descriptor")?;

    // ── 6. Candidate pool → R-5b guard → schema → row pipeline → receivers ────
    let url = runtime.connection_url();
    let pg = build_pg_pool(&url, None)
        .await
        .context("[ingest] build the PostgreSQL pool")?;

    // R-5b (SI adjudication): refuse when a legacy `fredo.db` exists and the
    // one-shot migration has not completed. The marker is readable only after the
    // candidate cluster is up; the guard runs BEFORE the engine is installed and
    // before any receiver starts, so the daemon never ingests ahead of the
    // migration. It defers to a GUI boot.
    let marker_present = migration_marker_present(&pg.pool).await?;
    if migration_blocks(fredo_db_exists, marker_present) {
        let message = format!(
            "legacy `fredo.db` exists at {} and the one-shot `{}` migration has not completed",
            app_data_dir.join("fredo.db").display(),
            MIGRATION_COMPLETED_KEY
        );
        eprintln!("[ingest] refusing to start: {message}");
        eprintln!(
            "[ingest] launch the Fredo desktop app once to complete the migration, then retry `fredo ingest`"
        );
        // Bounded teardown of the candidate cluster; the RAII cleanup clears the
        // descriptor, the PID marker, and the lock.
        pg.pool.close().await;
        let _ = runtime.stop_bounded(stop_bound()).await;
        return Err(anyhow!("[ingest] {message}"));
    }

    engine.install(StoreEngine::Postgres(Arc::new(pg)));

    let rtdb_store = Arc::new(RtdbStore::open(engine.clone()).context("RtdbStore::open")?);
    rtdb_store
        .ensure_schema()
        .await
        .context("[ingest] create the RTDB rows schema")?;
    let span_store = Arc::new(SpanStore::open(engine.clone()).context("SpanStore::open")?);
    span_store
        .ensure_schema()
        .await
        .context("[ingest] create the telemetry schema")?;

    let (cache, rx) = RtdbCache::new(rtdb_store);
    // No webview ⇒ no-op emitter (the spike's proven recipe). The ONLY write path
    // remains the classifier.
    let emitter: RowEmitter = Arc::new(|_deliveries, _marker| {});
    let rtdb = Arc::new(Rtdb::new(
        cache.clone(),
        Arc::new(SubscriptionRegistry::new()),
        Arc::new(FlushLoop::new(emitter)),
    ));
    let classifier = Arc::new(IngestClassifier::new(rtdb));

    // ST-4 AppHandle-free writer core drains the write-behind queue. `rtdb: None`
    // — there are no subscribers to route retention evictions to.
    let writer = tokio::spawn(run_writer_task_core(cache, app_store.clone(), None, rx, None));
    let ctx = Arc::new(ReceiverContext {
        classifier,
        span_store,
    });
    let grpc_port = effective_port(args.grpc_port, GRPC_PORT_ENV, DEFAULT_GRPC_PORT);
    let http_port = effective_port(args.http_port, HTTP_PORT_ENV, DEFAULT_HTTP_PORT);
    let mut otlp = tokio::spawn(otlp::start_with_ports(ctx, grpc_port, http_port));
    tracing::info!(
        target: "fredo::ingest",
        grpc_port,
        http_port,
        "OTLP receivers starting"
    );

    // ── 7. Await shutdown: signal / shutdown file / run-ms ────────────────────
    let run_ms = effective_run_ms(args.run_ms, RUN_MS_ENV);
    let shutdown_file = effective_shutdown_file(args.shutdown_file.clone(), SHUTDOWN_FILE_ENV);
    let cause = await_shutdown(&mut otlp, run_ms, shutdown_file).await;
    tracing::info!(target: "fredo::ingest", ?cause, "shutdown requested");

    // ── 8. Bounded teardown (G-263) ───────────────────────────────────────────
    otlp.abort();
    let _ = otlp.await;
    // Let the writer core drain + flush what is queued (it flushes every ~30 ms).
    tokio::time::sleep(DRAIN_WINDOW).await;
    writer.abort();
    let _ = writer.await;
    if let Ok(pg) = engine.pg() {
        pg.pool.close().await;
    }
    let outcome = runtime.stop_bounded(stop_bound()).await;
    tracing::info!(
        target: "fredo::ingest",
        ?outcome,
        "embedded PostgreSQL stopped; releasing the lock"
    );

    match cause {
        ShutdownCause::ReceiverExited(detail) => Err(anyhow!(
            "[ingest] the OTLP receivers stopped unexpectedly: {detail}"
        )),
        _ => Ok(()),
    }
}

/// R-5b decision rule (pure): a legacy data store blocks the daemon ONLY when the
/// one-shot migration marker is absent.
pub fn migration_blocks(fredo_db_exists: bool, marker_present: bool) -> bool {
    fredo_db_exists && !marker_present
}

/// Read `migration.postgres.completed` from the candidate pool's `settings`
/// table. The marker is written ONLY by the GUI's one-shot leg
/// (`storage::migration::run_pre_install`), so its absence means the migration
/// has not completed.
async fn migration_marker_present(pool: &sqlx::PgPool) -> Result<bool> {
    let marker: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(MIGRATION_COMPLETED_KEY)
        .fetch_optional(pool)
        .await
        .context("[ingest] read the one-shot migration marker")?;
    Ok(marker.is_some())
}

/// Resolve the OS app-data dir the GUI uses, Tauri-free, then apply the shared
/// `FREDO_DATA_DIR` override (G-275/G-296). On Windows this is
/// `%APPDATA%\com.fredo.app` — the SAME leaf `app.path().app_data_dir()` returns.
pub fn resolve_os_app_data_dir() -> Result<PathBuf> {
    let os_dir = os_app_data_dir()?;
    Ok(resolve_app_data_dir(&os_dir))
}

#[cfg(target_os = "windows")]
fn os_app_data_dir() -> Result<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .context("APPDATA is not set; cannot resolve the OS app-data dir")?;
    Ok(PathBuf::from(base).join(APP_IDENTIFIER))
}

#[cfg(target_os = "macos")]
fn os_app_data_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home)
        .join("Library/Application Support")
        .join(APP_IDENTIFIER))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn os_app_data_dir() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .context("neither XDG_DATA_HOME nor HOME is set")?;
    Ok(base.join(APP_IDENTIFIER))
}

/// Effective OTLP port: CLI flag > `env_key` > `default`. A blank/unparseable/zero
/// env value falls back to the default (G-296); a caller-supplied flag always
/// wins.
pub fn effective_port(flag: Option<u16>, env_key: &str, default: u16) -> u16 {
    effective_port_with(flag, std::env::var(env_key).ok().as_deref(), default)
}

/// The pure port rule (unit-testable without process-global env, G-222).
fn effective_port_with(flag: Option<u16>, env_value: Option<&str>, default: u16) -> u16 {
    if let Some(port) = flag {
        return port;
    }
    match env_value.map(str::trim) {
        Some(raw) if !raw.is_empty() => raw
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .unwrap_or(default),
        _ => default,
    }
}

/// Effective bounded-run duration: CLI flag > `RUN_MS_ENV` > unset (long-lived).
pub fn effective_run_ms(flag: Option<u64>, env_key: &str) -> Option<u64> {
    effective_run_ms_with(flag, std::env::var(env_key).ok().as_deref())
}

/// The pure run-ms rule (unit-testable without process-global env, G-222).
fn effective_run_ms_with(flag: Option<u64>, env_value: Option<&str>) -> Option<u64> {
    if flag.is_some() {
        return flag;
    }
    env_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
}

/// Effective shutdown-file path: CLI flag > `SHUTDOWN_FILE_ENV` > unset.
pub fn effective_shutdown_file(flag: Option<PathBuf>, env_key: &str) -> Option<PathBuf> {
    effective_shutdown_file_with(flag, std::env::var(env_key).ok().as_deref())
}

/// The pure shutdown-file rule (unit-testable without process-global env, G-222).
fn effective_shutdown_file_with(flag: Option<PathBuf>, env_value: Option<&str>) -> Option<PathBuf> {
    if flag.is_some() {
        return flag;
    }
    env_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The bounded shutdown stop bound: `FREDO_INGEST_STOP_BOUND_MS` clamped to
/// [`STOP_BOUND_MAX_MS`], else [`PG_STOP_BOUND`]. A blank/unparseable/zero value
/// falls back to the default.
pub fn stop_bound() -> Duration {
    stop_bound_with(std::env::var(STOP_BOUND_MS_ENV).ok().as_deref())
}

/// The pure stop-bound rule (unit-testable without process-global env, G-222).
fn stop_bound_with(env_value: Option<&str>) -> Duration {
    match env_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(ms) if ms > 0 => Duration::from_millis(ms.min(STOP_BOUND_MAX_MS)),
        _ => PG_STOP_BOUND,
    }
}

/// Await shutdown: SIGINT, the shutdown file, or the `--run-ms` bound. Also
/// returns early (a fail-fast) if the OTLP receivers stop on their own — e.g. a
/// busy port. Every wait is finite (G-263).
async fn await_shutdown(
    otlp: &mut tokio::task::JoinHandle<anyhow::Result<()>>,
    run_ms: Option<u64>,
    shutdown_file: Option<PathBuf>,
) -> ShutdownCause {
    // The signal waiter is spawned once; if `ctrl_c` is unavailable the receiver
    // closes and the file/run-ms levers remain.
    let (signal_tx, mut signal_rx) = tokio::sync::mpsc::channel::<()>(1);
    tokio::spawn(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                let _ = signal_tx.send(()).await;
            }
            Err(error) => tracing::warn!(
                target: "fredo::ingest",
                %error,
                "Ctrl+C is unavailable; use the shutdown file or --run-ms"
            ),
        }
    });

    let deadline = run_ms.map(|ms| tokio::time::Instant::now() + Duration::from_millis(ms));
    let mut signal_closed = false;
    loop {
        if let Some(path) = &shutdown_file {
            if path.exists() {
                return ShutdownCause::ShutdownFile;
            }
        }
        let poll = match deadline {
            Some(deadline) => {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return ShutdownCause::RunElapsed;
                }
                deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_millis(SHUTDOWN_POLL_MS))
                    .max(Duration::from_millis(1))
            }
            None => Duration::from_millis(SHUTDOWN_POLL_MS),
        };
        tokio::select! {
            result = &mut *otlp => {
                let detail = match result {
                    Ok(Ok(())) => "the OTLP receivers stopped".to_string(),
                    Ok(Err(error)) => format!("{error:#}"),
                    Err(error) => format!("receiver task failed: {error}"),
                };
                return ShutdownCause::ReceiverExited(detail);
            }
            message = signal_rx.recv(), if !signal_closed => {
                if message.is_some() {
                    return ShutdownCause::Signal;
                }
                // The signal waiter ended without a signal (ctrl_c unavailable):
                // stop polling the closed receiver.
                signal_closed = true;
            }
            _ = tokio::time::sleep(poll) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    use std::path::Path;

    #[test]
    fn migration_blocks_only_when_a_legacy_db_exists_and_the_marker_is_absent() {
        assert!(migration_blocks(true, false), "un-migrated fredo.db blocks");
        assert!(!migration_blocks(true, true), "a completed migration unblocks");
        assert!(!migration_blocks(false, false), "a fresh install never blocks");
        assert!(!migration_blocks(false, true));
    }

    #[test]
    fn effective_port_prefers_the_flag_then_env_then_default() {
        assert_eq!(effective_port_with(Some(9000), Some("8000"), 4317), 9000);
        assert_eq!(effective_port_with(None, Some("8000"), 4317), 8000);
        assert_eq!(effective_port_with(None, Some(" 8000 "), 4317), 8000);
        assert_eq!(effective_port_with(None, None, 4317), 4317, "unset => default");
        assert_eq!(effective_port_with(None, Some(""), 4317), 4317, "blank => default");
        assert_eq!(effective_port_with(None, Some("   "), 4317), 4317, "blank => default");
        assert_eq!(
            effective_port_with(None, Some("not-a-port"), 4317),
            4317,
            "unparseable => default"
        );
        assert_eq!(
            effective_port_with(None, Some("0"), 4317),
            4317,
            "zero env is not a valid receiver port => default"
        );
    }

    #[test]
    fn effective_run_ms_prefers_the_flag_then_a_positive_env() {
        assert_eq!(effective_run_ms_with(Some(100), Some("200")), Some(100));
        assert_eq!(effective_run_ms_with(None, Some("200")), Some(200));
        assert_eq!(effective_run_ms_with(None, Some(" 200 ")), Some(200));
        assert_eq!(effective_run_ms_with(None, None), None, "unset => long-lived");
        assert_eq!(effective_run_ms_with(None, Some("")), None, "blank => long-lived");
        assert_eq!(
            effective_run_ms_with(None, Some("nope")),
            None,
            "unparseable => long-lived"
        );
        assert_eq!(
            effective_run_ms_with(Some(0), None),
            Some(0),
            "an explicit 0 is a bounded self-terminate"
        );
    }

    #[test]
    fn effective_shutdown_file_prefers_the_flag_then_a_non_blank_env() {
        assert_eq!(
            effective_shutdown_file_with(Some(PathBuf::from("C:/flag")), Some("C:/env")),
            Some(PathBuf::from("C:/flag"))
        );
        assert_eq!(
            effective_shutdown_file_with(None, Some("C:/env")),
            Some(PathBuf::from("C:/env"))
        );
        assert_eq!(effective_shutdown_file_with(None, None), None);
        assert_eq!(effective_shutdown_file_with(None, Some("   ")), None);
    }

    #[test]
    fn stop_bound_defaults_and_clamps() {
        assert_eq!(stop_bound_with(None), PG_STOP_BOUND);
        assert_eq!(stop_bound_with(Some("")), PG_STOP_BOUND);
        assert_eq!(stop_bound_with(Some("nope")), PG_STOP_BOUND);
        assert_eq!(stop_bound_with(Some("0")), PG_STOP_BOUND, "zero => default");
        assert_eq!(stop_bound_with(Some("5000")), Duration::from_millis(5000));
        assert_eq!(
            stop_bound_with(Some("999999999")),
            Duration::from_millis(STOP_BOUND_MAX_MS),
            "the stop bound is clamped to the hard ceiling"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn os_app_data_dir_uses_the_tauri_identifier_leaf() {
        let os = os_app_data_dir().expect("APPDATA is set on Windows");
        assert!(
            os.ends_with(APP_IDENTIFIER),
            "{} must end with {}",
            os.display(),
            APP_IDENTIFIER
        );
        assert_eq!(
            os.parent().map(Path::to_path_buf),
            std::env::var_os("APPDATA").map(PathBuf::from),
            "the parent is the roaming AppData root"
        );
    }
    #[test]
    fn stop_bound_max_is_the_documented_ceiling() {
        assert_eq!(STOP_BOUND_MAX_MS, 120_000);
    }
}
