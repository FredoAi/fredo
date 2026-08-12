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
const ATTR_OPERATION_NAME: &str = "gen_ai.operation.name";
const ATTR_INPUT_MESSAGES: &str = "gen_ai.input.messages";
const ATTR_OUTPUT_MESSAGES: &str = "gen_ai.output.messages";
const ATTR_REQUEST_BODY: &str = "gen_ai.request.body";
const ATTR_USAGE_INPUT_TOKENS: &str = "gen_ai.usage.input_tokens";
const ATTR_USAGE_OUTPUT_TOKENS: &str = "gen_ai.usage.output_tokens";
const ATTR_USAGE_REASONING_OUTPUT_TOKENS: &str = "gen_ai.usage.reasoning.output_tokens";
const ATTR_USAGE_CACHE_READ_INPUT_TOKENS: &str = "gen_ai.usage.cache_read.input_tokens";
const ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS: &str = "gen_ai.usage.cache_creation.input_tokens";
const ATTR_RESPONSE_MODEL: &str = "gen_ai.response.model";
const ATTR_CONVERSATION_ID: &str = "gen_ai.conversation.id";
const ATTR_TOOL_NAME: &str = "gen_ai.tool.name";
const ATTR_TOOL_CALL_ARGUMENTS: &str = "gen_ai.tool.call.arguments";
const ATTR_TOOL_CALL_RESULT: &str = "gen_ai.tool.call.result";
const ATTR_AGENT_NAME: &str = "gen_ai.agent.name";

// ── Flat Claude-Code convention fallback keys (secondary only) ────────────────
const CC_ATTR_SESSION_ID: &str = "session.id";
const CC_ATTR_INPUT_TOKENS: &str = "input_tokens";
const CC_ATTR_OUTPUT_TOKENS: &str = "output_tokens";
const CC_ATTR_MODEL: &str = "model";
const CC_ATTR_SPAN_TYPE: &str = "span.type";
const CC_ATTR_SESSION_PARENT_ID: &str = "session.parent_id";
const CC_ATTR_TOOL_INPUT: &str = "tool_input";
const CC_ATTR_PROMPT_FLAT: &str = "prompt";
const CC_ATTR_RESPONSE_TEXT: &str = "response_text";

// ── gen_ai.operation.name registry values (genai-conventions.ts:15-21) ─────────────
const OP_NAME_SESSION: &str = "run_agent";
const OP_NAME_CHAT: &str = "chat";
const OP_NAME_TOOL: &str = "execute_tool";

// Legacy op-name values accepted for backward compatibility (NOT fredo.* patterns).
const OP_LEGACY_INVOKE_AGENT: &str = "invoke_agent";
const OP_LEGACY_PERMISSION: &str = "permission";
const OP_LEGACY_ELICITATION: &str = "elicitation";

// ── Canonical op names produced by `resolve_op_name` ──────────────────────────
const OP_SESSION: &str = "session";
const OP_CHAT_CANON: &str = "chat";
const OP_TOOL_PREFIX: &str = "tool.";

/// Bounded-map capacity shared by every correlation/relationship cache.
const MAP_CAPACITY: usize = 10_000;

/// Emission style of `gen_ai.usage.input_tokens` for a session (Spec #2711
/// round 2).
///
/// Providers are not uniform: most (opencode with Claude/DeepSeek) emit the
/// session's CUMULATIVE non-cached request context (grows per turn), while
/// others (e.g. nemotron via opencode) emit the PER-MESSAGE input (a drop from
/// 27,693 to 2,394 is a legitimate smaller message, NOT compaction). The style
/// is latched at turn 2 from the D1/D2 cache discriminators and is NEVER
/// un-latched — a session's reporter does not change style mid-stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenEmissionStyle {
    /// `input_tokens` is the session's cumulative request context — the
    /// per-message prompt is the per-turn delta from the previous baseline
    /// (clamped ≥ 0 at compaction).
    Cumulative,
    /// `input_tokens` is the per-message input — the per-message prompt is the
    /// direct value, NEVER clamped (a drop is a real smaller message).
    PerMessage,
}

