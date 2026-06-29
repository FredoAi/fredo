pub mod feature_store;

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

/// Persistent key-value store backed by SQLite.
/// Wrapped in a Mutex so it can live in Tauri's managed state.
pub struct AppStore {
    conn: Mutex<Connection>,
}

impl AppStore {
    /// Open (or create) the SQLite database at `<app_data_dir>/fredo.db`.
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("fredo.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;

        Ok(AppStore {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_store() -> AppStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .unwrap();
        AppStore {
            conn: Mutex::new(conn),
        }
    }

    // ── REQ-1: AppStore CRUD ──────────────────────────────────────────────

    #[test]
    fn get_returns_some_for_previously_set_key() {
        let store = make_store();
        store.set("theme", "dark").unwrap();
        let result = store.get("theme").unwrap();
        assert_eq!(result, Some("dark".to_string()));
    }

    #[test]
    fn get_returns_none_for_unknown_key() {
        let store = make_store();
        let result = store.get("nonexistent").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn set_upserts_same_key_twice() {
        let store = make_store();
        store.set("language", "en").unwrap();
        store.set("language", "fr").unwrap();
        let result = store.get("language").unwrap();
        assert_eq!(result, Some("fr".to_string()));
    }
}
