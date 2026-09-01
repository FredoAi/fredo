//! RTDB flush loop (Spec #2788, P2.3, REQs R-1c/R-2a).
//!
//! Pending [`RowDelivery`] envelopes coalesce per query: at most ONE emission
//! per query per flush window (~30 ms default; a query registered with
//! `flush_ms: 0` bypasses coalescing and emits immediately). Within a window,
//! later patches for the SAME key replace the earlier pending one per-key
//! (keeping the highest seq — see [`coalesce`]); different keys batch
//! together into one emission.
//!
//! Emission goes through an injected [`RowEmitter`]. In the app, lib.rs wires
//! the emitter to the EventBus's `emit_row_delivery` — the ONLY sanctioned
//! RTDB emission path (never `app_handle.emit` directly). Tests inject a
//! capture sink instead, which keeps the coalescing semantics testable
//! without a Tauri runtime.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::infrastructure::rtdb::project::{rfc3339_now, RowChangeKind, RowDelivery, RowKey};

/// Default coalescing window in milliseconds (~30 ms per the design).
pub const DEFAULT_FLUSH_MS: u64 = 30;
/// Poll cadence of the background flush task — worst-case added latency on
/// top of a query's window.
const FLUSH_POLL_MS: u64 = 5;

/// Emission sink for coalesced batches. One call = one emission for one query
/// (the batch holds every pending key of that query).
pub type RowEmitter = Arc<dyn Fn(&[RowDelivery]) + Send + Sync>;

struct QueryWindow {
    flush_ms: u64,
    /// When `Some`, the query is armed and flushes at this instant.
    deadline: Option<Instant>,
    /// One pending delivery per key (per-key replacement).
    pending: HashMap<RowKey, RowDelivery>,
}

#[derive(Default)]
struct FlushInner {
    queries: HashMap<String, QueryWindow>,
}

/// Per-query coalescing flush loop over RowDelivery envelopes.
pub struct FlushLoop {
    inner: Mutex<FlushInner>,
    emitter: RowEmitter,
}

/// Result of folding an incoming delivery into a pending one.
enum Coalesced {
    Keep(RowDelivery),
    /// The pending entry disappears (net-no-op for the client).
    Drop,
}

/// Fold `next` into pending `prev` for the same (query, key).
///
/// Net-effect semantics — the client must end up with the correct final row
/// state whether the two deliveries are coalesced here or already arrived
/// separately:
/// - `next` Remove + pending Insert → [`Coalesced::Drop`]: the client never
///   saw the key (the insert is still unflushed), so emitting insert+remove
///   would be churn. `remove` is retention-eviction-only (R-2d) and this is
///   the only way a remove trails a pending insert.
/// - `next` Remove + pending Update → keep the remove envelope (max seq):
///   the client holds the row from an earlier emission.
/// - pending Remove + non-remove → forward `next` untouched: the registry
///   clears membership on eviction, so a reappearance is always a fresh
///   full-row insert.
/// - Otherwise → the highest kind wins (an insert patch is the full row and
///   dominates a partial update), and patch fragments overlay in seq order so
///   the highest-seq value of every field survives.
fn coalesce(prev: RowDelivery, next: RowDelivery) -> Coalesced {
    let seq = prev.seq.max(next.seq);
    if next.kind == RowChangeKind::Remove {
        return if prev.kind == RowChangeKind::Insert {
            Coalesced::Drop
        } else {
            Coalesced::Keep(RowDelivery { seq, ..next })
        };
    }
    if prev.kind == RowChangeKind::Remove {
        return Coalesced::Keep(next);
    }
    let kind = if prev.kind == RowChangeKind::Insert || next.kind == RowChangeKind::Insert {
        RowChangeKind::Insert
    } else {
        RowChangeKind::Update
    };
    let mut fragments = [(prev.seq, prev.patch), (next.seq, next.patch)];
    fragments.sort_by_key(|(fragment_seq, _)| *fragment_seq);
    let mut merged = serde_json::Map::new();
    for (_, fragment) in fragments {
        if let Some(serde_json::Value::Object(fields)) = fragment {
            for (name, value) in fields {
                merged.insert(name, value);
            }
        }
    }
    Coalesced::Keep(RowDelivery {
        query_id: next.query_id,
        event_type: next.event_type,
        kind,
        seq,
        key: next.key,
        patch: Some(serde_json::Value::Object(merged)),
        timestamp: rfc3339_now(),
    })
}

