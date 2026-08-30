//! ContractEventStore — SQLite-backed per-contract delivery persistence
//! (Spec #2768, ST-3) plus the non-blocking persistence pipeline.
//!
//! Follows the SpanStore pattern (`storage/span_store.rs`):
//! - Own `Mutex<Connection>` to `fredo.db` with WAL journal mode.
//! - Schema managed via `ensure_schema()`.
//! - Batched inserts, batched retention pruning (age + row cap).
//!
//! ## Non-blocking pipeline (R8 — the emit path never waits on storage)
//!
//! `EventBus.emit_delivery` (the single choke point covering every process
//! call-site, the 5s sweep, and deregister ends) calls
//! `ContractEventWriter::enqueue` for deliveries of **persistent** contracts.
//! The enqueue is a non-blocking `try_send` on a bounded MPSC channel — when
//! the queue is full the persistence work is SHED (counted, logged) and live
//! delivery is never blocked or dropped. A dedicated writer task spawned via
//! `tauri::async_runtime::spawn` drains the channel in ~100 ms batches and
//! writes with `INSERT OR IGNORE` (dedupe on `delivery_id`).
//!
//! ## Retention (R5)
//!
//! Two AppStore knobs, read fresh at every prune cycle:
//! - `contracts.retention_days` (default 7) — age-based prune on `persisted_at`
//! - `contracts.max_rows` (default 100000) — global row cap, oldest-first (seq)
//!
//! Pruning runs at app startup and on a 60-minute interval inside the writer
//! task, deleting in 1000-row batches (`span_store.rs` delete_expired pattern).

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;
use tauri::Manager;

use super::types::SubscriptionDelivery;

// ── Constants (documented in docs/ARCHITECTURE.md) ───────────────────────────

/// AppStore key: retention window in days for `contract_events` rows.
pub const RETENTION_DAYS_KEY: &str = "contracts.retention_days";
/// AppStore key: global row cap for `contract_events`.
pub const MAX_ROWS_KEY: &str = "contracts.max_rows";
/// Default retention window (days).
pub const DEFAULT_RETENTION_DAYS: i64 = 7;
/// Default global row cap.
pub const DEFAULT_MAX_ROWS: i64 = 100_000;
/// Rows per prune delete batch.
const PRUNE_BATCH: i64 = 1000;
/// Writer flush window: deliveries are batched across ~this many milliseconds.
const WRITER_FLUSH_MS: u64 = 100;
/// Prune interval inside the writer task (60 minutes).
const WRITER_PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Bounded persistence queue capacity. Overflow sheds persistence work (R8),
/// never live deliveries.
const QUEUE_CAPACITY: usize = 4096;

// ── ContractEventStore ───────────────────────────────────────────────────────

/// SQLite-backed store for persistent-contract deliveries.
///
/// Uses the same `fredo.db` as `AppStore`, `FeatureStore`, and `SpanStore`,
/// with its own `Mutex<Connection>` for thread-safe access. Owns the
/// `contract_events` table — it never touches `telemetry_spans` or
/// FeatureStore tables.
pub struct ContractEventStore {
    conn: Mutex<Connection>,
}

