// contract_601.rs — Shared contract for Spec #601 (OTLP adapter span mapping).
//
// Capsule B (Rust adapter) implements against this contract — updating
// normalize_op_name() and transform_otlp() to handle the new span format.
//
// READ-ONLY: Only the Software Architect edits this file.

use serde_json::{Map, Value};

/// Canonical op names that the adapter maps from OTLP span names.
/// These are the values returned by `normalize_op_name()`.
pub const OP_SESSION: &str = "session";
pub const OP_CHAT: &str = "chat";
pub const OP_TOOL_PREFIX: &str = "tool.";

/// Span name prefixes emitted by the fredo OTLP plugin.
pub const SPAN_PREFIX: &str = "fredo.";
pub const SPAN_SESSION_PREFIX: &str = "fredo.session";
pub const SPAN_LLM_PREFIX: &str = "fredo.llm";
pub const SPAN_TOOL_PREFIX: &str = "fredo.tool.";

/// Span attribute keys used in Claude Code / Fredo convention spans.
pub const ATTR_SESSION_ID: &str = "session.id";
pub const ATTR_INPUT_TOKENS: &str = "input_tokens";
pub const ATTR_OUTPUT_TOKENS: &str = "output_tokens";
pub const ATTR_REASONING_TOKENS: &str = "reasoning_tokens";
pub const ATTR_CACHE_READ_TOKENS: &str = "cache_read_tokens";
pub const ATTR_CACHE_CREATION_TOKENS: &str = "cache_creation_tokens";
pub const ATTR_MODEL: &str = "model";
pub const ATTR_PROVIDER: &str = "provider";
pub const ATTR_DURATION_MS: &str = "duration_ms";
pub const ATTR_SUCCESS: &str = "success";
pub const ATTR_COST_USD: &str = "cost_usd";
pub const ATTR_TOOL_NAME: &str = "tool_name";
pub const ATTR_TOOL_SUCCESS: &str = "tool.success";
pub const ATTR_TOOL_ERROR: &str = "tool.error";
pub const ATTR_SPAN_TYPE: &str = "span.type";
pub const ATTR_AGENT_TYPE: &str = "agent.type";

/// Legacy OTLP attribute keys (preserved for backward compatibility).
pub const LEGACY_ATTR_OP_NAME: &str = "gen_ai.operation.name";
pub const LEGACY_ATTR_CONVERSATION_ID: &str = "gen_ai.conversation.id";
pub const LEGACY_ATTR_INPUT_TOKENS: &str = "gen_ai.usage.input_tokens";
pub const LEGACY_ATTR_OUTPUT_TOKENS: &str = "gen_ai.usage.output_tokens";
pub const LEGACY_ATTR_REQUEST_BODY: &str = "gen_ai.request.body";
pub const LEGACY_ATTR_RESPONSE_MODEL: &str = "gen_ai.response.model";

/// Trait contract for the OTLP span normalisation and attribute extraction.
///
/// Capsule B (Rust adapter) implements these methods in `opencode.rs`.
/// The methods MUST handle both legacy `gen_ai.*` conventions AND the new
/// Claude Code / Fredo conventions.
pub trait Spec601Contract {
    /// Normalise an OTLP span name to a canonical op name.
    ///
    /// REQ-10: Recognises fredo.session → "session", fredo.llm → "chat",
    /// fredo.tool.<name> → "tool.<name>". Falls back to span.type attribute
    /// and legacy gen_ai.operation.name. Returns None if unrecognised.
    fn req_10_normalize_op_name(name: &str) -> Option<&'static str>;

    /// Determine EventState from span timing.
    ///
    /// REQ-11: Returns EventState::Response if span has end_time_unix_nano set,
    /// EventState::Init otherwise.
    fn req_11_event_state_from_span(span: &Map<String, Value>) -> crate::infrastructure::comm::event::EventState;

    /// Map Claude Code convention span attributes to the nested FredoEvent payload
    /// structure expected by the frontend.
    ///
    /// REQ-12: Extracts input_tokens → info.turnInputTokens, output_tokens →
    /// info.turnOutputTokens, model → info.modelID, etc. Preserves all flat
    /// attributes for backward compatibility.
    fn req_12_attrs_to_payload(attrs: Map<String, Value>) -> Value;
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    /// Verify span name prefix constants are consistent.
    #[test]
    fn span_prefix_constants_are_consistent() {
        assert!(SPAN_SESSION_PREFIX.starts_with(SPAN_PREFIX));
        assert!(SPAN_LLM_PREFIX.starts_with(SPAN_PREFIX));
        assert!(SPAN_TOOL_PREFIX.starts_with(SPAN_PREFIX));
        assert_ne!(SPAN_SESSION_PREFIX, SPAN_LLM_PREFIX);
    }

    /// Verify all span names start with fredo. prefix.
    #[test]
    fn span_names_have_correct_prefix() {
        assert!(SPAN_SESSION_PREFIX.starts_with("fredo."));
        assert!(SPAN_LLM_PREFIX.starts_with("fredo."));
        assert!(SPAN_TOOL_PREFIX.starts_with("fredo."));
    }

    /// Verify legacy attribute keys are distinct from new ones.
    #[test]
    fn attribute_keys_are_distinct() {
        // New convention keys should not collide with legacy gen_ai.* keys
        assert_ne!(ATTR_INPUT_TOKENS, LEGACY_ATTR_INPUT_TOKENS);
        assert_ne!(ATTR_OUTPUT_TOKENS, LEGACY_ATTR_OUTPUT_TOKENS);
    }
}
