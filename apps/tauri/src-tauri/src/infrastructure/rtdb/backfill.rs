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
//! ## Provider re-derivation (Spec #2932 ST-6; round-2 identity fix)
//!
//! [`run_startup_provider_rebackfill`] is a SECOND, INDEPENDENT one-shot leg
//! gated by its OWN marker ([`BACKFILL_PROVIDER_COMPLETED_KEY`] —
//! `rtdb.backfill.provider.completed.v2`), so an install that latched
//! `rtdb.backfill.completed` before the `provider` column existed still runs
//! exactly one provider re-derivation pass.
//!
//! **Identity rule (round-2 FIX-R2-2).** The pass attributes the row at its
//! OWN persisted `(session_id, correlation_id)`; it NEVER mints a correlation
//! id. Round 1 replayed the corpus through a fresh classifier and let it mint
//! keys from per-process state — but a persisted key is a historical artifact
//! of the live process that wrote it, not a derivable function of the corpus,
//! so the re-minted key targeted a DIFFERENT PK and INSERTed a parallel row
//! while the pre-existing row stayed `unknown` (tester FAIL). The corrected
//! pass enumerates unresolved rows joined to `telemetry_spans` on
//! `(match_session, started_at_ns)` (with `match_session =
//! COALESCE(composited_child_session_id, session_id)` for chat rows), filters
//! the matched spans to the row's op family via the shared `resolve_op_name`,
//! resolves the token with the SAME shared `attrs::resolve_provider_token`
//! rule (NFR-6 — never a second extract path), and writes a `provider`-only
//! patch at the row's own key through the classifier's canonical write path
//! (durable seq / delivery / cache semantics preserved). No new rows are ever
//! created; a row with no unambiguous span match stays the documented
//! fallback. The pass is idempotent (content-no-op writes are skipped), a
//! no-op when `telemetry_spans` is absent/empty (its marker is left unset so a
//! later startup re-checks), and strictly READ-ONLY toward `telemetry_spans`.
//!
//! **Marker supersession.** The marker was renamed to `…completed.v2` so an
//! install that latched the round-1 (identity-incorrect) pass re-runs the
//! corrected one exactly once. The old `…completed` key is simply ignored —
//! never consulted, never deleted.
//!
//! ## Read-only invariant
//!
//! The backfill opens its OWN `SQLITE_OPEN_READ_ONLY` connection to
//! fredo.db — RTDB code cannot write `telemetry_spans` through it (the
//! `rtdb_never_creates_or_touches_telemetry_tables` invariant in store.rs
//! stays intact). Malformed spans (non-JSON attributes) are skipped with a
//! `tracing::warn`, never a panic; an empty or missing `telemetry_spans`
//! table yields a zero summary.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Map, Value};
use sqlx::Row as _;
use tauri::Manager;

use crate::infrastructure::rtdb::attrs::{
    resolve_op_name, ATTR_CONVERSATION_ID, CC_ATTR_SESSION_ID, OP_CHAT_CANON, OP_SESSION,
    OP_TOOL_PREFIX, PROVIDER_UNKNOWN,
};
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::rtdb::commands::RtdbState;
use crate::infrastructure::rtdb::ingest::{
    IngestClassifier, IngestClassifierState, ProviderReattribution,
};
use crate::infrastructure::rtdb::store::RowKind;
use crate::infrastructure::storage::engine::{begin_read_only, CanonicalReader, EngineHandle};
use crate::infrastructure::storage::AppStore;

/// AppStore KV marker set after one successful backfill pass over an
/// existing `telemetry_spans` table. Later startups skip the re-derivation
/// (post-cutover spans are always classified live, so the pass covered all
/// pre-cutover history there ever was).
pub const BACKFILL_COMPLETED_KEY: &str = "rtdb.backfill.completed";

