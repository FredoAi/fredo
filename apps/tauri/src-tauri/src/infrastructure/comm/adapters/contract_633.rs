/// Contract stub for Spec #633 (Redesign): Span Link Resolution + gen_ai.* Attribute Reading.
///
/// This contract defines the API surface for adapter-level changes.
/// Only the Software Architect edits this file — Developers implement against it
/// in their own code (inline in opencode.rs or in a dedicated impl module).
///
/// The redesign replaces the previous adapter-level parent prompt injection
/// workaround (contract_633_ac6c.rs) with:
/// 1. Span link resolution (REQ-6) — order-independent parent-child detection
/// 2. gen_ai.* attribute reading with fallback (REQ-7)
/// 3. Removal of pending_child_injections cross-batch state (REQ-8)

use serde_json::{Map, Value};
use std::collections::HashMap;

// ── REQ-6: Span Link Resolution ────────────────────────────────────────────

/// Extract the parent session ID from a span's OTLP span links.
///
/// Scans the `links` array on the span JSON for a link with
/// `parent.session_id` attribute. The link attributes use the same OTLP
/// key-value array format as span attributes, parseable by `otlp_attrs_to_map`.
///
/// # Arguments
/// * `span` - The OTLP span JSON object (may contain a "links" array)
///
/// # Returns
/// `Some(parent_session_id)` if a span link with `parent.session_id` is found,
/// `None` otherwise.
///
/// # OTLP JSON Link Format
/// ```json
/// "links": [{
///   "traceId": "hex_trace_id",
///   "spanId": "hex_span_id",
///   "attributes": [
///     {"key": "parent.session_id", "value": {"stringValue": "parent-123"}},
///     {"key": "relationship.type", "value": {"stringValue": "parent-child"}}
///   ]
/// }]
/// ```
pub fn req_6_extract_parent_from_span_links(span: &Value) -> Option<String> {
    // Stub: iterate span["links"], parse each link's attributes,
    // return parent.session_id stringValue if found.
    //
    // Implementation guidance:
    // 1. span.get("links").and_then(|l| l.as_array())
    // 2. For each link: Self::otlp_attrs_to_map(link.get("attributes"))
    // 3. Return link_attrs.get("parent.session_id").and_then(|v| v.as_str()).map(String::from)
    // 4. Return first match; ignore links without parent.session_id
    let _ = span;
    None
}

/// Populate session_to_parent from span links.
///
/// Called during OTLP span processing after extracting the child session_id.
/// If a parent is found via span links, inserts the child→parent mapping
/// into the session_to_parent map.
///
/// # Arguments
/// * `session_to_parent` - Mutable reference to the session_to_parent HashMap
/// * `child_session_id` - The subagent/child session ID
/// * `parent_session_id` - The parent session ID extracted from span links
pub fn req_6_populate_parent_from_links(
    session_to_parent: &mut HashMap<String, String>,
    child_session_id: &str,
    parent_session_id: &str,
) {
    if child_session_id != parent_session_id && !parent_session_id.is_empty() {
        session_to_parent.insert(child_session_id.to_string(), parent_session_id.to_string());
    }
}

// ── REQ-7: gen_ai.* Attribute Reading with Fallback ─────────────────────────

/// Extract instruction/prompt text from span attributes with new-path preference.
///
/// Priority: gen_ai.prompt → prompt → instruction (session span attribute).
/// Returns `None` if no non-empty text is found at any path.
///
/// # Arguments
/// * `attrs` - The merged span attributes map
/// * `is_subagent_span` - Whether this is a subagent span (unused, retained for API stability)
pub fn req_7_extract_instruction(attrs: &Map<String, Value>, _is_subagent_span: bool) -> Option<String> {
    // Stub: check gen_ai.prompt first, then prompt, then instruction.
    // Implementation guidance:
    // attrs.get("gen_ai.prompt").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
    //   .or_else(|| attrs.get("prompt").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
    //   .or_else(|| attrs.get("instruction").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
    //   .map(|s| s.to_string())
    let _ = attrs;
    None
}

/// Extract agent response text from span attributes with new-path preference.
///
/// Priority: gen_ai.response.body → response_text → output.
/// Returns `None` if no non-empty text is found at any path.
///
/// # Arguments
/// * `attrs` - The merged span attributes map
pub fn req_7_extract_response_text(attrs: &Map<String, Value>) -> Option<String> {
    // Stub: check gen_ai.response.body first, then response_text, then output.
    let _ = attrs;
    None
}

