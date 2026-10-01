//! RTDB row cache + write-behind pipeline (Spec #2788, P1.2).
//!
//! ## LRU row cache (SQLite authoritative)
//!
//! [`RowCache`] is a bounded LRU map keyed by the composite key
//! `(session_id, correlation_id)`, one instance per row type (each capped at
//! [`DEFAULT_CACHE_CAPACITY`] entries). On a cache miss,
//! [`RtdbCache::get_chat`] and friends reload from [`RtdbStore`] (the
//! authoritative source) and re-populate the cache — evicted entries are
//! always recoverable. All state is bounded (NFR-2).
//!
//! ## Write-behind
//!
//! Mutations (`upsert_*`) update the cache SYNCHRONOUSLY, then enqueue the
//! full row on a bounded MPSC channel (`try_send` — never blocks). A writer
//! task ([`run_writer_task`], spawned by lib.rs via
//! `tauri::async_runtime::spawn`) drains the queue in ~30 ms batches and
//! upserts into SQLite in one transaction per batch.
//!
//! On queue overflow / persistence failure the STORAGE work is SHED (counted,
//! logged) — the in-memory/live state is never blocked or lost (R-2d: storage
//! sheds, delivery never does).
//!
//! ## Retention
//!
//! The writer task prunes at a 60-minute interval (and lib.rs prunes at
//! startup), re-reading the AppStore knobs `rtdb.retention_days` /
//! `rtdb.max_rows` fresh at every cycle via [`read_knobs`]. Since P2.3 the
//! prune's evicted keys route `kind: remove` deliveries through the [`Rtdb`]
//! orchestrator (R-2d: retention eviction is the ONLY remove producer).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::Manager;

use crate::infrastructure::rtdb::commands::RtdbState;
use crate::infrastructure::rtdb::rows::{AgentSessionRow, ChatRow, ToolUseRow};
use crate::infrastructure::rtdb::store::{RowKind, RtdbStore};
use crate::infrastructure::storage::migration::MigrationGate;
use crate::infrastructure::storage::AppStore;

// ── Constants ────────────────────────────────────────────────────────────────

/// LRU cap per row type (chat / tool-use / agent-session caches each hold at
/// most this many rows; SQLite remains authoritative for everything else).
pub const DEFAULT_CACHE_CAPACITY: usize = 10_000;
/// Bounded write-behind queue capacity. Overflow sheds the storage write.
pub const QUEUE_CAPACITY: usize = 4096;
/// Writer flush window: pending rows coalesce across ~this many milliseconds.
const WRITER_FLUSH_MS: u64 = 30;
/// Prune interval inside the writer task (60 minutes; lib.rs also prunes at
/// startup).
const WRITER_PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);

// ── RowCache (generic bounded LRU) ───────────────────────────────────────────

/// Composite row key.
pub type RowKey = (String, String);

/// Bounded LRU cache keyed by [`RowKey`].
///
/// Tick-stamped entries; on overflow the oldest ~10% are evicted in one pass
/// (hysteresis — amortized O(n log n) per bulk eviction, not per insert).
pub struct RowCache<T> {
    cap: usize,
    entries: HashMap<RowKey, T>,
    ticks: HashMap<RowKey, u64>,
    tick: u64,
}

impl<T: Clone> RowCache<T> {
    pub fn new(cap: usize) -> Self {
        RowCache {
            cap: cap.max(1),
            entries: HashMap::new(),
            ticks: HashMap::new(),
            tick: 0,
        }
    }

    /// Look up a key (LRU access stamps recency). Returns a clone.
    pub fn get(&mut self, session_id: &str, correlation_id: &str) -> Option<T> {
        let key = (session_id.to_string(), correlation_id.to_string());
        if !self.entries.contains_key(&key) {
            return None;
        }
        self.stamp(key);
        self.entries.get(&(session_id.to_string(), correlation_id.to_string())).cloned()
    }

