//! Spike #2989 — headless ingest feasibility PoC (gated integration test).
//!
//! Proves/disproves whether Fredo application events can be persisted into the
//! embedded PostgreSQL store by a process that is NOT the Tauri desktop GUI.
//!
//! This is a **spike artifact**, not a production entry point: it ships no
//! background process, edits no `main.rs` / `lib.rs` setup closure /
//! `pg_supervisor` / OTLP binding / retention code, and adds no public
//! re-export. The whole binary is a single gated test — a normal
//! `cargo test --locked` executes it as an immediate no-op.
//!
//! # Gate
//!
//! ```text
//! FREDO_SPIKE_2989=1 cargo test --locked --test spike_2989_headless_ingest -- --nocapture
//! ```
//!
//! `FREDO_TEST_PG=1` is also accepted (the plan's names block), but the
//! canonical gate is `FREDO_SPIKE_2989`.
//!
//! # What it does (the reuse recipe — no `AppHandle` anywhere)
//!
//! `PgRuntime` (isolated `FREDO_PG_DATA_DIR`) → `build_pg_pool` →
//! `EngineHandle::install` → `RtdbStore` → `RtdbCache` → `Rtdb` →
//! `IngestClassifier`; feed one synthetic `FredoEvent` through `ingest_event`;
//! drain the write-behind channel and `cache.flush_pending`; query the
//! canonical `chat_rows`. Separately, probe the raw `telemetry_spans` path via
//! the sanctioned `SpanStore` + `SpanCollector` (never a new writer route).
//!
//! # QA contract
//!
//! The PoC prints a machine-readable `PG_DSN=postgresql://…` line for its own
//! bound ephemeral port plus the seeded `(session_id, correlation_id)` marker,
//! so the tester's managed-`psql` read can target the cluster. Because the
//! bounded teardown stops the cluster on exit, an optional, FINITE hold
//! (`FREDO_SPIKE_2989_HOLD_MS`, clamped to ≤120 s, default 0) keeps the server
//! up long enough for an external `psql` attach; the default run tears down
//! immediately.
//!
//! # Isolation (R-4.5) + safety
//!
//! Throwaway data dir `.opencode/tmp/2989/pgdata` via `FREDO_PG_DATA_DIR` and a
//! temp control-plane `AppStore` (`tempfile::tempdir()`); the app's real data
//! dir and `control.db` are never touched. The one-shot backfill markers
//! (`rtdb.backfill.completed`, `rtdb.backfill.provider.completed.v2`) are never
//! read or written. Every start/stop/wait is finitely bounded by `PgRuntime`
//! (G-263); `stop_bounded` hard-kills on expiry and the RAII `Drop` covers the
//! error/panic paths; a post-stop TCP probe must fail.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use fredo_lib::infrastructure::comm::event::{
    EventProvider, EventState, EventType, FredoEvent, Transport,
};
use fredo_lib::infrastructure::rtdb::cache::RtdbCache;
use fredo_lib::infrastructure::rtdb::commands::Rtdb;
use fredo_lib::infrastructure::rtdb::flush::{FlushLoop, RowEmitter};
use fredo_lib::infrastructure::rtdb::ingest::IngestClassifier;
use fredo_lib::infrastructure::rtdb::store::RtdbStore;
use fredo_lib::infrastructure::rtdb::subscriptions::SubscriptionRegistry;
use fredo_lib::infrastructure::storage::engine::{
    build_pg_pool, EngineHandle, StoreEngine,
};
use fredo_lib::infrastructure::storage::span_store::SpanStore;
use fredo_lib::infrastructure::storage::AppStore;
use fredo_lib::infrastructure::telemetry::SpanCollector;
use fredo_lib::PgRuntime;

