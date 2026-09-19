//! Declaration registry — persistence + idempotent materialization of declared
//! feature tables (Spec #2896, ST-2, R-4.1/R-4.3/R-4.4).
//!
//! `declare` persists the declaration into `feature_data_tables` (via
//! [`FeatureDataStore`]) and materializes the physical table
//! (`CREATE TABLE IF NOT EXISTS feature_<sanitized featureId>_<table>` + the
//! backend-managed reserved columns `_row_version` / `_updated_at`), reusing
//! [`FeatureStore::validate_namespace`] for the isolation prefix.
//!
//! Migration is **additive-only**:
//! - unchanged declaration → no-op (the table is still ensured, never dropped);
//! - an added column → `ALTER TABLE ... ADD COLUMN`;
//! - a removed/retyped column (or a changed primary key) → refused with hard
//!   NAMED errors; no data is ever deleted (R-4.3).
//!
//! `materialize_persisted` loads every persisted declaration at startup and
//! re-runs the same idempotent creation — a restart over an existing `fredo.db`
//! keeps the declared rows (R-4.4).

use std::sync::Arc;

use anyhow::Result;

use crate::infrastructure::storage::feature_store::FeatureStore;

use super::declaration::{DeclaredColumn, FeatureDataDeclaration, FeatureDataTableDeclaration};
use super::store::{FeatureDataStore, TableMeta};

/// One materialized declared table (the `feature_data_declare` result element,
/// contract (c)).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedTable {
    pub feature_id: String,
    pub table: String,
    pub revision: String,
    pub created: bool,
}

/// A persisted table declaration loaded for startup materialization.
#[derive(Clone, Debug)]
pub struct PersistedTable {
    pub feature_id: String,
    pub table_name: String,
    pub revision: String,
    pub declaration: FeatureDataTableDeclaration,
}

/// The migration decision for one declared table.
#[derive(Clone, Debug, PartialEq)]
enum MigrationPlan {
    /// No metadata row — create the physical table + metadata.
    Create,
    /// Declaration content is unchanged — ensure the table exists, touch nothing.
    EnsureOnly,
    /// Additive column additions (possibly empty when only `source`/`retention`
    /// changed) — `ALTER TABLE ADD COLUMN` each, then update the metadata.
    AddColumns(Vec<DeclaredColumn>),
}

/// Declaration registry — persisted declarations + idempotent materialization.
pub struct DeclarationRegistry {
    meta: Arc<FeatureDataStore>,
    store: Arc<FeatureStore>,
}

impl DeclarationRegistry {
    /// Build a registry over the metadata store and the feature-scoped table store.
    pub fn new(meta: Arc<FeatureDataStore>, store: Arc<FeatureStore>) -> Self {
        DeclarationRegistry { meta, store }
    }

    /// Declare one feature's tables (see [`Self::declare_many`]).
    pub fn declare(
        &self,
        declaration: &FeatureDataDeclaration,
    ) -> Result<Vec<MaterializedTable>, Vec<String>> {
        self.declare_many(std::slice::from_ref(declaration))
    }

