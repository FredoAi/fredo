//! IPC commands for the Event Contract Engine.
//!
//! These are registered in `lib.rs` via `tauri::generate_handler!()` and called
//! from the frontend via `invoke()`.

use std::collections::HashMap;
use std::sync::Arc;

use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::contract::engine::ContractEngine;
use crate::infrastructure::comm::contract::store::ContractEventStore;
use crate::infrastructure::comm::contract::store::ContractEventWriter;
use crate::infrastructure::comm::contract::types::ContractDeclaration;
use crate::infrastructure::comm::contract::types::SubscriptionDelivery;
use crate::infrastructure::comm::contract::EventContractEngine;

// ── REQ-1: register_event_contracts ───────────────────────────────────────────

/// Register one or more event contracts with the ECE.
///
/// The frontend calls this during feature initialization to declare which
/// events the feature needs, mapped via streamFields/deferredFields/completeWhen.
///
/// Spec #2768 (ST-3): contracts declared `persistent: true` are additionally
/// recorded in the `ContractEventWriter` so `EventBus.emit_delivery` persists
/// their deliveries while the feature is closed. Persistent contracts are
/// registered once at app bootstrap (Home.tsx registers every feature's
/// contracts at mount) and are SKIPPED by unmount-time deregistration.
///
/// # Errors
/// Returns a comma-separated error string if any contract is invalid
/// (e.g., timeout > 300000ms, unparseable completeWhen expression).
#[tauri::command]
pub async fn register_event_contracts(
    contracts: Vec<ContractDeclaration>,
    state: tauri::State<'_, Arc<ContractEngine>>,
    event_writer: tauri::State<'_, Arc<ContractEventWriter>>,
) -> Result<(), String> {
    state
        .req_1_register(contracts.clone())
        .map_err(|errors| errors.join("; "))?;

    let persistent_names: Vec<String> = contracts
        .iter()
        .filter(|c| c.persistent)
        .map(|c| c.contract_name.clone())
        .collect();
    if !persistent_names.is_empty() {
        event_writer.register_persistent(&persistent_names);
    }
    Ok(())
}

// ── REQ-7: deregister_event_contracts ─────────────────────────────────────────

/// Deregister one or more event contracts by name.
///
/// Removes the contracts and emits `timedOut: true` End deliveries for any
/// in-flight buffer instances via the EventBus.
///
/// Spec #2768 (ST-3): persistent contracts are skipped by this command — the
/// exemption is enforced inside `ContractEngine::do_deregister`.
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

// ── Spec #2768 (ST-4): contract_events_hydrate ────────────────────────────────

/// Hydrate persisted contract deliveries (PULL-only — never re-emitted on the
/// "fredo-stream-event" channel, never re-processed by the ECE).
///
/// Returns the already-lifecycled `SubscriptionDelivery` records for the given
/// contract names (optionally scoped to one session), ordered by insertion
/// sequence ASC — the original emission order, under their ORIGINAL delivery
/// ids so frontend id-dedupe makes re-adding a no-op.
///
/// Emits one `tracing::debug!` with per-contract hydrated-row counts
/// (diagnostic only).
///
/// # Errors
/// Returns the SQLite error string on query failure.
#[tauri::command]
pub async fn contract_events_hydrate(
    contract_names: Vec<String>,
    session_id: Option<String>,
    store: tauri::State<'_, Arc<ContractEventStore>>,
) -> Result<Vec<SubscriptionDelivery>, String> {
    let deliveries = store
        .query_deliveries(&contract_names, session_id.as_deref())
        .map_err(|e| e.to_string())?;

    let mut per_contract: HashMap<&str, usize> = HashMap::new();
    for delivery in &deliveries {
        *per_contract.entry(delivery.contract_name.as_str()).or_default() += 1;
    }
    tracing::debug!(
        target: "fredo::comm",
        per_contract = ?per_contract,
        total = deliveries.len(),
        "contract_events_hydrate served persisted deliveries"
    );

    Ok(deliveries)
}
