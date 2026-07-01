//! Spec #369 Contract — Mission Monitor Data Pipeline Fix
//!
//! This contract defines the trait signatures that all backend capsules must satisfy.
//! Capsules implement against these stubs — the compiler catches type mismatches.

use std::collections::HashMap;
use serde_json::Value;

// ── Capsule 1: ECE Init-Before-End ─────────────────────────────────────────

/// REQ-1: When completeWhen fires on the first event, emit both init and end.
/// This is implemented as an internal change to process_for_contract().
/// The contract method verifies the behavior in tests.
pub trait EceLifecycleContract {
    /// Verify that when completeWhen fires on first event, both init and end
    /// deliveries are returned, in order (init first, end second).
    /// Returns (init_delivery, end_delivery).
    fn req_1_verify_init_before_end(
        &self,
        event_json: Value,
        contract_name: &str,
    ) -> (Option<Value>, Option<Value>);
}

// ── Capsule 2: OTLP Payload Mapping ────────────────────────────────────────

/// REQ-2: Map OTLP span attributes to frontend-expected payload fields.
pub trait OtlpPayloadContract {
    /// Given raw OTLP span attributes, produce a mapped payload with:
    /// - turnInputTokens: from gen_ai.usage.input_tokens
    /// - turnOutputTokens: from gen_ai.usage.output_tokens
    /// - text fields mapped from gen_ai.response.body / gen_ai.request.body
    fn req_2_map_otlp_attributes(attrs: HashMap<String, Value>) -> HashMap<String, Value>;
}

// ── Capsule 3: FeatureStore Idempotent Insert ───────────────────────────────

/// REQ-3: Insert must be idempotent for duplicate primary keys.
pub trait IdempotentInsertContract {
    /// Insert rows; if a row with the same primary key already exists,
    /// silently ignore it (INSERT OR IGNORE). Returns count of actually inserted rows.
    fn req_3_idempotent_insert(
        &self,
        feature_id: &str,
        table_name: &str,
        rows: &[serde_json::Map<String, Value>],
    ) -> Result<u64, String>;
}
