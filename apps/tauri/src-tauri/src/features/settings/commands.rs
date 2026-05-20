use std::sync::Arc;

use crate::infrastructure::storage::AppStore;

/// Persist a setting to the SQLite store.
#[tauri::command]
pub fn save_setting(
    key: String,
    value: String,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<(), String> {
    store.set(&key, &value).map_err(|e| e.to_string())
}

/// Retrieve a setting from the SQLite store.
/// Returns `None` if the key has never been saved.
#[tauri::command]
pub fn get_setting(
    key: String,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<Option<String>, String> {
    store.get(&key).map_err(|e| e.to_string())
}
