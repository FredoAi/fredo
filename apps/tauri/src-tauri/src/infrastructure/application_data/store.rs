//! Shared application-data metadata storage (Spec #2896, ST-2; engine-selected in
//! Spec #2975 ST-5).
//!
//! Owns the two process-global metadata tables on the shared [`EngineHandle`]
//! (no per-store `Mutex<Connection>`):
//!
//! - `feature_data_tables` — one row per declared table: the declaration JSON,
//!   the application-declared revision, the last delivered scope version and the
//!   one-time-backfill marker (contract (d)).
//! - `feature_data_tombstones` — one row per explicitly deleted record key, so
//!   the projection never resurrects it (ST-7 consumes these).
//!
//! `backfill_done` is carried as DATA (never re-derived). On PostgreSQL the
//! composite-key upserts use `EXCLUDED.` and the shared column set.
//!
//! This module also owns the **reserved-column guard** for application-originated
//! writes: an application may never name `_row_version` / `_updated_at`, nor a
//! `backend`-owned column, nor an undeclared column.

use anyhow::Result;
use serde_json::{Map, Value as JsonValue};
use std::sync::Arc;

use crate::infrastructure::storage::engine::{EngineHandle, StoreEngine};
use crate::infrastructure::storage::application_store::block_on_pg;

use super::declaration::{is_reserved_column, ColumnOwner, ApplicationDataTableDeclaration};

/// On-disk compatibility contract (Spec #2956 AC4, **NO-MIGRATE**).
///
/// The physical PostgreSQL identifiers of the application-data metadata plane
/// are a serialized on-disk contract with previously shipped installs — they are
/// NOT a user-facing surface. They are **retained verbatim**: renaming or
/// migrating them would be a destructive PostgreSQL migration for zero user
/// benefit and would break existing databases. Every SQL path in this module
/// references these constants (never a raw literal); the
/// `frozen_metadata_literals_are_pinned` unit test pins each one so a future
/// rename cannot silently diverge.
pub const LEGACY_META_TABLES_TABLE: &str = "feature_data_tables";
/// Frozen tombstone metadata table (see [`LEGACY_META_TABLES_TABLE`]).
pub const LEGACY_META_TOMBSTONES_TABLE: &str = "feature_data_tombstones";
/// Frozen metadata column naming the owning application (see
/// [`LEGACY_META_TABLES_TABLE`]).
pub const LEGACY_METADATA_COLUMN: &str = "feature_id";

/// The PostgreSQL DDL (C1 type map: `INTEGER → bigint`), built from the frozen
/// NO-MIGRATE identifiers above so the physical schema has a single source.
fn metadata_ddl_pg() -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {tables} (
        {id}            text NOT NULL,
        table_name            text NOT NULL,
        declaration_json      text NOT NULL,
        declaration_revision  text NOT NULL,
        last_version          bigint NOT NULL DEFAULT 0,
        backfill_done         bigint NOT NULL DEFAULT 0,
        PRIMARY KEY ({id}, table_name)
    );
    CREATE TABLE IF NOT EXISTS {tombstones} (
        {id}  text NOT NULL,
        table_name  text NOT NULL,
        key_json    text NOT NULL,
        deleted_at  text NOT NULL,
        PRIMARY KEY ({id}, table_name, key_json)
    );",
        tables = LEGACY_META_TABLES_TABLE,
        tombstones = LEGACY_META_TOMBSTONES_TABLE,
        id = LEGACY_METADATA_COLUMN,
    )
}

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

/// Engine-selected metadata store for the application-owned data layer.
pub struct ApplicationDataStore {
    engine: Arc<EngineHandle>,
}

impl ApplicationDataStore {
    /// Wrap the shared engine handle.
    pub fn open(engine: Arc<EngineHandle>) -> Result<Self> {
        Ok(ApplicationDataStore { engine })
    }

