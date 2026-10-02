//! Bounded control of the managed embedded-PostgreSQL server (Spec #2974, ST-1).
//!
//! This is the guaranteed-teardown primitive: every control/start/readiness/stop
//! wait carries a finite wall-clock cap, the graceful stop falls back to
//! `taskkill /PID <pid> /T /F` on expiry, and the RAII [`Drop`] hard-kills a
//! surviving postmaster on the normal, error, and panic-unwind paths.
//!
//! # G-263 SAFETY (named failure mode: #2948's ~11 h `pg.stop()`)
//!
//! * `Settings::timeout` is ALWAYS `Some(PG_CONTROL_TIMEOUT)` — never `None`.
//! * EVERY blocking await routes through [`run_bounded`]; there is no bare
//!   `.await` on a server wait.
//! * [`PgRuntime::stop_bounded`] runs a synchronous watchdog thread that
//!   hard-kills the postmaster PID tree if the graceful `pg.stop()` has not
//!   signalled within the bound, then re-checks `postmaster.pid` as a backstop.
//! * [`Drop`] hard-kills the postmaster tree unless the runtime was stopped.
//!
//! The mechanism is ported from spike #2964 (`harness.rs` / `supervisor.rs`) —
//! it is NOT a dependency on the spike crate (no cross-crate reference).

use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use sqlx::Connection as _;

use super::{
    PG_CONNECT_TIMEOUT, PG_CONTROL_TIMEOUT, PG_READY_BOUND, PG_SETUP_BOUND, PG_START_BOUND,
};

/// Marker line that makes the [`PgRuntime::apply_server_knobs`] overlay
/// idempotent (never appended twice).
const PG_KNOB_MARKER: &str = "# fredo server-memory knobs (Spec #2975)";

/// **Q-17 log-destination mechanism (Spec #2978 S4, REQ-3.2).** The crate
/// (`postgresql_embedded` 0.21) owns the postmaster spawn, so Fredo cannot apply
/// `CREATE_NO_WINDOW`/stdout redirection at the spawn boundary (the
/// `features/llm_server/process.rs` pattern). The crate DOES expose its server
/// configuration surface — [`Settings::configuration`] ("Server configuration
/// options", a `HashMap<String, String>`) — so the postmaster's own
/// `logging_collector` is pointed at `<data_dir>/log/postgres.log`, the exact
/// path [`crate::features::pg_supervisor::state::pg_server_log_tail`] reads.
///
/// `log_directory = 'log'` is resolved by PostgreSQL relative to the data
/// directory, so the collector writes `<data_dir>/log/postgres.log`. Rotation is
/// disabled (`log_rotation_age`/`log_rotation_size = 0`) so the filename is
/// stable and the tail never races a renamed file.
pub const PG_LOG_COLLECTOR_CONFIG: &[(&str, &str)] = &[
    ("logging_collector", "on"),
    ("log_directory", "log"),
    ("log_filename", "postgres.log"),
    ("log_rotation_age", "0"),
    ("log_rotation_size", "0"),
    ("log_truncate_on_rotation", "off"),
];

/// **Documented deviation (Q-17, AC3.1 — no console flash).** The crate 0.21
/// `Settings` surface (verified against the crate's public rustdoc at
/// implementation time: fields `data_dir`, `installation_dir`, `host`, `port`,
/// `username`, `password`, `temporary`, `timeout`, `configuration`,
/// `trust_installation_dir`, `socket_dir`, `releases_url`, `version`) exposes a
/// server-configuration hook but NO process-creation-flag hook. Therefore the
/// console window of the crate-spawned postmaster CANNOT be suppressed from
/// Fredo code today, and on a Windows GUI launch a brief console flash remains
/// possible. This is the plan's named deviation branch (AC3.1 is the gate that
/// forces resolution — a crate hook or a wrapper — before ship); it is recorded
/// here rather than silently shipped. The log-destination half (AC3.2) IS
/// implemented via [`PG_LOG_COLLECTOR_CONFIG`], and the server's own logging
/// collector captures the postmaster output regardless of the console.
pub const PG_CONSOLE_FLASH_DEVIATION: &str =
    "postgresql_embedded 0.21 exposes no spawn creation-flag hook; the crate-spawned \
     postmaster console cannot be suppressed from Fredo code (Q-17/AC3.1 documented deviation)";

