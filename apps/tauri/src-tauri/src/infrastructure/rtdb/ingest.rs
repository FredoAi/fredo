//! IngestClassifier — the RTDB write-path classifier (Spec #2788, P3.1,
//! REQs R-1e/R-1f/R-4a/R-4b/R-4d).
//!
//! Owns the correlation-state maps the v1 `GenericOtlpAdapter` keeps for the
//! ECE delivery pipeline, re-homed to the row pipeline: each incoming span is
//! classified into zero or more canonical `RowUpsert`s fed to
//! [`Rtdb::ingest_row_upsert`] (merge rules → durable seq → subscriptions →
//! flush → IPC). This is an ADDITIVE parallel run — the v1
//! adapter→engine→EventBus path is untouched and a v1-only consumer still
//! observes byte-identical deliveries.
//!
//! ## Ported state (copy-preserve — same caps, same eviction, same logic)
//!
//! - The 9 correlation maps of `GenericOtlpAdapter` (`adapters/otlp.rs:164-199`):
//!   `trace_to_session`, `session_to_correlation`, `span_to_correlation` (ST9
//!   #2688 double-advance guard), `session_to_parent`, `session_turn_counter`
//!   (REQ-639), `pending_task_instructions` (#633), `parent_prompts`
//!   (`adapters/parent_prompt_cache.rs` helpers reused verbatim),
//!   `last_request_input` / `last_request_cache_read` (#2711/#2723 token-delta
//!   baselines). All capped at [`MAP_CAPACITY`] (10 000) with oldest-first
//!   eviction — identical bounded-state semantics (NFR-2).
//! - The ECE relationship registry (`contract/engine.rs:53-55`):
//!   `child_to_parent` / `parent_to_children`, cap 10 000 oldest-first
//!   eviction, internal `build`/`plan` agent exclusion (AGENTS.md #509 rule).
//!
//! ## Row derivation (R-4a)
//!
//! Every span classified — UNCONDITIONALLY, never gated by subscriptions
//! (that is what makes replay work). Extract paths are the adapter's
//! production paths, reused via `pub(crate)` visibility (one source of truth;
//! grounded in the plugin's emitted attribute shapes and cross-checked against
//! the `realCorpus.ts` real-corpus fixture and `span_store.rs`'s real DDL).
//! Row `state` is an ordinary field derived from span timing exactly as the
//! adapter derives `EventState` (REQ-11); session spans stay `Init` (REQ-609).
//!
//! ## Token deltas (R-1f)
//!
//! One correlation id per span (the ported ST9 `span_to_correlation` guard);
//! `promptTokens` / `cacheReadTokens` rows are PER-TURN DELTAS derived against
//! the session-cumulative `last_request_input` / `last_request_cache_read`
//! baselines, preserving the #2711/#2723 semantics exactly (deltas clamped ≥ 0
//! with baseline reset on compaction/out-of-order; cache-read NEVER falls back
//! to the raw session-cumulative registry value).
//!
//! ## Relationship registration + re-key (R-1e)
//!
//! Registration sources are ported from the ECE (`engine.rs:792-840`): the
//! span-link `parent.session_id` attr and the `session.parent_id` attr feed
//! `session_to_parent`; registration happens from the self-carried parent
//! attribution minus the internal `build`/`plan` exclusion. WHEN a
//! child→parent relationship registers, the child's EXISTING rows are COPIED
//! under the parent key (session_id = parent, correlation_id = the child's
//! own per-turn id) carrying the `parentSessionId` +
//! `compositedChildSessionId` stamps. Binding constraints honored:
//! - `kind: remove` is ONLY ever emitted for retention eviction — a re-key
//!   NEVER removes rows. Child-keyed rows stay intact, so rows never vanish
//!   mid-session for an active subscription.
//! - Under P2.2's key-complete semantics the parent-keyed copies arrive as a
//!   first-match `insert` — exactly what SubagentNode creation needs
//!   (AGENTS.md #523: node creation happens on new-key arrival).
//! - Every LATER child row also gets a parent-keyed copy while the
//!   relationship is registered, so the parent-space view stays current.
//! - The re-key reads the cached ∪ persisted key set
//!   ([`RtdbCache::chat_keys_for_session`]) so rows still inside the ~30 ms
//!   write-behind window are not missed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::infrastructure::comm::adapters::otlp::{
    GenericOtlpAdapter, TurnTokenDerivation, ATTR_AGENT_NAME, ATTR_CONVERSATION_ID,
    ATTR_INPUT_MESSAGES, ATTR_TOOL_CALL_ARGUMENTS, ATTR_USAGE_CACHE_READ_INPUT_TOKENS,
    ATTR_USAGE_INPUT_TOKENS, ATTR_USAGE_OUTPUT_TOKENS, CC_ATTR_PROMPT_FLAT, CC_ATTR_SESSION_ID,
    CC_ATTR_SESSION_PARENT_ID, CC_ATTR_TOOL_INPUT, MAP_CAPACITY, OP_CHAT_CANON, OP_SESSION,
    OP_TOOL_PREFIX,
};
use crate::infrastructure::comm::adapters::parent_prompt_cache;
use crate::infrastructure::comm::event::{EventState, EventType, FredoEvent, Transport};
use crate::infrastructure::rtdb::commands::{IngestRow, Rtdb};
use crate::infrastructure::rtdb::merge::{
    apply_agent_session_patch, apply_chat_patch, apply_tool_use_patch, AgentSessionPatch,
    ChatPatch, ToolUsePatch,
};
use crate::infrastructure::rtdb::project::rfc3339_now;
use crate::infrastructure::rtdb::rows::{
    AgentSessionRow, ChatRow, RowState, ToolUseRow, AGENT_SESSION_FIELDS, CHAT_FIELDS,
    TOOL_USE_FIELDS,
};

// ── Row-specific attribute keys (verified against the plugin's emitted shapes:
//    apps/opencode-plugin/src/telemetry-constants.ts:40-54; message.ts:135/323
//    for cost_usd; session.ts:608 for the total_* family). NOT gen_ai.* —
//    fredo-native flat attrs carried on the plugin's spans. ────────────────────
const ATTR_COST_USD: &str = "cost_usd";
const ATTR_TOOL_SUCCESS: &str = "tool.success";
const ATTR_TOOL_ERROR: &str = "tool.error";
const ATTR_DURATION_MS: &str = "duration_ms";
const ATTR_TOTAL_TOKENS: &str = "total_tokens";
const ATTR_TOTAL_MESSAGES: &str = "total_messages";
const ATTR_TOTAL_COST_USD: &str = "total_cost_usd";

/// Span-link parent attribution attribute (REQ-6, Spec #633 — ported from
/// `adapters/otlp.rs` process_span).
const LINK_ATTR_PARENT_SESSION_ID: &str = "parent.session_id";

/// Internal OpenCode tool-execution agent names — port of the ECE exclusion
/// (`contract/engine.rs:768`, AGENTS.md #509 rule). Sessions whose agent name
/// resolves to one of these are NOT user-requested @-subagent dispatches and
/// must never register a child→parent relationship.
const INTERNAL_TOOL_EXECUTION_AGENTS: &[&str] = &["build", "plan"];

/// Managed-state alias — `app.manage(Arc::new(IngestClassifier::new(rtdb)))`
/// in lib.rs (P3.1); consumed by the OTLP receivers + the IPC dispatcher.
pub type IngestClassifierState = Arc<IngestClassifier>;

/// The RTDB write-path classifier (module doc — Spec #2788 P3.1).
pub struct IngestClassifier {
    /// The row pipeline orchestrator (P2.3) — the classifier's only sink.
    rtdb: Arc<Rtdb>,

    // ── The 9 correlation maps (ported from adapters/otlp.rs:164-199) ───────
    /// Key: traceId, Value: session_id (conversation.id).
    trace_to_session: Mutex<HashMap<String, String>>,
    /// Key: session_id, Value: correlationId. Hook-bridged sessions reuse the
    /// stored Hook correlationId; pure-OTLP sessions get per-turn IDs.
    session_to_correlation: Mutex<HashMap<String, String>>,
    /// Key: (session_id, span_id), Value: correlationId. ST9 (#2688) reuse
    /// guard — one correlation id per span, the per-turn counter never
    /// double-advances.
    span_to_correlation: Mutex<HashMap<(String, String), String>>,
    /// Key: child_session_id, Value: parent_session_id (Spec #615).
    session_to_parent: Mutex<HashMap<String, String>>,
    /// Key: session_id, Value: turn counter (1-based) — REQ-639.
    session_turn_counter: Mutex<HashMap<String, u64>>,
    /// Key: parent_session_id, Value: task instruction (Spec #633 Bug 1).
    pending_task_instructions: Mutex<HashMap<String, String>>,
    /// Key: session_id, Value: prompt text (Spec #633 AC-6c REQ-1).
    parent_prompts: Mutex<HashMap<String, String>>,
    /// Key: session_id, Value: cumulative `gen_ai.usage.input_tokens` at the
    /// last completed chat span (#2711 per-turn prompt-delta baseline).
    last_request_input: Mutex<HashMap<String, i64>>,
    /// Key: session_id, Value: cumulative
    /// `gen_ai.usage.cache_read.input_tokens` (#2723 ST-3 H1 baseline).
    last_request_cache_read: Mutex<HashMap<String, i64>>,

