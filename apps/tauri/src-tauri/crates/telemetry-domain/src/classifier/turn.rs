//! The chat-turn row family — `chat` spans, the merge-then-ingest write path
//! for [`ChatRow`], the parent-keyed copy, and the per-turn token-delta
//! derivation (#2711/#2723 ST-3).
//!
//! Moved verbatim from `infrastructure/rtdb/ingest.rs` by Spec #3201 ST-5; the
//! logic is unchanged, only its location and its two boundary types
//! (`RowUpsert` / [`RowSink`] instead of `IngestRow` / `Rtdb`).
//!
//! **Cost never double-counts**: `promptTokens` / `cacheReadTokens` are
//! per-turn DELTAS against the session-cumulative baselines held in the
//! classifier's `last_request_input` / `last_request_cache_read` maps, clamped
//! ≥ 0 and reset by an out-of-order (smaller) cumulative reading. This module
//! owns that derivation.

use serde_json::Value;

use super::{
    attr_i64, changed_fields, content_no_op, f64_field, i64_field, nested_i64, nested_str,
    parts_text, rfc3339_now, str_field,
};
use crate::attrs::{
    resolve_provider_token, TurnTokenDerivation, ATTR_USAGE_CACHE_READ_INPUT_TOKENS,
    ATTR_USAGE_INPUT_TOKENS, ATTR_USAGE_OUTPUT_TOKENS, MAP_CAPACITY, OP_CHAT_CANON,
    PROVIDER_COPILOT_CLI,
};
use crate::event::{EventState, FredoEvent};
use crate::merge::{apply_chat_patch, ChatPatch};
use crate::rows::{ChatRow, RowKind, RowState, RowUpsert, CHAT_FIELDS};

impl super::IngestClassifier {
    /// Merge-then-ingest one chat patch. Returns `true` when the row was
    /// actually written (a new row, or a content change past the no-op gate).
    pub(crate) async fn apply_chat(
        &self,
        patch: ChatPatch,
        stamp: Option<(&str, &str)>,
    ) -> bool {
        let Some(session) = patch.session_id.clone() else {
            return false;
        };
        let Some(corr) = patch.correlation_id.clone() else {
            return false;
        };
        let existing = self
            .sink
            .get_row(RowKind::Chat, &session, &corr)
            .await
            .unwrap_or(None)
            .and_then(|row| match row {
                RowUpsert::Chat(row) => Some(row),
                _ => None,
            });
        let existed = existing.is_some();
        let mut row = existing.unwrap_or_else(|| empty_chat_row(&session, &corr));
        let old = serde_json::to_value(&row).unwrap_or(Value::Null);
        apply_chat_patch(&mut row, &patch);
        if let Some((parent, child)) = stamp {
            row.parent_session_id = Some(parent.to_string());
            row.composited_child_session_id = Some(child.to_string());
        }
        let new = serde_json::to_value(&row).unwrap_or(Value::Null);
        let changed = changed_fields(&old, &new, CHAT_FIELDS);
        if content_no_op(existed, &changed) {
            return false;
        }
        if let Err(e) = self
            .sink
            .ingest_row_upsert(RowUpsert::Chat(row), &changed)
            .await
        {
            tracing::warn!(target: "fredo::rtdb::ingest", session_id = %session, correlation_id = %corr, error = %e, "chat row ingest failed");
            return false;
        }
        true
    }

    /// Ingest a child chat row, then (while a child→parent relationship is
    /// registered) also ingest a parent-keyed stamped copy — the parent-space
    /// composite. The copy's correlation id is the CHILD's per-turn id (the
    /// brief's "new correlation_id = child's turn id").
    pub(crate) async fn ingest_chat_with_copy(&self, patch: ChatPatch, child: &str) -> usize {
        self.apply_chat(patch.clone(), None).await;
        let mut copied = 0usize;
        if let Some(parent) = self.parent_of(child) {
            let mut copy = patch;
            copy.session_id = Some(parent.clone());
            self.apply_chat(copy, Some((parent.as_str(), child))).await;
            copied += 1;
        }
        copied
    }

    /// #2711/#2723/#2734 port — per-turn token deltas against the classifier-
    /// owned cumulative baselines (identical clamp/reset/bounded semantics).
    pub(crate) fn derive_turn_tokens(
        &self,
        session_id: &str,
        op_name: &str,
        event_state: EventState,
        attrs: &serde_json::Map<String, Value>,
    ) -> Option<TurnTokenDerivation> {
        if op_name != OP_CHAT_CANON {
            return None;
        }
        // Spec #2933 ST-3 (R-2.2): Copilot's `gen_ai.usage.input_tokens` on a
        // `chat` span is PER-CALL, not session-cumulative. Feeding it through
        // the cumulative-delta machinery below would emit a deflated/zero
        // delta; returning `None` makes the projector fall back to the RAW
        // per-call registry values (promptTokens/completionTokens are the
        // per-call figures; cacheReadTokens stays absent — the delta path is
        // the only injector). No baseline is written for a Copilot session, so
        // the OpenCode baselines stay isolated (R-5.2).
        if resolve_provider_token(attrs) == PROVIDER_COPILOT_CLI {
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
}

pub(crate) fn empty_chat_row(session: &str, corr: &str) -> ChatRow {
    ChatRow {
        session_id: session.to_string(),
        correlation_id: corr.to_string(),
        seq: 0,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: rfc3339_now(),
        state: RowState::Init,
        provider: None,
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

/// Build a re-key chat patch from an existing child row: every content field
/// carried over, identity re-keyed to the parent (correlation id UNCHANGED —
/// the child's per-turn id is the new parent-space key).
pub(crate) fn chat_patch_from_row(existing: &ChatRow, parent: &str) -> ChatPatch {
    ChatPatch {
        session_id: Some(parent.to_string()),
        correlation_id: Some(existing.correlation_id.clone()),
        seq: None,
        started_at_ns: existing.started_at_ns,
        ended_at_ns: existing.ended_at_ns,
        updated_at: Some(rfc3339_now()),
        state: Some(existing.state),
        provider: existing.provider.clone(),
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

/// FredoEvent → chat patch (IPC/CLI mock path). Extraction priority: the
/// canonical normalized fields first (userMessage / agentReply / promptTokens
/// …), then the nested info.* twins, then the real opencode event shape
/// (`output.message.parts[].text`) and the mock recipe shape
/// (`message.content[].text`) — real paths with mock fallbacks per the
/// AGENTS.md mock-vs-real rule.
pub(crate) fn chat_patch_from_event(
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
        provider: Some(event.provider.as_str().to_string()),
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
