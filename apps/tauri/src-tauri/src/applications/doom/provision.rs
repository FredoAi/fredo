//! Doom engine provisioning (Spec #3012, ST-2): first-use build from the
//! vendored in-repo source.
//!
//! This module owns the bounded, cancellable, typed provisioning state machine
//! that turns a fresh install dir into a runnable
//! `<install_dir>/engine/restful-doom.exe`:
//!
//! 1. resolve a usable toolchain root **only** from `FREDO_DOOM_TOOLCHAIN_ROOT`
//!    or the managed `<install_dir>/toolchain/msys2` (never a filesystem search,
//!    G-172);
//! 2. when none is usable and the run is not offline, download the pinned MSYS2
//!    base archive through Fredo's ONE streaming acquisition engine
//!    ([`acquisition::acquire_archive_with`]) with a REAL [`ProgressReporter`]
//!    that emits `doom-provision-progress`, then extract it **in-process**
//!    (pure-Rust xz decode → Rust `tar` crate) so the managed path never depends
//!    on a host PATH `tar` (ST-6, F-78);
//! 3. build the vendored source by spawning
//!    `scripts/doom/build-restful-doom.ps1 -SourceDir <vendor> -Msys2Root <root>`
//!    and parsing its stderr `STEP` markers;
//! 4. stage + verify the engine.
//!
//! # G-263 (bounded, cancellable, no orphan)
//!
//! Every wait is wall-clock bounded and hard-killed with
//! [`process::kill_pid_tree`] on every exit path: the toolchain download is
//! wrapped in `tokio::time::timeout`, the extract race is a `spawn_blocking`
//! task raced against the cancel flag and an absolute deadline (a blocked
//! thread spawns no OS process, so there is no orphan to face for it), and the
//! build child is raced against the cancel flag and an absolute deadline,
//! hard-killing the whole child tree (`powershell → bash → make`) when either
//! fires. The three bounds are read through their test-only env seams (inert
//! when unset; defaults 1800/900/900 s) so the bounded-timeout AC is live-inducible.
//!
//! Nothing here changes the engine resolver order or the mode lifecycle — it
//! only makes the staged candidate exist (ST-3 wires first activation).

use std::collections::VecDeque;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncBufReadExt;

use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::companion::download::{
    DownloadProgress, ProgressReporter, ReqwestTransport,
};
use crate::infrastructure::companion::models::{ModelFileSpec, ModelManifest};
use crate::infrastructure::storage::AppStore;

use super::acquisition::{self, LocalFileTransport};
use super::process;
use super::state::{
    DOOM_INSTALL_DIR_ENV, DOOM_INSTALL_DIR_KEY, DOOM_INSTALL_SUBDIR,
};

// ── Binding names (Spec #3012 Names Block) ────────────────────────────────────

/// The ONLY provisioning progress event: a global broadcast whose payload is
/// [`DoomProvisionStatus`] (nested `progress`).
pub const DOOM_PROVISION_EVENT: &str = "doom-provision-progress";

/// Vendored source subdirectory inside the build-inputs root.
pub const DOOM_VENDOR_SUBDIR: &str = "vendor/restful-doom";
/// The pinned RESTful-DOOM commit the vendored tree + staged marker carry.
pub const DOOM_VENDOR_COMMIT: &str = "eded41b5597b7738ec1fa06d24f62b53db982c2c";
/// The staged-engine commit marker filename (written by the build script).
pub const DOOM_ENGINE_COMMIT_MARKER: &str = ".restful-doom-commit";
/// The managed-toolchain subdirectory under the install dir.
pub const DOOM_TOOLCHAIN_SUBDIR: &str = "toolchain";
/// The usable-root probe relative to a toolchain root.
pub const DOOM_TOOLCHAIN_BASH_REL: &str = "usr/bin/bash.exe";
/// Intermediate `.tar` decoded from the pinned `.tar.xz` (under the toolchain
/// dir); removed once the tar is extracted (ST-6).
const DOOM_TOOLCHAIN_TAR_TMP: &str = ".msys2-extract.tar";
/// The staging dir the archive is unpacked into before the final move.
const DOOM_TOOLCHAIN_STAGING_DIR: &str = ".msys2-extract";
/// Script basename that builds the engine.
pub const DOOM_BUILD_SCRIPT_BASENAME: &str = "build-restful-doom.ps1";

// ── Bounded-timeout constants + env seams (G-263 / G-275) ─────────────────────

/// Test-only overall provisioning bound override, in seconds (inert when unset).
pub const DOOM_PROVISION_TIMEOUT_ENV: &str = "FREDO_DOOM_PROVISION_TIMEOUT_S";
/// Test-only toolchain download(+extract) bound override, in seconds.
pub const DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_ENV: &str = "FREDO_DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_S";
/// Test-only build bound override, in seconds.
pub const DOOM_BUILD_TIMEOUT_ENV: &str = "FREDO_DOOM_BUILD_TIMEOUT_S";
/// Overall provisioning bound (default).
pub const DOOM_PROVISION_TIMEOUT_S: u64 = 1800;
/// Toolchain download + extraction bound (default).
pub const DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_S: u64 = 900;
/// Engine build bound (default).
pub const DOOM_BUILD_TIMEOUT_S: u64 = 900;
/// Cancel hard-kill bound (default).
pub const DOOM_PROVISION_STOP_TIMEOUT_S: u64 = 5;

/// Explicit toolchain root override (never a search).
pub const DOOM_TOOLCHAIN_ROOT_ENV: &str = "FREDO_DOOM_TOOLCHAIN_ROOT";
/// Toolchain archive URL override — `http(s)://` OR `file://`/plain path.
pub const DOOM_TOOLCHAIN_URL_ENV: &str = "FREDO_DOOM_TOOLCHAIN_ARCHIVE_URL";
/// Toolchain archive SHA-256 override.
pub const DOOM_TOOLCHAIN_SHA256_ENV: &str = "FREDO_DOOM_TOOLCHAIN_ARCHIVE_SHA256";
/// Toolchain archive byte-count override.
pub const DOOM_TOOLCHAIN_BYTES_ENV: &str = "FREDO_DOOM_TOOLCHAIN_ARCHIVE_BYTES";
/// Vendored source tree override (build inputs).
pub const DOOM_SOURCE_DIR_ENV: &str = "FREDO_DOOM_SOURCE_DIR";
/// Build-inputs root override (contains `vendor/` + `scripts/doom`).
pub const DOOM_BUILD_ROOT_ENV: &str = "FREDO_DOOM_BUILD_ROOT";
/// Existing offline flag (honoured, fails closed before any network).
pub const DOOM_PROVISION_OFFLINE_ENV: &str = "FREDO_DOOM_BUILD_OFFLINE";

/// The build script's machine-readable step marker prefix (stderr).
const BUILD_STEP_MARKER: &str = "[build-restful-doom] STEP ";
/// How many trailing non-`STEP` stderr lines a build failure carries (ST-11).
const BUILD_STDERR_TAIL_LINES: usize = 8;

// ── Managed toolchain pin (transcribed from scripts/doom/README.md, G-320) ────

/// The pinned managed MSYS2 base archive (ST-1 enforcing-fetch values).
pub struct DoomToolchainPin {
    /// Archive URL.
    pub url: &'static str,
    /// Archive SHA-256 (lowercase hex).
    pub sha256: &'static str,
    /// Exact archive byte count.
    pub bytes: u64,
    /// Archive filename.
    pub archive_filename: &'static str,
}

/// The ST-1-recorded pin (G-320: transcribed from `scripts/doom/README.md`).
pub const DOOM_TOOLCHAIN_PIN: DoomToolchainPin = DoomToolchainPin {
    url: "https://repo.msys2.org/distrib/x86_64/msys2-base-x86_64-20260927.tar.xz",
    sha256: "ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322",
    bytes: 42_860_696,
    archive_filename: "msys2-base-x86_64-20260927.tar.xz",
};

/// The resolved toolchain archive spec (env overrides the pin per field).
#[derive(Clone, Debug)]
pub struct DoomToolchainArchive {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

// ── Wire vocabulary ───────────────────────────────────────────────────────────

/// The provisioning phase (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomProvisionPhase {
    /// Nothing in flight; the engine may already be staged.
    Idle,
    /// The owner must choose a directory before any download.
    AwaitingInstallDir,
    /// Downloading (or extracting) the managed toolchain.
    DownloadingToolchain,
    /// Building the vendored engine source.
    Building,
    /// The engine is staged at `<install_dir>/engine/restful-doom.exe`.
    Ready,
    /// The last run failed; `last_error`/`code` describe why.
    Failed,
    /// The last run was cancelled.
    Cancelled,
}