/// Canonical spike gate (non-default; the PoC never runs on a plain
/// `cargo test`).
const GATE_ENV: &str = "FREDO_SPIKE_2989";
/// The plan's alternative gate (accepted for harness reuse).
const ALT_GATE_ENV: &str = "FREDO_TEST_PG";
/// Isolated data dir (FS-1 override, `pg_supervisor/mod.rs:78`).
const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
/// Isolated install dir (G-275 override, `pg_supervisor/mod.rs:85`).
const PG_INSTALL_DIR_ENV: &str = "FREDO_PG_INSTALL_DIR";
/// Optional, FINITE post-evidence hold so an external `psql` can attach.
const HOLD_ENV: &str = "FREDO_SPIKE_2989_HOLD_MS";
/// Finite teardown bound (G-263).
const STOP_BOUND: Duration = Duration::from_secs(30);
/// Hard cap on the optional hold (never unbounded).
const HOLD_CAP: u64 = 120_000;

fn spike_enabled() -> bool {
    matches!(std::env::var(GATE_ENV).as_deref(), Ok("1"))
        || matches!(std::env::var(ALT_GATE_ENV).as_deref(), Ok("1"))
}

/// `<repo>/.opencode/tmp/2989` — the sanctioned scratch dir for this spike.
fn repo_tmp() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(".opencode")
        .join("tmp")
        .join("2989")
}

fn marker(tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{tag}-{nanos}")
}

