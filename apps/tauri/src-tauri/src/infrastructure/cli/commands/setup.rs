use clap::Parser;
use std::path::{Path, PathBuf};

use crate::applications::setup::model_download::{
    download_missing_files, DownloadProgress, ProgressReporter, ProgressState, ReqwestTransport,
    SystemClock,
};
use crate::applications::setup::model_download_state::{default_manifest, probe_files, FileState};
use crate::infrastructure::opencode_service;
use crate::infrastructure::opencode_version::{
    self, is_plugin_installed, plugin_artifact_path, plugin_install_path, plugin_installed_message,
    plugins_dir, resolve_plugin_source_dir, version_message, OpenCodeVersion,
    MIN_SUPPORTED_OPENCODE_MAJOR,
};

/// Check or perform Fredo setup operations
///
/// Run without flags to see available options.
/// Combine with --check to inspect all setup steps,
/// or use individual flags to perform specific actions.
#[derive(Parser, Debug)]
pub struct SetupArgs {
    /// Check setup status of all steps (PATH, opencode, plugin, model, otel)
    #[arg(long)]
    pub check: bool,

    /// Add Fredo CLI binary directory to the system PATH
    #[arg(long)]
    pub add_to_path: bool,

    /// Install the Fredo plugin for OpenCode into the global plugins directory
    /// (no OTEL environment is written). Writes one hash-guarded file and stops
    /// there — OpenCode loads the installed plugin itself, so no part of the
    /// install restarts its background service.
    #[arg(long)]
    pub install_plugin: bool,

    /// Download model files (GGUF + mmproj) from Hugging Face
    #[arg(long)]
    pub download_model: bool,
}

// ── CLI helpers ────────────────────────────────────────────────────────────────

fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

/// Return the canonical BASE models directory — the same `{home}/fredo-models`
/// fallback the app uses. The manifest `subdir` (`gemma-4-e2b-it-qat`) is
/// appended by the shared engine, keeping the CLI layout identical to the app.
fn resolve_models_dir() -> PathBuf {
    home_dir().join("fredo-models")
}

/// Mirror the in-app `setup:download-progress` lifecycle onto stderr.
struct CliProgressReporter;

impl ProgressReporter for CliProgressReporter {
    fn report(&self, progress: DownloadProgress) {
        match progress.state {
            ProgressState::Downloading => {
                eprint!(
                    "\r[fredo] Downloading {}... {:.1}%",
                    progress.file, progress.percent
                );
            }
            ProgressState::Present => {
                eprintln!("\r[fredo] {} ready.", progress.file);
            }
            ProgressState::Skipped => {
                eprintln!("[fredo] {} already present, skipping.", progress.file);
            }
            ProgressState::Error => {
                eprintln!("\r[fredo] {} failed.", progress.file);
            }
        }
    }
}

/// Fail a setup step: the reason must reach the caller.
///
/// The CLI installs no `tracing` subscriber, so `tracing::error!` on this path
/// is silent — the message is written to stderr (the CLI's error channel; stdout
/// is the machine-readable `--check` JSON) and the process exits 1 ("a failed
/// step", the CLI's documented failure code).
fn fail_step(message: &str) -> ! {
    tracing::error!(target: "fredo::cli", error = %message, "setup step error");
    eprintln!("{message}");
    std::process::exit(1)
}

// ── `--check` steps (pure: the probe result is an argument, never re-probed) ──

/// The `opencode` step: the version gate IS the status.
///
/// R-1a/R-1b: an installed-but-unsupported (or undeterminable) runtime is an
/// **error** naming the found version and the one-command remedy — never
/// `missing` (the binary exists and runs; "Install from …" would be false) and
/// never `ok` (the false pass this slice exists to remove).
fn opencode_step(version: &OpenCodeVersion) -> serde_json::Value {
    match version_message(version) {
        Some(detail) => serde_json::json!({ "status": "error", "detail": detail }),
        None => serde_json::json!({
            "status": "ok",
            "detail": "OpenCode CLI is installed.",
        }),
    }
}

