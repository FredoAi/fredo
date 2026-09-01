//! EventBus — emits SubscriptionDelivery on the "fredo-stream-event" Tauri IPC channel.
//!
//! After the ECE (Spec #303), EventBus emits SubscriptionDelivery objects instead
//! of raw FredoEvent objects. The old `emit(event: FredoEvent)` method is retained
//! for backward compatibility during migration, but the primary emission method is
//! `emit_delivery(delivery: SubscriptionDelivery)`.
//!
//! Registered as Tauri state in lib.rs and consumed by IPC dispatch, OTLP receivers,
//! and the ECE sweep task.
//!
//! Spec #2768 (ST-3): `emit_delivery` is ALSO the single persistence choke point —
//! every SubscriptionDelivery of a persistent contract is enqueued into the bounded
//! `ContractEventWriter` queue here, covering all process call-sites, the 5s sweep,
//! and deregister ends without touching them. The enqueue is non-blocking
//! (overflow sheds persistence work, never live deliveries — R8).

use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use crate::infrastructure::comm::contract::store::ContractEventWriter;
use crate::infrastructure::comm::contract::types::SubscriptionDelivery;
use crate::infrastructure::comm::event::FredoEvent;
use crate::infrastructure::rtdb::project::{RowDelivery, RowDeliveryBatch};

/// EventBus emits SubscriptionDelivery on the "fredo-stream-event" Tauri channel.
///
/// NB-C12: After ECE, EventBus emits SubscriptionDelivery on "fredo-stream-event",
/// not raw FredoEvent.
#[derive(Debug)]
pub struct EventBus {
    app: AppHandle,
    /// Spec #2768: non-blocking persistence enqueue handle for persistent
    /// contracts. Enqueues happen inside emit_delivery — the single choke point.
    event_writer: Arc<ContractEventWriter>,
}

impl EventBus {
    /// Create a new EventBus with the given AppHandle and persistence writer.
    pub fn new(app: AppHandle, event_writer: Arc<ContractEventWriter>) -> Self {
        EventBus { app, event_writer }
    }

    /// Emit a SubscriptionDelivery to the Tauri webview via "fredo-stream-event".
    ///
    /// NB-C12: This is the primary emission path after ECE.
    ///
    /// Spec #2768 (R8): the persistence enqueue happens AFTER the live emit and
    /// never blocks — a full persistence queue sheds the enqueue, not the delivery.
    pub fn emit_delivery(&self, delivery: SubscriptionDelivery) {
        if let Err(e) = self.app.emit("fredo-stream-event", &delivery) {
            tracing::error!(target: "fredo::comm", error = %e, "emit SubscriptionDelivery failed");
        }
        self.event_writer.enqueue(&delivery);
    }

    /// Emit a FredoEvent to the Tauri webview via "fredo-stream-event".
    ///
    /// Retained for backward compatibility during migration. After full migration,
    /// all emission goes through `emit_delivery`.
    pub fn emit(&self, event: FredoEvent) {
        if let Err(e) = self.app.emit("fredo-stream-event", &event) {
            tracing::error!(target: "fredo::comm", error = %e, "emit FredoEvent failed");
        }
    }

    /// Emit a BATCH of RTDB RowDelivery envelopes as ONE "fredo-stream-event"
    /// IPC event (Spec #2788 F-33 fix, W-1): the wire envelope is the
    /// camelCase `{"rowBatch": RowDelivery[]}` struct (`RowDeliveryBatch` in
    /// `rtdb/project.rs`), discriminated by the `rowBatch` field in
    /// AppProvider. Single-delivery consumers on the v1 path are unaffected —
    /// the v1 emit_delivery/emit paths keep working untouched. This is the
    /// ONLY sanctioned RTDB emission path — RTDB code never calls
    /// app_handle.emit directly. Row deliveries are LIVE-only: they are never
    /// enqueued into the contract-event persistence writer.
    pub fn emit_row_delivery_batch(&self, deliveries: &[RowDelivery]) {
        let envelope = RowDeliveryBatch {
            row_batch: deliveries.to_vec(),
        };
        if let Err(e) = self.app.emit("fredo-stream-event", &envelope) {
            tracing::error!(target: "fredo::comm", error = %e, "emit RowDelivery batch failed");
        }
    }
}
