//! The closed `sessionRollup` projection kind — one declared row per composited
//! chat `sessionId`, carrying only the documented fact columns (Spec #2896,
//! ST-3).
//!
//! ## Semantics (fixed by contract (a), unit-tested here)
//!
//! All counts are over canonical rows whose `sessionId` equals the group key
//! (composited child copies ride the parent key — `rtdb/ingest.rs:870-910`):
//!
//! - `chatRowCount` = all chat rows.
//! - `nonSubagentChatRowCount` = chat rows with `parentSessionId` and
//!   `compositedChildSessionId` both null.
//! - `visibleTurnCount` = non-subagent chat rows that are NOT transitional
//!   (`state ∈ terminalStates` AND `trim(coalesce(agentReply,'')) = ''` — the
//!   `isTransitionalTurn` rule, `rowDerivation.ts:224-239`).
//! - `userDispatchCount` = non-subagent tool rows with `toolName='task'` whose
//!   `toolInputJson.subagent_type ?? .agent` ∉ `excludeDispatchNames`
//!   (`rowDerivation.ts:212`, `sessionMeta.ts:120-138`).
//! - `startedAtNs` = min NON-NULL chat `startedAtNs`.
//! - `latestAt` = max chat `updatedAt`.
//! - `derivedName` = raw `userMessage` of the non-blank chat row with the
//!   smallest non-null `startedAtNs` (tie-break: correlationId ascending);
//!   stored raw — display normalization/truncation is the frontend's job.
//! - `agentName` = `agentName` of the latest (by `updatedAt`, then `seq`)
//!   agent-session row carrying a non-blank name.
//! - `provider` = CLI token copied from the earliest NON-subagent chat row
//!   (ordering as `derivedName`: non-null `startedAtNs` first, ascending, then
//!   `correlationId` ascending); when no non-subagent chat row exists, the
//!   earliest row including composited copies is used; a null/blank value
//!   normalizes to [`PROVIDER_UNKNOWN`]. Never re-derived here — the token is
//!   the canonical row's already-resolved field (NFR-6).
//!
//! **State casing.** `terminalStates` is declared in the row-model vocabulary
//! (PascalCase `RowState`); SQLite stores the machine name (`RowState::as_str`,
//! lowercase) — comparisons here go through `RowState::as_str()` (ST-1 fact 1,
//! `store.rs:88-101`).
//!
//! **Qualification.** The LOGICAL qualification rule stays on the frontend
//! (`rowDerivation.ts:390-421`); the projection applies the SAME predicate to
//! decide whether the group has a declared row at all, so contract (e)(iii)
//! ("a group ceases to qualify after a canonical mutation and its row is
//! deleted") is a real, observable transition:
//!
//! ```text
//! visibleTurnCount > 0 || (nonSubagentChatRowCount > 0 && userDispatchCount > 0)
//! ```
//!
//! The produced column set is FACTS ONLY — no `qualified` flag is emitted.

use std::collections::HashMap;

use anyhow::Result;
use serde_json::{Map, Value as JsonValue};
use sqlx::Row as _;

use crate::infrastructure::rtdb::attrs::PROVIDER_UNKNOWN;
use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, ToolUseRow};

use super::declaration::SessionRollupProjection;

// ── Fixed declared column names (contract (a)) ──────────────────────────────

/// Declared primary-key / group column.
pub const SESSION_ID: &str = "sessionId";
/// Min non-null chat `startedAtNs`.
pub const STARTED_AT_NS: &str = "startedAtNs";
/// Max chat `updatedAt`.
pub const LATEST_AT: &str = "latestAt";
/// All chat rows for the group.
pub const CHAT_ROW_COUNT: &str = "chatRowCount";
/// Chat rows with both subagent stamps null.
pub const NON_SUBAGENT_CHAT_ROW_COUNT: &str = "nonSubagentChatRowCount";
/// Non-subagent, non-transitional chat rows.
pub const VISIBLE_TURN_COUNT: &str = "visibleTurnCount";
/// Non-subagent `task` rows whose dispatch name is not excluded.
pub const USER_DISPATCH_COUNT: &str = "userDispatchCount";
/// Raw `userMessage` of the earliest non-blank chat row.
pub const DERIVED_NAME: &str = "derivedName";
/// Latest non-blank agent-session `agentName`.
pub const AGENT_NAME: &str = "agentName";
/// Canonical CLI token of the session (provider attribution; `unknown` when
/// absent). Copied from the canonical chat row — never re-derived (NFR-6).
pub const PROVIDER: &str = "provider";

