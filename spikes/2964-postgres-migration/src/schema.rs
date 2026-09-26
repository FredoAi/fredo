//! Spike #2964 ST-1 — `schema` binary: SQLite DDL → PostgreSQL DDL and
//! statement-translation validation against a **real** PostgreSQL client.
//!
//! Proves, for the RTDB `chat_rows` table (`rtdb/store.rs:310-336`) and the
//! AppStore `settings` KV (`storage/mod.rs:23-26`):
//!
//! 1. the PG DDL applies (and re-applies) cleanly;
//! 2. the produced schema maps 1:1 — types, composite PK, indexes;
//! 3. the translated statements execute: `INSERT OR REPLACE` → `ON CONFLICT DO
//!    UPDATE ... EXCLUDED`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`,
//!    `?n` → `$n`, point/range reads, `PRAGMA query_only=ON` →
//!    `START TRANSACTION READ ONLY`;
//! 4. the translated write/read path reaches the SAME final state as the SQLite
//!    source path — row count **and** SHA-256 content checksum;
//! 5. the remaining C1 mapping probes: `sqlite_master` → `to_regclass`,
//!    `pragma_table_info` → `information_schema.columns`,
//!    `AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`,
//!    `PRAGMA synchronous=NORMAL` → `synchronous_commit = off`.
//!
//! Everything runs against a throwaway embedded PostgreSQL under this crate's
//! own `target/`; it never opens `fredo.db` and never touches production.

use anyhow::{Context, Result};
use postgres_migration_spike::harness::{self, PgRuntime};
use postgres_migration_spike::schema_defs as defs;
use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Serialize)]
struct Check {
    name: String,
    ok: bool,
    detail: String,
}

impl Check {
    fn new(name: &str, ok: bool, detail: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            ok,
            detail: detail.into(),
        }
    }
}

#[derive(Serialize)]
struct Snap {
    rows: i64,
    checksum: String,
    point_read: Option<String>,
    range_count: i64,
    range_sum: i64,
}

fn snap(s: &harness::Snapshot) -> Snap {
    Snap {
        rows: s.rows,
        checksum: s.checksum.clone(),
        point_read: s.point_read.clone(),
        range_count: s.range_count,
        range_sum: s.range_sum,
    }
}

#[derive(Serialize)]
struct Environment {
    os: String,
    arch: String,
    profile: String,
    crate_version: String,
}

#[derive(Serialize)]
struct Workload {
    ops: usize,
    unique_keys: usize,
    batch: usize,
    seed: u64,
    reupsert_ratio: f64,
}

#[derive(Serialize)]
struct Summary {
    total: usize,
    passed: usize,
    failed: usize,
    ok: bool,
}

#[derive(Serialize)]
struct Timings {
    pg_upsert_ms: f64,
    sqlite_upsert_ms: f64,
}

#[derive(Serialize)]
struct Report {
    issue: u32,
    task: String,
    mode: String,
    acquisition_mode: String,
    environment: Environment,
    workload: Workload,
    checks: Vec<Check>,
    summary: Summary,
    pg: Snap,
    sqlite: Snap,
    timings: Timings,
    duration_ms: u128,
}

fn pg_settings_eq_checksum(client: &mut postgres::Client) -> Result<String> {
    let rows = client.query(
        "SELECT key, value FROM settings WHERE key LIKE 'eq.%' ORDER BY key",
        &[],
    )?;
    let encoded: Vec<String> = rows
        .iter()
        .map(|r| {
            harness::encode_row(&[
                Some(r.get::<_, String>(0)),
                Some(r.get::<_, String>(1)),
            ])
        })
        .collect();
    Ok(harness::checksum_rows(&encoded))
}

fn sqlite_settings_eq_checksum(conn: &Connection) -> Result<String> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key LIKE 'eq.%' ORDER BY key")?;
    let mut rows = stmt.query([])?;
    let mut encoded = Vec::new();
    while let Some(r) = rows.next()? {
        encoded.push(harness::encode_row(&[
            Some(r.get::<_, String>(0)?),
            Some(r.get::<_, String>(1)?),
        ]));
    }
    Ok(harness::checksum_rows(&encoded))
}