impl DoomProvisionPhase {
    /// The stable wire string (`#[serde(rename_all = "camelCase")]`).
    pub fn as_str(self) -> &'static str {
        match self {
            DoomProvisionPhase::Idle => "idle",
            DoomProvisionPhase::AwaitingInstallDir => "awaitingInstallDir",
            DoomProvisionPhase::DownloadingToolchain => "downloadingToolchain",
            DoomProvisionPhase::Building => "building",
            DoomProvisionPhase::Ready => "ready",
            DoomProvisionPhase::Failed => "failed",
            DoomProvisionPhase::Cancelled => "cancelled",
        }
    }
}

/// The typed provisioning failure vocabulary (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomProvisionErrorCode {
    /// The install dir is missing/unwritable.
    InstallDirInvalid,
    /// Offline requested, or no usable/pinned toolchain.
    ToolchainUnavailable,
    /// The toolchain archive download failed (or its pin did not verify).
    ToolchainDownloadFailed,
    /// The downloaded archive could not be unpacked.
    ToolchainExtractFailed,
    /// The vendored source tree / build script is missing.
    SourceMissing,
    /// The engine build failed.
    BuildFailed,
    /// Provisioning exceeded its wall-clock bound (hard-killed).
    Timeout,
    /// Provisioning was cancelled by the owner.
    Cancelled,
}

impl DoomProvisionErrorCode {
    /// The stable wire string (`#[serde(rename_all = "camelCase")]`).
    pub fn as_str(self) -> &'static str {
        match self {
            DoomProvisionErrorCode::InstallDirInvalid => "installDirInvalid",
            DoomProvisionErrorCode::ToolchainUnavailable => "toolchainUnavailable",
            DoomProvisionErrorCode::ToolchainDownloadFailed => "toolchainDownloadFailed",
            DoomProvisionErrorCode::ToolchainExtractFailed => "toolchainExtractFailed",
            DoomProvisionErrorCode::SourceMissing => "sourceMissing",
            DoomProvisionErrorCode::BuildFailed => "buildFailed",
            DoomProvisionErrorCode::Timeout => "timeout",
            DoomProvisionErrorCode::Cancelled => "cancelled",
        }
    }

    /// Parse the wire string back to the typed code (`None` when unknown).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "installDirInvalid" => Some(DoomProvisionErrorCode::InstallDirInvalid),
            "toolchainUnavailable" => Some(DoomProvisionErrorCode::ToolchainUnavailable),
            "toolchainDownloadFailed" => Some(DoomProvisionErrorCode::ToolchainDownloadFailed),
            "toolchainExtractFailed" => Some(DoomProvisionErrorCode::ToolchainExtractFailed),
            "sourceMissing" => Some(DoomProvisionErrorCode::SourceMissing),
            "buildFailed" => Some(DoomProvisionErrorCode::BuildFailed),
            "timeout" => Some(DoomProvisionErrorCode::Timeout),
            "cancelled" => Some(DoomProvisionErrorCode::Cancelled),
            _ => None,
        }
    }
}

/// Per-tick provisioning detail carried on [`DoomProvisionStatus`].
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomProvisionProgress {
    pub phase: DoomProvisionPhase,
    pub step: String,
    pub message: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
    pub elapsed_ms: u64,
}

/// The provisioning status — the payload of `doom-provision-progress` AND the
/// return of `get_doom_provision_status` (exactly ONE shape).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomProvisionStatus {
    pub phase: DoomProvisionPhase,
    pub running: bool,
    pub needs_install_dir: bool,
    pub install_dir: Option<String>,
    pub install_dir_default: String,
    pub engine_path: Option<String>,
    pub progress: Option<DoomProvisionProgress>,
    pub last_error: Option<String>,
    pub code: Option<DoomProvisionErrorCode>,
}

/// Result of `provision_doom_engine` — returned immediately (the event is truth).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomProvisionResult {
    pub success: bool,
    pub phase: DoomProvisionPhase,
    pub needs_install_dir: bool,
    pub engine_path: Option<String>,
    pub error: Option<String>,
    pub code: Option<DoomProvisionErrorCode>,
}

// ── Managed state ─────────────────────────────────────────────────────────────

/// Tauri-managed provisioning state. The mutex guards only a short synchronous
/// section — it is never held across an `.await`.
#[derive(Default)]
pub struct DoomProvisionState(pub Mutex<DoomProvisionInner>);

/// The provisioning core: phase + the live run's cancel flag + last detail.
pub struct DoomProvisionInner {
    phase: DoomProvisionPhase,
    running: bool,
    install_dir: Option<String>,
    progress: Option<DoomProvisionProgress>,
    last_error: Option<String>,
    code: Option<DoomProvisionErrorCode>,
    cancel: Option<Arc<AtomicBool>>,
}

impl Default for DoomProvisionInner {
    fn default() -> Self {
        Self {
            phase: DoomProvisionPhase::Idle,
            running: false,
            install_dir: None,
            progress: None,
            last_error: None,
            code: None,
            cancel: None,
        }
    }
}

impl DoomProvisionState {
    /// A poisoned lock must never take down the app — recover the guard.
    fn lock(&self) -> MutexGuard<'_, DoomProvisionInner> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Atomically begin a run. `false` when one is already running (idempotent —
    /// a second trigger never starts a second task).
    pub fn begin(&self, install_dir: String, cancel: Arc<AtomicBool>) -> bool {
        let mut inner = self.lock();
        if inner.running {
            return false;
        }
        inner.phase = DoomProvisionPhase::DownloadingToolchain;
        inner.running = true;
        inner.install_dir = Some(install_dir);
        inner.progress = None;
        inner.last_error = None;
        inner.code = None;
        inner.cancel = Some(cancel);
        true
    }

    fn set_phase(&self, phase: DoomProvisionPhase) {
        self.lock().phase = phase;
    }

    fn set_progress(&self, progress: Option<DoomProvisionProgress>) {
        self.lock().progress = progress;
    }

    /// A live run is in flight.
    pub fn is_running(&self) -> bool {
        self.lock().running
    }

    /// Mark a successful run (`ready`).
    fn finish_ready(&self) {
        let mut inner = self.lock();
        inner.phase = DoomProvisionPhase::Ready;
        inner.running = false;
        inner.progress = None;
        inner.last_error = None;
        inner.code = None;
        inner.cancel = None;
    }

    /// Mark a failed run with its typed cause.
    fn finish_failed(&self, code: DoomProvisionErrorCode, message: String) {
        let mut inner = self.lock();
        inner.phase = DoomProvisionPhase::Failed;
        inner.running = false;
        inner.progress = None;
        inner.last_error = Some(message);
        inner.code = Some(code);
        inner.cancel = None;
    }

    /// Mark a cancelled run.
    fn finish_cancelled(&self) {
        let mut inner = self.lock();
        inner.phase = DoomProvisionPhase::Cancelled;
        inner.running = false;
        inner.progress = None;
        inner.last_error = Some("Doom engine setup was cancelled — no engine was installed.".to_string());
        inner.code = Some(DoomProvisionErrorCode::Cancelled);
        inner.cancel = None;
    }

