//! Event Contract Engine — Rust infrastructure for the Spec #252 contract pipeline.
//!
//! The ECE replaces raw `FredoEvent` delivery with typed `SubscriptionDelivery`
//! objects. Features declare contracts; the engine buffers events by composite
//! key, evaluates `completeWhen` expressions, and manages Init→Update→End lifecycle.
//!
//! # Module structure
//!
//! - `types` — shared types (`ContractDeclaration`, `SubscriptionDelivery`,
//!   `ContractKey`, `CompleteWhenExpr`, `BufferedContract`)
//! - `input` — `EngineInput` (the ECE's input contract) + `From<FredoEvent>`
//! - `field` — `extract_field` for dot-notation field access on serializable inputs
//! - `complete` — `parse_complete_when` and `evaluate_complete_when`
//! - `engine` — `ContractEngine` (main stateful engine, implements
//!   `EventContractEngine` trait)
//! - `commands` — Tauri IPC command handlers
//! - `store` — `ContractEventStore` (Spec #2768 per-contract delivery
//!   persistence) + `ContractEventWriter` (non-blocking enqueue pipeline) +
//!   the batched writer task
//!
//! # Usage
//!
//! ```ignore
//! let bus = Arc::new(EventBus::new(app.handle().clone(), event_writer));
//! let engine = ContractEngine::new();
//! app.manage(engine);
//! ```

pub mod types;
pub mod input;
pub mod field;
pub mod complete;
pub mod engine;
pub mod commands;
pub mod store;

pub use engine::{ContractEngine, EventContractEngine};
pub use input::EngineInput;
pub use store::{ContractEventStore, ContractEventWriter};
pub use types::{
    ContractDeclaration, ContractKey, SubscriptionDelivery, CompleteWhenExpr,
    BufferedContract,
};
pub use field::extract_field;
pub use complete::parse_complete_when;

/// Comprehensive unit tests for the Event Contract Engine.
#[cfg(test)]
mod tests;
