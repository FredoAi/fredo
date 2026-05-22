//! Stub InternalAdapter implementation.
//!
//! Minimal implementation so tests compile. The coder will flesh this out:
//! - Strict enum validation (reject unknown variants via serde)
//! - Arbitrary JSON for payload/metadata
//! - Stamping defaults (id, timestamp, transport: Hook, session_id: tauri-local)
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

use chrono::Utc;
use uuid::Uuid;

use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::event::{FredoEvent, EventProvider, Transport};

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

    /// Enrich a FredoEvent with server-side defaults per REQ-1.8.
    ///
    /// Stamps:
    /// - `id` → UUID if empty
    /// - `timestamp` → RFC3339 if empty
    /// - `session_id` → "tauri-local" if empty
    /// - `transport` → Hook if Internal provider (REQ-1.4)
    pub fn enrich(&self, mut event: FredoEvent) -> FredoEvent {
        if event.id.is_empty() {
            event.id = Uuid::new_v4().to_string();
        }
        if event.timestamp.is_empty() {
            event.timestamp = Utc::now().to_rfc3339();
        }
        if event.session_id.is_empty() {
            event.session_id = "tauri-local".into();
        }
        // REQ-1.4: Internal provider defaults to Hook transport
        if event.provider == EventProvider::Internal && event.transport == Transport::Internal {
            event.transport = Transport::Hook;
        }
        event
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