    // ── Relationship registry (ported from contract/engine.rs:53-55) ────────
    /// Key: child_session_id, Value: parent_session_id (Spec #523/#2768).
    child_to_parent: Mutex<HashMap<String, String>>,
    /// Reverse lookup — Key: parent_session_id, Value: child session IDs.
    parent_to_children: Mutex<HashMap<String, Vec<String>>>,
}

impl IngestClassifier {
    /// Create the classifier over an existing [`Rtdb`] orchestrator.
    pub fn new(rtdb: Arc<Rtdb>) -> Self {
        IngestClassifier {
            rtdb,
            trace_to_session: Mutex::new(HashMap::new()),
            session_to_correlation: Mutex::new(HashMap::new()),
            span_to_correlation: Mutex::new(HashMap::new()),
            session_to_parent: Mutex::new(HashMap::new()),
            session_turn_counter: Mutex::new(HashMap::new()),
            pending_task_instructions: Mutex::new(HashMap::new()),
            parent_prompts: Mutex::new(HashMap::new()),
            last_request_input: Mutex::new(HashMap::new()),
            last_request_cache_read: Mutex::new(HashMap::new()),
            child_to_parent: Mutex::new(HashMap::new()),
            parent_to_children: Mutex::new(HashMap::new()),
        }
    }

