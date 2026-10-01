//! Tauri-managed embedded-PostgreSQL supervisor state + lifecycle wiring
//! (Spec #2974, ST-3).
//!
//! This is the composition seam between `lib.rs` and the bounded runtime
//! ([`super::runtime`]) / startup-safety primitives ([`super::sweep`],
//! [`super::lock`]). It owns:
//!
//! * the disable-by-default decision (`postgres.enabled` absent ⇒ nothing is
//!   locked, swept, or spawned — SQLite persistence is untouched, R-1.4);
//! * the exclusive data-dir lock acquired BEFORE the orphan sweep (R-4.5);
//! * the LAZY background start — `lib.rs` setup NEVER awaits `setup()/start()/
//!   probe_ready()` (G-273/R-2.3), so the webview shell renders while the
//!   postmaster boots;
//! * the bounded readiness failure transition (`PgState::Failed` + a structured
//!   error + bounded teardown + marker clear, R-1.3);
//! * the wall-clock-capped `RunEvent::Exit` teardown (R-2.1);
//! * the single read-only observability hook (`pg_supervisor_status`).
//!
//! # G-263 SAFETY (named failure mode: #2948's ~11 h `pg.stop()`)
//!
//! No wait here is unbounded: the start task is driven entirely through
//! [`super::runtime`]'s bounded control, the failure path stops under
//! [`PG_STOP_BOUND`] then confirms the postmaster is gone under
//! [`PG_DEATH_WAIT_BOUND`], and [`stop_on_exit`] caps the graceful attempt at
//! [`PG_EXIT_HOOK_BOUND`] (with the runtime's synchronous watchdog hard-kill
//! fallback) so quit can never block on a hung server.
//!
//! A std [`Mutex`] in [`PgSupervisorState`] guards only the optional runtime /
//! lock handle. It is NEVER held across an `.await`: the async start task takes
//! the runtime out of the mutex for its bounded work and puts it back on success.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::engine::{
    build_pg_pool, EngineChoice, PgPoolStage, StorageEngineState,
};
use crate::infrastructure::storage::migration::{
    resolve_app_data_dir, resolve_migration_dir, run_pre_install, MigrationOutcome, MigrationStatus,
};
use crate::infrastructure::storage::AppStore;

use super::lock::PgDataDirLock;
use super::runtime::{wait_until, PgRuntime, StopOutcome};
use super::sweep::{persist_pid, sweep_orphan, sweep_postmaster_pid_file};
use super::{
    DEFAULT_PG_HOST, PG_DEATH_WAIT_BOUND, PG_ENABLED_KEY, PG_EXIT_HOOK_BOUND, PG_PASSWORD_KEY,
    PG_STOP_BOUND,
};

/// Lifecycle state exposed by [`pg_supervisor_status`] / the readiness gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgState {
    /// `postgres.enabled` is not `"true"` (the default) — no lock, no sweep, no spawn.
    Disabled,
    /// The managed postmaster is booting on a background task.
    Starting,
    /// The real-client readiness probe succeeded; `port`/`pid` are populated.
    Ready,
    /// The boot failed closed (structured `error`) and was torn down.
    Failed,
}

/// Read-only snapshot of the supervisor (`#[serde(rename_all = "camelCase")]`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgStatusView {
    /// Current lifecycle state.
    pub state: PgState,
    /// The bound ephemeral loopback port, once `Ready`.
    pub port: Option<u16>,
    /// The managed postmaster PID, once `Ready`.
    pub pid: Option<u32>,
    /// Structured failure detail, once `Failed`.
    pub error: Option<String>,
    /// The PostgreSQL data directory (`<app_data_dir>/postgres`, or the FS-1
    /// `FREDO_PG_DATA_DIR` override when set).
    pub data_dir: String,
}

impl PgStatusView {
    /// A `Failed` view carrying a structured error (never a port/pid).
    pub fn failed(error: String, data_dir: String) -> Self {
        Self {
            state: PgState::Failed,
            port: None,
            pid: None,
            error: Some(error),
            data_dir,
        }
    }
}

/// Structured failure text: a stable `[<stage>]` tag then the full anyhow chain.
pub fn structured_error(stage: &str, error: &anyhow::Error) -> String {
    format!("[{stage}] {error:#}")
}

