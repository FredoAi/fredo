//! `fredo companion probe` (Spec #3158 ST-3).
//!
//! The ONE documented CLI diagnostic that makes the companion engine observable
//! from a RELEASE binary. The published artifact has no MCP bridge
//! (`#[cfg(debug_assertions)]` only) and runs no OTel producer, so neither
//! `tauri_webview_*` nor `telemetry_spans` can attach there. This command starts
//! the SAME in-process engine the app uses, runs ONE bounded turn, and prints a
//! single JSON object on stdout — the observable the artifact acceptance rows
//! (AC1/AC2/AC4) are driven from.
//!
//! It is a PRODUCT diagnostic, not a test seam: it is compiled unconditionally
//! (no `#[cfg(debug_assertions)]`), it adds no Tauri command, and it does not
//! touch the process-scoped engine slot. It spawns its OWN
//! [`CompanionEngineHandle`], starts it, runs the turn, and stops it.
//!
//! ## No `AppHandle`
//!
//! A CLI invocation has no Tauri app instance, so the paths use the SAME
//! CLI-side models-dir rule `fredo setup` uses — `home_dir().join("fredo-models")`
//! ([`crate::infrastructure::cli::commands::setup`]) — plus the compiled
//! [`default_manifest`]. `EnginePaths::resolve` + `resolve_for_app` give the
//! typed missing-file refusal; `resolve_for_handle` is deliberately NOT used
//! (it requires an `AppHandle`).
//!
//! ## `gpuLayers` is the load's own projection
//!
//! The reported offload count comes from the engine's ONE projection rule —
//! [`device::project`] + [`device::gpu_layers_for`] over the device set the
//! start reported — so the probe cannot invent a second offload rule (NFR-6).
//! On the CPU arm it is `0`; on the full-offload arm it is `u32::MAX`
//! (`4294967295`, i.e. "every layer", not a defect).

use std::io::Write;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use serde::Serialize;

use crate::applications::llm_server::chat::LlmMessage;
use crate::applications::llm_server::engine::device;
use crate::applications::llm_server::engine::handle::CompanionEngineHandle;
use crate::applications::llm_server::engine::paths::{self, EnginePaths};
use crate::applications::llm_server::engine::request::ChatTurn;
use crate::applications::llm_server::engine::{
    CompanionBackendKind, CompanionBackendMode, CompanionDeviceInfo, CompanionEngineErrorCode,
    OneShotRequest,
};
use crate::infrastructure::companion::models::default_manifest;

/// The models-dir leaf the CLI rule appends to the user's home directory.
///
/// It is the SAME literal [`crate::infrastructure::cli::commands::setup`] uses
/// (`home_dir().join("fredo-models")`); the drift pin below asserts the two CLI
/// paths cannot diverge.
pub const MODELS_DIR_NAME: &str = "fredo-models";

/// The prompt a bare `fredo companion probe` sends.
pub const DEFAULT_PROMPT: &str = "Reply with one short sentence about the color blue.";

/// The completion budget of the probe turn (bounded — the probe is a smoke test,
/// not a generation surface).
pub const PROBE_MAX_TOKENS: u32 = 64;

/// Exit code: the engine started and answered the turn.
const EXIT_SUCCESS: i32 = 0;
/// Exit code: a typed engine failure (missing model, start/load/backend failure).
const EXIT_ENGINE_FAILURE: i32 = 1;
/// Exit code: a usage or local precondition error (no typed engine outcome).
const EXIT_USAGE: i32 = 2;

/// `fredo companion` — companion engine diagnostics (local only).
#[derive(Debug, Args)]
pub struct CompanionArgs {
    #[command(subcommand)]
    pub command: CompanionCommand,
}

