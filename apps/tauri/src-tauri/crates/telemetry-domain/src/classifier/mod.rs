//! IngestClassifier — the RTDB write-path classifier (Spec #2788, P3.1,
//! REQs R-1e/R-1f/R-4a/R-4b/R-4d), now the domain crate's classifier
//! (Spec #3201 ST-5 moved it here and split it by row family).
//!
//! Owns the correlation-state maps the deleted v1 delivery adapter kept for its
//! pipeline, re-homed to the row pipeline: each incoming span is classified
//! into zero or more canonical [`RowUpsert`]s handed to the [`RowSink`] port
//! (the merge-then-ingest rules live in this crate; durable seq, subscriptions,
//! flush and IPC live behind the port). This classifier is the ONLY write path
//! into the row store.
//!
//! The split follows the row families (Spec #3201's target tree):
//!
//! | Module | Content |
//! |---|---|
//! | [`session`] | the agent-session row family (`run_agent` spans) |
//! | [`turn`] | the chat-turn row family + the per-turn token deltas |
//! | [`tool`] | the tool-use row family (`execute_tool` spans) |
//! | [`agent`] | per-span classification, agent identity, span timing |
//! | [`relationship`] | child→parent registration, the re-key, instruction injection, and the parent-prompt cache helpers |
//!
//! ## Ported state (copy-preserve — same caps, same eviction, same logic)
//!
//! - The 9 correlation maps of the deleted v1 OTLP adapter
//!   (relocated pure helpers live in [`crate::attrs`]):
//!   `trace_to_session`, `session_to_correlation`, `span_to_correlation` (ST9
//!   #2688 double-advance guard), `session_to_parent`, `session_turn_counter`
//!   (REQ-639), `pending_task_instructions` (#633), `parent_prompts`
//!   (the [`relationship`] helpers, reused verbatim),
//!   `last_request_input` / `last_request_cache_read` (#2711/#2723 token-delta
//!   baselines). All capped at [`crate::attrs::MAP_CAPACITY`] (10 000) with
//!   oldest-first eviction — identical bounded-state semantics (NFR-2).
//! - The ECE relationship registry (`contract/engine.rs:53-55`):
//!   `child_to_parent` / `parent_to_children`, cap 10 000 oldest-first
//!   eviction, internal `build`/`plan` agent exclusion (AGENTS.md #509 rule).
//!
//! ## Row derivation (R-4a)
//!
//! Every span classified — UNCONDITIONALLY, never gated by subscriptions
//! (that is what makes replay work). Extract paths are the adapter's
//! production paths, reused via crate visibility (one source of truth;
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
//! - The re-key reads the cached ∪ persisted key set through
//!   [`RowSink::keys_for_session`] so rows still inside the ~30 ms write-behind
//!   window are not missed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::attrs::{otlp_attrs_to_map, resolve_provider_token, MAP_CAPACITY};
use crate::event::{EventState, EventType, FredoEvent, Transport};
use crate::merge::{AgentSessionPatch, ChatPatch, ToolUsePatch};
use crate::rows::{RowKind, RowState};
use crate::RowSink;

pub mod agent;
pub mod relationship;
pub mod session;
pub mod tool;
pub mod turn;

use session::session_patch_from_event;
use tool::tool_patch_from_event;
use turn::chat_patch_from_event;

/// Managed-state alias — `app.manage(Arc::new(IngestClassifier::new(sink)))`
/// on the platform side; consumed by the OTLP receivers + the IPC dispatcher.
pub type IngestClassifierState = Arc<IngestClassifier>;

/// Outcome of one [`IngestClassifier::reattribute_provider`] call
/// (Spec #2932 round-2 FIX-R2-1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderReattribution {
    /// The row's provider slot was written — a documented fallback was upgraded
    /// to a resolved token.
    Upgraded,
    /// No write: the row already carried a resolved token, or the re-derived
    /// token equalled the stored fallback (the content-no-op gate skipped it).
    Unchanged,
    /// The matched spans disagreed on the provider token — nothing written
    /// (never guess).
    Ambiguous,
    /// No matched span in the row's op family — nothing written.
    NoSource,
}