impl FlushLoop {
    /// Create the loop with the given emission sink.
    pub fn new(emitter: RowEmitter) -> Self {
        FlushLoop {
            inner: Mutex::new(FlushInner::default()),
            emitter,
        }
    }

    /// Configure the flush window (ms) of a query. `0` = immediate emission
    /// (bypasses coalescing). Called at subscribe time.
    pub fn set_window(&self, query_id: &str, flush_ms: u64) {
        let mut inner = self.lock();
        inner
            .queries
            .entry(query_id.to_string())
            .or_insert_with(|| QueryWindow {
                flush_ms,
                deadline: None,
                pending: HashMap::new(),
            })
            .flush_ms = flush_ms;
    }

    /// Queue one delivery for its query. Immediate queries emit right away;
    /// coalesced queries merge per-key (replacing the earlier pending patch,
    /// keeping the highest seq) and arm the window deadline on first enqueue.
    pub fn enqueue(&self, delivery: RowDelivery) {
        let flush_ms = {
            let mut inner = self.lock();
            inner
                .queries
                .entry(delivery.query_id.clone())
                .or_insert_with(|| QueryWindow {
                    flush_ms: DEFAULT_FLUSH_MS,
                    deadline: None,
                    pending: HashMap::new(),
                })
                .flush_ms
        };
        if flush_ms == 0 {
            (self.emitter)(std::slice::from_ref(&delivery));
            return;
        }
        let key = delivery.key.clone();
        let mut inner = self.lock();
        let Some(window) = inner.queries.get_mut(&delivery.query_id) else {
            return;
        };
        if window.deadline.is_none() {
            window.deadline =
                Some(Instant::now() + Duration::from_millis(window.flush_ms));
        }
        let coalesced = match window.pending.remove(&key) {
            Some(prev) => coalesce(prev, delivery),
            None => Coalesced::Keep(delivery),
        };
        if let Coalesced::Keep(merged) = coalesced {
            window.pending.insert(key, merged);
        }
    }

    /// Emit every armed query whose deadline has passed (one emission per
    /// query, all pending keys batched). Returns the number of deliveries
    /// emitted. Called by the background task; tests call it directly for
    /// deterministic timing.
    pub fn flush_due(&self) -> usize {
        let now = Instant::now();
        let mut batches: Vec<Vec<RowDelivery>> = Vec::new();
        {
            let mut inner = self.lock();
            for window in inner.queries.values_mut() {
                let Some(deadline) = window.deadline else {
                    continue;
                };
                if deadline > now || window.pending.is_empty() {
                    continue;
                }
                batches.push(window.pending.drain().map(|(_, d)| d).collect());
                window.deadline = None;
            }
        }
        let emitted = batches.iter().map(Vec::len).sum();
        for batch in batches {
            (self.emitter)(&batch);
        }
        emitted
    }

    /// Drop a query's pending state (unsubscribe). Pending unflushed
    /// deliveries for the query are discarded — the client asked to stop.
    pub fn drop_query(&self, query_id: &str) {
        self.lock().queries.remove(query_id);
    }

    /// Total pending deliveries across all queries (tests/diagnostics).
    pub fn pending_count(&self) -> usize {
        self.lock()
            .queries
            .values()
            .map(|window| window.pending.len())
            .sum()
    }

