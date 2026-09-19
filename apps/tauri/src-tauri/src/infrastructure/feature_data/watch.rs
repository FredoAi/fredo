//! The global per-`watchId` watch registry (Spec #2896, ST-4).
//!
//! One PROCESS-GLOBAL registry serves every webview (each webview owns its own
//! registrations, but the registry is shared — the `queryId`-scoped unregister
//! property of `rtdb/subscriptions.rs` is preserved: removing one watch never
//! affects another).
//!
//! ## Granularity (R-2)
//!
//! A watch is `{ target, scope, fields?, flushMs }`:
//!
//! - [`WatchScope::Table`] — every insert/update/remove of any record in the
//!   table;
//! - [`WatchScope::Record`] — only the named record (primary-key values in
//!   declaration order for a declared table; `[correlationId, sessionId]` for a
//!   canonical table);
//! - [`WatchScope::Query`] — records whose current values satisfy every
//!   `{ field, eq }` filter;
//! - `fields` narrows the notification to changes of the named columns — a
//!   change to a sibling field NEVER notifies (R-2.3).
//!
//! ## Register-before-snapshot (R-3.2)
//!
//! The caller inserts the watch here FIRST, then takes the snapshot rows; a
//! change landing between the two is buffered and delivered — there is no gap
//! at the registration/snapshot boundary.
//!
//! ## Coalescing (R-3.3)
//!
//! Changes are buffered per watch per record; a flush that is due (the
//! `flushMs` window elapsed, default [`DEFAULT_FLUSH_MS`]) emits ONE
//! notification per record carrying the CURRENT (latest) values — a field
//! changed twice reports its latest value once.
//!
//! ## Removals (R-3.4)
//!
//! A `remove` carries `changedFields` = the record's previously-known fields
//! and `values: null`; it is delivered to the table watch, that record's
//! watch, and every field watch on that record. A field set to `null` is an
//! `update`, never a `remove`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use uuid::Uuid;

use crate::infrastructure::feature_data::envelope::{FeatureChangeKind, FeatureRowNotification};
use crate::infrastructure::feature_data::projection::{
    DeclaredChangeKind, DeclaredRowChange, DeclaredRowObserver,
};
use crate::infrastructure::rtdb::commands::IngestRow;
use crate::infrastructure::rtdb::flush::DEFAULT_FLUSH_MS;
use crate::infrastructure::rtdb::project::rfc3339_now;

/// The notification sink the registry flushes batches into (production: the
/// `EventBus`'s `emit_feature_delivery_batch`; tests: a collector).
pub trait NotificationSink: Send + Sync {
    /// Emit one coalesced batch as a single `featureBatch` envelope.
    fn emit(&self, notifications: &[FeatureRowNotification]);
}

/// The registry's flush default — the shared RTDB coalescing window.
pub const WATCH_DEFAULT_FLUSH_MS: u64 = DEFAULT_FLUSH_MS;

/// What a watch is addressed to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchTarget {
    /// A declared (feature-owned) table.
    Declared { feature_id: String, table: String },
    /// A canonical RTDB table (`chat` | `toolUse` | `agentSession`).
    Canonical { table: String },
}

impl WatchTarget {
    /// `true` for a canonical-table target.
    pub fn is_canonical(&self) -> bool {
        matches!(self, WatchTarget::Canonical { .. })
    }

    /// The declaring feature id (`None` for canonical).
    pub fn feature_id(&self) -> Option<&str> {
        match self {
            WatchTarget::Declared { feature_id, .. } => Some(feature_id),
            WatchTarget::Canonical { .. } => None,
        }
    }

    /// The logical table name (`sessions` | `chat` | `toolUse` | `agentSession`).
    pub fn table(&self) -> &str {
        match self {
            WatchTarget::Declared { table, .. } => table,
            WatchTarget::Canonical { table } => table,
        }
    }
}

/// A `{ field, eq }` filter over a record's current values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqFilter {
    pub field: String,
    pub eq: JsonValue,
}

/// The granularity of a watch.
#[derive(Clone, Debug, PartialEq)]
pub enum WatchScope {
    Table,
    Record(Vec<JsonValue>),
    Query(Vec<EqFilter>),
}

