//! Persistence + the store-reachability seam (Spec #3232, ST-4; AC-4).
//!
//! Each scored fixture is written as ONE namespaced span into the EXISTING
//! `telemetry_spans` store, so the AC-4 receipt is a **native `telemetry_spans`
//! query** made by a SEPARATE process after the harness exits:
//!
//! ```sql
//! SELECT span_id, attributes_json FROM telemetry_spans
//! WHERE event_type = 'companion.score' ORDER BY start_time_ns
//! ```
//!
//! No new table and no new DDL: the harness rides the shared [`SpanStore`]'s
//! insert path (idempotent on `span_id`), and the rows are namespaced by
//! `event_type = 'companion.score'` so product telemetry stays separable.
//!
//! ## The store-reachability seam (the load-bearing unknown, resolved HERE)
//!
//! The embedded cluster binds an OS-assigned **ephemeral** loopback port that is
//! published in memory by the app's supervisor and never written to disk, so a
//! standalone CLI process cannot discover it. The harness therefore takes an
//! **explicitly supplied endpoint** ([`ScoreStoreEndpoint`]) — never a probed
//! port: the caller resolves the host/port/user/database (from
//! `pg_supervisor_status`, or a dev environment's manifest `ports.pg`, or a
//! `--pg-port` argument) and the password (from `FREDO_PG_PASSWORD_FILE`, the OS
//! keychain, or the documented loopback fallback) and hands them in. This is the
//! "explicit supplied value over discovery" shape; it adds NO new product
//! surface. The store outlives the process because it is the already-running
//! cluster, not a store the harness boots and drops.
//!
//! ## Has `persist.rs` a second store path?
//!
//! No: `sqlx` is used only here to (a) build ONE pool from the supplied endpoint
//! and (b) run the read-back query. Every WRITE goes through
//! [`SpanStore::insert_spans`] — the same path the product's telemetry uses — so
//! the span row shape cannot drift from the store's contract.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::Utc;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Row};

use crate::infrastructure::storage::engine::{EngineHandle, PgEngine, StoreEngine};
use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::telemetry::TelemetrySpan;

use super::CompanionScoreResult;

/// The namespaced `event_type` every harness span carries — the AC-4 read key.
pub const SCORE_EVENT_TYPE: &str = "companion.score";

/// The harness span name.
pub const SCORE_SPAN_NAME: &str = "companion.score.fixture";

/// The harness session id.
pub const SCORE_SESSION_ID: &str = "companion-score";

/// The harness transport-agnostic provider marker.
pub const SCORE_PROVIDER: &str = "internal";

/// The AC-4 read-back query (documented verbatim; also pinned by a test).
pub const READ_BACK_SQL: &str = "SELECT span_id, start_time_ns, status_code, attributes_json \
     FROM telemetry_spans WHERE event_type = $1 ORDER BY start_time_ns";

/// Bounded pool size for the harness connection (the harness is single-threaded
/// over the store).
const SCORE_POOL_MAX_CONNECTIONS: u32 = 4;

/// Bounded connect/acquire budget — the harness never hangs on an unreachable
/// store (G-263).
const SCORE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// An EXPLICITLY SUPPLIED store endpoint. Never discovered, never probed.
///
/// `port == 0` is not a valid endpoint (the caller must supply the resolved
/// port); [`Self::is_resolved`] names the precondition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreStoreEndpoint {
    /// The cluster host (loopback for the embedded cluster).
    pub host: String,
    /// The resolved loopback port (never `0`).
    pub port: u16,
    /// The connection role (unchanged `postgres`).
    pub user: String,
    /// The loopback password (never persisted or logged by this module).
    pub password: String,
    /// The Fredo application database name.
    pub database: String,
}

impl ScoreStoreEndpoint {
    /// Build an endpoint from its resolved parts.
    pub fn new(
        host: impl Into<String>,
        port: u16,
        user: impl Into<String>,
        password: impl Into<String>,
        database: impl Into<String>,
    ) -> Self {
        Self {
            host: host.into(),
            port,
            user: user.into(),
            password: password.into(),
            database: database.into(),
        }
    }