    /// Insert/replace a row (LRU access stamps recency), evicting if over cap.
    pub fn put(&mut self, key: RowKey, value: T) {
        self.stamp(key.clone());
        self.entries.insert(key, value);
        self.evict_if_needed();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Every cached key belonging to `session_id` (bounded by the cache cap).
    /// Used by the P3.1 re-key path to include rows still pending write-behind
    /// (SQLite alone would miss rows in the ~30 ms flush window).
    pub fn keys_for_session(&self, session_id: &str) -> Vec<RowKey> {
        self.entries
            .keys()
            .filter(|(session, _)| session == session_id)
            .cloned()
            .collect()
    }

    fn stamp(&mut self, key: RowKey) {
        self.tick += 1;
        self.ticks.insert(key, self.tick);
    }

    fn evict_if_needed(&mut self) {
        if self.entries.len() <= self.cap {
            return;
        }
        // Evict the oldest ~10% (hysteresis keeps this off the hot path).
        let target = (self.cap * 9 / 10).max(1);
        let excess = self.entries.len() - target;
        let mut pairs: Vec<(u64, RowKey)> =
            self.ticks.iter().map(|(k, t)| (*t, k.clone())).collect();
        pairs.sort_unstable();
        for (_, key) in pairs.into_iter().take(excess) {
            self.entries.remove(&key);
            self.ticks.remove(&key);
        }
    }
}

// ── Pending writes ───────────────────────────────────────────────────────────

/// One pending write-behind row.
#[derive(Clone, Debug)]
pub enum PendingWrite {
    Chat(ChatRow),
    ToolUse(ToolUseRow),
    AgentSession(AgentSessionRow),
}

// ── RtdbCache ────────────────────────────────────────────────────────────────

/// LRU row cache + write-behind enqueue front-end over [`RtdbStore`].
///
/// Mutations update the cache synchronously and enqueue the SQLite upsert;
/// the writer task flushes batches. Cache misses reload from SQLite (which
/// stays authoritative).
pub struct RtdbCache {
    store: Arc<RtdbStore>,
    chats: Mutex<RowCache<ChatRow>>,
    tools: Mutex<RowCache<ToolUseRow>>,
    sessions: Mutex<RowCache<AgentSessionRow>>,
    tx: tokio::sync::mpsc::Sender<PendingWrite>,
    /// Storage writes shed due to queue overflow (or a closed channel).
    dropped: AtomicU64,
}

impl RtdbCache {
    /// Create the cache + bounded write-behind queue. The receiver is passed
    /// to [`run_writer_task`] (spawned by lib.rs).
    pub fn new(store: Arc<RtdbStore>) -> (Arc<Self>, tokio::sync::mpsc::Receiver<PendingWrite>) {
        Self::with_capacity(store, DEFAULT_CACHE_CAPACITY, QUEUE_CAPACITY)
    }

    /// Capacity-parameterized constructor (tests use small caps).
    pub fn with_capacity(
        store: Arc<RtdbStore>,
        cache_cap: usize,
        queue_capacity: usize,
    ) -> (Arc<Self>, tokio::sync::mpsc::Receiver<PendingWrite>) {
        let (tx, rx) = tokio::sync::mpsc::channel(queue_capacity);
        (
            Arc::new(RtdbCache {
                store,
                chats: Mutex::new(RowCache::new(cache_cap)),
                tools: Mutex::new(RowCache::new(cache_cap)),
                sessions: Mutex::new(RowCache::new(cache_cap)),
                tx,
                dropped: AtomicU64::new(0),
            }),
            rx,
        )
    }

    /// The authoritative store (used by lib.rs for the startup prune).
    pub fn store(&self) -> Arc<RtdbStore> {
        Arc::clone(&self.store)
    }

    // ── Mutations: cache synchronously, enqueue the storage write ───────────

