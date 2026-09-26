//! Embedded PostgreSQL benchmark (`theseus-rs/postgresql-embedded`, default
//! runtime-download acquisition). Runs the fixed workload from `workload.rs`
//! against the representative schema and prints one `RunReport` JSON line.
//!
//! Invoked by `measure` (and usable standalone for reproduction).

use anyhow::{Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use spike::{pgbench, sampler, workload, RunReport};
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

#[tokio::main]
async fn main() -> Result<()> {
    let process_start = Instant::now();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let run: u32 = arg_value("--run").and_then(|v| v.parse().ok()).unwrap_or(1);
    let data_dir = arg_value("--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join(format!("target/spike-tmp/bench-pg-run{run}")));
    let install_dir = arg_value("--install-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-pg-install"));
    let keep_data_dir = std::env::args().any(|a| a == "--keep-data-dir");
    let data_dir_reused = data_dir.exists() && keep_data_dir;
    if data_dir.exists() && !keep_data_dir {
        std::fs::remove_dir_all(&data_dir).ok();
    }
    std::fs::create_dir_all(&data_dir).context("create pg data dir")?;

    // Start the sampler before setup so the whole lifecycle is covered.
    let stop = Arc::new(AtomicBool::new(false));
    let peak = sampler::spawn_peak_sampler(Arc::clone(&stop), vec!["postgres".to_string()]);

    let mut settings = Settings::new();
    settings.data_dir = data_dir.clone();
    settings.installation_dir = install_dir.clone();
    settings.port = 0; // ephemeral port
    settings.temporary = false;
    settings.username = "spike".to_string();
    settings.password = "spike".to_string();
    // Bounded (round 1 fix): an unbounded command timeout is what let `pg_ctl -w`
    // hang forever; 180 s covers a first-run download + initdb and fails fast.
    settings.timeout = Some(std::time::Duration::from_secs(180));

    let mut pg = PostgreSQL::new(settings);
    pg.setup()
        .await
        .context("embedded postgres setup failed")?;
    pg.start()
        .await
        .context("embedded postgres start failed")?;
    let connection_url = pg.settings().url("postgres");

    let rows = workload::generate();
    let outcome =
        tokio::task::spawn_blocking(move || pgbench::run_workload(&connection_url, &rows, process_start))
            .await
            .context("join workload task")??;

    // Bounded teardown (round 1 fix): `pg.stop()` drives `pg_ctl -w stop`, which
    // hung unbounded in the original run (see QUESTIONS.md Q2). Cap at 60 s, then
    // hard-kill any leftover server so the benchmark can never hang.
    if tokio::time::timeout(std::time::Duration::from_secs(60), pg.stop())
        .await
        .is_err()
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "postgres.exe"])
            .status();
    }

    stop.store(true, Ordering::Relaxed);
    std::thread::sleep(std::time::Duration::from_millis(60));
    let peak_rss_bytes = peak.load(Ordering::Relaxed);

    let data_dir_bytes = sampler::dir_size(&data_dir);
    let distribution_bytes = sampler::dir_size(&install_dir);
    let binary_bytes = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    let report = RunReport {
        name: "embedded-postgres".to_string(),
        mode: "runtime-download".to_string(),
        run,
        binary_bytes,
        distribution_bytes: Some(distribution_bytes),
        cold_start_ms: outcome.cold_start_ms,
        peak_rss_bytes,
        data_dir_bytes,
        upsert_ms: outcome.upsert_ms,
        point_read_ms: outcome.point_read_ms,
        range_read_ms: outcome.range_read_ms,
        rows_final: outcome.rows_final,
        measured_at: sampler::now_rfc3339(),
        notes: format!(
            "postgresql_embedded 0.21 runtime-download; ephemeral port; fresh data dir; data_dir_reused={data_dir_reused}; {} upsert ops; {} final rows; distribution_bytes = installed postgres dir",
            outcome.written, outcome.rows_final
        ),
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