impl ContractEventStore {
    /// Open (or create) `fredo.db` with WAL journal mode.
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("fredo.db");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        Ok(ContractEventStore {
            conn: Mutex::new(conn),
        })
    }

    /// Create the `contract_events` table and indexes if they don't exist.
    pub fn ensure_schema(&self) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS contract_events (
                seq            INTEGER PRIMARY KEY AUTOINCREMENT,
                delivery_id    TEXT NOT NULL UNIQUE,
                contract_name  TEXT NOT NULL,
                key_json       TEXT NOT NULL,
                session_id     TEXT NOT NULL,
                lifecycle      TEXT NOT NULL,
                payload_json   TEXT NOT NULL,
                provider       TEXT,
                timestamp      TEXT NOT NULL,
                persisted_at   TEXT NOT NULL,
                timed_out      INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_ce_contract_session
                ON contract_events(contract_name, session_id, seq);
            CREATE INDEX IF NOT EXISTS idx_ce_persisted_at
                ON contract_events(persisted_at);",
        )?;
        Ok(())
    }

    /// Insert a batch of deliveries in one transaction.
    ///
    /// `delivery_id` is UNIQUE — `INSERT OR IGNORE` keeps re-emitted
    /// deliveries idempotent (a duplicate id is ignored, not overwritten).
    /// Returns the number of rows inserted.
    pub fn insert_deliveries(&self, deliveries: &[SubscriptionDelivery]) -> Result<usize> {
        if deliveries.is_empty() {
            return Ok(0);
        }

        let conn = self.lock_conn();
        let persisted_at = Utc::now().to_rfc3339();
        let mut total = 0usize;

        conn.execute_batch("BEGIN TRANSACTION;")?;
        for delivery in deliveries {
            let key_json = serde_json::to_string(&delivery.key)?;
            let payload_json = serde_json::to_string(&delivery.payload)?;
            let session_id = delivery
                .key
                .get("sessionId")
                .cloned()
                .unwrap_or_default();
            let affected = conn.execute(
                "INSERT OR IGNORE INTO contract_events
                 (delivery_id, contract_name, key_json, session_id, lifecycle,
                  payload_json, provider, timestamp, persisted_at, timed_out)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    delivery.id,
                    delivery.contract_name,
                    key_json,
                    session_id,
                    delivery.lifecycle,
                    payload_json,
                    delivery.provider,
                    delivery.timestamp,
                    persisted_at,
                    delivery.timed_out,
                ],
            )?;
            total += affected;
        }
        conn.execute_batch("COMMIT;")?;

        Ok(total)
    }

    /// Query persisted deliveries for the given contract names (and optionally
    /// one session), ordered by `seq` ASC — the original emission order.
    ///
    /// Rows are reconstructed as the already-lifecycled `SubscriptionDelivery`
    /// records under their ORIGINAL ids (hydration replay is id-deduped
    /// downstream and never re-processed by the ECE).
    pub fn query_deliveries(
        &self,
        contract_names: &[String],
        session_id: Option<&str>,
    ) -> Result<Vec<SubscriptionDelivery>> {
        if contract_names.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = vec!["?"; contract_names.len()].join(", ");
        let mut sql = format!(
            "SELECT delivery_id, contract_name, lifecycle, key_json, payload_json,
                    provider, timestamp, timed_out
             FROM contract_events
             WHERE contract_name IN ({placeholders})"
        );
        if session_id.is_some() {
            sql.push_str(" AND session_id = ?");
        }
        sql.push_str(" ORDER BY seq ASC");

        // params_from_iter needs homogeneous values — every bind value is a String.
        let mut values: Vec<String> = contract_names.to_vec();
        if let Some(sid) = session_id {
            values.push(sid.to_string());
        }

        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
            let key_json: String = row.get(3)?;
            let payload_json: String = row.get(4)?;
            let provider: Option<String> = row.get(5)?;
            let timed_out: Option<bool> = row.get(7)?;
            Ok(SubscriptionDelivery {
                id: row.get(0)?,
                contract_name: row.get(1)?,
                lifecycle: row.get(2)?,
                key: serde_json::from_str(&key_json).unwrap_or_default(),
                payload: serde_json::from_str(&payload_json).unwrap_or_default(),
                timestamp: row.get(6)?,
                provider,
                timed_out,
            })
        })?;

        let mut deliveries = Vec::new();
        for row in rows {
            deliveries.push(row?);
        }
        Ok(deliveries)
    }

    /// Retention prune: (1) delete rows older than `retention_days` on
    /// `persisted_at`, then (2) enforce the `max_rows` global cap by deleting
    /// the OLDEST rows (lowest seq) first. Deletes run in 1000-row batches.
    /// Returns the total number of rows deleted.
    pub fn prune(&self, retention_days: i64, max_rows: i64) -> Result<u64> {
        let cutoff = (Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
        let conn = self.lock_conn();
        let mut total_deleted = 0u64;

        // 1. Age-based prune (persisted_at index).
        loop {
            let deleted = conn.execute(
                "DELETE FROM contract_events WHERE seq IN (
                    SELECT seq FROM contract_events WHERE persisted_at < ?1 LIMIT ?2
                )",
                params![cutoff, PRUNE_BATCH],
            )? as u64;
            if deleted == 0 {
                break;
            }
            total_deleted += deleted;
            conn.execute_batch("PRAGMA incremental_vacuum;")?;
        }

        // 2. Row-cap prune, oldest-first (seq ASC). The count is re-read each
        //    batch so concurrent inserts are respected; the newest rows are
        //    always the last to go (no off-by-one drop of the newest event).
        loop {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM contract_events",
                [],
                |row| row.get(0),
            )?;
            let excess = count - max_rows;
            if excess <= 0 {
                break;
            }
            let batch = excess.min(PRUNE_BATCH);
            let deleted = conn.execute(
                "DELETE FROM contract_events WHERE seq IN (
                    SELECT seq FROM contract_events ORDER BY seq ASC LIMIT ?1
                )",
                params![batch],
            )? as u64;
            if deleted == 0 {
                break;
            }
            total_deleted += deleted;
            conn.execute_batch("PRAGMA incremental_vacuum;")?;
        }

        Ok(total_deleted)
    }

    /// Current row count (test/diagnostic helper).
    pub fn row_count(&self) -> Result<i64> {
        let conn = self.lock_conn();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM contract_events", [], |row| row.get(0))?;
        Ok(count)
    }

    /// Lock the connection, recovering from poisoning (no `unwrap`).
    fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

