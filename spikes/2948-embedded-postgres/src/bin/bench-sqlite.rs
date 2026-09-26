//! SQLite baseline benchmark. Runs the fixed workload from `workload.rs`
//! against `rusqlite` (the same crate/version Fredo uses: 0.32, `bundled`) and
//! prints one `RunReport` JSON line on stdout.
//!
//! Invoked by `measure` (and usable standalone for reproduction).

use anyhow::{Context, Result};
use rusqlite::params;
use spike::{sampler, schema, workload, RunReport};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

fn arg_value(flag: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() -> Result<()> {
    let process_start = Instant::now();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let run: u32 = arg_value("--run").and_then(|v| v.parse().ok()).unwrap_or(1);
    let data_dir = arg_value("--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join(format!("target/spike-tmp/bench-sqlite-run{run}")));
    if data_dir.exists() {
        std::fs::remove_dir_all(&data_dir).ok();
    }
    std::fs::create_dir_all(&data_dir).context("create sqlite data dir")?;
    let db_path = data_dir.join("fredo-spike.db");

    let stop = Arc::new(AtomicBool::new(false));
    let peak = sampler::spawn_peak_sampler(Arc::clone(&stop), vec![]);

    let conn = rusqlite::Connection::open(&db_path).context("open sqlite db")?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch(schema::SQLITE_DDL)
        .context("create sqlite schema")?;
    let _first: i64 = conn
        .query_row("SELECT count(*) FROM chat_rows", [], |r| r.get(0))
        .context("first query")?;
    let cold_start_ms = process_start.elapsed().as_secs_f64() * 1000.0;

    let rows = workload::generate();
    let lo = rows.iter().map(|r| r.started_at_ns).min().unwrap_or(0);
    let hi = rows.iter().map(|r| r.started_at_ns).max().unwrap_or(0) + 1;

    // Batch upsert: one transaction per 512 rows (mirrors RTDB chunking).
    let mut written = 0usize;
    let upsert_ms = {
        let t0 = Instant::now();
        let mut stmt = conn.prepare(schema::SQLITE_UPSERT)?;
        for chunk in rows.chunks(workload::BATCH) {
            let tx = conn.unchecked_transaction()?;
            for row in chunk {
                stmt.execute(params![
                    &row.session_id,
                    &row.correlation_id,
                    row.seq,
                    row.started_at_ns,
                    &row.ended_at_ns,
                    &row.updated_at,
                    &row.state,
                    &row.user_message,
                    &row.agent_reply,
                    &row.prompt_tokens,
                    &row.completion_tokens,
                    &row.cache_read_tokens,
                    &row.cost_usd,
                    &row.model,
                    &row.parent_session_id,
                    &row.composited_child_session_id,
                    &row.raw_json,
                    &row.provider,
                ])?;
                written += 1;
            }
            tx.commit()?;
        }
        t0.elapsed().as_secs_f64() * 1000.0
    };

    // Point reads: 1000 keys, compared against the FINAL write for each key
    // (10% of ops are re-upserts of earlier keys).
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut check_rows: Vec<&workload::Row> = Vec::new();
    for row in rows.iter().rev() {
        if seen.insert((row.session_id.clone(), row.correlation_id.clone())) {
            check_rows.push(row);
        }
        if check_rows.len() >= 1000 {
            break;
        }
    }
    let point_read_ms = {
        let t0 = Instant::now();
        let mut stmt = conn.prepare(schema::SQLITE_POINT_READ)?;
        let mut mismatches = 0usize;
        for row in &check_rows {
            let got: String =
                stmt.query_row(params![&row.session_id, &row.correlation_id], |r| r.get(0))?;
            if got != row.raw_json {
                mismatches += 1;
            }
        }
        anyhow::ensure!(mismatches == 0, "point-read mismatches: {mismatches}");
        t0.elapsed().as_secs_f64() * 1000.0
    };

    // Range read by started_at_ns.
    let range_read_ms = {
        let t0 = Instant::now();
        let mut stmt = conn.prepare(schema::SQLITE_RANGE_READ)?;
        let (_count, _sum): (i64, i64) = stmt.query_row(params![lo, hi], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        t0.elapsed().as_secs_f64() * 1000.0
    };

    let rows_final: i64 = conn.query_row("SELECT count(*) FROM chat_rows", [], |r| r.get(0))?;
    drop(conn);

    stop.store(true, Ordering::Relaxed);
    std::thread::sleep(std::time::Duration::from_millis(60));
    let peak_rss_bytes = peak.load(Ordering::Relaxed);

    let data_dir_bytes = {
        let mut total = sampler::dir_size(&data_dir);
        // Advance the disk accounting to include the WAL sidecar if present.
        total += std::fs::metadata(db_path.with_extension("db-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        total
    };

    let binary_bytes = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    let report = RunReport {
        name: "sqlite-baseline".to_string(),
        mode: "bundled-sqlite".to_string(),
        run,
        binary_bytes,
        distribution_bytes: None,
        cold_start_ms,
        peak_rss_bytes,
        data_dir_bytes,
        upsert_ms,
        point_read_ms,
        range_read_ms,
        rows_final,
        measured_at: sampler::now_rfc3339(),
        notes: format!(
            "rusqlite 0.32 bundled; WAL + synchronous=NORMAL (production parity); {written} upsert ops; {rows_final} final rows"
        ),
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