struct Pending {
    key: Vec<JsonValue>,
    kind: FeatureChangeKind,
    changed: BTreeSet<String>,
    values: Option<Map<String, JsonValue>>,
    version: u64,
}

struct Watch {
    id: String,
    feature_id: Option<String>,
    table: String,
    canonical: bool,
    scope: WatchScope,
    fields: Option<BTreeSet<String>>,
    flush_ms: u64,
    window_start: Option<Instant>,
    pending: BTreeMap<String, Pending>,
    /// Record keys this watch has ever buffered (canonical insert-vs-update and
    /// query-scoped removals).
    known: HashSet<String>,
}

struct Inner {
    watches: HashMap<String, Watch>,
}

/// The process-global watch registry.
pub struct WatchRegistry {
    inner: Mutex<Inner>,
    sink: Arc<dyn NotificationSink>,
}

impl WatchRegistry {
    /// Build a registry emitting into `sink`.
    pub fn new(sink: Arc<dyn NotificationSink>) -> Self {
        WatchRegistry {
            inner: Mutex::new(Inner {
                watches: HashMap::new(),
            }),
            sink,
        }
    }

    // ── Registration / removal ──────────────────────────────────────────────

    /// Insert a watch and return its opaque id. Callers MUST register before
    /// taking the snapshot rows (R-3.2).
    pub fn register(
        &self,
        target: WatchTarget,
        scope: WatchScope,
        fields: Option<Vec<String>>,
        flush_ms: Option<u64>,
    ) -> String {
        let watch_id = Uuid::new_v4().to_string();
        let canonical = target.is_canonical();
        let watch = Watch {
            id: watch_id.clone(),
            feature_id: target.feature_id().map(str::to_string),
            table: target.table().to_string(),
            canonical,
            scope,
            fields: fields.map(|names| names.into_iter().collect()),
            flush_ms: flush_ms.unwrap_or(WATCH_DEFAULT_FLUSH_MS),
            window_start: None,
            pending: BTreeMap::new(),
            known: HashSet::new(),
        };
        self.lock().watches.insert(watch_id.clone(), watch);
        watch_id
    }

    /// Seed the known-record set after an `initial: true` snapshot so a later
    /// canonical change is an `update` (not a duplicate `insert`).
    pub fn seed_known(&self, watch_id: &str, keys: &[Vec<JsonValue>]) {
        let mut inner = self.lock();
        if let Some(watch) = inner.watches.get_mut(watch_id) {
            for key in keys {
                watch.known.insert(record_key(key));
            }
        }
    }

    /// Remove exactly this watch. Unknown/already-removed ids are a no-op
    /// (idempotent). Returns `true` iff the watch existed.
    pub fn unwatch(&self, watch_id: &str) -> bool {
        self.lock().watches.remove(watch_id).is_some()
    }

    /// Number of currently registered watches (observability/tests).
    pub fn watch_count(&self) -> usize {
        self.lock().watches.len()
    }

    /// `true` iff the watch id is currently registered.
    pub fn is_watching(&self, watch_id: &str) -> bool {
        self.lock().watches.contains_key(watch_id)
    }

    // ── Change feeds ────────────────────────────────────────────────────────

    /// Feed one canonical upsert (the composite `RowUpsertObserver` calls this
    /// for every ingest, unconditionally).
    pub fn on_canonical_row(&self, row: &IngestRow, changed_fields: &[String]) {
        let (table, key, values, version) = canonical_record(row);
        let record_key = record_key(&key);
        let mut inner = self.lock();
        for watch in inner.watches.values_mut() {
            if !watch.canonical || watch.table != table {
                continue;
            }
            if !watch.scope_matches(&record_key, &key, Some(&values)) {
                continue;
            }
            let is_new = !watch.known.contains(&record_key);
            watch.known.insert(record_key.clone());
            let kind = if is_new {
                FeatureChangeKind::Insert
            } else {
                FeatureChangeKind::Update
            };
            let changed: BTreeSet<String> = if is_new {
                values.keys().cloned().collect()
            } else {
                changed_fields.iter().cloned().collect()
            };
            let narrowed = narrow(&changed, watch.fields.as_ref());
            if kind != FeatureChangeKind::Remove && narrowed.is_empty() {
                continue;
            }
            buffer(
                watch,
                record_key.clone(),
                key.clone(),
                kind,
                narrowed,
                Some(values.clone()),
                version,
            );
        }
    }

