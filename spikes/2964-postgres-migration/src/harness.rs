//! Shared PoC harness for spike #2964 (ST-1) — **bounded** embedded-PostgreSQL
//! lifecycle + deterministic workload + engine-independent row checksum.
//!
//! Reused by every ST-1 binary, and by later tasks via
//! `use postgres_migration_spike::harness;` (no Cargo.toml/lib.rs edit needed).
//!
//! # Runtime bound (G-263/G-264 — the #2948 ~11 h `pg.stop()` hang)
//!
//! * `Settings::timeout` bounds every `pg_ctl`-driven control command.
//! * Every blocking wait (`pg.setup`, `pg.start`, `pg.stop`, client connect,
//!   server readiness) carries an explicit wall-clock cap.
//! * Teardown is guaranteed on every path: `shutdown()` performs a bounded
//!   graceful stop with a hard-kill fallback, and `Drop` hard-kills the
//!   postmaster PID tree on a panic / early return.
//! * A **PID-reuse-guarded orphan sweep** (`sweep_orphans`) runs before start.

use crate::schema_defs;
use anyhow::{Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Wall-clock bound for every `pg_ctl`-driven control command (download / initdb /
/// start / stop) — never left unset (the #2948 hang).
pub const PG_CONTROL_TIMEOUT: Duration = Duration::from_secs(180);
/// Wall-clock bound around `pg.setup()` (first run may download the ~164 MB archive).
pub const PG_SETUP_BOUND: Duration = Duration::from_secs(600);
/// Wall-clock bound around `pg.start()`.
pub const PG_START_BOUND: Duration = Duration::from_secs(180);
/// Wall-clock bound around `pg.stop()` (the measured ~11 h hang).
pub const PG_STOP_BOUND: Duration = Duration::from_secs(30);
/// TCP connect timeout for the PG client.
pub const PG_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Readiness poll bound (server up → first successful connect).
pub const PG_READY_BOUND: Duration = Duration::from_secs(60);

/// Acquisition mode exercised by this PoC (mirrors #2948): the crate's default
/// `runtime-download`. `bundled` is unresolved (see the master design doc).
pub const ACQUISITION_MODE: &str = "runtime-download";

/// Minimal deterministic PRNG (xorshift64*) — no external crate, reproducible
/// workloads across runs/machines.
pub struct Xorshift64(u64);

impl Xorshift64 {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next_u64() % n
        }
    }
}

/// A `chat_rows`-shaped row — the same 18 fields in the same order as the
/// production `ChatRow` / DDL.
#[derive(Clone, Debug)]
pub struct ChatRow {
    pub session_id: String,
    pub correlation_id: String,
    pub seq: i64,
    pub started_at_ns: Option<i64>,
    pub ended_at_ns: Option<i64>,
    pub updated_at: String,
    pub state: String,
    pub user_message: Option<String>,
    pub agent_reply: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub model: Option<String>,
    pub parent_session_id: Option<String>,
    pub composited_child_session_id: Option<String>,
    pub raw_json: String,
    pub provider: String,
}

