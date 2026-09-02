//! Pure GenAI-attribute helpers + registry constants (Spec #2788 P5.1 W2).
//!
//! Relocated verbatim from `infrastructure/comm/adapters/otlp.rs` when the v1
//! `GenericOtlpAdapter` → ECE transform pipeline was deleted (AC6): the RTDB
//! ingest classifier (`rtdb/ingest.rs`) and the canonical backfill
//! (`rtdb/backfill.rs`) reuse the SAME verified extract paths, so the helpers
//! are pure free functions here — one source of truth for the attribute keys
//! and payload projection (NFR-6: ONE shared extract-rule implementation keeps
//! re-derivation byte-comparable with live derivation).
//!
//! Nothing in this module carries state or constructs `EngineInput`s — the
//! stateful correlation maps live on `IngestClassifier` (`rtdb/ingest.rs`),
//! the v1 adapter transform is gone.

use serde_json::{json, Map, Value};

use crate::infrastructure::comm::event::EventState;

// ── OTel GenAI semantic-convention registry keys (current names) ──────────────
// Emission source of truth: apps/opencode-plugin/src/genai-conventions.ts.
// `pub(crate)`: the RTDB IngestClassifier reuses the SAME verified extract
// paths — one source of truth for the attribute keys.
pub(crate) const ATTR_OPERATION_NAME: &str = "gen_ai.operation.name";
pub(crate) const ATTR_INPUT_MESSAGES: &str = "gen_ai.input.messages";
pub(crate) const ATTR_OUTPUT_MESSAGES: &str = "gen_ai.output.messages";
pub(crate) const ATTR_REQUEST_BODY: &str = "gen_ai.request.body";
pub(crate) const ATTR_USAGE_INPUT_TOKENS: &str = "gen_ai.usage.input_tokens";
pub(crate) const ATTR_USAGE_OUTPUT_TOKENS: &str = "gen_ai.usage.output_tokens";
pub(crate) const ATTR_USAGE_REASONING_OUTPUT_TOKENS: &str = "gen_ai.usage.reasoning.output_tokens";
pub(crate) const ATTR_USAGE_CACHE_READ_INPUT_TOKENS: &str = "gen_ai.usage.cache_read.input_tokens";
pub(crate) const ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS: &str =
    "gen_ai.usage.cache_creation.input_tokens";
pub(crate) const ATTR_RESPONSE_MODEL: &str = "gen_ai.response.model";
pub(crate) const ATTR_CONVERSATION_ID: &str = "gen_ai.conversation.id";
pub(crate) const ATTR_TOOL_NAME: &str = "gen_ai.tool.name";
pub(crate) const ATTR_TOOL_CALL_ARGUMENTS: &str = "gen_ai.tool.call.arguments";
pub(crate) const ATTR_TOOL_CALL_RESULT: &str = "gen_ai.tool.call.result";
pub(crate) const ATTR_AGENT_NAME: &str = "gen_ai.agent.name";

// ── Flat Claude-Code convention fallback keys (secondary only) ────────────────
pub(crate) const CC_ATTR_SESSION_ID: &str = "session.id";
pub(crate) const CC_ATTR_INPUT_TOKENS: &str = "input_tokens";
pub(crate) const CC_ATTR_OUTPUT_TOKENS: &str = "output_tokens";
pub(crate) const CC_ATTR_MODEL: &str = "model";
pub(crate) const CC_ATTR_SPAN_TYPE: &str = "span.type";
pub(crate) const CC_ATTR_SESSION_PARENT_ID: &str = "session.parent_id";
pub(crate) const CC_ATTR_TOOL_INPUT: &str = "tool_input";
pub(crate) const CC_ATTR_PROMPT_FLAT: &str = "prompt";
pub(crate) const CC_ATTR_RESPONSE_TEXT: &str = "response_text";

// ── Fredo-native child-completion flat keys (Spec #2745 R-2) ─────────────────
// Emitted by the plugin onto the parent's `fredo.tool.task` span at child-
// session completion (apps/opencode-plugin/src/telemetry-constants.ts,
// `childCompletionAttrs`). Deliberately NOT `gen_ai.*` — the OTel GenAI
// registry is the source of truth for gen_ai.* keys and defines no
// child-completion aggregate keys. `otlp_attrs_to_payload` preserves them
// verbatim (the attrs.clone() below) AND projects them onto canonical camelCase
// payload keys (`childSessionId`/`childAgent`/`childTokens`/`childCost`/
// `childMessages`) for the Mission Monitor SubagentNode builder.
const ATTR_CHILD_SESSION_ID: &str = "child_session_id";
const ATTR_CHILD_AGENT: &str = "child_agent";
const ATTR_CHILD_TOTAL_TOKENS: &str = "child_total_tokens";
const ATTR_CHILD_TOTAL_COST: &str = "child_total_cost_usd";
const ATTR_CHILD_TOTAL_MESSAGES: &str = "child_total_messages";
// Per-family token breakdown of the child (SubagentNode five-way row).
const ATTR_CHILD_INPUT_TOKENS: &str = "child_input_tokens";
const ATTR_CHILD_CACHE_READ_TOKENS: &str = "child_cache_read_tokens";
const ATTR_CHILD_REASONING_TOKENS: &str = "child_reasoning_tokens";
const ATTR_CHILD_OUTPUT_TOKENS: &str = "child_output_tokens";

// ── gen_ai.operation.name registry values (genai-conventions.ts:15-21) ─────────────
const OP_NAME_SESSION: &str = "run_agent";
const OP_NAME_CHAT: &str = "chat";
const OP_NAME_TOOL: &str = "execute_tool";

// Legacy op-name values accepted for backward compatibility (NOT fredo.* patterns).
const OP_LEGACY_INVOKE_AGENT: &str = "invoke_agent";
const OP_LEGACY_PERMISSION: &str = "permission";
const OP_LEGACY_ELICITATION: &str = "elicitation";

// ── Canonical op names produced by `resolve_op_name` ──────────────────────────
pub(crate) const OP_SESSION: &str = "session";
pub(crate) const OP_CHAT_CANON: &str = "chat";
pub(crate) const OP_TOOL_PREFIX: &str = "tool.";