    /// Feed one declared-row change (ST-3's projection seam / ST-7's evictions /
    /// ST-4's write+delete paths).
    pub fn on_declared_change(&self, change: &DeclaredRowChange) {
        let kind = match change.kind {
            DeclaredChangeKind::Insert => FeatureChangeKind::Insert,
            DeclaredChangeKind::Update => FeatureChangeKind::Update,
            DeclaredChangeKind::Remove => FeatureChangeKind::Remove,
        };
        let values = normalize_values(change.values.clone());
        let key = change.key.clone();
        let record_key = record_key(&key);
        let version = change.version.max(0) as u64;
        let mut inner = self.lock();
        for watch in inner.watches.values_mut() {
            if watch.canonical {
                continue;
            }
            if watch.feature_id.as_deref() != Some(change.feature_id.as_str())
                || watch.table != change.table
            {
                continue;
            }
            if !watch.scope_matches(&record_key, &key, values.as_ref()) {
                continue;
            }
            if kind != FeatureChangeKind::Remove {
                watch.known.insert(record_key.clone());
            }
            let changed: BTreeSet<String> = change.changed_fields.iter().cloned().collect();
            let narrowed = narrow(&changed, watch.fields.as_ref());
            if kind != FeatureChangeKind::Remove && narrowed.is_empty() {
                continue;
            }
            // A removal carries the record's previously-known fields; a value
            // change carries the changed (narrowed) fields.
            let changed_fields = if kind == FeatureChangeKind::Remove {
                narrow(&record_known_fields(values.as_ref(), &changed), watch.fields.as_ref())
            } else {
                narrowed
            };
            buffer(
                watch,
                record_key.clone(),
                key.clone(),
                kind,
                changed_fields,
                values.clone(),
                version,
            );
        }
    }

    /// Feed many declared-row changes (ST-7 prune evictions, startup fan-out).
    pub fn handle_declared_changes(&self, changes: &[DeclaredRowChange]) {
        for change in changes {
            self.on_declared_change(change);
        }
    }

    // ── Flush ───────────────────────────────────────────────────────────────