    fn lock(&self) -> MutexGuard<'_, FlushInner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// Background flush task: polls [`FlushLoop::flush_due`] at a fixed cadence.
/// Spawned by lib.rs via `tauri::async_runtime::spawn`.
pub async fn run_flush_task(flush: Arc<FlushLoop>) {
    loop {
        tokio::time::sleep(Duration::from_millis(FLUSH_POLL_MS)).await;
        flush.flush_due();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::project::RowKey;
    use crate::infrastructure::rtdb::query::EventTypeArg;
    use std::sync::Mutex;

    // ── Fixtures ────────────────────────────────────────────────────────────

    type Sink = Arc<Mutex<Vec<RowDelivery>>>;

    fn sink_loop() -> (FlushLoop, Sink) {
        let sink: Sink = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&sink);
        let loop_ = FlushLoop::new(Arc::new(move |deliveries: &[RowDelivery]| {
            capture
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(deliveries);
        }));
        (loop_, sink)
    }

    fn key(session: &str, correlation: &str) -> RowKey {
        RowKey {
            session_id: session.to_string(),
            correlation_id: correlation.to_string(),
        }
    }

    fn delivery(query: &str, kind: RowChangeKind, seq: i64, k: &RowKey, fields: &[(&str, serde_json::Value)]) -> RowDelivery {
        let mut patch = serde_json::Map::new();
        for (name, value) in fields {
            patch.insert((*name).to_string(), value.clone());
        }
        RowDelivery {
            query_id: query.to_string(),
            event_type: EventTypeArg::Chat,
            kind,
            seq,
            key: k.clone(),
            patch: Some(serde_json::Value::Object(patch)),
            timestamp: rfc3339_now(),
        }
    }

    fn emitted(sink: &Sink) -> Vec<RowDelivery> {
        sink.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    // ── Coalescing: per-key replacement, batching, windowing ────────────────

    #[test]
    fn later_patch_replaces_pending_per_key_keeping_highest_seq_and_newest_values() {
        let (loop_, sink) = sink_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        let k = key("s", "c1");
        loop_.enqueue(delivery(
            "q1",
            RowChangeKind::Insert,
            1,
            &k,
            &[("userMessage", serde_json::json!("q")), ("agentReply", serde_json::json!("stale"))],
        ));
        loop_.enqueue(delivery(
            "q1",
            RowChangeKind::Update,
            2,
            &k,
            &[("agentReply", serde_json::json!("fresh"))],
        ));
        assert_eq!(loop_.pending_count(), 1, "one pending entry per key");
        assert!(emitted(&sink).is_empty(), "window not elapsed yet");
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 1);

        let out = emitted(&sink);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, RowChangeKind::Insert, "insert dominates update");
        assert_eq!(out[0].seq, 2, "highest seq wins");
        let patch = out[0].patch.as_ref().and_then(|p| p.as_object()).expect("patch object");
        assert_eq!(patch.get("agentReply"), Some(&serde_json::json!("fresh")), "highest-seq field value wins");
        assert_eq!(patch.get("userMessage"), Some(&serde_json::json!("q")), "insert fragment survives the fold");
    }

    #[test]
    fn seq_order_decides_overlay_even_when_enqueue_order_differs() {
        // A stale-seq delivery arriving after a fresh one must not regress
        // field values (replay inserts can race live mutations).
        let (loop_, sink) = sink_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        let k = key("s", "c1");
        loop_.enqueue(delivery(
            "q1",
            RowChangeKind::Insert,
            2,
            &k,
            &[("agentReply", serde_json::json!("fresh"))],
        ));
        loop_.enqueue(delivery(
            "q1",
            RowChangeKind::Update,
            1,
            &k,
            &[("agentReply", serde_json::json!("stale"))],
        ));
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        loop_.flush_due();
        let out = emitted(&sink);
        assert_eq!(out.len(), 1);
        let patch = out[0].patch.as_ref().and_then(|p| p.as_object()).expect("patch object");
        assert_eq!(patch.get("agentReply"), Some(&serde_json::json!("fresh")));
        assert_eq!(out[0].seq, 2);
    }

