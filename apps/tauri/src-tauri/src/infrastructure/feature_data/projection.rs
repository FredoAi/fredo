//! Projection engine — turns every canonical RTDB row upsert into declared-table
//! writes, unconditionally and without any feature-side write (Spec #2896, ST-3,
//! R-4.2/R-4.5).
//!
//! ## Entry point + seam
//!
//! [`Rtdb::ingest_row_upsert`] calls [`dispatch_row_upsert`] for EVERY upsert,
//! with no subscription/watch/read open (R-4.2). The installed
//! [`RowUpsertObserver`] (ST-4 installs a [`ProjectionEngine`]) recomputes the
//! declared rows affected by the mutation:
//!
//! 1. load every persisted declaration ([`FeatureDataStore::list_tables`]);
//! 2. for a `row` source whose `from` matches the mutated row kind, recompute
//!    that canonical key's declared record (field map + `where`);
//! 3. for a `sessionRollup` source, recompute the one affected group (bounded
//!    per-key SQL over the canonical `*_rows` tables — [`session_rollup`]);
//! 4. `INSERT ... ON CONFLICT(pk) DO UPDATE` the declared row (via
//!    [`FeatureStore::upsert`]) with a per-record `_row_version` bump and a
//!    table-scope `feature_data_tables.last_version` bump per applied change;
//! 5. hand the change to the installed [`DeclaredRowObserver`] — the ST-4
//!    watch-registry seam, which fans it out to table/record/field watches.
//!
//! ## Correctness under the write-behind queue
//!
//! Canonical rows reach SQLite through the RTDB write-behind queue (~30 ms
//! batches), so a bounded SQL read taken immediately after the cache upsert can
//! lag. The engine therefore keeps a bounded in-flight overlay of every row it
//! observed ([`session_rollup::ObservedGroup`]) and merges it over the persisted
//! group by `seq` (observed wins unless SQL already carries `seq >=`). A row
//! that stops matching a `row` projection's `where`, or a `sessionRollup` group
//! that stops qualifying, is DELETED and reported as `kind: Remove`
//! (contract (e)); a field set to null is an `update`, never a `remove`.
//!
//! ## Canonical reads are read-only
//!
//! The engine opens its OWN `fredo.db` connection with `PRAGMA query_only=ON`
//! and only ever SELECTs the canonical `*_rows` tables (NFR-6 — canonical
//! contents and the classifier's extraction rules are untouched). Declared-table
//! writes go through [`FeatureStore`]'s connection.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as JsonValue};

use crate::infrastructure::rtdb::commands::IngestRow;
use crate::infrastructure::rtdb::project::rfc3339_now;
use crate::infrastructure::storage::feature_store::FeatureStore;

use super::declaration::{
    is_reserved_column, ActivitySource, ColumnOwner, DataSource, FeatureDataTableDeclaration,
    FieldMapping, RowProjection, WhereExpr,
};
use super::session_rollup::{
    self, ObservedGroup, ObservedRow, RollupAgentRow, RollupChatRow, RollupToolRow,
};
use super::store::{FeatureDataStore, TableMeta};

/// Sessions whose in-flight overlay is retained (bounded — a session evicted
/// here re-seeds from canonical SQL on its next mutation, by which point its
/// rows have flushed).
const MAX_OBSERVED_SESSIONS: usize = 128;

// ── Change + observer seam ──────────────────────────────────────────────────

/// The kind of a declared-row change (`insert` | `update` | `remove` on the
/// wire — ST-4 maps it onto its `FeatureRowNotification.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeclaredChangeKind {
    Insert,
    Update,
    Remove,
}

/// One declared-row change handed to the watch-registry seam (ST-4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredRowChange {
    /// The declaring feature (`feature_<sanitized id>_<table>` namespace).
    pub feature_id: String,
    /// The logical declared table name.
    pub table: String,
    pub kind: DeclaredChangeKind,
    /// Primary-key values in declaration order.
    pub key: Vec<JsonValue>,
    /// Names of the changed columns (whole known column set for `remove`).
    pub changed_fields: Vec<String>,
    /// Current declared values (reserved columns included); `None` on `remove`.
    pub values: Option<Map<String, JsonValue>>,
    /// The declared table's scope version AFTER this change (`last_version`).
    pub version: i64,
}

/// The watch-registry seam — ST-4 implements this and plugs it in; ST-3 only
/// emits changes.
pub trait DeclaredRowObserver: Send + Sync {
    /// One declared row changed. Never re-enter the projection engine.
    fn on_declared_row_change(&self, change: &DeclaredRowChange);
}

/// The canonical-upsert observer ST-4 installs (the projection engine).
pub trait RowUpsertObserver: Send + Sync {
    /// EVERY canonical upsert, unconditionally (no subscription required).
    fn on_row_upsert(&self, row: &IngestRow, changed_fields: &[String]);
}

static ROW_UPSERT_OBSERVER: Mutex<Option<Arc<dyn RowUpsertObserver>>> = Mutex::new(None);

/// Install the canonical-upsert observer (ST-4, once at startup).
pub fn install_row_upsert_observer(observer: Arc<dyn RowUpsertObserver>) {
    let mut guard = lock_row_upsert_observer();
    *guard = Some(observer);
}

/// Remove the canonical-upsert observer (tests / teardown).
pub fn clear_row_upsert_observer() {
    let mut guard = lock_row_upsert_observer();
    *guard = None;
}

