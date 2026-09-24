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
use rusqlite::{params, Connection};
use serde_json::{Map, Value as JsonValue};

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

/// The fixed fact column set the rollup produces (declaration order-independent).
pub const FACT_COLUMNS: [&str; 9] = [
    SESSION_ID,
    STARTED_AT_NS,
    LATEST_AT,
    CHAT_ROW_COUNT,
    NON_SUBAGENT_CHAT_ROW_COUNT,
    VISIBLE_TURN_COUNT,
    USER_DISPATCH_COUNT,
    DERIVED_NAME,
    AGENT_NAME,
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
    }
}

/// The frontend list-qualification predicate (`rowDerivation.ts:390-421`),
/// applied by the projection to decide row presence (see module doc).
pub fn qualifies(facts: &SessionRollupFacts) -> bool {
    facts.visible_turn_count > 0
        || (facts.non_subagent_chat_row_count > 0 && facts.user_dispatch_count > 0)
}

/// Map the facts onto the fixed declared column names (all nine).
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
    values
}

// ── Canonical reads (bounded, per group key) ────────────────────────────────

/// Read the persisted canonical rows for one group, selecting ONLY the columns
/// the rollup reads (never `raw_json`) — one bounded, indexed query per kind.
pub fn load_persisted_group(conn: &Connection, session_id: &str) -> Result<RollupGroup> {
    let chats = {
        let mut stmt = conn.prepare(
            "SELECT correlation_id, seq, started_at_ns, updated_at, state,
                    user_message, agent_reply, parent_session_id,
                    composited_child_session_id
             FROM chat_rows WHERE session_id = ?1",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(RollupChatRow {
                correlation_id: row.get(0)?,
                seq: row.get(1)?,
                started_at_ns: row.get(2)?,
                updated_at: row.get(3)?,
                state: row.get(4)?,
                user_message: row.get(5)?,
                agent_reply: row.get(6)?,
                parent_session_id: row.get(7)?,
                composited_child_session_id: row.get(8)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let tools = {
        let mut stmt = conn.prepare(
            "SELECT correlation_id, seq, tool_name, tool_input_json, is_subagent
             FROM tool_use_rows WHERE session_id = ?1",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(RollupToolRow {
                correlation_id: row.get(0)?,
                seq: row.get(1)?,
                tool_name: row.get(2)?,
                tool_input_json: row.get(3)?,
                is_subagent: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let agents = {
        let mut stmt = conn.prepare(
            "SELECT correlation_id, seq, updated_at, agent_name
             FROM agent_session_rows WHERE session_id = ?1",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(RollupAgentRow {
                correlation_id: row.get(0)?,
                seq: row.get(1)?,
                updated_at: row.get(2)?,
                agent_name: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::rows::RowState;

    fn config() -> SessionRollupProjection {
        SessionRollupProjection {
            kind: super::super::declaration::SessionRollupKind::SessionRollup,
            exclude_dispatch_names: vec!["build".to_string(), "plan".to_string()],
            terminal_states: vec![RowState::Response, RowState::Timeout],
        }
    }

    fn chat(correlation_id: &str, state: &str, reply: Option<&str>) -> RollupChatRow {
        RollupChatRow {
            correlation_id: correlation_id.to_string(),
            seq: 1,
            started_at_ns: Some(1_000),
            updated_at: "2026-09-18T00:00:00+00:00".to_string(),
            state: state.to_string(),
            user_message: None,
            agent_reply: reply.map(str::to_string),
            parent_session_id: None,
            composited_child_session_id: None,
        }
    }

    fn tool(correlation_id: &str, name: &str, subagent_type: Option<&str>, is_subagent: bool) -> RollupToolRow {
        RollupToolRow {
            correlation_id: correlation_id.to_string(),
            seq: 1,
            tool_name: Some(name.to_string()),
            tool_input_json: subagent_type
                .map(|value| format!(r#"{{"subagent_type":"{value}","prompt":"p"}}"#)),
            is_subagent: Some(is_subagent),
        }
    }

    fn group(chats: Vec<RollupChatRow>, tools: Vec<RollupToolRow>, agents: Vec<RollupAgentRow>) -> RollupGroup {
        RollupGroup {
            session_id: "ses_1".to_string(),
            chats,
            tools,
            agents,
        }
    }

    #[test]
    fn chat_row_count_counts_every_chat_row_including_subagent_copies() {
        let mut plain = chat("c1", "response", Some("done"));
        plain.started_at_ns = Some(2_000);
        let mut child_original = chat("c2", "response", Some("child"));
        child_original.parent_session_id = Some("ses_parent".to_string());
        let mut child_copy = chat("c3", "response", Some("copy"));
        child_copy.composited_child_session_id = Some("ses_child".to_string());

        let facts = compute_facts(&group(vec![plain, child_original, child_copy], vec![], vec![]), &config());
        assert_eq!(facts.chat_row_count, 3);
        assert_eq!(facts.non_subagent_chat_row_count, 1);
    }

    #[test]
    fn non_subagent_chat_row_count_requires_both_subagent_stamps_null() {
        let plain = chat("c1", "init", None);
        let mut parent_only = chat("c2", "init", None);
        parent_only.parent_session_id = Some("ses_parent".to_string());
        let mut composited_only = chat("c3", "init", None);
        composited_only.composited_child_session_id = Some("ses_child".to_string());
        let mut both = chat("c4", "init", None);
        both.parent_session_id = Some("ses_parent".to_string());
        both.composited_child_session_id = Some("ses_child".to_string());

        let facts = compute_facts(
            &group(vec![plain, parent_only, composited_only, both], vec![], vec![]),
            &config(),
        );
        assert_eq!(facts.non_subagent_chat_row_count, 1);
    }

    #[test]
    fn visible_turn_count_excludes_terminal_blank_turns_and_all_subagent_rows() {
        let visible = chat("c1", "response", Some("a real reply"));
        let transitional = chat("c2", "response", Some("   ")); // terminal + blank
        let timeout_blank = chat("c3", "timeout", None);
        let init_blank = chat("c4", "init", None); // NOT terminal → visible
        let mut subagent_visible = chat("c5", "init", None);
        subagent_visible.parent_session_id = Some("ses_parent".to_string());
        let mut copy_visible = chat("c6", "init", None);
        copy_visible.composited_child_session_id = Some("ses_child".to_string());

        let facts = compute_facts(
            &group(
                vec![
                    visible,
                    transitional,
                    timeout_blank,
                    init_blank,
                    subagent_visible,
                    copy_visible,
                ],
                vec![],
                vec![],
            ),
            &config(),
        );
        // c1 (visible), c4 (init is not terminal) — c2/c3 transitional, c5/c6 subagent.
        assert_eq!(facts.visible_turn_count, 2);
    }

    #[test]
    fn user_dispatch_count_counts_only_non_subagent_task_rows_not_excluded() {
        let developer = tool("t1", "task", Some("developer"), false);
        let build = tool("t2", "task", Some("build"), false);
        let plan = tool("t3", "task", Some("plan"), false);
        let child_dispatch = tool("t4", "task", Some("developer"), true);
        let non_task = tool("t5", "bash", None, false);
        let no_name = tool("t6", "task", None, false); // neither key → counts

        let facts = compute_facts(
            &group(
                vec![],
                vec![developer, build, plan, child_dispatch, non_task, no_name],
                vec![],
            ),
            &config(),
        );
        assert_eq!(facts.user_dispatch_count, 2, "developer + unnamed task");
    }

    #[test]
    fn agent_fallback_key_is_used_when_subagent_type_is_absent() {
        let row = RollupToolRow {
            correlation_id: "t1".to_string(),
            seq: 1,
            tool_name: Some("task".to_string()),
            tool_input_json: Some(r#"{"agent":"build","prompt":"p"}"#.to_string()),
            is_subagent: Some(false),
        };
        let facts = compute_facts(&group(vec![], vec![row], vec![]), &config());
        assert_eq!(facts.user_dispatch_count, 0, "agent fallback is excluded");
    }

    #[test]
    fn started_at_ns_is_the_min_non_null_and_latest_at_the_max_updated_at() {
        let mut a = chat("c1", "init", None);
        a.started_at_ns = Some(5_000);
        a.updated_at = "2026-09-18T00:00:05+00:00".to_string();
        let mut b = chat("c2", "init", None);
        b.started_at_ns = None; // ignored for the min
        b.updated_at = "2026-09-18T00:00:09+00:00".to_string();
        let mut c = chat("c3", "init", None);
        c.started_at_ns = Some(1_000);
        c.updated_at = "2026-09-18T00:00:01+00:00".to_string();

        let facts = compute_facts(&group(vec![a, b, c], vec![], vec![]), &config());
        assert_eq!(facts.started_at_ns, Some(1_000));
        assert_eq!(
            facts.latest_at.as_deref(),
            Some("2026-09-18T00:00:09+00:00")
        );
    }

    #[test]
    fn started_at_ns_is_null_when_every_chat_row_is_null() {
        let mut row = chat("c1", "init", None);
        row.started_at_ns = None;
        let facts = compute_facts(&group(vec![row], vec![], vec![]), &config());
        assert_eq!(facts.started_at_ns, None);
    }

    #[test]
    fn derived_name_is_the_earliest_non_blank_user_message_null_started_sorts_last() {
        let mut later = chat("c9", "init", None);
        later.user_message = Some("later message".to_string());
        later.started_at_ns = Some(9_000);
        let mut earliest = chat("c2", "init", None);
        earliest.user_message = Some("earliest message".to_string());
        earliest.started_at_ns = Some(2_000);
        let mut blank = chat("c1", "init", None);
        blank.user_message = Some("   ".to_string());
        blank.started_at_ns = Some(1_000); // blank → never selected
        let mut null_started = chat("c0", "init", None);
        null_started.user_message = Some("null started message".to_string());
        null_started.started_at_ns = None;

        let facts = compute_facts(
            &group(vec![later, earliest, blank, null_started], vec![], vec![]),
            &config(),
        );
        assert_eq!(facts.derived_name.as_deref(), Some("earliest message"));
    }

    #[test]
    fn derived_name_is_null_when_no_chat_row_has_a_non_blank_message() {
        let mut blank = chat("c1", "init", None);
        blank.user_message = Some("  ".to_string());
        let facts = compute_facts(&group(vec![blank], vec![], vec![]), &config());
        assert_eq!(facts.derived_name, None);
    }

    #[test]
    fn agent_name_is_the_latest_non_blank_across_agent_session_rows() {
        let old = RollupAgentRow {
            correlation_id: "a1".to_string(),
            seq: 5,
            updated_at: "2026-09-18T00:00:01+00:00".to_string(),
            agent_name: Some("old-agent".to_string()),
        };
        let blank_latest = RollupAgentRow {
            correlation_id: "a2".to_string(),
            seq: 9,
            updated_at: "2026-09-18T00:00:09+00:00".to_string(),
            agent_name: Some("  ".to_string()),
        };
        let newer = RollupAgentRow {
            correlation_id: "a3".to_string(),
            seq: 2,
            updated_at: "2026-09-18T00:00:05+00:00".to_string(),
            agent_name: Some("newer-agent".to_string()),
        };

        let facts = compute_facts(
            &group(
                vec![chat("c1", "init", None)],
                vec![],
                vec![old, blank_latest, newer],
            ),
            &config(),
        );
        assert_eq!(facts.agent_name.as_deref(), Some("newer-agent"));
    }

    #[test]
    fn qualification_matches_the_frontend_predicate() {
        let visible = compute_facts(
            &group(vec![chat("c1", "init", None)], vec![], vec![]),
            &config(),
        );
        assert!(qualifies(&visible), "a visible turn qualifies");

        // Transitional-only non-subagent row with no dispatch → does not qualify.
        let transitional = compute_facts(
            &group(vec![chat("c1", "response", Some(""))], vec![], vec![]),
            &config(),
        );
        assert!(!qualifies(&transitional));

        // Transitional-only but with a user-requested dispatch → qualifies.
        let dispatch_belt = compute_facts(
            &group(
                vec![chat("c1", "response", Some(""))],
                vec![tool("t1", "task", Some("developer"), false)],
                vec![],
            ),
            &config(),
        );
        assert!(qualifies(&dispatch_belt));

        // Subagent-only rows never qualify.
        let mut child = chat("c1", "init", None);
        child.composited_child_session_id = Some("ses_child".to_string());
        let subagent_only = compute_facts(&group(vec![child], vec![], vec![]), &config());
        assert!(!qualifies(&subagent_only));
    }

    #[test]
    fn merge_overlays_in_flight_rows_and_yields_to_a_caught_up_sql_seq() {
        let persisted = RollupChatRow::from_chat_row(&chat_row_fixture("c_persisted", 7));
        let mut group = RollupGroup {
            session_id: "ses_1".to_string(),
            chats: vec![persisted],
            tools: vec![],
            agents: vec![],
        };

        let mut observed = ObservedGroup::default();
        // Not yet flushed (seq 3 < persisted seq 7 is a different key) — overlaid.
        let mut in_flight = chat("c_in_flight", "response", Some("live"));
        in_flight.seq = 1;
        observed.observe(ObservedRow::Chat(in_flight));
        // SQL already caught up (seq 9 >= observed 5) — SQL wins.
        let mut stale = chat("c_persisted", "init", None);
        stale.seq = 5;
        observed.observe(ObservedRow::Chat(stale));

        observed.merge_into(&mut group);
        assert_eq!(group.chats.len(), 2);
        let persisted_after = group
            .chats
            .iter()
            .find(|row| row.correlation_id == "c_persisted")
            .expect("persisted row kept");
        assert_eq!(persisted_after.state, "response", "SQL caught up → SQL wins");
        assert!(group.chats.iter().any(|row| row.correlation_id == "c_in_flight"));
    }

    fn chat_row_fixture(correlation_id: &str, seq: i64) -> ChatRow {
        ChatRow {
            session_id: "ses_1".to_string(),
            correlation_id: correlation_id.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-09-18T00:00:00+00:00".to_string(),
            state: RowState::Response,
            provider: None,
            user_message: None,
            agent_reply: Some("persisted".to_string()),
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
}
