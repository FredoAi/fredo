//! Event Contract Engine (ECE)
//!
//! Spec #295, GitHub issue #295: Event Contract Engine
//!
//! The ECE replaces raw FredoEvent IPC emission with a declarative,
//! GraphQL-inspired contract system. Features declare which events
//! they consume and what fields they need. The engine buffers partial
//! events by correlation key and delivers progressively assembled
//! `SubscriptionDelivery` objects through the Init → Update → End lifecycle.

pub mod types;
pub mod complete_when;
pub mod engine;
pub mod commands;

pub use types::*;
pub use engine::ContractEngine;
pub use commands::{register_event_contracts, deregister_event_contracts};
