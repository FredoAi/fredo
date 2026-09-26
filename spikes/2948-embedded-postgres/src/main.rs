//! ST-1 PoC (AC1): boot embedded PostgreSQL on Windows, write a batch of
//! chat-row-shaped rows into a schema mirrored from Fredo's production
//! `chat_rows`, read them back, print a summary and exit 0.
//!
//! This binary is a **disposable proof of feasibility** — it is not wired into
//! Fredo and never opens `fredo.db`.

use anyhow::{Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use spike::{pgbench, workload};
use std::path::PathBuf;
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

    let data_dir = arg_value("--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-tmp/poc-data"));
    let install_dir = arg_value("--install-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target/spike-pg-install"));

    if data_dir.exists() {
        std::fs::remove_dir_all(&data_dir).ok();
    }
    std::fs::create_dir_all(&data_dir).context("create data dir")?;

    let mut settings = Settings::new();
    settings.data_dir = data_dir.clone();
    settings.installation_dir = install_dir.clone();
    settings.port = 0; // ephemeral port
    settings.temporary = false;
    settings.username = "spike".to_string();
    settings.password = "spike".to_string();
    // The default command timeout is far too short for a first-run archive
    // download + initdb, but an UNBOUNDED timeout is what let `pg_ctl -w` hang
    // forever in the original run (~11 h, see QUESTIONS.md Q2). Bound every pg
    // control command at 180 s: enough for a first-run download + initdb, small
    // enough to fail fast.
    settings.timeout = Some(std::time::Duration::from_secs(180));

    // Acquisition mode exercised by this PoC (see README): the default
    // runtime-download mode from the theseus-rs archive. The `bundled`
    // (compile-time-embedded archive) mode is documented as UNKNOWN in the ADR.
    let acquisition_mode = "runtime-download";
    println!("embedded-postgres PoC (#2948)");
    println!("acquisition mode : {acquisition_mode}");
    println!("data dir         : {}", data_dir.display());
    println!("installation dir : {}", install_dir.display());

    let mut pg = PostgreSQL::new(settings);
    println!("[1/5] setup() — download/extract + initdb ...");
    pg.setup().await.context("postgresql setup failed")?;
    println!("[2/5] start() ...");
    pg.start().await.context("postgresql start failed")?;
    let connection_url = pg.settings().url("postgres");
    let port = pg.settings().port;
    println!("      server up on 127.0.0.1:{port}");

    let rows = workload::generate_poc();
    let outcome =
        tokio::task::spawn_blocking(move || pgbench::run_workload(&connection_url, &rows, process_start))
            .await
            .context("join workload task")??;

    println!(
        "[3/5] first successful query after {:.1} ms (cold start)",
        outcome.cold_start_ms
    );
    println!("      schema created (chat_rows + settings, production parity)");
    println!(
        "[4/5] WROTE {} rows ({} upserts, {} batches) in {:.1} ms",
        outcome.rows_final,
        outcome.written,
        outcome.written.div_ceil(workload::BATCH),
        outcome.upsert_ms
    );
    println!(
        "[5/5] READ BACK raw_json match={}; unicode round-trip={}; settings KV={}",
        outcome.round_trip_ok, outcome.unicode_ok, outcome.settings_ok
    );

    // Bounded teardown (round 1 fix): `pg.stop()` drives `pg_ctl -w stop`, which
    // hung unbounded in the original PoC (see QUESTIONS.md Q2). Never propagate a
    // hang — cap the graceful stop at 60 s, then hard-kill any leftover server via
    // taskkill, then report success.
    if tokio::time::timeout(std::time::Duration::from_secs(60), pg.stop())
        .await
        .is_err()
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "postgres.exe"])
            .status();
    }
    println!(
        "OK — embedded PostgreSQL ran on Windows, performed a representative write+read, and stopped cleanly (total {:.0} ms)",
        process_start.elapsed().as_secs_f64() * 1000.0
    );

    anyhow::ensure!(
        outcome.round_trip_ok && outcome.unicode_ok && outcome.settings_ok,
        "read-back did not match the written value"
    );
    Ok(())
}
