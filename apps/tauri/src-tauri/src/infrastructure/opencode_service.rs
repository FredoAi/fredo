//! Infrastructure/opencode_service — the ONE OpenCode **background-service**
//! surface: a bounded read-only probe, the PURE restart trigger, the
//! hash-guarded plugin write both install paths call, and the restart-outcome
//! copy (Spec #3198 round-2 ST-A1; Names Block).
//!
//! **Why a module of its own.** The capture point is one global plugin loaded by
//! OpenCode's shared background server (#3197), so a plugin copied to
//! disk after that server started is invisible until the server restarts. Setup
//! therefore has to (a) know whether a service is running, (b) restart it through
//! **the runtime's own verb** and (c) report the outcome honestly. All three live
//! here, once, because `docs/ENGINEERING_RULES.md` forbids the
//! application-to-application import that a per-surface copy would need: the
//! in-app setup wizard (`applications::setup`) and the `fredo setup` CLI twin
//! (`infrastructure::cli`) call these functions.
//!
//! **What the runtime actually exposes** (posted probe, `opencode v2.4.1`):
//! `opencode service status` prints only `http://127.0.0.1:28894` and exits 0 —
//! **no pid, no start time, no client count**. `opencode service --help` lists
//! `start | restart | status | stop | get | set | unset`. That is why the trigger
//! is the **write event** (`restart_needed(wrote_bytes, state)`) and not service
//! age: an age predicate would be written on a surface the probe never showed
//! (the `--major` lesson — never name a mechanism the runtime does not have).
//!
//! **Nothing here terminates a process.** The only lifecycle action is the
//! runtime's own `restart` subcommand: the server's owner performs its own
//! shutdown, and Fredo kills nothing it did not spawn. The bounded runner kills
//! only the child it spawned itself when that child overruns its deadline.
//!
//! **Idempotent, hash-guarded write.** [`install_plugin_file`] compares SHA-256
//! digests and writes **only** when the destination is absent or differs, then
//! stamps the install instant. A second identical run writes nothing — so it also
//! restarts nothing (`restart_needed(false, _) == false`), which is what keeps
//! NFR-1 (setup is idempotent) intact while still allowing the restart.

use std::path::Path;
use std::process::Output;
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use super::opencode_version::{
    opencode_command, render, resolve_opencode_binary, run_bounded, VERSION_PROBE_TIMEOUT_MS,
};

// ── The verb (Names Block — BINDING, from the posted probe) ───────────────────

/// The read-only status argv (`opencode service status`).
pub const OPENCODE_SERVICE_STATUS_ARGS: [&str; 2] = ["service", "status"];

/// The restart argv (`opencode service restart`) — the runtime's OWN verb.
pub const OPENCODE_SERVICE_RESTART_ARGS: [&str; 2] = ["service", "restart"];

/// The one command STRING every restart-outcome message renders `{restart}`
/// from. Prose never carries a literal command: a constant that drifts from the
/// argv above would tell the user to run something the runtime rejects.
pub const OPENCODE_SERVICE_RESTART_COMMAND: &str = "opencode service restart";

/// Hard bound on the restart. A shared server that will not come back must not
/// hang setup: the bound fails the step loud and names the command to run.
pub const SERVICE_RESTART_TIMEOUT_MS: u64 = 15_000;

// ── Message templates (copy contracts — BINDING) ──────────────────────────────

/// R-2e success: the restart happened, so the next session is captured.
pub const OPENCODE_SERVICE_RESTARTED_MSG: &str =
    "[fredo] Restarted OpenCode's background service so it loads the plugin — new sessions are \
     captured.";

/// R-2e failure: the file IS installed (the copy succeeded); what failed is the
/// capture outcome. Names the child's own detail and the one command that fixes
/// it — never a silent success, never a claim that nothing was installed.
pub const OPENCODE_SERVICE_RESTART_FAILED_MSG: &str =
    "The Fredo plugin is installed, but OpenCode's background service could not be restarted \
     ({detail}), so new sessions will not be captured yet. Run `{restart}`, then start a new \
     session.";

