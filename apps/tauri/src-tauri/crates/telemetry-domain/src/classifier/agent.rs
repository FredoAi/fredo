//! Per-span classification — the `process_span_rows` entry the OTLP path
//! funnels every span through, plus the agent-identity and span-timing helpers
//! it uses.
//!
//! Moved verbatim from `infrastructure/rtdb/ingest.rs` by Spec #3201 ST-5; the
//! logic is unchanged, only its location and its boundary types (`RowUpsert` /
//! [`RowSink`](crate::RowSink) instead of `IngestRow` / `Rtdb`).
//!
//! This module is where the **internal-agent exclusion** lives at the span
//! level ([`is_internal_tool_execution_agent`], `ingest.rs:118` before the
//! move): a `build`/`plan` session is an OpenCode INTERNAL tool-execution
//! session, never a user-requested @-subagent dispatch, so it must never
//! register a child→parent relationship.

use serde_json::Value;

use super::relationship::is_internal_tool_execution_agent;
use super::{attr_f64, attr_i64, attr_str, rfc3339_now, row_state_of};
use crate::attrs::{
    extract_messages_text, is_subagent_span, otlp_attrs_to_map, otlp_attrs_to_payload,
    req_11_event_state_from_span, resolve_op_name, resolve_provider_token,
    ATTR_CONVERSATION_ID, ATTR_INPUT_MESSAGES, ATTR_TOOL_CALL_ARGUMENTS,
    ATTR_USAGE_INPUT_TOKENS, ATTR_USAGE_OUTPUT_TOKENS,
    CC_ATTR_PROMPT_FLAT, CC_ATTR_SESSION_ID, CC_ATTR_SESSION_PARENT_ID, CC_ATTR_TOOL_INPUT,
    MAP_CAPACITY, OP_CHAT_CANON, OP_SESSION, OP_TOOL_PREFIX, PROVIDER_COPILOT_CLI,
};
use crate::event::EventState;
use crate::merge::{AgentSessionPatch, ChatPatch, ToolUsePatch};

/// Row-specific attribute keys (verified against the plugin's emitted shapes:
/// apps/opencode-plugin/src/telemetry-constants.ts:40-54; message.ts:135/323
/// for cost_usd; session.ts:608 for the total_* family). NOT gen_ai.* —
/// fredo-native flat attrs carried on the plugin's spans.
const ATTR_COST_USD: &str = "cost_usd";
const ATTR_TOOL_SUCCESS: &str = "tool.success";
const ATTR_TOOL_ERROR: &str = "tool.error";
const ATTR_DURATION_MS: &str = "duration_ms";
/// OTel `error.type` — emitted on a failed span (Copilot's tool-failure
/// signal). Spec #2933 ST-3: read ONLY as an additive fallback when the
/// OpenCode-native flat `tool.success`/`tool.error` keys are absent.
const ATTR_ERROR_TYPE: &str = "error.type";
const ATTR_TOTAL_TOKENS: &str = "total_tokens";
const ATTR_TOTAL_MESSAGES: &str = "total_messages";
const ATTR_TOTAL_COST_USD: &str = "total_cost_usd";

/// Span-link parent attribution attribute (REQ-6, Spec #633 — ported from
/// `adapters/otlp.rs` process_span).
const LINK_ATTR_PARENT_SESSION_ID: &str = "parent.session_id";

impl super::IngestClassifier {
    // ── Per-span classification (ported from the deleted v1 OTLP adapter) ────