    /// Emit every coalescing window that is due right now. Returns the number
    /// of notifications emitted. Normally driven by the background flush task.
    pub fn flush_due(&self) -> usize {
        let now = Instant::now();
        let mut batch = Vec::new();
        {
            let mut inner = self.lock();
            for watch in inner.watches.values_mut() {
                if watch.pending.is_empty() {
                    continue;
                }
                let due = match watch.window_start {
                    Some(start) => {
                        watch.flush_ms == 0
                            || now.duration_since(start) >= Duration::from_millis(watch.flush_ms)
                    }
                    None => true,
                };
                if !due {
                    continue;
                }
                let pending = std::mem::take(&mut watch.pending);
                watch.window_start = None;
                for (_record, change) in pending {
                    batch.push(FeatureRowNotification {
                        watch_id: watch.id.clone(),
                        feature_id: watch.feature_id.clone(),
                        table: watch.table.clone(),
                        kind: change.kind,
                        key: change.key,
                        changed_fields: change.changed.into_iter().collect(),
                        values: change.values,
                        version: change.version,
                        timestamp: rfc3339_now(),
                    });
                }
            }
        }
        if batch.is_empty() {
            return 0;
        }
        let count = batch.len();
        self.sink.emit(&batch);
        count
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// The ST-3 declared-row sink: the projection engine hands every declared
/// change here (it never re-enters the engine).
impl DeclaredRowObserver for WatchRegistry {
    fn on_declared_row_change(&self, change: &DeclaredRowChange) {
        self.on_declared_change(change);
    }
}

impl Watch {
    /// Does this watch's scope accept the record?
    fn scope_matches(
        &self,
        record_key: &str,
        key: &[JsonValue],
        values: Option<&Map<String, JsonValue>>,
    ) -> bool {
        match &self.scope {
            WatchScope::Table => true,
            WatchScope::Record(expected) => expected == key,
            WatchScope::Query(filters) => match values {
                Some(values) => filters.iter().all(|filter| {
                    values
                        .get(&filter.field)
                        .map_or(filter.eq.is_null(), |value| value == &filter.eq)
                }),
                // A removal carries no values — a query-scoped watch only sees
                // it when the record was previously in its result set.
                None => self.known.contains(record_key),
            },
        }
    }
}

/// Buffer one change into the watch's current window, coalescing to the latest
/// values (R-3.3): a later insert upgrades an update to insert; a removal wins.
fn buffer(
    watch: &mut Watch,
    record_key: String,
    key: Vec<JsonValue>,
    kind: FeatureChangeKind,
    changed: BTreeSet<String>,
    values: Option<Map<String, JsonValue>>,
    version: u64,
) {
    if watch.window_start.is_none() {
        watch.window_start = Some(Instant::now());
    }
    let entry = watch
        .pending
        .entry(record_key)
        .or_insert_with(|| Pending {
            key: key.clone(),
            kind,
            changed: BTreeSet::new(),
            values: None,
            version,
        });
    entry.key = key;
    entry.version = version;
    entry.changed.extend(changed);
    if kind == FeatureChangeKind::Remove {
        entry.kind = FeatureChangeKind::Remove;
        entry.values = None;
    } else if entry.kind != FeatureChangeKind::Remove {
        if entry.kind == FeatureChangeKind::Insert || kind == FeatureChangeKind::Insert {
            entry.kind = FeatureChangeKind::Insert;
        } else {
            entry.kind = FeatureChangeKind::Update;
        }
        entry.values = values;
    }
}

/// Restrict `changed` to the watch's watched fields (no narrowing when absent).
fn narrow(changed: &BTreeSet<String>, fields: Option<&BTreeSet<String>>) -> BTreeSet<String> {
    match fields {
        Some(fields) => changed.intersection(fields).cloned().collect(),
        None => changed.clone(),
    }
}

/// The removed record's previously-known field names: the current values' keys
/// when present, else the change's own field list.
fn record_known_fields(
    values: Option<&Map<String, JsonValue>>,
    fallback: &BTreeSet<String>,
) -> BTreeSet<String> {
    match values {
        Some(values) => values.keys().cloned().collect(),
        None => fallback.clone(),
    }
}

/// Reserved backend-managed columns surfaced camelCase for consumers.
fn normalize_values(mut values: Option<Map<String, JsonValue>>) -> Option<Map<String, JsonValue>> {
    values.as_mut().map(|map| {
        if let Some(version) = map.remove("_row_version") {
            map.insert("_rowVersion".to_string(), version);
        }
        if let Some(updated) = map.remove("_updated_at") {
            map.insert("_updatedAt".to_string(), updated);
        }
        map.clone()
    })
}

/// `serde_json::to_string(&Vec<JsonValue>)` — the same stable key form the
/// tombstone guard uses (PK values in declaration order).
fn record_key(key: &[JsonValue]) -> String {
    serde_json::to_string(key).unwrap_or_default()
}

/// `(table, [correlationId, sessionId], current row values, seq)` for a canonical row.
fn canonical_record(row: &IngestRow) -> (&'static str, Vec<JsonValue>, Map<String, JsonValue>, u64) {
    let (table, session_id, correlation_id, seq, value) = match row {
        IngestRow::Chat(inner) => (
            "chat",
            inner.session_id.clone(),
            inner.correlation_id.clone(),
            inner.seq,
            serde_json::to_value(inner),
        ),
        IngestRow::ToolUse(inner) => (
            "toolUse",
            inner.session_id.clone(),
            inner.correlation_id.clone(),
            inner.seq,
            serde_json::to_value(inner),
        ),
        IngestRow::AgentSession(inner) => (
            "agentSession",
            inner.session_id.clone(),
            inner.correlation_id.clone(),
            inner.seq,
            serde_json::to_value(inner),
        ),
    };
    let values = match value {
        Ok(JsonValue::Object(map)) => map,
        _ => Map::new(),
    };
    let key = vec![JsonValue::String(correlation_id), JsonValue::String(session_id)];
    (table, key, values, seq.max(0) as u64)
}

/// Background flush task: emits due coalescing windows at a ~5 ms cadence
/// (mirrors the RTDB flush loop). Spawned by lib.rs.
pub async fn run_watch_flush_task(registry: Arc<WatchRegistry>) {
    let mut interval = tokio::time::interval(Duration::from_millis(5));
    loop {
        interval.tick().await;
        registry.flush_due();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::feature_data::envelope::FeatureDeliveryBatch;
    use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, RowState, ToolUseRow};
    use serde_json::json;

    #[derive(Default)]
    struct Collector {
        batches: Mutex<Vec<FeatureDeliveryBatch>>,
    }

    impl Collector {
        fn notifications(&self) -> Vec<FeatureRowNotification> {
            let batches = self.batches.lock().unwrap();
            batches
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

    fn collector_registry() -> (Arc<Collector>, WatchRegistry) {
        let collector = Arc::new(Collector::default());
        let registry = WatchRegistry::new(collector.clone());
        (collector, registry)
    }

    fn declared_change(
        kind: DeclaredChangeKind,
        key: &str,
        changed: &[&str],
        fields: &[(&str, JsonValue)],
        version: i64,
    ) -> DeclaredRowChange {
        let values = if kind == DeclaredChangeKind::Remove {
            None
        } else {
            let mut map = Map::new();
            for (name, value) in fields {
                map.insert((*name).to_string(), value.clone());
            }
            map.insert("_row_version".to_string(), json!(version));
            map.insert("_updated_at".to_string(), json!("2026-09-18T00:00:00+00:00"));
            Some(map)
        };
        DeclaredRowChange {
            feature_id: "mission-monitor".to_string(),
            table: "sessions".to_string(),
            kind,
            key: vec![json!(key)],
            changed_fields: changed.iter().map(|s| (*s).to_string()).collect(),
            values,
            version,
        }
    }

    fn declared_target() -> WatchTarget {
        WatchTarget::Declared {
            feature_id: "mission-monitor".to_string(),
            table: "sessions".to_string(),
        }
    }

    fn canonical_chat(session: &str, correlation: &str, seq: i64, reply: Option<&str>) -> IngestRow {
        IngestRow::Chat(ChatRow {
            session_id: session.to_string(),
            correlation_id: correlation.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-09-18T00:00:00+00:00".to_string(),
            state: RowState::Update,
            user_message: None,
            agent_reply: reply.map(str::to_string),
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

    // ── Granularity ─────────────────────────────────────────────────────────

    #[test]
    fn table_watch_fires_on_any_record() {
        let (collector, registry) = collector_registry();
        registry.register(declared_target(), WatchScope::Table, None, Some(0));

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Insert,
            "s1",
            &["sessionId", "chatRowCount"],
            &[("sessionId", json!("s1")), ("chatRowCount", json!(1))],
            1,
        ));
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s2",
            &["chatRowCount"],
            &[("sessionId", json!("s2")), ("chatRowCount", json!(9))],
            2,
        ));
        assert_eq!(registry.flush_due(), 2);

        let notifications = collector.notifications();
        assert_eq!(notifications.len(), 2, "one per record");
        let keys: HashSet<String> = notifications
            .iter()
            .map(|n| n.key[0].as_str().unwrap().to_string())
            .collect();
        assert_eq!(keys, HashSet::from(["s1".to_string(), "s2".to_string()]));
        assert!(notifications.iter().all(|n| n.watch_id.len() == 36));
        assert!(notifications.iter().all(|n| n.feature_id.as_deref() == Some("mission-monitor")));
    }

    #[test]
    fn record_watch_fires_only_on_its_own_key() {
        let (collector, registry) = collector_registry();
        registry.register(
            declared_target(),
            WatchScope::Record(vec![json!("s1")]),
            None,
            Some(0),
        );

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s2",
            &["chatRowCount"],
            &[("sessionId", json!("s2"))],
            1,
        ));
        assert_eq!(registry.flush_due(), 0, "a sibling record never notifies");

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["chatRowCount"],
            &[("sessionId", json!("s1"))],
            2,
        ));
        assert_eq!(registry.flush_due(), 1);
        assert_eq!(collector.notifications()[0].key, vec![json!("s1")]);
    }

    #[test]
    fn field_watch_does_not_fire_on_a_sibling_field() {
        let (collector, registry) = collector_registry();
        registry.register(
            declared_target(),
            WatchScope::Table,
            Some(vec!["customName".to_string()]),
            Some(0),
        );

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["chatRowCount"],
            &[("sessionId", json!("s1")), ("customName", json!("A"))],
            1,
        ));
        assert_eq!(
            registry.flush_due(),
            0,
            "a change to a sibling field must NOT notify (R-2.3)"
        );

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1")), ("customName", json!("B"))],
            2,
        ));
        assert_eq!(registry.flush_due(), 1);
        let notification = &collector.notifications()[0];
        assert_eq!(notification.changed_fields, vec!["customName"]);
        assert_eq!(notification.values.as_ref().unwrap()["customName"], json!("B"));
    }

    #[test]
    fn query_scope_filters_on_current_values() {
        let (_, registry) = collector_registry();
        registry.register(
            declared_target(),
            WatchScope::Query(vec![EqFilter {
                field: "sessionId".to_string(),
                eq: json!("s1"),
            }]),
            None,
            Some(0),
        );

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s2",
            &["chatRowCount"],
            &[("sessionId", json!("s2"))],
            1,
        ));
        assert_eq!(registry.flush_due(), 0);
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["chatRowCount"],
            &[("sessionId", json!("s1"))],
            2,
        ));
        assert_eq!(registry.flush_due(), 1);
    }

    // ── Removal shape ───────────────────────────────────────────────────────

    #[test]
    fn remove_carries_previously_known_fields_and_no_values() {
        let (collector, registry) = collector_registry();
        registry.register(declared_target(), WatchScope::Record(vec![json!("s1")]), None, Some(0));
        // A field watch on the same record also sees the removal.
        registry.register(
            declared_target(),
            WatchScope::Record(vec![json!("s1")]),
            Some(vec!["customName".to_string()]),
            Some(0),
        );

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Remove,
            "s1",
            &["sessionId", "chatRowCount", "customName"],
            &[],
            7,
        ));
        assert_eq!(registry.flush_due(), 2);
        for notification in collector.notifications() {
            assert_eq!(notification.kind, FeatureChangeKind::Remove);
            assert!(notification.values.is_none(), "removal carries no value");
            assert_eq!(notification.version, 7);
        }
        // The narrowed watch reports the watched field only.
        let narrowed = collector
            .notifications()
            .into_iter()
            .find(|n| n.changed_fields.len() == 1)
            .expect("narrowed removal");
        assert_eq!(narrowed.changed_fields, vec!["customName"]);
    }

    #[test]
    fn removal_is_invisible_to_a_query_watch_that_never_saw_the_record() {
        let (collector, registry) = collector_registry();
        registry.register(
            declared_target(),
            WatchScope::Query(vec![EqFilter {
                field: "sessionId".to_string(),
                eq: json!("other"),
            }]),
            None,
            Some(0),
        );
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Remove,
            "s1",
            &["sessionId"],
            &[],
            1,
        ));
        assert_eq!(registry.flush_due(), 0);
        assert!(collector.notifications().is_empty());
    }

    // ── Coalescing ──────────────────────────────────────────────────────────

    #[test]
    fn coalescing_reports_the_latest_value_once_per_record() {
        let (collector, registry) = collector_registry();
        registry.register(declared_target(), WatchScope::Table, None, Some(0));

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1")), ("customName", json!("one"))],
            1,
        ));
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1")), ("customName", json!("two"))],
            2,
        ));
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1")), ("customName", json!("three"))],
            3,
        ));

        assert_eq!(registry.flush_due(), 1, "one notification per record per window");
        let notification = &collector.notifications()[0];
        assert_eq!(notification.values.as_ref().unwrap()["customName"], json!("three"));
        assert_eq!(notification.version, 3);
        assert_eq!(notification.changed_fields, vec!["customName"]);
        assert!(collector.notifications().len() == 1);
    }

    #[test]
    fn a_window_is_not_flushed_before_its_flush_ms_elapses() {
        let (collector, registry) = collector_registry();
        registry.register(declared_target(), WatchScope::Table, None, Some(60_000));
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1"))],
            1,
        ));
        assert_eq!(registry.flush_due(), 0, "window is not due yet");
        assert!(collector.notifications().is_empty());
    }

    // ── Unwatch isolation ───────────────────────────────────────────────────

    #[test]
    fn unwatch_is_isolated_and_idempotent() {
        let (collector, registry) = collector_registry();
        let kept = registry.register(declared_target(), WatchScope::Table, None, Some(0));
        let dropped = registry.register(declared_target(), WatchScope::Table, None, Some(0));

        assert!(registry.unwatch(&dropped));
        assert!(!registry.unwatch(&dropped), "already removed → no-op");
        assert!(!registry.unwatch("never-registered"), "unknown → no-op");
        assert_eq!(registry.watch_count(), 1);

        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1"))],
            1,
        ));
        assert_eq!(registry.flush_due(), 1, "only the surviving watch delivers");
        let notifications = collector.notifications();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].watch_id, kept);
    }

    // ── Register-before-snapshot ────────────────────────────────────────────

    #[test]
    fn register_before_snapshot_has_no_gap() {
        let (collector, registry) = collector_registry();
        // Registration FIRST, then a change landing before the (hypothetical)
        // snapshot — the change is buffered and delivered, so nothing is lost.
        let watch_id = registry.register(declared_target(), WatchScope::Table, None, Some(0));
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Insert,
            "s1",
            &["sessionId"],
            &[("sessionId", json!("s1"))],
            1,
        ));
        assert_eq!(registry.flush_due(), 1);
        assert_eq!(collector.notifications()[0].watch_id, watch_id);
    }

    // ── Canonical watches ───────────────────────────────────────────────────

    #[test]
    fn canonical_table_watch_reports_insert_then_update() {
        let (collector, registry) = collector_registry();
        registry.register(
            WatchTarget::Canonical {
                table: "chat".to_string(),
            },
            WatchScope::Table,
            None,
            Some(0),
        );

        registry.on_canonical_row(&canonical_chat("ses_1", "ses_1_1", 1, Some("hi")), &["state".to_string()]);
        assert_eq!(registry.flush_due(), 1);
        let first = &collector.notifications()[0];
        assert_eq!(first.kind, FeatureChangeKind::Insert);
        assert!(first.feature_id.is_none(), "canonical watch has no featureId");
        assert_eq!(first.table, "chat");
        assert_eq!(first.key, vec![json!("ses_1_1"), json!("ses_1")]);
        assert_eq!(first.version, 1);

        registry.on_canonical_row(
            &canonical_chat("ses_1", "ses_1_1", 2, Some("full reply")),
            &["agentReply".to_string()],
        );
        assert_eq!(registry.flush_due(), 1);
        let second = &collector.notifications()[1];
        assert_eq!(second.kind, FeatureChangeKind::Update);
        assert_eq!(second.changed_fields, vec!["agentReply"]);
        assert_eq!(second.version, 2);
    }

    #[test]
    fn canonical_field_watch_ignores_a_sibling_field_change() {
        let (collector, registry) = collector_registry();
        registry.register(
            WatchTarget::Canonical {
                table: "chat".to_string(),
            },
            WatchScope::Record(vec![json!("ses_1_1"), json!("ses_1")]),
            Some(vec!["agentReply".to_string()]),
            Some(0),
        );
        // First observation is an insert → the watched field is present.
        registry.on_canonical_row(&canonical_chat("ses_1", "ses_1_1", 1, Some("hi")), &["state".to_string()]);
        assert_eq!(registry.flush_due(), 1);

        // A sibling-only change never notifies.
        registry.on_canonical_row(&canonical_chat("ses_1", "ses_1_1", 2, Some("hi")), &["state".to_string()]);
        assert_eq!(registry.flush_due(), 0);
        assert_eq!(collector.notifications().len(), 1);
    }

    #[test]
    fn canonical_query_scope_filters_by_session() {
        let (_, registry) = collector_registry();
        registry.register(
            WatchTarget::Canonical {
                table: "chat".to_string(),
            },
            WatchScope::Query(vec![EqFilter {
                field: "sessionId".to_string(),
                eq: json!("ses_A"),
            }]),
            None,
            Some(0),
        );
        registry.on_canonical_row(&canonical_chat("ses_B", "ses_B_1", 1, None), &[]);
        assert_eq!(registry.flush_due(), 0, "session B is out of scope");
        registry.on_canonical_row(&canonical_chat("ses_A", "ses_A_1", 2, None), &[]);
        assert_eq!(registry.flush_due(), 1);
    }

    #[test]
    fn seed_known_downgrades_the_next_change_to_an_update() {
        let (collector, registry) = collector_registry();
        let watch_id = registry.register(
            WatchTarget::Canonical {
                table: "chat".to_string(),
            },
            WatchScope::Table,
            None,
            Some(0),
        );
        registry.seed_known(&watch_id, &[vec![json!("ses_1_1"), json!("ses_1")]]);
        registry.on_canonical_row(&canonical_chat("ses_1", "ses_1_1", 5, Some("x")), &["agentReply".to_string()]);
        assert_eq!(registry.flush_due(), 1);
        assert_eq!(collector.notifications()[0].kind, FeatureChangeKind::Update);
    }

    #[test]
    fn canonical_other_kinds_do_not_fire_a_chat_watch() {
        let (_, registry) = collector_registry();
        registry.register(
            WatchTarget::Canonical {
                table: "chat".to_string(),
            },
            WatchScope::Table,
            None,
            Some(0),
        );
        registry.on_canonical_row(
            &IngestRow::ToolUse(ToolUseRow {
                session_id: "ses_1".to_string(),
                correlation_id: "ses_1_2".to_string(),
                seq: 1,
                started_at_ns: None,
                ended_at_ns: None,
                updated_at: "2026-09-18T00:00:00+00:00".to_string(),
                state: RowState::Response,
                tool_name: Some("bash".to_string()),
                tool_success: None,
                tool_error: None,
                duration_ms: None,
                tool_input_json: None,
                tool_output_json: None,
                is_subagent: None,
                raw_json: "{}".to_string(),
            }),
            &[],
        );
        registry.on_canonical_row(
            &IngestRow::AgentSession(AgentSessionRow {
                session_id: "ses_1".to_string(),
                correlation_id: "ses_1".to_string(),
                seq: 2,
                started_at_ns: None,
                ended_at_ns: None,
                updated_at: "2026-09-18T00:00:00+00:00".to_string(),
                state: RowState::Update,
                total_tokens: None,
                total_messages: None,
                total_cost_usd: None,
                agent_name: None,
                raw_json: "{}".to_string(),
            }),
            &[],
        );
        assert_eq!(registry.flush_due(), 0);
    }

    #[test]
    fn separate_watches_each_receive_their_own_notification() {
        let (collector, registry) = collector_registry();
        registry.register(declared_target(), WatchScope::Table, None, Some(0));
        registry.register(
            declared_target(),
            WatchScope::Table,
            Some(vec!["customName".to_string()]),
            Some(0),
        );
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1")), ("customName", json!("x"))],
            1,
        ));
        assert_eq!(registry.flush_due(), 2, "each watch gets its own notification");
        let ids: HashSet<String> = collector
            .notifications()
            .into_iter()
            .map(|n| n.watch_id)
            .collect();
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn flush_batches_into_one_envelope() {
        let (collector, registry) = collector_registry();
        registry.register(declared_target(), WatchScope::Table, None, Some(0));
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s1",
            &["customName"],
            &[("sessionId", json!("s1"))],
            1,
        ));
        registry.on_declared_change(&declared_change(
            DeclaredChangeKind::Update,
            "s2",
            &["customName"],
            &[("sessionId", json!("s2"))],
            2,
        ));
        registry.flush_due();
        assert_eq!(collector.batches.lock().unwrap().len(), 1, "one batch per flush");
    }
}
