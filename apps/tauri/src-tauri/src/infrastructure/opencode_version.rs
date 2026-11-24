//! Infrastructure/opencode_version — the ONE authoritative OpenCode runtime
//! probe, plugin-artifact/path helpers and user-facing message templates
//! (Spec #3198 ST-1; Names Block).
//!
//! **Why `infrastructure/` and not an application.** `docs/ENGINEERING_RULES.md`
//! forbids cross-application imports, so a probe living in
//! `applications/setup` could not be consumed by `applications/terminal` or by
//! `infrastructure/cli`. Three copies of the gate were the rejected
//! alternative: this module is the single source the in-app setup wizard, the
//! `fredo setup` CLI twin and the Terminal launch path all call, so the gate,
//! the copy and the plugin artifact name can never diverge.
//!
//! **Three outcomes, never two.** A probe that cannot establish the version is
//! [`OpenCodeVersion::Undetermined`] — it is never reported as "not installed"
//! and never as a pass (R-1b). "Cannot determine" and "not installed" are
//! different facts with different remedies.
//!
//! **Copy is rendered from constants.** [`MIN_SUPPORTED_OPENCODE_MAJOR`] is the
//! single source of the supported major and every message below renders from
//! it, so no user-facing string carries a hand-written `"2"` that can drift
//! from the value the gate actually enforces.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

// ── The gate (Names Block — BINDING) ──────────────────────────────────────────

/// The minimum supported OpenCode major — the ONE source of the gate and of
/// every rendered message.
pub const MIN_SUPPORTED_OPENCODE_MAJOR: u32 = 2;

/// The version-probe argument (`opencode --version`).
pub const OPENCODE_VERSION_ARG: &str = "--version";

/// The supported upgrade path printed in the gate-failure message.
///
/// **Bare, never a flag.** The installed runtime's `opencode upgrade --help`
/// takes a POSITIONAL target plus `--method` — there is no `--major` flag
/// (ST-1 probe), so naming one would print a command the runtime rejects.
pub const OPENCODE_UPGRADE_COMMAND: &str = "opencode upgrade";

/// The install/upgrade reference the setup surfaces offer.
pub const OPENCODE_INSTALL_DOCS_URL: &str = "https://opencode.ai/docs/install";

/// Hard bound on the version probe, mirroring `terminal::resume`'s pre-flight
/// (NFR-3). A timeout is [`OpenCodeVersion::Undetermined`], never a success.
pub const VERSION_PROBE_TIMEOUT_MS: u64 = 5_000;

// ── The plugin artifact + global install destination (the #3197 seam) ────────

/// The built plugin bundle, relative to the plugin source directory
/// (`apps/opencode-plugin/package.json` `main`).
pub const FREDO_PLUGIN_ARTIFACT_REL: &str = "dist/index.js";

/// The installed file name (a flat `.js` directly in the plugins directory is
/// how OpenCode discovers local plugins).
pub const FREDO_PLUGIN_INSTALL_FILENAME: &str = "fredo.js";

/// The GLOBAL plugins directory, relative to the user's home directory.
pub const FREDO_GLOBAL_PLUGINS_SUBDIR: [&str; 3] = [".config", "opencode", "plugins"];

// ── Message templates (copy contracts — BINDING) ─────────────────────────────

/// R-1a: the installed runtime is too old. Names the found version, the
/// required major (rendered from [`MIN_SUPPORTED_OPENCODE_MAJOR`]) and the one
/// command that fixes it — never "not installed", which would be false for a
/// binary that exists and runs.
pub const OPENCODE_VERSION_UNSUPPORTED_MSG: &str =
    "OpenCode {found} is installed, but Fredo requires OpenCode {min}.x. \
     Run `{upgrade}`, then re-run `fredo setup --check`.";

/// R-1b: the probe could not establish a version. Names the probe's own failure
/// and the diagnostic command — never degrades to "not installed", never a
/// silent pass.
pub const OPENCODE_VERSION_UNDETERMINED_MSG: &str =
    "Could not determine the installed OpenCode version ({detail}). \
     Run `opencode --version` to check it, then re-run `fredo setup --check`.";

/// R-2b: the one success line, naming the resolved destination and stating that
/// the install is global (the claim that stops a per-project re-install).
pub const PLUGIN_INSTALLED_GLOBAL_MSG: &str =
    "[fredo] Installed the Fredo plugin to {path} (global — every OpenCode client loads it).";