/// Tauri-managed state for the ONE embedded PostgreSQL supervisor.
///
/// The `Mutex`es guard short critical sections only and are NEVER held across an
/// `.await`; the `watch` channel fans the status out to the status command and
/// [`await_ready`].
pub struct PgSupervisorState {
    /// The live runtime once `Ready` (taken by the exit hook / dropped on failure).
    pub runtime: Mutex<Option<PgRuntime>>,
    /// The published status; the readiness gate subscribes to it.
    pub status: tokio::sync::watch::Sender<PgStatusView>,
    /// The exclusive data-dir lock, held for the app lifetime (R-4.5).
    pub lock: Mutex<Option<PgDataDirLock>>,
}

impl PgSupervisorState {
    /// Build a `Starting` supervisor holding the acquired lock (runtime added on success).
    pub fn new(runtime: Option<PgRuntime>, lock: Option<PgDataDirLock>, data_dir: String) -> Self {
        let (status, _rx) = tokio::sync::watch::channel(PgStatusView {
            state: PgState::Starting,
            port: None,
            pid: None,
            error: None,
            data_dir,
        });
        Self {
            runtime: Mutex::new(runtime),
            status,
            lock: Mutex::new(lock),
        }
    }

    /// Build a `Failed` supervisor without starting anything (e.g. the data-dir
    /// lock is owned by another instance — the second instance reports `Failed`).
    pub fn failed_only(error: String, data_dir: String) -> Self {
        let (status, _rx) = tokio::sync::watch::channel(PgStatusView::failed(error, data_dir));
        Self {
            runtime: Mutex::new(None),
            status,
            lock: Mutex::new(None),
        }
    }

    /// Publish `Ready` with the resolved port/PID.
    pub fn set_ready(&self, port: u16, pid: u32) {
        let data_dir = self.status.borrow().data_dir.clone();
        self.status.send_replace(PgStatusView {
            state: PgState::Ready,
            port: Some(port),
            pid: Some(pid),
            error: None,
            data_dir,
        });
    }

    /// Transition to `Failed` with a structured error (R-1.3).
    pub fn fail(&self, stage: &str, error: &anyhow::Error) {
        let data_dir = self.status.borrow().data_dir.clone();
        self.status
            .send_replace(PgStatusView::failed(structured_error(stage, error), data_dir));
    }
}

/// The synchronous startup decision: what the bootstrap did (and, when enabled,
/// the held lock + resolved data dir to hand to the managed state).
enum Bootstrap {
    /// `postgres.enabled` is not `"true"` — nothing locked, swept, or spawned.
    Disabled,
    /// Enabled, but the exclusive data-dir lock is held elsewhere ⇒ `Failed`.
    Failed(String),
    /// Enabled and locked: the lock is held BEFORE the sweep (R-4.5).
    Locked(PgDataDirLock, String),
}

/// The slice-1 KV enable flag: ONLY the literal `"true"` enables the engine;
/// absent, blank, or any other value leaves persistence unchanged (R-1.4). Used
/// as the fallback when no shared engine state is managed (unit tests / a
/// pre-ST-2 caller); in production the resolved engine choice supersedes it.
fn pg_enabled(store: &AppStore) -> bool {
    matches!(
        store.control_get(PG_ENABLED_KEY).ok().flatten().as_deref(),
        Some("true")
    )
}

/// The **FS-4** fault seam resolved to a named pool-build stage: the non-blank
/// value of [`super::PG_POOL_FORCE_FAIL_ENV`] parsed by
/// [`PgPoolStage::parse`]. Inert when unset (the default build is unchanged).
pub fn pool_force_fail_stage() -> Option<PgPoolStage> {
    let raw = std::env::var(super::PG_POOL_FORCE_FAIL_ENV).ok()?;
    PgPoolStage::parse(&raw)
}