/// The `plugin` step. A plugin cannot be verified against a runtime that fails
/// the gate, and saying "not installed" there would repeat the false claim the
/// gate just replaced.
fn plugin_step(version: &OpenCodeVersion, plugin_installed: bool) -> serde_json::Value {
    if !version.is_supported() {
        let min = MIN_SUPPORTED_OPENCODE_MAJOR;
        return serde_json::json!({
            "status": "error",
            "detail": format!("OpenCode {min}.x is required — the Fredo plugin was not checked."),
        });
    }
    if plugin_installed {
        serde_json::json!({"status": "ok", "detail": "Fredo plugin is installed."})
    } else {
        serde_json::json!({"status": "missing", "detail": "Fredo plugin not installed."})
    }
}

/// The `otel` step. R-2c: nothing is configured any more — OpenCode 2 loads the
/// global plugin, which is the capture point — so the honest state is `ok`, never
/// `missing` and never a bare "configured".
///
/// R-2e′: the detail comes from the SAME constant the in-app twin renders, so no
/// sentence is duplicated between the surfaces. It claims the mechanism only:
/// round 3 removed the install-time restart, so the step reports no lifecycle
/// outcome — and has no restart failure to hide.
fn otel_step(plugin_installed: bool) -> serde_json::Value {
    let detail = if plugin_installed {
        crate::applications::setup::commands::OTEL_CAPTURE_MECHANISM_MSG
    } else {
        crate::applications::setup::commands::OTEL_NOT_REQUIRED_MSG
    };
    serde_json::json!({ "status": "ok", "detail": detail })
}

/// The `--check` payload.
///
/// The five shipped keys are unchanged. `opencode_version` is an **absent key**
/// when the probe established none (G-413: never an explicit `null`), and
/// `opencode_min_major` always carries the enforced minimum.
fn check_payload(
    fredo_path: serde_json::Value,
    version: &OpenCodeVersion,
    plugin_installed: bool,
    model: serde_json::Value,
) -> serde_json::Value {
    let mut payload = serde_json::Map::new();
    payload.insert("fredo_path".to_string(), fredo_path);
    payload.insert("opencode".to_string(), opencode_step(version));
    payload.insert(
        "plugin".to_string(),
        plugin_step(version, plugin_installed),
    );
    payload.insert("model".to_string(), model);
    payload.insert("otel".to_string(), otel_step(plugin_installed));
    if let Some(raw) = version.raw() {
        payload.insert(
            "opencode_version".to_string(),
            serde_json::Value::String(raw.to_string()),
        );
    }
    payload.insert(
        "opencode_min_major".to_string(),
        serde_json::json!(MIN_SUPPORTED_OPENCODE_MAJOR),
    );
    serde_json::Value::Object(payload)
}

/// The exit code for `--check`: 0 when the runtime passes the gate, 1 when it
/// does not (the gate is the one hard blocker — the advisory steps above keep
/// their existing, non-fatal statuses).
fn check_exit_code(version: &OpenCodeVersion) -> i32 {
    if version.is_supported() {
        0
    } else {
        1
    }
}

// ── `--install-plugin` helpers ────────────────────────────────────────────────

/// The plugin bundle for `source_dir`, running the one documented build step
/// only when the bundle is absent. Fails loud — a missing artifact is never
/// skipped silently.
fn ensure_plugin_artifact(source_dir: &Path) -> Result<PathBuf, String> {
    let artifact = plugin_artifact_path(source_dir);
    if artifact.exists() {
        return Ok(artifact);
    }

    let build_output = std::process::Command::new("bun")
        .args(["build", "src/index.ts", "--outdir", "dist", "--target", "bun"])
        .current_dir(source_dir)
        .output()
        .map_err(|e| format!("Failed to run bun build: {e}"))?;

    if !build_output.status.success() {
        let stderr = String::from_utf8_lossy(&build_output.stderr);
        return Err(format!("The plugin build failed: {}", stderr.trim()));
    }
    if !artifact.exists() {
        return Err(format!(
            "The plugin build produced no artifact at {}",
            artifact.display()
        ));
    }
    Ok(artifact)
}

