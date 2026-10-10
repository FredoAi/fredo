//! Tauri-managed embedded-PostgreSQL supervisor state + lifecycle wiring
//! (Spec #2974, ST-3).
//!
//! This is the composition seam between `lib.rs` and the bounded runtime
//! ([`super::runtime`]) / startup-safety primitives ([`super::sweep`],
//! [`super::lock`]). It owns:
//!
//! * the boot decision: PostgreSQL is UNCONDITIONAL (Spec #3005 ST-3 removes the
//!   engine selector), so the supervisor always starts (nothing is locked,
//!   swept, or spawned on any opt-out path). The PID marker it reads and writes
//!   lives in the JSON boot KV; the password lives in the OS keychain
//!   ([`crate::applications::pg_supervisor::credentials`], Spec #3005 ST-7);
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
    build_pg_pool, PgPoolStage, StorageEngineState, StoreEngine,
};
use crate::infrastructure::storage::AppStore;

use super::config::{PgLogVerbosity, PgSupervisorConfig};
use super::credentials::PgCredential;
use super::descriptor::{self, HeadlessDescriptor};
use super::lock::PgDataDirLock;
use super::runtime::{wait_until, PgRuntime, StopOutcome};
use super::sweep::{persist_pid, sweep_orphan, sweep_postmaster_pid_file};
use super::{
    DEFAULT_PG_HOST, PG_APPLY_BOUND, PG_DEATH_WAIT_BOUND, PG_EXIT_HOOK_BOUND, PG_STOP_BOUND,
};

/// Lifecycle state exposed by [`pg_supervisor_status`] / the readiness gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgState {
    /// No managed supervisor is present (the status command's no-state fallback).
    Disabled,
    /// The managed postmaster is booting on a background task.
    Starting,
    /// The real-client readiness probe succeeded; `port`/`pid` are populated.
    Ready,
    /// The data dir is locked by a LIVE headless `fredo ingest` daemon and this
    /// GUI attached to its cluster (Spec #2992 CU-1). `port` is the published
    /// ephemeral port; the GUI owns no runtime and holds no lock, so it never
    /// starts, stops, or sweeps that postmaster.
    Attached,
    /// The boot failed closed (structured `error`) and was torn down.
    Failed,
}

/// Additive failure classification carried by [`PgStatusView::failure_kind`]
/// (Spec #3022 ST-4, R-3.3). `Some` ONLY while the state is [`PgState::Failed`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgFailureKind {
    /// The boot/readiness leg rejected the stored credential (SQLSTATE `28P01`
    /// `/ `28000`, `password authentication failed`) — the keychain drifted.
    AuthMismatch,
    /// The server could not bind the configured port (`address already in use`).
    PortInUse,
    /// Any other failure.
    Unknown,
}

/// Read-only snapshot of the supervisor (`#[serde(rename_all = "camelCase")]`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgStatusView {
    /// Current lifecycle state.
    pub state: PgState,
    /// The bound ephemeral loopback port, once `Ready`/`Attached`.
    pub port: Option<u16>,
    /// The managed postmaster PID once `Ready`; the owning headless daemon PID
    /// once `Attached` (the postmaster belongs to that daemon).
    pub pid: Option<u32>,
    /// Structured failure detail, once `Failed`.
    pub error: Option<String>,
    /// The PostgreSQL data directory (`<app_data_dir>/postgres`, or the FS-1
    /// `FREDO_PG_DATA_DIR` override when set).
    pub data_dir: String,
    /// Additive (Spec #2978 S4): the postmaster log path
    /// (`<data_dir>/log/postgres.log`) the read-only `pg_server_log_tail` reads;
    /// `None` only when no data dir is resolvable.
    pub log_path: Option<String>,
    /// Additive (Spec #3022 ST-4): the failure classification, `Some` ONLY while
    /// `state == Failed` (additive — existing consumers ignore the extra field).
    pub failure_kind: Option<PgFailureKind>,
    /// Additive (Spec #2992 CU-1): `true` only while the GUI serves a
    /// headless-owned cluster ([`PgState::Attached`]); `false` for every other
    /// state. Existing consumers ignore the extra field.
    pub attached: bool,
}

/// `<data_dir>/log/postgres.log` as a serializable string; `None` when the data
/// dir is unknown (empty). One rule so the status view and the tail agree.
fn log_path_for(data_dir: &str) -> Option<String> {
    let trimmed = data_dir.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(
            super::pg_log_path(Path::new(trimmed))
                .display()
                .to_string(),
        )
    }
}

impl PgStatusView {
    /// A `Failed` view carrying a structured error (never a port/pid). The
    /// failure is classified [`PgFailureKind::Unknown`] unless a caller supplies
    /// a more specific kind via [`Self::failed_with_kind`].
    pub fn failed(error: String, data_dir: String) -> Self {
        Self::failed_with_kind(error, data_dir, PgFailureKind::Unknown)
    }

    /// A `Failed` view carrying a structured error AND a classified
    /// [`PgFailureKind`] (Spec #3022 ST-4, R-3.3).
    pub fn failed_with_kind(error: String, data_dir: String, kind: PgFailureKind) -> Self {
        Self {
            state: PgState::Failed,
            port: None,
            pid: None,
            error: Some(error),
            log_path: log_path_for(&data_dir),
            data_dir,
            failure_kind: Some(kind),
            attached: false,
        }
    }
}

/// Classify a failed boot/restart outcome into the additive [`PgFailureKind`]
/// (Spec #3022 ST-4, R-3.3). A credential rejection on the boot/readiness leg
/// (SQLSTATE `28P01`/`28000`, `password authentication failed`) maps to
/// [`PgFailureKind::AuthMismatch`]; a `start`-stage bind failure maps to
/// [`PgFailureKind::PortInUse`]; everything else is [`PgFailureKind::Unknown`].
/// Pure over the formatted error chain, so the mapping is unit-testable.
pub fn classify_failure(stage: &str, error: &anyhow::Error) -> PgFailureKind {
    classify_failure_text(stage, &format!("{error:#}"))
}

/// The pure classification rule (unit-testable without a live server, G-222).
fn classify_failure_text(stage: &str, text: &str) -> PgFailureKind {
    let lower = text.to_ascii_lowercase();
    if text.contains("28P01")
        || text.contains("28000")
        || lower.contains("password authentication failed")
        || lower.contains("authentication failed")
    {
        return PgFailureKind::AuthMismatch;
    }
    if stage == "start"
        && (lower.contains("could not bind")
            || lower.contains("address already in use")
            || lower.contains("address in use")
            || lower.contains("failed to bind")
            || lower.contains("bind:"))
    {
        return PgFailureKind::PortInUse;
    }
    PgFailureKind::Unknown
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
    /// Serializes config applies / database resets (Spec #3022 ST-4, R-5.2): ONE
    /// restart at a time. Deliberately held across the awaited restart.
    pub apply_lock: tokio::sync::Mutex<()>,
}