/// Synchronous, bounded bootstrap: decide → lock → sweep. NEVER starts the server.
///
/// `enabled` is the already-resolved boot decision (the shared engine choice, or
/// the slice-1 KV rule when no state is managed). The lock stays at
/// `<app_data_dir>/<PG_LOCK_FILENAME>`; only the **data dir** honours the FS-1
/// [`super::PG_DATA_DIR_ENV`] override (`super::resolve_data_dir`).
fn bootstrap(app_data_dir: &Path, store: &AppStore, enabled: bool) -> Bootstrap {
    if !enabled {
        return Bootstrap::Disabled;
    }
    // FS-1: one shared rule also used by `PgRuntime` and the status view.
    let data_dir = super::resolve_data_dir(app_data_dir);
    // R-4.5: the exclusive data-dir lock is acquired BEFORE any sweep, so a
    // second instance can never kill this instance's live postmaster.
    match PgDataDirLock::acquire(app_data_dir) {
        Ok(lock) => {
            // Reclaim a prior-run orphan only under the `postgres.exe` image guard,
            // then the data-dir `postmaster.pid` backstop (R-3.1/R-3.4).
            sweep_orphan(store);
            sweep_postmaster_pid_file(&data_dir);
            Bootstrap::Locked(lock, data_dir.display().to_string())
        }
        Err(error) => Bootstrap::Failed(structured_error("lock", &error)),
    }
}

/// The password for the loopback-only cluster, generated once and reused.
fn ensure_password(store: &AppStore) -> String {
    if let Ok(Some(password)) = store.control_get(PG_PASSWORD_KEY) {
        if !password.is_empty() {
            return password;
        }
    }
    let password = uuid::Uuid::new_v4().simple().to_string();
    let _ = store.control_set(PG_PASSWORD_KEY, &password);
    password
}

/// Startup entry (SYNCHRONOUS, never awaits): read the flag; when enabled,
/// acquire the lock BEFORE the sweep and spawn the LAZY background start (G-273).
///
/// If the flag is not `"true"` this returns immediately having created no lock,
/// run no sweep, and spawned no task (R-1.4).
pub fn start_supervisor(app: &AppHandle) {
    let store = match app.try_state::<Arc<AppStore>>() {
        Some(store) => store.inner().clone(),
        None => return,
    };
    let os_app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            tracing::error!(
                target: "fredo::pg_supervisor",
                error = %error,
                "cannot resolve the app data dir; embedded PostgreSQL supervisor not started"
            );
            return;
        }
    };
    // Spec #2977 ST-6 (G-275): the SAME app-data-dir resolver `lib.rs` injects, so
    // the migration source `<dir>/fredo.db` and `restore_snapshot`'s target can
    // never diverge. The managed-PG data dir, install dir, and lock deliberately
    // stay on the OS dir (see `bootstrap` below).
    let data_dir = resolve_app_data_dir(&os_app_data_dir);

    // Spec #2975 ST-2: the resolved engine choice drives the boot decision. The
    // env lever `FREDO_STORAGE_ENGINE` (resolved by `select_engine` at setup and
    // carried on the managed engine state) OVERRIDES the control-plane
    // `postgres.enabled`; with no override the slice-1 KV rule applies
    // (absent ⇒ disabled, so persistence is unchanged — R-1.4).
    let enabled = match app.try_state::<Arc<StorageEngineState>>() {
        Some(state) => state.choice() == EngineChoice::Postgres,
        None => pg_enabled(&store),
    };

    match bootstrap(&os_app_data_dir, &store, enabled) {
        Bootstrap::Disabled => {
            tracing::info!(
                target: "fredo::pg_supervisor",
                "embedded PostgreSQL disabled (not selected); persistence unchanged"
            );
        }
        Bootstrap::Failed(error) => {
            // The data dir is owned elsewhere: record the fail-closed reason,
            // report Failed, and start nothing.
            if let Some(state) = app.try_state::<Arc<StorageEngineState>>() {
                if state.choice() == EngineChoice::Postgres {
                    state.set_fallback_reason(error.clone());
                }
            }
            tracing::error!(
                target: "fredo::pg_supervisor",
                error = %error,
                "embedded PostgreSQL data dir is not available; supervisor reports Failed"
            );
            app.manage(Arc::new(PgSupervisorState::failed_only(
                error,
                super::resolve_data_dir(&os_app_data_dir)
                    .display()
                    .to_string(),
            )));
        }
        Bootstrap::Locked(lock, pg_data_dir) => {
            tracing::info!(
                target: "fredo::pg_supervisor",
                lock = %lock.path().display(),
                data_dir = %pg_data_dir,
                "embedded PostgreSQL enabled; holding the exclusive data-dir lock"
            );
            app.manage(Arc::new(PgSupervisorState::new(None, Some(lock), pg_data_dir)));
            let handle = app.clone();
            let os_app_data_dir = os_app_data_dir.clone();
            // G-273 / R-2.3: setup NEVER awaits the boot — the whole
            // setup/start/readiness leg runs on a background task so the webview
            // shell renders while the postmaster boots. Only `await_ready`-gated
            // store reads (later slices) block.
            tauri::async_runtime::spawn(async move {
                run_start(handle, os_app_data_dir, data_dir).await;
            });
        }
    }
}