/// Copy the built bundle to the GLOBAL plugins directory and return the
/// installed path plus whether this call wrote bytes. The directory is created on
/// this (success) path only, so a gated run leaves it untouched.
///
/// The copy rule itself is `opencode_service::install_plugin_file` — the SAME one
/// the in-app command calls, so the hash guard cannot diverge between the twins.
fn install_artifact(artifact: &Path, home: &Path) -> Result<(PathBuf, bool), String> {
    let destination = plugin_install_path(home);
    std::fs::create_dir_all(plugins_dir(home))
        .map_err(|e| format!("Could not create the plugins directory: {e}"))?;
    let wrote_bytes = opencode_service::install_plugin_file(artifact, &destination).map_err(|e| {
        format!(
            "Failed to copy the plugin from {} to {}: {e}",
            artifact.display(),
            destination.display()
        )
    })?;
    Ok((destination, wrote_bytes))
}

/// The GATED install — the only path that may write.
///
/// R-1/R-1c: a failing version gate returns the rendered message BEFORE any
/// path is resolved, any build runs, or the plugins directory is created, so a
/// 1.x (or undeterminable) runtime installs nothing and leaves the destination
/// untouched.
fn install_gated(version: &OpenCodeVersion, home: &Path) -> Result<(PathBuf, bool), String> {
    if let Some(message) = version_message(version) {
        return Err(message);
    }
    let source_dir = resolve_plugin_source_dir(None)?;
    let artifact = ensure_plugin_artifact(&source_dir).map_err(|error| {
        format!(
            "Could not resolve the plugin artifact in {}: {error}",
            source_dir.display()
        )
    })?;
    install_artifact(&artifact, home)
}

