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
use serde_json::Value as JsonValue;

use crate::infrastructure::storage::feature_store::{ColumnType, FeatureStore, PhysicalColumn};

use super::declaration::{
    is_reserved_column, DeclaredColumn, DeclaredColumnType, FeatureDataDeclaration,
    FeatureDataTableDeclaration,
};
use super::store::{FeatureDataStore, TableMeta, Tombstone};

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
    /// No declared-layer table — create the physical table + metadata.
    Create,
    /// Declaration content is unchanged — ensure the table exists, touch nothing.
    EnsureOnly,
    /// Additive column additions (possibly empty when only `source`/`retention`
    /// changed) — `ALTER TABLE ADD COLUMN` each, then update the metadata.
    AddColumns(Vec<DeclaredColumn>),
    /// The physical table that owns the declared name is NOT the declared layer
    /// (a foreign/legacy table: it lacks the reserved columns and/or carries
    /// undeclared columns). The declared layer is rebuilt WITHOUT dropping
    /// anything: the foreign table is renamed to `quarantine`, the declared
    /// schema is created, and the one-time backfill is re-armed.
    RebuildLegacy { quarantine: String },
}

/// One planned table migration — the feature id + revision are carried alongside
/// the table declaration so `apply_plan` can materialize without re-deriving them.
struct PlannedTable<'a> {
    feature_id: &'a str,
    revision: &'a str,
    table: &'a FeatureDataTableDeclaration,
    plan: MigrationPlan,
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

        let mut planned: Vec<PlannedTable<'_>> = Vec::new();
        for declaration in declarations {
            for table in &declaration.tables {
                let full = match FeatureStore::validate_namespace(&declaration.feature_id, &table.name)
                {
                    Ok(full) => full,
                    Err(e) => {
                        errors.push(format!(
                            "feature '{}' table '{}' is not a valid feature namespace: {e}",
                            declaration.feature_id, table.name
                        ));
                        continue;
                    }
                };
                // Physical schema is read regardless of metadata, so a same-named
                // foreign/legacy table is detected even when the declaration
                // metadata says the table is already materialized.
                let physical = match self.store.table_schema(&full) {
                    Ok(physical) => physical,
                    Err(e) => {
                        errors.push(format!(
                            "feature '{}' table '{}' physical schema read failed: {e}",
                            declaration.feature_id, table.name
                        ));
                        continue;
                    }
                };
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
                match self.compute_plan(
                    &declaration.feature_id,
                    table,
                    existing.as_ref(),
                    &physical,
                ) {
                    Ok(plan) => planned.push(PlannedTable {
                        feature_id: &declaration.feature_id,
                        revision: &declaration.declaration_revision,
                        table,
                        plan,
                    }),
                    Err(mut plan_errors) => errors.append(&mut plan_errors),
                }
            }
        }
        if !errors.is_empty() {
            return Err(errors);
        }

        let mut materialized = Vec::new();
        for planned_table in planned {
            match self.apply_plan(
                planned_table.feature_id,
                planned_table.revision,
                planned_table.table,
                planned_table.plan,
            ) {
                Ok(m) => materialized.push(m),
                Err(e) => errors.push(format!(
                    "feature '{}' table '{}' materialization failed: {e}",
                    planned_table.feature_id, planned_table.table.name
                )),
            }
        }

        if errors.is_empty() {
            Ok(materialized)
        } else {
            Err(errors)
        }
    }

    /// Startup path: load every persisted declaration and re-materialize it
    /// through the SAME [`Self::compute_plan`] + [`Self::apply_plan`] path as a
    /// live declare, so a restart repairs a same-named foreign/legacy physical
    /// table (rebuild, never drop) instead of silently re-accepting it. Existing
    /// declared rows are preserved; a `RebuildLegacy` move keeps the foreign table
    /// and its rows verbatim under the quarantine name.
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

            let full = match FeatureStore::validate_namespace(&meta.feature_id, &meta.table_name) {
                Ok(full) => full,
                Err(e) => {
                    errors.push(format!(
                        "failed to re-materialize feature '{}' table '{}': {e}",
                        meta.feature_id, meta.table_name
                    ));
                    continue;
                }
            };
            let physical = match self.store.table_schema(&full) {
                Ok(physical) => physical,
                Err(e) => {
                    errors.push(format!(
                        "failed to read the physical schema for feature '{}' table '{}': {e}",
                        meta.feature_id, meta.table_name
                    ));
                    continue;
                }
            };

            match self.compute_plan(&meta.feature_id, &declaration, Some(&meta), &physical) {
                Ok(plan) => {
                    match self.apply_plan(
                        &meta.feature_id,
                        &meta.declaration_revision,
                        &declaration,
                        plan,
                    ) {
                        Ok(m) => materialized.push(m),
                        Err(e) => errors.push(format!(
                            "failed to re-materialize feature '{}' table '{}': {e}",
                            meta.feature_id, meta.table_name
                        )),
                    }
                }
                Err(mut plan_errors) => errors.append(&mut plan_errors),
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
        feature_id: &str,
        declaration_revision: &str,
        table: &FeatureDataTableDeclaration,
        plan: MigrationPlan,
    ) -> Result<MaterializedTable> {
        let full = FeatureStore::validate_namespace(feature_id, &table.name)?;
        let existed_before = self.store.table_exists(&full)?;
        let declaration_json = serde_json::to_string(table)?;
        // A rebuild creates the declared schema anew (the name was occupied by a
        // foreign/legacy table that is moved aside, not by the declared layer).
        let created = matches!(plan, MigrationPlan::RebuildLegacy { .. }) || !existed_before;

        match plan {
            MigrationPlan::Create => {
                self.store.execute_batch(&create_table_sql(&full, table))?;
                self.meta.put_table(&TableMeta {
                    feature_id: feature_id.to_string(),
                    table_name: table.name.clone(),
                    declaration_json,
                    declaration_revision: declaration_revision.to_string(),
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
                    feature_id: feature_id.to_string(),
                    table_name: table.name.clone(),
                    declaration_json,
                    declaration_revision: declaration_revision.to_string(),
                    last_version,
                    backfill_done: if additions.is_empty() {
                        backfill_done
                    } else {
                        false
                    },
                })?;
            }
            MigrationPlan::RebuildLegacy { quarantine } => {
                // Migrate, never drop: preserve the foreign/legacy table verbatim
                // under the quarantine name, then create the declared schema and
                // re-arm the one-time backfill.
                let moved = self.store.row_count(&full)?;
                self.store.execute_batch(&format!(
                    "ALTER TABLE {} RENAME TO {};",
                    full, quarantine
                ))?;
                self.store.execute_batch(&create_table_sql(&full, table))?;
                self.meta.put_table(&TableMeta {
                    feature_id: feature_id.to_string(),
                    table_name: table.name.clone(),
                    declaration_json,
                    declaration_revision: declaration_revision.to_string(),
                    last_version: 0,
                    backfill_done: false,
                })?;
                tracing::warn!(
                    target: "fredo::feature_data",
                    feature_id = %feature_id,
                    table = %table.name,
                    quarantine = %quarantine,
                    moved_rows = moved,
                    "foreign/legacy physical table moved aside; declared schema created and backfill re-armed"
                );
            }
        }

        // ST-6R: the declared `mission-monitor.sessions` table is (re)created from
        // scratch by `Create`/`RebuildLegacy` (the only plans that set `created`),
        // so migrate the legacy deletion tombstones now — before the one-time
        // backfill re-projects the canonical sessions — so a session the user
        // deleted through the old Mission Monitor affordance cannot reappear.
        if created && feature_id == "mission-monitor" && table.name == "sessions" {
            self.migrate_legacy_deletion_tombstones()?;
        }

        Ok(MaterializedTable {
            feature_id: feature_id.to_string(),
            table: table.name.clone(),
            revision: declaration_revision.to_string(),
            created,
        })
    }

    /// Decide how (or whether) to migrate one declared table from the ACTUAL
    /// physical schema (not only the persisted metadata). `Err` carries the hard
    /// named refusal messages for destruction-only changes.
    fn compute_plan(
        &self,
        feature_id: &str,
        table: &FeatureDataTableDeclaration,
        existing: Option<&TableMeta>,
        physical: &[PhysicalColumn],
    ) -> Result<MigrationPlan, Vec<String>> {
        let persisted: Option<FeatureDataTableDeclaration> = match existing {
            Some(meta) => match serde_json::from_str(&meta.declaration_json) {
                Ok(persisted) => Some(persisted),
                Err(e) => {
                    return Err(vec![format!(
                        "persisted declaration for feature '{feature_id}' table '{}' is unreadable: {e}",
                        table.name
                    )])
                }
            },
            None => None,
        };

        // R-4.3 refusal precedence: a declaration that removes/retypes/owner-changes
        // a column or changes the primary key is refused BEFORE any physical
        // classification or write, so no rebuild and no data deletion can happen.
        if let Some(persisted) = &persisted {
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
        }

        // Table absent from the physical layer (including stale metadata for a
        // dropped table) → (re)create it.
        if physical.is_empty() {
            return Ok(MigrationPlan::Create);
        }

        // A physical table that is not the declared layer is foreign/legacy (the
        // real-world legacy `feature_mission_monitor_sessions` has neither
        // reserved column and undeclared columns), so the declared layer is
        // rebuilt without dropping the foreign table.
        if !declared_layer_shaped(table, persisted.as_ref(), physical) {
            let full = FeatureStore::validate_namespace(feature_id, &table.name)
                .map_err(|e| vec![format!("feature '{feature_id}' table '{}': {e}", table.name)])?;
            let quarantine = self.quarantine_name(&full)?;
            return Ok(MigrationPlan::RebuildLegacy { quarantine });
        }

        // Declared-layer-shaped but a declared column's physical type contradicts
        // the declaration: there is no safe additive repair, so refuse with a hard
        // NAMED error (never destructive).
        let mut type_errors = Vec::new();
        for column in &table.columns {
            if let Some(physical_column) = physical.iter().find(|c| c.name == column.name) {
                if physical_column.col_type != declared_affinity(column.col_type) {
                    type_errors.push(format!(
                        "feature '{feature_id}' table '{}' physical column '{}' is {} but the declaration says {} (no data was deleted)",
                        table.name,
                        column.name,
                        physical_column.sql_type,
                        column.col_type.as_str()
                    ));
                }
            }
        }
        if !type_errors.is_empty() {
            return Err(type_errors);
        }

        match persisted {
            Some(persisted) if persisted == *table => Ok(MigrationPlan::EnsureOnly),
            Some(persisted) => Ok(MigrationPlan::AddColumns(
                table
                    .columns
                    .iter()
                    .filter(|column| persisted.column(&column.name).is_none())
                    .cloned()
                    .collect(),
            )),
            None => Ok(MigrationPlan::Create),
        }
    }

    /// A collision-free `<full>__legacy_<yyyymmddHHMMSS>` name (`_2`, `_3`, … on
    /// collision). Only ever used to move a foreign table aside — never to drop it.
    fn quarantine_name(&self, full: &str) -> Result<String, Vec<String>> {
        let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
        let base = format!("{full}__legacy_{stamp}");
        if !self
            .store
            .table_exists(&base)
            .map_err(|e| vec![format!("failed to probe quarantine name '{base}': {e}")])?
        {
            return Ok(base);
        }
        let mut suffix = 2u32;
        loop {
            let candidate = format!("{base}_{suffix}");
            if !self
                .store
                .table_exists(&candidate)
                .map_err(|e| vec![format!("failed to probe quarantine name '{candidate}': {e}")])?
            {
                return Ok(candidate);
            }
            suffix += 1;
        }
    }

    /// ST-6R: the legacy Mission Monitor owned its explicit-deletion tombstones in
    /// `feature_mission_monitor_deleted_sessions` (`session_id`, `deleted_at`).
    /// When the declared `sessions` table is (re)created, migrate every legacy row
    /// into the declared-layer tombstone store under the EXACT
    /// `is_tombstoned`/`tombstone_key` wire format (`["<sessionId>"]` — the MM
    /// `sessions` primary key is `sessionId`), so the one-time backfill cannot
    /// resurrect a session the user deleted through the old affordance.
    ///
    /// Idempotent (the tombstone upsert keyed on `(feature, table, key_json)`),
    /// and the legacy table is READ-ONLY here — never mutated, never dropped.
    fn migrate_legacy_deletion_tombstones(&self) -> Result<()> {
        let legacy_full = FeatureStore::validate_namespace("mission-monitor", "deleted_sessions")?;
        if !self.store.table_exists(&legacy_full)? {
            return Ok(());
        }

        let rows = self
            .store
            .query("mission-monitor", "deleted_sessions", None, None, None)?;
        let mut migrated = 0usize;
        for row in &rows {
            // A row without a `session_id` cannot form a tombstone key.
            let Some(session_id) = row.get("session_id").and_then(JsonValue::as_str) else {
                continue;
            };
            let key_json = serde_json::to_string(&vec![JsonValue::String(session_id.to_string())])?;
            // `deleted_at` is NOT NULL in the tombstone store; the legacy column
            // always carries it, but fall back to "now" if it is ever absent.
            let deleted_at = row
                .get("deleted_at")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            self.meta.put_tombstone(&Tombstone {
                feature_id: "mission-monitor".to_string(),
                table_name: "sessions".to_string(),
                key_json,
                deleted_at,
            })?;
            migrated += 1;
        }

        tracing::info!(
            target: "fredo::feature_data",
            migrated,
            "legacy mission-monitor deletion tombstones migrated into the declared layer"
        );
        Ok(())
    }
}