// ── ContractEventWriter (non-blocking enqueue handle) ────────────────────────

/// Non-blocking enqueue handle for persistent-contract deliveries.
///
/// Held by `EventBus` (Tauri state). `enqueue` is called from inside
/// `EventBus.emit_delivery` — it must NEVER block: it is a `try_send` on a
/// bounded channel, and a full queue sheds the persistence work (counted) so
/// live delivery stays at-most-once and fast (R8).
#[derive(Debug)]
pub struct ContractEventWriter {
    /// Names of currently-registered persistent contracts. Populated by the
    /// `register_event_contracts` command; never shrinks on deregistration
    /// (persistent contracts survive unmount by design).
    persistent_contracts: RwLock<HashSet<String>>,
    tx: tokio::sync::mpsc::Sender<SubscriptionDelivery>,
    dropped: AtomicU64,
}

impl ContractEventWriter {
    /// Create the writer and its bounded receiving end. The receiver is
    /// passed to `run_writer_task` (spawned by lib.rs).
    pub fn new() -> (Arc<Self>, tokio::sync::mpsc::Receiver<SubscriptionDelivery>) {
        let (tx, rx) = tokio::sync::mpsc::channel(QUEUE_CAPACITY);
        (
            Arc::new(ContractEventWriter {
                persistent_contracts: RwLock::new(HashSet::new()),
                tx,
                dropped: AtomicU64::new(0),
            }),
            rx,
        )
    }

    /// Record persistent contract names after a successful
    /// `register_event_contracts` call. Idempotent — a set.
    pub fn register_persistent(&self, names: &[String]) {
        if let Ok(mut set) = self.persistent_contracts.write() {
            set.extend(names.iter().cloned());
        }
    }

    /// Whether a contract name is registered as persistent.
    pub fn is_persistent(&self, contract_name: &str) -> bool {
        match self.persistent_contracts.read() {
            Ok(set) => set.contains(contract_name),
            Err(_) => false,
        }
    }

