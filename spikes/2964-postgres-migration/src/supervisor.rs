//! Spike #2964 **ST-5** — lifecycle supervisor PoC: bounded start/stop with
//! guaranteed teardown and a PID-reuse-guarded orphan sweep.
//!
//! This is the executable proof for the C4 lifecycle-supervision contract
//! (`docs/research/2964-postgres-migration-approach/startup-lifecycle.md`) and
//! for R-1(d) / R-3 / R-3a / R-3b. It owns the single strongest objection to the
//! migration: the `#2948` ~11 h `pg.stop()` hang. The PoC demonstrates, with
//! measured evidence written to `results/lifecycle.json`, that:
//!
//! * every blocking wait (`pg.setup`, `pg.start`, connect, readiness poll,
//!   `pg.stop`) carries an explicit wall-clock cap;
//! * the graceful stop is bounded and falls back to `taskkill /PID <pid> /T /F`
//!   on expiry (the exact fallback is exercised directly);
//! * teardown is guaranteed on the normal, hard-kill, and **panic** paths;
//! * a startup sweep reclaims a real orphaned `postgres.exe` only after the
//!   PID-reuse guard confirms the live image is `postgres.exe`;
//! * the whole run completes in finite wall-clock and leaves no `postgres.exe`
//!   it started behind.
//!
//! # Reuse (migration principle: reuse-or-justify)
//!
//! The bounded embedded-PostgreSQL lifecycle is REUSED verbatim from ST-1's
//! shared harness (`harness::PgRuntime`, `harness::sweep_orphans`,
//! `harness::is_postgres_image`, `harness::kill_pid_tree`,
//! `harness::read_postmaster_pid`, `harness::connect_until_ready`). This binary
//! adds the pieces the harness does not own: the AppStore-shaped PID marker and
//! the steady-state supervisor control flow that mirrors
//! `apps/tauri/src-tauri/src/features/llm_server/process.rs`.
//!
//! No file under `apps/**` is referenced or changed.

use anyhow::{anyhow, Context, Result};
use postgres_migration_spike::harness::{self, PgRuntime};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// AppStore `settings` KV key holding the supervised postmaster PID
/// (production parity: `llm_server::LLAMA_SERVER_PID_KEY`).
pub const PG_PID_KEY: &str = "postgres_pid";
/// Image name the supervised server must report for the PID-reuse guard to
/// treat a persisted PID as OUR server.
pub const POSTGRES_IMAGE: &str = "postgres.exe";
/// Upper bound on how long the PoC waits for a killed PID to disappear.
pub const DEATH_WAIT_BOUND: Duration = Duration::from_secs(20);

// ── AppStore-shaped settings KV (the production PID marker lives here) ────────

/// Minimal replica of the production `AppStore` settings KV
/// (`settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`) — the marker must
/// survive process restarts and data-dir wipes, exactly as in production.
pub struct SettingsKv {
    conn: Connection,
}

impl SettingsKv {
    fn ensure_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (\
                 key TEXT PRIMARY KEY, value TEXT NOT NULL\
             );",
        )
        .context("create settings table")?;
        Ok(())
    }

    /// Open (creating) the on-disk settings KV at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create marker dir {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        Self::ensure_schema(&conn)?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("open in-memory settings")?;
        Self::ensure_schema(&conn)?;
        Ok(Self { conn })
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO settings(key, value) VALUES(?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .context("settings upsert")?;
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .context("settings read")
    }

    /// Persist the marker; `None` clears it (blank value => no PID).
    pub fn persist_pid(&self, pid: Option<u32>) -> Result<()> {
        self.set(PG_PID_KEY, &pid.map(|p| p.to_string()).unwrap_or_default())
    }

    /// Read the marker (blank / malformed => `None`).
    pub fn persisted_pid(&self) -> Result<Option<u32>> {
        Ok(self
            .get(PG_PID_KEY)?
            .and_then(|value| value.trim().parse::<u32>().ok()))
    }
}

// ── supervisor primitives (mirror `llm_server/process.rs`) ───────────────────