impl PgSupervisorState {
    /// Build a `Starting` supervisor holding the acquired lock (runtime added on success).
    pub fn new(runtime: Option<PgRuntime>, lock: Option<PgDataDirLock>, data_dir: String) -> Self {
        let log_path = log_path_for(&data_dir);
        let (status, _rx) = tokio::sync::watch::channel(PgStatusView {
            state: PgState::Starting,
            port: None,
            pid: None,
            error: None,
            data_dir,
            log_path,
            failure_kind: None,
            attached: false,
        });
        Self {
            runtime: Mutex::new(runtime),
            status,
            lock: Mutex::new(lock),
            apply_lock: tokio::sync::Mutex::new(()),
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
            apply_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Publish `Ready` with the resolved port/PID.
    pub fn set_ready(&self, port: u16, pid: u32) {
        let data_dir = self.status.borrow().data_dir.clone();
        let log_path = log_path_for(&data_dir);
        self.status.send_replace(PgStatusView {
            state: PgState::Ready,
            port: Some(port),
            pid: Some(pid),
            error: None,
            data_dir,
            log_path,
            failure_kind: None,
            attached: false,
        });
    }

    /// Publish `Attached` (Spec #2992 CU-1): the GUI serves a headless-owned
    /// cluster on `port`; `pid` is the owning headless daemon. The GUI holds no
    /// runtime and no lock, so [`stop_on_exit`] no-ops (it never stops the
    /// headless postmaster).
    pub fn set_attached(&self, port: u16, pid: u32) {
        let data_dir = self.status.borrow().data_dir.clone();
        let log_path = log_path_for(&data_dir);
        self.status.send_replace(PgStatusView {
            state: PgState::Attached,
            port: Some(port),
            pid: Some(pid),
            error: None,
            data_dir,
            log_path,
            failure_kind: None,
            attached: true,
        });
    }

    /// Transition to `Failed` with a structured error (R-1.3), classifying the
    /// failure into the additive [`PgFailureKind`] (Spec #3022 ST-4, R-3.3).
    pub fn fail(&self, stage: &str, error: &anyhow::Error) {
        self.fail_with_kind(stage, error, classify_failure(stage, error));
    }

    /// Transition to `Failed` with a structured error AND an explicit
    /// [`PgFailureKind`] (Spec #3022 ST-4).
    pub fn fail_with_kind(&self, stage: &str, error: &anyhow::Error, kind: PgFailureKind) {
        let data_dir = self.status.borrow().data_dir.clone();
        self.status.send_replace(PgStatusView::failed_with_kind(
            structured_error(stage, error),
            data_dir,
            kind,
        ));
    }
}

/// The synchronous startup decision: what the bootstrap did (and, on success,
/// the held lock + resolved data dir to hand to the managed state).
enum Bootstrap {
    /// The exclusive data-dir lock is held elsewhere ⇒ `Failed`.
    Failed(String),
    /// The lock is held BEFORE the sweep (R-4.5).
    Locked(PgDataDirLock, String),
}

/// The **FS-4** fault seam resolved to a named pool-build stage: the non-blank
/// value of [`super::PG_POOL_FORCE_FAIL_ENV`] parsed by
/// [`PgPoolStage::parse`]. Inert when unset (the default build is unchanged).
pub fn pool_force_fail_stage() -> Option<PgPoolStage> {
    let raw = std::env::var(super::PG_POOL_FORCE_FAIL_ENV).ok()?;
    PgPoolStage::parse(&raw)
}

/// Synchronous, bounded bootstrap: lock → sweep. NEVER starts the server.
///
/// PostgreSQL is UNCONDITIONAL (Spec #3005 ST-3 removed the engine selector), so
/// there is no disabled path. The lock lives at `<lock_dir>/<PG_LOCK_FILENAME>`,
/// where `lock_dir` honours the **G-275** [`super::PG_LOCK_DIR_ENV`] override
/// ([`super::resolve_lock_dir`]); the **data dir** honours the FS-1
/// [`super::PG_DATA_DIR_ENV`] override (`super::resolve_data_dir`).
fn bootstrap(app_data_dir: &Path, store: &AppStore) -> Bootstrap {
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

/// Resolve the loopback-only cluster password from the OS keychain (Spec #3005
/// ST-7). Shared with the headless daemon (Spec #2992 CU-2), which must use the
/// SAME credential. The password is NEVER written to the synchronous settings
/// cache nor the PostgreSQL `settings` table; when the keychain is unavailable
/// the documented [`PgCredential::resolve`] fallback applies (warned WITHOUT its
/// value).
pub(crate) fn ensure_password(credential: &PgCredential) -> String {
    credential.resolve()
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

    // Spec #3005 ST-3: PostgreSQL is UNCONDITIONAL — the engine selector and the
    // legacy `postgres.enabled` opt-out are gone, so the supervisor always sets
    // up. `bootstrap` acquires the lock BEFORE the sweep.
    match bootstrap(&os_app_data_dir, &store) {
        Bootstrap::Failed(error) => {
            let lock_dir = super::resolve_lock_dir(&os_app_data_dir);
            let pg_data_dir = super::resolve_data_dir(&os_app_data_dir)
                .display()
                .to_string();
            // R-3 attach leg (Spec #2992 CU-1): the data dir is locked. If a LIVE
            // headless descriptor is published, ATTACH to the headless-owned
            // cluster instead of failing closed. `is_live` is bounded (PID image
            // guard + a <=500 ms TCP connect), so the synchronous setup path
            // never blocks unbounded (G-263).
            match descriptor::read(&lock_dir).filter(descriptor::is_live) {
                Some(headless) => {
                    tracing::info!(
                        target: "fredo::pg_supervisor",
                        pid = headless.pid,
                        port = headless.port,
                        data_dir = %pg_data_dir,
                        "data dir locked by a live headless daemon; attaching to its cluster"
                    );
                    // No runtime, no lock: this GUI never starts/stops/sweeps the
                    // headless postmaster, and `stop_on_exit` no-ops.
                    app.manage(Arc::new(PgSupervisorState::new(None, None, pg_data_dir)));
                    let handle = app.clone();
                    // G-273: the attach leg is spawned, never awaited in setup.
                    tauri::async_runtime::spawn(async move {
                        run_attach(handle, headless).await;
                    });
                }
                None => {
                    // Missing/stale descriptor: keep the fail-closed `Failed` path —
                    // record the reason, report Failed, and start nothing.
                    if let Some(state) = app.try_state::<Arc<StorageEngineState>>() {
                        state.set_fallback_reason(error.clone());
                    }
                    tracing::error!(
                        target: "fredo::pg_supervisor",
                        error = %error,
                        "embedded PostgreSQL data dir is not available; supervisor reports Failed"
                    );
                    app.manage(Arc::new(PgSupervisorState::failed_only(error, pg_data_dir)));
                }
            }
        }
        Bootstrap::Locked(lock, pg_data_dir) => {
            tracing::info!(
                target: "fredo::pg_supervisor",
                lock = %lock.path().display(),
                data_dir = %pg_data_dir,
                "embedded PostgreSQL enabled; holding the exclusive data-dir lock"
            );
            // Spec #2978 S1 (AC1): record the compile-time acquisition mode and
            // its declared price at boot, so the shipped choice and its
            // installer/footprint consequence are observable on a running system.
            tracing::info!(
                target: "fredo::pg_supervisor",
                mode = ?super::acquisition::ACQUISITION_MODE,
                first_run_download_bytes = super::acquisition::PG_FIRST_RUN_DOWNLOAD_BYTES,
                installer_delta_bundled_bytes = super::acquisition::PG_INSTALLER_DELTA_BUNDLED_BYTES,
                bundled_archive_bytes = super::acquisition::PG_BUNDLED_ARCHIVE_BYTES,
                extracted_payload_bytes = super::acquisition::PG_EXTRACTED_PAYLOAD_BYTES,
                data_dir_delta_bytes = super::acquisition::PG_DATA_DIR_DELTA_BYTES,
                "embedded PostgreSQL acquisition mode + declared price"
            );
            app.manage(Arc::new(PgSupervisorState::new(None, Some(lock), pg_data_dir)));
            let handle = app.clone();
            let os_app_data_dir = os_app_data_dir.clone();
            // G-273 / R-2.3: setup NEVER awaits the boot — the whole
            // setup/start/readiness leg runs on a background task so the webview
            // shell renders while the postmaster boots. Only `await_ready`-gated
            // store reads (later slices) block.
            tauri::async_runtime::spawn(async move {
                run_start(handle, os_app_data_dir).await;
            });
        }
    }
}

/// The background start: bounded setup → start → marker → readiness. On any
/// bounded failure, tear down under a bounded stop, clear the marker, and publish
/// `Failed` (R-1.3). Never awaited from `setup`.
///
/// `os_app_data_dir` roots the managed-PG data/install dirs + lock.
async fn run_start(app: AppHandle, os_app_data_dir: PathBuf) {
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

    let password = ensure_password(&PgCredential::keyring());
    // Spec #3022 ST-4: the boot path honours the persisted supervisor config —
    // the pinned/ephemeral port and the log verbosity are applied through
    // `PgRuntime::with_config` (an absent config yields the ephemeral default).
    let config = PgSupervisorConfig::load(&os_app_data_dir);
    let mut runtime = build_runtime(&os_app_data_dir, password, &config);
    tracing::info!(
        target: "fredo::pg_supervisor",
        host = DEFAULT_PG_HOST,
        data_dir = %runtime.data_dir().display(),
        port = runtime.port(),
        "starting embedded PostgreSQL on loopback"
    );

    let started = async {
        // Spec #2978 S2: on the `runtime-download` path, acquire + verify the
        // PostgreSQL archive through Fredo's ONE streaming engine BEFORE `setup()`
        // extracts it. A failed acquisition returns a retryable `[pg:archive] …`
        // error and stops the boot BEFORE any extraction, so no half-extracted
        // distribution is left behind (REQ-4.1). The `bundled` path carries the
        // archive in the binary and must not fetch at runtime (REQ-4.2).
        if super::acquisition::ACQUISITION_MODE
            == super::acquisition::PgAcquisitionMode::RuntimeDownload
        {
            super::acquisition::acquire_pg_archive(&os_app_data_dir)
                .await
                .map_err(|error| ("acquisition", error))?;
        }
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
            // readiness probe resolves, build ONE bounded pool, run the shared
            // pre-install leg (schema inits), and install the engine. The SAME
            // helper backs the CU-1 headless attach path, so the two legs can
            // never diverge.
            install_engine_on_pool(&engine, &runtime.connection_url()).await;

            // Spec #3005 ST-2: hydrate the synchronous settings cache from
            // PostgreSQL ONCE the pool is installed (R-2.2), applying the
            // persisted tracing level through the reload handle. A hydration
            // failure leaves the cache at defaults and never blocks boot (N-2).
            let _ = store.hydrate().await;

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
            // A setup/start/readiness failure leaves the handle Pending — record
            // why (fail-closed, R-1.4; no fallback data plane).
            if let Some(engine) = engine.as_ref() {
                engine.set_fallback_reason(structured_error(stage, &error));
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

/// The pre-install engine leg shared by the GUI's OWN cluster start and the CU-1
/// headless attach path: build ONE bounded pool, run the registered schema
/// initializers, and install the engine.
///
/// Spec #3005 ST-5: the legacy one-shot SQLite → PostgreSQL migration is
/// deleted (fresh-install-only, no carry, data loss accepted). PostgreSQL is
/// installed directly after the schema inits; any pre-existing legacy SQLite file
/// is ignored — never opened, never carried. The retired migration markers
/// (`migration.postgres.completed` / `rollback.*`) stay as unread PG rows.
///
/// Fail-closed contract (REQ-3/EARS-3.2, R-1.4): ANY failure records the
/// structured reason on the engine state and installs NOTHING — the handle stays
/// Pending, so there is no SQLite data-plane fallback. The FS-4 seam forces the
/// pool stage deterministically for QA (G-275). A `None` engine state is a no-op
/// (the slice-1 path). The function is bounded end-to-end by `build_pg_pool`'s
/// [`crate::infrastructure::storage::engine::PG_POOL_BUILD_BOUND`] and the
/// runtime's bounded readiness (G-263).
async fn install_engine_on_pool(engine: &Option<Arc<StorageEngineState>>, url: &str) {
    let Some(engine) = engine.as_ref() else {
        return;
    };
    match build_pg_pool(url, pool_force_fail_stage()).await {
        Ok(pg) => match engine.run_pg_schema_inits(&pg.pool) {
            Ok(()) => {
                // The schema set exists on the candidate pool; install the engine.
                engine.install_postgres(pg);
                tracing::info!(
                    target: "fredo::pg_supervisor",
                    "storage engine installed: postgres"
                );
            }
            Err(error) => {
                let reason = format!("[pool:schemaInit] {error:#}");
                tracing::error!(
                    target: "fredo::pg_supervisor",
                    reason = %reason,
                    "schema init failed; storage engine stays Pending (fail-closed, no SQLite data-plane fallback)"
                );
                engine.set_fallback_reason(reason);
            }
        },
        Err(error) => {
            let reason = format!("{error:#}");
            tracing::error!(
                target: "fredo::pg_supervisor",
                reason = %reason,
                "pool build failed; storage engine stays Pending (fail-closed, no SQLite data-plane fallback)"
            );
            engine.set_fallback_reason(reason);
        }
    }
}

// ── Config surface (Spec #3022, ST-4) ─────────────────────────────────────────

/// The effective supervisor config MINUS any secret (Spec #3022 ST-4). Carries
/// NO password/secret field — the structural write-only guard (AC5/R-5.1), so no
/// cleartext can ever reach a visible surface.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgConfigView {
    /// The pinned TCP port; `None` = ephemeral (OS-assigned).
    pub port: Option<u16>,
    /// The server log verbosity (persisted as the PG `log_min_messages` string).
    pub log_verbosity: PgLogVerbosity,
    /// The resolved PostgreSQL data directory.
    pub data_dir: String,
    /// The absolute path of the backing config file
    /// (`<app_data_dir>/postgres-supervisor.json`).
    pub config_path: String,
}

/// The result of [`pg_config_apply`] (Spec #3022 ST-4). `config` is the retained
/// effective config (the prior one on a failed apply).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgConfigApplyResult {
    /// `true` only when the config persisted AND the cluster restarted.
    pub ok: bool,
    /// The structured failure reason, once `ok == false`.
    pub error: Option<String>,
    /// The effective config after the attempt (write-only: no secret).
    pub config: PgConfigView,
}

/// The result of [`pg_database_reset`] (Spec #3022 ST-4).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDatabaseResetResult {
    /// `true` only when the cluster re-initialised and is ready.
    pub ok: bool,
    /// The structured failure reason, once `ok == false`.
    pub error: Option<String>,
    /// The bound port once the re-initialised cluster is ready.
    pub port: Option<u16>,
}

/// Build a runtime honouring the persisted config (Spec #3022 ST-4). The data /
/// install dirs resolve through the shared FS-1/G-275 rules, so the boot and the
/// restart legs can never diverge.
fn build_runtime(app_data_dir: &Path, password: String, config: &PgSupervisorConfig) -> PgRuntime {
    PgRuntime::with_config(
        &super::resolve_data_dir(app_data_dir),
        &super::resolve_install_dir(app_data_dir),
        password,
        config,
    )
}

/// The effective config view for `app_data_dir` (no secret field).
fn config_view_for_dir(app_data_dir: &Path) -> PgConfigView {
    let config = PgSupervisorConfig::load(app_data_dir);
    PgConfigView {
        port: config.port,
        log_verbosity: config.log_verbosity,
        data_dir: super::resolve_data_dir(app_data_dir)
            .display()
            .to_string(),
        config_path: PgSupervisorConfig::path(app_data_dir)
            .display()
            .to_string(),
    }
}

/// The effective config view resolved from the app handle; a failed app-data-dir
/// resolution yields an empty-path view (never a panic).
fn config_view(app: &AppHandle) -> PgConfigView {
    match app.path().app_data_dir() {
        Ok(dir) => config_view_for_dir(&dir),
        Err(_) => PgConfigView {
            port: None,
            log_verbosity: PgLogVerbosity::Info,
            data_dir: String::new(),
            config_path: String::new(),
        },
    }
}

/// Snapshot the config file's raw bytes for a failure-time restore (Spec #3022
/// ST-4). `None` when the file did not exist.
fn snapshot_config(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

/// Restore the config file to a prior byte snapshot, atomically. A `None`
/// snapshot (the file did not exist before) removes the file, so a failed apply
/// leaves the on-disk config byte-identical to the pre-apply state.
fn restore_config(path: &Path, snapshot: &Option<Vec<u8>>) -> Result<()> {
    match snapshot {
        Some(bytes) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("create {}", parent.display()))?;
                }
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, bytes).with_context(|| format!("write {}", tmp.display()))?;
            std::fs::rename(&tmp, path)
                .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
            Ok(())
        }
        None => {
            if path.exists() {
                std::fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
            }
            Ok(())
        }
    }
}