/// Kill primitive seam used by the teardown paths; defaults to [`kill_pid_tree`].
/// Injectable in tests so teardown can be proven without spawning a server.
pub type KillTreeFn = fn(u32);

/// Graceful-stop primitive seam (**FS-2**), mirroring [`KillTreeFn`]: it takes
/// the crate handle and returns the graceful-stop future. Defaults to
/// [`pg_stop_with_env_hook`]; injectable so the expiry → hard-kill branch of
/// [`PgRuntime::stop_bounded`] is provable WITHOUT a real server.
pub type StopFn =
    for<'a> fn(&'a mut PostgreSQL) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;

/// Default graceful stop: honour the **FS-3** [`super::PG_STOP_HANG_ENV`] hook
/// (sleep the requested, capped duration) then call the real
/// `PostgreSQL::stop()`. With the env unset the hook is a no-op, so behaviour is
/// byte-identical to the pre-seam path.
fn pg_stop_with_env_hook(
    pg: &mut PostgreSQL,
) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
    Box::pin(async move {
        if let Some(hang) = super::stop_hang_duration() {
            tokio::time::sleep(hang).await;
        }
        pg.stop().await?;
        Ok(())
    })
}

/// Hard-kill a process and its children (`taskkill /PID <pid> /T /F` on Windows;
/// a no-op on other platforms, which this Windows-first slice does not support).
pub fn kill_pid_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::process::{Command, Stdio};
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
    }
}

/// Bound a future to `bound` wall-clock time, mapping expiry to a structured
/// error. EVERY blocking wait in this module goes through here (G-263); a bare
/// `.await` on a server wait is a defect.
pub async fn run_bounded<T, F>(bound: Duration, what: &'static str, fut: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    match tokio::time::timeout(bound, fut).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("{what} exceeded its {bound:?} wall-clock bound")),
    }
}

/// Bounded poll of a synchronous predicate, sleeping `poll` between tests.
/// Returns `true` on the first success, `false` once `bound` elapses.
pub async fn wait_until<F: Fn() -> bool>(pred: F, bound: Duration, poll: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        if pred() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(poll).await;
    }
}

/// How a bounded stop finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// The graceful `pg.stop()` completed within the bound.
    Graceful { elapsed_ms: u128 },
    /// The graceful stop expired and the PID tree was hard-killed.
    HardKilled { elapsed_ms: u128 },
}

/// Read the postmaster PID from `<data_dir>/postmaster.pid` (first line).
pub fn read_postmaster_pid(data_dir: &Path) -> Option<u32> {
    let contents = std::fs::read_to_string(data_dir.join("postmaster.pid")).ok()?;
    contents.lines().next()?.trim().parse::<u32>().ok()
}

/// Owns the embedded server. Constructed before `setup`, dropped last.
pub struct PgRuntime {
    pg: PostgreSQL,
    data_dir: PathBuf,
    stopped: bool,
    kill: KillTreeFn,
    stop: StopFn,
}

impl PgRuntime {
    /// Build a runtime rooted at `app_data_dir` (data dir `<app>/postgres`, or
    /// the **FS-1** [`super::PG_DATA_DIR_ENV`] override when set; install dir
    /// `<app>/postgres-install`) using the production kill primitive.
    pub fn new(app_data_dir: &Path, password: String) -> Self {
        Self::with_kill(app_data_dir, password, kill_pid_tree)
    }