    /// Classify a raw OTLP export (standard `resourceSpans` envelope or flat
    /// JSON — the SAME input shape `GenericOtlpAdapter::transform` takes) into
    /// row upserts. Returns the number of row mutations ingested. P3.2's
    /// backfill MUST reuse THIS entry point (reconstructed span JSON) so the
    /// extract rules stay identical to the live path.
    pub fn ingest_otlp(&self, transport: Transport, raw: &Value) -> usize {
        tracing::debug!(
            target: "fredo::rtdb::ingest",
            transport = transport.as_str(),
            "RTDB ingest classifier receiving an OTLP export"
        );
        let mut count = 0usize;

        if let Some(resource_spans) = raw.get("resourceSpans").and_then(|v| v.as_array()) {
            for rs in resource_spans {
                let res_attrs = GenericOtlpAdapter::otlp_attrs_to_map(
                    rs.get("resource").and_then(|r| r.get("attributes")),
                );
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
                        count += self.process_span_rows(span, span_name, &res_attrs, true);
                    }
                }
            }
            return count;
        }

        // Flat/custom JSON (OpenCode file-exporter style / non-envelope emitters).
        let raw_name = raw
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("otlp.span");
        let empty_res = serde_json::Map::new();
        count += self.process_span_rows(raw, raw_name, &empty_res, false);
        count
    }

    /// Classify a `FredoEvent` (the IPC/`fredo emit` CLI path — the mock
    /// payload shapes follow the `fredo-cli-events` skill conventions; real
    /// OTLP-derived rows remain the primary shape per the AGENTS.md
    /// mock-vs-real rule) into row upserts. Only the three row-bearing event
    /// types classify; others are ignored.
    pub fn ingest_event(&self, event: &FredoEvent) -> usize {
        let payload = event.payload.clone().unwrap_or(Value::Null);
        let correlation = event
            .correlation_id
            .clone()
            .unwrap_or_else(|| event.session_id.clone());
        let state = row_state_of(event.state);
        let updated_at = rfc3339_now();

        // R-1e: relationship detection — ported from the ECE
        // (`engine.rs:792-840`): legacy metadata path first (no exclusion,
        // exactly as the engine), then the self-carried routing property with
        // the internal `build`/`plan` exclusion.
        let mut copied = self.detect_event_relationship(event, &payload);

        match event.event_type {
            EventType::Chat => {
                let patch =
                    chat_patch_from_event(event, &payload, &correlation, state, &updated_at);
                copied += self.ingest_chat_with_copy(patch, &event.session_id);
            }
            EventType::ToolUse => {
                let patch =
                    tool_patch_from_event(event, &payload, &correlation, state, &updated_at);
                copied += self.ingest_tool_with_copy(patch, &event.session_id);
            }
            EventType::AgentSession => {
                let patch = session_patch_from_event(&payload, &event.session_id, &correlation, state, &updated_at);
                copied += self.ingest_session_with_copy(patch, &event.session_id);
            }
            EventType::Infrastructure | EventType::Ui | EventType::Custom => {}
        }
        copied
    }

    // ── Per-span classification (ported from GenericOtlpAdapter::process_span) ─

    fn process_span_rows(
        &self,
        span: &Value,
        span_name: &str,
        res_attrs: &serde_json::Map<String, Value>,
        check_links: bool,
    ) -> usize {
        let span_attrs = GenericOtlpAdapter::otlp_attrs_to_map(span.get("attributes"));

        // Resolve canonical op name. Unrecognised spans are dropped (logged) —
        // same classification as the v1 adapter (R6).
        let Some(op_name) = GenericOtlpAdapter::resolve_op_name(span_name, &span_attrs) else {
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

        let mut merged = res_attrs.clone();
        merged.extend(span_attrs);

        // REQ-11 / REQ-609: session spans always Init; others from span timing.
        let event_state = if op_name == OP_SESSION {
            EventState::Init
        } else {
            GenericOtlpAdapter::req_11_event_state_from_span(span)
        };

        // REQ-3 / REQ-639 / ST9: correlationId bridging + per-turn counters
        // with the reuse guard (one correlation id per span).
        let span_id = span
            .get("spanId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let correlation_id =
            self.resolve_span_correlation_id(&session_id, &span_id, &op_name, event_state);

        // REQ-6: parent from OTLP span links (order-independent detection).
        if check_links {
            if let Some(links) = span.get("links").and_then(|l| l.as_array()) {
                for link in links {
                    let link_attrs =
                        GenericOtlpAdapter::otlp_attrs_to_map(link.get("attributes"));
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

        let is_subagent = GenericOtlpAdapter::is_subagent_span(&merged);
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
                copied += self.register_relationship(parent, &session_id);
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
                .and_then(|s| GenericOtlpAdapter::extract_messages_text(s, "user"))
                .or_else(|| {
                    merged
                        .get(CC_ATTR_PROMPT_FLAT)
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .filter(|s| !s.trim().is_empty())
            {
                if let Ok(mut map) = self.parent_prompts.lock() {
                    parent_prompt_cache::req_1_cache_parent_prompt(&mut map, &session_id, &prompt);
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
        let mut payload = GenericOtlpAdapter::otlp_attrs_to_payload(merged, derived);
        self.inject_instruction_if_needed(is_subagent, &session_id, &mut payload);
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
                    // The projector preserves the flat attrs verbatim and
                    // projects gen_ai.agent.name → `agent`/`name` — read the
                    // canonical fields (one source of truth).
                    total_tokens: attr_i64(payload_map, ATTR_TOTAL_TOKENS),
                    total_messages: attr_i64(payload_map, ATTR_TOTAL_MESSAGES),
                    total_cost_usd: attr_f64(payload_map, ATTR_TOTAL_COST_USD),
                    agent_name: attr_str(payload_map, "agent").or_else(|| attr_str(payload_map, "name")),
                    raw_json: Some(raw_json),
                };
                copied += self.ingest_session_with_copy(patch, &session_id);
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
                copied += self.ingest_chat_with_copy(patch, &session_id);
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
                    tool_name: Some(tool_name),
                    tool_success: payload_map.get(ATTR_TOOL_SUCCESS).and_then(|v| v.as_bool()),
                    tool_error: attr_str(payload_map, ATTR_TOOL_ERROR),
                    duration_ms: attr_i64(payload_map, ATTR_DURATION_MS),
                    tool_input_json: attr_str(payload_map, "input"),
                    tool_output_json: attr_str(payload_map, "output"),
                    is_subagent: Some(is_subagent),
                    raw_json: Some(raw_json),
                };
                copied += self.ingest_tool_with_copy(patch, &session_id);
            }
        }

        copied + 1
    }

    // ── Correlation resolution (ported verbatim from adapters/otlp.rs) ────────

    /// ST9 (#2688) port — see `GenericOtlpAdapter::resolve_span_correlation_id`.
    fn resolve_span_correlation_id(
        &self,
        session_id: &str,
        span_id: &str,
        op_name: &str,
        event_state: EventState,
    ) -> String {
        if op_name == OP_SESSION {
            return self.resolve_correlation_id(session_id, event_state);
        }

        if !span_id.is_empty() {
            let key = (session_id.to_string(), span_id.to_string());
            if let Some(cid) = self
                .span_to_correlation
                .lock()
                .ok()
                .and_then(|m| m.get(&key).cloned())
            {
                return cid;
            }
        }

        let cid = if event_state == EventState::Response {
            self.resolve_correlation_id(session_id, EventState::Init)
        } else {
            self.resolve_correlation_id(session_id, event_state)
        };

        if !span_id.is_empty() {
            if let Ok(mut map) = self.span_to_correlation.lock() {
                let key = (session_id.to_string(), span_id.to_string());
                if map.len() >= MAP_CAPACITY && !map.contains_key(&key) {
                    if let Some(oldest) = map.keys().next().cloned() {
                        map.remove(&oldest);
                    }
                }
                map.insert(key, cid.clone());
            }
        }

        cid
    }

    /// REQ-3 / REQ-639 port — see
    /// `GenericOtlpAdapter::resolve_correlation_id`.
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
                return cid.clone();
            }
            if event_state == EventState::Init {
                return self.generate_per_turn_correlation_id(session_id);
            }
            return cid.clone();
        }

        if event_state == EventState::Init {
            return self.generate_per_turn_correlation_id(session_id);
        }

        let cid = session_id.to_string();
        if let Ok(mut map) = self.session_to_correlation.lock() {
            if map.len() >= MAP_CAPACITY && !map.contains_key(session_id) {
                if let Some(oldest) = map.keys().next().cloned() {
                    map.remove(&oldest);
                }
            }
            map.entry(session_id.to_string())
                .or_insert_with(|| cid.clone());
        }
        cid
    }

    /// REQ-639 port — see
    /// `GenericOtlpAdapter::generate_per_turn_correlation_id`.
    fn generate_per_turn_correlation_id(&self, session_id: &str) -> String {
        let counter = self
            .session_turn_counter
            .lock()
            .ok()
            .map(|mut m| {
                let entry = m.entry(session_id.to_string()).or_insert(0);
                *entry += 1;
                *entry
            })
            .unwrap_or(1);
        let new_cid = format!("{session_id}_{counter}");

        if let Ok(mut map) = self.session_to_correlation.lock() {
            if map.len() >= MAP_CAPACITY && !map.contains_key(session_id) {
                if let Some(oldest) = map.keys().next().cloned() {
                    map.remove(&oldest);
                }
            }
            map.insert(session_id.to_string(), new_cid.clone());
        }

        if let Ok(mut tm) = self.session_turn_counter.lock() {
            if tm.len() >= MAP_CAPACITY {
                if let Some(oldest) = tm.keys().next().cloned() {
                    tm.remove(&oldest);
                }
            }
        }

        new_cid
    }

    /// #2711/#2723/#2734 port — see `GenericOtlpAdapter::derive_turn_tokens`
    /// (classifier-owned baselines, identical clamp/reset/bounded semantics).
    fn derive_turn_tokens(
        &self,
        session_id: &str,
        op_name: &str,
        event_state: EventState,
        attrs: &serde_json::Map<String, Value>,
    ) -> Option<TurnTokenDerivation> {
        if op_name != OP_CHAT_CANON {
            return None;
        }
        let input_n_raw = attr_i64(attrs, ATTR_USAGE_INPUT_TOKENS);
        let output_n = attr_i64(attrs, ATTR_USAGE_OUTPUT_TOKENS);
        let cache_n = attr_i64(attrs, ATTR_USAGE_CACHE_READ_INPUT_TOKENS).unwrap_or(0);
        let has_cache = attrs.contains_key(ATTR_USAGE_CACHE_READ_INPUT_TOKENS);

        let completed_with_input = event_state == EventState::Response && input_n_raw.is_some();
        if !completed_with_input && !has_cache {
            return None;
        }

        let mut prev_input = 0i64;
        let (prompt_delta, session_context_tokens) = if completed_with_input {
            let input_n = input_n_raw.unwrap_or(0).max(0);
            let mut map = self.last_request_input.lock().ok()?;
            prev_input = map.get(session_id).copied().unwrap_or(0);
            let delta = (input_n - prev_input).max(0);
            if map.len() >= MAP_CAPACITY && !map.contains_key(session_id) {
                if let Some(oldest) = map.keys().next().cloned() {
                    map.remove(&oldest);
                }
            }
            map.insert(session_id.to_string(), input_n);
            (Some(delta), Some(input_n + cache_n))
        } else {
            (None, None)
        };

        let mut prev_cache = 0i64;
        let cache_read_delta = if has_cache {
            let mut cache_map = self.last_request_cache_read.lock().ok()?;
            prev_cache = cache_map.get(session_id).copied().unwrap_or(0);
            let cache_delta = (cache_n - prev_cache).max(0);
            if cache_map.len() >= MAP_CAPACITY && !cache_map.contains_key(session_id) {
                if let Some(oldest) = cache_map.keys().next().cloned() {
                    cache_map.remove(&oldest);
                }
            }
            cache_map.insert(session_id.to_string(), cache_n);
            Some(cache_delta)
        } else {
            None
        };

        tracing::debug!(
            target: "fredo::rtdb::ingest",
            session_id = %session_id,
            prev_input = prev_input,
            input_n = ?input_n_raw,
            prompt_delta = ?prompt_delta,
            completion = ?output_n,
            prev_cache = prev_cache,
            cache_read_delta = ?cache_read_delta,
            "RTDB per-turn token deltas (#2711 / #2723 ST-3)"
        );

        Some(TurnTokenDerivation {
            prompt_delta,
            completion: output_n,
            session_context_tokens,
            cache_read_delta,
        })
    }

    /// Instruction injection for subagent payloads (Spec #633 order:
    /// pending task instruction → parent prompt cache). rawJson parity with
    /// the v1 payload.
    fn inject_instruction_if_needed(
        &self,
        is_subagent: bool,
        session_id: &str,
        payload: &mut Value,
    ) {
        if !is_subagent {
            return;
        }
        let has_instruction = payload
            .get("instruction")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if has_instruction {
            return;
        }
        let parent = self
            .session_to_parent
            .lock()
            .ok()
            .and_then(|m| m.get(session_id).cloned())
            .filter(|p| p != session_id);
        let Some(parent) = parent else {
            return;
        };
        let instruction = self
            .pending_task_instructions
            .lock()
            .ok()
            .and_then(|m| m.get(&parent).cloned())
            .filter(|s| !s.trim().is_empty());
        if let Some(instruction) = instruction {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("instruction".to_string(), Value::String(instruction));
            }
            return;
        }
        if let (Ok(parent_prompts), Ok(session_to_parent)) =
            (self.parent_prompts.lock(), self.session_to_parent.lock())
        {
            parent_prompt_cache::req_2_inject_parent_prompt_as_instruction(
                &parent_prompts,
                &session_to_parent,
                session_id,
                payload,
            );
        }
    }

    // ── R-1e: relationship registry + re-key (ported from engine.rs:866-905) ──

    /// Register a child→parent relationship (idempotent per child; capped at
    /// [`MAP_CAPACITY`] with oldest-first eviction) and COPY the child's
    /// existing rows under the parent key. Returns the number of copied rows.
    fn register_relationship(&self, parent: &str, child: &str) -> usize {
        {
            let Ok(mut child_map) = self.child_to_parent.lock() else {
                return 0;
            };
            if child_map.contains_key(child) {
                return 0; // idempotent
            }
            if child_map.len() >= MAP_CAPACITY {
                if let Some(oldest_child) = child_map.keys().next().cloned() {
                    if let Some(oldest_parent) = child_map.remove(&oldest_child) {
                        if let Ok(mut rev) = self.parent_to_children.lock() {
                            if let Some(children) = rev.get_mut(&oldest_parent) {
                                children.retain(|c| c != &oldest_child);
                                if children.is_empty() {
                                    rev.remove(&oldest_parent);
                                }
                            }
                        }
                    }
                }
            }
            child_map.insert(child.to_string(), parent.to_string());
        }
        if let Ok(mut rev) = self.parent_to_children.lock() {
            rev.entry(parent.to_string()).or_default().push(child.to_string());
        }
        self.rekey_child_rows(parent, child)
    }

    /// The parent of a registered child session, if any.
    fn parent_of(&self, child: &str) -> Option<String> {
        self.child_to_parent
            .lock()
            .ok()
            .and_then(|m| m.get(child).cloned())
    }

    /// Copy the child's EXISTING rows under the parent key (the re-key).
    /// Child-keyed rows are LEFT INTACT — a re-key never removes rows (the
    /// binding `kind: remove` constraint). The cached ∪ persisted key set is
    /// read so rows inside the write-behind window are not missed.
    fn rekey_child_rows(&self, parent: &str, child: &str) -> usize {
        let mut copied = 0usize;

        if let Ok(chat_keys) = self.rtdb.cache().chat_keys_for_session(child) {
            for (_, corr) in chat_keys {
                if let Ok(Some(existing)) = self.rtdb.cache().get_chat(child, &corr) {
                    self.apply_chat(
                        chat_patch_from_row(&existing, parent),
                        Some((parent, child)),
                    );
                    copied += 1;
                }
            }
        }
        if let Ok(tool_keys) = self.rtdb.cache().tool_keys_for_session(child) {
            for (_, corr) in tool_keys {
                if let Ok(Some(existing)) = self.rtdb.cache().get_tool_use(child, &corr) {
                    self.apply_tool_use(tool_patch_from_row(&existing, parent));
                    copied += 1;
                }
            }
        }
        if let Ok(session_keys) = self.rtdb.cache().agent_session_keys_for_session(child) {
            for (_, corr) in session_keys {
                if let Ok(Some(existing)) = self.rtdb.cache().get_agent_session(child, &corr) {
                    self.apply_agent_session(session_patch_from_row(&existing, parent));
                    copied += 1;
                }
            }
        }
        if copied > 0 {
            tracing::debug!(
                target: "fredo::rtdb::ingest",
                parent = %parent,
                child = %child,
                copied = copied,
                "RTDB relationship re-key: child rows copied under the parent key (no removes)"
            );
        }
        copied
    }

    /// ECE `detect_and_register_relationship` port for the FredoEvent path
    /// (legacy metadata first — no exclusion, exactly as the engine; a
    /// non-`parent-child` metadata object falls through to the self-carried
    /// check, exactly as the engine; the self-carried path applies the
    /// internal-agent exclusion).
    fn detect_event_relationship(&self, event: &FredoEvent, payload: &Value) -> usize {
        if let Some(rel_type) = event
            .metadata
            .as_ref()
            .and_then(|m| m.get("relationship"))
            .and_then(|r| r.get("type"))
            .and_then(|t| t.as_str())
        {
            if rel_type == "parent-child" {
                let parent = event
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("relationship"))
                    .and_then(|r| r.get("parentSessionId"))
                    .and_then(|v| v.as_str());
                let child = event
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("relationship"))
                    .and_then(|r| r.get("childSessionId"))
                    .and_then(|v| v.as_str());
                if let (Some(parent), Some(child)) = (parent, child) {
                    return self.register_relationship(parent, child);
                }
            }
        }

        if let Some(parent) = event
            .parent_session_id
            .as_ref()
            .filter(|p| !p.is_empty() && p.as_str() != event.session_id)
        {
            // `engine.rs:855-864` port: payload identity keys decide the
            // internal tool-execution agent exclusion.
            let internal = ["agent", "agent.name", "name"]
                .iter()
                .filter_map(|key| payload.get(*key).and_then(|v| v.as_str()))
                .any(|name| INTERNAL_TOOL_EXECUTION_AGENTS.contains(&name));
            if internal {
                tracing::debug!(
                    target: "fredo::rtdb::ingest",
                    session_id = %event.session_id,
                    parent_session_id = %parent,
                    "Classifier: event relationship skipped — internal tool-execution agent session"
                );
                return 0;
            }
            return self.register_relationship(parent, &event.session_id);
        }
        0
    }

    // ── Merge-then-ingest helpers (P1.1 rules applied by the classifier) ─────

    fn apply_chat(&self, patch: ChatPatch, stamp: Option<(&str, &str)>) {
        let Some(session) = patch.session_id.clone() else {
            return;
        };
        let Some(corr) = patch.correlation_id.clone() else {
            return;
        };
        let existing = self.rtdb.cache().get_chat(&session, &corr).unwrap_or(None);
        let mut row = existing.unwrap_or_else(|| empty_chat_row(&session, &corr));
        let old = serde_json::to_value(&row).unwrap_or(Value::Null);
        apply_chat_patch(&mut row, &patch);
        if let Some((parent, child)) = stamp {
            row.parent_session_id = Some(parent.to_string());
            row.composited_child_session_id = Some(child.to_string());
        }
        let new = serde_json::to_value(&row).unwrap_or(Value::Null);
        let changed = changed_fields(&old, &new, CHAT_FIELDS);
        if let Err(e) = self.rtdb.ingest_row_upsert(IngestRow::Chat(row), &changed) {
            tracing::warn!(target: "fredo::rtdb::ingest", session_id = %session, correlation_id = %corr, error = %e, "chat row ingest failed");
        }
    }

    fn apply_tool_use(&self, patch: ToolUsePatch) {
        let Some(session) = patch.session_id.clone() else {
            return;
        };
        let Some(corr) = patch.correlation_id.clone() else {
            return;
        };
        let existing = self
            .rtdb
            .cache()
            .get_tool_use(&session, &corr)
            .unwrap_or(None);
        let mut row = existing.unwrap_or_else(|| empty_tool_row(&session, &corr));
        let old = serde_json::to_value(&row).unwrap_or(Value::Null);
        apply_tool_use_patch(&mut row, &patch);
        let new = serde_json::to_value(&row).unwrap_or(Value::Null);
        let changed = changed_fields(&old, &new, TOOL_USE_FIELDS);
        if let Err(e) = self.rtdb.ingest_row_upsert(IngestRow::ToolUse(row), &changed) {
            tracing::warn!(target: "fredo::rtdb::ingest", session_id = %session, correlation_id = %corr, error = %e, "tool-use row ingest failed");
        }
    }

    fn apply_agent_session(&self, patch: AgentSessionPatch) {
        let Some(session) = patch.session_id.clone() else {
            return;
        };
        let Some(corr) = patch.correlation_id.clone() else {
            return;
        };
        let existing = self
            .rtdb
            .cache()
            .get_agent_session(&session, &corr)
            .unwrap_or(None);
        let mut row = existing.unwrap_or_else(|| empty_session_row(&session, &corr));
        let old = serde_json::to_value(&row).unwrap_or(Value::Null);
        apply_agent_session_patch(&mut row, &patch);
        let new = serde_json::to_value(&row).unwrap_or(Value::Null);
        let changed = changed_fields(&old, &new, AGENT_SESSION_FIELDS);
        if let Err(e) = self.rtdb.ingest_row_upsert(IngestRow::AgentSession(row), &changed) {
            tracing::warn!(target: "fredo::rtdb::ingest", session_id = %session, correlation_id = %corr, error = %e, "agent-session row ingest failed");
        }
    }

    /// Ingest a child chat row, then (while a child→parent relationship is
    /// registered) also ingest a parent-keyed stamped copy — the parent-space
    /// composite. The copy's correlation id is the CHILD's per-turn id (the
    /// brief's "new correlation_id = child's turn id").
    fn ingest_chat_with_copy(&self, patch: ChatPatch, child: &str) -> usize {
        self.apply_chat(patch.clone(), None);
        let mut copied = 0usize;
        if let Some(parent) = self.parent_of(child) {
            let mut copy = patch;
            copy.session_id = Some(parent.clone());
            self.apply_chat(copy, Some((parent.as_str(), child)));
            copied += 1;
        }
        copied
    }

    fn ingest_tool_with_copy(&self, patch: ToolUsePatch, child: &str) -> usize {
        self.apply_tool_use(patch.clone());
        let mut copied = 0usize;
        if let Some(parent) = self.parent_of(child) {
            let mut copy = patch;
            copy.session_id = Some(parent.clone());
            self.apply_tool_use(copy);
            copied += 1;
        }
        copied
    }

    fn ingest_session_with_copy(&self, patch: AgentSessionPatch, child: &str) -> usize {
        self.apply_agent_session(patch.clone());
        let mut copied = 0usize;
        if let Some(parent) = self.parent_of(child) {
            let mut copy = patch;
            copy.session_id = Some(parent.clone());
            self.apply_agent_session(copy);
            copied += 1;
        }
        copied
    }
}

