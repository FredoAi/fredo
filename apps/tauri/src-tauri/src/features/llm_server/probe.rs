//! Phase-0 live capability diagnostic for companion skill calling
//! (Spec #2893, ST-1; EARS R-5.1/R-5.2/R-5.3).
//!
//! The `## Triage Plan`'s `### Spike Findings (AC-5)` records the documented
//! capability evidence for OpenAI-style tool calling on the pinned Gemma model +
//! the managed `llama-server`. The one thing the Architect sandbox cannot drive
//! is a LIVE check against the running server. This module closes that gap with a
//! single read-only Tauri command, [`probe_companion_skills`]:
//!
//! 1. `GET /props` → `chat_template_tool_use` (is the loaded GGUF template
//!    tool-aware?) and the server log's `Chat format:` startup line.
//! 2. one streaming `tools` request offering the frozen `open_app` schema,
//!    recording the RAW SSE, whether a `tool_calls` delta was emitted, the
//!    `finish_reason`, whether the stream terminated, and any reasoning deltas.
//! 3. the `response_format` (schema-constrained JSON) variant, recording the raw
//!    content — the documented fallback mechanism.
//!
//! The report carries a derived [`ProbeVerdict`] (`native_tools_usable`,
//! `explicit_jinja_enough`, `template_override_needed`, `reasoning_detected`)
//! plus the Domain Model §Cleanup catalogue, so the mechanism selection is
//! recorded, not assumed.
//!
//! **Read-only contract (ST-1 non-goals):** the probe opens no window, mutates no
//! `AppStore` state (it only reads the configured host/port/log path), launches
//! nothing, and NEVER emits `llm-token`. The live invocation is driven by the
//! Tester through the sanctioned app path; the pure request builders and the
//! transcript observers are unit-tested here.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;
use crate::infrastructure::voice::{SttAudioCapability, SttAudioCapabilityState};

use super::chat::{self, LlmMessage};
use super::process;
use super::{
    DEFAULT_LLAMA_SERVER_PORT, LLAMA_SERVER_ACTIVE_PORT_KEY, LLAMA_SERVER_HOST_KEY,
    LLAMA_SERVER_LOG_PATH_KEY, LLAMA_SERVER_PORT_KEY,
};

/// Bounded lifetime for EACH probe request. The `tools` probe is deliberately
/// testing whether the stream terminates; this client timeout is what keeps a
/// non-terminating stream from hanging the command — it is recorded as
/// `terminated: false` + a stream error, which IS the diagnostic answer.
const PROBE_TIMEOUT_S: u64 = 60;

/// Bytes of the server log scanned for the startup `Chat format:` line.
const LOG_SCAN_BYTES: u64 = 512 * 1024;

/// Characters of a non-200 body included in a probe error (UTF-8 safe).
const ERROR_TAIL_CHARS: usize = 400;

/// The frozen `open_app` tool description (plan API contract §4). A local const
/// keeps ST-1 free of a `requires: ST-3` dependency on `skills.rs`.
pub const OPEN_APP_DESCRIPTION: &str =
    "Open a Fredo desktop app/feature by the name the user said. Use ONLY for an explicit open request.";

/// The probe's system turn — a minimal plain-chat persona so the model has no
/// reason to answer in prose instead of selecting the tool.
pub const PROBE_SYSTEM_PROMPT: &str = "You are Fredo, a desktop companion. Use the provided tool when the user asks to open an app.";

/// The probe's user turn: an explicit open request that SHOULD select `open_app`.
pub const PROBE_PROMPT: &str = "open Mission Monitor";

/// Domain Model §Cleanup catalogue (Spec #2893). With the recommended native
/// tool-calling mechanism NO existing companion extraction code becomes
/// obsolete: the reply path has no multi-path/`??` fallback extraction and its
/// only text normalization is the control-token strip (`CompanionEntity.tsx`).
/// If the probe instead selects prompted structured output, the catalogue is that
/// strip — extend it to the tool-call markers. No follow-up backlog issue is
/// created; a mechanism change loops back to Phase 2 (R-5.3).
pub const CLEANUP_CATALOGUE: &str = "native tools: no existing companion extraction code becomes obsolete. prompted structured output: extend the reply control-token strip to the tool-call markers (loop to Phase 2, no follow-up issue).";

// ── Pure schema / request builders (unit-tested seam) ─────────────────────────

/// The `open_app` tool `parameters` schema (frozen shape, plan API contract §4).
pub fn open_app_parameters_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "app": {
                "type": "string",
                "description": "The Fredo app name or id, without the word 'open'."
            }
        },
        "required": ["app"],
        "additionalProperties": false
    })
}

/// The frozen `open_app` tool declaration offered to the model.
pub fn open_app_tool() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "open_app",
            "description": OPEN_APP_DESCRIPTION,
            "parameters": open_app_parameters_schema(),
        }
    })
}

/// The two-turn probe conversation (system + explicit open request).
pub fn probe_messages() -> Vec<LlmMessage> {
    vec![
        LlmMessage {
            role: "system".to_string(),
            content: PROBE_SYSTEM_PROMPT.to_string(),
        },
        LlmMessage {
            role: "user".to_string(),
            content: PROBE_PROMPT.to_string(),
        },
    ]
}

/// Build the streaming `tools` probe body: the `open_app` tool, `tool_choice:
/// "auto"`, `parallel_tool_calls: false` (documented Gemma4 loop mitigation).
pub fn build_tools_probe_body() -> serde_json::Value {
    chat::build_tools_request_body(
        &probe_messages(),
        &serde_json::json!([open_app_tool()]),
        "auto",
        false,
    )
}

/// Build the streaming `response_format` probe body: the `open_app` argument
/// schema as schema-constrained JSON (the documented fallback mechanism).
pub fn build_response_format_probe_body() -> serde_json::Value {
    chat::build_response_format_request_body(&probe_messages(), &open_app_parameters_schema())
}

// ── Pure transcript / log observation (unit-tested seam) ──────────────────────