    /// Build a runtime with an injected kill primitive (test seam). The data dir
    /// honours the FS-1 override; the install dir resolves through the shared
    /// [`super::resolve_install_dir`] rule, so the **G-275** `FREDO_PG_INSTALL_DIR`
    /// override (Spec #2978 S2) can never make the extraction dir and the archive
    /// staging dir diverge.
    pub fn with_kill(app_data_dir: &Path, password: String, kill: KillTreeFn) -> Self {
        Self::with_dirs(
            &super::resolve_data_dir(app_data_dir),
            &super::resolve_install_dir(app_data_dir),
            password,
            kill,
            pg_stop_with_env_hook,
        )
    }

    /// Full constructor with explicit data/install dirs and BOTH injectable seams
    /// (**FS-1**/**FS-2**). Private: [`Self::new`]/[`Self::with_kill`] are the
    /// production and retained seams; the unit tests reach it as a child module.
    fn with_dirs(
        data_dir: &Path,
        install_dir: &Path,
        password: String,
        kill: KillTreeFn,
        stop: StopFn,
    ) -> Self {
        let data_dir = data_dir.to_path_buf();
        let mut settings = Settings::new();
        settings.data_dir = data_dir.clone();
        settings.installation_dir = install_dir.to_path_buf();
        // Ephemeral loopback: `port = 0` requests an OS-assigned port, so no
        // fixed-port collision is possible with OTLP 4317/4318 or the MCP 9223.
        settings.port = 0;
        settings.temporary = false;
        settings.password = password;
        // G-263: a finite bound on EVERY `pg_ctl` control command. Leaving this
        // `None` is exactly what let `pg_ctl -w stop` wait ~11 h in #2948.
        settings.timeout = Some(PG_CONTROL_TIMEOUT);
        // Q-17 (S4): point the crate-spawned postmaster's logging collector at
        // `<data_dir>/log/postgres.log` through the crate's server-configuration
        // hook. This is the surface `pg_server_log_tail` reads (REQ-3.2).
        for &(key, value) in PG_LOG_COLLECTOR_CONFIG {
            settings
                .configuration
                .insert(key.to_string(), value.to_string());
        }
        // Q-17: surface the documented console-flash deviation on the live boot
        // path (the crate exposes no creation-flag hook), so it is recorded in
        // the app log rather than silently shipped (AC3.1 gate).
        tracing::warn!(
            target: "fredo::pg_supervisor",
            deviation = PG_CONSOLE_FLASH_DEVIATION,
            "embedded-PostgreSQL Q-17 deviation recorded"
        );
        // NOTE: `settings.username` is intentionally left at the crate default
        // ("postgres") — see the spike's empirically verified finding: the field
        // only builds `url()`, while `initdb` still creates the `postgres`
        // superuser, so overriding it yields a URL whose user does not exist.
        Self {
            pg: PostgreSQL::new(settings),
            data_dir,
            stopped: false,
            kill,
            stop,
        }
    }

    /// The resolved PostgreSQL data directory.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The connection URL the readiness probe (and later slices' pools) must use
    /// — authoritative because the bound ephemeral port lives in these settings.
    pub fn connection_url(&self) -> String {
        self.pg.settings().url("postgres")
    }

    /// The port the server is bound to; `0` before `start()` requests an
    /// ephemeral OS-assigned port, after which the crate resolves it here.
    pub fn port(&self) -> u16 {
        self.pg.settings().port
    }

    /// The postmaster PID read from `postmaster.pid`, or `None` if absent.
    pub fn postmaster_pid(&self) -> Option<u32> {
        read_postmaster_pid(&self.data_dir)
    }

    /// Bounded `setup()` (download/extract + initdb on first run).
    pub async fn setup(&mut self) -> Result<()> {
        let pg = &mut self.pg;
        run_bounded(PG_SETUP_BOUND, "pg.setup", async move {
            pg.setup().await?;
            Ok::<(), anyhow::Error>(())
        })
        .await
    }

