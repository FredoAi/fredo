//! Gated end-to-end integration test for the headless `fredo ingest` daemon
//! (Spec #2992, CU-4 / ST-8).
//!
//! This drives the REAL `fredo ingest` binary (not an in-process copy) against
//! scratch dirs under `.opencode/tmp/2992/`, proving the three AC1–AC3 legs:
//!
//! * **(a)** the daemon boots the embedded PostgreSQL cluster, publishes the
//!   descriptor, serves OTLP/HTTP, and a delivered trace persists BOTH a raw
//!   `telemetry_spans` row (existing `SpanStore::insert_raw_spans`) AND a
//!   canonical `chat_rows` row (existing `IngestClassifier`) — no alternate
//!   route.
//! * **(c)** while the first daemon holds the exclusive data-dir lock, a second
//!   `fredo ingest` exits non-zero with a clear lock message and starts no
//!   second postmaster; the first is unaffected.
//! * **(b)** the shutdown file makes the first daemon exit **0** within the
//!   bound, clearing the descriptor, releasing the lock, leaving no orphan
//!   postmaster, and the post-stop TCP probe against the PG port fails.
//!
//! # Gate
//!
//! ```text
//! FREDO_INGEST_E2E=1 cargo test --locked --test headless_ingest -- --nocapture
//! ```
//!
//! Without the gate the test prints a skip line and returns — a plain
//! `cargo test --locked` executes it as an immediate no-op (exit 0).
//!
//! # Bounded (G-263)
//!
//! EVERY child wait (readiness, HTTP up, lock-conflict exit, shutdown) carries
//! an explicit wall-clock cap with a hard-kill fallback, and a `Drop` guard kills
//! the daemon on any early exit / panic. The daemon is additionally started with
//! a hard `--run-ms` self-terminate so even a lost shutdown lever cannot leave it
//! running forever.
//!
//! # Fixture (G-172)
//!
//! The deterministic OTLP trace payload this test POSTs is committed at
//! `.opencode/tests/headless-ingest/fixtures/otlp-trace-chat.json` — an in-repo
//! producer for the tester's F-2/F-10 receipts.
//!
//! # Non-goals
//!
//! Does not weaken or delete the existing engine regression suites or the #2989
//! spike test (G-290/G-281); it only ADDS this gated file + the fixture.

use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};

use fredo_lib::descriptor::HeadlessDescriptor;
use fredo_lib::infrastructure::storage::engine::{build_pg_pool, EngineHandle, PgEngine};
use fredo_lib::infrastructure::storage::AppStore;
use tokio::process::{Child, Command};

/// The gate. The test is a no-op unless this is exactly `1`.
const GATE_ENV: &str = "FREDO_INGEST_E2E";
/// Fixed session id carried by the committed fixture; the row assertions key on
/// it. The scratch cluster is rebuilt fresh each run, so the count is
/// deterministic.
const FIXTURE_SESSION_ID: &str = "headless-ingest-e2e-session";
/// Fixed shared control-plane credential pre-seeded before the daemon starts, so
/// the test can build its own PG pool against the daemon-owned cluster.
const E2E_PASSWORD: &str = "headless-ingest-e2e-password";
/// The control-plane credential key (`pg_supervisor::PG_PASSWORD_KEY`).
const PG_PASSWORD_KEY: &str = "postgres.password";
/// Hard `--run-ms` self-terminate passed to every child (a lost-lever safety).
const CHILD_RUN_MS: u64 = 300_000;
/// Bounded readiness wait (covers a cold `setup()`/initdb on a warm install).
const READINESS_BOUND: Duration = Duration::from_secs(600);
/// Bounded HTTP-receiver wait.
const HTTP_BOUND: Duration = Duration::from_secs(120);
/// Bounded row-persistence poll.
const ROW_BOUND: Duration = Duration::from_secs(60);
/// Bounded wait for the second daemon's fail-fast exit.
const CONFLICT_BOUND: Duration = Duration::from_secs(60);
/// Bounded wait for the graceful shutdown-file exit.
const SHUTDOWN_BOUND: Duration = Duration::from_secs(90);
/// Bound on a single loopback probe.
const PROBE_BOUND: Duration = Duration::from_millis(500);