    /// Create the metadata + tombstone tables if they don't exist.
    pub fn ensure_schema(&self) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => Self::ensure_schema_on_pg(&pg.pool),
        }
    }

    /// Create the metadata + tombstone tables on a PostgreSQL pool (idempotent).
    ///
    /// The ONE PostgreSQL DDL source: [`Self::ensure_schema`]'s PostgreSQL arm
    /// and the startup schema-init registry (`lib.rs`) both route here, so the
    /// boot contract's schema set is never re-declared (NFR-6 spirit).
    pub fn ensure_schema_on_pg(pool: &sqlx::PgPool) -> Result<()> {
        let ddl = metadata_ddl_pg();
        block_on_pg(async { sqlx::raw_sql(&ddl).execute(pool).await.map(|_| ()) })?;
        Ok(())
    }

    /// Load the metadata row for one declared table.
    pub fn get_table(&self, feature_id: &str, table_name: &str) -> Result<Option<TableMeta>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT {id}, table_name, declaration_json, declaration_revision,
                            last_version, backfill_done
                     FROM {tables}
                     WHERE {id} = $1 AND table_name = $2",
                    id = LEGACY_METADATA_COLUMN,
                    tables = LEGACY_META_TABLES_TABLE,
                );
                let row: Option<(String, String, String, String, i64, i64)> = block_on_pg(async {
                    sqlx::query_as(&sql)
                        .bind(feature_id)
                        .bind(table_name)
                        .fetch_optional(&pg.pool)
                        .await
                })?;
                Ok(row.map(
                    |(
                        feature_id,
                        table_name,
                        declaration_json,
                        declaration_revision,
                        last_version,
                        backfill_done,
                    )| TableMeta {
                        feature_id,
                        table_name,
                        declaration_json,
                        declaration_revision,
                        last_version,
                        backfill_done: backfill_done != 0,
                    },
                ))
            }
        }
    }

    /// Load every persisted declaration metadata row (startup materialization).
    pub fn list_tables(&self) -> Result<Vec<TableMeta>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT {id}, table_name, declaration_json, declaration_revision,
                            last_version, backfill_done
                     FROM {tables}
                     ORDER BY {id}, table_name",
                    id = LEGACY_METADATA_COLUMN,
                    tables = LEGACY_META_TABLES_TABLE,
                );
                let rows: Vec<(String, String, String, String, i64, i64)> = block_on_pg(async {
                    sqlx::query_as(&sql).fetch_all(&pg.pool).await
                })?;
                Ok(rows
                    .into_iter()
                    .map(
                        |(
                            feature_id,
                            table_name,
                            declaration_json,
                            declaration_revision,
                            last_version,
                            backfill_done,
                        )| TableMeta {
                            feature_id,
                            table_name,
                            declaration_json,
                            declaration_revision,
                            last_version,
                            backfill_done: backfill_done != 0,
                        },
                    )
                    .collect())
            }
        }
    }

    /// Insert or update the metadata row for a declared table.
    pub fn put_table(&self, meta: &TableMeta) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "INSERT INTO {tables}
                        ({id}, table_name, declaration_json, declaration_revision,
                         last_version, backfill_done)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT({id}, table_name) DO UPDATE SET
                        declaration_json     = EXCLUDED.declaration_json,
                        declaration_revision = EXCLUDED.declaration_revision,
                        last_version         = EXCLUDED.last_version,
                        backfill_done        = EXCLUDED.backfill_done",
                    id = LEGACY_METADATA_COLUMN,
                    tables = LEGACY_META_TABLES_TABLE,
                );
                block_on_pg(async {
                    sqlx::query(&sql)
                        .bind(&meta.feature_id)
                        .bind(&meta.table_name)
                        .bind(&meta.declaration_json)
                        .bind(&meta.declaration_revision)
                        .bind(meta.last_version)
                        .bind(i64::from(meta.backfill_done))
                        .execute(&pg.pool)
                        .await
                        .map(|_| ())
                })?;
                Ok(())
            }
        }
    }

    /// Update only the projection backfill marker for a declared table.
    pub fn set_backfill_done(&self, feature_id: &str, table_name: &str, done: bool) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "UPDATE {tables} SET backfill_done = $3
                     WHERE {id} = $1 AND table_name = $2",
                    tables = LEGACY_META_TABLES_TABLE,
                    id = LEGACY_METADATA_COLUMN,
                );
                block_on_pg(async {
                    sqlx::query(&sql)
                        .bind(feature_id)
                        .bind(table_name)
                        .bind(i64::from(done))
                        .execute(&pg.pool)
                        .await
                        .map(|_| ())
                })?;
                Ok(())
            }
        }
    }

    /// Update only the last delivered scope version for a declared table.
    pub fn set_last_version(&self, feature_id: &str, table_name: &str, version: i64) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "UPDATE {tables} SET last_version = $3
                     WHERE {id} = $1 AND table_name = $2",
                    tables = LEGACY_META_TABLES_TABLE,
                    id = LEGACY_METADATA_COLUMN,
                );
                block_on_pg(async {
                    sqlx::query(&sql)
                        .bind(feature_id)
                        .bind(table_name)
                        .bind(version)
                        .execute(&pg.pool)
                        .await
                        .map(|_| ())
                })?;
                Ok(())
            }
        }
    }

    /// Insert (or refresh) a tombstone for an explicitly deleted record key.
    pub fn put_tombstone(&self, tombstone: &Tombstone) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "INSERT INTO {tombstones}
                        ({id}, table_name, key_json, deleted_at)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT({id}, table_name, key_json) DO UPDATE SET
                        deleted_at = EXCLUDED.deleted_at",
                    tombstones = LEGACY_META_TOMBSTONES_TABLE,
                    id = LEGACY_METADATA_COLUMN,
                );
                block_on_pg(async {
                    sqlx::query(&sql)
                        .bind(&tombstone.feature_id)
                        .bind(&tombstone.table_name)
                        .bind(&tombstone.key_json)
                        .bind(&tombstone.deleted_at)
                        .execute(&pg.pool)
                        .await
                        .map(|_| ())
                })?;
                Ok(())
            }
        }
    }

    /// `true` iff the record key is tombstoned (never re-project it).
    pub fn is_tombstoned(
        &self,
        feature_id: &str,
        table_name: &str,
        key_json: &str,
    ) -> Result<bool> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT 1 FROM {tombstones}
                     WHERE {id} = $1 AND table_name = $2 AND key_json = $3",
                    tombstones = LEGACY_META_TOMBSTONES_TABLE,
                    id = LEGACY_METADATA_COLUMN,
                );
                let found: Option<i32> = block_on_pg(async {
                    sqlx::query_scalar(&sql)
                        .bind(feature_id)
                        .bind(table_name)
                        .bind(key_json)
                        .fetch_optional(&pg.pool)
                        .await
                })?;
                Ok(found.is_some())
            }
        }
    }

    /// Load every tombstone for one declared table.
    pub fn list_tombstones(&self, feature_id: &str, table_name: &str) -> Result<Vec<Tombstone>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let sql = format!(
                    "SELECT {id}, table_name, key_json, deleted_at
                     FROM {tombstones}
                     WHERE {id} = $1 AND table_name = $2
                     ORDER BY key_json",
                    id = LEGACY_METADATA_COLUMN,
                    tombstones = LEGACY_META_TOMBSTONES_TABLE,
                );
                let rows: Vec<(String, String, String, String)> = block_on_pg(async {
                    sqlx::query_as(&sql)
                        .bind(feature_id)
                        .bind(table_name)
                        .fetch_all(&pg.pool)
                        .await
                })?;
                Ok(rows
                    .into_iter()
                    .map(|(feature_id, table_name, key_json, deleted_at)| Tombstone {
                        feature_id,
                        table_name,
                        key_json,
                        deleted_at,
                    })
                    .collect())
            }
        }
    }
}

