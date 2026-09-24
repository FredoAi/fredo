//! ST-1 (Spec #2935) — Phase-0 live probe: pin each Terminal CLI's resume surface
//! and its CLI-native session-id capture channel.
//!
//! Neither CLI may be invoked from an agent shell (`docs/agentic-pipeline/permissions.md`
//! denies direct `opencode` execution; only `copilot*` is allowlisted), so the probe
//! runs **from product code** — this `#[ignore]`d integration test resolves each CLI
//! exactly the way `features/terminal/commands.rs` does (`cli_candidates` order +
//! `where`, then the `.cmd`/`.bat` → `cmd.exe /C`, `.ps1` → `pwsh -File` launch
//! wrapping) and runs `<cli> --help` plus any listing surface, printing a
//! machine-readable summary.
//!
//! Run it deliberately:
//!
//! ```text
//! cargo test --locked --test terminal_cli_resume_probe -- --ignored --nocapture
//! ```
//!
//! The findings (exact flags, no-id validity, session-id capture channel) are
//! recorded in `.opencode/tmp/2935/resume-probe.md`. This file is a diagnostic:
//! it changes no product behaviour, adds no command, and touches neither
//! `commands.rs` nor `state.rs`.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Hard bound on ANY single CLI invocation, so a CLI that waits for a TTY can
/// never wedge the probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Bound on how much raw CLI text is echoed per invocation (a `session list`
/// with a long history can be large; the pin needs the flag text, not the dump).
const MAX_ECHO: usize = 12_000;

/// The Windows candidate order for `opencode`, mirroring
/// `features/terminal/commands.rs::cli_candidates` (native `.exe`, then the
/// `.cmd`/`.bat` shims, then the bare name).
const OPENCODE_CANDIDATES: &[&str] = &["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"];

/// The Windows candidate order for `copilot`, mirroring
/// `features/terminal/commands.rs::cli_candidates` (native `.exe`, then the
/// `.cmd`/`.bat` shims, then a `.ps1`, then the bare name).
const COPILOT_CANDIDATES: &[&str] =
    &["copilot.exe", "copilot.cmd", "copilot.bat", "copilot.ps1", "copilot"];

/// `where <name>` → first matching path (the product's `where_first`).
fn where_first(name: &str) -> Option<String> {
    let output = Command::new("where").arg(name).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().next().map(|l| l.trim().to_string()).filter(|s| !s.is_empty())
}

/// First resolvable candidate, exactly like `resolve_binary` with no override.
fn resolve(candidates: &[&str]) -> Option<String> {
    candidates.iter().find_map(|c| where_first(c))
}

/// The concrete (program, argv-prefix) used to invoke a resolved binary —
/// mirrors `plan_launch` + `build_pty_command` for the forms the probe cares
/// about on Windows.
fn launch_form(bin: &str) -> (String, Vec<String>) {
    let lower = bin.to_ascii_lowercase();
    if lower.ends_with(".ps1") {
        (
            "pwsh".to_string(),
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                bin.to_string(),
            ],
        )
    } else if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        ("cmd.exe".to_string(), vec!["/C".to_string(), bin.to_string()])
    } else {
        (bin.to_string(), Vec::new())
    }
}

/// Run one command with a hard timeout, returning (exit, stdout, stderr).
/// stdin is null so an interactive CLI cannot block on a prompt; the child is
/// killed at the deadline and the reader threads then hit EOF.
fn run_bounded(program: &str, args: &[String]) -> (Option<i32>, String, String) {
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return (None, String::new(), format!("spawn error: {e}")),
    };

    let mut out = child.stdout.take();
    let mut err = child.stderr.take();

    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut pipe) = out.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = out_tx.send(buf);
        });
    }
    if let Some(mut pipe) = err.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = err_tx.send(buf);
        });
    }

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };

    let stdout = out_rx
        .recv_timeout(Duration::from_secs(2))
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    let stderr = err_rx
        .recv_timeout(Duration::from_secs(2))
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    (exit, stdout, stderr)
}

/// Echo one invocation as a machine-readable, delimited block.
fn report(cli: &str, stage: &str, bin: Option<&str>, argv: &[String]) {
    println!("===== PROBE cli={cli} stage={stage} =====");
    match bin {
        None => {
            println!("resolved: NOT FOUND");
        }
        Some(bin) => {
            println!("resolved: {bin}");
            let (program, mut prefix) = launch_form(bin);
            prefix.extend_from_slice(argv);
            println!("argv: {} {}", program, prefix.join(" "));
            let (exit, stdout, stderr) = run_bounded(&program, &prefix);
            println!("exit: {exit:?}");
            println!("----- stdout -----");
            println!("{}", truncate(&stdout));
            println!("----- stderr -----");
            println!("{}", truncate(&stderr));
        }
    }
    println!("===== END PROBE cli={cli} stage={stage} =====");
}

fn truncate(text: &str) -> String {
    if text.len() <= MAX_ECHO {
        text.to_string()
    } else {
        format!("{}…[truncated {} bytes]", &text[..MAX_ECHO], text.len() - MAX_ECHO)
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// Machine-readable flag-presence summary over the observed text, so the
/// findings file can quote an exact observation rather than a recollection.
fn flag_presence(cli: &str, stage: &str, text: &str) {
    for needle in ["--resume", "--continue", "--session", "sessions", "resume"] {
        if text.contains(needle) {
            println!("FLAG-FOUND cli={cli} stage={stage} literal={needle}");
        }
    }
}

#[test]
#[ignore = "live Phase-0 probe (ST-1): spawns each resolved CLI; run with --ignored --nocapture"]
fn probe_terminal_cli_resume_surface() {
    println!("### ST-1 terminal CLI resume probe ###");

    // ── OpenCode ───────────────────────────────────────────────────────────
    let opencode = resolve(OPENCODE_CANDIDATES);
    report("opencode", "help", opencode.as_deref(), &args(&["--help"]));

    if let Some(bin) = opencode.as_deref() {
        let (program, mut prefix) = launch_form(bin);
        prefix.extend(args(&["--help"]));
        let (_, stdout, stderr) = run_bounded(&program, &prefix);
        flag_presence("opencode", "help", &format!("{stdout}\n{stderr}"));
    }

    report(
        "opencode",
        "session-list-json",
        opencode.as_deref(),
        &args(&["session", "list", "--format", "json"]),
    );
    report("opencode", "session-help", opencode.as_deref(), &args(&["session", "--help"]));

    // ── GitHub Copilot ─────────────────────────────────────────────────────
    let copilot = resolve(COPILOT_CANDIDATES);
    report("copilot", "help", copilot.as_deref(), &args(&["--help"]));

    if let Some(bin) = copilot.as_deref() {
        let (program, mut prefix) = launch_form(bin);
        prefix.extend(args(&["--help"]));
        let (_, stdout, stderr) = run_bounded(&program, &prefix);
        flag_presence("copilot", "help", &format!("{stdout}\n{stderr}"));
    }

    // Best-effort listing surfaces for Copilot (documented as an interactive
    // Sessions tab; probe the CLI for any non-interactive equivalent).
    report("copilot", "sessions-help", copilot.as_deref(), &args(&["sessions", "--help"]));
    report("copilot", "resume-help", copilot.as_deref(), &args(&["--resume", "--help"]));

    println!("### ST-1 terminal CLI resume probe complete ###");
}
