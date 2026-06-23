//! EventBus — emits FredoEvent on the "fredo-stream-event" Tauri IPC channel.
//!
//! Registered as Tauri state in lib.rs and consumed by adapters, IPC dispatch,
//! and feature commands to emit events to the webview.

use tauri::{AppHandle, Emitter};
use crate::infrastructure::comm::event::FredoEvent;

/// EventBus emits FredoEvent on the "fredo-stream-event" Tauri channel.
///
/// Per REQ-1.7, this reuses the same IPC channel as StreamEvent.
#[derive(Debug)]
pub struct EventBus {
    app: AppHandle,
}

impl EventBus {
    /// Create a new EventBus with the given AppHandle.
    pub fn new(app: AppHandle) -> Self {
        EventBus { app }
    }

    /// Emit a FredoEvent to the Tauri webview via "fredo-stream-event".
    pub fn emit(&self, event: FredoEvent) {
        if let Err(e) = self.app.emit("fredo-stream-event", &event) {
            eprintln!("[fredo] Failed to emit FredoEvent: {e}");
        }
    }
}