    /// Append the [`super::PG_SERVER_KNOBS`] to `<data_dir>/postgresql.conf`
    /// (REQ-5/EARS-5.1). Called after `setup()` (which creates the file via
    /// `initdb`) and before `start()`.
    ///
    /// Idempotent: a marker line guards the append, so a second call — or a
    /// restart over an existing data dir — is a no-op. PostgreSQL applies later
    /// settings last, so the overlay wins over the `initdb` defaults; the live
    /// values are verified with `SHOW` by ST-7/QA. If a future crate version
    /// rewrote `postgresql.conf` in `start()`, that live `SHOW` check would catch
    /// it and the crate `Settings` hook is the fallback (plan risk row).
    ///
    /// **FS-5** (Spec #2975 ST-7, AC5): when [`super::PG_SKIP_SERVER_KNOBS_ENV`]
    /// is set, this is a no-op, so the managed server starts UNTUNED — the
    /// live-drivable "before" leg. Inert when unset (default byte-identical).
    pub fn apply_server_knobs(&self) -> Result<()> {
        if super::skip_server_knobs() {
            return Ok(());
        }
        let path = self.data_dir.join("postgresql.conf");
        let existing = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        if existing.contains(PG_KNOB_MARKER) {
            return Ok(());
        }
        let mut block = String::new();
        block.push('\n');
        block.push_str(PG_KNOB_MARKER);
        block.push('\n');
        for (name, value) in super::PG_SERVER_KNOBS {
            block.push_str(name);
            block.push_str(" = ");
            block.push_str(value);
            block.push('\n');
        }
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .with_context(|| format!("opening {} for append", path.display()))?
            .write_all(block.as_bytes())
            .with_context(|| format!("appending server-memory knobs to {}", path.display()))?;
        Ok(())
    }

    /// Bounded `start()`; returns the postmaster PID once it has been written.
    pub async fn start(&mut self) -> Result<u32> {
        let pg = &mut self.pg;
        run_bounded(PG_START_BOUND, "pg.start", async move {
            pg.start().await?;
            Ok::<(), anyhow::Error>(())
        })
        .await?;
        self.postmaster_pid()
            .context("postmaster.pid is missing after a successful pg.start()")
    }

    /// Bounded readiness probe: a real `sqlx` client connect on the crate URL,
    /// each attempt capped by `PG_CONNECT_TIMEOUT`, the whole poll wrapped in
    /// `run_bounded(PG_READY_BOUND + 2 s)`. This proves the exact URL/credentials
    /// later slices' pools will use — deliberately not the crate's `is_ready`.
    pub async fn probe_ready(&self) -> Result<()> {
        let url = self.connection_url();
        run_bounded(
            PG_READY_BOUND + Duration::from_secs(2),
            "readiness poll",
            async move {
                let deadline = Instant::now() + PG_READY_BOUND;
                loop {
                    let error = match tokio::time::timeout(
                        PG_CONNECT_TIMEOUT,
                        sqlx::PgConnection::connect(&url),
                    )
                    .await
                    {
                        Ok(Ok(connection)) => {
                            drop(connection);
                            return Ok(());
                        }
                        Ok(Err(error)) => anyhow::Error::from(error),
                        Err(_) => {
                            anyhow!("connect attempt exceeded its {PG_CONNECT_TIMEOUT:?} bound")
                        }
                    };
                    if Instant::now() >= deadline {
                        return Err(error);
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            },
        )
        .await
    }

    /// Bounded graceful stop with a guaranteed hard-kill fallback (G-263).
    ///
    /// A synchronous watchdog thread hard-kills the postmaster PID tree if the
    /// graceful stop has not signalled within `bound` — defence against a
    /// `pg.stop()` that blocks the async task and would otherwise defeat
    /// `tokio::time::timeout`. A surviving `postmaster.pid` after the attempt is
    /// a final backstop hard-kill. `stopped` is set on every path.
    pub async fn stop_bounded(&mut self, bound: Duration) -> StopOutcome {
        if self.stopped {
            return StopOutcome::Graceful { elapsed_ms: 0 };
        }
        let started = Instant::now();
        let pid = self.postmaster_pid();
        let kill = self.kill;
        let hard_killed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&hard_killed);
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if done_rx.recv_timeout(bound).is_err() {
                if let Some(pid) = pid {
                    kill(pid);
                    flag.store(true, Ordering::SeqCst);
                }
            }
        });

