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
//! the emitter to the EventBus's `emit_row_delivery_batch` — the ONLY
//! sanctioned RTDB emission path (never `app_handle.emit` directly). Each
//! emitter call is ONE batch IPC envelope (`{"rowBatch": [...]}`); a drained
//! window larger than [`RTDB_MAX_EMISSION_BATCH`] is split into multiple
//! emitter calls WITHIN the same `flush_due` invocation — zero added latency.
//! Tests inject a capture sink instead, which keeps the coalescing semantics
//! testable without a Tauri runtime.
//!
//! Replay completion (round-3 F-33 fix): the replay leg now drains in the
//! background off the command thread, so the frontend needs a deterministic
//! settle signal. [`FlushLoop::mark_replay_complete`] arms a per-query
//! completion marker; the LAST emitter call of that query's drain carries
//! `replayCompleteQueryId` (a >512-row drain marks only its final chunk), and
//! a query with nothing left pending emits ONE terminal EMPTY envelope with
//! the marker. Live-only emissions never carry the marker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::infrastructure::rtdb::project::{rfc3339_now, RowChangeKind, RowDelivery, RowKey};

/// Default coalescing window in milliseconds (~30 ms per the design).
pub const DEFAULT_FLUSH_MS: u64 = 30;
/// Poll cadence of the background flush task — worst-case added latency on
/// top of a query's window.
const FLUSH_POLL_MS: u64 = 5;
/// Maximum deliveries per emitter call = per batch IPC envelope (F-33 fix,
/// W-1). A replay of ~58k rows drains as ~113 emitter calls instead of ~58k
/// individual IPC events. Chunking is intra-window: all chunks of a drained
/// window emit in the same `flush_due` call — zero added latency.
pub const RTDB_MAX_EMISSION_BATCH: usize = 512;

/// Emission sink for coalesced batches. One call = one emission for one query
/// (the batch holds every pending key of that query). The second argument is
/// the replay-completion marker: `Some(query_id)` ONLY on the terminal
/// emission of that query's replay drain (round-3 F-33 fix), `None` on every
/// live emission.
pub type RowEmitter = Arc<dyn Fn(&[RowDelivery], Option<&str>) + Send + Sync>;