/// The fixed fact column set the rollup produces (declaration order-independent).
pub const FACT_COLUMNS: [&str; 10] = [
    SESSION_ID,
    STARTED_AT_NS,
    LATEST_AT,
    CHAT_ROW_COUNT,
    NON_SUBAGENT_CHAT_ROW_COUNT,
    VISIBLE_TURN_COUNT,
    USER_DISPATCH_COUNT,
    DERIVED_NAME,
    AGENT_NAME,
    PROVIDER,
];

// ── Canonical row projections ───────────────────────────────────────────────

/// One canonical chat row projected to the columns the rollup reads.
#[derive(Clone, Debug, PartialEq)]
pub struct RollupChatRow {
    pub correlation_id: String,
    pub seq: i64,
    pub started_at_ns: Option<i64>,
    pub updated_at: String,
    /// Lowercase storage machine name (`RowState::as_str`).
    pub state: String,
    pub user_message: Option<String>,
    pub agent_reply: Option<String>,
    pub parent_session_id: Option<String>,
    pub composited_child_session_id: Option<String>,
    /// Canonical CLI token copied verbatim from `ChatRow.provider`.
    pub provider: Option<String>,
}

impl RollupChatRow {
    /// Project a canonical [`ChatRow`].
    pub fn from_chat_row(row: &ChatRow) -> Self {
        Self {
            correlation_id: row.correlation_id.clone(),
            seq: row.seq,
            started_at_ns: row.started_at_ns,
            updated_at: row.updated_at.clone(),
            state: row.state.as_str().to_string(),
            user_message: row.user_message.clone(),
            agent_reply: row.agent_reply.clone(),
            parent_session_id: row.parent_session_id.clone(),
            composited_child_session_id: row.composited_child_session_id.clone(),
            provider: row.provider.clone(),
        }
    }

    /// `true` iff the row belongs to a subagent session's turn (`parentSessionId`
    /// attribution join OR the #523 parent-keyed re-key stamp).
    pub fn is_subagent(&self) -> bool {
        self.parent_session_id.is_some() || self.composited_child_session_id.is_some()
    }
}

/// One canonical tool row projected to the columns the rollup reads.
#[derive(Clone, Debug, PartialEq)]
pub struct RollupToolRow {
    pub correlation_id: String,
    pub seq: i64,
    pub tool_name: Option<String>,
    pub tool_input_json: Option<String>,
    pub is_subagent: Option<bool>,
}

impl RollupToolRow {
    /// Project a canonical [`ToolUseRow`].
    pub fn from_tool_use_row(row: &ToolUseRow) -> Self {
        Self {
            correlation_id: row.correlation_id.clone(),
            seq: row.seq,
            tool_name: row.tool_name.clone(),
            tool_input_json: row.tool_input_json.clone(),
            is_subagent: row.is_subagent,
        }
    }
}

/// One canonical agent-session row projected to the columns the rollup reads.
#[derive(Clone, Debug, PartialEq)]
pub struct RollupAgentRow {
    pub correlation_id: String,
    pub seq: i64,
    pub updated_at: String,
    pub agent_name: Option<String>,
}

impl RollupAgentRow {
    /// Project a canonical [`AgentSessionRow`].
    pub fn from_agent_session_row(row: &AgentSessionRow) -> Self {
        Self {
            correlation_id: row.correlation_id.clone(),
            seq: row.seq,
            updated_at: row.updated_at.clone(),
            agent_name: row.agent_name.clone(),
        }
    }
}

// ── Group + facts ───────────────────────────────────────────────────────────

/// The canonical rows of one composited `sessionId` group.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RollupGroup {
    pub session_id: String,
    pub chats: Vec<RollupChatRow>,
    pub tools: Vec<RollupToolRow>,
    pub agents: Vec<RollupAgentRow>,
}

/// The documented fact columns for one group.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionRollupFacts {
    pub session_id: String,
    pub chat_row_count: i64,
    pub non_subagent_chat_row_count: i64,
    pub visible_turn_count: i64,
    pub user_dispatch_count: i64,
    pub started_at_ns: Option<i64>,
    pub latest_at: Option<String>,
    pub derived_name: Option<String>,
    pub agent_name: Option<String>,
    /// Canonical CLI token of the group's earliest non-subagent chat row;
    /// never null (`PROVIDER_UNKNOWN` when absent/blank).
    pub provider: String,
}