    /// Validate every declaration, plan every migration, then apply it.
    ///
    /// Validation and migration planning happen BEFORE any write, so a refused
    /// removal/retype leaves every table (including tables that would otherwise
    /// have changed) exactly as it was. Returns one hard NAMED error per
    /// violation, or the materialized tables on success.
    pub fn declare_many(
        &self,
        declarations: &[FeatureDataDeclaration],
    ) -> Result<Vec<MaterializedTable>, Vec<String>> {
        let mut errors = Vec::new();

        for declaration in declarations {
            errors.extend(declaration.validate());
        }
        if !errors.is_empty() {
            return Err(errors);
        }

        let mut planned: Vec<(
            &FeatureDataDeclaration,
            &FeatureDataTableDeclaration,
            MigrationPlan,
        )> = Vec::new();
        for declaration in declarations {
            for table in &declaration.tables {
                if let Err(e) =
                    FeatureStore::validate_namespace(&declaration.feature_id, &table.name)
                {
                    errors.push(format!(
                        "feature '{}' table '{}' is not a valid feature namespace: {e}",
                        declaration.feature_id, table.name
                    ));
                    continue;
                }
                let existing = match self.meta.get_table(&declaration.feature_id, &table.name) {
                    Ok(existing) => existing,
                    Err(e) => {
                        errors.push(format!(
                            "feature '{}' table '{}' metadata read failed: {e}",
                            declaration.feature_id, table.name
                        ));
                        continue;
                    }
                };
                match compute_plan(&declaration.feature_id, table, existing.as_ref()) {
                    Ok(plan) => planned.push((declaration, table, plan)),
                    Err(mut plan_errors) => errors.append(&mut plan_errors),
                }
            }
        }
        if !errors.is_empty() {
            return Err(errors);
        }

        let mut materialized = Vec::new();
        for (declaration, table, plan) in planned {
            match self.apply_plan(declaration, table, plan) {
                Ok(m) => materialized.push(m),
                Err(e) => errors.push(format!(
                    "feature '{}' table '{}' materialization failed: {e}",
                    declaration.feature_id, table.name
                )),
            }
        }

        if errors.is_empty() {
            Ok(materialized)
        } else {
            Err(errors)
        }
    }

    /// Startup path: load every persisted declaration and re-materialize its
    /// physical table idempotently (`CREATE TABLE IF NOT EXISTS` — existing rows
    /// are preserved). Never drops or alters anything destructively.
    pub fn materialize_persisted(&self) -> Result<Vec<MaterializedTable>, Vec<String>> {
        let metas = self.meta.list_tables().map_err(|e| {
            vec![format!(
                "failed to load persisted feature data declarations: {e}"
            )]
        })?;

        let mut materialized = Vec::new();
        let mut errors = Vec::new();
        for meta in metas {
            let declaration: FeatureDataTableDeclaration =
                match serde_json::from_str(&meta.declaration_json) {
                    Ok(declaration) => declaration,
                    Err(e) => {
                        errors.push(format!(
                            "persisted declaration for feature '{}' table '{}' is unreadable: {e}",
                            meta.feature_id, meta.table_name
                        ));
                        continue;
                    }
                };

            let outcome = (|| -> Result<bool> {
                let full = FeatureStore::validate_namespace(&meta.feature_id, &meta.table_name)?;
                let existed = self.store.table_exists(&full)?;
                self.store
                    .execute_batch(&create_table_sql(&full, &declaration))?;
                Ok(existed)
            })();

            match outcome {
                Ok(existed) => materialized.push(MaterializedTable {
                    feature_id: meta.feature_id,
                    table: meta.table_name,
                    revision: meta.declaration_revision,
                    created: !existed,
                }),
                Err(e) => errors.push(format!(
                    "failed to re-materialize feature '{}' table '{}': {e}",
                    meta.feature_id, meta.table_name
                )),
            }
        }

        if errors.is_empty() {
            Ok(materialized)
        } else {
            Err(errors)
        }
    }

    /// Every persisted table declaration (projection/read consumers).
    pub fn persisted_tables(&self) -> Result<Vec<PersistedTable>, Vec<String>> {
        let metas = self.meta.list_tables().map_err(|e| {
            vec![format!(
                "failed to load persisted feature data declarations: {e}"
            )]
        })?;
        let mut tables = Vec::with_capacity(metas.len());
        for meta in metas {
            match serde_json::from_str::<FeatureDataTableDeclaration>(&meta.declaration_json) {
                Ok(declaration) => tables.push(PersistedTable {
                    feature_id: meta.feature_id,
                    table_name: meta.table_name,
                    revision: meta.declaration_revision,
                    declaration,
                }),
                Err(e) => {
                    return Err(vec![format!(
                        "persisted declaration for feature '{}' table '{}' is unreadable: {e}",
                        meta.feature_id, meta.table_name
                    )])
                }
            }
        }
        Ok(tables)
    }