/// PID-reuse-guarded startup sweep — marker-driven, exactly mirroring
/// `features/llm_server/process.rs:185-197`: read the persisted PID, kill it
/// ONLY when its live image is `postgres.exe`, then always clear the marker.
/// A missing marker, a gone process, and a reused PID are all safe no-kill
/// paths.
pub fn sweep_orphan(store: &SettingsKv) -> Result<Option<u32>> {
    let Some(pid) = store.persisted_pid()? else {
        return Ok(None);
    };
    let killed = if harness::is_postgres_image(pid) {
        harness::kill_pid_tree(pid);
        Some(pid)
    } else {
        None
    };
    store.persist_pid(None)?;
    Ok(killed)
}

/// Top-level teardown guard — the PoC analogue of the production
/// `RunEvent::Exit` hook (`apps/tauri/src-tauri/src/lib.rs:664-671`). Every
/// postmaster this run starts is tracked; on scope exit (normal return OR panic
/// unwind) any tracked PID still alive is hard-killed after the PID-reuse guard
/// confirms the live image is `postgres.exe`. This is the last of the three
/// teardown layers (exit hook -> RAII `Drop` -> startup sweep).
#[derive(Default)]
pub struct PidReaper {
    pids: Vec<u32>,
}

impl PidReaper {
    pub fn track(&mut self, pid: u32) {
        self.pids.push(pid);
    }
}

impl Drop for PidReaper {
    fn drop(&mut self) {
        for pid in &self.pids {
            if harness::is_postgres_image(*pid) {
                harness::kill_pid_tree(*pid);
            }
        }
    }
}

/// Bounded await — EVERY blocking wait in this PoC is routed through it so no
/// wait can be unbounded (`#2948`'s ~11 h `pg.stop()` class).
pub async fn run_bounded<T, F>(bound: Duration, what: &str, fut: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    match tokio::time::timeout(bound, fut).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("{what} exceeded its {bound:?} wall-clock bound")),
    }
}

