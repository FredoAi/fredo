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
pub mod bus;
pub mod adapter;

// Spec #3201 ST-2 — the wire vocabulary MOVED to `telemetry-domain`: it is domain
// vocabulary, and relocating it together with the extraction rules is what makes
// the NFR-6 single-definition form hold (there is no converter, so nothing can
// drift). Spec #3201 ST-7a re-pointed this module's own consumers at the crate and
// deliberately carries NO re-export of `event::{…}` names here — a `pub use` that
// let a consumer keep saying `comm::event::…` is exactly the coupling this spec
// removes.
pub use bus::EventBus;
pub use adapter::CommAdapter;
pub use adapters::internal::InternalAdapter;

#[cfg(test)]
mod tests {
    mod adapter_tests;
    mod ipc_tests;
}