// ── Free helpers ─────────────────────────────────────────────────────────────

/// Bounded-map insert with oldest-first eviction (the adapter's cap pattern).
fn bounded_map_insert<V>(map: &mut HashMap<String, V>, key: &str, value: V) {
    if map.len() >= MAP_CAPACITY && !map.contains_key(key) {
        if let Some(oldest) = map.keys().next().cloned() {
            map.remove(&oldest);
        }
    }
    map.insert(key.to_string(), value);
}

/// Row `state` from the adapter-derived `EventState` (an ordinary field).
fn row_state_of(state: EventState) -> RowState {
    match state {
        EventState::Init => RowState::Init,
        EventState::Update => RowState::Update,
        EventState::Response => RowState::Response,
        EventState::Error => RowState::Error,
    }
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

/// Whether a span's attributes resolve to an internal OpenCode
/// tool-execution agent (`build`/`plan`) — `engine.rs:855-864` port extended
/// with the raw `gen_ai.agent.name` attribute the plugin stamps on every span.
fn is_internal_tool_execution_agent(attrs: &serde_json::Map<String, Value>) -> bool {
    ["agent", "agent.name", "name", ATTR_AGENT_NAME]
        .iter()
        .filter_map(|key| attrs.get(*key).and_then(|v| v.as_str()))
        .any(|name| INTERNAL_TOOL_EXECUTION_AGENTS.contains(&name))
}

fn attr_str(map: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

fn attr_i64(map: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    map.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
}

fn attr_f64(map: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok())))
}