    /// Request cancellation of the live run. `false` when idle (idempotent).
    pub fn request_cancel(&self) -> bool {
        let inner = self.lock();
        match inner.cancel.as_ref() {
            Some(flag) if inner.running => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    }

    /// A snapshot of the state (never holds the lock).
    fn snapshot(
        &self,
    ) -> (
        DoomProvisionPhase,
        bool,
        Option<String>,
        Option<DoomProvisionProgress>,
        Option<String>,
        Option<DoomProvisionErrorCode>,
    ) {
        let inner = self.lock();
        (
            inner.phase,
            inner.running,
            inner.install_dir.clone(),
            inner.progress.clone(),
            inner.last_error.clone(),
            inner.code,
        )
    }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/// A non-blank environment value, trimmed; `None` when unset or blank.
fn non_blank_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_u64(name: &str) -> Option<u64> {
    non_blank_env(name).and_then(|value| value.parse().ok())
}

/// The overall provisioning bound (env seam → default).
pub fn overall_timeout() -> Duration {
    Duration::from_secs(env_u64(DOOM_PROVISION_TIMEOUT_ENV).unwrap_or(DOOM_PROVISION_TIMEOUT_S))
}

/// The toolchain download+extract bound (env seam → default).
fn download_timeout() -> Duration {
    Duration::from_secs(
        env_u64(DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_ENV).unwrap_or(DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_S),
    )
}

/// The engine build bound (env seam → default).
fn build_timeout() -> Duration {
    Duration::from_secs(env_u64(DOOM_BUILD_TIMEOUT_ENV).unwrap_or(DOOM_BUILD_TIMEOUT_S))
}

/// Whether the offline flag (`FREDO_DOOM_BUILD_OFFLINE=1`) is set.
fn offline_requested() -> bool {
    non_blank_env(DOOM_PROVISION_OFFLINE_ENV).as_deref() == Some("1")
}

/// The resolved toolchain archive (env override per field, else the pin).
pub fn toolchain_archive_spec() -> DoomToolchainArchive {
    DoomToolchainArchive {
        url: non_blank_env(DOOM_TOOLCHAIN_URL_ENV)
            .unwrap_or_else(|| DOOM_TOOLCHAIN_PIN.url.to_string()),
        sha256: non_blank_env(DOOM_TOOLCHAIN_SHA256_ENV)
            .unwrap_or_else(|| DOOM_TOOLCHAIN_PIN.sha256.to_string()),
        bytes: non_blank_env(DOOM_TOOLCHAIN_BYTES_ENV)
            .and_then(|value| value.parse().ok())
            .unwrap_or(DOOM_TOOLCHAIN_PIN.bytes),
    }
}

/// The destination filename for a toolchain archive URL/path (last path segment,
/// query/fragment stripped; the pin filename when empty).
pub fn archive_filename_for(url: &str) -> String {
    let no_query = url.split(['?', '#']).next().unwrap_or(url);
    let name = no_query
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        DOOM_TOOLCHAIN_PIN.archive_filename.to_string()
    } else {
        name
    }
}

/// Strip the Windows verbatim (`\\?\`) prefix from a path (ST-15).
///
/// The app must never hand a verbatim path to a non-Rust child: PowerShell 5.1
/// and MSYS2 cannot process the verbatim form (they raise `Cannot process
/// argument because the value of argument "drive" is null`). This is a pure
/// string operation (no `cfg`, no dependency) over the raw path text, so it
/// unit-tests on every platform.
///
/// - `\\?\C:\a\b` → `C:\a\b` (device path)
/// - `\\?\UNC\server\share\x` → `\\server\share\x` (UNC device path)
/// - any other path is returned unchanged (no-op)
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.as_os_str().to_string_lossy();
    // The UNC form must be matched before the generic `\\?\` prefix.
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// A usable toolchain root has `<root>/usr/bin/bash.exe`.
fn usable_root(root: &Path) -> bool {
    let mut probe = root.to_path_buf();
    for part in DOOM_TOOLCHAIN_BASH_REL.split('/') {
        probe.push(part);
    }
    probe.is_file()
}

/// Resolve a usable toolchain root: the explicit `FREDO_DOOM_TOOLCHAIN_ROOT`
/// seam when usable, else the managed `<install_dir>/toolchain/msys2`. NEVER a
/// filesystem search (G-172).
fn resolve_toolchain_root(install_dir: &Path) -> Option<PathBuf> {
    if let Some(env) = non_blank_env(DOOM_TOOLCHAIN_ROOT_ENV) {
        let candidate = PathBuf::from(env);
        if usable_root(&candidate) {
            return Some(candidate);
        }
    }
    let managed = install_dir.join(DOOM_TOOLCHAIN_SUBDIR).join("msys2");
    usable_root(&managed).then_some(managed)
}

/// The base directory holding the in-repo `vendor/` + `scripts/doom` build
/// inputs: explicit `FREDO_DOOM_BUILD_ROOT` env → the compile-time repo root.
/// (The bundled resource dir is handled in [`resolve_source_dir`] /
/// [`resolve_build_script`].)
pub fn resolve_build_inputs_root(_app: &AppHandle) -> Option<PathBuf> {
    if let Some(env) = non_blank_env(DOOM_BUILD_ROOT_ENV) {
        let candidate = PathBuf::from(env);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    // The compile-time manifest dir is `apps/tauri/src-tauri`; the repo root is
    // three levels up. Used in dev/QA; a shipped build resolves the bundled
    // resources first (see resolve_source_dir + resolve_build_script).
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
}

/// Resolve the RESTful-DOOM source tree: `FREDO_DOOM_SOURCE_DIR` override →
/// (debug) workspace `<root>/vendor/restful-doom` → bundled
/// `<resource>/doom/source` → `<root>/vendor/restful-doom`.
///
/// Workspace-first in dev (ST-15): `resource_dir()` yields a stale
/// `target/debug/doom/*` snapshot AND a Windows verbatim `\\?\` path; the
/// compile-time repo checkout (env-overridable via `FREDO_DOOM_BUILD_ROOT`) is
/// the correct dev source, mirroring `applications/setup/commands.rs`. The
/// bundled resource dir remains the packaged-release fallback.
pub fn resolve_source_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Some(env) = non_blank_env(DOOM_SOURCE_DIR_ENV) {
        return Some(PathBuf::from(env));
    }
    if cfg!(debug_assertions) {
        if let Some(root) = resolve_build_inputs_root(app) {
            let workspace = root.join("vendor").join("restful-doom");
            if workspace.join("configure.ac").is_file() {
                return Some(workspace);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("doom").join("source");
        if bundled.join("configure.ac").is_file() {
            return Some(bundled);
        }
    }
    let root = resolve_build_inputs_root(app)?;
    Some(root.join("vendor").join("restful-doom"))
}

/// Resolve the build script: (debug) workspace
/// `<root>/scripts/doom/<basename>` → bundled
/// `<resource>/doom/scripts/<basename>` → `<root>/scripts/doom/<basename>`.
///
/// Workspace-first in dev (ST-15), same rationale as [`resolve_source_dir`].
pub fn resolve_build_script(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(root) = resolve_build_inputs_root(app) {
            let workspace = root
                .join("scripts")
                .join("doom")
                .join(DOOM_BUILD_SCRIPT_BASENAME);
            if workspace.is_file() {
                return Some(workspace);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir
            .join("doom")
            .join("scripts")
            .join(DOOM_BUILD_SCRIPT_BASENAME);
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    let root = resolve_build_inputs_root(app)?;
    Some(root.join("scripts").join("doom").join(DOOM_BUILD_SCRIPT_BASENAME))
}

/// The stored install-dir override (env `FREDO_DOOM_INSTALL_DIR` → setting
/// `doom_install_dir`), non-blank trimmed. `None` means the owner must choose.
pub fn configured_install_dir(app: &AppHandle) -> Option<String> {
    if let Some(env) = non_blank_env(DOOM_INSTALL_DIR_ENV) {
        return Some(env);
    }
    app.state::<Arc<AppStore>>()
        .cached_get(DOOM_INSTALL_DIR_KEY)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The product-default install dir `{app_data_dir}/doom`.
pub fn default_install_dir(app: &AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|base| base.join(DOOM_INSTALL_SUBDIR).to_string_lossy().into_owned())
        .unwrap_or_else(|_| DOOM_INSTALL_SUBDIR.to_string())
}

/// Whether the staged engine at `<install_dir>/engine/restful-doom.exe` exists,
/// is a PE image, and carries the pinned commit marker. `Some(path)` = staged.
pub fn staged_engine_path(install_dir: &Path) -> Option<String> {
    let exe = acquisition::engine_exe_path(install_dir);
    if !exe.is_file() {
        return None;
    }
    let marker = exe.parent()?.join(DOOM_ENGINE_COMMIT_MARKER);
    let commit = std::fs::read_to_string(&marker).ok()?;
    if commit.trim() != DOOM_VENDOR_COMMIT {
        return None;
    }
    let head = {
        use std::io::Read;
        let mut file = std::fs::File::open(&exe).ok()?;
        let mut magic = [0u8; 2];
        file.read_exact(&mut magic).ok()?;
        magic
    };
    if &head != b"MZ" {
        return None;
    }
    Some(exe.to_string_lossy().into_owned())
}

/// Whether a usable pinned engine is already staged.
pub fn is_engine_staged(install_dir: &Path) -> bool {
    staged_engine_path(install_dir).is_some()
}

/// The display phase for a status snapshot: a live run reports its phase; a
/// staged engine is `idle`; a terminal failure/cancel is preserved; otherwise a
/// missing stored dir is `awaitingInstallDir`.
fn display_phase(
    phase: DoomProvisionPhase,
    running: bool,
    engine_staged: bool,
    needs_install_dir: bool,
) -> DoomProvisionPhase {
    if running {
        return phase;
    }
    if engine_staged {
        return DoomProvisionPhase::Idle;
    }
    match phase {
        DoomProvisionPhase::Failed | DoomProvisionPhase::Cancelled => phase,
        _ if needs_install_dir => DoomProvisionPhase::AwaitingInstallDir,
        _ => DoomProvisionPhase::Idle,
    }
}

/// Build the live status snapshot from the managed state + the stored dir +
/// disk staging.
pub fn build_status(app: &AppHandle) -> DoomProvisionStatus {
    let default_dir = default_install_dir(app);
    let stored = configured_install_dir(app);
    let stored_path = stored.as_ref().map(PathBuf::from);
    let engine_path = stored_path
        .as_deref()
        .and_then(staged_engine_path);
    let engine_staged = engine_path.is_some();
    let needs_install_dir = stored.is_none() && !engine_staged;

    let (phase, running, state_install, progress, last_error, code) =
        app.state::<DoomProvisionState>().snapshot();
    let phase = display_phase(phase, running, engine_staged, needs_install_dir);

    DoomProvisionStatus {
        phase,
        running,
        needs_install_dir,
        install_dir: state_install.or(stored),
        install_dir_default: default_dir,
        engine_path,
        progress,
        last_error,
        code,
    }
}

/// Emit the status on the global `doom-provision-progress` broadcast.
fn publish(app: &AppHandle, status: &DoomProvisionStatus) {
    app.state::<EventBus>()
        .emit_global(DOOM_PROVISION_EVENT, status);
}

/// Emit a status with an explicit phase (the event is the source of truth — a
/// completed run emits `ready` even though the poll snapshot then reads `idle`).
fn publish_phase(app: &AppHandle, phase: DoomProvisionPhase) {
    let mut status = build_status(app);
    status.phase = phase;
    publish(app, &status);
}

fn now_elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

// ── Progress reporter ─────────────────────────────────────────────────────────

/// The REAL progress sink for the toolchain download: maps each
/// [`DownloadProgress`] tick onto a `doom-provision-progress` emission.
struct DoomProvisionReporter {
    app: AppHandle,
    started: Instant,
}

impl ProgressReporter for DoomProvisionReporter {
    fn report(&self, progress: DownloadProgress) {
        let detail = DoomProvisionProgress {
            phase: DoomProvisionPhase::DownloadingToolchain,
            step: "toolchain".to_string(),
            message: format!(
                "{} — {} of {} bytes",
                progress.file, progress.downloaded, progress.total
            ),
            downloaded: progress.downloaded,
            total: progress.total,
            percent: progress.percent,
            elapsed_ms: now_elapsed_ms(self.started),
        };
        let state = self.app.state::<DoomProvisionState>();
        state.set_phase(DoomProvisionPhase::DownloadingToolchain);
        state.set_progress(Some(detail));
        publish_phase(&self.app, DoomProvisionPhase::DownloadingToolchain);
    }
}

// ── The run ───────────────────────────────────────────────────────────────────

/// A typed provisioning failure that maps to a phase + code.
#[derive(Debug)]
enum ProvisionFailure {
    Code(DoomProvisionErrorCode, String),
    Timeout,
    Cancelled,
}

/// Shared borrows for one provisioning run.
struct ProvisionRun<'a> {
    app: &'a AppHandle,
    install_dir: &'a Path,
    cancel: &'a Arc<AtomicBool>,
    started: Instant,
}

/// Poll the cancel flag (a future that resolves once cancellation is requested).
async fn wait_cancel(flag: &Arc<AtomicBool>) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The remaining time before an absolute deadline.
fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// Acquire + extract the managed toolchain, streaming download progress.
async fn acquire_toolchain(
    run: &ProvisionRun<'_>,
    deadline: Instant,
) -> Result<PathBuf, ProvisionFailure> {
    let spec = toolchain_archive_spec();
    let filename = archive_filename_for(&spec.url);
    let manifest = ModelManifest {
        revision: "toolchain".to_string(),
        subdir: DOOM_TOOLCHAIN_SUBDIR.to_string(),
        files: vec![ModelFileSpec {
            id: "toolchain".to_string(),
            path: filename.clone(),
            url: spec.url.clone(),
            expected_bytes: spec.bytes,
            sha256: Some(spec.sha256.clone()),
        }],
    };

    let state = run.app.state::<DoomProvisionState>();
    state.set_phase(DoomProvisionPhase::DownloadingToolchain);
    state.set_progress(Some(DoomProvisionProgress {
        phase: DoomProvisionPhase::DownloadingToolchain,
        step: "toolchain".to_string(),
        message: format!("Downloading the build toolchain ({filename})"),
        downloaded: 0,
        total: spec.bytes,
        percent: 0.0,
        elapsed_ms: now_elapsed_ms(run.started),
    }));
    publish_phase(run.app, DoomProvisionPhase::DownloadingToolchain);

    let budget = remaining(deadline).min(download_timeout());
    if budget.is_zero() {
        return Err(ProvisionFailure::Timeout);
    }
    let reporter = DoomProvisionReporter {
        app: run.app.clone(),
        started: run.started,
    };
    let download = download_archive(run.install_dir, &manifest, &spec, &reporter);
    let archive = tokio::select! {
        result = tokio::time::timeout(budget, download) => match result {
            Ok(Ok(path)) => path,
            Ok(Err(detail)) => {
                return Err(ProvisionFailure::Code(
                    DoomProvisionErrorCode::ToolchainDownloadFailed,
                    detail,
                ))
            }
            Err(_) => return Err(ProvisionFailure::Timeout),
        },
        _ = wait_cancel(run.cancel) => return Err(ProvisionFailure::Cancelled),
    };

    let extract_budget = remaining(deadline).min(download_timeout());
    if extract_budget.is_zero() {
        return Err(ProvisionFailure::Timeout);
    }
    extract_archive(run, &archive, extract_budget).await?;

    let root = run.install_dir.join(DOOM_TOOLCHAIN_SUBDIR).join("msys2");
    if !usable_root(&root) {
        return Err(ProvisionFailure::Code(
            DoomProvisionErrorCode::ToolchainExtractFailed,
            format!(
                "the toolchain archive did not produce {}",
                root.join(DOOM_TOOLCHAIN_BASH_REL).display()
            ),
        ));
    }
    Ok(root)
}

/// Download the toolchain archive through the shared engine, routing a local
/// (`file://`/path) source to [`LocalFileTransport`] and `http(s)://` to reqwest.
async fn download_archive(
    install_dir: &Path,
    manifest: &ModelManifest,
    spec: &DoomToolchainArchive,
    reporter: &DoomProvisionReporter,
) -> Result<PathBuf, String> {
    if acquisition::is_local_source(&spec.url) {
        let transport = LocalFileTransport::new();
        acquisition::acquire_archive_with(&transport, install_dir, manifest, reporter).await
    } else {
        let transport = ReqwestTransport::new()
            .map_err(|error| format!("could not build the download client: {error}"))?;
        acquisition::acquire_archive_with(&transport, install_dir, manifest, reporter).await
    }
}

/// The extracted root inside `staging` that contains `usr/bin/bash.exe`.
fn find_extracted_root(staging: &Path) -> Option<PathBuf> {
    if usable_root(staging) {
        return Some(staging.to_path_buf());
    }
    for entry in std::fs::read_dir(staging).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() && usable_root(&path) {
            return Some(path);
        }
    }
    None
}

/// A `toolchainExtractFailed` failure carrying a detail message.
fn extract_failed(message: String) -> ProvisionFailure {
    ProvisionFailure::Code(DoomProvisionErrorCode::ToolchainExtractFailed, message)
}

/// Decode `archive` (a `.tar.xz`) into a temp `.tar` under `toolchain_dir`, then
/// extract that tar into `staging` — **entirely in-process** (ST-6, F-78): a
/// pure-Rust `lzma-rs` xz decode plus the Rust `tar` crate. No host `tar` and no
/// child process is involved, so there is nothing to orphan. The cancel flag and
/// the absolute `deadline` are honoured between tar entries.
fn extract_tar_xz_blocking(
    archive: &Path,
    toolchain_dir: &Path,
    staging: &Path,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<(), ProvisionFailure> {
    let tar_path = toolchain_dir.join(DOOM_TOOLCHAIN_TAR_TMP);
    let _ = std::fs::remove_file(&tar_path);

    // 1. Pure-Rust xz decode: `.tar.xz` → temp `.tar` (no liblzma, no host tar).
    let mut input = BufReader::new(std::fs::File::open(archive).map_err(|error| {
        extract_failed(format!("could not open {}: {error}", archive.display()))
    })?);
    let mut output = BufWriter::new(std::fs::File::create(&tar_path).map_err(|error| {
        extract_failed(format!("could not create {}: {error}", tar_path.display()))
    })?);
    lzma_rs::xz_decompress(&mut input, &mut output)
        .map_err(|error| extract_failed(format!("could not decode the xz archive: {error}")))?;
    output
        .flush()
        .map_err(|error| extract_failed(format!("could not write {}: {error}", tar_path.display())))?;
    drop(output);

    // 2. Rust `tar` extraction into staging, cancel/budget-aware per entry.
    let tar_file = std::fs::File::open(&tar_path).map_err(|error| {
        extract_failed(format!("could not reopen {}: {error}", tar_path.display()))
    })?;
    let mut tar_archive = tar::Archive::new(BufReader::new(tar_file));
    let entries = tar_archive
        .entries()
        .map_err(|error| extract_failed(format!("could not read the tar archive: {error}")))?;
    for entry in entries {
        if cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&tar_path);
            return Err(ProvisionFailure::Cancelled);
        }
        if Instant::now() >= deadline {
            let _ = std::fs::remove_file(&tar_path);
            return Err(ProvisionFailure::Timeout);
        }
        let mut entry = entry
            .map_err(|error| extract_failed(format!("could not read a tar entry: {error}")))?;
        let unpacked = entry
            .unpack_in(staging)
            .map_err(|error| extract_failed(format!("could not extract a tar entry: {error}")))?;
        if !unpacked {
            let _ = std::fs::remove_file(&tar_path);
            return Err(extract_failed(
                "the archive contains an entry outside the extraction dir".to_string(),
            ));
        }
    }
    let _ = std::fs::remove_file(&tar_path);
    Ok(())
}

/// Extract the toolchain archive into `<install_dir>/toolchain/msys2` with the
/// in-process extractor, bounded + cancellable. Runs on a blocking thread so the
/// cancel flag/timeout can win without blocking the async runtime (ST-6).
async fn extract_archive(
    run: &ProvisionRun<'_>,
    archive: &Path,
    budget: Duration,
) -> Result<(), ProvisionFailure> {
    let toolchain_dir = run.install_dir.join(DOOM_TOOLCHAIN_SUBDIR);
    let staging = toolchain_dir.join(DOOM_TOOLCHAIN_STAGING_DIR);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|error| {
        extract_failed(format!("could not create {}: {error}", staging.display()))
    })?;

    let deadline = Instant::now() + budget;
    let handle = tauri::async_runtime::spawn_blocking({
        let archive = archive.to_path_buf();
        let toolchain_dir = toolchain_dir.clone();
        let staging = staging.clone();
        let cancel = run.cancel.clone();
        move || extract_tar_xz_blocking(&archive, &toolchain_dir, &staging, &cancel, deadline)
    });
    tokio::pin!(handle);

    let failure = tokio::select! {
        result = &mut handle => match result {
            Ok(Ok(())) => None,
            Ok(Err(failure)) => Some(failure),
            Err(join_error) => Some(extract_failed(format!(
                "the extraction task failed: {join_error}"
            ))),
        },
        _ = wait_cancel(run.cancel) => Some(ProvisionFailure::Cancelled),
        _ = tokio::time::sleep(budget) => Some(ProvisionFailure::Timeout),
    };
    if let Some(failure) = failure {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(failure);
    }

    let extracted = find_extracted_root(&staging).ok_or_else(|| {
        extract_failed(format!("the archive produced no {}", DOOM_TOOLCHAIN_BASH_REL))
    })?;
    let target = toolchain_dir.join("msys2");
    let _ = std::fs::remove_dir_all(&target);
    let moved = if extracted == staging {
        std::fs::rename(&staging, &target)
    } else {
        let result = std::fs::rename(&extracted, &target);
        let _ = std::fs::remove_dir_all(&staging);
        result
    };
    moved.map_err(|error| {
        extract_failed(format!(
            "could not move the extracted toolchain into place: {error}"
        ))
    })
}

/// Retains the last few non-`STEP` stderr lines from the build child, so a bare
/// exit code can be explained by the child's own diagnostics instead of being
/// reported without context (ST-11, second symptom).
#[derive(Debug, Default)]
struct BuildStderrTail {
    capacity: usize,
    lines: VecDeque<String>,
}

impl BuildStderrTail {
    /// A tail that keeps at most `capacity` non-`STEP` lines.
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            lines: VecDeque::with_capacity(capacity),
        }
    }

    /// Record one stderr line. The machine-readable `STEP` markers and blank
    /// lines are ignored; only the last `capacity` remaining lines are kept.
    fn push(&mut self, line: &str) {
        if self.capacity == 0 || line.contains(BUILD_STEP_MARKER) {
            return;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        if self.lines.len() == self.capacity {
            self.lines.pop_front();
        }
        self.lines.push_back(trimmed.to_string());
    }

    /// Render the retained lines as a `: a; b; c` suffix (empty when none).
    fn render_suffix(&self) -> String {
        if self.lines.is_empty() {
            return String::new();
        }
        let joined = self
            .lines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("; ");
        format!(": {joined}")
    }
}

