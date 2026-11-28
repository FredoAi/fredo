//! The agent-session row family — `run_agent`/`session` spans, the
//! merge-then-ingest write path for [`AgentSessionRow`], and the parent-keyed
//! copy that keeps a subagent's session row in its parent's timeline.
//!
//! Moved verbatim from `infrastructure/rtdb/ingest.rs` by Spec #3201 ST-5; the
//! logic is unchanged, only its location and its two boundary types
//! (`RowUpsert` / [`RowSink`] instead of `IngestRow` / `Rtdb`).

use serde_json::Value;

use super::{changed_fields, content_no_op, f64_field, i64_field, rfc3339_now, str_field};
use crate::merge::{apply_agent_session_patch, AgentSessionPatch};
use crate::rows::{AgentSessionRow, RowKind, RowState, RowUpsert, AGENT_SESSION_FIELDS};

impl super::IngestClassifier {
    /// Merge-then-ingest one agent-session patch. Returns `true` when written.
    pub(crate) async fn apply_agent_session(&self, patch: AgentSessionPatch) -> bool {
        let Some(session) = patch.session_id.clone() else {
            return false;
        };
        let Some(corr) = patch.correlation_id.clone() else {
            return false;
        };
        let existing = self
            .sink
            .get_row(RowKind::AgentSession, &session, &corr)
            .await
            .unwrap_or(None)
            .and_then(|row| match row {
                RowUpsert::AgentSession(row) => Some(row),
                _ => None,
            });
        let existed = existing.is_some();
        let mut row = existing.unwrap_or_else(|| empty_session_row(&session, &corr));
        let old = serde_json::to_value(&row).unwrap_or(Value::Null);
        apply_agent_session_patch(&mut row, &patch);
        let new = serde_json::to_value(&row).unwrap_or(Value::Null);
        let changed = changed_fields(&old, &new, AGENT_SESSION_FIELDS);
        if content_no_op(existed, &changed) {
            return false;
        }
        if let Err(e) = self
            .sink
            .ingest_row_upsert(RowUpsert::AgentSession(row), &changed)
            .await
        {
            tracing::warn!(target: "fredo::rtdb::ingest", session_id = %session, correlation_id = %corr, error = %e, "agent-session row ingest failed");
            return false;
        }
        true
    }

    pub(crate) async fn ingest_session_with_copy(
        &self,
        patch: AgentSessionPatch,
        child: &str,
    ) -> usize {
        self.apply_agent_session(patch.clone()).await;
        let mut copied = 0usize;
        if let Some(parent) = self.parent_of(child) {
            let mut copy = patch;
            copy.session_id = Some(parent.clone());
            self.apply_agent_session(copy).await;
            copied += 1;
        }
        copied
    }
}

pub(crate) fn empty_session_row(session: &str, corr: &str) -> AgentSessionRow {
    AgentSessionRow {
        session_id: session.to_string(),
        correlation_id: corr.to_string(),
        seq: 0,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: rfc3339_now(),
        state: RowState::Init,
        provider: None,
        total_tokens: None,
        total_messages: None,
        total_cost_usd: None,
        agent_name: None,
        raw_json: "{}".to_string(),
    }
}

pub(crate) fn session_patch_from_row(
    existing: &AgentSessionRow,
    parent: &str,
) -> AgentSessionPatch {
    AgentSessionPatch {
        session_id: Some(parent.to_string()),
        correlation_id: Some(existing.correlation_id.clone()),
        seq: None,
        started_at_ns: existing.started_at_ns,
        ended_at_ns: existing.ended_at_ns,
        updated_at: Some(rfc3339_now()),
        state: Some(existing.state),
        provider: existing.provider.clone(),
        total_tokens: existing.total_tokens,
        total_messages: existing.total_messages,
        total_cost_usd: existing.total_cost_usd,
        agent_name: existing.agent_name.clone(),
        raw_json: Some(existing.raw_json.clone()),
    }
}

pub(crate) fn session_patch_from_event(
    payload: &Value,
    session_id: &str,
    correlation: &str,
    state: RowState,
    updated_at: &str,
    provider: &str,
) -> AgentSessionPatch {
    AgentSessionPatch {
        session_id: Some(session_id.to_string()),
        correlation_id: Some(correlation.to_string()),
        seq: None,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: Some(updated_at.to_string()),
        state: Some(state),
        provider: Some(provider.to_string()),
        total_tokens: i64_field(payload, &["totalTokens"]),
        total_messages: i64_field(payload, &["totalMessages"]),
        total_cost_usd: f64_field(payload, &["totalCostUsd"]),
        agent_name: str_field(payload, &["agent", "name", "agentName"]),
        raw_json: Some(payload.to_string()),
    }
}
