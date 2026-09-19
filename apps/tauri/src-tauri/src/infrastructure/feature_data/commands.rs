//! Feature-data IPC surface (Spec #2896, ST-4): read / watch / unwatch /
//! write / delete / declare.
//!
//! Every command rejects with a HARD NAMED error (`Vec<String>` / `string[]`,
//! the `subscribe_events` precedent) and NEVER silently swallows a failure.
//!
//! Wire transport note: each command takes ONE struct argument named `args`, so
//! the frontend invokes e.g. `invoke('feature_data_read', { args: { ref, where,
//! orderBy, limit } })`. The `args` object's fields are exactly the contract
//! (b)/(c) shapes.
//!
//! The pure command bodies ([`read`], [`watch`], [`unwatch`], [`write`],
//! [`delete`], [`declare`]) are free functions over [`FeatureDataState`] so
//! they are unit-testable without a Tauri runtime; the `#[tauri::command]`
//! wrappers are thin.

use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as JsonValue};

use crate::infrastructure::feature_data::backfill;
use crate::infrastructure::feature_data::declaration::{
    is_reserved_column, FeatureDataDeclaration, FeatureDataTableDeclaration,
};
use crate::infrastructure::feature_data::lifecycle::{resolve_retention, tombstone_key};
use crate::infrastructure::feature_data::projection::{
    DeclaredChangeKind, DeclaredRowChange, ProjectionEngine,
};
use crate::infrastructure::feature_data::registry::DeclarationRegistry;
use crate::infrastructure::feature_data::store::{guard_feature_write, FeatureDataStore, Tombstone};
use crate::infrastructure::feature_data::watch::{
    EqFilter, WatchRegistry, WatchScope, WatchTarget,
};
use crate::infrastructure::rtdb::cache::read_knobs;
use crate::infrastructure::rtdb::store::{RowKind, RtdbStore};
use crate::infrastructure::storage::feature_store::FeatureStore;
use crate::infrastructure::storage::AppStore;

// ── Shared state ────────────────────────────────────────────────────────────

/// Everything the feature-data commands need, managed once in `lib.rs`.
pub struct FeatureDataState {
    /// App data dir (backfill's read-only canonical connection).
    pub data_dir: PathBuf,
    /// `feature_data_tables` / `feature_data_tombstones` metadata.
    pub meta: Arc<FeatureDataStore>,
    /// The feature-scoped typed-column table store (declared table DML).
    pub tables: Arc<FeatureStore>,
    /// AppStore (retention knobs + `resolve_retention`).
    pub app_store: Arc<AppStore>,
    /// Declaration persistence + materialization.
    pub registry: Arc<DeclarationRegistry>,
    /// Canonical → declared-row projection engine (also a `RowUpsertObserver`).
    pub engine: Arc<ProjectionEngine>,
    /// The process-global watch registry.
    pub watches: Arc<WatchRegistry>,
    /// Canonical `*_rows` reads (read-only snapshot selects).
    pub rtdb_store: Arc<RtdbStore>,
}

// ── Wire types ──────────────────────────────────────────────────────────────

/// The table a read/watch is addressed to (contract (b)).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum DataTableRef {
    /// A declared (feature-owned) table.
    Feature {
        #[serde(rename = "featureId")]
        feature_id: String,
        table: String,
    },
    /// A canonical RTDB table: `chat` | `toolUse` | `agentSession`.
    Canonical { table: String },
}

/// A declared-only table ref (write/delete).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureTableRef {
    pub feature_id: String,
    pub table: String,
}

/// `{ kind: 'table' } | { kind: 'record', key } | { kind: 'query', where }`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WatchScopeArg {
    Table,
    Record {
        key: Vec<JsonValue>,
    },
    Query {
        #[serde(rename = "where")]
        r#where: Vec<EqFilter>,
    },
}

/// `feature_data_read` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataReadArgs {
    #[serde(rename = "ref")]
    pub r#ref: DataTableRef,
    #[serde(default, rename = "where")]
    pub r#where: Vec<EqFilter>,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default)]
    pub limit: Option<u64>,
}

/// The declared retention bound surfaced to a read (null = unbounded).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureRetention {
    pub max_rows: Option<u64>,
    pub ttl_days: Option<u64>,
}

/// `feature_data_read` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataReadResult {
    pub version: u64,
    pub rows: Vec<Map<String, JsonValue>>,
    pub retention: FeatureRetention,
}

/// `feature_data_watch` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataWatchArgs {
    #[serde(rename = "ref")]
    pub r#ref: DataTableRef,
    pub scope: WatchScopeArg,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    #[serde(default)]
    pub initial: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flush_ms: Option<u64>,
}

/// `feature_data_watch` result (`rows` only when `initial: true`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataWatchResult {
    pub watch_id: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Map<String, JsonValue>>>,
}

/// `feature_data_unwatch` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataUnwatchArgs {
    pub watch_ids: Vec<String>,
}

/// `feature_data_unwatch` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataUnwatchResult {
    pub watch_ids: Vec<String>,
}

/// `feature_data_write` args (feature-owned columns only).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataWriteArgs {
    #[serde(rename = "ref")]
    pub r#ref: FeatureTableRef,
    pub key: Vec<JsonValue>,
    pub set: Map<String, JsonValue>,
}

/// `feature_data_write` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataWriteResult {
    pub updated: u64,
}

/// `feature_data_delete` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataDeleteArgs {
    #[serde(rename = "ref")]
    pub r#ref: FeatureTableRef,
    pub key: Vec<JsonValue>,
}