/// What a raw SSE transcript reveals about the probe's questions.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseObservations {
    /// A `choices[0].delta.tool_calls` array was present and non-empty.
    pub tool_calls_emitted: bool,
    /// The last non-empty `choices[0].finish_reason` (e.g. `tool_calls`, `stop`).
    pub finish_reason: Option<String>,
    /// A `data: [DONE]` terminator was seen.
    pub terminated: bool,
    /// Concatenated `delta.content` (ordinary / schema-constrained text).
    pub content: String,
    /// A `delta.reasoning_content` / `delta.reasoning` fragment was seen (the
    /// server has reasoning on — evidence for the reasoning-interaction check).
    pub reasoning_detected: bool,
}

/// Fold a raw SSE transcript into the probe's observations. Pure; every
/// malformed/non-`data:` line is skipped, never a panic.
pub fn observe_sse(raw: &str) -> SseObservations {
    let mut observations = SseObservations::default();
    for line in raw.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() {
            continue;
        }
        if payload == "[DONE]" {
            observations.terminated = true;
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };
        let Some(choice) = chunk["choices"].as_array().and_then(|choices| choices.first()) else {
            continue;
        };
        if let Some(reason) = choice["finish_reason"].as_str() {
            if !reason.is_empty() {
                observations.finish_reason = Some(reason.to_string());
            }
        }
        if let Some(delta) = choice.get("delta") {
            if delta["tool_calls"]
                .as_array()
                .map(|calls| !calls.is_empty())
                .unwrap_or(false)
            {
                observations.tool_calls_emitted = true;
            }
            if let Some(content) = delta["content"].as_str() {
                observations.content.push_str(content);
            }
            let reasoning = delta["reasoning_content"].as_str().unwrap_or_default();
            let legacy_reasoning = delta["reasoning"].as_str().unwrap_or_default();
            if !reasoning.is_empty() || !legacy_reasoning.is_empty() {
                observations.reasoning_detected = true;
            }
        }
    }
    observations
}

/// Pure: `chat_template_tool_use` from the `/props` JSON (absent/null => `None`).
pub fn chat_template_tool_use_from_props(props: &serde_json::Value) -> Option<bool> {
    props.get("chat_template_tool_use").and_then(|value| value.as_bool())
}

/// Pure: whether `/props` carries a non-empty `chat_template` (i.e. the server
/// resolved a template, so `--chat-template` would actually take effect).
pub fn chat_template_present_from_props(props: &serde_json::Value) -> bool {
    props
        .get("chat_template")
        .and_then(|value| value.as_str())
        .map(|template| !template.is_empty())
        .unwrap_or(false)
}

/// Pure: the first `Chat format:` line of a server-log excerpt.
pub fn extract_chat_format_line(log: &str) -> Option<String> {
    log.lines()
        .find(|line| line.contains("Chat format:"))
        .map(|line| line.trim().to_string())
}

/// Pure derived verdict for the mechanism questions the capsule must record.
pub fn compute_verdict(
    chat_template_tool_use: Option<bool>,
    tool_calls_emitted: bool,
    terminated: bool,
    had_error: bool,
    reasoning_detected: bool,
) -> ProbeVerdict {
    let native_tools_usable = tool_calls_emitted && terminated && !had_error;
    let explicit_jinja_enough = matches!(chat_template_tool_use, Some(true));
    let template_override_needed = matches!(chat_template_tool_use, Some(false));
    let summary = match (chat_template_tool_use, native_tools_usable) {
        (Some(true), true) => {
            "native tools usable; /props reports chat_template_tool_use=true, so an explicit --jinja is sufficient (no template override needed).".to_string()
        }
        (Some(true), false) => {
            "the template is tool-aware (chat_template_tool_use=true) but the probe did not observe a completed tool call — inspect the raw SSE.".to_string()
        }
        (Some(false), true) => {
            "native tools usable, but /props reports chat_template_tool_use=false — a --chat-template/--chat-template-file override is needed.".to_string()
        }
        (Some(false), false) => {
            "the template is not tool-aware (chat_template_tool_use=false) and no tool call was observed — use the response_format fallback or provide a template override.".to_string()
        }
        (None, _) => {
            "/props did not report chat_template_tool_use — the server may be an older build; inspect the raw props.".to_string()
        }
    };
    ProbeVerdict {
        native_tools_usable,
        explicit_jinja_enough,
        template_override_needed,
        reasoning_detected,
        summary,
    }
}

// ── Wire models (camelCase, IPC) ──────────────────────────────────────────────

/// The `/props` capability read.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PropsProbe {
    pub url: String,
    /// `chat_template_tool_use` read from `/props` (`None` when not reported).
    pub chat_template_tool_use: Option<bool>,
    /// Whether `/props` carries a non-empty resolved `chat_template`.
    pub chat_template_present: bool,
    /// The full `/props` payload, kept verbatim for the tester's evidence.
    pub raw: serde_json::Value,
}

/// The native `tools` probe outcome (raw SSE + observations).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolsProbe {
    pub request: serde_json::Value,
    pub raw_sse: String,
    pub tool_calls_emitted: bool,
    pub finish_reason: Option<String>,
    pub terminated: bool,
    pub reasoning_detected: bool,
    pub content: String,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// The `response_format` (schema-constrained) probe outcome.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResponseFormatProbe {
    pub request: serde_json::Value,
    pub raw_sse: String,
    pub content: String,
    pub finish_reason: Option<String>,
    pub terminated: bool,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// The derived mechanism verdict the capsule records.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeVerdict {
    pub native_tools_usable: bool,
    pub explicit_jinja_enough: bool,
    pub template_override_needed: bool,
    pub reasoning_detected: bool,
    pub summary: String,
}

/// The full ST-1 probe report returned to the caller.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSkillProbeReport {
    pub host: String,
    pub port: u16,
    pub props: PropsProbe,
    pub log_path: Option<String>,
    pub log_chat_format_line: Option<String>,
    pub tools: ToolsProbe,
    pub response_format: ResponseFormatProbe,
    pub verdict: ProbeVerdict,
    pub cleanup_catalogue: String,
}

// ── Live probe (read-only; driven by the Tester) ──────────────────────────────

struct StreamOutcome {
    raw_sse: String,
    tool_calls_emitted: bool,
    finish_reason: Option<String>,
    terminated: bool,
    reasoning_detected: bool,
    content: String,
    duration_ms: u64,
    error: Option<String>,
}