/// The `fredo companion` subcommands.
#[derive(Debug, Subcommand)]
pub enum CompanionCommand {
    /// Start the companion engine and run one bounded turn (no app required)
    ///
    /// Runs the in-process engine from THIS binary and prints one JSON object on
    /// stdout: `success`, `backend`, `backendMode`, `gpuLayers`, `devices`,
    /// `modelId`, `replyChars`, and `detail` (plus `code` on a typed failure).
    ///
    /// Precondition: the three GGUF model files are present under
    /// `<home>/fredo-models` (run `fredo setup --download-model` first). The
    /// model files are NOT part of the installer payload; a probe without them
    /// reports the engine's typed `modelMissing` / `mmprojInitFailed` detail.
    ///
    /// Exit codes:
    ///   0  the engine started and answered the turn
    ///   1  a typed engine failure (the `code` field names it)
    ///   2  a usage or local precondition error
    Probe(ProbeArgs),
    /// Score the committed companion fixture set and detect regressions
    ///
    /// Drives every committed fixture through the in-process engine, scores each
    /// against its OWN structural expectation, compares the pass set against a
    /// committed baseline, and prints one JSON object on stdout.
    ///
    /// Precondition: the three GGUF model files are present. The `score` command
    /// resolves the models dir from `FREDO_COMPANION_MODELS_DIR` (non-blank) else
    /// `<home>/fredo-models`; the `probe` resolves `<home>/fredo-models` and
    /// IGNORES that lever. With them absent the command takes a NAMED skip and
    /// prints NO total.
    ///
    /// Exit codes:
    ///   0  every fixture passed and no regression was detected
    ///   1  a fixture failed, the engine could not start, or a regression
    ///   2  a usage or local precondition error
    ///   3  skipped: the pinned model files are absent (no score)
    Score(super::companion_score::ScoreArgs),
}

/// Arguments for `fredo companion probe`.
#[derive(Debug, Parser)]
pub struct ProbeArgs {
    /// Text of the single probe turn (default: a short sentence about the color blue)
    #[arg(long, value_name = "TEXT")]
    pub prompt: Option<String>,
}

/// One device in the probe report — the contract's four-field shape (the
/// engine's internal `description` is not part of the probe wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeDevice {
    /// The ggml device name (`CPU`, `Vulkan0`, …).
    pub name: String,
    /// The device class token (`cpu`, `gpu`, `integratedGpu`, …).
    pub device_type: CompanionBackendKind,
    /// Free device memory, in bytes.
    pub memory_free_bytes: u64,
    /// Total device memory, in bytes.
    pub memory_total_bytes: u64,
}

impl From<&CompanionDeviceInfo> for ProbeDevice {
    fn from(device: &CompanionDeviceInfo) -> Self {
        Self {
            name: device.name.clone(),
            device_type: device.device_type,
            memory_free_bytes: device.memory_free_bytes,
            memory_total_bytes: device.memory_total_bytes,
        }
    }
}

/// The ONE JSON object the probe prints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// The engine started and answered the turn.
    pub success: bool,
    /// The typed failure code — present only on a typed engine failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<CompanionEngineErrorCode>,
    /// The backend class ggml reported for the loaded device set.
    pub backend: Option<CompanionBackendKind>,
    /// The requested backend mode (`auto` — the probe always uses the default).
    pub backend_mode: CompanionBackendMode,
    /// GPU layers the load's own projection resolves to (`0` on the CPU arm).
    pub gpu_layers: u32,
    /// The device set the start reported.
    pub devices: Vec<ProbeDevice>,
    /// The main model's id (the manifest `model` file stem).
    pub model_id: String,
    /// Characters in the assistant reply (`0` when no reply was produced).
    pub reply_chars: usize,
    /// The engine's detail string (curated failure detail, or the ready sentence).
    pub detail: String,
}

impl ProbeReport {
    /// A typed engine failure with the engine's own detail.
    fn failure(code: CompanionEngineErrorCode, detail: String, model_id: String) -> Self {
        Self {
            success: false,
            code: Some(code),
            backend: None,
            backend_mode: CompanionBackendMode::Auto,
            gpu_layers: 0,
            devices: Vec::new(),
            model_id,
            reply_chars: 0,
            detail,
        }
    }

    /// A local usage/precondition failure (no typed engine outcome).
    fn usage(detail: String) -> Self {
        Self {
            success: false,
            code: None,
            backend: None,
            backend_mode: CompanionBackendMode::Auto,
            gpu_layers: 0,
            devices: Vec::new(),
            model_id: String::new(),
            reply_chars: 0,
            detail,
        }
    }
}

/// The home directory, resolved with the SAME rule
/// [`crate::infrastructure::cli::commands::setup`] uses.
fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

/// The CLI models dir — `<home>/fredo-models`, the exact literal `fredo setup`
/// uses (the manifest subdir is appended by the shared manifest rule).
fn cli_models_dir() -> PathBuf {
    home_dir().join(MODELS_DIR_NAME)
}

/// The `gpuLayers` the probe reports: the SAME projection the load uses
/// ([`device::project`] + [`device::gpu_layers_for`], never a second rule).
pub fn projection_gpu_layers(
    mode: CompanionBackendMode,
    devices: &[CompanionDeviceInfo],
) -> u32 {
    let projection = device::project(mode, devices);
    device::gpu_layers_for(projection)
}

