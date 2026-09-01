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
//!   → FlushLoop (this module's flush.rs) → EventBus.emit_row_delivery
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
//! the snapshot cannot double-deliver it (see [`Rtdb::replay_query`]).
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
use crate::infrastructure::rtdb::store::{EvictedKey, RowKind};
use crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry;
use rusqlite::types::Value as SqlValue;

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
    /// FIRST, then emit the snapshot as full-row inserts (see
    /// [`Rtdb::replay_query`]), then let live patches flow.
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
            for (entry, query) in registered.iter().zip(validated.iter()) {
                // A replay failure never un-subscribes the live path; the
                // delivery stream keeps working, the client just misses the
                // historical rows (R-2c: replay reads whatever SQLite holds).
                if let Err(e) = self.replay_query(&entry.query_id, query) {
                    tracing::error!(
                        target: "fredo::rtdb",
                        query_id = %entry.query_id,
                        error = %e,
                        "rtdb replay failed — live subscription stays active"
                    );
                }
            }
        }
        Ok(registered)
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
    /// deliveries. The live subscription MUST already be registered (the
    /// registry's key-complete membership then decides the fate of every
    /// snapshot row):
    /// - not a member → `insert` (full row) — the normal replay case;
    /// - already a member → skipped: a mutation landed mid-replay BEFORE this
    ///   row's snapshot leg, and the live path already delivered (or has
    ///   pending) its full-row insert with a NEWER seq. A replay-side update
    ///   would carry the STALE snapshot values, so it is never forwarded.
    /// Either interleaving leaves the client with the correct final state —
    /// proven by the concurrent-mutation tests below.
    pub fn replay_query(&self, query_id: &str, query: &ValidatedQuery) -> Result<usize> {
        tracing::debug!(
            target: "fredo::rtdb",
            query_id,
            event_type = query.event_type.as_str(),
            "rtdb replay snapshot starting"
        );
        let kind = row_kind(query.event_type);
        let (where_sql, params) = pushdown(query.event_type, &query.args);
        let rows = self
            .cache
            .store()
            .select_snapshot(kind, &where_sql, params)?;
        let changed = all_field_names(query.event_type);
        let mut forwarded = 0usize;
        for row in &rows {
            let key = row.key();
            for delivery in
                self.registry
                    .match_mutation(query.event_type, &key, &row.as_snapshot(), &changed)
            {
                if delivery.kind != RowChangeKind::Insert {
                    continue;
                }
                self.flush.enqueue(delivery);
                forwarded += 1;
            }
        }
        Ok(forwarded)
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
    pub fn ingest_row_upsert(&self, row: IngestRow, changed_fields: &[String]) -> Result<usize> {
        let kind = row.kind();
        let key = row.key();
        let seq = self
            .cache
            .store()
            .next_seq(kind, &key.session_id, &key.correlation_id)?;
        let row = row.with_seq(seq);
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
#[tauri::command]
pub fn subscribe_events(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::rtdb::flush::RowEmitter;
    use crate::infrastructure::rtdb::rows::RowState;
    use crate::infrastructure::rtdb::store::RtdbStore;
    use std::sync::Mutex;
    use std::time::Duration;

    // ── Fixtures ────────────────────────────────────────────────────────────

    type Sink = Arc<Mutex<Vec<RowDelivery>>>;

    fn make_rtdb() -> (
        tempfile::TempDir,
        Arc<Rtdb>,
        tokio::sync::mpsc::Receiver<crate::infrastructure::rtdb::cache::PendingWrite>,
        Sink,
    ) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(
            RtdbStore::open(dir.path().to_path_buf()).expect("open store"),
        );
        store.ensure_schema().expect("schema");
        let (cache, rx) = RtdbCache::new(store);
        let registry = Arc::new(SubscriptionRegistry::new());
        let sink: Sink = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&sink);
        let emitter: RowEmitter = Arc::new(move |deliveries: &[RowDelivery]| {
            capture
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(deliveries);
        });
        let flush = Arc::new(FlushLoop::new(emitter));
        let rtdb = Arc::new(Rtdb::new(cache, registry, flush));
        (dir, rtdb, rx, sink)
    }

    /// Drain the write-behind queue and persist the batch — tests that prune
    /// (or otherwise read SQLite) must first land the ingested rows.
    fn persist_write_behind(
        rtdb: &Rtdb,
        rx: &mut tokio::sync::mpsc::Receiver<crate::infrastructure::rtdb::cache::PendingWrite>,
    ) {
        let mut batch = Vec::new();
        while let Ok(pending) = rx.try_recv() {
            batch.push(pending);
        }
        rtdb.cache()
            .flush_pending(batch)
            .expect("write-behind flush");
    }

    fn chat_row(session: &str, correlation: &str, updated_at: &str) -> ChatRow {
        ChatRow {
            session_id: session.to_string(),
            correlation_id: correlation.to_string(),
            seq: 0,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: updated_at.to_string(),
            state: RowState::Init,
            user_message: Some("fix the bug".to_string()),
            agent_reply: None,
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cost_usd: None,
            model: Some("claude-sonnet-4".to_string()),
            parent_session_id: None,
            composited_child_session_id: None,
            raw_json: "{}".to_string(),
        }
    }

    fn emitted(sink: &Sink) -> Vec<RowDelivery> {
        sink.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Apply deliveries the way the P4.1 client will: insert = full-row
    /// replace, update = field merge, remove = drop. Returns the final
    /// (query_id, key) → patch-object state.
    fn apply_client(deliveries: &[RowDelivery]) -> std::collections::HashMap<(String, RowKey), serde_json::Map<String, serde_json::Value>> {
        let mut state = std::collections::HashMap::new();
        for delivery in deliveries {
            let entry_key = (delivery.query_id.clone(), delivery.key.clone());
            match delivery.kind {
                RowChangeKind::Remove => {
                    state.remove(&entry_key);
                }
                RowChangeKind::Insert => {
                    let mut row = serde_json::Map::new();
                    if let Some(serde_json::Value::Object(fields)) = &delivery.patch {
                        row.extend(fields.clone());
                    }
                    state.insert(entry_key, row);
                }
                RowChangeKind::Update => {
                    let row = state.entry(entry_key).or_default();
                    if let Some(serde_json::Value::Object(fields)) = &delivery.patch {
                        for (name, value) in fields {
                            row.insert(name.clone(), value.clone());
                        }
                    }
                }
            }
        }
        state
    }

    fn window_drain(rtdb: &Rtdb) {
        std::thread::sleep(Duration::from_millis(
            crate::infrastructure::rtdb::flush::DEFAULT_FLUSH_MS + 15,
        ));
        rtdb.flush_due();
    }

    // ── Subscribe validation (R-3a): named errors, zero partial registration ─

    #[test]
    fn typo_field_subscribes_return_the_named_error_with_the_query_text() {
        let (_dir, rtdb, _rx, _sink) = make_rtdb();
        let err = rtdb
            .subscribe(&["chat(promtTokens > 0) { userMessage }".to_string()], false, None)
            .expect_err("typo field must fail validation");
        assert_eq!(err.len(), 1);
        assert!(
            err[0].contains("promtTokens"),
            "error must name the offending field: {}",
            err[0]
        );
        assert!(
            err[0].contains("chat(promtTokens>0)"),
            "error must embed the query text: {}",
            err[0]
        );
        assert_eq!(rtdb.registry().subscription_count(), 0);
    }

    #[test]
    fn parse_error_subscribes_carry_the_offending_query_text() {
        let (_dir, rtdb, _rx, _sink) = make_rtdb();
        let err = rtdb
            .subscribe(&["chat(promptTokens >".to_string()], false, None)
            .expect_err("truncated query must fail to parse");
        assert!(
            err[0].contains("chat(promptTokens >"),
            "parse error must carry the raw query text: {}",
            err[0]
        );
        assert_eq!(rtdb.registry().subscription_count(), 0);
    }

    #[test]
    fn any_failure_registers_nothing_zero_partial_registration() {
        let (_dir, rtdb, _rx, _sink) = make_rtdb();
        let queries = vec![
            "chat(sessionId = \"s\") { userMessage }".to_string(),
            "chat(bogusField = 1) { userMessage }".to_string(),
        ];
        assert!(rtdb.subscribe(&queries, false, None).is_err());
        assert_eq!(
            rtdb.registry().subscription_count(),
            0,
            "the valid query must NOT be registered when its sibling fails"
        );
    }

    #[test]
    fn valid_subscribes_return_query_ids_and_event_types() {
        let (_dir, rtdb, _rx, _sink) = make_rtdb();
        let queries = vec![
            "chat(promptTokens > 0) { userMessage, agentReply }".to_string(),
            "toolUse(toolSuccess = true) { toolName }".to_string(),
        ];
        let registered = rtdb.subscribe(&queries, false, None).expect("subscribe");
        assert_eq!(registered.len(), 2);
        assert_ne!(registered[0].query_id, registered[1].query_id);
        assert_eq!(registered[0].event_type, EventTypeArg::Chat);
        assert_eq!(registered[1].event_type, EventTypeArg::ToolUse);
        assert_eq!(rtdb.registry().subscription_count(), 2);

        // camelCase wire shape (P4.1 consumes verbatim).
        let json = serde_json::to_value(&registered[0]).expect("serialize");
        assert!(json.get("queryId").is_some());
        assert!(json.get("eventType").is_some());
        assert_eq!(json.get("eventType"), Some(&serde_json::json!("Chat")));
    }

    // ── Live path: ingest → match → flush → emitter ─────────────────────────

    #[test]
    fn ingest_routes_deliveries_and_allocates_durable_seq() {
        let (_dir, rtdb, _rx, sink) = make_rtdb();
        rtdb.subscribe(
            &["chat(promptTokens > 0) { userMessage, agentReply }".to_string()],
            false,
            None,
        )
        .expect("subscribe");

        let mut row = chat_row("s_live", "s_live_1", "2026-08-31T00:00:00+00:00");
        row.prompt_tokens = Some(25);
        let changed = vec!["promptTokens".to_string(), "userMessage".to_string()];
        let forwarded = rtdb
            .ingest_row_upsert(IngestRow::Chat(row.clone()), &changed)
            .expect("ingest");
        assert_eq!(forwarded, 1);
        assert_eq!(
            rtdb.cache().store().next_seq(RowKind::Chat, "s_live", "s_live_1").expect("seq"),
            2,
            "seq was allocated 1 by the ingest and continues from MAX"
        );

        window_drain(&rtdb);
        let out = emitted(&sink);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, RowChangeKind::Insert);
        assert_eq!(out[0].seq, 1, "ingest stamped the allocated seq on the delivery");
        let patch = out[0].patch.as_ref().and_then(|p| p.as_object()).expect("patch");
        assert_eq!(patch.len(), 2, "insert respects the query's selection subset");
        assert_eq!(patch.get("userMessage"), Some(&serde_json::json!("fix the bug")));
        assert_eq!(patch.get("agentReply"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn live_update_after_insert_carries_only_changed_fields() {
        let (_dir, rtdb, _rx, sink) = make_rtdb();
        rtdb.subscribe(&["chat { userMessage, agentReply, updatedAt }".to_string()], false, None)
            .expect("subscribe");

        let row1 = chat_row("s_u", "s_u_1", "2026-08-31T00:00:00+00:00");
        rtdb
            .ingest_row_upsert(IngestRow::Chat(row1), &["userMessage".to_string()])
            .expect("ingest 1");
        // Flush the first window so the insert is emitted on its own and the
        // second mutation cannot coalesce into it.
        window_drain(&rtdb);
        let mut row2 = chat_row("s_u", "s_u_1", "2026-08-31T00:00:01+00:00");
        row2.agent_reply = Some("done".to_string());
        rtdb
            .ingest_row_upsert(
                IngestRow::Chat(row2),
                &["agentReply".to_string(), "updatedAt".to_string()],
            )
            .expect("ingest 2");

        window_drain(&rtdb);
        let out = emitted(&sink);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, RowChangeKind::Insert);
        assert_eq!(out[1].kind, RowChangeKind::Update);
        assert_eq!(out[1].seq, 2);
        let patch = out[1].patch.as_ref().and_then(|p| p.as_object()).expect("patch");
        assert_eq!(patch.len(), 2, "changed fields only");
        assert!(patch.contains_key("agentReply"));
        assert!(patch.contains_key("updatedAt"));
    }

    // ── Replay (R-2a): snapshot inserts then live ───────────────────────────

    #[test]
    fn replay_emits_full_row_snapshot_inserts_then_live_patches_flow() {
        let (_dir, rtdb, _rx, sink) = make_rtdb();

        // Historical rows already in SQLite (durability — R-2c reads whatever
        // SQLite holds; seq continues from MAX via P1.2).
        let mut historic = chat_row("s_r", "s_r_1", "2026-08-30T00:00:00+00:00");
        historic.seq = 1;
        historic.prompt_tokens = Some(25);
        rtdb.cache()
            .store()
            .upsert_chat_rows(&[historic.clone()])
            .expect("persist historic row");

        let registered = rtdb
            .subscribe(
                &["chat(promptTokens > 0) { userMessage, agentReply }".to_string()],
                true,
                Some(0),
            )
            .expect("subscribe with replay");
        assert_eq!(registered.len(), 1);

        // flush_ms: 0 → replay deliveries emitted synchronously.
        let out = emitted(&sink);
        assert_eq!(out.len(), 1, "snapshot insert");
        assert_eq!(out[0].kind, RowChangeKind::Insert);
        assert_eq!(out[0].query_id, registered[0].query_id);
        assert_eq!(out[0].seq, 1);
        let patch = out[0].patch.as_ref().and_then(|p| p.as_object()).expect("row");
        assert_eq!(patch.len(), 2, "insert respects the query's selection");
        assert_eq!(patch.get("userMessage"), Some(&serde_json::json!("fix the bug")));

        // Non-matching snapshot rows are filtered by the registry, not just
        // pushdown: a row below the threshold yields nothing.
        let (_dir2, rtdb2, _rx2, sink2) = make_rtdb();
        let mut below = chat_row("s_r", "s_r_2", "2026-08-30T00:00:01+00:00");
        below.seq = 1;
        below.prompt_tokens = Some(0);
        rtdb2.cache().store().upsert_chat_rows(&[below]).expect("persist below");
        let below_registered = rtdb2
            .subscribe(
                &["chat(promptTokens > 0) { userMessage, agentReply }".to_string()],
                true,
                Some(0),
            )
            .expect("subscribe");
        assert_eq!(below_registered.len(), 1);
        let below_out = emitted(&sink2);
        assert!(
            below_out.iter().all(|d| d.key.correlation_id != "s_r_2"),
            "rows failing the query args must not replay"
        );

        // Live patches flow after replay. The live row must still satisfy the
        // query args (promptTokens > 0) — a row that stops matching leaves
        // the result set silently.
        let mut live = chat_row("s_r", "s_r_1", "2026-08-31T00:00:00+00:00");
        live.prompt_tokens = Some(25);
        live.agent_reply = Some("streamed".to_string());
        rtdb.ingest_row_upsert(IngestRow::Chat(live), &["agentReply".to_string()])
            .expect("ingest");
        let all = emitted(&sink);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].kind, RowChangeKind::Update, "post-replay mutation is an update");
    }

    #[test]
    fn concurrent_mutation_before_snapshot_leg_yields_no_gap_and_no_lost_update() {
        // Interleaving A: the mutation lands mid-replay BEFORE the snapshot
        // leg matches the key (the live insert registers membership first).
        let (_dir, rtdb, _rx, sink) = make_rtdb();

        let mut historic = chat_row("s_c", "s_c_1", "2026-08-30T00:00:00+00:00");
        historic.seq = 1;
        rtdb.cache().store().upsert_chat_rows(&[historic]).expect("persist");

        let text = "chat(sessionId = \"s_c\") { userMessage, agentReply }".to_string();
        let registered = rtdb.register_queries(&[text.clone()], None).expect("register");
        let validated = {
            let spec = parse(&text).expect("parse");
            validate(&spec).expect("validate")
        };

        // The concurrent mutation (live path, newer seq, full row).
        let mut live = chat_row("s_c", "s_c_1", "2026-08-31T00:00:00+00:00");
        live.agent_reply = Some("live reply".to_string());
        rtdb
            .ingest_row_upsert(
                IngestRow::Chat(live),
                &["agentReply".to_string(), "updatedAt".to_string()],
            )
            .expect("ingest");

        // The replay snapshot leg runs after the mutation.
        rtdb.replay_query(&registered[0].query_id, &validated)
            .expect("replay");

        window_drain(&rtdb);
        let state = apply_client(&emitted(&sink));
        let row = state
            .get(&(registered[0].query_id.clone(), RowKey {
                session_id: "s_c".to_string(),
                correlation_id: "s_c_1".to_string(),
            }))
            .expect("row must exist client-side (no gap)");
        assert_eq!(
            row.get("agentReply"),
            Some(&serde_json::json!("live reply")),
            "final state must hold the live value (no lost update)"
        );
        assert_eq!(row.get("userMessage"), Some(&serde_json::json!("fix the bug")));
    }

    #[test]
    fn concurrent_mutation_after_snapshot_leg_coalesces_to_the_correct_final_state() {
        // Interleaving B: the snapshot leg matches the key first (snapshot
        // insert seq 1), THEN the mutation lands (live update seq 2) — both
        // coalesce in one window into the correct final row.
        let (_dir, rtdb, _rx, sink) = make_rtdb();

        let mut historic = chat_row("s_d", "s_d_1", "2026-08-30T00:00:00+00:00");
        historic.seq = 1;
        rtdb.cache().store().upsert_chat_rows(&[historic]).expect("persist");

        let text = "chat(sessionId = \"s_d\") { userMessage, agentReply }".to_string();
        let registered = rtdb.register_queries(&[text.clone()], None).expect("register");
        let validated = {
            let spec = parse(&text).expect("parse");
            validate(&spec).expect("validate")
        };
        rtdb.replay_query(&registered[0].query_id, &validated)
            .expect("replay first leg");

        let mut live = chat_row("s_d", "s_d_1", "2026-08-31T00:00:00+00:00");
        live.agent_reply = Some("live reply".to_string());
        rtdb
            .ingest_row_upsert(
                IngestRow::Chat(live),
                &["agentReply".to_string(), "updatedAt".to_string()],
            )
            .expect("ingest after replay");

        window_drain(&rtdb);
        let out = emitted(&sink);
        assert_eq!(
            out.len(),
            1,
            "snapshot insert + live update coalesce into one emission per window"
        );
        let state = apply_client(&out);
        let row = state.values().next().expect("row present");
        assert_eq!(row.get("agentReply"), Some(&serde_json::json!("live reply")));
        assert_eq!(row.get("userMessage"), Some(&serde_json::json!("fix the bug")));
    }

    // ── Remove on eviction (R-2d) ───────────────────────────────────────────

    #[test]
    fn eviction_routes_remove_to_matching_subscriber_only() {
        let (_dir, rtdb, mut rx, sink) = make_rtdb();
        let registered = rtdb
            .subscribe(
                &[
                    "chat(sessionId = \"s_e\") { userMessage }".to_string(),
                    "chat(sessionId = \"s_other\") { userMessage }".to_string(),
                ],
                false,
                None,
            )
            .expect("subscribe");
        assert_eq!(registered.len(), 2);
        let (matching, non_matching) = (&registered[0], &registered[1]);

        let row = chat_row("s_e", "s_e_1", "2020-01-01T00:00:00+00:00");
        rtdb
            .ingest_row_upsert(IngestRow::Chat(row), &["userMessage".to_string()])
            .expect("ingest");
        window_drain(&rtdb);
        let inserts = emitted(&sink);
        assert_eq!(inserts.len(), 1, "only the matching subscriber got the insert");
        assert_eq!(inserts[0].query_id, matching.query_id);

        // Land the write-behind batch so SQLite holds the row, then retention
        // prune evicts it and returns the eviction set.
        persist_write_behind(&rtdb, &mut rx);
        let outcome = rtdb
            .cache()
            .store()
            .prune(7, 100_000)
            .expect("prune");
        assert_eq!(outcome.deleted, 1);
        assert_eq!(outcome.evicted.len(), 1);
        rtdb.route_evictions(outcome.evicted);

        window_drain(&rtdb);
        let all = emitted(&sink);
        assert_eq!(all.len(), 2, "insert + remove");
        let removal = &all[1];
        assert_eq!(removal.kind, RowChangeKind::Remove);
        assert_eq!(removal.patch, None);
        assert_eq!(removal.query_id, matching.query_id);
        assert!(
            all.iter().all(|d| d.query_id != non_matching.query_id),
            "the non-matching subscriber must receive nothing"
        );

        // The client drops the row.
        let state = apply_client(&all);
        assert!(!state.contains_key(&(matching.query_id.clone(), RowKey {
            session_id: "s_e".to_string(),
            correlation_id: "s_e_1".to_string(),
        })));
    }

    #[test]
    fn remove_is_emitted_only_for_retention_evictions() {
        // A row that merely STOPS matching (arg failure) never produces a
        // remove — R-2d binding decision.
        let (_dir, rtdb, _rx, sink) = make_rtdb();
        rtdb.subscribe(&["chat(promptTokens > 20) { promptTokens }".to_string()], false, None)
            .expect("subscribe");
        let mut row = chat_row("s_f", "s_f_1", "2026-08-31T00:00:00+00:00");
        row.prompt_tokens = Some(25);
        rtdb
            .ingest_row_upsert(IngestRow::Chat(row), &["promptTokens".to_string()])
            .expect("ingest 1");
        let mut drop_below = chat_row("s_f", "s_f_1", "2026-08-31T00:00:01+00:00");
        drop_below.prompt_tokens = Some(10);
        rtdb
            .ingest_row_upsert(IngestRow::Chat(drop_below), &["promptTokens".to_string()])
            .expect("ingest 2");
        window_drain(&rtdb);
        let out = emitted(&sink);
        assert_eq!(out.len(), 1, "only the insert");
        assert!(out.iter().all(|d| d.kind != RowChangeKind::Remove));
    }

    // ── Unsubscribe ─────────────────────────────────────────────────────────

    #[test]
    fn unsubscribe_stops_delivery_and_discards_pending() {
        let (_dir, rtdb, _rx, sink) = make_rtdb();
        let registered = rtdb
            .subscribe(&["chat { userMessage }".to_string()], false, None)
            .expect("subscribe");

        let row = chat_row("s_g", "s_g_1", "2026-08-31T00:00:00+00:00");
        rtdb
            .ingest_row_upsert(IngestRow::Chat(row), &["userMessage".to_string()])
            .expect("ingest — pending");
        rtdb.unsubscribe(&[registered[0].query_id.clone()]);
        window_drain(&rtdb);
        assert!(emitted(&sink).is_empty(), "pending deliveries dropped on unsubscribe");

        // Further ingests match nothing.
        let row2 = chat_row("s_g", "s_g_2", "2026-08-31T00:00:01+00:00");
        rtdb
            .ingest_row_upsert(IngestRow::Chat(row2), &["userMessage".to_string()])
            .expect("ingest 2");
        window_drain(&rtdb);
        assert!(emitted(&sink).is_empty());
    }

    // ── Pushdown narrowing (registry remains the authority) ─────────────────

    #[test]
    fn pushdown_covers_typed_columns_and_skips_compound_json_and_string_ordering() {
        let args = vec![
            QueryArg {
                field: vec!["sessionId".to_string()],
                op: CompareOp::Eq,
                value: serde_json::json!("s_x"),
            },
            QueryArg {
                field: vec!["promptTokens".to_string()],
                op: CompareOp::Gt,
                value: serde_json::json!(0),
            },
            QueryArg {
                field: vec!["key".to_string(), "sessionId".to_string()],
                op: CompareOp::Eq,
                value: serde_json::json!("s_x"),
            },
            QueryArg {
                field: vec!["rawJson".to_string()],
                op: CompareOp::Eq,
                value: serde_json::json!("{}"),
            },
            QueryArg {
                field: vec!["model".to_string()],
                op: CompareOp::Gt,
                value: serde_json::json!("a"),
            },
        ];
        let (where_sql, params) = pushdown(EventTypeArg::Chat, &args);
        assert_eq!(
            where_sql,
            "session_id = ?1 AND prompt_tokens > ?2 AND raw_json = ?3",
            "typed single-segment args (including rawJson raw-string equality) push down; \
             compound paths and string ordering stay in-memory"
        );
        assert_eq!(params.len(), 3);
    }

    #[test]
    fn replay_snapshot_select_respects_the_pushdown_clause() {
        let (_dir, rtdb, _rx, sink) = make_rtdb();
        let mut hit = chat_row("s_p", "s_p_1", "2026-08-30T00:00:00+00:00");
        hit.seq = 1;
        let mut other = chat_row("s_q", "s_q_1", "2026-08-30T00:00:00+00:00");
        other.seq = 1;
        rtdb.cache().store().upsert_chat_rows(&[hit, other]).expect("persist");

        let registered = rtdb
            .subscribe(
                &["chat(sessionId = \"s_p\") { userMessage }".to_string()],
                true,
                Some(0),
            )
            .expect("subscribe");
        let out = emitted(&sink);
        assert_eq!(out.len(), 1, "pushdown narrowed the select to s_p rows only");
        assert_eq!(out[0].key.session_id, "s_p");
        assert_eq!(registered.len(), 1);
    }
}