/// REFUSE an apply/reset while the data dir is attached (Spec #3022 ST-4): the
/// GUI does not own the headless `fredo ingest` cluster, so it must not stop /
/// restart / re-initialise it. Returns the refusal reason, or `None` when the
/// GUI owns the cluster.
fn refuse_when_attached(state: &PgSupervisorState) -> Option<String> {
    if state.status.borrow().state == PgState::Attached {
        Some(
            "The embedded PostgreSQL cluster is owned by a headless `fredo ingest` daemon; \
             this window does not own it, so its configuration cannot be changed here."
                .to_string(),
        )
    } else {
        None
    }
}

/// Rebuild the shared pool against `url` and RE-POINT the engine via
/// [`crate::infrastructure::storage::engine::EngineHandle::swap`] (the Spec
/// #3022 ST-3 seam) — unlike the first-wins install on the boot path, a restart
/// must replace the pool whose URL moved. Fail-closed: any failure records the
/// reason and leaves the active engine unchanged (handle stays on its prior pool).
async fn rebuild_engine_pool(engine: &Option<Arc<StorageEngineState>>, url: &str) {
    let Some(engine) = engine.as_ref() else {
        return;
    };
    match build_pg_pool(url, pool_force_fail_stage()).await {
        Ok(pg) => match engine.run_pg_schema_inits(&pg.pool) {
            Ok(()) => {
                engine.handle().swap(StoreEngine::Postgres(Arc::new(pg)));
                tracing::info!(
                    target: "fredo::pg_supervisor",
                    "storage engine re-pointed after restart"
                );
            }
            Err(error) => {
                let reason = format!("[pool:schemaInit] {error:#}");
                tracing::error!(
                    target: "fredo::pg_supervisor",
                    reason = %reason,
                    "schema init failed on restart; engine left on its prior pool (fail-closed)"
                );
                engine.set_fallback_reason(reason);
            }
        },
        Err(error) => {
            let reason = format!("{error:#}");
            tracing::error!(
                target: "fredo::pg_supervisor",
                reason = %reason,
                "pool rebuild failed on restart; engine left on its prior pool (fail-closed)"
            );
            engine.set_fallback_reason(reason);
        }
    }
}