/// Deterministic workload: `ops` upserts over `unique_keys` distinct keys
/// (~10 % re-upserts when `ops = 1.1 * unique_keys`), mirroring #2948.
/// `raw_json` carries a non-ASCII payload to prove TEXT round-trips.
pub fn generate(ops: usize, unique_keys: usize, seed: u64) -> Vec<ChatRow> {
    let unique_keys = unique_keys.max(1);
    let mut rng = Xorshift64::new(seed);
    let mut seq: HashMap<u64, i64> = HashMap::new();
    let base_ns: i64 = 1_700_000_000_000_000_000;
    let mut out = Vec::with_capacity(ops);
    for i in 0..ops {
        let key = rng.below(unique_keys as u64);
        let s = seq.entry(key).or_insert(0);
        *s += 1;
        let started = base_ns + (key as i64) * 1_000_000;
        let state = match rng.below(3) {
            0 => "open",
            1 => "running",
            _ => "closed",
        };
        out.push(ChatRow {
            session_id: format!("s{:03}", key % 64),
            correlation_id: format!("c{key:06}"),
            seq: *s,
            started_at_ns: Some(started),
            ended_at_ns: Some(started + 5_000_000),
            updated_at: format!("2026-01-01T00:00:{:02}Z", key % 60),
            state: state.to_string(),
            user_message: if rng.below(6) == 0 {
                None
            } else {
                Some(format!("prompt {i} — héllo ✅ 漢字"))
            },
            agent_reply: if rng.below(7) == 0 {
                None
            } else {
                Some(format!("reply {i}"))
            },
            prompt_tokens: Some(rng.below(4096) as i64),
            completion_tokens: Some(rng.below(4096) as i64),
            cache_read_tokens: Some(rng.below(1024) as i64),
            cost_usd: Some((rng.below(100_000) as f64) / 1_000_000.0),
            model: if rng.below(4) == 0 {
                None
            } else {
                Some(format!("model-{}", rng.below(5)))
            },
            parent_session_id: if rng.below(5) == 0 {
                Some(format!("p{key:06}"))
            } else {
                None
            },
            composited_child_session_id: if rng.below(7) == 0 {
                Some(format!("child-{key:06}"))
            } else {
                None
            },
            raw_json: format!(
                "{{\"key\":{key},\"i\":{i},\"seq\":{},\"note\":\"héllo ✅ 漢字\"}}",
                *s
            ),
            provider: "opencode".to_string(),
        });
    }
    out
}

/// `(loaded rows, sha256 checksum)`, plus the translated point/range read results.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub rows: i64,
    pub checksum: String,
    pub point_read: Option<String>,
    pub range_count: i64,
    pub range_sum: i64,
}

/// Engine-independent canonical row encoding. NULL is a single `N`; a value is
/// `V` + its normalized string. Columns are joined with U+001F, rows with U+001E
/// (see `checksum_rows`). Integers render decimal, REALs render `{:.6}` so the
/// SQLite (`REAL`) and PG (`DOUBLE PRECISION`) legs produce the identical digest.
pub fn encode_row(cols: &[Option<String>]) -> String {
    let mut s = String::new();
    for (i, c) in cols.iter().enumerate() {
        if i > 0 {
            s.push('\u{1f}');
        }
        match c {
            Some(v) => {
                s.push('V');
                s.push_str(v);
            }
            None => s.push('N'),
        }
    }
    s
}

pub fn checksum_rows(rows: &[String]) -> String {
    let mut h = Sha256::new();
    for r in rows {
        h.update(r.as_bytes());
        h.update([0x1e]);
    }
    format!("{:x}", h.finalize())
}

