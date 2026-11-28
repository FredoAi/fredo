//! The relationship registry and the parent-prompt cache — everything that
//! keeps **a subagent's work visible in its parent's timeline**, plus the
//! Spec #633 AC-6c parent-prompt helpers that moved here from
//! `infrastructure/comm/adapters/parent_prompt_cache.rs` (Spec #3201 §1 edge 3).
//!
//! Moved verbatim from `infrastructure/rtdb/ingest.rs` by Spec #3201 ST-5; the
//! logic is unchanged, only its location and its boundary types (`RowUpsert` /
//! [`RowSink`](crate::RowSink) instead of `IngestRow` / `Rtdb`).
//!
//! ## The binding constraints this module protects
//!
//! - **A re-key NEVER removes a row.** `kind: remove` is emitted ONLY for
//!   retention eviction. Child-keyed rows stay intact, so no row vanishes
//!   mid-session for an active subscription.
//! - **The internal `build`/`plan` exclusion** ([`INTERNAL_TOOL_EXECUTION_AGENTS`]):
//!   those are OpenCode's internal tool-execution sessions, never
//!   user-requested @-subagent dispatches, so they must never register a
//!   relationship.
//! - **First-wins stamps**: the re-key copies each child row under the parent
//!   key carrying the `parentSessionId` + `compositedChildSessionId` stamps; a
//!   later re-key cannot overwrite them (`MergeRule::KeepFirst` in
//!   [`crate::merge`]).

use std::collections::HashMap;

use serde_json::Value;

use crate::attrs::MAP_CAPACITY;
use crate::event::FredoEvent;
use crate::rows::{RowKind, RowKey, RowUpsert};

use super::session::session_patch_from_row;
use super::tool::tool_patch_from_row;
use super::turn::chat_patch_from_row;

/// Internal OpenCode tool-execution agent names — port of the ECE exclusion
/// (`contract/engine.rs:768`, AGENTS.md #509 rule). Sessions whose agent name
/// resolves to one of these are NOT user-requested @-subagent dispatches and
/// must never register a child→parent relationship.
const INTERNAL_TOOL_EXECUTION_AGENTS: &[&str] = &["build", "plan"];

/// Whether a span's attributes resolve to an internal OpenCode
/// tool-execution agent (`build`/`plan`) — `engine.rs:855-864` port extended
/// with the raw `gen_ai.agent.name` attribute the plugin stamps on every span.
pub(crate) fn is_internal_tool_execution_agent(attrs: &serde_json::Map<String, Value>) -> bool {
    ["agent", "agent.name", "name", crate::attrs::ATTR_AGENT_NAME]
        .iter()
        .filter_map(|key| attrs.get(*key).and_then(|v| v.as_str()))
        .any(|name| INTERNAL_TOOL_EXECUTION_AGENTS.contains(&name))
}

impl super::IngestClassifier {
    // ── R-1e: relationship registry + re-key (ported from engine.rs:866-905) ──

    /// Register a child→parent relationship (idempotent per child; capped at
    /// [`MAP_CAPACITY`] with oldest-first eviction) and COPY the child's
    /// existing rows under the parent key. Returns the number of copied rows.
    pub(crate) async fn register_relationship(&self, parent: &str, child: &str) -> usize {
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
        self.rekey_child_rows(parent, child).await
    }

    /// The parent of a registered child session, if any.
    pub(crate) fn parent_of(&self, child: &str) -> Option<String> {
        self.child_to_parent
            .lock()
            .ok()
            .and_then(|m| m.get(child).cloned())
    }

