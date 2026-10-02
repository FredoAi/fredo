//! RTDB IPC commands + orchestrator (Spec #2788, P2.3, REQs R-1c/R-2a/R-2b/
//! R-2d/R-3a).
//!
//! [`Rtdb`] is the composition point of the live row pipeline:
//!
//! ```text
//! ingest_row_upsert (P3.1 classifier calls this)
//!   → seq from RtdbStore::next_seq (durable, P1.2)
//!   → RtdbCache upsert (sync cache + write-behind queue, P1.2)
//!   → SubscriptionRegistry::match_mutation (P2.2) → RowDeliveries
//!   → FlushLoop (this module's flush.rs) → EventBus.emit_row_delivery_batch
//! ```
//!
//! Retention evictions flow the same way: `RtdbStore::prune` (P1.2, extended
//! in P2.3) returns the evicted `(kind, key)` set →
//! [`Rtdb::route_evictions`] → `match_removal` → `kind: remove` deliveries.
//! The eviction path is the ONLY producer of `remove` (R-2d).
//!
//! Replay (R-2a): a `replay: true` subscribe registers the LIVE subscription
//! FIRST, then reads the SQLite snapshot (equality/comparison args pushed
//! down to typed columns where the arg path maps 1:1; compound/JSON paths
//! filter in-memory — actually the registry re-evaluates every arg on each
//! snapshot row, so pushdown is purely a read-narrowing optimization and can
//! never widen or skew results), emitting full-row `insert` deliveries before
//! live patches flow. No gap, no lost update: a row living only in the
//! cache (write-behind lag) was ingested through the live path and already
//! routed; a row only in SQLite is covered by the snapshot; a mutation that
//! lands mid-replay registers membership before the snapshot leg sees it, so
//! the snapshot cannot double-deliver it (see [`replay_query_on`]).
//!
//! Round-3 F-33 fix — the replay leg is a BACKGROUND DRAIN: the IPC command
//! is `async` (never the main thread) and hands the snapshot SELECT +
//! delivery build to `tauri::async_runtime::spawn` (never `tokio::spawn`)
//! immediately after registration, returning the `Vec<RegisteredQuery>`
//! without awaiting it. Each query's drain ends with the replay-completion
//! marker ([`FlushLoop::mark_replay_complete`] → the terminal envelope's
//! `replayCompleteQueryId`), the frontend's deterministic settle signal.
//!
//! The IPC surface (consumed by P4.1's frontend, verbatim):
//! - `subscribe_events(queries, replay, flushMs)` → `Vec<RegisteredQuery>` |
//!   `Vec<String>` — queries are QUERY TEXT strings; the backend parses.
//!   ANY parse/validate failure returns the hard named error vec and
//!   registers NOTHING (zero partial registration).
//! - `unsubscribe_events(queryIds)` → `()`.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;

use crate::infrastructure::rtdb::cache::RtdbCache;
use crate::infrastructure::rtdb::flush::{FlushLoop, DEFAULT_FLUSH_MS};
use crate::infrastructure::rtdb::project::{RowChangeKind, RowDelivery, RowKey, RowSnapshot};
use crate::infrastructure::rtdb::query::{
    parse, validate, CompareOp, EventTypeArg, QueryArg, ValidatedQuery,
};
use crate::infrastructure::rtdb::rows::{
    AgentSessionRow, ChatRow, ToolUseRow, AGENT_SESSION_FIELDS, CHAT_FIELDS, TOOL_USE_FIELDS,
};
use crate::infrastructure::rtdb::store::{EvictedKey, RowKind, SqlValue};
use crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry;

// ── IPC types ───────────────────────────────────────────────────────────────

/// One successfully registered subscription — the `subscribe_events` success
/// element (P4.1 consumes these verbatim).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredQuery {
    pub query_id: String,
    pub event_type: EventTypeArg,
}

// ── Ingestion row ───────────────────────────────────────────────────────────

