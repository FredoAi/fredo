//! RTDB typed row structs — the canonical per-entity field set (Spec #2788, P1.1).
//!
//! The canonical field set is grounded in the de-facto shape produced by the
//! OTLP adapter's normalization (`infrastructure/comm/adapters/otlp.rs`,
//! Spec #551/#568 contract-trust pipeline) and consumed by the Mission Monitor
//! frontend (`apps/ui/src/features/mission-monitor/`):
//!
//! - Chat turn: `userMessage` / `agentReply` / `promptTokens` /
//!   `completionTokens` / `cacheReadTokens` (per-turn delta, #2723) /
//!   `costUsd` (flat `cost_usd` span attr, message.ts:135) / `model`
//!   (`gen_ai.response.model`) / `startTime`/`endTime` (span timing, #2723 R-6).
//! - Tool call: `gen_ai.tool.name` / `tool.success` / `tool.error` /
//!   `duration_ms` (message.ts:524) / `gen_ai.tool.call.arguments` → input /
//!   `gen_ai.tool.call.result` → output / `is_subagent`.
//! - Agent session: `total_tokens` / `total_messages` / `total_cost_usd`
//!   (session.ts:608) / `gen_ai.agent.name`.
//! - Envelope: `session.id` / per-turn correlation (`<session>_<n>`, REQ-639) /
//!   span `startTimeUnixNano`/`endTimeUnixNano` / `state` (PascalCase, REQ-11) /
//!   `parentSessionId` (#2768) / `compositedChildSessionId` (#523 ECE re-key).
//!
//! `state` is an ORDINARY field (`Init | Update | Response | Timeout | Error`)
//! — lifecycle transitions become ordinary patches later (P2+); nothing about
//! the row lifecycle is special-cased here. Every field has a total, explicit
//! merge rule declared in [`crate::infrastructure::rtdb::merge`] — no implicit
//! last-wins (the #523/#586 ad-hoc-merge bug family fix class).

use serde::{Deserialize, Serialize};

/// Lifecycle state of a row — an ordinary mergeable field.
///
/// Serialized PascalCase (`"Init"`, `"Update"`, `"Response"`, `"Timeout"`,
/// `"Error"`) per the repo serde convention for enums.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum RowState {
    Init,
    Update,
    Response,
    Timeout,
    Error,
}

impl RowState {
    /// Stable machine name (snake_case) for the query language and storage.
    pub fn as_str(&self) -> &'static str {
        match self {
            RowState::Init => "init",
            RowState::Update => "update",
            RowState::Response => "response",
            RowState::Timeout => "timeout",
            RowState::Error => "error",
        }
    }
}

/// Every canonical field name of a row type (camelCase — matches the serde
/// wire shape). The merge tables in `merge.rs` MUST declare exactly one rule
/// per name here; the totality unit tests enforce it.
pub const CHAT_FIELDS: &[&str] = &[
    "sessionId",
    "correlationId",
    "seq",
    "startedAtNs",
    "endedAtNs",
    "updatedAt",
    "state",
    "userMessage",
    "agentReply",
    "promptTokens",
    "completionTokens",
    "cacheReadTokens",
    "costUsd",
    "model",
    "parentSessionId",
    "compositedChildSessionId",
    "rawJson",
];

pub const TOOL_USE_FIELDS: &[&str] = &[
    "sessionId",
    "correlationId",
    "seq",
    "startedAtNs",
    "endedAtNs",
    "updatedAt",
    "state",
    "toolName",
    "toolSuccess",
    "toolError",
    "durationMs",
    "toolInputJson",
    "toolOutputJson",
    "isSubagent",
    "rawJson",
];

pub const AGENT_SESSION_FIELDS: &[&str] = &[
    "sessionId",
    "correlationId",
    "seq",
    "startedAtNs",
    "endedAtNs",
    "updatedAt",
    "state",
    "totalTokens",
    "totalMessages",
    "totalCostUsd",
    "agentName",
    "rawJson",
];

/// A completed chat turn (one per-turn ECE composite key: sessionId +
/// correlationId). `correlationId` repeats the session id for session-level
/// rows; per-turn rows carry `<session>_<n>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRow {
    pub session_id: String,
    pub correlation_id: String,
    /// Per-key monotonic sequence — DURABLE (seeded from MAX(seq) on backfill).
    pub seq: i64,
    /// Span start, epoch nanoseconds (telemetry_spans.start_time_ns).
    pub started_at_ns: Option<i64>,
    /// Span end, epoch nanoseconds (`None` while the turn streams).
    pub ended_at_ns: Option<i64>,
    /// RFC3339 last-write stamp.
    pub updated_at: String,
    pub state: RowState,
    /// User prompt text (init-time data — survives every later patch).
    pub user_message: Option<String>,
    /// Assistant reply text (latest non-empty wins).
    pub agent_reply: Option<String>,
    /// Per-turn prompt delta (#2711 — never the session-cumulative input).
    pub prompt_tokens: Option<i64>,
    /// Per-turn completion output.
    pub completion_tokens: Option<i64>,
    /// Per-turn cache-read delta (#2723 ST-3 — never the raw cumulative).
    pub cache_read_tokens: Option<i64>,
    /// Per-turn cost in USD (flat `cost_usd` span attr).
    pub cost_usd: Option<f64>,
    /// Model id (`gen_ai.response.model`).
    pub model: Option<String>,
    /// Parent session attribution join (#523/#2768).
    pub parent_session_id: Option<String>,
    /// #523 ECE re-key stamp — the original child session id on composited rows.
    pub composited_child_session_id: Option<String>,
    /// Escape hatch — the latest raw delivery payload as JSON.
    pub raw_json: String,
}

/// One tool execution (`execute_tool` span).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseRow {
    pub session_id: String,
    pub correlation_id: String,
    pub seq: i64,
    pub started_at_ns: Option<i64>,
    pub ended_at_ns: Option<i64>,
    pub updated_at: String,
    pub state: RowState,
    /// Tool name (`gen_ai.tool.name`).
    pub tool_name: Option<String>,
    /// Outcome flag (`tool.success` — `false` is a meaningful outcome).
    pub tool_success: Option<bool>,
    /// Failure text (`tool.error`).
    pub tool_error: Option<String>,
    /// Execution duration in milliseconds (`duration_ms`).
    pub duration_ms: Option<i64>,
    /// Call arguments JSON (`gen_ai.tool.call.arguments` — fixed at call time).
    pub tool_input_json: Option<String>,
    /// Result JSON (`gen_ai.tool.call.result`).
    pub tool_output_json: Option<String>,
    /// Subagent dispatch marker (`is_subagent` / `agent.type`).
    pub is_subagent: Option<bool>,
    pub raw_json: String,
}

/// Session-level aggregate (`run_agent` span).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRow {
    pub session_id: String,
    pub correlation_id: String,
    pub seq: i64,
    pub started_at_ns: Option<i64>,
    pub ended_at_ns: Option<i64>,
    pub updated_at: String,
    pub state: RowState,
    /// Session-cumulative tokens (`total_tokens`).
    pub total_tokens: Option<i64>,
    /// Session-cumulative message count (`total_messages`).
    pub total_messages: Option<i64>,
    /// Session-cumulative cost in USD (`total_cost_usd`).
    pub total_cost_usd: Option<f64>,
    /// Agent display name (`gen_ai.agent.name`).
    pub agent_name: Option<String>,
    pub raw_json: String,
}