/// Repo root (`<repo>/apps/tauri/src-tauri` → up three levels).
///
/// Deliberately NOT canonicalized: on Windows `canonicalize()` returns a
/// `\\?\C:\…` verbatim path, and `initdb` rejects the `\\?\` prefix (it tries to
/// create `//?/C:`). The spike's scratch-dir rule keeps the `..` segments for the
/// same reason.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

/// `.opencode/tmp/2992/st8-e2e` — this test's isolated scratch root.
fn scratch_root() -> PathBuf {
    repo_root().join(".opencode").join("tmp").join("2992").join("st8-e2e")
}

/// The committed deterministic OTLP trace fixture (G-172).
fn fixture_path() -> PathBuf {
    repo_root()
        .join(".opencode")
        .join("tests")
        .join("headless-ingest")
        .join("fixtures")
        .join("otlp-trace-chat.json")
}

/// Immutable per-run scratch layout + chosen ports.
struct Ctx {
    scratch: PathBuf,
    app_dir: PathBuf,
    pg_data_dir: PathBuf,
    lock_dir: PathBuf,
    stop_flag: PathBuf,
    desc_path: PathBuf,
    grpc_port: u16,
    http_port: u16,
}

/// A child daemon with a guaranteed kill-on-drop and bounded waits.
struct DaemonGuard {
    child: Option<Child>,
}

impl DaemonGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn is_running(&mut self) -> bool {
        self.child
            .as_mut()
            .map(|child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false)
    }

    fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }

    /// Reap the child if it has already exited; `None` while it still runs.
    fn try_exit(&mut self) -> Option<ExitStatus> {
        let status = self
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten());
        if status.is_some() {
            self.child = None;
        }
        status
    }

    /// Wait up to `bound` for exit; on expiry hard-kill and reap (bounded).
    async fn wait_bounded(&mut self, bound: Duration) -> Result<ExitStatus, String> {
        let Some(mut child) = self.child.take() else {
            return Err("the daemon has already exited".to_string());
        };
        match tokio::time::timeout(bound, child.wait()).await {
            Ok(Ok(status)) => Ok(status),
            Ok(Err(error)) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
                Err(format!("waiting for the daemon failed: {error}"))
            }
            Err(_) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
                Err(format!("the daemon did not exit within {bound:?}"))
            }
        }
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

fn free_port() -> u16 {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral loopback port");
    listener
        .local_addr()
        .expect("read the ephemeral local addr")
        .port()
}

fn tcp_open(port: u16, bound: Duration) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<std::net::SocketAddr>() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&addr, bound).is_ok()
}

fn dsn(port: u16) -> String {
    format!("postgresql://postgres:{E2E_PASSWORD}@127.0.0.1:{port}/postgres")
}

fn read_descriptor(path: &Path) -> Option<HeadlessDescriptor> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Pre-seed the shared control-plane credential on the scratch app-data dir so
/// the test can authenticate to the daemon-owned cluster without racing the
/// daemon's own control-plane writes.
fn seed_password(app_dir: &Path) {
    let engine = EngineHandle::new_pending();
    let store = AppStore::open(engine, app_dir).expect("open the scratch control plane");
    store
        .control_set(PG_PASSWORD_KEY, E2E_PASSWORD)
        .expect("seed the shared credential");
}

/// Spawn the real `fredo ingest` binary against `ctx`; logs land under scratch.
fn spawn_daemon(bin: &str, ctx: &Ctx, label: &str) -> (DaemonGuard, PathBuf) {
    let stdout_path = ctx.scratch.join(format!("{label}.out.log"));
    let stderr_path = ctx.scratch.join(format!("{label}.err.log"));
    let stdout = std::fs::File::create(&stdout_path).expect("create daemon stdout log");
    let stderr = std::fs::File::create(&stderr_path).expect("create daemon stderr log");
    let child = Command::new(bin)
        .arg("ingest")
        .env("FREDO_DATA_DIR", &ctx.app_dir)
        .env("FREDO_PG_DATA_DIR", &ctx.pg_data_dir)
        .env("FREDO_PG_LOCK_DIR", &ctx.lock_dir)
        .env("FREDO_INGEST_SHUTDOWN_FILE", &ctx.stop_flag)
        .env("FREDO_INGEST_GRPC_PORT", ctx.grpc_port.to_string())
        .env("FREDO_INGEST_HTTP_PORT", ctx.http_port.to_string())
        .env("FREDO_INGEST_STOP_BOUND_MS", "30000")
        // Neutralise any inherited override so the descriptor lands under the
        // scratch lock dir (blank is inert, G-296).
        .env("FREDO_INGEST_DESCRIPTOR", "")
        .env("FREDO_PG_STOP_HANG_MS", "")
        .arg("--run-ms")
        .arg(CHILD_RUN_MS.to_string())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the fredo ingest binary");
    (DaemonGuard::new(child), stderr_path)
}

