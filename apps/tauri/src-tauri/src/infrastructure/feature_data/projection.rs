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
//! The engine uses the SHARED read-only SQLite connection (Spec #2975 ST-5) and
//! only ever SELECTs the canonical `*_rows` tables (NFR-6 — canonical contents
//! and the classifier's extraction rules are untouched). Declared-table writes
//! go through [`FeatureStore`] on the active engine.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as JsonValue};

use crate::infrastructure::rtdb::commands::IngestRow;
use crate::infrastructure::rtdb::project::rfc3339_now;
use crate::infrastructure::storage::engine::{CanonicalReader, EngineHandle};
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

/// The outcome of projecting one canonical upsert into ONE declared table.
///
/// [`ProjectionEngine::project_reporting`] returns one outcome per affected
/// declaration, so a single broken declared table (e.g. a physical table whose
/// schema lacks a declared column) can never abort or suppress the healthy
/// siblings (ST-4R isolation fix).
#[derive(Debug)]
pub struct DeclTableOutcome {
    /// The declaring feature (`feature_<sanitized id>_<table>` namespace).
    pub feature_id: String,
    /// The logical declared table name.
    pub table: String,
    /// The projection result for this declaration ALONE.
    pub result: Result<()>,
}

/// The watch-registry seam — ST-4 implements this and plugs it in; ST-3 only
/// emits changes.
pub trait DeclaredRowObserver: Send + Sync {
    /// One declared row changed. Never re-enter the projection engine.
    fn on_declared_row_change(&self, change: &DeclaredRowChange);
}