fn is_blank(value: Option<&str>) -> bool {
    value.is_none_or(|text| text.trim().is_empty())
}

/// The task-dispatch name key: `subagent_type`, falling back to `agent`; `None`
/// when neither is a non-empty string (`rowDerivation.ts:433-446`).
fn dispatch_name(input: Option<&str>) -> Option<String> {
    let parsed: JsonValue = serde_json::from_str(input?).ok()?;
    let record = parsed.as_object()?;
    for key in ["subagent_type", "agent"] {
        if let Some(name) = record.get(key).and_then(JsonValue::as_str) {
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Compute the documented facts for one group (pure — unit-tested).
pub fn compute_facts(group: &RollupGroup, config: &SessionRollupProjection) -> SessionRollupFacts {
    let terminal: Vec<&str> = config
        .terminal_states
        .iter()
        .map(|state| state.as_str())
        .collect();

    let mut non_subagent_chat_row_count = 0i64;
    let mut visible_turn_count = 0i64;
    let mut started_at_ns: Option<i64> = None;
    let mut latest_at: Option<String> = None;

    for chat in &group.chats {
        let subagent = chat.is_subagent();
        if !subagent {
            non_subagent_chat_row_count += 1;
        }
        let terminal_blank = terminal.contains(&chat.state.as_str())
            && is_blank(chat.agent_reply.as_deref());
        if !subagent && !terminal_blank {
            visible_turn_count += 1;
        }
        if let Some(ns) = chat.started_at_ns {
            started_at_ns = Some(started_at_ns.map_or(ns, |min| min.min(ns)));
        }
        latest_at = Some(match latest_at {
            Some(current) if current >= chat.updated_at => current,
            _ => chat.updated_at.clone(),
        });
    }

    // derivedName: earliest non-blank user message by (non-null startedAtNs,
    // correlationId) — nulls last (ST-1 recommendation: MIN over non-null).
    let mut named: Vec<&RollupChatRow> = group
        .chats
        .iter()
        .filter(|chat| !is_blank(chat.user_message.as_deref()))
        .collect();
    named.sort_by(|a, b| {
        a.started_at_ns
            .is_none()
            .cmp(&b.started_at_ns.is_none())
            .then_with(|| a.started_at_ns.cmp(&b.started_at_ns))
            .then_with(|| a.correlation_id.cmp(&b.correlation_id))
    });
    let derived_name = named.first().and_then(|chat| chat.user_message.clone());

    // agentName: latest (updatedAt desc, seq desc) non-blank name.
    let mut agents: Vec<&RollupAgentRow> = group.agents.iter().collect();
    agents.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.seq.cmp(&a.seq))
    });
    let agent_name = agents
        .iter()
        .find(|agent| !is_blank(agent.agent_name.as_deref()))
        .and_then(|agent| agent.agent_name.clone());

    // provider: the canonical token of the earliest NON-subagent chat row,
    // ordered exactly like `derivedName` (non-null `startedAtNs` first, ascending,
    // then `correlationId`). If no non-subagent chat row exists, fall back to the
    // earliest row INCLUDING composited copies. The token is copied verbatim from
    // the canonical row (NFR-6) — this projection performs no extraction of its
    // own; a null/blank value normalizes to `PROVIDER_UNKNOWN`.
    let mut provider_candidates: Vec<&RollupChatRow> = group
        .chats
        .iter()
        .filter(|chat| !chat.is_subagent())
        .collect();
    if provider_candidates.is_empty() {
        provider_candidates = group.chats.iter().collect();
    }
    provider_candidates.sort_by(|a, b| {
        a.started_at_ns
            .is_none()
            .cmp(&b.started_at_ns.is_none())
            .then_with(|| a.started_at_ns.cmp(&b.started_at_ns))
            .then_with(|| a.correlation_id.cmp(&b.correlation_id))
    });
    let provider = provider_candidates
        .first()
        .and_then(|chat| chat.provider.as_deref())
        .filter(|token| !token.trim().is_empty())
        .unwrap_or(PROVIDER_UNKNOWN)
        .to_string();

    let mut user_dispatch_count = 0i64;
    for tool in &group.tools {
        if tool.is_subagent == Some(true) {
            continue;
        }
        if tool.tool_name.as_deref() != Some("task") {
            continue;
        }
        let excluded = dispatch_name(tool.tool_input_json.as_deref()).is_some_and(|name| {
            config
                .exclude_dispatch_names
                .iter()
                .any(|excluded| excluded == &name)
        });
        if !excluded {
            user_dispatch_count += 1;
        }
    }

    SessionRollupFacts {
        session_id: group.session_id.clone(),
        chat_row_count: group.chats.len() as i64,
        non_subagent_chat_row_count,
        visible_turn_count,
        user_dispatch_count,
        started_at_ns,
        latest_at,
        derived_name,
        agent_name,
        provider,
    }
}