/// Time an await, returning `(value, elapsed_ms)`.
async fn timed<T, F: Future<Output = T>>(fut: F) -> (T, f64) {
    let start = Instant::now();
    let value = fut.await;
    (value, start.elapsed().as_secs_f64() * 1000.0)
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Bounded poll until `pid` is no longer a live `postgres.exe`.
pub async fn wait_until_dead(pid: u32, bound: Duration) -> bool {
    tokio::task::spawn_blocking(move || {
        let deadline = Instant::now() + bound;
        loop {
            if !harness::is_postgres_image(pid) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })
    .await
    .unwrap_or(false)
}

/// Bounded poll until `pid` is a live `postgres.exe` (proves a leaked runtime is
/// a real orphan before the sweep runs).
async fn wait_until_alive(pid: u32, bound: Duration) -> bool {
    tokio::task::spawn_blocking(move || {
        let deadline = Instant::now() + bound;
        loop {
            if harness::is_postgres_image(pid) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })
    .await
    .unwrap_or(false)
}

/// `tasklist` availability probe: can the process-observation tool see OUR own
/// image? If not, image-based teardown checks are unverifiable and the run must
/// say so rather than claim a false PASS.
pub fn tasklist_available() -> bool {
    let own = std::process::id();
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {own}"), "/FO", "CSV", "/NH"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains(".exe"))
        .unwrap_or(false)
}

/// Global snapshot of live `postgres.exe` PIDs via `tasklist`. `None` when the
/// snapshot tool is unavailable (recorded as a tool-access gap, never asserted).
pub fn list_postgres_pids() -> Option<Vec<u32>> {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq postgres.exe", "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut pids = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('"') {
            continue;
        }
        let cols: Vec<&str> = line.trim_matches('"').split("\",\"").collect();
        if cols.len() >= 2 && cols[0].to_ascii_lowercase().contains("postgres") {
            if let Ok(pid) = cols[1].trim().parse::<u32>() {
                pids.push(pid);
            }
        }
    }
    Some(pids)
}

// ── report model ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Bounds {
    control_ms: u128,
    setup_ms: u128,
    start_ms: u128,
    stop_ms: u128,
    connect_ms: u128,
    ready_ms: u128,
}

#[derive(Serialize, Default, Clone)]
struct Scenario {
    name: String,
    ok: bool,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    postmaster_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    marker_persisted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    marker_cleared: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    orphan_alive_before_sweep: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    swept_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dead_after: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panicked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sweep_child_stdout: Option<String>,
}

#[derive(Serialize, Clone)]
struct Check {
    name: String,
    ok: bool,
    detail: String,
}

#[derive(Serialize)]
struct LifecycleReport {
    issue: u32,
    task: String,
    acquisition_mode: String,
    crate_version: String,
    os: String,
    arch: String,
    profile: String,
    process_observation_available: bool,
    bounds: Bounds,
    scenarios: Vec<Scenario>,
    checks: Vec<Check>,
    passed: usize,
    failed: usize,
    baseline_postgres_pids: Vec<u32>,
    final_postgres_pids: Vec<u32>,
    orphan_pids: Vec<u32>,
    total_ms: u128,
}

type ScenarioOutcome = (Scenario, Vec<Check>);

fn check(name: &str, ok: bool, detail: impl Into<String>) -> Check {
    Check {
        name: name.to_string(),
        ok,
        detail: detail.into(),
    }
}

fn prepare_data_dir(dir: &Path) -> Result<()> {
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
    std::fs::create_dir_all(dir).with_context(|| format!("create data dir {}", dir.display()))?;
    Ok(())
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

// ── scenarios ────────────────────────────────────────────────────────────────

/// 5 — PID-reuse guard: a persisted PID whose live image is NOT `postgres.exe`
/// (a reused PID or an unrelated process) is NEVER killed, and the marker is
/// still cleared.
fn scenario_pid_reuse_guard(marker: &SettingsKv) -> Result<ScenarioOutcome> {
    let mut scenario = Scenario {
        name: "pid_reuse_guard".to_string(),
        ..Default::default()
    };
    let mut checks = Vec::new();

    // (a) A PID that is not running at all: safe no-kill, marker cleared.
    marker.persist_pid(Some(4_000_000))?;
    let swept_absent = sweep_orphan(marker)?;
    let cleared_absent = marker.persisted_pid()?.is_none();

    // (b) OUR OWN live PID — a real live image that is not `postgres.exe`.
    // If the guard regressed and killed it, this process would not survive.
    let own = std::process::id();
    let own_is_postgres = harness::is_postgres_image(own);
    marker.persist_pid(Some(own))?;
    let swept_own = sweep_orphan(marker)?;
    let cleared_own = marker.persisted_pid()?.is_none();
    let survived = true; // reaching this line proves the guard did not kill us

    scenario.detail = format!(
        "absent-pid=4,000,000 -> swept={swept_absent:?}, cleared={cleared_absent}; \
         own-pid={own} (is_postgres={own_is_postgres}) -> swept={swept_own:?}, \
         cleared={cleared_own}, survived={survived}"
    );
    scenario.swept_pid = swept_own;
    scenario.marker_cleared = Some(cleared_absent && cleared_own);
    scenario.ok = swept_absent.is_none()
        && cleared_absent
        && !own_is_postgres
        && swept_own.is_none()
        && cleared_own
        && survived;

    checks.push(check(
        "guard.absent_pid_not_killed",
        swept_absent.is_none(),
        format!("swept={swept_absent:?} (expected None)"),
    ));
    checks.push(check(
        "guard.non_postgres_image_not_killed",
        !own_is_postgres && swept_own.is_none() && survived,
        format!("own pid {own}, is_postgres={own_is_postgres}, swept={swept_own:?}"),
    ));
    checks.push(check(
        "guard.marker_cleared_after_inspection",
        cleared_absent && cleared_own,
        format!("absent_cleared={cleared_absent}, own_cleared={cleared_own}"),
    ));

    Ok((scenario, checks))
}

/// 1 — normal lifecycle: bounded setup/start -> persist PID marker -> bounded
/// readiness poll -> bounded stop -> clear marker -> verify no orphan.
async fn scenario_normal(
    data_dir: &Path,
    install_dir: &Path,
    marker: &SettingsKv,
    reaper: &mut PidReaper,
) -> Result<ScenarioOutcome> {
    let mut scenario = Scenario {
        name: "normal_start_ready_stop".to_string(),
        ..Default::default()
    };
    let mut checks = Vec::new();

    prepare_data_dir(data_dir)?;
    // Belt-and-suspenders: the data-dir `postmaster.pid` backstop (covers the
    // window between spawn and marker write).
    if let Some(pid) = harness::sweep_orphans(data_dir) {
        scenario.detail.push_str(&format!("pre-start swept postmaster.pid {pid}; "));
    }

    let mut pg = PgRuntime::new(data_dir.to_path_buf(), install_dir.to_path_buf());

    let (setup_res, setup_ms) =
        timed(run_bounded(harness::PG_SETUP_BOUND, "pg.setup", pg.setup())).await;
    setup_res.context("bounded pg.setup")?;
    scenario.setup_ms = Some(setup_ms);

    let start_started = Instant::now();
    let start_res = run_bounded(harness::PG_START_BOUND, "pg.start", pg.start()).await;
    let start_ms = elapsed_ms(start_started);
    start_res.context("bounded pg.start")?;
    scenario.start_ms = Some(start_ms);

    let pid = harness::read_postmaster_pid(data_dir).context("postmaster.pid after start")?;
    scenario.postmaster_pid = Some(pid);
    reaper.track(pid);
    marker.persist_pid(Some(pid))?;
    let marker_persisted = marker.persisted_pid()? == Some(pid);
    scenario.marker_persisted = Some(marker_persisted);

    let url = pg.url();
    let ready_started = Instant::now();
    let ready_res = run_bounded(
        harness::PG_READY_BOUND + Duration::from_secs(2),
        "readiness poll",
        async move {
            // The synchronous `postgres` client is driven entirely on the
            // blocking thread and dropped there (mirrors ST-1's finding that it
            // owns its own runtime).
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _client = harness::connect_until_ready(&url)?;
                Ok(())
            })
            .await
            .context("readiness poll task")?
        },
    )
    .await;
    let ready_ms = elapsed_ms(ready_started);
    ready_res.context("bounded readiness poll")?;
    scenario.ready_ms = Some(ready_ms);

    let (_, stop_ms) = timed(pg.shutdown()).await;
    scenario.stop_ms = Some(stop_ms);
    marker.persist_pid(None)?;
    let marker_cleared = marker.persisted_pid()?.is_none();
    scenario.marker_cleared = Some(marker_cleared);

    let dead = wait_until_dead(pid, DEATH_WAIT_BOUND).await;
    scenario.dead_after = Some(dead);

    scenario.ok = marker_persisted
        && marker_cleared
        && dead
        && start_ms <= ms(harness::PG_START_BOUND)
        && ready_ms <= ms(harness::PG_READY_BOUND)
        && stop_ms <= ms(harness::PG_STOP_BOUND);
    scenario.detail.push_str(&format!(
        "pid={pid}, setup={setup_ms:.0}ms, start={start_ms:.0}ms, ready={ready_ms:.0}ms, \
         stop={stop_ms:.0}ms, dead={dead}"
    ));

    checks.push(check(
        "normal.start_bounded",
        start_ms <= ms(harness::PG_START_BOUND),
        format!("pg.start {start_ms:.0} ms <= bound {:.0} ms", ms(harness::PG_START_BOUND)),
    ));
    checks.push(check(
        "normal.ready_bounded",
        ready_ms <= ms(harness::PG_READY_BOUND),
        format!("readiness {ready_ms:.0} ms <= bound {:.0} ms", ms(harness::PG_READY_BOUND)),
    ));
    checks.push(check(
        "normal.stop_bounded",
        stop_ms <= ms(harness::PG_STOP_BOUND),
        format!("pg.stop {stop_ms:.0} ms <= bound {:.0} ms", ms(harness::PG_STOP_BOUND)),
    ));
    checks.push(check(
        "normal.pid_marker_persisted",
        marker_persisted,
        format!("marker == {pid}"),
    ));
    checks.push(check(
        "normal.pid_marker_cleared",
        marker_cleared,
        "marker empty after bounded stop",
    ));
    checks.push(check(
        "normal.teardown_no_orphan",
        dead,
        format!("postgres.exe pid {pid} gone within {:?}", DEATH_WAIT_BOUND),
    ));

    Ok((scenario, checks))
}

