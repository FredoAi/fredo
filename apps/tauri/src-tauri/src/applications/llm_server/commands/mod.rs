//! Companion command surface, split by CONCERN (Spec #3141, ST-1).
//!
//! `commands.rs` was a single 1273-line file; ST-1 performs the ONE-TIME
//! file→directory split so later sub-tasks edit DISJOINT modules and never
//! collide on the same file:
//!
//! * [`engine`] — engine lifecycle + the status surface (ST-1), plus the
//!   pre-migration `llama-server` launch/stop/generate commands it supersedes.
//! * [`chat`] — the chat/vision/audio turns (ST-3 re-points these onto the
//!   engine; in ST-1 they still delegate to the OLD transport).
//! * [`capability`] — the model-audio capability probe (ST-5 re-points it; in
//!   ST-1 it still delegates to the OLD probe).
//!
//! The wire models and helpers the sub-modules share live here in the module
//! root, so ST-1 re-homes them without rewriting behaviour. No behaviour changes
//! in this split.
//!
//! ## Status surface (AC-22.3 / AC-24 / AC-25)
//!
//! [`LlamaServerStatus`] keeps its EXISTING fields (byte-for-byte wire
//! stability — AC-26) and gains the ADDITIVE fields `lastErrorCode`, `backend`,
//! `backendMode`, `devices`, `modelId`. Every NEW optional field is carried as
//! an ABSENT KEY when unset (never an explicit `null`, NFR-9); the PRE-EXISTING
//! optional fields keep their current explicit-`null` form.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::infrastructure::companion::models::{
    file_path, is_step_complete, missing_files, resolve_manifest, resolve_models_dir,
    ModelManifest,
};
use crate::infrastructure::storage::SettingsStore;

use super::config::LlamaServerConfig;
use super::engine::handle::{CompanionEngineHandle, EngineSlot};
use super::engine::{CompanionBackendKind, CompanionBackendMode, CompanionDeviceInfo};
use super::health;
use super::process;
use super::state::LlamaServerState;
use super::LLAMA_SERVER_BACKEND_KEY;

pub mod capability;
pub mod chat;
pub mod engine;

/// SettingsStore key for the last launch error, surfaced by `get_llama_server_status`.
///
/// Internal to this application — not part of the persisted-settings contract.
pub(crate) const LLAMA_SERVER_LAST_ERROR_KEY: &str = "llama_server_last_error";

// ── Wire models (camelCase, IPC) ──────────────────────────────────────────────

/// Why a launch could not reach a healthy server.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum LlamaServerLaunchCode {
    SpawnFailed,
    PortInUse,
    HealthTimeout,
    NotConfigured,
}

/// The launch state vocabulary, wire-identical to `applications::setup`'s
/// `PrerequisiteState` (`installed` / `missing` / `error`). Declared locally
/// because a cross-FEATURE import is forbidden (`AGENTS.md`); the JSON shape is
/// deliberately the same so the wizard can consume either.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PrerequisiteState {
    Installed,
    Missing,
    Error,
}

/// Result of `launch_llama_server` — always returned, never a hang.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerLaunchResult {
    pub success: bool,
    pub state: PrerequisiteState,
    pub detail: String,
    pub port: Option<u16>,
    pub config_path: String,
    pub error: Option<String>,
    pub code: Option<LlamaServerLaunchCode>,
}

/// Status snapshot for the UI/QA poll target.
///
/// PRE-EXISTING fields (`port` / `pid` / `configPath` / `logPath` /
/// `lastError`) keep their current explicit-`null` wire form (AC-26 wire
/// stability). The ADDITIVE fields below are OPTIONAL and carry an ABSENT KEY
/// when unset (NFR-9): when no engine is loaded the serialized payload has NO
/// `backend`, `lastErrorCode`, or `modelId` key.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerStatus {
    pub running: bool,
    pub healthy: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub config_path: String,
    pub log_path: String,
    pub last_error: Option<String>,
    // ── additive (ST-1) ──
    /// The typed failure of the most recent engine start, when it failed.
    /// ABSENT KEY when unset (NFR-9).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<super::engine::CompanionEngineErrorCode>,
    /// The backend ggml reports for the loaded device set. ABSENT KEY when no
    /// engine is loaded (NFR-9).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<CompanionBackendKind>,
    /// The persisted backend selection, echoed back.
    pub backend_mode: CompanionBackendMode,
    /// The device set ggml reports (empty before a load).
    pub devices: Vec<CompanionDeviceInfo>,
    /// The canonical model id (manifest `model` file stem). ABSENT KEY when no
    /// engine is loaded (NFR-9).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// The cumulative MTP speculative-decoding counters (ST-4 / R-19.1).
    /// ABSENT KEY when no turn has run yet (NFR-9).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtp_stats: Option<super::engine::mtp::MtpStats>,
}

