//! Application-data IPC surface (Spec #2896, ST-4): read / watch / unwatch /
//! write / delete / declare.
//!
//! Every command rejects with a HARD NAMED error (`Vec<String>` / `string[]`,
//! the `subscribe_events` precedent) and NEVER silently swallows a failure.
//!
//! Wire transport note: each command takes ONE struct argument named `args`, so
//! the frontend invokes e.g. `invoke('application_data_read', { args: { ref, where,
//! orderBy, limit } })`. The `args` object's fields are exactly the contract
//! (b)/(c) shapes.
//!
//! The pure command bodies ([`read`], [`watch`], [`unwatch`], [`write`],
//! [`delete`], [`declare`]) are free functions over [`ApplicationDataState`] so
//! they are unit-testable without a Tauri runtime; the `#[tauri::command]`
//! wrappers are thin.

use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as JsonValue};

use crate::infrastructure::application_data::backfill;
use crate::infrastructure::application_data::declaration::{
    is_reserved_column, ApplicationDataDeclaration, ApplicationDataTableDeclaration,
};
use crate::infrastructure::application_data::lifecycle::{resolve_retention, tombstone_key};
use crate::infrastructure::application_data::projection::{
    diff_fields, DeclaredChangeKind, DeclaredRowChange, ProjectionEngine,
};
use crate::infrastructure::application_data::registry::DeclarationRegistry;
use crate::infrastructure::application_data::store::{guard_application_write, ApplicationDataStore, Tombstone};
use crate::infrastructure::application_data::watch::{
    EqFilter, WatchRegistry, WatchScope, WatchTarget,
};
use crate::infrastructure::rtdb::cache::read_knobs;
use crate::infrastructure::rtdb::store::{RowKind, RtdbStore};
use crate::infrastructure::storage::application_store::ApplicationStore;
use crate::infrastructure::storage::AppStore;

// ── Shared state ────────────────────────────────────────────────────────────

/// Everything the application-data commands need, managed once in `lib.rs`.
pub struct ApplicationDataState {
    /// App data dir (backfill's read-only canonical connection).
    pub data_dir: PathBuf,
    /// `feature_data_tables` / `feature_data_tombstones` metadata.
    pub meta: Arc<ApplicationDataStore>,
    /// The application-scoped typed-column table store (declared table DML).
    pub tables: Arc<ApplicationStore>,
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
    /// A declared (application-owned) table.
    Application {
        #[serde(rename = "applicationId")]
        feature_id: String,
        table: String,
    },
    /// A canonical RTDB table: `chat` | `toolUse` | `agentSession`.
    Canonical { table: String },
}

/// A declared-only table ref (write/delete).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationTableRef {
    #[serde(rename = "applicationId")]
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

/// `application_data_read` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataReadArgs {
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
pub struct ApplicationRetention {
    pub max_rows: Option<u64>,
    pub ttl_days: Option<u64>,
}

/// `application_data_read` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataReadResult {
    pub version: u64,
    pub rows: Vec<Map<String, JsonValue>>,
    pub retention: ApplicationRetention,
}

/// `application_data_watch` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataWatchArgs {
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

/// `application_data_watch` result (`rows` only when `initial: true`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataWatchResult {
    pub watch_id: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Map<String, JsonValue>>>,
}

/// `application_data_unwatch` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataUnwatchArgs {
    pub watch_ids: Vec<String>,
}

/// `application_data_unwatch` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataUnwatchResult {
    pub watch_ids: Vec<String>,
}

/// `application_data_write` args (application-owned columns only).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataWriteArgs {
    #[serde(rename = "ref")]
    pub r#ref: ApplicationTableRef,
    pub key: Vec<JsonValue>,
    pub set: Map<String, JsonValue>,
}

/// `application_data_write` result.
///
/// `updated` is the number of rows whose values actually changed: `1` for a
/// real value delta, `0` when the record existed but every set value already
/// equalled the stored value (an identical write is a silent no-op — no
/// UPDATE, no version bump, no notification).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataWriteResult {
    pub updated: u64,
}

/// `application_data_delete` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataDeleteArgs {
    #[serde(rename = "ref")]
    pub r#ref: ApplicationTableRef,
    pub key: Vec<JsonValue>,
}

/// `application_data_delete` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataDeleteResult {
    pub deleted: bool,
}

/// `application_data_declare` args.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataDeclareArgs {
    pub declarations: Vec<JsonValue>,
}

