//! Declared-table retention + tombstone lifecycle (Spec #2896, ST-7,
//! R-3.4/R-4.4/R-4.6).
//!
//! Two responsibilities:
//!
//! 1. **Retention** — [`prune_declared_tables`] bounds every persisted declared
//!    table by its declared `retention: { maxRows?, ttlDays? }`, falling back to
//!    the `AppStore` knobs `application_data.default_max_rows` /
//!    `application_data.default_retention_days` and then to the contract defaults
//!    [`DEFAULT_MAX_ROWS`] / [`DEFAULT_RETENTION_DAYS`]. Eviction is
//!    **oldest-first by `latestAt`** (the `_updated_at` reserved column for a
//!    table that does not declare `latestAt`), bumps the declared table's
//!    version **once per evicted record** and RETURNS the evicted records as
//!    [`DeclaredRowChange`] `kind: Remove` entries so ST-4's wiring can turn
//!    them into `remove` notifications. This function **never emits a
//!    notification itself**.
//!
//!    **Retention is idle when `maxRows` is null** (binding contract): the cap
//!    is the master switch, so an explicit `maxRows: null` normalizes the whole
//!    bound to unbounded ([`EffectiveRetention`] `{ None, None }`). A declaration
//!    that omits `retention` entirely gets the AppStore knob / contract default.
//!
//! 2. **Tombstone-aware projection** — [`is_tombstoned`] is the reusable guard
//!    for a key deleted by `application_data_delete`. It serializes the key with the
//!    SAME wire format the projection engine's tombstone lookup uses
//!    (`serde_json::to_string(&Vec<JsonValue>)`, the PK values in declaration
//!    order), via [`tombstone_key`]. ST-3's projection path and ST-4's write
//!    path compose it so a tombstoned key is never re-created.
//!
//! Retention is a maintenance operation: it runs at startup and on the existing
//! 60-minute prune cycle through ST-4's `lib.rs` wiring. It never touches a table
//! that has no persisted declaration (only `feature_data_tables` drives it) and
//! never touches the canonical `*_rows` tables.

use anyhow::{anyhow, Result};
use serde_json::{Map, Value as JsonValue};

use crate::infrastructure::rtdb::project::rfc3339_now;
use crate::infrastructure::storage::application_store::ApplicationStore;
use crate::infrastructure::storage::AppStore;

use super::declaration::{is_reserved_column, ApplicationDataTableDeclaration};
use super::projection::{DeclaredChangeKind, DeclaredRowChange};
use super::store::{ApplicationDataStore, TableMeta};

/// Contract default row cap for a declared table (non-behavioral requirement).
pub const DEFAULT_MAX_ROWS: u64 = 10_000;
/// Contract default TTL for a declared table (non-behavioral requirement).
pub const DEFAULT_RETENTION_DAYS: u64 = 30;

/// `AppStore` knob overriding [`DEFAULT_MAX_ROWS`].
pub const KNOB_DEFAULT_MAX_ROWS: &str = "application_data.default_max_rows";
/// `AppStore` knob overriding [`DEFAULT_RETENTION_DAYS`].
pub const KNOB_DEFAULT_RETENTION_DAYS: &str = "application_data.default_retention_days";

/// The oldest-first eviction order column used when a declared table has it.
pub const RETENTION_ORDER_COLUMN: &str = "latestAt";
/// Fallback order column — backend-managed, always physically present.
const UPDATED_AT_COLUMN: &str = "_updated_at";

// ── Tombstone guard ─────────────────────────────────────────────────────────

/// The tombstone key wire format: the primary-key values in declaration order,
/// JSON-serialized. This is byte-identical to the projection engine's tombstone
/// lookup (`serde_json::to_string(&Vec<JsonValue>)`) so the guard and the
/// projection path can never disagree.
pub fn tombstone_key(key: &[JsonValue]) -> Result<String> {
    Ok(serde_json::to_string(key)?)
}

/// The reusable tombstone-aware projection guard: `true` iff `key` was deleted
/// by `application_data_delete` and must never be re-created. ST-3's projection path
/// and ST-4's write path compose it.
pub fn is_tombstoned(
    meta: &ApplicationDataStore,
    feature_id: &str,
    table_name: &str,
    key: &[JsonValue],
) -> Result<bool> {
    meta.is_tombstoned(feature_id, table_name, &tombstone_key(key)?)
}

// ── Retention resolution ────────────────────────────────────────────────────

