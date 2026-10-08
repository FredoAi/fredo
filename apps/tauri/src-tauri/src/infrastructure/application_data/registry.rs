//! Declaration registry — persistence + idempotent materialization of declared
//! application tables (Spec #2896, ST-2, R-4.1/R-4.3/R-4.4).
//!
//! `declare` persists the declaration into `feature_data_tables` (via
//! [`ApplicationDataStore`]) and materializes the physical table
//! (`CREATE TABLE IF NOT EXISTS feature_<sanitized applicationId>_<table>` + the
//! backend-managed reserved columns `_row_version` / `_updated_at`), reusing
//! [`ApplicationStore::validate_namespace`] for the isolation prefix.
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

use crate::infrastructure::storage::engine::quote_ident;
use crate::infrastructure::storage::application_store::{ColumnType, ApplicationStore, PhysicalColumn};

use super::declaration::{
    is_reserved_column, DeclaredColumn, DeclaredColumnType, ApplicationDataDeclaration,
    ApplicationDataTableDeclaration,
};
use super::store::{ApplicationDataStore, TableMeta, Tombstone};

/// One materialized declared table (the `application_data_declare` result element,
/// contract (c)).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedTable {
    #[serde(rename = "applicationId")]
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
    pub declaration: ApplicationDataTableDeclaration,
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

/// One planned table migration — the application id + revision are carried alongside
/// the table declaration so `apply_plan` can materialize without re-deriving them.
struct PlannedTable<'a> {
    feature_id: &'a str,
    revision: &'a str,
    table: &'a ApplicationDataTableDeclaration,
    plan: MigrationPlan,
}

/// Declaration registry — persisted declarations + idempotent materialization.
pub struct DeclarationRegistry {
    meta: Arc<ApplicationDataStore>,
    store: Arc<ApplicationStore>,
}

impl DeclarationRegistry {
    /// Build a registry over the metadata store and the application-scoped table store.
    pub fn new(meta: Arc<ApplicationDataStore>, store: Arc<ApplicationStore>) -> Self {
        DeclarationRegistry { meta, store }
    }