/// Extract token counts from span attributes with new-path preference.
///
/// Priority: gen_ai.usage.input_tokens → input_tokens; gen_ai.usage.output_tokens → output_tokens.
/// Handles both integer and string-encoded values.
///
/// # Arguments
/// * `attrs` - The merged span attributes map
///
/// # Returns
/// `(input_tokens, output_tokens)` — either may be 0 if not found.
pub fn req_7_extract_token_counts(attrs: &Map<String, Value>) -> (i64, i64) {
    // Stub: check gen_ai.usage.input_tokens first, then input_tokens.
    // Same for output tokens. Parse as i64 or string→i64.
    let _ = attrs;
    (0, 0)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Extract an i64 value from a serde_json Value, supporting both number and
/// string-encoded integer representations.
pub fn value_as_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    // ── REQ-6 Tests ───────────────────────────────────────────────────────

    #[test]
    fn test_extract_parent_from_span_link() {
        let span = serde_json::json!({
            "name": "fredo.session",
            "traceId": "trace-1",
            "spanId": "child-span",
            "links": [{
                "traceId": "trace-1",
                "spanId": "parent-span",
                "attributes": [
                    {"key": "parent.session_id", "value": {"stringValue": "parent-session-123"}},
                    {"key": "relationship.type", "value": {"stringValue": "parent-child"}}
                ]
            }]
        });
        let result = req_6_extract_parent_from_span_links(&span);
        assert_eq!(result.as_deref(), Some("parent-session-123"));
    }

    #[test]
    fn test_extract_parent_no_links_returns_none() {
        let span = serde_json::json!({
            "name": "fredo.session",
            "traceId": "trace-1"
        });
        let result = req_6_extract_parent_from_span_links(&span);
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_parent_empty_links_returns_none() {
        let span = serde_json::json!({
            "name": "fredo.session",
            "links": []
        });
        let result = req_6_extract_parent_from_span_links(&span);
        assert_eq!(result, None);
    }

    #[test]
    fn test_populate_parent_from_links_inserts() {
        let mut map = HashMap::new();
        req_6_populate_parent_from_links(&mut map, "child-1", "parent-1");
        assert_eq!(map.get("child-1").map(|s| s.as_str()), Some("parent-1"));
    }

    #[test]
    fn test_populate_parent_skips_self_reference() {
        let mut map = HashMap::new();
        req_6_populate_parent_from_links(&mut map, "same", "same");
        assert!(map.is_empty());
    }

    // ── REQ-7 Tests ───────────────────────────────────────────────────────

    #[test]
    fn test_extract_instruction_prefers_gen_ai_prompt() {
        let mut attrs = Map::new();
        attrs.insert("gen_ai.prompt".to_string(), Value::String("new path".to_string()));
        attrs.insert("prompt".to_string(), Value::String("old path".to_string()));
        let result = req_7_extract_instruction(&attrs, true);
        assert_eq!(result.as_deref(), Some("new path"));
    }

    #[test]
    fn test_extract_instruction_falls_back_to_prompt() {
        let mut attrs = Map::new();
        attrs.insert("prompt".to_string(), Value::String("fallback text".to_string()));
        let result = req_7_extract_instruction(&attrs, true);
        assert_eq!(result.as_deref(), Some("fallback text"));
    }

    #[test]
    fn test_extract_instruction_falls_back_to_instruction_attr() {
        let mut attrs = Map::new();
        attrs.insert("instruction".to_string(), Value::String("session span attr".to_string()));
        let result = req_7_extract_instruction(&attrs, true);
        assert_eq!(result.as_deref(), Some("session span attr"));
    }

    #[test]
    fn test_extract_instruction_empty_returns_none() {
        let mut attrs = Map::new();
        attrs.insert("gen_ai.prompt".to_string(), Value::String("".to_string()));
        let result = req_7_extract_instruction(&attrs, true);
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_response_text_prefers_gen_ai_response_body() {
        let mut attrs = Map::new();
        attrs.insert("gen_ai.response.body".to_string(), Value::String("new response".to_string()));
        attrs.insert("response_text".to_string(), Value::String("old response".to_string()));
        let result = req_7_extract_response_text(&attrs);
        assert_eq!(result.as_deref(), Some("new response"));
    }

    #[test]
    fn test_extract_response_text_falls_back_to_response_text() {
        let mut attrs = Map::new();
        attrs.insert("response_text".to_string(), Value::String("flat response".to_string()));
        let result = req_7_extract_response_text(&attrs);
        assert_eq!(result.as_deref(), Some("flat response"));
    }

    #[test]
    fn test_extract_token_counts_prefers_gen_ai_usage() {
        let mut attrs = Map::new();
        attrs.insert("gen_ai.usage.input_tokens".to_string(), serde_json::json!(100));
        attrs.insert("gen_ai.usage.output_tokens".to_string(), serde_json::json!(50));
        attrs.insert("input_tokens".to_string(), serde_json::json!(999));
        let (input, output) = req_7_extract_token_counts(&attrs);
        assert_eq!(input, 100);
        assert_eq!(output, 50);
    }

    #[test]
    fn test_extract_token_counts_falls_back_to_flat() {
        let mut attrs = Map::new();
        attrs.insert("input_tokens".to_string(), serde_json::json!(200));
        attrs.insert("output_tokens".to_string(), serde_json::json!(100));
        let (input, output) = req_7_extract_token_counts(&attrs);
        assert_eq!(input, 200);
        assert_eq!(output, 100);
    }

    #[test]
    fn test_value_as_i64_from_number() {
        let v = serde_json::json!(42);
        assert_eq!(value_as_i64(&v), Some(42));
    }

    #[test]
    fn test_value_as_i64_from_string() {
        let v = serde_json::json!("42");
        assert_eq!(value_as_i64(&v), Some(42));
    }
}