/// Replace the password segment of a crate connection URL (the crate's shape is
/// `postgresql://<user>:<password>@<host>:<port>/<db>`). Used ONLY by the R-1.3
/// compensating revert.
fn url_with_password(url: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return url.to_string();
    }
    url.replacen(from, to, 1)
}

/// Run `ALTER USER postgres PASSWORD $1` on an explicit connection URL, bounded
/// by [`super::PG_CONTROL_TIMEOUT`] (G-263). Backs the R-1.3 compensating revert,
/// which must connect with the JUST-SET password (the runtime's own URL carries
/// the old one).
async fn alter_password_on_url(url: &str, new_password: &str) -> Result<()> {
    use sqlx::Connection as _;
    let url = url.to_string();
    let password = new_password.to_string();
    super::runtime::run_bounded(super::PG_CONTROL_TIMEOUT, "pg.alter", async move {
        let mut connection = sqlx::PgConnection::connect(&url)
            .await
            .context("connecting to change the postgres password")?;
        sqlx::query("ALTER USER postgres PASSWORD $1")
            .bind(password)
            .execute(&mut connection)
            .await
            .context("running ALTER USER postgres PASSWORD")?;
        Ok::<(), anyhow::Error>(())
    })
    .await
}

/// Change the running cluster's `postgres` password IN PLACE and persist it to
/// the OS keychain (Spec #3022 ST-4, R-1.1/R-1.3).
///
/// Ordering: ALTER (with the current credential) → keychain store. If the
/// keychain write fails AFTER a successful ALTER, a compensating ALTER restores
/// the prior password, so the server and the keychain never diverge. The running
/// runtime is left in `state` on every path; the mutex is never held across an
/// await.
async fn change_password_safely(
    state: &Arc<PgSupervisorState>,
    credential: &PgCredential,
    new_password: &str,
    current_password: &str,
) -> Result<()> {
    let runtime = state.runtime.lock().ok().and_then(|mut guard| guard.take());
    let Some(runtime) = runtime else {
        anyhow::bail!("no running embedded PostgreSQL cluster to change the password on");
    };

    if let Err(error) = runtime.change_password(new_password).await {
        if let Ok(mut guard) = state.runtime.lock() {
            *guard = Some(runtime);
        }
        return Err(error.context("ALTER USER postgres PASSWORD failed"));
    }

    // The runtime's own URL still carries the OLD password; the compensating
    // revert must connect with the NEW one.
    let runtime_url = runtime.connection_url();
    let outcome = match credential.store(new_password) {
        Ok(()) => Ok(()),
        Err(store_error) => {
            let revert_url = url_with_password(&runtime_url, current_password, new_password);
            match alter_password_on_url(&revert_url, current_password).await {
                Ok(()) => Err(anyhow::anyhow!(
                    "the OS keychain write failed; the cluster password was reverted to the prior value: {store_error}"
                )),
                Err(revert_error) => Err(anyhow::anyhow!(
                    "the OS keychain write failed AND the compensating password revert also failed: {store_error}; revert error: {revert_error:#}"
                )),
            }
        }
    };

    if let Ok(mut guard) = state.runtime.lock() {
        *guard = Some(runtime);
    }
    outcome
}

/// The shared bounded cluster-restart leg (Spec #3022 ST-4): take the runtime →
/// bounded stop → build [`PgRuntime::with_config`] → `setup` → `apply_server_knobs`
/// → `start` → `probe_ready` → rebuild the pool → `EngineHandle::swap` → publish
/// `Ready`. The WHOLE leg is wrapped in [`PG_APPLY_BOUND`] (over the existing inner
/// bounds). On failure the runtime is torn down, the marker cleared, and a
/// classified `Failed` is published. The caller refuses while the data dir is
/// attached.
async fn restart_cluster(
    app: &AppHandle,
    config: &PgSupervisorConfig,
    password: &str,
) -> Result<(u16, u32)> {
    match tokio::time::timeout(
        PG_APPLY_BOUND,
        restart_cluster_inner(app, config, password),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let error = anyhow::anyhow!(
                "the embedded PostgreSQL restart exceeded its {PG_APPLY_BOUND:?} wall-clock bound"
            );
            if let Some(state) = app.try_state::<Arc<PgSupervisorState>>() {
                state.fail("restart", &error);
            }
            Err(error)
        }
    }
}

async fn restart_cluster_inner(
    app: &AppHandle,
    config: &PgSupervisorConfig,
    password: &str,
) -> Result<(u16, u32)> {
    let state = app
        .try_state::<Arc<PgSupervisorState>>()
        .context("embedded PostgreSQL supervisor is not running")?;
    let store = app.try_state::<Arc<AppStore>>().map(|s| s.inner().clone());
    let engine = app
        .try_state::<Arc<StorageEngineState>>()
        .map(|s| s.inner().clone());
    let os_app_data_dir = app
        .path()
        .app_data_dir()
        .context("resolve the app data dir")?;

    // 1. Stop the current runtime. The mutex is NOT held across the await: the
    //    runtime is taken out and the guard dropped before `stop_bounded`.
    let previous = state.runtime.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut previous) = previous {
        let _ = previous.stop_bounded(PG_STOP_BOUND).await;
        let _ = wait_until(
            || previous.postmaster_pid().is_none(),
            PG_DEATH_WAIT_BOUND,
            Duration::from_millis(100),
        )
        .await;
        if let Some(store) = store.as_ref() {
            persist_pid(store, None);
        }
    }

    // 2. Build the new runtime with the persisted config + effective password.
    let mut runtime = build_runtime(&os_app_data_dir, password.to_string(), config);

    // 3. Bounded setup → knobs → start → marker → readiness (each leg has its own
    //    inner bound; the whole restart is additionally capped by `restart_cluster`).
    let started = async {
        runtime.setup().await.map_err(|error| ("setup", error))?;
        runtime
            .apply_server_knobs()
            .map_err(|error| ("knobs", error))?;
        let pid = runtime.start().await.map_err(|error| ("start", error))?;
        if let Some(store) = store.as_ref() {
            persist_pid(store, Some(pid));
        }
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
            // Spec #3022 ST-3: the pool URL moved, so RE-POINT (swap) the engine.
            rebuild_engine_pool(&engine, &runtime.connection_url()).await;
            // Spec #3005 ST-2: re-hydrate the synchronous cache from the new pool.
            if let Some(store) = store.as_ref() {
                let _ = store.hydrate().await;
            }
            if let Ok(mut guard) = state.runtime.lock() {
                *guard = Some(runtime);
            }
            state.set_ready(port, pid);
            tracing::info!(
                target: "fredo::pg_supervisor",
                pid,
                port,
                "embedded PostgreSQL restarted"
            );
            Ok((port, pid))
        }
        Err((stage, error)) => {
            if let Some(engine) = engine.as_ref() {
                engine.set_fallback_reason(structured_error(stage, &error));
            }
            let _ = runtime.stop_bounded(PG_STOP_BOUND).await;
            if let Some(store) = store.as_ref() {
                persist_pid(store, None);
            }
            state.fail(stage, &error);
            tracing::error!(
                target: "fredo::pg_supervisor",
                stage,
                error = %error,
                "embedded PostgreSQL restart failed; bounded teardown complete"
            );
            Err(error.context(format!("restart failed at the {stage} stage")))
        }
    }
}

