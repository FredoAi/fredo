//! GenericOtlpAdapter — provider-agnostic OTLP span → `EngineInput` conversion.
//!
//! Spec #2449 S2: ports the OTLP transform from `OpenCodeAdapter`
//! (`opencode.rs::transform_otlp`) to emit `EngineInput` — the ECE's input
//! contract — instead of constructing a standalone `FredoEvent` (R3). The
//! adapter is provider-agnostic (R6): op classification is driven by the
//! `gen_ai.operation.name` registry values (`run_agent`/`chat`/`execute_tool`,
//! apps/opencode-plugin/src/genai-conventions.ts:15-21) with generic span-name
//! heuristics — there are NO `fredo.*` span-name patterns, so any OTLP emitter
//! (opencode, Copilot CLI, Claude Code) classifies identically.
//!
//! State semantics (R9): completed session spans emit `EventState::Init`
//! (REQ-609) so `chat-node`'s `completeWhen` never fires on them; completed
//! chat/tool spans emit a synthetic `Init` `EngineInput` before the `Response`
//! `EngineInput`, preserving init-then-end and the Spec #627 multi-message
//! #2758 ST-2: live flow verified — fresh session with chat + tool_use +
//! agent_session produces SubscriptionDelivery via Hook + OTLP gRPC -> ECE and
//! populates telemetry_spans; all gen_ai.* use current OTel keys.
//! buffer reset.
//!
//! Regression invariants preserved from `OpenCodeAdapter`:
//! - Correlation-map semantics: session→correlation bridging, per-turn counter
//!   (REQ-639), `session_to_parent` span-link / `session.parent_id` detection,
//!   and the 10,000-entry cap with oldest-first eviction.
//! - `metadata.relationship` format (Spec #523 parent-child compositing).
//! - `eventType` values `chat`/`agent_session`/`tool_use` and PascalCase
//!   `state` serialization.
//! - `Transport::OtlpGrpc` → `"otlp_grpc"` / `Transport::OtlpHttp` →
//!   `"otlp_http"` names preserved verbatim (NFR-4).
//! - Task-instruction/parent-prompt injection uses the registry keys
//!   `gen_ai.tool.call.arguments` and `gen_ai.input.messages` (parsed from the
//!   JSON-string message array; primary) with flat Claude-Code fallbacks
//!   secondary.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::infrastructure::comm::contract::input::EngineInput;
use crate::infrastructure::comm::event::{EventProvider, EventState, EventType, Transport};

use super::parent_prompt_cache;

// ── OTel GenAI semantic-convention registry keys (current names) ──────────────
// Emission source of truth: apps/opencode-plugin/src/genai-conventions.ts.
// `pub(crate)`: the RTDB IngestClassifier (Spec #2788 P3.1) reuses the SAME
// verified extract paths — one source of truth for the attribute keys.
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
/// `pub(crate)`: the RTDB IngestClassifier (Spec #2788 P3.1) applies the SAME
/// cap to its ported correlation maps (NFR-2 bounded state).
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

/// Provider-agnostic OTLP span → `EngineInput` adapter.
///
/// Maintains the same correlation-map state as `OpenCodeAdapter`'s OTLP half:
/// session→correlation bridging (REQ-3), per-turn counters (REQ-639), and
/// child→parent session detection (Spec #523/#615). All maps are capped at
/// 10,000 entries with oldest-first eviction.
#[derive(Debug)]
pub struct GenericOtlpAdapter {
    /// Key: traceId, Value: session_id (conversation.id)
    trace_to_session: Arc<Mutex<HashMap<String, String>>>,
    /// Key: session_id, Value: correlationId. Hook-bridged sessions reuse the
    /// stored Hook correlationId; pure-OTLP sessions get per-turn IDs.
    session_to_correlation: Arc<Mutex<HashMap<String, String>>>,
    /// Key: (session_id, span_id), Value: correlationId. ST9 (#2688) reuse
    /// guard — a completed chat/tool span whose spanId already emitted an Init
    /// in an earlier export (the streaming open-then-complete dual export)
    /// reuses that Init's correlationId so the per-turn counter never
    /// double-advances (one turn → one ECE buffer). Same 10,000-entry cap with
    /// oldest-first eviction as the other maps.
    span_to_correlation: Arc<Mutex<HashMap<(String, String), String>>>,
    /// Key: child_session_id, Value: parent_session_id (Spec #615).
    session_to_parent: Arc<Mutex<HashMap<String, String>>>,
    /// Key: session_id, Value: turn counter (1-based) — REQ-639 (REQ-2).
    session_turn_counter: Arc<Mutex<HashMap<String, u64>>>,
    /// Key: parent_session_id, Value: task instruction (Spec #633 Bug 1).
    pending_task_instructions: Arc<Mutex<HashMap<String, String>>>,
    /// Key: session_id, Value: prompt text (Spec #633 AC-6c REQ-1).
    parent_prompts: Arc<Mutex<HashMap<String, String>>>,
    /// Key: session_id, Value: cumulative `gen_ai.usage.input_tokens` at the
    /// last completed chat span (Spec #2711). `gen_ai.usage.input_tokens` is
    /// the session's cumulative non-cached request context (grows per turn);
    /// the per-message prompt consumption is the DELTA from this baseline.
    /// Subagent/build/plan sessions key by their own session.id so deltas stay
    /// independent. Same 10,000-entry cap with oldest-first eviction as the
    /// other maps.
    last_request_input: Arc<Mutex<HashMap<String, i64>>>,
    /// Key: session_id, Value: cumulative `gen_ai.usage.cache_read.input_tokens`
    /// at the last completed chat span (Spec #2723 ST-3 H1). Live telemetry
    /// shows cache_read is SESSION-CUMULATIVE (strictly non-decreasing per
    /// turn), so the per-turn cache-read figure is the DELTA from this
    /// baseline — same bounded-map discipline as `last_request_input`.
    last_request_cache_read: Arc<Mutex<HashMap<String, i64>>>,
}