/// Resolve the probe prompt: the caller's text, or the default; a blank
/// explicit value is a usage error.
fn resolve_prompt(prompt: Option<&str>) -> Result<String, String> {
    match prompt {
        None => Ok(DEFAULT_PROMPT.to_string()),
        Some(value) if value.trim().is_empty() => Err("--prompt must not be blank.".to_string()),
        Some(value) => Ok(value.to_string()),
    }
}

/// A per-turn distribution seed (the production `EngineOneShotSource` uses a
/// fresh seed too; the probe need not report it).
fn fresh_seed() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u32)
        .unwrap_or(0)
}

/// Run `fredo companion <subcommand>`.
pub async fn run_companion(args: &CompanionArgs) -> anyhow::Result<()> {
    match &args.command {
        CompanionCommand::Probe(probe) => run_probe(probe).await,
        CompanionCommand::Score(score) => {
            super::companion_score::run_score(score).await
        }
    }
}

/// Run the probe, print ONE JSON object on stdout, and exit 0/1/2.
async fn run_probe(args: &ProbeArgs) -> anyhow::Result<()> {
    let (report, exit_code) = probe(args).await;
    let json = serde_json::to_string(&report)?;
    // Flush explicitly: `process::exit` must not race a buffered stdout on the
    // release (windows-subsystem) binary whose stdout is redirected by the caller.
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{json}")?;
    stdout.flush()?;
    std::process::exit(exit_code);
}