/// Apply a new supervisor config (Spec #3022 ST-4): validate → (optional) in-place
/// password change + keychain update → atomic config save → bounded restart with
/// the ST-3 swap. On ANY failure the prior config bytes are restored and a bounded
/// recovery restart runs, so a bad port never leaves the cluster down
/// (R-1.2/R-1.3/R-3.2/R-3.3/R-4). REFUSES while the data dir is attached (R-5.2).
#[tauri::command]
pub async fn pg_config_apply(
    app: AppHandle,
    port: Option<u16>,
    log_verbosity: PgLogVerbosity,
    new_password: Option<String>,
) -> PgConfigApplyResult {
    let Some(state) = app.try_state::<Arc<PgSupervisorState>>() else {
        return PgConfigApplyResult {
            ok: false,
            error: Some("embedded PostgreSQL supervisor is not running".to_string()),
            config: config_view(&app),
        };
    };

    // Serialize applies: ONE restart at a time (R-5.2).
    let _apply = state.apply_lock.lock().await;

    if let Some(reason) = refuse_when_attached(&state) {
        return PgConfigApplyResult {
            ok: false,
            error: Some(reason),
            config: config_view(&app),
        };
    }

    match apply_config_inner(&app, &state, port, log_verbosity, new_password).await {
        Ok(()) => PgConfigApplyResult {
            ok: true,
            error: None,
            config: config_view(&app),
        },
        Err(error) => PgConfigApplyResult {
            ok: false,
            error: Some(format!("{error:#}")),
            config: config_view(&app),
        },
    }
}

async fn apply_config_inner(
    app: &AppHandle,
    state: &Arc<PgSupervisorState>,
    port: Option<u16>,
    log_verbosity: PgLogVerbosity,
    new_password: Option<String>,
) -> Result<()> {
    // Validate: a pinned port must be in 1..=65535 (u16 already caps the top).
    if port == Some(0) {
        anyhow::bail!("the pinned port must be between 1 and 65535");
    }
    // An explicitly empty password is rejected — it must never blank the credential.
    if let Some(password) = new_password.as_deref() {
        if password.is_empty() {
            anyhow::bail!("the new password must not be empty");
        }
    }

    let os_app_data_dir = app
        .path()
        .app_data_dir()
        .context("resolve the app data dir")?;
    let config_path = PgSupervisorConfig::path(&os_app_data_dir);
    let prior_snapshot = snapshot_config(&config_path);
    let prior_config = PgSupervisorConfig::load(&os_app_data_dir);

    // Optional in-place password change (never leaves keychain/cluster divergent).
    let credential = PgCredential::keyring();
    let mut effective_password = ensure_password(&credential);
    if let Some(new_password) = new_password.as_deref() {
        change_password_safely(state, &credential, new_password, &effective_password)
            .await
            .context("changing the superuser password")?;
        effective_password = new_password.to_string();
    }

    // Persist the new config atomically, then restart on it.
    let next_config = PgSupervisorConfig {
        port,
        log_verbosity,
    };
    PgSupervisorConfig::save(&os_app_data_dir, &next_config)
        .context("persisting the postgres-supervisor config")?;

    match restart_cluster(app, &next_config, &effective_password).await {
        Ok(_) => Ok(()),
        Err(error) => {
            // R-1.2/AC3-negative: restore the prior config bytes and run a bounded
            // recovery restart on the prior configuration. A recovery failure is
            // surfaced in the returned error; the cluster stays fail-closed.
            if let Err(restore_error) = restore_config(&config_path, &prior_snapshot) {
                tracing::error!(
                    target: "fredo::pg_supervisor",
                    error = %restore_error,
                    "failed to restore the prior postgres-supervisor config"
                );
            }
            match restart_cluster(app, &prior_config, &effective_password).await {
                Ok(_) => Err(error.context(
                    "apply failed; the prior configuration was restored and the cluster restarted",
                )),
                Err(recovery_error) => Err(error.context(format!(
                    "apply failed AND the recovery restart failed: {recovery_error:#}"
                ))),
            }
        }
    }
}

/// Reset (re-initialise) the embedded cluster (Spec #3022 ST-4): stop → delete the
/// RESOLVED data dir → restart (`setup` re-runs `initdb`) with the CURRENTLY stored
/// keychain password. REFUSES while attached; bounded by [`PG_APPLY_BOUND`]
/// (R-2.1/R-2.2).
#[tauri::command]
pub async fn pg_database_reset(app: AppHandle) -> PgDatabaseResetResult {
    let Some(state) = app.try_state::<Arc<PgSupervisorState>>() else {
        return PgDatabaseResetResult {
            ok: false,
            error: Some("embedded PostgreSQL supervisor is not running".to_string()),
            port: None,
        };
    };
    let _apply = state.apply_lock.lock().await;
    if let Some(reason) = refuse_when_attached(&state) {
        return PgDatabaseResetResult {
            ok: false,
            error: Some(reason),
            port: None,
        };
    }
    match reset_database_inner(&app, &state).await {
        Ok(port) => PgDatabaseResetResult {
            ok: true,
            error: None,
            port: Some(port),
        },
        Err(error) => PgDatabaseResetResult {
            ok: false,
            error: Some(format!("{error:#}")),
            port: None,
        },
    }
}

async fn reset_database_inner(app: &AppHandle, state: &Arc<PgSupervisorState>) -> Result<u16> {
    let store = app.try_state::<Arc<AppStore>>().map(|s| s.inner().clone());
    let os_app_data_dir = app
        .path()
        .app_data_dir()
        .context("resolve the app data dir")?;

    // Stop the runtime (taken out; mutex not held across the await).
    let previous = state.runtime.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut previous) = previous {
        let _ = previous.stop_bounded(PG_STOP_BOUND).await;
        let _ = wait_until(
            || previous.postmaster_pid().is_none(),
            PG_DEATH_WAIT_BOUND,
            Duration::from_millis(100),
        )
        .await;
    }
    if let Some(store) = store.as_ref() {
        persist_pid(store, None);
    }

    // Delete the RESOLVED data dir so `setup` re-initialises it.
    let data_dir = super::resolve_data_dir(&os_app_data_dir);
    if data_dir.exists() {
        std::fs::remove_dir_all(&data_dir)
            .with_context(|| format!("delete the PostgreSQL data dir {}", data_dir.display()))?;
    }

    // Restart on the CURRENT config + the CURRENTLY stored password.
    let config = PgSupervisorConfig::load(&os_app_data_dir);
    let password = ensure_password(&PgCredential::keyring());
    let (port, _pid) = restart_cluster(app, &config, &password).await?;
    tracing::info!(
        target: "fredo::pg_supervisor",
        port,
        "embedded PostgreSQL database reset complete"
    );
    Ok(port)
}

/// Read the effective supervisor config (Spec #3022 ST-4). Carries NO secret
/// field (structural write-only guard for AC5/R-5.1); `configPath` is the absolute
/// `<app_data_dir>/postgres-supervisor.json`.
#[tauri::command]
pub async fn pg_config_get(app: AppHandle) -> PgConfigView {
    config_view(&app)
}

/// The attach connection URL: the headless cluster's published loopback port +
/// the SHARED control-plane credential
/// (`postgresql://postgres:<pw>@<host>:<port>/postgres`). The password is a
/// generated hex token, so no percent-encoding is required.
fn attach_connection_url(host: &str, port: u16, password: &str) -> String {
    format!("postgresql://postgres:{password}@{host}:{port}/postgres")
}

