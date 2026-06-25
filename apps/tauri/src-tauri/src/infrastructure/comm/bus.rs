//! EventBus — emits SubscriptionDelivery on the "fredo-stream-event" Tauri IPC channel.
//!
//! After the ECE (Spec #303), EventBus emits SubscriptionDelivery objects instead
//! of raw FredoEvent objects. The old `emit(event: FredoEvent)` method is retained
//! for backward compatibility during migration, but the primary emission method is
//! `emit_delivery(delivery: SubscriptionDelivery)`.
//!
//! Registered as Tauri state in lib.rs and consumed by IPC dispatch, OTLP receivers,
//! and the ECE sweep task.

use tauri::{AppHandle, Emitter};
use crate::infrastructure::comm::contract::types::SubscriptionDelivery;
use crate::infrastructure::comm::event::FredoEvent;

/// EventBus emits SubscriptionDelivery on the "fredo-stream-event" Tauri channel.
///
/// NB-C12: After ECE, EventBus emits SubscriptionDelivery on "fredo-stream-event",
/// not raw FredoEvent.
#[derive(Debug)]
pub struct EventBus {
    app: AppHandle,
}

impl EventBus {
    /// Create a new EventBus with the given AppHandle.
    pub fn new(app: AppHandle) -> Self {
        EventBus { app }
    }

    /// Emit a SubscriptionDelivery to the Tauri webview via "fredo-stream-event".
    ///
    /// NB-C12: This is the primary emission path after ECE.
    pub fn emit_delivery(&self, delivery: SubscriptionDelivery) {
        if let Err(e) = self.app.emit("fredo-stream-event", &delivery) {
            eprintln!("[fredo] Failed to emit SubscriptionDelivery: {e}");
        }
    }

    /// Emit a FredoEvent to the Tauri webview via "fredo-stream-event".
    ///
    /// Retained for backward compatibility during migration. After full migration,
    /// all emission goes through `emit_delivery`.
    pub fn emit(&self, event: FredoEvent) {
        if let Err(e) = self.app.emit("fredo-stream-event", &event) {
            eprintln!("[fredo] Failed to emit FredoEvent: {e}");
        }
    }
}
