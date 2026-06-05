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

#[cfg(test)]
mod tests {
    use crate::infrastructure::storage::AppStore;
    use std::sync::Arc;

    #[test]
    fn save_and_get_setting_round_trips_correctly() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());

        store.set("theme", "dark").unwrap();
        let value = store.get("theme").unwrap();
        assert_eq!(value, Some("dark".to_string()));
    }

    #[test]
    fn get_setting_returns_none_for_unknown_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());

        let value = store.get("nonexistent").unwrap();
        assert_eq!(value, None);
    }

    #[test]
    fn save_setting_overwrites_existing_value() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());

        store.set("key1", "old_value").unwrap();
        store.set("key1", "new_value").unwrap();
        let value = store.get("key1").unwrap();
        assert_eq!(value, Some("new_value".to_string()));
    }

    #[test]
    fn multiple_settings_independent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());

        store.set("a", "1").unwrap();
        store.set("b", "2").unwrap();
        assert_eq!(store.get("a").unwrap(), Some("1".to_string()));
        assert_eq!(store.get("b").unwrap(), Some("2".to_string()));
    }
}
