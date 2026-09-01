//! Canonical backfill from `telemetry_spans` (Spec #2788 P3.2, REQs
//! R-2b/R-4c).
//!
//! Re-derives canonical RTDB rows (`chat_rows` / `tool_use_rows` /
//! `agent_session_rows`) for PRE-CUTOVER history by replaying the existing
//! `telemetry_spans` table (in fredo.db, DDL at `span_store.rs:66-93`)
//! through the SAME [`IngestClassifier`] the live OTLP receivers feed —
//! NFR-6: ONE shared extract-rule implementation, so re-derivation is
//! byte-comparable with live derivation. Each persisted span row is
//! reconstructed into its original flat-JSON span shape (`name` / `traceId`
//! / `spanId` / `startTimeUnixNano` / `endTimeUnixNano` / `attributes` —
//! the `ingest_otlp` non-envelope form) and handed to the classifier; THIS
//! module owns no extraction logic.
//!
//! ## Ordering (R-4c)
//!
//! Spans replay in `(session_id, start_time_ns, span_id)` ASC order — the
//! order the live pipeline observed events within each session — so
//! per-turn correlation ids (REQ-639), the #2711/#2723 token-delta
//! baselines and the P1.1 merge outcomes re-derive deterministically.
//!
//! ## Idempotency
//!
//! Rows land through the normal PK-upsert path on
//! `(session_id, correlation_id)`. A re-run over the same corpus re-derives
//! byte-identical content (fresh classifier per process start → same replay
//! order → same per-turn ids via the shared ST9 span→correlation guard) and
//! the classifier's content-no-op gate skips the write — seq never inflates
//! and no duplicates appear. The startup hook additionally persists a
//! one-shot completion marker (`rtdb.backfill.completed`): `telemetry_spans`
//! only ever grows with POST-cutover spans (each is classified live on
//! arrival), so one successful pass covers all pre-cutover history and
//! later startups skip the re-derivation entirely.
//!
//! ## Read-only invariant
//!
//! The backfill opens its OWN `SQLITE_OPEN_READ_ONLY` connection to
//! fredo.db — RTDB code cannot write `telemetry_spans` through it (the
//! `rtdb_never_creates_or_touches_telemetry_tables` invariant in store.rs
//! stays intact). Malformed spans (non-JSON attributes) are skipped with a
//! `tracing::warn`, never a panic; an empty or missing `telemetry_spans`
//! table yields a zero summary.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use tauri::Manager;

use crate::infrastructure::comm::adapters::otlp::{
    GenericOtlpAdapter, ATTR_CONVERSATION_ID, CC_ATTR_SESSION_ID, OP_CHAT_CANON, OP_SESSION,
};
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::rtdb::ingest::{IngestClassifier, IngestClassifierState};
use crate::infrastructure::storage::AppStore;

/// AppStore KV marker set after one successful backfill pass over an
/// existing `telemetry_spans` table. Later startups skip the re-derivation
/// (post-cutover spans are always classified live, so the pass covered all
/// pre-cutover history there ever was).
pub const BACKFILL_COMPLETED_KEY: &str = "rtdb.backfill.completed";

/// Per-type completion counts — the startup summary log payload.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BackfillSummary {
    /// Span rows read from `telemetry_spans`.
    pub spans_read: usize,
    /// Spans classified to the canonical `chat` op (≥1 ChatRow each).
    pub chat_spans: usize,
    /// Spans classified to a `tool.*` op (≥1 ToolUseRow each).
    pub tool_spans: usize,
    /// Spans classified to the canonical `session` op (≥1 AgentSessionRow).
    pub session_spans: usize,
    /// Spans skipped: `attributes_json` is not a JSON object.
    pub skipped_malformed: usize,
    /// Spans the shared resolver did not recognize (the classifier drops
    /// them identically on the live path).
    pub skipped_unrecognized: usize,
}