/// The seam `Rtdb::ingest_row_upsert` calls for every canonical upsert. A no-op
/// until an observer is installed, so the canonical pipeline is unaffected when
/// the feature-data layer is not composed (existing RTDB tests, CLI mode).
pub fn dispatch_row_upsert(row: &IngestRow, changed_fields: &[String]) {
    let observer = {
        let guard = lock_row_upsert_observer();
        guard.as_ref().map(Arc::clone)
    };
    if let Some(observer) = observer {
        observer.on_row_upsert(row, changed_fields);
    }
}

fn lock_row_upsert_observer() -> MutexGuard<'static, Option<Arc<dyn RowUpsertObserver>>> {
    match ROW_UPSERT_OBSERVER.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

// ── Engine ──────────────────────────────────────────────────────────────────

struct PersistedDecl {
    meta: TableMeta,
    declaration: FeatureDataTableDeclaration,
}

#[derive(Default)]
struct ObservedState {
    groups: HashMap<String, ObservedGroup>,
    order: VecDeque<String>,
}

/// The backend-owned projection engine: canonical upserts → declared-table
/// writes, with the declared-row change seam (ST-4).
pub struct ProjectionEngine {
    conn: Mutex<Connection>,
    meta: Arc<FeatureDataStore>,
    tables: Arc<FeatureStore>,
    observer: Mutex<Option<Arc<dyn DeclaredRowObserver>>>,
    observed: Mutex<ObservedState>,
    dispatch: Mutex<()>,
}

