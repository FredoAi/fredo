//! Declared-table retention + tombstone lifecycle (Spec #2896, ST-7,
//! R-3.4/R-4.4/R-4.6).
//!
//! Two responsibilities:
//!
//! 1. **Retention** — [`prune_declared_tables`] bounds every persisted declared
//!    table by its declared `retention: { maxRows?, ttlDays? }`, falling back to
//!    the `AppStore` knobs `feature_data.default_max_rows` /
//!    `feature_data.default_retention_days` and then to the contract defaults
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
//!    for a key deleted by `feature_data_delete`. It serializes the key with the
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
use crate::infrastructure::storage::feature_store::FeatureStore;
use crate::infrastructure::storage::AppStore;

use super::declaration::{is_reserved_column, FeatureDataTableDeclaration};
use super::projection::{DeclaredChangeKind, DeclaredRowChange};
use super::store::{FeatureDataStore, TableMeta};

/// Contract default row cap for a declared table (non-behavioral requirement).
pub const DEFAULT_MAX_ROWS: u64 = 10_000;
/// Contract default TTL for a declared table (non-behavioral requirement).
pub const DEFAULT_RETENTION_DAYS: u64 = 30;

/// `AppStore` knob overriding [`DEFAULT_MAX_ROWS`].
pub const KNOB_DEFAULT_MAX_ROWS: &str = "feature_data.default_max_rows";
/// `AppStore` knob overriding [`DEFAULT_RETENTION_DAYS`].
pub const KNOB_DEFAULT_RETENTION_DAYS: &str = "feature_data.default_retention_days";

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
/// by `feature_data_delete` and must never be re-created. ST-3's projection path
/// and ST-4's write path compose it.
pub fn is_tombstoned(
    meta: &FeatureDataStore,
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
    declaration: &FeatureDataTableDeclaration,
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
    Ok(match app.get(key)? {
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
    meta: &FeatureDataStore,
    tables: &FeatureStore,
    app: &AppStore,
) -> Result<Vec<DeclaredRowChange>> {
    prune_declared_tables_at(meta, tables, app, &rfc3339_now())
}

/// Deterministic form of [`prune_declared_tables`] with an injected clock (the
/// TTL boundary is evaluated against `now`; RFC3339). Public for tests.
pub fn prune_declared_tables_at(
    meta: &FeatureDataStore,
    tables: &FeatureStore,
    app: &AppStore,
    now: &str,
) -> Result<Vec<DeclaredRowChange>> {
    let metas = meta.list_tables()?;
    let mut evicted = Vec::new();

    for table_meta in metas {
        let declaration: FeatureDataTableDeclaration =
            match serde_json::from_str(&table_meta.declaration_json) {
                Ok(declaration) => declaration,
                Err(e) => {
                    tracing::warn!(
                        target: "fredo::feature_data",
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
    meta: &FeatureDataStore,
    tables: &FeatureStore,
    table_meta: &TableMeta,
    declaration: &FeatureDataTableDeclaration,
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
fn retention_order_column(declaration: &FeatureDataTableDeclaration) -> &'static str {
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
    declaration: &FeatureDataTableDeclaration,
    row: &Map<String, JsonValue>,
) -> Option<Vec<JsonValue>> {
    declaration
        .primary_key
        .iter()
        .map(|name| row.get(name).cloned())
        .collect()
}

/// `pk column → value` in declaration order (the `FeatureStore::delete` filter).
fn key_where_cols(
    declaration: &FeatureDataTableDeclaration,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use crate::infrastructure::feature_data::declaration::{
        ActivitySource, ColumnOwner, DataSource, DeclaredColumn, DeclaredColumnType,
        FeatureDataDeclaration, FieldMapping, Retention, RowProjection, RowProjectionKind,
    };
    use crate::infrastructure::feature_data::projection::ProjectionEngine;
    use crate::infrastructure::feature_data::registry::DeclarationRegistry;
    use crate::infrastructure::feature_data::store::Tombstone;
    use crate::infrastructure::rtdb::commands::IngestRow;
    use crate::infrastructure::rtdb::rows::{ChatRow, RowState};
    use crate::infrastructure::rtdb::store::RtdbStore;

    fn backend_column(name: &str, ty: DeclaredColumnType, nullable: bool) -> DeclaredColumn {
        DeclaredColumn {
            name: name.to_string(),
            col_type: ty,
            nullable,
            owner: ColumnOwner::Backend,
        }
    }

    /// A minimal MM-shaped declared table with a `latestAt` order column.
    fn sessions_declaration(retention: Option<Retention>) -> FeatureDataDeclaration {
        FeatureDataDeclaration {
            feature_id: "mission-monitor".to_string(),
            declaration_revision: "mm.sessions.v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "sessions".to_string(),
                primary_key: vec!["sessionId".to_string()],
                columns: vec![
                    backend_column("sessionId", DeclaredColumnType::Text, false),
                    backend_column("latestAt", DeclaredColumnType::Text, false),
                    backend_column("chatRowCount", DeclaredColumnType::Integer, false),
                ],
                source: None,
                retention,
            }],
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        meta: Arc<FeatureDataStore>,
        tables: Arc<FeatureStore>,
        app: Arc<AppStore>,
    }

    fn setup(retention: Option<Retention>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let tables = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        let app = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());
        let registry = DeclarationRegistry::new(meta.clone(), tables.clone());
        registry.declare(&sessions_declaration(retention)).unwrap();
        Harness {
            _dir: dir,
            meta,
            tables,
            app,
        }
    }

    fn session_row(session_id: &str, latest_at: &str, chat_row_count: i64) -> Map<String, JsonValue> {
        serde_json::json!({
            "sessionId": session_id,
            "latestAt": latest_at,
            "chatRowCount": chat_row_count,
            "_row_version": 1,
            "_updated_at": latest_at,
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn insert(h: &Harness, rows: &[Map<String, JsonValue>]) {
        h.tables
            .upsert(
                "mission-monitor",
                "sessions",
                &["sessionId".to_string()],
                rows,
            )
            .unwrap();
    }

    fn remaining_sessions(h: &Harness) -> Vec<String> {
        h.tables
            .query(
                "mission-monitor",
                "sessions",
                None,
                Some("latestAt ASC"),
                None,
            )
            .unwrap()
            .iter()
            .map(|row| row["sessionId"].as_str().unwrap().to_string())
            .collect()
    }

    fn evicted_keys(changes: &[DeclaredRowChange]) -> Vec<String> {
        changes
            .iter()
            .map(|change| change.key[0].as_str().unwrap().to_string())
            .collect()
    }

    fn last_version(h: &Harness) -> i64 {
        h.meta
            .get_table("mission-monitor", "sessions")
            .unwrap()
            .unwrap()
            .last_version
    }

    const NOW: &str = "2026-09-18T00:00:00+00:00";

    #[test]
    fn max_rows_evicts_oldest_first_by_latest_at() {
        let h = setup(Some(Retention {
            max_rows: Some(2),
            ttl_days: None,
        }));
        insert(
            &h,
            &[
                session_row("s3", "2026-09-03T00:00:00+00:00", 3),
                session_row("s1", "2026-09-01T00:00:00+00:00", 1),
                session_row("s4", "2026-09-04T00:00:00+00:00", 4),
                session_row("s2", "2026-09-02T00:00:00+00:00", 2),
            ],
        );

        let evicted =
            prune_declared_tables_at(&h.meta, &h.tables, &h.app, NOW).unwrap();

        assert_eq!(
            evicted_keys(&evicted),
            vec!["s1", "s2"],
            "eviction must be oldest-first by latestAt"
        );
        assert_eq!(
            remaining_sessions(&h),
            vec!["s3", "s4"],
            "the newest rows must survive"
        );
    }

    #[test]
    fn eviction_bumps_version_per_record_and_returns_the_keys() {
        let h = setup(Some(Retention {
            max_rows: Some(1),
            ttl_days: None,
        }));
        insert(
            &h,
            &[
                session_row("s3", "2026-09-03T00:00:00+00:00", 3),
                session_row("s1", "2026-09-01T00:00:00+00:00", 1),
                session_row("s2", "2026-09-02T00:00:00+00:00", 2),
            ],
        );
        assert_eq!(last_version(&h), 0, "declare initializes the version at 0");

        let evicted =
            prune_declared_tables_at(&h.meta, &h.tables, &h.app, NOW).unwrap();

        assert_eq!(evicted_keys(&evicted), vec!["s1", "s2"]);
        assert_eq!(
            evicted.iter().map(|change| change.version).collect::<Vec<_>>(),
            vec![1, 2],
            "the version bumps once per evicted record"
        );
        assert_eq!(last_version(&h), 2, "the bumped version is persisted");
        assert!(evicted
            .iter()
            .all(|change| change.kind == DeclaredChangeKind::Remove && change.values.is_none()));
        // The remove payload carries the removed record's known non-reserved
        // field names and never a value.
        assert!(evicted[0]
            .changed_fields
            .contains(&"sessionId".to_string()));
        assert!(!evicted[0]
            .changed_fields
            .iter()
            .any(|field| field.starts_with('_')));
        assert!(evicted.iter().all(|change| change.feature_id == "mission-monitor"));
        assert!(evicted.iter().all(|change| change.table == "sessions"));
    }

    #[test]
    fn ttl_evicts_strictly_older_than_the_cutoff() {
        // A generous cap so ONLY the TTL decides.
        let h = setup(Some(Retention {
            max_rows: Some(100),
            ttl_days: Some(30),
        }));
        insert(
            &h,
            &[
                session_row("old", "2026-08-01T00:00:00+00:00", 1),
                // Exactly 30 days before NOW — the boundary is inclusive (kept).
                session_row("boundary", "2026-08-19T00:00:00+00:00", 1),
                session_row("new", "2026-09-01T00:00:00+00:00", 1),
            ],
        );

        let evicted =
            prune_declared_tables_at(&h.meta, &h.tables, &h.app, NOW).unwrap();

        assert_eq!(
            evicted_keys(&evicted),
            vec!["old"],
            "only stamps strictly older than now-30d are evicted"
        );
        assert_eq!(remaining_sessions(&h), vec!["boundary", "new"]);
    }

    #[test]
    fn null_max_rows_is_idle_even_when_a_ttl_would_otherwise_evict() {
        // Explicit `maxRows: null` is the binding "idle" contract: the cap is the
        // master switch, so the whole bound is unbounded. `ttlDays: 1` would
        // expire both ancient rows if retention were active.
        let h = setup(Some(Retention {
            max_rows: None,
            ttl_days: Some(1),
        }));
        insert(
            &h,
            &[
                session_row("s1", "2000-01-01T00:00:00+00:00", 1),
                session_row("s2", "2000-01-02T00:00:00+00:00", 1),
            ],
        );

        let evicted =
            prune_declared_tables_at(&h.meta, &h.tables, &h.app, NOW).unwrap();

        assert!(evicted.is_empty(), "idle retention must evict nothing");
        assert_eq!(remaining_sessions(&h), vec!["s1", "s2"]);
        assert_eq!(last_version(&h), 0, "an idle prune must not bump the version");
    }

    #[test]
    fn absent_declaration_retention_uses_the_appstore_knob_then_the_default() {
        // No declared retention -> the AppStore knob sets the cap.
        let knobbed = setup(None);
        knobbed
            .app
            .set(KNOB_DEFAULT_MAX_ROWS, "1")
            .unwrap();
        insert(
            &knobbed,
            &[
                session_row("s1", "2026-09-01T00:00:00+00:00", 1),
                session_row("s2", "2026-09-02T00:00:00+00:00", 1),
                session_row("s3", "2026-09-03T00:00:00+00:00", 1),
            ],
        );
        let evicted =
            prune_declared_tables_at(&knobbed.meta, &knobbed.tables, &knobbed.app, NOW).unwrap();
        assert_eq!(evicted_keys(&evicted), vec!["s1", "s2"]);
        assert_eq!(remaining_sessions(&knobbed), vec!["s3"]);

        // No knob and no declared retention -> the contract defaults (10_000
        // rows, 30 days) are far above three recent rows, so nothing is evicted.
        let defaulted = setup(None);
        insert(
            &defaulted,
            &[
                session_row("s1", "2026-09-15T00:00:00+00:00", 1),
                session_row("s2", "2026-09-16T00:00:00+00:00", 1),
                session_row("s3", "2026-09-17T00:00:00+00:00", 1),
            ],
        );
        let evicted =
            prune_declared_tables_at(&defaulted.meta, &defaulted.tables, &defaulted.app, NOW)
                .unwrap();
        assert!(
            evicted.is_empty(),
            "the default maxRows (10_000) must leave three rows untouched"
        );
        assert_eq!(remaining_sessions(&defaulted), vec!["s1", "s2", "s3"]);
    }

    #[test]
    fn prune_never_touches_a_non_declared_table() {
        // cap = 0 -> the declared table is fully evicted.
        let h = setup(Some(Retention {
            max_rows: Some(0),
            ttl_days: None,
        }));
        insert(&h, &[session_row("s1", "2026-09-01T00:00:00+00:00", 1)]);

        // A physically namespaced table with NO declaration + NO metadata row.
        h.tables
            .execute_batch(
                "CREATE TABLE feature_mission_monitor_other (id TEXT PRIMARY KEY, latestAt TEXT);",
            )
            .unwrap();
        h.tables
            .upsert(
                "mission-monitor",
                "other",
                &["id".to_string()],
                &[serde_json::json!({
                    "id": "keep",
                    "latestAt": "2000-01-01T00:00:00+00:00"
                })
                .as_object()
                .unwrap()
                .clone()],
            )
            .unwrap();

        let evicted =
            prune_declared_tables_at(&h.meta, &h.tables, &h.app, NOW).unwrap();

        assert_eq!(evicted_keys(&evicted), vec!["s1"]);
        assert!(remaining_sessions(&h).is_empty(), "cap 0 evicts the declared row");
        let untouched = h
            .tables
            .query("mission-monitor", "other", None, None, None)
            .unwrap();
        assert_eq!(
            untouched.len(),
            1,
            "prune must only ever visit tables with a persisted declaration"
        );
    }

    // ── Tombstone-aware projection ──────────────────────────────────────────

    fn probe_declaration() -> FeatureDataDeclaration {
        FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.turns.v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "turns".to_string(),
                primary_key: vec!["id".to_string()],
                columns: vec![
                    backend_column("id", DeclaredColumnType::Text, false),
                    backend_column("reply", DeclaredColumnType::Text, true),
                ],
                source: Some(DataSource::Row(RowProjection {
                    kind: RowProjectionKind::Row,
                    from: ActivitySource::Chat,
                    r#where: None,
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
                    ]),
                })),
                retention: None,
            }],
        }
    }

    struct ProjectionHarness {
        _dir: tempfile::TempDir,
        engine: ProjectionEngine,
        meta: Arc<FeatureDataStore>,
        tables: Arc<FeatureStore>,
    }

    fn projection_setup() -> ProjectionHarness {
        let dir = tempfile::tempdir().unwrap();
        let rtdb = Arc::new(RtdbStore::open(dir.path().to_path_buf()).unwrap());
        rtdb.ensure_schema().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let tables = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        let registry = DeclarationRegistry::new(meta.clone(), tables.clone());
        registry.declare(&probe_declaration()).unwrap();
        let engine =
            ProjectionEngine::new(dir.path().to_path_buf(), meta.clone(), tables.clone()).unwrap();
        ProjectionHarness {
            _dir: dir,
            engine,
            meta,
            tables,
        }
    }

    fn chat_row(session_id: &str, correlation_id: &str) -> ChatRow {
        ChatRow {
            session_id: session_id.to_string(),
            correlation_id: correlation_id.to_string(),
            seq: 1,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-09-18T00:00:01+00:00".to_string(),
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
        }
    }

    #[test]
    fn tombstone_key_matches_the_projection_wire_format() {
        // The exact format ST-3/ST-4 use: JSON array of the PK values in
        // declaration order.
        assert_eq!(
            tombstone_key(&[serde_json::json!("ses_1_1")]).unwrap(),
            serde_json::to_string(&vec![serde_json::json!("ses_1_1")]).unwrap()
        );
        assert_eq!(
            tombstone_key(&[serde_json::json!("ses_1_1")]).unwrap(),
            "[\"ses_1_1\"]"
        );
        assert_eq!(
            tombstone_key(&[serde_json::json!("a"), serde_json::json!(2)]).unwrap(),
            "[\"a\",2]"
        );
    }

    #[test]
    fn tombstoned_key_is_not_re_created() {
        let h = projection_setup();
        let key = [serde_json::json!("ses_1_1")];
        h.meta
            .put_tombstone(&Tombstone {
                feature_id: "probe".to_string(),
                table_name: "turns".to_string(),
                key_json: tombstone_key(&key).unwrap(),
                deleted_at: NOW.to_string(),
            })
            .unwrap();

        assert!(is_tombstoned(&h.meta, "probe", "turns", &key).unwrap());
        assert!(!is_tombstoned(
            &h.meta,
            "probe",
            "turns",
            &[serde_json::json!("ses_1_2")]
        )
        .unwrap());

        // The projection engine honors the guard's key format: the tombstoned
        // record is never re-created, while a live sibling still projects.
        h.engine
            .project(&IngestRow::Chat(chat_row("ses_1", "ses_1_1")), &[])
            .unwrap();
        h.engine
            .project(&IngestRow::Chat(chat_row("ses_1", "ses_1_2")), &[])
            .unwrap();

        let rows = h.tables.query("probe", "turns", None, None, None).unwrap();
        assert_eq!(rows.len(), 1, "the tombstoned record must stay deleted");
        assert_eq!(rows[0]["id"], "ses_1_2");
    }
}