/// `application_data_declare` result.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDataDeclareResult {
    pub materialized: Vec<crate::infrastructure::application_data::registry::MaterializedTable>,
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
    state: &ApplicationDataState,
    feature_id: &str,
    table: &str,
) -> Result<ApplicationDataTableDeclaration, Vec<String>> {
    match state.registry.persisted_table(feature_id, table) {
        Ok(Some(persisted)) => Ok(persisted.declaration),
        Ok(None) => Err(one_error(format!(
            "application '{feature_id}' has not declared table '{table}' \
             (call application_data_declare first)"
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

/// `[{ field, eq }]` → a `ApplicationStore::query` WHERE map.
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

/// Primary-key values in declaration order → a `ApplicationStore` WHERE map.
fn key_map(
    declaration: &ApplicationDataTableDeclaration,
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
    declaration: &ApplicationDataTableDeclaration,
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
/// registry (the ST-4 write/delete/application-change path).
fn bump_and_notify(
    state: &ApplicationDataState,
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

/// `application_data_read`.
pub async fn read(
    state: &ApplicationDataState,
    args: ApplicationDataReadArgs,
) -> Result<ApplicationDataReadResult, Vec<String>> {
    match args.r#ref {
        DataTableRef::Application { feature_id, table } => {
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
            Ok(ApplicationDataReadResult {
                version,
                rows,
                retention: ApplicationRetention {
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
                .await
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
            Ok(ApplicationDataReadResult {
                version,
                rows,
                retention: ApplicationRetention {
                    max_rows: u64::try_from(max_rows).ok(),
                    ttl_days: u64::try_from(retention_days).ok(),
                },
            })
        }
    }
}

fn declared_snapshot(
    state: &ApplicationDataState,
    feature_id: &str,
    table: &str,
    declaration: &ApplicationDataTableDeclaration,
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

async fn canonical_snapshot(
    state: &ApplicationDataState,
    table: &str,
    scope: &WatchScopeArg,
) -> Result<CanonicalSnapshot, Vec<String>> {
    let kind = canonical_kind(table)?;
    let stored = state
        .rtdb_store
        .select_snapshot(kind, "1=1", Vec::new())
        .await
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

/// `application_data_watch` — register BEFORE the snapshot (R-3.2).
pub async fn watch(
    state: &ApplicationDataState,
    args: ApplicationDataWatchArgs,
) -> Result<ApplicationDataWatchResult, Vec<String>> {
    match args.r#ref {
        DataTableRef::Application { feature_id, table } => {
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
            Ok(ApplicationDataWatchResult {
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
            let snapshot = canonical_snapshot(state, &table, &args.scope).await?;
            if args.initial {
                let keys: Vec<Vec<JsonValue>> =
                    snapshot.1.iter().map(canonical_key_of).collect();
                state.watches.seed_known(&watch_id, &keys);
            }
            Ok(ApplicationDataWatchResult {
                watch_id,
                version: snapshot.0,
                rows: if args.initial { Some(snapshot.1) } else { None },
            })
        }
    }
}

/// `application_data_unwatch` — per-`watchId`, never affects another watch (R-2.5).
pub fn unwatch(
    state: &ApplicationDataState,
    args: ApplicationDataUnwatchArgs,
) -> Result<ApplicationDataUnwatchResult, Vec<String>> {
    let mut removed = Vec::new();
    for watch_id in &args.watch_ids {
        if state.watches.unwatch(watch_id) {
            removed.push(watch_id.clone());
        }
    }
    Ok(ApplicationDataUnwatchResult { watch_ids: removed })
}

/// `application_data_write` — application-owned columns only.
pub fn write(
    state: &ApplicationDataState,
    args: ApplicationDataWriteArgs,
) -> Result<ApplicationDataWriteResult, Vec<String>> {
    let declaration = resolve_declaration(state, &args.r#ref.feature_id, &args.r#ref.table)?;
    guard_application_write(&declaration, &args.set)?;
    if args.set.is_empty() {
        return Err(one_error(format!(
            "application_data_write for application '{}' table '{}' carries an empty set",
            args.r#ref.feature_id, args.r#ref.table
        )));
    }
    let where_cols = key_map(&declaration, &args.key)?;
    // Read BEFORE the UPDATE (as `delete()` does): existence and the value
    // delta are both decided against the stored row, not against SQLite's
    // matched-row count (an identical UPDATE still matches a row).
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
    let Some(existing) = existing else {
        return Err(record_missing_error(&args));
    };

    // The ONE diff rule, shared with the projection path — a set key whose
    // value equals the stored value is not a change.
    let changed = diff_fields(&existing, &args.set);
    if changed.is_empty() {
        // No value delta: no UPDATE, no `set_last_version`, no notification.
        return Ok(ApplicationDataWriteResult { updated: 0 });
    }

    // Maintain the backend-managed per-row bookkeeping exactly as the
    // projection path does (`upsert_declared_row`): a real change advances the
    // row version and stamps `_updated_at`.
    let next_row_version = existing
        .get("_row_version")
        .and_then(JsonValue::as_i64)
        .unwrap_or(0)
        + 1;
    let mut write_set = args.set.clone();
    write_set.insert("_row_version".to_string(), json!(next_row_version));
    write_set.insert(
        "_updated_at".to_string(),
        json!(crate::infrastructure::rtdb::project::rfc3339_now()),
    );

    let updated = state
        .tables
        .update(
            &args.r#ref.feature_id,
            &args.r#ref.table,
            &write_set,
            &where_cols,
        )
        .map_err(to_errors)?;
    if updated == 0 {
        return Err(record_missing_error(&args));
    }

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
    Ok(ApplicationDataWriteResult { updated })
}

/// The hard named error for a `application_data_write` whose record is absent.
fn record_missing_error(args: &ApplicationDataWriteArgs) -> Vec<String> {
    one_error(format!(
        "record {} does not exist in application '{}' table '{}'",
        serde_json::to_string(&args.key).unwrap_or_default(),
        args.r#ref.feature_id,
        args.r#ref.table
    ))
}

/// `application_data_delete` — tombstone + `remove` notification.
pub fn delete(
    state: &ApplicationDataState,
    args: ApplicationDataDeleteArgs,
) -> Result<ApplicationDataDeleteResult, Vec<String>> {
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
    Ok(ApplicationDataDeleteResult { deleted: removed })
}

/// `application_data_declare` — idempotent materialization.
pub fn declare(
    state: &ApplicationDataState,
    args: ApplicationDataDeclareArgs,
) -> Result<ApplicationDataDeclareResult, Vec<String>> {
    let declarations = ApplicationDataDeclaration::parse_slice(args.declarations)?;
    let materialized = state.registry.declare_many(&declarations)?;
    Ok(ApplicationDataDeclareResult { materialized })
}

// ── Tauri command wrappers ──────────────────────────────────────────────────

#[tauri::command]
pub async fn application_data_read(
    state: tauri::State<'_, Arc<ApplicationDataState>>,
    args: ApplicationDataReadArgs,
) -> Result<ApplicationDataReadResult, Vec<String>> {
    read(state.inner(), args).await
}

#[tauri::command]
pub async fn application_data_watch(
    state: tauri::State<'_, Arc<ApplicationDataState>>,
    args: ApplicationDataWatchArgs,
) -> Result<ApplicationDataWatchResult, Vec<String>> {
    watch(state.inner(), args).await
}

#[tauri::command]
pub fn application_data_unwatch(
    state: tauri::State<'_, Arc<ApplicationDataState>>,
    args: ApplicationDataUnwatchArgs,
) -> Result<ApplicationDataUnwatchResult, Vec<String>> {
    unwatch(state.inner(), args)
}

#[tauri::command]
pub async fn application_data_write(
    state: tauri::State<'_, Arc<ApplicationDataState>>,
    args: ApplicationDataWriteArgs,
) -> Result<ApplicationDataWriteResult, Vec<String>> {
    write(state.inner(), args)
}

#[tauri::command]
pub async fn application_data_delete(
    state: tauri::State<'_, Arc<ApplicationDataState>>,
    args: ApplicationDataDeleteArgs,
) -> Result<ApplicationDataDeleteResult, Vec<String>> {
    delete(state.inner(), args)
}

#[tauri::command]
pub async fn application_data_declare(
    state: tauri::State<'_, Arc<ApplicationDataState>>,
    args: ApplicationDataDeclareArgs,
) -> Result<ApplicationDataDeclareResult, Vec<String>> {
    let result = declare(state.inner(), args)?;
    // First run persists + materializes + backfills: kick the one-time
    // read-only projection in the background (reads never block on it).
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        backfill::run_backfill(
            state.meta.clone(),
            state.engine.clone(),
            state.rtdb_store.clone(),
        )
        .await;
    });
    Ok(result)
}

// ── Tests ───────────────────────────────────────────────────────────────────