/// 3 — the on-expiry branch of a bounded stop: `taskkill /PID <pid> /T /F`
/// tears down a LIVE postmaster tree (the exact fallback `PgRuntime::shutdown`
/// invokes when `pg.stop()` exceeds `PG_STOP_BOUND`).
async fn scenario_hard_kill(
    data_dir: &Path,
    install_dir: &Path,
    marker: &SettingsKv,
    reaper: &mut PidReaper,
) -> Result<ScenarioOutcome> {
    let mut scenario = Scenario {
        name: "hard_kill_fallback_on_stop_timeout".to_string(),
        ..Default::default()
    };
    let mut checks = Vec::new();

    prepare_data_dir(data_dir)?;
    let mut pg = PgRuntime::new(data_dir.to_path_buf(), install_dir.to_path_buf());
    let (setup_res, _) = timed(run_bounded(harness::PG_SETUP_BOUND, "pg.setup", pg.setup())).await;
    setup_res.context("bounded pg.setup")?;
    let (start_res, start_ms) =
        timed(run_bounded(harness::PG_START_BOUND, "pg.start", pg.start())).await;
    start_res.context("bounded pg.start")?;
    scenario.start_ms = Some(start_ms);

    let pid = harness::read_postmaster_pid(data_dir).context("postmaster.pid after start")?;
    scenario.postmaster_pid = Some(pid);
    reaper.track(pid);
    marker.persist_pid(Some(pid))?;
    scenario.marker_persisted = Some(true);

    let alive_before = wait_until_alive(pid, Duration::from_secs(5)).await;
    // The exact on-expiry fallback: taskkill /PID <pid> /T /F.
    let kill_started = Instant::now();
    harness::kill_pid_tree(pid);
    let kill_ms = elapsed_ms(kill_started);
    let dead = wait_until_dead(pid, DEATH_WAIT_BOUND).await;

    marker.persist_pid(None)?;
    let marker_cleared = marker.persisted_pid()?.is_none();
    scenario.marker_cleared = Some(marker_cleared);
    scenario.dead_after = Some(dead);
    scenario.detail = format!(
        "pid={pid}, alive_before={alive_before}, kill_pid_tree={kill_ms:.0}ms, dead={dead}"
    );
    scenario.ok = alive_before && dead && marker_cleared;

    checks.push(check(
        "hard_kill.live_postmaster_before",
        alive_before,
        format!("pid {pid} was a live postgres.exe before the fallback"),
    ));
    checks.push(check(
        "hard_kill.fallback_tears_down_tree",
        dead,
        format!("taskkill /PID {pid} /T /F removed the postmaster tree"),
    ));
    checks.push(check(
        "hard_kill.marker_cleared",
        marker_cleared,
        "marker empty after the fallback",
    ));

    Ok((scenario, checks))
}