    /// Upsert a chat row: cache update is synchronous; the SQLite upsert is
    /// batched through the write-behind queue. Queue overflow SHEDS the
    /// storage write (counted + logged) — the in-memory row is never lost.
    pub fn upsert_chat(&self, row: ChatRow) {
        {
            let mut cache = self.lock_chats();
            cache.put((row.session_id.clone(), row.correlation_id.clone()), row.clone());
        }
        if let Err(e) = self.tx.try_send(PendingWrite::Chat(row.clone())) {
            let _ = self.dropped.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                target: "fredo::rtdb",
                session_id = %row.session_id,
                correlation_id = %row.correlation_id,
                error = %e,
                "rtdb chat write-behind enqueue shed (queue full or closed) — in-memory row unaffected"
            );
        }
    }

    /// Upsert a tool-use row (same write-behind semantics).
    pub fn upsert_tool_use(&self, row: ToolUseRow) {
        {
            let mut cache = self.lock_tools();
            cache.put((row.session_id.clone(), row.correlation_id.clone()), row.clone());
        }
        if let Err(e) = self.tx.try_send(PendingWrite::ToolUse(row.clone())) {
            let _ = self.dropped.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                target: "fredo::rtdb",
                session_id = %row.session_id,
                correlation_id = %row.correlation_id,
                error = %e,
                "rtdb tool-use write-behind enqueue shed (queue full or closed) — in-memory row unaffected"
            );
        }
    }

    /// Upsert an agent-session row (same write-behind semantics).
    pub fn upsert_agent_session(&self, row: AgentSessionRow) {
        {
            let mut cache = self.lock_sessions();
            cache.put((row.session_id.clone(), row.correlation_id.clone()), row.clone());
        }
        if let Err(e) = self.tx.try_send(PendingWrite::AgentSession(row.clone())) {
            let _ = self.dropped.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                target: "fredo::rtdb",
                session_id = %row.session_id,
                correlation_id = %row.correlation_id,
                error = %e,
                "rtdb agent-session write-behind enqueue shed (queue full or closed) — in-memory row unaffected"
            );
        }
    }

    // ── Reads: cache-first, SQLite reload on miss ───────────────────────────

    /// Get a chat row — cache-first; a miss reloads from the active engine and
    /// re-populates the cache (storage is authoritative).
    pub async fn get_chat(
        &self,
        session_id: &str,
        correlation_id: &str,
    ) -> anyhow::Result<Option<ChatRow>> {
        {
            let mut cache = self.lock_chats();
            if let Some(row) = cache.get(session_id, correlation_id) {
                return Ok(Some(row));
            }
        }
        match self.store.get_chat_row(session_id, correlation_id).await? {
            Some(row) => {
                self.lock_chats().put(
                    (row.session_id.clone(), row.correlation_id.clone()),
                    row.clone(),
                );
                Ok(Some(row))
            }
            None => Ok(None),
        }
    }

    /// Get a tool-use row — cache-first, storage reload on miss.
    pub async fn get_tool_use(
        &self,
        session_id: &str,
        correlation_id: &str,
    ) -> anyhow::Result<Option<ToolUseRow>> {
        {
            let mut cache = self.lock_tools();
            if let Some(row) = cache.get(session_id, correlation_id) {
                return Ok(Some(row));
            }
        }
        match self.store.get_tool_use_row(session_id, correlation_id).await? {
            Some(row) => {
                self.lock_tools().put(
                    (row.session_id.clone(), row.correlation_id.clone()),
                    row.clone(),
                );
                Ok(Some(row))
            }
            None => Ok(None),
        }
    }

    /// Get an agent-session row — cache-first, storage reload on miss.
    pub async fn get_agent_session(
        &self,
        session_id: &str,
        correlation_id: &str,
    ) -> anyhow::Result<Option<AgentSessionRow>> {
        {
            let mut cache = self.lock_sessions();
            if let Some(row) = cache.get(session_id, correlation_id) {
                return Ok(Some(row));
            }
        }
        match self.store.get_agent_session_row(session_id, correlation_id).await? {
            Some(row) => {
                self.lock_sessions().put(
                    (row.session_id.clone(), row.correlation_id.clone()),
                    row.clone(),
                );
                Ok(Some(row))
            }
            None => Ok(None),
        }
    }

    // ── Per-session key listing (Spec #2788 P3.1 re-key input) ──────────────

    /// All keys `(session_id, correlation_id)` belonging to `session_id` for a
    /// row kind — the CACHED leg unioned with the PERSISTED leg (storage is
    /// authoritative per key; a later `get_*` re-reads the winning row).
    /// Deduplicated. Both legs are bounded (cache cap / indexed select).
    async fn keys_for_session_union(
        &self,
        kind: RowKind,
        cached: Vec<RowKey>,
        session_id: &str,
    ) -> anyhow::Result<Vec<RowKey>> {
        let mut keys: Vec<RowKey> = cached;
        for row in self
            .store
            .select_snapshot(
                kind,
                "session_id = ?1",
                vec![crate::infrastructure::rtdb::store::SqlValue::Text(
                    session_id.to_string(),
                )],
            )
            .await?
        {
            let key = row.key();
            keys.push((key.session_id, key.correlation_id));
        }
        keys.sort();
        keys.dedup();
        Ok(keys)
    }

    /// Chat keys for a session (cached ∪ persisted) — P3.1 re-key input.
    pub async fn chat_keys_for_session(&self, session_id: &str) -> anyhow::Result<Vec<RowKey>> {
        let cached = self.lock_chats().keys_for_session(session_id);
        self.keys_for_session_union(RowKind::Chat, cached, session_id)
            .await
    }

    /// Tool-use keys for a session (cached ∪ persisted) — P3.1 re-key input.
    pub async fn tool_keys_for_session(&self, session_id: &str) -> anyhow::Result<Vec<RowKey>> {
        let cached = self.lock_tools().keys_for_session(session_id);
        self.keys_for_session_union(RowKind::ToolUse, cached, session_id)
            .await
    }

    /// Agent-session keys for a session (cached ∪ persisted) — P3.1 re-key input.
    pub async fn agent_session_keys_for_session(
        &self,
        session_id: &str,
    ) -> anyhow::Result<Vec<RowKey>> {
        let cached = self.lock_sessions().keys_for_session(session_id);
        self.keys_for_session_union(RowKind::AgentSession, cached, session_id)
            .await
    }

    // ── Write-behind flush ──────────────────────────────────────────────────

    /// Flush one drained batch: partition by kind, upsert each in a single
    /// store transaction per kind. Called by the writer task (and tests).
    pub async fn flush_pending(&self, batch: Vec<PendingWrite>) -> anyhow::Result<usize> {
        let mut chats = Vec::new();
        let mut tools = Vec::new();
        let mut sessions = Vec::new();
        for pending in batch {
            match pending {
                PendingWrite::Chat(row) => chats.push(row),
                PendingWrite::ToolUse(row) => tools.push(row),
                PendingWrite::AgentSession(row) => sessions.push(row),
            }
        }
        let mut total = 0usize;
        if !chats.is_empty() {
            total += self.store.upsert_chat_rows(&chats).await?;
        }
        if !tools.is_empty() {
            total += self.store.upsert_tool_use_rows(&tools).await?;
        }
        if !sessions.is_empty() {
            total += self.store.upsert_agent_session_rows(&sessions).await?;
        }
        Ok(total)
    }

    /// Number of storage writes shed due to queue overflow.
    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Cached chat-row count (test/diagnostic).
    pub fn chat_cache_len(&self) -> usize {
        self.lock_chats().len()
    }

    /// Cached tool-use-row count (test/diagnostic).
    pub fn tool_cache_len(&self) -> usize {
        self.lock_tools().len()
    }

    /// Cached agent-session-row count (test/diagnostic).
    pub fn session_cache_len(&self) -> usize {
        self.lock_sessions().len()
    }

    // ── Lock helpers (poison recovery — no unwrap) ──────────────────────────

    fn lock_chats(&self) -> MutexGuard<'_, RowCache<ChatRow>> {
        match self.chats.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_tools(&self) -> MutexGuard<'_, RowCache<ToolUseRow>> {
        match self.tools.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_sessions(&self) -> MutexGuard<'_, RowCache<AgentSessionRow>> {
        match self.sessions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