impl ProjectionEngine {
    /// Open the engine's own (read-only) canonical connection over `fredo.db`.
    pub fn new(
        data_dir: PathBuf,
        meta: Arc<FeatureDataStore>,
        tables: Arc<FeatureStore>,
    ) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let conn = Connection::open(data_dir.join("fredo.db"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        // Canonical reads are read-only by contract (canonical table contents
        // are never modified by the projection engine).
        conn.execute_batch("PRAGMA query_only=ON;")?;
        Ok(ProjectionEngine {
            conn: Mutex::new(conn),
            meta,
            tables,
            observer: Mutex::new(None),
            observed: Mutex::new(ObservedState::default()),
            dispatch: Mutex::new(()),
        })
    }

    /// Install the declared-row change sink (ST-4's watch registry).
    pub fn set_declared_row_observer(&self, observer: Arc<dyn DeclaredRowObserver>) {
        let mut guard = self.lock_observer();
        *guard = Some(observer);
    }

    /// Remove the declared-row change sink.
    pub fn clear_declared_row_observer(&self) {
        let mut guard = self.lock_observer();
        *guard = None;
    }

    /// Project one canonical upsert. Public for tests; production flows through
    /// [`RowUpsertObserver::on_row_upsert`].
    pub fn project(&self, row: &IngestRow, _changed_fields: &[String]) -> Result<()> {
        let _dispatch = self.lock_dispatch();
        let declarations = self.persisted_declarations()?;
        if declarations.is_empty() {
            return Ok(());
        }

        let source = source_of(row);
        let session_id = session_id_of(row).to_string();
        if declarations
            .iter()
            .any(|decl| matches!(&decl.declaration.source, Some(DataSource::SessionRollup(_))))
        {
            self.observe(row);
        }

        for decl in &declarations {
            match &decl.declaration.source {
                Some(DataSource::Row(projection)) if projection.from == source => {
                    self.apply_row_projection(decl, projection, row)?;
                }
                Some(DataSource::SessionRollup(config)) => {
                    self.apply_session_rollup(decl, config, &session_id)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn persisted_declarations(&self) -> Result<Vec<PersistedDecl>> {
        let metas = self.meta.list_tables()?;
        let mut declarations = Vec::with_capacity(metas.len());
        for meta in metas {
            match serde_json::from_str::<FeatureDataTableDeclaration>(&meta.declaration_json) {
                Ok(declaration) => declarations.push(PersistedDecl { meta, declaration }),
                Err(e) => tracing::warn!(
                    target: "fredo::feature_data",
                    feature_id = %meta.feature_id,
                    table = %meta.table_name,
                    error = %e,
                    "persisted declared table is unreadable; projection skipped"
                ),
            }
        }
        Ok(declarations)
    }

    // ── row projection (field map + where) ──────────────────────────────────

    fn apply_row_projection(
        &self,
        decl: &PersistedDecl,
        projection: &RowProjection,
        row: &IngestRow,
    ) -> Result<()> {
        let row_map = row_as_json_object(row);
        let matched = projection
            .r#where
            .as_ref()
            .is_none_or(|expr| eval_where(expr, &row_map));

        let table = &decl.declaration;
        let mut selected = Map::new();
        for (target, mapping) in &projection.select {
            let Some(column) = table.column(target) else {
                continue;
            };
            if column.owner != ColumnOwner::Backend {
                continue;
            }
            let value = match mapping {
                FieldMapping::Field { field } => {
                    row_map.get(field).cloned().unwrap_or(JsonValue::Null)
                }
                FieldMapping::Literal { literal } => literal.clone(),
            };
            selected.insert(target.clone(), value);
        }
        let selected = declared_backend_values(table, selected);

        let mut key = Vec::with_capacity(table.primary_key.len());
        for name in &table.primary_key {
            match selected.get(name) {
                Some(value) => key.push(value.clone()),
                // The declared record cannot be identified without its key.
                None => return Ok(()),
            }
        }

        let existing = self.find_declared_row(decl, &key)?;
        if !matched {
            if let Some(old) = existing {
                let changed = non_reserved_names(&old);
                self.delete_declared_row(decl, &key)?;
                self.bump_and_notify(decl, DeclaredChangeKind::Remove, key, changed, None)?;
            }
            return Ok(());
        }
        if self.is_tombstoned(decl, &key)? {
            return Ok(());
        }
        self.upsert_declared_row(decl, key, selected, existing)
    }

    // ── sessionRollup projection ────────────────────────────────────────────

    fn apply_session_rollup(
        &self,
        decl: &PersistedDecl,
        config: &super::declaration::SessionRollupProjection,
        session_id: &str,
    ) -> Result<()> {
        let group = self.load_group(session_id)?;
        let facts = session_rollup::compute_facts(&group, config);
        let key = vec![JsonValue::String(session_id.to_string())];
        let existing = self.find_declared_row(decl, &key)?;

        if !session_rollup::qualifies(&facts) {
            if let Some(old) = existing {
                let changed = non_reserved_names(&old);
                self.delete_declared_row(decl, &key)?;
                self.bump_and_notify(decl, DeclaredChangeKind::Remove, key, changed, None)?;
            }
            return Ok(());
        }
        if self.is_tombstoned(decl, &key)? {
            return Ok(());
        }

        let values = declared_backend_values(&decl.declaration, session_rollup::fact_values(&facts));
        self.upsert_declared_row(decl, key, values, existing)
    }

    /// Recompute source: bounded per-key canonical SQL + the in-flight overlay.
    fn load_group(&self, session_id: &str) -> Result<session_rollup::RollupGroup> {
        let mut group = {
            let conn = self.lock_conn();
            session_rollup::load_persisted_group(&conn, session_id)?
        };
        let state = self.lock_observed();
        if let Some(observed) = state.groups.get(session_id) {
            observed.merge_into(&mut group);
        }
        Ok(group)
    }

    fn observe(&self, row: &IngestRow) {
        let (session_id, observed) = observed_row(row);
        let mut state = self.lock_observed();
        if !state.groups.contains_key(&session_id) {
            state.order.push_back(session_id.clone());
            while state.order.len() > MAX_OBSERVED_SESSIONS {
                if let Some(evicted) = state.order.pop_front() {
                    state.groups.remove(&evicted);
                }
            }
        }
        state
            .groups
            .entry(session_id)
            .or_default()
            .observe(observed);
    }

    // ── declared-table I/O ──────────────────────────────────────────────────

    fn find_declared_row(
        &self,
        decl: &PersistedDecl,
        key: &[JsonValue],
    ) -> Result<Option<Map<String, JsonValue>>> {
        let where_cols = key_where_cols(&decl.declaration, key);
        let rows = self.tables.query(
            &decl.meta.feature_id,
            &decl.meta.table_name,
            Some(&where_cols),
            None,
            Some(2),
        )?;
        Ok(rows.into_iter().next())
    }

    fn delete_declared_row(&self, decl: &PersistedDecl, key: &[JsonValue]) -> Result<()> {
        let where_cols = key_where_cols(&decl.declaration, key);
        self.tables.delete(
            &decl.meta.feature_id,
            &decl.meta.table_name,
            &where_cols,
        )?;
        Ok(())
    }

    /// Insert or update the declared row, with change detection (a no-op change
    /// writes nothing and emits nothing — no phantom notification).
    fn upsert_declared_row(
        &self,
        decl: &PersistedDecl,
        key: Vec<JsonValue>,
        values: Map<String, JsonValue>,
        existing: Option<Map<String, JsonValue>>,
    ) -> Result<()> {
        let now = rfc3339_now();
        match existing {
            Some(old) => {
                let changed = diff_fields(&old, &values);
                if changed.is_empty() {
                    return Ok(());
                }
                let next_version = old
                    .get("_row_version")
                    .and_then(JsonValue::as_i64)
                    .unwrap_or(0)
                    + 1;
                let mut write = values;
                write.insert("_row_version".to_string(), json!(next_version));
                write.insert("_updated_at".to_string(), json!(now));
                self.write_declared_row(decl, &write)?;
                self.bump_and_notify(
                    decl,
                    DeclaredChangeKind::Update,
                    key,
                    changed,
                    Some(write),
                )
            }
            None => {
                let mut changed: Vec<String> = values.keys().cloned().collect();
                changed.sort();
                let mut write = values;
                write.insert("_row_version".to_string(), json!(1));
                write.insert("_updated_at".to_string(), json!(now));
                self.write_declared_row(decl, &write)?;
                self.bump_and_notify(
                    decl,
                    DeclaredChangeKind::Insert,
                    key,
                    changed,
                    Some(write),
                )
            }
        }
    }

    fn write_declared_row(
        &self,
        decl: &PersistedDecl,
        values: &Map<String, JsonValue>,
    ) -> Result<()> {
        self.tables.upsert(
            &decl.meta.feature_id,
            &decl.meta.table_name,
            &decl.declaration.primary_key,
            std::slice::from_ref(values),
        )?;
        Ok(())
    }

    fn is_tombstoned(&self, decl: &PersistedDecl, key: &[JsonValue]) -> Result<bool> {
        let key_json = serde_json::to_string(key)?;
        self.meta.is_tombstoned(
            &decl.meta.feature_id,
            &decl.meta.table_name,
            &key_json,
        )
    }

    /// Bump the declared table's scope version and hand the change to the seam.
    fn bump_and_notify(
        &self,
        decl: &PersistedDecl,
        kind: DeclaredChangeKind,
        key: Vec<JsonValue>,
        changed_fields: Vec<String>,
        values: Option<Map<String, JsonValue>>,
    ) -> Result<()> {
        let version = self
            .meta
            .get_table(&decl.meta.feature_id, &decl.meta.table_name)?
            .map_or(1, |meta| meta.last_version + 1);
        self.meta.set_last_version(
            &decl.meta.feature_id,
            &decl.meta.table_name,
            version,
        )?;
        let change = DeclaredRowChange {
            feature_id: decl.meta.feature_id.clone(),
            table: decl.meta.table_name.clone(),
            kind,
            key,
            changed_fields,
            values,
            version,
        };
        self.notify(&change);
        Ok(())
    }

    fn notify(&self, change: &DeclaredRowChange) {
        let observer = {
            let guard = self.lock_observer();
            guard.as_ref().map(Arc::clone)
        };
        if let Some(observer) = observer {
            observer.on_declared_row_change(change);
        }
    }

    // ── lock helpers (poison recovery — no unwrap) ──────────────────────────

    fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_observer(&self) -> MutexGuard<'_, Option<Arc<dyn DeclaredRowObserver>>> {
        match self.observer.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_observed(&self) -> MutexGuard<'_, ObservedState> {
        match self.observed.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_dispatch(&self) -> MutexGuard<'_, ()> {
        match self.dispatch.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl RowUpsertObserver for ProjectionEngine {
    fn on_row_upsert(&self, row: &IngestRow, changed_fields: &[String]) {
        if let Err(e) = self.project(row, changed_fields) {
            tracing::warn!(
                target: "fredo::feature_data",
                error = %e,
                "declared-table projection failed; canonical ingest unaffected"
            );
        }
    }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

fn source_of(row: &IngestRow) -> ActivitySource {
    match row {
        IngestRow::Chat(_) => ActivitySource::Chat,
        IngestRow::ToolUse(_) => ActivitySource::ToolUse,
        IngestRow::AgentSession(_) => ActivitySource::AgentSession,
    }
}

fn session_id_of(row: &IngestRow) -> &str {
    match row {
        IngestRow::Chat(row) => &row.session_id,
        IngestRow::ToolUse(row) => &row.session_id,
        IngestRow::AgentSession(row) => &row.session_id,
    }
}

fn observed_row(row: &IngestRow) -> (String, ObservedRow) {
    match row {
        IngestRow::Chat(row) => (
            row.session_id.clone(),
            ObservedRow::Chat(RollupChatRow::from_chat_row(row)),
        ),
        IngestRow::ToolUse(row) => (
            row.session_id.clone(),
            ObservedRow::Tool(RollupToolRow::from_tool_use_row(row)),
        ),
        IngestRow::AgentSession(row) => (
            row.session_id.clone(),
            ObservedRow::Agent(RollupAgentRow::from_agent_session_row(row)),
        ),
    }
}

fn row_as_json_object(row: &IngestRow) -> Map<String, JsonValue> {
    let value = match row {
        IngestRow::Chat(row) => serde_json::to_value(row),
        IngestRow::ToolUse(row) => serde_json::to_value(row),
        IngestRow::AgentSession(row) => serde_json::to_value(row),
    };
    match value {
        Ok(JsonValue::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Evaluate a declaration `where` expression against a canonical row's camelCase
/// field map (missing field ≡ null).
pub fn eval_where(expr: &WhereExpr, row: &Map<String, JsonValue>) -> bool {
    match expr {
        WhereExpr::All { all } => all.iter().all(|inner| eval_where(inner, row)),
        WhereExpr::Any { any } => any.iter().any(|inner| eval_where(inner, row)),
        WhereExpr::Not { not } => !eval_where(not, row),
        WhereExpr::Eq { field, eq } => row.get(field).map_or(eq.is_null(), |value| value == eq),
        WhereExpr::IsNull { field, is_null } => {
            row.get(field).is_none_or(JsonValue::is_null) == *is_null
        }
        WhereExpr::In { field, r#in } => {
            row.get(field).is_some_and(|value| r#in.iter().any(|item| item == value))
        }
    }
}

fn key_where_cols(table: &FeatureDataTableDeclaration, key: &[JsonValue]) -> Map<String, JsonValue> {
    table
        .primary_key
        .iter()
        .cloned()
        .zip(key.iter().cloned())
        .collect()
}

fn declared_backend_values(
    table: &FeatureDataTableDeclaration,
    values: Map<String, JsonValue>,
) -> Map<String, JsonValue> {
    values
        .into_iter()
        .filter(|(name, _)| {
            table
                .column(name)
                .is_some_and(|column| column.owner == ColumnOwner::Backend)
        })
        .collect()
}

fn non_reserved_names(row: &Map<String, JsonValue>) -> Vec<String> {
    let mut names: Vec<String> = row
        .keys()
        .filter(|key| !is_reserved_column(key))
        .cloned()
        .collect();
    names.sort();
    names
}

fn diff_fields(old: &Map<String, JsonValue>, new: &Map<String, JsonValue>) -> Vec<String> {
    let mut changed: Vec<String> = new
        .iter()
        .filter(|(key, value)| old.get(*key) != Some(*value))
        .map(|(key, _)| key.clone())
        .collect();
    changed.sort();
    changed
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::infrastructure::feature_data::declaration::{
        DeclaredColumn, DeclaredColumnType, FeatureDataDeclaration, FeatureDataTableDeclaration,
        RowProjectionKind, SessionRollupKind, SessionRollupProjection,
    };
    use crate::infrastructure::feature_data::registry::DeclarationRegistry;
    use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, RowState, ToolUseRow};
    use crate::infrastructure::rtdb::store::RtdbStore;

    fn column(
        name: &str,
        col_type: DeclaredColumnType,
        nullable: bool,
        owner: ColumnOwner,
    ) -> DeclaredColumn {
        DeclaredColumn {
            name: name.to_string(),
            col_type,
            nullable,
            owner,
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        engine: ProjectionEngine,
        meta: Arc<FeatureDataStore>,
        tables: Arc<FeatureStore>,
    }

    fn setup(declaration: &FeatureDataDeclaration) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let rtdb = Arc::new(RtdbStore::open(dir.path().to_path_buf()).unwrap());
        rtdb.ensure_schema().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let tables = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        let registry = DeclarationRegistry::new(meta.clone(), tables.clone());
        registry.declare(declaration).unwrap();
        let engine = ProjectionEngine::new(
            dir.path().to_path_buf(),
            meta.clone(),
            tables.clone(),
        )
        .unwrap();
        Harness {
            _dir: dir,
            engine,
            meta,
            tables,
        }
    }

    fn declared_rows(h: &Harness, feature_id: &str, table: &str) -> Vec<Map<String, JsonValue>> {
        h.tables.query(feature_id, table, None, None, None).unwrap()
    }

    fn chat_row(
        session_id: &str,
        correlation_id: &str,
        state: RowState,
        reply: Option<&str>,
        parent: Option<&str>,
        started_at_ns: Option<i64>,
        updated_at: &str,
    ) -> ChatRow {
        ChatRow {
            session_id: session_id.to_string(),
            correlation_id: correlation_id.to_string(),
            seq: 1,
            started_at_ns,
            ended_at_ns: None,
            updated_at: updated_at.to_string(),
            state,
            user_message: None,
            agent_reply: reply.map(str::to_string),
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cost_usd: None,
            model: None,
            parent_session_id: parent.map(str::to_string),
            composited_child_session_id: None,
            raw_json: "{}".to_string(),
        }
    }

    fn tool_row(
        session_id: &str,
        correlation_id: &str,
        tool_name: &str,
        subagent_type: Option<&str>,
        is_subagent: bool,
    ) -> ToolUseRow {
        ToolUseRow {
            session_id: session_id.to_string(),
            correlation_id: correlation_id.to_string(),
            seq: 1,
            started_at_ns: None,
            ended_at_ns: None,
            updated_at: "2026-09-18T00:00:00+00:00".to_string(),
            state: RowState::Response,
            tool_name: Some(tool_name.to_string()),
            tool_success: None,
            tool_error: None,
            duration_ms: None,
            tool_input_json: subagent_type
                .map(|value| format!(r#"{{"subagent_type":"{value}","prompt":"p"}}"#)),
            tool_output_json: None,
            is_subagent: Some(is_subagent),
            raw_json: "{}".to_string(),
        }
    }

    fn agent_row(session_id: &str, agent_name: &str, updated_at: &str) -> AgentSessionRow {
        AgentSessionRow {
            session_id: session_id.to_string(),
            correlation_id: session_id.to_string(),
            seq: 1,
            started_at_ns: None,
            ended_at_ns: None,
            updated_at: updated_at.to_string(),
            state: RowState::Update,
            total_tokens: None,
            total_messages: None,
            total_cost_usd: None,
            agent_name: Some(agent_name.to_string()),
            raw_json: "{}".to_string(),
        }
    }

    fn row_declaration() -> FeatureDataDeclaration {
        FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.turns.v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "turns".to_string(),
                primary_key: vec!["id".to_string()],
                columns: vec![
                    column("id", DeclaredColumnType::Text, false, ColumnOwner::Backend),
                    column(
                        "reply",
                        DeclaredColumnType::Text,
                        true,
                        ColumnOwner::Backend,
                    ),
                    column(
                        "kind",
                        DeclaredColumnType::Text,
                        false,
                        ColumnOwner::Backend,
                    ),
                ],
                source: Some(DataSource::Row(RowProjection {
                    kind: RowProjectionKind::Row,
                    from: ActivitySource::Chat,
                    r#where: Some(WhereExpr::All {
                        all: vec![
                            WhereExpr::Eq {
                                field: "state".to_string(),
                                eq: json!("Response"),
                            },
                            WhereExpr::IsNull {
                                field: "parentSessionId".to_string(),
                                is_null: true,
                            },
                        ],
                    }),
                    select: BTreeMap::from([
                        (
                            "id".to_string(),
                            FieldMapping::Field {
                                field: "correlationId".to_string(),
                            },
                        ),
                        (
                            "reply".to_string(),
                            FieldMapping::Field {
                                field: "agentReply".to_string(),
                            },
                        ),
                        (
                            "kind".to_string(),
                            FieldMapping::Literal {
                                literal: json!("chat"),
                            },
                        ),
                    ]),
                })),
                retention: None,
            }],
        }
    }

    fn mm_declaration() -> FeatureDataDeclaration {
        FeatureDataDeclaration {
            feature_id: "mission-monitor".to_string(),
            declaration_revision: "mm.sessions.v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "sessions".to_string(),
                primary_key: vec![session_rollup::SESSION_ID.to_string()],
                columns: vec![
                    column(
                        session_rollup::SESSION_ID,
                        DeclaredColumnType::Text,
                        false,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::STARTED_AT_NS,
                        DeclaredColumnType::Integer,
                        true,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::LATEST_AT,
                        DeclaredColumnType::Text,
                        false,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::CHAT_ROW_COUNT,
                        DeclaredColumnType::Integer,
                        false,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::NON_SUBAGENT_CHAT_ROW_COUNT,
                        DeclaredColumnType::Integer,
                        false,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::VISIBLE_TURN_COUNT,
                        DeclaredColumnType::Integer,
                        false,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::USER_DISPATCH_COUNT,
                        DeclaredColumnType::Integer,
                        false,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::DERIVED_NAME,
                        DeclaredColumnType::Text,
                        true,
                        ColumnOwner::Backend,
                    ),
                    column(
                        session_rollup::AGENT_NAME,
                        DeclaredColumnType::Text,
                        true,
                        ColumnOwner::Backend,
                    ),
                    column(
                        "customName",
                        DeclaredColumnType::Text,
                        true,
                        ColumnOwner::Feature,
                    ),
                ],
                source: Some(DataSource::SessionRollup(SessionRollupProjection {
                    kind: SessionRollupKind::SessionRollup,
                    exclude_dispatch_names: vec!["build".to_string(), "plan".to_string()],
                    terminal_states: vec![RowState::Response, RowState::Timeout],
                })),
                retention: None,
            }],
        }
    }

    #[derive(Default)]
    struct CollectingObserver {
        changes: Mutex<Vec<DeclaredRowChange>>,
    }

    impl DeclaredRowObserver for CollectingObserver {
        fn on_declared_row_change(&self, change: &DeclaredRowChange) {
            match self.changes.lock() {
                Ok(mut changes) => changes.push(change.clone()),
                Err(poisoned) => poisoned.into_inner().push(change.clone()),
            }
        }
    }

    // ── row projection (field map + where) ──────────────────────────────────

    #[test]
    fn row_projection_applies_field_map_and_where() {
        let h = setup(&row_declaration());
        let row = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            Some("hello"),
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        h.engine.project(&IngestRow::Chat(row), &[]).unwrap();

        let rows = declared_rows(&h, "probe", "turns");
        assert_eq!(rows.len(), 1, "where matched → projected");
        assert_eq!(rows[0].get("id"), Some(&json!("ses_1_1")));
        assert_eq!(rows[0].get("reply"), Some(&json!("hello")));
        assert_eq!(rows[0].get("kind"), Some(&json!("chat")));
        assert_eq!(rows[0].get("_row_version"), Some(&json!(1)));
    }

    #[test]
    fn row_projection_where_excludes_non_matching_rows() {
        let h = setup(&row_declaration());
        // state=Init fails the `state == Response` arm.
        let init = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Init,
            Some("hi"),
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        h.engine.project(&IngestRow::Chat(init), &[]).unwrap();
        // A subagent row fails the `parentSessionId is null` arm.
        let child = chat_row(
            "ses_1",
            "ses_1_2",
            RowState::Response,
            Some("child"),
            Some("ses_parent"),
            Some(2_000),
            "2026-09-18T00:00:02+00:00",
        );
        h.engine.project(&IngestRow::Chat(child), &[]).unwrap();

        assert!(declared_rows(&h, "probe", "turns").is_empty());
    }

    #[test]
    fn row_projection_update_bumps_row_version_and_reports_changed_fields() {
        let h = setup(&row_declaration());
        let observer = Arc::new(CollectingObserver::default());
        h.engine
            .set_declared_row_observer(observer.clone() as Arc<dyn DeclaredRowObserver>);

        let first = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            Some("hello"),
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        h.engine.project(&IngestRow::Chat(first), &[]).unwrap();
        let second = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            Some("bye"),
            None,
            Some(1_000),
            "2026-09-18T00:00:02+00:00",
        );
        h.engine.project(&IngestRow::Chat(second), &[]).unwrap();

        let rows = declared_rows(&h, "probe", "turns");
        assert_eq!(rows.len(), 1, "same key upserts in place");
        assert_eq!(rows[0].get("reply"), Some(&json!("bye")));
        assert_eq!(rows[0].get("_row_version"), Some(&json!(2)));

        let changes = observer.changes.lock().unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].kind, DeclaredChangeKind::Insert);
        assert_eq!(changes[1].kind, DeclaredChangeKind::Update);
        assert_eq!(changes[1].changed_fields, vec!["reply".to_string()]);
        assert_eq!(changes[1].version, 2, "scope version bumps per change");
    }

    #[test]
    fn row_projection_repeated_identical_mutation_is_a_noop() {
        let h = setup(&row_declaration());
        let observer = Arc::new(CollectingObserver::default());
        h.engine
            .set_declared_row_observer(observer.clone() as Arc<dyn DeclaredRowObserver>);

        let row = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            Some("hello"),
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        h.engine.project(&IngestRow::Chat(row.clone()), &[]).unwrap();
        h.engine.project(&IngestRow::Chat(row), &[]).unwrap();

        let changes = observer.changes.lock().unwrap();
        assert_eq!(changes.len(), 1, "an identical recompute emits no change");
        assert_eq!(declared_rows(&h, "probe", "turns")[0].get("_row_version"), Some(&json!(1)));
    }

    #[test]
    fn row_projection_deletes_the_record_when_where_stops_matching() {
        let h = setup(&row_declaration());
        let observer = Arc::new(CollectingObserver::default());
        h.engine
            .set_declared_row_observer(observer.clone() as Arc<dyn DeclaredRowObserver>);

        let response = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            Some("hello"),
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        h.engine.project(&IngestRow::Chat(response), &[]).unwrap();
        let init = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Init,
            Some("hello"),
            None,
            Some(1_000),
            "2026-09-18T00:00:02+00:00",
        );
        h.engine.project(&IngestRow::Chat(init), &[]).unwrap();

        assert!(declared_rows(&h, "probe", "turns").is_empty());
        let changes = observer.changes.lock().unwrap();
        let remove = changes.last().expect("remove change");
        assert_eq!(remove.kind, DeclaredChangeKind::Remove);
        assert!(remove.values.is_none());
        assert_eq!(
            remove.changed_fields,
            vec!["id".to_string(), "kind".to_string(), "reply".to_string()]
        );
    }

    #[test]
    fn row_projection_null_field_is_an_update_never_a_remove() {
        let h = setup(&row_declaration());
        let observer = Arc::new(CollectingObserver::default());
        h.engine
            .set_declared_row_observer(observer.clone() as Arc<dyn DeclaredRowObserver>);

        let with_reply = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            Some("hello"),
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        h.engine.project(&IngestRow::Chat(with_reply), &[]).unwrap();
        let without_reply = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            None,
            None,
            Some(1_000),
            "2026-09-18T00:00:02+00:00",
        );
        h.engine.project(&IngestRow::Chat(without_reply), &[]).unwrap();

        let rows = declared_rows(&h, "probe", "turns");
        assert_eq!(rows.len(), 1, "a null field is a value change, not a remove");
        assert_eq!(rows[0].get("reply"), Some(&JsonValue::Null));
        let changes = observer.changes.lock().unwrap();
        assert_eq!(changes.last().unwrap().kind, DeclaredChangeKind::Update);
        assert_eq!(
            changes.last().unwrap().changed_fields,
            vec!["reply".to_string()]
        );
    }