/// All PostgreSQL client + SQLite work — invoked on a blocking thread because the
/// sync `postgres` client owns its own runtime and must not be driven from async.
fn run_validation(url: &str) -> Result<(Vec<Check>, Snap, Snap, Timings)> {
    let mut checks: Vec<Check> = Vec::new();
    let mut client = harness::connect_until_ready(url)?;

    // 1) DDL applies, then re-applies (idempotent).
    let ddl_ok = client.batch_execute(defs::PG_DDL).is_ok();
    checks.push(Check::new(
        "pg_ddl_applies",
        ddl_ok,
        "CREATE TABLE + CREATE INDEX executed on PostgreSQL",
    ));
    let ddl_idem = client.batch_execute(defs::PG_DDL).is_ok();
    checks.push(Check::new(
        "pg_ddl_idempotent",
        ddl_idem,
        "re-running the translated DDL is a no-op (IF NOT EXISTS)",
    ));

    // 2) `pragma_table_info` -> `information_schema.columns`: column type mapping.
    let cols: Vec<(String, String)> = client
        .query(
            "SELECT column_name, data_type FROM information_schema.columns \
             WHERE table_schema = 'public' AND table_name = 'chat_rows' \
             ORDER BY ordinal_position",
            &[],
        )?
        .iter()
        .map(|r| (r.get::<_, String>(0), r.get::<_, String>(1)))
        .collect();
    let expected: Vec<(String, String)> = defs::PG_CHAT_COLUMNS_EXPECTED
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    checks.push(Check::new(
        "chat_rows_type_mapping",
        cols == expected,
        format!("pg={cols:?} expected={expected:?}"),
    ));

    // 3) Composite PK preserved 1:1.
    let pk: Vec<String> = client
        .query(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema = kcu.table_schema \
             WHERE tc.table_name = 'chat_rows' AND tc.constraint_type = 'PRIMARY KEY' \
             ORDER BY kcu.ordinal_position",
            &[],
        )?
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    checks.push(Check::new(
        "chat_rows_composite_pk",
        pk == ["session_id", "correlation_id"],
        format!("pk={pk:?}"),
    ));

    // 4) All three production indexes preserved 1:1.
    let idx: Vec<String> = client
        .query(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' \
             AND tablename = 'chat_rows' ORDER BY indexname",
            &[],
        )?
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    let want = ["idx_chat_started", "idx_chat_session_time", "idx_chat_updated"];
    let idx_ok = want.iter().all(|w| idx.iter().any(|i| i == w));
    checks.push(Check::new(
        "chat_rows_indexes",
        idx_ok,
        format!("pg={idx:?} required={want:?}"),
    ));

    // 5) settings KV maps 1:1 (`key` PK, both NOT NULL).
    let settings_cols: Vec<(String, String, String)> = client
        .query(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns \
             WHERE table_schema = 'public' AND table_name = 'settings' \
             ORDER BY ordinal_position",
            &[],
        )?
        .iter()
        .map(|r| {
            (
                r.get::<_, String>(0),
                r.get::<_, String>(1),
                r.get::<_, String>(2),
            )
        })
        .collect();
    let settings_expected = vec![
        ("key".to_string(), "text".to_string(), "NO".to_string()),
        ("value".to_string(), "text".to_string(), "NO".to_string()),
    ];
    checks.push(Check::new(
        "settings_kv_mapping",
        settings_cols == settings_expected,
        format!("pg={settings_cols:?} expected={settings_expected:?}"),
    ));
    let settings_pk: Vec<String> = client
        .query(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema = kcu.table_schema \
             WHERE tc.table_name = 'settings' AND tc.constraint_type = 'PRIMARY KEY' \
             ORDER BY kcu.ordinal_position",
            &[],
        )?
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    checks.push(Check::new(
        "settings_pk",
        settings_pk == ["key"],
        format!("pk={settings_pk:?}"),
    ));

    // 6) `sqlite_master` existence check -> `to_regclass`.
    let r = client.query_one(
        "SELECT to_regclass('public.chat_rows')::text, to_regclass('public.settings')::text, \
         to_regclass('public.definitely_missing_2964')::text",
        &[],
    )?;
    let a: Option<String> = r.get(0);
    let b: Option<String> = r.get(1);
    let c: Option<String> = r.get(2);
    checks.push(Check::new(
        "sqlite_master_to_regclass",
        a.is_some() && b.is_some() && c.is_none(),
        format!("chat_rows={a:?} settings={b:?} missing={c:?}"),
    ));

    // 7) `PRAGMA synchronous=NORMAL` -> `synchronous_commit = off` (explicit choice).
    client.batch_execute("SET synchronous_commit = off;")?;
    let sc: String = client
        .query_one("SHOW synchronous_commit", &[])?
        .get(0);
    checks.push(Check::new(
        "synchronous_commit_off",
        sc == "off",
        format!("synchronous_commit={sc}"),
    ));

    // 8) `AUTOINCREMENT` -> `GENERATED ALWAYS AS IDENTITY`.
    client.batch_execute(defs::IDENTITY_PROBE_DDL)?;
    client.batch_execute("TRUNCATE identity_probe RESTART IDENTITY")?;
    client.batch_execute("INSERT INTO identity_probe (label) VALUES ('a'), ('b')")?;
    let ids: Vec<i64> = client
        .query("SELECT id FROM identity_probe ORDER BY id", &[])?
        .iter()
        .map(|r| r.get::<_, i64>(0))
        .collect();
    let explicit_rejected = client
        .execute("INSERT INTO identity_probe (id, label) VALUES (99, 'c')", &[])
        .is_err();
    checks.push(Check::new(
        "autoincrement_to_identity",
        ids == [1, 2] && explicit_rejected,
        format!("ids={ids:?} explicit_id_rejected={explicit_rejected}"),
    ));

    // 9) settings upsert (`excluded.value` -> `EXCLUDED.value`).
    client.execute(defs::PG_SETTINGS_UPSERT, &[&"probe.kv", &"v1"])?;
    client.execute(defs::PG_SETTINGS_UPSERT, &[&"probe.kv", &"v2"])?;
    let kv: String = client
        .query_one("SELECT value FROM settings WHERE key = 'probe.kv'", &[])?
        .get(0);
    checks.push(Check::new(
        "settings_upsert_translation",
        kv == "v2",
        format!("value={kv} (expected v2 after re-upsert)"),
    ));

    // 10) `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING` (both engines agree).
    client.execute(defs::PG_SETTINGS_UPSERT, &[&"probe.ignore", &"keep"])?;
    client.execute(defs::PG_SETTINGS_INSERT_IGNORE, &[&"probe.ignore", &"drop"])?;
    let pg_ignore: String = client
        .query_one("SELECT value FROM settings WHERE key = 'probe.ignore'", &[])?
        .get(0);
    let sqlite_ignore_ok = {
        let c = Connection::open_in_memory()?;
        c.execute_batch(defs::SQLITE_DDL)?;
        c.execute(defs::SQLITE_SETTINGS_UPSERT, rusqlite::params!["probe.ignore", "keep"])?;
        c.execute(defs::SQLITE_SETTINGS_INSERT_IGNORE, rusqlite::params!["probe.ignore", "drop"])?;
        let got: String = c.query_row(
            "SELECT value FROM settings WHERE key = 'probe.ignore'",
            [],
            |r| r.get(0),
        )?;
        got == "keep"
    };
    checks.push(Check::new(
        "insert_or_ignore_translation",
        pg_ignore == "keep" && sqlite_ignore_ok,
        format!("pg={pg_ignore} sqlite_ok={sqlite_ignore_ok}"),
    ));

    // 11) `PRAGMA query_only=ON` -> `START TRANSACTION READ ONLY` (write rejected).
    let pg_ro = {
        client.batch_execute(defs::PG_READ_ONLY_BEGIN)?;
        let rejected = client
            .execute(defs::PG_SETTINGS_UPSERT, &[&"probe.ro", &"x"])
            .is_err();
        let _ = client.batch_execute("ROLLBACK");
        rejected
    };
    let sqlite_ro = {
        let c = Connection::open_in_memory()?;
        c.execute_batch(defs::SQLITE_DDL)?;
        c.execute_batch(defs::SQLITE_QUERY_ONLY)?;
        c.execute(defs::SQLITE_SETTINGS_UPSERT, rusqlite::params!["probe.ro", "x"])
            .is_err()
    };
    checks.push(Check::new(
        "query_only_to_read_only_tx",
        pg_ro && sqlite_ro,
        format!("pg_write_rejected={pg_ro} sqlite_write_rejected={sqlite_ro}"),
    ));

    // 12) The same workload through both engines.
    let ops: usize = harness::arg_value("--rows")
        .and_then(|v| v.parse().ok())
        .unwrap_or(2_000);
    let unique_keys = (ops * 9 / 10).max(1);
    let batch = 512usize;
    let rows = harness::generate(ops, unique_keys, 2964);

    let lite = Connection::open_in_memory()?;
    lite.execute_batch(defs::SQLITE_DDL)?;
    let t0 = Instant::now();
    harness::sqlite_apply(&lite, &rows)?;
    let sqlite_upsert_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let pg_upsert_ms = harness::pg_apply(&mut client, &rows, batch)?;

    let (key, range) = harness::final_key_and_range(&rows);
    let pg_snap = harness::pg_snapshot(&mut client, &key, range)?;
    let sq_snap = harness::sqlite_snapshot(&lite, &key, range)?;

    let distinct_keys = rows
        .iter()
        .map(|r| (r.session_id.as_str(), r.correlation_id.as_str()))
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    checks.push(Check::new(
        "row_count_match",
        pg_snap.rows == sq_snap.rows && pg_snap.rows == distinct_keys,
        format!(
            "pg={} sqlite={} distinct_keys={} ops={}",
            pg_snap.rows,
            sq_snap.rows,
            distinct_keys,
            rows.len()
        ),
    ));
    checks.push(Check::new(
        "content_checksum_match",
        pg_snap.checksum == sq_snap.checksum,
        format!("pg={} sqlite={}", pg_snap.checksum, sq_snap.checksum),
    ));
    checks.push(Check::new(
        "point_read_translation",
        pg_snap.point_read.is_some() && pg_snap.point_read == sq_snap.point_read,
        format!(
            "pg={:?} sqlite={:?}",
            pg_snap.point_read, sq_snap.point_read
        ),
    ));
    checks.push(Check::new(
        "range_read_translation",
        pg_snap.range_count == sq_snap.range_count && pg_snap.range_sum == sq_snap.range_sum,
        format!(
            "pg=({}, {}) sqlite=({}, {})",
            pg_snap.range_count, pg_snap.range_sum, sq_snap.range_count, sq_snap.range_sum
        ),
    ));

    // 13) settings equivalence across engines (same upsert + one re-upsert).
    let eq_pairs = [("eq.theme", "dark"), ("eq.accent", "purple"), ("eq.locale", "en")];
    let lite2 = Connection::open_in_memory()?;
    lite2.execute_batch(defs::SQLITE_DDL)?;
    for (k, v) in eq_pairs {
        client.execute(defs::PG_SETTINGS_UPSERT, &[&k, &v])?;
        lite2.execute(defs::SQLITE_SETTINGS_UPSERT, rusqlite::params![k, v])?;
    }
    client.execute(defs::PG_SETTINGS_UPSERT, &[&"eq.theme", &"light"])?;
    lite2.execute(defs::SQLITE_SETTINGS_UPSERT, rusqlite::params!["eq.theme", "light"])?;
    let pg_eq = pg_settings_eq_checksum(&mut client)?;
    let sq_eq = sqlite_settings_eq_checksum(&lite2)?;
    checks.push(Check::new(
        "settings_engine_equivalence",
        pg_eq == sq_eq,
        format!("pg={pg_eq} sqlite={sq_eq}"),
    ));

    Ok((
        checks,
        snap(&pg_snap),
        snap(&sq_snap),
        Timings {
            pg_upsert_ms,
            sqlite_upsert_ms,
        },
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    let process_start = Instant::now();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let data_dir = harness::arg_value("--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-tmp/schema-data"));
    let install_dir = harness::arg_value("--install-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-pg-install"));
    let out = harness::arg_value("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("results/schema-translation.json"));
    let ops: usize = harness::arg_value("--rows")
        .and_then(|v| v.parse().ok())
        .unwrap_or(2_000);

    if data_dir.exists() {
        let _ = std::fs::remove_dir_all(&data_dir);
    }
    std::fs::create_dir_all(&data_dir).context("create data dir")?;

    if let Some(pid) = harness::sweep_orphans(&data_dir) {
        println!("swept orphan postmaster pid {pid} before start");
    }

    println!("spike #2964 ST-1 — schema/DDL + statement translation validation");
    println!("acquisition mode : {}", harness::ACQUISITION_MODE);
    println!("data dir         : {}", data_dir.display());
    println!("installation dir : {}", install_dir.display());

    let mut pg = PgRuntime::new(data_dir.clone(), install_dir);
    pg.setup().await.context("embedded postgres setup")?;
    pg.start().await.context("embedded postgres start")?;
    let port = pg.port();
    let url = pg.url();
    println!("server up on 127.0.0.1:{port}");

    let validation = tokio::task::spawn_blocking({
        let url = url.clone();
        move || run_validation(&url)
    })
    .await
    .context("join validation task")?;

    // Bounded teardown on the normal path (Drop covers error/panic paths).
    pg.shutdown().await;

    let (checks, pg_snap, sqlite_snap, timings) = validation?;
    let passed = checks.iter().filter(|c| c.ok).count();
    let failed = checks.len() - passed;
    let summary = Summary {
        total: checks.len(),
        passed,
        failed,
        ok: failed == 0,
    };
    let report = Report {
        issue: 2964,
        task: "ST-1".to_string(),
        mode: "sqlite->postgresql schema + statement translation".to_string(),
        acquisition_mode: harness::ACQUISITION_MODE.to_string(),
        environment: Environment {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            profile: if cfg!(debug_assertions) { "debug" } else { "release" }.to_string(),
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        workload: Workload {
            ops,
            unique_keys: (ops * 9 / 10).max(1),
            batch: 512,
            seed: 2964,
            reupsert_ratio: 0.1,
        },
        checks,
        summary,
        pg: pg_snap,
        sqlite: sqlite_snap,
        timings,
        duration_ms: process_start.elapsed().as_millis(),
    };

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).context("create results dir")?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)
        .with_context(|| format!("write {}", out.display()))?;

    for c in &report.checks {
        println!("  [{}] {} — {}", if c.ok { "ok" } else { "FAIL" }, c.name, c.detail);
    }
    println!(
        "checks {}/{} passed; pg rows={} sqlite rows={}; checksums match={}",
        report.summary.passed,
        report.summary.total,
        report.pg.rows,
        report.sqlite.rows,
        report.pg.checksum == report.sqlite.checksum
    );
    println!("results written to {}", out.display());
    println!(
        "OK — schema/statement translation validated (total {:.0} ms, bounded teardown)",
        process_start.elapsed().as_secs_f64() * 1000.0
    );

    anyhow::ensure!(
        report.summary.ok,
        "{} translation check(s) failed; see {}",
        report.summary.failed,
        out.display()
    );
    Ok(())
}