/// The frontend list-qualification predicate (`rowDerivation.ts:390-421`),
/// applied by the projection to decide row presence (see module doc).
pub fn qualifies(facts: &SessionRollupFacts) -> bool {
    facts.visible_turn_count > 0
        || (facts.non_subagent_chat_row_count > 0 && facts.user_dispatch_count > 0)
}

/// Map the facts onto the fixed declared column names (all ten).
pub fn fact_values(facts: &SessionRollupFacts) -> Map<String, JsonValue> {
    let mut values = Map::new();
    values.insert(
        SESSION_ID.to_string(),
        JsonValue::String(facts.session_id.clone()),
    );
    values.insert(
        STARTED_AT_NS.to_string(),
        facts.started_at_ns.map_or(JsonValue::Null, JsonValue::from),
    );
    values.insert(
        LATEST_AT.to_string(),
        facts
            .latest_at
            .clone()
            .map_or(JsonValue::Null, JsonValue::String),
    );
    values.insert(
        CHAT_ROW_COUNT.to_string(),
        JsonValue::from(facts.chat_row_count),
    );
    values.insert(
        NON_SUBAGENT_CHAT_ROW_COUNT.to_string(),
        JsonValue::from(facts.non_subagent_chat_row_count),
    );
    values.insert(
        VISIBLE_TURN_COUNT.to_string(),
        JsonValue::from(facts.visible_turn_count),
    );
    values.insert(
        USER_DISPATCH_COUNT.to_string(),
        JsonValue::from(facts.user_dispatch_count),
    );
    values.insert(
        DERIVED_NAME.to_string(),
        facts
            .derived_name
            .clone()
            .map_or(JsonValue::Null, JsonValue::String),
    );
    values.insert(
        AGENT_NAME.to_string(),
        facts.agent_name.clone().map_or(JsonValue::Null, JsonValue::String),
    );
    values.insert(
        PROVIDER.to_string(),
        JsonValue::String(facts.provider.clone()),
    );
    values
}

// ── Canonical reads (bounded, per group key) ────────────────────────────────