/// The background start: bounded setup → start → marker → readiness. On any
/// bounded failure, tear down under a bounded stop, clear the marker, and publish
/// `Failed` (R-1.3). Never awaited from `setup`.
///
/// `os_app_data_dir` roots the managed-PG data/install dirs + lock; `data_dir`
/// is the resolved app-data dir (G-275) that holds the migration source
/// `fredo.db` and the default migration scratch dir.
async fn run_start(app: AppHandle, os_app_data_dir: PathBuf, data_dir: PathBuf) {
    let state = match app.try_state::<Arc<PgSupervisorState>>() {
        Some(state) => state,
        None => return,
    };
    let store = match app.try_state::<Arc<AppStore>>() {
        Some(store) => store.inner().clone(),
        None => return,
    };
    // Spec #2975 ST-2: the shared engine state the pool installs into. Optional
    // so the supervisor still runs on the slice-1 path when no seam is managed.
    let engine = app
        .try_state::<Arc<StorageEngineState>>()
        .map(|state| state.inner().clone());

    let password = ensure_password(&store);
    let mut runtime = PgRuntime::new(&os_app_data_dir, password);
    tracing::info!(
        target: "fredo::pg_supervisor",
        host = DEFAULT_PG_HOST,
        data_dir = %runtime.data_dir().display(),
        "starting embedded PostgreSQL on loopback with an ephemeral port"
    );

    let started = async {
        runtime.setup().await.map_err(|error| ("setup", error))?;
        // Spec #2975 ST-2 (REQ-5/EARS-5.1): overlay the desktop server-memory
        // knobs onto the `initdb`-created postgresql.conf AFTER setup and BEFORE
        // start, so the running server picks them up (verified live via `SHOW`).
        runtime
            .apply_server_knobs()
            .map_err(|error| ("knobs", error))?;
        let pid = runtime.start().await.map_err(|error| ("start", error))?;
        // Persist the PID marker after the spawn, before the readiness poll (R-1.1).
        persist_pid(&store, Some(pid));
        runtime
            .probe_ready()
            .await
            .map_err(|error| ("readiness", error))?;
        Ok::<u32, (&'static str, anyhow::Error)>(pid)
    }
    .await;

    match started {
        Ok(pid) => {
            let port = runtime.port();

            // Spec #2975 ST-2 pool-ready callback (REQ-1/EARS-1.2): after the
            // readiness probe resolves, build ONE bounded pool and install it
            // into the shared handle EXACTLY once. ANY failure/timeout installs
            // NOTHING and records the reason — the app stays on SQLite
            // (fail-closed, REQ-3/EARS-3.2). The FS-4 seam forces this
            // deterministically for QA (REQ-3/EARS-3.3).
            //
            // ST-2 rework: AFTER the pool builds and BEFORE the install, run the
            // registered startup schema initializers against the candidate pool,
            // so the full startup schema set (feature-data metadata tables + the
            // terminal record table, beyond `settings` created by
            // `build_pg_pool`) exists on PostgreSQL BEFORE any feature op. A
            // schema-init failure installs NOTHING (fail-closed).
            if let Some(engine) = engine.as_ref() {
                if engine.choice() == EngineChoice::Postgres {
                    let url = runtime.connection_url();
                    match build_pg_pool(&url, pool_force_fail_stage()).await {
                        Ok(pg) => match engine.run_pg_schema_inits(&pg.pool) {
                            Ok(()) => {
                                // Spec #2977 ST-5: the one-shot `fredo.db` →
                                // PostgreSQL data migration is the LAST pre-install
                                // step, BETWEEN the schema inits and the install.
                                // Fail-closed (R-2.2): a failed leg records the
                                // reason and installs NOTHING — the engine stays on
                                // SQLite and the next boot re-runs the idempotent
                                // read-only export. The marker is written inside
                                // `run_pre_install` ONLY on a fully parity-clean run.
                                let source_db = data_dir.join("fredo.db");
                                let migration_dir = resolve_migration_dir(&data_dir);
                                let gate = engine.migration_gate();
                                let migration_started = std::time::Instant::now();
                                match run_pre_install(
                                    &source_db,
                                    &migration_dir,
                                    &pg.pool,
                                    &gate,
                                )
                                .await
                                {
                                    Ok(outcome) => {
                                        engine.record_migration_outcome(outcome);
                                        engine.install_postgres(pg);
                                        tracing::info!(
                                            target: "fredo::pg_supervisor",
                                            "storage engine installed: postgres"
                                        );
                                    }
                                    Err(error) => {
                                        let reason = format!("[migration] {error:#}");
                                        tracing::error!(
                                            target: "fredo::pg_supervisor",
                                            reason = %reason,
                                            "data migration failed; storage engine stays on SQLite (fail-closed)"
                                        );
                                        engine.record_migration_outcome(MigrationOutcome {
                                            status: MigrationStatus::Failed,
                                            tables: Vec::new(),
                                            snapshot: None,
                                            elapsed_ms: migration_started.elapsed().as_millis(),
                                        });
                                        engine.set_fallback_reason(reason);
                                    }
                                }
                            }
                            Err(error) => {
                                let reason = format!("[pool:schemaInit] {error:#}");
                                tracing::error!(
                                    target: "fredo::pg_supervisor",
                                    reason = %reason,
                                    "schema init failed; storage engine stays on SQLite (fail-closed)"
                                );
                                engine.set_fallback_reason(reason);
                            }
                        },
                        Err(error) => {
                            let reason = format!("{error:#}");
                            tracing::error!(
                                target: "fredo::pg_supervisor",
                                reason = %reason,
                                "pool build failed; storage engine stays on SQLite (fail-closed)"
                            );
                            engine.set_fallback_reason(reason);
                        }
                    }
                }
            }

            if let Ok(mut guard) = state.runtime.lock() {
                *guard = Some(runtime);
            }
            state.set_ready(port, pid);
            // Invariant: the public readiness gate later slices' stores block on
            // must resolve to the port we just published. Bounded and instant on
            // the happy path; a divergence is surfaced, never swallowed.
            match await_ready(&app, Duration::from_millis(50)).await {
                Ok(gate_port) if gate_port == port => {}
                settled => tracing::warn!(
                    target: "fredo::pg_supervisor",
                    ?settled,
                    port,
                    "readiness gate did not agree with the published status"
                ),
            }
            tracing::info!(
                target: "fredo::pg_supervisor",
                pid,
                port,
                "embedded PostgreSQL ready"
            );
        }
        Err((stage, error)) => {
            // Spec #2975 ST-2: a selection/setup/start/readiness failure leaves
            // the engine on SQLite — record why (fail-closed, REQ-3/EARS-3.2).
            if let Some(engine) = engine.as_ref() {
                if engine.choice() == EngineChoice::Postgres {
                    engine.set_fallback_reason(structured_error(stage, &error));
                }
            }
            // R-1.3: bounded teardown, marker cleared, structured error, no hang.
            let outcome = runtime.stop_bounded(PG_STOP_BOUND).await;
            let (how, elapsed_ms) = match outcome {
                StopOutcome::Graceful { elapsed_ms } => ("graceful", elapsed_ms),
                StopOutcome::HardKilled { elapsed_ms } => ("hardKilled", elapsed_ms),
            };
            // Bounded confirmation that no postmaster survives the teardown.
            let postmaster_gone = wait_until(
                || runtime.postmaster_pid().is_none(),
                PG_DEATH_WAIT_BOUND,
                Duration::from_millis(100),
            )
            .await;
            persist_pid(&store, None);
            state.fail(stage, &error);
            tracing::error!(
                target: "fredo::pg_supervisor",
                stage,
                error = %error,
                how,
                elapsed_ms,
                postmaster_gone,
                "embedded PostgreSQL failed to start; bounded teardown complete"
            );
        }
    }
}

/// The readiness gate later slices' stores block on (bounded).
///
/// Returns the bound port on `Ready`; `Err` on `Disabled`, `Failed`, no managed
/// supervisor, or after `bound` elapses.
pub async fn await_ready(app: &AppHandle, bound: Duration) -> Result<u16> {
    let state = app
        .try_state::<Arc<PgSupervisorState>>()
        .context("embedded PostgreSQL supervisor is not running")?;
    let mut rx = state.status.subscribe();
    let deadline = Instant::now() + bound;
    loop {
        let view = rx.borrow_and_update().clone();
        match view.state {
            PgState::Ready => {
                return view
                    .port
                    .context("embedded PostgreSQL reported Ready without a bound port");
            }
            PgState::Failed => {
                return Err(anyhow::anyhow!(
                    "{}",
                    view.error
                        .unwrap_or_else(|| "embedded PostgreSQL failed".to_string())
                ));
            }
            PgState::Disabled => {
                return Err(anyhow::anyhow!("embedded PostgreSQL is disabled"));
            }
            PgState::Starting => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(anyhow::anyhow!(
                "await_ready exceeded its {bound:?} wall-clock bound"
            ));
        }
        if tokio::time::timeout(remaining, rx.changed()).await.is_err() {
            return Err(anyhow::anyhow!(
                "await_ready exceeded its {bound:?} wall-clock bound"
            ));
        }
    }
}

/// `RunEvent::Exit` hook (SYNCHRONOUS entry): `take()` the runtime, drive a
/// graceful stop bounded by [`PG_EXIT_HOOK_BOUND`] (hard-kill fallback inside),
/// then sweep the marker as a backstop. Quit can never block on a hung server —
/// the total is the bound plus a single `taskkill`.
pub fn stop_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<PgSupervisorState>>() else {
        return;
    };
    // Only the instance that OWNS the data dir may sweep its marker: a second
    // instance that failed to acquire the lock started nothing and must not
    // touch another instance's marker (R-4.5).
    let owns_data_dir = state
        .lock
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
    let runtime = state.runtime.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut runtime) = runtime {
        let outcome = tauri::async_runtime::block_on(runtime.stop_bounded(PG_EXIT_HOOK_BOUND));
        tracing::info!(
            target: "fredo::pg_supervisor",
            ?outcome,
            "embedded PostgreSQL stopped on app exit"
        );
    }
    if owns_data_dir {
        if let Some(store) = app.try_state::<Arc<AppStore>>() {
            // Marker backstop — also covers a hard-killed / mid-boot postmaster.
            sweep_orphan(&store);
        }
    }
}

