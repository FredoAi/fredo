//! Tauri commands for the Event Contract Engine.
//!
//! Provides `register_event_contracts` and `deregister_event_contracts`
//! commands that frontend features call to declare their event interests.

use std::sync::{Arc, Mutex};

use super::types::EventContractDeclaration;
use super::engine::ContractEngine;

/// Register event contracts for a feature.
///
/// The frontend calls this when a feature mounts to declare which events
/// it needs and how they should be delivered.
#[tauri::command]
pub fn register_event_contracts(
    feature_id: String,
    contracts: Vec<EventContractDeclaration>,
    engine: tauri::State<'_, Arc<Mutex<ContractEngine>>>,
) -> Result<(), String> {
    let mut eng = engine.lock().map_err(|e| e.to_string())?;
    eng.register_contracts(&feature_id, contracts);
    Ok(())
}

/// Deregister event contracts for a feature.
///
/// The frontend calls this when a feature unmounts to clean up its
/// contract registrations and buffered state.
#[tauri::command]
pub fn deregister_event_contracts(
    feature_id: String,
    engine: tauri::State<'_, Arc<Mutex<ContractEngine>>>,
) -> Result<(), String> {
    let mut eng = engine.lock().map_err(|e| e.to_string())?;
    eng.deregister_contracts(&feature_id);
    Ok(())
}