    /// One persisted table declaration, if any.
    pub fn persisted_table(
        &self,
        feature_id: &str,
        table_name: &str,
    ) -> Result<Option<PersistedTable>, Vec<String>> {
        let meta = self.meta.get_table(feature_id, table_name).map_err(|e| {
            vec![format!(
                "feature '{feature_id}' table '{table_name}' metadata read failed: {e}"
            )]
        })?;
        let Some(meta) = meta else {
            return Ok(None);
        };
        match serde_json::from_str::<FeatureDataTableDeclaration>(&meta.declaration_json) {
            Ok(declaration) => Ok(Some(PersistedTable {
                feature_id: meta.feature_id,
                table_name: meta.table_name,
                revision: meta.declaration_revision,
                declaration,
            })),
            Err(e) => Err(vec![format!(
                "persisted declaration for feature '{feature_id}' table '{table_name}' is unreadable: {e}"
            )]),
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    fn apply_plan(
        &self,
        declaration: &FeatureDataDeclaration,
        table: &FeatureDataTableDeclaration,
        plan: MigrationPlan,
    ) -> Result<MaterializedTable> {
        let feature_id = &declaration.feature_id;
        let full = FeatureStore::validate_namespace(feature_id, &table.name)?;
        let existed_before = self.store.table_exists(&full)?;
        let declaration_json = serde_json::to_string(table)?;

        match plan {
            MigrationPlan::Create => {
                self.store.execute_batch(&create_table_sql(&full, table))?;
                self.meta.put_table(&TableMeta {
                    feature_id: feature_id.clone(),
                    table_name: table.name.clone(),
                    declaration_json,
                    declaration_revision: declaration.declaration_revision.clone(),
                    last_version: 0,
                    backfill_done: false,
                })?;
            }
            MigrationPlan::EnsureOnly => {
                // Unchanged declaration → ensure the table exists, never touch
                // the stored revision/data (R-4.3 no-op).
                self.store.execute_batch(&create_table_sql(&full, table))?;
            }
            MigrationPlan::AddColumns(additions) => {
                // Drift defense: only ALTER columns that are not physically there
                // already (a partially-applied migration must not fail the declare).
                let physical = self.store.table_column_names(&full)?;
                let pending: Vec<&DeclaredColumn> = additions
                    .iter()
                    .filter(|column| !physical.iter().any(|name| name == &column.name))
                    .collect();
                if !pending.is_empty() {
                    let mut sql = String::new();
                    for column in pending {
                        sql.push_str(&format!(
                            "ALTER TABLE {} ADD COLUMN {} {};\n",
                            full,
                            column.name,
                            column.col_type.as_sql_type()
                        ));
                    }
                    self.store.execute_batch(&sql)?;
                }

                // Preserve the projection counters; a schema addition re-arms the
                // one-time backfill so the new column is populated.
                let (last_version, backfill_done) =
                    match self.meta.get_table(feature_id, &table.name)? {
                        Some(meta) => (meta.last_version, meta.backfill_done),
                        None => (0, false),
                    };
                self.meta.put_table(&TableMeta {
                    feature_id: feature_id.clone(),
                    table_name: table.name.clone(),
                    declaration_json,
                    declaration_revision: declaration.declaration_revision.clone(),
                    last_version,
                    backfill_done: if additions.is_empty() {
                        backfill_done
                    } else {
                        false
                    },
                })?;
            }
        }

        Ok(MaterializedTable {
            feature_id: feature_id.clone(),
            table: table.name.clone(),
            revision: declaration.declaration_revision.clone(),
            created: !existed_before,
        })
    }
}

/// Decide how (or whether) to migrate one declared table. `Err` carries the hard
/// named refusal messages for destruction-only changes.
fn compute_plan(
    feature_id: &str,
    table: &FeatureDataTableDeclaration,
    existing: Option<&TableMeta>,
) -> Result<MigrationPlan, Vec<String>> {
    let Some(meta) = existing else {
        return Ok(MigrationPlan::Create);
    };

    let persisted: FeatureDataTableDeclaration = match serde_json::from_str(&meta.declaration_json)
    {
        Ok(persisted) => persisted,
        Err(e) => {
            return Err(vec![format!(
                "persisted declaration for feature '{feature_id}' table '{}' is unreadable: {e}",
                table.name
            )])
        }
    };

    if persisted == *table {
        return Ok(MigrationPlan::EnsureOnly);
    }

    let mut errors = Vec::new();
    if persisted.primary_key != table.primary_key {
        errors.push(format!(
            "feature '{feature_id}' table '{}' cannot change its primary key from [{}] to [{}] \
             (declared schema is additive-only; no data was deleted)",
            table.name,
            persisted.primary_key.join(", "),
            table.primary_key.join(", ")
        ));
    }

    for old in &persisted.columns {
        match table.column(&old.name) {
            None => errors.push(format!(
                "feature '{feature_id}' table '{}' cannot drop declared column '{}' \
                 (declared schema is additive-only; no data was deleted)",
                table.name, old.name
            )),
            Some(new) if new.col_type != old.col_type => errors.push(format!(
                "feature '{feature_id}' table '{}' cannot retype column '{}' from {} to {} \
                 (declared schema is additive-only; no data was deleted)",
                table.name,
                old.name,
                old.col_type.as_str(),
                new.col_type.as_str()
            )),
            Some(new) if new.owner != old.owner => errors.push(format!(
                "feature '{feature_id}' table '{}' cannot change the owner of column '{}' \
                 (declared schema is additive-only; no data was deleted)",
                table.name, old.name
            )),
            Some(_) => {}
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }

    let additions: Vec<DeclaredColumn> = table
        .columns
        .iter()
        .filter(|column| persisted.column(&column.name).is_none())
        .cloned()
        .collect();
    Ok(MigrationPlan::AddColumns(additions))
}

/// The declared-table DDL: declared columns + the backend-managed reserved
/// columns + the composite primary key.
fn create_table_sql(full: &str, table: &FeatureDataTableDeclaration) -> String {
    let mut defs: Vec<String> = Vec::with_capacity(table.columns.len() + 3);
    for column in &table.columns {
        let not_null = if table.is_primary_key(&column.name) || !column.nullable {
            " NOT NULL"
        } else {
            ""
        };
        defs.push(format!(
            "{} {}{}",
            column.name,
            column.col_type.as_sql_type(),
            not_null
        ));
    }
    defs.push("_row_version INTEGER NOT NULL".to_string());
    defs.push("_updated_at TEXT NOT NULL".to_string());
    if !table.primary_key.is_empty() {
        defs.push(format!("PRIMARY KEY ({})", table.primary_key.join(", ")));
    }
    format!("CREATE TABLE IF NOT EXISTS {} ({});", full, defs.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::feature_data::declaration::{
        ColumnOwner, DataSource, DeclaredColumnType, Retention, SessionRollupKind,
        SessionRollupProjection,
    };
    use crate::infrastructure::feature_data::store::FeatureDataStore;
    use serde_json::{Map, Value as JsonValue};

    fn session_column(name: &str, ty: DeclaredColumnType) -> DeclaredColumn {
        DeclaredColumn {
            name: name.to_string(),
            col_type: ty,
            nullable: true,
            owner: ColumnOwner::Backend,
        }
    }

    /// A minimal MM-shaped declaration: PK `sessionId`, plus `chatRowCount` and an
    /// optional extra backend column used to exercise additive migration.
    fn declaration(revision: &str, extra_column: Option<DeclaredColumn>) -> FeatureDataDeclaration {
        let mut columns = vec![
            DeclaredColumn {
                name: "sessionId".to_string(),
                col_type: DeclaredColumnType::Text,
                nullable: false,
                owner: ColumnOwner::Backend,
            },
            session_column("chatRowCount", DeclaredColumnType::Integer),
        ];
        if let Some(extra) = extra_column {
            columns.push(extra);
        }
        FeatureDataDeclaration {
            feature_id: "mission-monitor".to_string(),
            declaration_revision: revision.to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "sessions".to_string(),
                primary_key: vec!["sessionId".to_string()],
                columns,
                source: Some(DataSource::SessionRollup(SessionRollupProjection {
                    kind: SessionRollupKind::SessionRollup,
                    exclude_dispatch_names: vec!["build".to_string(), "plan".to_string()],
                    terminal_states: vec![
                        crate::infrastructure::rtdb::rows::RowState::Response,
                        crate::infrastructure::rtdb::rows::RowState::Timeout,
                    ],
                })),
                retention: Some(Retention {
                    max_rows: Some(500),
                    ttl_days: None,
                }),
            }],
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        registry: DeclarationRegistry,
        store: Arc<FeatureStore>,
    }

    fn setup() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let store = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        Harness {
            _dir: dir,
            registry: DeclarationRegistry::new(meta, store.clone()),
            store,
        }
    }

    fn sessions_row(session_id: &str, chat_row_count: i64) -> Map<String, JsonValue> {
        serde_json::json!({
            "sessionId": session_id,
            "chatRowCount": chat_row_count,
            "_row_version": 1,
            "_updated_at": "2026-09-18T00:00:00Z"
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn full_name() -> String {
        FeatureStore::validate_namespace("mission-monitor", "sessions").unwrap()
    }

    #[test]
    fn declare_creates_table_with_reserved_columns_and_metadata() {
        let h = setup();
        let materialized = h
            .registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();

        assert_eq!(materialized.len(), 1);
        assert_eq!(materialized[0].feature_id, "mission-monitor");
        assert_eq!(materialized[0].table, "sessions");
        assert_eq!(materialized[0].revision, "mm.sessions.v1");
        assert!(
            materialized[0].created,
            "first declare must create the table"
        );

        let columns = h.store.table_column_names(&full_name()).unwrap();
        assert!(columns.contains(&"sessionId".to_string()), "{columns:?}");
        assert!(columns.contains(&"chatRowCount".to_string()), "{columns:?}");
        assert!(columns.contains(&"_row_version".to_string()), "{columns:?}");
        assert!(columns.contains(&"_updated_at".to_string()), "{columns:?}");

        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert_eq!(meta.declaration_revision, "mm.sessions.v1");
        assert_eq!(meta.last_version, 0);
        assert!(!meta.backfill_done);
    }

    #[test]
    fn redeclare_unchanged_is_a_noop_and_preserves_rows() {
        let h = setup();
        let decl = declaration("mm.sessions.v1", None);
        h.registry.declare(&decl).unwrap();
        h.store
            .upsert(
                "mission-monitor",
                "sessions",
                &["sessionId".to_string()],
                &[sessions_row("s1", 3)],
            )
            .unwrap();

        let again = h.registry.declare(&decl).unwrap();
        assert_eq!(again.len(), 1);
        assert!(!again[0].created, "unchanged re-declare must be a no-op");

        let rows = h
            .store
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("chatRowCount").unwrap(), 3);
    }

    #[test]
    fn additive_column_is_altered_and_existing_rows_preserved() {
        let h = setup();
        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();
        h.store
            .upsert(
                "mission-monitor",
                "sessions",
                &["sessionId".to_string()],
                &[sessions_row("s1", 3)],
            )
            .unwrap();

        let v2 = declaration(
            "mm.sessions.v2",
            Some(session_column(
                "visibleTurnCount",
                DeclaredColumnType::Integer,
            )),
        );
        let materialized = h.registry.declare(&v2).unwrap();
        assert!(
            !materialized[0].created,
            "additive migration must not recreate"
        );

        let columns = h.store.table_column_names(&full_name()).unwrap();
        assert!(
            columns.contains(&"visibleTurnCount".to_string()),
            "additive column missing: {columns:?}"
        );

        let rows = h
            .store
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap();
        assert_eq!(rows.len(), 1, "existing rows must be preserved");
        assert_eq!(rows[0].get("chatRowCount").unwrap(), 3);

        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert_eq!(meta.declaration_revision, "mm.sessions.v2");
    }

    #[test]
    fn removal_is_refused_with_named_error_and_data_preserved() {
        let h = setup();
        h.registry
            .declare(&declaration(
                "mm.sessions.v1",
                Some(session_column(
                    "visibleTurnCount",
                    DeclaredColumnType::Integer,
                )),
            ))
            .unwrap();
        h.store
            .upsert(
                "mission-monitor",
                "sessions",
                &["sessionId".to_string()],
                &[sessions_row("s1", 3)],
            )
            .unwrap();

        let errors = h
            .registry
            .declare(&declaration("mm.sessions.v2", None))
            .unwrap_err();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].contains("cannot drop declared column 'visibleTurnCount'"),
            "{errors:?}"
        );

        let rows = h
            .store
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap();
        assert_eq!(rows.len(), 1, "refused migration must not delete data");
        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert_eq!(meta.declaration_revision, "mm.sessions.v1");
    }

    #[test]
    fn retype_is_refused_with_named_error() {
        let h = setup();
        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();

        let mut retyped = declaration("mm.sessions.v2", None);
        retyped.tables[0].columns[1].col_type = DeclaredColumnType::Text;

        let errors = h.registry.declare(&retyped).unwrap_err();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].contains("cannot retype column 'chatRowCount' from INTEGER to TEXT"),
            "{errors:?}"
        );
    }