    /// Copy the child's EXISTING rows under the parent key (the re-key).
    /// Child-keyed rows are LEFT INTACT — a re-key never removes rows (the
    /// binding `kind: remove` constraint). The cached ∪ persisted key set is
    /// read so rows inside the write-behind window are not missed.
    pub(crate) async fn rekey_child_rows(&self, parent: &str, child: &str) -> usize {
        let mut copied = 0usize;

        if let Ok(chat_keys) = self.sink.keys_for_session(RowKind::Chat, child).await {
            for RowKey { correlation_id, .. } in chat_keys {
                if let Ok(Some(RowUpsert::Chat(existing))) = self
                    .sink
                    .get_row(RowKind::Chat, child, &correlation_id)
                    .await
                {
                    self.apply_chat(
                        chat_patch_from_row(&existing, parent),
                        Some((parent, child)),
                    )
                    .await;
                    copied += 1;
                }
            }
        }
        if let Ok(tool_keys) = self.sink.keys_for_session(RowKind::ToolUse, child).await {
            for RowKey { correlation_id, .. } in tool_keys {
                if let Ok(Some(RowUpsert::ToolUse(existing))) = self
                    .sink
                    .get_row(RowKind::ToolUse, child, &correlation_id)
                    .await
                {
                    self.apply_tool_use(tool_patch_from_row(&existing, parent)).await;
                    copied += 1;
                }
            }
        }
        if let Ok(session_keys) = self.sink.keys_for_session(RowKind::AgentSession, child).await {
            for RowKey { correlation_id, .. } in session_keys {
                if let Ok(Some(RowUpsert::AgentSession(existing))) = self
                    .sink
                    .get_row(RowKind::AgentSession, child, &correlation_id)
                    .await
                {
                    self.apply_agent_session(session_patch_from_row(&existing, parent))
                        .await;
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
    pub(crate) async fn detect_event_relationship(
        &self,
        event: &FredoEvent,
        payload: &Value,
    ) -> usize {
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
                    return self.register_relationship(parent, child).await;
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
            return self.register_relationship(parent, &event.session_id).await;
        }
        0
    }

    /// Instruction injection for subagent payloads (Spec #633 order:
    /// pending task instruction → parent prompt cache). rawJson parity with
    /// the v1 payload.
    pub(crate) fn inject_instruction_if_needed(
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
            req_2_inject_parent_prompt_as_instruction(
                &parent_prompts,
                &session_to_parent,
                session_id,
                payload,
            );
        }
    }
}

// ── Parent-prompt cache (Spec #633 AC-6c) ───────────────────────────────────
//
// Moved verbatim from `infrastructure/comm/adapters/parent_prompt_cache.rs`
// (Spec #3201 §1 edge 3) together with its `mod tests`. The helpers are pure
// and stateless: every piece of state arrives as an argument, and
// `MAX_PARENT_PROMPT_ENTRIES` is a `const`, so nothing infrastructure-shaped
// remained to travel.
//
// The fix addresses the gap where deepseek-v4-flash-free does not emit
// `message.part.updated` events with `part.type === "subtask"`, so the plugin
// never sets `prompt` on the subagent's fredo.llm OTLP span. Instead, the
// adapter caches the parent session's prompt attribute and injects it as
// `instruction` in the subagent's FredoEvent payload.

/// Bounded prompt cache for parent session prompts.
/// Maps session_id → prompt text (the full user message from the OTLP span).
/// Capped at MAX_ENTRIES with oldest-first eviction.
const MAX_PARENT_PROMPT_ENTRIES: usize = 10_000;

/// Requirement ID: REQ-1
///
/// Cache a primary session's prompt for later subagent instruction injection.
/// Called when processing any OTLP span that is NOT a subagent and has a
/// `prompt` or `gen_ai.prompt` attribute.
///
/// # Arguments
/// * `map` - The mutable reference to the parent_prompts HashMap
/// * `session_id` - The session_id of the primary session
/// * `prompt` - The prompt text to cache (non-empty, already validated)
pub fn req_1_cache_parent_prompt(
    map: &mut HashMap<String, String>,
    session_id: &str,
    prompt: &str,
) {
    if prompt.trim().is_empty() {
        return;
    }
    if map.len() >= MAX_PARENT_PROMPT_ENTRIES && !map.contains_key(session_id) {
        // Evict oldest entry (HashMap iteration order is not FIFO,
        // but for a bounded cache this is acceptable; the map acts as
        // a simple LRU approximation since entries are inserted in arrival order)
        if let Some(key) = map.keys().next().cloned() {
            map.remove(&key);
        }
    }
    map.insert(session_id.to_string(), prompt.to_string());
}

/// Requirement ID: REQ-3 (Spec #2933 ST-3R)
///
/// Read-only lookup of a session's cached prompt. Used by the classifier to
/// re-carry an exchange's user prompt onto a Copilot continuation chat row
/// (Copilot splits one user turn across two `chat` spans, and the continuation
/// span's own `gen_ai.input.messages` carries no `user` message).
///
/// Returns `None` when the session has no cached prompt (the dispatch span has
/// not been ingested yet) or the cached text is blank — the caller must then
/// leave the row's content fields absent rather than fabricate a prompt.
pub fn req_3_cached_prompt<'a>(
    map: &'a HashMap<String, String>,
    session_id: &str,
) -> Option<&'a str> {
    map.get(session_id)
        .map(String::as_str)
        .filter(|prompt| !prompt.trim().is_empty())
}