    /// Declare one application's tables (see [`Self::declare_many`]).
    pub fn declare(
        &self,
        declaration: &ApplicationDataDeclaration,
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
        declarations: &[ApplicationDataDeclaration],
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
                let full = match ApplicationStore::validate_namespace(&declaration.feature_id, &table.name)
                {
                    Ok(full) => full,
                    Err(e) => {
                        errors.push(format!(
                            "application '{}' table '{}' is not a valid application namespace: {e}",
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
                            "application '{}' table '{}' physical schema read failed: {e}",
                            declaration.feature_id, table.name
                        ));
                        continue;
                    }
                };
                let existing = match self.meta.get_table(&declaration.feature_id, &table.name) {
                    Ok(existing) => existing,
                    Err(e) => {
                        errors.push(format!(
                            "application '{}' table '{}' metadata read failed: {e}",
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
                    "application '{}' table '{}' materialization failed: {e}",
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
                "failed to load persisted application data declarations: {e}"
            )]
        })?;

        let mut materialized = Vec::new();
        let mut errors = Vec::new();
        for meta in metas {
            let declaration: ApplicationDataTableDeclaration =
                match serde_json::from_str(&meta.declaration_json) {
                    Ok(declaration) => declaration,
                    Err(e) => {
                        errors.push(format!(
                            "persisted declaration for application '{}' table '{}' is unreadable: {e}",
                            meta.feature_id, meta.table_name
                        ));
                        continue;
                    }
                };

            let full = match ApplicationStore::validate_namespace(&meta.feature_id, &meta.table_name) {
                Ok(full) => full,
                Err(e) => {
                    errors.push(format!(
                        "failed to re-materialize application '{}' table '{}': {e}",
                        meta.feature_id, meta.table_name
                    ));
                    continue;
                }
            };
            let physical = match self.store.table_schema(&full) {
                Ok(physical) => physical,
                Err(e) => {
                    errors.push(format!(
                        "failed to read the physical schema for application '{}' table '{}': {e}",
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
                            "failed to re-materialize application '{}' table '{}': {e}",
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
                "failed to load persisted application data declarations: {e}"
            )]
        })?;
        let mut tables = Vec::with_capacity(metas.len());
        for meta in metas {
            match serde_json::from_str::<ApplicationDataTableDeclaration>(&meta.declaration_json) {
                Ok(declaration) => tables.push(PersistedTable {
                    feature_id: meta.feature_id,
                    table_name: meta.table_name,
                    revision: meta.declaration_revision,
                    declaration,
                }),
                Err(e) => {
                    return Err(vec![format!(
                        "persisted declaration for application '{}' table '{}' is unreadable: {e}",
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
                "application '{feature_id}' table '{table_name}' metadata read failed: {e}"
            )]
        })?;
        let Some(meta) = meta else {
            return Ok(None);
        };
        match serde_json::from_str::<ApplicationDataTableDeclaration>(&meta.declaration_json) {
            Ok(declaration) => Ok(Some(PersistedTable {
                feature_id: meta.feature_id,
                table_name: meta.table_name,
                revision: meta.declaration_revision,
                declaration,
            })),
            Err(e) => Err(vec![format!(
                "persisted declaration for application '{feature_id}' table '{table_name}' is unreadable: {e}"
            )]),
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    fn apply_plan(
        &self,
        feature_id: &str,
        declaration_revision: &str,
        table: &ApplicationDataTableDeclaration,
        plan: MigrationPlan,
    ) -> Result<MaterializedTable> {
        let full = ApplicationStore::validate_namespace(feature_id, &table.name)?;
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
                            quote_ident(&full),
                            quote_ident(&column.name),
                            declared_sql_type(column.col_type)
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
                    quote_ident(&full),
                    quote_ident(&quarantine)
                ))?;
                self.store
                    .execute_batch(&create_table_sql(&full, table))?;
                self.meta.put_table(&TableMeta {
                    feature_id: feature_id.to_string(),
                    table_name: table.name.clone(),
                    declaration_json,
                    declaration_revision: declaration_revision.to_string(),
                    last_version: 0,
                    backfill_done: false,
                })?;
                tracing::warn!(
                    target: "fredo::application_data",
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
        table: &ApplicationDataTableDeclaration,
        existing: Option<&TableMeta>,
        physical: &[PhysicalColumn],
    ) -> Result<MigrationPlan, Vec<String>> {
        let persisted: Option<ApplicationDataTableDeclaration> = match existing {
            Some(meta) => match serde_json::from_str(&meta.declaration_json) {
                Ok(persisted) => Some(persisted),
                Err(e) => {
                    return Err(vec![format!(
                        "persisted declaration for application '{feature_id}' table '{}' is unreadable: {e}",
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
                    "application '{feature_id}' table '{}' cannot change its primary key from [{}] to [{}] \
                     (declared schema is additive-only; no data was deleted)",
                    table.name,
                    persisted.primary_key.join(", "),
                    table.primary_key.join(", ")
                ));
            }

            for old in &persisted.columns {
                match table.column(&old.name) {
                    None => errors.push(format!(
                        "application '{feature_id}' table '{}' cannot drop declared column '{}' \
                         (declared schema is additive-only; no data was deleted)",
                        table.name, old.name
                    )),
                    Some(new) if new.col_type != old.col_type => errors.push(format!(
                        "application '{feature_id}' table '{}' cannot retype column '{}' from {} to {} \
                         (declared schema is additive-only; no data was deleted)",
                        table.name,
                        old.name,
                        old.col_type.as_str(),
                        new.col_type.as_str()
                    )),
                    Some(new) if new.owner != old.owner => errors.push(format!(
                        "application '{feature_id}' table '{}' cannot change the owner of column '{}' \
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
            let full = ApplicationStore::validate_namespace(feature_id, &table.name)
                .map_err(|e| vec![format!("application '{feature_id}' table '{}': {e}", table.name)])?;
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
                        "application '{feature_id}' table '{}' physical column '{}' is {} but the declaration says {} (no data was deleted)",
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
    /// Idempotent (the tombstone upsert keyed on `(application, table, key_json)`),
    /// and the legacy table is READ-ONLY here — never mutated, never dropped.
    fn migrate_legacy_deletion_tombstones(&self) -> Result<()> {
        let legacy_full = ApplicationStore::validate_namespace("mission-monitor", "deleted_sessions")?;
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
            target: "fredo::application_data",
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
    table: &ApplicationDataTableDeclaration,
    persisted: Option<&ApplicationDataTableDeclaration>,
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

/// The physical SQL type for a declared column (Spec #2975 ST-4; PostgreSQL-only
/// since Spec #2979 CU-2).
///
/// Routes through the SHARED affinity ([`declared_affinity`]) and the ONE
/// physical type map ([`ColumnType::as_pg_type`]) — it introduces no second map.
fn declared_sql_type(col_type: DeclaredColumnType) -> &'static str {
    declared_affinity(col_type).as_pg_type()
}

/// The declared-table DDL: declared columns + the backend-managed reserved
/// columns + the composite primary key.
///
/// Identifier quoting is UNCONDITIONAL and single-string (`quote_ident`); the
/// physical TYPE token is the PostgreSQL C1 map (a ns-epoch `startedAtNs` cannot
/// fit int4).
fn create_table_sql(full: &str, table: &ApplicationDataTableDeclaration) -> String {
    let mut defs: Vec<String> = Vec::with_capacity(table.columns.len() + 3);
    for column in &table.columns {
        let not_null = if table.is_primary_key(&column.name) || !column.nullable {
            " NOT NULL"
        } else {
            ""
        };
        defs.push(format!(
            "{} {}{}",
            quote_ident(&column.name),
            declared_sql_type(column.col_type),
            not_null
        ));
    }
    defs.push(format!(
        "{} {} NOT NULL",
        quote_ident("_row_version"),
        ColumnType::INTEGER.as_pg_type()
    ));
    defs.push(format!(
        "{} {} NOT NULL",
        quote_ident("_updated_at"),
        ColumnType::TEXT.as_pg_type()
    ));
    if !table.primary_key.is_empty() {
        let keys = table
            .primary_key
            .iter()
            .map(|pk| quote_ident(pk))
            .collect::<Vec<_>>()
            .join(", ");
        defs.push(format!("PRIMARY KEY ({keys})"));
    }
    format!(
        "CREATE TABLE IF NOT EXISTS {} ({});",
        quote_ident(full),
        defs.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::application_data::declaration::{
        ColumnOwner, DataSource, Retention, SessionRollupKind, SessionRollupProjection,
    };
    use crate::infrastructure::rtdb::rows::RowState;
    use crate::infrastructure::storage::engine::EngineHandle;

    /// The canonical (post-rename) `mission-monitor.sessions` declaration — the
    /// live declaration a re-declare carries.
    fn mm_sessions_declaration() -> ApplicationDataTableDeclaration {
        let backend = |name: &str, ty: DeclaredColumnType, nullable: bool| DeclaredColumn {
            name: name.to_string(),
            col_type: ty,
            nullable,
            owner: ColumnOwner::Backend,
        };
        ApplicationDataTableDeclaration {
            name: "sessions".to_string(),
            primary_key: vec!["sessionId".to_string()],
            columns: vec![
                backend("sessionId", DeclaredColumnType::Text, false),
                backend("provider", DeclaredColumnType::Text, true),
                backend("startedAtNs", DeclaredColumnType::Integer, true),
                backend("latestAt", DeclaredColumnType::Text, false),
                backend("chatRowCount", DeclaredColumnType::Integer, false),
                backend("nonSubagentChatRowCount", DeclaredColumnType::Integer, false),
                backend("visibleTurnCount", DeclaredColumnType::Integer, false),
                backend("userDispatchCount", DeclaredColumnType::Integer, false),
                backend("derivedName", DeclaredColumnType::Text, true),
                backend("agentName", DeclaredColumnType::Text, true),
                DeclaredColumn {
                    name: "customName".to_string(),
                    col_type: DeclaredColumnType::Text,
                    nullable: true,
                    owner: ColumnOwner::Application,
                },
            ],
            source: Some(DataSource::SessionRollup(SessionRollupProjection {
                kind: SessionRollupKind::SessionRollup,
                exclude_dispatch_names: vec!["build".to_string(), "plan".to_string()],
                terminal_states: vec![RowState::Response, RowState::Timeout],
            })),
            retention: Some(Retention {
                max_rows: Some(500),
                ttl_days: None,
            }),
        }
    }

    /// The physical declared-layer schema matching [`mm_sessions_declaration`]:
    /// the declared columns plus the two NOT NULL reserved columns, with the
    /// primary key physically on `sessionId`.
    fn mm_sessions_physical(table: &ApplicationDataTableDeclaration) -> Vec<PhysicalColumn> {
        let mut columns: Vec<PhysicalColumn> = table
            .columns
            .iter()
            .map(|column| PhysicalColumn {
                name: column.name.clone(),
                sql_type: declared_affinity(column.col_type).as_pg_type().to_string(),
                col_type: declared_affinity(column.col_type),
                not_null: table.is_primary_key(&column.name) || !column.nullable,
                primary_key: table.is_primary_key(&column.name),
            })
            .collect();
        columns.push(PhysicalColumn {
            name: "_row_version".to_string(),
            sql_type: ColumnType::INTEGER.as_pg_type().to_string(),
            col_type: ColumnType::INTEGER,
            not_null: true,
            primary_key: false,
        });
        columns.push(PhysicalColumn {
            name: "_updated_at".to_string(),
            sql_type: ColumnType::TEXT.as_pg_type().to_string(),
            col_type: ColumnType::TEXT,
            not_null: true,
            primary_key: false,
        });
        columns
    }

    fn pending_registry() -> DeclarationRegistry {
        let handle = EngineHandle::new_pending();
        DeclarationRegistry::new(
            Arc::new(ApplicationDataStore::open(handle.clone()).expect("data store")),
            Arc::new(ApplicationStore::open(handle).expect("application store")),
        )
    }

    /// Spec #2956 round 2, AC4. A persisted `TableMeta` whose `declaration_json`
    /// carries the pre-rename `"owner":"feature"` tag must resolve through the
    /// SAME persisted-read/plan path ([`DeclarationRegistry::compute_plan`]) the
    /// seven read sites use, with no "unreadable" error. The live declaration
    /// matches the persisted one, so the resolution is the non-destructive
    /// `EnsureOnly` (never a rebuild/refusal). Before the `ColumnOwner` alias
    /// this test fails with `unknown variant 'feature'`.
    #[test]
    fn legacy_owner_tag_persisted_declaration_plans_without_unreadable_error() {
        let registry = pending_registry();
        let live = mm_sessions_declaration();
        let physical = mm_sessions_physical(&live);

        // The real persisted `feature_data_tables.declaration_json` shape with the
        // pre-rename `ColumnOwner` tag on the application-owned column.
        let legacy_json = serde_json::to_string(&live)
            .unwrap()
            .replace(r#""owner":"application""#, r#""owner":"feature""#);
        assert!(
            legacy_json.contains(r#""owner":"feature""#),
            "fixture must carry the legacy tag: {legacy_json}"
        );

        let meta = TableMeta {
            feature_id: "mission-monitor".to_string(),
            table_name: "sessions".to_string(),
            declaration_json: legacy_json,
            declaration_revision: "mm.sessions.v2".to_string(),
            last_version: 0,
            backfill_done: true,
        };

        let plan = registry
            .compute_plan("mission-monitor", &live, Some(&meta), &physical)
            .expect(
                "a pre-rename persisted `owner:\"feature\"` declaration must not be 'unreadable'",
            );
        assert_eq!(
            plan,
            MigrationPlan::EnsureOnly,
            "an unchanged pre-rename declaration must resolve to a non-destructive EnsureOnly"
        );
    }
}