/// A live row mutation entering the pipeline. The classifier (P3.1) builds
/// the merged row and calls [`Rtdb::ingest_row_upsert`] with the camelCase
/// names of the fields its merge patch touched.
#[derive(Clone, Debug)]
pub enum IngestRow {
    Chat(ChatRow),
    ToolUse(ToolUseRow),
    AgentSession(AgentSessionRow),
}

impl IngestRow {
    fn kind(&self) -> RowKind {
        match self {
            IngestRow::Chat(_) => RowKind::Chat,
            IngestRow::ToolUse(_) => RowKind::ToolUse,
            IngestRow::AgentSession(_) => RowKind::AgentSession,
        }
    }

    fn key(&self) -> RowKey {
        let (session_id, correlation_id) = match self {
            IngestRow::Chat(row) => (&row.session_id, &row.correlation_id),
            IngestRow::ToolUse(row) => (&row.session_id, &row.correlation_id),
            IngestRow::AgentSession(row) => (&row.session_id, &row.correlation_id),
        };
        RowKey {
            session_id: session_id.clone(),
            correlation_id: correlation_id.clone(),
        }
    }

    fn with_seq(self, seq: i64) -> Self {
        match self {
            IngestRow::Chat(mut row) => {
                row.seq = seq;
                IngestRow::Chat(row)
            }
            IngestRow::ToolUse(mut row) => {
                row.seq = seq;
                IngestRow::ToolUse(row)
            }
            IngestRow::AgentSession(mut row) => {
                row.seq = seq;
                IngestRow::AgentSession(row)
            }
        }
    }

    fn as_snapshot(&self) -> RowSnapshot<'_> {
        match self {
            IngestRow::Chat(row) => RowSnapshot::Chat(row),
            IngestRow::ToolUse(row) => RowSnapshot::ToolUse(row),
            IngestRow::AgentSession(row) => RowSnapshot::AgentSession(row),
        }
    }
}

// ── Rtdb orchestrator ───────────────────────────────────────────────────────

/// Composition point of the RTDB live pipeline: registry (P2.2) + row cache
/// (P1.2) + flush loop (P2.3). Shared behind Tauri state as `Arc<Rtdb>`.
pub struct Rtdb {
    registry: Arc<SubscriptionRegistry>,
    cache: Arc<RtdbCache>,
    flush: Arc<FlushLoop>,
}

impl Rtdb {
    pub fn new(
        cache: Arc<RtdbCache>,
        registry: Arc<SubscriptionRegistry>,
        flush: Arc<FlushLoop>,
    ) -> Self {
        Rtdb {
            registry,
            cache,
            flush,
        }
    }

    /// The row cache (store access for tests + the write-behind pipeline).
    pub fn cache(&self) -> &Arc<RtdbCache> {
        &self.cache
    }

    /// Emit every coalescing window that is due right now. Normally driven by
    /// the background flush task (lib.rs); exposed for tests and diagnostics.
    pub fn flush_due(&self) -> usize {
        self.flush.flush_due()
    }

    /// The subscription registry (tests/diagnostics).
    pub fn registry(&self) -> &Arc<SubscriptionRegistry> {
        &self.registry
    }

    // ── Subscribe / unsubscribe ─────────────────────────────────────────────

    /// Parse + validate every query text, then register the survivors.
    /// ANY failure returns the hard named error vec (the offending query text
    /// is embedded by the P2.1 error Display) and registers NOTHING — zero
    /// partial registration.
    pub fn register_queries(
        &self,
        queries: &[String],
        flush_ms: Option<u32>,
    ) -> Result<Vec<RegisteredQuery>, Vec<String>> {
        let validated = validate_all(queries)?;
        let window = flush_ms.map_or(DEFAULT_FLUSH_MS, u64::from);
        Ok(self.register_validated(validated, window))
    }

