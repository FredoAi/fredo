//! Communication Layer — the canonical `FredoEvent` wire type and the
//! `EventBus` that emits RTDB row batches to the Tauri webview.
//!
//! Spec #2788 P5.1 (AC6): the v1 event pipeline (contract engine / ECE, the
//! OpenCode + OTLP v1 adapters, raw/legacy EventBus emission) is deleted —
//! RTDB row deliveries are the ONLY thing that crosses IPC. `FredoEvent`
//! survives as the `fredo emit` CLI wire format and classifier input.
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
    mod adapter_tests;
    mod ipc_tests;
}
