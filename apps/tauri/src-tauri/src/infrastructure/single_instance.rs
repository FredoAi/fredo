//! Single-instance hand-off for the resident shell (Spec #3192 ST-3).
//!
//! A second launch of Fredo must hand its intent to the instance that is already
//! running instead of starting a second stack (R-4): the resident instance
//! focuses — or rebuilds — its `main` window, and the second process exits
//! without touching PostgreSQL, the OTLP receivers, the tray or a window.
//!
//! **The key is the ENVIRONMENT, not the application identity.** Detection is a
//! connect on this process's own IPC pipe (`FREDO_CLI_PIPE`, resolved by
//! [`socket_name`]), so the supported multi-environment workflow (per-env pipe,
//! ports and data dir) keeps working: two env-isolated instances stay
//! independent by construction. `tauri-plugin-single-instance` is deliberately
//! NOT used — it is absent from the lock, its key semantics are unverified, and
//! a global app-identifier key would refuse exactly that workflow.
//!
//! **Detection is a CONNECT with a time-bounded read, never a bind.** Whether a
//! second process could bind a second instance of the same pipe name is not a
//! property to rely on, and a bind-success test would also have to answer "is
//! that really Fredo?". [`send_cli_command`] already distinguishes "nothing is
//! listening" (`Ok(None)` on `NotFound`/`ConnectionRefused`) from a real answer,
//! and the whole read is capped by [`PROBE_TIMEOUT`], so a cold start can never
//! be held up by the probe.
//!
//! **Structural authority is unchanged.** `PgDataDirLock` and the bind-or-fail
//! OTLP receivers remain the one-postmaster / one-OTLP-owner guarantee; this
//! probe removes the second process on the normal path and adds no lock, no
//! port, no file and no persistence. A cold-launch race (both processes probing
//! before either serves the pipe) still fails closed through those two
//! invariants, which is why nothing here re-derives a path or a lock dir.

use std::time::Duration;

use crate::infrastructure::ipc::{send_cli_command_on, socket_name, CliCommand};

/// How long a launch waits for a resident instance to answer the focus request.
///
/// The read is bounded by construction: when nothing answers within this window
/// the process treats itself as the primary and continues a normal launch, so a
/// wedged or foreign listener on the pipe can delay a cold start by at most this
/// long and can never block it.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Whether another Fredo instance is already resident for this environment.
///
/// `true` means a resident instance ANSWERED the focus request — it has been
/// asked to focus or rebuild its `main` window, and this process must exit
/// without starting a second stack. `false` means this process is the primary:
/// nothing is listening (the normal cold start), the probe failed, or the answer
/// did not arrive inside [`PROBE_TIMEOUT`] — every "not proven resident" case
/// falls through to a normal launch, because refusing to start would be far
/// worse than a redundant probe.
pub fn probe_existing_instance() -> bool {
    probe_existing_instance_on(&socket_name(), PROBE_TIMEOUT)
}