        // FS-2: the graceful attempt goes through the injectable `StopFn` so a
        // hung stop can be induced deterministically (unit) and live (FS-3),
        // while the synchronous watchdog above still hard-kills on expiry.
        let stop = self.stop;
        let pg = &mut self.pg;
        let _ = run_bounded(bound, "pg.stop", async {
            stop(pg).await?;
            Ok::<(), anyhow::Error>(())
        })
        .await;

        let _ = done_tx.send(());
        let _ = watchdog.join();

        // Backstop: a still-present `postmaster.pid` means a postmaster survived
        // the graceful attempt — hard-kill its tree so no orphan is left behind.
        if let Some(pid) = self.postmaster_pid() {
            kill(pid);
            hard_killed.store(true, Ordering::SeqCst);
        }

        self.stopped = true;
        let elapsed_ms = started.elapsed().as_millis();
        if hard_killed.load(Ordering::SeqCst) {
            StopOutcome::HardKilled { elapsed_ms }
        } else {
            StopOutcome::Graceful { elapsed_ms }
        }
    }
}

impl Drop for PgRuntime {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        // Panic / early-return path: no async work is allowed here — hard-kill
        // the postmaster PID tree directly so no orphan survives.
        if let Some(pid) = self.postmaster_pid() {
            (self.kill)(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::pg_supervisor::{
        skip_server_knobs, PG_DATA_SUBDIR, PG_SERVER_KNOBS, PG_SKIP_SERVER_KNOBS_ENV,
    };
    use std::sync::Mutex;

    static KILLS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
    static KILL_LOCK: Mutex<()> = Mutex::new(());
    /// Serializes every test that sets the **FS-5** knob-skip env var (a
    /// process-global) against the tests that call `apply_server_knobs`, so the
    /// overlay assertions are deterministic under any suite order (G-222).
    static KNOB_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Restores the FS-5 lever to unset on drop (even on a panic).
    struct KnobEnvGuard;

    impl Drop for KnobEnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(PG_SKIP_SERVER_KNOBS_ENV);
        }
    }

    fn record_kill(pid: u32) {
        KILLS.lock().expect("kill recorder").push(pid);
    }

    fn recorded_kills() -> Vec<u32> {
        KILLS.lock().expect("kill recorder").clone()
    }

