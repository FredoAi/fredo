//! Spike #2964 ST-1 — `bench` binary: executes the **translated** statements
//! (`chat_rows` batch upsert, PK point read, `started_at_ns` range read) against
//! a real embedded PostgreSQL and records timings.
//!
//! This is the execution proof for the C1 statement-translation rule; the
//! SQLite↔PG *equivalence* proof lives in the `schema` binary.

use anyhow::{Context, Result};
use postgres_migration_spike::harness::{self, PgRuntime};
use postgres_migration_spike::schema_defs as defs;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

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
    point_reads: usize,
}

#[derive(Serialize)]
struct Metrics {
    upsert_ms: f64,
    point_read_ms: f64,
    range_read_ms: f64,
    rows_final: i64,
    distinct_keys: i64,
    point_read_mismatches: usize,
    range_count: i64,
    range_sum: i64,
}

#[derive(Serialize)]
struct BenchReport {
    issue: u32,
    task: String,
    mode: String,
    acquisition_mode: String,
    environment: Environment,
    workload: Workload,
    metrics: Metrics,
    content_checksum: String,
    duration_ms: u128,
}

fn run_bench(url: &str, ops: usize, unique_keys: usize, batch: usize) -> Result<(Metrics, String)> {
    let mut client = harness::connect_until_ready(url)?;
    client
        .batch_execute(defs::PG_DDL)
        .context("create translated schema")?;
    client
        .batch_execute("TRUNCATE chat_rows")
        .context("truncate chat_rows for a clean run")?;

    let rows = harness::generate(ops, unique_keys, 2964);
    let distinct_keys = rows
        .iter()
        .map(|r| (r.session_id.as_str(), r.correlation_id.as_str()))
        .collect::<HashSet<_>>()
        .len() as i64;

    let upsert_ms = harness::pg_apply(&mut client, &rows, batch)?;

    // 1000 PK point reads over the final write of each distinct key.
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut keys: Vec<(String, String, String)> = Vec::new();
    for r in rows.iter().rev() {
        if seen.insert((r.session_id.clone(), r.correlation_id.clone())) {
            keys.push((r.session_id.clone(), r.correlation_id.clone(), r.raw_json.clone()));
            if keys.len() >= 1_000 {
                break;
            }
        }
    }
    let point_read_ms = {
        let t0 = Instant::now();
        let mut mismatches = 0usize;
        for (s, c, raw) in &keys {
            let got = client
                .query_one(defs::PG_POINT_READ, &[&s, &c])
                .context("point read")?;
            let got: String = got.get(0);
            if &got != raw {
                mismatches += 1;
            }
        }
        anyhow::ensure!(mismatches == 0, "point-read mismatches: {mismatches}");
        t0.elapsed().as_secs_f64() * 1000.0
    };

    let (key, range) = harness::final_key_and_range(&rows);
    let range_read_ms = {
        let t0 = Instant::now();
        let row = client
            .query_one(defs::PG_RANGE_READ, &[&range.0, &range.1])
            .context("range read")?;
        let _: i64 = row.get(0);
        let _: i64 = row.get(1);
        t0.elapsed().as_secs_f64() * 1000.0
    };

    let snap = harness::pg_snapshot(&mut client, &key, range)?;
    let mismatches = 0usize;
    Ok((
        Metrics {
            upsert_ms,
            point_read_ms,
            range_read_ms,
            rows_final: snap.rows,
            distinct_keys,
            point_read_mismatches: mismatches,
            range_count: snap.range_count,
            range_sum: snap.range_sum,
        },
        snap.checksum,
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    let process_start = Instant::now();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let data_dir = harness::arg_value("--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-tmp/bench-data"));
    let install_dir = harness::arg_value("--install-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-pg-install"));
    let out = harness::arg_value("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("results/bench.json"));
    let ops: usize = harness::arg_value("--rows")
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let batch = 512usize;
    let unique_keys = (ops as f64 * 0.9) as usize;

    if data_dir.exists() {
        let _ = std::fs::remove_dir_all(&data_dir);
    }
    std::fs::create_dir_all(&data_dir).context("create data dir")?;
    if let Some(pid) = harness::sweep_orphans(&data_dir) {
        println!("swept orphan postmaster pid {pid} before start");
    }

    println!("spike #2964 ST-1 — translated-statement bench (chat_rows)");
    println!("acquisition mode : {}", harness::ACQUISITION_MODE);
    println!("data dir         : {}", data_dir.display());

    let mut pg = PgRuntime::new(data_dir.clone(), install_dir);
    pg.setup().await.context("embedded postgres setup")?;
    pg.start().await.context("embedded postgres start")?;
    let port = pg.port();
    let url = pg.url();
    println!("server up on 127.0.0.1:{port}");

    let bench = tokio::task::spawn_blocking({
        let url = url.clone();
        move || run_bench(&url, ops, unique_keys, batch)
    })
    .await
    .context("join bench task")?;

    pg.shutdown().await;

    let (metrics, checksum) = bench?;
    let report = BenchReport {
        issue: 2964,
        task: "ST-1".to_string(),
        mode: "translated statements on embedded postgres".to_string(),
        acquisition_mode: harness::ACQUISITION_MODE.to_string(),
        environment: Environment {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            profile: if cfg!(debug_assertions) { "debug" } else { "release" }.to_string(),
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        workload: Workload {
            ops,
            unique_keys,
            batch,
            seed: 2964,
            point_reads: 1_000,
        },
        metrics,
        content_checksum: checksum,
        duration_ms: process_start.elapsed().as_millis(),
    };

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).context("create results dir")?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)
        .with_context(|| format!("write {}", out.display()))?;

    println!(
        "upsert {:.1} ms ({} ops); point read {:.1} ms (1000 reads); range read {:.1} ms",
        report.metrics.upsert_ms,
        report.workload.ops,
        report.metrics.point_read_ms,
        report.metrics.range_read_ms
    );
    println!(
        "rows_final={} (distinct keys {} of {} key space); point-read mismatches={}",
        report.metrics.rows_final,
        report.metrics.distinct_keys,
        report.workload.unique_keys,
        report.metrics.point_read_mismatches
    );
    println!("results written to {}", out.display());
    println!(
        "OK — translated statements executed against embedded PostgreSQL (total {:.0} ms, bounded teardown)",
        process_start.elapsed().as_secs_f64() * 1000.0
    );

    anyhow::ensure!(
        report.metrics.rows_final == report.metrics.distinct_keys,
        "final row count {} != observed distinct keys {}",
        report.metrics.rows_final,
        report.metrics.distinct_keys
    );
    anyhow::ensure!(
        report.metrics.point_read_mismatches == 0,
        "point-read mismatches: {}",
        report.metrics.point_read_mismatches
    );
    Ok(())
}
