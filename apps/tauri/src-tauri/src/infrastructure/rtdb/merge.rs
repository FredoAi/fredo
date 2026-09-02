//! RTDB explicit per-field merge rules + patch application (Spec #2788, P1.1).
//!
//! Replaces the ad-hoc JSON spread-merge (#523/#586 bug family) with a total,
//! deterministic rule per field: the tables below declare EXACTLY ONE rule for
//! EVERY canonical field of each row type (totality enforced against the
//! `*_FIELDS` consts by unit tests), and the `apply_*_patch` functions apply
//! each present patch field per the row type's declared rule.
//!
//! Rule semantics (a patch with no present fields changes nothing):
//! - [`MergeRule::LastWins`] — a present patch value overwrites (used for
//!   envelope identity, the ordinary `state` field, and the `rawJson` escape
//!   hatch).
//! - [`MergeRule::KeepFirst`] — the existing non-`None` value always survives;
//!   the patch value fills only an unset field. Never re-initializes init-time
//!   data (user prompt, tool input, attribution joins).
//! - [`MergeRule::LastNonZero`] — overwrites ONLY with a non-zero/non-empty
//!   value; a zero/empty patch value never changes anything (it cannot clobber
//!   non-zero existing data, and it does not fill an unset field either).
//!   Guards token/cost/duration fields against #586-style zero-delta wipes
//!   and #2723-style cumulative contamination.

use crate::infrastructure::rtdb::rows::{
    AgentSessionRow, ChatRow, RowState, ToolUseRow,
};
use serde::{Deserialize, Serialize};

/// The merge rule of a single canonical field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum MergeRule {
    LastWins,
    KeepFirst,
    LastNonZero,
}

/// One field's declared merge rule. `field` is the camelCase serde name of the
/// row field (matches the `*_FIELDS` consts and the future query language).
///
/// `Serialize`-only: the tables are compile-time declarations (`&'static str`
/// field names), never deserialized from untrusted input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct FieldRule {
    pub field: &'static str,
    pub rule: MergeRule,
}

/// Chat turn merge table — one total rule per [`CHAT_FIELDS`] entry.
pub const CHAT_MERGE: &[FieldRule] = &[
    FieldRule { field: "sessionId", rule: MergeRule::LastWins },
    FieldRule { field: "correlationId", rule: MergeRule::LastWins },
    FieldRule { field: "seq", rule: MergeRule::LastWins },
    FieldRule { field: "startedAtNs", rule: MergeRule::KeepFirst },
    FieldRule { field: "endedAtNs", rule: MergeRule::LastNonZero },
    FieldRule { field: "updatedAt", rule: MergeRule::LastWins },
    FieldRule { field: "state", rule: MergeRule::LastWins },
    FieldRule { field: "userMessage", rule: MergeRule::KeepFirst },
    FieldRule { field: "agentReply", rule: MergeRule::LastNonZero },
    FieldRule { field: "promptTokens", rule: MergeRule::LastNonZero },
    FieldRule { field: "completionTokens", rule: MergeRule::LastNonZero },
    FieldRule { field: "cacheReadTokens", rule: MergeRule::LastNonZero },
    FieldRule { field: "costUsd", rule: MergeRule::LastNonZero },
    FieldRule { field: "model", rule: MergeRule::KeepFirst },
    FieldRule { field: "parentSessionId", rule: MergeRule::KeepFirst },
    FieldRule { field: "compositedChildSessionId", rule: MergeRule::KeepFirst },
    FieldRule { field: "rawJson", rule: MergeRule::LastWins },
];

/// Tool-use merge table — one total rule per [`TOOL_USE_FIELDS`] entry.
pub const TOOL_USE_MERGE: &[FieldRule] = &[
    FieldRule { field: "sessionId", rule: MergeRule::LastWins },
    FieldRule { field: "correlationId", rule: MergeRule::LastWins },
    FieldRule { field: "seq", rule: MergeRule::LastWins },
    FieldRule { field: "startedAtNs", rule: MergeRule::KeepFirst },
    FieldRule { field: "endedAtNs", rule: MergeRule::LastNonZero },
    FieldRule { field: "updatedAt", rule: MergeRule::LastWins },
    FieldRule { field: "state", rule: MergeRule::LastWins },
    FieldRule { field: "toolName", rule: MergeRule::KeepFirst },
    FieldRule { field: "toolSuccess", rule: MergeRule::LastWins },
    FieldRule { field: "toolError", rule: MergeRule::LastNonZero },
    FieldRule { field: "durationMs", rule: MergeRule::LastNonZero },
    FieldRule { field: "toolInputJson", rule: MergeRule::KeepFirst },
    FieldRule { field: "toolOutputJson", rule: MergeRule::LastNonZero },
    FieldRule { field: "isSubagent", rule: MergeRule::LastWins },
    FieldRule { field: "rawJson", rule: MergeRule::LastWins },
];