pub fn now_epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Minimal `--flag value` parser (no clap needed for a throwaway PoC).
pub fn arg_value(flag: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

// ── embedded-PostgreSQL lifecycle ────────────────────────────────────────────

/// Owns the embedded server. Constructed before `setup`, dropped last.
pub struct PgRuntime {
    pg: PostgreSQL,
    data_dir: PathBuf,
    stopped: bool,
}

impl PgRuntime {
    pub fn new(data_dir: PathBuf, install_dir: PathBuf) -> Self {
        let mut settings = Settings::new();
        settings.data_dir = data_dir.clone();
        settings.installation_dir = install_dir;
        settings.port = 0; // ephemeral loopback (never 0.0.0.0, no fixed-port collision)
        settings.temporary = false;
        settings.password = "spike".to_string();
        // NOTE (empirically verified on Windows, 2026-09-26): leave
        // `settings.username` at the crate default ("postgres"). In
        // `postgresql_embedded` 0.21, `settings.username` is used to build the
        // `url()` but `initdb` still creates the `postgres` superuser — setting
        // `username = "spike"` therefore yields a URL whose user does not exist
        // ("password authentication failed for user spike"). The password DOES
        // come from `settings.password`; with the default username,
        // `url("postgres")` connects. Carried as a migration finding.
        // Finite bound on EVERY pg_ctl control command. Leaving this `None` is
        // exactly what let `pg_ctl -w stop` wait ~11 h in #2948.
        settings.timeout = Some(PG_CONTROL_TIMEOUT);
        Self {
            pg: PostgreSQL::new(settings),
            data_dir,
            stopped: false,
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn url(&self) -> String {
        self.pg.settings().url("postgres")
    }

    /// The actual bound loopback port (ephemeral).
    pub fn port(&self) -> u16 {
        self.pg.settings().port
    }



    /// Bounded `setup()` (download/extract + initdb on first run).
    pub async fn setup(&mut self) -> Result<()> {
        tokio::time::timeout(PG_SETUP_BOUND, self.pg.setup())
            .await
            .context("pg.setup() exceeded its wall-clock bound")?
            .context("pg.setup() failed")
    }

    /// Bounded `start()`.
    pub async fn start(&mut self) -> Result<()> {
        tokio::time::timeout(PG_START_BOUND, self.pg.start())
            .await
            .context("pg.start() exceeded its wall-clock bound")?
            .context("pg.start() failed")
    }

    /// Bounded graceful stop with a guaranteed hard-kill fallback.
    ///
    /// A watchdog thread hard-kills the postmaster PID tree if the graceful stop
    /// has not completed within [`PG_STOP_BOUND`] (defence against a `pg.stop()`
    /// that blocks synchronously and would defeat `tokio::time::timeout`). After
    /// the attempt, a surviving `postmaster.pid` triggers a final PID-tree kill.
    pub async fn shutdown(&mut self) {
        if self.stopped {
            return;
        }
        let pid = read_postmaster_pid(&self.data_dir);
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if done_rx.recv_timeout(PG_STOP_BOUND).is_err() {
                if let Some(p) = pid {
                    kill_pid_tree(p);
                }
            }
        });
        let _ = tokio::time::timeout(PG_STOP_BOUND, self.pg.stop()).await;
        let _ = done_tx.send(());
        let _ = watchdog.join();
        // No orphan survives: if the postmaster PID file is still there, kill the tree.
        if let Some(pid) = read_postmaster_pid(&self.data_dir) {
            kill_pid_tree(pid);
        }
        self.stopped = true;
    }
}

impl Drop for PgRuntime {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        // Panic / early-return path: no async calls allowed here — hard-kill the
        // postmaster PID tree directly so no orphan survives.
        if let Some(pid) = read_postmaster_pid(&self.data_dir) {
            kill_pid_tree(pid);
        }
    }
}

/// Reads the postmaster PID from `<data_dir>/postmaster.pid` (first line).
pub fn read_postmaster_pid(data_dir: &Path) -> Option<u32> {
    let contents = std::fs::read_to_string(data_dir.join("postmaster.pid")).ok()?;
    contents.lines().next()?.trim().parse::<u32>().ok()
}

/// PID-reuse guard: true only if the live process image for `pid` is `postgres.exe`.
pub fn is_postgres_image(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .to_ascii_lowercase()
            .contains("postgres.exe"),
        Err(_) => false,
    }
}

/// Hard-kills a process and its children (`taskkill /T /F`).
pub fn kill_pid_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

/// Startup orphan sweep: kill a leftover postmaster only when its live image is
/// `postgres.exe` (never an unrelated PID). Returns the killed PID.
pub fn sweep_orphans(data_dir: &Path) -> Option<u32> {
    let pid = read_postmaster_pid(data_dir)?;
    if is_postgres_image(pid) {
        kill_pid_tree(pid);
        Some(pid)
    } else {
        None
    }
}

// ── PG client (sync — must only be driven from a blocking context) ───────────