/// The socket- and bound-parameterised core of [`probe_existing_instance`], so
/// the classification is unit-pinnable without mutating process environment
/// (`FREDO_CLI_PIPE` is process-global; injecting the pipe keeps the pins
/// order-independent).
fn probe_existing_instance_on(socket: &str, bound: Duration) -> bool {
    // `tauri::async_runtime::block_on` is safe before the builder: the global
    // runtime is created lazily on first use, and it is Tokio's default
    // multi-thread runtime with `enable_all()` (the timer driver included), so
    // `timeout` is available inside it. See
    // `tauri::async_runtime::default_runtime`.
    //
    // The timeout is constructed INSIDE the async block on purpose: `timeout`
    // registers with the ambient timer when the future is created, so building
    // it as an argument to `block_on` would run before the runtime context is
    // entered and panic ("there is no reactor running") — a cold start would
    // never reach the builder. This exact failure was caught by
    // `probe_reports_primary_when_nothing_is_listening`.
    let outcome = tauri::async_runtime::block_on(async move {
        tokio::time::timeout(
            bound,
            send_cli_command_on(socket, &CliCommand::OpenMainWindow),
        )
        .await
    });

    match outcome {
        Ok(Ok(Some(response))) => {
            // Any well-formed answer means "a Fredo instance owns this
            // environment's pipe". A `ok: false` answer still means the resident
            // instance is there and was asked to open its window — starting a
            // second stack would be strictly worse than leaving the user with a
            // resident instance that could not focus (and, per R-2d, that
            // instance keeps its tray, so the window stays reachable).
            report(format!(
                "another Fredo instance is resident for this environment and was asked to \
                 open its main window (answered ok={}); this launch exits without starting a \
                 second PostgreSQL/OTLP stack",
                response.ok
            ));
            true
        }
        // Nothing is listening: this is the primary launch (the normal path —
        // no output, so a cold start stays quiet).
        Ok(Ok(None)) => false,
        Ok(Err(error)) => {
            report(format!(
                "single-instance probe failed ({error}); starting a normal launch"
            ));
            false
        }
        Err(_elapsed) => {
            report(format!(
                "single-instance probe got no answer within {} ms; starting a normal launch",
                bound.as_millis()
            ));
            false
        }
    }
}