/// The PostgreSQL arm of [`load_persisted_group`] (Spec #2976 ST-6): the SAME
/// bounded, per-group SELECTs against the shared pool, wrapped in a READ ONLY
/// transaction (REQ-9). `tool_use_rows.is_subagent` is physically `BIGINT` on
/// PostgreSQL (the C1 `INTEGER→BIGINT` map), so it is normalized to
/// `Option<bool>` exactly like the canonical store's PG row mapper.
pub async fn load_persisted_group_pg(
    pool: &sqlx::PgPool,
    session_id: &str,
) -> Result<RollupGroup> {
    let mut tx = crate::infrastructure::storage::engine::begin_read_only(pool).await?;

    let chat_rows = sqlx::query(
        "SELECT correlation_id, seq, started_at_ns, updated_at, state,
                user_message, agent_reply, parent_session_id,
                composited_child_session_id, provider
         FROM chat_rows WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_all(&mut *tx)
    .await?;
    let chats = chat_rows
        .iter()
        .map(|row| {
            Ok(RollupChatRow {
                correlation_id: row.try_get(0)?,
                seq: row.try_get(1)?,
                started_at_ns: row.try_get(2)?,
                updated_at: row.try_get(3)?,
                state: row.try_get(4)?,
                user_message: row.try_get(5)?,
                agent_reply: row.try_get(6)?,
                parent_session_id: row.try_get(7)?,
                composited_child_session_id: row.try_get(8)?,
                provider: row.try_get(9)?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let tool_rows = sqlx::query(
        "SELECT correlation_id, seq, tool_name, tool_input_json, is_subagent
         FROM tool_use_rows WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_all(&mut *tx)
    .await?;
    let tools = tool_rows
        .iter()
        .map(|row| {
            Ok(RollupToolRow {
                correlation_id: row.try_get(0)?,
                seq: row.try_get(1)?,
                tool_name: row.try_get(2)?,
                tool_input_json: row.try_get(3)?,
                is_subagent: row
                    .try_get::<Option<i64>, _>(4)?
                    .map(|value| value != 0),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let agent_rows = sqlx::query(
        "SELECT correlation_id, seq, updated_at, agent_name
         FROM agent_session_rows WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_all(&mut *tx)
    .await?;
    let agents = agent_rows
        .iter()
        .map(|row| {
            Ok(RollupAgentRow {
                correlation_id: row.try_get(0)?,
                seq: row.try_get(1)?,
                updated_at: row.try_get(2)?,
                agent_name: row.try_get(3)?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    tx.commit().await?;

    Ok(RollupGroup {
        session_id: session_id.to_string(),
        chats,
        tools,
        agents,
    })
}

// ── In-flight overlay (write-behind lag correctness) ────────────────────────

/// One row observed by the projection engine, in rollup form.
#[derive(Clone, Debug, PartialEq)]
pub enum ObservedRow {
    Chat(RollupChatRow),
    Tool(RollupToolRow),
    Agent(RollupAgentRow),
}

/// Rows observed by the engine but not necessarily flushed to canonical SQLite
/// yet (the RTDB write-behind queue flushes in ~30 ms batches). Merged over the
/// persisted group by `seq`: the observed row wins unless SQL already carries a
/// `seq >=` value (the write caught up), so the declared row reflects EVERY
/// observed upsert even while the canonical write lags.
#[derive(Clone, Debug, Default)]
pub struct ObservedGroup {
    pub chats: HashMap<String, RollupChatRow>,
    pub tools: HashMap<String, RollupToolRow>,
    pub agents: HashMap<String, RollupAgentRow>,
}

impl ObservedGroup {
    /// Record one observed upsert (last-wins per correlationId — rows are
    /// identified by their composite key).
    pub fn observe(&mut self, row: ObservedRow) {
        match row {
            ObservedRow::Chat(row) => {
                self.chats.insert(row.correlation_id.clone(), row);
            }
            ObservedRow::Tool(row) => {
                self.tools.insert(row.correlation_id.clone(), row);
            }
            ObservedRow::Agent(row) => {
                self.agents.insert(row.correlation_id.clone(), row);
            }
        }
    }

    /// Merge the observed rows over a persisted group (observed wins unless SQL
    /// has caught up to `seq >=` the observed seq).
    pub fn merge_into(&self, group: &mut RollupGroup) {
        if !self.chats.is_empty() {
            let mut sql_seq: HashMap<String, i64> = group
                .chats
                .iter()
                .map(|row| (row.correlation_id.clone(), row.seq))
                .collect();
            for (correlation_id, observed) in &self.chats {
                if sql_seq
                    .get(correlation_id)
                    .is_some_and(|seq| *seq >= observed.seq)
                {
                    continue;
                }
                match group
                    .chats
                    .iter_mut()
                    .find(|row| &row.correlation_id == correlation_id)
                {
                    Some(slot) => *slot = observed.clone(),
                    None => group.chats.push(observed.clone()),
                }
                sql_seq.insert(correlation_id.clone(), observed.seq);
            }
        }

        if !self.tools.is_empty() {
            let mut sql_seq: HashMap<String, i64> = group
                .tools
                .iter()
                .map(|row| (row.correlation_id.clone(), row.seq))
                .collect();
            for (correlation_id, observed) in &self.tools {
                if sql_seq
                    .get(correlation_id)
                    .is_some_and(|seq| *seq >= observed.seq)
                {
                    continue;
                }
                match group
                    .tools
                    .iter_mut()
                    .find(|row| &row.correlation_id == correlation_id)
                {
                    Some(slot) => *slot = observed.clone(),
                    None => group.tools.push(observed.clone()),
                }
                sql_seq.insert(correlation_id.clone(), observed.seq);
            }
        }

        if !self.agents.is_empty() {
            let mut sql_seq: HashMap<String, i64> = group
                .agents
                .iter()
                .map(|row| (row.correlation_id.clone(), row.seq))
                .collect();
            for (correlation_id, observed) in &self.agents {
                if sql_seq
                    .get(correlation_id)
                    .is_some_and(|seq| *seq >= observed.seq)
                {
                    continue;
                }
                match group
                    .agents
                    .iter_mut()
                    .find(|row| &row.correlation_id == correlation_id)
                {
                    Some(slot) => *slot = observed.clone(),
                    None => group.agents.push(observed.clone()),
                }
                sql_seq.insert(correlation_id.clone(), observed.seq);
            }
        }
    }
}