impl LlamaServerStatus {
    /// Build the status surface from an engine slot.
    pub(crate) fn from_slot(slot: &EngineSlot) -> Self {
        let snapshot = &slot.snapshot;
        Self {
            running: snapshot.loaded,
            healthy: snapshot.loaded,
            // In-process: there is no port and no process id.
            port: None,
            pid: None,
            // No generated `.bat`; the engine log is reported via `logPath`.
            config_path: String::new(),
            log_path: String::new(),
            last_error: snapshot.last_error.clone(),
            last_error_code: snapshot.last_error_code,
            backend: snapshot.backend,
            backend_mode: slot.mode,
            devices: snapshot.devices.clone(),
            model_id: snapshot.model_id.clone(),
            mtp_stats: snapshot.mtp_stats,
        }
    }

    /// Build the not-yet-started status for `mode` (no engine loaded).
    pub(crate) fn idle(mode: CompanionBackendMode) -> Self {
        Self {
            running: false,
            healthy: false,
            port: None,
            pid: None,
            config_path: String::new(),
            log_path: String::new(),
            last_error: None,
            last_error_code: None,
            backend: None,
            backend_mode: mode,
            devices: Vec::new(),
            model_id: None,
            mtp_stats: None,
        }
    }
}

/// The generated launch config plus its materialized path and contents.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerConfigPreview {
    pub config: LlamaServerConfig,
    pub path: String,
    pub contents: String,
}

// ── Settings access (SettingsStore is the single source of truth) ──────────────────

pub(crate) fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    app.state::<Arc<SettingsStore>>()
        .cached_get(key)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn set_setting(app: &AppHandle, key: &str, value: &str) {
    let _ = app.state::<Arc<SettingsStore>>().cached_set(key, value);
}