    /// Non-blocking enqueue of a persistent-contract delivery.
    ///
    /// Overflow (or a closed channel) SHEDS the persistence work — the count
    /// is bumped and a warning logged — and never blocks the emit path.
    pub fn enqueue(&self, delivery: &SubscriptionDelivery) {
        if !self.is_persistent(&delivery.contract_name) {
            return;
        }
        if let Err(e) = self.tx.try_send(delivery.clone()) {
            let _ = self.dropped.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                target: "fredo::comm",
                contract = %delivery.contract_name,
                delivery_id = %delivery.id,
                error = %e,
                "contract-event persistence enqueue dropped (queue full or closed) — live delivery unaffected"
            );
        }
    }

    /// Number of persistence enqueues shed due to queue overflow.
    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

// ── Writer task ──────────────────────────────────────────────────────────────

/// Dedicated writer task: drains the bounded persistence queue in ~100 ms
/// batches and runs retention pruning at startup of the loop and on a 60-minute
/// interval. Spawned by lib.rs via `tauri::async_runtime::spawn`.
pub async fn run_writer_task(
    app: tauri::AppHandle,
    mut rx: tokio::sync::mpsc::Receiver<SubscriptionDelivery>,
) {
    let mut last_prune = tokio::time::Instant::now();
    loop {
        // Wait up to the flush window for the first item of a batch.
        let first = tokio::time::timeout(Duration::from_millis(WRITER_FLUSH_MS), rx.recv()).await;
        match first {
            Ok(Some(delivery)) => {
                let mut batch = vec![delivery];
                // Drain everything already queued — one transaction per batch.
                while let Ok(delivery) = rx.try_recv() {
                    batch.push(delivery);
                }
                if let Some(store) = app.try_state::<Arc<ContractEventStore>>() {
                    if let Err(e) = store.insert_deliveries(&batch) {
                        tracing::error!(
                            target: "fredo::comm",
                            error = %e,
                            count = batch.len(),
                            "contract-event batch insert failed"
                        );
                    }
                }
            }
            Ok(None) => break, // channel closed — all senders dropped
            Err(_elapsed) => {} // flush window elapsed with nothing queued
        }

        if last_prune.elapsed() >= WRITER_PRUNE_INTERVAL {
            prune_with_knobs(&app);
            last_prune = tokio::time::Instant::now();
        }
    }
}