/// 2 — panic-path teardown: a panic while the runtime is owned by the
/// unwinding scope still runs `PgRuntime::drop` (RAII hard-kill) so no orphan
/// survives.
async fn scenario_panic(
    data_dir: &Path,
    install_dir: &Path,
    marker: &SettingsKv,
    reaper: &mut PidReaper,
) -> Result<ScenarioOutcome> {
    let mut scenario = Scenario {
        name: "panic_path_teardown".to_string(),
        ..Default::default()
    };
    let mut checks = Vec::new();

    prepare_data_dir(data_dir)?;
    let mut pg = PgRuntime::new(data_dir.to_path_buf(), install_dir.to_path_buf());
    let (setup_res, _) = timed(run_bounded(harness::PG_SETUP_BOUND, "pg.setup", pg.setup())).await;
    setup_res.context("bounded pg.setup")?;
    let (start_res, start_ms) =
        timed(run_bounded(harness::PG_START_BOUND, "pg.start", pg.start())).await;
    start_res.context("bounded pg.start")?;
    scenario.start_ms = Some(start_ms);

    let pid = harness::read_postmaster_pid(data_dir).context("postmaster.pid after start")?;
    scenario.postmaster_pid = Some(pid);
    reaper.track(pid);
    marker.persist_pid(Some(pid))?;
    let marker_persisted = marker.persisted_pid()? == Some(pid);
    scenario.marker_persisted = Some(marker_persisted);

    // Induce a panic while `pg` is owned by the unwinding scope: `PgRuntime`'s
    // `Drop` must hard-kill the postmaster tree during unwinding. The default
    // panic hook prints the induced panic to stderr (expected, not a failure).
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(move || {
        let _owned = pg;
        panic!("induced panic (ST-5): teardown must still run");
    }));
    let panicked = outcome.is_err();
    scenario.panicked = Some(panicked);

    let dead = wait_until_dead(pid, DEATH_WAIT_BOUND).await;
    scenario.dead_after = Some(dead);

    // Production parity: the next startup's PID-reuse-guarded sweep clears the
    // marker (a hard-kill leaves the marker behind by design).
    let swept = sweep_orphan(marker)?;
    let marker_cleared = marker.persisted_pid()?.is_none();
    scenario.swept_pid = swept;
    scenario.marker_cleared = Some(marker_cleared);
    scenario.detail = format!(
        "pid={pid}, panicked={panicked}, dead={dead}, sweep={swept:?}, cleared={marker_cleared}"
    );
    scenario.ok = panicked && dead && marker_cleared;

    checks.push(check(
        "panic.panic_observed",
        panicked,
        "the induced panic was caught (unwinding completed)",
    ));
    checks.push(check(
        "panic.raii_drop_teardown",
        dead,
        format!("postgres.exe pid {pid} gone after the panic unwind"),
    ));
    checks.push(check(
        "panic.marker_cleared_by_startup_sweep",
        marker_cleared,
        format!("sweep returned {swept:?}, marker empty"),
    ));

    Ok((scenario, checks))
}