/// R-3d: a blocked Terminal launch. Deliberately distinct from
/// `terminal::commands::not_found_message`, which stays byte-identical.
pub const TERMINAL_OPENCODE_BLOCKED_MSG: &str =
    "Fredo Terminal could not start OpenCode: {cause}. Fix the cause, then reopen Terminal.";

// ── The typed probe result ───────────────────────────────────────────────────

/// The three distinct probe outcomes. "Cannot determine" is its own state so a
/// consumer can never collapse it into "not installed" or into a pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenCodeVersion {
    /// The installed runtime satisfies [`MIN_SUPPORTED_OPENCODE_MAJOR`].
    Supported {
        /// The version token as printed (`2.4.1` for `opencode v2.4.1`).
        raw: String,
        /// The parsed major.
        major: u32,
    },
    /// The binary exists but its major is below the supported minimum.
    Unsupported {
        /// The version token as printed.
        raw: String,
        /// The parsed major.
        major: u32,
    },
    /// The version could not be established (spawn failure, timeout, non-zero
    /// exit, or unparseable output). `detail` names this probe's own failure.
    Undetermined {
        /// What went wrong, for the R-1b message.
        detail: String,
    },
}

impl OpenCodeVersion {
    /// `true` only for [`OpenCodeVersion::Supported`] — the gate's answer.
    pub fn is_supported(&self) -> bool {
        matches!(self, OpenCodeVersion::Supported { .. })
    }

    /// The version token when one was parsed (`None` when undetermined) — the
    /// value a wire field carries as an ABSENT KEY, never `null` (G-413).
    pub fn raw(&self) -> Option<&str> {
        match self {
            OpenCodeVersion::Supported { raw, .. } | OpenCodeVersion::Unsupported { raw, .. } => {
                Some(raw)
            }
            OpenCodeVersion::Undetermined { .. } => None,
        }
    }

    /// The parsed major when one was established.
    pub fn major(&self) -> Option<u32> {
        match self {
            OpenCodeVersion::Supported { major, .. } | OpenCodeVersion::Unsupported { major, .. } => {
                Some(*major)
            }
            OpenCodeVersion::Undetermined { .. } => None,
        }
    }
}

// ── Parsing (pure) ───────────────────────────────────────────────────────────

/// The first semver-ish token in `output` → its major.
///
/// Tolerates `2.4.1`, `v2.4.1`, `opencode 2.4.1`, `OpenCode CLI v2.4.1` and a
/// bare `2`. A bare major is accepted only when it IS the whole output, so an
/// incidental number in prose (`exit code 1`) is never mistaken for a version.
pub fn parse_major(output: &str) -> Option<u32> {
    parse_version(output).map(|(_, major)| major)
}

/// Classify a probe's captured output. `None` when no version token is present
/// (the caller turns that into [`OpenCodeVersion::Undetermined`]).
///
/// `output` should carry stdout and stderr (the probe concatenates them) so a
/// runtime that prints its version on the error stream still parses.
pub fn classify_output(output: &str) -> Option<OpenCodeVersion> {
    parse_version(output).map(|(raw, major)| {
        if major >= MIN_SUPPORTED_OPENCODE_MAJOR {
            OpenCodeVersion::Supported { raw, major }
        } else {
            OpenCodeVersion::Unsupported { raw, major }
        }
    })
}

/// The version token and its major: a dotted token anywhere, else a bare major
/// that is the entire output.
fn parse_version(output: &str) -> Option<(String, u32)> {
    for token in output.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
        if token.contains('.') {
            if let Some(found) = version_from_token(token) {
                return Some(found);
            }
        }
    }

    // A bare major ("2", "v2", "opencode 2") is tolerated only as the WHOLE
    // output — a stray digit in prose must not read as a version.
    let mut whole = output.trim();
    for prefix in ["opencode cli", "opencode"] {
        let head = match whole.get(..prefix.len()) {
            Some(head) => head,
            None => continue,
        };
        if head.eq_ignore_ascii_case(prefix) {
            whole = whole[prefix.len()..].trim();
            break;
        }
    }
    let whole = match whole.strip_prefix('v').or_else(|| whole.strip_prefix('V')) {
        Some(rest) => rest.trim(),
        None => whole,
    };
    if !whole.is_empty() && whole.chars().all(|c| c.is_ascii_digit()) {
        let major = whole.parse::<u32>().ok()?;
        return Some((whole.to_string(), major));
    }
    None
}

