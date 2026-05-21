//! InternalAdapter implementation.
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

use async_trait::async_trait;
use anyhow::Result;
use uuid::Uuid;
use chrono::Utc;
use super::super::adapter::CommAdapter;
use super::super::event::{EventProvider, FredoEvent, Transport};

/// InternalAdapter validates and enriches incoming FredoEvents.
///
/// Per REQ-1.8 and REQ-1.9:
/// - Strictly validates enum fields (reject unknown variants)
/// - Accepts arbitrary JSON for payload/metadata
/// - Stamps missing defaults
#[derive(Debug)]
pub struct InternalAdapter;

impl InternalAdapter {
    /// Create a new InternalAdapter.
    pub fn new() -> Self {
        InternalAdapter
    }

    /// Enrich a FredoEvent with server-side defaults.
    ///
    /// Stamps missing fields:
    /// - `id`: UUID v4
    /// - `timestamp`: RFC3339 current time
    /// - `session_id`: "tauri-local"
    /// - `transport`: Hook (when provider is Internal)
    pub fn enrich(&self, mut event: FredoEvent) -> FredoEvent {
        if event.id.is_empty() {
            event.id = Uuid::new_v4().to_string();
        }
        if event.timestamp.is_empty() {
            event.timestamp = Utc::now().to_rfc3339();
        }
        if event.session_id.is_empty() {
            event.session_id = "tauri-local".to_string();
        }
        // Internal provider events default to Hook transport
        if matches!(event.provider, EventProvider::Internal) && matches!(event.transport, Transport::Internal) {
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

#[async_trait]
impl CommAdapter for InternalAdapter {
    fn name(&self) -> &str {
        "internal"
    }

    fn provider(&self) -> EventProvider {
        EventProvider::Internal
    }

    async fn transform(
        &self,
        transport: Transport,
        raw: serde_json::Value,
    ) -> Result<Vec<FredoEvent>> {
        let mut event: FredoEvent = serde_json::from_value(raw)
            .map_err(|e| anyhow::anyhow!("Invalid FredoEvent: {}", e))?;
        event.transport = transport;
        Ok(vec![self.enrich(event)])
    }
}