/// Reject an application-originated write that names a reserved backend-managed
/// column, a backend-owned column, or a column that is not declared at all.
/// Returns one hard NAMED error per offending column (never fail-fast).
pub fn guard_application_write(
    table: &ApplicationDataTableDeclaration,
    set: &Map<String, JsonValue>,
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    for name in set.keys() {
        if is_reserved_column(name) {
            errors.push(format!(
                "column '{name}' on table '{}' is backend-managed and cannot be written by an application",
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
                "column '{name}' on table '{}' is backend-owned and cannot be written by an application",
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
    use crate::infrastructure::application_data::declaration::{DeclaredColumn, DeclaredColumnType};

    fn guarded_table() -> ApplicationDataTableDeclaration {
        ApplicationDataTableDeclaration {
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
                    owner: ColumnOwner::Application,
                },
            ],
            source: None,
            retention: None,
        }
    }

    #[test]
    fn guard_allows_application_owned_columns() {
        let set = serde_json::json!({ "customName": "My session" })
            .as_object()
            .unwrap()
            .clone();
        assert!(guard_application_write(&guarded_table(), &set).is_ok());
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
        let errors = guard_application_write(&guarded_table(), &set).unwrap_err();
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

    #[test]
    fn frozen_metadata_literals_are_pinned() {
        // Spec #2956 AC4 (NO-MIGRATE): these physical PostgreSQL identifiers are
        // a shipped on-disk compat contract — they must never be renamed or
        // migrated. Pinning them here makes a future silent divergence fail.
        assert_eq!(LEGACY_META_TABLES_TABLE, "feature_data_tables");
        assert_eq!(LEGACY_META_TOMBSTONES_TABLE, "feature_data_tombstones");
        assert_eq!(LEGACY_METADATA_COLUMN, "feature_id");

        // The DDL is built from those exact constants (single source of truth),
        // so the frozen names cannot drift between constant and schema.
        let ddl = metadata_ddl_pg();
        assert!(ddl.contains(LEGACY_META_TABLES_TABLE), "{ddl}");
        assert!(ddl.contains(LEGACY_META_TOMBSTONES_TABLE), "{ddl}");
        assert!(ddl.contains(LEGACY_METADATA_COLUMN), "{ddl}");
    }
}