/// The deferred busy branch. `opencode service status` exposes no client count, so
/// no code path can establish "a session is attached" and this message is not
/// reachable today; it ships as the wording to use when such a surface appears
/// (the addendum's guard (d)) rather than being re-invented then.
pub const OPENCODE_SERVICE_BUSY_MSG: &str =
    "The Fredo plugin is installed. An OpenCode session is running on the background service, so \
     Fredo did not restart it — new sessions will not be captured until you run `{restart}`.";

/// `--no-restart-service`: the user opted out. The write stands, the run stays
/// successful, and the state is never silent — the remedy is named.
pub const OPENCODE_SERVICE_RESTART_SKIPPED_MSG: &str =
    "The Fredo plugin is installed; the background-service restart was skipped \
     (--no-restart-service). New sessions are captured only after the service restarts — run \
     `{restart}` when convenient.";

// ── The typed service state ──────────────────────────────────────────────────

/// What the background service is doing, as far as a read-only probe can tell.
///
/// `Absent` is a distinct state rather than a flavour of `Unknown`: "there is no
/// service" and "I could not tell" have different consequences (the first needs no
/// restart by construction — the next session starts a fresh server that loads the
/// plugin; the second must never be acted on). No production path constructs it
/// yet: the posted probe recorded only the RUNNING shape (`exit 0` +
/// `http://127.0.0.1:28894`) and no "no service" exit code, and guessing that code
/// is exactly the failure mode this slice exists to remove.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SharedServiceState {
    /// No background service is running.
    Absent,
    /// A service answered; `url` is the first line it printed.
    Running {
        /// The URL the runtime reported (`http://127.0.0.1:28894`).
        url: Option<String>,
    },
    /// The state could not be established. `detail` names the probe's own failure.
    Unknown {
        /// What went wrong, for the outcome copy.
        detail: String,
    },
}

// ── The probe (bounded, read-only) ───────────────────────────────────────────

/// Probe the running background service with `opencode service status`.
///
/// Read-only and bounded by [`VERSION_PROBE_TIMEOUT_MS`] (the same budget as the
/// version probe), resolved through the SAME binary resolution and Windows shim
/// rule — a PATH-shadowing fake drives the real code path, which is why the
/// product needs no test seam.
pub fn probe() -> SharedServiceState {
    match resolve_opencode_binary() {
        Some(binary) => probe_binary(&binary),
        None => SharedServiceState::Unknown {
            detail: format!(
                "the `opencode` binary could not be resolved on PATH (`{}`)",
                status_command()
            ),
        },
    }
}

