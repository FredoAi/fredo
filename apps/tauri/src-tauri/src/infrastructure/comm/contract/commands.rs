//! IPC commands for the Event Contract Engine.
//!
//! These are registered in `lib.rs` via `tauri::generate_handler!()` and called
//! from the frontend via `invoke()`.

use std::sync::Arc;

use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::contract::engine::ContractEngine;
use crate::infrastructure::comm::contract::types::ContractDeclaration;
use crate::infrastructure::comm::contract::EventContractEngine;

// ── REQ-1: register_event_contracts ───────────────────────────────────────────

/// Register one or more event contracts with the ECE.
///
/// The frontend calls this during feature initialization to declare which
/// events the feature needs, mapped via streamFields/deferredFields/completeWhen.
///
/// # Errors
/// Returns a comma-separated error string if any contract is invalid
/// (e.g., timeout > 300000ms, unparseable completeWhen expression).
#[tauri::command]
pub async fn register_event_contracts(
    contracts: Vec<ContractDeclaration>,
    state: tauri::State<'_, Arc<ContractEngine>>,
) -> Result<(), String> {
    state
        .req_1_register(contracts)
        .map_err(|errors| errors.join("; "))
}

// ── REQ-7: deregister_event_contracts ─────────────────────────────────────────

/// Deregister one or more event contracts by name.
///
/// Removes the contracts and emits `timedOut: true` End deliveries for any
/// in-flight buffer instances via the EventBus.
#[tauri::command]
pub async fn deregister_event_contracts(
    contract_names: Vec<String>,
    state: tauri::State<'_, Arc<ContractEngine>>,
    bus: tauri::State<'_, EventBus>,
) -> Result<(), String> {
    let deliveries = state.req_7_deregister(contract_names);
    for delivery in deliveries {
        bus.emit_delivery(delivery);
    }
    Ok(())
}