    /// Whether the endpoint carries a resolved port. A `0` port means the caller
    /// did not resolve the cluster (the G-307 stale-port hazard).
    pub fn is_resolved(&self) -> bool {
        self.port > 0
    }

    /// A NON-SECRET connection identity (no password) for diagnostics and the
    /// pooled-engine record.
    pub fn identity(&self) -> String {
        format!(
            "postgres://{}@{}:{}/{}",
            self.user, self.host, self.port, self.database
        )
    }
}

/// A connected harness store: the shared [`SpanStore`] (for the idempotent insert
/// path) plus the pool the read-back query uses.
pub struct CompanionScoreStore {
    store: SpanStore,
    pool: PgPool,
}

impl CompanionScoreStore {
    /// Connect to the supplied endpoint, ensure the telemetry schema exists, and
    /// return the store. The schema init is idempotent, so pointing at the app's
    /// live cluster is a no-op.
    pub async fn connect(endpoint: &ScoreStoreEndpoint) -> Result<Self> {
        if !endpoint.is_resolved() {
            anyhow::bail!(
                "[companion-score] the store endpoint has no resolved port (port 0); supply the \
                 cluster's loopback port (pg_supervisor_status, a dev-env manifest `ports.pg`, or \
                 --pg-port) — never a stale/zero port (G-307)"
            );
        }
        let options = PgConnectOptions::new()
            .host(&endpoint.host)
            .port(endpoint.port)
            .username(&endpoint.user)
            .password(&endpoint.password)
            .database(&endpoint.database);
        let pool = PgPoolOptions::new()
            .max_connections(SCORE_POOL_MAX_CONNECTIONS)
            .acquire_timeout(SCORE_CONNECT_TIMEOUT)
            .connect_with(options)
            .await
            .with_context(|| {
                format!(
                    "[companion-score] could not connect to the store at {}",
                    endpoint.identity()
                )
            })?;
        Self::from_pool(pool, endpoint.identity()).await
    }

    /// Wrap an existing pool (the test/injection seam). Builds the shared span
    /// store over the pool and ensures the telemetry schema exists.
    pub async fn from_pool(pool: PgPool, identity: String) -> Result<Self> {
        let engine = StoreEngine::Postgres(Arc::new(PgEngine { pool: pool.clone(), url: identity }));
        let handle = EngineHandle::new(engine);
        let store = SpanStore::open(handle)?;
        store
            .ensure_schema()
            .await
            .context("[companion-score] ensuring the telemetry schema")?;
        Ok(Self { store, pool })
    }

    /// Write one `companion.score` span per result through the shared store's
    /// idempotent insert path. Returns the number of rows inserted.
    ///
    /// Spans carry a per-run `span_id`/`trace_id` token, so two consecutive runs
    /// produce two distinguishable row sets (AC-4 edge) rather than the second
    /// being swallowed by `ON CONFLICT (span_id) DO NOTHING`.
    pub async fn persist(&self, results: &[CompanionScoreResult]) -> Result<usize> {
        if results.is_empty() {
            return Ok(0);
        }
        let start_time_ns = now_ns();
        let run_id = start_time_ns.to_string();
        let spans: Vec<TelemetrySpan> = results
            .iter()
            .map(|result| score_span(&run_id, start_time_ns, result))
            .collect();
        self.store
            .insert_spans(&spans)
            .await
            .context("[companion-score] inserting the score spans")
    }

    /// Read every `companion.score` span back from the store (the AC-4 receipt,
    /// usable by a separate process AFTER the harness exits).
    pub async fn read_back(&self) -> Result<Vec<ScoreSpanRecord>> {
        let rows = sqlx::query(READ_BACK_SQL)
            .bind(SCORE_EVENT_TYPE)
            .fetch_all(&self.pool)
            .await
            .context("[companion-score] reading the score spans back")?;
        let mut records = Vec::with_capacity(rows.len());
        for row in rows {
            records.push(ScoreSpanRecord {
                span_id: row.get::<String, _>("span_id"),
                start_time_ns: row.get::<i64, _>("start_time_ns"),
                status_code: row.get::<String, _>("status_code"),
                attributes_json: row
                    .get::<Option<String>, _>("attributes_json")
                    .unwrap_or_default(),
            });
        }
        Ok(records)
    }
}