impl GenericOtlpAdapter {
    /// Create a new `GenericOtlpAdapter`.
    pub fn new() -> Self {
        GenericOtlpAdapter {
            trace_to_session: Arc::new(Mutex::new(HashMap::new())),
            session_to_correlation: Arc::new(Mutex::new(HashMap::new())),
            span_to_correlation: Arc::new(Mutex::new(HashMap::new())),
            session_to_parent: Arc::new(Mutex::new(HashMap::new())),
            session_turn_counter: Arc::new(Mutex::new(HashMap::new())),
            pending_task_instructions: Arc::new(Mutex::new(HashMap::new())),
            parent_prompts: Arc::new(Mutex::new(HashMap::new())),
            last_request_input: Arc::new(Mutex::new(HashMap::new())),
            last_request_cache_read: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Transform an OTLP export (standard `resourceSpans` envelope or flat JSON)
    /// into `EngineInput`s — the ECE's input contract. Never constructs a
    /// standalone `FredoEvent` (R3).
    pub fn transform(&self, transport: Transport, raw: Value) -> anyhow::Result<Vec<EngineInput>> {
        let mut inputs = Vec::new();

        // Standard OTLP envelope (gRPC + protobuf/JSON HTTP exports).
        if let Some(resource_spans) = raw.get("resourceSpans").and_then(|v| v.as_array()) {
            for rs in resource_spans {
                let res_attrs =
                    Self::otlp_attrs_to_map(rs.get("resource").and_then(|r| r.get("attributes")));
                let scope_spans = rs
                    .get("scopeSpans")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for scope in &scope_spans {
                    let spans = scope
                        .get("spans")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    for span in &spans {
                        let span_name =
                            span.get("name").and_then(|v| v.as_str()).unwrap_or("span");
                        if let Some(mut span_inputs) =
                            self.process_span(transport, span, span_name, &res_attrs, true)
                        {
                            inputs.append(&mut span_inputs);
                        }
                    }
                }
            }
            return Ok(inputs);
        }

        // Flat/custom JSON (OpenCode file-exporter style / non-envelope emitters).
        let raw_name = raw
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("otlp.span");
        let empty_res = Map::new();
        if let Some(mut span_inputs) = self.process_span(transport, &raw, raw_name, &empty_res, false)
        {
            inputs.append(&mut span_inputs);
        }

        Ok(inputs)
    }

    /// Common per-span processing shared by the resourceSpans and flat JSON paths.
    ///
    /// `res_attrs` are the resource-level attributes (empty for the flat path);
    /// `check_links` enables span-link parent detection (present on standard
    /// OTLP spans, not on the flat exporter format).
    fn process_span(
        &self,
        transport: Transport,
        span: &Value,
        span_name: &str,
        res_attrs: &Map<String, Value>,
        check_links: bool,
    ) -> Option<Vec<EngineInput>> {
        let span_attrs = Self::otlp_attrs_to_map(span.get("attributes"));

        // Resolve canonical op name. Unrecognised spans are dropped (logged).
        let op_name = match Self::resolve_op_name(span_name, &span_attrs) {
            Some(op) => op,
            None => {
                tracing::debug!(
                    target: "fredo::adapter::otlp",
                    span_name = %span_name,
                    "Dropping unrecognised OTLP span"
                );
                return None;
            }
        };

        // Resolve session id: prefer session.id, fall back to
        // gen_ai.conversation.id, then trace_to_session, then trace_id/UUID.
        let trace_id = span
            .get("traceId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let session_id = span_attrs
            .get(CC_ATTR_SESSION_ID)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| {
                span_attrs
                    .get(ATTR_CONVERSATION_ID)
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            })
            .or_else(|| {
                if check_links {
                    self.trace_to_session
                        .lock()
                        .ok()
                        .and_then(|m| m.get(&trace_id).cloned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| {
                if !trace_id.is_empty() {
                    trace_id.clone()
                } else {
                    Uuid::new_v4().to_string()
                }
            });

        // Store trace→session mapping when a session identity is present.
        if let Some(sid) = span_attrs
            .get(CC_ATTR_SESSION_ID)
            .and_then(|v| v.as_str())
            .or_else(|| {
                span_attrs
                    .get(ATTR_CONVERSATION_ID)
                    .and_then(|v| v.as_str())
            })
        {
            if let Ok(mut map) = self.trace_to_session.lock() {
                if map.len() >= MAP_CAPACITY && !map.contains_key(&trace_id) {
                    if let Some(key) = map.keys().next().cloned() {
                        map.remove(&key);
                    }
                }
                map.insert(trace_id.clone(), sid.to_string());
            }
        }

        // Merge resource attrs + span attrs.
        let mut merged = res_attrs.clone();
        merged.extend(span_attrs);

        // Determine event type based on canonical op name.
        let event_type = match op_name.as_str() {
            OP_SESSION => EventType::AgentSession,
            OP_CHAT_CANON => EventType::Chat,
            _ => EventType::ToolUse,
        };

        // REQ-11: EventState from span timing. REQ-609: session spans always
        // emit Init only — never Response — preventing premature ECE buffer
        // completion that would block chat span data.
        let event_state = if op_name == OP_SESSION {
            EventState::Init
        } else {
            Self::req_11_event_state_from_span(span)
        };

        // REQ-3 / REQ-639: correlationId bridging + per-turn counters.
        // ST9 (#2688): a completed chat/tool span whose FIRST export is the
        // completion (Run CLI export order — chat spans exported as each
        // message completes, session spans at session.idle) must still advance
        // the per-turn counter so each prompt opens its own ECE buffer. We
        // resolve the id as an Init for the first-export-completed case, and
        // the synthetic Init + Response share it (build_input clones
        // otlp_correlation_id for both). The span_to_correlation reuse guard
        // keeps the streaming open-then-complete dual-export path on ONE id per
        // span (no counter double-advance, no phantom buffer).
        let span_id = span
            .get("spanId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let otlp_correlation_id =
            self.resolve_span_correlation_id(&session_id, &span_id, &op_name, event_state);

        // REQ-6 (Spec #633 Redesign): Extract parent from OTLP span links for
        // order-independent parent-child detection. Span links are on the span
        // JSON; each link carries a parent.session_id attribute.
        let parent_from_links: Option<String> = if check_links {
            span.get("links")
                .and_then(|l| l.as_array())
                .and_then(|links| {
                    for link in links {
                        let link_attrs = Self::otlp_attrs_to_map(link.get("attributes"));
                        if let Some(pid) = link_attrs
                            .get("parent.session_id")
                            .and_then(|v| v.as_str())
                            .filter(|pid| !pid.is_empty() && *pid != session_id)
                        {
                            return Some(pid.to_string());
                        }
                    }
                    None
                })
        } else {
            None
        };

        if let Some(ref parent_sid) = parent_from_links {
            if let Ok(mut map) = self.session_to_parent.lock() {
                if map.len() >= MAP_CAPACITY && !map.contains_key(&session_id) {
                    if let Some(key) = map.keys().next().cloned() {
                        map.remove(&key);
                    }
                }
                map.insert(session_id.clone(), parent_sid.clone());
            }
        }

        // REQ-9 (Spec #633 Redesign): Fallback to session.parent_id attribute
        // for backward compatibility with spans that don't carry span links.
        let parent_from_attrs = merged
            .get(CC_ATTR_SESSION_PARENT_ID)
            .and_then(|v| v.as_str())
            .filter(|psid| !psid.is_empty() && *psid != session_id)
            .map(|s| s.to_string());

        if let Some(ref parent_sid) = parent_from_attrs {
            if let Ok(mut map) = self.session_to_parent.lock() {
                // Span links take priority (REQ-6) — only insert if not already set.
                if !map.contains_key(&session_id) {
                    if map.len() >= MAP_CAPACITY {
                        if let Some(key) = map.keys().next().cloned() {
                            map.remove(&key);
                        }
                    }
                    map.insert(session_id.clone(), parent_sid.clone());
                }
            }
        }

        let is_subagent = Self::is_subagent_span(&merged);

        // Spec #2723 (R-5 / AC5, round 2): session-level subagent marker.
        // `is_subagent_span` only sees the CURRENT span's attributes — which
        // the plugin sets solely on the `fredo.session` span. The `fredo.llm`
        // spans of a subagent session carry `session.parent_id` instead, so
        // the session-level determination below propagates the marker to every
        // span-derived event payload (LLM/chat included). This makes the
        // Mission Monitor `excludePayload` contract rules match in the ECE and
        // the engine drops child-derived events pre-buffer (AC5 / Q-5.2).
        let session_is_subagent = self.is_subagent_session(&merged, &session_id);

        // Spec #2762 (D4a): resolve the child's parent session id the SAME
        // three-rule way `is_subagent_session` does — the `session.parent_id`
        // attribute first, then the persisted `session_to_parent` registry
        // (span-link / earlier-span registrations). Resolved BEFORE
        // `otlp_attrs_to_payload` consumes `merged`; injected into the payload
        // as `parentSessionId` below so the Mission Monitor scoped orphan count
        // (R-7) can attribute child deliveries to their parent's subtree.
        // Spec #2768 (ST-2): the ECE registers the child→parent relationship
        // from the self-carried typed routing property alone, so composited
        // child deliveries re-key to the parent composite key and inject the
        // original child id as `compositedChildSessionId` in the delivery
        // payload — consumers join by the child id, not the composite key.
        // The synthetic Init and Response payloads carry it identically (the
        // clone below happens after this block).
        let session_parent_id: Option<String> = merged
            .get(CC_ATTR_SESSION_PARENT_ID)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| {
                self.session_to_parent
                    .lock()
                    .ok()
                    .and_then(|m| m.get(&session_id).cloned())
            })
            .filter(|psid| !psid.is_empty() && psid != &session_id);

        let relationship_meta: Option<serde_json::Value> = if is_subagent {
            self.session_to_parent
                .lock()
                .ok()
                .and_then(|m| m.get(&session_id).cloned())
                .filter(|psid| psid != &session_id)
                .map(|parent| {
                    json!({
                        "relationship": {
                            "type": "parent-child",
                            "parentSessionId": parent,
                            "childSessionId": session_id
                        }
                    })
                })
        } else {
            None
        };

        // Bug 1 (Spec #633): Extract the task instruction from the registry key
        // gen_ai.tool.call.arguments (JSON string) when this is a task tool span;
        // flat `tool_input` remains a secondary fallback. Keyed by session_id
        // (the parent session that dispatched the task). Must run BEFORE
        // otlp_attrs_to_payload consumes `merged`.
        if op_name == "tool.task" {
            let tool_input_str = merged
                .get(ATTR_TOOL_CALL_ARGUMENTS)
                .and_then(|v| v.as_str())
                .or_else(|| merged.get(CC_ATTR_TOOL_INPUT).and_then(|v| v.as_str()));
            if let Some(input_json) = tool_input_str {
                if let Ok(parsed) = serde_json::from_str::<Value>(input_json) {
                    let task_instruction = parsed
                        .get("task")
                        .or_else(|| parsed.get("instruction"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    if let Some(instr) = task_instruction {
                        if let Ok(mut map) = self.pending_task_instructions.lock() {
                            if map.len() >= MAP_CAPACITY && !map.contains_key(&session_id) {
                                if let Some(key) = map.keys().next().cloned() {
                                    map.remove(&key);
                                }
                            }
                            map.insert(session_id.clone(), instr);
                        }
                    }
                }
            }
        }

        // REQ-1 (Spec #633 AC-6c): Cache parent session prompts for subagent
        // instruction injection. Extract prompt from non-subagent spans.
        if !is_subagent {
            let parent_prompt = merged
                .get(ATTR_INPUT_MESSAGES)
                .and_then(|v| v.as_str())
                .and_then(|s| Self::extract_messages_text(s, "user"))
                .or_else(|| {
                    merged
                        .get(CC_ATTR_PROMPT_FLAT)
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .filter(|s| !s.trim().is_empty());
            if let Some(prompt) = parent_prompt {
                if let Ok(mut map) = self.parent_prompts.lock() {
                    parent_prompt_cache::req_1_cache_parent_prompt(&mut map, &session_id, &prompt);
                }
            }
        }

        // REQ-2 / AC-2: Map flat OTLP attributes to the nested payload structure.
        // Spec #2711: derive the per-message prompt delta BEFORE payload
        // construction so the synthetic Init + Response clones (both built from
        // `mapped_payload`) carry the SAME delta — computed once per span set,
        // never per event. No-op (None) for non-chat spans, non-completed
        // spans, and spans without usage — the caller then keeps the existing
        // cumulative injection path unchanged.
        let derived_tokens = self.derive_turn_tokens(&session_id, &op_name, event_state, &merged);
        let mut mapped_payload = Self::otlp_attrs_to_payload(merged, derived_tokens);

        // Spec #2723 (R-6 / AC6): inject the span's real start/end times
        // (RFC3339 UTC) alongside the canonical payload fields so the
        // DetailPanel shows telemetry-derived times instead of delivery
        // wall-clocks. Telemetry truth lives in telemetry_spans.start_time_ns
        // (raw.rs:45,160); the raw span JSON carries startTimeUnixNano /
        // endTimeUnixNano (http.rs:356-357; read at otlp.rs:1214). Injected
        // BEFORE the payload clone (otlp.rs:517-518) so the synthetic Init
        // and Response deliveries carry identical timing. Streaming spans
        // without endTimeUnixNano get startTime only — the frontend falls
        // back to the end-delivery timestamp for End (useMissionMonitor.ts:629).
        if let Some(obj) = mapped_payload.as_object_mut() {
            let (start_time, end_time) = Self::span_timing_to_rfc3339(span);
            if let Some(start) = start_time {
                obj.insert("startTime".to_string(), Value::String(start));
            }
            if let Some(end) = end_time {
                obj.insert("endTime".to_string(), Value::String(end));
            }
        }

        // Spec #2723 (R-5 / AC5, round 2): inject the session-level subagent
        // marker into EVERY span-derived event payload (LLM/chat included).
        // The raw span attributes carry `is_subagent` / `agent.type` only on
        // the `fredo.session` span; the LLM/chat spans of a subagent session
        // carry `session.parent_id` instead. The session-level determination
        // (`session_is_subagent`, computed above) propagates the marker here so
        // the already-declared Mission Monitor `excludePayload` rules
        // (`[{path:'is_subagent',equals:true},{path:'agent.type',equals:'subagent'}]`)
        // match in the ECE and the engine drops child-derived events pre-buffer
        // — zero child deliveries reach IPC/StreamContext/persistence (Q-5.2).
        // Injected BEFORE the payload clone (otlp.rs:558) so the synthetic Init
        // and Response deliveries carry the flags identically.
        if session_is_subagent {
            if let Some(obj) = mapped_payload.as_object_mut() {
                obj.insert("is_subagent".to_string(), Value::Bool(true));
                obj.insert("agent.type".to_string(), Value::String("subagent".to_string()));
                // Spec #2762 (D4a): child identity for the Mission Monitor
                // scoped orphan count — mirrors the session-level marker
                // propagation above (N-1 amendment: one payload attribute,
                // no new contract / engine / plugin change).
                if let Some(ref parent) = session_parent_id {
                    obj.insert("parentSessionId".to_string(), Value::String(parent.clone()));
                }
            }
        }

        // Bug 1 (Spec #633): Inject the task instruction for OTLP subagent
        // sessions from pending_task_instructions (keyed by parent session ID).
        if is_subagent {
            let instruction: Option<String> = relationship_meta
                .as_ref()
                .and_then(|meta| meta.get("relationship"))
                .and_then(|rel| rel.get("parentSessionId"))
                .and_then(|v| v.as_str())
                .and_then(|parent_sid| {
                    self.pending_task_instructions
                        .lock()
                        .ok()
                        .and_then(|m| m.get(parent_sid).cloned())
                });
            if let Some(ref instr) = instruction {
                if !instr.is_empty() {
                    if let Some(obj) = mapped_payload.as_object_mut() {
                        obj.insert("instruction".to_string(), Value::String(instr.clone()));
                    }
                }
            }
        }

        // Fallback: try the parent_prompts cache if pending_task_instructions
        // didn't find anything.
        if is_subagent {
            let has_instruction = mapped_payload
                .get("instruction")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !has_instruction {
                if let (Ok(parent_prompts), Ok(session_to_parent)) = (
                    self.parent_prompts.lock(),
                    self.session_to_parent.lock(),
                ) {
                    parent_prompt_cache::req_2_inject_parent_prompt_as_instruction(
                        &parent_prompts,
                        &session_to_parent,
                        &session_id,
                        &mut mapped_payload,
                    );
                }
            }
        }

        // REQ-3: Clone payload before move — may be needed for the synthetic Init.
        let init_payload = mapped_payload.clone();

        // REQ-12: Extract tool_name from op_name for tool.* spans.
        let tool_name = op_name.strip_prefix(OP_TOOL_PREFIX).map(|s| s.to_string());
        let tool_name_str = tool_name.as_deref().unwrap_or(&op_name).to_string();

        let build_input = |state: EventState, payload: Value| -> EngineInput {
            let mut input = EngineInput {
                state,
                provider: EventProvider::OpenCode,
                transport,
                event_type,
                session_id: session_id.clone(),
                correlation_id: Some(otlp_correlation_id.clone()),
                tool_name: Some(tool_name_str.clone()),
                payload: Some(payload),
                error: None,
                metadata: None,
                // Spec #2768 ST-1: promote the span-level `session.parent_id`
                // attribute (or the persisted session_to_parent registration)
                // to the FIRST-CLASS typed routing property on EVERY
                // EngineInput of a child session — session, chat, and
                // tool-use spans alike. The payload-level `parentSessionId`
                // projection below is retained unchanged for consumers that
                // read the payload attribute. The ECE
                // (detect_and_register_relationship) registers the child→
                // parent relationship from this field alone, so attribution
                // never depends on catching a parent-side event.
                parent_session_id: session_parent_id.clone(),
            };
            if let Some(ref meta) = relationship_meta {
                input.metadata = Some(meta.clone());
            }
            input
        };

        let mut inputs = Vec::new();
        // REQ-11 fix: For completed chat/tool spans (Response state), emit a
        // synthetic Init EngineInput BEFORE the Response so the ECE emits
        // init-then-end and the Spec #627 multi-message buffer reset is
        // preserved (R9). Session spans never reach here (always Init).
        if event_state == EventState::Response {
            inputs.push(build_input(EventState::Init, init_payload));
        }
        inputs.push(build_input(event_state, mapped_payload));

        Some(inputs)
    }

    /// ST9 (#2688): Resolve the correlationId for an OTLP span, applying the
    /// per-turn counter fix for completed chat/tool spans.
    ///
    /// The Run CLI export order exports completed chat spans (endTimeUnixNano
    /// present, event_state Response) BEFORE any Init-state span. A first
    /// export that is a completed chat/tool span must still advance the
    /// per-turn counter so each prompt opens its own ECE buffer — it resolves
    /// as an `EventState::Init` so `generate_per_turn_correlation_id` yields
    /// `<session>_<n>` and the synthetic Init + Response share that id.
    ///
    /// Reuse guard: a completed span whose `spanId` already emitted an Init in
    /// an earlier export (the streaming open-then-complete dual-export path)
    /// reuses that Init's correlationId from `span_to_correlation` — the
    /// counter never double-advances, so one turn stays one buffer (no phantom
    /// node, AC5).
    ///
    /// Session spans (always Init, REQ-609) and Hook-bridged sessions (stored
    /// cid + no counter → reuse, `resolve_correlation_id`) are unchanged.
    fn resolve_span_correlation_id(
        &self,
        session_id: &str,
        span_id: &str,
        op_name: &str,
        event_state: EventState,
    ) -> String {
        // Session spans are always Init (REQ-609) and never carry a per-turn
        // counter — keep their pre-ST9 path untouched.
        if op_name == OP_SESSION {
            return self.resolve_correlation_id(session_id, event_state);
        }

        // Reuse guard: this exact span already emitted an Init in an earlier
        // export (streaming open-then-complete). Reuse its correlationId so the
        // per-turn counter is not advanced a second time for the same turn.
        if !span_id.is_empty() {
            let key = (session_id.to_string(), span_id.to_string());
            if let Some(cid) = self.span_to_correlation.lock().ok().and_then(|m| m.get(&key).cloned())
            {
                return cid;
            }
        }

        // First export of this span. A completed chat/tool span (Response —
        // endTimeUnixNano present) resolves as an Init so the per-turn counter
        // advances and the id takes the form `<session>_<n>`.
        let cid = if event_state == EventState::Response {
            self.resolve_correlation_id(session_id, EventState::Init)
        } else {
            self.resolve_correlation_id(session_id, event_state)
        };

        // Record the span→correlation mapping so a re-export of the same span
        // (the completed export after a streaming Init) reuses this id.
        if !span_id.is_empty() {
            if let Ok(mut map) = self.span_to_correlation.lock() {
                let key = (session_id.to_string(), span_id.to_string());
                if map.len() >= MAP_CAPACITY && !map.contains_key(&key) {
                    if let Some(k) = map.keys().next().cloned() {
                        map.remove(&k);
                    }
                }
                map.insert(key, cid.clone());
            }
        }

        cid
    }

    /// REQ-3 / REQ-639: Resolve the correlationId for an OTLP span.
    ///
    /// Hook-bridged sessions (stored `session_to_correlation` entry and no
    /// per-turn counter) reuse the stored Hook correlationId; pure-OTLP
    /// sessions generate a unique per-turn ID (`<session>_<n>`) on each Init so
    /// each turn's ECE composite key (sessionId, correlationId) is unique.
    fn resolve_correlation_id(&self, session_id: &str, event_state: EventState) -> String {
        let stored = self
            .session_to_correlation
            .lock()
            .ok()
            .and_then(|m| m.get(session_id).cloned());
        let has_turn_counter = self
            .session_turn_counter
            .lock()
            .ok()
            .map(|m| m.contains_key(session_id))
            .unwrap_or(false);

        if let Some(ref cid) = stored {
            if !has_turn_counter {
                // Hook-bridged: stored correlationId came from the Hook transport.
                return cid.clone();
            }
            if event_state == EventState::Init {
                // Pure-OTLP Init: generate a new per-turn correlationId.
                return self.generate_per_turn_correlation_id(session_id);
            }
            // Pure-OTLP non-Init: reuse the stored per-turn ID.
            return cid.clone();
        }

        if event_state == EventState::Init {
            // Pure-OTLP first Init: generate the first per-turn correlationId.
            return self.generate_per_turn_correlation_id(session_id);
        }

        // Non-Init with no stored entry: fall back to session_id.
        let cid = session_id.to_string();
        if let Ok(mut map) = self.session_to_correlation.lock() {
            if map.len() >= MAP_CAPACITY && !map.contains_key(session_id) {
                if let Some(key) = map.keys().next().cloned() {
                    map.remove(&key);
                }
            }
            map.entry(session_id.to_string()).or_insert_with(|| cid.clone());
        }
        cid
    }

    /// REQ-639 (REQ-2): Increment the per-session turn counter, generate a unique
    /// `<session>_<n>` correlationId, and upsert it in session_to_correlation.
    /// Both maps are capped at 10,000 entries with oldest-first eviction.
    fn generate_per_turn_correlation_id(&self, session_id: &str) -> String {
        let mut turn_map = self.session_turn_counter.lock().ok();
        let counter = turn_map
            .as_mut()
            .map(|m| {
                let entry = m.entry(session_id.to_string()).or_insert(0);
                *entry += 1;
                *entry
            })
            .unwrap_or(1);
        let new_cid = format!("{}_{}", session_id, counter);

        if let Ok(mut map) = self.session_to_correlation.lock() {
            if map.len() >= MAP_CAPACITY && !map.contains_key(session_id) {
                if let Some(key) = map.keys().next().cloned() {
                    map.remove(&key);
                }
            }
            map.insert(session_id.to_string(), new_cid.clone());
        }

        if let Some(ref mut tm) = turn_map {
            if tm.len() >= MAP_CAPACITY {
                if let Some(key) = tm.keys().next().cloned() {
                    tm.remove(&key);
                }
            }
        }

        new_cid
    }

    /// Resolve the canonical operation name for an OTLP span — provider-agnostic (R6).
    ///
    /// Priority:
    /// 1. `gen_ai.operation.name` registry values (genai-conventions.ts:15-21):
    ///    `run_agent` → `session`, `chat` (or legacy `invoke_agent`) → `chat`,
    ///    `execute_tool` → `tool.<name>` (name from `gen_ai.tool.name` when
    ///    present, else the span name).
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
                Self::tool_name_from_span(span_name)
            ));
        }

        if let Some(span_type) = attrs.get(CC_ATTR_SPAN_TYPE).and_then(|v| v.as_str()) {
            if span_type != span_name {
                return Self::resolve_op_name(span_type, attrs);
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

    /// Spec #2723 (R-5 / AC5, round 2): determine whether a span belongs to a
    /// subagent session at the SESSION level.
    ///
    /// The plugin emits `is_subagent` / `agent.type` attributes ONLY on the
    /// `fredo.session` span (handlers/session.ts:181-182); the `fredo.llm` and
    /// chat spans of a subagent session carry `session.parent_id` instead
    /// (handlers/message.ts:208,690). The ECE `excludePayload` contract filter
    /// evaluates on the EVENT payload, so the session-level marker must be
    /// propagated into every span-derived payload (LLM/chat included) for the
    /// Mission Monitor exclusion rules (`is_subagent: true` /
    /// `agent.type: "subagent"`) to match and drop child events pre-buffer.
    ///
    /// A span belongs to a subagent session when:
    /// 1. the span itself carries the `is_subagent` / `agent.type` attrs (the
    ///    `fredo.session` span), OR
    /// 2. the span carries a `session.parent_id` differing from its own session
    ///    (LLM/chat spans — populated into `session_to_parent` earlier in
    ///    `process_span`), OR
    /// 3. `session_to_parent` already knows this session's parent (registered
    ///    by a prior span of the same session — covers timing gaps where a
    ///    later LLM span omits the attribute).
    fn is_subagent_session(&self, attrs: &Map<String, Value>, session_id: &str) -> bool {
        Self::is_subagent_span(attrs)
            || attrs
                .get(CC_ATTR_SESSION_PARENT_ID)
                .and_then(|v| v.as_str())
                .map(|psid| !psid.is_empty() && psid != session_id)
                .unwrap_or(false)
            || self
                .session_to_parent
                .lock()
                .ok()
                .and_then(|m| m.get(session_id).cloned())
                .map(|parent| parent != session_id)
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
            .and_then(|s| Self::extract_messages_text(s, "user"));
        let output_messages_text = attrs
            .get(ATTR_OUTPUT_MESSAGES)
            .and_then(|v| v.as_str())
            .and_then(|s| Self::extract_messages_text(s, "assistant"));
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
        // registry keys as the info.* twins (otlp.rs:982-999):
        // gen_ai.usage.reasoning.output_tokens /
        // gen_ai.usage.cache_read.input_tokens /
        // gen_ai.usage.cache_creation.input_tokens. reasoningTokens /
        // cacheWriteTokens are absolute per-turn values (never deltas);
        // cacheReadTokens is the derived per-turn DELTA when present
        // (Spec #2723 ST-3 H1 — the registry value is session-cumulative). An
        // absent family means the field is simply NOT injected — the plugin
        // skips usage attrs ≤ 0, and the frontend renders 0 (R-3.3). This
        // injection happens inside otlp_attrs_to_payload, i.e. BEFORE the
        // payload clone (otlp.rs:517-518), so the synthetic Init and Response
        // deliveries carry the fields identically.
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
        // dispatch-only data). Injected here, i.e. BEFORE the payload clone at
        // otlp.rs:601, so the synthetic Init + Response deliveries carry them
        // identically. The flat attrs themselves remain preserved verbatim via
        // the attrs.clone() at the top of this function.
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
        let is_subagent_span = Self::is_subagent_span(&attrs);
        if is_subagent_span {
            let instruction = attrs
                .get(ATTR_INPUT_MESSAGES)
                .and_then(|v| v.as_str())
                .and_then(|s| Self::extract_messages_text(s, "user"))
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

    /// Spec #2711: derive the per-message token consumption for a completed
    /// chat span.
    ///
    /// `gen_ai.usage.input_tokens` is the CUMULATIVE non-cached request
    /// context for the session at turn n (grows monotonically per turn:
    /// 2,731 → 2,758 → 2,790 → 2,820 → 3,229 in the live root-cause session);
    /// the per-message prompt consumption is the DELTA from the previous
    /// turn's cumulative input. `gen_ai.usage.cache_read.input_tokens` (the
    /// cached system/tool prefix, pinned at e.g. 25,344) cancels in every
    /// delta and NEVER enters a node's prompt/completion.
    ///
    /// Spec #2723 ST-3 (H1): `gen_ai.usage.cache_read.input_tokens` is
    /// SESSION-CUMULATIVE in live telemetry (strictly non-decreasing across
    /// turns), so this method ALSO derives the per-turn cache-read delta
    /// (`cache_read_n − prev_cache`, clamped ≥ 0) against a per-session
    /// baseline — the node's "Cache" figure must be per-turn, never the raw
    /// cumulative total (raw would make node N's Cache = Σ cache turns 1..N).
    ///
    /// Spec #2734 ST-2: the cache-read derivation is DECOUPLED from the
    /// prompt/input gate. A chat span carrying `gen_ai.usage.cache_read.input_tokens`
    /// derives + persists its per-turn cache delta even when
    /// `gen_ai.usage.input_tokens` is ABSENT (the pre-#2734 `?` early-return
    /// bailed the whole function and `otlp_attrs_to_payload` injected the RAW
    /// session-cumulative cache value on every such span — the AC2 duplication
    /// bug) or when the span is a streaming Init (no endTime — previously the
    /// whole function early-returned `None` at the state gate, losing the cache
    /// baseline/delta for cache-bearing open spans). The prompt/context
    /// derivation remains gated on COMPLETED chat spans carrying input — the
    /// prompt contract is unchanged.
    ///
    /// Guard rails:
    /// - No input AND no cache_read attr → `None`: nothing derivable; the
    ///   caller injects no token fields (unchanged missing-usage behavior).
    /// - Negative delta (context compaction / out-of-order spans) → clamped to
    ///   0 with a baseline reset: `last_request_input` / `last_request_cache_read`
    ///   always store the reading so the NEXT turn derives against the clamped
    ///   turn, never a stale higher baseline.
    /// - Subagent/build/plan sessions key by their own session.id — deltas are
    ///   independent (SubagentNode carries no tokens).
    ///
    /// Returns `Some(TurnTokenDerivation)` when the span carries derivable
    /// usage (completed chat span with input, and/or any cache-bearing chat
    /// span); `None` otherwise or for non-chat spans.
    fn derive_turn_tokens(
        &self,
        session_id: &str,
        op_name: &str,
        event_state: EventState,
        attrs: &Map<String, Value>,
    ) -> Option<TurnTokenDerivation> {
        // Cache-read deltas are chat-scoped — session/tool spans carry no usage.
        if op_name != OP_CHAT_CANON {
            return None;
        }
        let input_n_raw = attrs
            .get(ATTR_USAGE_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        let output_n = attrs
            .get(ATTR_USAGE_OUTPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        let cache_n = attrs
            .get(ATTR_USAGE_CACHE_READ_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
            .unwrap_or(0);
        let has_cache = attrs.contains_key(ATTR_USAGE_CACHE_READ_INPUT_TOKENS);

        // Nothing derivable: a span without input tokens (and not a completed
        // chat span) AND without a cache_read attr → `None` (unchanged
        // missing-usage behavior). Note the old `?`/state early-returns are now
        // CONDITIONALS so a cache-bearing span falls through to the cache
        // derivation below regardless of input presence or event state.
        let completed_with_input = event_state == EventState::Response && input_n_raw.is_some();
        if !completed_with_input && !has_cache {
            return None;
        }

        // Prompt/context derivation stays gated on a COMPLETED chat span
        // carrying input (streaming Init spans never derive prompt deltas —
        // unchanged). Spec #2734 ST-2: this is a conditional now, so cache-only
        // spans skip it without killing the cache derivation.
        let mut prev_input = 0i64;
        let (prompt_delta, session_context_tokens) = if completed_with_input {
            let input_n = input_n_raw.unwrap_or(0).max(0);
            let mut map = self.last_request_input.lock().ok()?;
            prev_input = map.get(session_id).copied().unwrap_or(0);
            // Compaction / out-of-order guard: a negative delta means the input
            // context was reset or spans arrived out of order — clamp to 0 and
            // reset the baseline (stored below) so subsequent deltas derive from
            // THIS turn.
            let delta = (input_n - prev_input).max(0);
            if map.len() >= MAP_CAPACITY && !map.contains_key(session_id) {
                if let Some(key) = map.keys().next().cloned() {
                    map.remove(&key);
                }
            }
            map.insert(session_id.to_string(), input_n);
            (Some(delta), Some(input_n + cache_n))
        } else {
            (None, None)
        };

        // Spec #2723 ST-3 (H1) + Spec #2734 ST-2: derive the per-turn cache-read
        // delta against the per-session cumulative baseline for ANY cache-bearing
        // chat span — completed or streaming Init, input present or absent. Same
        // compaction / out-of-order guard as input: a lower cumulative cache read
        // (context eviction / out-of-order export) clamps to 0 and resets the
        // baseline so the next turn derives from THIS reading, never a stale
        // higher one.
        let mut prev_cache = 0i64;
        let cache_read_delta = if has_cache {
            let mut cache_map = self.last_request_cache_read.lock().ok()?;
            prev_cache = cache_map.get(session_id).copied().unwrap_or(0);
            let cache_delta = (cache_n - prev_cache).max(0);
            if cache_map.len() >= MAP_CAPACITY && !cache_map.contains_key(session_id) {
                if let Some(key) = cache_map.keys().next().cloned() {
                    cache_map.remove(&key);
                }
            }
            cache_map.insert(session_id.to_string(), cache_n);
            Some(cache_delta)
        } else {
            None
        };

        // Bug #586 lesson: surface derivation failures at runtime — per-turn
        // session, prev baselines, raw input, and the resulting delta/output.
        tracing::debug!(
            target: "fredo::adapter::otlp",
            session_id = %session_id,
            prev_input = prev_input,
            input_n = ?input_n_raw,
            prompt_delta = ?prompt_delta,
            completion = ?output_n,
            prev_cache = prev_cache,
            cache_read_delta = ?cache_read_delta,
            "OTLP per-message token delta (Spec #2711) + per-turn cache delta (Spec #2723 ST-3)"
        );

        Some(TurnTokenDerivation {
            prompt_delta,
            completion: output_n,
            session_context_tokens,
            cache_read_delta,
        })
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

    /// Extract the span's real start/end times as RFC3339 UTC strings
    /// (Spec #2723 R-6 / AC6).
    ///
    /// The raw OTLP span JSON carries `startTimeUnixNano` / `endTimeUnixNano`
    /// (uint64 nanoseconds — the OTLP JSON encoding uses decimal strings, but
    /// numeric values are accepted too). The frontend DetailPanel renders these
    /// so the displayed Start/End rows match `telemetry_spans.start_time_ns`
    /// and (start + duration) within ±1 s. `endTime` is `None` for streaming
    /// spans that never carried `endTimeUnixNano` — the frontend then falls
    /// back to the end-delivery timestamp.
    fn span_timing_to_rfc3339(span: &Value) -> (Option<String>, Option<String>) {
        let nano_to_rfc3339 = |key: &str| -> Option<String> {
            let ns = span.get(key).and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| v.as_u64())
                    .or_else(|| v.as_i64().and_then(|i| u64::try_from(i).ok()))
            })?;
            if ns == 0 {
                return None;
            }
            let secs = (ns / 1_000_000_000) as i64;
            let nsecs = (ns % 1_000_000_000) as u32;
            chrono::DateTime::from_timestamp(secs, nsecs).map(|dt| dt.to_rfc3339())
        };
        (
            nano_to_rfc3339("startTimeUnixNano"),
            nano_to_rfc3339("endTimeUnixNano"),
        )
    }
}

impl Default for GenericOtlpAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::comm::contract::types::{ContractDeclaration, ExcludePayloadRule};
    use crate::infrastructure::comm::contract::EventContractEngine;

    /// Build a standard OTLP resourceSpans export with a single span.
    fn otlp_payload(span: Value) -> Value {
        serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [span]
                }]
            }]
        })
    }

    /// Convenience: run a transform and unwrap the EngineInputs.
    fn transform(adapter: &GenericOtlpAdapter, transport: Transport, raw: Value) -> Vec<EngineInput> {
        adapter.transform(transport, raw).expect("transform should not error")
    }

    // ── R6: op classification from gen_ai.operation.name registry values ──────

    #[test]
    fn classifies_run_agent_as_agent_session() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "my.session",
            "traceId": "trace-run-agent",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-run-agent" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].event_type, EventType::AgentSession);
        assert_eq!(inputs[0].event_type.as_str(), "agent_session");
        assert_eq!(inputs[0].state, EventState::Init, "REQ-609: session spans always Init");
    }

    #[test]
    fn classifies_chat_via_operation_name() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-chat",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-chat" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].event_type, EventType::Chat);
        assert_eq!(inputs[0].event_type.as_str(), "chat");
        assert_eq!(inputs[0].state, EventState::Init);
    }