/// Update + emit the build step parsed from one stderr line.
fn handle_step_line(run: &ProvisionRun<'_>, line: &str) {
    let Some(index) = line.find(BUILD_STEP_MARKER) else {
        return;
    };
    let step = line[index + BUILD_STEP_MARKER.len()..]
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    if step.is_empty() {
        return;
    }
    let detail = DoomProvisionProgress {
        phase: DoomProvisionPhase::Building,
        step,
        message: line.trim().to_string(),
        downloaded: 0,
        total: 0,
        percent: 0.0,
        elapsed_ms: now_elapsed_ms(run.started),
    };
    let state = run.app.state::<DoomProvisionState>();
    state.set_phase(DoomProvisionPhase::Building);
    state.set_progress(Some(detail));
    publish_phase(run.app, DoomProvisionPhase::Building);
}

/// Spawn the build child and read its stderr `STEP` markers, bounded by
/// `budget` and cancellable (hard-killing the tree on cancel/timeout).
async fn build_engine(
    run: &ProvisionRun<'_>,
    source_dir: &Path,
    toolchain_root: &Path,
    build_script: &Path,
    budget: Duration,
) -> Result<(), ProvisionFailure> {
    // ST-15: PowerShell 5.1 / MSYS2 cannot process the Windows verbatim `\\?\`
    // form. Normalize EVERY path argument at the spawn boundary — this covers
    // `-File`, `-SourceDir`, `-Msys2Root`, `-InstallDir` in one place, and
    // restores a correct `$PSScriptRoot` for the script's patch dir.
    let build_script = strip_verbatim_prefix(build_script);
    let source_dir = strip_verbatim_prefix(source_dir);
    let toolchain_root = strip_verbatim_prefix(toolchain_root);
    let install_dir = strip_verbatim_prefix(run.install_dir);
    let mut command = tokio::process::Command::new("powershell");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&build_script)
        .arg("-SourceDir")
        .arg(&source_dir)
        .arg("-Msys2Root")
        .arg(&toolchain_root)
        .arg("-InstallDir")
        .arg(&install_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| {
        ProvisionFailure::Code(
            DoomProvisionErrorCode::BuildFailed,
            format!("could not start the engine build: {error}"),
        )
    })?;
    let pid = child.id().ok_or_else(|| {
        ProvisionFailure::Code(
            DoomProvisionErrorCode::BuildFailed,
            "the engine build child has no process id".to_string(),
        )
    })?;
    let Some(stderr) = child.stderr.take() else {
        process::kill_pid_tree(pid);
        return Err(ProvisionFailure::Code(
            DoomProvisionErrorCode::BuildFailed,
            "the engine build child has no stderr pipe".to_string(),
        ));
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
    let reader = tauri::async_runtime::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });

    let deadline = tokio::time::Instant::now() + budget;
    let wait = child.wait();
    tokio::pin!(wait);
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut rx_open = true;
    let mut failure: Option<ProvisionFailure> = None;
    let mut wait_failed = false;
    let mut stderr_tail = BuildStderrTail::new(BUILD_STDERR_TAIL_LINES);

    loop {
        tokio::select! {
            status = &mut wait, if exit_status.is_none() && failure.is_none() => {
                match status {
                    Ok(status) => exit_status = Some(status),
                    Err(error) => {
                        failure = Some(ProvisionFailure::Code(
                            DoomProvisionErrorCode::BuildFailed,
                            format!("the engine build wait failed: {error}"),
                        ));
                        wait_failed = true;
                    }
                }
            }
            maybe = rx.recv(), if rx_open => {
                match maybe {
                    Some(line) => {
                        stderr_tail.push(&line);
                        handle_step_line(run, &line);
                    }
                    None => rx_open = false,
                }
            }
            _ = wait_cancel(run.cancel), if failure.is_none() && exit_status.is_none() => {
                failure = Some(ProvisionFailure::Cancelled);
            }
            _ = tokio::time::sleep_until(deadline), if failure.is_none() && exit_status.is_none() => {
                failure = Some(ProvisionFailure::Timeout);
            }
            else => break,
        }
        if failure.is_some() {
            break;
        }
        if exit_status.is_some() && !rx_open {
            break;
        }
    }

    // Dropping `rx` unblocks the reader task's `tx.send`.
    drop(rx);
    drop(reader);
    if let Some(failure) = failure {
        // Hard-kill the whole tree (powershell → bash → make) on cancel/timeout.
        if !wait_failed {
            process::kill_pid_tree(pid);
        }
        return Err(failure);
    }
    let status = exit_status.ok_or_else(|| {
        process::kill_pid_tree(pid);
        ProvisionFailure::Code(
            DoomProvisionErrorCode::BuildFailed,
            "the engine build child did not report an exit status".to_string(),
        )
    })?;
    if !status.success() {
        return Err(ProvisionFailure::Code(
            DoomProvisionErrorCode::BuildFailed,
            format!(
                "the engine build failed (exit code {:?}){}",
                status.code(),
                stderr_tail.render_suffix()
            ),
        ));
    }
    Ok(())
}