/// Replay every persisted span through the shared ingest classifier
/// (NFR-6). Opens a READ-ONLY connection; errors only when fredo.db itself
/// cannot be opened read-only (the caller logs and retries next startup).
pub fn backfill_from_telemetry(
    data_dir: &Path,
    classifier: &IngestClassifier,
) -> Result<BackfillSummary> {
    let db_path = data_dir.join("fredo.db");
    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| anyhow::anyhow!("rtdb backfill: cannot open fredo.db read-only: {e}"))?;

    let present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='telemetry_spans'",
        [],
        |row| row.get(0),
    )?;
    if present == 0 {
        tracing::info!(
            target: "fredo::rtdb::backfill",
            "rtdb backfill: telemetry_spans table absent — no pre-cutover history to derive"
        );
        return Ok(BackfillSummary::default());
    }

    let mut stmt = conn.prepare(
        "SELECT trace_id, span_id, span_name, start_time_ns, end_time_ns,
                session_id, attributes_json
         FROM telemetry_spans
         ORDER BY session_id ASC, start_time_ns ASC, span_id ASC",
    )?;
    let mut rows = stmt.query([])?;

    let mut summary = BackfillSummary::default();
    while let Some(row) = rows.next()? {
        summary.spans_read += 1;
        let trace_id: String = row.get(0)?;
        let span_id: String = row.get(1)?;
        let span_name: String = row.get(2)?;
        let start_time_ns: i64 = row.get(3)?;
        let end_time_ns: Option<i64> = row.get(4)?;
        let session_id: String = row.get(5)?;
        let attributes_json: Option<String> = row.get(6)?;

        let Some(attrs) = parse_attributes(attributes_json.as_deref()) else {
            summary.skipped_malformed += 1;
            tracing::warn!(
                target: "fredo::rtdb::backfill",
                span_id = %span_id,
                session_id = %session_id,
                "rtdb backfill skipping malformed span (attributes_json is not a JSON object)"
            );
            continue;
        };

        // Summary-only classification through the SHARED resolver — the
        // classifier re-resolves identically when fed the reconstructed
        // span; no extract rule is duplicated here.
        match GenericOtlpAdapter::resolve_op_name(&span_name, &attrs) {
            Some(op) => {
                if op == OP_SESSION {
                    summary.session_spans += 1;
                } else if op == OP_CHAT_CANON {
                    summary.chat_spans += 1;
                } else {
                    summary.tool_spans += 1;
                }
            }
            None => summary.skipped_unrecognized += 1,
        }

        let span = reconstruct_span(
            &trace_id,
            &span_id,
            &span_name,
            start_time_ns,
            end_time_ns,
            &session_id,
            attrs,
        );
        classifier.ingest_otlp(Transport::OtlpGrpc, &span);
    }
    Ok(summary)
}

/// The lib.rs startup-hook body (P3.2): run the canonical backfill at most
/// once ever, inside a `tauri::async_runtime::spawn` so startup never
/// blocks. Tolerates a missing/empty telemetry tier; malformed spans are
/// skipped inside [`backfill_from_telemetry`], never a panic.
pub fn run_startup_backfill(app: &tauri::AppHandle, data_dir: &Path) {
    let app_store = app.state::<Arc<AppStore>>();
    if matches!(app_store.get(BACKFILL_COMPLETED_KEY), Ok(Some(_))) {
        tracing::debug!(
            target: "fredo::rtdb::backfill",
            "rtdb canonical backfill already completed — skipping"
        );
        return;
    }

    let classifier = app.state::<IngestClassifierState>();
    match backfill_from_telemetry(data_dir, classifier.inner()) {
        Ok(summary) => {
            tracing::info!(
                target: "fredo::rtdb::backfill",
                spans_read = summary.spans_read,
                chat_spans = summary.chat_spans,
                tool_spans = summary.tool_spans,
                session_spans = summary.session_spans,
                skipped_malformed = summary.skipped_malformed,
                skipped_unrecognized = summary.skipped_unrecognized,
                "rtdb canonical backfill complete"
            );
            // Marker only after a pass that actually read spans — a missing
            // telemetry_spans table (fresh install / schema timing) re-checks
            // on the next startup instead of latching done.
            if summary.spans_read > 0 {
                let stamped = chrono::Utc::now().to_rfc3339();
                if let Err(e) = app_store.set(BACKFILL_COMPLETED_KEY, &stamped) {
                    tracing::warn!(
                        target: "fredo::rtdb::backfill",
                        error = %e,
                        "could not persist the backfill completion marker — the next startup re-runs the (idempotent) pass"
                    );
                }
            }
        }
        Err(e) => {
            tracing::warn!(
                target: "fredo::rtdb::backfill",
                error = %e,
                "rtdb canonical backfill unavailable this startup — will retry next launch"
            );
        }
    }
}

// ── Span-row → flat-JSON reconstruction (no extraction logic — shape only) ──