    /// Subscribe with optional replay (R-2a): register the live subscription
    /// FIRST, then — when `replay` is set — hand the replay leg to
    /// [`tauri::async_runtime::spawn`] (never `tokio::spawn`) and return
    /// immediately (round-3 F-33 fix: the full-table snapshot SELECT +
    /// per-row delivery build must never run on the caller's thread; the
    /// caller is the async IPC command and the drain is a background task).
    pub fn subscribe(
        &self,
        queries: &[String],
        replay: bool,
        flush_ms: Option<u32>,
    ) -> Result<Vec<RegisteredQuery>, Vec<String>> {
        let validated = validate_all(queries)?;
        let window = flush_ms.map_or(DEFAULT_FLUSH_MS, u64::from);
        let registered = self.register_validated(validated.clone(), window);
        if replay {
            self.spawn_replay_leg(registered.clone(), validated);
        }
        Ok(registered)
    }

    /// Spawn the replay leg onto the async runtime (round-3 F-33 fix; Spec
    /// #2976 ST-4 moved it off `spawn_blocking` to `tauri::async_runtime::spawn`).
    ///
    /// Registration has ALREADY happened before this task is spawned — the
    /// registry's membership cut is taken first (register-before-snapshot),
    /// so a mutation landing mid-replay is live-delivered and the snapshot
    /// skips the key; one landing after the snapshot leg coalesces by seq.
    /// Both interleavings stay pinned by the concurrent-mutation tests.
    ///
    /// The leg signals per-query completion through
    /// [`FlushLoop::mark_replay_complete`] on BOTH the success and the
    /// failure path (a replay failure never un-subscribes the live path —
    /// the delivery stream keeps working, the client just misses the
    /// historical rows — and the frontend `ready` gate must never wedge).
    /// The join handle is detached: replay is a background drain (NFR-1).
    fn spawn_replay_leg(&self, registered: Vec<RegisteredQuery>, validated: Vec<ValidatedQuery>) {
        let cache = Arc::clone(&self.cache);
        let registry = Arc::clone(&self.registry);
        let flush = Arc::clone(&self.flush);
        tauri::async_runtime::spawn(async move {
            for (entry, query) in registered.iter().zip(validated.iter()) {
                if let Err(e) =
                    replay_query_on(&cache, &registry, &flush, &entry.query_id, query).await
                {
                    tracing::error!(
                        target: "fredo::rtdb",
                        query_id = %entry.query_id,
                        error = %e,
                        "rtdb replay failed — live subscription stays active"
                    );
                }
                flush.mark_replay_complete(&entry.query_id);
            }
        });
    }

    /// Remove subscriptions (idempotent on unknown ids). Pending unflushed
    /// deliveries of the queries are discarded.
    pub fn unsubscribe(&self, query_ids: &[String]) {
        for query_id in query_ids {
            self.registry.unregister(query_id);
            self.flush.drop_query(query_id);
        }
    }

    fn register_validated(
        &self,
        validated: Vec<ValidatedQuery>,
        window: u64,
    ) -> Vec<RegisteredQuery> {
        validated
            .into_iter()
            .map(|query| {
                let query_id = self.registry.register(query.clone());
                self.flush.set_window(&query_id, window);
                RegisteredQuery {
                    query_id,
                    event_type: query.event_type,
                }
            })
            .collect()
    }

    // ── Replay (R-2a) ───────────────────────────────────────────────────────

    /// Run one query's SQL snapshot and route it as full-row `insert`
    /// deliveries (async form — the spawned leg and the tests use the free
    /// function [`replay_query_on`] directly; this thin wrapper keeps the
    /// `Rtdb` surface self-contained for diagnostics/tests).
    pub async fn replay_query(&self, query_id: &str, query: &ValidatedQuery) -> Result<usize> {
        replay_query_on(&self.cache, &self.registry, &self.flush, query_id, query).await
    }

    /// Signal one query's replay completion through the flush loop (the
    /// terminal `replayCompleteQueryId` envelope). Exposed for the spawned
    /// leg's tests — production wiring lives in [`Rtdb::spawn_replay_leg`].
    pub fn mark_replay_complete(&self, query_id: &str) {
        self.flush.mark_replay_complete(query_id);
    }