/// 4 — startup orphan sweep in a FRESH process: leave a genuine orphan
/// (`mem::forget` skips `Drop`), then invoke `supervisor --sweep-startup`, which
/// reads the persisted marker, confirms the live image is `postgres.exe`
/// (PID-reuse guard), kills the tree, and clears the marker.
async fn scenario_orphan(
    data_dir: &Path,
    install_dir: &Path,
    marker_path: &Path,
    marker: &SettingsKv,
    reaper: &mut PidReaper,
) -> Result<ScenarioOutcome> {
    let mut scenario = Scenario {
        name: "startup_orphan_sweep".to_string(),
        ..Default::default()
    };
    let mut checks = Vec::new();

    prepare_data_dir(data_dir)?;
    let mut pg = PgRuntime::new(data_dir.to_path_buf(), install_dir.to_path_buf());
    let (setup_res, _) = timed(run_bounded(harness::PG_SETUP_BOUND, "pg.setup", pg.setup())).await;
    setup_res.context("bounded pg.setup")?;
    let (start_res, start_ms) =
        timed(run_bounded(harness::PG_START_BOUND, "pg.start", pg.start())).await;
    start_res.context("bounded pg.start")?;
    scenario.start_ms = Some(start_ms);

    let pid = harness::read_postmaster_pid(data_dir).context("postmaster.pid after start")?;
    scenario.postmaster_pid = Some(pid);
    reaper.track(pid);
    marker.persist_pid(Some(pid))?;
    scenario.marker_persisted = Some(marker.persisted_pid()? == Some(pid));

    // Leak the runtime so the postmaster genuinely outlives its owner: a REAL
    // orphan, not a simulated one.
    std::mem::forget(pg);
    let orphan_alive = wait_until_alive(pid, Duration::from_secs(10)).await;
    scenario.orphan_alive_before_sweep = Some(orphan_alive);

    // Fresh-process startup sweep — the exact production recovery path.
    let exe = std::env::current_exe().context("current exe")?;
    let child = std::process::Command::new(&exe)
        .args([
            "--sweep-startup",
            "--marker",
            &marker_path.to_string_lossy(),
        ])
        .output()
        .context("spawn --sweep-startup child")?;
    let child_stdout = String::from_utf8_lossy(&child.stdout).trim().to_string();
    scenario.sweep_child_stdout = Some(child_stdout.clone());

    let dead = wait_until_dead(pid, DEATH_WAIT_BOUND).await;
    scenario.dead_after = Some(dead);

    // Re-open the marker with a fresh connection so the child's clear is
    // observed without any stale snapshot.
    let verify = SettingsKv::open(marker_path)?;
    let marker_cleared = verify.persisted_pid()?.is_none();
    scenario.marker_cleared = Some(marker_cleared);
    scenario.detail = format!(
        "pid={pid}, orphan_alive={orphan_alive}, child_exit={:?}, child_out={child_stdout:?}, \
         dead={dead}, cleared={marker_cleared}",
        child.status.code()
    );
    scenario.ok = orphan_alive && dead && marker_cleared && child.status.success();

    checks.push(check(
        "orphan.real_orphan_present_before_sweep",
        orphan_alive,
        format!("leaked runtime pid {pid} was still a live postgres.exe"),
    ));
    checks.push(check(
        "orphan.fresh_process_sweep_killed_it",
        child.status.success() && dead,
        format!("--sweep-startup exit {:?}, pid gone", child.status.code()),
    ));
    checks.push(check(
        "orphan.marker_cleared_after_sweep",
        marker_cleared,
        "marker empty after the startup sweep",
    ));

    Ok((scenario, checks))
}

