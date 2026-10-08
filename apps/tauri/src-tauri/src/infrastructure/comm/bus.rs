//! EventBus — emits RTDB row batches on the "fredo-stream-event" Tauri IPC
//! channel.
//!
//! Spec #2788 P5.1 (AC6): the v1 raw-`FredoEvent` emission and the ECE
//! delivery/persistence choke point are deleted. `emit_row_delivery_batch` is
//! now the ONLY emission path — the ONLY sanctioned RTDB route to the webview.
//!
//! Registered as Tauri state in lib.rs and consumed by the RTDB flush loop.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use crate::infrastructure::application_data::envelope::{
    ApplicationDeliveryBatch, ApplicationRowNotification,
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

    /// Emit a BATCH of application-data notifications as ONE
    /// "fredo-stream-event" IPC event (Spec #2896 ST-4): the wire envelope is
    /// the camelCase `{"applicationBatch": ApplicationRowNotification[]}` struct
    /// (`ApplicationDeliveryBatch` in `application_data/envelope.rs`), discriminated by
    /// the `applicationBatch` field in AppProvider BEFORE the RTDB `rowBatch`
    /// validators.
    ///
    /// This is the ONLY sanctioned application-data emission path (declared-table
    /// watches never call `app_handle.emit` directly) and it rides the SAME
    /// channel as [`Self::emit_row_delivery_batch`] — the RTDB `rowBatch`
    /// contract and its emission path are unchanged.
    pub fn emit_application_delivery_batch(&self, notifications: &[ApplicationRowNotification]) {
        let envelope = ApplicationDeliveryBatch::new(notifications.to_vec());
        if let Err(e) = self.app.emit("fredo-stream-event", &envelope) {
            tracing::error!(target: "fredo::comm", error = %e, "emit applicationBatch failed");
        }
    }

    /// Emit `event` with `payload` to ONE webview `window` (targeted delivery).
    ///
    /// This is the sanctioned path for an application's window-scoped status event
    /// (Spec #2969 ST-5: the Doom window's `doom-autoplay-changed`): like
    /// [`Self::emit_row_delivery_batch`], it keeps the emission behind the
    /// EventBus so application code never calls `AppHandle::emit_to` directly. A
    /// missing window is not an error — it is logged at debug.
    pub fn emit_to_window<T: Serialize>(&self, window: &str, event: &str, payload: &T) {
        if let Err(error) = self.app.emit_to(window, event, payload) {
            tracing::debug!(
                target: "fredo::comm",
                error = %error,
                window,
                event,
                "emit_to_window skipped (no such window?)"
            );
        }
    }

    /// Emit `event` with `payload` to EVERY webview (a global broadcast).
    ///
    /// This is the sanctioned path for a cross-window state broadcast (Spec
    /// #2970 ST-2: the Doom Mode `doom-mode-changed`): like
    /// [`Self::emit_row_delivery_batch`], it keeps the emission behind the
    /// EventBus so application code never calls `AppHandle::emit` directly.
    pub fn emit_global<T: Serialize>(&self, event: &str, payload: &T) {
        if let Err(error) = self.app.emit(event, payload) {
            tracing::error!(
                target: "fredo::comm",
                error = %error,
                event,
                "emit_global failed"
            );
        }
    }
}