    // ── Live ingestion (P3.1's entry point) ─────────────────────────────────

    /// Ingest one live row mutation: allocate the durable per-key seq (P1.2,
    /// seeded from MAX(seq)), upsert through the cache (sync cache + bounded
    /// write-behind queue), route through the registry, and hand the
    /// resulting deliveries to the flush loop. `changed_fields` holds the
    /// camelCase names of the fields the caller's merge patch touched.
    ///
    /// Delivery is NEVER shed — only the storage write can be (P1.2 queue
    /// overflow), matching R-2d.
    pub async fn ingest_row_upsert(
        &self,
        row: IngestRow,
        changed_fields: &[String],
    ) -> Result<usize> {
        let kind = row.kind();
        let key = row.key();
        let seq = self
            .cache
            .store()
            .next_seq(kind, &key.session_id, &key.correlation_id)
            .await?;
        let row = row.with_seq(seq);
        // Feature-data projection seam (Spec #2896 ST-3): every canonical upsert
        // is offered to the installed observer, unconditionally — never gated by
        // subscriptions or an open feature UI (R-4.2). A no-op when the
        // feature-data layer is not composed (existing RTDB tests, CLI mode).
        crate::infrastructure::feature_data::projection::dispatch_row_upsert(&row, changed_fields)
            .await;
        match &row {
            IngestRow::Chat(chat) => self.cache.upsert_chat(chat.clone()),
            IngestRow::ToolUse(tool) => self.cache.upsert_tool_use(tool.clone()),
            IngestRow::AgentSession(session) => self.cache.upsert_agent_session(session.clone()),
        }
        let snapshot = row.as_snapshot();
        let mut forwarded = 0usize;
        for delivery in
            self.registry
                .match_mutation(event_type_of(kind), &key, &snapshot, changed_fields)
        {
            // project.rs contract: an Update with no changed fields is an
            // empty envelope — callers should not emit one.
            if is_empty_update(&delivery) {
                continue;
            }
            self.flush.enqueue(delivery);
            forwarded += 1;
        }
        Ok(forwarded)
    }

    // ── Retention-eviction routing (R-2d: the ONLY remove producer) ─────────

    /// Route retention-evicted `(kind, key)` pairs (from the extended P1.2
    /// prune path) through the registry's `match_removal` — every query that
    /// holds the key in its result set receives a `kind: remove` delivery;
    /// non-matching subscribers receive nothing. Wired into
    /// `cache::prune_with_knobs` (writer task + lib.rs startup prune).
    pub fn route_evictions(&self, evicted: Vec<EvictedKey>) {
        for evicted in evicted {
            let event_type = event_type_of(evicted.kind);
            let key = RowKey {
                session_id: evicted.session_id,
                correlation_id: evicted.correlation_id,
            };
            for delivery in self.registry.match_removal(event_type, &key) {
                self.flush.enqueue(delivery);
            }
        }
    }
}

fn is_empty_update(delivery: &RowDelivery) -> bool {
    delivery.kind == RowChangeKind::Update
        && delivery
            .patch
            .as_ref()
            .and_then(|patch| patch.as_object())
            .is_some_and(serde_json::Map::is_empty)
}