impl StreamOutcome {
    fn from_observations(raw_sse: String, duration_ms: u64, error: Option<String>) -> Self {
        let observations = observe_sse(&raw_sse);
        Self {
            tool_calls_emitted: observations.tool_calls_emitted,
            finish_reason: observations.finish_reason,
            terminated: observations.terminated,
            reasoning_detected: observations.reasoning_detected,
            content: observations.content,
            raw_sse,
            duration_ms,
            error,
        }
    }
}

fn store_string(app: &AppHandle, key: &str) -> Option<String> {
    app.state::<Arc<AppStore>>().get(key).ok().flatten()
}

/// Read the server port WITHOUT mutating any state: the live active port when
/// persisted, else the configured port, else the product default.
fn resolve_probe_port(app: &AppHandle) -> u16 {
    for key in [LLAMA_SERVER_ACTIVE_PORT_KEY, LLAMA_SERVER_PORT_KEY] {
        if let Some(value) = store_string(app, key) {
            if let Ok(port) = value.trim().parse::<u16>() {
                return port;
            }
        }
    }
    DEFAULT_LLAMA_SERVER_PORT
}

/// Resolve the server log read-only: the persisted managed log path when set,
/// else the default companion-dir log. Returns `None` when neither is derivable.
fn resolve_probe_log_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(configured) = store_string(app, LLAMA_SERVER_LOG_PATH_KEY) {
        let configured = configured.trim();
        if !configured.is_empty() {
            return Some(PathBuf::from(configured));
        }
    }
    process::resolve_companion_dir(app)
        .ok()
        .map(|dir| process::log_path(&dir))
}

/// Bounded read of the START of the server log (where the startup `Chat format:`
/// line lives) — never loads an unbounded log into memory.
fn read_log_excerpt(path: &Path) -> String {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let _ = file
        .take(LOG_SCAN_BYTES)
        .read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Head of a string by character count (UTF-8 safe), with an ellipsis marker.
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut head: String = text.chars().take(max_chars).collect();
    head.push('…');
    head
}

/// POST one streaming request and collect the raw SSE within [`PROBE_TIMEOUT_S`].
async fn run_stream_probe(
    client: &reqwest::Client,
    endpoint: &str,
    body: &serde_json::Value,
) -> StreamOutcome {
    let started = std::time::Instant::now();
    let response = match client.post(endpoint).json(body).send().await {
        Ok(response) => response,
        Err(e) => {
            return StreamOutcome::from_observations(
                String::new(),
                started.elapsed().as_millis() as u64,
                Some(format!("request to {endpoint} failed: {e}")),
            );
        }
    };

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return StreamOutcome::from_observations(
            String::new(),
            started.elapsed().as_millis() as u64,
            Some(format!(
                "HTTP {}: {}",
                status.as_u16(),
                truncate(detail.trim(), ERROR_TAIL_CHARS)
            )),
        );
    }

    let mut bytes: Vec<u8> = Vec::new();
    let mut error = None;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => bytes.extend_from_slice(&chunk),
            Err(e) => {
                // A non-terminating stream surfaces here as the client timeout —
                // `terminated: false` IS the answer to "does it terminate?".
                error = Some(format!("stream failed: {e}"));
                break;
            }
        }
    }

    StreamOutcome::from_observations(
        String::from_utf8_lossy(&bytes).into_owned(),
        started.elapsed().as_millis() as u64,
        error,
    )
}

/// **ST-1** — the read-only Phase-0 live capability diagnostic.
///
/// Reads `/props` (tool-aware template?), the server log's `Chat format:` line,
/// then issues one streaming `tools` request and one `response_format` request,
/// returning the raw transcripts + the derived verdict. Never opens a window,
/// never writes `AppStore` state, never emits `llm-token`.
///
/// `Err` only when the managed server is unreachable / `/props` fails — start the
/// managed server first, then re-invoke.
#[tauri::command]
pub async fn probe_companion_skills(app: AppHandle) -> Result<CompanionSkillProbeReport, String> {
    let host = chat::resolve_host(store_string(&app, LLAMA_SERVER_HOST_KEY).as_deref());
    let port = resolve_probe_port(&app);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(PROBE_TIMEOUT_S))
        .build()
        .map_err(|e| format!("could not build the probe HTTP client: {e}"))?;

    // (a) GET /props — the live template capability check.
    let url = chat::props_url(&host, port);
    let response = client.get(&url).send().await.map_err(|e| {
        format!("the companion server is not reachable at {url}: {e} — start the managed llama-server first")
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GET {url} returned HTTP {}", status.as_u16()));
    }
    let raw: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("GET {url} did not return JSON: {e}"))?;
    let chat_template_tool_use = chat_template_tool_use_from_props(&raw);
    let chat_template_present = chat_template_present_from_props(&raw);

    // Server log's `Chat format:` startup line (read-only).
    let log_path = resolve_probe_log_path(&app);
    let log_chat_format_line = log_path
        .as_deref()
        .and_then(|path| extract_chat_format_line(&read_log_excerpt(path)));

    // (b) native `tools` probe, then (c) the `response_format` fallback probe.
    let chat_url = chat::chat_completions_url(&host, port);
    let tools_request = build_tools_probe_body();
    let tools_outcome = run_stream_probe(&client, &chat_url, &tools_request).await;
    let response_format_request = build_response_format_probe_body();
    let response_format_outcome =
        run_stream_probe(&client, &chat_url, &response_format_request).await;

    let verdict = compute_verdict(
        chat_template_tool_use,
        tools_outcome.tool_calls_emitted,
        tools_outcome.terminated,
        tools_outcome.error.is_some(),
        tools_outcome.reasoning_detected,
    );

    Ok(CompanionSkillProbeReport {
        host,
        port,
        props: PropsProbe {
            url,
            chat_template_tool_use,
            chat_template_present,
            raw,
        },
        log_path: log_path.map(|path| path.to_string_lossy().into_owned()),
        log_chat_format_line,
        tools: ToolsProbe {
            request: tools_request,
            raw_sse: tools_outcome.raw_sse,
            tool_calls_emitted: tools_outcome.tool_calls_emitted,
            finish_reason: tools_outcome.finish_reason,
            terminated: tools_outcome.terminated,
            reasoning_detected: tools_outcome.reasoning_detected,
            content: tools_outcome.content,
            duration_ms: tools_outcome.duration_ms,
            error: tools_outcome.error,
        },
        response_format: ResponseFormatProbe {
            request: response_format_request,
            raw_sse: response_format_outcome.raw_sse,
            content: response_format_outcome.content,
            finish_reason: response_format_outcome.finish_reason,
            terminated: response_format_outcome.terminated,
            duration_ms: response_format_outcome.duration_ms,
            error: response_format_outcome.error,
        },
        verdict,
        cleanup_catalogue: CLEANUP_CATALOGUE.to_string(),
    })
}

