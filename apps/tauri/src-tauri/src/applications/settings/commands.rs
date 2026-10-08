use std::sync::Arc;

use crate::infrastructure::storage::AppStore;

/// Persist a setting through the engine-selected data plane.
#[tauri::command]
pub async fn save_setting(
    key: String,
    value: String,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<(), String> {
    store.set(&key, &value).await.map_err(|e| e.to_string())
}

/// Retrieve a setting from the engine-selected data plane.
/// Returns `None` if the key has never been saved.
#[tauri::command]
pub async fn get_setting(
    key: String,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<Option<String>, String> {
    store.get(&key).await.map_err(|e| e.to_string())
}

/// Read a setting from the always-synchronous control plane (`control.db`).
///
/// This is the frontend seam for keys the backend reads synchronously (e.g.
/// the per-app window presentation map on the terminal per-emit hot path),
/// which must not route through the async, PostgreSQL-only data plane.
/// Returns `None` if the key has never been saved.
#[tauri::command]
pub async fn get_control_setting(
    key: String,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<Option<String>, String> {
    store.control_get(&key).map_err(|e| e.to_string())
}

/// Upsert a setting on the always-synchronous control plane (`control.db`).
#[tauri::command]
pub async fn save_control_setting(
    key: String,
    value: String,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<(), String> {
    store.control_set(&key, &value).map_err(|e| e.to_string())
}
