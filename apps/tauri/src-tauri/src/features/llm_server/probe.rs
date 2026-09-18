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

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;

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
}
