//! The tool-use row family — `execute_tool` spans, the merge-then-ingest write
//! path for [`ToolUseRow`], and the parent-keyed copy.
//!
//! Moved verbatim from `infrastructure/rtdb/ingest.rs` by Spec #3201 ST-5; the
//! logic is unchanged, only its location and its two boundary types
//! (`RowUpsert` / [`RowSink`] instead of `IngestRow` / `Rtdb`).

use serde_json::Value;

use super::{
    changed_fields, content_no_op, i64_field, nested_str, rfc3339_now, str_field,
};
use crate::event::FredoEvent;
use crate::merge::{apply_tool_use_patch, ToolUsePatch};
use crate::rows::{RowKind, RowState, RowUpsert, ToolUseRow, TOOL_USE_FIELDS};

impl super::IngestClassifier {
    /// Merge-then-ingest one tool-use patch. Returns `true` when written.
    pub(crate) async fn apply_tool_use(&self, patch: ToolUsePatch) -> bool {
        let Some(session) = patch.session_id.clone() else {
            return false;
        };
        let Some(corr) = patch.correlation_id.clone() else {
            return false;
        };
        let existing = self
            .sink
            .get_row(RowKind::ToolUse, &session, &corr)
            .await
            .unwrap_or(None)
            .and_then(|row| match row {
                RowUpsert::ToolUse(row) => Some(row),
                _ => None,
            });
        let existed = existing.is_some();
        let mut row = existing.unwrap_or_else(|| empty_tool_row(&session, &corr));
        let old = serde_json::to_value(&row).unwrap_or(Value::Null);
        apply_tool_use_patch(&mut row, &patch);
        let new = serde_json::to_value(&row).unwrap_or(Value::Null);
        let changed = changed_fields(&old, &new, TOOL_USE_FIELDS);
        if content_no_op(existed, &changed) {
            return false;
        }
        if let Err(e) = self
            .sink
            .ingest_row_upsert(RowUpsert::ToolUse(row), &changed)
            .await
        {
            tracing::warn!(target: "fredo::rtdb::ingest", session_id = %session, correlation_id = %corr, error = %e, "tool-use row ingest failed");
            return false;
        }
        true
    }

    pub(crate) async fn ingest_tool_with_copy(&self, patch: ToolUsePatch, child: &str) -> usize {
        self.apply_tool_use(patch.clone()).await;
        let mut copied = 0usize;
        if let Some(parent) = self.parent_of(child) {
            let mut copy = patch;
            copy.session_id = Some(parent.clone());
            self.apply_tool_use(copy).await;
            copied += 1;
        }
        copied
    }
}

pub(crate) fn empty_tool_row(session: &str, corr: &str) -> ToolUseRow {
    ToolUseRow {
        session_id: session.to_string(),
        correlation_id: corr.to_string(),
        seq: 0,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: rfc3339_now(),
        state: RowState::Init,
        provider: None,
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

pub(crate) fn tool_patch_from_row(existing: &ToolUseRow, parent: &str) -> ToolUsePatch {
    ToolUsePatch {
        session_id: Some(parent.to_string()),
        correlation_id: Some(existing.correlation_id.clone()),
        seq: None,
        started_at_ns: existing.started_at_ns,
        ended_at_ns: existing.ended_at_ns,
        updated_at: Some(rfc3339_now()),
        state: Some(existing.state),
        provider: existing.provider.clone(),
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

pub(crate) fn tool_patch_from_event(
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
        provider: Some(event.provider.as_str().to_string()),
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