/// One dot-separated numeric token (1–3 components, each non-empty digits) →
/// the token and its major. Anything else is not a version.
fn version_from_token(token: &str) -> Option<(String, u32)> {
    let token = token.trim_matches('.');
    if token.is_empty() {
        return None;
    }
    let mut parts = token.split('.');
    let first = parts.next()?;
    if !is_numeric(first) {
        return None;
    }
    let mut components = 1;
    for part in parts {
        if !is_numeric(part) {
            return None;
        }
        components += 1;
        if components > 3 {
            return None;
        }
    }
    let major = first.parse::<u32>().ok()?;
    Some((token.to_string(), major))
}

fn is_numeric(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

// ── The probe (bounded, side-effect free) ────────────────────────────────────

/// Probe the `opencode` on PATH.
///
/// Bounded by [`VERSION_PROBE_TIMEOUT_MS`], never mutates anything, and reuses
/// the Terminal launch rule for Windows shims (`.cmd`/`.bat` go through
/// `cmd.exe /C` — `CreateProcessW` cannot execute them).
pub fn probe() -> OpenCodeVersion {
    match resolve_opencode_binary() {
        Some(binary) => probe_binary(&binary),
        None => OpenCodeVersion::Undetermined {
            detail: format!("the `opencode` binary could not be resolved on PATH ({OPENCODE_VERSION_ARG})"),
        },
    }
}

/// Probe one already-resolved binary — the executable core of [`probe`].
pub fn probe_binary(binary: &str) -> OpenCodeVersion {
    let output = match run_bounded(
        probe_command(binary),
        Duration::from_millis(VERSION_PROBE_TIMEOUT_MS),
    ) {
        Ok(output) => output,
        Err(detail) => return OpenCodeVersion::Undetermined { detail },
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        let code = match output.status.code() {
            Some(code) => code.to_string(),
            None => "terminated by a signal".to_string(),
        };
        return OpenCodeVersion::Undetermined {
            detail: format!("`opencode {OPENCODE_VERSION_ARG}` exited with {code}"),
        };
    }

    match classify_output(&format!("{stdout}\n{stderr}")) {
        Some(version) => version,
        None => OpenCodeVersion::Undetermined {
            detail: format!(
                "`opencode {OPENCODE_VERSION_ARG}` printed no recognisable version (output: {})",
                first_line(&format!("{stdout}\n{stderr}"))
            ),
        },
    }
}

/// The command that runs the probe for `binary`, honouring the Windows shim
/// rule (`cmd.exe /C` for `.cmd`/`.bat`).
fn probe_command(binary: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let lower = binary.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut command = Command::new("cmd.exe");
            command.arg("/C");
            command.arg(binary);
            command.arg(OPENCODE_VERSION_ARG);
            return command;
        }
    }

    let mut command = Command::new(binary);
    command.arg(OPENCODE_VERSION_ARG);
    command
}

/// The Windows candidate order Terminal uses (`opencode.exe`, `.cmd`, `.bat`,
/// bare); on other platforms the extension probes miss harmlessly.
fn resolve_opencode_binary() -> Option<String> {
    const CANDIDATES: [&str; 4] = ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"];
    CANDIDATES.iter().find_map(|candidate| where_first(candidate))
}

/// Run `where` (Windows) / `which` (Unix) and return the first matching path.
fn where_first(name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    let finder = "where";
    #[cfg(not(target_os = "windows"))]
    let finder = "which";

    Command::new(finder)
        .arg(name)
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.lines().next().map(|line| line.trim().to_string()))
        .filter(|line| !line.is_empty())
}

/// Run `command` with a hard timeout and captured output.
///
/// Declared, accepted duplication of `applications::terminal::resume::run_bounded`:
/// `infrastructure/` must not import from an application, and this probe needs
/// only this small bounded runner. stdin is null so a CLI cannot block on a
/// prompt; the child is killed at the deadline (NFR-3).
fn run_bounded(mut command: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run the version probe: {e}"))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut pipe) = stdout_pipe.take() {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            let _ = out_tx.send(buffer);
        });
    }
    if let Some(mut pipe) = stderr_pipe.take() {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            let _ = err_tx.send(buffer);
        });
    }

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "`opencode {OPENCODE_VERSION_ARG}` did not finish within {VERSION_PROBE_TIMEOUT_MS} ms"
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("could not run the version probe: {e}")),
        }
    };

    let stdout = out_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "reading the version probe's stdout timed out".to_string())?;
    let stderr = err_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "reading the version probe's stderr timed out".to_string())?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// The first non-blank line, truncated — keeps an R-1b detail readable.