    pub(crate) async fn process_span_rows(
        &self,
        span: &Value,
        span_name: &str,
        res_attrs: &serde_json::Map<String, Value>,
        check_links: bool,
    ) -> usize {
        let span_attrs = otlp_attrs_to_map(span.get("attributes"));

        // Spec #2933 ST-2: build the merged resource+span attribute map BEFORE
        // op resolution so the resource `service.name` is visible to the
        // provider-scoped `invoke_agent` → session promotion (the promotion
        // resolves the provider through the shared `resolve_provider_token` rule
        // on this map). Span attributes are extended LAST, so a span-level key
        // always wins a collision.
        let mut merged = res_attrs.clone();
        merged.extend(span_attrs.clone());

        // Resolve canonical op name. Unrecognised spans are dropped (logged) —
        // same classification as the v1 adapter (R6).
        let Some(op_name) = resolve_op_name(span_name, &merged) else {
            tracing::debug!(
                target: "fredo::rtdb::ingest",
                span_name = %span_name,
                "Classifier dropping unrecognised OTLP span"
            );
            return 0;
        };

        // Resolve session id: session.id → gen_ai.conversation.id →
        // trace_to_session → trace_id/UUID (ported from otlp.rs:297-328).
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
                if trace_id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    trace_id.clone()
                }
            });

        // Store trace→session mapping when a session identity is present.
        if let Some(sid) = span_attrs
            .get(CC_ATTR_SESSION_ID)
            .and_then(|v| v.as_str())
            .or_else(|| span_attrs.get(ATTR_CONVERSATION_ID).and_then(|v| v.as_str()))
        {
            if let Ok(mut map) = self.trace_to_session.lock() {
                if map.len() >= MAP_CAPACITY && !map.contains_key(&trace_id) {
                    if let Some(oldest) = map.keys().next().cloned() {
                        map.remove(&oldest);
                    }
                }
                map.insert(trace_id.clone(), sid.to_string());
            }
        }

        // Spec #2932 ST-3 (R1/R3): resolve the canonical CLI-provider token ONCE
        // per span from the merged resource+span attribute map, via the SHARED
        // extract rule (NFR-6 — the canonical backfill reuses the same helper).
        // The token is stamped on all three row patch kinds below.
        let provider = resolve_provider_token(&merged);

        // REQ-11 / REQ-609: session spans always Init; others from span timing.
        let event_state = if op_name == OP_SESSION {
            EventState::Init
        } else {
            req_11_event_state_from_span(span)
        };

        // REQ-3 / REQ-639 / ST9: correlationId bridging + per-turn counters
        // with the reuse guard (one correlation id per span).
        let span_id = span
            .get("spanId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let correlation_id = self.resolve_span_correlation_id(
            &session_id,
            &span_id,
            &op_name,
            event_state,
            &provider,
        );

        // REQ-6: parent from OTLP span links (order-independent detection).
        if check_links {
            if let Some(links) = span.get("links").and_then(|l| l.as_array()) {
                for link in links {
                    let link_attrs =
                        otlp_attrs_to_map(link.get("attributes"));
                    if let Some(pid) = link_attrs
                        .get(LINK_ATTR_PARENT_SESSION_ID)
                        .and_then(|v| v.as_str())
                        .filter(|pid| !pid.is_empty() && pid != &session_id)
                    {
                        if let Ok(mut map) = self.session_to_parent.lock() {
                            bounded_map_insert(&mut map, &session_id, pid.to_string());
                        }
                        break;
                    }
                }
            }
        }

        // REQ-9: fallback to the session.parent_id attribute (span links take
        // priority — only insert if not already set).
        if let Some(parent_sid) = merged
            .get(CC_ATTR_SESSION_PARENT_ID)
            .and_then(|v| v.as_str())
            .filter(|psid| !psid.is_empty() && psid != &session_id)
        {
            if let Ok(mut map) = self.session_to_parent.lock() {
                if !map.contains_key(&session_id) {
                    bounded_map_insert(&mut map, &session_id, parent_sid.to_string());
                }
            }
        }

        let is_subagent = is_subagent_span(&merged);
        let internal_agent = is_internal_tool_execution_agent(&merged);

        // Spec #2762/#2768: the child's parent session id, resolved the SAME
        // three-rule way the adapter does (attribute first, then the persisted
        // registry).
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

        // R-1e: relationship registration from the self-carried parent
        // attribution, minus the internal `build`/`plan` exclusion
        // (`engine.rs:823-837` port). Registration re-keys (copies) the
        // child's existing rows under the parent key.
        let mut copied = 0usize;
        if let Some(parent) = session_parent_id.as_ref() {
            if internal_agent {
                tracing::debug!(
                    target: "fredo::rtdb::ingest",
                    session_id = %session_id,
                    parent_session_id = %parent,
                    "Classifier: relationship skipped — internal tool-execution agent session"
                );
            } else {
                copied += self.register_relationship(parent, &session_id).await;
            }
        }

        // Bug 1 (Spec #633): capture the task instruction for task tool spans
        // (keyed by the dispatching parent session).
        if op_name == "tool.task" {
            let tool_input_str = merged
                .get(ATTR_TOOL_CALL_ARGUMENTS)
                .and_then(|v| v.as_str())
                .or_else(|| merged.get(CC_ATTR_TOOL_INPUT).and_then(|v| v.as_str()));
            if let Some(input_json) = tool_input_str {
                if let Ok(parsed) = serde_json::from_str::<Value>(input_json) {
                    if let Some(instr) = parsed
                        .get("task")
                        .or_else(|| parsed.get("instruction"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                    {
                        if let Ok(mut map) = self.pending_task_instructions.lock() {
                            bounded_map_insert(&mut map, &session_id, instr);
                        }
                    }
                }
            }
        }

        // REQ-1 (Spec #633 AC-6c): cache parent session prompts (non-subagent).
        if !is_subagent {
            if let Some(prompt) = merged
                .get(ATTR_INPUT_MESSAGES)
                .and_then(|v| v.as_str())
                .and_then(|s| extract_messages_text(s, "user"))
                .or_else(|| {
                    merged
                        .get(CC_ATTR_PROMPT_FLAT)
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .filter(|s| !s.trim().is_empty())
            {
                if let Ok(mut map) = self.parent_prompts.lock() {
                    super::relationship::req_1_cache_parent_prompt(&mut map, &session_id, &prompt);
                }
            }
        }

        // Spec #2711/#2723/#2734: per-turn token deltas against the session-
        // cumulative baselines (classifier-owned maps, identical semantics).
        let derived = self.derive_turn_tokens(&session_id, &op_name, event_state, &merged);

        // Build the raw delivery payload (v1 parity — one source of truth via
        // the adapter's projector) + the instruction injection order
        // (task instruction → parent prompt), then freeze it as `rawJson`.
        // Row fields are then read from the projector's canonical fields
        // (`userMessage`/`promptTokens`/`agent`/… — the exact priority chains
        // v1 applies) and the preserved verbatim flat attrs.
        let mut payload = otlp_attrs_to_payload(merged, derived);
        self.inject_instruction_if_needed(is_subagent, &session_id, &mut payload);

        // Spec #2933 ST-3R (R-2.1): Copilot splits ONE user turn across TWO
        // `chat` spans — the dispatch span carries the user text (plus a
        // tool_call output), the continuation span (after `execute_tool`)
        // carries only the tool result plus the assistant text. OpenCode
        // re-carries the exchange's user prompt on EVERY chat span of a turn
        // (`message.ts:702,716-719`), and Mission Monitor's same-exchange
        // tool anchoring depends on that canonical row contract. When a
        // Copilot continuation span's own `gen_ai.input.messages` has no
        // `user` role, its projected payload loses `userMessage`; carry the
        // session's cached prompt forward so `userMessage`, `rawJson`, the
        // typed column and the delivery all agree (one layer, consumer
        // untouched).
        //
        // Provider-scoped by construction (a `copilot_cli` data-mapping rule):
        // no `open_code` row can take this branch, so the R-5.1/AC5
        // byte-identity bar holds. A miss (content off, or the dispatch span
        // not yet ingested) is a no-op — `userMessage` stays absent, exactly
        // the R-3 documented degradation. The carried text is the exchange's
        // own captured prompt, never fabricated.
        if op_name == OP_CHAT_CANON
            && provider == PROVIDER_COPILOT_CLI
            && payload
                .get(ATTR_INPUT_MESSAGES)
                .and_then(|v| v.as_str())
                .is_some_and(|s| extract_messages_text(s, "user").is_none())
            && payload
                .get("userMessage")
                .and_then(|v| v.as_str())
                .is_none_or(|s| s.trim().is_empty())
        {
            if let Ok(map) = self.parent_prompts.lock() {
                if let Some(prompt) =
                    super::relationship::req_3_cached_prompt(&map, &session_id)
                {
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("userMessage".to_string(), Value::String(prompt.to_string()));
                    }
                }
            }
        }

        let raw_json = payload.to_string();
        let empty_map = serde_json::Map::new();
        let payload_map = payload.as_object().unwrap_or(&empty_map);

        let (start_ns, end_ns) = span_timing_ns(span);
        let updated_at = rfc3339_now();
        let row_state = row_state_of(event_state);

        match op_name.as_str() {
            OP_SESSION => {
                let patch = AgentSessionPatch {
                    session_id: Some(session_id.clone()),
                    correlation_id: Some(correlation_id.clone()),
                    seq: None,
                    started_at_ns: start_ns,
                    ended_at_ns: end_ns,
                    updated_at: Some(updated_at),
                    state: Some(row_state),
                    // Spec #2932 ST-3 (R1): the CLI-provider token resolved from
                    // the merged resource+span attribute map (shared rule).
                    provider: Some(provider.clone()),
                    // The projector preserves the flat attrs verbatim and
                    // projects gen_ai.agent.name → `agent`/`name` — read the
                    // canonical fields (one source of truth).
                    // Spec #2933 ST-3 (R-2.6): the flat OpenCode-native
                    // `total_tokens` key stays primary; only when it is absent
                    // fall back to Copilot's session-cumulative
                    // `gen_ai.usage.input_tokens + gen_ai.usage.output_tokens`.
                    // `total_messages`/`total_cost_usd` stay absent (Copilot
                    // emits no such attributes — documented limitation).
                    total_tokens: attr_i64(payload_map, ATTR_TOTAL_TOKENS).or_else(|| {
                        let input = attr_i64(payload_map, ATTR_USAGE_INPUT_TOKENS);
                        let output = attr_i64(payload_map, ATTR_USAGE_OUTPUT_TOKENS);
                        match (input, output) {
                            (None, None) => None,
                            (i, o) => Some(i.unwrap_or(0) + o.unwrap_or(0)),
                        }
                    }),
                    total_messages: attr_i64(payload_map, ATTR_TOTAL_MESSAGES),
                    total_cost_usd: attr_f64(payload_map, ATTR_TOTAL_COST_USD),
                    agent_name: attr_str(payload_map, "agent").or_else(|| attr_str(payload_map, "name")),
                    raw_json: Some(raw_json),
                };
                copied += self.ingest_session_with_copy(patch, &session_id).await;
            }
            OP_CHAT_CANON => {
                // Text/tokens come from the adapter projector's canonical
                // fields — `userMessage`/`agentReply` carry the exact
                // input.messages → request.body → flat-prompt chain,
                // `promptTokens`/`completionTokens` the delta-or-registry
                // chain, and `cacheReadTokens` the derived per-turn DELTA
                // ONLY (the projector never injects the raw cumulative,
                // #2723 ST-3 H1). Identical values to v1 by construction.
                let patch = ChatPatch {
                    session_id: Some(session_id.clone()),
                    correlation_id: Some(correlation_id.clone()),
                    seq: None,
                    started_at_ns: start_ns,
                    ended_at_ns: end_ns,
                    updated_at: Some(updated_at),
                    state: Some(row_state),
                    provider: Some(provider.clone()),
                    user_message: attr_str(payload_map, "userMessage"),
                    agent_reply: attr_str(payload_map, "agentReply"),
                    prompt_tokens: attr_i64(payload_map, "promptTokens"),
                    completion_tokens: attr_i64(payload_map, "completionTokens"),
                    cache_read_tokens: attr_i64(payload_map, "cacheReadTokens"),
                    cost_usd: attr_f64(payload_map, ATTR_COST_USD),
                    model: attr_str(payload_map, "model"),
                    parent_session_id: session_parent_id.clone(),
                    composited_child_session_id: None,
                    raw_json: Some(raw_json),
                };
                copied += self.ingest_chat_with_copy(patch, &session_id).await;
            }
            _ => {
                let tool_name = op_name
                    .strip_prefix(OP_TOOL_PREFIX)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| op_name.clone());
                let patch = ToolUsePatch {
                    session_id: Some(session_id.clone()),
                    correlation_id: Some(correlation_id.clone()),
                    seq: None,
                    started_at_ns: start_ns,
                    ended_at_ns: end_ns,
                    updated_at: Some(updated_at),
                    state: Some(row_state),
                    provider: Some(provider.clone()),
                    tool_name: Some(tool_name),
                    // Spec #2933 ST-3 (R-2.5): the flat OpenCode-native
                    // `tool.success`/`tool.error`/`duration_ms` keys stay
                    // primary. Copilot emits `error.type` + span timing
                    // instead, so fall back ONLY when the flat key is absent:
                    // failure iff `error.type` is present, success iff the span
                    // completed (has an end time), else in-flight (absent).
                    tool_success: payload_map
                        .get(ATTR_TOOL_SUCCESS)
                        .and_then(|v| v.as_bool())
                        .or_else(|| {
                            if attr_str(payload_map, ATTR_ERROR_TYPE).is_some() {
                                Some(false)
                            } else if end_ns.is_some() {
                                Some(true)
                            } else {
                                None
                            }
                        }),
                    tool_error: attr_str(payload_map, ATTR_TOOL_ERROR)
                        .or_else(|| attr_str(payload_map, ATTR_ERROR_TYPE)),
                    duration_ms: attr_i64(payload_map, ATTR_DURATION_MS).or_else(|| {
                        // Span timing fallback (end − start, ms) — fires only
                        // when the flat duration_ms attr is absent.
                        match (start_ns, end_ns) {
                            (Some(start), Some(end)) if end >= start => {
                                Some((end - start) / 1_000_000)
                            }
                            _ => None,
                        }
                    }),
                    tool_input_json: attr_str(payload_map, "input"),
                    tool_output_json: attr_str(payload_map, "output"),
                    is_subagent: Some(is_subagent),
                    raw_json: Some(raw_json),
                };
                copied += self.ingest_tool_with_copy(patch, &session_id).await;
            }
        }

        copied + 1
    }
}

/// Bounded-map insert with oldest-first eviction (the adapter's cap pattern).
fn bounded_map_insert<V>(map: &mut std::collections::HashMap<String, V>, key: &str, value: V) {
    if map.len() >= MAP_CAPACITY && !map.contains_key(key) {
        if let Some(oldest) = map.keys().next().cloned() {
            map.remove(&oldest);
        }
    }
    map.insert(key.to_string(), value);
}

/// Span timing as epoch-ns i64 pair (`startTimeUnixNano` / `endTimeUnixNano`;
/// decimal strings per the OTLP JSON encoding, numerics accepted too; 0 →
/// `None`). Rows keep the raw ns (telemetry_spans.start_time_ns parity).
fn span_timing_ns(span: &Value) -> (Option<i64>, Option<i64>) {
    let parse_ns = |key: &str| -> Option<i64> {
        let ns = span
            .get(key)
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| v.as_u64())
                    .or_else(|| v.as_i64().and_then(|i| u64::try_from(i).ok()))
            })?;
        if ns == 0 {
            return None;
        }
        i64::try_from(ns).ok()
    };
    (parse_ns("startTimeUnixNano"), parse_ns("endTimeUnixNano"))
}
