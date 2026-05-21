//! Stub CommAdapter trait.
//!
//! Minimal trait so tests compile. The coder will implement actual adapters.
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

use crate::infrastructure::comm::event::FredoEvent;

/// Trait for event adapters that can transform or route FredoEvents.
///
/// The InternalAdapter is one implementation; others (e.g., OTLP adapters)
/// may follow.
pub trait CommAdapter {
    /// Transform an input JSON payload into a FredoEvent.
    fn transform(&self, input: serde_json::Value) -> Result<FredoEvent, String>;
}