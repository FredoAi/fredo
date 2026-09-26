//! Measurement harness (ST-2). Runs the SQLite baseline and the embedded
//! PostgreSQL variants over the identical fixed workload, samples the
//! process-tree peak working set (including the Postgres child processes),
//! two runs per variant in the SAME session, and writes
//! `results/measurements.json`.
//!
//! Exit code is 0 whenever `measurements.json` was written; a variant that
//! could not be measured is recorded in `unknown[]` with its reason and the
//! exact failing command (never an invented number).

use anyhow::{Context, Result};
use spike::{sampler, workload, RunReport};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const RUNS: u32 = 2;

fn bin_exe(name: &str) -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

fn command_output(program: &str, args: &[&str], cwd: &Path) -> String {
    match Command::new(program).args(args).current_dir(cwd).output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => "unknown".to_string(),
    }
}

/// Run one benchmark child and return (report, external_peak_bytes, command_line).
fn run_once(
    manifest: &Path,
    name: &str,
    bin: &str,
    run: u32,
    prefixes: Vec<String>,
) -> Result<(RunReport, u64, String)> {
    let data_dir = manifest.join(format!("target/spike-tmp/measure-{name}-run{run}"));
    let exe = bin_exe(bin);
    anyhow::ensure!(exe.exists(), "benchmark binary not found: {}", exe.display());
    let cmd_line = format!(
        "{} --data-dir {} --run {}",
        exe.display(),
        data_dir.display(),
        run
    );

    let mut child = Command::new(&exe)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--run")
        .arg(run.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("spawn {cmd_line}"))?;
    let child_pid = child.id();

    let stop = Arc::new(AtomicBool::new(false));
    let peak = sampler::spawn_peak_sampler_for(child_pid, Arc::clone(&stop), prefixes);

    // Bounded child (round 1 fix): the original harness blocked forever on
    // `wait_with_output()`. `postgresql_embedded` 0.21 ran `pg_ctl -w` with an
    // unbounded command timeout (see QUESTIONS.md Q2), so a hung child hung the
    // whole run (~11 h). Capture stdout on a reader thread and poll `try_wait()`
    // against a hard OS wall-clock deadline; on expiry kill the child and fail
    // the variant — the caller records it in `unknown[]`. Never block.
    const CHILD_DEADLINE: Duration = Duration::from_secs(300);
    let mut child_stdout = child.stdout.take();
    let stdout_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        if let Some(out) = child_stdout.as_mut() {
            let _ = out.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + CHILD_DEADLINE;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("poll {cmd_line}"))?
        {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            stop.store(true, Ordering::Relaxed);
            anyhow::bail!(
                "benchmark exceeded the {} s hard deadline and was killed: {cmd_line}",
                CHILD_DEADLINE.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    stop.store(true, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(60));
    let external_peak = peak.load(Ordering::Relaxed);

    anyhow::ensure!(
        status.success(),
        "benchmark failed (exit {}): {cmd_line}",
        status
    );
    let json_line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .with_context(|| format!("no JSON report on stdout from {cmd_line}"))?;
    let report: RunReport = serde_json::from_str(json_line)
        .with_context(|| format!("parse JSON report from {cmd_line}: {json_line}"))?;
    Ok((report, external_peak, cmd_line))
}

fn variant_value(name: &str, mode: &str, runs: &[RunReport], unknown: &mut Vec<serde_json::Value>) -> serde_json::Value {
    let last = &runs[runs.len() - 1];
    let peak = runs.iter().map(|r| r.peak_rss_bytes).max().unwrap_or(0);
    let cold = last.cold_start_ms;
    let mut obj = serde_json::json!({
        "name": name,
        "mode": mode,
        "binary_bytes": last.binary_bytes,
        "distribution_bytes": last.distribution_bytes,
        "cold_start_ms": cold,
        "cold_start_ms_first_run": runs[0].cold_start_ms,
        "peak_rss_bytes": peak,
        "data_dir_bytes": last.data_dir_bytes,
        "measured_at": last.measured_at,
        "notes": last.notes,
        "runs": runs,
    });
    // Any metric that came back as 0 for a reason we cannot trust is surfaced.
    if peak == 0 {
        unknown.push(serde_json::json!({
            "metric": format!("{name}.peak_rss_bytes"),
            "reason": "sampler observed no live process working set (process exited before the first 25 ms sample)",
            "command": "cargo run --release --bin measure"
        }));
        obj["peak_rss_bytes"] = serde_json::Value::Null;
    }
    obj
}

fn failed_variant(name: &str, reason: &str, command: &str, unknown: &mut Vec<serde_json::Value>) -> serde_json::Value {
    unknown.push(serde_json::json!({
        "metric": name,
        "reason": reason,
        "command": command
    }));
    serde_json::json!({
        "name": name,
        "mode": if name == "embedded-postgres" { "runtime-download" } else { "bundled-sqlite" },
        "binary_bytes": null,
        "distribution_bytes": null,
        "cold_start_ms": null,
        "peak_rss_bytes": null,
        "data_dir_bytes": null,
        "measured_at": spike::sampler::now_rfc3339(),
        "notes": format!("NOT MEASURED: {reason}"),
        "error": reason,
    })
}

fn delta(pg: &serde_json::Value, sq: &serde_json::Value, key: &str) -> serde_json::Value {
    // SQLite has no separate distribution (it is compiled into the binary), so a
    // null baseline is treated as 0 for the install-size delta.
    match pg.get(key).and_then(|v| v.as_f64()) {
        Some(a) => {
            let b = sq.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
            serde_json::json!(a - b)
        }
        None => serde_json::Value::Null,
    }
}

fn main() -> Result<()> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    std::env::set_current_dir(&manifest).ok();

    // The benchmark binaries must be built first; `cargo run --bin measure`
    // builds only `measure`. `measure.ps1` runs `cargo build --release --bins`
    // before invoking this harness (see README.md).
    for bin in ["bench-sqlite", "bench-pg"] {
        let exe = bin_exe(bin);
        anyhow::ensure!(
            exe.exists(),
            "{} not found — run `cargo build --release --bins` first",
            exe.display()
        );
    }

    let mut unknown: Vec<serde_json::Value> = Vec::new();

    // SQLite baseline.
    let mut sqlite_runs: Vec<RunReport> = Vec::new();
    let mut sqlite_failure: Option<String> = None;
    for run in 1..=RUNS {
        eprintln!("[measure] sqlite-baseline run {run}/{RUNS} ...");
        match run_once(&manifest, "sqlite-baseline", "bench-sqlite", run, vec![]) {
            Ok((mut report, external_peak, _cmd)) => {
                report.peak_rss_bytes = report.peak_rss_bytes.max(external_peak);
                sqlite_runs.push(report);
            }
            Err(err) => {
                eprintln!("[measure] sqlite-baseline run {run} FAILED: {err:#}");
                sqlite_failure = Some(format!("{err:#}"));
            }
        }
    }
    let sqlite_value = if !sqlite_runs.is_empty() {
        variant_value("sqlite-baseline", "bundled-sqlite", &sqlite_runs, &mut unknown)
    } else {
        let reason = sqlite_failure
            .clone()
            .unwrap_or_else(|| "no successful SQLite baseline run".to_string());
        let cmd = format!(
            "{} --data-dir {}/target/spike-tmp/measure-sqlite-baseline-run1 --run 1",
            bin_exe("bench-sqlite").display(),
            manifest.display()
        );
        failed_variant("sqlite-baseline", &reason, &cmd, &mut unknown)
    };

    // Embedded PostgreSQL.
    let mut pg_runs: Vec<RunReport> = Vec::new();
    let mut pg_failure: Option<String> = None;
    for run in 1..=RUNS {
        eprintln!("[measure] embedded-postgres run {run}/{RUNS} (run 1 includes first-run archive download) ...");
        match run_once(
            &manifest,
            "embedded-postgres",
            "bench-pg",
            run,
            vec!["postgres".to_string()],
        ) {
            Ok((mut report, external_peak, _cmd)) => {
                report.peak_rss_bytes = report.peak_rss_bytes.max(external_peak);
                pg_runs.push(report);
            }
            Err(err) => {
                eprintln!("[measure] embedded-postgres run {run} FAILED: {err:#}");
                pg_failure = Some(format!("{err:#}"));
            }
        }
    }
    let pg_value = if !pg_runs.is_empty() {
        variant_value("embedded-postgres", "runtime-download", &pg_runs, &mut unknown)
    } else {
        let reason = pg_failure
            .clone()
            .unwrap_or_else(|| "embedded PostgreSQL could not be set up/started in this environment".to_string());
        let cmd = format!(
            "{} --data-dir {}/target/spike-tmp/measure-embedded-postgres-run1 --run 1",
            bin_exe("bench-pg").display(),
            manifest.display()
        );
        failed_variant("embedded-postgres", &reason, &cmd, &mut unknown)
    };

    let rustc = command_output("rustc", &["--version"], &manifest);
    let commit = command_output("git", &["rev-parse", "--short", "HEAD"], &manifest);
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };

    let deltas = serde_json::json!({
        "binary_bytes": delta(&pg_value, &sqlite_value, "binary_bytes"),
        "distribution_bytes": delta(&pg_value, &sqlite_value, "distribution_bytes"),
        "cold_start_ms": delta(&pg_value, &sqlite_value, "cold_start_ms"),
        "peak_rss_bytes": delta(&pg_value, &sqlite_value, "peak_rss_bytes"),
        "data_dir_bytes": delta(&pg_value, &sqlite_value, "data_dir_bytes"),
    });

    let document = serde_json::json!({
        "environment": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "profile": profile,
            "rustc": rustc,
            "commit": commit,
            "sampler": "sysinfo process-tree peak working set (root process + descendants; PostgreSQL child processes matched by name)",
            "session": "both variants measured in the same session"
        },
        "workload": serde_json::to_value(workload::description())?,
        "variants": [sqlite_value, pg_value],
        "deltas": deltas,
        "unknown": unknown,
    });

    let results_dir = manifest.join("results");
    std::fs::create_dir_all(&results_dir)?;
    let out_path = results_dir.join("measurements.json");
    std::fs::write(&out_path, serde_json::to_string_pretty(&document)?)?;
    println!("wrote {}", out_path.display());

    if pg_runs.is_empty() {
        println!("RESULT: PARTIAL — embedded PostgreSQL could not be measured (see unknown[]).");
    } else {
        println!("RESULT: OK — both variants measured; see results/measurements.json");
    }
    Ok(())
}
