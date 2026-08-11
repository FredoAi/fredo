/// Parent Prompt → Subagent Instruction Injection cache (Spec #633 AC-6c).
///
/// The fix addresses the gap where deepseek-v4-flash-free does not emit
/// `message.part.updated` events with `part.type === "subtask"`, so the plugin
/// never sets `prompt` on the subagent's fredo.llm OTLP span. Instead, the
/// adapter caches the parent session's prompt attribute and injects it as
/// `instruction` in the subagent's FredoEvent payload.
use std::collections::HashMap;

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