    #[test]
    fn different_keys_batch_together_in_one_emission() {
        let (loop_, sink) = sink_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c2"), &[]));
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c3"), &[]));
        assert_eq!(loop_.pending_count(), 3);
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 3);
        assert_eq!(emitted(&sink).len(), 3, "all keys batched in one emission");
        assert_eq!(loop_.pending_count(), 0, "window drained");
    }

    #[test]
    fn queries_flush_independently() {
        let (loop_, sink) = sink_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        loop_.set_window("q2", 500);
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        loop_.enqueue(delivery("q2", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 1, "only q1's window elapsed");
        let out = emitted(&sink);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].query_id, "q1");
    }

    #[test]
    fn zero_flush_ms_emits_immediately_bypassing_coalescing() {
        let (loop_, sink) = sink_loop();
        loop_.set_window("q0", 0);
        loop_.enqueue(delivery("q0", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        assert_eq!(emitted(&sink).len(), 1, "emitted synchronously on enqueue");
        assert_eq!(loop_.pending_count(), 0);
        loop_.enqueue(delivery("q0", RowChangeKind::Update, 2, &key("s", "c1"), &[]));
        assert_eq!(emitted(&sink).len(), 2, "no coalescing — every delivery emits");
    }

    // ── Remove semantics (R-2d: remove is retention-eviction-only) ─────────

    #[test]
    fn remove_supersedes_pending_insert_to_a_net_noop() {
        let (loop_, sink) = sink_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        let k = key("s", "c1");
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &k, &[("seq", serde_json::json!(1))]));
        loop_.enqueue(RowDelivery {
            query_id: "q1".to_string(),
            event_type: EventTypeArg::Chat,
            kind: RowChangeKind::Remove,
            seq: 1,
            key: k.clone(),
            patch: None,
            timestamp: rfc3339_now(),
        });
        assert_eq!(loop_.pending_count(), 0, "pending insert+remove cancels out");
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        loop_.flush_due();
        assert!(emitted(&sink).is_empty(), "client never saw the key — nothing to deliver");
    }

    #[test]
    fn remove_supersedes_pending_update_for_a_client_holding_the_row() {
        let (loop_, sink) = sink_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        let k = key("s", "c1");
        // The client already received the insert (flushed in an earlier
        // window); a pending update + eviction must still deliver the remove.
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &k, &[]));
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        loop_.flush_due();

        loop_.enqueue(delivery("q1", RowChangeKind::Update, 2, &k, &[("agentReply", serde_json::json!("x"))]));
        loop_.enqueue(RowDelivery {
            query_id: "q1".to_string(),
            event_type: EventTypeArg::Chat,
            kind: RowChangeKind::Remove,
            seq: 2,
            key: k.clone(),
            patch: None,
            timestamp: rfc3339_now(),
        });
        assert_eq!(loop_.pending_count(), 1);
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        loop_.flush_due();
        let out = emitted(&sink);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].kind, RowChangeKind::Remove);
        assert_eq!(out[1].patch, None);
        assert_eq!(out[1].seq, 2);
    }

    // ── Unsubscribe drops pending ───────────────────────────────────────────

    #[test]
    fn drop_query_discards_pending_deliveries() {
        let (loop_, sink) = sink_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        loop_.drop_query("q1");
        assert_eq!(loop_.pending_count(), 0);
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        loop_.flush_due();
        assert!(emitted(&sink).is_empty(), "unsubscribed query emits nothing");
    }

    // ── Background task drains due windows ──────────────────────────────────

    #[tokio::test]
    async fn run_flush_task_drains_due_windows_without_manual_flush() {
        let (loop_, sink) = sink_loop();
        let task_loop = Arc::new(loop_);
        let handle = tauri::async_runtime::spawn({
            let task_loop = Arc::clone(&task_loop);
            async move { run_flush_task(task_loop).await }
        });
        task_loop.set_window("q1", DEFAULT_FLUSH_MS);
        task_loop.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        tokio::time::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 100)).await;
        assert_eq!(
            emitted(&sink).len(),
            1,
            "the spawned task must deliver without a manual flush_due"
        );
        handle.abort();
    }
}
