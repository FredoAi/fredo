//! Communication Layer Foundation — stub types for TDD
//!
//! This module provides minimal type stubs so that unit tests can compile
//! against the expected interface. The coder will flesh out the actual
//! implementation.
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

pub mod adapters;
pub mod event;
pub mod bus;
pub mod adapter;

pub use event::{FredoEvent, FredoEventError, EventType, EventProvider, Transport, EventState};
pub use bus::EventBus;
pub use adapter::CommAdapter;
pub use adapters::internal::InternalAdapter;

#[cfg(test)]
mod tests {
    mod event_tests;
    mod bus_tests;
    mod adapter_tests;
    mod ipc_tests;
}