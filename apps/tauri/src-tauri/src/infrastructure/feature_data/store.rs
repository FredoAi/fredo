//! Shared feature-data metadata storage (Spec #2896, ST-2).
//!
//! Owns the two process-global metadata tables in the same `fredo.db` as
//! `AppStore` / `FeatureStore` / `RtdbStore`, behind its own `Mutex<Connection>`
//! (the `RtdbStore` pattern — WAL, poison-recovering lock helper):
//!
//! - `feature_data_tables` — one row per declared table: the declaration JSON,
//!   the feature-declared revision, the last delivered scope version and the
//!   one-time-backfill marker (contract (d)).
//! - `feature_data_tombstones` — one row per explicitly deleted record key, so
//!   the projection never resurrects it (ST-7 consumes these).
//!
//! This module also owns the **reserved-column guard** for feature-originated
//! writes: a feature may never name `_row_version` / `_updated_at`, nor a
//! `backend`-owned column, nor an undeclared column.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value as JsonValue};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use super::declaration::{is_reserved_column, ColumnOwner, FeatureDataTableDeclaration};

/// Metadata row for one declared table (`feature_data_tables`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableMeta {
    pub feature_id: String,
    pub table_name: String,
    pub declaration_json: String,
    pub declaration_revision: String,
    pub last_version: i64,
    pub backfill_done: bool,
}

/// One tombstoned record key (`feature_data_tombstones`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tombstone {
    pub feature_id: String,
    pub table_name: String,
    pub key_json: String,
    pub deleted_at: String,
}

/// SQLite-backed metadata store for the feature-owned data layer.
pub struct FeatureDataStore {
    conn: Mutex<Connection>,
}