    #[test]
    fn classifies_execute_tool_via_operation_name() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "fredo.tool.Bash",
            "traceId": "trace-tool",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                { "key": "gen_ai.tool.name", "value": { "stringValue": "Bash" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-tool" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].event_type, EventType::ToolUse);
        assert_eq!(inputs[0].event_type.as_str(), "tool_use");
        // Tool name from the registry key gen_ai.tool.name, not the span name.
        assert_eq!(inputs[0].tool_name.as_deref(), Some("Bash"));
    }

    // ── R6: generic (non-fredo.*) span-name classification, no operation attr ──

    #[test]
    fn generic_span_names_classify_without_fredo_patterns() {
        let adapter = GenericOtlpAdapter::new();

        // "my.llm" (a second emitter's chat span) → chat.
        let chat = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "my.llm",
                "traceId": "t1",
                "attributes": [
                    { "key": "session.id", "value": { "stringValue": "s1" } }
                ]
            })),
        );
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0].event_type, EventType::Chat);

        // "my.tool.bash" → tool_use with tool name "bash".
        let tool = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "my.tool.bash",
                "traceId": "t2",
                "attributes": [
                    { "key": "session.id", "value": { "stringValue": "s2" } }
                ]
            })),
        );
        assert_eq!(tool.len(), 1);
        assert_eq!(tool[0].event_type, EventType::ToolUse);
        assert_eq!(tool[0].tool_name.as_deref(), Some("bash"));

        // "agent" / "session" spans → agent_session.
        let session = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "agent",
                "traceId": "t3",
                "attributes": [
                    { "key": "session.id", "value": { "stringValue": "s3" } }
                ]
            })),
        );
        assert_eq!(session.len(), 1);
        assert_eq!(session[0].event_type, EventType::AgentSession);
        assert_eq!(session[0].event_type.as_str(), "agent_session");
    }

    #[test]
    fn unknown_span_is_dropped_not_panicked() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "totally.unrelated",
            "traceId": "t-drop",
            "attributes": []
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert!(inputs.is_empty(), "unrecognised span should be dropped");
    }

    // ── R9: REQ-609 session Init + synthetic Init-before-Response ordering ────

    #[test]
    fn completed_session_span_stays_init_only() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-sess-complete",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-complete" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        // REQ-609: a completed session span emits ONE Init EngineInput — never a
        // Response, and no synthetic Init (the single Init already serves as the
        // buffer creation event).
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].state, EventState::Init);
        assert_eq!(inputs[0].event_type, EventType::AgentSession);
    }

    #[test]
    fn completed_chat_span_emits_synthetic_init_before_response() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-chat-complete",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-chat-complete" } },
                { "key": "gen_ai.output.messages", "value": { "stringValue": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"Hello there\"}]}]" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
        assert_eq!(inputs[0].state, EventState::Init);
        assert_eq!(inputs[1].state, EventState::Response);
        // Same composite key across the synthetic Init and the Response.
        assert_eq!(inputs[0].correlation_id, inputs[1].correlation_id);
        assert_eq!(inputs[0].session_id, inputs[1].session_id);
        // Synthetic Init carries the same payload (agentReply present).
        let init_payload = inputs[0].payload.as_ref().unwrap();
        assert_eq!(
            init_payload.get("agentReply").and_then(|v| v.as_str()),
            Some("Hello there")
        );
    }

    #[test]
    fn incomplete_chat_span_emits_single_init() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-chat-open",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-chat-open" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].state, EventState::Init);
    }

    // ── Correlation-map behavior (REQ-3 / REQ-639) ────────────────────────────

    #[test]
    fn per_turn_correlation_ids_for_multi_turn_pure_otlp() {
        let adapter = GenericOtlpAdapter::new();

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "chat",
                "traceId": "trace-1",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": "shared-session" } }
                ]
            })),
        );
        assert_eq!(first[0].correlation_id.as_deref(), Some("shared-session_1"));

        let second = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "chat",
                "traceId": "trace-2",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": "shared-session" } }
                ]
            })),
        );
        assert_eq!(
            second[0].correlation_id.as_deref(),
            Some("shared-session_2"),
            "second OTLP Init for the same session generates a new per-turn ID"
        );

        let map = adapter.session_to_correlation.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("shared-session").map(|s| s.as_str()), Some("shared-session_2"));
    }

    #[test]
    fn hook_bridged_correlation_reused_when_no_turn_counter() {
        let adapter = GenericOtlpAdapter::new();
        // Simulate a Hook transport having stored a correlationId for the session.
        adapter
            .session_to_correlation
            .lock()
            .unwrap()
            .insert("sess-hook".to_string(), "hook-corr-abc".to_string());

        let inputs = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "chat",
                "traceId": "trace-hook",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-hook" } }
                ]
            })),
        );
        // No turn counter for the session → Hook-bridged → reuse the stored ID.
        assert_eq!(inputs[0].correlation_id.as_deref(), Some("hook-corr-abc"));
    }

    #[test]
    fn correlation_map_capped_at_10000_oldest_evicted() {
        let adapter = GenericOtlpAdapter::new();
        // Fill session_to_correlation to capacity via the public path.
        for i in 0..MAP_CAPACITY {
            adapter
                .session_to_correlation
                .lock()
                .unwrap()
                .insert(format!("sess-{}", i), format!("cid-{}", i));
        }
        assert_eq!(adapter.session_to_correlation.lock().unwrap().len(), MAP_CAPACITY);

        // A new session triggers per-turn ID generation → must evict an old entry.
        let inputs = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "chat",
                "traceId": "trace-overflow",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": "overflow-session" } }
                ]
            })),
        );
        assert_eq!(inputs[0].correlation_id.as_deref(), Some("overflow-session_1"));
        let map = adapter.session_to_correlation.lock().unwrap();
        assert!(map.len() <= MAP_CAPACITY);
        assert!(map.contains_key("overflow-session"));
    }

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
        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, derived);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("from input.messages"));
    }

    #[test]
    fn request_body_preferred_over_flat_prompt_when_input_messages_absent() {
        let mut attrs = Map::new();
        attrs.insert(ATTR_REQUEST_BODY.to_string(), json!("from request.body"));
        attrs.insert(CC_ATTR_PROMPT_FLAT.to_string(), json!("from flat prompt"));

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("from output.messages"));
    }

    #[test]
    fn output_messages_falls_back_to_flat_response_text() {
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_RESPONSE_TEXT.to_string(), json!("from flat response_text"));

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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
        assert_eq!(GenericOtlpAdapter::extract_messages_text(&json, "user").as_deref(), Some("Hello world"));
    }

    #[test]
    fn extract_messages_text_skips_non_text_parts() {
        let json = serde_json::json!([
            { "role": "user", "parts": [{ "type": "tool_call", "id": "c1" }, { "type": "text", "content": "actual" }] }
        ])
        .to_string();
        assert_eq!(GenericOtlpAdapter::extract_messages_text(&json, "user").as_deref(), Some("actual"));
    }

    #[test]
    fn extract_messages_text_returns_none_for_unmatched_role_or_bad_json() {
        let json = serde_json::json!([
            { "role": "assistant", "parts": [{ "type": "text", "content": "hi" }] }
        ])
        .to_string();
        assert_eq!(GenericOtlpAdapter::extract_messages_text(&json, "user"), None);
        assert_eq!(GenericOtlpAdapter::extract_messages_text("not json", "user"), None);
        assert_eq!(GenericOtlpAdapter::extract_messages_text("{}", "user"), None);
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
        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("childTokens").and_then(|v| v.as_i64()), Some(1234));
        assert_eq!(obj.get("childCost").and_then(|v| v.as_f64()), Some(0.0042));
        assert_eq!(obj.get("childMessages").and_then(|v| v.as_i64()), Some(3));
    }

    #[test]
    fn completed_task_span_carries_child_completion_keys_on_init_and_response() {
        // Full transform-level verification (ST-3's core invariant): a COMPLETED
        // parent `fredo.tool.task` span carrying the child-completion flat attrs
        // dual-emits synthetic Init + Response sharing one correlationId, and BOTH
        // payloads carry the canonical child keys identically (injected before the
        // payload clone at otlp.rs:601).
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "fredo.tool.task",
            "traceId": "trace-task-child",
            "spanId": "span-task-child",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                { "key": "gen_ai.tool.name", "value": { "stringValue": "task" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "parent-session" } },
                { "key": "child_session_id", "value": { "stringValue": "ses_child_1" } },
                { "key": "child_agent", "value": { "stringValue": "explore" } },
                { "key": "child_total_tokens", "value": { "intValue": "1234" } },
                { "key": "child_total_cost_usd", "value": { "doubleValue": 0.0123 } },
                { "key": "child_total_messages", "value": { "intValue": "7" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed task span dual-emits Init + Response");
        assert_eq!(inputs[0].state, EventState::Init);
        assert_eq!(inputs[1].state, EventState::Response);
        assert_eq!(
            inputs[0].correlation_id,
            inputs[1].correlation_id,
            "synthetic Init and Response share one correlationId"
        );

        for input in &inputs {
            let payload = input.payload.as_ref().unwrap();
            assert_eq!(
                payload.get("childSessionId").and_then(|v| v.as_str()),
                Some("ses_child_1"),
                "{:?} delivery must carry childSessionId",
                input.state
            );
            assert_eq!(
                payload.get("childAgent").and_then(|v| v.as_str()),
                Some("explore"),
                "{:?} delivery must carry childAgent",
                input.state
            );
            assert_eq!(
                payload.get("childTokens").and_then(|v| v.as_i64()),
                Some(1234),
                "{:?} delivery must carry childTokens",
                input.state
            );
            assert_eq!(
                payload.get("childCost").and_then(|v| v.as_f64()),
                Some(0.0123),
                "{:?} delivery must carry childCost",
                input.state
            );
            assert_eq!(
                payload.get("childMessages").and_then(|v| v.as_i64()),
                Some(7),
                "{:?} delivery must carry childMessages",
                input.state
            );
            // Flat fredo-native attrs stay preserved verbatim on both deliveries.
            assert_eq!(
                payload.get(ATTR_CHILD_SESSION_ID).and_then(|v| v.as_str()),
                Some("ses_child_1"),
                "{:?} delivery must preserve the flat child_session_id attr",
                input.state
            );
        }
    }

    #[test]
    fn agent_name_projected_to_agent_and_name() {
        let mut attrs = Map::new();
        attrs.insert(ATTR_AGENT_NAME.to_string(), json!("coder"));

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, None);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("agent").and_then(|v| v.as_str()), Some("coder"));
        assert_eq!(obj.get("name").and_then(|v| v.as_str()), Some("coder"));
    }

    // ── Spec #2711: per-message token delta derivation ────────────────────────

    /// Build a COMPLETED chat span carrying cumulative usage for `session`:
    /// `gen_ai.usage.input_tokens` (cumulative request context), output, and
    /// cache_read (the pinned cached system/tool prefix). int64 attributes use
    /// the OTLP JSON string encoding (`otlp_attrs_to_map` parses both).
    fn completed_chat_span_with_usage(
        session: &str,
        span_id: &str,
        input: i64,
        output: i64,
        cache: i64,
    ) -> Value {
        serde_json::json!({
            "name": "llm",
            "traceId": format!("trace-{}", span_id),
            "spanId": span_id,
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": session } },
                { "key": "gen_ai.usage.input_tokens", "value": { "intValue": format!("{}", input) } },
                { "key": "gen_ai.usage.output_tokens", "value": { "intValue": format!("{}", output) } },
                { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": format!("{}", cache) } }
            ]
        })
    }

    #[test]
    fn per_message_prompt_deltas_from_warm_cache_cumulative_input() {
        // Spec #2711 root-cause trace (live session
        // ses_00bf7871dffexcyzy13MkdhiM9): cumulative gen_ai.usage.input_tokens
        // 2,731 → 2,758 → 2,790 → 2,820 → 3,229 with cache_read pinned at
        // 25,344. Per-message deltas: 2,731 / 27 / 32 / 30 / 409. The cache
        // prefix cancels in every delta — it never enters a node's prompt.
        let adapter = GenericOtlpAdapter::new();
        let session = "ses_00bf7871dffexcyzy13MkdhiM9";
        let cumulative = [2_731_i64, 2_758, 2_790, 2_820, 3_229];
        let expected_deltas = [2_731_i64, 27, 32, 30, 409];
        let cache = 25_344_i64;

        for (i, &input) in cumulative.iter().enumerate() {
            let inputs = transform(
                &adapter,
                Transport::OtlpGrpc,
                otlp_payload(completed_chat_span_with_usage(
                    session,
                    &format!("span-{}", i),
                    input,
                    150 + i as i64,
                    cache,
                )),
            );
            assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
            let init_payload = inputs[0].payload.as_ref().unwrap();
            let response_payload = inputs[1].payload.as_ref().unwrap();
            // The delta must be IDENTICAL across the synthetic Init and the
            // Response — computed once per span set, not per event.
            for payload in [init_payload, response_payload] {
                assert_eq!(
                    payload.get("promptTokens").and_then(|v| v.as_i64()),
                    Some(expected_deltas[i]),
                    "turn {}: promptTokens must be the per-message delta ({}), never the cumulative input ({})",
                    i + 1,
                    expected_deltas[i],
                    input
                );
                assert_eq!(
                    payload.get("completionTokens").and_then(|v| v.as_i64()),
                    Some(150 + i as i64),
                    "turn {}: completionTokens = the turn's own output",
                    i + 1
                );
                // AC3 reconciliation aid: C(n) = sessionContextTokens(n) +
                // output(n) + reasoning(n) = cache(n) + input(n) + output(n) +
                // reasoning(n).
                assert_eq!(
                    payload.get("sessionContextTokens").and_then(|v| v.as_i64()),
                    Some(input + cache),
                    "turn {}: sessionContextTokens = input_n + cache_read_n",
                    i + 1
                );
            }
        }
    }

    #[test]
    fn cold_cache_first_turn_delta_equals_full_input() {
        // Cold cache: cache_read = 0 on every turn; turn 1 has no prev baseline
        // (absent → 0) so delta = input(1) — the full first prompt is consumed
        // by the first message.
        let adapter = GenericOtlpAdapter::new();
        let session = "cold-session";

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-1", 100, 10, 0)),
        );
        let p = first[1].payload.as_ref().unwrap();
        assert_eq!(
            p.get("promptTokens").and_then(|v| v.as_i64()),
            Some(100),
            "first turn (no prev) → delta = input(1)"
        );
        assert_eq!(
            p.get("sessionContextTokens").and_then(|v| v.as_i64()),
            Some(100),
            "cache 0 → session context = input(1)"
        );

        let second = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-2", 130, 15, 0)),
        );
        let p = second[1].payload.as_ref().unwrap();
        assert_eq!(
            p.get("promptTokens").and_then(|v| v.as_i64()),
            Some(30),
            "turn 2 → delta = 130 − 100"
        );
        assert_eq!(p.get("sessionContextTokens").and_then(|v| v.as_i64()), Some(130));
    }

    #[test]
    fn per_turn_cache_read_deltas_from_cumulative_cache_read() {
        // Spec #2723 ST-3 (H1) root-cause trace (live session
        // ses_044bb36d7ffeeh5kwPSzvQ1Aum): gen_ai.usage.cache_read.input_tokens
        // is SESSION-CUMULATIVE (strictly non-decreasing per turn: 512,000 →
        // 513,536 → 515,840 → 516,224 → 518,144 over 57 turns). The per-node
        // "Cache" figure must be the per-turn DELTA (512,000 / 1,536 / 2,304 /
        // 384 / 1,920) — never the raw cumulative total (raw would make node
        // N's Cache = Σ cache turns 1..N: literal cross-node contamination).
        let adapter = GenericOtlpAdapter::new();
        let session = "ses_044bb36d7ffeeh5kwPSzvQ1Aum";
        let cumulative_cache = [512_000_i64, 513_536, 515_840, 516_224, 518_144];
        let expected_deltas = [512_000_i64, 1_536, 2_304, 384, 1_920];
        // Cumulative input grows alongside cache (like the live session):
        // per-message prompt deltas 100 / 1 / 1 / 1 / 1.
        let cumulative_input = [100_i64, 101, 102, 103, 104];
        let expected_prompt_deltas = [100_i64, 1, 1, 1, 1];

        for (i, &cache) in cumulative_cache.iter().enumerate() {
            let inputs = transform(
                &adapter,
                Transport::OtlpGrpc,
                otlp_payload(completed_chat_span_with_usage(
                    session,
                    &format!("span-{}", i),
                    cumulative_input[i],
                    50 + i as i64,
                    cache,
                )),
            );
            assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
            let init_payload = inputs[0].payload.as_ref().unwrap();
            let response_payload = inputs[1].payload.as_ref().unwrap();
            // The delta must be IDENTICAL across the synthetic Init and the
            // Response — computed once per span set, not per event (G-011).
            for payload in [init_payload, response_payload] {
                assert_eq!(
                    payload.get("cacheReadTokens").and_then(|v| v.as_i64()),
                    Some(expected_deltas[i]),
                    "turn {}: cacheReadTokens must be the per-turn cache delta ({}), never the cumulative cache read ({})",
                    i + 1,
                    expected_deltas[i],
                    cache
                );
                assert_eq!(
                    payload.get("info").and_then(|v| v.get("turnCacheReadTokens")).and_then(|v| v.as_i64()),
                    Some(expected_deltas[i]),
                    "turn {}: info.turnCacheReadTokens mirrors the per-turn cache delta",
                    i + 1
                );
                // promptTokens still derives independently (per-turn input delta).
                assert_eq!(
                    payload.get("promptTokens").and_then(|v| v.as_i64()),
                    Some(expected_prompt_deltas[i]),
                    "turn {}: promptTokens = this turn's input delta",
                    i + 1
                );
            }
        }
    }

    #[test]
    fn cache_read_delta_never_leaks_into_other_families() {
        // Spec #2723 ST-3 (H1): the per-turn cache-read delta must NEVER leak
        // into promptTokens/completionTokens/sessionContextTokens — those
        // continue to carry their own semantics (per-message prompt delta,
        // per-turn output, cumulative context aid input_n + cache_n). The
        // delta is scoped to the "Cache" category only.
        let adapter = GenericOtlpAdapter::new();
        let session = "no-leak-session";

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-1", 2_731, 180, 25_344)),
        );
        let p = first[1].payload.as_ref().unwrap();
        assert_eq!(p.get("cacheReadTokens").and_then(|v| v.as_i64()), Some(25_344));
        assert_eq!(p.get("promptTokens").and_then(|v| v.as_i64()), Some(2_731));
        assert_eq!(p.get("completionTokens").and_then(|v| v.as_i64()), Some(180));
        // sessionContextTokens stays input_n + cache_read_n (cumulative aid).
        assert_eq!(
            p.get("sessionContextTokens").and_then(|v| v.as_i64()),
            Some(2_731 + 25_344)
        );

        // Turn 2: cache grows by 1,536; input grows by 27.
        let second = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-2", 2_758, 190, 26_880)),
        );
        let p = second[1].payload.as_ref().unwrap();
        assert_eq!(
            p.get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(1_536),
            "turn 2 cache delta = 26,880 − 25,344"
        );
        assert_eq!(
            p.get("promptTokens").and_then(|v| v.as_i64()),
            Some(27),
            "turn 2 prompt delta = 2,758 − 2,731"
        );
        assert_eq!(p.get("completionTokens").and_then(|v| v.as_i64()), Some(190));
        assert_eq!(
            p.get("sessionContextTokens").and_then(|v| v.as_i64()),
            Some(2_758 + 26_880)
        );
    }

    #[test]
    fn cache_read_delta_clamps_on_cumulative_decrease_and_resets_baseline() {
        // Spec #2723 ST-3 (H1) guard — mirror the input compaction guard: a
        // cumulative cache read that DECREASES (cache eviction / out-of-order
        // export) must never emit a negative per-turn cache delta — clamp to 0
        // AND reset the baseline so the NEXT turn derives against the clamped
        // reading, never a stale higher baseline.
        let adapter = GenericOtlpAdapter::new();
        let session = "cache-clamp-session";

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-1", 100, 10, 30_000)),
        );
        assert_eq!(
            first[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(30_000)
        );

        // Cache eviction: cumulative cache drops 30,000 → 20,000 → delta −10,000
        // → clamped 0 (never negative).
        let evicted = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-2", 200, 15, 20_000)),
        );
        assert_eq!(
            evicted[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(0),
            "negative cache delta clamps to 0 — never negative cacheReadTokens"
        );

        // Next turn derives from the RESET baseline (20,000), not the
        // pre-eviction 30,000.
        let third = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-3", 300, 20, 20_500)),
        );
        assert_eq!(
            third[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(500),
            "baseline reset after clamp: 20,500 − 20,000"
        );
    }

    #[test]
    fn cache_read_delta_derived_when_input_tokens_missing() {
        // Spec #2734 ST-2 — the previously-untested fallback: a completed chat
        // span carrying gen_ai.usage.cache_read.input_tokens but NO
        // gen_ai.usage.input_tokens. The pre-#2734 code early-returned `None`
        // at the input `?` (otlp.rs:1291-1293) and otlp_attrs_to_payload fell
        // back to the RAW session-CUMULATIVE cache value on every such span —
        // every fallback node carried the same cumulative figure and the
        // session total summed it N times (AC2). Now the cache baseline/delta
        // is derived independently of input: cacheReadTokens MUST be the
        // per-turn delta, never the raw cumulative. Prompt stays absent (no
        // input to derive from — the prompt contract is unchanged).
        let adapter = GenericOtlpAdapter::new();
        let session = "no-input-cache-session";

        // Turn 1: cumulative cache 25,344, no input_tokens → delta 25,344
        // (first turn, prev baseline absent → 0).
        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "llm",
                "traceId": "trace-cache-only-1",
                "spanId": "span-cache-only-1",
                "endTimeUnixNano": "1000000",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": session } },
                    { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": "25344" } }
                ]
            })),
        );
        assert_eq!(first.len(), 2, "completed chat span dual-emits Init + Response");
        for (idx, payload) in first.iter().map(|i| i.payload.as_ref().unwrap()).enumerate() {
            assert_eq!(
                payload.get("cacheReadTokens").and_then(|v| v.as_i64()),
                Some(25_344),
                "delivery {}: turn 1 cacheReadTokens = first-turn delta (prev absent → full cumulative 25,344)",
                idx
            );
            assert!(
                payload.get("promptTokens").is_none(),
                "delivery {}: no input_tokens attr → promptTokens stays absent (unchanged prompt contract)",
                idx
            );
            assert!(
                payload.get("sessionContextTokens").is_none(),
                "delivery {}: no input to sum → sessionContextTokens absent",
                idx
            );
        }

        // Turn 2: cumulative cache grows 25,344 → 26,880 → per-turn delta
        // 1,536 — NEVER the raw cumulative 26,880.
        let second = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "llm",
                "traceId": "trace-cache-only-2",
                "spanId": "span-cache-only-2",
                "endTimeUnixNano": "1000000",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": session } },
                    { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": "26880" } }
                ]
            })),
        );
        assert_eq!(second.len(), 2, "completed chat span dual-emits Init + Response");
        for (idx, payload) in second.iter().map(|i| i.payload.as_ref().unwrap()).enumerate() {
            assert_eq!(
                payload.get("cacheReadTokens").and_then(|v| v.as_i64()),
                Some(1_536),
                "delivery {}: turn 2 cacheReadTokens = per-turn delta (26,880 − 25,344), NEVER the raw cumulative 26,880",
                idx
            );
            assert!(
                payload.get("promptTokens").is_none(),
                "delivery {}: promptTokens stays absent on cache-only turns",
                idx
            );
        }

        // The raw session-cumulative cache value must never appear as
        // cacheReadTokens on ANY delivery of either turn.
        for (turn, payload) in first
            .iter()
            .chain(second.iter())
            .map(|i| i.payload.as_ref().unwrap())
            .enumerate()
        {
            let cache = payload.get("cacheReadTokens").and_then(|v| v.as_i64());
            assert!(
                cache != Some(26_880),
                "delivery {}: the raw cumulative cache (26,880) must never be injected as cacheReadTokens",
                turn
            );
        }
    }

    #[test]
    fn streaming_init_cache_bearing_span_derives_cache_delta() {
        // Spec #2734 ST-2: the streaming Init early-return (pre-#2734: every
        // non-Response span returned `None` at the state gate, so a cache-bearing
        // OPEN chat span fell back to the RAW session-cumulative cache value).
        // The cache derivation is now state-agnostic: a streaming Init carrying
        // gen_ai.usage.cache_read.input_tokens derives + persists its per-turn
        // delta, and the baseline SURVIVES for the next completed span of the
        // same session ("cache baseline/delta survives for cache-bearing spans").
        let adapter = GenericOtlpAdapter::new();
        let session = "stream-cache-session";

        // 1. Streaming Init (no endTimeUnixNano) with cumulative cache 25,344
        //    → single Init delivery, cacheReadTokens = 25,344 (first-turn delta).
        let open = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "llm",
                "traceId": "trace-stream-cache",
                "spanId": "span-stream-cache",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": session } },
                    { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": "25344" } }
                ]
            })),
        );
        assert_eq!(open.len(), 1, "streaming span emits a single Init");
        assert_eq!(open[0].state, EventState::Init);
        let open_payload = open[0].payload.as_ref().unwrap();
        assert_eq!(
            open_payload.get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(25_344),
            "streaming Init derives its per-turn cache delta (first turn) — never the pre-#2734 raw fallback path"
        );
        assert!(
            open_payload.get("promptTokens").is_none(),
            "streaming Init never derives prompt deltas (unchanged)"
        );

        // 2. Completed span of the SAME session (next turn): cache grows to
        //    26,880 → delta 1,536 against the baseline persisted by the
        //    streaming Init — the cache baseline/delta survives across states.
        let completed = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "llm",
                "traceId": "trace-stream-cache-2",
                "spanId": "span-stream-cache-2",
                "endTimeUnixNano": "1000000",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": session } },
                    { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": "26880" } }
                ]
            })),
        );
        assert_eq!(completed.len(), 2, "completed chat span dual-emits Init + Response");
        for (idx, payload) in completed.iter().map(|i| i.payload.as_ref().unwrap()).enumerate() {
            assert_eq!(
                payload.get("cacheReadTokens").and_then(|v| v.as_i64()),
                Some(1_536),
                "delivery {}: next completed turn derives against the streaming-Init baseline (26,880 − 25,344)",
                idx
            );
        }
    }

    #[test]
    fn subagent_sessions_derive_cache_read_deltas_independently() {
        // The cache-read baseline is keyed per session.id (like the input
        // baseline) — interleaved parent/child sessions never cross-derive
        // their cache deltas.
        let adapter = GenericOtlpAdapter::new();

        // Parent turn 1: cumulative cache 25,000 → delta 25,000.
        let p1 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("parent", "p1", 1_000, 10, 25_000)),
        );
        assert_eq!(
            p1[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(25_000)
        );

        // Child session FIRST turn starts its OWN cache baseline: 200 → delta
        // 200 (NOT 200 − 25,000 from the parent's baseline).
        let s1 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("child", "s1", 200, 5, 200)),
        );
        assert_eq!(
            s1[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(200),
            "subagent first turn: cache delta = its own full cache, independent of the parent"
        );

        // Parent turn 2 still derives from the PARENT cache baseline.
        let p2 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("parent", "p2", 1_050, 12, 26_000)),
        );
        assert_eq!(
            p2[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(1_000),
            "parent turn 2: cache delta = 26,000 − 25,000"
        );

        // Child turn 2 derives from the CHILD cache baseline.
        let s2 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("child", "s2", 250, 6, 350)),
        );
        assert_eq!(
            s2[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(150),
            "subagent turn 2: cache delta = 350 − 200"
        );
    }

    #[test]
    fn compaction_clamp_clamps_negative_delta_to_zero_and_resets_baseline() {
        // Compaction guard: a cumulative input that DECREASES (context
        // compaction) must never emit a negative per-message delta — clamp to 0
        // AND reset the baseline so the NEXT turn derives against the clamped
        // turn, never a stale higher baseline.
        let adapter = GenericOtlpAdapter::new();
        let session = "compact-session";

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-1", 3_000, 50, 25_000)),
        );
        assert_eq!(
            first[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(3_000)
        );

        // Context compacts from 3,000 → 2,500 → delta would be −500 → clamped 0.
        let compacted = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-2", 2_500, 40, 25_000)),
        );
        assert_eq!(
            compacted[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(0),
            "negative delta clamps to 0 — never a negative promptTokens"
        );

        // Next turn derives from the RESET baseline (2,500), not the
        // pre-compaction 3,000.
        let third = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-3", 2_530, 30, 25_000)),
        );
        assert_eq!(
            third[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(30),
            "baseline reset after clamp: 2,530 − 2,500"
        );
    }

    #[test]
    fn out_of_order_spans_never_emit_negative_prompt_tokens() {
        // Out-of-order guard: spans arriving with a LOWER cumulative input
        // (out-of-order export) clamp to 0 — the emitted value is never
        // negative, on repeated decreases too.
        let adapter = GenericOtlpAdapter::new();
        let session = "ooo-session";

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-1", 5_000, 60, 20_000)),
        );
        assert_eq!(
            first[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(5_000)
        );

        // Late-arriving older span (cumulative 3,000 < 5,000).
        let late = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-late", 3_000, 45, 20_000)),
        );
        assert_eq!(
            late[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(0),
            "out-of-order lower cumulative input → delta 0, never negative"
        );

        // A second out-of-order lower span also clamps (baseline is 3,000 now).
        let late2 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "span-late2", 2_000, 40, 20_000)),
        );
        assert_eq!(
            late2[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(0),
            "repeated out-of-order decreases keep clamping to 0"
        );
    }

    #[test]
    fn missing_usage_span_injects_no_prompt_tokens() {
        // Missing-usage spans inject NO promptTokens/completionTokens/
        // sessionContextTokens (unchanged behavior — the frontend last-wins
        // merge keeps the prior per-turn value). agentReply still flows.
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-nousage",
            "spanId": "span-nousage",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-nousage" } },
                { "key": "gen_ai.output.messages", "value": { "stringValue": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"Hi\"}]}]" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
        let payload = inputs[1].payload.as_ref().unwrap();
        assert!(payload.get("promptTokens").is_none(), "no usage → no promptTokens injection");
        assert!(payload.get("completionTokens").is_none(), "no usage → no completionTokens injection");
        assert!(payload.get("sessionContextTokens").is_none(), "no usage → no sessionContextTokens");
        assert_eq!(payload.get("agentReply").and_then(|v| v.as_str()), Some("Hi"));
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
        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, derived);
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
        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs, derived);
        let obj = result.as_object().unwrap();

        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(100));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(50));
        assert!(obj.get("reasoningTokens").is_none(), "absent reasoning family → field not injected");
        assert!(obj.get("cacheReadTokens").is_none(), "absent cache_read family → field not injected");
        assert!(obj.get("cacheWriteTokens").is_none(), "absent cache_creation family → field not injected");
    }

    #[test]
    fn reasoning_and_cache_families_flow_through_synthetic_init_and_response() {
        // The two delivery clones (synthetic Init + Response) must carry the
        // new canonical fields IDENTICALLY — the payload is cloned at
        // otlp.rs:517-518 AFTER otlp_attrs_to_payload injection.
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-fam",
            "spanId": "span-fam",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "fam-session" } },
                { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "2731" } },
                { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "180" } },
                { "key": "gen_ai.usage.reasoning.output_tokens", "value": { "intValue": "512" } },
                { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": "25344" } },
                { "key": "gen_ai.usage.cache_creation.input_tokens", "value": { "intValue": "1024" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
        let init_payload = inputs[0].payload.as_ref().unwrap();
        let response_payload = inputs[1].payload.as_ref().unwrap();
        for (idx, payload) in [init_payload, response_payload].iter().enumerate() {
            assert_eq!(
                payload.get("reasoningTokens").and_then(|v| v.as_i64()),
                Some(512),
                "delivery {}: reasoningTokens on both clones",
                idx
            );
            assert_eq!(
                payload.get("cacheReadTokens").and_then(|v| v.as_i64()),
                Some(25_344),
                "delivery {}: cacheReadTokens on both clones",
                idx
            );
            assert_eq!(
                payload.get("cacheWriteTokens").and_then(|v| v.as_i64()),
                Some(1_024),
                "delivery {}: cacheWriteTokens on both clones",
                idx
            );
        }
    }

    #[test]
    fn missing_usage_span_injects_no_reasoning_or_cache_families() {
        // A span with no usage attrs at all must NOT inject any of the new
        // canonical token fields (R-3.3 absent → field absent, no invented
        // zeros) — same convention as promptTokens/completionTokens.
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-nofam",
            "spanId": "span-nofam",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-nofam" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
        let payload = inputs[1].payload.as_ref().unwrap();
        assert!(payload.get("reasoningTokens").is_none());
        assert!(payload.get("cacheReadTokens").is_none());
        assert!(payload.get("cacheWriteTokens").is_none());
    }

    // ── Spec #2723 (R-6 / AC6): span timing → RFC3339 startTime/endTime ──────

    #[test]
    fn span_timing_injected_as_rfc3339_start_and_end() {
        // A completed chat span carries startTimeUnixNano / endTimeUnixNano in
        // the raw span JSON (http.rs:356-357; telemetry truth raw.rs:45,160).
        // The adapter injects them as RFC3339 UTC strings so the DetailPanel
        // renders telemetry-derived times, not delivery wall-clocks. The
        // injection happens BEFORE the payload clone (otlp.rs:517-518), so the
        // synthetic Init and Response deliveries carry IDENTICAL timing.
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-times",
            "spanId": "span-times",
            // 2024-01-02T03:04:05Z = 1704164645s; 2024-01-02T03:04:06Z = +1s.
            "startTimeUnixNano": "1704164645000000000",
            "endTimeUnixNano": "1704164646000000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-times" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
        for (idx, input) in inputs.iter().enumerate() {
            let payload = input.payload.as_ref().unwrap();
            let start = payload.get("startTime").and_then(|v| v.as_str()).unwrap();
            let end = payload.get("endTime").and_then(|v| v.as_str()).unwrap();
            assert_eq!(start, "2024-01-02T03:04:05+00:00", "delivery {}: startTime RFC3339", idx);
            assert_eq!(end, "2024-01-02T03:04:06+00:00", "delivery {}: endTime RFC3339", idx);
        }
    }

    #[test]
    fn streaming_span_injects_start_time_only() {
        // A streaming (open) chat span has no endTimeUnixNano → EventState::Init
        // and no endTime injection. The frontend then renders Start-only and
        // falls back to the end-delivery timestamp for End (non-goal, ST-7).
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-stream",
            "spanId": "span-stream",
            "startTimeUnixNano": "1704164645000000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-stream" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1, "streaming span emits a single Init");
        let payload = inputs[0].payload.as_ref().unwrap();
        assert_eq!(
            payload.get("startTime").and_then(|v| v.as_str()),
            Some("2024-01-02T03:04:05+00:00"),
            "streaming span still carries its real startTime"
        );
        assert!(payload.get("endTime").is_none(), "streaming span has no endTime to inject");
    }

    #[test]
    fn span_timing_absent_when_nanos_missing_or_zero() {
        // No startTimeUnixNano / endTimeUnixNano on the span JSON → no timing
        // fields injected (the frontend falls back to delivery timestamps).
        // Zero nanos are treated as absent (never 1970-01-01T00:00:00Z).
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-notimes",
            "spanId": "span-notimes",
            "startTimeUnixNano": "0",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-notimes" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        let payload = inputs[0].payload.as_ref().unwrap();
        assert!(payload.get("startTime").is_none(), "zero nanos → no startTime");
        assert!(payload.get("endTime").is_none(), "no endTimeUnixNano → no endTime");
    }

    #[test]
    fn subagent_sessions_derive_deltas_independently() {
        // Subagent/build/plan sessions key by their own session.id — the
        // baseline map is per-session, so interleaved sessions never
        // cross-derive (SubagentNode carries no tokens — unchanged).
        let adapter = GenericOtlpAdapter::new();

        // Parent session turn 1: cumulative 1,000 → delta 1,000.
        let p1 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("parent", "p1", 1_000, 10, 25_000)),
        );
        assert_eq!(
            p1[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(1_000)
        );

        // Child session FIRST turn starts its OWN baseline: cumulative 200 →
        // delta 200 (NOT 200 − 1,000 from the parent's baseline).
        let s1 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("child", "s1", 200, 5, 0)),
        );
        assert_eq!(
            s1[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(200),
            "subagent first turn: delta = its own full input, independent of the parent"
        );

        // Parent turn 2 still derives from the PARENT baseline.
        let p2 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("parent", "p2", 1_050, 12, 25_000)),
        );
        assert_eq!(
            p2[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(50),
            "parent turn 2: delta = 1,050 − 1,000"
        );

        // Child turn 2 derives from the CHILD baseline.
        let s2 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("child", "s2", 250, 6, 0)),
        );
        assert_eq!(
            s2[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(50),
            "subagent turn 2: delta = 250 − 200"
        );
    }

    #[test]
    fn last_request_input_map_capped_at_map_capacity() {
        // REGRESSION INVARIANT: the last_request_input baseline map is
        // MAP_CAPACITY-bounded with oldest-first eviction, like every other
        // adapter state map.
        let adapter = GenericOtlpAdapter::new();
        for i in 0..MAP_CAPACITY {
            adapter
                .last_request_input
                .lock()
                .unwrap()
                .insert(format!("sess-{}", i), i as i64);
        }
        assert_eq!(adapter.last_request_input.lock().unwrap().len(), MAP_CAPACITY);

        // A new session's derivation must evict an old entry.
        let inputs = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("overflow", "span-1", 500, 10, 0)),
        );
        assert_eq!(
            inputs[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(500)
        );
        let map = adapter.last_request_input.lock().unwrap();
        assert!(map.len() <= MAP_CAPACITY, "baseline map stays bounded");
        assert!(map.contains_key("overflow"), "new session baseline recorded");
    }

    #[test]
    fn last_request_cache_read_map_capped_at_map_capacity() {
        // REGRESSION INVARIANT (Spec #2723 ST-3 H1): the last_request_cache_read
        // baseline map is MAP_CAPACITY-bounded with oldest-first eviction, like
        // every other adapter state map.
        let adapter = GenericOtlpAdapter::new();
        for i in 0..MAP_CAPACITY {
            adapter
                .last_request_cache_read
                .lock()
                .unwrap()
                .insert(format!("sess-{}", i), i as i64);
        }
        assert_eq!(adapter.last_request_cache_read.lock().unwrap().len(), MAP_CAPACITY);

        // A new session's cache derivation must evict an old entry.
        let inputs = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("cache-overflow", "span-1", 500, 10, 1_000)),
        );
        assert_eq!(
            inputs[1].payload.as_ref().unwrap().get("cacheReadTokens").and_then(|v| v.as_i64()),
            Some(1_000)
        );
        let map = adapter.last_request_cache_read.lock().unwrap();
        assert!(map.len() <= MAP_CAPACITY, "cache baseline map stays bounded");
        assert!(map.contains_key("cache-overflow"), "new session cache baseline recorded");
    }

    #[test]
    fn delta_flows_through_ece_as_subscription_delivery() {
        // Full-chain verification (Bug #586 lesson): adapter delta → ECE →
        // SubscriptionDelivery. The end delivery's inner payload must carry the
        // per-message delta, and the synthetic init delivery the SAME delta.
        let engine = crate::infrastructure::comm::contract::ContractEngine::new();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["otlp_grpc".to_string()]),
            event_types: Some(vec!["chat".to_string()]),
            persistent: false,
            exclude_payload: None,
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(completed_chat_span_with_usage("ece-delta-session", "span-1", 2_731, 180, 25_344));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits");

        let mut deliveries = Vec::new();
        for input in inputs {
            deliveries.extend(engine.req_2_3_process(input));
        }
        assert_eq!(deliveries.len(), 2);
        assert_eq!(deliveries[0].lifecycle, "init");
        assert_eq!(deliveries[1].lifecycle, "end");

        for (idx, d) in deliveries.iter().enumerate() {
            let payload = d.payload.get("payload").unwrap();
            assert_eq!(
                payload.get("promptTokens").and_then(|v| v.as_i64()),
                Some(2_731),
                "delivery {}: promptTokens = first-turn delta (prev absent → 0)",
                idx
            );
            assert_eq!(
                payload.get("completionTokens").and_then(|v| v.as_i64()),
                Some(180),
                "delivery {}: completionTokens = output",
                idx
            );
            assert_eq!(
                payload.get("sessionContextTokens").and_then(|v| v.as_i64()),
                Some(2_731 + 25_344),
                "delivery {}: sessionContextTokens = input + cache",
                idx
            );
        }
    }

    // ── Flat / custom JSON path ───────────────────────────────────────────────

    #[test]
    fn flat_json_path_classifies_and_correlates() {
        let adapter = GenericOtlpAdapter::new();
        let raw = serde_json::json!({
            "name": "chat",
            "traceId": "flat-trace",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "flat-session" } }
            ]
        });
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].event_type, EventType::Chat);
        assert_eq!(inputs[0].correlation_id.as_deref(), Some("flat-session_1"));
    }

    // ── Transport name preservation (NFR-4) ───────────────────────────────────

    #[test]
    fn transport_names_preserved_for_both_otlp_transports() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "chat",
            "traceId": "trace-tr",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-tr" } }
            ]
        }));
        let grpc = transform(&adapter, Transport::OtlpGrpc, raw.clone());
        assert_eq!(grpc[0].transport, Transport::OtlpGrpc);
        assert_eq!(grpc[0].transport.as_str(), "otlp_grpc");

        let http = transform(&adapter, Transport::OtlpHttp, raw);
        assert_eq!(http[0].transport, Transport::OtlpHttp);
        assert_eq!(http[0].transport.as_str(), "otlp_http");
    }

    // ── Subagent / relationship metadata (Spec #523, R8) ──────────────────────

    #[test]
    fn subagent_span_with_parent_attr_emits_relationship_metadata() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-sub",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "session.id", "value": { "stringValue": "child-subagent" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-main" } },
                { "key": "is_subagent", "value": { "boolValue": true } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1);
        let metadata = inputs[0].metadata.as_ref().expect("subagent must carry metadata");
        let rel = metadata.get("relationship").expect("relationship key");
        assert_eq!(rel.get("type").and_then(|v| v.as_str()), Some("parent-child"));
        assert_eq!(rel.get("parentSessionId").and_then(|v| v.as_str()), Some("parent-main"));
        assert_eq!(rel.get("childSessionId").and_then(|v| v.as_str()), Some("child-subagent"));
    }

    #[test]
    fn span_link_resolves_parent_and_injects_instruction() {
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-link",
            "endTimeUnixNano": "1000000",
            "links": [{
                "traceId": "trace-parent",
                "spanId": "parent-span",
                "attributes": [
                    {"key": "parent.session_id", "value": {"stringValue": "parent-session"}},
                    {"key": "relationship.type", "value": {"stringValue": "parent-child"}}
                ]
            }],
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "session.id", "value": { "stringValue": "child-session" } },
                { "key": "gen_ai.input.messages", "value": { "stringValue": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Subagent instruction from plugin\"}]}]" } },
                { "key": "agent.type", "value": { "stringValue": "subagent" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert!(!inputs.is_empty());

        let child = inputs.iter().find(|i| i.session_id == "child-session").expect("child input");
        let metadata = child.metadata.as_ref().expect("relationship metadata");
        let rel = metadata.get("relationship").unwrap();
        assert_eq!(rel.get("parentSessionId").and_then(|v| v.as_str()), Some("parent-session"));

        // session_to_parent populated from the span link.
        let map = adapter.session_to_parent.lock().unwrap();
        assert_eq!(map.get("child-session").map(|s| s.as_str()), Some("parent-session"));

        // Instruction injected from gen_ai.input.messages on the subagent span itself.
        let payload = child.payload.as_ref().unwrap();
        assert_eq!(
            payload.get("instruction").and_then(|v| v.as_str()),
            Some("Subagent instruction from plugin")
        );
    }

    #[test]
    fn task_instruction_from_tool_call_arguments_injected_into_subagent() {
        let adapter = GenericOtlpAdapter::new();

        // 1. Parent dispatches a task tool with gen_ai.tool.call.arguments JSON.
        let task_span = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(serde_json::json!({
                "name": "fredo.tool.task",
                "traceId": "trace-task",
                "attributes": [
                    { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                    { "key": "gen_ai.tool.name", "value": { "stringValue": "task" } },
                    { "key": "gen_ai.conversation.id", "value": { "stringValue": "parent-session" } },
                    { "key": "gen_ai.tool.call.arguments", "value": { "stringValue": "{\"task\":\"Write the README\"}" } }
                ]
            })),
        );
        assert_eq!(task_span.len(), 1);
        assert_eq!(task_span[0].event_type, EventType::ToolUse);

        // 2. Subagent session span for the child → instruction from the cache.
        let sub_raw = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-child",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "session.id", "value": { "stringValue": "child-session" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-session" } },
                { "key": "is_subagent", "value": { "boolValue": true } }
            ]
        }));
        let sub_inputs = transform(&adapter, Transport::OtlpGrpc, sub_raw);
        assert_eq!(sub_inputs.len(), 1);
        let payload = sub_inputs[0].payload.as_ref().unwrap();
        assert_eq!(
            payload.get("instruction").and_then(|v| v.as_str()),
            Some("Write the README"),
            "task instruction extracted from gen_ai.tool.call.arguments must be injected"
        );
    }

    #[test]
    fn parent_prompt_cache_reads_parsed_input_messages_for_subagent_instruction() {
        let adapter = GenericOtlpAdapter::new();

        // 1. Parent chat span carries gen_ai.input.messages (JSON-string array)
        // → parsed text cached in parent_prompts for the parent session.
        let parent_raw = otlp_payload(serde_json::json!({
            "name": "chat",
            "traceId": "trace-parent",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "parent-session" } },
                { "key": "gen_ai.input.messages", "value": { "stringValue": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Parent prompt text\"}]}]" } }
            ]
        }));
        let parent_inputs = transform(&adapter, Transport::OtlpGrpc, parent_raw);
        assert_eq!(parent_inputs.len(), 1, "parent chat span emits one Init");

        let cache = adapter.parent_prompts.lock().unwrap();
        assert_eq!(
            cache.get("parent-session").map(|s| s.as_str()),
            Some("Parent prompt text"),
            "parsed gen_ai.input.messages text must be cached for the parent session"
        );
        drop(cache);

        // 2. Subagent session span for the child → instruction from the cache.
        let sub_raw = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-child",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "session.id", "value": { "stringValue": "child-session" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-session" } },
                { "key": "is_subagent", "value": { "boolValue": true } }
            ]
        }));
        let sub_inputs = transform(&adapter, Transport::OtlpGrpc, sub_raw);
        assert_eq!(sub_inputs.len(), 1);
        let payload = sub_inputs[0].payload.as_ref().unwrap();
        assert_eq!(
            payload.get("instruction").and_then(|v| v.as_str()),
            Some("Parent prompt text"),
            "parent prompt from parsed gen_ai.input.messages must be injected as instruction"
        );
    }

    // ── Spec #2723 (R-5 / AC5, round 2): session-level subagent payload ──────
    // The round-1 failure: `fredo.llm` spans of a subagent session carry
    // `session.parent_id` but NOT `is_subagent` / `agent.type` — so the ECE
    // `excludePayload` filter (which evaluates on the event payload) never
    // matched and child-session chat nodes rendered. The adapter now propagates
    // the session-level marker into EVERY span-derived event payload.

    #[test]
    fn llm_span_of_subagent_session_carries_injected_subagent_payload() {
        let adapter = GenericOtlpAdapter::new();
        // A completed chat (LLM) span of a subagent session: carries
        // session.parent_id ONLY — deliberately NO is_subagent/agent.type attrs
        // (the round-1 telemetry shape, ses_0077bd6c… fredo.llm spans).
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-child-llm",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "child-session" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-main" } },
                { "key": "gen_ai.input.messages", "value": { "stringValue": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Hello\"}]}]" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
        for input in &inputs {
            let payload = input.payload.as_ref().expect("payload");
            assert_eq!(
                payload.get("is_subagent").and_then(|v| v.as_bool()),
                Some(true),
                "LLM payload of a subagent session must carry is_subagent: true"
            );
            assert_eq!(
                payload.get("agent.type").and_then(|v| v.as_str()),
                Some("subagent"),
                "LLM payload of a subagent session must carry agent.type: subagent"
            );
        }
    }

    #[test]
    fn parent_session_chat_payload_has_no_subagent_marker() {
        // Control: the PARENT session's own chat span must NOT be flagged —
        // only child-session events are excluded by the MM contract rules.
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-parent-llm",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "parent-main" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2);
        for input in &inputs {
            let payload = input.payload.as_ref().expect("payload");
            assert!(
                payload.get("is_subagent").is_none(),
                "parent session chat payload must not carry is_subagent"
            );
            assert!(
                payload.get("agent.type").is_none(),
                "parent session chat payload must not carry agent.type"
            );
        }
    }

    #[test]
    fn session_level_marker_persists_across_spans_via_session_to_parent() {
        // A subagent session's relationship may be registered by an EARLIER
        // span (span link / session.parent_id) and a LATER chat span may omit
        // the attribute — the persisted session_to_parent registry must still
        // flag the chat span as subagent.
        let adapter = GenericOtlpAdapter::new();

        // 1. Session span registers child-session → parent-main.
        let session_span = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-child-sess",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "session.id", "value": { "stringValue": "child-session" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-main" } }
            ]
        }));
        let session_inputs = transform(&adapter, Transport::OtlpGrpc, session_span);
        assert_eq!(session_inputs.len(), 1);

        // 2. A later chat span for the SAME child session WITHOUT the parent
        // attribute → session_to_parent registry still resolves it.
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-child-llm2",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "child-session" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2);
        for input in &inputs {
            let payload = input.payload.as_ref().expect("payload");
            assert_eq!(
                payload.get("is_subagent").and_then(|v| v.as_bool()),
                Some(true),
                "chat payload must carry is_subagent via persisted session_to_parent"
            );
            assert_eq!(
                payload.get("agent.type").and_then(|v| v.as_str()),
                Some("subagent"),
                "chat payload must carry agent.type via persisted session_to_parent"
            );
            // Spec #2762 (D4a): the parent identity rides every child payload
            // identically (both the synthetic Init and the Response) so the
            // Mission Monitor scoped orphan count can attribute the delivery.
            assert_eq!(
                payload.get("parentSessionId").and_then(|v| v.as_str()),
                Some("parent-main"),
                "chat payload must carry parentSessionId via persisted session_to_parent"
            );
        }
    }

    // ── Spec #2768 ST-1: typed `parent_session_id` routing property ──────────

    #[test]
    fn parent_session_id_typed_field_set_from_span_attr_on_every_span_kind() {
        // The typed routing property is stamped on EVERY EngineInput of a
        // child session — session, chat, and tool-use spans alike — so
        // attribution never depends on catching a parent-side event.
        let adapter = GenericOtlpAdapter::new();

        // Session span (run_agent) of a child session.
        let session_raw = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-st1-sess",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "session.id", "value": { "stringValue": "child-st1" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-st1" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, session_raw);
        assert_eq!(inputs.len(), 1);
        assert_eq!(
            inputs[0].parent_session_id.as_deref(),
            Some("parent-st1"),
            "session span must carry the typed parent_session_id"
        );

        // Completed chat span → dual-emits synthetic Init + Response; BOTH
        // carry the typed property identically.
        let chat_raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-st1-chat",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "child-st1" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-st1" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, chat_raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
        for input in &inputs {
            assert_eq!(
                input.parent_session_id.as_deref(),
                Some("parent-st1"),
                "both the synthetic Init and the Response must carry the typed property"
            );
        }

        // Tool-use span of the same child session.
        let tool_raw = otlp_payload(serde_json::json!({
            "name": "tool.bash",
            "traceId": "trace-st1-tool",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                { "key": "gen_ai.tool.name", "value": { "stringValue": "bash" } },
                { "key": "session.id", "value": { "stringValue": "child-st1" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-st1" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, tool_raw);
        assert_eq!(inputs.len(), 2);
        for input in &inputs {
            assert_eq!(
                input.parent_session_id.as_deref(),
                Some("parent-st1"),
                "tool-use span must carry the typed parent_session_id"
            );
        }
    }

    #[test]
    fn parent_session_id_typed_field_absent_attr_is_none() {
        // A span with NO session.parent_id attr (primary session — or a legacy
        // span under the FREDO_SUPPRESS_PARENT_ROUTING seam) maps to None, so
        // the ECE self-carried registration path no-ops naturally.
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-st1-none",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "primary-st1" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2);
        for input in &inputs {
            assert!(
                input.parent_session_id.is_none(),
                "no session.parent_id attr → typed field must be None"
            );
        }

        // Control: the parent session's own span must never self-attribute —
        // a session.parent_id equal to the session's own id is filtered.
        let self_parent_raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-st1-self",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "sess-self" } },
                { "key": "session.parent_id", "value": { "stringValue": "sess-self" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, self_parent_raw);
        assert_eq!(inputs.len(), 2);
        for input in &inputs {
            assert!(
                input.parent_session_id.is_none(),
                "self-referencing session.parent_id must not produce a typed parent"
            );
        }
    }

    #[test]
    fn parent_session_id_typed_field_persists_via_session_to_parent_for_later_spans() {
        // A later span of the same child session that OMITS the attribute is
        // still stamped from the persisted session_to_parent registry — every
        // event of a child session self-carries the parent.
        let adapter = GenericOtlpAdapter::new();

        // 1. Session span registers child → parent.
        let session_raw = otlp_payload(serde_json::json!({
            "name": "run_agent",
            "traceId": "trace-st1-persist",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "session.id", "value": { "stringValue": "child-persist" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-persist" } }
            ]
        }));
        assert_eq!(transform(&adapter, Transport::OtlpGrpc, session_raw).len(), 1);

        // 2. Later chat span WITHOUT the attr → registry resolves the parent.
        let chat_raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-st1-persist-chat",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "child-persist" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, chat_raw);
        assert_eq!(inputs.len(), 2);
        for input in &inputs {
            assert_eq!(
                input.parent_session_id.as_deref(),
                Some("parent-persist"),
                "typed property must persist across spans via session_to_parent"
            );
        }
    }

    #[test]
    fn parent_session_id_payload_projection_unchanged_for_subagent_sessions() {
        // Regression guard: the payload-level `parentSessionId` projection that
        // Mission Monitor reads (useMissionMonitor.ts:817-846) stays intact
        // alongside the new typed field.
        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-st1-projection",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "child-proj" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-proj" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2);
        for input in &inputs {
            assert_eq!(
                input.parent_session_id.as_deref(),
                Some("parent-proj"),
                "typed field present"
            );
            let payload = input.payload.as_ref().expect("payload");
            assert_eq!(
                payload.get("parentSessionId").and_then(|v| v.as_str()),
                Some("parent-proj"),
                "payload-level parentSessionId projection must remain for consumers"
            );
        }
    }

    #[test]
    fn parent_session_id_serializes_camel_case_skip_if_none() {
        // serde contract: camelCase `parentSessionId` when present; the key is
        // ABSENT (skip-if-none) when None — existing serialized events stay
        // byte-compatible.
        let with_parent = crate::infrastructure::comm::event::FredoEvent::builder()
            .event_type(EventType::Chat)
            .state(EventState::Init)
            .provider(EventProvider::OpenCode)
            .transport(Transport::OtlpGrpc)
            .session_id("child-ser")
            .parent_session_id("parent-ser")
            .build();
        let json = serde_json::to_value(&with_parent).expect("serialize");
        assert_eq!(
            json.get("parentSessionId").and_then(|v| v.as_str()),
            Some("parent-ser"),
            "field serializes as camelCase parentSessionId"
        );

        let without_parent = crate::infrastructure::comm::event::FredoEvent::builder()
            .event_type(EventType::Chat)
            .state(EventState::Init)
            .provider(EventProvider::OpenCode)
            .transport(Transport::OtlpGrpc)
            .session_id("solo-ser")
            .build();
        let json = serde_json::to_value(&without_parent).expect("serialize");
        assert!(
            json.get("parentSessionId").is_none(),
            "None must be skipped (byte-compatible with pre-#2768 events)"
        );
    }

    #[test]
    fn subagent_chat_events_dropped_by_mm_exclude_payload_contract() {
        // End-to-end static leg: adapter emits the injected marker on child
        // chat payloads → the Mission Monitor chat-node contract (declared in
        // MissionMonitorFeature.tsx) with the excludePayload rules drops the
        // events pre-buffer → ZERO deliveries (AC5 / Q-5.2).
        let engine = crate::infrastructure::comm::contract::ContractEngine::new();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["otlp_grpc".to_string()]),
            event_types: Some(vec!["chat".to_string()]),
            persistent: false,
            exclude_payload: Some(vec![
                ExcludePayloadRule {
                    path: "is_subagent".to_string(),
                    equals: serde_json::json!(true),
                },
                ExcludePayloadRule {
                    path: "agent.type".to_string(),
                    equals: serde_json::json!("subagent"),
                },
            ]),
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-child-ece",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "child-session" } },
                { "key": "session.parent_id", "value": { "stringValue": "parent-main" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2);

        let mut deliveries = Vec::new();
        for input in inputs {
            deliveries.extend(engine.req_2_3_process(input));
        }
        assert!(
            deliveries.is_empty(),
            "subagent chat events must be dropped pre-buffer by excludePayload (Q-5.2)"
        );
    }

    #[test]
    fn parent_chat_events_still_delivered_by_mm_contract() {
        // Control for the ECE leg: a parent-session chat span (no marker)
        // still flows through the same contract → parent activity renders.
        let engine = crate::infrastructure::comm::contract::ContractEngine::new();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["otlp_grpc".to_string()]),
            event_types: Some(vec!["chat".to_string()]),
            persistent: false,
            exclude_payload: Some(vec![
                ExcludePayloadRule {
                    path: "is_subagent".to_string(),
                    equals: serde_json::json!(true),
                },
                ExcludePayloadRule {
                    path: "agent.type".to_string(),
                    equals: serde_json::json!("subagent"),
                },
            ]),
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-parent-ece",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "session.id", "value": { "stringValue": "parent-main" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2);

        let mut deliveries = Vec::new();
        for input in inputs {
            deliveries.extend(engine.req_2_3_process(input));
        }
        assert_eq!(
            deliveries.len(),
            2,
            "parent-session chat events must still deliver (init + end)"
        );
    }

    // ── AC3 static leg: EngineInput → ECE → SubscriptionDelivery ──────────────

    #[test]
    fn otlp_projection_flows_through_ece_as_subscription_delivery() {
        let engine = crate::infrastructure::comm::contract::ContractEngine::new();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["otlp_grpc".to_string()]),
            event_types: Some(vec!["chat".to_string()]),
            persistent: false,
            exclude_payload: None,
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-ece",
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "ece-session" } },
                { "key": "gen_ai.input.messages", "value": { "stringValue": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Hello\"}]}]" } },
                { "key": "gen_ai.output.messages", "value": { "stringValue": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"Hi there\"}]}]" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits");

        let mut deliveries = Vec::new();
        for input in inputs {
            deliveries.extend(engine.req_2_3_process(input));
        }

        // Synthetic Init → init delivery, Response → end delivery.
        assert_eq!(deliveries.len(), 2);
        assert_eq!(deliveries[0].lifecycle, "init");
        assert_eq!(deliveries[1].lifecycle, "end");

        // The inner payload (delivery.payload["payload"]) carries the canonical
        // fields — the frontend contract shape is unchanged (R13).
        let end_payload = deliveries[1].payload.get("payload").unwrap();
        assert_eq!(
            end_payload.get("userMessage").and_then(|v| v.as_str()),
            Some("Hello")
        );
        assert_eq!(
            end_payload.get("agentReply").and_then(|v| v.as_str()),
            Some("Hi there")
        );
    }

    // ── #2688 AC1/AC5: chat-only contract kills phantom + duplicate nodes ─────

    #[test]
    fn agent_session_init_produces_no_chat_node_delivery() {
        // The Mission Monitor chat-node contract is eventTypes ['chat'] +
        // transports ['otlp_grpc'] (#2688). A session span (run_agent) maps to
        // EventType::AgentSession with EventState::Init (REQ-609) — it can never
        // satisfy completeWhen "state === 'Response'" and must produce NO
        // chat-node delivery, otherwise a phantom (never-completing) buffer
        // would be created and its timeout sweep would emit an empty node.
        let engine = crate::infrastructure::comm::contract::ContractEngine::new();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["otlp_grpc".to_string()]),
            event_types: Some(vec!["chat".to_string()]),
            persistent: false,
            exclude_payload: None,
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let adapter = GenericOtlpAdapter::new();
        let raw = otlp_payload(serde_json::json!({
            "name": "fredo.session",
            "traceId": "trace-agent-session",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "run_agent" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-nochat" } }
            ]
        }));
        let inputs = transform(&adapter, Transport::OtlpGrpc, raw);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].event_type, EventType::AgentSession);
        assert_eq!(inputs[0].state, EventState::Init);

        let deliveries = engine.req_2_3_process(inputs[0].clone());
        assert!(
            deliveries.is_empty(),
            "agent_session Init must be filtered by eventTypes ['chat'] — no chat-node delivery"
        );

        // The engine keeps no buffer for the filtered event, so the timeout sweep
        // can never emit a phantom end delivery for this key.
        assert_eq!(
            engine.req_2_3_process(inputs[0].clone()).len(),
            0,
            "re-processing the session event still yields no deliveries"
        );
    }

    // ── #2688 ST9: per-turn correlationId for completed chat spans ────────────

    /// Build a completed (endTimeUnixNano set) chat span for `session`, with a
    /// distinct spanId, plus the standard gen_ai conversation attributes.
    fn completed_chat_span_json(session: &str, span_id: &str, trace_id: &str) -> Value {
        serde_json::json!({
            "name": "llm",
            "traceId": trace_id,
            "spanId": span_id,
            "endTimeUnixNano": "1000000",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": session } },
                { "key": "gen_ai.input.messages", "value": { "stringValue": format!("[{{\"role\":\"user\",\"parts\":[{{\"type\":\"text\",\"content\":\"Prompt {}\"}}]}}]", span_id) } },
                { "key": "gen_ai.output.messages", "value": { "stringValue": format!("[{{\"role\":\"assistant\",\"parts\":[{{\"type\":\"text\",\"content\":\"Reply {}\"}}]}}]", span_id) } }
            ]
        })
    }

    #[test]
    fn completed_chat_spans_get_distinct_per_turn_correlation_ids() {
        // ST9 (#2688): N consecutive COMPLETED chat spans for one session
        // (distinct spanIds, endTimeUnixNano set, no prior Init-state span —
        // the Run CLI export order) must produce N distinct per-turn
        // correlationIds (`<session>_<n>`), each span dual-emitting a
        // synthetic Init + Response that SHARE one id.
        let adapter = GenericOtlpAdapter::new();
        let session = "runcli-session";
        let mut ids: Vec<String> = Vec::new();

        for i in 1..=5 {
            let inputs = transform(
                &adapter,
                Transport::OtlpGrpc,
                otlp_payload(completed_chat_span_json(
                    session,
                    &format!("span-{}", i),
                    &format!("trace-{}", i),
                )),
            );
            assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");
            assert_eq!(inputs[0].state, EventState::Init);
            assert_eq!(inputs[1].state, EventState::Response);
            // The synthetic Init and the Response share ONE per-turn id.
            assert_eq!(
                inputs[0].correlation_id, inputs[1].correlation_id,
                "span {}: synthetic Init and Response must share one correlationId",
                i
            );
            ids.push(inputs[0].correlation_id.clone().expect("chat span must carry a correlationId"));
        }

        // N distinct per-turn ids of the form <session>_<n>.
        let unique: std::collections::HashSet<String> = ids.iter().cloned().collect();
        assert_eq!(unique.len(), 5, "5 completed spans → 5 distinct per-turn ids");
        for (idx, id) in ids.iter().enumerate() {
            assert_eq!(
                id.as_str(),
                format!("{}_{}", session, idx + 1),
                "per-turn id must advance the counter per completed span"
            );
        }
    }

    #[test]
    fn completed_chat_spans_flow_through_ece_as_n_init_n_end() {
        // ST9 (#2688): the N per-turn correlationId pairs flow through the ECE
        // as N init + N end deliveries under the chat-node contract (eventTypes
        // ['chat'] + transports ['otlp_grpc']) — one buffer per prompt, so the
        // frontend renders N chat nodes (AC 1).
        let engine = crate::infrastructure::comm::contract::ContractEngine::new();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["otlp_grpc".to_string()]),
            event_types: Some(vec!["chat".to_string()]),
            persistent: false,
            exclude_payload: None,
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let adapter = GenericOtlpAdapter::new();
        let session = "ece-session";
        let mut deliveries = Vec::new();

        for i in 1..=5 {
            let inputs = transform(
                &adapter,
                Transport::OtlpGrpc,
                otlp_payload(completed_chat_span_json(
                    session,
                    &format!("span-{}", i),
                    &format!("trace-{}", i),
                )),
            );
            for input in inputs {
                deliveries.extend(engine.req_2_3_process(input));
            }
        }

        // 5 prompts → 5 init + 5 end deliveries (one buffer per correlationId).
        let init_count = deliveries.iter().filter(|d| d.lifecycle == "init").count();
        let end_count = deliveries.iter().filter(|d| d.lifecycle == "end").count();
        assert_eq!(init_count, 5, "one init delivery per completed chat span");
        assert_eq!(end_count, 5, "one end delivery per completed chat span");

        // Each delivery key is unique per turn (sessionId + correlationId).
        let unique_keys: std::collections::HashSet<Vec<(String, String)>> = deliveries
            .iter()
            .map(|d| {
                let mut pairs: Vec<(String, String)> =
                    d.key.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                pairs.sort();
                pairs
            })
            .collect();
        assert_eq!(unique_keys.len(), 5, "5 distinct ECE buffers — one per prompt");
    }

    #[test]
    fn completed_span_reexport_reuses_streaming_init_correlation_id() {
        // ST9 (#2688) reuse guard: a completed chat span whose spanId already
        // emitted an Init in an earlier export (the streaming open-then-complete
        // dual-export path) must REUSE that Init's correlationId — the per-turn
        // counter never double-advances, so one turn stays one ECE buffer (no
        // phantom node, AC5).
        let adapter = GenericOtlpAdapter::new();
        let session = "stream-session";

        // 1. Streaming open export: incomplete chat span (no endTimeUnixNano) →
        //    a single Init, counter → _1.
        let open_raw = otlp_payload(serde_json::json!({
            "name": "llm",
            "traceId": "trace-open",
            "spanId": "span-stream-1",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": session } }
            ]
        }));
        let open_inputs = transform(&adapter, Transport::OtlpGrpc, open_raw);
        assert_eq!(open_inputs.len(), 1, "incomplete span emits a single Init");
        assert_eq!(open_inputs[0].state, EventState::Init);
        assert_eq!(
            open_inputs[0].correlation_id.as_deref(),
            Some(format!("{}_1", session).as_str()),
            "streaming Init advances the counter to _1"
        );

        // 2. Completed re-export of the SAME spanId → the synthetic Init +
        //    Response MUST reuse _1, not advance to _2.
        let complete_raw = otlp_payload(completed_chat_span_json(session, "span-stream-1", "trace-open"));
        let complete_inputs = transform(&adapter, Transport::OtlpGrpc, complete_raw);
        assert_eq!(complete_inputs.len(), 2, "completed span dual-emits Init + Response");
        assert_eq!(
            complete_inputs[0].correlation_id.as_deref(),
            Some(format!("{}_1", session).as_str()),
            "re-exported span must reuse the streaming Init's id — no counter double-advance"
        );
        assert_eq!(
            complete_inputs[1].correlation_id.as_deref(),
            Some(format!("{}_1", session).as_str()),
            "Response shares the same reused id"
        );

        // 3. A NEW span (different spanId) advances the counter to _2.
        let next_raw = otlp_payload(completed_chat_span_json(session, "span-stream-2", "trace-2"));
        let next_inputs = transform(&adapter, Transport::OtlpGrpc, next_raw);
        assert_eq!(
            next_inputs[0].correlation_id.as_deref(),
            Some(format!("{}_2", session).as_str()),
            "next distinct span advances the counter to _2"
        );
    }
}