// ── Writer task + retention knobs ────────────────────────────────────────────

/// Dedicated write-behind task: drains the bounded queue in ~30 ms batches and
/// runs retention pruning on a 60-minute interval (knobs re-read each cycle).
/// Spawned by lib.rs via `tauri::async_runtime::spawn`.
///
/// Spec #2977 ST-4: every batch flush quiesces against the exclusive migration
/// barrier when one is installed, so no RTDB storage write can land while the
/// migration window is open. `None` (unit tests) leaves the task ungated.
pub async fn run_writer_task(
    app: tauri::AppHandle,
    mut rx: tokio::sync::mpsc::Receiver<PendingWrite>,
    gate: Option<Arc<MigrationGate>>,
) {
    let mut last_prune = tokio::time::Instant::now();
    loop {
        // Wait up to the flush window for the first item of a batch.
        let first = tokio::time::timeout(Duration::from_millis(WRITER_FLUSH_MS), rx.recv()).await;
        match first {
            Ok(Some(pending)) => {
                let mut batch = vec![pending];
                // Drain everything already queued — one transaction per kind.
                while let Ok(pending) = rx.try_recv() {
                    batch.push(pending);
                }
                match gate.as_ref() {
                    Some(gate) => match gate.writer_enter().await {
                        Ok(_guard) => flush_rtdb_batch(&app, batch).await,
                        Err(error) => {
                            tracing::warn!(
                                target: "fredo::rtdb",
                                error = %error,
                                count = batch.len(),
                                "rtdb write-behind batch shed: migration barrier held past its bound"
                            );
                        }
                    },
                    None => flush_rtdb_batch(&app, batch).await,
                }
            }
            Ok(None) => break,  // channel closed — all senders dropped
            Err(_elapsed) => {} // flush window elapsed with nothing queued
        }

        if last_prune.elapsed() >= WRITER_PRUNE_INTERVAL {
            prune_with_knobs(&app, gate.as_ref()).await;
            last_prune = tokio::time::Instant::now();
        }
    }
}

