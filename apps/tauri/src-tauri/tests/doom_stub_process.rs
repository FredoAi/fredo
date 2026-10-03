//! Process-level tests for the feature-gated Doom stub engine (Spec #2968 ST-8).
//!
//! Compiled/run ONLY with `cargo test --features doom-stub`. Every wait here is
//! finite and the spawned process is always killed before the test returns
//! (G-263: never run an unbounded binary).

#![cfg(feature = "doom-stub")]

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The built stub binary path (Cargo provides this to integration tests).
fn stub_bin() -> &'static str {
    env!("CARGO_BIN_EXE_doom_stub")
}

/// Wait up to `bound` for `child` to exit; kill it on timeout so the test can
/// never leak a process.
fn wait_bounded(child: &mut Child, bound: Duration, what: &str) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + bound;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(error) => panic!("{what}: try_wait failed: {error}"),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn spawn_stub(envs: &[(&str, &str)]) -> Child {
    let mut command = Command::new(stub_bin());
    command
        .arg("-apiport")
        .arg("0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (key, value) in envs {
        command.env(key, value);
    }
    command.spawn().expect("spawn doom-stub")
}

#[test]
fn exit_lever_exits_immediately_within_bound() {
    let mut child = spawn_stub(&[("FREDO_DOOM_STUB_EXIT", "1")]);
    let status = wait_bounded(&mut child, Duration::from_secs(10), "EXIT lever");
    assert!(
        status.is_some(),
        "the FREDO_DOOM_STUB_EXIT=1 lever must exit immediately"
    );
}

#[test]
fn hang_lever_survives_and_is_hard_killable_within_bound() {
    let mut child = spawn_stub(&[("FREDO_DOOM_STUB_HANG", "1")]);

    // Give it a moment to bind; it must still be alive (HANG ignores termination).
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        matches!(child.try_wait(), Ok(None)),
        "the FREDO_DOOM_STUB_HANG=1 stub must still be running"
    );

    // Bounded hard-kill: the test owns the kill so it can never leak.
    let _ = child.kill();
    let status = wait_bounded(&mut child, Duration::from_secs(5), "HANG hard-kill");
    assert!(
        status.is_some(),
        "the hard-killed stub must be reaped within the bound"
    );
}

#[test]
fn default_stub_starts_and_is_bounded_killable() {
    // No lever: the stub is a long-running server; confirm it starts and that
    // our bounded kill reaps it (never an unbounded run).
    let mut child = spawn_stub(&[]);
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        matches!(child.try_wait(), Ok(None)),
        "the default stub must be running (it serves until killed)"
    );
    let _ = child.kill();
    let status = wait_bounded(&mut child, Duration::from_secs(5), "default stub kill");
    assert!(status.is_some(), "the killed stub must be reaped within the bound");
}