/// Agent-session merge table — one total rule per [`AGENT_SESSION_FIELDS`] entry.
pub const AGENT_SESSION_MERGE: &[FieldRule] = &[
    FieldRule { field: "sessionId", rule: MergeRule::LastWins },
    FieldRule { field: "correlationId", rule: MergeRule::LastWins },
    FieldRule { field: "seq", rule: MergeRule::LastWins },
    FieldRule { field: "startedAtNs", rule: MergeRule::KeepFirst },
    FieldRule { field: "endedAtNs", rule: MergeRule::LastNonZero },
    FieldRule { field: "updatedAt", rule: MergeRule::LastWins },
    FieldRule { field: "state", rule: MergeRule::LastWins },
    FieldRule { field: "totalTokens", rule: MergeRule::LastNonZero },
    FieldRule { field: "totalMessages", rule: MergeRule::LastNonZero },
    FieldRule { field: "totalCostUsd", rule: MergeRule::LastNonZero },
    FieldRule { field: "agentName", rule: MergeRule::KeepFirst },
    FieldRule { field: "rawJson", rule: MergeRule::LastWins },
];

/// Look up the declared rule for a field. `None` when the table does not cover
/// the field — the totality tests guarantee this never happens for the three
/// canonical tables.
pub fn rule_of(table: &[FieldRule], field: &str) -> Option<MergeRule> {
    table
        .iter()
        .find(|fr| fr.field == field)
        .map(|fr| fr.rule)
}

/// Values that have a "zero"/"empty" reading for [`MergeRule::LastNonZero`].
trait ZeroValue {
    fn is_zero_value(&self) -> bool;
}

impl ZeroValue for i64 {
    fn is_zero_value(&self) -> bool {
        *self == 0
    }
}

impl ZeroValue for f64 {
    fn is_zero_value(&self) -> bool {
        *self == 0.0
    }
}

impl ZeroValue for String {
    fn is_zero_value(&self) -> bool {
        self.is_empty()
    }
}

impl ZeroValue for bool {
    fn is_zero_value(&self) -> bool {
        !*self
    }
}

/// Apply one present optional patch value per `rule`.
fn apply_rule<T: Clone + ZeroValue>(
    target: &mut Option<T>,
    patch: Option<&T>,
    rule: MergeRule,
) {
    let Some(value) = patch else {
        return;
    };
    match rule {
        MergeRule::LastWins => *target = Some(value.clone()),
        MergeRule::KeepFirst => {
            if target.is_none() {
                *target = Some(value.clone());
            }
        }
        MergeRule::LastNonZero => {
            if !value.is_zero_value() {
                *target = Some(value.clone());
            }
        }
    }
}

/// Apply one present REQUIRED patch value (always `LastWins` — required fields
/// are envelope identity/monotonic/latest-write only).
fn apply_required<T: Clone>(target: &mut T, patch: Option<&T>) {
    if let Some(value) = patch {
        *target = value.clone();
    }
}

/// Partial [`ChatRow`] — every field optional; absent fields are not applied.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPatch {
    pub session_id: Option<String>,
    pub correlation_id: Option<String>,
    pub seq: Option<i64>,
    pub started_at_ns: Option<i64>,
    pub ended_at_ns: Option<i64>,
    pub updated_at: Option<String>,
    pub state: Option<RowState>,
    pub user_message: Option<String>,
    pub agent_reply: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub model: Option<String>,
    pub parent_session_id: Option<String>,
    pub composited_child_session_id: Option<String>,
    pub raw_json: Option<String>,
}

/// Partial [`ToolUseRow`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsePatch {
    pub session_id: Option<String>,
    pub correlation_id: Option<String>,
    pub seq: Option<i64>,
    pub started_at_ns: Option<i64>,
    pub ended_at_ns: Option<i64>,
    pub updated_at: Option<String>,
    pub state: Option<RowState>,
    pub tool_name: Option<String>,
    pub tool_success: Option<bool>,
    pub tool_error: Option<String>,
    pub duration_ms: Option<i64>,
    pub tool_input_json: Option<String>,
    pub tool_output_json: Option<String>,
    pub is_subagent: Option<bool>,
    pub raw_json: Option<String>,
}

/// Partial [`AgentSessionRow`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionPatch {
    pub session_id: Option<String>,
    pub correlation_id: Option<String>,
    pub seq: Option<i64>,
    pub started_at_ns: Option<i64>,
    pub ended_at_ns: Option<i64>,
    pub updated_at: Option<String>,
    pub state: Option<RowState>,
    pub total_tokens: Option<i64>,
    pub total_messages: Option<i64>,
    pub total_cost_usd: Option<f64>,
    pub agent_name: Option<String>,
    pub raw_json: Option<String>,
}