fn first_line(output: &str) -> String {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no output");
    if line.chars().count() > 120 {
        let truncated: String = line.chars().take(120).collect();
        format!("{truncated}…")
    } else {
        line.to_string()
    }
}

// ── Message rendering (derived from the constants) ──────────────────────────

/// `None` for [`OpenCodeVersion::Supported`]; the R-1a / R-1b message
/// otherwise. Every rendered string derives from the constants above, so the
/// copy can never drift from the value the gate enforces.
pub fn version_message(version: &OpenCodeVersion) -> Option<String> {
    match version {
        OpenCodeVersion::Supported { .. } => None,
        OpenCodeVersion::Unsupported { raw, .. } => {
            let min = MIN_SUPPORTED_OPENCODE_MAJOR.to_string();
            Some(render(
                OPENCODE_VERSION_UNSUPPORTED_MSG,
                &[
                    ("{found}", raw.as_str()),
                    ("{min}", min.as_str()),
                    ("{upgrade}", OPENCODE_UPGRADE_COMMAND),
                ],
            ))
        }
        OpenCodeVersion::Undetermined { detail } => Some(render(
            OPENCODE_VERSION_UNDETERMINED_MSG,
            &[("{detail}", detail.as_str())],
        )),
    }
}

/// R-2b: the single `[fredo] ` success line naming the resolved destination.
pub fn plugin_installed_message(path: &Path) -> String {
    render(
        PLUGIN_INSTALLED_GLOBAL_MSG,
        &[("{path}", path.display().to_string().as_str())],
    )
}

/// R-3d: the blocked-launch message for an OpenCode start failure.
pub fn terminal_blocked_message(cause: &str) -> String {
    render(TERMINAL_OPENCODE_BLOCKED_MSG, &[("{cause}", cause)])
}

/// Substitute `{placeholder}` pairs in a message template.
fn render(template: &str, substitutions: &[(&str, &str)]) -> String {
    let mut rendered = template.to_string();
    for (placeholder, value) in substitutions {
        rendered = rendered.replace(placeholder, value);
    }
    rendered
}

// ── Plugin path helpers (the twins ST-2/ST-3 replace) ───────────────────────

/// The GLOBAL plugins directory for `home` (`<home>/.config/opencode/plugins`).
pub fn plugins_dir(home: &Path) -> PathBuf {
    let mut path = home.to_path_buf();
    for segment in FREDO_GLOBAL_PLUGINS_SUBDIR {
        path.push(segment);
    }
    path
}

/// The installed plugin file — a flat `.js` directly in the plugins directory.
pub fn plugin_install_path(home: &Path) -> PathBuf {
    plugins_dir(home).join(FREDO_PLUGIN_INSTALL_FILENAME)
}

/// `true` when the plugin file exists. Reads only; never creates the directory.
pub fn is_plugin_installed(home: &Path) -> bool {
    plugin_install_path(home).exists()
}

/// The plugin BUILD artifact inside a plugin source directory.
pub fn plugin_artifact_path(source_dir: &Path) -> PathBuf {
    source_dir.join(FREDO_PLUGIN_ARTIFACT_REL)
}