/// The canonical-upsert observer ST-4 installs (the projection engine).
///
/// Async (Spec #2976 ST-6): the observer reads canonical rows through the
/// engine-selected read-only handle, which is async on PostgreSQL.
#[async_trait]
pub trait RowUpsertObserver: Send + Sync {
    /// EVERY canonical upsert, unconditionally (no subscription required).
    async fn on_row_upsert(&self, row: &IngestRow, changed_fields: &[String]);
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
pub async fn dispatch_row_upsert(row: &IngestRow, changed_fields: &[String]) {
    let observer = {
        let guard = lock_row_upsert_observer();
        guard.as_ref().map(Arc::clone)
    };
    if let Some(observer) = observer {
        observer.on_row_upsert(row, changed_fields).await;
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
    /// The shared engine handle (Spec #2976 ST-6): canonical `*_rows` reads
    /// follow the ACTIVE engine through [`StoreEngine::canonical_reader`] — the
    /// PostgreSQL pool wrapped in a READ ONLY transaction. Never a per-engine
    /// `Connection::open`. Declared-table writes go through [`FeatureStore`].
    engine: Arc<EngineHandle>,
    meta: Arc<FeatureDataStore>,
    tables: Arc<FeatureStore>,
    observer: Mutex<Option<Arc<dyn DeclaredRowObserver>>>,
    observed: Mutex<ObservedState>,
    /// Serializes projection runs. An async mutex (Spec #2976 ST-6): the guard
    /// is held across the now-async canonical read, and a std guard across an
    /// await would make the future `!Send`.
    dispatch: tokio::sync::Mutex<()>,
    /// Monotonic count of `sessionRollup` group recomputations (observability /
    /// test aid for the O(Σ group) backfill invariant, ST-4S).
    rollup_recomputes: AtomicUsize,
}

impl ProjectionEngine {
    /// Wrap the shared engine handle. Canonical reads use the engine-selected
    /// read-only handle; declared writes go through the shared `FeatureStore`.
    pub fn new(
        engine: Arc<EngineHandle>,
        meta: Arc<FeatureDataStore>,
        tables: Arc<FeatureStore>,
    ) -> Result<Self> {
        Ok(ProjectionEngine {
            engine,
            meta,
            tables,
            observer: Mutex::new(None),
            observed: Mutex::new(ObservedState::default()),
            dispatch: tokio::sync::Mutex::new(()),
            rollup_recomputes: AtomicUsize::new(0),
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

    /// Project one canonical upsert into EVERY affected declared table, with
    /// per-declaration isolation: one declaration's failure is returned as that
    /// outcome's `Err` and never aborts the loop, so a healthy sibling is still
    /// applied (ST-4R).
    ///
    /// Public for tests; production flows through
    /// [`RowUpsertObserver::on_row_upsert`]. Use [`Self::project`] when a single
    /// joined `Result` is wanted (existing callers/tests).
    pub async fn project_reporting(
        &self,
        row: &IngestRow,
        _changed_fields: &[String],
    ) -> Vec<DeclTableOutcome> {
        let _dispatch = self.lock_dispatch().await;
        let declarations = match self.persisted_declarations() {
            Ok(declarations) => declarations,
            // No per-declaration attribution is possible when the declaration
            // list itself is unreadable — surface it as one engine-level failure
            // so `project` still returns `Err` (behavior preserved).
            Err(e) => {
                return vec![DeclTableOutcome {
                    feature_id: String::new(),
                    table: String::new(),
                    result: Err(e),
                }];
            }
        };
        if declarations.is_empty() {
            return Vec::new();
        }

        let source = source_of(row);
        let session_id = session_id_of(row).to_string();
        if declarations
            .iter()
            .any(|decl| matches!(&decl.declaration.source, Some(DataSource::SessionRollup(_))))
        {
            self.observe(row);
        }

        let mut outcomes = Vec::new();
        for decl in &declarations {
            let result = if let Some(projection) = row_projection_for(decl, source) {
                self.apply_row_projection(decl, projection, row)
            } else if let Some(config) = session_rollup_for(decl) {
                self.apply_session_rollup(decl, config, &session_id).await
            } else {
                continue;
            };
            outcomes.push(DeclTableOutcome {
                feature_id: decl.meta.feature_id.clone(),
                table: decl.meta.table_name.clone(),
                result,
            });
        }
        outcomes
    }

    /// Project one canonical upsert, joining every declaration failure into one
    /// `Err`. Public for tests; production flows through
    /// [`RowUpsertObserver::on_row_upsert`]. Delegates to
    /// [`Self::project_reporting`] so both forms share one implementation.
    pub async fn project(&self, row: &IngestRow, changed_fields: &[String]) -> Result<()> {
        let failures: Vec<String> = self
            .project_reporting(row, changed_fields)
            .await
            .into_iter()
            .filter_map(|outcome| match outcome.result {
                Ok(()) => None,
                Err(e) => Some(format!(
                    "feature '{}' table '{}': {:#}",
                    outcome.feature_id, outcome.table, e
                )),
            })
            .collect();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(anyhow::anyhow!(failures.join("; ")))
        }
    }

    /// Feed one canonical row through ONLY the `row`-source declarations whose
    /// `from` source matches it (the backfill row leg, ST-4S). Unlike
    /// [`Self::project_reporting`] this never touches a `sessionRollup`
    /// declaration and never records an in-flight observation, so the backfill
    /// cost is O(rows of the source) — no per-row group recomputation.
    pub async fn project_row_sources(&self, row: &IngestRow) -> Vec<DeclTableOutcome> {
        let _dispatch = self.lock_dispatch().await;
        let declarations = match self.persisted_declarations() {
            Ok(declarations) => declarations,
            // No per-declaration attribution is possible when the declaration
            // list itself is unreadable — surface it as one engine-level failure
            // (mirrors `project_reporting`).
            Err(e) => {
                return vec![DeclTableOutcome {
                    feature_id: String::new(),
                    table: String::new(),
                    result: Err(e),
                }];
            }
        };
        if declarations.is_empty() {
            return Vec::new();
        }
        let source = source_of(row);
        let mut outcomes = Vec::new();
        for decl in &declarations {
            if let Some(projection) = row_projection_for(decl, source) {
                outcomes.push(DeclTableOutcome {
                    feature_id: decl.meta.feature_id.clone(),
                    table: decl.meta.table_name.clone(),
                    result: self.apply_row_projection(decl, projection, row),
                });
            }
        }
        outcomes
    }

    /// Recompute ONLY the `sessionRollup` declarations for `session_id` (the
    /// backfill rollup leg, ST-4S) — one call per distinct canonical session, so
    /// the total rollup cost becomes O(Σ group) instead of one full-group read
    /// per canonical row. This never records an in-flight observation: at startup
    /// SQLite is authoritative and the overlay exists only for write-behind lag.
    pub async fn project_session_rollups(&self, session_id: &str) -> Vec<DeclTableOutcome> {
        let _dispatch = self.lock_dispatch().await;
        let declarations = match self.persisted_declarations() {
            Ok(declarations) => declarations,
            Err(e) => {
                return vec![DeclTableOutcome {
                    feature_id: String::new(),
                    table: String::new(),
                    result: Err(e),
                }];
            }
        };
        if declarations.is_empty() {
            return Vec::new();
        }
        let mut outcomes = Vec::new();
        for decl in &declarations {
            if let Some(config) = session_rollup_for(decl) {
                outcomes.push(DeclTableOutcome {
                    feature_id: decl.meta.feature_id.clone(),
                    table: decl.meta.table_name.clone(),
                    result: self.apply_session_rollup(decl, config, session_id).await,
                });
            }
        }
        outcomes
    }

    /// Monotonic count of `sessionRollup` group recomputations performed by this
    /// engine (observability / test aid for the O(Σ group) backfill invariant).
    pub fn rollup_recompute_count(&self) -> usize {
        self.rollup_recomputes.load(Ordering::Relaxed)
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

    async fn apply_session_rollup(
        &self,
        decl: &PersistedDecl,
        config: &super::declaration::SessionRollupProjection,
        session_id: &str,
    ) -> Result<()> {
        self.rollup_recomputes.fetch_add(1, Ordering::Relaxed);
        let group = self.load_group(session_id).await?;
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

    /// Recompute source: bounded per-key canonical SQL + the in-flight overlay,
    /// read through the engine-selected read-only handle (REQ-9).
    async fn load_group(&self, session_id: &str) -> Result<session_rollup::RollupGroup> {
        let mut group = match self.canonical_conn().await? {
            CanonicalReader::Postgres(pool) => {
                session_rollup::load_persisted_group_pg(&pool, session_id).await?
            }
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

    /// The read-only canonical reader (AC3 / REQ-9): the shared PostgreSQL pool
    /// whose reads must be wrapped in [`begin_read_only`]. Used by the
    /// declared-table backfill's distinct-session enumeration.
    pub(crate) async fn canonical_conn(&self) -> Result<CanonicalReader> {
        let engine = self.engine.engine_or_err()?;
        engine
            .canonical_reader()
            .ok_or_else(|| anyhow::anyhow!("no canonical reader available for the active engine"))
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

    async fn lock_dispatch(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.dispatch.lock().await
    }
}

#[async_trait]
impl RowUpsertObserver for ProjectionEngine {
    async fn on_row_upsert(&self, row: &IngestRow, changed_fields: &[String]) {
        // Per-declaration isolation: one broken declared table must never stop a
        // healthy sibling from being applied (ST-4R), so use the reporting form
        // and log one scoped WARN per failed declaration.
        for outcome in self.project_reporting(row, changed_fields).await {
            if let Err(e) = outcome.result {
                tracing::warn!(
                    target: "fredo::feature_data",
                    feature_id = %outcome.feature_id,
                    table = %outcome.table,
                    error = %e,
                    "declared-table projection failed; canonical ingest unaffected"
                );
            }
        }
    }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/// The ONE shared source-matching rule: `Some` iff `decl` is a `row`
/// declaration whose `from` source equals `source`. Used by
/// [`ProjectionEngine::project_reporting`] and
/// [`ProjectionEngine::project_row_sources`] so the two can never diverge.
fn row_projection_for(decl: &PersistedDecl, source: ActivitySource) -> Option<&RowProjection> {
    match &decl.declaration.source {
        Some(DataSource::Row(projection)) if projection.from == source => Some(projection),
        _ => None,
    }
}

/// The ONE shared source-matching rule: `Some` iff `decl` is a `sessionRollup`
/// declaration. Used by [`ProjectionEngine::project_reporting`] and
/// [`ProjectionEngine::project_session_rollups`].
fn session_rollup_for(
    decl: &PersistedDecl,
) -> Option<&super::declaration::SessionRollupProjection> {
    match &decl.declaration.source {
        Some(DataSource::SessionRollup(config)) => Some(config),
        _ => None,
    }
}

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

/// The ONE value-diff rule, shared by the projection path
/// ([`upsert_declared_row`]) and the `feature_data_write` path so an unchanged
/// value is never reported as a change in either.
pub(crate) fn diff_fields(
    old: &Map<String, JsonValue>,
    new: &Map<String, JsonValue>,
) -> Vec<String> {
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
}