/// One `companion.score` row as read back from `telemetry_spans` (AC-4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreSpanRecord {
    /// The row's `span_id`.
    pub span_id: String,
    /// The run time the row was recorded at (nanoseconds since the epoch).
    pub start_time_ns: i64,
    /// `OK` for a passing fixture, `ERROR` for a failing one.
    pub status_code: String,
    /// The serialized [`CompanionScoreResult`] attributes (`""` when absent).
    pub attributes_json: String,
}

/// Build the `companion.score` span row for one result. Pure, so the row shape
/// (the AC-4 observable field set) is unit-pinned without a database.
pub fn score_span(run_id: &str, start_time_ns: i64, result: &CompanionScoreResult) -> TelemetrySpan {
    // The result is a fixed, always-serializable shape; a serialization failure
    // is impossible, but the fallback keeps the row shape valid without an
    // `unwrap` on a fallible path.
    let attributes_json = serde_json::to_string(result).unwrap_or_else(|_| "null".to_string());
    let (status_code, status_message) = if result.passed {
        ("OK", None)
    } else {
        ("ERROR", Some(result.detail.clone()))
    };
    TelemetrySpan {
        trace_id: format!("companion-score-{run_id}"),
        span_id: format!("companion-score.{run_id}.{}", result.fixture_id),
        parent_span_id: None,
        span_name: SCORE_SPAN_NAME.to_string(),
        span_kind: "INTERNAL".to_string(),
        start_time_ns,
        end_time_ns: Some(
            start_time_ns.saturating_add((result.latency_ms as i64).saturating_mul(1_000_000)),
        ),
        status_code: status_code.to_string(),
        status_message,
        session_id: SCORE_SESSION_ID.to_string(),
        attributes_json: Some(attributes_json),
        events_json: None,
        provider: Some(SCORE_PROVIDER.to_string()),
        transport: None,
        event_type: Some(SCORE_EVENT_TYPE.to_string()),
        ingested_at: Utc::now().to_rfc3339(),
    }
}