/// The resolved (effective) retention bound for one declared table.
/// `max_rows: None` means the table is unbounded — the whole bound is idle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectiveRetention {
    pub max_rows: Option<u64>,
    pub ttl_days: Option<u64>,
}

impl EffectiveRetention {
    /// `true` iff neither bound applies (retention is idle).
    pub fn is_idle(&self) -> bool {
        self.max_rows.is_none() && self.ttl_days.is_none()
    }
}

/// Resolve a declaration's effective retention:
/// declared `retention` → `AppStore` knob → contract default.
///
/// A present `retention` object is authoritative: an unspecified bound is idle.
/// An absent `retention` object consults the knobs, then
/// [`DEFAULT_MAX_ROWS`] / [`DEFAULT_RETENTION_DAYS`]. Per the binding contract,
/// `maxRows: null` makes the whole bound idle.
pub fn resolve_retention(
    declaration: &ApplicationDataTableDeclaration,
    app: &AppStore,
) -> Result<EffectiveRetention> {
    let (max_rows, ttl_days) = match &declaration.retention {
        Some(retention) => (retention.max_rows, retention.ttl_days),
        None => (
            Some(knob_u64(app, KNOB_DEFAULT_MAX_ROWS)?.unwrap_or(DEFAULT_MAX_ROWS)),
            Some(knob_u64(app, KNOB_DEFAULT_RETENTION_DAYS)?.unwrap_or(DEFAULT_RETENTION_DAYS)),
        ),
    };

    if max_rows.is_none() {
        return Ok(EffectiveRetention {
            max_rows: None,
            ttl_days: None,
        });
    }

    Ok(EffectiveRetention { max_rows, ttl_days })
}

fn knob_u64(app: &AppStore, key: &str) -> Result<Option<u64>> {
    Ok(match app.cached_get(key)? {
        Some(raw) => raw.trim().parse::<u64>().ok(),
        None => None,
    })
}

// ── Prune ───────────────────────────────────────────────────────────────────

/// Enforce declared retention across every persisted declared table. Called at
/// startup and on the existing 60-minute prune cycle (ST-4 wires it).
///
/// Returns the evicted records as `kind: Remove` [`DeclaredRowChange`] values —
/// oldest-first, each carrying the declared table's version AFTER its eviction —
/// for the caller to convert into `remove` notifications. It emits nothing.
pub fn prune_declared_tables(
    meta: &ApplicationDataStore,
    tables: &ApplicationStore,
    app: &AppStore,
) -> Result<Vec<DeclaredRowChange>> {
    prune_declared_tables_at(meta, tables, app, &rfc3339_now())
}

/// Deterministic form of [`prune_declared_tables`] with an injected clock (the
/// TTL boundary is evaluated against `now`; RFC3339). Public for tests.
pub fn prune_declared_tables_at(
    meta: &ApplicationDataStore,
    tables: &ApplicationStore,
    app: &AppStore,
    now: &str,
) -> Result<Vec<DeclaredRowChange>> {
    let metas = meta.list_tables()?;
    let mut evicted = Vec::new();

    for table_meta in metas {
        let declaration: ApplicationDataTableDeclaration =
            match serde_json::from_str(&table_meta.declaration_json) {
                Ok(declaration) => declaration,
                Err(e) => {
                    tracing::warn!(
                        target: "fredo::application_data",
                        feature_id = %table_meta.feature_id,
                        table = %table_meta.table_name,
                        error = %e,
                        "persisted declared table is unreadable; retention prune skipped"
                    );
                    continue;
                }
            };

        let retention = resolve_retention(&declaration, app)?;
        if retention.is_idle() {
            continue;
        }

        evicted.extend(prune_declared_table(
            meta,
            tables,
            &table_meta,
            &declaration,
            &retention,
            now,
        )?);
    }

    Ok(evicted)
}