/// The bounded provisioning run: toolchain → source identity → build → verify.
async fn run_provision(
    app: &AppHandle,
    install_dir: &Path,
    cancel: &Arc<AtomicBool>,
    started: Instant,
) -> Result<String, ProvisionFailure> {
    let run = ProvisionRun {
        app,
        install_dir,
        cancel,
        started,
    };
    let deadline = Instant::now() + overall_timeout();

    let toolchain_root = match resolve_toolchain_root(install_dir) {
        Some(root) => root,
        None => {
            if offline_requested() {
                return Err(ProvisionFailure::Code(
                    DoomProvisionErrorCode::ToolchainUnavailable,
                    "offline mode is on and no usable build toolchain is present.".to_string(),
                ));
            }
            acquire_toolchain(&run, deadline).await?
        }
    };

    let source_dir = resolve_source_dir(app).ok_or_else(|| {
        ProvisionFailure::Code(
            DoomProvisionErrorCode::SourceMissing,
            "the RESTful-DOOM source tree could not be located.".to_string(),
        )
    })?;
    if !source_dir.join("configure.ac").is_file() {
        return Err(ProvisionFailure::Code(
            DoomProvisionErrorCode::SourceMissing,
            format!(
                "the RESTful-DOOM source tree is missing or incomplete: {}",
                source_dir.display()
            ),
        ));
    }
    let build_script = resolve_build_script(app).ok_or_else(|| {
        ProvisionFailure::Code(
            DoomProvisionErrorCode::SourceMissing,
            "the engine build script could not be located.".to_string(),
        )
    })?;
    if !build_script.is_file() {
        return Err(ProvisionFailure::Code(
            DoomProvisionErrorCode::SourceMissing,
            format!("the engine build script is missing: {}", build_script.display()),
        ));
    }

    let state = app.state::<DoomProvisionState>();
    state.set_phase(DoomProvisionPhase::Building);
    state.set_progress(Some(DoomProvisionProgress {
        phase: DoomProvisionPhase::Building,
        step: "toolchain".to_string(),
        message: "Starting the engine build".to_string(),
        downloaded: 0,
        total: 0,
        percent: 0.0,
        elapsed_ms: now_elapsed_ms(started),
    }));
    publish_phase(app, DoomProvisionPhase::Building);

    let budget = remaining(deadline).min(build_timeout());
    if budget.is_zero() {
        return Err(ProvisionFailure::Timeout);
    }
    build_engine(&run, &source_dir, &toolchain_root, &build_script, budget).await?;

    staged_engine_path(install_dir).ok_or_else(|| {
        ProvisionFailure::Code(
            DoomProvisionErrorCode::BuildFailed,
            "the build finished but no usable engine was staged.".to_string(),
        )
    })
}