/// `true` iff the physical table is the declared layer rather than a foreign /
/// legacy table that merely shares the name.
///
/// It must carry BOTH reserved columns `_row_version` + `_updated_at` (NOT NULL,
/// exactly as the declared DDL creates them), every physical column must be
/// declared (in the new or the persisted declaration) or reserved, and it must
/// physically key on the declared primary key. The real legacy MM table fails on
/// every count (`session_id`/`label`/`start_time`/`delivery_count`, no reserved
/// columns).
fn declared_layer_shaped(
    table: &FeatureDataTableDeclaration,
    persisted: Option<&FeatureDataTableDeclaration>,
    physical: &[PhysicalColumn],
) -> bool {
    let has_not_null_reserved =
        |name: &str| physical.iter().any(|c| c.name == name && c.not_null);
    if !has_not_null_reserved("_row_version") || !has_not_null_reserved("_updated_at") {
        return false;
    }

    let is_known = |name: &str| {
        is_reserved_column(name)
            || table.column(name).is_some()
            || persisted.is_some_and(|p| p.column(name).is_some())
    };
    if !physical.iter().all(|column| is_known(&column.name)) {
        return false;
    }

    table
        .primary_key
        .iter()
        .all(|pk| physical.iter().any(|column| &column.name == pk && column.primary_key))
}