/// The ONE observability hook: a read-only status snapshot (no state mutation).
#[tauri::command]
pub async fn pg_supervisor_status(app: AppHandle) -> PgStatusView {
    if let Some(state) = app.try_state::<Arc<PgSupervisorState>>() {
        return state.status.borrow().clone();
    }
    // No managed supervisor ⇒ disabled (the default) — resolve the data dir for
    // informational purposes only (honours the FS-1 override like the live path).
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|dir| super::resolve_data_dir(&dir).display().to_string())
        .unwrap_or_default();
    PgStatusView {
        state: PgState::Disabled,
        port: None,
        pid: None,
        error: None,
        data_dir,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::pg_supervisor::sweep::persisted_pid;
    use crate::features::pg_supervisor::{
        PG_DATA_SUBDIR, PG_LOCK_FILENAME, PG_PID_KEY, PG_POOL_FORCE_FAIL_ENV,
    };

    fn open_store(dir: &Path) -> AppStore {
        use crate::infrastructure::storage::engine::{EngineHandle, SqliteEngine, StoreEngine};
        let sqlite = SqliteEngine::open(&dir.join("fredo.db")).expect("open sqlite engine");
        AppStore::open(EngineHandle::new(StoreEngine::Sqlite(sqlite))).expect("open app store")
    }

    #[test]
    fn only_the_literal_true_enables_the_engine() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        assert!(!pg_enabled(&store), "an absent flag is disabled (R-1.4)");
        for raw in ["false", "TRUE", "True", "1", "yes", "", "  true"] {
            store.control_set(PG_ENABLED_KEY, raw).expect("seed flag");
            assert!(!pg_enabled(&store), "{raw:?} must not enable the engine");
        }
        store.control_set(PG_ENABLED_KEY, "true").expect("enable");
        assert!(pg_enabled(&store));
    }

    #[test]
    fn disabled_bootstrap_takes_no_lock_and_never_touches_the_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        // A stale marker must survive the disabled path untouched (R-1.4).
        store.control_set(PG_PID_KEY, "4242").expect("seed marker");

        assert!(matches!(
            bootstrap(dir.path(), &store, false),
            Bootstrap::Disabled
        ));

        assert!(
            !dir.path().join(PG_LOCK_FILENAME).exists(),
            "disabled must not lock the data dir"
        );
        assert_eq!(
            persisted_pid(&store),
            Some(4242),
            "disabled must not sweep or clear the marker"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn enabled_bootstrap_acquires_the_lock_before_sweeping() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        store.control_set(PG_ENABLED_KEY, "true").expect("enable");

        match bootstrap(dir.path(), &store, true) {
            Bootstrap::Locked(lock, data_dir) => {
                assert!(lock.path().exists(), "the lock file is created");
                assert_eq!(lock.path(), dir.path().join(PG_LOCK_FILENAME).as_path());
                assert_eq!(
                    data_dir,
                    dir.path().join(PG_DATA_SUBDIR).display().to_string()
                );
            }
            _ => panic!("an enabled bootstrap must acquire the lock"),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_second_bootstrap_reports_failed_with_a_structured_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        store.control_set(PG_ENABLED_KEY, "true").expect("enable");
        let held = PgDataDirLock::acquire(dir.path()).expect("hold the lock");

        match bootstrap(dir.path(), &store, true) {
            Bootstrap::Failed(error) => {
                assert!(error.starts_with("[lock]"), "structured error: {error}");
            }
            _ => panic!("a second supervisor must report Failed and start nothing"),
        }

        drop(held);
    }

    #[test]
    fn readiness_failure_transitions_to_failed_with_a_structured_error() {
        let state = PgSupervisorState::new(None, None, "C:/data/postgres".to_string());
        assert_eq!(state.status.borrow().state, PgState::Starting);

        state.fail("readiness", &anyhow::anyhow!("connect refused after 62s"));

        let view = state.status.borrow().clone();
        assert_eq!(view.state, PgState::Failed);
        assert_eq!(view.port, None);
        assert_eq!(view.pid, None);
        assert_eq!(view.data_dir, "C:/data/postgres");
        let error = view.error.expect("a structured error is published");
        assert!(error.starts_with("[readiness]"), "{error}");
        assert!(error.contains("connect refused after 62s"), "{error}");
    }

    #[test]
    fn status_view_serializes_camel_case() {
        let ready = PgStatusView {
            state: PgState::Ready,
            port: Some(54321),
            pid: Some(1234),
            error: None,
            data_dir: "C:/data/postgres".to_string(),
        };
        let json = serde_json::to_value(&ready).expect("serialize");
        assert_eq!(json["state"], "ready");
        assert_eq!(json["port"], 54321);
        assert_eq!(json["pid"], 1234);
        assert_eq!(json["dataDir"], "C:/data/postgres");
        assert!(json["error"].is_null());

        assert_eq!(
            serde_json::to_value(PgState::Disabled).expect("serialize"),
            "disabled"
        );
        assert_eq!(
            serde_json::to_value(PgState::Starting).expect("serialize"),
            "starting"
        );
        assert_eq!(
            serde_json::to_value(PgState::Failed).expect("serialize"),
            "failed"
        );
    }

    // -- ST-2: FS-4 fault seam -------------------------------------------------

    static SEAM_ENV_LOCK: Mutex<()> = Mutex::new(());

    struct SeamEnvGuard;

    impl Drop for SeamEnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(PG_POOL_FORCE_FAIL_ENV);
        }
    }

    #[test]
    fn pool_force_fail_stage_is_inert_when_unset_and_parses_when_set() {
        let _lock = SEAM_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(PG_POOL_FORCE_FAIL_ENV);
        assert_eq!(pool_force_fail_stage(), None, "unset must be inert");

        std::env::set_var(PG_POOL_FORCE_FAIL_ENV, "1");
        let _guard = SeamEnvGuard;
        assert_eq!(pool_force_fail_stage(), Some(PgPoolStage::Connect));

        std::env::set_var(PG_POOL_FORCE_FAIL_ENV, "schemaInit");
        assert_eq!(pool_force_fail_stage(), Some(PgPoolStage::SchemaInit));

        std::env::set_var(PG_POOL_FORCE_FAIL_ENV, "   ");
        assert_eq!(pool_force_fail_stage(), None, "blank must be inert");
    }
}