/// Flush one drained batch through the RTDB cache (storage write).
async fn flush_rtdb_batch(app: &tauri::AppHandle, batch: Vec<PendingWrite>) {
    if let Some(cache) = app.try_state::<Arc<RtdbCache>>() {
        let count = batch.len();
        if let Err(e) = cache.flush_pending(batch).await {
            tracing::error!(
                target: "fredo::rtdb",
                error = %e,
                count,
                "rtdb write-behind batch flush failed — in-memory rows unaffected"
            );
        }
    }
}

/// Run one prune cycle using the current AppStore knob values. Since P2.3,
/// every eviction is routed through the RTDB orchestrator (`Rtdb`, when
/// running) as a `kind: remove` delivery to matching subscribers — R-2d.
///
/// Spec #2977 ST-4: quiesces against the exclusive migration barrier when one is
/// installed; on timeout the prune is shed.
pub async fn prune_with_knobs(app: &tauri::AppHandle, gate: Option<&Arc<MigrationGate>>) {
    let _guard = match gate {
        Some(gate) => match gate.writer_enter().await {
            Ok(guard) => Some(guard),
            Err(error) => {
                tracing::warn!(
                    target: "fredo::rtdb",
                    error = %error,
                    "rtdb prune shed: migration barrier held past its bound"
                );
                return;
            }
        },
        None => None,
    };
    let Some(cache) = app.try_state::<Arc<RtdbCache>>() else {
        return;
    };
    let app_store = app.state::<Arc<AppStore>>();
    let (retention_days, max_rows) = read_knobs(&app_store);
    match cache.store().prune(retention_days, max_rows).await {
        Ok(outcome) => {
            if !outcome.evicted.is_empty() {
                if let Some(rtdb) = app.try_state::<RtdbState>() {
                    rtdb.route_evictions(outcome.evicted);
                }
            }
            if outcome.deleted > 0 {
                tracing::info!(
                    target: "fredo::rtdb",
                    deleted = outcome.deleted,
                    retention_days,
                    max_rows,
                    "rtdb retention prune"
                );
            }
        }
        Err(e) => {
            tracing::error!(target: "fredo::rtdb", error = %e, "rtdb prune failed");
        }
    }
}

