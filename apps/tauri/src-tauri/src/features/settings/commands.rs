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

#[cfg(test)]
mod tests {
    use crate::infrastructure::storage::AppStore;
    use std::sync::Arc;

    #[tokio::test]
    async fn save_and_get_setting_round_trips_correctly() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open_sqlite_for_tests(dir.path().to_path_buf()).unwrap());

        store.set("theme", "dark").await.unwrap();
        let value = store.get("theme").await.unwrap();
        assert_eq!(value, Some("dark".to_string()));
    }

    #[tokio::test]
    async fn get_setting_returns_none_for_unknown_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open_sqlite_for_tests(dir.path().to_path_buf()).unwrap());

        let value = store.get("nonexistent").await.unwrap();
        assert_eq!(value, None);
    }

    #[tokio::test]
    async fn save_setting_overwrites_existing_value() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open_sqlite_for_tests(dir.path().to_path_buf()).unwrap());

        store.set("key1", "old_value").await.unwrap();
        store.set("key1", "new_value").await.unwrap();
        let value = store.get("key1").await.unwrap();
        assert_eq!(value, Some("new_value".to_string()));
    }

    #[tokio::test]
    async fn multiple_settings_independent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AppStore::open_sqlite_for_tests(dir.path().to_path_buf()).unwrap());

        store.set("a", "1").await.unwrap();
        store.set("b", "2").await.unwrap();
        assert_eq!(store.get("a").await.unwrap(), Some("1".to_string()));
        assert_eq!(store.get("b").await.unwrap(), Some("2".to_string()));
    }
}
