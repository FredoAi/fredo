//! EventBus — routes FredoEvent through the ContractEngine, emitting
//! SubscriptionDelivery on the "fredo-stream-event" Tauri IPC channel.
//!
//! Per Spec #295 REQ-11, raw FredoEvent never crosses the IPC bridge.
//! The ContractEngine converts them to SubscriptionDelivery objects.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::infrastructure::comm::contract::ContractEngine;
use crate::infrastructure::comm::event::FredoEvent;

/// EventBus emits SubscriptionDelivery on the "fredo-stream-event" Tauri channel.
///
/// Raw FredoEvent objects are fed to the ContractEngine internally and
/// never cross the IPC bridge (REQ-11).
#[derive(Debug)]
pub struct EventBus {
    app: AppHandle,
    engine: Arc<Mutex<ContractEngine>>,
}

impl EventBus {
    /// Create a new EventBus with the given AppHandle and ContractEngine.
    pub fn new(app: AppHandle, engine: Arc<Mutex<ContractEngine>>) -> Self {
        EventBus { app, engine }
    }

    /// Route a FredoEvent through the ContractEngine, emitting any
    /// resulting SubscriptionDelivery objects via IPC.
    pub fn emit(&self, event: FredoEvent) {
        let deliveries = {
            let mut eng = match self.engine.lock() {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[fredo] ContractEngine lock poisoned: {e}");
                    return;
                }
            };
            eng.process_event(&event)
        };

        // Emit all resulting SubscriptionDeliveries
        for delivery in &deliveries {
            if let Err(e) = self.app.emit("fredo-stream-event", delivery) {
                eprintln!("[fredo] Failed to emit SubscriptionDelivery: {e}");
            }
        }
    }
}