/// Resolve the plugin source directory: the adjacent workspace checkout first
/// (dev/debug machines), then the packaged `<resource_dir>/plugin` when an
/// `AppHandle` is available. Fails loud — a missing source is never a silent
/// skip.
pub fn resolve_plugin_source_dir(app: Option<&AppHandle>) -> Result<PathBuf, String> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("apps/opencode-plugin");
    let workspace = workspace.canonicalize().unwrap_or(workspace);
    if workspace.exists() {
        return Ok(workspace);
    }

    if let Some(app) = app {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("could not resolve the resource directory: {e}"))?;
        let packaged = resource_dir.join("plugin");
        if packaged.exists() {
            return Ok(packaged);
        }
        return Err(format!(
            "Plugin source directory not found: {} (no packaged copy at {})",
            workspace.display(),
            packaged.display()
        ));
    }

    Err(format!(
        "Plugin source directory not found: {}",
        workspace.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_major: the tolerant rule ──────────────────────────────────────

    #[test]
    fn parses_a_plain_semver() {
        assert_eq!(parse_major("2.4.1"), Some(2));
    }

    #[test]
    fn parses_a_v_prefixed_version() {
        assert_eq!(parse_major("v2.4.1"), Some(2));
    }

    #[test]
    fn parses_the_recorded_runtime_output() {
        // The literal probe record from OpenCode 2.4.1 (ST-1 dev-verify).
        assert_eq!(parse_major("opencode v2.4.1"), Some(2));
    }

    #[test]
    fn parses_a_labelled_version_and_two_components() {
        assert_eq!(parse_major("OpenCode CLI v2.4"), Some(2));
        assert_eq!(parse_major("OpenCode 1.15.5"), Some(1));
    }

    #[test]
    fn parses_a_bare_major() {
        assert_eq!(parse_major("2"), Some(2));
        assert_eq!(parse_major("v2\n"), Some(2));
        assert_eq!(parse_major("opencode 2"), Some(2));
    }

    #[test]
    fn unparseable_output_yields_none() {
        assert_eq!(parse_major("hello from a fake cli"), None);
        assert_eq!(parse_major(""), None);
        assert_eq!(parse_major("   \n "), None);
        // A stray number in prose is not a version (a bare major must be the
        // whole output; 4 components is not a version token).
        assert_eq!(parse_major("exit code 1"), None);
        assert_eq!(parse_major("listening on 127.0.0.1:4317"), None);
    }

    // ── classify_output: the three states ───────────────────────────────────

    #[test]
    fn classifies_the_supported_major() {
        let version = classify_output("opencode v2.4.1").expect("a version token");
        assert_eq!(
            version,
            OpenCodeVersion::Supported {
                raw: "2.4.1".to_string(),
                major: 2,
            }
        );
        assert!(version.is_supported());
        assert_eq!(version.raw(), Some("2.4.1"));
        assert_eq!(version.major(), Some(2));
    }

    #[test]
    fn classifies_a_supported_future_major() {
        let version = classify_output("opencode v3.0.0").expect("a version token");
        assert!(version.is_supported());
        assert_eq!(version.major(), Some(3));
    }

    #[test]
    fn classifies_the_too_old_major() {
        // The QA fixture's line for shim-opencode-1x.
        let version = classify_output("OpenCode 1.15.5").expect("a version token");
        assert_eq!(
            version,
            OpenCodeVersion::Unsupported {
                raw: "1.15.5".to_string(),
                major: 1,
            }
        );
        assert!(!version.is_supported());
        assert_eq!(version.raw(), Some("1.15.5"));
    }

    #[test]
    fn unparseable_output_is_not_classified() {
        assert_eq!(classify_output("hello from a fake cli"), None);
        assert_eq!(classify_output(""), None);
    }

    #[test]
    fn the_gate_reads_the_minimum_constant() {
        // A major exactly at the minimum is supported; one below is not — both
        // derived from the constant, so a moved value cannot silently invert.
        let at_minimum = format!("opencode {MIN_SUPPORTED_OPENCODE_MAJOR}.0.0");
        let version = classify_output(&at_minimum).expect("a version token");
        assert!(version.is_supported());

        if MIN_SUPPORTED_OPENCODE_MAJOR > 0 {
            let below = format!("opencode {}.0.0", MIN_SUPPORTED_OPENCODE_MAJOR - 1);
            let version = classify_output(&below).expect("a version token");
            assert!(!version.is_supported());
        }
    }

    // ── version_message: rendered from the constants ────────────────────────

    #[test]
    fn supported_has_no_message() {
        let version = OpenCodeVersion::Supported {
            raw: "2.4.1".to_string(),
            major: 2,
        };
        assert_eq!(version_message(&version), None);
    }

    #[test]
    fn the_too_old_message_names_the_found_version_the_minimum_and_the_upgrade() {
        let version = OpenCodeVersion::Unsupported {
            raw: "1.15.5".to_string(),
            major: 1,
        };
        let message = version_message(&version).expect("a gate message");
        assert!(message.contains("1.15.5"), "found version: {message}");
        assert!(
            message.contains(&format!("{MIN_SUPPORTED_OPENCODE_MAJOR}.x")),
            "required major rendered from the constant: {message}"
        );
        assert!(
            message.contains(OPENCODE_UPGRADE_COMMAND),
            "the upgrade constant must appear verbatim: {message}"
        );
        assert!(
            message.contains("fredo setup --check"),
            "the re-run remedy: {message}"
        );
        // It is a gate error, not an install hint: the false "not installed"
        // framing must never appear here.
        assert!(!message.contains("not installed"));
        assert!(!message.contains(OPENCODE_INSTALL_DOCS_URL));
        // The runtime rejects `--major` (ST-1 probe: `opencode upgrade --help`
        // takes a positional target + `--method`), so the copy must be bare.
        assert!(
            !message.contains("--major"),
            "the message must never name a flag the runtime rejects: {message}"
        );
    }

    #[test]
    fn the_upgrade_command_is_the_bare_verb_the_runtime_accepts() {
        // The selector is a POSITIONAL target in `opencode upgrade --help`, so
        // the one command constant carries no flag at all — every message that
        // renders it follows, which is why the flag can never reappear in copy.
        assert_eq!(OPENCODE_UPGRADE_COMMAND, "opencode upgrade");
        assert!(!OPENCODE_UPGRADE_COMMAND.contains("--"));
        assert!(!OPENCODE_VERSION_UNSUPPORTED_MSG.contains("--major"));
    }

    #[test]
    fn the_undetermined_message_names_the_probe_failure_and_the_remedy() {
        let version = OpenCodeVersion::Undetermined {
            detail: "`opencode --version` exited with 1".to_string(),
        };
        let message = version_message(&version).expect("an error message");
        assert!(message.contains("exited with 1"), "probe detail: {message}");
        assert!(
            message.contains("opencode --version"),
            "the diagnostic command: {message}"
        );
        assert!(message.contains("fredo setup --check"), "the remedy: {message}");
        // Never "not installed" (false) and never a pass.
        assert!(!message.contains("not installed"));
        assert!(!message.contains("Install from"));
    }

    #[test]
    fn every_template_placeholder_is_substituted() {
        for message in [
            version_message(&OpenCodeVersion::Unsupported {
                raw: "1.15.5".to_string(),
                major: 1,
            }),
            version_message(&OpenCodeVersion::Undetermined {
                detail: "no output".to_string(),
            }),
            Some(plugin_installed_message(Path::new(
                r"C:\Users\x\.config\opencode\plugins\fredo.js",
            ))),
            Some(terminal_blocked_message("the process exited immediately")),
        ] {
            let message = message.expect("a rendered message");
            assert!(!message.contains('{'), "unsubstituted placeholder: {message}");
            assert!(!message.contains('}'), "unsubstituted placeholder: {message}");
        }
    }

    #[test]
    fn the_success_line_is_prefixed_and_names_the_destination_as_global() {
        let path = Path::new(r"C:\Users\x\.config\opencode\plugins\fredo.js");
        let message = plugin_installed_message(path);
        assert!(message.starts_with("[fredo] "), "{message}");
        assert!(message.contains("fredo.js"), "{message}");
        assert!(message.contains("global"), "{message}");
    }

    #[test]
    fn the_blocked_message_names_the_cause_and_the_remedy() {
        let message = terminal_blocked_message("the process exited immediately");
        assert!(message.contains("the process exited immediately"), "{message}");
        assert!(message.contains("reopen Terminal"), "{message}");
    }

    // ── The plugin path helpers ─────────────────────────────────────────────

    #[test]
    fn the_install_path_is_the_flat_global_file() {
        let home = Path::new(r"C:\Users\x");
        assert_eq!(
            plugins_dir(home),
            home.join(".config").join("opencode").join("plugins")
        );
        assert_eq!(plugin_install_path(home), plugins_dir(home).join("fredo.js"));
    }

    #[test]
    fn is_plugin_installed_reads_without_creating_the_directory() {
        let dir = tempfile::tempdir().expect("a temp dir");
        assert!(!is_plugin_installed(dir.path()));
        assert!(!plugins_dir(dir.path()).exists());
    }

    #[test]
    fn is_plugin_installed_detects_the_installed_file() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let plugins = plugins_dir(dir.path());
        std::fs::create_dir_all(&plugins).expect("create the plugins dir");
        std::fs::write(plugin_install_path(dir.path()), "// bundle").expect("write the plugin");
        assert!(is_plugin_installed(dir.path()));
    }

    #[test]
    fn the_artifact_path_is_relative_to_the_source_dir() {
        let source = Path::new("/repo/apps/opencode-plugin");
        assert_eq!(
            plugin_artifact_path(source),
            source.join("dist").join("index.js")
        );
        assert!(!FREDO_PLUGIN_ARTIFACT_REL.is_empty());
    }
}