/// Start the bounded provisioning task. Idempotent — a live run is not restarted.
pub fn start_provisioning(app: AppHandle, install_dir: PathBuf) {
    let cancel = Arc::new(AtomicBool::new(false));
    if !app
        .state::<DoomProvisionState>()
        .begin(install_dir.to_string_lossy().into_owned(), cancel.clone())
    {
        return;
    }
    publish_phase(&app, DoomProvisionPhase::DownloadingToolchain);
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let outcome = run_provision(&app, &install_dir, &cancel, started).await;
        let state = app.state::<DoomProvisionState>();
        match outcome {
            Ok(_engine) => {
                state.finish_ready();
                publish_phase(&app, DoomProvisionPhase::Ready);
            }
            Err(ProvisionFailure::Cancelled) => {
                state.finish_cancelled();
                publish_phase(&app, DoomProvisionPhase::Cancelled);
            }
            Err(ProvisionFailure::Timeout) => {
                state.finish_failed(
                    DoomProvisionErrorCode::Timeout,
                    "Doom engine setup timed out and was stopped.".to_string(),
                );
                publish_phase(&app, DoomProvisionPhase::Failed);
            }
            Err(ProvisionFailure::Code(code, message)) => {
                state.finish_failed(code, message);
                publish_phase(&app, DoomProvisionPhase::Failed);
            }
        }
    });
}