    #[test]
    fn materialize_persisted_preserves_rows_and_recreates_a_missing_table() {
        let h = setup();
        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();
        h.store
            .upsert(
                "mission-monitor",
                "sessions",
                &["sessionId".to_string()],
                &[sessions_row("s1", 3)],
            )
            .unwrap();

        // Startup re-materialization (R-4.4): rows survive.
        let materialized = h.registry.materialize_persisted().unwrap();
        assert_eq!(materialized.len(), 1);
        assert!(!materialized[0].created);
        let rows = h
            .store
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "startup materialization must preserve declared rows"
        );

        // A lost physical table is recreated (idempotent create).
        h.store
            .execute_batch(&format!("DROP TABLE {};", full_name()))
            .unwrap();
        let materialized = h.registry.materialize_persisted().unwrap();
        assert!(materialized[0].created, "missing table must be recreated");
        assert!(h.store.table_exists(&full_name()).unwrap());
    }

    #[test]
    fn persisted_tables_round_trip() {
        let h = setup();
        let decl = declaration("mm.sessions.v1", None);
        h.registry.declare(&decl).unwrap();

        let persisted = h.registry.persisted_tables().unwrap();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].feature_id, "mission-monitor");
        assert_eq!(persisted[0].table_name, "sessions");
        assert_eq!(persisted[0].declaration, decl.tables[0]);
        assert!(h
            .registry
            .persisted_table("mission-monitor", "sessions")
            .unwrap()
            .is_some());
        assert!(h
            .registry
            .persisted_table("mission-monitor", "missing")
            .unwrap()
            .is_none());
    }

    #[test]
    fn cross_feature_read_is_refused_by_the_namespace_rule() {
        let h = setup();
        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();

        // Another feature cannot address mission-monitor's declared table: the
        // physical name resolves under ITS OWN namespace and does not exist.
        let err = h
            .store
            .query("other-feature", "sessions", None, None, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("no such table"), "{err}");
    }
}
