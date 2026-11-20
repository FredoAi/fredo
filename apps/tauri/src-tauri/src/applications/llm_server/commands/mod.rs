//! Companion command surface, split by CONCERN (Spec #3141, ST-1; teardown ST-6).
//!
//! * [`engine`] — the in-process engine lifecycle + the status surface.
//! * [`chat`] — the chat/vision/audio turns (in-process since ST-3).
//! * [`capability`] — the model-audio capability read (in-process since ST-5).
//!
//! The wire models and helpers the sub-modules share live here in the module
//! root.
//!
//! ## Status surface (AC-22.3 / AC-24 / AC-25)
//!
//! [`LlamaServerStatus`] keeps its EXISTING fields (byte-for-byte wire
//! stability — AC-26) and carries the ADDITIVE fields `lastErrorCode`,
//! `backend`, `backendMode`, `devices`, `modelId`, `mtpStats`, and `starting`
//! (Spec #3180 ST-2: always present, `true` while a start is in flight). Every
//! NEW optional field is carried as an ABSENT KEY when unset (never an explicit
//! `null`, NFR-9); the PRE-EXISTING optional fields keep their current
//! explicit-`null` form.
//!
//! ## What ST-6 removed
//!
//! The pre-migration launch path is GONE: `LlamaServerConfigPreview`,
//! `LlamaServerLaunchResult` / `LlamaServerLaunchCode`, the args-override model
//! (`LlamaServerArgsOverride` / `apply_args_override`), `build_launch_config`,
//! `executable_or_code`, `companion_paths`, `materialize_config`, the
//! managed-process slot helpers (`lock_state` / `running_snapshot` /
//! `stop_managed` / `persist_managed_pid`), `health_probe_once`,
//! `missing_model_files_detail`, `resolve_model_path`, and the launch-wait
//! helpers. No live consumer remained after ST-3 re-pointed the chat path and
//! the Doom agent (G-430).

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::SettingsStore;

use super::engine::handle::{CompanionEngineHandle, EngineSlot};
use super::engine::{CompanionBackendKind, CompanionBackendMode, CompanionDeviceInfo};
use super::LLAMA_SERVER_BACKEND_KEY;

pub mod capability;
pub mod chat;
pub mod engine;

// ── Wire models (camelCase, IPC) ──────────────────────────────────────────────

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
    /// A start is IN FLIGHT (Spec #3180 ST-2). ADDITIVE and ALWAYS PRESENT on
    /// the wire (never an absent key, never `null`) — like `backendMode` /
    /// `devices`, so the webview can distinguish an idle engine (`false`) from a
    /// load that is still running (`true`).
    pub starting: bool,
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
            starting: snapshot.starting,
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
            starting: false,
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

// ── Settings access (SettingsStore is the single source of truth) ──────────────────

pub(crate) fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    app.state::<Arc<SettingsStore>>()
        .cached_get(key)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The persisted backend mode (coerced to `auto` for an unknown value).
pub(crate) fn backend_mode(app: &AppHandle) -> CompanionBackendMode {
    CompanionBackendMode::from_persisted(get_setting(app, LLAMA_SERVER_BACKEND_KEY).as_deref())
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

/// The three absolute model paths the engine loads, resolved through the SHARED
/// #2856 manifest rule. `None` when the manifest declares no file for `id`.
///
/// This is the ONE path rule the status surface would need if it reported
/// per-file paths; the engine resolves its own paths in
/// [`super::engine::paths`], so this helper exists only for the settings tests
/// that pin the manifest join.
#[cfg(test)]
pub(crate) fn manifest_path_for(
    models_dir: &std::path::Path,
    manifest: &crate::infrastructure::companion::models::ModelManifest,
    file_id: &str,
) -> Option<String> {
    manifest
        .files
        .iter()
        .find(|spec| spec.id == file_id)
        .map(|spec| {
            crate::infrastructure::companion::models::file_path(models_dir, manifest, spec)
                .to_string_lossy()
                .into_owned()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::llm_server::engine::handle::EngineSlot;
    use crate::applications::llm_server::engine::CompanionBackendMode;

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
        assert_eq!(
            value["starting"],
            serde_json::json!(false),
            "`starting` is always present (never an absent key): {value}"
        );

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
            starting: false,
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
            mtmd_capability: Some(super::super::engine::multimodal::MtmdCapability {
                vision: true,
                audio: true,
                audio_sample_rate: 16_000,
            }),
        };
        let slot = EngineSlot {
            snapshot,
            mode: CompanionBackendMode::Gpu,
        };
        let value = serde_json::to_value(LlamaServerStatus::from_slot(&slot)).expect("serialize");

        // The present case: every additive key is present with the right value.
        assert_eq!(value["backend"], "gpu");
        assert_eq!(value["starting"], serde_json::json!(false));
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

    /// G-413 wire proof for the new field: `starting` is a SERIALIZED,
    /// ALWAYS-PRESENT key — `false` while idle and `true` while a start is in
    /// flight — and the in-flight payload does not claim the engine is running.
    #[test]
    fn the_starting_key_is_present_and_true_while_a_start_is_in_flight() {
        let idle = serde_json::to_value(LlamaServerStatus::idle(CompanionBackendMode::Auto))
            .expect("serialize idle");
        assert_eq!(
            idle.get("starting"),
            Some(&serde_json::json!(false)),
            "an idle status must carry `starting: false`: {idle}"
        );

        let slot = EngineSlot {
            snapshot: super::super::engine::handle::EngineStatusSnapshot {
                starting: true,
                ..Default::default()
            },
            mode: CompanionBackendMode::Cpu,
        };
        let in_flight = serde_json::to_value(LlamaServerStatus::from_slot(&slot))
            .expect("serialize in-flight");
        assert_eq!(in_flight["starting"], serde_json::json!(true));
        assert_eq!(in_flight["running"], serde_json::json!(false));
        assert_eq!(in_flight["healthy"], serde_json::json!(false));
        assert_eq!(in_flight["backendMode"], "cpu");
    }

    /// The status surface resolves no model path from a persisted per-file
    /// override: the manifest is the ONE path rule (AC-18). The helper joins the
    /// manifest exactly, and the retired override keys are never consulted.
    #[test]
    fn the_manifest_join_is_the_one_path_rule() {
        let manifest = crate::infrastructure::companion::models::default_manifest();
        let models_dir = std::path::Path::new("C:/fredo-models");
        let model = manifest_path_for(models_dir, &manifest, "model").expect("model spec");
        // Path equality, not string equality: `Path::join` legitimately renders a
        // mixed-separator path on Windows, and the product has no string consumer.
        let expected = crate::infrastructure::companion::models::file_path(
            models_dir,
            &manifest,
            manifest.files.iter().find(|spec| spec.id == "model").expect("model"),
        );
        assert_eq!(std::path::Path::new(&model), expected);
        assert!(manifest_path_for(models_dir, &manifest, "unknown").is_none());
    }
}
