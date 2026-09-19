//! EventBus — emits RTDB row batches on the "fredo-stream-event" Tauri IPC
//! channel.
//!
//! Spec #2788 P5.1 (AC6): the v1 raw-`FredoEvent` emission and the ECE
//! delivery/persistence choke point are deleted. `emit_row_delivery_batch` is
//! now the ONLY emission path — the ONLY sanctioned RTDB route to the webview.
//!
//! Registered as Tauri state in lib.rs and consumed by the RTDB flush loop.

use tauri::{AppHandle, Emitter};
use crate::infrastructure::feature_data::envelope::{
    FeatureDeliveryBatch, FeatureRowNotification,
};
use crate::infrastructure::rtdb::project::{RowDelivery, RowDeliveryBatch};

/// EventBus emits RTDB row batches on the "fredo-stream-event" Tauri channel.
#[derive(Debug)]
pub struct EventBus {
    app: AppHandle,
}

impl EventBus {
    /// Create a new EventBus with the given AppHandle.
    pub fn new(app: AppHandle) -> Self {
        EventBus { app }
    }

    /// Emit a BATCH of RTDB RowDelivery envelopes as ONE "fredo-stream-event"
    /// IPC event (Spec #2788 F-33 fix, W-1): the wire envelope is the
    /// camelCase `{"rowBatch": RowDelivery[]}` struct (`RowDeliveryBatch` in
    /// `rtdb/project.rs`), discriminated by the `rowBatch` field in
    /// AppProvider. This is the ONLY sanctioned RTDB emission path — RTDB
    /// code never calls app_handle.emit directly. Row deliveries are
    /// LIVE-only: they are never persisted through any writer queue.
    ///
    /// `replay_complete_query_id` (round-3 F-33 fix) rides the terminal
    /// emission of one query's replay drain; `None` on every live emission.
    /// The envelope omits the field on the wire when `None`.
    pub fn emit_row_delivery_batch(
        &self,
        deliveries: &[RowDelivery],
        replay_complete_query_id: Option<&str>,
    ) {
        let envelope = RowDeliveryBatch {
            row_batch: deliveries.to_vec(),
            replay_complete_query_id: replay_complete_query_id.map(str::to_string),
        };
        if let Err(e) = self.app.emit("fredo-stream-event", &envelope) {
            tracing::error!(target: "fredo::comm", error = %e, "emit RowDelivery batch failed");
        }
    }

    /// Emit a BATCH of feature-data notifications as ONE
    /// "fredo-stream-event" IPC event (Spec #2896 ST-4): the wire envelope is
    /// the camelCase `{"featureBatch": FeatureRowNotification[]}` struct
    /// (`FeatureDeliveryBatch` in `feature_data/envelope.rs`), discriminated by
    /// the `featureBatch` field in AppProvider BEFORE the RTDB `rowBatch`
    /// validators.
    ///
    /// This is the ONLY sanctioned feature-data emission path (declared-table
    /// watches never call `app_handle.emit` directly) and it rides the SAME
    /// channel as [`Self::emit_row_delivery_batch`] — the RTDB `rowBatch`
    /// contract and its emission path are unchanged.
    pub fn emit_feature_delivery_batch(&self, notifications: &[FeatureRowNotification]) {
        let envelope = FeatureDeliveryBatch::new(notifications.to_vec());
        if let Err(e) = self.app.emit("fredo-stream-event", &envelope) {
            tracing::error!(target: "fredo::comm", error = %e, "emit featureBatch failed");
        }
    }
}