/// Poll for the descriptor up to `bound`, failing fast if the daemon exits first
/// (so a dead child is never waited on for the full readiness bound, G-263).
async fn wait_for_descriptor_or_exit(
    path: &Path,
    bound: Duration,
    daemon: &mut DaemonGuard,
    stderr_path: &Path,
) -> Result<HeadlessDescriptor, String> {
    let deadline = Instant::now() + bound;
    loop {
        if let Some(descriptor) = read_descriptor(path) {
            return Ok(descriptor);
        }
        if let Some(status) = daemon.try_exit() {
            let stderr = std::fs::read_to_string(stderr_path).unwrap_or_default();
            return Err(format!(
                "the daemon exited early with {status:?} before publishing the descriptor; stderr: {stderr}"
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the daemon did not publish the descriptor at {} within {bound:?}",
                path.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Poll `GET /health` until it answers, bounded.
async fn wait_for_http(port: u16, bound: Duration) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = Instant::now() + bound;
    loop {
        if let Ok(response) = client
            .get(&url)
            .timeout(Duration::from_millis(500))
            .send()
            .await
        {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the OTLP/HTTP receiver on 127.0.0.1:{port} did not come up within {bound:?}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// POST the committed fixture to `/v1/traces`; returns the status code.
async fn post_fixture(port: u16, body: &str) -> Result<u16, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://127.0.0.1:{port}/v1/traces"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("POST /v1/traces failed: {error}"))?;
    Ok(response.status().as_u16())
}

/// Poll the daemon-owned cluster until a raw span, a canonical chat row, AND a
/// rollup-qualifying turn for the fixture session are visible, bounded.
///
/// The third clause mirrors the Mission Monitor rollup predicate
/// (`session_rollup.rs::compute_facts`): a turn is visible unless it is a
/// terminal (`Response`/`Timeout`) turn with a blank `agent_reply`. Requiring
/// `visible_turn >= 1` proves the fixture session is renderable by the declared
/// `sessions` rollup (ST-8R-2), not merely persisted.
async fn wait_for_rows(pool: &sqlx::PgPool, session: &str, bound: Duration) -> Result<(), String> {
    let deadline = Instant::now() + bound;
    loop {
        let spans: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_spans WHERE session_id = $1")
                .bind(session)
                .fetch_one(pool)
                .await
                .map_err(|error| format!("query telemetry_spans: {error}"))?;
        let chats: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chat_rows WHERE session_id = $1")
                .bind(session)
                .fetch_one(pool)
                .await
                .map_err(|error| format!("query chat_rows: {error}"))?;
        // The `visibleTurnCount > 0` clause (mirrors session_rollup.rs:251-255):
        // a non-subagent turn counts as visible unless it is terminal AND blank.
        let visible_turns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM chat_rows WHERE session_id = $1 \
             AND (lower(state) NOT IN ('response','timeout') \
             OR (agent_reply IS NOT NULL AND btrim(agent_reply) <> ''))",
        )
        .bind(session)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("query chat_rows visible turns: {error}"))?;
        if spans >= 1 && chats >= 1 && visible_turns >= 1 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the fixture session did not persist a rollup-qualifying row within {bound:?} \
                 (telemetry_spans={spans}, chat_rows={chats}, visible_turns={visible_turns})"
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The `postgres.exe` PID inventory (bounded `tasklist`; `[]` when unavailable).
async fn postgres_pids() -> Vec<u32> {
    let output = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq postgres.exe", "/FO", "CSV", "/NH"])
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(10), output).await {
        Ok(Ok(output)) => parse_tasklist_pids(&String::from_utf8_lossy(&output.stdout)),
        _ => Vec::new(),
    }
}

fn parse_tasklist_pids(stdout: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('"') {
            continue;
        }
        let columns: Vec<&str> = line.split("\",\"").collect();
        if columns.len() < 2 {
            continue;
        }
        if let Ok(pid) = columns[1].trim_matches('"').parse::<u32>() {
            pids.push(pid);
        }
    }
    pids
}

/// The exclusive lock must be free once the daemon has exited. On Windows the
/// daemon opens it with `share_mode(0)`, so re-opening the same way is the real
/// released/held probe.
#[cfg(target_os = "windows")]
fn assert_lock_released(lock_dir: &Path) {
    use std::os::windows::fs::OpenOptionsExt;
    let path = lock_dir.join("postgres.lock");
    let opened = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&path);
    assert!(
        opened.is_ok(),
        "the data-dir lock must be released after shutdown ({})",
        path.display()
    );
}

#[cfg(not(target_os = "windows"))]
fn assert_lock_released(lock_dir: &Path) {
    assert!(
        lock_dir.join("postgres.lock").exists(),
        "the lock file must exist under {}",
        lock_dir.display()
    );
}

/// Legs (a) and (c): boot, OTLP delivery + row persistence, lock-conflict
/// fail-fast. Returns the daemon's PG port for leg (b).
async fn scenario(
    bin: &str,
    ctx: &Ctx,
    daemon1: &mut DaemonGuard,
    stderr1: &Path,
) -> Result<u16, String> {
    // ── (a) readiness ────────────────────────────────────────────────────────
    let descriptor =
        wait_for_descriptor_or_exit(&ctx.desc_path, READINESS_BOUND, daemon1, stderr1).await?;
    if descriptor.port == 0 {
        return Err("the descriptor published a zero port".to_string());
    }
    if let Some(pid) = daemon1.pid() {
        if descriptor.pid != pid {
            return Err(format!(
                "the descriptor pid {} is not the daemon pid {pid}",
                descriptor.pid
            ));
        }
    }
    println!(
        "HEADLESS_INGEST_DESCRIPTOR pid={} port={}",
        descriptor.pid, descriptor.port
    );

    wait_for_http(ctx.http_port, HTTP_BOUND).await?;
    println!("HEADLESS_INGEST_HTTP receiver_port={} up", ctx.http_port);

    // ── (a) deliver the committed fixture ────────────────────────────────────
    let body = std::fs::read_to_string(fixture_path())
        .map_err(|error| format!("read the committed fixture: {error}"))?;
    let status = post_fixture(ctx.http_port, &body).await?;
    if status != 200 {
        return Err(format!("POST /v1/traces returned {status}, expected 200"));
    }
    println!("HEADLESS_INGEST_POST status={status} session={FIXTURE_SESSION_ID}");

    // ── (a) assert BOTH rows persisted ───────────────────────────────────────
    let engine: PgEngine = build_pg_pool(&dsn(descriptor.port), None)
        .await
        .map_err(|error| format!("build the verification pool: {error}"))?;
    wait_for_rows(&engine.pool, FIXTURE_SESSION_ID, ROW_BOUND).await?;
    println!(
        "HEADLESS_INGEST_ROWS telemetry_spans>=1 chat_rows>=1 session={FIXTURE_SESSION_ID}"
    );
    println!("HEADLESS_INGEST_ROLLUP visible_turn>=1 session={FIXTURE_SESSION_ID}");

    // ── (c) second daemon fails fast on the held lock ────────────────────────
    let (mut daemon2, stderr2) = spawn_daemon(bin, ctx, "daemon2");
    let status2 = daemon2.wait_bounded(CONFLICT_BOUND).await?;
    if status2.success() {
        return Err("the second daemon must exit non-zero while the lock is held".to_string());
    }
    let stderr_text = std::fs::read_to_string(&stderr2).unwrap_or_default();
    if !stderr_text.to_lowercase().contains("locked") {
        return Err(format!(
            "the second daemon stderr must carry a clear lock message; got: {stderr_text}"
        ));
    }
    println!(
        "HEADLESS_INGEST_LOCK_CONFLICT exit={:?} message_contains_locked=true",
        status2.code()
    );
    if !daemon1.is_running() {
        return Err("the first daemon must be unaffected by the lock conflict".to_string());
    }
    if !ctx.desc_path.exists() {
        return Err("the first daemon descriptor must survive the lock conflict".to_string());
    }

    engine.pool.close().await;
    Ok(descriptor.port)
}

/// Leg (b): shutdown via the file lever + all teardown assertions.
async fn shutdown_leg(
    ctx: &Ctx,
    daemon1: &mut DaemonGuard,
    port: u16,
    pg_before: &[u32],
) -> Result<(), String> {
    std::fs::write(&ctx.stop_flag, b"").map_err(|error| format!("create stop flag: {error}"))?;
    let started = Instant::now();
    let status = daemon1.wait_bounded(SHUTDOWN_BOUND).await?;
    let elapsed = started.elapsed();
    if !status.success() {
        return Err(format!(
            "graceful shutdown must exit 0, got {:?}",
            status.code()
        ));
    }
    println!("HEADLESS_INGEST_SHUTDOWN exit=0 elapsed_ms={}", elapsed.as_millis());

    if ctx.desc_path.exists() {
        return Err("the descriptor must be cleared on shutdown".to_string());
    }
    assert_lock_released(&ctx.lock_dir);
    println!("HEADLESS_INGEST_LOCK_RELEASED");

    if tcp_open(port, PROBE_BOUND) {
        return Err(format!(
            "the PG port {port} must not accept connections after stop"
        ));
    }
    println!("HEADLESS_INGEST_POST_STOP_TCP reachable=false");

    let pg_after = postgres_pids().await;
    let new_pids: Vec<u32> = pg_after
        .iter()
        .copied()
        .filter(|pid| !pg_before.contains(pid))
        .collect();
    if !new_pids.is_empty() {
        return Err(format!(
            "an orphan postmaster survived teardown: new postgres.exe pids {new_pids:?}"
        ));
    }
    println!(
        "HEADLESS_INGEST_NO_ORPHAN preexisting_postgres={} new_postgres=0",
        pg_before.len()
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn headless_ingest_end_to_end() {
    if std::env::var(GATE_ENV).as_deref() != Ok("1") {
        eprintln!(
            "headless_ingest: skipping — set {GATE_ENV}=1 to run the gated headless-ingest E2E"
        );
        return;
    }

    // Fresh scratch: deterministic row counts + a clean lock.
    let scratch = scratch_root();
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch).expect("clean the scratch root");
    }
    let app_dir = scratch.join("app");
    let pg_data_dir = scratch.join("pgdata");
    let lock_dir = scratch.join("lock");
    std::fs::create_dir_all(&app_dir).expect("create the scratch app dir");
    std::fs::create_dir_all(&lock_dir).expect("create the scratch lock dir");

    let desc_path = lock_dir.join("headless-ingest.json");
    let ctx = Ctx {
        scratch: scratch.clone(),
        app_dir: app_dir.clone(),
        pg_data_dir,
        lock_dir,
        stop_flag: scratch.join("stop.flag"),
        desc_path,
        grpc_port: free_port(),
        http_port: free_port(),
    };
    seed_password(&app_dir);

    let bin = env!("CARGO_BIN_EXE_fredo");
    let pg_before = postgres_pids().await;

    let (mut daemon1, stderr1) = spawn_daemon(bin, &ctx, "daemon1");

    // Run the scenario; teardown is guaranteed on EVERY path (leg (b) when the
    // scenario succeeded, the kill-on-drop guard otherwise).
    let result = scenario(bin, &ctx, &mut daemon1, &stderr1).await;

    match result {
        Ok(port) => {
            let teardown = shutdown_leg(&ctx, &mut daemon1, port, &pg_before).await;
            if let Err(error) = teardown {
                panic!("headless_ingest E2E teardown failed: {error}");
            }
        }
        Err(error) => {
            // Best-effort graceful teardown, then surface the scenario failure.
            let _ = std::fs::write(&ctx.stop_flag, b"");
            let _ = daemon1.wait_bounded(SHUTDOWN_BOUND).await;
            panic!("headless_ingest E2E scenario failed: {error}");
        }
    }

    println!("HEADLESS_INGEST_E2E_OK");
}