/// Nanoseconds since the Unix epoch (`0` on a pre-epoch clock — never a panic).
fn now_ns() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::llm_server::engine::score::ScoreMeasurements;

    fn sample(passed: bool) -> CompanionScoreResult {
        if passed {
            CompanionScoreResult::passed(
                "text-chat",
                7,
                ScoreMeasurements {
                    latency_ms: 123,
                    prompt_tokens: 40,
                    completion_tokens: 8,
                    prefill_micros: 4_000,
                    decode_micros: 9_000,
                    mtp_drafts_proposed: 5,
                    mtp_drafts_accepted: 3,
                    mtp_draft_calls: 2,
                },
            )
        } else {
            CompanionScoreResult::failed(
                "text-chat",
                7,
                ScoreMeasurements {
                    latency_ms: 10,
                    ..ScoreMeasurements::default()
                },
                "the reply was not the expected object",
            )
        }
    }

    /// The span row carries the AC-4 namespacing: the constant event type, span
    /// name, session id and provider the read-back query keys on.
    #[test]
    fn the_span_row_carries_the_namespacing_and_status() {
        let pass = score_span("run-1", 1_000_000, &sample(true));
        assert_eq!(pass.event_type.as_deref(), Some("companion.score"));
        assert_eq!(pass.event_type.as_deref(), Some(SCORE_EVENT_TYPE));
        assert_eq!(pass.span_name, "companion.score.fixture");
        assert_eq!(pass.span_name, SCORE_SPAN_NAME);
        assert_eq!(pass.session_id, "companion-score");
        assert_eq!(pass.session_id, SCORE_SESSION_ID);
        assert_eq!(pass.provider.as_deref(), Some("internal"));
        assert_eq!(pass.provider.as_deref(), Some(SCORE_PROVIDER));
        assert_eq!(pass.span_kind, "INTERNAL");
        assert_eq!(pass.status_code, "OK");
        assert!(pass.status_message.is_none());
        assert!(pass.parent_span_id.is_none());
        assert!(pass.transport.is_none());
        assert!(pass.events_json.is_none());
        assert_eq!(pass.trace_id, "companion-score-run-1");
        assert_eq!(pass.span_id, "companion-score.run-1.text-chat");

        // The ERROR arm carries the failure detail as the status message.
        let fail = score_span("run-1", 1_000_000, &sample(false));
        assert_eq!(fail.status_code, "ERROR");
        assert_eq!(
            fail.status_message.as_deref(),
            Some("the reply was not the expected object")
        );

        // The end time is derived from the recorded latency.
        assert_eq!(pass.end_time_ns, Some(1_000_000 + 123_000_000));
    }

    /// The span attributes are the serialized result — the exact field set the
    /// AC-4 read-back exposes.
    #[test]
    fn the_span_attributes_are_the_serialized_result() {
        let span = score_span("run-2", 5, &sample(true));
        let attributes: serde_json::Value =
            serde_json::from_str(span.attributes_json.as_deref().expect("attributes"))
                .expect("valid JSON");
        assert_eq!(attributes["fixtureId"], serde_json::json!("text-chat"));
        assert_eq!(attributes["passed"], serde_json::json!(true));
        assert_eq!(attributes["seed"], serde_json::json!(7));
        assert_eq!(attributes["latencyMs"], serde_json::json!(123));
        assert_eq!(attributes["promptTokens"], serde_json::json!(40));
        assert_eq!(attributes["completionTokens"], serde_json::json!(8));
        assert_eq!(attributes["mtpDraftsProposed"], serde_json::json!(5));
        assert_eq!(attributes["mtpDraftsAccepted"], serde_json::json!(3));
        assert_eq!(attributes["mtpDraftCalls"], serde_json::json!(2));
    }

    /// Two runs produce DISTINCT span ids, so a second run's rows are not
    /// swallowed by `ON CONFLICT (span_id) DO NOTHING` (AC-4 edge: two sets,
    /// distinguishable by `start_time_ns`/id).
    #[test]
    fn two_runs_produce_distinguishable_span_ids() {
        let first = score_span("100", 100, &sample(true));
        let second = score_span("200", 200, &sample(true));
        assert_ne!(first.span_id, second.span_id);
        assert_ne!(first.trace_id, second.trace_id);
        assert_ne!(first.start_time_ns, second.start_time_ns);
    }

    /// The endpoint's resolved precondition and non-secret identity.
    #[test]
    fn the_endpoint_reports_resolution_and_a_non_secret_identity() {
        let resolved = ScoreStoreEndpoint::new("127.0.0.1", 5433, "postgres", "s3cr3t", "fredo");
        assert!(resolved.is_resolved());
        let identity = resolved.identity();
        assert_eq!(identity, "postgres://postgres@127.0.0.1:5433/fredo");
        assert!(!identity.contains("s3cr3t"), "the identity must never carry the password");

        let unresolved = ScoreStoreEndpoint::new("127.0.0.1", 0, "postgres", "", "fredo");
        assert!(!unresolved.is_resolved());
    }

    /// The read-back query is the documented one: it selects the AC-4 observable
    /// columns and filters on the namespaced event type.
    #[test]
    fn the_read_back_query_filters_on_the_event_type() {
        assert!(READ_BACK_SQL.contains("FROM telemetry_spans"));
        assert!(READ_BACK_SQL.contains("WHERE event_type = $1"));
        assert!(READ_BACK_SQL.contains("attributes_json"));
        assert!(READ_BACK_SQL.contains("ORDER BY start_time_ns"));
    }
}