    /// A graceful-stop seam that never completes — the exact #2948 hang, made
    /// deterministic for the bounded-watchdog test (the hang is bounded by
    /// `run_bounded` + the synchronous watchdog, never awaited unbounded).
    fn hang_stop(_pg: &mut PostgreSQL) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(std::future::pending::<Result<()>>())
    }

    /// Build a runtime with the recording kill seam and a seeded
    /// `postmaster.pid`, so teardown paths are observable without a server.
    fn seeded_runtime(app_data_dir: &Path, pid: u32) -> PgRuntime {
        let data_dir = app_data_dir.join(PG_DATA_SUBDIR);
        std::fs::create_dir_all(&data_dir).expect("create data dir");
        std::fs::write(data_dir.join("postmaster.pid"), format!("{pid}\n")).expect("write pid");
        PgRuntime::with_kill(app_data_dir, "test-password".to_string(), record_kill)
    }

    #[tokio::test]
    async fn run_bounded_errors_fast_on_an_unbounded_wait() {
        let started = Instant::now();
        let result: Result<()> = run_bounded(
            Duration::from_millis(50),
            "pending",
            std::future::pending::<Result<()>>(),
        )
        .await;
        assert!(
            result.is_err(),
            "a never-completing future must be bounded into an error"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the 50 ms bound must fire well under 5 s"
        );
    }

    #[tokio::test]
    async fn run_bounded_passes_through_a_completed_value() {
        let result: Result<u32> = run_bounded(Duration::from_secs(1), "ok", async { Ok(7) }).await;
        assert_eq!(result.expect("completed value passes through"), 7);
    }

    #[tokio::test]
    async fn control_timeout_is_some_and_port_is_requested_ephemeral() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = PgRuntime::new(dir.path(), "pw".to_string());
        assert_eq!(
            runtime.port(),
            0,
            "port 0 must request an OS-assigned ephemeral port"
        );
        assert_eq!(
            runtime.pg.settings().timeout,
            Some(PG_CONTROL_TIMEOUT),
            "Settings::timeout must never be None (the #2948 stop hang)"
        );
        let expected = dir.path().join(PG_DATA_SUBDIR);
        assert_eq!(runtime.data_dir(), expected.as_path());
    }

    /// S4 / REQ-3.2 (Q-17): the crate settings point the postmaster's logging
    /// collector at `<data_dir>/log/postgres.log` — the path the read-only tail
    /// reads — and the console-flash deviation is recorded (the crate exposes no
    /// creation-flag hook).
    #[test]
    fn settings_route_the_postmaster_log_to_the_data_dir_log_path() {
        // Explicit dirs (not the FS-1 resolver) so the assertion is independent
        // of any sibling test's process-global env state (G-222).
        let dir = tempfile::tempdir().expect("tempdir");
        let data_dir = dir.path().join("pgdata-log");
        let install_dir = dir.path().join("pginstall");
        std::fs::create_dir_all(&data_dir).expect("create data dir");

        let runtime = PgRuntime::with_dirs(
            &data_dir,
            &install_dir,
            "test-password".to_string(),
            record_kill,
            hang_stop,
        );

        let configuration = &runtime.pg.settings().configuration;
        for &(key, value) in PG_LOG_COLLECTOR_CONFIG {
            assert_eq!(
                configuration.get(key).map(String::as_str),
                Some(value),
                "server configuration must set {key} = {value}"
            );
        }
        // The path rule the tail reads and the config writes must agree.
        assert_eq!(
            crate::features::pg_supervisor::pg_log_path(runtime.data_dir()),
            data_dir.join("log").join("postgres.log")
        );
        assert!(
            !PG_CONSOLE_FLASH_DEVIATION.is_empty(),
            "the Q-17 console-flash deviation must be recorded"
        );
    }

    #[tokio::test]
    async fn drop_hard_kills_the_postmaster_tree_on_panic_unwind() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        KILLS.lock().expect("kill recorder").clear();
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data_dir = dir.path().to_path_buf();

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _runtime = seeded_runtime(&app_data_dir, 4242);
            panic!("induced panic: RAII Drop must still run during unwind");
        }));

        assert!(outcome.is_err(), "the induced panic must unwind");
        assert_eq!(recorded_kills(), vec![4242]);
    }

    #[tokio::test]
    async fn teardown_runs_on_an_error_return() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        KILLS.lock().expect("kill recorder").clear();
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data_dir = dir.path().to_path_buf();

        fn work(app_data_dir: &Path) -> Result<()> {
            let _runtime = seeded_runtime(app_data_dir, 5150);
            // Return early with an error before any bounded stop — `Drop` must
            // still tear the postmaster down.
            anyhow::bail!("induced error before stop")
        }

        assert!(work(&app_data_dir).is_err());
        assert_eq!(recorded_kills(), vec![5150]);
    }

    #[tokio::test]
    async fn drop_does_not_kill_after_a_bounded_stop() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        KILLS.lock().expect("kill recorder").clear();
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data_dir = dir.path().to_path_buf();
        let mut runtime = seeded_runtime(&app_data_dir, 6060);
        runtime.stopped = true;
        drop(runtime);
        assert!(
            recorded_kills().is_empty(),
            "an already-stopped runtime must not be killed again"
        );
    }

    /// FS-2 / F-4: a graceful stop that never completes must be bounded and
    /// hard-killed — exactly the AC2 expiry → hard-kill branch, no real server.
    #[tokio::test]
    async fn stop_bounded_hard_kills_when_graceful_stop_hangs() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        KILLS.lock().expect("kill recorder").clear();
        let dir = tempfile::tempdir().expect("tempdir");
        let data_dir = dir.path().join("pgdata");
        let install_dir = dir.path().join("pginstall");
        std::fs::create_dir_all(&data_dir).expect("create data dir");
        std::fs::write(data_dir.join("postmaster.pid"), "7373\n").expect("write pid");

        let mut runtime = PgRuntime::with_dirs(
            &data_dir,
            &install_dir,
            "test-password".to_string(),
            record_kill,
            hang_stop,
        );

        let started = Instant::now();
        let outcome = runtime.stop_bounded(Duration::from_millis(50)).await;
        let elapsed = started.elapsed();

        assert!(
            matches!(outcome, StopOutcome::HardKilled { .. }),
            "a hung graceful stop must fall back to HardKilled, got {outcome:?}"
        );
        assert!(
            recorded_kills().contains(&7373),
            "the watchdog/backstop must hard-kill the seeded postmaster PID, saw {:?}",
            recorded_kills()
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "the 50 ms bound must fire well under 5 s, took {elapsed:?}"
        );
    }

    /// A graceful-stop seam that completes immediately (the normal path).
    fn noop_stop(_pg: &mut PostgreSQL) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }

    /// ST-6 / REQ-6/EARS-6.1 (G-263): the NORMAL exit path is graceful, bounded,
    /// and does not hard-kill — `stop_bounded` returns `Graceful` within its
    /// bound when no postmaster survives the graceful stop. Together with the
    /// hang/panic/error tests this closes the teardown-on-every-exit-path set.
    #[tokio::test]
    async fn stop_bounded_reports_graceful_within_bound_when_no_postmaster_survives() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        KILLS.lock().expect("kill recorder").clear();
        let dir = tempfile::tempdir().expect("tempdir");
        let data_dir = dir.path().join("pgdata-empty");
        let install_dir = dir.path().join("pginstall");
        std::fs::create_dir_all(&data_dir).expect("create data dir");

        let mut runtime = PgRuntime::with_dirs(
            &data_dir,
            &install_dir,
            "test-password".to_string(),
            record_kill,
            noop_stop,
        );

        let started = Instant::now();
        let outcome = runtime.stop_bounded(Duration::from_millis(200)).await;

        assert!(
            matches!(outcome, StopOutcome::Graceful { .. }),
            "a completed graceful stop with no surviving postmaster must be Graceful, got {outcome:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the 200 ms bound must fire well under 5 s, took {:?}",
            started.elapsed()
        );
        assert!(
            recorded_kills().is_empty(),
            "the graceful path must not hard-kill anything, saw {:?}",
            recorded_kills()
        );
    }

    /// ST-2 / REQ-5/EARS-5.1: the overlay is appended exactly once and carries
    /// every declared server-memory knob.
    #[test]
    fn apply_server_knobs_appends_the_overlay_once() {
        let _env_lock = KNOB_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::remove_var(PG_SKIP_SERVER_KNOBS_ENV);
        let dir = tempfile::tempdir().expect("tempdir");
        let data_dir = dir.path().join("pgdata");
        let install_dir = dir.path().join("pginstall");
        std::fs::create_dir_all(&data_dir).expect("create data dir");
        let conf = data_dir.join("postgresql.conf");
        std::fs::write(&conf, "# initdb defaults\n").expect("seed postgresql.conf");

        let runtime = PgRuntime::with_dirs(
            &data_dir,
            &install_dir,
            "test-password".to_string(),
            record_kill,
            hang_stop,
        );
        runtime.apply_server_knobs().expect("append the overlay");

        let first = std::fs::read_to_string(&conf).expect("read conf");
        for (name, value) in PG_SERVER_KNOBS {
            assert!(
                first.contains(&format!("{name} = {value}")),
                "missing knob {name} = {value} in:\n{first}"
            );
        }

        // Idempotent: a second call must not append a duplicate overlay.
        runtime.apply_server_knobs().expect("second call is a no-op");
        let second = std::fs::read_to_string(&conf).expect("read conf");
        assert_eq!(first, second, "the overlay must be appended exactly once");
    }

    /// ST-2: a missing `postgresql.conf` is a clean error (bounded, no panic) —
    /// `apply_server_knobs` must never take the app down.
    #[test]
    fn apply_server_knobs_errors_when_postgresql_conf_is_absent() {
        let _env_lock = KNOB_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::remove_var(PG_SKIP_SERVER_KNOBS_ENV);
        let dir = tempfile::tempdir().expect("tempdir");
        let data_dir = dir.path().join("pgdata-no-conf");
        let install_dir = dir.path().join("pginstall");
        std::fs::create_dir_all(&data_dir).expect("create data dir");

        let runtime = PgRuntime::with_dirs(
            &data_dir,
            &install_dir,
            "test-password".to_string(),
            record_kill,
            hang_stop,
        );
        assert!(runtime.apply_server_knobs().is_err());
    }

    /// ST-7 / FS-5 (AC5): the untuned-baseline lever. With the lever set,
    /// `apply_server_knobs` is a clean no-op (`postgresql.conf` untouched); with
    /// it unset, the overlay is appended exactly as before — so the AC5 "before"
    /// (untuned) leg is live-drivable and the default is byte-identical.
    #[test]
    fn skip_server_knobs_lever_leaves_the_overlay_untuned_and_is_inert_when_unset() {
        let _env_lock = KNOB_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::remove_var(PG_SKIP_SERVER_KNOBS_ENV);
        assert!(
            !skip_server_knobs(),
            "an unset lever must resolve to the tuned default"
        );

        let dir = tempfile::tempdir().expect("tempdir");
        let data_dir = dir.path().join("pgdata-untuned");
        let install_dir = dir.path().join("pginstall");
        std::fs::create_dir_all(&data_dir).expect("create data dir");
        let conf = data_dir.join("postgresql.conf");
        let initdb_defaults = "# initdb defaults\n";
        std::fs::write(&conf, initdb_defaults).expect("seed postgresql.conf");

        let runtime = PgRuntime::with_dirs(
            &data_dir,
            &install_dir,
            "test-password".to_string(),
            record_kill,
            hang_stop,
        );

        // Lever set: the server is left on the initdb defaults (the "before" leg).
        std::env::set_var(PG_SKIP_SERVER_KNOBS_ENV, "1");
        let _guard = KnobEnvGuard;
        assert!(skip_server_knobs(), "the lever must read as set");
        runtime
            .apply_server_knobs()
            .expect("a lever-set apply is a clean no-op");
        let untuned = std::fs::read_to_string(&conf).expect("read conf");
        assert_eq!(
            untuned, initdb_defaults,
            "the lever must leave postgresql.conf byte-identical"
        );
        assert!(
            !untuned.contains(PG_KNOB_MARKER),
            "no knob marker may be written while the lever is set"
        );

        // Lever cleared: the default tuned overlay returns (byte-identical path).
        std::env::remove_var(PG_SKIP_SERVER_KNOBS_ENV);
        assert!(!skip_server_knobs(), "clearing the lever restores tuned");
        runtime
            .apply_server_knobs()
            .expect("the default path appends the overlay");
        let tuned = std::fs::read_to_string(&conf).expect("read conf");
        assert!(
            tuned.contains(PG_KNOB_MARKER),
            "with the lever unset the overlay must be appended again"
        );
        for (name, value) in PG_SERVER_KNOBS {
            assert!(
                tuned.contains(&format!("{name} = {value}")),
                "missing knob {name} = {value} in:\n{tuned}"
            );
        }
    }
}