// ── `--sweep-startup` mode (a fresh process's startup recovery) ──────────────

fn sweep_startup_mode(marker_path: &Path) -> Result<()> {
    let store = SettingsKv::open(marker_path)?;
    let before = store.persisted_pid()?;
    let swept = sweep_orphan(&store)?;
    let after = store.persisted_pid()?;
    println!(
        "sweep-startup: marker={before:?} swept={swept:?} marker_after={after:?} \
         image_guard={POSTGRES_IMAGE}"
    );
    Ok(())
}

// ── main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let process_start = Instant::now();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = harness::arg_value("--data-root")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-tmp"));
    let install_dir = harness::arg_value("--install-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-pg-install"));
    let marker_path = harness::arg_value("--marker")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("supervisor-marker.sqlite"));
    let out = harness::arg_value("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("results/lifecycle.json"));

    if std::env::args().any(|a| a == "--sweep-startup") {
        return sweep_startup_mode(&marker_path);
    }

    std::fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
    let marker = SettingsKv::open(&marker_path)?;
    marker.persist_pid(None)?;

    let observation = tasklist_available();
    let baseline_postgres_pids = list_postgres_pids().unwrap_or_default();

    println!("spike #2964 ST-5 — lifecycle supervisor PoC");
    println!("acquisition mode     : {}", harness::ACQUISITION_MODE);
    println!("data root            : {}", root.display());
    println!("marker (AppStore KV) : {}", marker_path.display());
    println!("process observation  : tasklist available = {observation}");

    let mut scenarios: Vec<Scenario> = Vec::new();
    let mut checks: Vec<Check> = Vec::new();
    // Last-line teardown: never leave a postmaster this run started behind,
    // even on an early error return (the `RunEvent::Exit` hook analogue).
    let mut reaper = PidReaper::default();

    let (s, c) = scenario_pid_reuse_guard(&marker)?;
    scenarios.push(s);
    checks.extend(c);

    let (s, c) = scenario_normal(
        &root.join("supervisor-normal"),
        &install_dir,
        &marker,
        &mut reaper,
    )
    .await?;
    scenarios.push(s);
    checks.extend(c);

    let (s, c) = scenario_hard_kill(
        &root.join("supervisor-hard-kill"),
        &install_dir,
        &marker,
        &mut reaper,
    )
    .await?;
    scenarios.push(s);
    checks.extend(c);

    let (s, c) = scenario_panic(
        &root.join("supervisor-panic"),
        &install_dir,
        &marker,
        &mut reaper,
    )
    .await?;
    scenarios.push(s);
    checks.extend(c);

    let (s, c) = scenario_orphan(
        &root.join("supervisor-orphan"),
        &install_dir,
        &marker_path,
        &marker,
        &mut reaper,
    )
    .await?;
    scenarios.push(s);
    checks.extend(c);

    // Final observation: no postgres.exe the PoC started may survive.
    let final_postgres_pids = list_postgres_pids().unwrap_or_default();
    let known_pids: Vec<u32> = scenarios
        .iter()
        .filter_map(|s| s.postmaster_pid)
        .collect();
    let orphan_pids: Vec<u32> = known_pids
        .iter()
        .copied()
        .filter(|pid| final_postgres_pids.contains(pid))
        .collect();

    checks.push(check(
        "process_observation_available",
        observation,
        "tasklist can observe process images (teardown evidence is observable)",
    ));
    checks.push(check(
        "no_orphan_postgres_after_exit",
        orphan_pids.is_empty(),
        format!(
            "started pids {known_pids:?}; still-live {orphan_pids:?} (final snapshot {final_postgres_pids:?})"
        ),
    ));

    let passed = checks.iter().filter(|c| c.ok).count();
    let failed = checks.len() - passed;

    let report = LifecycleReport {
        issue: 2964,
        task: "ST-5".to_string(),
        acquisition_mode: harness::ACQUISITION_MODE.to_string(),
        crate_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        profile: if cfg!(debug_assertions) { "debug" } else { "release" }.to_string(),
        process_observation_available: observation,
        bounds: Bounds {
            control_ms: harness::PG_CONTROL_TIMEOUT.as_millis(),
            setup_ms: harness::PG_SETUP_BOUND.as_millis(),
            start_ms: harness::PG_START_BOUND.as_millis(),
            stop_ms: harness::PG_STOP_BOUND.as_millis(),
            connect_ms: harness::PG_CONNECT_TIMEOUT.as_millis(),
            ready_ms: harness::PG_READY_BOUND.as_millis(),
        },
        scenarios,
        checks,
        passed,
        failed,
        baseline_postgres_pids,
        final_postgres_pids,
        orphan_pids,
        total_ms: process_start.elapsed().as_millis(),
    };

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).context("create results dir")?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)
        .with_context(|| format!("write {}", out.display()))?;

    for scenario in &report.scenarios {
        println!(
            "[{}] {} — {}",
            if scenario.ok { "ok" } else { "FAIL" },
            scenario.name,
            scenario.detail
        );
    }
    println!(
        "checks: {}/{} passed; total {:.0} ms; results written to {}",
        report.passed,
        report.passed + report.failed,
        process_start.elapsed().as_secs_f64() * 1000.0,
        out.display()
    );

    anyhow::ensure!(
        report.failed == 0,
        "{} supervisor check(s) failed — see {}",
        report.failed,
        out.display()
    );
    println!(
        "OK — bounded lifecycle, guaranteed teardown, PID-reuse-guarded orphan sweep ({} checks)",
        report.passed
    );
    Ok(())
}