/// The RTDB write-path classifier (module doc — Spec #2788 P3.1).
pub struct IngestClassifier {
    /// The row sink — the classifier's one outward dependency (Spec #3201 AC6).
    sink: Arc<dyn RowSink>,

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
    /// Create the classifier over a row sink (Spec #3201 AC6 — the port is the
    /// classifier's only outward dependency; it never names the platform's
    /// composition root).
    pub fn new(sink: Arc<dyn RowSink>) -> Self {
        IngestClassifier {
            sink,
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
    /// JSON) into row upserts. Returns the number of row mutations ingested.
    /// P3.2's backfill MUST reuse THIS entry point (reconstructed span JSON)
    /// so the extract rules stay identical to the live path.
    pub async fn ingest_otlp(&self, transport: Transport, raw: &Value) -> usize {
        tracing::debug!(
            target: "fredo::rtdb::ingest",
            transport = transport.as_str(),
            "RTDB ingest classifier receiving an OTLP export"
        );
        let mut count = 0usize;

        if let Some(resource_spans) = raw.get("resourceSpans").and_then(|v| v.as_array()) {
            for rs in resource_spans {
                let res_attrs = otlp_attrs_to_map(
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
                        count += self.process_span_rows(span, span_name, &res_attrs, true).await;
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
        count += self.process_span_rows(raw, raw_name, &empty_res, false).await;
        count
    }

    /// Classify a `FredoEvent` (the IPC/`fredo emit` CLI path — the mock
    /// payload shapes follow the `fredo-cli-events` skill conventions; real
    /// OTLP-derived rows remain the primary shape per the AGENTS.md
    /// mock-vs-real rule) into row upserts. Only the three row-bearing event
    /// types classify; others are ignored.
    pub async fn ingest_event(&self, event: &FredoEvent) -> usize {
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
        let mut copied = self.detect_event_relationship(event, &payload).await;

        match event.event_type {
            EventType::Chat => {
                let patch =
                    chat_patch_from_event(event, &payload, &correlation, state, &updated_at);
                copied += self.ingest_chat_with_copy(patch, &event.session_id).await;
            }
            EventType::ToolUse => {
                let patch =
                    tool_patch_from_event(event, &payload, &correlation, state, &updated_at);
                copied += self.ingest_tool_with_copy(patch, &event.session_id).await;
            }
            EventType::AgentSession => {
                let patch = session_patch_from_event(
                    &payload,
                    &event.session_id,
                    &correlation,
                    state,
                    &updated_at,
                    event.provider.as_str(),
                );
                copied += self.ingest_session_with_copy(patch, &event.session_id).await;
            }
            EventType::Infrastructure | EventType::Ui | EventType::Custom => {}
        }
        copied
    }

    /// Upgrade the provider attribution of a PRE-EXISTING row, addressed by the
    /// row's OWN persisted identity `(session_id, correlation_id)`
    /// (Spec #2932 round-2 FIX-R2-1).
    ///
    /// The token is resolved with the SAME shared rule the live path uses
    /// ([`resolve_provider_token`], NFR-6) — never a second extraction path.
    /// The correlation-MINTING path (`resolve_span_correlation_id` /
    /// `resolve_correlation_id` / `generate_per_turn_correlation_id`) is NEVER
    /// called: the re-derivation pass cannot reproduce the historical
    /// per-process correlation key, so it must write AT the row's own key
    /// instead of minting one. Round-1 tester FAIL: a re-minted key targeted a
    /// different PK `(session_id, correlation_id)` and INSERTed a PARALLEL row
    /// while the pre-existing `unknown` row was never read, never patched.
    ///
    /// `candidates` are the span attribute maps the caller matched to this row
    /// (already filtered to the row's op family via the shared
    /// `attrs::resolve_op_name`). No candidates → [`ProviderReattribution::NoSource`];
    /// candidates disagreeing on the token → [`ProviderReattribution::Ambiguous`].
    /// Both write nothing (never guess). A one-token patch is dispatched
    /// through the existing [`Self::apply_chat`] / [`Self::apply_tool_use`] /
    /// [`Self::apply_agent_session`] path, so durable seq allocation, delivery
    /// routing and cache semantics are preserved; the patch carries ONLY
    /// `session_id` / `correlation_id` / `updated_at` / `provider`, and every
    /// other field stays `None` — absent patch fields are skipped by
    /// `merge::apply_rule`, so the row's existing content is untouched.
    ///
    /// Defensive: a missing or unreadable target row writes NOTHING. The pass
    /// only ever targets rows it just enumerated, but without this guard a
    /// failed lookup would fall through to the apply path's full-row upsert
    /// and replace a live full row with a minimal one (data loss).
    pub async fn reattribute_provider(
        &self,
        kind: RowKind,
        session_id: &str,
        correlation_id: &str,
        candidates: &[serde_json::Map<String, Value>],
    ) -> ProviderReattribution {
        // Distinct tokens across the matched spans — the shared rule only.
        let mut tokens: Vec<String> = Vec::new();
        for attrs in candidates {
            let token = resolve_provider_token(attrs);
            if !tokens.contains(&token) {
                tokens.push(token);
            }
        }
        match tokens.len() {
            0 => return ProviderReattribution::NoSource,
            1 => {}
            _ => {
                tracing::debug!(
                    target: "fredo::rtdb::ingest",
                    session_id = %session_id,
                    correlation_id = %correlation_id,
                    "provider re-attribution skipped — matched spans disagree on the resource identity"
                );
                return ProviderReattribution::Ambiguous;
            }
        }
        // The target row must already exist — never create one, never let a
        // failed lookup degrade into an empty-row INSERT over a live row.
        let target_present = self
            .sink
            .get_row(kind, session_id, correlation_id)
            .await
            .map(|row| row.is_some())
            .unwrap_or(false);
        if !target_present {
            tracing::debug!(
                target: "fredo::rtdb::ingest",
                session_id = %session_id,
                correlation_id = %correlation_id,
                "provider re-attribution skipped — target row absent"
            );
            return ProviderReattribution::Unchanged;
        }
        let token = tokens.into_iter().next().expect("token list has exactly one element");
        let updated_at = Some(rfc3339_now());
        let wrote = match kind {
            RowKind::Chat => self.apply_chat(
                ChatPatch {
                    session_id: Some(session_id.to_string()),
                    correlation_id: Some(correlation_id.to_string()),
                    updated_at,
                    provider: Some(token),
                    ..ChatPatch::default()
                },
                None,
            ).await,
            RowKind::ToolUse => self.apply_tool_use(ToolUsePatch {
                session_id: Some(session_id.to_string()),
                correlation_id: Some(correlation_id.to_string()),
                updated_at,
                provider: Some(token),
                ..ToolUsePatch::default()
            }).await,
            RowKind::AgentSession => self.apply_agent_session(AgentSessionPatch {
                session_id: Some(session_id.to_string()),
                correlation_id: Some(correlation_id.to_string()),
                updated_at,
                provider: Some(token),
                ..AgentSessionPatch::default()
            }).await,
        };
        if wrote {
            ProviderReattribution::Upgraded
        } else {
            ProviderReattribution::Unchanged
        }
    }

    // ── Correlation resolution (ported verbatim from adapters/otlp.rs) ────────

    /// ST9 (#2688) port — one correlation id per span (see
    /// [`crate::attrs`] for the retained shared extract helpers).
    ///
    /// Spec #2933 (R-4.2): the provider-scoped promoted Copilot session root
    /// (`invoke_agent` → [`crate::attrs::OP_SESSION`], ST-2) is routed through
    /// the SAME span-keyed guard as every other span. Without this, a replayed
    /// (or late-duplicated) export would re-mint the root's per-turn
    /// correlation id and land it at a NEW `(sessionId, correlationId)` PK — a
    /// second `agent_session_rows` row at the same `startedAtNs`. The guard
    /// reuses the id the span already resolved to for THIS classifier instance,
    /// so a replay is a content no-op.
    ///
    /// The span-keyed route is byte-identical to the session-keyed route on
    /// the FIRST sight of the root: with no prior resolution it mints via
    /// `resolve_correlation_id(session, Init)` (`<session>_1` for the first
    /// span of a session). It only diverges on a re-seen span — the duplicate
    /// we must not create. Kept provider-scoped (checks the shared
    /// [`crate::attrs::PROVIDER_COPILOT_CLI`] token) so the OpenCode
    /// `run_agent` root keeps its historical session-keyed resolution
    /// byte-for-byte (R-5.1/AC5).
    fn resolve_span_correlation_id(
        &self,
        session_id: &str,
        span_id: &str,
        op_name: &str,
        event_state: EventState,
        provider: &str,
    ) -> String {
        if op_name == crate::attrs::OP_SESSION && provider != crate::attrs::PROVIDER_COPILOT_CLI {
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
    /// REQ-3/REQ-609 correlation bridging port (session-keyed, one row per
    /// session; Hook-bridged sessions reuse the Hook correlation id).
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
    /// REQ-639 per-turn correlation id port (`{session_id}_{turn}`).
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
}

// ── Free helpers shared across the classifier's row families ──────────────────

/// Row `state` from the adapter-derived `EventState` (an ordinary field).
fn row_state_of(state: EventState) -> RowState {
    match state {
        EventState::Init => RowState::Init,
        EventState::Update => RowState::Update,
        EventState::Response => RowState::Response,
        EventState::Error => RowState::Error,
    }
}

fn str_field(payload: &Value, keys: &[&str]) -> Option<String> {    keys.iter()
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

/// P3.2 idempotency gate: a merge into an EXISTING row that changed nothing
/// but the wall-clock `updatedAt` stamp is a content no-op — the write is
/// skipped entirely (no seq allocation, no delivery), so re-deriving
/// identical content (canonical-backfill re-runs, duplicate span exports)
/// never bumps seq. New rows always write.
fn content_no_op(existed: bool, changed: &[String]) -> bool {
    existed && changed.iter().all(|field| field == "updatedAt")
}

/// RFC3339 "now" — the established `chrono::Utc::now().to_rfc3339()` pattern.
///
/// Spec #3201 §1 edge 5b: deliberately a PRIVATE copy, not a shared rule. It is
/// a one-line timestamp formatter, not an attribute-extraction path, so NFR-6
/// (one extraction path for live and backfill) does not apply to it. Recorded
/// here so it is never mistaken for a fork of a domain rule.
fn rfc3339_now() -> String {
    chrono::Utc::now().to_rfc3339()
}