    // ── sessionRollup engine wiring ─────────────────────────────────────────

    #[test]
    fn session_rollup_projects_every_documented_fact_column() {
        let h = setup(&mm_declaration());
        h.engine
            .project(
                &IngestRow::Chat(chat_row(
                    "ses_mm",
                    "ses_mm_1",
                    RowState::Response,
                    Some(""),
                    None,
                    Some(1_000),
                    "2026-09-18T00:00:02+00:00",
                )),
                &[],
            )
            .unwrap();
        // A visible turn with a user message + a later timestamp.
        let mut visible = chat_row(
            "ses_mm",
            "ses_mm_2",
            RowState::Response,
            Some("the answer"),
            None,
            Some(2_000),
            "2026-09-18T00:00:05+00:00",
        );
        visible.user_message = Some("hello there".to_string());
        h.engine.project(&IngestRow::Chat(visible), &[]).unwrap();
        // A parent-keyed composited copy (counts in chatRowCount only).
        let mut copy = chat_row(
            "ses_mm",
            "ses_child_1",
            RowState::Response,
            Some("child"),
            Some("ses_mm"),
            Some(3_000),
            "2026-09-18T00:00:06+00:00",
        );
        copy.composited_child_session_id = Some("ses_child".to_string());
        h.engine.project(&IngestRow::Chat(copy), &[]).unwrap();
        // A user-requested dispatch counts; internal build/plan do not.
        h.engine
            .project(
                &IngestRow::ToolUse(tool_row(
                    "ses_mm",
                    "ses_mm_3",
                    "task",
                    Some("developer"),
                    false,
                )),
                &[],
            )
            .unwrap();
        h.engine
            .project(
                &IngestRow::ToolUse(tool_row(
                    "ses_mm",
                    "ses_mm_4",
                    "task",
                    Some("build"),
                    false,
                )),
                &[],
            )
            .unwrap();
        // A child-session task row is not the session's own dispatch.
        h.engine
            .project(
                &IngestRow::ToolUse(tool_row(
                    "ses_mm",
                    "ses_mm_5",
                    "task",
                    Some("tester"),
                    true,
                )),
                &[],
            )
            .unwrap();
        h.engine
            .project(
                &IngestRow::AgentSession(agent_row(
                    "ses_mm",
                    "developer",
                    "2026-09-18T00:00:07+00:00",
                )),
                &[],
            )
            .unwrap();

        let rows = declared_rows(&h, "mission-monitor", "sessions");
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.get(session_rollup::SESSION_ID), Some(&json!("ses_mm")));
        assert_eq!(row.get(session_rollup::CHAT_ROW_COUNT), Some(&json!(3)));
        assert_eq!(
            row.get(session_rollup::NON_SUBAGENT_CHAT_ROW_COUNT),
            Some(&json!(2))
        );
        assert_eq!(row.get(session_rollup::VISIBLE_TURN_COUNT), Some(&json!(1)));
        assert_eq!(row.get(session_rollup::USER_DISPATCH_COUNT), Some(&json!(1)));
        assert_eq!(row.get(session_rollup::STARTED_AT_NS), Some(&json!(1_000)));
        assert_eq!(
            row.get(session_rollup::LATEST_AT),
            Some(&json!("2026-09-18T00:00:06+00:00"))
        );
        assert_eq!(
            row.get(session_rollup::DERIVED_NAME),
            Some(&json!("hello there"))
        );
        assert_eq!(
            row.get(session_rollup::AGENT_NAME),
            Some(&json!("developer"))
        );
        assert_eq!(row.get("customName"), Some(&JsonValue::Null));
    }

    #[test]
    fn session_rollup_inserts_then_deletes_when_the_group_stops_qualifying() {
        let h = setup(&mm_declaration());
        let observer = Arc::new(CollectingObserver::default());
        h.engine
            .set_declared_row_observer(observer.clone() as Arc<dyn DeclaredRowObserver>);

        // A non-terminal (`init`) non-subagent turn qualifies.
        h.engine
            .project(
                &IngestRow::Chat(chat_row(
                    "ses_x",
                    "ses_x_1",
                    RowState::Init,
                    None,
                    None,
                    Some(1_000),
                    "2026-09-18T00:00:01+00:00",
                )),
                &[],
            )
            .unwrap();
        assert_eq!(declared_rows(&h, "mission-monitor", "sessions").len(), 1);

        // Transition it to a terminal blank turn with no dispatch → ceases to
        // qualify → row deleted + `remove` emitted.
        h.engine
            .project(
                &IngestRow::Chat(chat_row(
                    "ses_x",
                    "ses_x_1",
                    RowState::Response,
                    Some(""),
                    None,
                    Some(1_000),
                    "2026-09-18T00:00:02+00:00",
                )),
                &[],
            )
            .unwrap();
        assert!(declared_rows(&h, "mission-monitor", "sessions").is_empty());

        let changes = observer.changes.lock().unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].kind, DeclaredChangeKind::Insert);
        assert_eq!(changes[1].kind, DeclaredChangeKind::Remove);
        assert!(changes[1].values.is_none());
        assert_eq!(changes[1].key, vec![json!("ses_x")]);
    }

    #[test]
    fn session_rollup_never_stores_a_non_qualifying_group() {
        let h = setup(&mm_declaration());
        // Subagent-only rows (composited copy) never qualify, so no row exists.
        let mut copy = chat_row(
            "ses_child_group",
            "ses_child_1",
            RowState::Init,
            Some("child"),
            Some("ses_parent"),
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        copy.composited_child_session_id = Some("ses_child".to_string());
        h.engine.project(&IngestRow::Chat(copy), &[]).unwrap();
        assert!(declared_rows(&h, "mission-monitor", "sessions").is_empty());
    }

    // ── global seam ─────────────────────────────────────────────────────────

    struct CountingObserver {
        count: Arc<AtomicUsize>,
    }

    impl RowUpsertObserver for CountingObserver {
        fn on_row_upsert(&self, _row: &IngestRow, _changed_fields: &[String]) {
            self.count.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn dispatch_reaches_the_installed_observer_and_is_a_noop_without_one() {
        clear_row_upsert_observer();
        let row = IngestRow::Chat(chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Init,
            None,
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        ));
        dispatch_row_upsert(&row, &[]);
        assert_eq!(source_of(&row), ActivitySource::Chat);

        let count = Arc::new(AtomicUsize::new(0));
        install_row_upsert_observer(Arc::new(CountingObserver {
            count: count.clone(),
        }));
        dispatch_row_upsert(&row, &[]);
        assert_eq!(count.load(Ordering::Relaxed), 1);
        clear_row_upsert_observer();
        dispatch_row_upsert(&row, &[]);
        assert_eq!(count.load(Ordering::Relaxed), 1, "cleared observer is not called");
    }

    #[test]
    fn where_expr_evaluates_all_any_not_in_is_null_and_eq() {
        let row = json!({
            "state": "Response",
            "parentSessionId": JsonValue::Null,
            "toolName": "task",
        })
        .as_object()
        .unwrap()
        .clone();

        assert!(eval_where(
            &WhereExpr::Eq {
                field: "state".to_string(),
                eq: json!("Response"),
            },
            &row
        ));
        assert!(!eval_where(
            &WhereExpr::Eq {
                field: "state".to_string(),
                eq: json!("Init"),
            },
            &row
        ));
        assert!(eval_where(
            &WhereExpr::IsNull {
                field: "parentSessionId".to_string(),
                is_null: true,
            },
            &row
        ));
        assert!(!eval_where(
            &WhereExpr::IsNull {
                field: "parentSessionId".to_string(),
                is_null: false,
            },
            &row
        ));
        assert!(eval_where(
            &WhereExpr::IsNull {
                field: "missing".to_string(),
                is_null: true,
            },
            &row
        ));
        assert!(eval_where(
            &WhereExpr::In {
                field: "toolName".to_string(),
                r#in: vec![json!("bash"), json!("task")],
            },
            &row
        ));
        assert!(!eval_where(
            &WhereExpr::In {
                field: "toolName".to_string(),
                r#in: vec![json!("bash")],
            },
            &row
        ));
        assert!(eval_where(
            &WhereExpr::All {
                all: vec![
                    WhereExpr::Eq {
                        field: "state".to_string(),
                        eq: json!("Response"),
                    },
                    WhereExpr::IsNull {
                        field: "parentSessionId".to_string(),
                        is_null: true,
                    },
                ],
            },
            &row
        ));
        assert!(eval_where(
            &WhereExpr::Any {
                any: vec![
                    WhereExpr::Eq {
                        field: "state".to_string(),
                        eq: json!("Init"),
                    },
                    WhereExpr::Eq {
                        field: "state".to_string(),
                        eq: json!("Response"),
                    },
                ],
            },
            &row
        ));
        assert!(eval_where(
            &WhereExpr::Not {
                not: Box::new(WhereExpr::Eq {
                    field: "state".to_string(),
                    eq: json!("Init"),
                }),
            },
            &row
        ));
    }

    #[test]
    fn tombstoned_key_is_never_re_projected() {
        let h = setup(&row_declaration());
        // ST-4's delete writes the tombstone with the JSON-array key form; the
        // engine must not resurrect the row.
        h.meta
            .put_tombstone(&crate::infrastructure::feature_data::store::Tombstone {
                feature_id: "probe".to_string(),
                table_name: "turns".to_string(),
                key_json: serde_json::to_string(&vec![json!("ses_1_1")]).unwrap(),
                deleted_at: "2026-09-18T00:00:00+00:00".to_string(),
            })
            .unwrap();

        let row = chat_row(
            "ses_1",
            "ses_1_1",
            RowState::Response,
            Some("hello"),
            None,
            Some(1_000),
            "2026-09-18T00:00:01+00:00",
        );
        h.engine.project(&IngestRow::Chat(row), &[]).unwrap();
        assert!(declared_rows(&h, "probe", "turns").is_empty());
    }
}