/// Report a probe outcome a human may need to see.
///
/// The probe runs at the very top of `run()`, BEFORE the tracing subscriber is
/// installed in `setup`, so `tracing` would be silent on every path this module
/// takes (and the secondary launch never reaches `setup` at all). The message
/// therefore goes to stderr — the app's console channel — with a `tracing` event
/// alongside it for any future configuration that installs a subscriber first.
/// Only the actionable paths report: a clean cold start says nothing.
fn report(message: String) {
    tracing::info!(target: "fredo::single_instance", "{message}");
    eprintln!("[fredo] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    /// Distinguishes the pipes bound by this suite's own tests.
    static PIPE_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A pipe name that no other test (or the running app) can be using.
    fn unique_pipe(tag: &str) -> String {
        let sequence = PIPE_COUNTER.fetch_add(1, Ordering::Relaxed);
        format!(
            r"\\.\pipe\fredo-si-test-{}-{sequence}-{tag}",
            std::process::id()
        )
    }

    /// Bind a sync listener on `pipe`.
    fn bind(pipe: &str) -> LocalSocketListener {
        let name = pipe
            .to_fs_name::<GenericFilePath>()
            .expect("a Windows pipe path is a valid local-socket name");
        ListenerOptions::new()
            .name(name)
            .create_sync()
            .expect("bind a test pipe")
    }

    /// Read one newline-terminated request line and answer it.
    fn serve_one(mut stream: LocalSocketStream, answer: &str) -> String {
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while stream.read(&mut byte).expect("read the request") == 1 {
            if byte[0] == b'\n' {
                break;
            }
            request.push(byte[0]);
        }
        stream
            .write_all(format!("{answer}\n").as_bytes())
            .expect("write the answer");
        String::from_utf8(request).expect("the request is UTF-8")
    }

    /// The documented bound is part of the contract (`lib.rs` returns on a
    /// proven delivery, and a cold start may wait at most this long).
    #[test]
    fn probe_timeout_is_the_documented_bound() {
        assert_eq!(PROBE_TIMEOUT, Duration::from_millis(1500));
    }

    /// With nothing listening the probe reports "primary" — the only path a cold
    /// start takes, and the one that must never be mistaken for a resident
    /// instance.
    #[test]
    fn probe_reports_primary_when_nothing_is_listening() {
        let pipe = unique_pipe("no-listener");
        assert!(
            !probe_existing_instance_on(&pipe, Duration::from_millis(500)),
            "a pipe nobody serves must classify as the primary launch"
        );
    }

    /// A listener that accepts but never answers must NOT be mistaken for a
    /// resident instance, and the wait must stay inside the bound — the reason
    /// the probe can never block a cold start.
    #[test]
    fn probe_is_bounded_when_the_listener_never_answers() {
        let pipe = unique_pipe("silent");
        let listener = bind(&pipe);
        let server = std::thread::spawn(move || {
            let connection = listener.accept().expect("accept the probe");
            // Hold the connection open, far longer than the probe's bound, and
            // answer nothing.
            std::thread::sleep(Duration::from_secs(2));
            drop(connection);
        });

        let bound = Duration::from_millis(150);
        let started = Instant::now();
        let resident = probe_existing_instance_on(&pipe, bound);
        let elapsed = started.elapsed();

        assert!(
            !resident,
            "a listener that never answers is not a proven resident instance"
        );
        assert!(
            elapsed < Duration::from_millis(1500),
            "the probe must stay bounded by its timeout, took {elapsed:?}"
        );

        server.join().expect("the test server thread joins");
    }

    /// R-4's core: a SECOND PROCESS running the REAL entry point
    /// ([`probe_existing_instance`], environment resolution included) connects to
    /// the resident instance's pipe and reads its answer.
    ///
    /// This is the live mechanism probe the plan asks for, driven through the
    /// production code path: the parent binds the pipe and acts as the resident
    /// IPC server, the child is `#[test] second_process_probe_child` re-executed
    /// out of the real test binary with `FREDO_CLI_PIPE` injected, and the
    /// returned line is asserted to be the pinned wire command.
    #[test]
    fn a_second_process_observes_the_resident_instance() {
        let pipe = unique_pipe("cross-process");
        let listener = bind(&pipe);
        let (observed_tx, observed_rx) = mpsc::channel::<String>();

        let server = std::thread::spawn(move || {
            let connection = listener.accept().expect("accept the second process");
            let request = serve_one(
                connection,
                r#"{"ok":true,"data":{"recreated":false,"focused":true}}"#,
            );
            observed_tx.send(request).expect("report the request");
        });

        let exe = std::env::current_exe().expect("the test binary path");
        let mut child = Command::new(exe)
            .args([
                "--exact",
                "infrastructure::single_instance::tests::second_process_probe_child",
                "--ignored",
            ])
            .env(crate::infrastructure::env::CLI_PIPE_ENV, &pipe)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn the second process");

        let request = observed_rx
            .recv_timeout(Duration::from_secs(20))
            .expect("the second process must connect and send its command within 20 s");
        let parsed: CliCommand =
            serde_json::from_str(&request).expect("the wire line is a CliCommand");
        assert!(
            matches!(parsed, CliCommand::OpenMainWindow),
            "the second process must send the focus request, got {request}"
        );

        let status = wait_bounded(&mut child, Duration::from_secs(20));
        let mut diagnostics = String::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_string(&mut diagnostics);
        }
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut diagnostics);
        }
        assert!(
            status.success(),
            "the second process must observe the resident instance, got {status}\n{diagnostics}"
        );

        server.join().expect("the resident-side thread joins");
    }

    /// The child half of [`a_second_process_observes_the_resident_instance`].
    /// Ignored so a normal suite run never executes it: the parent drives it in a
    /// separate process with the pipe injected.
    #[test]
    #[ignore = "driven in a second process by a_second_process_observes_the_resident_instance"]
    fn second_process_probe_child() {
        assert!(
            std::env::var(crate::infrastructure::env::CLI_PIPE_ENV).is_ok(),
            "the parent must inject the environment's pipe"
        );
        assert!(
            probe_existing_instance(),
            "the second process must observe the resident instance through the real entry point"
        );
    }

    /// Wait for a child with a wall-clock bound (never an unbounded `wait`).
    fn wait_bounded(child: &mut std::process::Child, bound: Duration) -> std::process::ExitStatus {
        let started = Instant::now();
        loop {
            match child.try_wait().expect("poll the child") {
                Some(status) => return status,
                None if started.elapsed() > bound => {
                    let _ = child.kill();
                    panic!("the second process did not exit within {bound:?}");
                }
                None => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    }
}