/// Build the probe report and its exit code. Pure over the engine boundary, so
/// the report shape is unit-pinnable.
async fn probe(args: &ProbeArgs) -> (ProbeReport, i32) {
    let prompt = match resolve_prompt(args.prompt.as_deref()) {
        Ok(prompt) => prompt,
        Err(detail) => return (ProbeReport::usage(detail), EXIT_USAGE),
    };

    let models_dir: PathBuf = cli_models_dir();
    let manifest = default_manifest();
    // Resolve the canonical model id from the SAME joined paths the engine
    // loads, so a refusal still names the model.
    let model_id = paths::model_id_for(&EnginePaths::resolve(&models_dir, &manifest).model)
        .unwrap_or_default();

    // The typed missing-file refusal (a precondition failure, not an artifact
    // failure): `resolve_for_app` names every absent file and classifies the
    // code by subsystem.
    let engine_paths = match paths::resolve_for_app(&models_dir, &manifest) {
        Ok(paths) => paths,
        Err((code, detail)) => {
            return (ProbeReport::failure(code, detail, model_id), EXIT_ENGINE_FAILURE)
        }
    };

    // Spawn THIS invocation's own engine handle; nothing process-global is
    // touched, so a probe never enables or disables the app's companion.
    let handle = CompanionEngineHandle::spawn();

    let started = handle.start(engine_paths.clone(), CompanionBackendMode::Auto);
    if !started.success {
        handle.stop();
        let code = started
            .code
            .unwrap_or(CompanionEngineErrorCode::BackendInitFailed);
        return (
            ProbeReport::failure(code, started.detail, model_id),
            EXIT_ENGINE_FAILURE,
        );
    }

    // The SAME projection the load used decides the reported offload count.
    let gpu_layers = projection_gpu_layers(CompanionBackendMode::Auto, &started.devices);
    let devices: Vec<ProbeDevice> = started.devices.iter().map(ProbeDevice::from).collect();

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let turn = ChatTurn::text(vec![LlmMessage {
        role: "user".to_string(),
        content: prompt,
    }])
    .with_max_tokens(PROBE_MAX_TOKENS);
    let request = OneShotRequest {
        turn,
        reply: reply_tx,
        paths: engine_paths,
        mode: CompanionBackendMode::Auto,
        seed: fresh_seed(),
    };
    if let Err((code, detail)) = handle.one_shot(request) {
        handle.stop();
        return (
            ProbeReport {
                success: false,
                code: Some(code),
                backend: started.backend,
                backend_mode: CompanionBackendMode::Auto,
                gpu_layers,
                devices,
                model_id,
                reply_chars: 0,
                detail,
            },
            EXIT_ENGINE_FAILURE,
        );
    }

    let (success, reply_chars, code, detail) = match reply_rx.await {
        Ok(Ok(reply)) => (true, reply.content.chars().count(), None, started.detail),
        Ok(Err((code, detail))) => (false, 0, Some(code), detail),
        // A dropped reply channel means the engine thread went away mid-turn.
        // Never a default empty success (the shipped F1 fix).
        Err(_) => (
            false,
            0,
            Some(CompanionEngineErrorCode::BackendInitFailed),
            "the companion engine stopped before the turn finished. Start the engine again and retry."
                .to_string(),
        ),
    };

    // Release this invocation's engine before the process exits.
    handle.stop();

    let exit_code = if success {
        EXIT_SUCCESS
    } else {
        EXIT_ENGINE_FAILURE
    };
    (
        ProbeReport {
            success,
            code,
            backend: started.backend,
            backend_mode: CompanionBackendMode::Auto,
            gpu_layers,
            devices,
            model_id,
            reply_chars,
            detail,
        },
        exit_code,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::applications::llm_server::engine::device::ModeProjection;

    fn cpu_device() -> CompanionDeviceInfo {
        CompanionDeviceInfo {
            name: "CPU".to_string(),
            description: "CPU".to_string(),
            device_type: CompanionBackendKind::Cpu,
            memory_free_bytes: 0,
            memory_total_bytes: 0,
        }
    }

    fn gpu_device() -> CompanionDeviceInfo {
        CompanionDeviceInfo {
            name: "Vulkan0".to_string(),
            description: "Test GPU".to_string(),
            device_type: CompanionBackendKind::Gpu,
            memory_free_bytes: 1,
            memory_total_bytes: 2,
        }
    }

    /// ST-3: the reported `gpuLayers` covers all three `ModeProjection` arms —
    /// the load's OWN rule, never a second derivation.
    #[test]
    fn companion_probe_projection_maps_every_mode_projection_arm() {
        // FullOffload ⇒ u32::MAX ("every layer").
        assert_eq!(
            projection_gpu_layers(CompanionBackendMode::Auto, &[gpu_device()]),
            u32::MAX
        );
        // CpuOnly ⇒ 0 (no usable GPU under `auto`, or `cpu` mode).
        assert_eq!(
            projection_gpu_layers(CompanionBackendMode::Auto, &[cpu_device()]),
            0
        );
        assert_eq!(
            projection_gpu_layers(CompanionBackendMode::Cpu, &[gpu_device()]),
            0
        );
        // GpuUnavailable never reaches an offload request (0 layers); the probe
        // itself always starts in `auto`, but the projection arm is pinned.
        assert_eq!(
            projection_gpu_layers(CompanionBackendMode::Gpu, &[cpu_device()]),
            0
        );
        // And the three arms resolve exactly through the shared mapper.
        assert_eq!(device::gpu_layers_for(ModeProjection::FullOffload), u32::MAX);
        assert_eq!(device::gpu_layers_for(ModeProjection::CpuOnly), 0);
        assert_eq!(device::gpu_layers_for(ModeProjection::GpuUnavailable), 0);
    }

    /// ST-3: the serialized success report carries EXACTLY the contract's field
    /// set, with the contract's tokens and device shape.
    #[test]
    fn companion_probe_report_serializes_the_contract_field_set() {
        let report = ProbeReport {
            success: true,
            code: None,
            backend: Some(CompanionBackendKind::Cpu),
            backend_mode: CompanionBackendMode::Auto,
            gpu_layers: 0,
            devices: vec![ProbeDevice::from(&cpu_device())],
            model_id: "gemma-4-E2B-it-qat-UD-Q4_K_XL".to_string(),
            reply_chars: 42,
            detail: "the companion engine is ready.".to_string(),
        };
        let value = serde_json::to_value(&report).expect("serialize a probe report");
        let object = value.as_object().expect("the probe report is one JSON object");

        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "backend",
                "backendMode",
                "detail",
                "devices",
                "gpuLayers",
                "modelId",
                "replyChars",
                "success",
            ],
            "the success report carries exactly the contract's fields (no `code`)"
        );

        assert_eq!(value["success"], serde_json::json!(true));
        assert_eq!(value["backend"], serde_json::json!("cpu"));
        assert_eq!(value["backendMode"], serde_json::json!("auto"));
        assert_eq!(value["gpuLayers"], serde_json::json!(0));
        assert_eq!(value["modelId"], serde_json::json!("gemma-4-E2B-it-qat-UD-Q4_K_XL"));
        assert_eq!(value["replyChars"], serde_json::json!(42));
        assert!(value["detail"].is_string());

        let device = &value["devices"][0];
        let mut device_keys: Vec<&str> = device
            .as_object()
            .expect("a device is an object")
            .keys()
            .map(String::as_str)
            .collect();
        device_keys.sort_unstable();
        assert_eq!(
            device_keys,
            vec![
                "deviceType",
                "memoryFreeBytes",
                "memoryTotalBytes",
                "name",
            ],
            "the device carries the contract's four fields"
        );
        assert_eq!(device["name"], serde_json::json!("CPU"));
        assert_eq!(device["deviceType"], serde_json::json!("cpu"));
        assert_eq!(device["memoryFreeBytes"], serde_json::json!(0));
        assert_eq!(device["memoryTotalBytes"], serde_json::json!(0));
    }

    /// ST-3: a typed engine failure adds the `code` token and reports the
    /// failure shape the artifact rows classify on (E-2).
    #[test]
    fn companion_probe_failure_report_carries_the_typed_code() {
        let report = ProbeReport::failure(
            CompanionEngineErrorCode::ModelMissing,
            "missing model file(s): gemma-4-e2b-it-qat/model.gguf".to_string(),
            "gemma-4-E2B-it-qat-UD-Q4_K_XL".to_string(),
        );
        let value = serde_json::to_value(&report).expect("serialize a failure report");
        assert_eq!(value["success"], serde_json::json!(false));
        assert_eq!(value["code"], serde_json::json!("modelMissing"));
        assert_eq!(value["gpuLayers"], serde_json::json!(0));
        assert_eq!(value["replyChars"], serde_json::json!(0));
        assert_eq!(value["backend"], serde_json::Value::Null);
        assert!(value["devices"].as_array().expect("devices array").is_empty());
        assert!(value["detail"].as_str().expect("detail string").contains("model.gguf"));
    }

    /// ST-3 (G-254): a blank `--prompt` is a usage error, and the bare form uses
    /// the documented default prompt.
    #[test]
    fn companion_probe_prompt_resolution_and_usage_error() {
        assert_eq!(resolve_prompt(None).expect("default"), DEFAULT_PROMPT);
        assert_eq!(
            resolve_prompt(Some("hi")).expect("explicit prompt"),
            "hi".to_string()
        );
        assert!(resolve_prompt(Some("   ")).is_err());
        assert!(resolve_prompt(Some("")).is_err());
    }

    /// ST-3: `fredo companion probe [--prompt <text>]` parses, and a bogus
    /// subcommand is a parse error (never silently accepted).
    #[test]
    fn companion_probe_parses_the_documented_invocation() {
        use clap::Parser;

        use crate::infrastructure::cli::{Cli, Commands};

        let cli = Cli::try_parse_from(["fredo", "companion", "probe"]).expect("bare probe parses");
        match cli.command {
            Commands::Companion(CompanionArgs {
                command: CompanionCommand::Probe(args),
            }) => assert!(args.prompt.is_none()),
            other => panic!("expected `companion probe`, got {other:?}"),
        }

        let cli = Cli::try_parse_from(["fredo", "companion", "probe", "--prompt", "say hello"])
            .expect("probe --prompt parses");
        match cli.command {
            Commands::Companion(CompanionArgs {
                command: CompanionCommand::Probe(args),
            }) => {
                assert_eq!(args.prompt.as_deref(), Some("say hello"));
            }
            other => panic!("expected `companion probe --prompt`, got {other:?}"),
        }

        assert!(Cli::try_parse_from(["fredo", "companion", "bogus"]).is_err());
    }

    /// ST-3: the CLI models-dir rule cannot drift from `fredo setup` — it is the
    /// SAME literal (`home_dir().join("fredo-models")`). The setup command owns
    /// that literal; this pin reads its source so a future edit there fails here.
    #[test]
    fn companion_probe_models_dir_matches_the_setup_command_literal() {
        // The setup command's literal, verbatim from its own source.
        const SETUP_SOURCE: &str = include_str!("setup.rs");
        assert!(
            SETUP_SOURCE.contains("home_dir().join(\"fredo-models\")"),
            "`fredo setup` changed its models-dir rule; `fredo companion probe` must resolve the \
             same directory (companion_probe.rs follows `home_dir().join(\"fredo-models\")`)"
        );

        // And this module's rule resolves to that exact literal.
        assert_eq!(MODELS_DIR_NAME, "fredo-models");
        assert_eq!(cli_models_dir(), home_dir().join("fredo-models"));
    }
}