/// Apply a chat patch onto `row` — each present field per its declared
/// [`CHAT_MERGE`] rule. A patch with no present fields changes nothing.
pub fn apply_chat_patch(row: &mut ChatRow, patch: &ChatPatch) {
    apply_required(&mut row.session_id, patch.session_id.as_ref());
    apply_required(&mut row.correlation_id, patch.correlation_id.as_ref());
    apply_required(&mut row.seq, patch.seq.as_ref());
    apply_rule(&mut row.started_at_ns, patch.started_at_ns.as_ref(), MergeRule::KeepFirst);
    apply_rule(&mut row.ended_at_ns, patch.ended_at_ns.as_ref(), MergeRule::LastNonZero);
    apply_required(&mut row.updated_at, patch.updated_at.as_ref());
    if let Some(state) = patch.state {
        row.state = state;
    }
    apply_rule(&mut row.user_message, patch.user_message.as_ref(), MergeRule::KeepFirst);
    apply_rule(&mut row.agent_reply, patch.agent_reply.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.prompt_tokens, patch.prompt_tokens.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.completion_tokens, patch.completion_tokens.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.cache_read_tokens, patch.cache_read_tokens.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.cost_usd, patch.cost_usd.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.model, patch.model.as_ref(), MergeRule::KeepFirst);
    apply_rule(&mut row.parent_session_id, patch.parent_session_id.as_ref(), MergeRule::KeepFirst);
    apply_rule(
        &mut row.composited_child_session_id,
        patch.composited_child_session_id.as_ref(),
        MergeRule::KeepFirst,
    );
    apply_required(&mut row.raw_json, patch.raw_json.as_ref());
}

/// Apply a tool-use patch onto `row` — each present field per its declared
/// [`TOOL_USE_MERGE`] rule.
pub fn apply_tool_use_patch(row: &mut ToolUseRow, patch: &ToolUsePatch) {
    apply_required(&mut row.session_id, patch.session_id.as_ref());
    apply_required(&mut row.correlation_id, patch.correlation_id.as_ref());
    apply_required(&mut row.seq, patch.seq.as_ref());
    apply_rule(&mut row.started_at_ns, patch.started_at_ns.as_ref(), MergeRule::KeepFirst);
    apply_rule(&mut row.ended_at_ns, patch.ended_at_ns.as_ref(), MergeRule::LastNonZero);
    apply_required(&mut row.updated_at, patch.updated_at.as_ref());
    if let Some(state) = patch.state {
        row.state = state;
    }
    apply_rule(&mut row.tool_name, patch.tool_name.as_ref(), MergeRule::KeepFirst);
    apply_rule(&mut row.tool_success, patch.tool_success.as_ref(), MergeRule::LastWins);
    apply_rule(&mut row.tool_error, patch.tool_error.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.duration_ms, patch.duration_ms.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.tool_input_json, patch.tool_input_json.as_ref(), MergeRule::KeepFirst);
    apply_rule(&mut row.tool_output_json, patch.tool_output_json.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.is_subagent, patch.is_subagent.as_ref(), MergeRule::LastWins);
    apply_required(&mut row.raw_json, patch.raw_json.as_ref());
}

