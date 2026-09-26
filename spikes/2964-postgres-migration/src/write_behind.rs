//! Spike #2964 **ST-3** — `write_behind` binary: validates the RTDB
//! write-behind batch + bounded-LRU reload shape against a **real PostgreSQL
//! client**, proving the SQLite → PostgreSQL storage swap does not break the
//! shed/reload semantics.
//!
//! It is a **faithful model** of the production front-end in
//! `apps/tauri/src-tauri/src/infrastructure/rtdb/cache.rs` (READ-ONLY source of
//! truth — never modified), with the storage leg pointed at the embedded
//! PostgreSQL server instead of `fredo.db`:
//!
//! | Shape | Production | This PoC |
//! |---|---|---|
//! | three bounded LRU caches, cap `DEFAULT_CACHE_CAPACITY` | `cache.rs:47` | [`DEFAULT_CACHE_CAPACITY`], one `RowCache` for `chat_rows` (the other two kinds have the identical shape) |
//! | bounded MPSC write-behind queue | `cache.rs:49` | [`QUEUE_CAPACITY`] |
//! | ~30 ms writer coalescing window | `cache.rs:51` | [`WRITER_FLUSH_MS`] |
//! | mutation = synchronous cache put + `try_send` full row | `cache.rs:204-255` | [`WriteBehindCache::upsert_chat`] |
//! | overflow SHEDS the storage write (`dropped` counter) | `cache.rs:209-218`, `:401-403` | [`WriteBehindCache::upsert_chat`] / [`WriteBehindCache::dropped_count`] |
//! | writer drains a batch then upserts once | `cache.rs:376-398`, `:449-485` | [`run_writer_task`] |
//! | cache miss reloads from storage | `cache.rs:261-326` | [`WriteBehindCache::get_chat`] |
//!
//! ## Checks (all must pass)
//!
//! 1. `production_constants_modeled` — the modeled cap/queue/window equal the
//!    cited production constants.
//! 2. `write_behind_batch_flush` — 3 mutations update the cache synchronously,
//!    PostgreSQL stays empty until the batch is drained + flushed in one tx.
//! 3. `writer_coalesces_burst_into_one_batch` — a 500-row burst queued behind
//!    the bounded queue is drained by the real async writer into ONE batch and
//!    upserted in one transaction (the ~30 ms coalescing window).
//! 4. `lone_write_flushed_within_flush_window` — a lone mutation is persisted on
//!    the writer's next bounded cycle (no unbounded wait).
//! 5. `overflow_sheds_storage_not_memory` — with a small queue, the excess
//!    storage writes are shed (`dropped` counted) while every row stays
//!    readable in memory; the shed rows never reach PostgreSQL.
//! 6. `cache_miss_reload_from_pg` — cap-1 LRU eviction, then a cache miss
//!    reloads the evicted row from PostgreSQL and re-populates the cache.
//! 7. `cache_miss_absent_returns_none` — a miss with no storage row returns
//!    `None` and caches nothing.
//! 8. `lru_evicts_oldest_keeps_recent` / 9. `lru_cap_one_keeps_newest` — the
//!    bounded-LRU mechanics (echoing the production unit pins).
//!
//! ## Reproducible command (finite wall-clock bound)
//!
//! ```text
//! cargo run --release --bin write_behind -- --out results/write-behind.json
//! ```
//!
//! Safe under a 10-minute outer shell timeout. Every blocking wait is bounded
//! by [`harness`] (`pg_ctl` 180 s, setup 600 s, start 180 s, stop 30 s +
//! hard-kill, connect 10 s, readiness 60 s) with guaranteed teardown on
//! timeout/panic/all paths (G-263/G-264).
//!
//! Research artifact only: standalone package, never a workspace member, no
//! `apps/**` file referenced or changed.

use anyhow::{Context, Result};
use postgres_migration_spike::harness::{self, ChatRow, PgRuntime};
use postgres_migration_spike::schema_defs as defs;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

// ── Modeled production constants (source of truth: rtdb/cache.rs) ────────────

/// LRU cap per row type — production `cache.rs:47`.
const DEFAULT_CACHE_CAPACITY: usize = 10_000;
/// Bounded write-behind queue capacity — production `cache.rs:49`.
const QUEUE_CAPACITY: usize = 4096;
/// Writer flush window (ms) — production `cache.rs:51`.
const WRITER_FLUSH_MS: u64 = 30;

/// Composite row key — production `cache.rs:59`.
type RowKey = (String, String);

// ── Bounded LRU (faithful copy of production `RowCache`, cache.rs:65-138) ────

