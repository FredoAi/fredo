//! Stub InternalAdapter implementation.
//!
//! Minimal implementation so tests compile. The coder will flesh this out:
//! - Strict enum validation (reject unknown variants via serde)
//! - Arbitrary JSON for payload/metadata
//! - Stamping defaults (id, timestamp, transport: Hook, session_id: tauri-local)
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::event::FredoEvent;

/// InternalAdapter validates and enriches incoming FredoEvents.
///
/// Per REQ-1.8 and REQ-1.9:
/// - Strictly validates enum fields (reject unknown variants)
/// - Accepts arbitrary JSON for payload/metadata
/// - Stamps missing defaults
#[derive(Debug)]
pub struct InternalAdapter;

impl InternalAdapter {
    pub fn new() -> Self {
        InternalAdapter
    }
}

impl Default for InternalAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CommAdapter for InternalAdapter {
    fn transform(&self, input: serde_json::Value) -> Result<FredoEvent, String> {
        // Stub: the coder will implement strict validation and enrichment.
        // For now, try direct deserialization; caller can inspect the result.
        serde_json::from_value(input).map_err(|e| e.to_string())
    }
}