/// Run one query's SQL snapshot and route it as full-row `insert`
/// deliveries. The live subscription MUST already be registered (the
/// registry's key-complete membership then decides the fate of every
/// snapshot row):
/// - not a member → `insert` (full row) — the normal replay case;
/// - already a member → skipped: a mutation landed mid-replay BEFORE this
///   row's snapshot leg, and the live path already delivered (or has
///   pending) its full-row insert with a NEWER seq. A replay-side update
///   would carry the STALE snapshot values, so it is never forwarded.
///
/// Either interleaving leaves the client with the correct final state —
/// proven by the concurrent-mutation tests below.
async fn replay_query_on(
    cache: &RtdbCache,
    registry: &SubscriptionRegistry,
    flush: &FlushLoop,
    query_id: &str,
    query: &ValidatedQuery,
) -> Result<usize> {
    tracing::debug!(
        target: "fredo::rtdb",
        query_id,
        event_type = query.event_type.as_str(),
        "rtdb replay snapshot starting"
    );
    let kind = row_kind(query.event_type);
    let (where_sql, params) = pushdown(query.event_type, &query.args);
    let rows = cache.store().select_snapshot(kind, &where_sql, params).await?;
    let changed = all_field_names(query.event_type);
    let mut forwarded = 0usize;
    for row in &rows {
        let key = row.key();
        for delivery in registry.match_mutation(query.event_type, &key, &row.as_snapshot(), &changed)
        {
            if delivery.kind != RowChangeKind::Insert {
                continue;
            }
            flush.enqueue(delivery);
            forwarded += 1;
        }
    }
    Ok(forwarded)
}

// ── Query validation (subscribe front door) ─────────────────────────────────

/// Parse + validate every query text. Collects ALL hard named errors (parse
/// errors rendered through the P2.1 Display carrying the query text) and
/// returns them as one vec when any query failed.
fn validate_all(queries: &[String]) -> Result<Vec<ValidatedQuery>, Vec<String>> {
    let mut validated = Vec::new();
    let mut errors = Vec::new();
    for text in queries {
        match parse(text) {
            Ok(spec) => match validate(&spec) {
                Ok(query) => validated.push(query),
                Err(mut errs) => errors.append(&mut errs),
            },
            Err(err) => errors.push(err.to_string()),
        }
    }
    if errors.is_empty() {
        Ok(validated)
    } else {
        Err(errors)
    }
}

// ── Replay pushdown (read-narrowing only — the registry re-checks all args) ─

/// Static column lists per row kind (snake_case — mirrors the P1.2 DDL).
fn columns_of(event_type: EventTypeArg) -> &'static [&'static str] {
    match event_type {
        EventTypeArg::Chat => &[
            "session_id",
            "correlation_id",
            "seq",
            "started_at_ns",
            "ended_at_ns",
            "updated_at",
            "state",
            "provider",
            "user_message",
            "agent_reply",
            "prompt_tokens",
            "completion_tokens",
            "cache_read_tokens",
            "cost_usd",
            "model",
            "parent_session_id",
            "composited_child_session_id",
            "raw_json",
        ],
        EventTypeArg::ToolUse => &[
            "session_id",
            "correlation_id",
            "seq",
            "started_at_ns",
            "ended_at_ns",
            "updated_at",
            "state",
            "provider",
            "tool_name",
            "tool_success",
            "tool_error",
            "duration_ms",
            "tool_input_json",
            "tool_output_json",
            "is_subagent",
            "raw_json",
        ],
        EventTypeArg::AgentSession => &[
            "session_id",
            "correlation_id",
            "seq",
            "started_at_ns",
            "ended_at_ns",
            "updated_at",
            "state",
            "provider",
            "total_tokens",
            "total_messages",
            "total_cost_usd",
            "agent_name",
            "raw_json",
        ],
    }
}

fn all_field_names(event_type: EventTypeArg) -> Vec<String> {
    let fields = match event_type {
        EventTypeArg::Chat => CHAT_FIELDS,
        EventTypeArg::ToolUse => TOOL_USE_FIELDS,
        EventTypeArg::AgentSession => AGENT_SESSION_FIELDS,
    };
    fields.iter().map(|name| (*name).to_string()).collect()
}

fn row_kind(event_type: EventTypeArg) -> RowKind {
    match event_type {
        EventTypeArg::Chat => RowKind::Chat,
        EventTypeArg::ToolUse => RowKind::ToolUse,
        EventTypeArg::AgentSession => RowKind::AgentSession,
    }
}

fn event_type_of(kind: RowKind) -> EventTypeArg {
    match kind {
        RowKind::Chat => EventTypeArg::Chat,
        RowKind::ToolUse => EventTypeArg::ToolUse,
        RowKind::AgentSession => EventTypeArg::AgentSession,
    }
}