/// Probe one already-resolved binary — the executable core of [`probe`].
pub fn probe_binary(binary: &str) -> SharedServiceState {
    let mut command = opencode_command(binary);
    command.args(OPENCODE_SERVICE_STATUS_ARGS);

    match run_bounded(
        command,
        Duration::from_millis(VERSION_PROBE_TIMEOUT_MS),
        "the OpenCode service probe",
        &format!("`{}`", status_command()),
    ) {
        Ok(output) => classify_status(
            output.status.code(),
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(detail) => SharedServiceState::Unknown { detail },
    }
}

/// Classify a status run — **PURE**, so every branch is unit-tested without
/// spawning the runtime (G-222).
///
/// `Running` iff the command exits 0 with a non-empty first line (the recorded
/// `http://127.0.0.1:28894` shape). Anything else is `Unknown` carrying the
/// child's own detail: the probe record establishes no distinct "no service" exit
/// code, so none is invented.
pub fn classify_status(code: Option<i32>, stdout: &str, stderr: &str) -> SharedServiceState {
    let url = if code == Some(0) {
        first_line(stdout)
    } else {
        None
    };

    match url {
        Some(url) => SharedServiceState::Running { url: Some(url) },
        None => SharedServiceState::Unknown {
            detail: describe_failure(code, stdout, stderr),
        },
    }
}

// ── The pure trigger ─────────────────────────────────────────────────────────

/// The ONE restart rule: restart **iff this invocation wrote bytes AND a service
/// is running**.
///
/// - an unchanged install wrote nothing, so there is nothing new for a restart to
///   pick up (NFR-1: a second setup run changes nothing, and must not end a live
///   turn);
/// - `Absent` needs no restart — the next session starts a server that loads the
///   plugin by construction;
/// - `Unknown` is reported, never acted on: a restart on a guess is a hazard with
///   no evidence behind it.
pub fn restart_needed(wrote_bytes: bool, state: &SharedServiceState) -> bool {
    wrote_bytes && matches!(state, SharedServiceState::Running { .. })
}

// ── The restart (the runtime's own verb, bounded) ────────────────────────────

/// Restart the background service through `opencode service restart`.
///
/// Bounded by [`SERVICE_RESTART_TIMEOUT_MS`]; a non-zero exit returns the child's
/// own detail (exit code + first stderr/stdout line) so the failure copy names
/// what actually happened. Never a signal, never a second mechanism.
pub fn restart() -> Result<(), String> {
    let binary = resolve_opencode_binary().ok_or_else(|| {
        format!(
            "the `opencode` binary could not be resolved on PATH (`{OPENCODE_SERVICE_RESTART_COMMAND}`)"
        )
    })?;
    restart_binary(&binary)
}

/// Restart through one already-resolved binary — the executable core of
/// [`restart`].
pub fn restart_binary(binary: &str) -> Result<(), String> {
    let mut command = opencode_command(binary);
    command.args(OPENCODE_SERVICE_RESTART_ARGS);

    let output = run_bounded(
        command,
        Duration::from_millis(SERVICE_RESTART_TIMEOUT_MS),
        "the OpenCode service restart",
        &format!("`{OPENCODE_SERVICE_RESTART_COMMAND}`"),
    )?;

    if output.status.success() {
        Ok(())
    } else {
        Err(child_detail(&output))
    }
}

// ── The hash-guarded write (ONE rule for both install paths) ─────────────────

/// Copy `artifact` to `destination`, writing **only** when the bytes differ.
/// Returns `true` when this call wrote bytes.
///
/// One rule, because there are TWO copy sites (`applications::setup::commands`
/// and `infrastructure::cli::commands::setup`) and a guard written twice would
/// diverge exactly as the two install paths did before. The digest comparison is
/// what lets an unchanged install be a no-op — no write, no mtime churn, and
/// therefore no restart (`restart_needed(false, _) == false`).
///
/// The install instant is stamped onto the destination only after a real write:
/// `std::fs::copy`/`write` leave the SOURCE's timestamp on Windows, so an
/// unstamped destination would carry `dist/index.js`'s build time.
///
/// The destination's **directory** is the caller's: both install paths create it
/// on their success path only, so a gated run still leaves no directory behind
/// (R-1c) and this function stays one responsibility.
pub fn install_plugin_file(artifact: &Path, destination: &Path) -> Result<bool, String> {
    let bytes = std::fs::read(artifact)
        .map_err(|e| format!("could not read {} ({e})", artifact.display()))?;
    let digest = sha256(&bytes);

    // A destination that cannot be read is "absent" for this decision: writing is
    // the safe outcome, and the write itself reports any real failure.
    let unchanged = std::fs::read(destination)
        .map(|existing| sha256(&existing) == digest)
        .unwrap_or(false);
    if unchanged {
        return Ok(false);
    }

    std::fs::write(destination, &bytes)
        .map_err(|e| format!("could not write {} ({e})", destination.display()))?;
    stamp_install_instant(destination);
    Ok(true)
}

/// The SHA-256 of `bytes` — the idempotency guard's whole input.
fn sha256(bytes: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().to_vec()
}

/// Stamp the install instant on the destination.
///
/// A stamp failure is reported and does **not** fail the install: the bytes are
/// already correct on disk and the idempotency guard is the digest, so the
/// timestamp is an anchor for readers, not a correctness input.
fn stamp_install_instant(destination: &Path) {
    let stamped = std::fs::File::options()
        .write(true)
        .open(destination)
        .and_then(|file| file.set_modified(SystemTime::now()));
    if let Err(error) = stamped {
        tracing::warn!(
            "could not stamp the install instant on {}: {error}",
            destination.display()
        );
    }
}

// ── Message rendering (derived from the constants) ───────────────────────────

/// R-2e: the restart happened.
pub fn restarted_message() -> String {
    OPENCODE_SERVICE_RESTARTED_MSG.to_string()
}

/// R-2e: the restart failed; `{detail}` is the child's own failure.
pub fn restart_failed_message(detail: &str) -> String {
    render(
        OPENCODE_SERVICE_RESTART_FAILED_MSG,
        &[
            ("{detail}", detail),
            ("{restart}", OPENCODE_SERVICE_RESTART_COMMAND),
        ],
    )
}

/// `--no-restart-service`: the restart was skipped by explicit request.
pub fn restart_skipped_message() -> String {
    render(
        OPENCODE_SERVICE_RESTART_SKIPPED_MSG,
        &[("{restart}", OPENCODE_SERVICE_RESTART_COMMAND)],
    )
}

/// The deferred busy wording (see [`OPENCODE_SERVICE_BUSY_MSG`]).
pub fn busy_message() -> String {
    render(
        OPENCODE_SERVICE_BUSY_MSG,
        &[("{restart}", OPENCODE_SERVICE_RESTART_COMMAND)],
    )
}

// ── Small helpers ────────────────────────────────────────────────────────────

/// `opencode service status` as one string (used in probe failure detail so the
/// reader is told which command failed).
fn status_command() -> String {
    format!("opencode {}", OPENCODE_SERVICE_STATUS_ARGS.join(" "))
}

/// The first non-blank line, trimmed.
fn first_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// `exit <code>: <first stderr line, else first stdout line>` — the child's own
/// failure, for the restart-failure copy.
fn child_detail(output: &Output) -> String {
    let code = match output.status.code() {
        Some(code) => code.to_string(),
        None => "terminated by a signal".to_string(),
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let head = first_line(&stderr)
        .or_else(|| first_line(&stdout))
        .unwrap_or_else(|| "no output".to_string());
    format!("exit {code}: {head}")
}

/// The `Unknown` detail for a status run: exit code plus the first line the
/// runtime printed.
fn describe_failure(code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let code = match code {
        Some(code) => code.to_string(),
        None => "terminated by a signal".to_string(),
    };
    let head = first_line(stderr)
        .or_else(|| first_line(stdout))
        .unwrap_or_else(|| "no output".to_string());
    format!("`{}` exited with {code} ({head})", status_command())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn running() -> SharedServiceState {
        SharedServiceState::Running {
            url: Some("http://127.0.0.1:28894".to_string()),
        }
    }

    // ── the PURE trigger: all four states × wrote / not wrote ────────────────

    /// R-2e: the restart happens ONLY for a write plus a running service. Every
    /// cell of the table is asserted — the "never on a guess" clauses are the
    /// ones a plausible-looking inversion would break.
    #[test]
    fn restart_needed_is_wrote_bytes_and_running_only() {
        let states = [
            SharedServiceState::Absent,
            running(),
            SharedServiceState::Running { url: None },
            SharedServiceState::Unknown {
                detail: "the probe could not run".to_string(),
            },
        ];

        // wrote bytes: exactly the running states restart.
        let decided: Vec<bool> = states.iter().map(|s| restart_needed(true, s)).collect();
        assert_eq!(decided, vec![false, true, true, false]);

        // no write: nothing restarts, whatever the service is doing.
        for state in &states {
            assert!(
                !restart_needed(false, state),
                "an unchanged install must never restart the service: {state:?}"
            );
        }
    }

    // ── classify_status: the recorded shapes ────────────────────────────────

    /// The posted probe's live shape: exit 0 and the URL on the first line.
    #[test]
    fn a_zero_exit_with_a_url_reads_running_with_that_url() {
        let state = classify_status(Some(0), "http://127.0.0.1:28894\n", "");
        assert_eq!(
            state,
            SharedServiceState::Running {
                url: Some("http://127.0.0.1:28894".to_string())
            }
        );
    }

    /// A zero exit that printed nothing is NOT a pass: nothing was established.
    #[test]
    fn a_zero_exit_with_no_output_is_unknown() {
        for empty in ["", "   \n\n "] {
            match classify_status(Some(0), empty, "") {
                SharedServiceState::Unknown { detail } => {
                    assert!(detail.contains("no output"), "{detail}");
                }
                other => panic!("no output must not read as running: {other:?}"),
            }
        }
    }

    /// A non-zero exit is `Unknown` naming the code and the child's own line —
    /// never `Absent` (no "no service" code is established) and never `Running`.
    #[test]
    fn a_non_zero_exit_is_unknown_naming_the_code_and_the_line() {
        match classify_status(Some(3), "", "connect ECONNREFUSED\n") {
            SharedServiceState::Unknown { detail } => {
                assert!(detail.contains("exited with 3"), "{detail}");
                assert!(detail.contains("connect ECONNREFUSED"), "{detail}");
                assert!(detail.contains("opencode service status"), "{detail}");
            }
            other => panic!("a failed status run is Unknown: {other:?}"),
        }
    }

    /// The command STRING every message renders is the argv actually run — a
    /// drifted constant would print a command the runtime rejects.
    #[test]
    fn the_restart_command_constant_is_the_argv_the_runtime_runs() {
        assert_eq!(
            OPENCODE_SERVICE_RESTART_COMMAND,
            format!("opencode {}", OPENCODE_SERVICE_RESTART_ARGS.join(" "))
        );
        assert_eq!(OPENCODE_SERVICE_RESTART_ARGS, ["service", "restart"]);
        assert_eq!(OPENCODE_SERVICE_STATUS_ARGS, ["service", "status"]);
        // The posted probe's verb set includes `restart` — no invented spelling.
        assert!(!OPENCODE_SERVICE_RESTART_COMMAND.contains("--"));
    }

    // ── the hash-guarded write ──────────────────────────────────────────────

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create the parent dir");
        }
        fs::write(path, contents).expect("write the fixture");
    }

    /// Stamp `path` an hour into the past — the fixture that makes the install
    /// instant's receipt discriminating (`fs::copy` would carry this time over).
    fn stamp_into_the_past(path: &Path) {
        fs::File::options()
            .write(true)
            .open(path)
            .expect("open the fixture")
            .set_modified(SystemTime::now() - Duration::from_secs(3_600))
            .expect("stamp the fixture into the past");
    }

    /// absent → written; identical → NOT written (mtime untouched); different →
    /// written with the new bytes. The mtime cell is the anchor's receipt: the
    /// destination must carry the INSTALL instant, never the artifact's time.
    #[test]
    fn the_hash_guarded_write_writes_only_when_the_bytes_differ() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let artifact = dir.path().join("dist").join("index.js");
        let destination = dir.path().join("plugins").join("fredo.js");
        // Both install paths create the plugins directory on their success path
        // before calling the shared write rule.
        fs::create_dir_all(destination.parent().expect("the plugins dir")).expect("create plugins dir");

        // (1) absent destination → written.
        write_file(&artifact, "// bundle v1");
        assert_eq!(install_plugin_file(&artifact, &destination), Ok(true));
        assert_eq!(
            fs::read_to_string(&destination).expect("read the installed bundle"),
            "// bundle v1"
        );

        // (2) identical bytes → no write, and the destination's mtime is
        // untouched (a rewrite would move it).
        let before = fs::metadata(&destination)
            .expect("metadata")
            .modified()
            .expect("mtime");
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(
            install_plugin_file(&artifact, &destination),
            Ok(false),
            "an identical re-install writes nothing (NFR-1)"
        );
        assert_eq!(
            fs::metadata(&destination)
                .expect("metadata")
                .modified()
                .expect("mtime"),
            before,
            "the idempotent path must not touch the file at all"
        );

        // (3) different bytes → written, and the destination carries the INSTALL
        // instant rather than the artifact's own (the `fs::copy` mtime trap).
        write_file(&artifact, "// bundle v2");
        stamp_into_the_past(&artifact);
        let artifact_mtime = fs::metadata(&artifact)
            .expect("metadata")
            .modified()
            .expect("mtime");
        assert!(
            artifact_mtime < SystemTime::now() - Duration::from_secs(60),
            "the fixture artifact is in the past: {artifact_mtime:?}"
        );

        assert_eq!(install_plugin_file(&artifact, &destination), Ok(true));
        assert_eq!(
            fs::read_to_string(&destination).expect("read the installed bundle"),
            "// bundle v2"
        );
        let destination_mtime = fs::metadata(&destination)
            .expect("metadata")
            .modified()
            .expect("mtime");
        assert!(
            destination_mtime > artifact_mtime,
            "the install instant is stamped on the destination, not copied from the artifact: \
             destination {destination_mtime:?} vs artifact {artifact_mtime:?}"
        );
    }

    /// A missing artifact fails loud instead of writing an empty file.
    #[test]
    fn a_missing_artifact_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let artifact = dir.path().join("dist").join("index.js");
        let destination = dir.path().join("plugins").join("fredo.js");

        let error = install_plugin_file(&artifact, &destination)
            .expect_err("a missing artifact is never a silent skip");
        assert!(error.contains("index.js"), "names the artifact: {error}");
        assert!(
            !destination.exists(),
            "no destination is written when the artifact is missing"
        );
    }

    // ── the copy contracts ──────────────────────────────────────────────────

    /// The restarted line is the ONE `[fredo] `-prefixed line and states the
    /// capture outcome the restart bought.
    #[test]
    fn the_restarted_message_is_prefixed_and_names_the_outcome() {
        let message = restarted_message();
        assert!(message.starts_with("[fredo] "), "{message}");
        assert!(message.contains("background service"), "{message}");
        assert!(message.contains("captured"), "{message}");
    }

    /// The failure copy names the child's detail AND the command to run, and it
    /// never claims nothing was installed — the file IS on disk.
    #[test]
    fn the_failure_message_names_the_detail_the_remedy_and_keeps_the_install() {
        let message = restart_failed_message("exit 2: the service did not respond");
        assert!(
            message.contains("exit 2: the service did not respond"),
            "{message}"
        );
        assert!(
            message.contains(OPENCODE_SERVICE_RESTART_COMMAND),
            "the remedy is rendered from the command constant: {message}"
        );
        assert!(
            message.contains("The Fredo plugin is installed"),
            "the file stays installed — the failure is the capture outcome: {message}"
        );
        assert!(!message.contains('{'), "no placeholder survives: {message}");
    }

    /// The skipped copy names the flag that skipped it and the remedy.
    #[test]
    fn the_skipped_message_names_the_flag_and_the_remedy() {
        let message = restart_skipped_message();
        assert!(message.contains("--no-restart-service"), "{message}");
        assert!(
            message.contains(OPENCODE_SERVICE_RESTART_COMMAND),
            "{message}"
        );
        assert!(!message.contains('{'), "{message}");
    }

    /// Every outcome template renders with no placeholder surviving — including
    /// the deferred busy wording, so it cannot rot before a surface reaches it.
    #[test]
    fn every_outcome_template_is_fully_rendered() {
        for message in [
            restarted_message(),
            restart_failed_message("exit 2: nope"),
            restart_skipped_message(),
            busy_message(),
        ] {
            assert!(!message.contains('{'), "unsubstituted placeholder: {message}");
            assert!(!message.contains('}'), "unsubstituted placeholder: {message}");
        }
    }

    /// G-430 absence guard: this module carries **no direct termination path**.
    /// The raw source is scanned (comments and doc comments included, because the
    /// AC's predicate is a raw grep) and every banned token is CONSTRUCTED here so
    /// the guard cannot match its own text.
    #[test]
    fn the_module_carries_no_direct_process_termination() {
        let source = include_str!("opencode_service.rs");

        // Non-vacuity: the universe is the real file and the matcher fires on a
        // token that IS present.
        assert!(source.len() > 5_000, "the scan universe is the whole module");
        assert!(
            source.contains(OPENCODE_SERVICE_RESTART_ARGS[1]),
            "the matcher fires on a token that is present"
        );

        let banned = [
            ["task", "kill"].concat(),
            ["service", " ", "stop"].concat(),
            ["child", ".", "kill"].concat(),
        ];
        for token in &banned {
            assert!(
                !source.contains(token.as_str()),
                "the only lifecycle action is the runtime's own restart verb: {token}"
            );
        }
    }
}