/// Run one prune cycle using the current AppStore knob values.
fn prune_with_knobs(app: &tauri::AppHandle) {
    let Some(store) = app.try_state::<Arc<ContractEventStore>>() else {
        return;
    };
    let app_store = app.state::<Arc<crate::infrastructure::storage::AppStore>>();
    let retention_days = app_store
        .get(RETENTION_DAYS_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS);
    let max_rows = app_store
        .get(MAX_ROWS_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_MAX_ROWS);

    match store.prune(retention_days, max_rows) {
        Ok(deleted) => {
            if deleted > 0 {
                tracing::info!(
                    target: "fredo::comm",
                    deleted,
                    retention_days,
                    max_rows,
                    "contract_events retention prune"
                );
            }
        }
        Err(e) => {
            tracing::error!(target: "fredo::comm", error = %e, "contract_events prune failed");
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_store() -> ContractEventStore {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch("PRAGMA journal_mode=WAL;").ok();
        ContractEventStore {
            conn: Mutex::new(conn),
        }
    }

    fn make_delivery(id: &str, contract: &str, session: &str, lifecycle: &str) -> SubscriptionDelivery {
        let mut key = HashMap::new();
        key.insert("sessionId".to_string(), session.to_string());
        key.insert("correlationId".to_string(), format!("corr-{id}"));
        SubscriptionDelivery {
            id: id.to_string(),
            contract_name: contract.to_string(),
            lifecycle: lifecycle.to_string(),
            key,
            payload: serde_json::json!({ "text": format!("payload of {id}") }),
            timestamp: Utc::now().to_rfc3339(),
            provider: Some("open_code".to_string()),
            timed_out: None,
        }
    }

    fn make_store_with_schema() -> ContractEventStore {
        let store = make_store();
        store.ensure_schema().expect("schema");
        store
    }

    // ── Schema ───────────────────────────────────────────────────────────────

    #[test]
    fn ensure_schema_creates_table_and_indexes() {
        let store = make_store_with_schema();
        let conn = store.lock_conn();
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='contract_events'",
                [],
                |row| row.get(0),
            )
            .expect("query");
        assert_eq!(table_count, 1, "contract_events table should exist");

        let mut stmt = conn
            .prepare("SELECT name FROM pragma_index_list('contract_events')")
            .expect("prepare");
        let indexes: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query_map")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect");
        assert!(indexes.contains(&"idx_ce_contract_session".to_string()));
        assert!(indexes.contains(&"idx_ce_persisted_at".to_string()));
    }

    // ── Insert + dedupe on delivery_id ───────────────────────────────────────

    #[test]
    fn insert_deliveries_returns_count() {
        let store = make_store_with_schema();
        let rows = vec![
            make_delivery("d1", "chat-node", "ses-1", "init"),
            make_delivery("d2", "chat-node", "ses-1", "end"),
        ];
        let inserted = store.insert_deliveries(&rows).expect("insert");
        assert_eq!(inserted, 2);
        assert_eq!(store.row_count().expect("count"), 2);
    }

    #[test]
    fn insert_deliveries_empty_slice_is_noop() {
        let store = make_store_with_schema();
        let inserted = store.insert_deliveries(&[]).expect("insert");
        assert_eq!(inserted, 0);
    }

    #[test]
    fn insert_dedupes_on_delivery_id() {
        let store = make_store_with_schema();

        let first = store
            .insert_deliveries(&[make_delivery("dup", "chat-node", "ses-1", "init")])
            .expect("first insert");
        assert_eq!(first, 1);

        // Same delivery_id re-emitted (e.g. racing call-sites) — ignored.
        let second = store
            .insert_deliveries(&[make_delivery("dup", "chat-node", "ses-1", "init")])
            .expect("second insert");
        assert_eq!(second, 0, "duplicate delivery_id should be ignored");
        assert_eq!(store.row_count().expect("count"), 1);
    }

    // ── Hydrate ordering by seq (R3/R9 mechanics) ────────────────────────────

    #[test]
    fn query_returns_rows_in_emission_order() {
        let store = make_store_with_schema();
        // Insert "out of id order" — seq is assigned at INSERT time, so ASC seq
        // reproduces the EMISSION order (what hydration must replay), which is
        // independent of the delivery ids.
        let rows = vec![
            make_delivery("d3", "chat-node", "ses-1", "end"),
            make_delivery("d1", "chat-node", "ses-1", "init"),
            make_delivery("d2", "chat-node", "ses-1", "update"),
        ];
        store.insert_deliveries(&rows).expect("insert");

        let hydrated = store
            .query_deliveries(&["chat-node".to_string()], None)
            .expect("query");
        let ids: Vec<&str> = hydrated.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["d3", "d1", "d2"],
            "rows must come back in seq ASC (emission) order"
        );
    }

    #[test]
    fn query_reconstructs_original_delivery_fields() {
        let store = make_store_with_schema();
        let mut delivery = make_delivery("d1", "chat-node", "ses-1", "end");
        delivery.timed_out = Some(true);
        store.insert_deliveries(&[delivery]).expect("insert");

        let hydrated = store
            .query_deliveries(&["chat-node".to_string()], None)
            .expect("query");
        assert_eq!(hydrated.len(), 1);
        let d = &hydrated[0];
        assert_eq!(d.id, "d1", "original delivery id preserved");
        assert_eq!(d.contract_name, "chat-node");
        assert_eq!(d.lifecycle, "end");
        assert_eq!(d.timed_out, Some(true), "re-keyed timed-out ends replay faithfully");
        assert_eq!(
            d.key.get("sessionId").map(String::as_str),
            Some("ses-1"),
            "composite key round-trips through key_json"
        );
        assert_eq!(d.payload["text"], "payload of d1");
    }

    #[test]
    fn query_filters_by_contract_and_session() {
        let store = make_store_with_schema();
        let rows = vec![
            make_delivery("a1", "contract-a", "ses-1", "init"),
            make_delivery("a2", "contract-a", "ses-2", "init"),
            make_delivery("b1", "contract-b", "ses-1", "init"),
        ];
        store.insert_deliveries(&rows).expect("insert");

        let only_a = store
            .query_deliveries(&["contract-a".to_string()], None)
            .expect("query");
        assert_eq!(only_a.len(), 2);

        let a_ses2 = store
            .query_deliveries(&["contract-a".to_string()], Some("ses-2"))
            .expect("query");
        assert_eq!(a_ses2.len(), 1);
        assert_eq!(a_ses2[0].id, "a2");

        let both = store
            .query_deliveries(&["contract-a".to_string(), "contract-b".to_string()], Some("ses-1"))
            .expect("query");
        assert_eq!(both.len(), 2, "multi-contract query works");

        let empty: Vec<String> = Vec::new();
        let none = store.query_deliveries(&empty, None).expect("query");
        assert!(none.is_empty(), "empty contract list returns nothing");
    }

    // ── Retention prune: age + max_rows cap, oldest-first (R5) ───────────────

    #[test]
    fn prune_deletes_rows_older_than_retention_days() {
        let store = make_store_with_schema();
        store
            .insert_deliveries(&[
                make_delivery("old", "chat-node", "ses-1", "end"),
                make_delivery("fresh", "chat-node", "ses-1", "end"),
            ])
            .expect("insert");

        // Backdate one row beyond the retention window.
        {
            let conn = store.lock_conn();
            conn.execute(
                "UPDATE contract_events SET persisted_at = '2020-01-01T00:00:00+00:00'
                 WHERE delivery_id = 'old'",
                [],
            )
            .expect("backdate");
        }

        let deleted = store.prune(1, 100_000).expect("prune");
        assert_eq!(deleted, 1, "the aged-out row should be deleted");

        let remaining = store
            .query_deliveries(&["chat-node".to_string()], None)
            .expect("query");
        let ids: Vec<&str> = remaining.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["fresh"], "fresh rows survive");
    }

    #[test]
    fn prune_enforces_max_rows_cap_oldest_first() {
        let store = make_store_with_schema();
        let rows: Vec<SubscriptionDelivery> = (0..10)
            .map(|i| make_delivery(&format!("r{i}"), "chat-node", "ses-1", "update"))
            .collect();
        store.insert_deliveries(&rows).expect("insert");

        let deleted = store.prune(7, 5).expect("prune");
        assert_eq!(deleted, 5, "cap 100000→5 rows deletes the 5 oldest");

        let remaining = store
            .query_deliveries(&["chat-node".to_string()], None)
            .expect("query");
        let ids: Vec<&str> = remaining.iter().map(|d| d.id.as_str()).collect();
        // Oldest-first: the five lowest seqs (r0..r4) are gone.
        assert_eq!(ids, vec!["r5", "r6", "r7", "r8", "r9"], "newest rows survive the cap");
    }

    #[test]
    fn prune_at_exact_cap_deletes_nothing() {
        let store = make_store_with_schema();
        let rows: Vec<SubscriptionDelivery> = (0..5)
            .map(|i| make_delivery(&format!("c{i}"), "chat-node", "ses-1", "update"))
            .collect();
        store.insert_deliveries(&rows).expect("insert");

        let deleted = store.prune(7, 5).expect("prune");
        assert_eq!(deleted, 0, "exactly-at-cap boundary: no off-by-one drop");
        assert_eq!(store.row_count().expect("count"), 5);
    }

    #[test]
    fn prune_noop_when_under_both_limits() {
        let store = make_store_with_schema();
        store
            .insert_deliveries(&[make_delivery("keep", "chat-node", "ses-1", "init")])
            .expect("insert");
        let deleted = store.prune(365, 100_000).expect("prune");
        assert_eq!(deleted, 0);
    }

    // ── ContractEventWriter: persistence gating + overflow shedding (R8) ─────

    fn writer_delivery(id: &str, contract: &str) -> SubscriptionDelivery {
        let mut key = HashMap::new();
        key.insert("sessionId".to_string(), "ses-w".to_string());
        SubscriptionDelivery {
            id: id.to_string(),
            contract_name: contract.to_string(),
            lifecycle: "init".to_string(),
            key,
            payload: serde_json::json!({}),
            timestamp: Utc::now().to_rfc3339(),
            provider: None,
            timed_out: None,
        }
    }

    #[tokio::test]
    async fn writer_enqueues_only_persistent_contracts() {
        let (writer, mut rx) = ContractEventWriter::new();
        writer.register_persistent(&["persistent-contract".to_string()]);

        writer.enqueue(&writer_delivery("p1", "persistent-contract"));
        writer.enqueue(&writer_delivery("n1", "non-persistent-contract"));

        let mut received = Vec::new();
        while let Ok(d) = rx.try_recv() {
            received.push(d);
        }
        assert_eq!(received.len(), 1, "non-persistent deliveries are never enqueued");
        assert_eq!(received[0].id, "p1");
        assert_eq!(writer.dropped_count(), 0);
    }

    #[tokio::test]
    async fn queue_overflow_sheds_persistence_not_deliveries() {
        // Capacity 1: first enqueue buffers, the rest are shed immediately.
        let (writer, mut rx) = tokio::sync::mpsc::channel(1);
        let writer = {
            let w = ContractEventWriter {
                persistent_contracts: RwLock::new(HashSet::from(["p".to_string()])),
                tx: writer,
                dropped: AtomicU64::new(0),
            };
            Arc::new(w)
        };

        for i in 0..10 {
            // Every call must return immediately (non-blocking) — the live
            // emit path that calls this is never delayed or dropped.
            writer.enqueue(&writer_delivery(&format!("overflow-{i}"), "p"));
        }

        assert_eq!(writer.dropped_count(), 9, "9 of 10 enqueues shed on a full queue");
        // The one buffered item is intact — the delivery object itself was
        // never blocked or lost by the emit path.
        let buffered = rx.try_recv().expect("first enqueue is buffered");
        assert_eq!(buffered.id, "overflow-0");
    }

    #[test]
    fn register_persistent_is_idempotent() {
        let (writer, _rx) = ContractEventWriter::new();
        writer.register_persistent(&["a".to_string()]);
        writer.register_persistent(&["a".to_string(), "b".to_string()]);
        assert!(writer.is_persistent("a"));
        assert!(writer.is_persistent("b"));
        assert!(!writer.is_persistent("c"), "unregistered names are not persistent");
    }

    // ── End-to-end micro-pipeline: writer → store ────────────────────────────

    #[tokio::test]
    async fn writer_rows_land_in_store_in_order() {
        let store = make_store_with_schema();
        let (writer, mut rx) = ContractEventWriter::new();
        writer.register_persistent(&["chat-node".to_string()]);

        let batch: Vec<SubscriptionDelivery> = (0..5)
            .map(|i| make_delivery(&format!("w{i}"), "chat-node", "ses-1", "update"))
            .collect();
        for d in &batch {
            writer.enqueue(d);
        }
        // Drain like run_writer_task does, then insert in one batch.
        let mut drained = Vec::new();
        while let Ok(d) = rx.try_recv() {
            drained.push(d);
        }
        let inserted = store.insert_deliveries(&drained).expect("insert");
        assert_eq!(inserted, 5);

        let hydrated = store
            .query_deliveries(&["chat-node".to_string()], None)
            .expect("query");
        let ids: Vec<&str> = hydrated.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["w0", "w1", "w2", "w3", "w4"]);
    }
}