/// The physical affinity a declared type must have. Mirrors
/// [`DeclaredColumnType::as_sql_type`] (BOOLEAN → INTEGER, JSON → TEXT) — the
/// physical side is the normalized [`ColumnType`] from the ONE pragma rule.
fn declared_affinity(col_type: DeclaredColumnType) -> ColumnType {
    match col_type.as_sql_type() {
        "INTEGER" => ColumnType::INTEGER,
        "REAL" => ColumnType::REAL,
        "BLOB" => ColumnType::BLOB,
        _ => ColumnType::TEXT,
    }
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
        dir: tempfile::TempDir,
        registry: DeclarationRegistry,
        store: Arc<FeatureStore>,
    }

    fn setup() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let store = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        Harness {
            dir,
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

    /// #2945 ST-4: the shipped `mm.sessions.v1 → v2` change is the additive
    /// `provider` column. The plan MUST be `AddColumns` (never a recreate), the
    /// existing rows and projection counters MUST survive, and the one-time
    /// backfill MUST be re-armed (`backfill_done = false`) so every pre-existing
    /// session gets a populated `provider`.
    #[test]
    fn sessions_v1_to_v2_adds_provider_and_rearms_the_backfill() {
        let h = setup();
        // v1 (no `provider`): a completed backfill left the marker latched and
        // the scope version advanced.
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
        {
            let meta = h
                .registry
                .meta
                .get_table("mission-monitor", "sessions")
                .unwrap()
                .unwrap();
            assert!(!meta.backfill_done);
            h.registry
                .meta
                .put_table(&TableMeta {
                    last_version: 7,
                    backfill_done: true,
                    ..meta
                })
                .unwrap();
        }

        // v2: the additive `provider` column.
        let v2 = declaration(
            "mm.sessions.v2",
            Some(session_column("provider", DeclaredColumnType::Text)),
        );
        let materialized = h.registry.declare(&v2).unwrap();
        assert_eq!(materialized.len(), 1);
        assert!(
            !materialized[0].created,
            "an additive column change must apply AddColumns, never a recreate"
        );

        // The column was physically altered in ...
        let columns = h.store.table_column_names(&full_name()).unwrap();
        assert!(
            columns.contains(&"provider".to_string()),
            "the additive provider column must be present: {columns:?}"
        );
        // ... existing rows and their data survive ...
        let rows = h
            .store
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap();
        assert_eq!(rows.len(), 1, "AddColumns must preserve existing rows");
        assert_eq!(rows[0].get("chatRowCount").unwrap(), 3);
        // ... the revision advanced and the projection counter was preserved ...
        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert_eq!(meta.declaration_revision, "mm.sessions.v2");
        assert_eq!(
            meta.last_version, 7,
            "AddColumns preserves the projection counters"
        );
        // ... and the one-time backfill was re-armed to populate `provider`.
        assert!(
            !meta.backfill_done,
            "an additive column MUST re-arm backfill_done=false so pre-existing rows get provider"
        );
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

    // ── Physical-schema-aware materialization (round-2 fix) ──────────────────

    /// The exact live legacy MM DDL (`persistence.ts`, since deleted) + a row.
    fn seed_legacy_collision(h: &Harness, full: &str) {
        h.store
            .execute_batch(&format!(
                "CREATE TABLE {full} (
                     session_id TEXT PRIMARY KEY,
                     label TEXT NOT NULL,
                     start_time TEXT NOT NULL,
                     end_time TEXT,
                     delivery_count INTEGER NOT NULL
                 );
                 INSERT INTO {full} (session_id, label, start_time, delivery_count)
                 VALUES ('legacy-1', 'Legacy One', '2026-01-01T00:00:00Z', 7);"
            ))
            .unwrap();
    }

    fn legacy_quarantine_name(h: &Harness) -> String {
        let conn = rusqlite::Connection::open(h.dir.path().join("fredo.db")).unwrap();
        conn.query_row(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'feature_mission_monitor_sessions__legacy_%'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn legacy_quarantine_count(h: &Harness) -> i64 {
        let conn = rusqlite::Connection::open(h.dir.path().join("fredo.db")).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'feature_mission_monitor_sessions__legacy_%'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn legacy_physical_table_classifies_as_rebuild_legacy() {
        let h = setup();
        let full = full_name();
        seed_legacy_collision(&h, &full);

        let decl = declaration("mm.sessions.v1", None);
        let physical = h.store.table_schema(&full).unwrap();
        let plan = h
            .registry
            .compute_plan("mission-monitor", &decl.tables[0], None, &physical)
            .unwrap();
        match plan {
            MigrationPlan::RebuildLegacy { quarantine } => {
                assert!(
                    quarantine.starts_with(&format!("{full}__legacy_")),
                    "{quarantine}"
                );
            }
            other => panic!("expected RebuildLegacy, got {other:?}"),
        }
    }

    #[test]
    fn declared_layer_physical_table_classifies_as_ensure_only() {
        let h = setup();
        let decl = declaration("mm.sessions.v1", None);
        h.registry.declare(&decl).unwrap();

        let full = full_name();
        let physical = h.store.table_schema(&full).unwrap();
        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        let plan = h
            .registry
            .compute_plan("mission-monitor", &decl.tables[0], Some(&meta), &physical)
            .unwrap();
        assert_eq!(plan, MigrationPlan::EnsureOnly);
    }

    #[test]
    fn legacy_collision_is_rebuilt_and_the_legacy_table_is_preserved() {
        let h = setup();
        let full = full_name();
        seed_legacy_collision(&h, &full);

        let materialized = h
            .registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();
        assert_eq!(materialized.len(), 1);
        assert!(
            materialized[0].created,
            "a rebuild creates the declared schema"
        );

        // The declared schema is real now (the projection/queries can run).
        let columns = h.store.table_column_names(&full).unwrap();
        assert!(columns.contains(&"sessionId".to_string()), "{columns:?}");
        assert!(columns.contains(&"chatRowCount".to_string()), "{columns:?}");
        assert!(columns.contains(&"_row_version".to_string()), "{columns:?}");
        assert!(columns.contains(&"_updated_at".to_string()), "{columns:?}");
        assert!(!columns.contains(&"label".to_string()), "{columns:?}");
        assert_eq!(legacy_quarantine_count(&h), 1, "exactly one quarantine");

        // The legacy table and its rows are preserved verbatim under __legacy_*.
        let legacy = legacy_quarantine_name(&h);
        assert!(legacy.contains("__legacy_"), "{legacy}");
        let conn = rusqlite::Connection::open(h.dir.path().join("fredo.db")).unwrap();
        let (label, delivery_count): (String, i64) = conn
            .query_row(
                &format!(
                    "SELECT label, delivery_count FROM {legacy} WHERE session_id = 'legacy-1'"
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(label, "Legacy One");
        assert_eq!(delivery_count, 7, "the moved rows are unchanged");

        // The one-time backfill is re-armed so the declared data is repopulated.
        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert_eq!(meta.last_version, 0);
        assert!(!meta.backfill_done);
    }

    #[test]
    fn rebuild_is_idempotent_on_the_next_declare() {
        let h = setup();
        let full = full_name();
        seed_legacy_collision(&h, &full);

        let decl = declaration("mm.sessions.v1", None);
        h.registry.declare(&decl).unwrap();
        let again = h.registry.declare(&decl).unwrap();
        assert!(!again[0].created, "the repaired table is now a no-op");
        assert_eq!(
            legacy_quarantine_count(&h),
            1,
            "a second declare must not quarantine again"
        );
    }

    #[test]
    fn materialize_persisted_repairs_a_legacy_collision() {
        let h = setup();
        let full = full_name();
        let decl = declaration("mm.sessions.v1", None);
        seed_legacy_collision(&h, &full);
        // The live DB's metadata: the collision was accepted once (backfill_done=1).
        h.registry
            .meta
            .put_table(&TableMeta {
                feature_id: "mission-monitor".to_string(),
                table_name: "sessions".to_string(),
                declaration_json: serde_json::to_string(&decl.tables[0]).unwrap(),
                declaration_revision: "mm.sessions.v1".to_string(),
                last_version: 0,
                backfill_done: true,
            })
            .unwrap();

        // Restart path (R-4.4): the same compute_plan/apply_plan path repairs it.
        let materialized = h.registry.materialize_persisted().unwrap();
        assert_eq!(materialized.len(), 1);
        assert!(materialized[0].created);

        let columns = h.store.table_column_names(&full).unwrap();
        assert!(columns.contains(&"sessionId".to_string()), "{columns:?}");
        assert!(!columns.contains(&"label".to_string()), "{columns:?}");
        assert_eq!(legacy_quarantine_count(&h), 1);

        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        assert!(
            !meta.backfill_done,
            "the restart must re-arm the one-time backfill"
        );
        assert_eq!(meta.last_version, 0);
    }

    #[test]
    fn physical_type_mismatch_is_a_named_error_and_the_table_is_untouched() {
        let h = setup();
        let full = full_name();
        // Declared-layer-shaped (reserved columns + all names known) but the
        // declared `chatRowCount` is physically TEXT instead of INTEGER.
        h.store
            .execute_batch(&format!(
                "CREATE TABLE {full} (
                     sessionId TEXT NOT NULL,
                     chatRowCount TEXT,
                     _row_version INTEGER NOT NULL,
                     _updated_at TEXT NOT NULL,
                     PRIMARY KEY (sessionId)
                 );"
            ))
            .unwrap();

        let errors = h
            .registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap_err();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].contains(
                "physical column 'chatRowCount' is TEXT but the declaration says INTEGER"
            ),
            "{errors:?}"
        );

        // No data/schema deletion, and no metadata was written.
        let columns = h.store.table_column_names(&full).unwrap();
        assert_eq!(
            columns,
            vec!["sessionId", "chatRowCount", "_row_version", "_updated_at"]
        );
        assert!(h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .is_none());
    }

    #[test]
    fn primary_key_change_is_refused_with_named_error() {
        let h = setup();
        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();

        let mut changed = declaration("mm.sessions.v2", None);
        changed.tables[0].primary_key = vec!["chatRowCount".to_string()];

        let errors = h.registry.declare(&changed).unwrap_err();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].contains("cannot change its primary key"),
            "{errors:?}"
        );
    }

    // ── Round-2 ST-10b mirrors ───────────────────────────────────────────────

    /// A declared-layer-shaped physical table with a declared column missing is
    /// classified `AddColumns` (the additive drift defense) rather than rebuilt.
    #[test]
    fn declared_layer_with_a_missing_declared_column_classifies_as_add_columns() {
        let h = setup();
        let v1 = declaration("mm.sessions.v1", None);
        h.registry.declare(&v1).unwrap();

        let v2 = declaration(
            "mm.sessions.v2",
            Some(session_column(
                "visibleTurnCount",
                DeclaredColumnType::Integer,
            )),
        );
        let full = full_name();
        let physical = h.store.table_schema(&full).unwrap();
        let meta = h
            .registry
            .meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap();
        let plan = h
            .registry
            .compute_plan("mission-monitor", &v2.tables[0], Some(&meta), &physical)
            .unwrap();
        match plan {
            MigrationPlan::AddColumns(additions) => {
                assert_eq!(additions.len(), 1, "{additions:?}");
                assert_eq!(additions[0].name, "visibleTurnCount");
            }
            other => panic!("expected AddColumns, got {other:?}"),
        }
    }

    /// A foreign table carrying SEVERAL rows is moved aside verbatim; every row
    /// survives (the row count is unchanged under the quarantine name).
    #[test]
    fn foreign_table_with_rows_is_moved_aside_and_every_row_survives() {
        let h = setup();
        let full = full_name();
        h.store
            .execute_batch(&format!(
                "CREATE TABLE {full} (
                     session_id TEXT PRIMARY KEY,
                     label TEXT NOT NULL,
                     start_time TEXT NOT NULL,
                     end_time TEXT,
                     delivery_count INTEGER NOT NULL
                 );
                 INSERT INTO {full} (session_id, label, start_time, delivery_count) VALUES
                     ('legacy-1', 'One', '2026-01-01T00:00:00Z', 1),
                     ('legacy-2', 'Two', '2026-01-02T00:00:00Z', 2),
                     ('legacy-3', 'Three', '2026-01-03T00:00:00Z', 3);"
            ))
            .unwrap();

        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();

        let legacy = legacy_quarantine_name(&h);
        let conn = rusqlite::Connection::open(h.dir.path().join("fredo.db")).unwrap();
        let moved: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {legacy}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(moved, 3, "every foreign row survives the rebuild");
        assert_eq!(legacy_quarantine_count(&h), 1, "exactly one quarantine");
    }

    /// ST-6R: the legacy `feature_mission_monitor_deleted_sessions` tombstones are
    /// migrated into the declared layer under the exact wire format the projection
    /// `is_tombstoned` guard reads, idempotently, and the legacy table survives.
    #[test]
    fn legacy_deletion_tombstones_are_migrated_when_the_sessions_table_is_rebuilt() {
        let h = setup();
        let full = full_name();
        seed_legacy_collision(&h, &full);
        h.store
            .execute_batch(
                "CREATE TABLE feature_mission_monitor_deleted_sessions (
                     session_id TEXT,
                     deleted_at TEXT
                 );
                 INSERT INTO feature_mission_monitor_deleted_sessions (session_id, deleted_at) VALUES
                     ('ses_deleted_1', '2026-01-01T00:00:00Z'),
                     ('ses_deleted_2', '2026-01-02T00:00:00Z');",
            )
            .unwrap();

        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();

        // The exact `tombstone_key`/`is_tombstoned` wire format: ["<sessionId>"].
        assert!(h
            .registry
            .meta
            .is_tombstoned("mission-monitor", "sessions", "[\"ses_deleted_1\"]")
            .unwrap());
        assert!(h
            .registry
            .meta
            .is_tombstoned("mission-monitor", "sessions", "[\"ses_deleted_2\"]")
            .unwrap());
        assert!(!h
            .registry
            .meta
            .is_tombstoned("mission-monitor", "sessions", "[\"ses_live\"]")
            .unwrap());

        let tombstones = h
            .registry
            .meta
            .list_tombstones("mission-monitor", "sessions")
            .unwrap();
        assert_eq!(tombstones.len(), 2, "both legacy tombstones migrated");
        assert_eq!(tombstones[0].deleted_at, "2026-01-01T00:00:00Z");

        // Idempotent: a second declare neither duplicates nor errors.
        h.registry
            .declare(&declaration("mm.sessions.v1", None))
            .unwrap();
        assert_eq!(
            h.registry
                .meta
                .list_tombstones("mission-monitor", "sessions")
                .unwrap()
                .len(),
            2
        );

        // The legacy table is preserved read-only.
        assert!(h
            .store
            .table_exists("feature_mission_monitor_deleted_sessions")
            .unwrap());
    }
}