/// Bounded connect with session statement timeouts.
pub fn connect_bounded(url: &str) -> Result<postgres::Client> {
    let mut cfg: postgres::Config = url.parse().context("parse postgres url")?;
    cfg.connect_timeout(PG_CONNECT_TIMEOUT);
    cfg.application_name("postgres-migration-spike-2964");
    let mut client = cfg
        .connect(postgres::NoTls)
        .context("connect to embedded postgres")?;
    client
        .batch_execute(
            "SET statement_timeout = '120s'; SET idle_in_transaction_session_timeout = '120s';",
        )
        .context("set session timeouts")?;
    Ok(client)
}

/// Polls [`connect_bounded`] until the server is ready or [`PG_READY_BOUND`] elapses.
pub fn connect_until_ready(url: &str) -> Result<postgres::Client> {
    let deadline = std::time::Instant::now() + PG_READY_BOUND;
    loop {
        match connect_bounded(url) {
            Ok(c) => return Ok(c),
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(e).context("postgres not ready within bound");
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

// ── engine snapshots (identical column read + canonical encoding) ────────────

fn pg_chat_checksum(client: &mut postgres::Client) -> Result<(i64, String)> {
    let sql = format!(
        "SELECT {} FROM chat_rows ORDER BY session_id, correlation_id",
        schema_defs::CHAT_COLUMNS
    );
    let rows = client.query(sql.as_str(), &[]).context("select chat_rows")?;
    let mut encoded = Vec::with_capacity(rows.len());
    for row in &rows {
        let cols: Vec<Option<String>> = vec![
            row.get::<_, Option<String>>(0),
            row.get::<_, Option<String>>(1),
            row.get::<_, Option<i64>>(2).map(|v| v.to_string()),
            row.get::<_, Option<i64>>(3).map(|v| v.to_string()),
            row.get::<_, Option<i64>>(4).map(|v| v.to_string()),
            row.get::<_, Option<String>>(5),
            row.get::<_, Option<String>>(6),
            row.get::<_, Option<String>>(7),
            row.get::<_, Option<String>>(8),
            row.get::<_, Option<i64>>(9).map(|v| v.to_string()),
            row.get::<_, Option<i64>>(10).map(|v| v.to_string()),
            row.get::<_, Option<i64>>(11).map(|v| v.to_string()),
            row.get::<_, Option<f64>>(12).map(|v| format!("{v:.6}")),
            row.get::<_, Option<String>>(13),
            row.get::<_, Option<String>>(14),
            row.get::<_, Option<String>>(15),
            row.get::<_, Option<String>>(16),
            row.get::<_, Option<String>>(17),
        ];
        encoded.push(encode_row(&cols));
    }
    Ok((rows.len() as i64, checksum_rows(&encoded)))
}

fn sqlite_chat_checksum(conn: &rusqlite::Connection) -> Result<(i64, String)> {
    let sql = format!(
        "SELECT {} FROM chat_rows ORDER BY session_id, correlation_id",
        schema_defs::CHAT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut encoded = Vec::new();
    while let Some(row) = rows.next()? {
        let cols: Vec<Option<String>> = vec![
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?.map(|v| v.to_string()),
            row.get::<_, Option<i64>>(3)?.map(|v| v.to_string()),
            row.get::<_, Option<i64>>(4)?.map(|v| v.to_string()),
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<i64>>(9)?.map(|v| v.to_string()),
            row.get::<_, Option<i64>>(10)?.map(|v| v.to_string()),
            row.get::<_, Option<i64>>(11)?.map(|v| v.to_string()),
            row.get::<_, Option<f64>>(12)?.map(|v| format!("{v:.6}")),
            row.get::<_, Option<String>>(13)?,
            row.get::<_, Option<String>>(14)?,
            row.get::<_, Option<String>>(15)?,
            row.get::<_, Option<String>>(16)?,
            row.get::<_, Option<String>>(17)?,
        ];
        encoded.push(encode_row(&cols));
    }
    Ok((encoded.len() as i64, checksum_rows(&encoded)))
}

/// PG snapshot via the **translated** statements, including the point/range reads.
pub fn pg_snapshot(
    client: &mut postgres::Client,
    point_key: &(String, String),
    range: (i64, i64),
) -> Result<Snapshot> {
    let (rows, checksum) = pg_chat_checksum(client)?;
    let point_read: Option<String> = client
        .query_opt(
            schema_defs::PG_POINT_READ,
            &[&point_key.0, &point_key.1],
        )
        .context("pg point read")?
        .map(|r| r.get(0));
    let rr = client
        .query_one(schema_defs::PG_RANGE_READ, &[&range.0, &range.1])
        .context("pg range read")?;
    Ok(Snapshot {
        rows,
        checksum,
        point_read,
        range_count: rr.get(0),
        range_sum: rr.get(1),
    })
}

/// SQLite snapshot via the **source** statements, same encoding as [`pg_snapshot`].
pub fn sqlite_snapshot(
    conn: &rusqlite::Connection,
    point_key: &(String, String),
    range: (i64, i64),
) -> Result<Snapshot> {
    let (rows, checksum) = sqlite_chat_checksum(conn)?;
    let point_read: Option<String> = conn
        .query_row(
            schema_defs::SQLITE_POINT_READ,
            rusqlite::params![point_key.0, point_key.1],
            |r| r.get(0),
        )
        .ok();
    let (range_count, range_sum): (i64, i64) = conn.query_row(
        schema_defs::SQLITE_RANGE_READ,
        rusqlite::params![range.0, range.1],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Snapshot {
        rows,
        checksum,
        point_read,
        range_count,
        range_sum,
    })
}

/// The point key whose **final** write wins, plus the `[lo, hi)` window covering
/// every generated `started_at_ns`, derived identically for both engines.
pub fn final_key_and_range(rows: &[ChatRow]) -> ((String, String), (i64, i64)) {
    let last = rows.last().expect("non-empty workload");
    let lo = rows
        .iter()
        .filter_map(|r| r.started_at_ns)
        .min()
        .unwrap_or(0);
    let hi = rows
        .iter()
        .filter_map(|r| r.started_at_ns)
        .max()
        .unwrap_or(0)
        + 1;
    ((last.session_id.clone(), last.correlation_id.clone()), (lo, hi))
}

/// Upserts `rows` into SQLite in one transaction using the production SQL.
pub fn sqlite_apply(conn: &rusqlite::Connection, rows: &[ChatRow]) -> Result<()> {
    conn.execute_batch("BEGIN TRANSACTION;")?;
    {
        let mut stmt = conn.prepare(schema_defs::SQLITE_UPSERT_CHAT)?;
        for r in rows {
            stmt.execute(rusqlite::params![
                r.session_id,
                r.correlation_id,
                r.seq,
                r.started_at_ns,
                r.ended_at_ns,
                r.updated_at,
                r.state,
                r.user_message,
                r.agent_reply,
                r.prompt_tokens,
                r.completion_tokens,
                r.cache_read_tokens,
                r.cost_usd,
                r.model,
                r.parent_session_id,
                r.composited_child_session_id,
                r.raw_json,
                r.provider
            ])?;
        }
    }
    conn.execute_batch("COMMIT;")?;
    Ok(())
}

/// Upserts `rows` into PG in `batch`-sized transactions using the translated SQL.
pub fn pg_apply(client: &mut postgres::Client, rows: &[ChatRow], batch: usize) -> Result<f64> {
    let t0 = std::time::Instant::now();
    let stmt = client.prepare(schema_defs::PG_UPSERT_CHAT)?;
    for chunk in rows.chunks(batch.max(1)) {
        let mut tx = client.transaction()?;
        for r in chunk {
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
            tx.execute(&stmt, &params)?;
        }
        tx.commit()?;
    }
    Ok(t0.elapsed().as_secs_f64() * 1000.0)
}

/// Upserts a single row into PG via the translated statement.
pub fn pg_upsert_one(client: &mut postgres::Client, r: &ChatRow) -> Result<()> {
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
    client
        .execute(schema_defs::PG_UPSERT_CHAT, &params)
        .context("pg single upsert")?;
    Ok(())
}