/// Execute setup commands standalone (no IPC / no AppHandle).
pub async fn run_setup(args: &SetupArgs) -> anyhow::Result<()> {
    if args.check {
        let version = opencode_version::probe();
        let home = home_dir();
        let plugin_installed = is_plugin_installed(&home);

        // fredo-path
        let fredo_status = crate::applications::setup::commands::check_fredo_in_path();
        let fredo_path = if fredo_status.in_path {
            serde_json::json!({"status": "ok", "detail": "Fredo binary is in PATH."})
        } else {
            serde_json::json!({"status": "missing", "detail": format!("Not in PATH. Binary at: {}", fredo_status.binary_path)})
        };

        // opencode + plugin + otel are built from the ONE probe result.
        // model — same 3-file manifest + classifier as the in-app path.
        let manifest = default_manifest();
        let models_dir = resolve_models_dir();
        let files = probe_files(&models_dir, &manifest);
        let total = files.len();
        let present = files
            .iter()
            .filter(|status| status.state == FileState::Present)
            .count();
        let complete = total > 0 && present == total;
        let detail = if complete {
            "All required model files present.".to_string()
        } else {
            let missing: Vec<&str> = files
                .iter()
                .filter(|status| status.state != FileState::Present)
                .map(|status| status.relative_path.as_str())
                .collect();
            format!(
                "{present} of {total} model files present. Missing: {}",
                missing.join(", ")
            )
        };
        let model = serde_json::json!({
            "status": if complete { "ok" } else { "missing" },
            "detail": detail,
            "complete": complete,
            "files": files,
        });

        let result = check_payload(fredo_path, &version, plugin_installed, model);

        println!("{}", serde_json::to_string_pretty(&result)?);

        // The gate is the one hard blocker: report it through the exit code as
        // well as the JSON (1 = a failed step).
        let code = check_exit_code(&version);
        if code != 0 {
            std::process::exit(code);
        }
    }

    if args.add_to_path {
        let result = crate::applications::setup::commands::add_fredo_to_path();
        if result.success {
            println!("{}", result.output);
        } else {
            tracing::error!(target: "fredo::cli", error = %result.error.as_deref().unwrap_or("unknown error"), "setup step error");
            std::process::exit(1);
        }
    }

    if args.install_plugin {
        let version = opencode_version::probe();
        let home = home_dir();
        // Gate → hash-guarded copy. The copy is the whole install (R-2e′): no
        // child process is spawned and no service verb is run.
        let (destination, _wrote_bytes) =
            install_gated(&version, &home).unwrap_or_else(|error| fail_step(&error));

        // R-2b: exactly one `[fredo] ` stdout line naming the resolved
        // destination and stating the install is global.
        println!("{}", plugin_installed_message(&destination));
    }

    if args.download_model {
        // Delegate to the SAME manifest + streamed engine as the app
        // (skip-present / Range-resume / streaming SHA-256) — no duplicated URLs.
        let manifest = default_manifest();
        let models_dir = resolve_models_dir();
        std::fs::create_dir_all(models_dir.join(&manifest.subdir))
            .map_err(|e| anyhow::anyhow!("Failed to create models directory: {e}"))?;

        let transport = ReqwestTransport::new()
            .map_err(|e| anyhow::anyhow!("Failed to initialize the download client: {e}"))?;
        let outcome = download_missing_files(
            &transport,
            &manifest,
            &models_dir,
            &CliProgressReporter,
            &SystemClock,
        )
        .await;

        if !outcome.success {
            let error = outcome
                .error
                .clone()
                .unwrap_or_else(|| outcome.output.clone());
            anyhow::bail!("{error}");
        }

        tracing::info!(
            target: "fredo::cli",
            path = %models_dir.join(&manifest.subdir).display(),
            "model files ready"
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_dir_returns_non_empty_path() {
        let home = home_dir();
        assert!(
            !home.as_os_str().is_empty(),
            "home_dir should return a non-empty path"
        );
    }

    #[test]
    fn resolve_models_dir_is_the_fredo_models_base_dir() {
        let dir = resolve_models_dir();
        let dir_str = dir.to_string_lossy();
        assert!(
            dir_str.contains("fredo-models"),
            "models dir should contain 'fredo-models'"
        );
        assert!(
            !dir_str.contains("gemma-4-e2b-it-qat"),
            "the base dir must not bake in the manifest subdir"
        );
    }

    #[test]
    fn cli_uses_the_same_three_file_manifest_as_the_engine() {
        let manifest = default_manifest();
        let ids: Vec<&str> = manifest.files.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["model", "vision", "mtp"]);
        assert_eq!(manifest.subdir, "gemma-4-e2b-it-qat");
        assert!(manifest.files[2].path.starts_with("MTP/"));
    }

    // ── The CLI twin of the version gate (R-1a / R-1b / R-2b / R-2c) ────────
    // Every pin below is PURE: the probe result is an argument, so no test
    // depends on which `opencode` happens to be on the running host's PATH
    // (G-222) and none of them spawns `bun` or the real binary.

    /// The QA fixture's 1.x line (`OpenCode 1.15.5`).
    fn too_old() -> OpenCodeVersion {
        OpenCodeVersion::Unsupported {
            raw: "1.15.5".to_string(),
            major: 1,
        }
    }

    /// The recorded runtime shape (`opencode v2.4.1`).
    fn supported() -> OpenCodeVersion {
        OpenCodeVersion::Supported {
            raw: "2.4.1".to_string(),
            major: 2,
        }
    }

    /// The probe could not establish a version (`--version` exits 1, junk
    /// output, or a timeout).
    fn undetermined() -> OpenCodeVersion {
        OpenCodeVersion::Undetermined {
            detail: "`opencode --version` exited with 1".to_string(),
        }
    }

    /// A stand-in for a step payload the test does not read (`fredo_path`, `model`).
    fn sidecar() -> serde_json::Value {
        serde_json::json!({ "status": "ok" })
    }

    #[test]
    fn the_opencode_step_reports_error_naming_the_found_version_and_the_remedy() {
        let step = opencode_step(&too_old());
        assert_eq!(
            step["status"].as_str(),
            Some("error"),
            "a 1.x install is a gate error, never `ok`: {step}"
        );
        let detail = step["detail"].as_str().expect("a detail");
        // The copy IS the shared constant's rendering — the wire and the
        // message source cannot diverge.
        assert_eq!(
            Some(detail.to_string()),
            version_message(&too_old()),
            "the detail must be the shared version_message rendering"
        );
        assert!(detail.contains("1.15.5"), "names the found version: {detail}");
        assert!(
            detail.contains(&format!("{MIN_SUPPORTED_OPENCODE_MAJOR}.x")),
            "names the required major rendered from the constant: {detail}"
        );
        assert!(
            detail.contains("opencode upgrade"),
            "names the upgrade verb: {detail}"
        );
        assert!(
            detail.contains("fredo setup --check"),
            "names the re-run command: {detail}"
        );
        // Never the false claims: the binary IS installed, so neither the
        // "missing" framing nor an install-page hint may appear.
        assert!(!detail.contains("not installed"), "{detail}");
        assert!(!detail.contains("Install from"), "{detail}");
    }

    #[test]
    fn the_opencode_step_reports_error_when_the_version_is_undetermined() {
        let step = opencode_step(&undetermined());
        assert_eq!(
            step["status"].as_str(),
            Some("error"),
            "an undetermined version is an error, never `ok` and never `missing`: {step}"
        );
        let detail = step["detail"].as_str().expect("a detail");
        assert!(detail.contains("exited with 1"), "the probe's own failure: {detail}");
        assert!(
            detail.contains("opencode --version"),
            "names the diagnostic command: {detail}"
        );
        assert!(!detail.contains("not installed"), "{detail}");
    }

    #[test]
    fn the_opencode_step_keeps_the_shipped_pass_string_on_a_supported_runtime() {
        let step = opencode_step(&supported());
        assert_eq!(step["status"].as_str(), Some("ok"), "{step}");
        assert_eq!(
            step["detail"].as_str(),
            Some("OpenCode CLI is installed."),
            "the pass wording is unchanged (no docs/receipt churn)"
        );
    }

    #[test]
    fn the_check_payload_carries_the_found_version_and_the_enforced_minimum() {
        let payload = check_payload(sidecar(), &too_old(), false, sidecar());
        assert_eq!(
            payload["opencode_version"].as_str(),
            Some("1.15.5"),
            "the found version is carried: {payload}"
        );
        assert_eq!(
            payload["opencode_min_major"].as_u64(),
            Some(u64::from(MIN_SUPPORTED_OPENCODE_MAJOR)),
            "the minimum comes from the constant, never a literal: {payload}"
        );
    }

    #[test]
    fn an_undetermined_version_is_an_absent_key_never_null() {
        let payload = check_payload(sidecar(), &undetermined(), false, sidecar());
        assert!(
            payload.get("opencode_version").is_none(),
            "undetermined = ABSENT key (G-413): {payload}"
        );
        let wire = serde_json::to_string(&payload).expect("the payload serializes");
        assert!(
            !wire.contains("opencode_version"),
            "the serialized payload must not carry the key at all: {wire}"
        );
        assert!(
            payload.get("opencode_min_major").is_some(),
            "the minimum is always carried, even when the version is not: {payload}"
        );
    }

    #[test]
    fn the_check_payload_keeps_every_shipped_key_for_all_three_outcomes() {
        // Non-vacuity: the five shipped keys survive in EVERY probe outcome, so
        // an additive field can never displace one of them.
        for version in [supported(), too_old(), undetermined()] {
            let payload = check_payload(sidecar(), &version, false, sidecar());
            for key in ["fredo_path", "opencode", "plugin", "model", "otel"] {
                assert!(
                    payload.get(key).is_some(),
                    "`{key}` must survive for {version:?}: {payload}"
                );
            }
        }
    }

    #[test]
    fn the_otel_step_is_ok_and_names_the_capture_mechanism() {
        let step = otel_step(true);
        assert_eq!(
            step["status"].as_str(),
            Some("ok"),
            "R-2c/R-2e′: the telemetry step is ok (never `missing`): {step}"
        );
        let detail = step["detail"].as_str().expect("a detail");
        assert!(
            detail.contains("OpenCode loads the global plugin itself"),
            "the detail states the mechanism, never a bare `configured`: {detail}"
        );
        assert!(
            detail.contains("no OpenCode environment variable"),
            "the mechanism names the absent variable: {detail}"
        );
        assert!(
            !detail.to_lowercase().contains("restart"),
            "no lifecycle claim survives the removal: {detail}"
        );
    }

    /// R-2c: a machine without the plugin keeps the not-required wording — the
    /// `plugin` step owns the missing state, and the claim is still `ok`.
    #[test]
    fn the_otel_step_keeps_the_not_required_wording_without_a_plugin() {
        let step = otel_step(false);
        assert_eq!(step["status"].as_str(), Some("ok"), "{step}");
        let detail = step["detail"].as_str().expect("a detail");
        assert!(
            detail.contains("Not required"),
            "no plugin installed keeps the not-required wording: {detail}"
        );
        assert!(
            !detail.to_lowercase().contains("restart"),
            "the not-required wording carries no lifecycle claim: {detail}"
        );
    }

    #[test]
    fn the_plugin_step_never_claims_the_runtime_is_missing_when_the_gate_fails() {
        for version in [too_old(), undetermined()] {
            let step = plugin_step(&version, false);
            assert_eq!(step["status"].as_str(), Some("error"), "{step}");
            let detail = step["detail"].as_str().expect("a detail");
            assert!(
                detail.contains(&format!("{MIN_SUPPORTED_OPENCODE_MAJOR}.x")),
                "names the required major: {detail}"
            );
            assert!(
                !detail.contains("not installed"),
                "the binary IS installed — never the false framing: {detail}"
            );
        }
    }

    #[test]
    fn the_plugin_step_reports_installed_or_missing_behind_a_passing_gate() {
        assert_eq!(
            plugin_step(&supported(), true)["status"].as_str(),
            Some("ok")
        );
        assert_eq!(
            plugin_step(&supported(), false)["status"].as_str(),
            Some("missing")
        );
    }

    #[test]
    fn the_check_exit_code_is_non_zero_exactly_when_the_gate_fails() {
        assert_eq!(check_exit_code(&supported()), 0);
        assert_eq!(check_exit_code(&too_old()), 1, "a failed step exits 1");
        assert_eq!(
            check_exit_code(&undetermined()),
            1,
            "an undetermined version fails closed"
        );
    }

    #[test]
    fn the_gated_install_writes_nothing_when_the_gate_fails() {
        // R-1c: the version error returns BEFORE any path is resolved or any
        // directory is created — the plugins dir does not exist afterwards.
        let home = tempfile::tempdir().expect("a home dir");
        let error = install_gated(&too_old(), home.path())
            .expect_err("a 1.x runtime must not install anything");
        assert_eq!(
            Some(error),
            version_message(&too_old()),
            "the failure carries the rendered version message"
        );
        assert!(
            !plugins_dir(home.path()).exists(),
            "no plugins directory is created on the gated path"
        );

        let home = tempfile::tempdir().expect("a home dir");
        install_gated(&undetermined(), home.path()).expect_err("an undetermined version fails closed");
        assert!(
            !plugins_dir(home.path()).exists(),
            "no plugins directory is created on the undetermined path"
        );
    }

    #[test]
    fn the_install_copies_the_bundle_to_the_global_destination_and_names_it_once() {
        let source = tempfile::tempdir().expect("a source dir");
        let home = tempfile::tempdir().expect("a home dir");
        let artifact = plugin_artifact_path(source.path());
        std::fs::create_dir_all(artifact.parent().expect("the dist dir")).expect("create dist");
        std::fs::write(&artifact, "// fredo bundle").expect("write the bundle");

        let resolved =
            ensure_plugin_artifact(source.path()).expect("an existing bundle resolves as-is");
        assert_eq!(resolved, artifact, "no rebuild when the bundle is present");

        let (destination, wrote_bytes) =
            install_artifact(&resolved, home.path()).expect("the copy succeeds");
        assert_eq!(destination, plugin_install_path(home.path()));
        assert!(wrote_bytes, "a first install writes bytes");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read the installed bundle"),
            "// fredo bundle"
        );

        // NFR-1: the same artifact again writes nothing — the hash guard is what
        // makes a second setup run a no-op.
        let (again, wrote_again) =
            install_artifact(&resolved, home.path()).expect("the second copy succeeds");
        assert_eq!(again, destination);
        assert!(
            !wrote_again,
            "an unchanged re-install must report no write"
        );

        // R-2b: ONE line, `[fredo] `-prefixed, naming the resolved destination
        // and stating the install is global.
        let line = plugin_installed_message(&destination);
        assert!(line.starts_with("[fredo] "), "{line}");
        assert!(
            line.contains(&destination.display().to_string()),
            "names the resolved destination: {line}"
        );
        assert!(line.contains("global"), "{line}");
    }

    #[test]
    fn a_missing_bundle_fails_loud_instead_of_copying_nothing() {
        let source = tempfile::tempdir().expect("a source dir");
        let home = tempfile::tempdir().expect("a home dir");
        let error = install_artifact(&plugin_artifact_path(source.path()), home.path())
            .expect_err("a missing artifact is never a silent skip");
        assert!(error.contains("dist"), "names the artifact path: {error}");
        assert!(
            !plugin_install_path(home.path()).exists(),
            "no destination file is written when the copy fails"
        );
    }
}