/// `feature_data_delete` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataDeleteResult {
    pub deleted: bool,
}

/// `feature_data_declare` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataDeclareArgs {
    pub declarations: Vec<JsonValue>,
}

/// `feature_data_declare` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDataDeclareResult {
    pub materialized: Vec<crate::infrastructure::feature_data::registry::MaterializedTable>,
}

// ── Command bodies (unit-testable) ──────────────────────────────────────────

fn one_error(message: impl Into<String>) -> Vec<String> {
    vec![message.into()]
}

fn to_errors(error: impl std::fmt::Display) -> Vec<String> {
    vec![error.to_string()]
}

/// Resolve a persisted declared table (hard named error when undeclared).
fn resolve_declaration(
    state: &FeatureDataState,
    feature_id: &str,
    table: &str,
) -> Result<FeatureDataTableDeclaration, Vec<String>> {
    match state.registry.persisted_table(feature_id, table) {
        Ok(Some(persisted)) => Ok(persisted.declaration),
        Ok(None) => Err(one_error(format!(
            "feature '{feature_id}' has not declared table '{table}' \
             (call feature_data_declare first)"
        ))),
        Err(errors) => Err(errors),
    }
}

fn canonical_kind(table: &str) -> Result<RowKind, Vec<String>> {
    match table {
        "chat" => Ok(RowKind::Chat),
        "toolUse" => Ok(RowKind::ToolUse),
        "agentSession" => Ok(RowKind::AgentSession),
        other => Err(one_error(format!(
            "canonical table '{other}' is not one of chat | toolUse | agentSession"
        ))),
    }
}

/// `[{ field, eq }]` → a `FeatureStore::query` WHERE map.
fn eq_map(filters: &[EqFilter]) -> Option<Map<String, JsonValue>> {
    if filters.is_empty() {
        return None;
    }
    let mut map = Map::new();
    for filter in filters {
        map.insert(filter.field.clone(), filter.eq.clone());
    }
    Some(map)
}

/// `[{ field, eq }]` against a record's current values (missing ≡ null).
fn eq_matches(values: &Map<String, JsonValue>, filters: &[EqFilter]) -> bool {
    filters.iter().all(|filter| {
        values
            .get(&filter.field)
            .map_or(filter.eq.is_null(), |value| value == &filter.eq)
    })
}

/// Primary-key values in declaration order → a `FeatureStore` WHERE map.
fn key_map(
    declaration: &FeatureDataTableDeclaration,
    key: &[JsonValue],
) -> Result<Map<String, JsonValue>, Vec<String>> {
    if key.len() != declaration.primary_key.len() {
        return Err(one_error(format!(
            "table '{}' expects {} primary-key value(s) but {} were given",
            declaration.name,
            declaration.primary_key.len(),
            key.len()
        )));
    }
    Ok(declaration
        .primary_key
        .iter()
        .cloned()
        .zip(key.iter().cloned())
        .collect())
}

/// Reserved backend-managed columns surfaced camelCase; `_rowVersion` added.
fn normalize_row(row: &mut Map<String, JsonValue>, row_version: Option<u64>) {
    if let Some(version) = row.remove("_row_version") {
        row.insert("_rowVersion".to_string(), version);
    }
    if let Some(updated) = row.remove("_updated_at") {
        row.insert("_updatedAt".to_string(), updated);
    }
    if let Some(version) = row_version {
        row.insert("_rowVersion".to_string(), json!(version));
    }
}

/// `[{ field, eq }]` → `(field, descending)`.
fn parse_order_by(order_by: &str) -> (String, bool) {
    let mut parts = order_by.split_whitespace();
    let field = parts.next().unwrap_or_default().to_string();
    let descending = parts
        .next()
        .is_some_and(|direction| direction.eq_ignore_ascii_case("desc"));
    (field, descending)
}

/// Validate a declared-table `orderBy` against the declared columns.
fn validated_order_by(
    declaration: &FeatureDataTableDeclaration,
    order_by: Option<&str>,
) -> Result<Option<String>, Vec<String>> {
    let Some(order_by) = order_by else {
        return Ok(None);
    };
    if order_by.trim().is_empty() {
        return Ok(None);
    }
    let (field, descending) = parse_order_by(order_by);
    let known = declaration.column(&field).is_some()
        || is_reserved_column(&field)
        || field == "_rowVersion";
    if !known {
        return Err(one_error(format!(
            "orderBy column '{field}' is not declared on table '{}'",
            declaration.name
        )));
    }
    let column = if field == "_rowVersion" { "_row_version" } else { field.as_str() };
    Ok(Some(format!(
        "{} {}",
        column,
        if descending { "DESC" } else { "ASC" }
    )))
}