/// Apply an agent-session patch onto `row` — each present field per its
/// declared [`AGENT_SESSION_MERGE`] rule.
pub fn apply_agent_session_patch(row: &mut AgentSessionRow, patch: &AgentSessionPatch) {
    apply_required(&mut row.session_id, patch.session_id.as_ref());
    apply_required(&mut row.correlation_id, patch.correlation_id.as_ref());
    apply_required(&mut row.seq, patch.seq.as_ref());
    apply_rule(&mut row.started_at_ns, patch.started_at_ns.as_ref(), MergeRule::KeepFirst);
    apply_rule(&mut row.ended_at_ns, patch.ended_at_ns.as_ref(), MergeRule::LastNonZero);
    apply_required(&mut row.updated_at, patch.updated_at.as_ref());
    if let Some(state) = patch.state {
        row.state = state;
    }
    apply_rule(&mut row.total_tokens, patch.total_tokens.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.total_messages, patch.total_messages.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.total_cost_usd, patch.total_cost_usd.as_ref(), MergeRule::LastNonZero);
    apply_rule(&mut row.agent_name, patch.agent_name.as_ref(), MergeRule::KeepFirst);
    apply_required(&mut row.raw_json, patch.raw_json.as_ref());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::rows::{
        AgentSessionRow, AGENT_SESSION_FIELDS, ChatRow, CHAT_FIELDS, RowState, ToolUseRow,
        TOOL_USE_FIELDS,
    };

    // ── Table totality: exactly one rule per canonical field, no duplicates ──

    #[test]
    fn merge_tables_are_total_and_duplicate_free() {
        let tables: [(&str, &[FieldRule], &[&str]); 3] = [
            ("CHAT_MERGE", CHAT_MERGE, CHAT_FIELDS),
            ("TOOL_USE_MERGE", TOOL_USE_MERGE, TOOL_USE_FIELDS),
            ("AGENT_SESSION_MERGE", AGENT_SESSION_MERGE, AGENT_SESSION_FIELDS),
        ];
        for (name, table, fields) in tables {
            assert_eq!(
                table.len(),
                fields.len(),
                "{name} must declare exactly one rule per canonical field"
            );
            for (i, fr) in table.iter().enumerate() {
                assert_eq!(
                    fr.field,
                    fields[i],
                    "{name} entry {i} must match the canonical field order"
                );
                let dupes = table.iter().filter(|other| other.field == fr.field).count();
                assert_eq!(dupes, 1, "{name} field {} declared {} times", fr.field, dupes);
            }
        }
    }

    #[test]
    fn rule_of_resolves_every_declared_field_and_none_outside() {
        assert_eq!(rule_of(CHAT_MERGE, "userMessage"), Some(MergeRule::KeepFirst));
        assert_eq!(rule_of(CHAT_MERGE, "costUsd"), Some(MergeRule::LastNonZero));
        assert_eq!(rule_of(TOOL_USE_MERGE, "toolSuccess"), Some(MergeRule::LastWins));
        assert_eq!(rule_of(AGENT_SESSION_MERGE, "agentName"), Some(MergeRule::KeepFirst));
        assert_eq!(rule_of(CHAT_MERGE, "notAField"), None);
    }

    // ── Generic rule engine: all three rules, zero-vs-nonzero, re-init ──────

    #[test]
    fn last_wins_overwrites_any_existing_value() {
        let mut target: Option<i64> = Some(7);
        apply_rule(&mut target, Some(&42), MergeRule::LastWins);
        assert_eq!(target, Some(42));

        // Zero values DO overwrite under LastWins — the rule is unconditional.
        apply_rule(&mut target, Some(&0), MergeRule::LastWins);
        assert_eq!(target, Some(0));
    }

    #[test]
    fn keep_first_never_reinitializes_but_fills_unset() {
        let mut target: Option<String> = Some("original".to_string());
        apply_rule(&mut target, Some(&"patch".to_string()), MergeRule::KeepFirst);
        assert_eq!(target, Some("original".to_string()), "re-init must be impossible");

        let mut unset: Option<String> = None;
        apply_rule(&mut unset, Some(&"first".to_string()), MergeRule::KeepFirst);
        assert_eq!(unset, Some("first".to_string()));
    }

    #[test]
    fn last_non_zero_zero_never_clobbers_non_zero() {
        // i64
        let mut tokens: Option<i64> = Some(1250);
        apply_rule(&mut tokens, Some(&0), MergeRule::LastNonZero);
        assert_eq!(tokens, Some(1250), "#586 zero delta must not clobber");

        // f64
        let mut cost: Option<f64> = Some(0.0234);
        apply_rule(&mut cost, Some(&0.0), MergeRule::LastNonZero);
        assert_eq!(cost, Some(0.0234));

        // String
        let mut reply: Option<String> = Some("real reply".to_string());
        apply_rule(&mut reply, Some(&String::new()), MergeRule::LastNonZero);
        assert_eq!(reply, Some("real reply".to_string()), "empty delta must not clobber");
    }

    #[test]
    fn last_non_zero_applies_non_zero_values_and_never_fills_zero() {
        let mut target: Option<i64> = Some(1);
        apply_rule(&mut target, Some(&99), MergeRule::LastNonZero);
        assert_eq!(target, Some(99), "a non-zero patch value overwrites");

        // A zero patch on an UNSET field does not fill it either — the rule
        // overwrites ONLY with a non-zero value.
        let mut unset: Option<i64> = None;
        apply_rule(&mut unset, Some(&0), MergeRule::LastNonZero);
        assert_eq!(unset, None);
    }

    #[test]
    fn absent_patch_fields_change_nothing() {
        let mut target: Option<String> = Some("kept".to_string());
        apply_rule(&mut target, None, MergeRule::LastWins);
        apply_rule(&mut target, None, MergeRule::KeepFirst);
        apply_rule(&mut target, None, MergeRule::LastNonZero);
        assert_eq!(target, Some("kept".to_string()));
    }

    // ── Chat row: end-to-end merge semantics ────────────────────────────────

    fn chat_row() -> ChatRow {
        ChatRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_1".to_string(),
            seq: 1,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00Z".to_string(),
            state: RowState::Init,
            user_message: Some("fix the bug".to_string()),
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

    #[test]
    fn chat_patch_streams_init_update_response_without_wiping_init_data() {
        let mut row = chat_row();

        // Update: streaming reply + token deltas; init data survives.
        apply_chat_patch(
            &mut row,
            &ChatPatch {
                agent_reply: Some("partial".to_string()),
                prompt_tokens: Some(25),
                completion_tokens: Some(10),
                updated_at: Some("2026-08-31T00:00:01Z".to_string()),
                state: Some(RowState::Update),
                ..ChatPatch::default()
            },
        );
        assert_eq!(row.user_message, Some("fix the bug".to_string()), "userMessage never re-init");
        assert_eq!(row.agent_reply, Some("partial".to_string()));
        assert_eq!(row.state, RowState::Update);

        // Response: final values overwrite non-zero; zero deltas never clobber.
        apply_chat_patch(
            &mut row,
            &ChatPatch {
                agent_reply: Some("full reply".to_string()),
                prompt_tokens: Some(0),  // #586 zero delta — must not clobber 25
                completion_tokens: Some(75),
                cache_read_tokens: Some(177),
                cost_usd: Some(0.0234),
                model: Some("claude-sonnet-4".to_string()),
                ended_at_ns: Some(9_000),
                updated_at: Some("2026-08-31T00:00:02Z".to_string()),
                state: Some(RowState::Response),
                ..ChatPatch::default()
            },
        );
        assert_eq!(row.agent_reply, Some("full reply".to_string()));
        assert_eq!(row.prompt_tokens, Some(25), "zero prompt delta never clobbers");
        assert_eq!(row.completion_tokens, Some(75));
        assert_eq!(row.cache_read_tokens, Some(177));
        assert_eq!(row.cost_usd, Some(0.0234));
        assert_eq!(row.ended_at_ns, Some(9_000));
        assert_eq!(row.state, RowState::Response);
    }

    #[test]
    fn chat_patch_lifecycle_replay_and_composition_stamps_survive() {
        let mut row = chat_row();
        row.parent_session_id = Some("ses_parent".to_string());
        row.composited_child_session_id = Some("ses_child".to_string());

        // A replayed init delivery (same payload re-delivered after a #523
        // re-key) must not wipe accumulated data or re-stamp attribution.
        apply_chat_patch(
            &mut row,
            &ChatPatch {
                started_at_ns: Some(999_999),
                user_message: Some("REPLAYED".to_string()),
                parent_session_id: Some("ses_other".to_string()),
                composited_child_session_id: Some("ses_other_child".to_string()),
                ..ChatPatch::default()
            },
        );
        assert_eq!(row.started_at_ns, Some(1_000), "span start is immutable");
        assert_eq!(row.user_message, Some("fix the bug".to_string()));
        assert_eq!(row.parent_session_id, Some("ses_parent".to_string()));
        assert_eq!(row.composited_child_session_id, Some("ses_child".to_string()));
    }

    #[test]
    fn empty_chat_patch_changes_nothing() {
        let mut row = chat_row();
        let before = row.clone();
        apply_chat_patch(&mut row, &ChatPatch::default());
        assert_eq!(row, before);
    }

    #[test]
    fn chat_patch_timeout_and_error_states_are_ordinary_values() {
        let mut row = chat_row();
        apply_chat_patch(&mut row, &ChatPatch { state: Some(RowState::Timeout), ..Default::default() });
        assert_eq!(row.state, RowState::Timeout);
        apply_chat_patch(&mut row, &ChatPatch { state: Some(RowState::Error), ..Default::default() });
        assert_eq!(row.state, RowState::Error);
    }

    // ── Tool-use row: end-to-end merge semantics ────────────────────────────

    fn tool_row() -> ToolUseRow {
        ToolUseRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_2".to_string(),
            seq: 2,
            started_at_ns: Some(2_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00Z".to_string(),
            state: RowState::Init,
            tool_name: Some("bash".to_string()),
            tool_success: None,
            tool_error: None,
            duration_ms: None,
            tool_input_json: Some(r#"{"command":"ls"}"#.to_string()),
            tool_output_json: None,
            is_subagent: None,
            raw_json: "{}".to_string(),
        }
    }

    #[test]
    fn tool_patch_completes_with_success_false_meaningful() {
        let mut row = tool_row();
        apply_tool_use_patch(
            &mut row,
            &ToolUsePatch {
                tool_success: Some(false),
                tool_error: Some("exit code 1".to_string()),
                duration_ms: Some(3_000),
                tool_output_json: Some("".to_string()), // empty output must not fill
                ended_at_ns: Some(5_000),
                state: Some(RowState::Response),
                updated_at: Some("2026-08-31T00:00:03Z".to_string()),
                ..ToolUsePatch::default()
            },
        );
        assert_eq!(row.tool_success, Some(false), "a failed tool is a meaningful outcome");
        assert_eq!(row.tool_error, Some("exit code 1".to_string()));
        assert_eq!(row.duration_ms, Some(3_000));
        assert_eq!(row.tool_output_json, None, "empty output never fills the field");
        assert_eq!(row.tool_input_json, Some(r#"{"command":"ls"}"#.to_string()));
        assert_eq!(row.state, RowState::Response);

        // A later error-text correction overwrites (non-zero), and a zero
        // duration never clobbers a real one.
        apply_tool_use_patch(
            &mut row,
            &ToolUsePatch {
                tool_error: Some("exit code 1: permission denied".to_string()),
                duration_ms: Some(0),
                ..ToolUsePatch::default()
            },
        );
        assert_eq!(row.tool_error, Some("exit code 1: permission denied".to_string()));
        assert_eq!(row.duration_ms, Some(3_000));
    }

    #[test]
    fn tool_patch_keeps_first_input_and_name_on_replay() {
        let mut row = tool_row();
        apply_tool_use_patch(
            &mut row,
            &ToolUsePatch {
                tool_name: Some("hijacked".to_string()),
                tool_input_json: Some(r#"{"command":"rm -rf /"}"#.to_string()),
                ..ToolUsePatch::default()
            },
        );
        assert_eq!(row.tool_name, Some("bash".to_string()));
        assert_eq!(row.tool_input_json, Some(r#"{"command":"ls"}"#.to_string()));
    }

    #[test]
    fn empty_tool_patch_changes_nothing() {
        let mut row = tool_row();
        let before = row.clone();
        apply_tool_use_patch(&mut row, &ToolUsePatch::default());
        assert_eq!(row, before);
    }

    // ── Agent-session row: end-to-end merge semantics ───────────────────────

    fn session_row() -> AgentSessionRow {
        AgentSessionRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a".to_string(),
            seq: 3,
            started_at_ns: Some(3_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00Z".to_string(),
            state: RowState::Init,
            total_tokens: None,
            total_messages: None,
            total_cost_usd: None,
            agent_name: None,
            raw_json: "{}".to_string(),
        }
    }

    #[test]
    fn session_patch_accumulates_totals_and_keeps_agent_name() {
        let mut row = session_row();
        apply_agent_session_patch(
            &mut row,
            &AgentSessionPatch {
                total_tokens: Some(23_262),
                total_messages: Some(1),
                total_cost_usd: Some(0.0),
                agent_name: Some("self-improver".to_string()),
                ..AgentSessionPatch::default()
            },
        );
        assert_eq!(row.total_tokens, Some(23_262));
        assert_eq!(row.total_messages, Some(1));
        assert_eq!(row.total_cost_usd, None, "zero cost never fills the field");
        assert_eq!(row.agent_name, Some("self-improver".to_string()));

        // Later session spans carry grown totals — non-zero overwrites.
        apply_agent_session_patch(
            &mut row,
            &AgentSessionPatch {
                total_tokens: Some(59_200),
                total_messages: Some(57),
                total_cost_usd: Some(0.512),
                ..AgentSessionPatch::default()
            },
        );
        assert_eq!(row.total_tokens, Some(59_200));
        assert_eq!(row.total_messages, Some(57));
        assert_eq!(row.total_cost_usd, Some(0.512));
        assert_eq!(row.agent_name, Some("self-improver".to_string()), "KeepFirst");
    }

    #[test]
    fn empty_session_patch_changes_nothing() {
        let mut row = session_row();
        let before = row.clone();
        apply_agent_session_patch(&mut row, &AgentSessionPatch::default());
        assert_eq!(row, before);
    }

    // ── Apply arms cover EVERY field (behavioral totality) ──────────────────

    #[test]
    fn chat_apply_covers_every_field() {
        // Apply a full patch of distinctive sentinels onto a fresh row and
        // verify every field was touched per its rule. A future field added to
        // ChatRow without an apply arm fails this test.
        let mut row = ChatRow {
            session_id: "old".to_string(),
            correlation_id: "old".to_string(),
            seq: 0,
            started_at_ns: None,
            ended_at_ns: None,
            updated_at: "old".to_string(),
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
            raw_json: "old".to_string(),
        };
        apply_chat_patch(
            &mut row,
            &ChatPatch {
                session_id: Some("new".to_string()),
                correlation_id: Some("new".to_string()),
                seq: Some(7),
                started_at_ns: Some(111),
                ended_at_ns: Some(222),
                updated_at: Some("new".to_string()),
                state: Some(RowState::Response),
                user_message: Some("user".to_string()),
                agent_reply: Some("agent".to_string()),
                prompt_tokens: Some(1),
                completion_tokens: Some(2),
                cache_read_tokens: Some(3),
                cost_usd: Some(0.5),
                model: Some("m".to_string()),
                parent_session_id: Some("p".to_string()),
                composited_child_session_id: Some("c".to_string()),
                raw_json: Some("raw".to_string()),
            },
        );
        assert_eq!(row.session_id, "new");
        assert_eq!(row.correlation_id, "new");
        assert_eq!(row.seq, 7);
        assert_eq!(row.started_at_ns, Some(111));
        assert_eq!(row.ended_at_ns, Some(222));
        assert_eq!(row.updated_at, "new");
        assert_eq!(row.state, RowState::Response);
        assert_eq!(row.user_message, Some("user".to_string()));
        assert_eq!(row.agent_reply, Some("agent".to_string()));
        assert_eq!(row.prompt_tokens, Some(1));
        assert_eq!(row.completion_tokens, Some(2));
        assert_eq!(row.cache_read_tokens, Some(3));
        assert_eq!(row.cost_usd, Some(0.5));
        assert_eq!(row.model, Some("m".to_string()));
        assert_eq!(row.parent_session_id, Some("p".to_string()));
        assert_eq!(row.composited_child_session_id, Some("c".to_string()));
        assert_eq!(row.raw_json, "raw");
        assert_eq!(CHAT_FIELDS.len(), 17);
    }

    #[test]
    fn tool_apply_covers_every_field() {
        let mut row = ToolUseRow {
            session_id: "old".to_string(),
            correlation_id: "old".to_string(),
            seq: 0,
            started_at_ns: None,
            ended_at_ns: None,
            updated_at: "old".to_string(),
            state: RowState::Init,
            tool_name: None,
            tool_success: None,
            tool_error: None,
            duration_ms: None,
            tool_input_json: None,
            tool_output_json: None,
            is_subagent: None,
            raw_json: "old".to_string(),
        };
        apply_tool_use_patch(
            &mut row,
            &ToolUsePatch {
                session_id: Some("new".to_string()),
                correlation_id: Some("new".to_string()),
                seq: Some(8),
                started_at_ns: Some(111),
                ended_at_ns: Some(222),
                updated_at: Some("new".to_string()),
                state: Some(RowState::Response),
                tool_name: Some("read".to_string()),
                tool_success: Some(true),
                tool_error: Some(String::new()), // empty → must NOT fill
                duration_ms: Some(120),
                tool_input_json: Some("{}".to_string()),
                tool_output_json: Some("data".to_string()),
                is_subagent: Some(true),
                raw_json: Some("raw".to_string()),
            },
        );
        assert_eq!(row.session_id, "new");
        assert_eq!(row.correlation_id, "new");
        assert_eq!(row.seq, 8);
        assert_eq!(row.started_at_ns, Some(111));
        assert_eq!(row.ended_at_ns, Some(222));
        assert_eq!(row.updated_at, "new");
        assert_eq!(row.state, RowState::Response);
        assert_eq!(row.tool_name, Some("read".to_string()));
        assert_eq!(row.tool_success, Some(true));
        assert_eq!(row.tool_error, None, "empty error string must not fill");
        assert_eq!(row.duration_ms, Some(120));
        assert_eq!(row.tool_input_json, Some("{}".to_string()));
        assert_eq!(row.tool_output_json, Some("data".to_string()));
        assert_eq!(row.is_subagent, Some(true));
        assert_eq!(row.raw_json, "raw");
        assert_eq!(TOOL_USE_FIELDS.len(), 15);
    }

    #[test]
    fn session_apply_covers_every_field() {
        let mut row = AgentSessionRow {
            session_id: "old".to_string(),
            correlation_id: "old".to_string(),
            seq: 0,
            started_at_ns: None,
            ended_at_ns: None,
            updated_at: "old".to_string(),
            state: RowState::Init,
            total_tokens: None,
            total_messages: None,
            total_cost_usd: None,
            agent_name: None,
            raw_json: "old".to_string(),
        };
        apply_agent_session_patch(
            &mut row,
            &AgentSessionPatch {
                session_id: Some("new".to_string()),
                correlation_id: Some("new".to_string()),
                seq: Some(9),
                started_at_ns: Some(111),
                ended_at_ns: Some(222),
                updated_at: Some("new".to_string()),
                state: Some(RowState::Response),
                total_tokens: Some(100),
                total_messages: Some(4),
                total_cost_usd: Some(1.25),
                agent_name: Some("build".to_string()),
                raw_json: Some("raw".to_string()),
            },
        );
        assert_eq!(row.session_id, "new");
        assert_eq!(row.correlation_id, "new");
        assert_eq!(row.seq, 9);
        assert_eq!(row.started_at_ns, Some(111));
        assert_eq!(row.ended_at_ns, Some(222));
        assert_eq!(row.updated_at, "new");
        assert_eq!(row.state, RowState::Response);
        assert_eq!(row.total_tokens, Some(100));
        assert_eq!(row.total_messages, Some(4));
        assert_eq!(row.total_cost_usd, Some(1.25));
        assert_eq!(row.agent_name, Some("build".to_string()));
        assert_eq!(row.raw_json, "raw");
        assert_eq!(AGENT_SESSION_FIELDS.len(), 12);
    }

    // ── Serde round-trips: camelCase rows/patches, PascalCase enums ─────────

    #[test]
    fn chat_row_serde_round_trip_camel_case() {
        let row = ChatRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_1".to_string(),
            seq: 12,
            started_at_ns: Some(1_000),
            ended_at_ns: Some(9_000),
            updated_at: "2026-08-31T00:00:00Z".to_string(),
            state: RowState::Response,
            user_message: Some("q".to_string()),
            agent_reply: Some("a".to_string()),
            prompt_tokens: Some(25),
            completion_tokens: Some(75),
            cache_read_tokens: Some(177),
            cost_usd: Some(0.0234),
            model: Some("claude-sonnet-4".to_string()),
            parent_session_id: Some("ses_p".to_string()),
            composited_child_session_id: Some("ses_c".to_string()),
            raw_json: "{}".to_string(),
        };
        let json = serde_json::to_value(&row).ok().expect("serialize ChatRow");
        let obj = json.as_object().expect("object");
        for key in CHAT_FIELDS {
            assert!(obj.contains_key(*key), "ChatRow JSON missing camelCase key {key}");
        }
        let back: ChatRow = serde_json::from_value(json).ok().expect("deserialize ChatRow");
        assert_eq!(back, row);
    }

    #[test]
    fn tool_and_session_rows_serde_round_trip_camel_case() {
        let tool = ToolUseRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a_2".to_string(),
            seq: 2,
            started_at_ns: Some(1),
            ended_at_ns: Some(2),
            updated_at: "t".to_string(),
            state: RowState::Update,
            tool_name: Some("bash".to_string()),
            tool_success: Some(false),
            tool_error: Some("boom".to_string()),
            duration_ms: Some(120),
            tool_input_json: Some("{}".to_string()),
            tool_output_json: None,
            is_subagent: Some(true),
            raw_json: "{}".to_string(),
        };
        let json = serde_json::to_value(&tool).ok().expect("serialize ToolUseRow");
        for key in TOOL_USE_FIELDS {
            assert!(
                json.as_object().expect("object").contains_key(*key),
                "ToolUseRow JSON missing camelCase key {key}"
            );
        }
        let back: ToolUseRow = serde_json::from_value(json).ok().expect("deserialize ToolUseRow");
        assert_eq!(back, tool);

        let session = AgentSessionRow {
            session_id: "ses_a".to_string(),
            correlation_id: "ses_a".to_string(),
            seq: 3,
            started_at_ns: None,
            ended_at_ns: Some(2),
            updated_at: "t".to_string(),
            state: RowState::Timeout,
            total_tokens: Some(1),
            total_messages: Some(1),
            total_cost_usd: Some(0.5),
            agent_name: Some("build".to_string()),
            raw_json: "{}".to_string(),
        };
        let json = serde_json::to_value(&session).ok().expect("serialize AgentSessionRow");
        for key in AGENT_SESSION_FIELDS {
            assert!(
                json.as_object().expect("object").contains_key(*key),
                "AgentSessionRow JSON missing camelCase key {key}"
            );
        }
        let back: AgentSessionRow =
            serde_json::from_value(json).ok().expect("deserialize AgentSessionRow");
        assert_eq!(back, session);
    }

    #[test]
    fn row_state_and_merge_rule_serde_names() {
        // RowState: PascalCase wire names.
        let states = [
            (RowState::Init, "Init"),
            (RowState::Update, "Update"),
            (RowState::Response, "Response"),
            (RowState::Timeout, "Timeout"),
            (RowState::Error, "Error"),
        ];
        for (state, name) in states {
            let json = serde_json::to_value(state).ok().expect("serialize RowState");
            assert_eq!(json.as_str(), Some(name));
            let back: RowState = serde_json::from_value(json).ok().expect("deserialize RowState");
            assert_eq!(back, state);
            assert_eq!(back.as_str(), name.to_lowercase());
        }

        // MergeRule: PascalCase wire names (field-rule tables serialize too).
        let rules = [
            (MergeRule::LastWins, "LastWins"),
            (MergeRule::KeepFirst, "KeepFirst"),
            (MergeRule::LastNonZero, "LastNonZero"),
        ];
        for (rule, name) in rules {
            let json = serde_json::to_value(rule).ok().expect("serialize MergeRule");
            assert_eq!(json.as_str(), Some(name));
        }
        // The CHAT_MERGE table itself serializes with its declared field/rule
        // names intact (Serialize-only — the tables are compile-time
        // declarations, never deserialized from untrusted input).
        let table_json =
            serde_json::to_value(CHAT_MERGE).ok().expect("serialize CHAT_MERGE");
        let entries = table_json.as_array().expect("array");
        assert_eq!(entries.len(), CHAT_MERGE.len());
        for (entry, declared) in entries.iter().zip(CHAT_MERGE) {
            assert_eq!(entry.get("field").and_then(|v| v.as_str()), Some(declared.field));
        }
    }
}