/// Bounded-map capacity shared by every correlation/relationship cache.
/// `pub(crate)`: the RTDB IngestClassifier applies the SAME cap to its ported
/// correlation maps (NFR-2 bounded state).
pub(crate) const MAP_CAPACITY: usize = 10_000;

/// Per-message token derivation result for a completed chat span (Spec #2711,
/// extended by Spec #2723 ST-3 for the cache-read family).
///
/// `gen_ai.usage.input_tokens` is the CUMULATIVE request context at turn n
/// (grows per turn); the per-message prompt consumption is the delta from the
/// previous turn's cumulative input. `session_context_tokens` is the
/// cumulative session context at turn n (`input_n + cache_read_n`) — a
/// reconciliation aid for AC3 (C(n) = session_context_tokens + output(n) +
/// reasoning(n)).
///
/// Spec #2723 ST-3 (H1): `gen_ai.usage.cache_read.input_tokens` is ALSO
/// session-cumulative in live telemetry (e.g. ses_044bb36d…: 512000 → 513536
/// → 515840 → … → 592000 over 57 turns — strictly non-decreasing), so the
/// per-turn cache-read figure is the DELTA from the previous turn's cumulative
/// cache read, never the raw cumulative (raw would make node N's Cache = Σ
/// cache turns 1..N — literal cross-node contamination).
/// cache_read delta: `Some(delta)` only for completed chat spans with input;
/// `None` falls through to the raw registry value as before — the prompt
/// contract is unchanged).
#[derive(Clone, Copy, Debug)]
pub(crate) struct TurnTokenDerivation {
    /// Per-message prompt consumption: `input_n − prev`, clamped ≥ 0.
    /// `None` when the span carried no `gen_ai.usage.input_tokens` (or was a
    /// streaming Init — prompt derivation stays gated on completed chat spans
    /// with input). Spec #2734 ST-2: the prompt and cache derivations are now
    /// DECOUPLED — a cache-only derivation carries `None` here and the caller
    /// falls back to the raw registry input exactly as before (unchanged prompt
    /// contract).
    pub(crate) prompt_delta: Option<i64>,
    /// Per-message completion output tokens (`gen_ai.usage.output_tokens`).
    pub(crate) completion: Option<i64>,
    /// Cumulative session context at turn n (`input_n + cache_read_n`).
    /// `None` when input is not derivable (cache-only / streaming-Init
    /// derivation) — the reconciliation aid is then not injected, matching the
    /// pre-derivation missing-input behavior.
    pub(crate) session_context_tokens: Option<i64>,
    /// Per-turn cache-read consumption: `cache_read_n − prev_cache_read`,
    /// clamped ≥ 0 (Spec #2723 ST-3 H1). `None` when the span carries no
    /// cache_read attr — the canonical field then stays absent (R-3.3 renders
    /// 0). Spec #2734 ST-2: the cache derivation is decoupled from the
    /// `input_tokens` gate and the completion gate — a cache-bearing chat span
    /// derives its per-turn delta even when `gen_ai.usage.input_tokens` is
    /// absent or the span is a streaming Init (the pre-#2734 fallback injected
    /// the RAW session-cumulative cache value on every such span — the AC2
    /// duplication bug).
    pub(crate) cache_read_delta: Option<i64>,
}

/// Resolve the canonical op name for a span (classification priority):
///
/// 1. `gen_ai.operation.name` registry values (`run_agent` → `session`,
///    `chat`/`invoke_agent` → `chat`, `execute_tool` → `tool.<name>`, plus the
///    legacy `permission`/`elicitation` tool ops).
/// 2. Generic span-name heuristics (NO `fredo.*` patterns): spans whose name
///    mentions session/agent, chat/llm/message, or tool classify accordingly.
/// 3. `span.type` attribute fallback (REQ-10).
pub(crate) fn resolve_op_name(span_name: &str, attrs: &Map<String, Value>) -> Option<String> {
    if let Some(op) = attrs.get(ATTR_OPERATION_NAME).and_then(|v| v.as_str()) {
        match op {
            OP_NAME_SESSION => return Some(OP_SESSION.to_string()),
            OP_NAME_CHAT | OP_LEGACY_INVOKE_AGENT => return Some(OP_CHAT_CANON.to_string()),
            OP_NAME_TOOL => {
                let tool = attrs
                    .get(ATTR_TOOL_NAME)
                    .and_then(|v| v.as_str())
                    .unwrap_or(span_name);
                return Some(format!("{}{}", OP_TOOL_PREFIX, tool));
            }
            // Legacy values the OpenCode adapter classified as ToolUse.
            OP_LEGACY_PERMISSION | OP_LEGACY_ELICITATION => {
                return Some(format!("{}{}", OP_TOOL_PREFIX, op));
            }
            _ => {} // Unknown registry value — fall through to name heuristics.
        }
    }

    let lower = span_name.to_lowercase();
    if lower == OP_SESSION
        || lower == "agent_session"
        || lower.contains("session")
        || lower.contains("agent")
    {
        return Some(OP_SESSION.to_string());
    }
    if lower == OP_CHAT_CANON
        || lower == OP_LEGACY_INVOKE_AGENT
        || lower.contains("chat")
        || lower.contains("llm")
        || lower.contains("message")
    {
        return Some(OP_CHAT_CANON.to_string());
    }
    if lower == OP_NAME_TOOL || lower.contains("tool") {
        return Some(format!(
            "{}{}",
            OP_TOOL_PREFIX,
            tool_name_from_span(span_name)
        ));
    }

    if let Some(span_type) = attrs.get(CC_ATTR_SPAN_TYPE).and_then(|v| v.as_str()) {
        if span_type != span_name {
            return resolve_op_name(span_type, attrs);
        }
    }

    None
}

/// Extract a tool name from a generic span name (NO `fredo.*` patterns).
/// `"tool.bash"` → `"bash"`, `"my.tool.bash"` → `"bash"`, `"bash"` → `"bash"`.
fn tool_name_from_span(span_name: &str) -> String {
    let lower = span_name.to_lowercase();
    if let Some(idx) = lower.rfind("tool.") {
        let suffix = &span_name[idx + "tool.".len()..];
        if !suffix.is_empty() {
            return suffix.to_string();
        }
    }
    span_name.to_string()
}