// ── ST-6 model-audio capability probe (Spec #2897; REQ-7) ─────────────────────
//
// ST-6 exposes the backend-owned `stt_audio_capability` command the Companion
// readiness row (C0r) consumes. The UI NEVER infers capability from a model name:
// this probe answers the question from the LIVE managed server, exactly as ST-0's
// receipt does — reachability of the loopback endpoint, then an `input_audio`
// acceptance POST rendered by the ONE production renderer (`chat::render_messages`
// → `chat::audio_content_part`). It is read-only with respect to app state and
// never panics: an unreachable server is the truthful `serverUnavailable`.

/// Bounded lifetime for the capability probe. It is a settings-row probe, so it
/// must answer promptly; a hung server degrades to `unknown`, never a hang.
const CAPABILITY_PROBE_TIMEOUT_S: u64 = 8;

/// TCP connect budget for the capability probe (a refused loopback connect is
/// immediate; this bounds a wedged listener).
const CAPABILITY_PROBE_CONNECT_TIMEOUT_S: u64 = 2;

/// The synthetic probe clip: 0.1 s of silence at 16 kHz mono 16-bit PCM. The
/// audio CONTENT is irrelevant to the capability question — only whether the
/// managed server accepts the `input_audio` content part is. This is NOT the
/// capture encoder (`infrastructure/voice/` encodes the real clip); it is a fixed
/// synthetic payload for the probe.
const CAPABILITY_PROBE_SAMPLES: usize = 1_600;

/// The capability probe's system turn — minimal and neutral.
const CAPABILITY_PROBE_SYSTEM_PROMPT: &str =
    "You are Fredo, a desktop companion. Respond to the user's message.";

/// `/v1/models` URL for a bound host/port (the resolved managed host, so the
/// probe can only address the loopback server).
pub fn models_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/v1/models")
}

/// The synthetic probe conversation (system + ONE empty user turn whose content
/// is replaced by the audio part).
pub(crate) fn capability_probe_messages() -> Vec<LlmMessage> {
    vec![
        LlmMessage {
            role: "system".to_string(),
            content: CAPABILITY_PROBE_SYSTEM_PROMPT.to_string(),
        },
        LlmMessage {
            role: "user".to_string(),
            content: String::new(),
        },
    ]
}

/// Encode a fixed 16 kHz mono 16-bit PCM WAV of `samples` silent frames. Pure so
/// the format contract is unit-pinned; the probe payload is tiny and constant.
pub(crate) fn capability_probe_wav(samples: usize) -> Vec<u8> {
    let sample_rate: u32 = 16_000;
    let data_len = (samples * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.resize(44 + data_len as usize, 0);
    bytes
}

/// The capability probe body: the ONE renderer (`chat::render_messages`) with the
/// audio part on the LAST user message and a single-token cap (the probe only
/// needs the server's accept/reject verdict, not a completion).
pub(crate) fn build_capability_probe_body(audio_base64: &str) -> serde_json::Value {
    serde_json::json!({
        "messages": chat::render_messages(&capability_probe_messages(), None, Some(audio_base64)),
        "stream": true,
        "max_tokens": 1,
    })
}

/// Map the live POST's HTTP status onto the capability state. 2xx ⇒ the server
/// accepted the `input_audio` part; 4xx ⇒ it rejected audio for this
/// build/model; anything else is indeterminate. Pure + pinned, so the verdict can
/// never drift from the ST-0 decision rule.
pub(crate) fn capability_state_for_status(status: u16) -> SttAudioCapabilityState {
    match status {
        200..=299 => SttAudioCapabilityState::Ready,
        400..=499 => SttAudioCapabilityState::Unsupported,
        _ => SttAudioCapabilityState::Unknown,
    }
}

/// The first model id of a `/v1/models` payload (OpenAI list shape) — the DISPLAY
/// name only, never the capability verdict. Defensive: absent/malformed ⇒ None.
pub(crate) fn first_model_id(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("data")
        .and_then(|data| data.as_array())
        .and_then(|entries| {
            entries.iter().find_map(|entry| {
                entry
                    .get("id")
                    .and_then(|id| id.as_str())
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
            })
        })
}

/// Best-effort model name from the managed server: `None` when the endpoint is
/// unreachable/malformed — the capability answer never depends on it.
async fn probe_model_name(client: &reqwest::Client, host: &str, port: u16) -> Option<String> {
    let response = client.get(models_url(host, port)).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload = response.json::<serde_json::Value>().await.ok()?;
    first_model_id(&payload)
}

/// **ST-6 (REQ-7)** — the read-only model-audio capability probe backing
/// `stt_audio_capability`. Never panics and never transmits the user's captured
/// audio: the only payload it sends is a tiny synthetic silent clip, and only to
/// the managed loopback endpoint. Returns `serverUnavailable` when the server is
/// not listening, `unsupported` when the server rejects the audio part, `ready`
/// when it accepts it, and `unknown` when the answer is inconclusive.
pub async fn probe_model_audio_capability(app: &AppHandle) -> SttAudioCapability {
    let host = chat::resolve_host(store_string(app, LLAMA_SERVER_HOST_KEY).as_deref());
    let port = resolve_probe_port(app);
    let props_url = chat::props_url(&host, port);

    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CAPABILITY_PROBE_CONNECT_TIMEOUT_S))
        .timeout(Duration::from_secs(CAPABILITY_PROBE_TIMEOUT_S))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return SttAudioCapability::unknown(
                None,
                format!("could not build the capability probe HTTP client: {error}"),
            )
        }
    };

    // (a) Reachability — the managed loopback server must be listening.
    match client.get(&props_url).send().await {
        Err(error) => {
            return SttAudioCapability::server_unavailable(format!(
                "the local model server is not reachable at {props_url}: {error}"
            ))
        }
        Ok(response) if !response.status().is_success() => {
            return SttAudioCapability::unknown(
                None,
                format!(
                    "GET {props_url} returned HTTP {}",
                    response.status().as_u16()
                ),
            )
        }
        Ok(_) => {}
    }

    // (b) Best-effort display name (never the capability verdict).
    let model = probe_model_name(&client, &host, port).await;

    // (c) The acceptance probe: one `input_audio` turn through the ONE renderer.
    let wav = capability_probe_wav(CAPABILITY_PROBE_SAMPLES);
    let audio_base64 = STANDARD.encode(&wav);
    let body = build_capability_probe_body(&audio_base64);
    let chat_url = chat::chat_completions_url(&host, port);
    let response = match client.post(&chat_url).json(&body).send().await {
        Ok(response) => response,
        Err(error) => {
            // The server answered `/props` but not the chat POST — inconclusive,
            // never a fabricated verdict.
            return SttAudioCapability::unknown(
                model,
                format!("the audio capability request to {chat_url} failed: {error}"),
            );
        }
    };

    let status = response.status().as_u16();
    match capability_state_for_status(status) {
        SttAudioCapabilityState::Ready => SttAudioCapability::ready(model),
        SttAudioCapabilityState::Unsupported => SttAudioCapability::unsupported(
            model,
            format!("the model server rejected the audio input (HTTP {status})"),
        ),
        _ => SttAudioCapability::unknown(
            model,
            format!("the model server returned HTTP {status} for the audio input probe"),
        ),
    }
}