/// Requirement ID: REQ-2
///
/// Inject the parent session's cached prompt as `instruction` into a subagent
/// FredoEvent payload. Only injects if the payload does NOT already contain a
/// non-empty `instruction` field (respects higher-priority injection paths:
/// otlp_attrs_to_payload → pending_task_instructions → parent_prompts).
///
/// # Arguments
/// * `parent_prompts` - The cached parent prompt map
/// * `session_to_parent` - The session_to_parent relationship map
/// * `child_session_id` - The subagent's session_id
/// * `payload` - Mutable reference to the FredoEvent payload (serde_json::Value Object)
///
/// # Returns
/// `true` if instruction was injected, `false` otherwise
pub fn req_2_inject_parent_prompt_as_instruction(
    parent_prompts: &HashMap<String, String>,
    session_to_parent: &HashMap<String, String>,
    child_session_id: &str,
    payload: &mut serde_json::Value,
) -> bool {
    // Only inject if payload does NOT already have a non-empty instruction
    let has_existing = payload
        .get("instruction")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    if has_existing {
        return false;
    }

    // Look up parent session ID from session_to_parent map
    let parent_id = match session_to_parent.get(child_session_id) {
        Some(pid) if pid != child_session_id => pid,
        _ => return false,
    };

    // Look up parent's cached prompt
    let instruction = match parent_prompts.get(parent_id) {
        Some(p) if !p.trim().is_empty() => p.clone(),
        _ => return false,
    };

    // Inject instruction into payload
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "instruction".to_string(),
            serde_json::Value::String(instruction),
        );
        true
    } else {
        false
    }
}

#[cfg(test)]
mod parent_prompt_cache_tests {
    use super::*;

    /// REQ-1 AC-1: Prompt is cached and retrievable.
    #[test]
    fn test_cache_parent_prompt_and_retrieve() {
        let mut map = HashMap::new();
        req_1_cache_parent_prompt(&mut map, "session-1", "Solve the problem");
        assert_eq!(map.get("session-1").map(|s| s.as_str()), Some("Solve the problem"));
    }

    /// REQ-1 AC-2: Empty prompt is NOT cached.
    #[test]
    fn test_empty_prompt_not_cached() {
        let mut map = HashMap::new();
        req_1_cache_parent_prompt(&mut map, "session-1", "");
        assert!(!map.contains_key("session-1"));
        req_1_cache_parent_prompt(&mut map, "session-2", "   ");
        assert!(!map.contains_key("session-2"));
    }

    /// REQ-1 AC-3: Map eviction at capacity.
    #[test]
    fn test_map_eviction_at_capacity() {
        let mut map = HashMap::new();
        // Fill to capacity
        for i in 0..MAX_PARENT_PROMPT_ENTRIES {
            req_1_cache_parent_prompt(&mut map, &format!("session-{}", i), "prompt");
        }
        assert_eq!(map.len(), MAX_PARENT_PROMPT_ENTRIES);
        // Insert one more — should evict oldest and stay at capacity
        req_1_cache_parent_prompt(&mut map, "overflow", "overflow-prompt");
        assert!(map.len() <= MAX_PARENT_PROMPT_ENTRIES);
        assert!(map.contains_key("overflow"));
    }

    /// REQ-3 (Spec #2933 ST-3R): read-only cached-prompt lookup.
    #[test]
    fn test_req_3_cached_prompt_read_only_lookup() {
        let mut map = HashMap::new();
        req_1_cache_parent_prompt(&mut map, "session-1", "Exchange prompt");
        assert_eq!(req_3_cached_prompt(&map, "session-1"), Some("Exchange prompt"));
        // Unknown session → None (no fabrication).
        assert_eq!(req_3_cached_prompt(&map, "session-unknown"), None);
        // Blank cached text is treated as absent.
        map.insert("blank".to_string(), "   ".to_string());
        assert_eq!(req_3_cached_prompt(&map, "blank"), None);
    }