/// Detect subagent spans via the `is_subagent` / `agent.type` attributes.
pub(crate) fn is_subagent_span(attrs: &Map<String, Value>) -> bool {
    attrs
        .get("is_subagent")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || attrs
            .get("agent.type")
            .and_then(|v| v.as_str())
            .map(|s| s == "subagent")
            .unwrap_or(false)
}

/// Convert an OTLP attribute key-value array to a serde_json map.
pub(crate) fn otlp_attrs_to_map(attrs_json: Option<&Value>) -> Map<String, Value> {
    let mut map = Map::new();
    let arr = match attrs_json.and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return map,
    };
    for kv in arr {
        let key = match kv.get("key").and_then(|v| v.as_str()) {
            Some(k) => k.to_string(),
            None => continue,
        };
        let value = if let Some(v) = kv.get("value") {
            if let Some(s) = v.get("stringValue").and_then(|x| x.as_str()) {
                Value::String(s.to_string())
            } else if let Some(i) = v.get("intValue") {
                if let Some(n) = i.as_i64() {
                    json!(n)
                } else if let Some(s) = i.as_str() {
                    if let Ok(n) = s.parse::<i64>() {
                        json!(n)
                    } else {
                        Value::String(s.to_string())
                    }
                } else {
                    i.clone()
                }
            } else if let Some(d) = v.get("doubleValue") {
                d.clone()
            } else if let Some(b) = v.get("boolValue") {
                b.clone()
            } else {
                v.clone()
            }
        } else {
            Value::Null
        };
        map.insert(key, value);
    }
    map
}

/// Parse a JSON-string message array (gen-ai-spans.md notes 25/26 — the OTel
/// JS SDK emits arrays of objects as JSON strings on spans) and return the
/// concatenated text-part content of the first message with the given role.
///
/// Registry schemas: `gen-ai-input-messages.json` / `gen-ai-output-messages.json`,
/// e.g. `[{"role":"user","parts":[{"type":"text","content":"..."}]}]`.
/// Returns `None` when the JSON cannot be parsed, no message matches the
/// role, or the matching message carries no text content.
pub(crate) fn extract_messages_text(json: &str, role: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(json).ok()?;
    let messages = parsed.as_array()?;
    for msg in messages {
        if msg.get("role").and_then(|v| v.as_str()) != Some(role) {
            continue;
        }
        let mut text = String::new();
        if let Some(parts) = msg.get("parts").and_then(|v| v.as_array()) {
            for part in parts {
                if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(content) = part.get("content").and_then(|v| v.as_str()) {
                        text.push_str(content);
                    }
                }
            }
        }
        if !text.trim().is_empty() {
            return Some(text);
        }
        return None;
    }
    None
}