struct QueryWindow {
    flush_ms: u64,
    /// When `Some`, the query is armed and flushes at this instant.
    deadline: Option<Instant>,
    /// One pending delivery per key (per-key replacement).
    pending: HashMap<RowKey, RowDelivery>,
    /// Set by [`FlushLoop::mark_replay_complete`]: the next drain of this
    /// query marks its LAST chunk with the replay-complete marker, which is
    /// then cleared (round-3 F-33 fix).
    complete_pending: bool,
    /// One-shot latch — the completion marker is signalled at most once per
    /// subscription (a window's lifetime is exactly one registration).
    replay_completed: bool,
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
                complete_pending: false,
                replay_completed: false,
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
                    complete_pending: false,
                    replay_completed: false,
                })
                .flush_ms
        };
        if flush_ms == 0 {
            (self.emitter)(std::slice::from_ref(&delivery), None);
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
    /// query, all pending keys batched; windows larger than
    /// [`RTDB_MAX_EMISSION_BATCH`] split into multiple emitter calls within
    /// this same invocation). Returns the number of deliveries emitted.
    /// Called by the background task; tests call it directly for
    /// deterministic timing.
    ///
    /// A query armed with the replay-completion marker
    /// ([`FlushLoop::mark_replay_complete`]) marks its LAST chunk with the
    /// marker (round-3 F-33 fix); the flag clears with the drain.
    pub fn flush_due(&self) -> usize {
        let now = Instant::now();
        // (query_id, drained deliveries, carries completion marker)
        let mut batches: Vec<(String, Vec<RowDelivery>, bool)> = Vec::new();
        {
            let mut inner = self.lock();
            for (query_id, window) in inner.queries.iter_mut() {
                let Some(deadline) = window.deadline else {
                    continue;
                };
                if deadline > now || window.pending.is_empty() {
                    continue;
                }
                let marker = window.complete_pending;
                window.complete_pending = false;
                batches.push((
                    query_id.clone(),
                    window.pending.drain().map(|(_, d)| d).collect(),
                    marker,
                ));
                window.deadline = None;
            }
        }
        let mut emitted = 0;
        for (query_id, batch, marker) in batches {
            let last_chunk = batch.len().div_ceil(RTDB_MAX_EMISSION_BATCH).saturating_sub(1);
            for (index, chunk) in batch.chunks(RTDB_MAX_EMISSION_BATCH).enumerate() {
                let chunk_marker = if marker && index == last_chunk {
                    Some(query_id.as_str())
                } else {
                    None
                };
                (self.emitter)(chunk, chunk_marker);
                emitted += chunk.len();
            }
        }
        emitted
    }

    /// Arm the replay-completion marker for one query (round-3 F-33 fix).
    /// Called by the replay leg — on BOTH the success and the failure path —
    /// after its snapshot enqueue loop finishes. If the query has nothing
    /// left pending (the whole replay already drained, or `flushMs: 0` where
    /// nothing ever coalesces), the terminal EMPTY marker envelope is emitted
    /// immediately; otherwise the next drain of that query marks its last
    /// chunk. The signal is ONE-SHOT per subscription and unsubscribed
    /// queries (`drop_query`) discard it — never a post-unsubscribe emission.
    pub fn mark_replay_complete(&self, query_id: &str) {
        let emit_terminal = {
            let mut inner = self.lock();
            let Some(window) = inner.queries.get_mut(query_id) else {
                return;
            };
            if window.replay_completed {
                return;
            }
            window.replay_completed = true;
            if window.pending.is_empty() {
                true
            } else {
                window.complete_pending = true;
                false
            }
        };
        if emit_terminal {
            (self.emitter)(&[], Some(query_id));
        }
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
        let loop_ = FlushLoop::new(Arc::new(
            move |deliveries: &[RowDelivery], _marker: Option<&str>| {
                capture
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend_from_slice(deliveries);
            },
        ));
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

    // ── Batch emission chunking (F-33 fix, W-1) ─────────────────────────────

    /// Sink capturing each emitter CALL separately (call count, sizes, and
    /// the replay-completion marker per call), not just the flattened
    /// delivery stream.
    type CallSink = Arc<Mutex<Vec<(Vec<RowDelivery>, Option<String>)>>>;

    fn call_counting_loop() -> (FlushLoop, CallSink) {
        let sink: CallSink = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&sink);
        let loop_ = FlushLoop::new(Arc::new(
            move |deliveries: &[RowDelivery], marker: Option<&str>| {
                capture
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push((deliveries.to_vec(), marker.map(str::to_string)));
            },
        ));
        (loop_, sink)
    }

    fn calls(sink: &CallSink) -> Vec<(Vec<RowDelivery>, Option<String>)> {
        sink.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    #[test]
    fn large_window_chunks_into_emitter_calls_of_at_most_512() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        for i in 0..1500 {
            loop_.enqueue(delivery(
                "q1",
                RowChangeKind::Insert,
                1,
                &key("s", &format!("c{i}")),
                &[("userMessage", serde_json::json!("q"))],
            ));
        }
        assert_eq!(loop_.pending_count(), 1500);
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 1500, "count semantics unchanged");

        let out = calls(&sink);
        assert_eq!(out.len(), 3, "1500 = 512 + 512 + 476 → three emitter calls");
        assert_eq!(out[0].0.len(), RTDB_MAX_EMISSION_BATCH);
        assert_eq!(out[1].0.len(), RTDB_MAX_EMISSION_BATCH);
        assert_eq!(out[2].0.len(), 476);
        assert!(
            out.iter().all(|(_, marker)| marker.is_none()),
            "no replay marker was armed — live-only emissions carry none"
        );
        let total: usize = out.iter().map(|(batch, _)| batch.len()).sum();
        assert_eq!(total, 1500, "full content across the chunks — nothing dropped");
        assert_eq!(loop_.pending_count(), 0);
    }

    #[test]
    fn window_of_exactly_one_chunk_emits_a_single_call() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        for i in 0..RTDB_MAX_EMISSION_BATCH {
            loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", &format!("c{i}")), &[]));
        }
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), RTDB_MAX_EMISSION_BATCH);
        let out = calls(&sink);
        assert_eq!(out.len(), 1, "exactly-one-chunk windows do not split");
        assert_eq!(out[0].0.len(), RTDB_MAX_EMISSION_BATCH);
    }

    #[test]
    fn zero_flush_ms_path_emits_a_single_element_envelope_per_patch() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q0", 0);
        loop_.enqueue(delivery("q0", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        loop_.enqueue(delivery("q0", RowChangeKind::Update, 2, &key("s", "c1"), &[]));
        let out = calls(&sink);
        assert_eq!(out.len(), 2, "per-patch emission timing preserved (AC1-c)");
        assert!(out.iter().all(|(batch, _)| batch.len() == 1));
        assert!(out.iter().all(|(_, marker)| marker.is_none()));
    }

    #[test]
    fn full_50k_row_replay_drains_with_a_bounded_number_of_emitter_calls() {
        // Regression leg for FM-33: a full-table replay of ~50k rows must
        // drain in ceil(N / RTDB_MAX_EMISSION_BATCH) emitter calls (= batch
        // IPC envelopes), never one IPC event per row. Asserts the BOUND,
        // not an exact count (the batch size is the knob).
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        const ROWS: usize = 50_000;
        for i in 0..ROWS {
            loop_.enqueue(delivery(
                "q1",
                RowChangeKind::Insert,
                1,
                &key(&format!("s{}", i % 7), &format!("c{i}")),
                &[("userMessage", serde_json::json!("replay"))],
            ));
        }
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        let emitted_count = loop_.flush_due();
        assert_eq!(emitted_count, ROWS, "every row drains");

        let out = calls(&sink);
        let expected_calls = ROWS.div_ceil(RTDB_MAX_EMISSION_BATCH); // 98
        assert_eq!(
            out.len(),
            expected_calls,
            "~50k rows → ~98 batch envelopes, not 50k IPC events"
        );
        assert!(out.len() <= 100, "bounded emission (assert the bound)");
        assert!(out.iter().all(|(batch, _)| batch.len() <= RTDB_MAX_EMISSION_BATCH));
        let total: usize = out.iter().map(|(batch, _)| batch.len()).sum();
        assert_eq!(total, ROWS, "full replay content preserved");
    }

    // ── Replay-completion marker (round-3 F-33 fix) ─────────────────────────

    #[test]
    fn marker_rides_the_final_chunk_of_a_large_drain_and_clears_after() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        for i in 0..1500 {
            loop_.enqueue(delivery(
                "q1",
                RowChangeKind::Insert,
                1,
                &key("s", &format!("c{i}")),
                &[("userMessage", serde_json::json!("q"))],
            ));
        }
        // Arm the marker while rows are still pending → the flag rides to the
        // drain; no terminal envelope is emitted early.
        loop_.mark_replay_complete("q1");
        assert_eq!(calls(&sink).len(), 0, "no early emission while pending");

        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 1500);

        let out = calls(&sink);
        assert_eq!(out.len(), 3, "1500 = 512 + 512 + 476 → three chunks");
        assert_eq!(out[0].1, None, "first chunk carries no marker");
        assert_eq!(out[1].1, None, "middle chunk carries no marker");
        assert_eq!(
            out[2].1.as_deref(),
            Some("q1"),
            "the FINAL chunk carries the completion marker"
        );
        let total: usize = out.iter().map(|(batch, _)| batch.len()).sum();
        assert_eq!(total, 1500, "full content across the marked drain");

        // The flag cleared with the drain: subsequent live batches are clean.
        loop_.enqueue(delivery("q1", RowChangeKind::Update, 2, &key("s", "c0"), &[]));
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        loop_.flush_due();
        let after = calls(&sink);
        assert_eq!(after.len(), 4);
        assert_eq!(after[3].1, None, "marker cleared after the drain — live emission is clean");
    }

    #[test]
    fn marker_is_absent_on_live_only_batches() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 1);
        let out = calls(&sink);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, None, "live-only emissions never carry the marker");

        // flushMs: 0 live path likewise.
        loop_.set_window("q0", 0);
        loop_.enqueue(delivery("q0", RowChangeKind::Insert, 1, &key("s", "c2"), &[]));
        let out = calls(&sink);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].1, None, "flushMs:0 per-patch emissions carry no marker");
    }

    #[test]
    fn flush_ms_zero_replay_emits_a_terminal_empty_marker_exactly_once() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q0", 0);
        // Replay leg: every enqueue emits its per-patch single-element
        // envelope (AC1-c timing intact), then the terminal marker follows.
        loop_.enqueue(delivery("q0", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        loop_.enqueue(delivery("q0", RowChangeKind::Update, 2, &key("s", "c1"), &[]));
        loop_.mark_replay_complete("q0");

        let out = calls(&sink);
        assert_eq!(out.len(), 3, "two per-patch envelopes + one terminal marker");
        assert_eq!(out[0].1, None);
        assert_eq!(out[1].1, None);
        assert_eq!(out[2].1.as_deref(), Some("q0"), "terminal envelope carries the marker");
        assert!(
            out[2].0.is_empty(),
            "the flushMs:0 terminal marker is an EMPTY envelope — no extra delivery"
        );

        // Exactly once: a second mark on the already-complete query must not
        // re-emit (the drain/clear semantics make the marker one-shot here).
        loop_.mark_replay_complete("q0");
        assert_eq!(calls(&sink).len(), 3, "no duplicate terminal marker");
    }

    #[test]
    fn drop_query_before_the_marker_discards_it() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        loop_.drop_query("q1");
        loop_.mark_replay_complete("q1");
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        loop_.flush_due();
        let out = calls(&sink);
        assert!(
            out.is_empty(),
            "unsubscribed queries emit nothing — never a post-unsubscribe marker"
        );
    }

    #[test]
    fn marker_carries_the_correct_query_id_across_concurrent_query_drains() {
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        loop_.set_window("q2", DEFAULT_FLUSH_MS);
        for i in 0..600 {
            loop_.enqueue(delivery(
                "q1",
                RowChangeKind::Insert,
                1,
                &key("s1", &format!("c{i}")),
                &[],
            ));
        }
        loop_.enqueue(delivery("q2", RowChangeKind::Insert, 1, &key("s2", "c1"), &[]));
        loop_.mark_replay_complete("q1");
        loop_.mark_replay_complete("q2");

        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 601);

        let out = calls(&sink);
        // q1 drains as 2 chunks (512 + 88), q2 as 1 — order across queries is
        // map-iteration order, so group by query id.
        let q1_markers: Vec<Option<&String>> = out
            .iter()
            .filter(|(batch, _)| batch.iter().all(|d| d.query_id == "q1"))
            .map(|(_, m)| m.as_ref())
            .collect();
        let q2_markers: Vec<Option<&String>> = out
            .iter()
            .filter(|(batch, _)| batch.iter().all(|d| d.query_id == "q2"))
            .map(|(_, m)| m.as_ref())
            .collect();
        assert_eq!(q1_markers.len(), 2, "q1's 600 rows split into 2 chunks");
        assert_eq!(q1_markers[0], None);
        assert_eq!(
            q1_markers[1].map(String::as_str),
            Some("q1"),
            "only q1's final chunk marks q1"
        );
        assert_eq!(q2_markers.len(), 1);
        assert_eq!(
            q2_markers[0].map(String::as_str),
            Some("q2"),
            "q2's single-chunk drain is its own final chunk"
        );
    }

    #[test]
    fn marker_with_nothing_left_pending_emits_the_terminal_envelope_immediately() {
        // The race case: the whole replay drained before the leg signalled
        // completion (deadline fired between the last enqueue and the mark).
        // The terminal marker must still be emitted — the frontend `ready`
        // gate may never wedge on an already-drained replay.
        let (loop_, sink) = call_counting_loop();
        loop_.set_window("q1", DEFAULT_FLUSH_MS);
        loop_.enqueue(delivery("q1", RowChangeKind::Insert, 1, &key("s", "c1"), &[]));
        std::thread::sleep(Duration::from_millis(DEFAULT_FLUSH_MS + 15));
        assert_eq!(loop_.flush_due(), 1, "replay content fully drained");
        assert_eq!(calls(&sink)[0].1, None);

        loop_.mark_replay_complete("q1");
        let out = calls(&sink);
        assert_eq!(out.len(), 2, "terminal envelope emitted immediately");
        assert_eq!(out[1].1.as_deref(), Some("q1"));
        assert!(out[1].0.is_empty(), "terminal envelope is empty");
    }
}