fn str_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| payload.get(*k).and_then(|v| v.as_str()))
        .map(str::to_owned)
}

fn nested_str(payload: &Value, path: &[&str]) -> Option<String> {
    let mut current = payload;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str().map(str::to_owned)
}

fn i64_field(payload: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| {
        payload
            .get(*k)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
    })
}

fn nested_i64(payload: &Value, path: &[&str]) -> Option<i64> {
    let mut current = payload;
    for segment in path {
        current = current.get(*segment)?;
    }
    current
        .as_i64()
        .or_else(|| current.as_str().and_then(|s| s.parse::<i64>().ok()))
}

fn f64_field(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| {
        payload
            .get(*k)
            .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok())))
    })
}

/// Extract the concatenated text parts of the FIRST message with `role` from
/// the real opencode event shapes (`output.message.parts[].text` — AGENTS.md
/// mock-vs-real rule) and the mock recipe shape
/// (`message.content[].text`, `fredo-cli-events` recipe 2).
fn parts_text(payload: &Value, role: &str) -> Option<String> {
    for container in ["output", "message"] {
        let Some(message) = payload.get(container) else {
            continue;
        };
        // output → { message: { role, parts } } | message → { role, content }
        let message = message.get("message").unwrap_or(message);
        if let Some(msg_role) = message.get("role").and_then(|v| v.as_str()) {
            if msg_role != role {
                continue;
            }
        }
        let parts = message
            .get("parts")
            .or_else(|| message.get("content"))
            .and_then(|v| v.as_array());
        let Some(parts) = parts else { continue };
        let mut text = String::new();
        for part in parts {
            if let Some(part_type) = part.get("type").and_then(|v| v.as_str()) {
                if part_type != "text" {
                    continue;
                }
            }
            if let Some(content) = part.get("text").and_then(|v| v.as_str()) {
                text.push_str(content);
            }
        }
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
}

/// CamelCase field names whose values differ between the pre- and post-merge
/// row snapshots (the classifier computes its own merge input diff).
fn changed_fields(old: &Value, new: &Value, fields: &[&str]) -> Vec<String> {
    fields
        .iter()
        .filter(|f| old.get(**f) != new.get(**f))
        .map(|f| (*f).to_string())
        .collect()
}

fn empty_chat_row(session: &str, corr: &str) -> ChatRow {
    ChatRow {
        session_id: session.to_string(),
        correlation_id: corr.to_string(),
        seq: 0,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: rfc3339_now(),
        state: RowState::Init,
        user_message: None,
        agent_reply: None,
        prompt_tokens: None,
        completion_tokens: None,
        cache_read_tokens: None,
        cost_usd: None,
        model: None,
        parent_session_id: None,
        composited_child_session_id: None,
        raw_json: "{}".to_string(),
    }
}

fn empty_tool_row(session: &str, corr: &str) -> ToolUseRow {
    ToolUseRow {
        session_id: session.to_string(),
        correlation_id: corr.to_string(),
        seq: 0,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: rfc3339_now(),
        state: RowState::Init,
        tool_name: None,
        tool_success: None,
        tool_error: None,
        duration_ms: None,
        tool_input_json: None,
        tool_output_json: None,
        is_subagent: None,
        raw_json: "{}".to_string(),
    }
}

fn empty_session_row(session: &str, corr: &str) -> AgentSessionRow {
    AgentSessionRow {
        session_id: session.to_string(),
        correlation_id: corr.to_string(),
        seq: 0,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: rfc3339_now(),
        state: RowState::Init,
        total_tokens: None,
        total_messages: None,
        total_cost_usd: None,
        agent_name: None,
        raw_json: "{}".to_string(),
    }
}

/// Build a re-key chat patch from an existing child row: every content field
/// carried over, identity re-keyed to the parent (correlation id UNCHANGED —
/// the child's per-turn id is the new parent-space key).
fn chat_patch_from_row(existing: &ChatRow, parent: &str) -> ChatPatch {
    ChatPatch {
        session_id: Some(parent.to_string()),
        correlation_id: Some(existing.correlation_id.clone()),
        seq: None,
        started_at_ns: existing.started_at_ns,
        ended_at_ns: existing.ended_at_ns,
        updated_at: Some(rfc3339_now()),
        state: Some(existing.state),
        user_message: existing.user_message.clone(),
        agent_reply: existing.agent_reply.clone(),
        prompt_tokens: existing.prompt_tokens,
        completion_tokens: existing.completion_tokens,
        cache_read_tokens: existing.cache_read_tokens,
        cost_usd: existing.cost_usd,
        model: existing.model.clone(),
        parent_session_id: Some(parent.to_string()),
        composited_child_session_id: None, // stamped by apply_chat's copy path
        raw_json: Some(existing.raw_json.clone()),
    }
}

fn tool_patch_from_row(existing: &ToolUseRow, parent: &str) -> ToolUsePatch {
    ToolUsePatch {
        session_id: Some(parent.to_string()),
        correlation_id: Some(existing.correlation_id.clone()),
        seq: None,
        started_at_ns: existing.started_at_ns,
        ended_at_ns: existing.ended_at_ns,
        updated_at: Some(rfc3339_now()),
        state: Some(existing.state),
        tool_name: existing.tool_name.clone(),
        tool_success: existing.tool_success,
        tool_error: existing.tool_error.clone(),
        duration_ms: existing.duration_ms,
        tool_input_json: existing.tool_input_json.clone(),
        tool_output_json: existing.tool_output_json.clone(),
        is_subagent: existing.is_subagent,
        raw_json: Some(existing.raw_json.clone()),
    }
}

fn session_patch_from_row(existing: &AgentSessionRow, parent: &str) -> AgentSessionPatch {
    AgentSessionPatch {
        session_id: Some(parent.to_string()),
        correlation_id: Some(existing.correlation_id.clone()),
        seq: None,
        started_at_ns: existing.started_at_ns,
        ended_at_ns: existing.ended_at_ns,
        updated_at: Some(rfc3339_now()),
        state: Some(existing.state),
        total_tokens: existing.total_tokens,
        total_messages: existing.total_messages,
        total_cost_usd: existing.total_cost_usd,
        agent_name: existing.agent_name.clone(),
        raw_json: Some(existing.raw_json.clone()),
    }
}

/// FredoEvent → chat patch (IPC/CLI mock path). Extraction priority: the
/// canonical normalized fields first (userMessage / agentReply / promptTokens
/// …), then the nested info.* twins, then the real opencode event shape
/// (`output.message.parts[].text`) and the mock recipe shape
/// (`message.content[].text`) — real paths with mock fallbacks per the
/// AGENTS.md mock-vs-real rule.
fn chat_patch_from_event(
    event: &FredoEvent,
    payload: &Value,
    correlation: &str,
    state: RowState,
    updated_at: &str,
) -> ChatPatch {
    ChatPatch {
        session_id: Some(event.session_id.clone()),
        correlation_id: Some(correlation.to_string()),
        seq: None,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: Some(updated_at.to_string()),
        state: Some(state),
        user_message: str_field(payload, &["userMessage"])
            .or_else(|| nested_str(payload, &["info", "text"]))
            .or_else(|| parts_text(payload, "user")),
        agent_reply: str_field(payload, &["agentReply"])
            .or_else(|| nested_str(payload, &["part", "text"]))
            .or_else(|| parts_text(payload, "assistant")),
        prompt_tokens: i64_field(payload, &["promptTokens"])
            .or_else(|| nested_i64(payload, &["info", "turnInputTokens"])),
        completion_tokens: i64_field(payload, &["completionTokens"])
            .or_else(|| nested_i64(payload, &["info", "turnOutputTokens"])),
        cache_read_tokens: i64_field(payload, &["cacheReadTokens"])
            .or_else(|| nested_i64(payload, &["info", "turnCacheReadTokens"])),
        cost_usd: f64_field(payload, &["costUsd"]),
        model: str_field(payload, &["model"]).or_else(|| nested_str(payload, &["info", "modelID"])),
        parent_session_id: event.parent_session_id.clone(),
        composited_child_session_id: None,
        raw_json: Some(payload.to_string()),
    }
}

fn tool_patch_from_event(
    event: &FredoEvent,
    payload: &Value,
    correlation: &str,
    state: RowState,
    updated_at: &str,
) -> ToolUsePatch {
    ToolUsePatch {
        session_id: Some(event.session_id.clone()),
        correlation_id: Some(correlation.to_string()),
        seq: None,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: Some(updated_at.to_string()),
        state: Some(state),
        tool_name: event
            .tool_name
            .clone()
            .or_else(|| str_field(payload, &["toolName"])),
        tool_success: payload.get("toolSuccess").and_then(|v| v.as_bool()),
        tool_error: nested_str(payload, &["error", "message"]).or_else(|| {
            str_field(payload, &["toolError"])
        }),
        duration_ms: i64_field(payload, &["durationMs"]),
        tool_input_json: str_field(payload, &["input", "toolInputJson"]),
        tool_output_json: str_field(payload, &["output", "toolOutputJson"]),
        is_subagent: Some(
            payload
                .get("is_subagent")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || payload
                    .get("agent.type")
                    .and_then(|v| v.as_str())
                    .map(|s| s == "subagent")
                    .unwrap_or(false),
        ),
        raw_json: Some(payload.to_string()),
    }
}

fn session_patch_from_event(
    payload: &Value,
    session_id: &str,
    correlation: &str,
    state: RowState,
    updated_at: &str,
) -> AgentSessionPatch {
    AgentSessionPatch {
        session_id: Some(session_id.to_string()),
        correlation_id: Some(correlation.to_string()),
        seq: None,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: Some(updated_at.to_string()),
        state: Some(state),
        total_tokens: i64_field(payload, &["totalTokens"]),
        total_messages: i64_field(payload, &["totalMessages"]),
        total_cost_usd: f64_field(payload, &["totalCostUsd"]),
        agent_name: str_field(payload, &["agent", "name", "agentName"]),
        raw_json: Some(payload.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::comm::event::EventProvider;
    use crate::infrastructure::rtdb::flush::{FlushLoop, RowEmitter};
    use crate::infrastructure::rtdb::project::{RowChangeKind, RowDelivery};
    use crate::infrastructure::rtdb::store::RtdbStore;
    use crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry;
    use serde_json::json;
    use std::sync::Mutex;

    type Sink = Arc<Mutex<Vec<RowDelivery>>>;

    fn make_classifier() -> (tempfile::TempDir, Arc<IngestClassifier>, Arc<Rtdb>, Sink) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).expect("open store"));
        store.ensure_schema().expect("schema");
        let (cache, _rx) = crate::infrastructure::rtdb::cache::RtdbCache::new(store);
        let registry = Arc::new(SubscriptionRegistry::new());
        let sink: Sink = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&sink);
        let emitter: RowEmitter = Arc::new(move |deliveries: &[RowDelivery]| {
            capture
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(deliveries);
        });
        let flush = Arc::new(FlushLoop::new(emitter));
        let rtdb = Arc::new(Rtdb::new(cache, registry, flush));
        let classifier = Arc::new(IngestClassifier::new(Arc::clone(&rtdb)));
        (dir, classifier, rtdb, sink)
    }

    fn emitted(sink: &Sink) -> Vec<RowDelivery> {
        sink.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn attr(key: &str, value: impl Into<Value>) -> Value {
        json!({ "key": key, "value": { "stringValue": value.into() } })
    }

    fn attr_num(key: &str, value: i64) -> Value {
        json!({ "key": key, "value": { "intValue": value } })
    }

    fn envelope(spans: Vec<Value>) -> Value {
        json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{ "spans": spans }]
            }]
        })
    }

    fn chat_span(session: &str, span_id: &str, completed: bool, extra: Vec<Value>) -> Value {
        let mut span = json!({
            "name": "llm",
            "traceId": format!("trace-{session}-{span_id}"),
            "spanId": span_id,
            "attributes": [
                attr("gen_ai.operation.name", "chat"),
                attr("session.id", session),
                attr("gen_ai.input.messages",
                     "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"What is the weather?\"}]}]"),
                attr("gen_ai.output.messages",
                     "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"The weather is sunny.\"}]}]"),
                attr("gen_ai.response.model", "claude-sonnet-4")
            ]
        });
        if completed {
            span["endTimeUnixNano"] = json!("2000000000");
            span["startTimeUnixNano"] = json!("1000000000");
        }
        for item in extra {
            span["attributes"].as_array_mut().expect("attrs").push(item);
        }
        span
    }

    // ── R-4a: chat span → ChatRow with real-shape extract + per-turn deltas ──

    #[test]
    fn chat_span_classifies_to_chat_row_with_real_corpus_shapes() {
        let (_dir, classifier, rtdb, _sink) = make_classifier();
        // Real-corpus-shaped span (registry keys — realCorpus.ts / span_store
        // shapes): completed turn with usage + cost + model.
        let raw = envelope(vec![chat_span(
            "ses_chat1",
            "sp1",
            true,
            vec![
                attr_num("gen_ai.usage.input_tokens", 100),
                attr_num("gen_ai.usage.output_tokens", 50),
                attr_num("gen_ai.usage.cache_read.input_tokens", 512_000),
                json!({ "key": "cost_usd", "value": { "doubleValue": 0.0125 } }),
            ],
        )]);
        let rows = classifier.ingest_otlp(Transport::OtlpGrpc, &raw);
        assert!(rows >= 1, "a completed chat span must classify into a row");

        let row = rtdb
            .cache()
            .get_chat("ses_chat1", "ses_chat1_1")
            .expect("read")
            .expect("per-turn row exists under <session>_1 (REQ-639)");
        assert_eq!(row.state, RowState::Response, "completed span → Response");
        assert_eq!(row.user_message.as_deref(), Some("What is the weather?"));
        assert_eq!(row.agent_reply.as_deref(), Some("The weather is sunny."));
        assert_eq!(row.prompt_tokens, Some(100), "first-turn prompt = full input");
        assert_eq!(row.completion_tokens, Some(50));
        assert_eq!(
            row.cache_read_tokens,
            Some(512_000),
            "first-turn cache delta = full cumulative baseline"
        );
        assert_eq!(row.cost_usd, Some(0.0125), "flat cost_usd span attr");
        assert_eq!(row.model.as_deref(), Some("claude-sonnet-4"));
        assert_eq!(row.started_at_ns, Some(1_000_000_000));
        assert_eq!(row.ended_at_ns, Some(2_000_000_000));
    }

    // ── R-1f: #2711/#2723 per-turn delta baselines across multi-turn ──────────

    #[test]
    fn delta_baselines_across_multi_turn_preserve_2711_2723_semantics() {
        let (_dir, classifier, rtdb, _sink) = make_classifier();
        let turn = |input: i64, cache: i64| {
            envelope(vec![chat_span(
                "ses_delta",
                &format!("sp-{input}-{cache}"),
                true,
                vec![
                    attr_num("gen_ai.usage.input_tokens", input),
                    attr_num("gen_ai.usage.output_tokens", 40),
                    attr_num("gen_ai.usage.cache_read.input_tokens", cache),
                ],
            )])
        };

        classifier.ingest_otlp(Transport::OtlpGrpc, &turn(100, 512_000));
        classifier.ingest_otlp(Transport::OtlpGrpc, &turn(120, 513_000));
        // Compaction / out-of-order: input drops below the baseline → delta
        // clamped to 0 AND the baseline resets to the new reading.
        classifier.ingest_otlp(Transport::OtlpGrpc, &turn(50, 513_500));
        classifier.ingest_otlp(Transport::OtlpGrpc, &turn(60, 514_000));

        let row2 = rtdb
            .cache()
            .get_chat("ses_delta", "ses_delta_2")
            .expect("read")
            .expect("turn 2 row");
        assert_eq!(row2.prompt_tokens, Some(20), "input2 − input1");
        assert_eq!(row2.cache_read_tokens, Some(1_000), "cache2 − cache1");

        let row3 = rtdb
            .cache()
            .get_chat("ses_delta", "ses_delta_3")
            .expect("read")
            .expect("turn 3 row");
        assert_eq!(
            row3.prompt_tokens, None,
            "clamped-to-0 delta stores ABSENT — the P1.1 LastNonZero rule never \
             fills zero; the frontend renders 0 (R-3.3, same contract as v1)"
        );
        assert_eq!(row3.cache_read_tokens, Some(500));

        let row4 = rtdb
            .cache()
            .get_chat("ses_delta", "ses_delta_4")
            .expect("read")
            .expect("turn 4 row");
        assert_eq!(
            row4.prompt_tokens,
            Some(10),
            "next delta derives from the RESET baseline (60 − 50)"
        );
    }

    // ── R-4a: tool span → ToolUseRow, session span → AgentSessionRow ─────────

    #[test]
    fn tool_and_session_spans_classify_to_their_rows() {
        let (_dir, classifier, rtdb, _sink) = make_classifier();

        let tool = json!({
            "name": "fredo.tool.Bash",
            "traceId": "trace-tool",
            "spanId": "sp-tool",
            "endTimeUnixNano": "3000000000",
            "attributes": [
                attr("gen_ai.operation.name", "execute_tool"),
                attr("gen_ai.tool.name", "Bash"),
                attr("session.id", "ses_tool"),
                json!({ "key": "tool.success", "value": { "boolValue": false } }),
                attr("tool.error", "file not found"),
                attr_num("duration_ms", 120),
                attr("gen_ai.tool.call.arguments", "{\"command\":\"ls\"}"),
                attr("gen_ai.tool.call.result", "file1 file2")
            ]
        });
        classifier.ingest_otlp(Transport::OtlpGrpc, &envelope(vec![tool]));
        let tool_row = rtdb
            .cache()
            .get_tool_use("ses_tool", "ses_tool_1")
            .expect("read")
            .expect("tool row");
        assert_eq!(tool_row.tool_name.as_deref(), Some("Bash"));
        assert_eq!(tool_row.tool_success, Some(false), "false is a meaningful outcome");
        assert_eq!(tool_row.tool_error.as_deref(), Some("file not found"));
        assert_eq!(tool_row.duration_ms, Some(120));
        assert_eq!(tool_row.tool_input_json.as_deref(), Some("{\"command\":\"ls\"}"));
        assert_eq!(tool_row.tool_output_json.as_deref(), Some("file1 file2"));
        assert_eq!(tool_row.state, RowState::Response);

        let session = json!({
            "name": "run_agent",
            "traceId": "trace-session",
            "spanId": "sp-session",
            "attributes": [
                attr("gen_ai.operation.name", "run_agent"),
                attr("session.id", "ses_session"),
                attr("gen_ai.agent.name", "build"),
                attr_num("total_tokens", 59_200),
                attr_num("total_messages", 12),
                json!({ "key": "total_cost_usd", "value": { "doubleValue": 0.42 } })
            ]
        });
        classifier.ingest_otlp(Transport::OtlpGrpc, &envelope(vec![session]));
        // Ported correlation resolution (resolve_correlation_id, Init): the
        // FIRST session span of a pure-OTLP session generates the per-turn id
        // `<session>_1` — exactly the v1 adapter behavior (port, don't
        // re-design).
        let session_row = rtdb
            .cache()
            .get_agent_session("ses_session", "ses_session_1")
            .expect("read")
            .expect("session-level row (v1-faithful per-turn correlation)");
        assert_eq!(session_row.total_tokens, Some(59_200));
        assert_eq!(session_row.total_messages, Some(12));
        assert_eq!(session_row.total_cost_usd, Some(0.42));
        assert_eq!(session_row.agent_name.as_deref(), Some("build"));
        assert_eq!(
            session_row.state,
            RowState::Init,
            "REQ-609: session spans always Init — never Response"
        );
    }

    // ── ST9 (#2688): one correlation id per span, no counter double-advance ──

    #[test]
    fn st9_guard_dual_export_shares_one_correlation_and_one_row() {
        let (_dir, classifier, rtdb, _sink) = make_classifier();
        // Streaming open-then-complete: the same spanId exported twice.
        classifier.ingest_otlp(
            Transport::OtlpGrpc,
            &envelope(vec![chat_span("ses_st9", "sp-1", false, vec![])]),
        );
        classifier.ingest_otlp(
            Transport::OtlpGrpc,
            &envelope(vec![chat_span("ses_st9", "sp-1", true, vec![])]),
        );

        let row = rtdb
            .cache()
            .get_chat("ses_st9", "ses_st9_1")
            .expect("read")
            .expect("one row for the dual export");
        assert_eq!(row.state, RowState::Response, "completed export wins (LastWins)");
        // The counter must NOT have double-advanced: the NEXT span is turn 2.
        classifier.ingest_otlp(
            Transport::OtlpGrpc,
            &envelope(vec![chat_span("ses_st9", "sp-2", true, vec![])]),
        );
        assert!(
            rtdb
                .cache()
                .get_chat("ses_st9", "ses_st9_2")
                .expect("read")
                .is_some(),
            "one turn → one correlation id (no phantom turn between)"
        );
    }

    // ── R-4a: unconditional ingest (no subscriber → rows still stored) ───────

    #[test]
    fn ingest_is_unconditional_without_subscribers() {
        let (_dir, classifier, rtdb, sink) = make_classifier();
        assert_eq!(rtdb.registry().subscription_count(), 0);
        classifier.ingest_otlp(
            Transport::OtlpGrpc,
            &envelope(vec![chat_span(
                "ses_uncond",
                "sp-1",
                true,
                vec![attr_num("gen_ai.usage.input_tokens", 42)],
            )]),
        );
        let row = rtdb
            .cache()
            .get_chat("ses_uncond", "ses_uncond_1")
            .expect("read")
            .expect("row stored with NO subscription — replay-critical");
        assert_eq!(row.prompt_tokens, Some(42));
        assert!(emitted(&sink).is_empty(), "no subscriber → no deliveries");
    }

    // ── R-1e: relationship registration + re-key (no removes, stamps) ────────

    #[test]
    fn relationship_registration_copies_child_rows_under_the_parent_key() {
        let (_dir, classifier, rtdb, sink) = make_classifier();
        rtdb.subscribe(
            &["chat(sessionId = \"parent-s\") { userMessage, parentSessionId, compositedChildSessionId }".to_string()],
            false,
            Some(0),
        )
        .expect("subscribe");
        assert!(emitted(&sink).is_empty());

        // Turn 1 of the child: keyed under the CHILD session — no parent yet.
        classifier.ingest_otlp(
            Transport::OtlpGrpc,
            &envelope(vec![chat_span(
                "child-s",
                "sp-c1",
                true,
                vec![attr_num("gen_ai.usage.input_tokens", 10)],
            )]),
        );
        assert!(
            emitted(&sink).is_empty(),
            "child-keyed rows do not match the parent query"
        );
        assert!(
            rtdb
                .cache()
                .get_chat("child-s", "child-s_1")
                .expect("read")
                .is_some(),
            "child-keyed row intact"
        );

        // Turn 2 carries the parent attribution (session.parent_id) + a real
        // agent name → registers the relationship and re-keys.
        classifier.ingest_otlp(
            Transport::OtlpGrpc,
            &envelope(vec![chat_span(
                "child-s",
                "sp-c2",
                true,
                vec![
                    attr("session.parent_id", "parent-s"),
                    attr("gen_ai.agent.name", "general"),
                ],
            )]),
        );

        let deliveries = emitted(&sink);
        assert!(
            !deliveries.is_empty(),
            "parent-keyed copies must arrive as first-match inserts (SubagentNode creation)"
        );
        assert!(
            deliveries.iter().all(|d| d.kind != RowChangeKind::Remove),
            "BINDING: a re-key NEVER emits kind: remove"
        );
        for delivery in &deliveries {
            assert_eq!(delivery.key.session_id, "parent-s");
            let patch = delivery
                .patch
                .as_ref()
                .and_then(|p| p.as_object())
                .expect("patch");
            assert_eq!(
                patch.get("compositedChildSessionId"),
                Some(&json!("child-s")),
                "#523 stamp — the original child id on composited rows"
            );
            assert_eq!(patch.get("parentSessionId"), Some(&json!("parent-s")));
        }

        // The child's existing rows are queryable under BOTH keys.
        let child_row = rtdb
            .cache()
            .get_chat("child-s", "child-s_1")
            .expect("read")
            .expect("child row intact");
        assert_eq!(child_row.prompt_tokens, Some(10));
        let copied = rtdb
            .cache()
            .get_chat("parent-s", "child-s_1")
            .expect("read")
            .expect("EXISTING child row copied under the parent key");
        assert_eq!(copied.prompt_tokens, Some(10), "row content carried over");
        assert_eq!(copied.composited_child_session_id.as_deref(), Some("child-s"));
        assert_eq!(copied.parent_session_id.as_deref(), Some("parent-s"));
        // The new (turn-2) row is also composited into the parent space.
        assert!(
            rtdb
                .cache()
                .get_chat("parent-s", "child-s_2")
                .expect("read")
                .is_some(),
            "post-registration child rows also copy under the parent key"
        );
    }

    #[test]
    fn internal_build_plan_agents_are_excluded_from_relationships() {
        let (_dir, classifier, rtdb, sink) = make_classifier();
        rtdb.subscribe(
            &["chat(sessionId = \"parent-x\") { userMessage }".to_string()],
            false,
            Some(0),
        )
        .expect("subscribe");

        classifier.ingest_otlp(
            Transport::OtlpGrpc,
            &envelope(vec![chat_span(
                "child-build",
                "sp-b1",
                true,
                vec![
                    attr("session.parent_id", "parent-x"),
                    attr("gen_ai.agent.name", "build"),
                ],
            )]),
        );

        assert!(
            emitted(&sink).is_empty(),
            "internal tool-execution agents register NO relationship (AGENTS.md #509)"
        );
        assert!(
            rtdb
                .cache()
                .get_chat("parent-x", "child-build_1")
                .expect("read")
                .is_none(),
            "no parent-keyed copy was created"
        );
        assert!(
            rtdb
                .cache()
                .get_chat("child-build", "child-build_1")
                .expect("read")
                .is_some(),
            "the child row itself is still ingested"
        );
    }

    // ── Dual-feed coexistence: rows keyed at the SAME composite keys as v1 ────

    #[test]
    fn row_keys_match_the_v1_adapter_composite_keys() {
        let adapter = GenericOtlpAdapter::new();
        let (_dir, classifier, rtdb, _sink) = make_classifier();
        let raw = envelope(vec![chat_span("ses_dual", "sp-1", true, vec![])]);

        // The v1 adapter consumes the SAME export (grpc.rs order)...
        let inputs = adapter
            .transform(Transport::OtlpGrpc, raw.clone())
            .expect("transform");
        assert!(!inputs.is_empty());
        let adapter_corr = inputs[0].correlation_id.clone().expect("correlation id");
        // ...and the classifier classifies it independently — the row MUST
        // land at the same composite key the v1 ECE buffer uses.
        classifier.ingest_otlp(Transport::OtlpGrpc, &raw);

        let row = rtdb
            .cache()
            .get_chat("ses_dual", &adapter_corr)
            .expect("read")
            .expect("row keyed at the SAME composite key as the v1 ECE buffer");
        assert_eq!(row.state, RowState::Response);
    }

    // ── IPC/CLI mock path (ingest_event) ─────────────────────────────────────

    fn fredo_event(
        event_type: EventType,
        state: EventState,
        session: &str,
        payload: Value,
    ) -> FredoEvent {
        let mut event = FredoEvent::new(event_type, state);
        event.provider = EventProvider::OpenCode;
        event.session_id = session.to_string();
        event.payload = Some(payload);
        event
    }

    #[test]
    fn ingest_event_maps_cli_mock_payloads_to_rows() {
        let (_dir, classifier, rtdb, _sink) = make_classifier();

        let chat = fredo_event(
            EventType::Chat,
            EventState::Init,
            "e2e-session-1",
            json!({
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "e2e-test: hello from mock event" }] }
            }),
        );
        classifier.ingest_event(&chat);
        let row = rtdb
            .cache()
            .get_chat("e2e-session-1", "e2e-session-1")
            .expect("read")
            .expect("mock chat event → chat row keyed by session (no correlation id)");
        assert_eq!(row.state, RowState::Init);

        // Canonical normalized fields (adapter-normalized payloads).
        let mut chat2 = fredo_event(
            EventType::Chat,
            EventState::Response,
            "e2e-session-2",
            json!({
                "userMessage": "fix the bug",
                "agentReply": "done",
                "promptTokens": 25,
                "completionTokens": 12
            }),
        );
        chat2.correlation_id = Some("e2e-corr-1".to_string());
        classifier.ingest_event(&chat2);
        let row2 = rtdb
            .cache()
            .get_chat("e2e-session-2", "e2e-corr-1")
            .expect("read")
            .expect("correlation-id-keyed row");
        assert_eq!(row2.user_message.as_deref(), Some("fix the bug"));
        assert_eq!(row2.agent_reply.as_deref(), Some("done"));
        assert_eq!(row2.prompt_tokens, Some(25));
        assert_eq!(row2.state, RowState::Response);

        let mut tool = fredo_event(
            EventType::ToolUse,
            EventState::Error,
            "e2e-tool-1",
            json!({ "error": { "message": "intentional error for testing" } }),
        );
        tool.tool_name = Some("terminal".to_string());
        classifier.ingest_event(&tool);
        let tool_row = rtdb
            .cache()
            .get_tool_use("e2e-tool-1", "e2e-tool-1")
            .expect("read")
            .expect("mock tool event → tool row");
        assert_eq!(tool_row.tool_name.as_deref(), Some("terminal"));
        assert_eq!(
            tool_row.tool_error.as_deref(),
            Some("intentional error for testing")
        );
        assert_eq!(tool_row.state, RowState::Error);

        let session = fredo_event(
            EventType::AgentSession,
            EventState::Response,
            "e2e-lifecycle-1",
            json!({ "totalTokens": 1024, "totalMessages": 3, "agent": "opencode" }),
        );
        classifier.ingest_event(&session);
        let session_row = rtdb
            .cache()
            .get_agent_session("e2e-lifecycle-1", "e2e-lifecycle-1")
            .expect("read")
            .expect("mock session event → agent-session row");
        assert_eq!(session_row.total_tokens, Some(1024));
        assert_eq!(session_row.agent_name.as_deref(), Some("opencode"));

        // Non-row-bearing event types classify to nothing.
        let infra = fredo_event(EventType::Infrastructure, EventState::Init, "e2e-diag", json!({}));
        assert_eq!(classifier.ingest_event(&infra), 0);
    }

    #[test]
    fn ingest_event_registers_relationships_and_rekeys() {
        let (_dir, classifier, rtdb, _sink) = make_classifier();
        // A child event with the self-carried parent property + payload agent
        // name — registers and re-keys (build/plan excluded).
        let mut child = fredo_event(
            EventType::Chat,
            EventState::Init,
            "child-e2e",
            json!({ "userMessage": "child turn", "agent": "general" }),
        );
        child.parent_session_id = Some("parent-e2e".to_string());
        classifier.ingest_event(&child);

        let copied = rtdb
            .cache()
            .get_chat("parent-e2e", "child-e2e")
            .expect("read")
            .expect("child row copied under the parent key");
        assert_eq!(copied.composited_child_session_id.as_deref(), Some("child-e2e"));
        assert_eq!(copied.parent_session_id.as_deref(), Some("parent-e2e"));

        // build/plan exclusion.
        let mut internal = fredo_event(
            EventType::Chat,
            EventState::Init,
            "child-build-e2e",
            json!({ "userMessage": "internal turn", "agent": "plan" }),
        );
        internal.parent_session_id = Some("parent-e2e".to_string());
        classifier.ingest_event(&internal);
        assert!(
            rtdb
                .cache()
                .get_chat("parent-e2e", "child-build-e2e")
                .expect("read")
                .is_none(),
            "internal tool-execution agent (plan) never registers"
        );
    }
}