/// Per-message token derivation result for a completed chat span (Spec #2711).
///
/// `prompt` is the per-message prompt consumption: for Cumulative-style
/// sessions the per-turn delta of `gen_ai.usage.input_tokens` (clamped ≥ 0 at
/// compaction); for PerMessage-style sessions the direct `input_n` (never
/// clamped). `session_context_tokens` is the cumulative session context at
/// turn n (`input_n + cache_read_n + cache_creation_n`) — a reconciliation aid
/// for AC3 (C(n) = session_context_tokens + output(n) + reasoning(n)).
struct TurnTokenDerivation {
    /// Per-message prompt consumption (style-dependent, see struct docs).
    prompt: i64,
    /// Per-message completion output tokens (`gen_ai.usage.output_tokens`).
    completion: Option<i64>,
    /// Cumulative session context at turn n (`input_n + cache_n`).
    session_context_tokens: i64,
}

/// Insert `value` at `key` in a per-session map, evicting one entry when the
/// map is at `MAP_CAPACITY` and `key` is new (the same bounded-map pattern as
/// every other adapter state map — per-session state never grows unbounded).
fn insert_bounded<K, V>(map: &mut HashMap<K, V>, key: K, value: V)
where
    K: Eq + std::hash::Hash + Clone,
{
    if map.len() >= MAP_CAPACITY && !map.contains_key(&key) {
        if let Some(k) = map.keys().next().cloned() {
            map.remove(&k);
        }
    }
    map.insert(key, value);
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
    /// Key: session_id, Value: latched emission style of
    /// `gen_ai.usage.input_tokens` (Spec #2711 round 2). Absent = unknown
    /// (turn 1); latched at turn 2 from the D1/D2 cache discriminators and
    /// NEVER un-latched. Subagent/build/plan sessions key by their own
    /// session.id so styles stay independent. Same 10,000-entry cap with
    /// oldest-first eviction as the other maps.
    token_style: Arc<Mutex<HashMap<String, TokenEmissionStyle>>>,
    /// Key: session_id, Value: `cache_n` (cache_read + cache_creation) at the
    /// FIRST completed chat span (Spec #2711 round 2) — the D1/D2 style-latch
    /// discriminator baseline (cache warmed mid-session → PerMessage; cold
    /// cache with a non-monotonic input drop → PerMessage; else Cumulative).
    /// Same 10,000-entry cap with oldest-first eviction as the other maps.
    first_cache_read: Arc<Mutex<HashMap<String, i64>>>,
    /// Key: session_id, Value: cumulative `gen_ai.usage.input_tokens` at the
    /// last completed chat span (Spec #2711). For Cumulative-style sessions the
    /// per-message prompt consumption is the DELTA from this baseline; unused
    /// for PerMessage-style sessions (direct input). Subagent/build/plan
    /// sessions key by their own session.id so deltas stay independent. Same
    /// 10,000-entry cap with oldest-first eviction as the other maps.
    last_request_input: Arc<Mutex<HashMap<String, i64>>>,
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
            token_style: Arc::new(Mutex::new(HashMap::new())),
            first_cache_read: Arc::new(Mutex::new(HashMap::new())),
            last_request_input: Arc::new(Mutex::new(HashMap::new())),
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
    fn resolve_op_name(span_name: &str, attrs: &Map<String, Value>) -> Option<String> {
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
    fn is_subagent_span(attrs: &Map<String, Value>) -> bool {
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
    fn otlp_attrs_to_map(attrs_json: Option<&Value>) -> Map<String, Value> {
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
    fn extract_messages_text(json: &str, role: &str) -> Option<String> {
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
    /// `promptTokens`, `completionTokens`, `model`, `instruction`,
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
    fn otlp_attrs_to_payload(
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
        // Spec #2711 (round 2): the derived per-message prompt OVERRIDES the
        // cumulative registry value when present (a completed chat span with
        // usage). The prompt is style-derived (Cumulative: per-turn delta;
        // PerMessage: direct input); the per-message completion is the turn's
        // own output — never cumulative.
        let prompt_tokens_value = derived_tokens
            .as_ref()
            .map(|d| d.prompt)
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
        let turn_cache_read_tokens = attrs
            .get(ATTR_USAGE_CACHE_READ_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        let turn_cache_write_tokens = attrs
            .get(ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        if let Some(tokens) = turn_reasoning_tokens {
            info.insert("turnReasoningTokens".to_string(), json!(tokens));
        }
        if let Some(tokens) = turn_cache_read_tokens {
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
        // Spec #2711: cumulative session context at turn n (input_n + cache_n)
        // — additive reconciliation aid for AC3 only. The frontend reads it for
        // the DetailPanel context row and ignores it when absent; it never
        // replaces promptTokens/completionTokens (per-message values).
        if let Some(ref derived) = derived_tokens {
            payload.insert(
                "sessionContextTokens".to_string(),
                json!(derived.session_context_tokens),
            );
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

    /// Spec #2711 (round 2): derive the per-message token consumption for a
    /// completed chat span, robust to BOTH provider emission styles.
    ///
    /// `gen_ai.usage.input_tokens` means different things per provider:
    /// - **Cumulative style** (opencode with Claude/DeepSeek): the session's
    ///   cumulative non-cached request context — grows per turn (live root-cause
    ///   session: 2,731 → 2,758 → 2,790 → 2,820 → 3,229); the per-message
    ///   prompt is the DELTA from the previous turn's cumulative input.
    /// - **PerMessage style** (e.g. nemotron via opencode): the per-message
    ///   input (live round-1 session: 27,693 → 2,394 → 2,439 — a DROP is a
    ///   legitimate smaller message); the per-message prompt is the DIRECT
    ///   value, NEVER clamped.
    ///
    /// The style is latched per session at turn 2 from the D1/D2 cache
    /// discriminators:
    /// - D1 (`first_cache_read == 0 && cache_n > 0`): cache warmed mid-session
    ///   → PerMessage.
    /// - D2 (`first_cache_read == 0 && input_n < prev`): cold-cache
    ///   non-monotonic input drop → PerMessage.
    /// - otherwise (warm cache from turn 1, or monotonic cold cache) →
    ///   Cumulative.
    /// Once latched it is never un-latched. Turn 1 is style-agnostic:
    /// `prompt(1) = input(1)` under both styles (binding contract).
    ///
    /// `gen_ai.usage.cache_read/cache_creation.input_tokens` (the cached
    /// system/tool prefix, pinned at e.g. 25,344) cancels in every Cumulative
    /// delta and NEVER enters a node's prompt/completion under either style.
    ///
    /// Guard rails:
    /// - Missing usage → `None`: the caller does not inject `promptTokens` and
    ///   the frontend last-wins merge keeps the prior per-turn value (unchanged
    ///   behavior).
    /// - Cumulative clamp (compaction / out-of-order spans): negative delta →
    ///   clamped to 0 with a baseline reset (`last_request_input` always stores
    ///   `input_n`). PerMessage NEVER clamps.
    /// - Subagent/build/plan sessions key by their own session.id — styles and
    ///   baselines are independent (SubagentNode carries no tokens).
    ///
    /// Returns `Some(TurnTokenDerivation)` when the span carries usage;
    /// `None` otherwise or for non-chat / non-completed (streaming Init) spans.
    fn derive_turn_tokens(
        &self,
        session_id: &str,
        op_name: &str,
        event_state: EventState,
        attrs: &Map<String, Value>,
    ) -> Option<TurnTokenDerivation> {
        // Only completed chat spans carry per-turn usage (streaming Init spans
        // and session/tool spans do not — derivation is chat-scoped).
        if op_name != OP_CHAT_CANON || event_state != EventState::Response {
            return None;
        }
        let input_n = attrs
            .get(ATTR_USAGE_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))?
            .max(0);
        let output_n = attrs
            .get(ATTR_USAGE_OUTPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        // cache_n = cache_read + cache_creation (both are the cached
        // system/tool prefix; creation is 0 once the cache is warm).
        let cache_n = attrs
            .get(ATTR_USAGE_CACHE_READ_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
            .unwrap_or(0)
            + attrs
                .get(ATTR_USAGE_CACHE_CREATION_INPUT_TOKENS)
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
                .unwrap_or(0);

        // ── Emission-style detection (latched, never un-latched) ─────────────
        // Short-lived locks only — a Mutex guard is never held across a
        // re-lock (std Mutex is non-reentrant).
        let latched_style = { self.token_style.lock().ok()?.get(session_id).copied() };
        let stored_first_cache = { self.first_cache_read.lock().ok()?.get(session_id).copied() };

        let (style, first_cache_evidence) = match latched_style {
            Some(latched) => (Some(latched), stored_first_cache.unwrap_or(0)),
            None => match stored_first_cache {
                // TURN 1 — style-agnostic: seed the cache baseline. prompt =
                // input under both styles (binding contract: prompt(1) =
                // input(1)); the Cumulative extraction below also seeds
                // last_request_input so turn 2 derives against input(1).
                None => {
                    let mut first_cache_map = self.first_cache_read.lock().ok()?;
                    insert_bounded(&mut first_cache_map, session_id.to_string(), cache_n);
                    (None, cache_n)
                }
                // TURN 2 — latch the emission style (D1/D2 discriminators).
                Some(first_cache) => {
                    let prev = {
                        self.last_request_input.lock().ok()?.get(session_id).copied().unwrap_or(0)
                    };
                    let latched = if first_cache == 0 && cache_n > 0 {
                        // D1: cache warmed mid-session (cold at turn 1, warm at
                        // turn 2) → the reporter emits per-message inputs.
                        TokenEmissionStyle::PerMessage
                    } else if first_cache == 0 && input_n < prev {
                        // D2: cold-cache non-monotonic drop → per-message.
                        TokenEmissionStyle::PerMessage
                    } else {
                        // Warm cache from turn 1, or monotonic cold cache →
                        // cumulative reporter.
                        TokenEmissionStyle::Cumulative
                    };
                    // Bug #586 lesson: surface the latch decision at runtime —
                    // a wrong style was the round-1 root cause (round-1 clamped
                    // the nemotron per-message drop to 0).
                    tracing::warn!(
                        target: "fredo::adapter::otlp",
                        session_id = %session_id,
                        style = ?latched,
                        first_cache_read = first_cache,
                        cache_n = cache_n,
                        input_n = input_n,
                        prev = prev,
                        "OTLP token emission style latched (Spec #2711 round 2)"
                    );
                    let mut style_map = self.token_style.lock().ok()?;
                    insert_bounded(&mut style_map, session_id.to_string(), latched);
                    (Some(latched), first_cache)
                }
            },
        };

        // prev read for diagnostics (the Cumulative arm re-reads under its own
        // lock for the authoritative baseline — guards never span a re-lock).
        let prev = { self.last_request_input.lock().ok()?.get(session_id).copied().unwrap_or(0) };
        let prompt = match style {
            // PerMessage: direct input, NEVER clamped — a small value (2,394)
            // is a legitimate smaller message, not compaction.
            Some(TokenEmissionStyle::PerMessage) => input_n,
            // Cumulative (incl. turn-1 unknown → safe default): per-turn delta
            // from the baseline; a negative delta (compaction / out-of-order)
            // clamps to 0 and the baseline resets to THIS turn.
            _ => {
                let mut map = self.last_request_input.lock().ok()?;
                let prev = map.get(session_id).copied().unwrap_or(0);
                let delta = (input_n - prev).max(0);
                insert_bounded(&mut map, session_id.to_string(), input_n);
                delta
            }
        };

        // Bug #586 lesson: surface derivation evidence at runtime — session,
        // style, discriminator inputs, prev baseline, and the resulting prompt.
        tracing::debug!(
            target: "fredo::adapter::otlp",
            session_id = %session_id,
            style = ?style,
            first_cache_read = first_cache_evidence,
            cache_n = cache_n,
            input_n = input_n,
            prev = prev,
            prompt = prompt,
            completion = ?output_n,
            "OTLP per-message token derivation (Spec #2711 round 2)"
        );

        Some(TurnTokenDerivation {
            prompt,
            completion: output_n,
            session_context_tokens: input_n + cache_n,
        })
    }

    /// Determine EventState from OTLP span timing.
    ///
    /// REQ-11: Response if the span has endTimeUnixNano set, Init otherwise.
    fn req_11_event_state_from_span(span: &Value) -> EventState {
        if span.get("endTimeUnixNano").is_some() {
            EventState::Response
        } else {
            EventState::Init
        }
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
    use crate::infrastructure::comm::contract::types::ContractDeclaration;
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

        // Spec #2711 (round 2): the derived per-message prompt OVERRIDES the
        // cumulative registry input (attrs input 150 cumulative, prev baseline
        // 125 → delta 25). completion = the turn's own output (75).
        let derived = Some(TurnTokenDerivation {
            prompt: 25,
            completion: Some(75),
            session_context_tokens: 25_369, // 25 + cache_read 25,344 (root-cause trace)
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

    /// Like `completed_chat_span_with_usage` but also carries
    /// `gen_ai.usage.cache_creation.input_tokens` (Spec #2711 round 2: cache_n
    /// = cache_read + cache_creation feeds sessionContextTokens and the D1/D2
    /// latch discriminators).
    fn completed_chat_span_with_cache_creation(
        session: &str,
        span_id: &str,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_creation: i64,
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
                { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": format!("{}", cache_read) } },
                { "key": "gen_ai.usage.cache_creation.input_tokens", "value": { "intValue": format!("{}", cache_creation) } }
            ]
        })
    }

    #[test]
    fn cumulative_warm_cache_prompts_derived_as_deltas() {
        // Spec #2711 round 2 — Cumulative-style case (live root-cause session
        // ses_00bf7871dffexcyzy13MkdhiM9): cumulative gen_ai.usage.input_tokens
        // 2,731 → 2,758 → 2,790 → 2,820 → 3,229 with cache_read pinned at
        // 25,344 from turn 1. Warm cache from turn 1 → the turn-2 latch is
        // Cumulative (D1/D2 never fire) → per-message prompts are the deltas
        // 2,731 / 27 / 32 / 30 / 409 with outputs 9 / 13 / 9 / 393 / 112. The
        // cache prefix cancels in every delta — it never enters a node's prompt.
        let adapter = GenericOtlpAdapter::new();
        let session = "ses_00bf7871dffexcyzy13MkdhiM9";
        let cumulative = [2_731_i64, 2_758, 2_790, 2_820, 3_229];
        let expected_deltas = [2_731_i64, 27, 32, 30, 409];
        let outputs = [9_i64, 13, 9, 393, 112];
        let cache = 25_344_i64;

        for (i, &input) in cumulative.iter().enumerate() {
            let inputs = transform(
                &adapter,
                Transport::OtlpGrpc,
                otlp_payload(completed_chat_span_with_usage(
                    session,
                    &format!("span-{}", i),
                    input,
                    outputs[i],
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
                    "turn {}: promptTokens must be the Cumulative per-turn delta ({}), never the cumulative input ({})",
                    i + 1,
                    expected_deltas[i],
                    input
                );
                assert_eq!(
                    payload.get("completionTokens").and_then(|v| v.as_i64()),
                    Some(outputs[i]),
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
    fn per_message_cold_cache_nemotron_trace_never_clamped() {
        // Spec #2711 round 2 — PerMessage-style case (live round-1 session
        // ses_00b977109ffePPGFDFYKn0hi9P, nemotron): gen_ai.usage.input_tokens
        // 27,693 → 2,394 → 2,439 (a DROP — the provider reports per-message
        // inputs, not cumulative), cache 0 → 25,344 → 25,344. Turn 2 latches
        // PerMessage via D1 (first_cache_read == 0, cache warmed to 25,344), so
        // the per-message prompts are the DIRECT inputs 27,693 / 2,394 / 2,439
        // with outputs 14 / 19 / 13. Round 1's unconditional delta clamped
        // turn 2 to 0 and turn 3 to 45 — those values MUST be asserted as
        // wrong here (a small per-message value is legitimate, NEVER clamped).
        let adapter = GenericOtlpAdapter::new();
        let session = "ses_00b977109ffePPGFDFYKn0hi9P";
        let inputs = [27_693_i64, 2_394, 2_439];
        let outputs = [14_i64, 19, 13];
        let caches = [0_i64, 25_344, 25_344];

        for (i, &input) in inputs.iter().enumerate() {
            let inputs_out = transform(
                &adapter,
                Transport::OtlpGrpc,
                otlp_payload(completed_chat_span_with_usage(
                    session,
                    &format!("msg-{}", i + 1),
                    input,
                    outputs[i],
                    caches[i],
                )),
            );
            assert_eq!(inputs_out.len(), 2, "completed chat span dual-emits");
            let init_payload = inputs_out[0].payload.as_ref().unwrap();
            let response_payload = inputs_out[1].payload.as_ref().unwrap();
            for payload in [init_payload, response_payload] {
                assert_eq!(
                    payload.get("promptTokens").and_then(|v| v.as_i64()),
                    Some(input),
                    "turn {}: PerMessage prompt = the DIRECT input ({}), NEVER clamped — the round-1 values 0/45 are wrong",
                    i + 1,
                    input
                );
                assert_eq!(
                    payload.get("completionTokens").and_then(|v| v.as_i64()),
                    Some(outputs[i]),
                    "turn {}: completionTokens = output",
                    i + 1
                );
                assert_eq!(
                    payload.get("sessionContextTokens").and_then(|v| v.as_i64()),
                    Some(input + caches[i]),
                    "turn {}: sessionContextTokens = input + cache",
                    i + 1
                );
            }
        }

        // The latched style is PerMessage, never un-latched.
        let style_map = adapter.token_style.lock().unwrap();
        assert_eq!(
            style_map.get(session).copied(),
            Some(TokenEmissionStyle::PerMessage),
            "nemotron session must latch PerMessage at turn 2 (D1: cache warmed)"
        );
    }

    #[test]
    fn cache_warming_latches_per_message_d1() {
        // D1 latch (Spec #2711 round 2): first_cache_read == 0 (cold turn 1)
        // and cache_n > 0 at turn 2 (cache warmed mid-session) → PerMessage,
        // even when input is MONOTONIC (a naive delta would look cumulative).
        let adapter = GenericOtlpAdapter::new();
        let session = "d1-session";

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "d1-1", 200, 5, 0)),
        );
        assert_eq!(
            first[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(200),
            "turn 1 (style-agnostic): prompt = input"
        );

        // Turn 2: cache warms 0 → 25,344; input 200 → 250 (monotonic up, but
        // the cache warm is the D1 discriminator) → PerMessage.
        let second = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "d1-2", 250, 6, 25_344)),
        );
        assert_eq!(
            second[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(250),
            "D1 latch → PerMessage: prompt = the direct input 250, NOT the delta 50"
        );

        // Latch is sticky: turn 3 (cache warm, monotonic) stays PerMessage.
        let third = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "d1-3", 280, 7, 25_344)),
        );
        assert_eq!(
            third[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(280),
            "latched PerMessage is never un-latched: prompt = direct input 280"
        );
    }

    #[test]
    fn cold_cache_non_monotonic_drop_latches_per_message_d2() {
        // D2 latch (Spec #2711 round 2): cache stays cold (first_cache_read ==
        // 0, cache_n == 0) and input DROPS at turn 2 (input_n < prev) →
        // PerMessage. A drop under a cold cache is a per-message reporter, not
        // compaction.
        let adapter = GenericOtlpAdapter::new();
        let session = "d2-session";

        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "d2-1", 100, 3, 0)),
        );
        assert_eq!(
            first[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(100)
        );

        // Turn 2: input drops 100 → 50 with cache still 0 → D2 PerMessage latch.
        let second = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "d2-2", 50, 4, 0)),
        );
        assert_eq!(
            second[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(50),
            "D2 latch → PerMessage: the drop is a real smaller message — prompt 50, NEVER clamped to 0"
        );

        // Turn 3: still per-message.
        let third = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "d2-3", 60, 5, 0)),
        );
        assert_eq!(
            third[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(60),
            "latched PerMessage: prompt = direct input 60"
        );
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
    fn compaction_clamp_clamps_negative_delta_to_zero_and_resets_baseline() {
        // Compaction guard (Spec #2711 round 2 case e): the clamp applies to
        // the CUMULATIVE style ONLY. Warm cache from turn 1 (25,000) → the
        // turn-2 latch is Cumulative, so a cumulative input that DECREASES
        // (context compaction) must never emit a negative per-message delta —
        // clamp to 0 AND reset the baseline so the NEXT turn derives against
        // the clamped turn, never a stale higher baseline. (PerMessage-style
        // sessions NEVER clamp a drop — see the nemotron/D2 tests.)
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
    fn per_session_state_maps_capped_at_map_capacity() {
        // REGRESSION INVARIANT (Spec #2711 round 2, case i): the token_style,
        // first_cache_read, and last_request_input per-session state maps are
        // ALL MAP_CAPACITY-bounded with oldest-first eviction, like every other
        // adapter state map.
        let adapter = GenericOtlpAdapter::new();
        for i in 0..MAP_CAPACITY {
            let sid = format!("sess-{}", i);
            adapter.last_request_input.lock().unwrap().insert(sid.clone(), i as i64);
            adapter.first_cache_read.lock().unwrap().insert(sid.clone(), i as i64);
            adapter
                .token_style
                .lock()
                .unwrap()
                .insert(sid, TokenEmissionStyle::Cumulative);
        }
        assert_eq!(adapter.last_request_input.lock().unwrap().len(), MAP_CAPACITY);
        assert_eq!(adapter.first_cache_read.lock().unwrap().len(), MAP_CAPACITY);
        assert_eq!(adapter.token_style.lock().unwrap().len(), MAP_CAPACITY);

        // A new session's derivation must evict an old entry from every map it
        // touches (last_request_input + first_cache_read; token_style is
        // latched at turn 2, not turn 1).
        let inputs = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage("overflow", "span-1", 500, 10, 0)),
        );
        assert_eq!(
            inputs[1].payload.as_ref().unwrap().get("promptTokens").and_then(|v| v.as_i64()),
            Some(500)
        );
        assert!(adapter.last_request_input.lock().unwrap().len() <= MAP_CAPACITY);
        assert!(adapter.first_cache_read.lock().unwrap().len() <= MAP_CAPACITY);
        assert!(adapter.token_style.lock().unwrap().len() <= MAP_CAPACITY);
        assert!(adapter.last_request_input.lock().unwrap().contains_key("overflow"));
        assert!(adapter.first_cache_read.lock().unwrap().contains_key("overflow"));
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

    #[test]
    fn per_message_flows_through_ece_as_subscription_delivery() {
        // Spec #2711 round 2 case (j) — full ECE delivery chain for the
        // PerMessage style (Bug #586 lesson): the nemotron turn-2 span (input
        // 2,394) → adapter → ECE → SubscriptionDelivery must carry promptTokens
        // = 2,394 (never the round-1 clamped 0).
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
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let adapter = GenericOtlpAdapter::new();
        let session = "ece-per-message";

        // Turn 1: cold cache, full input 27,693 (style-agnostic).
        let t1 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "msg-1", 27_693, 14, 0)),
        );
        let mut deliveries = Vec::new();
        for input in t1 {
            deliveries.extend(engine.req_2_3_process(input));
        }
        assert_eq!(deliveries.len(), 2);
        assert_eq!(
            deliveries[1]
                .payload
                .get("payload")
                .unwrap()
                .get("promptTokens")
                .and_then(|v| v.as_i64()),
            Some(27_693),
            "turn 1: prompt = input (style-agnostic)"
        );

        // Turn 2: cache warms 0 → 25,344 → D1 latch PerMessage; the input DROP
        // to 2,394 must NOT clamp to 0.
        let t2 = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "msg-2", 2_394, 19, 25_344)),
        );
        deliveries.clear();
        for input in t2 {
            deliveries.extend(engine.req_2_3_process(input));
        }
        assert_eq!(deliveries.len(), 2);
        assert_eq!(deliveries[0].lifecycle, "init");
        assert_eq!(deliveries[1].lifecycle, "end");
        for d in &deliveries {
            let payload = d.payload.get("payload").unwrap();
            assert_eq!(
                payload.get("promptTokens").and_then(|v| v.as_i64()),
                Some(2_394),
                "delivery: PerMessage prompt = direct input 2,394 through the ECE — never the round-1 clamped 0"
            );
            assert_eq!(
                payload.get("completionTokens").and_then(|v| v.as_i64()),
                Some(19)
            );
            assert_eq!(
                payload.get("sessionContextTokens").and_then(|v| v.as_i64()),
                Some(2_394 + 25_344)
            );
        }
    }

    #[test]
    fn per_message_reexport_is_idempotent() {
        // Spec #2711 round 2 case (g): a PerMessage-style session re-exporting
        // a completed chat span (same spanId, the ST9 reuse path) derives the
        // SAME prompt on every export — the direct input, never a re-baselined
        // 0 (the Cumulative-style re-export caveat does not apply to
        // PerMessage, which never touches the baseline).
        let adapter = GenericOtlpAdapter::new();
        let session = "reexport-per-message";

        // Latch PerMessage: turn 1 cold (input 27,693, cache 0), turn 2 cache
        // warms (D1) with input 2,394.
        let _ = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "msg-1", 27_693, 14, 0)),
        );
        let _ = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_usage(session, "msg-2", 2_394, 19, 25_344)),
        );

        // Re-export the SAME completed span (msg-2) — prompt stays 2,394 on
        // every pass.
        for pass in 1..=2 {
            let inputs = transform(
                &adapter,
                Transport::OtlpGrpc,
                otlp_payload(completed_chat_span_with_usage(session, "msg-2", 2_394, 19, 25_344)),
            );
            let payload = inputs[1].payload.as_ref().unwrap();
            assert_eq!(
                payload.get("promptTokens").and_then(|v| v.as_i64()),
                Some(2_394),
                "re-export pass {}: PerMessage prompt stays the direct input — idempotent",
                pass
            );
        }
    }

    #[test]
    fn cache_creation_included_in_cache_n_for_session_context_and_latch() {
        // Spec #2711 round 2: cache_n = cache_read + cache_creation feeds BOTH
        // sessionContextTokens (input_n + cache_n) and the D1/D2 latch
        // discriminators. A session that CREATES its cache on the first request
        // (cache_creation > 0 at turn 1) is warm from turn 1 → Cumulative.
        let adapter = GenericOtlpAdapter::new();
        let session = "cache-creation-session";

        // Turn 1: cache_read 0, cache_creation 25,000 (cache created on the
        // first request).
        let first = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_cache_creation(
                session, "cc-1", 2_000, 10, 0, 25_000,
            )),
        );
        let p = first[1].payload.as_ref().unwrap();
        assert_eq!(
            p.get("promptTokens").and_then(|v| v.as_i64()),
            Some(2_000),
            "turn 1: prompt = input (style-agnostic)"
        );
        assert_eq!(
            p.get("sessionContextTokens").and_then(|v| v.as_i64()),
            Some(2_000 + 25_000),
            "sessionContextTokens = input + cache_read + cache_creation"
        );

        // Turn 2: cache_read 25,000, cache_creation 0 — first_cache_read =
        // 25,000 (≠ 0) so D1/D2 never fire → Cumulative delta 2,030 − 2,000.
        let second = transform(
            &adapter,
            Transport::OtlpGrpc,
            otlp_payload(completed_chat_span_with_cache_creation(
                session, "cc-2", 2_030, 11, 25_000, 0,
            )),
        );
        let p = second[1].payload.as_ref().unwrap();
        assert_eq!(
            p.get("promptTokens").and_then(|v| v.as_i64()),
            Some(30),
            "warm cache from turn 1 → Cumulative delta 2,030 − 2,000"
        );
        assert_eq!(
            p.get("sessionContextTokens").and_then(|v| v.as_i64()),
            Some(2_030 + 25_000),
            "cache_n = cache_read + cache_creation = 25,000 + 0"
        );
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
