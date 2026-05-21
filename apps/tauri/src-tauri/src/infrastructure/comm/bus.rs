//! Stub EventBus for the Fredo event bus.
//!
//! Minimal implementation so tests compile. The coder will flesh this out.
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

use tauri::AppHandle;
use crate::infrastructure::comm::event::FredoEvent;

/// EventBus emits FredoEvent on the "fredo-stream-event" Tauri channel.
///
/// Per REQ-1.7, this reuses the same IPC channel as StreamEvent.
#[derive(Debug)]
pub struct EventBus;

impl EventBus {
    /// Emit a FredoEvent to the Tauri webview via "fredo-stream-event".
    pub fn emit(app: &AppHandle, event: FredoEvent) {
        // Stub: actual implementation will call app.emit("fredo-stream-event", &event)
        let _ = app;
        let _ = event;
    }
}