/// Read the retention knobs fresh from the AppStore (defaults when unset or
/// unparseable). The binding config-first mechanism: AppStore KV keys.
pub fn read_knobs(app_store: &AppStore) -> (i64, i64) {
    use crate::infrastructure::rtdb::store::{
        RTDB_DEFAULT_MAX_ROWS, RTDB_DEFAULT_RETENTION_DAYS, RTDB_MAX_ROWS_KEY,
        RTDB_RETENTION_DAYS_KEY,
    };
    let retention_days = app_store
        .control_get(RTDB_RETENTION_DAYS_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(RTDB_DEFAULT_RETENTION_DAYS);
    let max_rows = app_store
        .control_get(RTDB_MAX_ROWS_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(RTDB_DEFAULT_MAX_ROWS);
    (retention_days, max_rows)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::rows::RowState;

    async fn open_store() -> (tempfile::TempDir, Arc<RtdbStore>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(RtdbStore::open_sqlite_for_tests(dir.path().to_path_buf()).expect("open"));
        store.ensure_schema().await.expect("schema");
        (dir, store)
    }

    fn chat_row(session: &str, corr: &str, seq: i64) -> ChatRow {
        ChatRow {
            session_id: session.to_string(),
            correlation_id: corr.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00+00:00".to_string(),
            state: RowState::Init,
            // #2932 ST-4: the physical `provider` column is NOT NULL DEFAULT
            // 'unknown', so a stored row always reads back `Some(..)` — the
            // reload-from-SQLite equality pin needs a real token, not the ST-2
            // compile placeholder.
            provider: Some("open_code".to_string()),
            user_message: Some("q".to_string()),
            agent_reply: None,
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

    fn tool_row(session: &str, corr: &str, seq: i64) -> ToolUseRow {
        ToolUseRow {
            session_id: session.to_string(),
            correlation_id: corr.to_string(),
            seq,
            started_at_ns: Some(2_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00+00:00".to_string(),
            state: RowState::Update,
            provider: None,
            tool_name: Some("bash".to_string()),
            tool_success: None,
            tool_error: None,
            duration_ms: None,
            tool_input_json: None,
            tool_output_json: None,
            is_subagent: None,
            raw_json: "{}".to_string(),
        }
    }

    fn session_row(session: &str, corr: &str, seq: i64) -> AgentSessionRow {
        AgentSessionRow {
            session_id: session.to_string(),
            correlation_id: corr.to_string(),
            seq,
            started_at_ns: Some(3_000),
            ended_at_ns: None,
            updated_at: "2026-08-31T00:00:00+00:00".to_string(),
            state: RowState::Init,
            provider: None,
            total_tokens: None,
            total_messages: None,
            total_cost_usd: None,
            agent_name: None,
            raw_json: "{}".to_string(),
        }
    }

    // ── RowCache LRU mechanics ──────────────────────────────────────────────

    #[test]
    fn lru_evicts_the_oldest_entries_and_keeps_recent_ones() {
        let mut cache: RowCache<u32> = RowCache::new(10);
        for i in 0..10 {
            cache.put((format!("s"), format!("k{i}")), i);
        }
        assert_eq!(cache.len(), 10);

        // Touch k0 and k1 — they become recent.
        assert_eq!(cache.get("s", "k0"), Some(0));
        assert_eq!(cache.get("s", "k1"), Some(1));

        // Overflow with 3 more → bulk eviction removes ~10% (1 entry) per
        // put beyond cap until back under the hysteresis target (9).
        cache.put(("s".to_string(), "k10".to_string()), 10);
        assert!(cache.len() <= 10, "cap enforced");
        // The untouched oldest (k2) is gone; touched k0/k1 survive.
        assert_eq!(cache.get("s", "k2"), None, "untouched oldest evicted");
        assert_eq!(cache.get("s", "k0"), Some(0), "recently used entry survives");
        assert_eq!(cache.get("s", "k10"), Some(10), "newest entry survives");
    }

    #[test]
    fn lru_cap_of_one_keeps_exactly_the_newest_entry() {
        let mut cache: RowCache<u32> = RowCache::new(1);
        cache.put(("s".to_string(), "a".to_string()), 1);
        cache.put(("s".to_string(), "b".to_string()), 2);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("s", "a"), None);
        assert_eq!(cache.get("s", "b"), Some(2));
    }

    // ── Write-behind: batch flush persists through the queue ────────────────

    #[tokio::test]
    async fn write_behind_batch_flush_persists_all_row_kinds() {
        let (_dir, store) = open_store().await;
        let (cache, mut rx) = RtdbCache::new(store);

        cache.upsert_chat(chat_row("ses_a", "ses_a_1", 1));
        cache.upsert_tool_use(tool_row("ses_a", "ses_a_2", 2));
        cache.upsert_agent_session(session_row("ses_a", "ses_a", 3));

        // Cache updated synchronously; storage still empty (write-behind).
        let (chat, tool, agent) = cache.store().row_counts().await.expect("counts");
        assert_eq!((chat, tool, agent), (0, 0, 0));
        assert_eq!(cache.chat_cache_len(), 1);
        assert_eq!(cache.tool_cache_len(), 1);
        assert_eq!(cache.session_cache_len(), 1);

        // Drain the queue like the writer task and flush one batch.
        let mut batch = Vec::new();
        while let Ok(pending) = rx.try_recv() {
            batch.push(pending);
        }
        let flushed = cache.flush_pending(batch).await.expect("flush");
        assert_eq!(flushed, 3);

        let (chat, tool, agent) = cache.store().row_counts().await.expect("counts");
        assert_eq!((chat, tool, agent), (1, 1, 1));
        assert_eq!(cache.dropped_count(), 0);
    }

    // ── LRU eviction + reload from SQLite (authoritative) ───────────────────

    #[tokio::test]
    async fn evicted_entries_reload_from_sqlite_on_demand() {
        let (_dir, store) = open_store().await;
        // Cache cap 1: writing row B evicts row A from the cache.
        let (cache, mut rx) = RtdbCache::with_capacity(store, 1, QUEUE_CAPACITY);

        let row_a = chat_row("ses_a", "row_a", 1);
        cache.upsert_chat(row_a.clone());
        let row_b = chat_row("ses_a", "row_b", 2);
        cache.upsert_chat(row_b.clone());

        // Persist both rows so storage is authoritative.
        let mut batch = Vec::new();
        while let Ok(pending) = rx.try_recv() {
            batch.push(pending);
        }
        cache.flush_pending(batch).await.expect("flush");

        // row_b is in cache; row_a was evicted by the cap-1 LRU…
        assert_eq!(cache.chat_cache_len(), 1);
        // …but reloads from storage on demand.
        let reloaded = cache.get_chat("ses_a", "row_a").await.expect("get").expect("reloaded");
        assert_eq!(reloaded, row_a);
        // And is cached again — the cap is enforced on reload too, so the
        // previously-cached row_b was evicted and reloads from storage itself.
        assert_eq!(cache.chat_cache_len(), 1, "cap enforced even across a reload");
        let again = cache.get_chat("ses_a", "row_b").await.expect("get").expect("reloaded from storage");
        assert_eq!(again, row_b, "the other side of the cap reloads on demand too");
    }

    #[tokio::test]
    async fn cache_miss_with_no_storage_row_returns_none() {
        let (_dir, store) = open_store().await;
        let (cache, _rx) = RtdbCache::new(store);
        let missing = cache.get_chat("nope", "nope").await.expect("get");
        assert!(missing.is_none());
        assert_eq!(cache.chat_cache_len(), 0, "a miss caches nothing");
    }

    // ── Overflow sheds the storage write, never the in-memory state ─────────

    #[tokio::test]
    async fn queue_overflow_sheds_storage_writes_never_in_memory_state() {
        let (_dir, store) = open_store().await;
        // Queue capacity 1: the first enqueue buffers, the rest are shed.
        let (cache, mut rx) = RtdbCache::with_capacity(store, DEFAULT_CACHE_CAPACITY, 1);

        let mut last = None;
        for i in 0..10 {
            let row = chat_row("ses_q", &format!("q{i}"), i);
            // Every call returns immediately — the live path is never blocked.
            cache.upsert_chat(row.clone());
            last = Some(row);
        }
        assert_eq!(cache.dropped_count(), 9, "9 of 10 storage enqueues shed");

        // In-memory/live state is fully intact — all 10 rows readable.
        for i in 0..10 {
            let got = cache.get_chat("ses_q", &format!("q{i}")).await.expect("get");
            assert!(got.is_some(), "in-memory row q{i} must survive the shed");
        }
        let expected = last.expect("last row");
        assert_eq!(cache.get_chat("ses_q", "q9").await.expect("get"), Some(expected));

        // The one buffered write is intact for the writer task.
        let buffered = rx.try_recv().expect("first enqueue is buffered");
        match buffered {
            PendingWrite::Chat(row) => assert_eq!(row.correlation_id, "q0"),
            other => panic!("expected a chat pending write, got {other:?}"),
        }
    }

    // ── Retention knobs (AppStore KV, config-first) ─────────────────────────

    #[test]
    fn read_knobs_defaults_when_unset_and_reads_configured_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_store =
            AppStore::open_sqlite_for_tests(dir.path().to_path_buf()).expect("appstore");

        // Unset → defaults (7 days / 100k rows).
        let (days, rows) = read_knobs(&app_store);
        assert_eq!(days, crate::infrastructure::rtdb::store::RTDB_DEFAULT_RETENTION_DAYS);
        assert_eq!(rows, crate::infrastructure::rtdb::store::RTDB_DEFAULT_MAX_ROWS);

        // Configured → the configured values win (read fresh each cycle).
        app_store
            .control_set(crate::infrastructure::rtdb::store::RTDB_RETENTION_DAYS_KEY, "3")
            .expect("set");
        app_store
            .control_set(crate::infrastructure::rtdb::store::RTDB_MAX_ROWS_KEY, "5000")
            .expect("set");
        let (days, rows) = read_knobs(&app_store);
        assert_eq!(days, 3);
        assert_eq!(rows, 5000);

        // Unparseable → back to defaults, never a panic.
        app_store
            .control_set(crate::infrastructure::rtdb::store::RTDB_RETENTION_DAYS_KEY, "bogus")
            .expect("set");
        let (days, _) = read_knobs(&app_store);
        assert_eq!(days, crate::infrastructure::rtdb::store::RTDB_DEFAULT_RETENTION_DAYS);
    }
}