/// AppStore KV marker for the INDEPENDENT one-shot provider re-derivation pass
/// (Spec #2932 ST-6). Deliberately separate from [`BACKFILL_COMPLETED_KEY`]: an
/// install that latched the original marker before the canonical `provider`
/// column existed would otherwise never re-derive provider attribution for its
/// pre-existing rows. Checking THIS key alone preserves that independence.
///
/// Round-2 FIX-R2-2c: superseded `rtdb.backfill.provider.completed` (the
/// round-1 pass that re-minted keys and INSERTed parallel rows) with `.v2`, so
/// an install that latched the identity-incorrect pass re-runs the corrected
/// one exactly once. The old key is ignored — never consulted, never deleted.
pub const BACKFILL_PROVIDER_COMPLETED_KEY: &str = "rtdb.backfill.provider.completed.v2";

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

/// Outcome of one provider re-attribution pass (Spec #2932 round-2 FIX-R2-2).
///
/// Replaces the round-1 span-replay counters: this pass enumerates UNRESOLVED
/// canonical rows, matches each to its span by `(match_session,
/// started_at_ns)` + op family, and writes the shared-rule token at the row's
/// OWN key — creating no rows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProviderReattributionSummary {
    /// `telemetry_spans` rows present at pass start — the marker-latch gate
    /// (an absent/empty telemetry tier leaves the marker unset; a pass that
    /// read no spans never latches).
    pub spans_read: usize,
    /// Unresolved rows the pass enumerated (span join matched ≥1 span).
    pub rows_considered: usize,
    /// Rows whose provider slot was written (fallback → resolved token).
    pub upgraded: usize,
    /// Rows already carrying a resolved token (content-no-op).
    pub unchanged: usize,
    /// Rows whose matched spans disagreed — nothing written.
    pub ambiguous: usize,
    /// Rows with no candidate in their op family — nothing written.
    pub no_source: usize,
}

/// One unresolved row plus its span candidates, still unfiltered by op family
/// (`(span_name, merged attribute map)`).
struct UnresolvedRow {
    session_id: String,
    correlation_id: String,
    candidates: Vec<(String, Map<String, Value>)>,
}

/// True when `attrs`/`span_name` classify into the row kind's op family — the
/// shared `resolve_op_name` rule, never a second classifier (NFR-6).
fn matches_op_family(kind: RowKind, span_name: &str, attrs: &Map<String, Value>) -> bool {
    match resolve_op_name(span_name, attrs) {
        Some(op) => match kind {
            RowKind::Chat => op == OP_CHAT_CANON,
            RowKind::ToolUse => op.starts_with(OP_TOOL_PREFIX),
            RowKind::AgentSession => op == OP_SESSION,
        },
        None => false,
    }
}

struct PersistedSpan {
    trace_id: String,
    span_id: String,
    span_name: String,
    start_time_ns: i64,
    end_time_ns: Option<i64>,
    session_id: String,
    attributes_json: Option<String>,
}

/// True when `table` exists on the PostgreSQL read-only transaction.
async fn pg_table_present(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: &str,
) -> Result<bool> {
    let present: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
        .bind(table)
        .fetch_one(&mut **tx)
        .await?;
    Ok(present.is_some())
}

/// Read every `telemetry_spans` row in replay order through the engine-selected
/// READ-ONLY canonical handle (REQ-9). `Ok(None)` when the table is absent on
/// the active engine (a fresh install / pre-migration tier).
async fn read_all_spans(engine: &EngineHandle) -> Result<Option<Vec<PersistedSpan>>> {
    const SQL: &str = "SELECT trace_id, span_id, span_name, start_time_ns, end_time_ns,
                session_id, attributes_json
         FROM telemetry_spans
         ORDER BY session_id ASC, start_time_ns ASC, span_id ASC";
    match engine.engine().and_then(|engine| engine.canonical_reader()) {
        Some(CanonicalReader::Postgres(pool)) => {
            let mut tx = begin_read_only(&pool).await?;
            if !pg_table_present(&mut tx, "telemetry_spans").await? {
                return Ok(None);
            }
            let rows = sqlx::query(SQL).fetch_all(&mut *tx).await?;
            let out = rows
                .iter()
                .map(|row| {
                    Ok(PersistedSpan {
                        trace_id: row.try_get(0)?,
                        span_id: row.try_get(1)?,
                        span_name: row.try_get(2)?,
                        start_time_ns: row.try_get(3)?,
                        end_time_ns: row.try_get(4)?,
                        session_id: row.try_get(5)?,
                        attributes_json: row.try_get(6)?,
                    })
                })
                .collect::<Result<Vec<_>, sqlx::Error>>()?;
            tx.commit().await?;
            Ok(Some(out))
        }
        None => Ok(None),
    }
}