/// The whole PoC runs inside ONE owning scope so the single embedded
/// `PgRuntime` has a guaranteed teardown on every exit path (normal, error,
/// panic) — the G-263 contract.
#[tokio::test(flavor = "multi_thread")]
async fn spike_2989_headless_ingest() {
    if !spike_enabled() {
        eprintln!(
            "spike_2989: skipping — set {GATE_ENV}=1 (or {ALT_GATE_ENV}=1) to run the gated headless-ingest PoC"
        );
        return;
    }

    let tmp = repo_tmp();
    std::fs::create_dir_all(&tmp).expect("create .opencode/tmp/2989");
    let data_dir = tmp.join("pgdata");
    let install_dir = tmp.join("pginstall");
    let app_scratch = tempfile::tempdir().expect("temp control-plane scratch dir");
    std::fs::create_dir_all(&data_dir).expect("create the isolated FS-1 data dir");
    std::fs::create_dir_all(&install_dir).expect("create the isolated install dir");
    // Isolation: PgRuntime resolves these BEFORE it is constructed. The app's
    // real data dir and control.db are never referenced.
    std::env::set_var(PG_DATA_DIR_ENV, &data_dir);
    std::env::set_var(PG_INSTALL_DIR_ENV, &install_dir);

    let mut evidence: Vec<String> = Vec::new();
    let mut record = |line: String| {
        println!("{line}");
        evidence.push(line);
    };

    // ── ONE embedded server (bounded; Drop is the panic/error hard-kill) ─────
    let mut runtime = PgRuntime::new(&app_scratch.path().join("pg-app"), "spike2989-password".to_string());
    runtime.setup().await.expect("embedded PostgreSQL setup (bounded)");
    runtime
        .apply_server_knobs()
        .expect("server-memory knob overlay");
    runtime
        .start()
        .await
        .expect("embedded PostgreSQL start (bounded)");
    runtime
        .probe_ready()
        .await
        .expect("embedded PostgreSQL readiness (bounded)");

    let url = runtime.connection_url();
    let port = runtime.port();
    // The crate resolves `host = localhost`; the QA contract wants the IPv4
    // literal. Prove the normalized host actually accepts a connection before
    // printing it as the DSN.
    let dsn = url.replace("localhost", "127.0.0.1");
    let ipv4_reachable = std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("parse 127.0.0.1:{port}"),
        Duration::from_millis(500),
    )
    .is_ok();
    // Machine-readable DSN for the tester's managed-psql read (QA contract).
    record(format!("PG_DSN={dsn}"));
    record(format!("SPIKE_2989_ACTUAL_URL={url}"));
    record(format!(
        "SPIKE_2989_TCP_127_0_0_1 reachable={ipv4_reachable}"
    ));
    record(format!(
        "SPIKE_2989_ISOLATION data_dir={} install_dir={} control_db={}",
        data_dir.display(),
        install_dir.display(),
        app_scratch.path().join("control.db").display()
    ));

    // ── Engine + canonical row pipeline (no AppHandle) ──────────────────────
    let pg_engine = build_pg_pool(&url, None).await.expect("bounded PG pool build");
    let engine = EngineHandle::new_pending();
    engine.install(StoreEngine::Postgres(Arc::new(pg_engine)));

    let store = Arc::new(RtdbStore::open(engine.clone()).expect("RtdbStore::open"));
    store.ensure_schema().await.expect("rtdb *_rows schema");
    let (cache, mut rx) = RtdbCache::new(store.clone());
    let emitter: RowEmitter = Arc::new(|_deliveries, _marker| {});
    let rtdb = Arc::new(Rtdb::new(
        cache.clone(),
        Arc::new(SubscriptionRegistry::new()),
        Arc::new(FlushLoop::new(emitter)),
    ));
    let classifier = IngestClassifier::new(rtdb);

    // One synthetic Chat event through the classifier (the ONLY write path).
    let session_id = marker("spike2989-session");
    let correlation_id = marker("spike2989-corr");
    let event = FredoEvent::builder()
        .event_type(EventType::Chat)
        .state(EventState::Init)
        .provider(EventProvider::OpenCode)
        .transport(Transport::Hook)
        .session_id(session_id.clone())
        .correlation_id(correlation_id.clone())
        .payload(json!({
            "userMessage": "spike-2989 headless ingest",
            "agentReply": "persisted without the GUI",
            "promptTokens": 7,
            "completionTokens": 3,
        }))
        .build();
    let classified = classifier.ingest_event(&event).await;
    record(format!(
        "SPIKE_2989_CLASSIFIED relationship_copies={classified} (the return value counts re-key copies, not writes)"
    ));

    // Drain the write-behind channel and flush (NO AppHandle writer task).
    let mut batch = Vec::new();
    while let Ok(pending) = rx.try_recv() {
        batch.push(pending);
    }
    let pending_len = batch.len();
    let flushed = cache
        .flush_pending(batch)
        .await
        .expect("cache.flush_pending (bounded)");
    record(format!(
        "SPIKE_2989_FLUSH canonical_pending={pending_len} canonical_rows_written={flushed}"
    ));

    let pg = engine.pg().expect("the PG engine is installed");
    let chat_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chat_rows WHERE session_id = $1 AND correlation_id = $2",
    )
    .bind(&session_id)
    .bind(&correlation_id)
    .fetch_one(&pg.pool)
    .await
    .expect("query chat_rows by seeded key");
    let chat_total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_rows")
        .fetch_one(&pg.pool)
        .await
        .expect("query chat_rows total");
    let chat_row: Option<(String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT session_id, user_message, prompt_tokens FROM chat_rows \
         WHERE session_id = $1 AND correlation_id = $2",
    )
    .bind(&session_id)
    .bind(&correlation_id)
    .fetch_optional(&pg.pool)
    .await
    .expect("query the seeded chat row content");
    record(format!(
        "SPIKE_2989_CHAT_ROWS marker_count={chat_count} table_total={chat_total}"
    ));
    record(format!(
        "SPIKE_2989_CHAT_ROW session_id={session_id} correlation_id={correlation_id} content={chat_row:?}"
    ));

    // ── Raw telemetry_spans probe via the SANCTIONED SpanStore/SpanCollector ─
    let span_store = Arc::new(SpanStore::open(engine.clone()).expect("SpanStore::open"));
    span_store.ensure_schema().await.expect("telemetry_spans schema");
    let app_store = Arc::new(
        AppStore::open(engine.clone(), app_scratch.path()).expect("temp control-plane AppStore"),
    );
    let collector = SpanCollector::new(span_store.clone(), app_store.clone());
    let raw_session = marker("spike2989-raw-session");
    let raw_correlation = marker("spike2989-raw-corr");
    let raw_init = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Init)
        .provider(EventProvider::OpenCode)
        .transport(Transport::OtlpHttp)
        .session_id(raw_session.clone())
        .correlation_id(raw_correlation.clone())
        .tool_name("spike_probe")
        .payload(json!({"toolInputJson": "{}"}))
        .build();
    let raw_response = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Response)
        .provider(EventProvider::OpenCode)
        .transport(Transport::OtlpHttp)
        .session_id(raw_session.clone())
        .correlation_id(raw_correlation.clone())
        .tool_name("spike_probe")
        .payload(json!({"toolOutputJson": "ok"}))
        .build();
    collector.process_events(std::slice::from_ref(&raw_init)).await;
    collector.process_events(std::slice::from_ref(&raw_response)).await;
    let spans_flushed = collector.flush_all().await;
    let span_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_spans WHERE session_id = $1")
            .bind(&raw_session)
            .fetch_one(&pg.pool)
            .await
            .expect("query telemetry_spans by seeded session");
    let span_total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_spans")
        .fetch_one(&pg.pool)
        .await
        .expect("query telemetry_spans total");
    record(format!(
        "SPIKE_2989_TELEMETRY_SPANS marker_count={span_count} table_total={span_total} flushed={spans_flushed}"
    ));

    // ── Static pool/lock grounding (AC5 contention is recorded as untested) ──
    record(
        "SPIKE_2989_POOL pool_max_connections=8 server_max_connections=8 acquire_timeout_s=5 \
         (engine.rs:39-43; pg_supervisor/mod.rs:170-176)"
            .to_string(),
    );
    record(
        "SPIKE_2989_LOCK PgRuntime does not acquire PgDataDirLock; isolation is the throwaway \
         FREDO_PG_DATA_DIR, so no app data dir is ever opened (lock.rs:36-61; state.rs:247)"
            .to_string(),
    );

    // ── Optional FINITE hold so an external psql can read the live cluster ──
    if let Ok(raw) = std::env::var(HOLD_ENV) {
        if let Ok(requested) = raw.trim().parse::<u64>() {
            let hold = requested.min(HOLD_CAP);
            if hold > 0 {
                record(format!("SPIKE_2989_HOLDING_MS={hold}"));
                tokio::time::sleep(Duration::from_millis(hold)).await;
            }
        }
    }

    // ── G-263 teardown: finite bound + no orphan + post-stop probe fails ─────
    pg.pool.close().await;
    let started = Instant::now();
    let outcome = runtime.stop_bounded(STOP_BOUND).await;
    let elapsed = started.elapsed();
    record(format!("SPIKE_2989_TEARDOWN outcome={outcome:?} elapsed_ms={}", elapsed.as_millis()));
    assert!(
        elapsed < STOP_BOUND + Duration::from_secs(15),
        "teardown must be bounded, took {elapsed:?}"
    );
    let addr = format!("127.0.0.1:{port}");
    let still_up = std::net::TcpStream::connect_timeout(
        &addr.parse().expect("parse the resolved port"),
        Duration::from_millis(500),
    )
    .is_ok();
    assert!(
        !still_up,
        "the postmaster must not accept connections on {addr} after stop_bounded"
    );
    record(format!("SPIKE_2989_POST_STOP_TCP reachable={still_up}"));

    // ── Persist the evidence transcript for the record (after the last
    // `record` use, so the closure's mutable borrow has ended) ──────────────
    let evidence_dir = tmp.join("evidence");
    std::fs::create_dir_all(&evidence_dir).expect("create evidence dir");
    std::fs::write(
        evidence_dir.join("poc-evidence.txt"),
        evidence.join("\n") + "\n",
    )
    .expect("write poc-evidence.txt");
    println!("SPIKE_2989_OK");
}