pub(crate) fn get_u16(app: &AppHandle, key: &str, default: u16) -> u16 {
    get_setting(app, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

pub(crate) fn get_u64(app: &AppHandle, key: &str, default: u64) -> u64 {
    get_setting(app, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// The persisted backend mode (coerced to `auto` for an unknown value).
pub(crate) fn backend_mode(app: &AppHandle) -> CompanionBackendMode {
    CompanionBackendMode::from_persisted(get_setting(app, LLAMA_SERVER_BACKEND_KEY).as_deref())
}

/// A persisted override when set, else the absolute path derived from the SHARED
/// #2856 manifest (`<models_dir>/<subdir>/<spec.path>` — NFR-6, one path rule).
/// `file_id` is the manifest id (`model` | `vision` | `mtp`).
pub(crate) fn resolve_model_path(
    app: &AppHandle,
    override_key: &str,
    models_dir: &Path,
    manifest: &ModelManifest,
    file_id: &str,
) -> String {
    if let Some(override_path) = get_setting(app, override_key) {
        return override_path;
    }
    manifest
        .files
        .iter()
        .find(|spec| spec.id == file_id)
        .map(|spec| {
            file_path(models_dir, manifest, spec)
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_default()
}

/// R-1c: a config is never valid/launchable while a required model file is
/// absent. Uses the SHARED #2856 manifest as the single rule source and NAMES
/// the missing file(s). `None` means every required file is present.
pub(crate) fn missing_model_files_detail(
    models_dir: &Path,
    manifest: &ModelManifest,
) -> Option<String> {
    if is_step_complete(models_dir, manifest) {
        return None;
    }
    let missing: Vec<String> = missing_files(models_dir, manifest)
        .into_iter()
        .map(|status| status.relative_path)
        .collect();
    if missing.is_empty() {
        Some("missing model file(s): model manifest declares no required files".to_string())
    } else {
        Some(format!("missing model file(s): {}", missing.join(", ")))
    }
}

/// The optional persisted parameter subset (`llama_server_args`). Every field is
/// optional; unset fields keep the ST-2 [`LlamaServerConfig::default`] value.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct LlamaServerArgsOverride {
    pub(crate) host: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) spec_type: Option<String>,
    pub(crate) spec_draft_n_max: Option<u32>,
    pub(crate) fit: Option<String>,
    pub(crate) load_mode: Option<String>,
    pub(crate) gpu_layers: Option<String>,
    pub(crate) threads: Option<u32>,
    pub(crate) threads_batch: Option<u32>,
    pub(crate) reasoning: Option<String>,
    pub(crate) ctx_size: Option<u32>,
    pub(crate) temp: Option<f32>,
    pub(crate) top_p: Option<f32>,
    pub(crate) top_k: Option<u32>,
    pub(crate) parallel: Option<u32>,
    pub(crate) jinja: Option<bool>,
    pub(crate) chat_template: Option<String>,
    pub(crate) chat_template_file: Option<String>,
    pub(crate) kv_unified: Option<bool>,
    pub(crate) log_verbosity: Option<u32>,
    pub(crate) alias: Option<String>,
}

/// Overlay the persisted `llama_server_args` JSON onto `base`. A blank/absent
/// value is a no-op; malformed JSON is a hard error (never a silently-ignored
/// config). Pure — unit-tested without a Tauri app.
pub(crate) fn apply_args_override(
    base: &mut LlamaServerConfig,
    json: Option<&str>,
) -> Result<(), String> {
    let raw = match json {
        Some(raw) if !raw.trim().is_empty() => raw,
        _ => return Ok(()),
    };
    let over: LlamaServerArgsOverride = serde_json::from_str(raw)
        .map_err(|e| format!("invalid llama_server_args JSON: {e}"))?;

    if let Some(value) = over.host {
        base.host = value;
    }
    if let Some(value) = over.port {
        base.port = value;
    }
    if let Some(value) = over.spec_type {
        base.spec_type = value;
    }
    if let Some(value) = over.spec_draft_n_max {
        base.spec_draft_n_max = value;
    }
    if let Some(value) = over.fit {
        base.fit = value;
    }
    if let Some(value) = over.load_mode {
        base.load_mode = value;
    }
    if let Some(value) = over.gpu_layers {
        base.gpu_layers = value;
    }
    if let Some(value) = over.threads {
        base.threads = value;
    }
    if let Some(value) = over.threads_batch {
        base.threads_batch = value;
    }
    if let Some(value) = over.reasoning {
        base.reasoning = value;
    }
    if let Some(value) = over.ctx_size {
        base.ctx_size = value;
    }
    if let Some(value) = over.temp {
        base.temp = value;
    }
    if let Some(value) = over.top_p {
        base.top_p = value;
    }
    if let Some(value) = over.top_k {
        base.top_k = value;
    }
    if let Some(value) = over.parallel {
        base.parallel = value;
    }
    if let Some(value) = over.jinja {
        base.jinja = value;
    }
    if let Some(value) = over.chat_template {
        base.chat_template = Some(value);
    }
    if let Some(value) = over.chat_template_file {
        base.chat_template_file = Some(value);
    }
    if let Some(value) = over.kv_unified {
        base.kv_unified = value;
    }
    if let Some(value) = over.log_verbosity {
        base.log_verbosity = value;
    }
    if let Some(value) = over.alias {
        base.alias = value;
    }
    Ok(())
}

/// The process-scoped engine handle, managed by Tauri.
pub struct CompanionEngineState(pub Arc<CompanionEngineHandle>);

impl Default for CompanionEngineState {
    fn default() -> Self {
        Self(Arc::new(CompanionEngineHandle::spawn()))
    }
}

/// The current status surface. Reads the engine slot when an engine is managed,
/// else reports an idle engine in the persisted mode.
pub(crate) fn current_status(app: &AppHandle) -> LlamaServerStatus {
    let mode = backend_mode(app);
    match app.try_state::<CompanionEngineState>() {
        Some(state) => {
            let slot = state.0.slot();
            let status = match slot.lock() {
                Ok(guard) => LlamaServerStatus::from_slot(&guard),
                Err(poisoned) => LlamaServerStatus::from_slot(&poisoned.into_inner()),
            };
            status
        }
        None => LlamaServerStatus::idle(mode),
    }
}

// ── Shared pre-migration helpers (still used by the engine commands) ─────────
//
// These are the launch-config / managed-process helpers the pre-migration
// `llama-server` path still needs until ST-6 re-points its consumers. They are
// re-homed from the old `commands.rs` unchanged (NFR-6: one implementation).

/// The generated launch config, built from persisted settings and a resolved
/// executable.
pub(crate) fn build_launch_config(
    app: &AppHandle,
    executable: &Path,
) -> Result<LlamaServerConfig, String> {
    let models_dir = resolve_models_dir(app);
    let manifest = resolve_manifest(app);
    let mut config = LlamaServerConfig {
        executable: executable.to_string_lossy().into_owned(),
        host: get_setting(app, crate::applications::llm_server::LLAMA_SERVER_HOST_KEY)
            .unwrap_or_else(|| {
                crate::applications::llm_server::DEFAULT_LLAMA_SERVER_HOST.to_string()
            }),
        port: get_u16(
            app,
            crate::applications::llm_server::LLAMA_SERVER_PORT_KEY,
            crate::applications::llm_server::DEFAULT_LLAMA_SERVER_PORT,
        ),
        model: resolve_model_path(
            app,
            crate::applications::llm_server::LLAMA_SERVER_MODEL_PATH_KEY,
            &models_dir,
            &manifest,
            "model",
        ),
        mmproj: resolve_model_path(
            app,
            crate::applications::llm_server::LLAMA_SERVER_MMPROJ_PATH_KEY,
            &models_dir,
            &manifest,
            "vision",
        ),
        model_draft: resolve_model_path(
            app,
            crate::applications::llm_server::LLAMA_SERVER_MTP_PATH_KEY,
            &models_dir,
            &manifest,
            "mtp",
        ),
        ..LlamaServerConfig::default()
    };

    if let Some(json) = get_setting(app, crate::applications::llm_server::LLAMA_SERVER_ARGS_KEY) {
        apply_args_override(&mut config, Some(&json))?;
    }
    Ok(config)
}

/// Map a resolver outcome to an executable path or the launch code explaining
/// the failure. Pure — the `NotConfigured` seam unit test hooks here.
pub(crate) fn executable_or_code(
    resolved: Result<Option<PathBuf>, String>,
) -> Result<PathBuf, (LlamaServerLaunchCode, String)> {
    match resolved {
        Ok(Some(path)) => Ok(path),
        Ok(None) => Err((
            LlamaServerLaunchCode::NotConfigured,
            "llama-server executable not found — install llama.cpp or set llama_server_path."
                .to_string(),
        )),
        Err(error) => Err((
            LlamaServerLaunchCode::NotConfigured,
            format!("could not resolve the llama-server executable: {error}"),
        )),
    }
}

/// Resolve the launch-config and server-log paths under the CONFIGURED
/// companion dir (default `{app_data_dir}/companion`; override via
/// `llama_server_companion_dir`).
pub(crate) fn companion_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = process::resolve_companion_dir(app)?;
    Ok((process::config_path(&dir), process::log_path(&dir)))
}

/// Write `config.to_bat()` to `path` and return the preview. Pure seam — no Tauri.
pub(crate) fn materialize_config(
    config: &LlamaServerConfig,
    path: &Path,
) -> Result<LlamaServerConfigPreview, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let contents = config.to_bat();
    std::fs::write(path, &contents)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(LlamaServerConfigPreview {
        config: config.clone(),
        path: path.to_string_lossy().into_owned(),
        contents,
    })
}

/// A poisoned lock must never take down the app — recover the guard.
pub(crate) fn lock_state(
    state: &LlamaServerState,
) -> std::sync::MutexGuard<'_, Option<super::state::ManagedServer>> {
    state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `Some((port, pid, log_path))` iff a live managed child exists. A child that
/// has exited is reaped out of the state.
pub(crate) fn running_snapshot(state: &LlamaServerState) -> Option<(u16, u32, PathBuf)> {
    let mut guard = lock_state(state);
    let alive = match guard.as_mut() {
        Some(server) => matches!(server.child.try_wait(), Ok(None)),
        None => false,
    };
    if !alive {
        if guard.is_some() {
            *guard = None;
        }
        return None;
    }
    guard
        .as_ref()
        .map(|server| (server.port, server.pid, server.log_path.clone()))
}

/// Kill and forget the managed server (used to reclaim an unhealthy slot).
pub(crate) fn stop_managed(app: &AppHandle) {
    let state = app.state::<LlamaServerState>();
    let mut guard = lock_state(state.inner());
    if let Some(mut server) = guard.take() {
        process::kill_process_tree(&mut server);
    }
}

/// Persist (or clear) the `llama_server_pid` marker through the SINGLE
/// implementation in [`process::persist_pid`], so the launch WRITE and the stop
/// CLEAR cannot drift (NFR-6, one implementation per rule).
pub(crate) fn persist_managed_pid(app: &AppHandle, pid: Option<u32>) {
    let store = app.state::<Arc<SettingsStore>>();
    process::persist_pid(store.inner(), pid);
}

/// A single bounded health probe (used for idempotency + status).
pub(crate) async fn health_probe_once(app: &AppHandle, port: u16) -> bool {
    let host = get_setting(app, crate::applications::llm_server::LLAMA_SERVER_HOST_KEY)
        .unwrap_or_else(|| {
            crate::applications::llm_server::DEFAULT_LLAMA_SERVER_HOST.to_string()
        });
    match health::ReqwestHealthClient::new() {
        Ok(client) => {
            use crate::applications::llm_server::health::HealthProbeSource;
            client
                .probe(&health::health_url(&host, port))
                .await
                .is_ready()
        }
        Err(_) => false,
    }
}

pub(crate) fn failure(
    code: LlamaServerLaunchCode,
    state: PrerequisiteState,
    detail: String,
    config_path: String,
    port: Option<u16>,
) -> LlamaServerLaunchResult {
    LlamaServerLaunchResult {
        success: false,
        state,
        error: Some(detail.clone()),
        detail,
        port,
        config_path,
        code: Some(code),
    }
}

/// Bounded `/health` wait for a freshly spawned server (never hangs).
pub(crate) async fn wait_for_health<S: health::HealthProbeSource + ?Sized>(
    source: &S,
    url: &str,
    timeout: Duration,
    interval: Duration,
    config_path: &str,
    port: u16,
    log_path: &Path,
) -> Result<(), LlamaServerLaunchResult> {
    match health::wait_until_healthy(source, url, timeout, interval).await {
        Ok(()) => Ok(()),
        Err(last) => {
            let log_tail = process::read_log_tail(log_path, 400);
            let detail = if log_tail.is_empty() {
                format!("llama-server started but {last}")
            } else {
                format!("llama-server started but {last}. Server log tail: {log_tail}")
            };
            Err(failure(
                LlamaServerLaunchCode::HealthTimeout,
                PrerequisiteState::Error,
                detail,
                config_path.to_string(),
                Some(port),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::models::ModelFileSpec;
    use std::path::PathBuf;

    use crate::applications::llm_server::engine::handle::EngineSlot;
    use crate::applications::llm_server::engine::CompanionBackendMode;

    /// A small KB-scale manifest so tests never touch the 3.67 GB default.
    fn test_manifest(specs: &[(&str, &str, u64)]) -> ModelManifest {
        ModelManifest {
            revision: "test-rev".to_string(),
            subdir: "gemma-4-e2b-it-qat".to_string(),
            files: specs
                .iter()
                .map(|(id, path, expected)| ModelFileSpec {
                    id: (*id).to_string(),
                    path: (*path).to_string(),
                    url: format!("https://example.invalid/{path}"),
                    expected_bytes: *expected,
                    sha256: None,
                })
                .collect(),
        }
    }

    fn write_sized(path: &Path, len: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        let file = std::fs::File::create(path).expect("create file");
        file.set_len(len).expect("set file length");
    }

    // ── R-1c: config refusal names missing model files ───────────────────────

    #[test]
    fn missing_model_files_detail_names_every_absent_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[
            ("model", "model.gguf", 4),
            ("vision", "mmproj.gguf", 5),
            ("mtp", "MTP/mtp.gguf", 6),
        ]);

        let detail = missing_model_files_detail(dir.path(), &manifest).expect("refusal");
        assert!(detail.starts_with("missing model file(s): "), "detail: {detail}");
        assert!(detail.contains("gemma-4-e2b-it-qat/model.gguf"), "detail: {detail}");
        assert!(detail.contains("gemma-4-e2b-it-qat/mmproj.gguf"), "detail: {detail}");
        assert!(
            detail.contains("gemma-4-e2b-it-qat/MTP/mtp.gguf"),
            "detail: {detail}"
        );

        let base = dir.path().join("gemma-4-e2b-it-qat");
        write_sized(&base.join("model.gguf"), 4);
        write_sized(&base.join("mmproj.gguf"), 5);
        write_sized(&base.join("MTP").join("mtp.gguf"), 6);
        assert!(missing_model_files_detail(dir.path(), &manifest).is_none());
    }

    #[test]
    fn missing_model_files_detail_refuses_an_empty_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[]);
        let detail = missing_model_files_detail(dir.path(), &manifest).expect("refusal");
        assert!(detail.contains("missing model file(s)"), "detail: {detail}");
    }

    // ── Args override (preserved behaviour) ──────────────────────────────────

    #[test]
    fn args_override_replaces_only_the_named_fields() {
        let mut config = LlamaServerConfig::default();
        apply_args_override(
            &mut config,
            Some(r#"{"ctxSize":4096,"threads":3,"alias":"Local"}"#),
        )
        .expect("valid override");

        assert_eq!(config.ctx_size, 4096);
        assert_eq!(config.threads, 3);
        assert_eq!(config.alias, "Local");
        assert_eq!(config.top_p, 0.95);
        assert_eq!(config.spec_type, "draft-mtp");
        assert!(config.kv_unified);
    }

    #[test]
    fn args_override_is_absent_and_blank_safe() {
        let mut config = LlamaServerConfig::default();
        apply_args_override(&mut config, None).expect("absent is a no-op");
        apply_args_override(&mut config, Some("   ")).expect("blank is a no-op");
        assert_eq!(config, LlamaServerConfig::default());
    }

    #[test]
    fn args_override_rejects_invalid_json() {
        let mut config = LlamaServerConfig::default();
        assert!(apply_args_override(&mut config, Some("{ not json")).is_err());
    }

    #[test]
    fn executable_or_code_reports_not_configured_when_absent() {
        let (code, _detail) = executable_or_code(Ok(None)).expect_err("no executable resolved");
        assert_eq!(code, LlamaServerLaunchCode::NotConfigured);

        let (code, _detail) =
            executable_or_code(Err("settings read failed".to_string())).expect_err("resolver error");
        assert_eq!(code, LlamaServerLaunchCode::NotConfigured);

        let path = executable_or_code(Ok(Some(PathBuf::from("llama-server.exe"))))
            .expect("resolved executable");
        assert_eq!(path, PathBuf::from("llama-server.exe"));
    }

    #[test]
    fn launch_codes_serialize_camel_case() {
        let cases = [
            (LlamaServerLaunchCode::SpawnFailed, "\"spawnFailed\""),
            (LlamaServerLaunchCode::PortInUse, "\"portInUse\""),
            (LlamaServerLaunchCode::HealthTimeout, "\"healthTimeout\""),
            (LlamaServerLaunchCode::NotConfigured, "\"notConfigured\""),
        ];
        for (code, expected) in cases {
            assert_eq!(serde_json::to_string(&code).expect("serialize"), expected);
        }
    }

    #[test]
    fn prerequisite_state_serializes_with_the_setup_wire_vocabulary() {
        assert_eq!(
            serde_json::to_string(&PrerequisiteState::Installed).expect("serialize"),
            "\"installed\""
        );
        assert_eq!(
            serde_json::to_string(&PrerequisiteState::Missing).expect("serialize"),
            "\"missing\""
        );
        assert_eq!(
            serde_json::to_string(&PrerequisiteState::Error).expect("serialize"),
            "\"error\""
        );
    }

    /// Map a resolver outcome to an executable path or the launch code.
    #[test]
    fn executable_or_code_passes_a_resolved_path_through() {
        let path = executable_or_code(Ok(Some(PathBuf::from("C:/llama/llama-server.exe"))))
            .expect("resolved");
        assert_eq!(path, PathBuf::from("C:/llama/llama-server.exe"));
    }

    // ── Spec #3141 ST-1: the serialized status payload (G-413) ──────────────
    //
    // The status surface crosses IPC, so the proof must be on the SERIALIZED
    // payload, not the authoring type. Two explicit cases:
    //   (a) an ABSENT-KEY case: with no engine loaded the JSON carries NO
    //       `backend` / `lastErrorCode` / `modelId` key (NFR-9 — never a `null`);
    //   (b) a PRESENT case: a loaded engine carries the keys with their values.

    #[test]
    fn idle_status_omits_every_optional_additive_key() {
        let status = LlamaServerStatus::idle(CompanionBackendMode::Auto);
        let value = serde_json::to_value(&status).expect("serialize");

        // NFR-9: unset optional fields are ABSENT KEYS, never explicit nulls.
        assert!(
            value.get("backend").is_none(),
            "no engine loaded ⇒ NO `backend` key: {value}"
        );
        assert!(
            value.get("lastErrorCode").is_none(),
            "no failure ⇒ NO `lastErrorCode` key: {value}"
        );
        assert!(
            value.get("modelId").is_none(),
            "no engine loaded ⇒ NO `modelId` key: {value}"
        );
        assert!(
            value.get("mtpStats").is_none(),
            "no turn has run ⇒ NO `mtpStats` key: {value}"
        );

        // The always-present additive fields are present.
        assert_eq!(value["backendMode"], "auto");
        assert_eq!(value["devices"], serde_json::json!([]));

        // The PRE-EXISTING optional fields keep their explicit-null wire form
        // (AC-26 stability): port / pid / lastError serialize as null.
        assert!(value.get("port").is_some(), "port key is always present: {value}");
        assert!(value["port"].is_null());
        assert!(value.get("pid").is_some(), "pid key is always present: {value}");
        assert!(value["pid"].is_null());
        assert!(value.get("lastError").is_some());
        assert!(value["lastError"].is_null());
    }

    #[test]
    fn loaded_status_carries_every_optional_additive_key_with_its_value() {
        let snapshot = super::super::engine::handle::EngineStatusSnapshot {
            loaded: true,
            last_error_code: Some(super::super::engine::CompanionEngineErrorCode::GpuUnavailable),
            last_error: Some("no GPU".to_string()),
            backend: Some(CompanionBackendKind::Gpu),
            devices: vec![CompanionDeviceInfo {
                name: "CUDA0".to_string(),
                description: "NVIDIA GeForce RTX 4090".to_string(),
                device_type: CompanionBackendKind::Gpu,
                memory_free_bytes: 1_000,
                memory_total_bytes: 2_000,
            }],
            model_id: Some("gemma-4-E2B-it-qat-UD-Q4_K_XL".to_string()),
            mtp_stats: Some(super::super::engine::mtp::MtpStats {
                drafts_proposed: 12,
                drafts_accepted: 7,
                draft_calls: 10,
            }),
        };
        let slot = EngineSlot {
            snapshot,
            mode: CompanionBackendMode::Gpu,
        };
        let value = serde_json::to_value(LlamaServerStatus::from_slot(&slot)).expect("serialize");

        // The present case: every additive key is present with the right value.
        assert_eq!(value["backend"], "gpu");
        assert_eq!(value["lastErrorCode"], "gpuUnavailable");
        assert_eq!(value["modelId"], "gemma-4-E2B-it-qat-UD-Q4_K_XL");
        assert_eq!(value["backendMode"], "gpu");
        assert_eq!(value["devices"][0]["name"], "CUDA0");
        assert_eq!(value["devices"][0]["deviceType"], "gpu");
        assert_eq!(value["devices"][0]["memoryFreeBytes"], 1_000);
        assert_eq!(value["devices"][0]["memoryTotalBytes"], 2_000);

        // The MTP counters ride the SAME status surface, camelCase (R-19.1).
        assert_eq!(value["mtpStats"]["draftsProposed"], 12);
        assert_eq!(value["mtpStats"]["draftsAccepted"], 7);
        assert_eq!(value["mtpStats"]["draftCalls"], 10);

        // In-process: port and pid are ALWAYS null, never a number.
        assert!(value["port"].is_null());
        assert!(value["pid"].is_null());
    }
}
