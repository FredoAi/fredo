//! EventBus — emits RTDB row batches on the "fredo-stream-event" Tauri IPC
//! channel.
//!
//! Spec #2788 P5.1 (AC6): the v1 raw-`FredoEvent` emission and the ECE
//! delivery/persistence choke point are deleted. `emit_row_delivery_batch` is
//! now the ONLY emission path — the ONLY sanctioned RTDB route to the webview.
//!
//! Registered as Tauri state in lib.rs and consumed by the RTDB flush loop.

use tauri::{AppHandle, Emitter};
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
}