// ── ST-0 audio-feasibility probe seam (Spec #2897) ────────────────────────────
//
// ST-0 is an enabling gate: prove (or refute) that the pinned managed
// `llama-server` build accepts an OpenAI-style `input_audio` content part on
// `POST /v1/chat/completions` BEFORE any transport code is written. The live
// request is driven from outside the app (the recipe in
// `docs/research/model-audio-feasibility.md`, executed by the Tester as F-110),
// because ST-0's non-goals forbid a registered command or any behavior change.
//
// This module is the pure, test-pinned seam: it shapes the exact request body,
// validates it, interprets `/props` + `/v1/models`, and applies the ST-0 decision
// rule so the recorded receipt is interpreted the same way every time. It is
// gated to tests so production carries no dead code (ST-0 adds no behavior) and
// `cargo test` pins the shape.
#[cfg(test)]
mod audio_feasibility {
    use super::chat;
    use super::truncate;
    use serde_json::Value;

    /// The OpenAI/llama.cpp multimodal content-part type for inline audio.
    pub const INPUT_AUDIO_PART_TYPE: &str = "input_audio";

    /// Candidate `format` values the live probe tries, most likely first. This is
    /// the probe's attempt ORDER, never a claim about what the server accepts —
    /// the ACCEPTED set is whatever the F-110 receipt records.
    pub const PROBE_INPUT_AUDIO_FORMATS: [&str; 2] = ["wav", "mp3"];

    /// Minimal probe persona: the model must answer the audio message, not echo
    /// it. Kept deliberately plain so the probe does not steer the model into
    /// either "answer" or "transcribe" behavior (that observation is recorded by
    /// the Tester from the raw reply).
    pub const AUDIO_PROBE_SYSTEM_PROMPT: &str =
        "You are Fredo, a desktop companion. Respond to the user's message.";

    /// The single `input_audio` content part carried on the last user message.
    ///
    /// Shape (architect contract, exact and unmodified):
    /// `{ "type": "input_audio",
    ///    "input_audio": { "data": "<base64 wav>", "format": "wav" } }`
    pub fn input_audio_content_part(audio_base64: &str, format: &str) -> Value {
        serde_json::json!({
            "type": INPUT_AUDIO_PART_TYPE,
            "input_audio": { "data": audio_base64, "format": format }
        })
    }

    /// The ST-0 probe request: a system turn plus ONE user turn whose content IS
    /// the audio part array. No transcript text accompanies model audio (REQ-3).
    pub fn build_audio_probe_body(audio_base64: &str, format: &str) -> Value {
        serde_json::json!({
            "messages": [
                { "role": "system", "content": AUDIO_PROBE_SYSTEM_PROMPT },
                {
                    "role": "user",
                    "content": [ input_audio_content_part(audio_base64, format) ],
                },
            ],
            "stream": true,
            "max_tokens": chat::MAX_TOKENS,
        })
    }