/// Map OTLP flat attributes to the nested payload structure expected by the
/// frontend, injecting the canonical fields `userMessage`, `agentReply`,
/// `promptTokens`, `completionTokens`, `reasoningTokens`,
/// `cacheReadTokens`, `cacheWriteTokens`, `model`, `instruction`,
/// `is_subagent`, and `agent.type` (contract.ts:221-261).
///
/// Registry `gen_ai.*` keys are primary; flat Claude-Code fallbacks
/// (`input_tokens`, `output_tokens`, `model`, `prompt`, `response_text`)
/// remain secondary only.
///
/// Spec #2711: when `derived_tokens` is `Some`, the per-message prompt
/// DELTA overrides the cumulative `gen_ai.usage.input_tokens` value for
/// both `info.turnInputTokens` and `payload.promptTokens` (the cache prefix
/// never enters a node's prompt/completion — it cancels in every delta).
/// `Some` only ever comes from a completed chat span that carried usage.
pub(crate) fn otlp_attrs_to_payload(
    attrs: Map<String, Value>,
    derived_tokens: Option<TurnTokenDerivation>,
) -> Value {
    let mut payload = attrs.clone();

    // ——— Extract mapped values from flat OTLP attributes ———
    // Token counts: gen_ai.usage.* primary, flat CC keys secondary.
    let turn_input_tokens = attrs
        .get(ATTR_USAGE_INPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
    let turn_input_tokens_cc = attrs
        .get(CC_ATTR_INPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));

    let turn_output_tokens = attrs
        .get(ATTR_USAGE_OUTPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
    let turn_output_tokens_cc = attrs
        .get(CC_ATTR_OUTPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));

    // gen_ai.input.messages / gen_ai.output.messages (JSON-string message
    // arrays) are the registry-primary content keys. The text is extracted
    // from the array (concatenated text parts of the first matching role).
    let input_messages_text = attrs
        .get(ATTR_INPUT_MESSAGES)
        .and_then(|v| v.as_str())
        .and_then(|s| extract_messages_text(s, "user"));
    let output_messages_text = attrs
        .get(ATTR_OUTPUT_MESSAGES)
        .and_then(|v| v.as_str())
        .and_then(|s| extract_messages_text(s, "assistant"));
    let request_body = attrs
        .get(ATTR_REQUEST_BODY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Flat fallbacks (secondary).
    let prompt_flat = attrs
        .get(CC_ATTR_PROMPT_FLAT)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let response_text_flat = attrs
        .get(CC_ATTR_RESPONSE_TEXT)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Model: gen_ai.response.model primary, flat `model` secondary.
    let model = attrs
        .get(ATTR_RESPONSE_MODEL)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let model_cc = attrs
        .get(CC_ATTR_MODEL)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // ——— Build info object (user message, model, token counts) ———
    let mut info = Map::new();
    // User message text: gen_ai.input.messages (parsed) → gen_ai.request.body
    // → flat prompt.
    let user_text = input_messages_text.or(request_body).or(prompt_flat);
    let canonical_user_message = user_text.clone();
    if let Some(text) = user_text {
        info.insert("text".to_string(), Value::String(text));
    }

    // Model: gen_ai.response.model (registry) preferred over flat `model`.
    let model_value = model.or(model_cc);
    let canonical_model = model_value.clone();
    if let Some(model_id) = model_value {
        info.insert("modelID".to_string(), Value::String(model_id));
    }

    // Token counts: gen_ai.usage.* (registry) preferred over flat CC keys.
    // Spec #2711: the derived per-message delta OVERRIDES the cumulative
    // registry value when present (a completed chat span with usage). The
    // per-message completion is the turn's own output — never cumulative.
    // Spec #2734 ST-2: prompt_delta is now Option — `and_then` preserves
    // the old semantics exactly (a derivation carries `Some(delta)` only
    // for completed chat spans with input; `None` falls through to the raw
    // registry value as before — the prompt contract is unchanged).
    let prompt_tokens_value = derived_tokens
        .as_ref()
        .and_then(|d| d.prompt_delta)
        .or_else(|| turn_input_tokens.or(turn_input_tokens_cc));
    let completion_tokens_value = derived_tokens
        .as_ref()
        .and_then(|d| d.completion)
        .or_else(|| turn_output_tokens.or(turn_output_tokens_cc));
    if let Some(tokens) = prompt_tokens_value {
        info.insert("turnInputTokens".to_string(), json!(tokens));
    }
    if let Some(tokens) = completion_tokens_value {
        info.insert("turnOutputTokens".to_string(), json!(tokens));
    }

    // Spec #1499 / GA-5: extended OTel GenAI usage family — reasoning and
    // cache token counts (registry keys; string-encoded integers accepted).
    let turn_reasoning_tokens = attrs
        .get(ATTR_USAGE_REASONING_OUTPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
    let turn_cache_write_tokens = attrs
        .get(ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
    // Spec #2723 ST-3 (H1) + Spec #2734 ST-2: cacheReadTokens is injected
    // ONLY as the derived per-turn cache-read DELTA — the raw
    // gen_ai.usage.cache_read.input_tokens registry value is session-
    // CUMULATIVE and is NEVER a fallback (raw would make node N's Cache =
    // Σ turns 1..N; every fallback node carries the same cumulative figure
    // and computeSessionTokenTotals sums it N times — the AC2 duplication
    // bug). The field stays ABSENT when no delta is derivable (span carries
    // no cache_read attr, or the streaming Init produced no derivation) →
    // the frontend renders 0 (R-4). reasoning / cacheWrite stay absolute
    // per-turn (reasoning is per-turn in telemetry; cacheWrite is
    // carried-but-never-summed, G-023). The raw cumulative stays preserved
    // as a flat payload attribute (attrs clone at otlp.rs:998) for the ST-3
    // reconciliation guard.
    let cache_read_tokens_value = derived_tokens
        .as_ref()
        .and_then(|d| d.cache_read_delta);
    if let Some(tokens) = turn_reasoning_tokens {
        info.insert("turnReasoningTokens".to_string(), json!(tokens));
    }
    if let Some(tokens) = cache_read_tokens_value {
        info.insert("turnCacheReadTokens".to_string(), json!(tokens));
    }
    if let Some(tokens) = turn_cache_write_tokens {
        info.insert("turnCacheWriteTokens".to_string(), json!(tokens));
    }

    // ——— Build part object (agent reply text) ———
    let mut part = Map::new();
    // Agent reply text: gen_ai.output.messages (parsed) preferred over
    // flat response_text.
    let agent_reply = output_messages_text.or(response_text_flat);
    let canonical_agent_reply = agent_reply.clone();
    if let Some(text) = agent_reply {
        part.insert("text".to_string(), Value::String(text));
    }

    // Insert nested objects into payload, preserving flat attrs.
    if !info.is_empty() {
        payload.insert("info".to_string(), Value::Object(info));
    }
    if !part.is_empty() {
        payload.insert("part".to_string(), Value::Object(part));
    }

    // ——— Canonical field injection (REQ-609 REQ-2) ———
    // Matches the field names injected by normalize_agent_payload() for Hook
    // events so the frontend reads them regardless of transport.
    if let Some(user_msg) = canonical_user_message {
        payload.insert("userMessage".to_string(), Value::String(user_msg));
    }
    if let Some(reply) = canonical_agent_reply {
        payload.insert("agentReply".to_string(), Value::String(reply));
    }
    if let Some(tokens) = prompt_tokens_value {
        payload.insert("promptTokens".to_string(), json!(tokens));
    }
    if let Some(tokens) = completion_tokens_value {
        payload.insert("completionTokens".to_string(), json!(tokens));
    }
    // Spec #2717: canonical top-level token-family injection for the
    // remaining OTel GenAI usage families — reasoning and cache. Mirrors
    // promptTokens/completionTokens above and sources the SAME extracted
    // registry keys as the info.* twins:
    // gen_ai.usage.reasoning.output_tokens /
    // gen_ai.usage.cache_read.input_tokens /
    // gen_ai.usage.cache_creation.input_tokens. reasoningTokens /
    // cacheWriteTokens are absolute per-turn values (never deltas);
    // cacheReadTokens is the derived per-turn DELTA when present
    // (Spec #2723 ST-3 H1 — the registry value is session-cumulative). An
    // absent family means the field is simply NOT injected — the plugin
    // skips usage attrs ≤ 0, and the frontend renders 0 (R-3.3).
    if let Some(tokens) = turn_reasoning_tokens {
        payload.insert("reasoningTokens".to_string(), json!(tokens));
    }
    if let Some(tokens) = cache_read_tokens_value {
        payload.insert("cacheReadTokens".to_string(), json!(tokens));
    }
    if let Some(tokens) = turn_cache_write_tokens {
        payload.insert("cacheWriteTokens".to_string(), json!(tokens));
    }
    // Spec #2711: cumulative session context at turn n (input_n + cache_n)
    // — additive reconciliation aid for AC3 only. The frontend reads it for
    // the DetailPanel context row and ignores it when absent; it never
    // replaces promptTokens/completionTokens (per-message values). Spec
    // #2734 ST-2: absent for cache-only / streaming-Init derivations (no
    // input_n to sum) — matches the pre-derivation missing-input behavior.
    if let Some(tokens) = derived_tokens.as_ref().and_then(|d| d.session_context_tokens) {
        payload.insert("sessionContextTokens".to_string(), json!(tokens));
    }
    if let Some(model_name) = canonical_model {
        payload.insert("model".to_string(), Value::String(model_name));
    }

    // Spec #2449 S2: project gen_ai.tool.call.arguments/result onto the
    // canonical `input`/`output` fields read by makeToolNodePayload
    // (contract.ts:228-229). Flat keys remain preserved verbatim.
    if let Some(args) = attrs
        .get(ATTR_TOOL_CALL_ARGUMENTS)
        .and_then(|v| v.as_str())
    {
        payload.insert("input".to_string(), Value::String(args.to_string()));
    }
    if let Some(res) = attrs.get(ATTR_TOOL_CALL_RESULT).and_then(|v| v.as_str()) {
        payload.insert("output".to_string(), Value::String(res.to_string()));
    }
    // Spec #2449 S2: project gen_ai.agent.name onto `agent`/`name` for
    // subagent display (contract.ts:248).
    if let Some(agent) = attrs.get(ATTR_AGENT_NAME).and_then(|v| v.as_str()) {
        payload.insert("agent".to_string(), Value::String(agent.to_string()));
        payload.insert("name".to_string(), Value::String(agent.to_string()));
    }

    // Spec #2745 R-2 (ST-3): project the fredo-native child-completion flat
    // keys (child_session_id / child_agent / child_total_tokens /
    // child_total_cost_usd / child_total_messages — emitted by the plugin
    // onto the parent's `fredo.tool.task` span at child-session completion)
    // onto canonical camelCase payload keys consumed by the Mission Monitor
    // SubagentNode builder. Present ONLY when the span carried the flat
    // attr — absent keys stay absent (the frontend degrades to
    // dispatch-only data). The flat attrs themselves remain preserved
    // verbatim via the attrs.clone() at the top of this function.
    if let Some(v) = attrs.get(ATTR_CHILD_SESSION_ID).and_then(|v| v.as_str()) {
        payload.insert("childSessionId".to_string(), Value::String(v.to_string()));
    }
    if let Some(v) = attrs.get(ATTR_CHILD_AGENT).and_then(|v| v.as_str()) {
        payload.insert("childAgent".to_string(), Value::String(v.to_string()));
    }
    if let Some(v) = attrs
        .get(ATTR_CHILD_TOTAL_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
    {
        payload.insert("childTokens".to_string(), json!(v));
    }
    if let Some(v) = attrs
        .get(ATTR_CHILD_TOTAL_COST)
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok())))
    {
        payload.insert("childCost".to_string(), json!(v));
    }
    if let Some(v) = attrs
        .get(ATTR_CHILD_TOTAL_MESSAGES)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
    {
        payload.insert("childMessages".to_string(), json!(v));
    }
    // Per-family token breakdown (SubagentNode five-way row) — child_input_
    // /child_cache_read_/child_reasoning_/child_output_tokens → camelCase.
    if let Some(v) = attrs
        .get(ATTR_CHILD_INPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
    {
        payload.insert("childInputTokens".to_string(), json!(v));
    }
    if let Some(v) = attrs
        .get(ATTR_CHILD_CACHE_READ_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
    {
        payload.insert("childCacheReadTokens".to_string(), json!(v));
    }
    if let Some(v) = attrs
        .get(ATTR_CHILD_REASONING_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
    {
        payload.insert("childReasoningTokens".to_string(), json!(v));
    }
    if let Some(v) = attrs
        .get(ATTR_CHILD_OUTPUT_TOKENS)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
    {
        payload.insert("childOutputTokens".to_string(), json!(v));
    }

    // REQ-633 (REQ-2): Inject `instruction` for subagent spans from
    // gen_ai.input.messages (parsed) / flat prompt / the instruction
    // attribute directly.
    let is_subagent = is_subagent_span(&attrs);
    if is_subagent {
        let instruction = attrs
            .get(ATTR_INPUT_MESSAGES)
            .and_then(|v| v.as_str())
            .and_then(|s| extract_messages_text(s, "user"))
            .or_else(|| {
                attrs
                    .get(CC_ATTR_PROMPT_FLAT)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .or_else(|| {
                attrs
                    .get("instruction")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .filter(|s| !s.is_empty());
        if let Some(ref instr) = instruction {
            payload.insert("instruction".to_string(), Value::String(instr.clone()));
        }
    }

    // Preserve is_subagent and agent.type in the delivery payload for
    // frontend subagent detection (isOtlpSubagent path in useMissionMonitor.ts).
    if let Some(b) = attrs.get("is_subagent").and_then(|v| v.as_bool()) {
        payload.insert("is_subagent".to_string(), Value::Bool(b));
    }
    if let Some(s) = attrs.get("agent.type").and_then(|v| v.as_str()) {
        payload.insert("agent.type".to_string(), Value::String(s.to_string()));
    }

    Value::Object(payload)
}

/// Determine EventState from OTLP span timing.
///
/// REQ-11: Response if the span has endTimeUnixNano set, Init otherwise.
pub(crate) fn req_11_event_state_from_span(span: &Value) -> EventState {
    if span.get("endTimeUnixNano").is_some() {
        EventState::Response
    } else {
        EventState::Init
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Canonical field injection ─────────────────────────────────────────────

    #[test]
    fn canonical_fields_injected_from_registry_keys() {
        let mut attrs = Map::new();
        attrs.insert(
            ATTR_INPUT_MESSAGES.to_string(),
            json!("[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"What is the weather?\"}]}]"),
        );
        attrs.insert(
            ATTR_OUTPUT_MESSAGES.to_string(),
            json!("[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"The weather is sunny.\"}]}]"),
        );
        attrs.insert(ATTR_USAGE_INPUT_TOKENS.to_string(), json!(150));
        attrs.insert(ATTR_USAGE_OUTPUT_TOKENS.to_string(), json!(75));
        attrs.insert(ATTR_RESPONSE_MODEL.to_string(), json!("claude-sonnet-4"));

        // Spec #2711: the derived per-message delta OVERRIDES the cumulative
        // registry input (attrs input 150 cumulative, prev baseline 125 →
        // delta 25). completion = the turn's own output (75). No cache_read
        // attr in this fixture → derived cache_read_delta stays None and no
        // cacheReadTokens is injected (absent family contract, R-3.3).
        let derived = Some(TurnTokenDerivation {
            prompt_delta: Some(25),
            completion: Some(75),
            session_context_tokens: Some(25_369), // 25 + cache_read 25,344 (root-cause trace)
            cache_read_delta: None,
        });
        let result = otlp_attrs_to_payload(attrs, derived);
        let obj = result.as_object().unwrap();

        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("What is the weather?"));
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("The weather is sunny."));
        assert_eq!(
            obj.get("promptTokens").and_then(|v| v.as_i64()),
            Some(25),
            "promptTokens must be the per-message delta, never the cumulative input"
        );
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(75));
        assert_eq!(obj.get("sessionContextTokens").and_then(|v| v.as_i64()), Some(25_369));
        assert_eq!(obj.get("model").and_then(|v| v.as_str()), Some("claude-sonnet-4"));

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(info.get("text").and_then(|v| v.as_str()), Some("What is the weather?"));
        assert_eq!(info.get("modelID").and_then(|v| v.as_str()), Some("claude-sonnet-4"));
        assert_eq!(
            info.get("turnInputTokens").and_then(|v| v.as_i64()),
            Some(25),
            "info.turnInputTokens stays consistent with promptTokens"
        );
        assert_eq!(info.get("turnOutputTokens").and_then(|v| v.as_i64()), Some(75));
        let part = obj.get("part").and_then(|v| v.as_object()).unwrap();
        assert_eq!(part.get("text").and_then(|v| v.as_str()), Some("The weather is sunny."));
    }

    #[test]
    fn input_messages_parsed_preferred_over_request_body_and_flat_prompt() {
        // Priority: gen_ai.input.messages (parsed) > gen_ai.request.body > flat prompt.
        let mut attrs = Map::new();
        attrs.insert(
            ATTR_INPUT_MESSAGES.to_string(),
            json!("[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"from input.messages\"}]}]"),
        );
        attrs.insert(ATTR_REQUEST_BODY.to_string(), json!("from request.body"));
        attrs.insert(CC_ATTR_PROMPT_FLAT.to_string(), json!("from flat prompt"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("from input.messages"));
    }

    #[test]
    fn request_body_preferred_over_flat_prompt_when_input_messages_absent() {
        let mut attrs = Map::new();
        attrs.insert(ATTR_REQUEST_BODY.to_string(), json!("from request.body"));
        attrs.insert(CC_ATTR_PROMPT_FLAT.to_string(), json!("from flat prompt"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("from request.body"));
    }

    #[test]
    fn output_messages_parsed_preferred_over_flat_response_text() {
        // Priority: gen_ai.output.messages (parsed) > flat response_text.
        let mut attrs = Map::new();
        attrs.insert(
            ATTR_OUTPUT_MESSAGES.to_string(),
            json!("[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"from output.messages\"}]}]"),
        );
        attrs.insert(CC_ATTR_RESPONSE_TEXT.to_string(), json!("from flat response_text"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("from output.messages"));
    }

    #[test]
    fn output_messages_falls_back_to_flat_response_text() {
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_RESPONSE_TEXT.to_string(), json!("from flat response_text"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("from flat response_text"));
    }

    // ── extract_messages_text (gen-ai-spans.md notes 25/26 JSON-string arrays) ─

    #[test]
    fn extract_messages_text_concatenates_text_parts_of_first_matching_role() {
        let json = serde_json::json!([
            { "role": "system", "parts": [{ "type": "text", "content": "sys" }] },
            { "role": "user", "parts": [{ "type": "text", "content": "Hello " }, { "type": "text", "content": "world" }] }
        ])
        .to_string();
        assert_eq!(extract_messages_text(&json, "user").as_deref(), Some("Hello world"));
    }

    #[test]
    fn extract_messages_text_skips_non_text_parts() {
        let json = serde_json::json!([
            { "role": "user", "parts": [{ "type": "tool_call", "id": "c1" }, { "type": "text", "content": "actual" }] }
        ])
        .to_string();
        assert_eq!(extract_messages_text(&json, "user").as_deref(), Some("actual"));
    }

    #[test]
    fn extract_messages_text_returns_none_for_unmatched_role_or_bad_json() {
        let json = serde_json::json!([
            { "role": "assistant", "parts": [{ "type": "text", "content": "hi" }] }
        ])
        .to_string();
        assert_eq!(extract_messages_text(&json, "user"), None);
        assert_eq!(extract_messages_text("not json", "user"), None);
        assert_eq!(extract_messages_text("{}", "user"), None);
    }

    #[test]
    fn flat_fallbacks_used_when_registry_keys_absent() {
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_PROMPT_FLAT.to_string(), json!("flat prompt"));
        attrs.insert(CC_ATTR_RESPONSE_TEXT.to_string(), json!("flat reply"));
        attrs.insert(CC_ATTR_INPUT_TOKENS.to_string(), json!(10));
        attrs.insert(CC_ATTR_OUTPUT_TOKENS.to_string(), json!(20));
        attrs.insert(CC_ATTR_MODEL.to_string(), json!("flat-model"));

        // Flat CC fallbacks are NOT delta-derived (Spec #2711 derivation is
        // registry-keys-only, fired on completed chat spans with usage) — the
        // fallback keeps its raw per-turn values when no derivation is present.
        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("flat prompt"));
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("flat reply"));
        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(10));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(20));
        assert_eq!(obj.get("model").and_then(|v| v.as_str()), Some("flat-model"));
    }

    #[test]
    fn registry_model_preferred_over_flat_model() {
        // The plan's extraction priority: gen_ai.response.model (registry) is
        // primary; flat `model` remains a secondary fallback only.
        let mut attrs = Map::new();
        attrs.insert(ATTR_RESPONSE_MODEL.to_string(), json!("registry-model"));
        attrs.insert(CC_ATTR_MODEL.to_string(), json!("flat-model"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("model").and_then(|v| v.as_str()), Some("registry-model"));
        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(info.get("modelID").and_then(|v| v.as_str()), Some("registry-model"));
    }

    #[test]
    fn tool_call_arguments_and_result_projected_to_input_output() {
        let mut attrs = Map::new();
        attrs.insert(ATTR_TOOL_CALL_ARGUMENTS.to_string(), json!("{\"command\":\"ls\"}"));
        attrs.insert(ATTR_TOOL_CALL_RESULT.to_string(), json!("file1 file2"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("input").and_then(|v| v.as_str()), Some("{\"command\":\"ls\"}"));
        assert_eq!(obj.get("output").and_then(|v| v.as_str()), Some("file1 file2"));
        // Flat registry keys remain preserved verbatim.
        assert_eq!(
            obj.get(ATTR_TOOL_CALL_ARGUMENTS).and_then(|v| v.as_str()),
            Some("{\"command\":\"ls\"}")
        );
    }

    // ── Spec #2745 R-2 (ST-3): child-completion canonical payload keys ────────

    #[test]
    fn child_completion_flat_keys_projected_to_canonical_payload() {
        // A parent `fredo.tool.task` span carrying the full ST-2 child-completion
        // snapshot as flat fredo-native attributes must project them onto the
        // canonical camelCase payload keys read by the Mission Monitor
        // SubagentNode builder (childSessionId/childAgent/childTokens/childCost/
        // childMessages).
        let mut attrs = Map::new();
        attrs.insert(ATTR_CHILD_SESSION_ID.to_string(), json!("ses_child_1"));
        attrs.insert(ATTR_CHILD_AGENT.to_string(), json!("explore"));
        attrs.insert(ATTR_CHILD_TOTAL_TOKENS.to_string(), json!(1234));
        attrs.insert(ATTR_CHILD_TOTAL_COST.to_string(), json!(0.0123));
        attrs.insert(ATTR_CHILD_TOTAL_MESSAGES.to_string(), json!(7));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("childSessionId").and_then(|v| v.as_str()), Some("ses_child_1"));
        assert_eq!(obj.get("childAgent").and_then(|v| v.as_str()), Some("explore"));
        assert_eq!(obj.get("childTokens").and_then(|v| v.as_i64()), Some(1234));
        assert_eq!(obj.get("childCost").and_then(|v| v.as_f64()), Some(0.0123));
        assert_eq!(obj.get("childMessages").and_then(|v| v.as_i64()), Some(7));
        // Flat fredo-native keys remain preserved verbatim (attrs.clone()).
        assert_eq!(
            obj.get(ATTR_CHILD_SESSION_ID).and_then(|v| v.as_str()),
            Some("ses_child_1")
        );
        assert_eq!(
            obj.get(ATTR_CHILD_TOTAL_TOKENS).and_then(|v| v.as_i64()),
            Some(1234)
        );
    }

    #[test]
    fn child_per_family_tokens_projected_to_canonical_payload() {
        // The per-family token breakdown (child_input_/child_cache_read_/
        // child_reasoning_/child_output_tokens) must project onto the camelCase
        // keys the SubagentNode five-way row reads.
        let mut attrs = Map::new();
        attrs.insert(ATTR_CHILD_INPUT_TOKENS.to_string(), json!(100));
        attrs.insert(ATTR_CHILD_CACHE_READ_TOKENS.to_string(), json!(200));
        attrs.insert(ATTR_CHILD_REASONING_TOKENS.to_string(), json!(300));
        attrs.insert(ATTR_CHILD_OUTPUT_TOKENS.to_string(), json!(400));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("childInputTokens").and_then(|v| v.as_i64()), Some(100));
        assert_eq!(obj.get("childCacheReadTokens").and_then(|v| v.as_i64()), Some(200));
        assert_eq!(obj.get("childReasoningTokens").and_then(|v| v.as_i64()), Some(300));
        assert_eq!(obj.get("childOutputTokens").and_then(|v| v.as_i64()), Some(400));
        // Flat fredo-native keys preserved verbatim.
        assert_eq!(
            obj.get(ATTR_CHILD_INPUT_TOKENS).and_then(|v| v.as_i64()),
            Some(100)
        );
    }

    #[test]
    fn child_per_family_keys_absent_when_span_lacks_flat_attrs() {
        // No per-family flat attrs → the canonical camelCase keys stay absent.
        let mut attrs = Map::new();
        attrs.insert(ATTR_TOOL_CALL_ARGUMENTS.to_string(), json!("{}"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert!(obj.get("childInputTokens").is_none());
        assert!(obj.get("childCacheReadTokens").is_none());
        assert!(obj.get("childReasoningTokens").is_none());
        assert!(obj.get("childOutputTokens").is_none());
    }

    #[test]
    fn child_completion_canonical_keys_absent_when_span_lacks_flat_attrs() {
        // The projected keys are OPTIONAL — absent flat attrs mean the canonical
        // camelCase keys stay absent (the frontend degrades to dispatch-only data).
        let mut attrs = Map::new();
        attrs.insert(ATTR_TOOL_CALL_ARGUMENTS.to_string(), json!("{\"agent\":\"explore\"}"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert!(obj.get("childSessionId").is_none(), "no child_session_id attr → key absent");
        assert!(obj.get("childAgent").is_none(), "no child_agent attr → key absent");
        assert!(obj.get("childTokens").is_none(), "no child_total_tokens attr → key absent");
        assert!(obj.get("childCost").is_none(), "no child_total_cost_usd attr → key absent");
        assert!(obj.get("childMessages").is_none(), "no child_total_messages attr → key absent");
    }

    #[test]
    fn child_completion_attrs_accepted_as_string_encoded_and_cost_as_f64() {
        // OTLP int64 attributes can arrive as the JSON string encoding
        // (`otlp_attrs_to_map` parses both int and string forms). The cost is a
        // number (f64) — string-encoded cost must parse too.
        let mut attrs = Map::new();
        attrs.insert(ATTR_CHILD_TOTAL_TOKENS.to_string(), json!("1234"));
        attrs.insert(ATTR_CHILD_TOTAL_COST.to_string(), json!("0.0042"));
        attrs.insert(ATTR_CHILD_TOTAL_MESSAGES.to_string(), json!("3"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("childTokens").and_then(|v| v.as_i64()), Some(1234));
        assert_eq!(obj.get("childCost").and_then(|v| v.as_f64()), Some(0.0042));
        assert_eq!(obj.get("childMessages").and_then(|v| v.as_i64()), Some(3));
    }

    #[test]
    fn agent_name_projected_to_agent_and_name() {
        let mut attrs = Map::new();
        attrs.insert(ATTR_AGENT_NAME.to_string(), json!("coder"));

        let result = otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("agent").and_then(|v| v.as_str()), Some("coder"));
        assert_eq!(obj.get("name").and_then(|v| v.as_str()), Some("coder"));
    }

    // ── Spec #2717: canonical reasoning/cache token-family injection ───────────

    #[test]
    fn canonical_reasoning_and_cache_families_injected_from_registry_keys() {
        // A completed chat span carrying the reasoning + cache usage families
        // must yield canonical top-level reasoningTokens / cacheReadTokens /
        // cacheWriteTokens alongside the existing promptTokens/completionTokens
        // (R-2 five-way payload). Spec #2723 ST-3 (H1): reasoningTokens is
        // absolute per-turn; cacheReadTokens is the DERIVED per-turn delta
        // (here a distinct 1,536 — proving the delta OVERRIDES the raw
        // cumulative registry value 25,344, never the reverse); cacheWriteTokens
        // is carried-but-never-summed.
        let mut attrs = Map::new();
        attrs.insert(ATTR_USAGE_INPUT_TOKENS.to_string(), json!(2_731));
        attrs.insert(ATTR_USAGE_OUTPUT_TOKENS.to_string(), json!(180));
        attrs.insert(
            ATTR_USAGE_REASONING_OUTPUT_TOKENS.to_string(),
            json!(512),
        );
        attrs.insert(
            ATTR_USAGE_CACHE_READ_INPUT_TOKENS.to_string(),
            json!(25_344),
        );
        attrs.insert(
            ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS.to_string(),
            json!(1_024),
        );

        // Spec #2723 ST-3 (H1): cacheReadTokens carries the derived per-turn
        // DELTA (1,536 — a mid-session turn whose cumulative cache read grew by
        // 1,536 from the previous turn's baseline), never the raw cumulative
        // registry value (25,344).
        let derived = Some(TurnTokenDerivation {
            prompt_delta: Some(2_731),
            completion: Some(180),
            session_context_tokens: Some(2_731 + 25_344),
            cache_read_delta: Some(1_536),
        });
        let result = otlp_attrs_to_payload(attrs, derived);
        let obj = result.as_object().unwrap();

        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(2_731));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(180));
        assert_eq!(
            obj.get("reasoningTokens").and_then(|v| v.as_i64()),
            Some(512),
            "reasoningTokens = gen_ai.usage.reasoning.output_tokens, absolute per turn"
        );
        assert_eq!(
            obj.get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(1_536),
            "cacheReadTokens = the derived per-turn cache-read delta (Spec #2723 ST-3 H1), never the raw cumulative 25,344"
        );
        assert_eq!(
            obj.get("cacheWriteTokens").and_then(|v| v.as_i64()),
            Some(1_024),
            "cacheWriteTokens = gen_ai.usage.cache_creation.input_tokens, carried only"
        );

        // The info.* twins stay injected for backward compatibility — the
        // cache twin mirrors the derived delta (same value as the top-level).
        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("turnReasoningTokens").and_then(|v| v.as_i64()),
            Some(512)
        );
        assert_eq!(
            info.get("turnCacheReadTokens").and_then(|v| v.as_i64()),
            Some(1_536)
        );
        assert_eq!(
            info.get("turnCacheWriteTokens").and_then(|v| v.as_i64()),
            Some(1_024)
        );
    }

    #[test]
    fn canonical_reasoning_and_cache_families_absent_when_attrs_missing() {
        // An absent usage family means the field is simply NOT injected (the
        // plugin skips usage attrs ≤ 0; the frontend renders 0 — R-3.3). No
        // zero-attr emission is invented. Mirrors the existing promptTokens
        // convention (missing → absent).
        let mut attrs = Map::new();
        attrs.insert(ATTR_USAGE_INPUT_TOKENS.to_string(), json!(100));
        attrs.insert(ATTR_USAGE_OUTPUT_TOKENS.to_string(), json!(50));

        let derived = Some(TurnTokenDerivation {
            prompt_delta: Some(100),
            completion: Some(50),
            session_context_tokens: Some(100),
            cache_read_delta: None,
        });
        let result = otlp_attrs_to_payload(attrs, derived);
        let obj = result.as_object().unwrap();

        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(100));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(50));
        assert!(obj.get("reasoningTokens").is_none(), "absent reasoning family → field not injected");
        assert!(obj.get("cacheReadTokens").is_none(), "absent cache_read family → field not injected");
        assert!(obj.get("cacheWriteTokens").is_none(), "absent cache_creation family → field not injected");
    }

    // ── Retained classification helpers (direct pins) ──────────────────────────

    #[test]
    fn resolve_op_name_maps_registry_values_and_tool_names() {
        let mut attrs = Map::new();
        attrs.insert(ATTR_OPERATION_NAME.to_string(), json!("run_agent"));
        assert_eq!(resolve_op_name("llm", &attrs), Some(OP_SESSION.to_string()));

        attrs.insert(ATTR_OPERATION_NAME.to_string(), json!("chat"));
        assert_eq!(resolve_op_name("llm", &attrs), Some(OP_CHAT_CANON.to_string()));

        attrs.insert(ATTR_OPERATION_NAME.to_string(), json!("execute_tool"));
        attrs.insert(ATTR_TOOL_NAME.to_string(), json!("bash"));
        assert_eq!(resolve_op_name("llm", &attrs), Some("tool.bash".to_string()));

        // Generic span-name heuristics (no registry value).
        let empty = Map::new();
        assert_eq!(resolve_op_name("my.tool.bash", &empty), Some("tool.bash".to_string()));
        assert_eq!(resolve_op_name("totally-unknown", &empty), None);
    }

    #[test]
    fn is_subagent_span_and_req_11_state_pins() {
        let mut attrs = Map::new();
        assert!(!is_subagent_span(&attrs));
        attrs.insert("is_subagent".to_string(), json!(true));
        assert!(is_subagent_span(&attrs));

        let mut attrs2 = Map::new();
        attrs2.insert("agent.type".to_string(), json!("subagent"));
        assert!(is_subagent_span(&attrs2));

        let completed = json!({ "name": "llm", "endTimeUnixNano": "1000" });
        assert_eq!(req_11_event_state_from_span(&completed), EventState::Response);
        let streaming = json!({ "name": "llm" });
        assert_eq!(req_11_event_state_from_span(&streaming), EventState::Init);
    }
}