fn camel_to_snake(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn op_sql(op: CompareOp) -> &'static str {
    match op {
        CompareOp::Eq => "=",
        CompareOp::Gt => ">",
        CompareOp::Gte => ">=",
        CompareOp::Lt => "<",
        CompareOp::Lte => "<=",
    }
}

fn to_sql_value(value: &serde_json::Value) -> Option<SqlValue> {
    match value {
        serde_json::Value::String(text) => Some(SqlValue::Text(text.clone())),
        serde_json::Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                Some(SqlValue::Integer(int))
            } else {
                number.as_f64().map(SqlValue::Real)
            }
        }
        serde_json::Value::Bool(flag) => Some(SqlValue::Integer(i64::from(*flag))),
        _ => None,
    }
}

/// Build the SQL WHERE clause narrowing a snapshot select to the args whose
/// single-segment path maps 1:1 onto a typed column. Compound/JSON paths and
/// null literals stay in-memory (the registry evaluates EVERY arg again on
/// each snapshot row, so a skipped pushdown only widens the select, never the
/// result). String ordering also stays in-memory: SQLite byte order vs Rust
/// lexicographic ordering can differ beyond ASCII.
fn pushdown(event_type: EventTypeArg, args: &[QueryArg]) -> (String, Vec<SqlValue>) {
    let columns = columns_of(event_type);
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for arg in args {
        let [field] = arg.field.as_slice() else {
            continue;
        };
        if matches!(arg.value, serde_json::Value::Null) {
            continue;
        }
        if matches!(arg.value, serde_json::Value::String(_)) && arg.op != CompareOp::Eq {
            continue;
        }
        let column = camel_to_snake(field);
        if !columns.contains(&column.as_str()) {
            continue;
        }
        let Some(sql_value) = to_sql_value(&arg.value) else {
            continue;
        };
        params.push(sql_value);
        clauses.push(format!("{column} {} ?{}", op_sql(arg.op), params.len()));
    }
    if clauses.is_empty() {
        ("1=1".to_string(), params)
    } else {
        (clauses.join(" AND "), params)
    }
}

// ── IPC commands (registered in lib.rs invoke_handler) ──────────────────────

/// Subscribe to RTDB row streams. `queries` are QUERY TEXT strings (the
/// backend is the parser — contract-trust). ANY parse/validate failure
/// returns the hard named error vec and registers NOTHING. `flushMs: 0` =
/// immediate emission for these queries; absent = ~30 ms coalescing.
///
/// Round-3 F-33 fix: the command is `async`, so Tauri v2 runs it on the
/// async runtime instead of the MAIN thread (the round-1/2 freeze: a sync
/// command running the full-table replay leg blocked the main thread →
/// "Not Responding" at MM mount). With `replay: true`, the snapshot leg is
/// additionally handed to `tauri::async_runtime::spawn` (never
/// `tokio::spawn`) inside [`Rtdb::subscribe`], so the command returns right
/// after registration and the snapshot drains in the background, terminated
/// per query by the `replayCompleteQueryId` marker envelope.
#[tauri::command]
pub async fn subscribe_events(
    app: tauri::AppHandle,
    queries: Vec<String>,
    replay: bool,
    flush_ms: Option<u32>,
) -> Result<Vec<RegisteredQuery>, Vec<String>> {
    let rtdb = app.state::<RtdbState>();
    rtdb.subscribe(&queries, replay, flush_ms)
}

/// Unsubscribe previously registered queries (idempotent on unknown ids).
#[tauri::command]
pub fn unsubscribe_events(app: tauri::AppHandle, query_ids: Vec<String>) {
    let rtdb = app.state::<RtdbState>();
    rtdb.unsubscribe(&query_ids);
}

/// Managed state alias — `app.manage(Arc::new(Rtdb::new(...)))` in lib.rs.
pub type RtdbState = Arc<Rtdb>;