    /// REQ-2 AC-4: Subagent receives parent's cached prompt as instruction.
    #[test]
    fn test_subagent_receives_parent_prompt_as_instruction() {
        let mut parent_prompts = HashMap::new();
        parent_prompts.insert("parent-1".to_string(), "Fix the bug".to_string());

        let mut session_to_parent = HashMap::new();
        session_to_parent.insert("child-1".to_string(), "parent-1".to_string());

        let mut payload = serde_json::json!({});
        let result = req_2_inject_parent_prompt_as_instruction(
            &parent_prompts,
            &session_to_parent,
            "child-1",
            &mut payload,
        );
        assert!(result);
        assert_eq!(payload["instruction"].as_str().unwrap(), "Fix the bug");
    }

    /// REQ-2 AC-5: Existing instruction is NOT overwritten.
    #[test]
    fn test_existing_instruction_not_overwritten_by_parent_prompt() {
        let mut parent_prompts = HashMap::new();
        parent_prompts.insert("parent-1".to_string(), "Parent prompt".to_string());

        let mut session_to_parent = HashMap::new();
        session_to_parent.insert("child-1".to_string(), "parent-1".to_string());

        // Payload already has instruction from otlp_attrs_to_payload
        let mut payload = serde_json::json!({"instruction": "Direct instruction from span"});
        let result = req_2_inject_parent_prompt_as_instruction(
            &parent_prompts,
            &session_to_parent,
            "child-1",
            &mut payload,
        );
        assert!(!result, "Should NOT inject when instruction already exists");
        assert_eq!(
            payload["instruction"].as_str().unwrap(),
            "Direct instruction from span"
        );
    }

    /// REQ-3 AC-8: Primary agent (no parent in session_to_parent) gets no instruction.
    #[test]
    fn test_no_parent_no_instruction_injection() {
        let mut parent_prompts = HashMap::new();
        parent_prompts.insert("session-1".to_string(), "Some prompt".to_string());

        let session_to_parent = HashMap::new(); // empty — session-1 has no parent

        let mut payload = serde_json::json!({});
        let result = req_2_inject_parent_prompt_as_instruction(
            &parent_prompts,
            &session_to_parent,
            "session-1",
            &mut payload,
        );
        assert!(!result);
        assert!(payload.get("instruction").is_none());
    }

    /// REQ-2: Parent prompt is empty — no injection.
    #[test]
    fn test_empty_parent_prompt_no_injection() {
        let mut parent_prompts = HashMap::new();
        parent_prompts.insert("parent-1".to_string(), "   ".to_string()); // whitespace only

        let mut session_to_parent = HashMap::new();
        session_to_parent.insert("child-1".to_string(), "parent-1".to_string());

        let mut payload = serde_json::json!({});
        let result = req_2_inject_parent_prompt_as_instruction(
            &parent_prompts,
            &session_to_parent,
            "child-1",
            &mut payload,
        );
        assert!(!result);
    }

    /// REQ-2: Multiple subagents from the same parent all get the instruction.
    #[test]
    fn test_multiple_subagents_same_parent() {
        let mut parent_prompts = HashMap::new();
        parent_prompts.insert("parent-1".to_string(), "Task A".to_string());

        let mut session_to_parent = HashMap::new();
        session_to_parent.insert("child-1".to_string(), "parent-1".to_string());
        session_to_parent.insert("child-2".to_string(), "parent-1".to_string());

        let mut payload1 = serde_json::json!({});
        let result1 = req_2_inject_parent_prompt_as_instruction(
            &parent_prompts,
            &session_to_parent,
            "child-1",
            &mut payload1,
        );
        assert!(result1);
        assert_eq!(payload1["instruction"].as_str().unwrap(), "Task A");

        let mut payload2 = serde_json::json!({});
        let result2 = req_2_inject_parent_prompt_as_instruction(
            &parent_prompts,
            &session_to_parent,
            "child-2",
            &mut payload2,
        );
        assert!(result2);
        assert_eq!(payload2["instruction"].as_str().unwrap(), "Task A");
    }
}