    /// Validate the shaped probe body. `Err` carries a precise, actionable reason
    /// (never a panic) so a malformed probe is caught before it reaches the wire.
    pub fn validate_audio_probe_body(body: &Value) -> Result<(), String> {
        let messages = body
            .get("messages")
            .and_then(Value::as_array)
            .ok_or_else(|| "body.messages must be an array".to_string())?;

        let last_user = messages
            .iter()
            .rev()
            .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .ok_or_else(|| "body.messages must contain a user message".to_string())?;

        let parts = last_user
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "the last user message content must be an array carrying the audio part".to_string()
            })?;

        // REQ-3: no transcript text ever accompanies model audio.
        if parts
            .iter()
            .any(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        {
            return Err(
                "the audio probe message must not carry a text part (REQ-3 no-transcript)"
                    .to_string(),
            );
        }

        let part = parts
            .iter()
            .find(|part| part.get("type").and_then(Value::as_str) == Some(INPUT_AUDIO_PART_TYPE))
            .ok_or_else(|| {
                format!("no {INPUT_AUDIO_PART_TYPE} content part on the last user message")
            })?;

        let audio = part
            .get("input_audio")
            .and_then(Value::as_object)
            .ok_or_else(|| "the input_audio part must carry an input_audio object".to_string())?;

        if audio
            .get("data")
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            return Err(
                "the input_audio part must carry a non-empty base64 data string".to_string(),
            );
        }
        if audio
            .get("format")
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            return Err("the input_audio part must carry a non-empty format string".to_string());
        }

        Ok(())
    }

    /// The `/v1/models` view (llama.cpp returns the OpenAI list shape).
    #[derive(Debug, Clone, PartialEq, Eq, Default)]
    pub struct ModelsEvidence {
        pub object: Option<String>,
        pub ids: Vec<String>,
    }

    /// Parse `/v1/models` defensively: a missing/renamed `object` or malformed
    /// entries are skipped, never a panic — the raw payload is the evidence.
    pub fn models_from_v1_models(payload: &Value) -> ModelsEvidence {
        let object = payload
            .get("object")
            .and_then(Value::as_str)
            .map(str::to_string);
        let ids = payload
            .get("data")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        ModelsEvidence { object, ids }
    }

    /// A `/props` key whose NAME suggests a multimodal projector / audio support.
    /// The scan RECORDS what the running build reports; it never asserts a key a
    /// different build may lack, and it never infers capability from a name.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct PropsMarker {
        pub path: String,
        pub value: String,
    }

    /// Recursively collect scalar `/props` entries whose key mentions
    /// `mmproj`, `projector`, or `audio` (case-insensitive), sorted by path.
    pub fn props_audio_markers(props: &Value) -> Vec<PropsMarker> {
        fn walk(value: &Value, prefix: &str, out: &mut Vec<PropsMarker>) {
            match value {
                Value::Object(map) => {
                    for (key, child) in map {
                        let path = if prefix.is_empty() {
                            key.clone()
                        } else {
                            format!("{prefix}.{key}")
                        };
                        let lower = key.to_ascii_lowercase();
                        if lower.contains("mmproj")
                            || lower.contains("projector")
                            || lower.contains("audio")
                        {
                            let rendered = match child {
                                Value::String(text) if !text.is_empty() => Some(text.clone()),
                                Value::Bool(flag) => Some(flag.to_string()),
                                Value::Number(number) => Some(number.to_string()),
                                _ => None,
                            };
                            if let Some(value) = rendered {
                                out.push(PropsMarker {
                                    path: path.clone(),
                                    value,
                                });
                            }
                        }
                        walk(child, &path, out);
                    }
                }
                Value::Array(items) => {
                    for (index, child) in items.iter().enumerate() {
                        walk(child, &format!("{prefix}[{index}]"), out);
                    }
                }
                _ => {}
            }
        }

        let mut out = Vec::new();
        walk(props, "", &mut out);
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    /// What the live `input_audio` POST returned — the AUTHORITATIVE ST-0 signal.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum AudioProbeOutcome {
        /// HTTP 2xx — the server accepted the audio part and began a completion.
        Accepted { status: u16 },
        /// HTTP 4xx — the server rejected the part/format for this build.
        Rejected { status: u16, detail: String },
        /// HTTP 5xx — the server errored while handling an otherwise valid shape.
        ServerError { status: u16, detail: String },
        /// No HTTP response (connection refused / timeout) — server not running.
        Unreachable { detail: String },
    }

    /// Classify the live response. `status == 0` models "no HTTP response".
    pub fn classify_audio_probe_response(status: u16, body: &str) -> AudioProbeOutcome {
        let detail = truncate(body.trim(), 400);
        if (200..300).contains(&status) {
            AudioProbeOutcome::Accepted { status }
        } else if (400..500).contains(&status) {
            AudioProbeOutcome::Rejected { status, detail }
        } else if status == 0 {
            AudioProbeOutcome::Unreachable { detail }
        } else {
            AudioProbeOutcome::ServerError { status, detail }
        }
    }

    /// The ST-0 decision rule. FEASIBLE iff the live POST was 2xx-accepted.
    /// `/props` + `/v1/models` are recorded evidence but never sufficient: a
    /// model id or a projector file name is NOT proof (QA F-110 forbids
    /// inferring capability from a model name). Anything but `Accepted` is
    /// `unresolved` — a negative receipt loops the spec back to Phase 2.
    pub fn audio_feasibility(outcome: &AudioProbeOutcome) -> &'static str {
        match outcome {
            AudioProbeOutcome::Accepted { .. } => "feasible",
            AudioProbeOutcome::Rejected { .. } => "infeasible",
            _ => "unresolved",
        }
    }

    // ── Tests: the ST-0 shape + decision rule (CI-pinned) ─────────────────────

    #[test]
    fn audio_content_part_matches_the_architect_contract_exactly() {
        let part = input_audio_content_part("QUJD", "wav");
        assert_eq!(part["type"], INPUT_AUDIO_PART_TYPE);
        assert_eq!(part["input_audio"]["data"], "QUJD");
        assert_eq!(part["input_audio"]["format"], "wav");
        assert_eq!(part.as_object().map(|object| object.len()), Some(2));
    }

    #[test]
    fn candidate_formats_are_wav_first_and_include_mp3() {
        assert_eq!(PROBE_INPUT_AUDIO_FORMATS[0], "wav");
        assert!(PROBE_INPUT_AUDIO_FORMATS.contains(&"mp3"));
    }

    #[test]
    fn audio_probe_body_is_a_streaming_audio_only_user_turn() {
        let body = build_audio_probe_body("QUJD", "wav");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], chat::MAX_TOKENS);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], AUDIO_PROBE_SYSTEM_PROMPT);

        let parts = body["messages"][1]["content"]
            .as_array()
            .expect("content must be an array");
        assert_eq!(parts.len(), 1, "exactly one content part (the audio)");
        assert_eq!(parts[0]["type"], INPUT_AUDIO_PART_TYPE);
        // REQ-3: no transcript text is fabricated into the request.
        assert!(!body.to_string().contains("\"type\":\"text\""));
        assert!(validate_audio_probe_body(&body).is_ok());
    }

    #[test]
    fn validate_rejects_non_audio_malformed_and_text_bearing_bodies() {
        // A plain string user message is not the multimodal shape.
        let string_body = serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        assert!(validate_audio_probe_body(&string_body).is_err());

        // A text part beside the audio part violates REQ-3.
        let text_body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what did I say?" },
                    input_audio_content_part("QUJD", "wav"),
                ],
            }],
        });
        let error = validate_audio_probe_body(&text_body).expect_err("text part must be rejected");
        assert!(error.contains("no-transcript"), "unexpected error: {error}");

        // Empty data / empty format are rejected with a precise reason.
        let empty_data = serde_json::json!({
            "messages": [{ "role": "user", "content": [ input_audio_content_part("", "wav") ] }],
        });
        assert!(validate_audio_probe_body(&empty_data).is_err());
        let empty_format = serde_json::json!({
            "messages": [{ "role": "user", "content": [ input_audio_content_part("QUJD", "") ] }],
        });
        assert!(validate_audio_probe_body(&empty_format).is_err());

        // Missing messages array.
        assert!(validate_audio_probe_body(&serde_json::json!({})).is_err());
    }

    #[test]
    fn models_reader_takes_the_openai_list_shape_and_skips_malformed_entries() {
        let payload = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "Gemma-4-E2B", "object": "model" },
                { "object": "model" },
                { "id": "B" },
                "not-an-object",
            ],
        });
        let evidence = models_from_v1_models(&payload);
        assert_eq!(evidence.object.as_deref(), Some("list"));
        assert_eq!(evidence.ids, vec!["Gemma-4-E2B".to_string(), "B".to_string()]);

        let empty = models_from_v1_models(&serde_json::json!({}));
        assert_eq!(empty, ModelsEvidence::default());
    }

    #[test]
    fn props_marker_scan_records_projector_keys_without_asserting_them() {
        let props = serde_json::json!({
            "build_info": "b1",
            "mmproj": "C:/models/mmproj-BF16.gguf",
            "chat_template_tool_use": true,
            "default_generation_settings": { "n_ctx": 131072 },
            "nested": { "supports_audio": false, "audio_projector": "" },
        });
        let markers = props_audio_markers(&props);
        let paths: Vec<&str> = markers.iter().map(|marker| marker.path.as_str()).collect();
        assert_eq!(paths, vec!["mmproj", "nested.supports_audio"]);
        assert_eq!(markers[0].value, "C:/models/mmproj-BF16.gguf");
        assert_eq!(markers[1].value, "false");
        // An empty string value is not recorded (it is not evidence of support).
        assert!(!paths.contains(&"nested.audio_projector"));
        // Unrelated keys are ignored.
        assert!(!paths.contains(&"build_info"));
        // A props payload with no audio markers yields an empty record.
        assert!(props_audio_markers(&serde_json::json!({ "build_info": "b1" })).is_empty());
    }

    #[test]
    fn response_classification_and_the_feasibility_decision_rule() {
        assert_eq!(
            classify_audio_probe_response(200, "ok"),
            AudioProbeOutcome::Accepted { status: 200 }
        );
        let rejected = classify_audio_probe_response(400, "unsupported content part");
        assert!(matches!(rejected, AudioProbeOutcome::Rejected { status: 400, .. }));
        let server_error = classify_audio_probe_response(500, "boom");
        assert!(matches!(server_error, AudioProbeOutcome::ServerError { status: 500, .. }));
        let unreachable = classify_audio_probe_response(0, "ECONNREFUSED");
        assert!(matches!(unreachable, AudioProbeOutcome::Unreachable { .. }));

        assert_eq!(audio_feasibility(&AudioProbeOutcome::Accepted { status: 200 }), "feasible");
        assert_eq!(
            audio_feasibility(&AudioProbeOutcome::Rejected {
                status: 400,
                detail: String::new()
            }),
            "infeasible"
        );
        assert_eq!(
            audio_feasibility(&AudioProbeOutcome::ServerError {
                status: 500,
                detail: String::new()
            }),
            "unresolved"
        );
        assert_eq!(
            audio_feasibility(&AudioProbeOutcome::Unreachable {
                detail: "ECONNREFUSED".to_string()
            }),
            "unresolved"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_app_tool_matches_the_frozen_contract() {
        let tool = open_app_tool();
        assert_eq!(tool["type"], "function");
        assert_eq!(tool["function"]["name"], "open_app");
        assert_eq!(tool["function"]["description"], OPEN_APP_DESCRIPTION);
        let parameters = &tool["function"]["parameters"];
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["properties"]["app"]["type"], "string");
        assert_eq!(parameters["required"][0], "app");
        assert_eq!(parameters["additionalProperties"], false);
    }

    #[test]
    fn tools_probe_body_offers_open_app_with_auto_and_no_parallel_calls() {
        let body = build_tools_probe_body();
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["parallel_tool_calls"], false);
        assert_eq!(body["tools"][0]["function"]["name"], "open_app");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], PROBE_PROMPT);
    }

    #[test]
    fn response_format_probe_body_constrains_to_the_argument_schema() {
        let body = build_response_format_probe_body();
        assert_eq!(body["stream"], true);
        assert_eq!(body["response_format"]["type"], "json_schema");
        let schema = &body["response_format"]["json_schema"]["schema"];
        assert_eq!(schema["required"][0], "app");
        assert_eq!(schema["additionalProperties"], false);
        // The schema path must NOT offer tools — it is the fallback mechanism.
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn observe_sse_detects_a_completed_tool_call() {
        let raw = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"open_app\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"app\\\":\\\"Mission Monitor\\\"}\"}}]},\"finish_reason\":null}]}\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: [DONE]\n",
        );
        let observations = observe_sse(raw);
        assert!(observations.tool_calls_emitted);
        assert_eq!(observations.finish_reason.as_deref(), Some("tool_calls"));
        assert!(observations.terminated);
        assert!(!observations.reasoning_detected);
        assert_eq!(observations.content, "");
    }

    #[test]
    fn observe_sse_collects_content_and_flags_reasoning() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Opening \"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Mission Monitor\"},\"finish_reason\":\"stop\"}]}\n",
            "data: [DONE]\n",
        );
        let observations = observe_sse(raw);
        assert!(observations.reasoning_detected);
        assert_eq!(observations.content, "Opening Mission Monitor");
        assert_eq!(observations.finish_reason.as_deref(), Some("stop"));
        assert!(observations.terminated);
        assert!(!observations.tool_calls_emitted);
    }

    #[test]
    fn observe_sse_reports_a_stream_that_did_not_terminate() {
        let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n";
        let observations = observe_sse(raw);
        assert!(!observations.terminated);
        assert_eq!(observations.finish_reason, None);
        assert_eq!(observations.content, "partial");
    }

    #[test]
    fn observe_sse_skips_non_data_and_malformed_lines() {
        let raw = concat!(
            "event: message\n",
            ": keep-alive\n",
            "data: { not json\n",
            "data:   \n",
            "data: {\"choices\":[]}\n",
        );
        assert_eq!(observe_sse(raw), SseObservations::default());
    }

    #[test]
    fn props_readers_take_the_boolean_and_template_presence() {
        let props = serde_json::json!({
            "chat_template_tool_use": true,
            "chat_template": "{{ bos_token }}",
        });
        assert_eq!(chat_template_tool_use_from_props(&props), Some(true));
        assert!(chat_template_present_from_props(&props));

        let generic = serde_json::json!({ "chat_template_tool_use": false });
        assert_eq!(chat_template_tool_use_from_props(&generic), Some(false));
        assert!(!chat_template_present_from_props(&generic));

        let empty = serde_json::json!({ "chat_template": "" });
        assert_eq!(chat_template_tool_use_from_props(&empty), None);
        assert!(!chat_template_present_from_props(&empty));
    }

    #[test]
    fn extract_chat_format_line_finds_the_startup_line() {
        let log = "main: loading model\nllama_model_loader: done\nChat format: peg-gemma4\nmain: server listening\n";
        assert_eq!(
            extract_chat_format_line(log).as_deref(),
            Some("Chat format: peg-gemma4")
        );
        assert_eq!(extract_chat_format_line("no marker here"), None);
    }

    #[test]
    fn verdict_native_tools_usable_requires_a_completed_tool_call() {
        let usable = compute_verdict(Some(true), true, true, false, false);
        assert!(usable.native_tools_usable);
        assert!(usable.explicit_jinja_enough);
        assert!(!usable.template_override_needed);

        let unterminated = compute_verdict(Some(true), true, false, false, false);
        assert!(!unterminated.native_tools_usable);

        let errored = compute_verdict(Some(true), true, true, true, false);
        assert!(!errored.native_tools_usable);
    }

    #[test]
    fn verdict_flags_a_template_override_only_when_props_say_false() {
        let override_needed = compute_verdict(Some(false), false, true, false, false);
        assert!(override_needed.template_override_needed);
        assert!(!override_needed.explicit_jinja_enough);

        let unknown = compute_verdict(None, false, true, false, false);
        assert!(!unknown.template_override_needed);
        assert!(!unknown.explicit_jinja_enough);
        assert!(unknown.summary.contains("did not report"));
    }

    #[test]
    fn verdict_propagates_reasoning_detection() {
        let verdict = compute_verdict(Some(true), true, true, false, true);
        assert!(verdict.reasoning_detected);
    }

    // ── #2897 ST-6 — the capability probe's pure seam (REQ-7) ────────────────

    /// The live POST status maps onto the closed capability vocabulary exactly
    /// once: 2xx accepted, 4xx rejected, everything else indeterminate.
    #[test]
    fn capability_state_maps_the_live_status_onto_the_closed_vocabulary() {
        assert_eq!(
            capability_state_for_status(200),
            SttAudioCapabilityState::Ready
        );
        assert_eq!(
            capability_state_for_status(204),
            SttAudioCapabilityState::Ready
        );
        assert_eq!(
            capability_state_for_status(400),
            SttAudioCapabilityState::Unsupported
        );
        assert_eq!(
            capability_state_for_status(422),
            SttAudioCapabilityState::Unsupported
        );
        assert_eq!(
            capability_state_for_status(500),
            SttAudioCapabilityState::Unknown
        );
        assert_eq!(
            capability_state_for_status(0),
            SttAudioCapabilityState::Unknown
        );
    }

    /// The synthetic probe clip is a valid 16 kHz mono 16-bit PCM WAV of the
    /// requested length and is byte-deterministic (no clock/randomness).
    #[test]
    fn capability_probe_wav_is_a_deterministic_16k_mono_pcm_wav() {
        let wav = capability_probe_wav(CAPABILITY_PROBE_SAMPLES);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000,
            "16 kHz"
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "16-bit");
        assert_eq!(
            u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize,
            CAPABILITY_PROBE_SAMPLES * 2
        );
        assert_eq!(wav.len(), 44 + CAPABILITY_PROBE_SAMPLES * 2);
        assert_eq!(wav, capability_probe_wav(CAPABILITY_PROBE_SAMPLES));
    }

    /// The capability body carries the audio part through the ONE renderer: a
    /// single `input_audio` part on the last user message, no text part, and a
    /// single-token cap.
    #[test]
    fn capability_probe_body_is_the_one_renderer_with_a_single_audio_part() {
        let body = build_capability_probe_body("UklGRg==");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 1);
        let messages = body["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        let parts = messages[1]["content"].as_array().expect("audio array");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "input_audio");
        assert_eq!(parts[0]["input_audio"]["data"], "UklGRg==");
        assert_eq!(parts[0]["input_audio"]["format"], "wav");
        assert!(
            !body.to_string().contains("\"type\":\"text\""),
            "the capability probe must not carry a text part (REQ-3)"
        );
    }

    /// The `/v1/models` reader takes the OpenAI list shape and never panics on a
    /// malformed payload — the model name is a display detail, never the verdict.
    #[test]
    fn first_model_id_reads_the_openai_list_defensively() {
        let payload = serde_json::json!({
            "object": "list",
            "data": [
                { "object": "model" },
                { "id": "Gemma-4-E2B" },
                { "id": "" },
            ],
        });
        assert_eq!(first_model_id(&payload).as_deref(), Some("Gemma-4-E2B"));
        assert_eq!(first_model_id(&serde_json::json!({})), None);
        assert_eq!(first_model_id(&serde_json::json!({ "data": [] })), None);
        assert_eq!(
            first_model_id(&serde_json::json!({ "data": "nope" })),
            None
        );
    }

    /// The models URL templates the resolved (loopback-defaulting) host.
    #[test]
    fn models_url_templates_the_resolved_host() {
        assert_eq!(
            models_url("127.0.0.1", 8080),
            "http://127.0.0.1:8080/v1/models"
        );
    }
}
