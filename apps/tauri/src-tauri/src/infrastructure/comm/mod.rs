//! Communication Layer — the backbone of the Fredo event pipeline.
//!
//! Defines the canonical `FredoEvent` type, the `EventBus` that emits events
//! to the Tauri webview, the `CommAdapter` trait for agent providers, and
//! adapter implementations (OpenCodeAdapter, InternalAdapter).
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
pub use adapters::opencode::OpenCodeAdapter;

#[cfg(test)]
mod tests {
    mod event_tests;
    mod bus_tests;
    mod adapter_tests;
    mod ipc_tests;
}