impl FeatureDataStore {
    /// Open (or create) `fredo.db` with WAL journal mode + `synchronous=NORMAL`.
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("fredo.db");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
        Ok(FeatureDataStore {
            conn: Mutex::new(conn),
        })
    }

    /// Create the metadata + tombstone tables if they don't exist.
    pub fn ensure_schema(&self) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS feature_data_tables (
                feature_id            TEXT NOT NULL,
                table_name            TEXT NOT NULL,
                declaration_json      TEXT NOT NULL,
                declaration_revision  TEXT NOT NULL,
                last_version          INTEGER NOT NULL DEFAULT 0,
                backfill_done         INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (feature_id, table_name)
            );
            CREATE TABLE IF NOT EXISTS feature_data_tombstones (
                feature_id  TEXT NOT NULL,
                table_name  TEXT NOT NULL,
                key_json    TEXT NOT NULL,
                deleted_at  TEXT NOT NULL,
                PRIMARY KEY (feature_id, table_name, key_json)
            );",
        )?;
        Ok(())
    }

    /// Load the metadata row for one declared table.
    pub fn get_table(&self, feature_id: &str, table_name: &str) -> Result<Option<TableMeta>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT feature_id, table_name, declaration_json, declaration_revision,
                    last_version, backfill_done
             FROM feature_data_tables
             WHERE feature_id = ?1 AND table_name = ?2",
            params![feature_id, table_name],
            row_to_meta,
        )
        .optional()
        .map_err(Into::into)
    }

    /// Load every persisted declaration metadata row (startup materialization).
    pub fn list_tables(&self) -> Result<Vec<TableMeta>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT feature_id, table_name, declaration_json, declaration_revision,
                    last_version, backfill_done
             FROM feature_data_tables
             ORDER BY feature_id, table_name",
        )?;
        let rows = stmt
            .query_map([], row_to_meta)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Insert or update the metadata row for a declared table.
    pub fn put_table(&self, meta: &TableMeta) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO feature_data_tables
                (feature_id, table_name, declaration_json, declaration_revision,
                 last_version, backfill_done)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(feature_id, table_name) DO UPDATE SET
                declaration_json     = excluded.declaration_json,
                declaration_revision = excluded.declaration_revision,
                last_version         = excluded.last_version,
                backfill_done        = excluded.backfill_done",
            params![
                meta.feature_id,
                meta.table_name,
                meta.declaration_json,
                meta.declaration_revision,
                meta.last_version,
                i64::from(meta.backfill_done),
            ],
        )?;
        Ok(())
    }

    /// Update only the projection backfill marker for a declared table.
    pub fn set_backfill_done(&self, feature_id: &str, table_name: &str, done: bool) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE feature_data_tables SET backfill_done = ?3
             WHERE feature_id = ?1 AND table_name = ?2",
            params![feature_id, table_name, i64::from(done)],
        )?;
        Ok(())
    }

    /// Update only the last delivered scope version for a declared table.
    pub fn set_last_version(&self, feature_id: &str, table_name: &str, version: i64) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE feature_data_tables SET last_version = ?3
             WHERE feature_id = ?1 AND table_name = ?2",
            params![feature_id, table_name, version],
        )?;
        Ok(())
    }

    /// Insert (or refresh) a tombstone for an explicitly deleted record key.
    pub fn put_tombstone(&self, tombstone: &Tombstone) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO feature_data_tombstones
                (feature_id, table_name, key_json, deleted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(feature_id, table_name, key_json) DO UPDATE SET
                deleted_at = excluded.deleted_at",
            params![
                tombstone.feature_id,
                tombstone.table_name,
                tombstone.key_json,
                tombstone.deleted_at,
            ],
        )?;
        Ok(())
    }

    /// `true` iff the record key is tombstoned (never re-project it).
    pub fn is_tombstoned(
        &self,
        feature_id: &str,
        table_name: &str,
        key_json: &str,
    ) -> Result<bool> {
        let conn = self.lock_conn();
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM feature_data_tombstones
                 WHERE feature_id = ?1 AND table_name = ?2 AND key_json = ?3",
                params![feature_id, table_name, key_json],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Load every tombstone for one declared table.
    pub fn list_tombstones(&self, feature_id: &str, table_name: &str) -> Result<Vec<Tombstone>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT feature_id, table_name, key_json, deleted_at
             FROM feature_data_tombstones
             WHERE feature_id = ?1 AND table_name = ?2
             ORDER BY key_json",
        )?;
        let rows = stmt
            .query_map(params![feature_id, table_name], |row| {
                Ok(Tombstone {
                    feature_id: row.get(0)?,
                    table_name: row.get(1)?,
                    key_json: row.get(2)?,
                    deleted_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ── Lock helper (poison recovery — no unwrap) ───────────────────────────

    fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

fn row_to_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<TableMeta> {
    Ok(TableMeta {
        feature_id: row.get(0)?,
        table_name: row.get(1)?,
        declaration_json: row.get(2)?,
        declaration_revision: row.get(3)?,
        last_version: row.get(4)?,
        backfill_done: row.get::<_, i64>(5)? != 0,
    })
}

/// Reject a feature-originated write that names a reserved backend-managed
/// column, a backend-owned column, or a column that is not declared at all.
/// Returns one hard NAMED error per offending column (never fail-fast).
pub fn guard_feature_write(
    table: &FeatureDataTableDeclaration,
    set: &Map<String, JsonValue>,
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    for name in set.keys() {
        if is_reserved_column(name) {
            errors.push(format!(
                "column '{name}' on table '{}' is backend-managed and cannot be written by a feature",
                table.name
            ));
            continue;
        }
        match table.column(name) {
            None => errors.push(format!(
                "column '{name}' is not declared on table '{}'",
                table.name
            )),
            Some(column) if column.owner == ColumnOwner::Backend => errors.push(format!(
                "column '{name}' on table '{}' is backend-owned and cannot be written by a feature",
                table.name
            )),
            Some(_) => {}
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::feature_data::declaration::{DeclaredColumn, DeclaredColumnType};

    fn make_store() -> FeatureDataStore {
        let conn = Connection::open_in_memory().unwrap();
        let store = FeatureDataStore {
            conn: Mutex::new(conn),
        };
        store.ensure_schema().unwrap();
        store
    }

    fn sample_meta() -> TableMeta {
        TableMeta {
            feature_id: "mission-monitor".to_string(),
            table_name: "sessions".to_string(),
            declaration_json: "{}".to_string(),
            declaration_revision: "mm.sessions.v1".to_string(),
            last_version: 0,
            backfill_done: false,
        }
    }

    #[test]
    fn metadata_round_trips_and_upserts() {
        let store = make_store();
        assert_eq!(
            store.get_table("mission-monitor", "sessions").unwrap(),
            None
        );

        store.put_table(&sample_meta()).unwrap();
        let loaded = store
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert_eq!(loaded, sample_meta());
        assert_eq!(store.list_tables().unwrap().len(), 1);

        let mut updated = sample_meta();
        updated.declaration_revision = "mm.sessions.v2".to_string();
        updated.last_version = 42;
        updated.backfill_done = true;
        store.put_table(&updated).unwrap();

        let loaded = store
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.declaration_revision, "mm.sessions.v2");
        assert_eq!(loaded.last_version, 42);
        assert!(loaded.backfill_done);
        assert_eq!(
            store.list_tables().unwrap().len(),
            1,
            "upsert must not duplicate"
        );
    }

    #[test]
    fn tombstone_round_trips() {
        let store = make_store();
        assert!(!store.is_tombstoned("f", "t", "[\"k\"]").unwrap());

        store
            .put_tombstone(&Tombstone {
                feature_id: "f".to_string(),
                table_name: "t".to_string(),
                key_json: "[\"k\"]".to_string(),
                deleted_at: "2026-09-18T00:00:00Z".to_string(),
            })
            .unwrap();

        assert!(store.is_tombstoned("f", "t", "[\"k\"]").unwrap());
        assert!(!store.is_tombstoned("f", "t", "[\"other\"]").unwrap());
        assert_eq!(store.list_tombstones("f", "t").unwrap().len(), 1);
    }

    fn guarded_table() -> FeatureDataTableDeclaration {
        FeatureDataTableDeclaration {
            name: "sessions".to_string(),
            primary_key: vec!["sessionId".to_string()],
            columns: vec![
                DeclaredColumn {
                    name: "sessionId".to_string(),
                    col_type: DeclaredColumnType::Text,
                    nullable: false,
                    owner: ColumnOwner::Backend,
                },
                DeclaredColumn {
                    name: "customName".to_string(),
                    col_type: DeclaredColumnType::Text,
                    nullable: true,
                    owner: ColumnOwner::Feature,
                },
            ],
            source: None,
            retention: None,
        }
    }

    #[test]
    fn guard_allows_feature_owned_columns() {
        let set = serde_json::json!({ "customName": "My session" })
            .as_object()
            .unwrap()
            .clone();
        assert!(guard_feature_write(&guarded_table(), &set).is_ok());
    }

    #[test]
    fn guard_rejects_reserved_undeclared_and_backend_owned_columns() {
        let set = serde_json::json!({
            "_row_version": 3,
            "_updated_at": "now",
            "sessionId": "s1",
            "ghost": true
        })
        .as_object()
        .unwrap()
        .clone();
        let errors = guard_feature_write(&guarded_table(), &set).unwrap_err();
        assert_eq!(errors.len(), 4, "{errors:?}");
        assert!(errors
            .iter()
            .any(|e| e.contains("'_row_version'") && e.contains("backend-managed")));
        assert!(errors
            .iter()
            .any(|e| e.contains("'_updated_at'") && e.contains("backend-managed")));
        assert!(errors
            .iter()
            .any(|e| e.contains("'sessionId'") && e.contains("backend-owned")));
        assert!(errors
            .iter()
            .any(|e| e.contains("'ghost'") && e.contains("not declared")));
    }
}