/// The background attach leg (Spec #2992 CU-1, R-3): with the data dir locked by
/// a LIVE headless daemon, build the pool against the published port + the shared
/// credential, run the SAME pre-install schema leg the GUI runs, and publish
/// [`PgState::Attached`].
///
/// Non-goals (enforced structurally): this never acquires the lock, never starts/
/// stops/sweeps the headless postmaster, and holds no runtime — `stop_on_exit`
/// no-ops. A failed pool/schema leg records the fallback reason and leaves the
/// engine Pending (fail-closed), mirroring the GUI's own start path; the
/// supervisor still reports `Attached` because the headless cluster IS serving.
/// Spawned, never awaited in setup (G-273); the pool build is bounded by
/// `PG_POOL_BUILD_BOUND` (G-263).
async fn run_attach(app: AppHandle, headless: HeadlessDescriptor) {
    let state = match app.try_state::<Arc<PgSupervisorState>>() {
        Some(state) => state,
        None => return,
    };
    let store = match app.try_state::<Arc<AppStore>>() {
        Some(store) => store.inner().clone(),
        None => return,
    };
    let engine = app
        .try_state::<Arc<StorageEngineState>>()
        .map(|state| state.inner().clone());

    let password = ensure_password(&PgCredential::keyring());
    let url = attach_connection_url(DEFAULT_PG_HOST, headless.port, &password);
    install_engine_on_pool(&engine, &url).await;
    // Spec #3005 ST-2: hydrate the synchronous cache on the attach leg too.
    let _ = store.hydrate().await;

    state.set_attached(headless.port, headless.pid);
    tracing::info!(
        target: "fredo::pg_supervisor",
        pid = headless.pid,
        port = headless.port,
        "attached to the headless-owned embedded PostgreSQL cluster"
    );
}

/// Resolve a status snapshot to the readiness gate's outcome: `Some(port)` once a
/// cluster is serving (`Ready` or `Attached`), `None` while `Starting` (keep
/// waiting), and `Err` on `Failed`/`Disabled`. Pure so every state — including
/// the CU-1 `Attached` — is unit-testable without a live app handle.
fn readiness_outcome(view: &PgStatusView) -> Result<Option<u16>> {
    match view.state {
        PgState::Ready => Ok(Some(
            view.port
                .context("embedded PostgreSQL reported Ready without a bound port")?,
        )),
        PgState::Attached => Ok(Some(
            view.port
                .context("embedded PostgreSQL reported Attached without a bound port")?,
        )),
        PgState::Failed => Err(anyhow::anyhow!(
            "{}",
            view.error
                .clone()
                .unwrap_or_else(|| "embedded PostgreSQL failed".to_string())
        )),
        PgState::Disabled => Err(anyhow::anyhow!("embedded PostgreSQL is disabled")),
        PgState::Starting => Ok(None),
    }
}