/// Parse persisted `attributes_json` (a flat JSON object of merged
/// resource+span attributes — `raw.rs` `RawSpan::from_proto` shape). `None`
/// means malformed (not a JSON object) → the caller skips the span. A NULL
/// column is an EMPTY attribute set, not malformed.
fn parse_attributes(attributes_json: Option<&str>) -> Option<Map<String, Value>> {
    let Some(raw) = attributes_json else {
        return Some(Map::new());
    };
    if raw.trim().is_empty() {
        return Some(Map::new());
    }
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|parsed| parsed.as_object().cloned())
}

/// Reconstruct the flat-JSON span the shared classifier consumes (the
/// `ingest_otlp` non-envelope form). Attribute values are re-wrapped into
/// the OTLP `AnyValue` shape `otlp_attrs_to_map` decodes — the exact
/// round-trip of `raw.rs`'s `any_value_to_json` persistence.
fn reconstruct_span(
    trace_id: &str,
    span_id: &str,
    span_name: &str,
    start_time_ns: i64,
    end_time_ns: Option<i64>,
    session_id: &str,
    attrs: Map<String, Value>,
) -> Value {
    let mut attributes = Vec::with_capacity(attrs.len() + 1);
    let mut has_session_identity = false;
    for (key, value) in &attrs {
        if key == CC_ATTR_SESSION_ID || key == ATTR_CONVERSATION_ID {
            has_session_identity = true;
        }
        attributes.push(json!({ "key": key, "value": attr_to_otlp_value(value) }));
    }
    if !has_session_identity {
        // The persisted session identity is authoritative — inject it so the
        // shared classifier resolves the SAME session (never the
        // random-UUID fallback) for spans whose attributes lost the identity.
        attributes.push(json!({
            "key": CC_ATTR_SESSION_ID,
            "value": { "stringValue": session_id },
        }));
    }
    let mut span = json!({
        "name": span_name,
        "traceId": trace_id,
        "spanId": span_id,
        "startTimeUnixNano": start_time_ns.to_string(),
        "attributes": attributes,
    });
    if let Some(end_ns) = end_time_ns {
        span["endTimeUnixNano"] = json!(end_ns.to_string());
    }
    span
}