/// Replay every persisted span through the shared ingest classifier
/// (NFR-6), reading `telemetry_spans` through the engine-selected READ-ONLY
/// canonical handle. Returns a zero summary when the telemetry tier is absent.
pub async fn backfill_from_telemetry(
    engine: &EngineHandle,
    classifier: &IngestClassifier,
) -> Result<BackfillSummary> {
    let Some(spans) = read_all_spans(engine).await? else {
        tracing::info!(
            target: "fredo::rtdb::backfill",
            "rtdb backfill: telemetry_spans table absent — no pre-cutover history to derive"
        );
        return Ok(BackfillSummary::default());
    };

    let mut summary = BackfillSummary::default();
    for span in &spans {
        summary.spans_read += 1;
        let Some(attrs) = parse_attributes(span.attributes_json.as_deref()) else {
            summary.skipped_malformed += 1;
            tracing::warn!(
                target: "fredo::rtdb::backfill",
                span_id = %span.span_id,
                session_id = %span.session_id,
                "rtdb backfill skipping malformed span (attributes_json is not a JSON object)"
            );
            continue;
        };

        // Summary-only classification through the SHARED resolver — the
        // classifier re-resolves identically when fed the reconstructed
        // span; no extract rule is duplicated here.
        match resolve_op_name(&span.span_name, &attrs) {
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

        let reconstructed = reconstruct_span(
            &span.trace_id,
            &span.span_id,
            &span.span_name,
            span.start_time_ns,
            span.end_time_ns,
            &span.session_id,
            attrs,
        );
        classifier.ingest_otlp(Transport::OtlpGrpc, &reconstructed).await;
    }
    Ok(summary)
}

/// The lib.rs startup-hook body (P3.2): run the canonical backfill at most
/// once ever. Spawned by lib.rs inside a `tauri::async_runtime::spawn` so
/// startup never blocks. Tolerates a missing/empty telemetry tier; malformed
/// spans are skipped inside [`backfill_from_telemetry`], never a panic.
pub async fn run_startup_backfill(app: &tauri::AppHandle, engine: Arc<EngineHandle>) {
    let app_store = app.state::<Arc<AppStore>>();
    if matches!(app_store.control_get(BACKFILL_COMPLETED_KEY), Ok(Some(_))) {
        tracing::debug!(
            target: "fredo::rtdb::backfill",
            "rtdb canonical backfill already completed — skipping"
        );
        return;
    }

    let classifier = app.state::<IngestClassifierState>();
    match backfill_from_telemetry(&engine, classifier.inner()).await {
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
                if let Err(e) = app_store.control_set(BACKFILL_COMPLETED_KEY, &stamped) {
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

/// The per-kind unresolved-row join (shared by both engine arms). `?1` is the
/// documented fallback sentinel (imported, never a literal); the PostgreSQL arm
/// translates it to `$1`.
fn unresolved_sql(kind: RowKind) -> &'static str {
    match kind {
        RowKind::Chat => {
            "SELECT c.session_id, c.correlation_id, s.span_name, s.attributes_json
         FROM chat_rows c
         JOIN telemetry_spans s
           ON s.session_id = COALESCE(c.composited_child_session_id, c.session_id)
          AND s.start_time_ns = c.started_at_ns
        WHERE (c.provider IS NULL OR c.provider = ?1)
          AND c.started_at_ns IS NOT NULL"
        }
        RowKind::ToolUse => {
            "SELECT c.session_id, c.correlation_id, s.span_name, s.attributes_json
         FROM tool_use_rows c
         JOIN telemetry_spans s
           ON s.session_id = c.session_id
          AND s.start_time_ns = c.started_at_ns
        WHERE (c.provider IS NULL OR c.provider = ?1)
          AND c.started_at_ns IS NOT NULL"
        }
        RowKind::AgentSession => {
            "SELECT c.session_id, c.correlation_id, s.span_name, s.attributes_json
         FROM agent_session_rows c
         JOIN telemetry_spans s
           ON s.session_id = c.session_id
          AND s.start_time_ns = c.started_at_ns
        WHERE (c.provider IS NULL OR c.provider = ?1)
          AND c.started_at_ns IS NOT NULL"
        }
    }
}

/// PostgreSQL arm of [`collect_unresolved_rows`] — identical grouping, reads
/// through the READ ONLY transaction.
async fn collect_unresolved_rows_pg(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
) -> Result<Vec<UnresolvedRow>> {
    let rows = sqlx::query(sql)
        .bind(PROVIDER_UNKNOWN)
        .fetch_all(&mut **tx)
        .await?;
    let mut out: Vec<UnresolvedRow> = Vec::new();
    let mut index: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();
    for row in rows {
        let session_id: String = row.try_get(0)?;
        let correlation_id: String = row.try_get(1)?;
        let span_name: String = row.try_get(2)?;
        let attributes_json: Option<String> = row.try_get(3)?;
        let key = (session_id.clone(), correlation_id.clone());
        let idx = *index.entry(key).or_insert_with(|| {
            out.push(UnresolvedRow {
                session_id: session_id.clone(),
                correlation_id: correlation_id.clone(),
                candidates: Vec::new(),
            });
            out.len() - 1
        });
        if let Some(attrs) = parse_attributes(attributes_json.as_deref()) {
            out[idx].candidates.push((span_name, attrs));
        }
    }
    Ok(out)
}

/// Testable core of the Spec #2932 ST-6 provider re-derivation: gate on the
/// INDEPENDENT [`BACKFILL_PROVIDER_COMPLETED_KEY`] marker, enumerate each
/// unresolved row's matched span(s), and upgrade the row's `provider` slot AT
/// ITS OWN KEY through [`IngestClassifier::reattribute_provider`] (round-2
/// identity rule — no correlation id is ever minted, no row is ever created).
/// The token comes from the SAME shared `attrs::resolve_provider_token` rule
/// (NFR-6). Canonical + telemetry reads go through the engine-selected
/// READ-ONLY handle (REQ-9).
///
/// Returns `Ok(None)` when a prior pass already latched the marker (idempotent
/// skip); `Ok(Some(summary))` when a pass ran. `spans_read == 0` (absent or
/// empty `telemetry_spans`) leaves the marker UNSET so the next startup
/// re-checks — never a false "done".
async fn provider_rebackfill_pass(
    app_store: &AppStore,
    classifier: &IngestClassifier,
    engine: &EngineHandle,
) -> Result<Option<ProviderReattributionSummary>> {
    if matches!(app_store.control_get(BACKFILL_PROVIDER_COMPLETED_KEY), Ok(Some(_))) {
        return Ok(None);
    }

    let mut summary = ProviderReattributionSummary::default();

    // Enumerate unresolved rows for every kind WITHOUT holding a connection
    // guard across the classifier awaits (`reattribute_provider` awaits the
    // storage-backed cache reads).
    let mut pending: Vec<(RowKind, Vec<UnresolvedRow>)> = Vec::new();
    match engine.engine().and_then(|engine| engine.canonical_reader()) {
        Some(CanonicalReader::Postgres(pool)) => {
            let mut tx = begin_read_only(&pool).await?;
            if !pg_table_present(&mut tx, "telemetry_spans").await? {
                tracing::info!(
                    target: "fredo::rtdb::backfill",
                    "rtdb provider re-derivation: telemetry_spans table absent — nothing to attribute"
                );
                return Ok(Some(summary));
            }
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_spans")
                .fetch_one(&mut *tx)
                .await?;
            summary.spans_read = count as usize;
            for kind in [RowKind::Chat, RowKind::ToolUse, RowKind::AgentSession] {
                let sql = unresolved_sql(kind).replace("?1", "$1");
                pending.push((kind, collect_unresolved_rows_pg(&mut tx, &sql).await?));
            }
            tx.commit().await?;
        }
        None => {}
    }

    for (kind, unresolved_rows) in pending {
        for unresolved in unresolved_rows {
            summary.rows_considered += 1;
            let candidates: Vec<Map<String, Value>> = unresolved
                .candidates
                .iter()
                .filter(|(span_name, attrs)| matches_op_family(kind, span_name, attrs))
                .map(|(_, attrs)| attrs.clone())
                .collect();
            match classifier
                .reattribute_provider(
                    kind,
                    &unresolved.session_id,
                    &unresolved.correlation_id,
                    &candidates,
                )
                .await
            {
                ProviderReattribution::Upgraded => summary.upgraded += 1,
                ProviderReattribution::Unchanged => summary.unchanged += 1,
                ProviderReattribution::Ambiguous => summary.ambiguous += 1,
                ProviderReattribution::NoSource => summary.no_source += 1,
            }
        }
    }

    if summary.spans_read > 0 {
        let stamped = chrono::Utc::now().to_rfc3339();
        app_store.control_set(BACKFILL_PROVIDER_COMPLETED_KEY, &stamped)?;
    }
    Ok(Some(summary))
}

/// The lib.rs startup-hook body for the Spec #2932 ST-6 leg: run ONE provider
/// re-derivation pass over `telemetry_spans`, gated solely by
/// [`BACKFILL_PROVIDER_COMPLETED_KEY`] (independent of
/// [`BACKFILL_COMPLETED_KEY`]). The classifier is only the WRITE path (the
/// shared `resolve_provider_token` rule + the canonical apply/ingest helpers);
/// the pass mints no correlation id, so a fresh instance is not required for
/// key reproducibility — the round-2 identity fix removes that dependency.
/// Spawned by lib.rs; tolerates a missing/empty telemetry tier.
pub async fn run_startup_provider_rebackfill(app: &tauri::AppHandle, engine: Arc<EngineHandle>) {
    let app_store = app.state::<Arc<AppStore>>();
    if matches!(app_store.control_get(BACKFILL_PROVIDER_COMPLETED_KEY), Ok(Some(_))) {
        tracing::debug!(
            target: "fredo::rtdb::backfill",
            "rtdb provider re-derivation already completed — skipping"
        );
        return;
    }

    let rtdb = app.state::<RtdbState>();
    let classifier = IngestClassifier::new(Arc::clone(rtdb.inner()));

    match provider_rebackfill_pass(app_store.inner().as_ref(), &classifier, &engine).await {
        Ok(None) => {
            // Race-free re-check (another pass latched it between the read and
            // the call) — nothing to do.
            tracing::debug!(
                target: "fredo::rtdb::backfill",
                "rtdb provider re-derivation already completed — skipping"
            );
        }
        Ok(Some(summary)) => {
            tracing::info!(
                target: "fredo::rtdb::backfill",
                spans_read = summary.spans_read,
                rows_considered = summary.rows_considered,
                upgraded = summary.upgraded,
                unchanged = summary.unchanged,
                ambiguous = summary.ambiguous,
                no_source = summary.no_source,
                "rtdb provider re-derivation complete"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "fredo::rtdb::backfill",
                error = %e,
                "rtdb provider re-derivation unavailable this startup — will retry next launch"
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