// ── unit tests (pure: no PostgreSQL, no network) ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kv_pid_marker_round_trips_and_clears() {
        let store = SettingsKv::open_in_memory().expect("kv");
        assert_eq!(store.persisted_pid().expect("read"), None);
        store.persist_pid(Some(4242)).expect("persist");
        assert_eq!(store.persisted_pid().expect("read"), Some(4242));
        store.persist_pid(None).expect("clear");
        assert_eq!(store.persisted_pid().expect("read"), None);
        // A malformed marker is never parsed as a PID.
        store.set(PG_PID_KEY, "not-a-pid").expect("set garbage");
        assert_eq!(store.persisted_pid().expect("read"), None);
    }

    #[test]
    fn sweep_does_not_kill_and_clears_marker_for_non_postgres_pid() {
        let store = SettingsKv::open_in_memory().expect("kv");
        // 4,000,000 is not a running process — the safe no-kill path.
        store.persist_pid(Some(4_000_000)).expect("persist");
        assert_eq!(sweep_orphan(&store).expect("sweep"), None);
        assert_eq!(store.persisted_pid().expect("read"), None);
        // An absent marker is also a no-op.
        assert_eq!(sweep_orphan(&store).expect("sweep"), None);
    }

    #[tokio::test]
    async fn run_bounded_errors_fast_on_an_unbounded_wait() {
        let start = Instant::now();
        let result: Result<()> = run_bounded(
            Duration::from_millis(50),
            "pending",
            std::future::pending::<Result<()>>(),
        )
        .await;
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn run_bounded_passes_through_a_completed_value() {
        let result: Result<u32> = run_bounded(Duration::from_secs(1), "ok", async { Ok(7) }).await;
        assert_eq!(result.expect("ok"), 7);
    }
}
