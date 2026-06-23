//! CommAdapter trait — the interface every agent provider adapter implements.
//!
//! Adapters transform raw input (plugin hooks, OTLP spans, etc.) into
//! canonical `FredoEvent` objects via `transform(transport, raw) -> Vec<FredoEvent>`.

use async_trait::async_trait;
use anyhow::Result;
use super::event::{EventProvider, FredoEvent, Transport};

/// Trait for event adapters that can transform or route FredoEvents.
///
/// The InternalAdapter is one implementation; others (e.g., OTLP adapters)
/// may follow.
#[async_trait]
pub trait CommAdapter: Send + Sync + 'static {
    /// Return the adapter name.
    fn name(&self) -> &str;

    /// Return the event provider for this adapter.
    fn provider(&self) -> EventProvider;

    /// Transform an input JSON payload into FredoEvents.
    async fn transform(
        &self,
        transport: Transport,
        raw: serde_json::Value,
    ) -> Result<Vec<FredoEvent>>;
}