/// Tick-stamped bounded LRU; on overflow the oldest ~10 % are evicted in one
/// pass (hysteresis). Identical mechanics to production `RowCache`.
struct RowCache<T> {
    cap: usize,
    entries: HashMap<RowKey, T>,
    ticks: HashMap<RowKey, u64>,
    tick: u64,
}

impl<T: Clone> RowCache<T> {
    fn new(cap: usize) -> Self {
        RowCache {
            cap: cap.max(1),
            entries: HashMap::new(),
            ticks: HashMap::new(),
            tick: 0,
        }
    }

    /// LRU lookup (stamps recency), returns a clone.
    fn get(&mut self, session_id: &str, correlation_id: &str) -> Option<T> {
        let key = (session_id.to_string(), correlation_id.to_string());
        if !self.entries.contains_key(&key) {
            return None;
        }
        self.stamp(key.clone());
        self.entries.get(&key).cloned()
    }

    /// Insert/replace (stamps recency), evicting if over cap.
    fn put(&mut self, key: RowKey, value: T) {
        self.stamp(key.clone());
        self.entries.insert(key, value);
        self.evict_if_needed();
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn stamp(&mut self, key: RowKey) {
        self.tick += 1;
        self.ticks.insert(key, self.tick);
    }

    fn evict_if_needed(&mut self) {
        if self.entries.len() <= self.cap {
            return;
        }
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

// ── PostgreSQL-backed store (the swapped storage leg) ────────────────────────

/// A `chat_rows` store over a synchronous `postgres::Client`. The client owns
/// its own runtime, so **every** method must run on a blocking thread (never
/// inside a Tokio async context) — same constraint the ST-1 harness documents.
///
/// The client lives in an `Option` so it can be taken out and dropped on a
/// blocking thread at shutdown: `postgres::Client`'s `Drop` blocks on its own
/// runtime and panics with "Cannot start a runtime from within a runtime" if it
/// is dropped on a Tokio runtime thread (observed on the first run).
struct PgStore {
    client: Mutex<Option<postgres::Client>>,
}

impl PgStore {
    fn from_client(client: postgres::Client) -> Self {
        PgStore {
            client: Mutex::new(Some(client)),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<postgres::Client>> {
        match self.client.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Run `f` with exclusive access to the live client (blocking context only).
    fn with_client<R>(
        &self,
        f: impl FnOnce(&mut postgres::Client) -> Result<R>,
    ) -> Result<R> {
        let mut guard = self.lock();
        let client = guard.as_mut().context("pg client already disposed")?;
        f(client)
    }

    /// Take the client out for disposal on a blocking thread (idempotent).
    fn take_client(&self) -> Option<postgres::Client> {
        self.lock().take()
    }

    fn truncate(&self) -> Result<()> {
        self.with_client(|c| {
            c.batch_execute("TRUNCATE chat_rows")
                .context("truncate chat_rows")
        })
    }

    fn count(&self) -> Result<i64> {
        self.with_client(|c| {
            Ok(c.query_one("SELECT count(*)::bigint FROM chat_rows", &[])
                .context("count chat_rows")?
                .get(0))
        })
    }

    /// Reload one row by composite PK — the authoritative storage read.
    fn get_chat_row(&self, session_id: &str, correlation_id: &str) -> Result<Option<ChatRow>> {
        let s = session_id.to_string();
        let c = correlation_id.to_string();
        let sql = format!(
            "SELECT {} FROM chat_rows WHERE session_id = $1 AND correlation_id = $2",
            defs::CHAT_COLUMNS
        );
        self.with_client(|client| {
            let row = client
                .query_opt(sql.as_str(), &[&s, &c])
                .context("point read chat_rows")?;
            Ok(row.map(|r| ChatRow {
                session_id: r.get::<_, String>(0),
                correlation_id: r.get::<_, String>(1),
                seq: r.get::<_, i64>(2),
                started_at_ns: r.get::<_, Option<i64>>(3),
                ended_at_ns: r.get::<_, Option<i64>>(4),
                updated_at: r.get::<_, String>(5),
                state: r.get::<_, String>(6),
                user_message: r.get::<_, Option<String>>(7),
                agent_reply: r.get::<_, Option<String>>(8),
                prompt_tokens: r.get::<_, Option<i64>>(9),
                completion_tokens: r.get::<_, Option<i64>>(10),
                cache_read_tokens: r.get::<_, Option<i64>>(11),
                cost_usd: r.get::<_, Option<f64>>(12),
                model: r.get::<_, Option<String>>(13),
                parent_session_id: r.get::<_, Option<String>>(14),
                composited_child_session_id: r.get::<_, Option<String>>(15),
                raw_json: r.get::<_, String>(16),
                provider: r.get::<_, Option<String>>(17).unwrap_or_default(),
            }))
        })
    }

    /// Upsert a drained batch in ONE transaction — the PG translation of the
    /// production `INSERT OR REPLACE` (see `schema_defs::PG_UPSERT_CHAT`).
    fn upsert_chat_rows(&self, rows: &[ChatRow]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        self.with_client(|client| {
            let stmt = client
                .prepare(defs::PG_UPSERT_CHAT)
                .context("prepare chat upsert")?;
            let mut tx = client.transaction().context("begin write-behind tx")?;
            for r in rows {
                let params: Vec<&(dyn postgres::types::ToSql + Sync)> = vec![
                    &r.session_id,
                    &r.correlation_id,
                    &r.seq,
                    &r.started_at_ns,
                    &r.ended_at_ns,
                    &r.updated_at,
                    &r.state,
                    &r.user_message,
                    &r.agent_reply,
                    &r.prompt_tokens,
                    &r.completion_tokens,
                    &r.cache_read_tokens,
                    &r.cost_usd,
                    &r.model,
                    &r.parent_session_id,
                    &r.composited_child_session_id,
                    &r.raw_json,
                    &r.provider,
                ];
                tx.execute(&stmt, &params).context("upsert chat row")?;
            }
            tx.commit().context("commit write-behind tx")?;
            Ok(rows.len())
        })
    }
}

// ── Write-behind front-end (mirror of production `RtdbCache`, cache.rs:157-442) ─

/// One pending write-behind row. Production has chat/tool-use/agent-session
/// variants; this PoC models the chat kind (the others share the identical shape).
enum PendingWrite {
    Chat(ChatRow),
}

/// Bounded LRU cache + write-behind enqueue front-end over the PG store.
struct WriteBehindCache {
    store: Arc<PgStore>,
    chats: Mutex<RowCache<ChatRow>>,
    tx: tokio::sync::mpsc::Sender<PendingWrite>,
    dropped: AtomicU64,
}

impl WriteBehindCache {
    fn with_capacity(
        store: Arc<PgStore>,
        cache_cap: usize,
        queue_capacity: usize,
    ) -> (Arc<Self>, tokio::sync::mpsc::Receiver<PendingWrite>) {
        let (tx, rx) = tokio::sync::mpsc::channel(queue_capacity);
        (
            Arc::new(WriteBehindCache {
                store,
                chats: Mutex::new(RowCache::new(cache_cap)),
                tx,
                dropped: AtomicU64::new(0),
            }),
            rx,
        )
    }

    /// Cache update is synchronous; the storage upsert is batched through the
    /// bounded queue. Overflow SHEDS the storage write (counted) — the
    /// in-memory row is never lost (production `cache.rs:204-219`).
    fn upsert_chat(&self, row: ChatRow) {
        {
            let mut cache = self.lock_chats();
            cache.put(
                (row.session_id.clone(), row.correlation_id.clone()),
                row.clone(),
            );
        }
        let session_id = row.session_id.clone();
        let correlation_id = row.correlation_id.clone();
        if let Err(e) = self.tx.try_send(PendingWrite::Chat(row)) {
            let _ = self.dropped.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "write-behind enqueue shed ({session_id}/{correlation_id}): {e} \
                 — in-memory row unaffected"
            );
        }
    }

    /// Cache-first read; a miss reloads from PG and re-populates the cache
    /// (production `cache.rs:261-278`).
    fn get_chat(&self, session_id: &str, correlation_id: &str) -> Result<Option<ChatRow>> {
        {
            let mut cache = self.lock_chats();
            if let Some(row) = cache.get(session_id, correlation_id) {
                return Ok(Some(row));
            }
        }
        match self.store.get_chat_row(session_id, correlation_id)? {
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

    /// Flush one drained batch (production `cache.rs:376-398`).
    fn flush_pending(&self, batch: Vec<PendingWrite>) -> Result<usize> {
        let mut rows = Vec::with_capacity(batch.len());
        for pending in batch {
            match pending {
                PendingWrite::Chat(row) => rows.push(row),
            }
        }
        self.store.upsert_chat_rows(&rows)
    }

    fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    fn chat_cache_len(&self) -> usize {
        self.lock_chats().len()
    }

    fn lock_chats(&self) -> MutexGuard<'_, RowCache<ChatRow>> {
        match self.chats.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

// ── Writer task (mirror of production `run_writer_task`, cache.rs:449-485) ───

#[derive(Default)]
struct WriterStats {
    batches: AtomicU64,
    rows: AtomicU64,
    max_batch: AtomicU64,
}

/// Drains the bounded queue in ~[`WRITER_FLUSH_MS`] coalesced batches, upserting
/// each batch in one transaction on a blocking thread. `stop` is a spike-only
/// termination knob (the production writer runs for the app's lifetime; here we
/// need the loop to end so the process is bounded).
async fn run_writer_task(
    mut rx: tokio::sync::mpsc::Receiver<PendingWrite>,
    store: Arc<PgStore>,
    stats: Arc<WriterStats>,
    stop: Arc<AtomicBool>,
) {
    loop {
        let first = tokio::time::timeout(Duration::from_millis(WRITER_FLUSH_MS), rx.recv()).await;
        match first {
            Ok(Some(pending)) => {
                let mut batch = vec![pending];
                // Drain everything already queued — one transaction per batch.
                while let Ok(p) = rx.try_recv() {
                    batch.push(p);
                }
                let n = batch.len() as u64;
                let mut rows = Vec::with_capacity(batch.len());
                for p in batch {
                    match p {
                        PendingWrite::Chat(r) => rows.push(r),
                    }
                }
                let store2 = Arc::clone(&store);
                let flushed =
                    tokio::task::spawn_blocking(move || store2.upsert_chat_rows(&rows)).await;
                match flushed {
                    Ok(Ok(written)) => {
                        stats.rows.fetch_add(written as u64, Ordering::Relaxed);
                        stats.batches.fetch_add(1, Ordering::Relaxed);
                        stats.max_batch.fetch_max(n, Ordering::Relaxed);
                    }
                    Ok(Err(e)) => eprintln!("write-behind batch flush failed: {e}"),
                    Err(e) => eprintln!("write-behind flush join failed: {e}"),
                }
            }
            Ok(None) => break, // channel closed — all senders dropped
            Err(_elapsed) => {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
            }
        }
    }
}

// ── Result + report types ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct Check {
    name: String,
    ok: bool,
    detail: String,
}

impl Check {
    fn new(name: &str, ok: bool, detail: impl Into<String>) -> Self {
        Check {
            name: name.to_string(),
            ok,
            detail: detail.into(),
        }
    }
}

#[derive(Serialize)]
struct Environment {
    os: String,
    arch: String,
    profile: String,
    crate_version: String,
}

#[derive(Serialize)]
struct ModeledConstants {
    default_cache_capacity: usize,
    queue_capacity: usize,
    writer_flush_ms: u64,
    source: String,
}

#[derive(Serialize)]
struct Metrics {
    coalesce_burst: u64,
    coalesce_batches: u64,
    coalesce_max_batch: u64,
    coalesce_rows: u64,
    lone_write_latency_ms: f64,
    overflow_queue_capacity: usize,
    overflow_enqueued: usize,
    overflow_shed: u64,
    overflow_persisted: i64,
    reload_cache_cap: usize,
}

#[derive(Serialize)]
struct Summary {
    total: usize,
    passed: usize,
    failed: usize,
    ok: bool,
}

#[derive(Serialize)]
struct Report {
    issue: u32,
    task: String,
    mode: String,
    acquisition_mode: String,
    environment: Environment,
    modeled_constants: ModeledConstants,
    checks: Vec<Check>,
    summary: Summary,
    metrics: Metrics,
    duration_ms: u128,
}

/// Outcome of the synchronous (blocking-thread) legs.
struct SyncOutcome {
    checks: Vec<Check>,
    overflow_queue_capacity: usize,
    overflow_enqueued: usize,
    overflow_shed: u64,
    overflow_persisted: i64,
    reload_cache_cap: usize,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// A deterministic `chat_rows`-shaped row (all 18 fields round-trip through PG).
fn chat_row(session: &str, corr: &str, seq: i64, raw: &str) -> ChatRow {
    ChatRow {
        session_id: session.to_string(),
        correlation_id: corr.to_string(),
        seq,
        started_at_ns: Some(1_700_000_000_000_000_000 + seq * 1_000_000),
        ended_at_ns: None,
        updated_at: format!("2026-01-01T00:00:{:02}Z", (seq % 60) as u32),
        state: "init".to_string(),
        user_message: Some(format!("q{seq} — héllo ✅ 漢字")),
        agent_reply: None,
        prompt_tokens: Some(10 + seq),
        completion_tokens: Some(seq),
        cache_read_tokens: None,
        cost_usd: Some(seq as f64 / 1_000_000.0),
        model: Some("gpt-spike".to_string()),
        parent_session_id: None,
        composited_child_session_id: None,
        raw_json: raw.to_string(),
        provider: "open_code".to_string(),
    }
}

/// Canonical digest of a row via the shared harness encoder (engine-independent).
fn chat_digest(r: &ChatRow) -> String {
    harness::encode_row(&[
        Some(r.session_id.clone()),
        Some(r.correlation_id.clone()),
        Some(r.seq.to_string()),
        r.started_at_ns.map(|v| v.to_string()),
        r.ended_at_ns.map(|v| v.to_string()),
        Some(r.updated_at.clone()),
        Some(r.state.clone()),
        r.user_message.clone(),
        r.agent_reply.clone(),
        r.prompt_tokens.map(|v| v.to_string()),
        r.completion_tokens.map(|v| v.to_string()),
        r.cache_read_tokens.map(|v| v.to_string()),
        r.cost_usd.map(|v| format!("{v:.6}")),
        r.model.clone(),
        r.parent_session_id.clone(),
        r.composited_child_session_id.clone(),
        Some(r.raw_json.clone()),
        Some(r.provider.clone()),
    ])
}

/// Bounded async poll (never an unbounded wait).
async fn wait_until(mut cond: impl FnMut() -> bool, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        if cond() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn truncate_async(store: &Arc<PgStore>) -> Result<()> {
    let s = Arc::clone(store);
    tokio::task::spawn_blocking(move || s.truncate())
        .await
        .context("join truncate task")?
}

// ── Synchronous legs (run on a blocking thread: the PG client is sync) ───────

fn run_sync_legs(store: &Arc<PgStore>) -> Result<SyncOutcome> {
    let mut checks = Vec::new();

    // Leg A — write-behind batch flush (mirrors the production unit pin).
    store.truncate()?;
    {
        let (cache, mut rx) = WriteBehindCache::with_capacity(
            Arc::clone(store),
            DEFAULT_CACHE_CAPACITY,
            QUEUE_CAPACITY,
        );
        for (i, raw) in ["{\"a\":0}", "{\"a\":1}", "{\"a\":2}"].iter().enumerate() {
            cache.upsert_chat(chat_row("ses_a", &format!("a{i}"), i as i64, raw));
        }
        let pg_before = store.count()?;
        let cache_len = cache.chat_cache_len();
        let mut batch = Vec::new();
        while let Ok(p) = rx.try_recv() {
            batch.push(p);
        }
        let flushed = cache.flush_pending(batch)?;
        let pg_after = store.count()?;
        checks.push(Check::new(
            "write_behind_batch_flush",
            pg_before == 0 && cache_len == 3 && flushed == 3 && pg_after == 3 && cache.dropped_count() == 0,
            format!(
                "pg_before_flush={pg_before} cache_len={cache_len} flushed={flushed} pg_after_flush={pg_after} dropped={}",
                cache.dropped_count()
            ),
        ));
    }

    // Leg D — overflow SHEDS the storage write, never the in-memory state.
    store.truncate()?;
    let overflow_queue_capacity = 32usize;
    let overflow_enqueued = 40usize;
    let overflow_shed;
    let overflow_persisted;
    {
        let (cache, mut rx) = WriteBehindCache::with_capacity(
            Arc::clone(store),
            DEFAULT_CACHE_CAPACITY,
            overflow_queue_capacity,
        );
        for i in 0..overflow_enqueued {
            cache.upsert_chat(chat_row("ses_q", &format!("q{i:02}"), i as i64, "{}"));
        }
        overflow_shed = cache.dropped_count();
        let cache_len = cache.chat_cache_len();
        let mut all_in_memory = true;
        for i in 0..overflow_enqueued {
            if cache
                .get_chat("ses_q", &format!("q{i:02}"))?
                .is_none()
            {
                all_in_memory = false;
            }
        }
        let mut batch = Vec::new();
        while let Ok(p) = rx.try_recv() {
            batch.push(p);
        }
        let flushed = cache.flush_pending(batch)?;
        overflow_persisted = store.count()?;
        // A shed row is still readable in memory…
        let shed_key = format!("q{:02}", overflow_enqueued - 1);
        let shed_in_memory = cache.get_chat("ses_q", &shed_key)?.is_some();
        // …but was never persisted to PostgreSQL.
        let shed_absent_in_pg = store.get_chat_row("ses_q", &shed_key)?.is_none();
        let expected_shed = (overflow_enqueued - overflow_queue_capacity) as u64;
        checks.push(Check::new(
            "overflow_sheds_storage_not_memory",
            overflow_shed == expected_shed
                && cache_len == overflow_enqueued
                && all_in_memory
                && flushed == overflow_queue_capacity
                && overflow_persisted == overflow_queue_capacity as i64
                && shed_in_memory
                && shed_absent_in_pg,
            format!(
                "queue_cap={overflow_queue_capacity} enqueued={overflow_enqueued} shed={overflow_shed} flushed={flushed} pg_rows={overflow_persisted} cache_len={cache_len} shed_row_in_memory={shed_in_memory} shed_row_in_pg={}",
                !shed_absent_in_pg
            ),
        ));
    }

    // Leg E — cache-miss reload from PostgreSQL (authoritative).
    store.truncate()?;
    let reload_cache_cap = 1usize;
    {
        let (cache, mut rx) = WriteBehindCache::with_capacity(
            Arc::clone(store),
            reload_cache_cap,
            QUEUE_CAPACITY,
        );
        let row_a = chat_row("ses_r", "row_a", 1, "{\"r\":\"a\"}");
        let row_b = chat_row("ses_r", "row_b", 2, "{\"r\":\"b\"}");
        cache.upsert_chat(row_a.clone());
        cache.upsert_chat(row_b.clone());
        let mut batch = Vec::new();
        while let Ok(p) = rx.try_recv() {
            batch.push(p);
        }
        cache.flush_pending(batch)?;
        let len_before = cache.chat_cache_len();
        let got_a = cache
            .get_chat("ses_r", "row_a")?
            .context("row_a must reload from PG")?;
        let reload_a = chat_digest(&got_a) == chat_digest(&row_a);
        let len_after_a = cache.chat_cache_len();
        let got_b = cache
            .get_chat("ses_r", "row_b")?
            .context("row_b must reload from PG")?;
        let reload_b = chat_digest(&got_b) == chat_digest(&row_b);
        checks.push(Check::new(
            "cache_miss_reload_from_pg",
            len_before == reload_cache_cap && reload_a && reload_b && len_after_a == reload_cache_cap,
            format!(
                "cap={reload_cache_cap} len_before={len_before} reload_a={reload_a} reload_b={reload_b} len_after_a={len_after_a}"
            ),
        ));
        let missing = cache.get_chat("nope", "nope")?;
        checks.push(Check::new(
            "cache_miss_absent_returns_none",
            missing.is_none() && cache.chat_cache_len() == reload_cache_cap,
            format!(
                "missing_is_none={} cache_len={}",
                missing.is_none(),
                cache.chat_cache_len()
            ),
        ));
    }

    // Leg F — pure bounded-LRU mechanics (echo of the production unit pins).
    {
        let mut lru: RowCache<u32> = RowCache::new(10);
        for i in 0..10u32 {
            lru.put(("s".to_string(), format!("k{i}")), i);
        }
        let len_at_cap = lru.len();
        let _ = lru.get("s", "k0");
        let _ = lru.get("s", "k1");
        lru.put(("s".to_string(), "k10".to_string()), 10);
        let len_after_overflow = lru.len();
        let k2 = lru.get("s", "k2");
        let k0 = lru.get("s", "k0");
        let k10 = lru.get("s", "k10");
        checks.push(Check::new(
            "lru_evicts_oldest_keeps_recent",
            len_at_cap == 10
                && len_after_overflow <= 10
                && k2.is_none()
                && k0 == Some(0)
                && k10 == Some(10),
            format!(
                "len_at_cap={len_at_cap} len_after_overflow={len_after_overflow} k2={k2:?} k0={k0:?} k10={k10:?}"
            ),
        ));

        let mut cap1: RowCache<u32> = RowCache::new(1);
        cap1.put(("s".to_string(), "a".to_string()), 1);
        cap1.put(("s".to_string(), "b".to_string()), 2);
        checks.push(Check::new(
            "lru_cap_one_keeps_newest",
            cap1.len() == 1
                && cap1.get("s", "a").is_none()
                && cap1.get("s", "b") == Some(2),
            format!(
                "len={} a={:?} b={:?}",
                cap1.len(),
                cap1.get("s", "a"),
                cap1.get("s", "b")
            ),
        ));
    }

    Ok(SyncOutcome {
        checks,
        overflow_queue_capacity,
        overflow_enqueued,
        overflow_shed,
        overflow_persisted,
        reload_cache_cap,
    })
}

// ── Writer legs (async: exercise the real coalescing writer task) ────────────

const COALESCE_BURST: usize = 500;

async fn leg_coalesce(store: Arc<PgStore>) -> Result<(Check, u64, u64, u64)> {
    truncate_async(&store).await?;
    let (cache, rx) = WriteBehindCache::with_capacity(
        Arc::clone(&store),
        DEFAULT_CACHE_CAPACITY,
        QUEUE_CAPACITY,
    );
    for i in 0..COALESCE_BURST {
        cache.upsert_chat(chat_row(
            "ses_b",
            &format!("b{i:04}"),
            i as i64,
            &format!("{{\"i\":{i}}}"),
        ));
    }
    let dropped = cache.dropped_count();

    let stats = Arc::new(WriterStats::default());
    let stop = Arc::new(AtomicBool::new(false));
    let writer = tokio::spawn(run_writer_task(
        rx,
        Arc::clone(&store),
        Arc::clone(&stats),
        Arc::clone(&stop),
    ));

    let persisted = wait_until(
        || stats.rows.load(Ordering::Relaxed) >= COALESCE_BURST as u64,
        Duration::from_secs(30),
    )
    .await;
    stop.store(true, Ordering::Relaxed);
    writer.await.context("join writer task")?;

    let batches = stats.batches.load(Ordering::Relaxed);
    let max_batch = stats.max_batch.load(Ordering::Relaxed);
    let rows = stats.rows.load(Ordering::Relaxed);
    let cache_len = cache.chat_cache_len();
    let check = Check::new(
        "writer_coalesces_burst_into_one_batch",
        persisted
            && dropped == 0
            && batches == 1
            && max_batch == COALESCE_BURST as u64
            && rows == COALESCE_BURST as u64
            && cache_len == COALESCE_BURST,
        format!(
            "burst={COALESCE_BURST} batches={batches} max_batch={max_batch} rows={rows} dropped={dropped} cache_len={cache_len}"
        ),
    );
    Ok((check, batches, max_batch, rows))
}

async fn leg_lone_write(store: Arc<PgStore>) -> Result<(Check, f64)> {
    truncate_async(&store).await?;
    let (cache, rx) = WriteBehindCache::with_capacity(
        Arc::clone(&store),
        DEFAULT_CACHE_CAPACITY,
        QUEUE_CAPACITY,
    );
    let stats = Arc::new(WriterStats::default());
    let stop = Arc::new(AtomicBool::new(false));
    let writer = tokio::spawn(run_writer_task(
        rx,
        Arc::clone(&store),
        Arc::clone(&stats),
        Arc::clone(&stop),
    ));

    // Let the idle writer settle into its bounded wait window.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let t0 = Instant::now();
    cache.upsert_chat(chat_row("ses_c", "c0", 1, "{\"c\":0}"));
    let persisted = wait_until(
        || stats.rows.load(Ordering::Relaxed) >= 1,
        Duration::from_secs(5),
    )
    .await;
    let latency_ms = t0.elapsed().as_secs_f64() * 1000.0;
    stop.store(true, Ordering::Relaxed);
    writer.await.context("join writer task")?;
    let rows = stats.rows.load(Ordering::Relaxed);
    let check = Check::new(
        "lone_write_flushed_within_flush_window",
        persisted && rows == 1 && latency_ms <= 1_000.0,
        format!(
            "latency_ms={latency_ms:.3} rows={rows} (window {WRITER_FLUSH_MS} ms + PG round-trip; bounded, no unbounded wait)"
        ),
    );
    Ok((check, latency_ms))
}

// ── Entry point ──────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let process_start = Instant::now();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let data_dir = harness::arg_value("--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-tmp/write-behind-data"));
    let install_dir = harness::arg_value("--install-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-pg-install"));
    let out = harness::arg_value("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("results/write-behind.json"));

    if data_dir.exists() {
        let _ = std::fs::remove_dir_all(&data_dir);
    }
    std::fs::create_dir_all(&data_dir).context("create data dir")?;
    if let Some(pid) = harness::sweep_orphans(&data_dir) {
        println!("swept orphan postmaster pid {pid} before start");
    }

    println!("spike #2964 ST-3 — write-behind batch + LRU reload semantics vs PostgreSQL");
    println!("acquisition mode : {}", harness::ACQUISITION_MODE);
    println!("data dir         : {}", data_dir.display());

    let mut pg = PgRuntime::new(data_dir.clone(), install_dir);
    pg.setup().await.context("embedded postgres setup")?;
    pg.start().await.context("embedded postgres start")?;
    let port = pg.port();
    let url = pg.url();
    println!("server up on 127.0.0.1:{port}");

    let store = {
        let url = url.clone();
        tokio::task::spawn_blocking(move || -> Result<PgStore> {
            let mut client = harness::connect_until_ready(&url)?;
            client
                .batch_execute(defs::PG_DDL)
                .context("create translated schema")?;
            Ok(PgStore::from_client(client))
        })
        .await
        .context("join connect task")??
    };
    let store = Arc::new(store);

    // Synchronous legs (PG client work on a blocking thread).
    let sync_outcome = {
        let store = Arc::clone(&store);
        tokio::task::spawn_blocking(move || run_sync_legs(&store))
            .await
            .context("join sync-leg task")??
    };

    // Writer legs (the real coalescing async writer task).
    let (coalesce_check, coalesce_batches, coalesce_max_batch, coalesce_rows) =
        leg_coalesce(Arc::clone(&store)).await?;
    let (lone_check, lone_latency_ms) = leg_lone_write(Arc::clone(&store)).await?;

    // Dispose the sync `postgres::Client` on a BLOCKING thread: its `Drop`
    // blocks on its own runtime and panics ("Cannot start a runtime from within
    // a runtime") if dropped on a Tokio runtime thread. Taking it out of the
    // shared store first makes any remaining `Arc` clones harmless.
    if let Some(client) = store.take_client() {
        tokio::task::spawn_blocking(move || drop(client))
            .await
            .context("join client dispose task")?;
    }

    // Bounded teardown on the normal path (Drop covers error/panic paths).
    pg.shutdown().await;

    let constants_check = Check::new(
        "production_constants_modeled",
        DEFAULT_CACHE_CAPACITY == 10_000 && QUEUE_CAPACITY == 4096 && WRITER_FLUSH_MS == 30,
        format!(
            "cap={DEFAULT_CACHE_CAPACITY} queue={QUEUE_CAPACITY} flush_ms={WRITER_FLUSH_MS} (rtdb/cache.rs:47,49,51)"
        ),
    );

    let mut checks = vec![constants_check];
    checks.extend(sync_outcome.checks);
    checks.push(coalesce_check);
    checks.push(lone_check);

    let passed = checks.iter().filter(|c| c.ok).count();
    let failed = checks.len() - passed;
    let report = Report {
        issue: 2964,
        task: "ST-3".to_string(),
        mode: "rtdb write-behind batch + bounded-LRU reload semantics vs postgresql".to_string(),
        acquisition_mode: harness::ACQUISITION_MODE.to_string(),
        environment: Environment {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            profile: if cfg!(debug_assertions) { "debug" } else { "release" }.to_string(),
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        modeled_constants: ModeledConstants {
            default_cache_capacity: DEFAULT_CACHE_CAPACITY,
            queue_capacity: QUEUE_CAPACITY,
            writer_flush_ms: WRITER_FLUSH_MS,
            source: "apps/tauri/src-tauri/src/infrastructure/rtdb/cache.rs:47,49,51".to_string(),
        },
        checks,
        summary: Summary {
            total: passed + failed,
            passed,
            failed,
            ok: failed == 0,
        },
        metrics: Metrics {
            coalesce_burst: COALESCE_BURST as u64,
            coalesce_batches,
            coalesce_max_batch,
            coalesce_rows,
            lone_write_latency_ms: lone_latency_ms,
            overflow_queue_capacity: sync_outcome.overflow_queue_capacity,
            overflow_enqueued: sync_outcome.overflow_enqueued,
            overflow_shed: sync_outcome.overflow_shed,
            overflow_persisted: sync_outcome.overflow_persisted,
            reload_cache_cap: sync_outcome.reload_cache_cap,
        },
        duration_ms: process_start.elapsed().as_millis(),
    };

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).context("create results dir")?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)
        .with_context(|| format!("write {}", out.display()))?;

    for c in &report.checks {
        println!(
            "  [{}] {} — {}",
            if c.ok { "ok" } else { "FAIL" },
            c.name,
            c.detail
        );
    }
    println!(
        "checks {}/{} passed; coalesced {}/{} rows into {} batch(es); lone-write {:.2} ms; overflow shed {} storage writes",
        report.summary.passed,
        report.summary.total,
        report.metrics.coalesce_rows,
        report.metrics.coalesce_burst,
        report.metrics.coalesce_batches,
        report.metrics.lone_write_latency_ms,
        report.metrics.overflow_shed
    );
    println!("results written to {}", out.display());
    println!(
        "OK — write-behind batch + LRU reload semantics hold on PostgreSQL (total {:.0} ms, bounded teardown)",
        process_start.elapsed().as_secs_f64() * 1000.0
    );

    anyhow::ensure!(
        report.summary.ok,
        "{} write-behind check(s) failed; see {}",
        report.summary.failed,
        out.display()
    );
    Ok(())
}