/// The readiness gate later slices' stores block on (bounded).
///
/// Returns the bound port on `Ready`/`Attached`; `Err` on `Disabled`, `Failed`,
/// no managed supervisor, or after `bound` elapses.
pub async fn await_ready(app: &AppHandle, bound: Duration) -> Result<u16> {
    let state = app
        .try_state::<Arc<PgSupervisorState>>()
        .context("embedded PostgreSQL supervisor is not running")?;
    let mut rx = state.status.subscribe();
    let deadline = Instant::now() + bound;
    loop {
        let view = rx.borrow_and_update().clone();
        if let Some(port) = readiness_outcome(&view)? {
            return Ok(port);
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

/// Resolve the managed-PG data dir for read-only observers (the status view and
/// the log tail): the live supervisor's already-resolved dir when present, else
/// the OS app-data dir through the ONE [`super::resolve_data_dir`] rule (FS-1
/// aware). Mirrors the supervisor so the reported `data_dir` and the log path
/// can never diverge.
fn resolve_status_data_dir(app: &AppHandle) -> String {
    if let Some(state) = app.try_state::<Arc<PgSupervisorState>>() {
        return state.status.borrow().data_dir.clone();
    }
    app.path()
        .app_data_dir()
        .map(|dir| super::resolve_data_dir(&dir).display().to_string())
        .unwrap_or_default()
}

/// The ONE observability hook: a read-only status snapshot (no state mutation).
#[tauri::command]
pub async fn pg_supervisor_status(app: AppHandle) -> PgStatusView {
    if let Some(state) = app.try_state::<Arc<PgSupervisorState>>() {
        return state.status.borrow().clone();
    }
    // No managed supervisor ⇒ disabled (the default) — resolve the data dir for
    // informational purposes only (honours the FS-1 override like the live path).
    let data_dir = resolve_status_data_dir(&app);
    PgStatusView {
        state: PgState::Disabled,
        port: None,
        pid: None,
        error: None,
        log_path: log_path_for(&data_dir),
        data_dir,
        failure_kind: None,
        attached: false,
    }
}

// ── Postmaster log tail (Spec #2978 S4 / REQ-3.2) ─────────────────────────────

/// Hard cap on the bytes read from the END of the log for one
/// [`pg_server_log_tail`] call. The tail is always a bounded, read-only window —
/// never a whole-file read.
pub const PG_LOG_TAIL_MAX_BYTES: u64 = 64 * 1024;
/// Hard cap on the number of lines a caller may request, so the returned vector
/// is bounded even for a pathological `lines` argument.
pub const PG_LOG_TAIL_MAX_LINES: usize = 2_000;

/// Read-only tail of the managed postmaster's log
/// (`#[serde(rename_all = "camelCase")]`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgLogTail {
    /// The log path that was read (`<data_dir>/log/postgres.log`).
    pub path: String,
    /// The last `lines` lines of the log (empty when the file does not exist yet).
    pub lines: Vec<String>,
    /// `true` when the returned window does not cover the whole file (the file is
    /// larger than [`PG_LOG_TAIL_MAX_BYTES`], or more lines exist than requested).
    pub truncated: bool,
}

/// Bounded, read-only tail of `path`: at most [`PG_LOG_TAIL_MAX_BYTES`] are read
/// from the end, the first (partial) line is dropped when the read started
/// mid-file, and at most `lines` (capped at [`PG_LOG_TAIL_MAX_LINES`]) are
/// returned. A missing/unreadable file yields an empty tail (never an error and
/// never a whole-file read).
fn tail_file(path: &Path, lines: usize) -> PgLogTail {
    let path_string = path.display().to_string();
    let empty = || PgLogTail {
        path: path_string.clone(),
        lines: Vec::new(),
        truncated: false,
    };

    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return empty(),
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = len.saturating_sub(PG_LOG_TAIL_MAX_BYTES);
    let mut buf = Vec::new();
    let read_ok = std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(start)).is_ok()
        && std::io::Read::read_to_end(
            &mut std::io::Read::take(&mut file, PG_LOG_TAIL_MAX_BYTES),
            &mut buf,
        )
        .is_ok();
    if !read_ok {
        return empty();
    }

    let text = String::from_utf8_lossy(&buf);
    let mut window: Vec<&str> = text.lines().collect();
    // A read that started mid-file begins with a partial line: drop it.
    if start > 0 && !window.is_empty() {
        window.remove(0);
    }
    let total = window.len();
    let requested = lines.min(PG_LOG_TAIL_MAX_LINES);
    let tail: Vec<String> = if total > requested {
        window[total - requested..]
            .iter()
            .map(|line| (*line).to_string())
            .collect()
    } else {
        window.iter().map(|line| (*line).to_string()).collect()
    };
    PgLogTail {
        path: path_string,
        lines: tail,
        truncated: start > 0 || total > requested,
    }
}

/// The bounded, read-only postmaster log tail (REQ-3.2). Registered in `lib.rs`.
/// The `app` handle resolves the SAME data dir the runtime writes to; the
/// frontend-facing argument is only `lines`.
#[tauri::command]
pub async fn pg_server_log_tail(app: AppHandle, lines: usize) -> PgLogTail {
    let data_dir = resolve_status_data_dir(&app);
    if data_dir.trim().is_empty() {
        return PgLogTail {
            path: String::new(),
            lines: Vec::new(),
            truncated: false,
        };
    }
    tail_file(&super::pg_log_path(Path::new(&data_dir)), lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::pg_supervisor::{
        PG_DATA_SUBDIR, PG_LOCK_FILENAME, PG_POOL_FORCE_FAIL_ENV,
    };

    fn open_store(dir: &Path) -> AppStore {
        use crate::infrastructure::storage::engine::EngineHandle;
        AppStore::open(EngineHandle::new_pending(), dir).expect("open app store")
    }

    /// ST-7 (G-290): re-homed from the old password-in-control-plane coverage. The
    /// password resolves ONLY through the OS-keychain seam and is NEVER written to
    /// the synchronous settings cache.
    #[test]
    fn the_postgres_password_resolves_from_the_keychain_not_the_cache() {
        use crate::applications::pg_supervisor::credentials::MemoryPgCredential;

        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let credential = PgCredential::with_store(Arc::new(MemoryPgCredential::with_password(
            "keychain-secret",
        )));

        let password = ensure_password(&credential);
        assert_eq!(password, "keychain-secret", "the keychain credential is reused");
        assert_eq!(
            store.cached_get("postgres.password").expect("read"),
            None,
            "the password is NEVER written to the synchronous settings cache"
        );
        // Reused, never regenerated (within a process).
        assert_eq!(ensure_password(&credential), "keychain-secret");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn bootstrap_acquires_the_lock_before_sweeping() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        match bootstrap(dir.path(), &store) {
            Bootstrap::Locked(lock, data_dir) => {
                assert!(lock.path().exists(), "the lock file is created");
                assert_eq!(lock.path(), dir.path().join(PG_LOCK_FILENAME).as_path());
                assert_eq!(
                    data_dir,
                    dir.path().join(PG_DATA_SUBDIR).display().to_string()
                );
            }
            _ => panic!("a bootstrap must acquire the lock"),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_second_bootstrap_reports_failed_with_a_structured_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let held = PgDataDirLock::acquire(dir.path()).expect("hold the lock");

        match bootstrap(dir.path(), &store) {
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
            log_path: log_path_for("C:/data/postgres"),
            failure_kind: None,
            attached: false,
        };
        let json = serde_json::to_value(&ready).expect("serialize");
        assert_eq!(json["state"], "ready");
        assert_eq!(json["port"], 54321);
        assert_eq!(json["pid"], 1234);
        assert_eq!(json["dataDir"], "C:/data/postgres");
        assert_eq!(
            json["logPath"],
            super::super::pg_log_path(Path::new("C:/data/postgres"))
                .display()
                .to_string()
        );
        assert!(json["error"].is_null());
        // CU-1: the additive `attached` flag is present and false on Ready.
        assert_eq!(json["attached"], false);

        assert_eq!(
            serde_json::to_value(PgState::Disabled).expect("serialize"),
            "disabled"
        );
        assert_eq!(
            serde_json::to_value(PgState::Starting).expect("serialize"),
            "starting"
        );
        assert_eq!(
            serde_json::to_value(PgState::Attached).expect("serialize"),
            "attached",
            "CU-1: the new variant serializes as \"attached\""
        );
        assert_eq!(
            serde_json::to_value(PgState::Failed).expect("serialize"),
            "failed"
        );
    }

    // -- CU-1/ST-2: GUI attach ------------------------------------------------

    /// CU-1/ST-2: `set_attached` publishes the headless cluster's port, marks
    /// `attached: true`, and holds NO runtime/lock (the GUI never owns the
    /// headless postmaster).
    #[test]
    fn set_attached_publishes_the_headless_cluster_without_owning_it() {
        let state = PgSupervisorState::new(None, None, "C:/data/postgres".to_string());
        assert_eq!(state.status.borrow().state, PgState::Starting);

        state.set_attached(54321, 4242);

        let view = state.status.borrow().clone();
        assert_eq!(view.state, PgState::Attached);
        assert!(view.attached, "attached is true while serving a headless cluster");
        assert_eq!(view.port, Some(54321));
        assert_eq!(view.pid, Some(4242), "the owning headless daemon pid");
        assert_eq!(view.error, None);
        assert_eq!(view.data_dir, "C:/data/postgres");
        assert!(
            state.runtime.lock().expect("runtime mutex").is_none(),
            "an attach owns no runtime"
        );
        assert!(
            state.lock.lock().expect("lock mutex").is_none(),
            "an attach holds no lock"
        );

        let json = serde_json::to_value(&view).expect("serialize");
        assert_eq!(json["state"], "attached");
        assert_eq!(json["attached"], true);
        assert_eq!(json["port"], 54321);
    }

    /// CU-1/ST-2: the readiness gate resolves EVERY state, including the new
    /// `Attached` (returns the published port so gated store reads proceed).
    #[test]
    fn readiness_outcome_resolves_every_state_including_attached() {
        let state = PgSupervisorState::new(None, None, "C:/data/postgres".to_string());
        // Starting => keep waiting.
        assert_eq!(
            readiness_outcome(&state.status.borrow().clone()).expect("starting"),
            None
        );

        // Attached => the headless cluster's port.
        state.set_attached(54321, 4242);
        assert_eq!(
            readiness_outcome(&state.status.borrow().clone()).expect("attached"),
            Some(54321)
        );

        // Ready => the owned cluster's port.
        state.set_ready(1111, 2222);
        assert_eq!(
            readiness_outcome(&state.status.borrow().clone()).expect("ready"),
            Some(1111)
        );

        // Failed => the structured error.
        state.fail("readiness", &anyhow::anyhow!("connect refused after 62s"));
        let error = readiness_outcome(&state.status.borrow().clone()).expect_err("failed");
        assert!(error.to_string().contains("connect refused after 62s"), "{error}");

        // Disabled => an error (no serving cluster).
        let disabled = PgStatusView {
            state: PgState::Disabled,
            port: None,
            pid: None,
            error: None,
            data_dir: String::new(),
            log_path: None,
            failure_kind: None,
            attached: false,
        };
        assert!(readiness_outcome(&disabled).is_err());
    }

    /// CU-1/ST-2: the shared pre-install leg is fail-closed — a forced pool
    /// failure records the fallback reason and installs NOTHING.
    #[tokio::test]
    async fn install_engine_on_pool_fails_closed_on_a_forced_pool_failure() {
        use crate::infrastructure::storage::engine::EngineHandle;
        let _lock = SEAM_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(PG_POOL_FORCE_FAIL_ENV, "1");
        let _guard = SeamEnvGuard;

        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle);
        let engine = Some(state.clone());

        install_engine_on_pool(
            &engine,
            "postgresql://postgres:pw@127.0.0.1:1/postgres",
        )
        .await;

        assert!(
            state.fallback_reason().is_some(),
            "a failed leg records the fail-closed reason"
        );
        assert!(
            state.handle().engine().is_none(),
            "a failed leg installs NOTHING (handle stays Pending)"
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

    // -- S4 (#2978): postmaster log path + bounded tail ------------------------

    /// S4 / REQ-3.2: the status view carries the additive `logPath` pointing at
    /// `<data_dir>/log/postgres.log` (camelCase on the wire), and it is `None`
    /// only when no data dir is resolvable.
    #[test]
    fn log_path_is_additive_and_resolves_under_the_data_dir() {
        let view = PgSupervisorState::new(None, None, "C:/data/postgres".to_string());
        let snapshot = view.status.borrow().clone();
        assert_eq!(
            snapshot.log_path,
            Some(
                super::super::pg_log_path(Path::new("C:/data/postgres"))
                    .display()
                    .to_string()
            )
        );
        assert_eq!(
            log_path_for("C:/data/postgres"),
            Some(
                super::super::pg_log_path(Path::new("C:/data/postgres"))
                    .display()
                    .to_string()
            )
        );
        assert_eq!(log_path_for(""), None, "an unknown data dir yields no log path");
        assert_eq!(log_path_for("   "), None, "a blank data dir yields no log path");
    }

    /// S4 / REQ-3.2: the tail returns only the LAST `lines` lines of the log and
    /// reports `truncated` when more lines exist.
    #[test]
    fn pg_log_tail_returns_only_the_last_lines() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("postgres.log");
        std::fs::write(&path, "one\ntwo\nthree\nfour\nfive\n").expect("seed log");

        let tail = tail_file(&path, 2);
        assert_eq!(tail.path, path.display().to_string());
        assert_eq!(tail.lines, vec!["four".to_string(), "five".to_string()]);
        assert!(tail.truncated, "more lines exist than requested");

        let whole = tail_file(&path, 99);
        assert_eq!(whole.lines.len(), 5, "all lines fit within the cap");
        assert!(!whole.truncated, "the whole file fits the requested window");
    }

    /// S4 / REQ-3.2 edge: a missing log (e.g. a failed start) yields an empty
    /// tail — never an error, never a whole-file read.
    #[test]
    fn pg_log_tail_is_empty_when_the_log_is_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("log").join("postgres.log");
        let tail = tail_file(&path, 10);
        assert_eq!(tail.path, path.display().to_string());
        assert!(tail.lines.is_empty());
        assert!(!tail.truncated);
    }

    /// S4 / REQ-3.2: the read is bounded — a log larger than
    /// [`PG_LOG_TAIL_MAX_BYTES`] returns at most [`PG_LOG_TAIL_MAX_LINES`] lines
    /// and reports `truncated`, and it never starts at the file's first line.
    #[test]
    fn pg_log_tail_reads_a_bounded_window_of_a_large_log() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("postgres.log");
        let mut contents = String::new();
        for index in 0..5_000 {
            contents.push_str(&format!("line-{index:05}\n"));
        }
        std::fs::write(&path, contents).expect("seed large log");

        let tail = tail_file(&path, usize::MAX);
        assert!(
            tail.lines.len() <= PG_LOG_TAIL_MAX_LINES,
            "the returned line count must be bounded, got {}",
            tail.lines.len()
        );
        assert!(tail.truncated, "a log larger than the window is truncated");
        assert_eq!(
            tail.lines.last().map(String::as_str),
            Some("line-04999"),
            "the tail must end at the file's last line"
        );
        assert_ne!(
            tail.lines.first().map(String::as_str),
            Some("line-00000"),
            "the bounded read must not start at the file's first line"
        );
    }

    /// S4: `PgLogTail` serializes camelCase (`path`/`lines`/`truncated`).
    #[test]
    fn pg_log_tail_serializes_camel_case() {
        let json = serde_json::to_value(PgLogTail {
            path: "C:/data/postgres/log/postgres.log".to_string(),
            lines: vec!["a".to_string()],
            truncated: true,
        })
        .expect("serialize");
        assert_eq!(json["path"], "C:/data/postgres/log/postgres.log");
        assert_eq!(json["lines"][0], "a");
        assert_eq!(json["truncated"], true);
    }

    // ── ST-4 (#3022): failure classification ──────────────────────────────────

    /// ST-4 / R-3.3: readiness/boot credential rejections (SQLSTATE `28P01` /
    /// `28000`, `password authentication failed`) classify as `AuthMismatch`; a
    /// `start`-stage bind failure classifies as `PortInUse`; everything else is
    /// `Unknown`.
    #[test]
    fn classify_failure_maps_auth_and_bind_failures() {
        let auth_sqlstate = anyhow::anyhow!(
            "error returned from database: password authentication failed for user \"postgres\" (SQLSTATE 28P01)"
        );
        assert_eq!(
            classify_failure("readiness", &auth_sqlstate),
            PgFailureKind::AuthMismatch
        );

        let auth_other = anyhow::anyhow!("db error: invalid authorization specification (28000)");
        assert_eq!(
            classify_failure("readiness", &auth_other),
            PgFailureKind::AuthMismatch
        );

        let bind = anyhow::anyhow!("pg.start failed: could not bind: Address already in use");
        assert_eq!(classify_failure("start", &bind), PgFailureKind::PortInUse);

        // A bind marker is only classified at the `start` stage.
        assert_eq!(
            classify_failure("readiness", &bind),
            PgFailureKind::Unknown
        );

        let other = anyhow::anyhow!("something else entirely");
        assert_eq!(classify_failure("setup", &other), PgFailureKind::Unknown);
    }

    /// ST-4 / R-3.3: `PgSupervisorState::fail` publishes the classified kind, and
    /// `failure_kind` is `None` on every non-Failed state.
    #[test]
    fn fail_publishes_the_classified_failure_kind() {
        let state = PgSupervisorState::new(None, None, "C:/data/postgres".to_string());

        state.fail(
            "readiness",
            &anyhow::anyhow!("password authentication failed (SQLSTATE 28P01)"),
        );
        let view = state.status.borrow().clone();
        assert_eq!(view.state, PgState::Failed);
        assert_eq!(view.failure_kind, Some(PgFailureKind::AuthMismatch));

        state.fail(
            "start",
            &anyhow::anyhow!("could not bind: Address already in use"),
        );
        assert_eq!(
            state.status.borrow().failure_kind,
            Some(PgFailureKind::PortInUse)
        );
    }

    /// ST-4: `PgFailureKind` serializes to the closed camelCase vocabulary, and
    /// `failureKind` is `null` on a `Ready` view.
    #[test]
    fn failure_kind_serializes_camel_case_and_is_null_when_ready() {
        assert_eq!(
            serde_json::to_value(PgFailureKind::AuthMismatch).expect("serialize"),
            "authMismatch"
        );
        assert_eq!(
            serde_json::to_value(PgFailureKind::PortInUse).expect("serialize"),
            "portInUse"
        );
        assert_eq!(
            serde_json::to_value(PgFailureKind::Unknown).expect("serialize"),
            "unknown"
        );

        let state = PgSupervisorState::new(None, None, "C:/data/postgres".to_string());
        state.set_ready(5432, 100);
        let json = serde_json::to_value(state.status.borrow().clone()).expect("serialize");
        assert!(
            json["failureKind"].is_null(),
            "failureKind is null while Ready (Some only while Failed)"
        );

        state.set_attached(5433, 99);
        let json = serde_json::to_value(state.status.borrow().clone()).expect("serialize");
        assert!(json["failureKind"].is_null(), "failureKind is null while Attached");
    }

    // ── ST-4 (#3022): config view + failure-time restore ──────────────────────

    /// ST-4 / AC5: `PgConfigView` serializes camelCase and carries NO password /
    /// secret field (the structural write-only guard).
    #[test]
    fn pg_config_view_serializes_camel_case_without_a_secret() {
        let view = PgConfigView {
            port: Some(5433),
            log_verbosity: PgLogVerbosity::Debug,
            data_dir: "C:/app/postgres".to_string(),
            config_path: "C:/app/postgres-supervisor.json".to_string(),
        };
        let json = serde_json::to_value(&view).expect("serialize");
        assert_eq!(json["port"], 5433);
        assert_eq!(json["logVerbosity"], "debug1");
        assert_eq!(json["dataDir"], "C:/app/postgres");
        assert_eq!(json["configPath"], "C:/app/postgres-supervisor.json");
        assert!(json.get("password").is_none(), "no password field on the wire");
        assert!(json.get("newPassword").is_none(), "no newPassword field on the wire");
        assert!(json.get("secret").is_none());

        // The ephemeral default serializes `port: null`.
        let ephemeral = PgConfigView {
            port: None,
            log_verbosity: PgLogVerbosity::Info,
            data_dir: String::new(),
            config_path: String::new(),
        };
        assert!(serde_json::to_value(ephemeral).expect("serialize")["port"].is_null());
    }

    /// ST-4 / R-1.2: the config snapshot/restore pair round-trips raw bytes
    /// atomically, and a `None` snapshot (the file did not exist) removes it.
    #[test]
    fn config_snapshot_and_restore_round_trips_and_removes_an_absent_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("postgres-supervisor.json");

        // Absent file ⇒ None snapshot; restoring None leaves it absent.
        assert_eq!(snapshot_config(&path), None);
        restore_config(&path, &None).expect("restore none");
        assert!(!path.exists());

        // Present file ⇒ byte snapshot; restore returns it byte-identically.
        let original = br#"{"port": 5433, "logVerbosity": "debug1"}"#.to_vec();
        std::fs::write(&path, &original).expect("seed");
        let snapshot = snapshot_config(&path);
        assert_eq!(snapshot.as_deref(), Some(original.as_slice()));

        std::fs::write(&path, b"mutated").expect("mutate");
        restore_config(&path, &snapshot).expect("restore");
        assert_eq!(std::fs::read(&path).expect("read"), original);

        // The restore is atomic: no temp file remains.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp file must remain: {leftovers:?}");
    }

    /// ST-4 / R-5.2: the apply/reset refusal fires ONLY on the attached state.
    #[test]
    fn refuse_when_attached_blocks_apply_on_a_headless_cluster() {
        let state = PgSupervisorState::new(None, None, "C:/data/postgres".to_string());
        assert_eq!(refuse_when_attached(&state), None, "Starting is not attached");

        state.set_ready(5432, 1);
        assert_eq!(refuse_when_attached(&state), None, "Ready is not attached");

        state.set_attached(5433, 99);
        assert!(
            refuse_when_attached(&state).is_some(),
            "Attached must be refused (the GUI does not own the headless cluster)"
        );
    }

    /// ST-4 / R-1.3: the compensating-revert URL replacement touches only the
    /// credential segment.
    #[test]
    fn url_with_password_replaces_only_the_credential() {
        let url = "postgresql://postgres:oldpw@127.0.0.1:5432/postgres";
        assert_eq!(
            url_with_password(url, "oldpw", "newpw"),
            "postgresql://postgres:newpw@127.0.0.1:5432/postgres"
        );
        // A blank source password cannot be compensated — the URL is unchanged.
        assert_eq!(url_with_password(url, "", "newpw"), url);
    }
}