/// Map one persisted flat attribute value back to the OTLP `AnyValue`
/// wrapper (`{stringValue|intValue|doubleValue|boolValue}`); non-scalar
/// values pass through verbatim (the shared `otlp_attrs_to_map` else-branch
/// clones them unchanged).
fn attr_to_otlp_value(value: &Value) -> Value {
    match value {
        Value::String(s) => json!({ "stringValue": s }),
        Value::Bool(b) => json!({ "boolValue": b }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                json!({ "intValue": i })
            } else {
                json!({ "doubleValue": n.as_f64().unwrap_or(0.0) })
            }
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::otlp::raw::RawSpan;
    use crate::infrastructure::rtdb::cache::{PendingWrite, RtdbCache};
    use crate::infrastructure::rtdb::commands::Rtdb;
    use crate::infrastructure::rtdb::flush::FlushLoop;
    use crate::infrastructure::rtdb::ingest::IngestClassifier;
    use crate::infrastructure::rtdb::project::RowDelivery;
    use crate::infrastructure::rtdb::rows::RowState;
    use crate::infrastructure::rtdb::store::RtdbStore;
    use crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry;
    use crate::infrastructure::storage::span_store::SpanStore;
    use tempfile::TempDir;
    use tokio::sync::mpsc::Receiver;

    // ── Fixtures ────────────────────────────────────────────────────────────

    struct Stack {
        dir: TempDir,
        span_store: SpanStore,
        rtdb: Arc<Rtdb>,
        rx: Receiver<PendingWrite>,
        store: Arc<RtdbStore>,
    }

    /// One fredo.db hosting BOTH tiers, exactly like production: the
    /// telemetry tier through the REAL `SpanStore` DDL and the canonical
    /// tier through `RtdbStore`.
    fn make_stack() -> Stack {
        let dir = tempfile::tempdir().expect("tempdir");
        let span_store = SpanStore::open(dir.path().to_path_buf()).expect("span store");
        span_store.ensure_schema().expect("telemetry schema");
        let store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).expect("rtdb store"));
        store.ensure_schema().expect("rtdb schema");
        let (cache, rx) = RtdbCache::new(Arc::clone(&store));
        let rtdb = Arc::new(Rtdb::new(
            cache,
            Arc::new(SubscriptionRegistry::new()),
            Arc::new(FlushLoop::new(Arc::new(|_: &[RowDelivery]| {}))),
        ));
        Stack {
            dir,
            span_store,
            rtdb,
            rx,
            store,
        }
    }

    /// Drain the write-behind queue and persist the batch — store-level
    /// assertions must see the derived rows.
    fn persist_write_behind(stack: &mut Stack) {
        let mut batch = Vec::new();
        while let Ok(pending) = stack.rx.try_recv() {
            batch.push(pending);
        }
        stack.rtdb.cache().flush_pending(batch).expect("flush");
    }

    fn raw_span(
        span_id: &str,
        session: &str,
        name: &str,
        start_ns: i64,
        attrs: Value,
    ) -> RawSpan {
        RawSpan {
            trace_id: format!("trace-{span_id}"),
            span_id: span_id.to_string(),
            parent_span_id: None,
            span_name: name.to_string(),
            span_kind: "INTERNAL".to_string(),
            start_time_ns: start_ns,
            end_time_ns: Some(start_ns + 1_000),
            status_code: "OK".to_string(),
            status_message: None,
            session_id: session.to_string(),
            attributes_json: Some(attrs.to_string()),
            events_json: None,
            provider: Some("open-code".to_string()),
            transport: Some("otlp_grpc".to_string()),
            event_type: Some("chat".to_string()),
            ingested_at: "2026-08-31T00:00:00+00:00".to_string(),
        }
    }

    /// A completed chat span in the REAL persisted attribute shape (flat
    /// object, exactly what `raw.rs` writes into `attributes_json`).
    fn chat_attrs(session: &str, input_tokens: i64) -> Value {
        json!({
            "gen_ai.operation.name": "chat",
            "session.id": session,
            "gen_ai.input.messages": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"hello backfill\"}]}]",
            "gen_ai.output.messages": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"hi there\"}]}]",
            "gen_ai.usage.input_tokens": input_tokens,
            "gen_ai.usage.output_tokens": 40,
            "gen_ai.response.model": "claude-sonnet-4"
        })
    }

    // ── Derivation: chat / tool / session spans → their canonical rows ──────

    #[test]
    fn backfill_derives_canonical_rows_from_telemetry_spans() {
        let stack = make_stack();
        stack
            .span_store
            .insert_raw_spans(&[
                raw_span("sp-chat", "ses_chat", "my.llm", 1_000_000_000, chat_attrs("ses_chat", 100)),
                raw_span(
                    "sp-tool",
                    "ses_tool",
                    "fredo.tool.Bash",
                    2_000_000_000,
                    json!({
                        "gen_ai.operation.name": "execute_tool",
                        "gen_ai.tool.name": "Bash",
                        "session.id": "ses_tool",
                        "tool.success": false,
                        "tool.error": "exit 1",
                        "duration_ms": 120
                    }),
                ),
                raw_span(
                    "sp-session",
                    "ses_session",
                    "fredo.session",
                    3_000_000_000,
                    json!({
                        "gen_ai.operation.name": "run_agent",
                        "session.id": "ses_session",
                        "gen_ai.agent.name": "general",
                        "total_tokens": 500
                    }),
                ),
            ])
            .expect("insert spans");

        let classifier = Arc::new(IngestClassifier::new(Arc::clone(&stack.rtdb)));
        let summary = backfill_from_telemetry(stack.dir.path(), &classifier).expect("backfill");
        assert_eq!(summary.spans_read, 3);
        assert_eq!(summary.chat_spans, 1);
        assert_eq!(summary.tool_spans, 1);
        assert_eq!(summary.session_spans, 1);
        assert_eq!(summary.skipped_malformed, 0);

        let chat = stack
            .rtdb
            .cache()
            .get_chat("ses_chat", "ses_chat_1")
            .expect("read")
            .expect("chat row re-derived");
        assert_eq!(chat.state, RowState::Response, "completed span → Response");
        assert_eq!(chat.user_message.as_deref(), Some("hello backfill"));
        assert_eq!(chat.agent_reply.as_deref(), Some("hi there"));
        assert_eq!(chat.prompt_tokens, Some(100));
        assert_eq!(chat.completion_tokens, Some(40));
        assert_eq!(chat.model.as_deref(), Some("claude-sonnet-4"));
        assert_eq!(chat.started_at_ns, Some(1_000_000_000));
        assert_eq!(chat.ended_at_ns, Some(1_000_001_000));

        let tool = stack
            .rtdb
            .cache()
            .get_tool_use("ses_tool", "ses_tool_1")
            .expect("read")
            .expect("tool row re-derived");
        assert_eq!(tool.tool_name.as_deref(), Some("Bash"));
        assert_eq!(tool.tool_success, Some(false));
        assert_eq!(tool.tool_error.as_deref(), Some("exit 1"));
        assert_eq!(tool.duration_ms, Some(120));
        assert_eq!(tool.state, RowState::Response);

        let session = stack
            .rtdb
            .cache()
            .get_agent_session("ses_session", "ses_session_1")
            .expect("read")
            .expect("agent-session row re-derived");
        assert_eq!(session.agent_name.as_deref(), Some("general"));
        assert_eq!(session.total_tokens, Some(500));
        assert_eq!(
            session.state,
            RowState::Init,
            "session spans stay Init (REQ-609)"
        );
    }

    // ── Ordering (R-4c): (session_id, start_time_ns) replay order ───────────

    #[test]
    fn backfill_replays_in_session_start_time_order() {
        let stack = make_stack();
        // Insert the LATER turn first — replay must still order by start time.
        stack
            .span_store
            .insert_raw_spans(&[
                raw_span("sp-turn2", "ses_ord", "my.llm", 2_000_000_000, chat_attrs("ses_ord", 120)),
                raw_span("sp-turn1", "ses_ord", "my.llm", 1_000_000_000, chat_attrs("ses_ord", 100)),
            ])
            .expect("insert spans");

        let classifier = Arc::new(IngestClassifier::new(Arc::clone(&stack.rtdb)));
        backfill_from_telemetry(stack.dir.path(), &classifier).expect("backfill");

        let turn1 = stack
            .rtdb
            .cache()
            .get_chat("ses_ord", "ses_ord_1")
            .expect("read")
            .expect("turn-1 row");
        assert_eq!(turn1.started_at_ns, Some(1_000_000_000), "the earlier span is turn 1");
        assert_eq!(
            turn1.prompt_tokens,
            Some(100),
            "first turn carries the full input baseline"
        );

        let turn2 = stack
            .rtdb
            .cache()
            .get_chat("ses_ord", "ses_ord_2")
            .expect("read")
            .expect("turn-2 row");
        assert_eq!(turn2.started_at_ns, Some(2_000_000_000));
        assert_eq!(
            turn2.prompt_tokens,
            Some(20),
            "the per-turn delta (120 − 100) re-derives only in start-time order"
        );
    }

    // ── Idempotency: re-run → no duplicates, seq unchanged ──────────────────

    #[test]
    fn backfill_is_idempotent_re_runs_do_not_duplicate_or_inflate_seq() {
        let mut stack = make_stack();
        stack
            .span_store
            .insert_raw_spans(&[
                raw_span("sp-1", "ses_idem", "my.llm", 1_000_000_000, chat_attrs("ses_idem", 100)),
                raw_span("sp-2", "ses_idem", "my.llm", 2_000_000_000, chat_attrs("ses_idem", 120)),
            ])
            .expect("insert spans");

        // First pass (the startup backfill — fresh classifier per process).
        let classifier = Arc::new(IngestClassifier::new(Arc::clone(&stack.rtdb)));
        backfill_from_telemetry(stack.dir.path(), &classifier).expect("first run");
        persist_write_behind(&mut stack);

        let first_row = stack
            .store
            .get_chat_row("ses_idem", "ses_idem_1")
            .expect("read")
            .expect("row persisted");
        let counts = stack.store.row_counts().expect("counts");

        // Re-run over the same corpus with a FRESH classifier (the restart
        // shape): deterministic replay order re-derives the same per-turn
        // ids and byte-identical content → every write is a no-op.
        let fresh = Arc::new(IngestClassifier::new(Arc::clone(&stack.rtdb)));
        backfill_from_telemetry(stack.dir.path(), &fresh).expect("re-run");
        persist_write_behind(&mut stack);

        assert_eq!(
            stack.store.row_counts().expect("counts"),
            counts,
            "no duplicate rows after the re-run"
        );
        assert_eq!(
            stack.store.get_chat_row("ses_idem", "ses_idem_1").expect("read"),
            Some(first_row),
            "stored rows are byte-identical — content-identical re-derivations were skipped (seq unchanged)"
        );
    }

    // ── Malformed / attribute-less spans: skip, never panic ─────────────────

    #[test]
    fn backfill_skips_malformed_spans_without_crashing() {
        let stack = make_stack();
        stack
            .span_store
            .insert_raw_spans(&[raw_span(
                "sp-ok",
                "ses_ok",
                "my.llm",
                1_000_000_000,
                chat_attrs("ses_ok", 100),
            )])
            .expect("insert valid span");

        let mut bad = raw_span("sp-bad", "ses_bad", "my.llm", 2_000_000_000, json!({}));
        bad.attributes_json = Some("{not json".to_string());
        stack.span_store.insert_raw_spans(&[bad]).expect("insert bad span");

        let mut absent = raw_span("sp-absent", "ses_absent", "chat", 3_000_000_000, json!({}));
        absent.attributes_json = None;
        stack
            .span_store
            .insert_raw_spans(&[absent])
            .expect("insert attribute-less span");

        let classifier = Arc::new(IngestClassifier::new(Arc::clone(&stack.rtdb)));
        let summary = backfill_from_telemetry(stack.dir.path(), &classifier).expect("backfill");
        assert_eq!(summary.spans_read, 3);
        assert_eq!(summary.skipped_malformed, 1, "the non-JSON attributes row is skipped");

        assert!(
            stack
                .rtdb
                .cache()
                .get_chat("ses_ok", "ses_ok_1")
                .expect("read")
                .is_some(),
            "the valid span is still derived"
        );
        assert!(
            stack
                .rtdb
                .cache()
                .get_chat("ses_absent", "ses_absent_1")
                .expect("read")
                .is_some(),
            "NULL attributes is an empty set (not malformed) — the span name \
             'chat' classifies through the shared name heuristics"
        );
    }

    // ── Empty / missing telemetry tier tolerated ────────────────────────────

    #[test]
    fn backfill_tolerates_missing_or_empty_telemetry_table() {
        let dir = tempfile::tempdir().expect("tempdir");
        // fredo.db with the RTDB schema but NO telemetry_spans table.
        let store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).expect("store"));
        store.ensure_schema().expect("schema");
        let (cache, _rx) = RtdbCache::new(Arc::clone(&store));
        let rtdb = Arc::new(Rtdb::new(
            cache,
            Arc::new(SubscriptionRegistry::new()),
            Arc::new(FlushLoop::new(Arc::new(|_: &[RowDelivery]| {}))),
        ));
        let classifier = Arc::new(IngestClassifier::new(Arc::clone(&rtdb)));
        let summary = backfill_from_telemetry(dir.path(), &classifier).expect("backfill");
        assert_eq!(summary.spans_read, 0, "missing table → zero summary, no error");

        // Present but empty table.
        let stack = make_stack();
        let classifier2 = Arc::new(IngestClassifier::new(Arc::clone(&stack.rtdb)));
        let summary2 = backfill_from_telemetry(stack.dir.path(), &classifier2).expect("backfill");
        assert_eq!(summary2.spans_read, 0);
    }

    // ── Relationship compositing re-derives through the shared classifier ───

    #[test]
    fn backfill_preserves_parent_child_compositing() {
        let stack = make_stack();
        stack
            .span_store
            .insert_raw_spans(&[
                raw_span("sp-c1", "ses_child", "my.llm", 1_000_000_000, chat_attrs("ses_child", 10)),
                raw_span(
                    "sp-c2",
                    "ses_child",
                    "my.llm",
                    2_000_000_000,
                    json!({
                        "gen_ai.operation.name": "chat",
                        "session.id": "ses_child",
                        "session.parent_id": "ses_parent",
                        "gen_ai.agent.name": "general",
                        "gen_ai.usage.input_tokens": 30,
                        "gen_ai.usage.output_tokens": 5
                    }),
                ),
            ])
            .expect("insert spans");

        let classifier = Arc::new(IngestClassifier::new(Arc::clone(&stack.rtdb)));
        backfill_from_telemetry(stack.dir.path(), &classifier).expect("backfill");

        let child = stack
            .rtdb
            .cache()
            .get_chat("ses_child", "ses_child_1")
            .expect("read")
            .expect("child-keyed row");
        assert_eq!(child.prompt_tokens, Some(10));

        let copied = stack
            .rtdb
            .cache()
            .get_chat("ses_parent", "ses_child_1")
            .expect("read")
            .expect("child row re-keyed under the parent session");
        assert_eq!(copied.prompt_tokens, Some(10), "row content carried over");
        assert_eq!(copied.composited_child_session_id.as_deref(), Some("ses_child"));
        assert_eq!(copied.parent_session_id.as_deref(), Some("ses_parent"));
    }
}