/// Wait (bounded) for the live run to reach `ready` or a terminal failure.
/// `Ok(engine_path)` on success; `Err((code, message))` on failure/cancel/timeout.
pub async fn await_provision_outcome(
    app: &AppHandle,
    bound: Duration,
) -> Result<String, (DoomProvisionErrorCode, String)> {
    let deadline = Instant::now() + bound;
    loop {
        let status = build_status(app);
        if let Some(engine) = status.engine_path {
            return Ok(engine);
        }
        match status.phase {
            DoomProvisionPhase::Failed => {
                return Err((
                    status.code.unwrap_or(DoomProvisionErrorCode::BuildFailed),
                    status
                        .last_error
                        .unwrap_or_else(|| "Doom engine setup failed.".to_string()),
                ));
            }
            DoomProvisionPhase::Cancelled => {
                return Err((
                    DoomProvisionErrorCode::Cancelled,
                    status
                        .last_error
                        .unwrap_or_else(|| "Doom engine setup was cancelled.".to_string()),
                ));
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err((
                DoomProvisionErrorCode::Timeout,
                format!("Doom engine setup did not finish within {}s.", bound.as_secs()),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The mount seed + poll fallback for the provisioning status.
#[tauri::command]
pub fn get_doom_provision_status(app: AppHandle) -> DoomProvisionStatus {
    build_status(&app)
}

/// Persist the chosen install dir, then start the bounded provisioning task and
/// return immediately (the `doom-provision-progress` event is the truth).
#[tauri::command]
pub fn provision_doom_engine(
    app: AppHandle,
    install_dir: Option<String>,
) -> DoomProvisionResult {
    let chosen = match resolve_chosen_install_dir(&app, install_dir) {
        Ok(dir) => dir,
        Err(message) => {
            return DoomProvisionResult {
                success: false,
                phase: DoomProvisionPhase::Failed,
                needs_install_dir: true,
                engine_path: None,
                error: Some(message),
                code: Some(DoomProvisionErrorCode::InstallDirInvalid),
            }
        }
    };
    if let Err(message) = validate_install_dir(&chosen) {
        return DoomProvisionResult {
            success: false,
            phase: DoomProvisionPhase::Failed,
            needs_install_dir: true,
            engine_path: None,
            error: Some(message),
            code: Some(DoomProvisionErrorCode::InstallDirInvalid),
        };
    }
    let _ = app
        .state::<Arc<AppStore>>()
        .cached_set(DOOM_INSTALL_DIR_KEY, &chosen.to_string_lossy());

    start_provisioning(app.clone(), chosen);
    let status = build_status(&app);
    DoomProvisionResult {
        success: true,
        phase: status.phase,
        needs_install_dir: false,
        engine_path: status.engine_path,
        error: None,
        code: None,
    }
}

/// Cancel a live provisioning run (idempotent). The run hard-kills within
/// `DOOM_PROVISION_STOP_TIMEOUT_S` and emits `phase: cancelled`.
#[tauri::command]
pub fn cancel_doom_engine_provisioning(app: AppHandle) -> Result<(), String> {
    app.state::<DoomProvisionState>().request_cancel();
    Ok(())
}

/// Resolve the install dir: explicit request → stored → product default.
fn resolve_chosen_install_dir(
    app: &AppHandle,
    requested: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(dir) = requested
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = configured_install_dir(app) {
        return Ok(PathBuf::from(dir));
    }
    let default = default_install_dir(app);
    if default.trim().is_empty() {
        return Err("the install location is required".to_string());
    }
    Ok(PathBuf::from(default))
}

/// Ensure the dir exists and is writable.
fn validate_install_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    let probe = dir.join(".fredo-provision-write-test");
    std::fs::write(&probe, b"ok")
        .map_err(|error| format!("{} is not writable: {error}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_serialize_camel_case() {
        let cases = [
            (DoomProvisionPhase::Idle, "\"idle\""),
            (DoomProvisionPhase::AwaitingInstallDir, "\"awaitingInstallDir\""),
            (DoomProvisionPhase::DownloadingToolchain, "\"downloadingToolchain\""),
            (DoomProvisionPhase::Building, "\"building\""),
            (DoomProvisionPhase::Ready, "\"ready\""),
            (DoomProvisionPhase::Failed, "\"failed\""),
            (DoomProvisionPhase::Cancelled, "\"cancelled\""),
        ];
        for (phase, expected) in cases {
            assert_eq!(serde_json::to_string(&phase).expect("serialize"), expected);
            assert_eq!(format!("\"{}\"", phase.as_str()), expected);
        }
    }

    #[test]
    fn error_codes_serialize_camel_case_and_parse() {
        let cases = [
            (DoomProvisionErrorCode::InstallDirInvalid, "\"installDirInvalid\""),
            (DoomProvisionErrorCode::ToolchainUnavailable, "\"toolchainUnavailable\""),
            (DoomProvisionErrorCode::ToolchainDownloadFailed, "\"toolchainDownloadFailed\""),
            (DoomProvisionErrorCode::ToolchainExtractFailed, "\"toolchainExtractFailed\""),
            (DoomProvisionErrorCode::SourceMissing, "\"sourceMissing\""),
            (DoomProvisionErrorCode::BuildFailed, "\"buildFailed\""),
            (DoomProvisionErrorCode::Timeout, "\"timeout\""),
            (DoomProvisionErrorCode::Cancelled, "\"cancelled\""),
        ];
        for (code, expected) in cases {
            assert_eq!(serde_json::to_string(&code).expect("serialize"), expected);
            assert_eq!(DoomProvisionErrorCode::parse(code.as_str()), Some(code));
        }
        assert_eq!(DoomProvisionErrorCode::parse("nope"), None);
        assert_eq!(DoomProvisionErrorCode::parse(""), None);
    }

    #[test]
    fn the_toolchain_pin_matches_the_st_1_record() {
        // G-320: pin values are transcribed from scripts/doom/README.md.
        assert_eq!(
            DOOM_TOOLCHAIN_PIN.url,
            "https://repo.msys2.org/distrib/x86_64/msys2-base-x86_64-20260927.tar.xz"
        );
        assert_eq!(
            DOOM_TOOLCHAIN_PIN.archive_filename,
            "msys2-base-x86_64-20260927.tar.xz"
        );
        assert_eq!(DOOM_TOOLCHAIN_PIN.bytes, 42_860_696);
        assert_eq!(
            DOOM_TOOLCHAIN_PIN.sha256,
            "ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322"
        );
        assert_eq!(DOOM_TOOLCHAIN_PIN.sha256.len(), 64);
        assert!(DOOM_TOOLCHAIN_PIN.sha256.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_binding_constants_and_seams_are_pinned() {
        assert_eq!(DOOM_PROVISION_EVENT, "doom-provision-progress");
        assert_eq!(DOOM_VENDOR_SUBDIR, "vendor/restful-doom");
        assert_eq!(
            DOOM_VENDOR_COMMIT,
            "eded41b5597b7738ec1fa06d24f62b53db982c2c"
        );
        assert_eq!(DOOM_ENGINE_COMMIT_MARKER, ".restful-doom-commit");
        assert_eq!(DOOM_TOOLCHAIN_SUBDIR, "toolchain");
        assert_eq!(DOOM_TOOLCHAIN_BASH_REL, "usr/bin/bash.exe");
        assert_eq!(DOOM_PROVISION_TIMEOUT_S, 1800);
        assert_eq!(DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_S, 900);
        assert_eq!(DOOM_BUILD_TIMEOUT_S, 900);
        assert_eq!(DOOM_PROVISION_STOP_TIMEOUT_S, 5);
        assert_eq!(DOOM_TOOLCHAIN_ROOT_ENV, "FREDO_DOOM_TOOLCHAIN_ROOT");
        assert_eq!(DOOM_TOOLCHAIN_URL_ENV, "FREDO_DOOM_TOOLCHAIN_ARCHIVE_URL");
        assert_eq!(DOOM_TOOLCHAIN_SHA256_ENV, "FREDO_DOOM_TOOLCHAIN_ARCHIVE_SHA256");
        assert_eq!(DOOM_TOOLCHAIN_BYTES_ENV, "FREDO_DOOM_TOOLCHAIN_ARCHIVE_BYTES");
        assert_eq!(DOOM_SOURCE_DIR_ENV, "FREDO_DOOM_SOURCE_DIR");
        assert_eq!(DOOM_PROVISION_TIMEOUT_ENV, "FREDO_DOOM_PROVISION_TIMEOUT_S");
        assert_eq!(DOOM_BUILD_TIMEOUT_ENV, "FREDO_DOOM_BUILD_TIMEOUT_S");
        assert_eq!(
            DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_ENV,
            "FREDO_DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_S"
        );
        assert_eq!(DOOM_PROVISION_OFFLINE_ENV, "FREDO_DOOM_BUILD_OFFLINE");
    }

    #[test]
    fn the_timeouts_honour_their_env_seam_or_default() {
        if std::env::var(DOOM_PROVISION_TIMEOUT_ENV).is_err() {
            assert_eq!(overall_timeout(), Duration::from_secs(DOOM_PROVISION_TIMEOUT_S));
        }
        if std::env::var(DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_ENV).is_err() {
            assert_eq!(
                download_timeout(),
                Duration::from_secs(DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_S)
            );
        }
        if std::env::var(DOOM_BUILD_TIMEOUT_ENV).is_err() {
            assert_eq!(build_timeout(), Duration::from_secs(DOOM_BUILD_TIMEOUT_S));
        }
    }

    #[test]
    fn archive_filename_is_derived_from_the_url_or_path() {
        assert_eq!(
            archive_filename_for("https://example.test/a/b/msys2.tar.xz?x=1"),
            "msys2.tar.xz"
        );
        assert_eq!(
            archive_filename_for("file:///C:/tmp/craft/archive.tar.xz"),
            "archive.tar.xz"
        );
        assert_eq!(
            archive_filename_for(r"C:\tmp\craft\archive.tar.xz"),
            "archive.tar.xz"
        );
        assert_eq!(archive_filename_for(""), DOOM_TOOLCHAIN_PIN.archive_filename);
        assert_eq!(
            archive_filename_for("file://"),
            DOOM_TOOLCHAIN_PIN.archive_filename
        );
    }

    #[test]
    fn toolchain_spec_defaults_to_the_pin_when_env_is_unset() {
        // Guarded: the env seams may be injected by the QA harness.
        if std::env::var(DOOM_TOOLCHAIN_URL_ENV).is_err()
            && std::env::var(DOOM_TOOLCHAIN_SHA256_ENV).is_err()
            && std::env::var(DOOM_TOOLCHAIN_BYTES_ENV).is_err()
        {
            let spec = toolchain_archive_spec();
            assert_eq!(spec.url, DOOM_TOOLCHAIN_PIN.url);
            assert_eq!(spec.sha256, DOOM_TOOLCHAIN_PIN.sha256);
            assert_eq!(spec.bytes, DOOM_TOOLCHAIN_PIN.bytes);
        }
    }

    #[test]
    fn strip_verbatim_prefix_normalizes_windows_paths() {
        // ST-15: PowerShell 5.1 / MSYS2 cannot process the verbatim form, so the
        // spawn boundary must de-verbatim every path argument. The helper is a
        // pure string op, so this pin runs on every platform.
        // Device-path form.
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\C:\a\b")),
            PathBuf::from(r"C:\a\b")
        );
        // UNC device-path form.
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        // A normal path is a no-op.
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"C:\a\b")),
            PathBuf::from(r"C:\a\b")
        );
        // A normal UNC path is a no-op too (only the `\\?\` prefix is special).
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
    }

    #[test]
    fn usable_root_requires_usr_bin_bash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("msys2");
        assert!(!usable_root(&root));
        let bash = root.join("usr").join("bin");
        std::fs::create_dir_all(&bash).expect("mkdir");
        std::fs::write(bash.join("bash.exe"), b"MZ").expect("write bash");
        assert!(usable_root(&root));
    }

    #[test]
    fn display_phase_prefers_a_live_run_then_staged_then_awaiting_dir() {
        assert_eq!(
            display_phase(DoomProvisionPhase::Building, true, false, true),
            DoomProvisionPhase::Building
        );
        assert_eq!(
            display_phase(DoomProvisionPhase::Ready, false, true, false),
            DoomProvisionPhase::Idle
        );
        assert_eq!(
            display_phase(DoomProvisionPhase::Idle, false, false, true),
            DoomProvisionPhase::AwaitingInstallDir
        );
        assert_eq!(
            display_phase(DoomProvisionPhase::Failed, false, false, false),
            DoomProvisionPhase::Failed
        );
        assert_eq!(
            display_phase(DoomProvisionPhase::Cancelled, false, false, false),
            DoomProvisionPhase::Cancelled
        );
        assert_eq!(
            display_phase(DoomProvisionPhase::Idle, false, false, false),
            DoomProvisionPhase::Idle
        );
    }

    #[test]
    fn staged_engine_requires_the_pinned_marker_and_a_pe_image() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine_dir = dir.path().join("engine");
        std::fs::create_dir_all(&engine_dir).expect("mkdir");
        let exe = engine_dir.join("restful-doom.exe");
        let marker = engine_dir.join(DOOM_ENGINE_COMMIT_MARKER);

        // No marker → not staged.
        std::fs::write(&exe, b"MZ fake").expect("write exe");
        assert!(staged_engine_path(dir.path()).is_none());

        // Wrong commit → not staged.
        std::fs::write(&marker, "deadbeef").expect("write marker");
        assert!(staged_engine_path(dir.path()).is_none());

        // Right commit but a non-PE body → not staged.
        std::fs::write(&marker, DOOM_VENDOR_COMMIT).expect("write marker");
        std::fs::write(&exe, b"not-a-pe").expect("write exe");
        assert!(staged_engine_path(dir.path()).is_none());

        // Right commit + PE image → staged.
        std::fs::write(&exe, b"MZ real engine").expect("write exe");
        assert_eq!(
            staged_engine_path(dir.path()),
            Some(exe.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn begin_is_idempotent_while_running() {
        let state = DoomProvisionState::default();
        let cancel = Arc::new(AtomicBool::new(false));
        assert!(state.begin("C:/doom".to_string(), cancel.clone()));
        assert!(state.is_running());
        assert!(!state.begin("C:/other".to_string(), Arc::new(AtomicBool::new(false))));

        assert!(state.request_cancel());
        assert!(cancel.load(Ordering::Relaxed));
        state.finish_cancelled();
        assert!(!state.is_running());
        // Cancel while idle is a no-op.
        assert!(!state.request_cancel());
    }

    #[test]
    fn blocked_status_snapshot_carries_the_display_phase_and_dir() {
        // A fresh state with no stored dir reads awaitingInstallDir via
        // `display_phase`; this pins the pure derivation without an AppHandle.
        assert_eq!(
            display_phase(DoomProvisionPhase::Idle, false, false, true),
            DoomProvisionPhase::AwaitingInstallDir
        );
    }

    #[test]
    fn build_stderr_tail_keeps_the_last_non_step_lines() {
        // ST-11: the tail ignores STEP markers + blank lines, keeps insertion
        // order, and retains only the last N non-STEP lines.
        let mut tail = BuildStderrTail::new(3);
        tail.push("[build-restful-doom] STEP toolchain");
        tail.push("");
        tail.push("line one");
        tail.push("   ");
        tail.push("line two");
        tail.push("[build-restful-doom] STEP source");
        tail.push("line three");
        tail.push("line four");
        assert_eq!(
            tail.render_suffix(),
            ": line two; line three; line four"
        );

        // An accumulator that saw only STEP/blank lines renders no suffix.
        let mut quiet = BuildStderrTail::new(8);
        quiet.push("[build-restful-doom] STEP deps");
        quiet.push("  ");
        assert_eq!(quiet.render_suffix(), "");
        assert_eq!(BuildStderrTail::new(0).render_suffix(), "");
    }

    #[test]
    fn the_in_process_extractor_round_trips_a_tar_xz_without_host_tar() {
        // ST-9 (F-78 regression): a crafted `.tar.xz` goes through the NEW
        // in-process extractor — no host `tar`, no child process. If the
        // extractor ever regresses to a PATH `tar`, this fixture (built purely
        // from the `tar` + `lzma-rs` crates) proves the path is self-sufficient.
        use std::io::Read as _;

        // Build a tiny tar containing the one usable-root probe file.
        let payload: &[u8] = b"MZ in-process extractor fixture";
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "msys2/usr/bin/bash.exe", payload)
                .expect("append tar entry");
            builder.finish().expect("finish tar");
        }

        // Compress to xz (pure Rust) — the same `.tar.xz` class as the pin.
        let mut xz_bytes: Vec<u8> = Vec::new();
        lzma_rs::xz_compress(&mut &tar_bytes[..], &mut xz_bytes).expect("xz compress");
        assert_eq!(&xz_bytes[..6], &[0xFD, b'7', b'z', b'X', b'Z', 0x00]);

        let dir = tempfile::tempdir().expect("tempdir");
        let toolchain_dir = dir.path().join("toolchain");
        let staging = toolchain_dir.join(DOOM_TOOLCHAIN_STAGING_DIR);
        std::fs::create_dir_all(&staging).expect("mkdir staging");
        let archive = toolchain_dir.join("fixture.tar.xz");
        std::fs::write(&archive, &xz_bytes).expect("write archive");

        let cancel = Arc::new(AtomicBool::new(false));
        extract_tar_xz_blocking(
            &archive,
            &toolchain_dir,
            &staging,
            &cancel,
            Instant::now() + Duration::from_secs(30),
        )
        .expect("in-process extract");

        // The SHARED root checks see the extracted toolchain...
        let root = find_extracted_root(&staging).expect("extracted root");
        assert!(usable_root(&root));
        let bash = root.join("usr").join("bin").join("bash.exe");
        let mut contents = String::new();
        std::fs::File::open(&bash)
            .expect("open bash")
            .read_to_string(&mut contents)
            .expect("read bash");
        assert_eq!(contents, "MZ in-process extractor fixture");
        // ...and the intermediate `.tar` was cleaned up.
        assert!(!toolchain_dir.join(DOOM_TOOLCHAIN_TAR_TMP).exists());
    }

    #[test]
    fn the_in_process_extractor_honours_a_pre_set_cancel_flag() {
        // A pre-requested cancel must abort the per-entry loop, not extract.
        let payload: &[u8] = b"MZ fixture";
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "msys2/usr/bin/bash.exe", payload)
                .expect("append tar entry");
            builder.finish().expect("finish tar");
        }
        let mut xz_bytes: Vec<u8> = Vec::new();
        lzma_rs::xz_compress(&mut &tar_bytes[..], &mut xz_bytes).expect("xz compress");

        let dir = tempfile::tempdir().expect("tempdir");
        let toolchain_dir = dir.path().join("toolchain");
        let staging = toolchain_dir.join(DOOM_TOOLCHAIN_STAGING_DIR);
        std::fs::create_dir_all(&staging).expect("mkdir staging");
        let archive = toolchain_dir.join("fixture.tar.xz");
        std::fs::write(&archive, &xz_bytes).expect("write archive");

        let cancel = Arc::new(AtomicBool::new(true));
        let outcome = extract_tar_xz_blocking(
            &archive,
            &toolchain_dir,
            &staging,
            &cancel,
            Instant::now() + Duration::from_secs(30),
        );
        assert!(matches!(outcome, Err(ProvisionFailure::Cancelled)));
        assert!(find_extracted_root(&staging).is_none());
    }
}