/// Prune one declared table. Returns its evictions, oldest-first.
fn prune_declared_table(
    meta: &ApplicationDataStore,
    tables: &ApplicationStore,
    table_meta: &TableMeta,
    declaration: &ApplicationDataTableDeclaration,
    retention: &EffectiveRetention,
    now: &str,
) -> Result<Vec<DeclaredRowChange>> {
    let order_column = retention_order_column(declaration);
    let rows = tables.query(
        &table_meta.feature_id,
        &table_meta.table_name,
        None,
        Some(&format!("{order_column} ASC")),
        None,
    )?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let cutoff = match retention.ttl_days {
        Some(days) => Some(cutoff_before(now, days)?),
        None => None,
    };

    // The oldest `total - max_rows` rows are cap victims; TTL adds any older
    // rows beyond that. Rows arrive oldest-first, so a row is a victim iff it is
    // expired OR it falls inside the cap-excess prefix.
    let cap_excess = retention
        .max_rows
        .map(|max| {
            let max = usize::try_from(max).unwrap_or(usize::MAX);
            rows.len().saturating_sub(max)
        })
        .unwrap_or(0);

    let feature_id = &table_meta.feature_id;
    let table_name = &table_meta.table_name;
    let mut next_version = meta
        .get_table(feature_id, table_name)?
        .map_or(0, |table| table.last_version);
    let initial_version = next_version;
    let mut evicted = Vec::new();

    for (index, row) in rows.iter().enumerate() {
        let expired = cutoff
            .as_ref()
            .is_some_and(|cutoff| is_expired(row.get(order_column), cutoff));
        if !expired && index >= cap_excess {
            continue;
        }

        // A row without its full primary key cannot be addressed — leave it.
        let Some(key) = primary_key_values(declaration, row) else {
            continue;
        };
        let where_cols = key_where_cols(declaration, &key);
        if tables.delete(feature_id, table_name, &where_cols)? == 0 {
            continue;
        }

        next_version += 1;
        evicted.push(DeclaredRowChange {
            feature_id: feature_id.clone(),
            table: table_name.clone(),
            kind: DeclaredChangeKind::Remove,
            key,
            changed_fields: non_reserved_names(row),
            values: None,
            version: next_version,
        });
    }

    if next_version != initial_version {
        meta.set_last_version(feature_id, table_name, next_version)?;
    }

    Ok(evicted)
}

/// The oldest-first eviction order column: the declared `latestAt` when present,
/// otherwise the backend-managed `_updated_at`.
fn retention_order_column(declaration: &ApplicationDataTableDeclaration) -> &'static str {
    if declaration.column(RETENTION_ORDER_COLUMN).is_some() {
        RETENTION_ORDER_COLUMN
    } else {
        UPDATED_AT_COLUMN
    }
}

/// `now - days`, parsed as RFC3339 to keep the comparison timezone-correct.
fn cutoff_before(now: &str, days: u64) -> Result<chrono::DateTime<chrono::FixedOffset>> {
    let now = chrono::DateTime::parse_from_rfc3339(now)
        .map_err(|e| anyhow!("invalid RFC3339 retention clock '{now}': {e}"))?;
    let days = i64::try_from(days)
        .map_err(|_| anyhow!("retention ttlDays {days} is out of range for an RFC3339 cutoff"))?;
    Ok(now - chrono::Duration::days(days))
}

/// `true` iff a row's order-column stamp is STRICTLY older than `cutoff`. A
/// missing/unparseable stamp is never treated as expired.
fn is_expired(value: Option<&JsonValue>, cutoff: &chrono::DateTime<chrono::FixedOffset>) -> bool {
    let Some(raw) = value.and_then(JsonValue::as_str) else {
        return false;
    };
    match chrono::DateTime::parse_from_rfc3339(raw) {
        Ok(stamp) => stamp < *cutoff,
        Err(_) => false,
    }
}

/// The primary-key values in declaration order, or `None` when any is missing.
fn primary_key_values(
    declaration: &ApplicationDataTableDeclaration,
    row: &Map<String, JsonValue>,
) -> Option<Vec<JsonValue>> {
    declaration
        .primary_key
        .iter()
        .map(|name| row.get(name).cloned())
        .collect()
}

/// `pk column → value` in declaration order (the `ApplicationStore::delete` filter).
fn key_where_cols(
    declaration: &ApplicationDataTableDeclaration,
    key: &[JsonValue],
) -> Map<String, JsonValue> {
    declaration
        .primary_key
        .iter()
        .cloned()
        .zip(key.iter().cloned())
        .collect()
}

/// The removed record's known non-reserved field names (sorted) — mirrors the
/// projection engine's `remove` payload so the notification contract matches.
fn non_reserved_names(row: &Map<String, JsonValue>) -> Vec<String> {
    let mut names: Vec<String> = row
        .keys()
        .filter(|key| !is_reserved_column(key))
        .cloned()
        .collect();
    names.sort();
    names
}

// ── Tests ───────────────────────────────────────────────────────────────────
