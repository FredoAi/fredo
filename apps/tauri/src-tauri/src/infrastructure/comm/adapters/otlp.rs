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
        let mut mapped_payload = Self::otlp_attrs_to_payload(merged);

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
    fn otlp_attrs_to_payload(attrs: Map<String, Value>) -> Value {
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
        let prompt_tokens_value = turn_input_tokens.or(turn_input_tokens_cc);
        let completion_tokens_value = turn_output_tokens.or(turn_output_tokens_cc);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("What is the weather?"));
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("The weather is sunny."));
        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(150));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(75));
        assert_eq!(obj.get("model").and_then(|v| v.as_str()), Some("claude-sonnet-4"));

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(info.get("text").and_then(|v| v.as_str()), Some("What is the weather?"));
        assert_eq!(info.get("modelID").and_then(|v| v.as_str()), Some("claude-sonnet-4"));
        assert_eq!(info.get("turnInputTokens").and_then(|v| v.as_i64()), Some(150));
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("from input.messages"));
    }

    #[test]
    fn request_body_preferred_over_flat_prompt_when_input_messages_absent() {
        let mut attrs = Map::new();
        attrs.insert(ATTR_REQUEST_BODY.to_string(), json!("from request.body"));
        attrs.insert(CC_ATTR_PROMPT_FLAT.to_string(), json!("from flat prompt"));

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("from output.messages"));
    }

    #[test]
    fn output_messages_falls_back_to_flat_response_text() {
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_RESPONSE_TEXT.to_string(), json!("from flat response_text"));

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
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

        let result = GenericOtlpAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("agent").and_then(|v| v.as_str()), Some("coder"));
        assert_eq!(obj.get("name").and_then(|v| v.as_str()), Some("coder"));
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