fn json_cmp(a: &JsonValue, b: &JsonValue) -> Ordering {
    match (a, b) {
        (JsonValue::Number(left), JsonValue::Number(right)) => left
            .as_f64()
            .partial_cmp(&right.as_f64())
            .unwrap_or(Ordering::Equal),
        (JsonValue::String(left), JsonValue::String(right)) => left.cmp(right),
        (JsonValue::Bool(left), JsonValue::Bool(right)) => left.cmp(right),
        (JsonValue::Null, JsonValue::Null) => Ordering::Equal,
        (JsonValue::Null, _) => Ordering::Less,
        (_, JsonValue::Null) => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

/// In-memory `orderBy`/`limit` for canonical reads.
fn apply_order_limit(rows: &mut Vec<Map<String, JsonValue>>, order_by: Option<&str>, limit: Option<u64>) {
    if let Some(order_by) = order_by {
        if !order_by.trim().is_empty() {
            let (field, descending) = parse_order_by(order_by);
            rows.sort_by(|a, b| {
                let ordering = json_cmp(
                    a.get(&field).unwrap_or(&JsonValue::Null),
                    b.get(&field).unwrap_or(&JsonValue::Null),
                );
                if descending {
                    ordering.reverse()
                } else {
                    ordering
                }
            });
        }
    }
    if let Some(limit) = limit {
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        rows.truncate(limit);
    }
}

fn canonical_row_json(row: &crate::infrastructure::rtdb::store::StoredRow) -> Map<String, JsonValue> {
    let seq = row.as_snapshot().seq();
    let mut map = match row.as_snapshot().to_row_json() {
        JsonValue::Object(map) => map,
        _ => Map::new(),
    };
    map.insert("_rowVersion".to_string(), json!(seq));
    map
}

/// The `[correlationId, sessionId]` canonical record key.
fn canonical_key_matches(row: &Map<String, JsonValue>, key: &[JsonValue]) -> bool {
    key.len() == 2
        && row.get("correlationId") == Some(&key[0])
        && row.get("sessionId") == Some(&key[1])
}

fn canonical_key_of(row: &Map<String, JsonValue>) -> Vec<JsonValue> {
    vec![
        row.get("correlationId").cloned().unwrap_or(JsonValue::Null),
        row.get("sessionId").cloned().unwrap_or(JsonValue::Null),
    ]
}

/// Bump the declared table's scope version and hand the change to the watch
/// registry (the ST-4 write/delete/feature-change path).
fn bump_and_notify(
    state: &FeatureDataState,
    feature_id: &str,
    table: &str,
    kind: DeclaredChangeKind,
    key: Vec<JsonValue>,
    changed_fields: Vec<String>,
    values: Option<Map<String, JsonValue>>,
) -> Result<u64, Vec<String>> {
    let version = state
        .meta
        .get_table(feature_id, table)
        .map_err(to_errors)?
        .map_or(1, |meta| meta.last_version + 1);
    state
        .meta
        .set_last_version(feature_id, table, version)
        .map_err(to_errors)?;
    let change = DeclaredRowChange {
        feature_id: feature_id.to_string(),
        table: table.to_string(),
        kind,
        key,
        changed_fields,
        values,
        version,
    };
    state.watches.on_declared_change(&change);
    Ok(version.max(0) as u64)
}

/// `feature_data_read`.
pub fn read(
    state: &FeatureDataState,
    args: FeatureDataReadArgs,
) -> Result<FeatureDataReadResult, Vec<String>> {
    match args.r#ref {
        DataTableRef::Feature { feature_id, table } => {
            let declaration = resolve_declaration(state, &feature_id, &table)?;
            // Version BEFORE the rows: the pair is safe for the consumer's
            // version guard (a concurrent change can only be newer).
            let version = state
                .meta
                .get_table(&feature_id, &table)
                .map_err(to_errors)?
                .map_or(0, |meta| meta.last_version.max(0) as u64);
            let where_cols = eq_map(&args.r#where);
            let order_by = validated_order_by(&declaration, args.order_by.as_deref())?;
            let mut rows = state
                .tables
                .query(
                    &feature_id,
                    &table,
                    where_cols.as_ref(),
                    order_by.as_deref(),
                    args.limit,
                )
                .map_err(to_errors)?;
            for row in rows.iter_mut() {
                normalize_row(row, None);
            }
            let retention = resolve_retention(&declaration, &state.app_store).map_err(to_errors)?;
            Ok(FeatureDataReadResult {
                version,
                rows,
                retention: FeatureRetention {
                    max_rows: retention.max_rows,
                    ttl_days: retention.ttl_days,
                },
            })
        }
        DataTableRef::Canonical { table } => {
            let kind = canonical_kind(&table)?;
            let stored = state
                .rtdb_store
                .select_snapshot(kind, "1=1", Vec::new())
                .map_err(to_errors)?;
            let version = stored
                .iter()
                .map(|row| row.as_snapshot().seq())
                .max()
                .unwrap_or(0)
                .max(0) as u64;
            let mut rows: Vec<Map<String, JsonValue>> =
                stored.iter().map(canonical_row_json).collect();
            rows.retain(|row| eq_matches(row, &args.r#where));
            apply_order_limit(&mut rows, args.order_by.as_deref(), args.limit);
            let (retention_days, max_rows) = read_knobs(&state.app_store);
            Ok(FeatureDataReadResult {
                version,
                rows,
                retention: FeatureRetention {
                    max_rows: u64::try_from(max_rows).ok(),
                    ttl_days: u64::try_from(retention_days).ok(),
                },
            })
        }
    }
}

fn declared_snapshot(
    state: &FeatureDataState,
    feature_id: &str,
    table: &str,
    declaration: &FeatureDataTableDeclaration,
    scope: &WatchScopeArg,
) -> Result<Vec<Map<String, JsonValue>>, Vec<String>> {
    let (where_cols, order_by, limit): (
        Option<Map<String, JsonValue>>,
        Option<String>,
        Option<u64>,
    ) = match scope {
        WatchScopeArg::Table => (None, None, None),
        WatchScopeArg::Record { key } => {
            let map = key_map(declaration, key)?;
            (Some(map), None, None)
        }
        WatchScopeArg::Query { r#where } => (eq_map(r#where), None, None),
    };
    let mut rows = state
        .tables
        .query(
            feature_id,
            table,
            where_cols.as_ref(),
            order_by.as_deref(),
            limit,
        )
        .map_err(to_errors)?;
    for row in rows.iter_mut() {
        normalize_row(row, None);
    }
    Ok(rows)
}

/// `(scope version, rows)` for a canonical watch snapshot.
type CanonicalSnapshot = (u64, Vec<Map<String, JsonValue>>);

fn canonical_snapshot(
    state: &FeatureDataState,
    table: &str,
    scope: &WatchScopeArg,
) -> Result<CanonicalSnapshot, Vec<String>> {
    let kind = canonical_kind(table)?;
    let stored = state
        .rtdb_store
        .select_snapshot(kind, "1=1", Vec::new())
        .map_err(to_errors)?;
    let version = stored
        .iter()
        .map(|row| row.as_snapshot().seq())
        .max()
        .unwrap_or(0)
        .max(0) as u64;
    let mut rows: Vec<Map<String, JsonValue>> = stored.iter().map(canonical_row_json).collect();
    match scope {
        WatchScopeArg::Table => {}
        WatchScopeArg::Record { key } => rows.retain(|row| canonical_key_matches(row, key)),
        WatchScopeArg::Query { r#where } => rows.retain(|row| eq_matches(row, r#where)),
    }
    Ok((version, rows))
}

fn to_watch_scope(scope: &WatchScopeArg) -> WatchScope {
    match scope {
        WatchScopeArg::Table => WatchScope::Table,
        WatchScopeArg::Record { key } => WatchScope::Record(key.clone()),
        WatchScopeArg::Query { r#where } => WatchScope::Query(r#where.clone()),
    }
}

/// `feature_data_watch` — register BEFORE the snapshot (R-3.2).
pub fn watch(
    state: &FeatureDataState,
    args: FeatureDataWatchArgs,
) -> Result<FeatureDataWatchResult, Vec<String>> {
    match args.r#ref {
        DataTableRef::Feature { feature_id, table } => {
            let declaration = resolve_declaration(state, &feature_id, &table)?;
            if let WatchScopeArg::Record { key } = &args.scope {
                key_map(&declaration, key)?;
            }
            // Registration FIRST: a change landing before the snapshot below is
            // buffered and delivered — no gap at the boundary.
            let watch_id = state.watches.register(
                WatchTarget::Declared {
                    feature_id: feature_id.clone(),
                    table: table.clone(),
                },
                to_watch_scope(&args.scope),
                args.fields.clone(),
                args.flush_ms,
            );
            let version = state
                .meta
                .get_table(&feature_id, &table)
                .map_err(to_errors)?
                .map_or(0, |meta| meta.last_version.max(0) as u64);
            let rows = if args.initial {
                Some(declared_snapshot(
                    state,
                    &feature_id,
                    &table,
                    &declaration,
                    &args.scope,
                )?)
            } else {
                None
            };
            Ok(FeatureDataWatchResult {
                watch_id,
                version,
                rows,
            })
        }
        DataTableRef::Canonical { table } => {
            canonical_kind(&table)?;
            if let WatchScopeArg::Record { key } = &args.scope {
                if key.len() != 2 {
                    return Err(one_error(format!(
                        "canonical record watches use the [correlationId, sessionId] key (2 values), got {}",
                        key.len()
                    )));
                }
            }
            let watch_id = state.watches.register(
                WatchTarget::Canonical {
                    table: table.clone(),
                },
                to_watch_scope(&args.scope),
                args.fields.clone(),
                args.flush_ms,
            );
            let snapshot = canonical_snapshot(state, &table, &args.scope)?;
            if args.initial {
                let keys: Vec<Vec<JsonValue>> =
                    snapshot.1.iter().map(canonical_key_of).collect();
                state.watches.seed_known(&watch_id, &keys);
            }
            Ok(FeatureDataWatchResult {
                watch_id,
                version: snapshot.0,
                rows: if args.initial { Some(snapshot.1) } else { None },
            })
        }
    }
}

/// `feature_data_unwatch` — per-`watchId`, never affects another watch (R-2.5).
pub fn unwatch(
    state: &FeatureDataState,
    args: FeatureDataUnwatchArgs,
) -> Result<FeatureDataUnwatchResult, Vec<String>> {
    let mut removed = Vec::new();
    for watch_id in &args.watch_ids {
        if state.watches.unwatch(watch_id) {
            removed.push(watch_id.clone());
        }
    }
    Ok(FeatureDataUnwatchResult { watch_ids: removed })
}

/// `feature_data_write` — feature-owned columns only.
pub fn write(
    state: &FeatureDataState,
    args: FeatureDataWriteArgs,
) -> Result<FeatureDataWriteResult, Vec<String>> {
    let declaration = resolve_declaration(state, &args.r#ref.feature_id, &args.r#ref.table)?;
    guard_feature_write(&declaration, &args.set)?;
    if args.set.is_empty() {
        return Err(one_error(format!(
            "feature_data_write for feature '{}' table '{}' carries an empty set",
            args.r#ref.feature_id, args.r#ref.table
        )));
    }
    let where_cols = key_map(&declaration, &args.key)?;
    let updated = state
        .tables
        .update(
            &args.r#ref.feature_id,
            &args.r#ref.table,
            &args.set,
            &where_cols,
        )
        .map_err(to_errors)?;
    if updated == 0 {
        return Err(one_error(format!(
            "record {} does not exist in feature '{}' table '{}'",
            serde_json::to_string(&args.key).unwrap_or_default(),
            args.r#ref.feature_id,
            args.r#ref.table
        )));
    }

    let mut changed: Vec<String> = args.set.keys().cloned().collect();
    changed.sort();
    let values = state
        .tables
        .query(
            &args.r#ref.feature_id,
            &args.r#ref.table,
            Some(&where_cols),
            None,
            Some(1),
        )
        .map_err(to_errors)?
        .into_iter()
        .next();
    bump_and_notify(
        state,
        &args.r#ref.feature_id,
        &args.r#ref.table,
        DeclaredChangeKind::Update,
        args.key,
        changed,
        values,
    )?;
    Ok(FeatureDataWriteResult { updated })
}

/// `feature_data_delete` — tombstone + `remove` notification.
pub fn delete(
    state: &FeatureDataState,
    args: FeatureDataDeleteArgs,
) -> Result<FeatureDataDeleteResult, Vec<String>> {
    let declaration = resolve_declaration(state, &args.r#ref.feature_id, &args.r#ref.table)?;
    let where_cols = key_map(&declaration, &args.key)?;
    let existing = state
        .tables
        .query(
            &args.r#ref.feature_id,
            &args.r#ref.table,
            Some(&where_cols),
            None,
            Some(1),
        )
        .map_err(to_errors)?
        .into_iter()
        .next();

    // Always tombstone: a deleted key is never re-projected (ST-7's guard).
    let key_json = tombstone_key(&args.key).map_err(to_errors)?;
    state
        .meta
        .put_tombstone(&Tombstone {
            feature_id: args.r#ref.feature_id.clone(),
            table_name: args.r#ref.table.clone(),
            key_json,
            deleted_at: crate::infrastructure::rtdb::project::rfc3339_now(),
        })
        .map_err(to_errors)?;

    let deleted = state
        .tables
        .delete(
            &args.r#ref.feature_id,
            &args.r#ref.table,
            &where_cols,
        )
        .map_err(to_errors)?;

    let removed = deleted > 0 && existing.is_some();
    if removed {
        let mut changed: Vec<String> = existing
            .as_ref()
            .map(|row| {
                row.keys()
                    .filter(|name| !is_reserved_column(name))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        changed.sort();
        bump_and_notify(
            state,
            &args.r#ref.feature_id,
            &args.r#ref.table,
            DeclaredChangeKind::Remove,
            args.key,
            changed,
            None,
        )?;
    }
    Ok(FeatureDataDeleteResult { deleted: removed })
}

/// `feature_data_declare` — idempotent materialization.
pub fn declare(
    state: &FeatureDataState,
    args: FeatureDataDeclareArgs,
) -> Result<FeatureDataDeclareResult, Vec<String>> {
    let declarations = FeatureDataDeclaration::parse_slice(args.declarations)?;
    let materialized = state.registry.declare_many(&declarations)?;
    Ok(FeatureDataDeclareResult { materialized })
}

// ── Tauri command wrappers ──────────────────────────────────────────────────

#[tauri::command]
pub fn feature_data_read(
    state: tauri::State<'_, Arc<FeatureDataState>>,
    args: FeatureDataReadArgs,
) -> Result<FeatureDataReadResult, Vec<String>> {
    read(state.inner(), args)
}

#[tauri::command]
pub fn feature_data_watch(
    state: tauri::State<'_, Arc<FeatureDataState>>,
    args: FeatureDataWatchArgs,
) -> Result<FeatureDataWatchResult, Vec<String>> {
    watch(state.inner(), args)
}

#[tauri::command]
pub fn feature_data_unwatch(
    state: tauri::State<'_, Arc<FeatureDataState>>,
    args: FeatureDataUnwatchArgs,
) -> Result<FeatureDataUnwatchResult, Vec<String>> {
    unwatch(state.inner(), args)
}

#[tauri::command]
pub fn feature_data_write(
    state: tauri::State<'_, Arc<FeatureDataState>>,
    args: FeatureDataWriteArgs,
) -> Result<FeatureDataWriteResult, Vec<String>> {
    write(state.inner(), args)
}

#[tauri::command]
pub fn feature_data_delete(
    state: tauri::State<'_, Arc<FeatureDataState>>,
    args: FeatureDataDeleteArgs,
) -> Result<FeatureDataDeleteResult, Vec<String>> {
    delete(state.inner(), args)
}

#[tauri::command]
pub fn feature_data_declare(
    state: tauri::State<'_, Arc<FeatureDataState>>,
    args: FeatureDataDeclareArgs,
) -> Result<FeatureDataDeclareResult, Vec<String>> {
    let result = declare(state.inner(), args)?;
    // First run persists + materializes + backfills: kick the one-time
    // read-only projection in the background (reads never block on it).
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        backfill::run_backfill(
            state.data_dir.clone(),
            state.meta.clone(),
            state.engine.clone(),
            state.rtdb_store.clone(),
        )
        .await;
    });
    Ok(result)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use crate::infrastructure::feature_data::declaration::{
        ActivitySource, ColumnOwner, DataSource, DeclaredColumn, DeclaredColumnType, FieldMapping,
        RowProjection, RowProjectionKind,
    };
    use crate::infrastructure::feature_data::envelope::{
        FeatureChangeKind, FeatureDeliveryBatch, FeatureRowNotification,
    };
    use crate::infrastructure::feature_data::watch::NotificationSink;
    use crate::infrastructure::rtdb::commands::IngestRow;
    use crate::infrastructure::rtdb::rows::{ChatRow, RowState};

    #[derive(Default)]
    pub(crate) struct Collector {
        pub(crate) batches: Mutex<Vec<FeatureDeliveryBatch>>,
    }

    impl Collector {
        pub(crate) fn notifications(&self) -> Vec<FeatureRowNotification> {
            self.batches
                .lock()
                .unwrap()
                .iter()
                .flat_map(|batch| batch.feature_batch.clone())
                .collect()
        }
    }

    impl NotificationSink for Collector {
        fn emit(&self, notifications: &[FeatureRowNotification]) {
            self.batches
                .lock()
                .unwrap()
                .push(FeatureDeliveryBatch::new(notifications.to_vec()));
        }
    }

    pub(crate) struct Harness {
        pub(crate) _dir: tempfile::TempDir,
        pub(crate) state: FeatureDataState,
        pub(crate) collector: Arc<Collector>,
    }

    pub(crate) fn column(
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

    pub(crate) fn sessions_declaration() -> FeatureDataDeclaration {
        FeatureDataDeclaration {
            feature_id: "mission-monitor".to_string(),
            declaration_revision: "mm.sessions.v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "sessions".to_string(),
                primary_key: vec!["sessionId".to_string()],
                columns: vec![
                    column("sessionId", DeclaredColumnType::Text, false, ColumnOwner::Backend),
                    column("chatRowCount", DeclaredColumnType::Integer, false, ColumnOwner::Backend),
                    column("customName", DeclaredColumnType::Text, true, ColumnOwner::Feature),
                ],
                source: Some(DataSource::Row(RowProjection {
                    kind: RowProjectionKind::Row,
                    from: ActivitySource::Chat,
                    r#where: None,
                    select: BTreeMap::from([
                        (
                            "sessionId".to_string(),
                            FieldMapping::Field {
                                field: "sessionId".to_string(),
                            },
                        ),
                        (
                            "chatRowCount".to_string(),
                            FieldMapping::Literal {
                                literal: json!(1),
                            },
                        ),
                    ]),
                })),
                retention: Some(crate::infrastructure::feature_data::declaration::Retention {
                    max_rows: Some(500),
                    ttl_days: None,
                }),
            }],
        }
    }

    pub(crate) fn declaration_json() -> JsonValue {
        serde_json::to_value(sessions_declaration()).unwrap()
    }

    pub(crate) fn chat_row(session_id: &str, correlation_id: &str, seq: i64) -> IngestRow {
        IngestRow::Chat(ChatRow {
            session_id: session_id.to_string(),
            correlation_id: correlation_id.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-09-18T00:00:00+00:00".to_string(),
            state: RowState::Response,
            user_message: None,
            agent_reply: Some("hi".to_string()),
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cost_usd: None,
            model: None,
            parent_session_id: None,
            composited_child_session_id: None,
            raw_json: "{}".to_string(),
        })
    }

    /// Build a state over a temp dir with `sessions` declared + the engine's
    /// declared observer wired to the watch registry.
    pub(crate) fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let rtdb_store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).unwrap());
        rtdb_store.ensure_schema().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let tables = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        let app_store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());
        let registry = Arc::new(DeclarationRegistry::new(meta.clone(), tables.clone()));
        registry.declare(&sessions_declaration()).unwrap();
        let engine = Arc::new(
            ProjectionEngine::new(dir.path().to_path_buf(), meta.clone(), tables.clone()).unwrap(),
        );
        let collector = Arc::new(Collector::default());
        let watches = Arc::new(WatchRegistry::new(collector.clone()));
        engine.set_declared_row_observer(watches.clone());
        let state = FeatureDataState {
            data_dir: dir.path().to_path_buf(),
            meta,
            tables,
            app_store,
            registry,
            engine,
            watches,
            rtdb_store,
        };
        Harness {
            _dir: dir,
            state,
            collector,
        }
    }

    fn read_args(ref_: DataTableRef) -> FeatureDataReadArgs {
        FeatureDataReadArgs {
            r#ref: ref_,
            r#where: Vec::new(),
            order_by: None,
            limit: None,
        }
    }

    fn declared_ref() -> DataTableRef {
        DataTableRef::Feature {
            feature_id: "mission-monitor".to_string(),
            table: "sessions".to_string(),
        }
    }

    // ── Read ────────────────────────────────────────────────────────────────

    #[test]
    fn read_reports_version_rows_and_retention() {
        let h = harness();
        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 1), &[]).unwrap();
        h.state.engine.project(&chat_row("ses_2", "ses_2_1", 1), &[]).unwrap();

        let result = read(&h.state, read_args(declared_ref())).unwrap();
        assert_eq!(result.rows.len(), 2);
        assert!(result.version >= 2, "version tracks the declared table");
        assert_eq!(
            result.retention,
            FeatureRetention {
                max_rows: Some(500),
                ttl_days: None
            }
        );
        for row in &result.rows {
            assert!(
                row.get("_rowVersion").is_some(),
                "read rows carry _rowVersion: {row:?}"
            );
            assert!(row.get("_row_version").is_none(), "reserved renamed camelCase");
        }
    }

    #[test]
    fn read_rejects_an_undeclared_table() {
        let h = harness();
        let errors = read(
            &h.state,
            read_args(DataTableRef::Feature {
                feature_id: "mission-monitor".to_string(),
                table: "ghost".to_string(),
            }),
        )
        .unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("has not declared table 'ghost'"), "{errors:?}");
    }

    #[test]
    fn read_supports_canonical_refs_with_the_rtdb_retention() {
        let h = harness();
        h.state
            .rtdb_store
            .upsert_chat_rows(&[ChatRow {
                session_id: "ses_1".to_string(),
                correlation_id: "ses_1_1".to_string(),
                seq: 4,
                started_at_ns: None,
                ended_at_ns: None,
                updated_at: "2026-09-18T00:00:00+00:00".to_string(),
                state: RowState::Response,
                user_message: None,
                agent_reply: Some("reply".to_string()),
                prompt_tokens: None,
                completion_tokens: None,
                cache_read_tokens: None,
                cost_usd: None,
                model: None,
                parent_session_id: None,
                composited_child_session_id: None,
                raw_json: "{}".to_string(),
            }])
            .unwrap();

        let result = read(
            &h.state,
            read_args(DataTableRef::Canonical {
                table: "chat".to_string(),
            }),
        )
        .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.version, 4, "canonical scope version is the row seq");
        assert_eq!(result.rows[0].get("_rowVersion"), Some(&json!(4)));
        assert_eq!(result.retention.max_rows, Some(100_000));
        assert_eq!(result.retention.ttl_days, Some(7));
    }

    #[test]
    fn read_rejects_an_unknown_canonical_table() {
        let h = harness();
        let errors = read(
            &h.state,
            read_args(DataTableRef::Canonical {
                table: "bogus".to_string(),
            }),
        )
        .unwrap_err();
        assert!(errors[0].contains("not one of chat | toolUse | agentSession"), "{errors:?}");
    }

    #[test]
    fn read_filters_by_where() {
        let h = harness();
        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 1), &[]).unwrap();
        h.state.engine.project(&chat_row("ses_2", "ses_2_1", 1), &[]).unwrap();
        let mut args = read_args(declared_ref());
        args.r#where = vec![EqFilter {
            field: "sessionId".to_string(),
            eq: json!("ses_2"),
        }];
        let result = read(&h.state, args).unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].get("sessionId"), Some(&json!("ses_2")));
    }

    // ── Watch ───────────────────────────────────────────────────────────────

    #[test]
    fn watch_initial_returns_the_snapshot_and_registers() {
        let h = harness();
        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 1), &[]).unwrap();
        let result = watch(
            &h.state,
            FeatureDataWatchArgs {
                r#ref: declared_ref(),
                scope: WatchScopeArg::Table,
                fields: None,
                initial: true,
                flush_ms: Some(0),
            },
        )
        .unwrap();
        assert_eq!(result.rows.as_ref().unwrap().len(), 1);
        assert!(result.version >= 1);
        assert!(h.state.watches.is_watching(&result.watch_id));

        // A later change is delivered under the returned watch id.
        h.state.engine.project(&chat_row("ses_2", "ses_2_1", 1), &[]).unwrap();
        assert_eq!(h.state.watches.flush_due(), 1);
        let notifications = h.collector.notifications();
        assert_eq!(notifications[0].watch_id, result.watch_id);
    }

    #[test]
    fn watch_without_initial_omits_rows() {
        let h = harness();
        let result = watch(
            &h.state,
            FeatureDataWatchArgs {
                r#ref: declared_ref(),
                scope: WatchScopeArg::Table,
                fields: None,
                initial: false,
                flush_ms: None,
            },
        )
        .unwrap();
        assert!(result.rows.is_none());
    }

    #[test]
    fn watch_rejects_a_record_scope_with_the_wrong_key_arity() {
        let h = harness();
        let errors = watch(
            &h.state,
            FeatureDataWatchArgs {
                r#ref: declared_ref(),
                scope: WatchScopeArg::Record {
                    key: vec![json!("a"), json!("b")],
                },
                fields: None,
                initial: false,
                flush_ms: None,
            },
        )
        .unwrap_err();
        assert!(errors[0].contains("primary-key value(s)"), "{errors:?}");
        assert_eq!(h.state.watches.watch_count(), 0, "nothing registered");
    }

    #[test]
    fn unwatch_is_isolated_and_idempotent() {
        let h = harness();
        let kept = watch(
            &h.state,
            FeatureDataWatchArgs {
                r#ref: declared_ref(),
                scope: WatchScopeArg::Table,
                fields: None,
                initial: false,
                flush_ms: Some(0),
            },
        )
        .unwrap()
        .watch_id;
        let dropped = watch(
            &h.state,
            FeatureDataWatchArgs {
                r#ref: declared_ref(),
                scope: WatchScopeArg::Table,
                fields: None,
                initial: false,
                flush_ms: Some(0),
            },
        )
        .unwrap()
        .watch_id;

        let result = unwatch(
            &h.state,
            FeatureDataUnwatchArgs {
                watch_ids: vec![dropped.clone(), dropped.clone(), "ghost".to_string()],
            },
        )
        .unwrap();
        assert_eq!(result.watch_ids, vec![dropped]);

        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 1), &[]).unwrap();
        assert_eq!(h.state.watches.flush_due(), 1);
        assert_eq!(h.collector.notifications().len(), 1);
        assert_eq!(h.collector.notifications()[0].watch_id, kept);
    }

    // ── Write / delete ──────────────────────────────────────────────────────

    fn declared_rows(state: &FeatureDataState) -> Vec<Map<String, JsonValue>> {
        state
            .tables
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap()
    }

    #[test]
    fn write_guards_backend_owned_reserved_and_undeclared_columns() {
        let h = harness();
        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 1), &[]).unwrap();

        let errors = write(
            &h.state,
            FeatureDataWriteArgs {
                r#ref: FeatureTableRef {
                    feature_id: "mission-monitor".to_string(),
                    table: "sessions".to_string(),
                },
                key: vec![json!("ses_1")],
                set: serde_json::json!({
                    "chatRowCount": 99,
                    "_row_version": 9,
                    "ghost": true
                })
                .as_object()
                .unwrap()
                .clone(),
            },
        )
        .unwrap_err();
        assert_eq!(errors.len(), 3, "{errors:?}");
        assert!(errors.iter().any(|e| e.contains("backend-owned")));
        assert!(errors.iter().any(|e| e.contains("backend-managed")));
        assert!(errors.iter().any(|e| e.contains("not declared")));
        // Nothing was written.
        assert_eq!(declared_rows(&h.state)[0].get("chatRowCount"), Some(&json!(1)));
    }

    #[test]
    fn write_updates_a_feature_owned_column_and_notifies() {
        let h = harness();
        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 1), &[]).unwrap();
        watch(
            &h.state,
            FeatureDataWatchArgs {
                r#ref: declared_ref(),
                scope: WatchScopeArg::Table,
                fields: None,
                initial: false,
                flush_ms: Some(0),
            },
        )
        .unwrap();
        let result = write(
            &h.state,
            FeatureDataWriteArgs {
                r#ref: FeatureTableRef {
                    feature_id: "mission-monitor".to_string(),
                    table: "sessions".to_string(),
                },
                key: vec![json!("ses_1")],
                set: serde_json::json!({ "customName": "Renamed" })
                    .as_object()
                    .unwrap()
                    .clone(),
            },
        )
        .unwrap();
        assert_eq!(result.updated, 1);
        assert_eq!(
            declared_rows(&h.state)[0].get("customName"),
            Some(&json!("Renamed"))
        );
        assert_eq!(h.state.watches.flush_due(), 1);
        let notification = &h.collector.notifications()[0];
        assert_eq!(notification.kind, FeatureChangeKind::Update);
        assert_eq!(notification.changed_fields, vec!["customName"]);
    }

    #[test]
    fn write_rejects_an_unknown_record() {
        let h = harness();
        let errors = write(
            &h.state,
            FeatureDataWriteArgs {
                r#ref: FeatureTableRef {
                    feature_id: "mission-monitor".to_string(),
                    table: "sessions".to_string(),
                },
                key: vec![json!("nope")],
                set: serde_json::json!({ "customName": "x" })
                    .as_object()
                    .unwrap()
                    .clone(),
            },
        )
        .unwrap_err();
        assert!(errors[0].contains("does not exist"), "{errors:?}");
    }

    #[test]
    fn delete_tombstones_emits_remove_and_suppresses_re_projection() {
        let h = harness();
        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 1), &[]).unwrap();
        watch(
            &h.state,
            FeatureDataWatchArgs {
                r#ref: declared_ref(),
                scope: WatchScopeArg::Table,
                fields: None,
                initial: false,
                flush_ms: Some(0),
            },
        )
        .unwrap();
        let result = delete(
            &h.state,
            FeatureDataDeleteArgs {
                r#ref: FeatureTableRef {
                    feature_id: "mission-monitor".to_string(),
                    table: "sessions".to_string(),
                },
                key: vec![json!("ses_1")],
            },
        )
        .unwrap();
        assert!(result.deleted);
        assert!(declared_rows(&h.state).is_empty());

        assert_eq!(h.state.watches.flush_due(), 1);
        let notification = &h.collector.notifications()[0];
        assert_eq!(notification.kind, FeatureChangeKind::Remove);
        assert!(notification.values.is_none());
        assert!(notification.changed_fields.contains(&"sessionId".to_string()));

        // A tombstoned key is never re-projected.
        h.state.engine.project(&chat_row("ses_1", "ses_1_1", 2), &[]).unwrap();
        assert!(declared_rows(&h.state).is_empty(), "tombstone must suppress resurrection");

        // Deleting again is a no-op that still leaves the tombstone.
        let again = delete(
            &h.state,
            FeatureDataDeleteArgs {
                r#ref: FeatureTableRef {
                    feature_id: "mission-monitor".to_string(),
                    table: "sessions".to_string(),
                },
                key: vec![json!("ses_1")],
            },
        )
        .unwrap();
        assert!(!again.deleted);
    }

    // ── Declare ─────────────────────────────────────────────────────────────

    #[test]
    fn declare_is_idempotent() {
        let h = harness();
        let first = declare(
            &h.state,
            FeatureDataDeclareArgs {
                declarations: vec![declaration_json()],
            },
        )
        .unwrap();
        assert_eq!(first.materialized.len(), 1);
        assert!(!first.materialized[0].created, "harness already declared it");

        let second = declare(
            &h.state,
            FeatureDataDeclareArgs {
                declarations: vec![declaration_json()],
            },
        )
        .unwrap();
        assert_eq!(second.materialized.len(), 1);
        assert!(!second.materialized[0].created, "re-declare is a no-op");
    }

    #[test]
    fn declare_rejects_an_invalid_declaration_with_named_errors() {
        let h = harness();
        let errors = declare(
            &h.state,
            FeatureDataDeclareArgs {
                declarations: vec![json!({
                    "featureId": "f",
                    "declarationRevision": "v1",
                    "tables": [{
                        "name": "t",
                        "primaryKey": ["id"],
                        "columns": [{ "name": "id", "type": "NUMBER", "owner": "backend" }]
                    }]
                })],
            },
        )
        .unwrap_err();
        assert!(errors[0].contains("unknown type 'NUMBER'"), "{errors:?}");
    }

    #[test]
    fn cross_feature_read_is_refused() {
        let h = harness();
        let errors = read(
            &h.state,
            read_args(DataTableRef::Feature {
                feature_id: "other-feature".to_string(),
                table: "sessions".to_string(),
            }),
        )
        .unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("has not declared table"), "{errors:?}");
    }
}
