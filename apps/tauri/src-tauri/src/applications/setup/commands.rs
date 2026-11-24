use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::companion::models::{
    models_subdir, resolve_manifest, resolve_models_dir,
};
#[cfg(test)]
use crate::infrastructure::companion::models::default_manifest;
use crate::infrastructure::opencode_service;
use crate::infrastructure::opencode_version::{
    self, is_plugin_installed, plugin_artifact_path, plugin_install_path, plugin_installed_message,
    plugins_dir, resolve_plugin_source_dir, version_message, OpenCodeVersion,
    MIN_SUPPORTED_OPENCODE_MAJOR, OPENCODE_INSTALL_DOCS_URL,
};
use super::model_download::{
    download_missing_files, DownloadProgress, ModelDownloadOutcome, ProgressReporter,
    ReqwestTransport, SystemClock,
};
use super::model_download_state::{is_step_complete, probe_files, FileState, ModelFileStatus};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct CliCheckResult {
    /// `false` when the CLI is absent **or** its major is below
    /// [`MIN_SUPPORTED_OPENCODE_MAJOR`] — an installed-but-unusable binary.
    pub opencode: bool,
    pub opencode_plugin_installed: bool,
    /// The probe's trimmed version token (`2.4.1`). An **ABSENT KEY** when the
    /// version could not be determined — never `null`, never `""` (G-413).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode_version: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct InstallResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct FredoPathStatus {
    pub in_path: bool,
    pub binary_path: String,
}

#[derive(Serialize, Deserialize)]
pub struct SetupPlanStep {
    pub id: String,
    pub label: String,
    pub status: String,
    pub command: Option<String>,
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct SetupPlan {
    pub steps: Vec<SetupPlanStep>,
    /// `false` on R-1a (too old) and R-1b (undetermined) — the gate's answer.
    pub can_proceed: bool,
    pub opencode_docs_url: String,
    /// ABSENT KEY when undetermined (G-413).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode_version: Option<String>,
    /// [`MIN_SUPPORTED_OPENCODE_MAJOR`], rendered so the wizard never hard-codes it.
    pub opencode_min_major: u32,
}

#[derive(Serialize, Deserialize)]
pub struct StepStatus {
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct CheckAllSetupResult {
    pub fredo_path: StepStatus,
    /// `error` carries the rendered version message (R-1a/R-1b).
    pub opencode: StepStatus,
    pub plugin: StepStatus,
    pub model: StepStatus,
    /// `ok` + the not-required detail on OpenCode 2 (R-2c) — never `missing`.
    pub otel: StepStatus,
    /// ABSENT KEY when undetermined (G-413).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode_version: Option<String>,
    pub opencode_min_major: u32,
}

/// Extended `check_model_files` result. The legacy snake_case fields are
/// preserved verbatim for `SetupWizard.tsx`; `complete` + `files` are the
/// authoritative 3-file manifest status (#2856).
#[derive(Serialize)]
pub struct ModelFilesStatus {
    /// true iff EVERY manifest file is present-and-complete.
    pub complete: bool,
    /// Per-file status, ordered `model` → `vision` → `mtp`.
    pub files: Vec<ModelFileStatus>,
    pub gguf_exists: bool,
    pub mmproj_exists: bool,
    pub mtp_exists: bool,
    pub gguf_path: Option<String>,
    pub mmproj_path: Option<String>,
    pub mtp_path: Option<String>,
}

#[derive(Serialize)]
pub struct SetupStepResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

/// `download_model` wire result: the streamed engine outcome, named for the API
/// contract the UI consumes (additive `files` over the legacy `SetupStepResult`).
pub type ModelDownloadResult = ModelDownloadOutcome;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// R-2c: OpenCode 2 needs **no** receiver configuration. Since #3197 the capture
/// point is one global plugin, so the telemetry step is not-required rather than
/// missing — and no persistent variable is written anywhere.
pub const OTEL_NOT_REQUIRED_MSG: &str =
    "Not required — OpenCode telemetry is captured by the global Fredo plugin; \
     no OpenCode environment variables are needed.";

/// R-2e′: the bounded `otel` claim. It states the **mechanism** — how the plugin
/// reaches the runtime — instead of a bare "configured", and it claims no
/// lifecycle action: setup writes the file and nothing else, and OpenCode loads
/// the installed global plugin itself (F-17(a) / F-17(a′)).
pub const OTEL_CAPTURE_MECHANISM_MSG: &str =
    "Plugin installed. OpenCode loads the global plugin itself, so no OpenCode \
     environment variable is needed and setup changes nothing on a server that is already running.";

/// The `opencode_version` wire value for a probe result. `None` — an ABSENT KEY,
/// never `null`/`""` — when the version could not be determined (G-413).
fn version_wire(version: &OpenCodeVersion) -> Option<String> {
    version.raw().map(str::to_string)
}

/// (a) The CLI-check payload, pure over the probe so the gate is unit-testable
/// without spawning `opencode` (G-222). A CLI that is too old, or whose version
/// cannot be determined, is **not** `opencode: true`: the wizard would otherwise
/// render a 1.x machine as done.
fn cli_check_result_for(version: &OpenCodeVersion, plugin_installed: bool) -> CliCheckResult {
    let opencode = version.is_supported();
    CliCheckResult {
        opencode,
        // An installed-but-unusable CLI never reports a usable plugin.
        opencode_plugin_installed: opencode && plugin_installed,
        opencode_version: version_wire(version),
    }
}

/// (b) The `opencode` step. R-1a and R-1b both land on `error` carrying the
/// rendered gate message; only a supported major reads `ok`.
fn opencode_step_for(version: &OpenCodeVersion) -> StepStatus {
    match version_message(version) {
        None => StepStatus {
            status: "ok".into(),
            detail: Some("OpenCode CLI is installed.".into()),
        },
        Some(detail) => StepStatus {
            status: "error".into(),
            detail: Some(detail),
        },
    }
}

/// (b) The `plugin` step. A CLI that cannot run the plugin gates this step as
/// `error` — never `missing`, which would read as "install the plugin" on a
/// machine whose real problem is the CLI itself.
fn plugin_step_for(supported: bool, installed: bool) -> StepStatus {
    if !supported {
        StepStatus {
            status: "error".into(),
            detail: Some("OpenCode CLI is not usable — cannot verify the plugin.".into()),
        }
    } else if installed {
        StepStatus {
            status: "ok".into(),
            detail: Some("Fredo plugin is installed.".into()),
        }
    } else {
        StepStatus {
            status: "missing".into(),
            detail: Some("Fredo plugin not installed.".into()),
        }
    }
}

/// (b) The `otel` step — R-2c's not-required state, bounded by R-2e′: an
/// installed plugin reports the capture **mechanism** (never a bare
/// "configured"), and a machine without it keeps the not-required wording.
///
/// PURE over the install flag, so the whole table is unit-tested without touching
/// process-global state (G-222). There is no install-outcome record to consult:
/// round 3 removed the install-time restart, so the setup surfaces have no
/// lifecycle outcome to report — and no failure to hide.
fn otel_step_for(plugin_installed: bool) -> StepStatus {
    StepStatus {
        status: "ok".into(),
        detail: Some(if plugin_installed {
            OTEL_CAPTURE_MECHANISM_MSG.to_string()
        } else {
            OTEL_NOT_REQUIRED_MSG.to_string()
        }),
    }
}

/// (c) The `plugin-install` plan command: the **copy alone**. No environment
/// assignment of any kind — setup writes no persistent variable any more (R-2c)
/// — and the destination is ST-1's flat global `fredo.js`, so the filename has
/// ONE source. Never a command when the gate failed (R-1c) or the plugin is
/// already present.
fn plugin_install_command(
    supported: bool,
    installed: bool,
    artifact: &Path,
    destination: &Path,
) -> Option<String> {
    if !supported || installed {
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        Some(format!(
            "copy \"{}\" \"{}\"",
            artifact.display(),
            destination.display()
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Some(format!("cp {} {}", artifact.display(), destination.display()))
    }
}

/// A failed install whose `error` is the user-facing cause (never an empty
/// `output` that reads as success).
fn install_failure(error: String) -> InstallResult {
    InstallResult {
        success: false,
        output: String::new(),
        error: Some(error),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Returns the path to the plugin source directory so the UI can build the
/// install command string to type visibly in the terminal.
#[tauri::command]
pub fn get_plugin_source_path(app: AppHandle) -> Result<String, String> {
    // Workspace-first: dev/debug machines resolve their adjacent checkout;
    // the bundled resource dir only serves packaged deployments (issue #2758 F1).
    let ws = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("apps/opencode-plugin");
    let workspace = ws.canonicalize().unwrap_or(ws);
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let prod = resource_dir.join("plugin");
    let src = if workspace.exists() {
        workspace
    } else {
        prod
    };
    if !src.exists() {
        return Err(format!("Plugin source directory not found: {}", src.display()));
    }
    let raw = src.to_string_lossy().into_owned();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    Ok(stripped.replace('\\', "/"))
}

/// Check whether OpenCode CLI is installed **and supported**, and whether the
/// Fredo plugin is present.
#[tauri::command]
pub fn check_cli_installations(app: AppHandle) -> CliCheckResult {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let version = opencode_version::probe();
    cli_check_result_for(&version, is_plugin_installed(&home))
}

/// Returns a setup plan with steps for fredo-path, opencode-cli, and plugin-install.
/// Status is "skipped", "needed", or "blocked" based on detection results.
#[tauri::command]
pub fn get_setup_plan(app: AppHandle) -> SetupPlan {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let version = opencode_version::probe();
    let fredo_status = check_fredo_in_path();
    let plugin_installed = is_plugin_installed(&home);

    // The gate: an installed-but-too-old (or undeterminable) CLI cannot proceed
    // (R-1a/R-1b), and no plugin step may run — let alone copy — behind it (R-1c).
    let opencode_available = version.is_supported();
    let can_proceed = opencode_available;

    // Determine plugin source path for command strings (workspace-first,
    // mirroring install_plugin; resource dir is for packaged deployments only)
    let plugin_src = {
        let ws = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("apps/opencode-plugin");
        let workspace = ws.canonicalize().unwrap_or(ws);
        let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        let prod = resource_dir.join("plugin");
        if workspace.exists() {
            workspace
        } else {
            prod
        }
    };

    // Build steps
    let mut steps = Vec::new();

    // Step 1: fredo-path
    let fredo_path_status = if fredo_status.in_path {
        "skipped"
    } else {
        "needed"
    };
    let fredo_path_command = if fredo_status.in_path {
        None
    } else {
        #[cfg(target_os = "windows")]
        {
            let dir = fredo_status.binary_path.replace('\\', "/");
            let escaped = dir.replace('\'', "''");
            Some(format!(
                "$Dir = '{escaped}'\n$current = [System.Environment]::GetEnvironmentVariable('PATH', 'User')\nif (-not $current) {{ $current = '' }}\n$new = ($current.TrimEnd(';') + ';' + $Dir).TrimStart(';')\n[System.Environment]::SetEnvironmentVariable('PATH', $new, 'User')"
            ))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let dir = fredo_status.binary_path.replace('\\', "/");
            Some(format!(r#"export PATH="{dir}:$PATH""#))
        }
    };
    steps.push(SetupPlanStep {
        id: "fredo-path".to_string(),
        label: "Add Fredo CLI to PATH".to_string(),
        status: fredo_path_status.to_string(),
        command: fredo_path_command,
        detail: if fredo_status.in_path {
            Some("Fredo binary directory is already in PATH.".to_string())
        } else {
            Some(format!("Binary location: {}", fredo_status.binary_path))
        },
    });

    // Step 2: opencode-cli
    let opencode_cli_status = if opencode_available {
        "skipped"
    } else {
        "blocked"
    };
    steps.push(SetupPlanStep {
        id: "opencode-cli".to_string(),
        label: "Install OpenCode CLI".to_string(),
        status: opencode_cli_status.to_string(),
        command: Some(OPENCODE_INSTALL_DOCS_URL.to_string()),
        // On a 1.x machine the CLI IS installed: this detail is the gate message
        // (found version + required major + the bare upgrade verb), never an
        // "Install from …" line that is false for a binary that exists (R-1a).
        detail: Some(match version_message(&version) {
            None => "OpenCode CLI is installed.".to_string(),
            Some(message) => message,
        }),
    });

    // Step 3: plugin-build
    let artifact = plugin_artifact_path(&plugin_src);
    let needs_plugin_build = !artifact.exists();
    let plugin_build_status = if !opencode_available {
        "blocked"
    } else if !needs_plugin_build {
        "skipped"
    } else {
        "needed"
    };
    steps.push(SetupPlanStep {
        id: "plugin-build".to_string(),
        label: "Build Fredo Plugin".to_string(),
        status: plugin_build_status.to_string(),
        command: if !opencode_available || !needs_plugin_build {
            None
        } else {
            #[cfg(target_os = "windows")]
            {
                Some("cd \"{plugin_src}\" && bun build src/index.ts --outdir dist --target bun".to_string())
            }
            #[cfg(not(target_os = "windows"))]
            {
                Some(format!("cd \"{plugin_src}\" && bun build src/index.ts --outdir dist --target bun"))
            }
        },
        detail: if !opencode_available {
            Some("OpenCode CLI is not usable — fix the OpenCode step first.".to_string())
        } else if !needs_plugin_build {
            Some("Plugin dist already built.".to_string())
        } else {
            None
        },
    });

    // Step 4: plugin-install
    let plugin_status = if !opencode_available {
        "blocked"
    } else if plugin_installed {
        "skipped"
    } else {
        "needed"
    };
    let plugin_command = plugin_install_command(
        opencode_available,
        plugin_installed,
        &artifact,
        &plugin_install_path(&home),
    );
    steps.push(SetupPlanStep {
        id: "plugin-install".to_string(),
        label: "Install Fredo Plugin".to_string(),
        status: plugin_status.to_string(),
        command: plugin_command,
        detail: if plugin_installed {
            Some("Fredo plugin is already installed.".to_string())
        } else if !opencode_available {
            Some("OpenCode CLI is not usable — fix the OpenCode step first.".to_string())
        } else {
            None
        },
    });

    SetupPlan {
        steps,
        can_proceed,
        opencode_docs_url: OPENCODE_INSTALL_DOCS_URL.to_string(),
        opencode_version: version_wire(&version),
        opencode_min_major: MIN_SUPPORTED_OPENCODE_MAJOR,
    }
}

/// Install the Fredo plugin for OpenCode.
///
/// The install is ONE pass (R-2a): copy the artifact #3197 produced to the flat
/// global `fredo.js`. That copy is the WHOLE action — it is hash-guarded
/// (`opencode_service::install_plugin_file` — the SAME rule the CLI twin calls),
/// so an unchanged re-install writes nothing (NFR-1), and OpenCode loads the
/// installed plugin itself, so no part of setup starts, stops or restarts
/// OpenCode's background service (R-2e′) and no turn in progress is interrupted.
/// The version gate runs FIRST, so a refused install touches nothing — no
/// directory create, no overwrite (R-1c) — and a missing artifact fails loud
/// instead of reporting a silent skip. No persistent environment value is
/// written (R-2c).
#[tauri::command]
pub async fn install_plugin(app: AppHandle) -> InstallResult {
    // R-1a / R-1b / R-1c: gate before any filesystem work.
    let version = opencode_version::probe();
    if let Some(message) = version_message(&version) {
        tracing::warn!("install_plugin early-exit [version-gate]: {message}");
        return install_failure(message);
    }

    let home = match app.path().home_dir() {
        Ok(h)  => h,
        Err(e) => {
            let err = format!("Could not resolve home directory: {e}");
            tracing::warn!("install_plugin early-exit [home-dir]: {err}");
            return install_failure(err);
        }
    };

    // Workspace-first: prefer the adjacent checkout (dev/debug machines); fall back
    // to the bundled resource dir only for packaged deployments (issue #2758 F1).
    let src_dir = match resolve_plugin_source_dir(Some(&app)) {
        Ok(dir) => dir,
        Err(err) => {
            tracing::warn!("install_plugin early-exit [missing-src]: {err}");
            return install_failure(err);
        }
    };
    tracing::info!("install_plugin resolved source: {}", src_dir.display());

    // The artifact is #3197's build output — never built here. A missing artifact
    // is a loud failure: silently skipping the copy would report success with
    // nothing installed.
    let artifact = plugin_artifact_path(&src_dir);
    if !artifact.exists() {
        let err = format!(
            "Plugin artifact not found: {} (build it with `bun build src/index.ts --outdir dist --target bun`)",
            artifact.display()
        );
        tracing::warn!("install_plugin early-exit [missing-artifact]: {err}");
        return install_failure(err);
    }

    // OpenCode discovers local plugins as flat .js files in the global plugins
    // directory; the destination comes from ST-1's helpers so the filename has
    // one source.
    let plugins_directory = plugins_dir(&home);
    if let Err(e) = std::fs::create_dir_all(&plugins_directory) {
        let err = format!(
            "Could not create plugins directory {}: {e}",
            plugins_directory.display()
        );
        tracing::warn!("install_plugin early-exit [plugins-dir-create]: {err}");
        return install_failure(err);
    }
    tracing::info!(
        "install_plugin plugins directory ready: {}",
        plugins_directory.display()
    );

    let dest_file = plugin_install_path(&home);
    // ONE hash-guarded copy rule, shared with the CLI twin: the bytes are written
    // only when they differ, so an unchanged re-install is a no-op (NFR-1).
    if let Err(e) = opencode_service::install_plugin_file(&artifact, &dest_file) {
        let err = format!("Failed to copy plugin to {}: {e}", dest_file.display());
        tracing::warn!("install_plugin early-exit [copy]: {err}");
        return install_failure(err);
    }
    tracing::info!("install_plugin destination {}", dest_file.display());

    // R-2b: the one `[fredo] `-prefixed success line, naming the resolved
    // destination and stating the install is global (ST-1 renders it from
    // `PLUGIN_INSTALLED_GLOBAL_MSG`, so the copy and the constant cannot drift).
    //
    // The copy is the whole install (R-2e′): no child process is spawned, no
    // service verb is run, and OpenCode picks the installed plugin up itself.
    InstallResult {
        success: true,
        output: plugin_installed_message(&dest_file),
        error: None,
    }
}

/// Returns whether the `fredo` binary is reachable in PATH and the path of the
/// currently running executable.
#[tauri::command]
pub fn check_fredo_in_path() -> FredoPathStatus {
    let current_exe = std::env::current_exe().ok();
    let binary_path = current_exe
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let bin_dir = current_exe
        .as_ref()
        .and_then(|p| p.parent())
        .map(|d| d.canonicalize().unwrap_or_else(|_| d.to_path_buf()));

    let in_path = bin_dir.map(|dir| {
        #[cfg(target_os = "windows")]
        {
            let script = r#"
$user = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $user) { $user = '' }
$system = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
if (-not $system) { $system = '' }
Write-Output ($user + ';' + $system)
"#;
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", script])
                .output()
                .ok();
            if let Some(o) = out {
                let combined = String::from_utf8_lossy(&o.stdout).into_owned();
                combined.split(';').any(|entry| {
                    let entry = entry.trim();
                    if entry.is_empty() { return false; }
                    std::path::Path::new(entry)
                        .canonicalize()
                        .unwrap_or_else(|_| std::path::PathBuf::from(entry))
                        == dir
                })
            } else {
                false
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let dir_str = dir.to_string_lossy().into_owned();
            let home = dirs::home_dir().unwrap_or_default();
            let in_rc = [".bashrc", ".zshrc", ".profile"].iter().any(|rc| {
                let p = home.join(rc);
                std::fs::read_to_string(&p)
                    .map(|c| c.contains(&dir_str))
                    .unwrap_or(false)
            });
            let in_live_path = std::env::var("PATH").unwrap_or_default()
                .split(':')
                .any(|entry| {
                    std::path::Path::new(entry)
                        .canonicalize()
                        .unwrap_or_else(|_| std::path::PathBuf::from(entry))
                        == dir
                });
            in_rc || in_live_path
        }
    }).unwrap_or(false);

    FredoPathStatus { in_path, binary_path }
}

/// Adds the directory containing the current Fredo executable to the user's
/// persistent PATH.
#[tauri::command]
pub fn add_fredo_to_path() -> InstallResult {
    let binary_dir = match std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        Some(d) => d,
        None => return InstallResult {
            success: false,
            output: String::new(),
            error: Some("Cannot determine the Fredo binary directory.".into()),
        },
    };

    let dir_str = binary_dir.to_string_lossy().into_owned();

    #[cfg(target_os = "windows")]
    {
        // Inline the path directly — PowerShell -Command doesn't support
        // named parameter passing to inline script strings.
        let escaped = dir_str.replace('\'', "''"); // escape single quotes
        let script = format!(
            r#"$Dir = '{escaped}'
$current = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $current) {{ $current = '' }}
if ($current -split ';' | Where-Object {{ $_ -eq $Dir }}) {{
    Write-Output "already_in_path"
}} else {{
    $new = ($current.TrimEnd(';') + ';' + $Dir).TrimStart(';')
    [System.Environment]::SetEnvironmentVariable('PATH', $new, 'User')
    Write-Output "added"
}}"#
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output();

        match out {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout).trim().to_owned();
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_owned();
                if o.status.success() {
                    let msg = if stdout == "already_in_path" {
                        format!("{dir_str} is already in your PATH.")
                    } else {
                        format!("Added {dir_str} to your user PATH.\nRestart any open terminals for the change to take effect.")
                    };
                    InstallResult { success: true, output: msg, error: None }
                } else {
                    InstallResult {
                        success: false,
                        output: String::new(),
                        error: Some(if stderr.is_empty() { stdout } else { stderr }),
                    }
                }
            }
            Err(e) => InstallResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to run PowerShell: {e}")),
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return InstallResult {
                success: false,
                output: String::new(),
                error: Some("Cannot determine home directory.".into()),
            },
        };
        let export_line = format!("\nexport PATH=\"{}:$PATH\"\n", dir_str);
        let mut written_to: Vec<String> = Vec::new();
        let mut already_present = false;

        for rc in &[".bashrc", ".zshrc", ".profile"] {
            let rc_path = home.join(rc);
            if rc_path.exists() {
                match std::fs::read_to_string(&rc_path) {
                    Ok(content) if content.contains(&dir_str) => {
                        already_present = true;
                    }
                    Ok(_) => {
                        use std::io::Write;
                        if std::fs::OpenOptions::new()
                            .append(true)
                            .open(&rc_path)
                            .and_then(|mut f| f.write_all(export_line.as_bytes()))
                            .is_ok()
                        {
                            written_to.push(rc.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }

        if already_present && written_to.is_empty() {
            InstallResult {
                success: true,
                output: format!("{dir_str} is already in your PATH."),
                error: None,
            }
        } else if written_to.is_empty() {
            InstallResult {
                success: false,
                output: String::new(),
                error: Some("No shell rc files found (~/.bashrc, ~/.zshrc, ~/.profile). Add the export line manually.".into()),
            }
        } else {
            InstallResult {
                success: true,
                output: format!(
                    "Added {dir_str} to PATH in: {}.\nRestart your terminal for the change to take effect.",
                    written_to.join(", ")
                ),
                error: None,
            }
        }
    }
}

// ── OTel telemetry configuration commands ────────────────────────────────────
//
// Since #3197 the capture point is the ONE global plugin, so these commands stay
// in the wire surface by name but configure nothing: telemetry needs no
// per-machine environment.

#[derive(Serialize)]
pub struct OtelStatus {
    /// Whether the telemetry capture point is in place — the installed Fredo
    /// plugin (the retired environment-presence probe is gone; R-2c).
    pub opencode_configured: bool,
}

/// Check whether Fredo telemetry is in place for OpenCode: the global plugin.
///
/// The capture point is the installed global plugin file, so presence IS the
/// answer (R-2e′): there is no install-time lifecycle outcome left to qualify it
/// — the install writes a file and OpenCode loads it itself.
#[tauri::command]
pub fn check_otel_configured(app: AppHandle) -> OtelStatus {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    OtelStatus {
        opencode_configured: is_plugin_installed(&home),
    }
}

/// Explicitly configure telemetry for OpenCode.
///
/// An idempotent **no-op**: it writes nothing (no user-env write, no shell-profile
/// append — R-2c) and reports the not-required message. Kept as a command because
/// the wizard's telemetry step still invokes it by name.
#[tauri::command]
pub fn configure_otel(_app: AppHandle) -> InstallResult {
    InstallResult {
        success: true,
        output: OTEL_NOT_REQUIRED_MSG.to_string(),
        error: None,
    }
}

// ── New Setup Commands ─────────────────────────────────────────────────────────

/// The absolute path of the file with `id` when it exists on disk (legacy
/// `gguf_path`/`mmproj_path`/`mtp_path` semantics — existence only).
fn legacy_path(files: &[ModelFileStatus], id: &str) -> Option<String> {
    files
        .iter()
        .find(|status| status.id == id)
        .and_then(|status| status.path.clone())
}

/// Check all setup steps and return JSON status for each.
#[tauri::command]
pub fn check_all_setup(app: AppHandle) -> CheckAllSetupResult {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let version = opencode_version::probe();
    let plugin_installed = is_plugin_installed(&home);

    // fredo-path
    let fredo_status = check_fredo_in_path();
    let fredo_path = if fredo_status.in_path {
        StepStatus { status: "ok".into(), detail: Some("Fredo binary is in PATH.".into()) }
    } else {
        StepStatus { status: "missing".into(), detail: Some(format!("Not in PATH. Binary at: {}", fredo_status.binary_path)) }
    };

    // opencode — R-1a/R-1b: an installed-but-too-old (or undeterminable) CLI is
    // `error` with the rendered gate message, never `ok` and never `missing`.
    let opencode = opencode_step_for(&version);

    // plugin
    let plugin = plugin_step_for(version.is_supported(), plugin_installed);

    // model — derived from the same 3-file manifest as the acquisition surfaces,
    // so this step can never report ok on a partial/truncated set.
    let manifest = resolve_manifest(&app);
    let model_files = probe_files(&resolve_models_dir(&app), &manifest);
    let total = model_files.len();
    let present = model_files
        .iter()
        .filter(|status| status.state == FileState::Present)
        .count();
    let model = if total > 0 && present == total {
        StepStatus {
            status: "ok".into(),
            detail: Some("All required model files present.".into()),
        }
    } else {
        let missing: Vec<&str> = model_files
            .iter()
            .filter(|status| status.state != FileState::Present)
            .map(|status| status.relative_path.as_str())
            .collect();
        StepStatus {
            status: "missing".into(),
            detail: Some(format!(
                "{present} of {total} model files present — missing: {}",
                missing.join(", ")
            )),
        }
    };

    // otel — R-2c's not-required state, bounded by R-2e′: the detail states how
    // capture reaches the runtime, never a bare "configured" and never a
    // lifecycle claim setup does not perform.
    let otel = otel_step_for(plugin_installed);

    CheckAllSetupResult {
        fredo_path,
        opencode,
        plugin,
        model,
        otel,
        opencode_version: version_wire(&version),
        opencode_min_major: MIN_SUPPORTED_OPENCODE_MAJOR,
    }
}

/// Run a single setup step by ID.
/// Supported IDs: "fredo-path", "plugin-install"
#[tauri::command]
pub async fn run_setup_step(app: AppHandle, step_id: String) -> SetupStepResult {
    match step_id.as_str() {
        "fredo-path" => {
            let result = add_fredo_to_path();
            SetupStepResult {
                success: result.success,
                output: result.output,
                error: result.error,
            }
        }
        "plugin-install" => {
            let result = install_plugin(app).await;
            SetupStepResult {
                success: result.success,
                output: result.output,
                error: result.error,
            }
        }
        other => SetupStepResult {
            success: false,
            output: String::new(),
            error: Some(format!("Unknown setup step: {other}")),
        },
    }
}

/// Probe the three required model files from the resolved manifest. The legacy
/// snake_case fields remain (existence semantics for `SetupWizard.tsx`); the
/// authoritative honesty gate is `complete` (`files` all present).
#[tauri::command]
pub fn check_model_files(app: AppHandle) -> ModelFilesStatus {
    let manifest = resolve_manifest(&app);
    let models_dir = resolve_models_dir(&app);
    let files = probe_files(&models_dir, &manifest);
    let complete = is_step_complete(&models_dir, &manifest);

    let gguf_path = legacy_path(&files, "model");
    let mmproj_path = legacy_path(&files, "vision");
    let mtp_path = legacy_path(&files, "mtp");

    ModelFilesStatus {
        complete,
        gguf_exists: gguf_path.is_some(),
        mmproj_exists: mmproj_path.is_some(),
        mtp_exists: mtp_path.is_some(),
        gguf_path,
        mmproj_path,
        mtp_path,
        files,
    }
}

/// Bridges the streamed engine's progress sink onto the existing
/// `setup:download-progress` event (camelCase, additively richer payload).
struct AppHandleProgressReporter {
    app: AppHandle,
}

impl ProgressReporter for AppHandleProgressReporter {
    fn report(&self, progress: DownloadProgress) {
        if let Err(error) = self.app.emit("setup:download-progress", &progress) {
            tracing::debug!("failed to emit setup:download-progress: {error}");
        }
    }
}

/// Acquire every required model file that is not present-and-complete. Delegates
/// to the ST-2 streamed engine (skip-present / Range-resume / streaming SHA-256)
/// and returns the final per-file status. Legacy `success`/`output`/`error` are
/// retained; `files` is additive.
#[tauri::command]
pub async fn download_model(app: AppHandle) -> ModelDownloadResult {
    let manifest = resolve_manifest(&app);
    let models_dir = resolve_models_dir(&app);

    let transport = match ReqwestTransport::new() {
        Ok(transport) => transport,
        Err(error) => {
            return ModelDownloadResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to initialize the download client: {error}")),
                files: Vec::new(),
            };
        }
    };

    let reporter = AppHandleProgressReporter { app: app.clone() };
    download_missing_files(&transport, &manifest, &models_dir, &reporter, &SystemClock).await
}

// ── Companion readiness (Spec #2855; in-process runtime since #3141) ──────────
//
// ONE canonical prerequisite set for the Companion setup wizard. The backend
// owns the set; the frontend renders exactly what `check_companion_readiness`
// returns through its ordered `COMPANION_SETUP_STEPS` registry. Since #3141 the
// runtime ships inside Fredo, so the MODEL FILES are the ONLY prerequisite: the
// `llamaServer` prerequisite and the one-click winget install retired with the
// out-of-process `llama-server`.

/// **FS-2** test-only induction seam (Spec #3052 round 2; narrowed by #3141):
/// when set to a non-blank value other than `0`/`false`,
/// [`check_companion_readiness`] reports the `modelFiles` prerequisite as
/// `Missing`, so the never-installed companion state becomes live-drivable
/// in-repo without touching the machine-global install paths (G-275; mirrors the
/// sanctioned [`crate::applications::pg_supervisor::PG_FORCE_START_FAIL_ENV`]
/// precedent). It never affects the engine launch path. Inert when unset — the
/// default probe is byte-identical.
pub const COMPANION_FORCE_NOT_INSTALLED_ENV: &str = "FREDO_COMPANION_FORCE_NOT_INSTALLED";

/// Per-prerequisite state. `Error` = could not determine; `Missing` = determined absent.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PrerequisiteState {
    Installed,
    Missing,
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrerequisiteReport {
    /// Stable id: `"modelFiles"` is the ONLY id since #3141.
    pub id: String,
    pub state: PrerequisiteState,
    pub detail: String,
    pub resolved_path: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompanionReadiness {
    /// true iff EVERY prerequisite is `Installed` (never for Missing/Error).
    pub ready: bool,
    pub prerequisites: Vec<PrerequisiteReport>,
}

/// Aggregate the manifest probe into the `modelFiles` prerequisite. Pure — the
/// resolved manifest is the single source of required files, so a partial set
/// (or an empty manifest) can never read `Installed`.
///
/// A file that exists at the WRONG size is `FileState::Error`: the probe could
/// not determine a usable file, so the prerequisite reports `Error` (a
/// determination failure) rather than `Missing` (determined absent). The
/// frontend renders both as not-ready; the distinction keeps the detail honest.
fn model_files_prerequisite(
    files: &[ModelFileStatus],
    resolved_path: String,
) -> PrerequisiteReport {
    let total = files.len();
    let present = files
        .iter()
        .filter(|status| status.state == FileState::Present)
        .count();
    let errored = files
        .iter()
        .any(|status| status.state == FileState::Error);
    let complete = total > 0 && present == total;
    let (state, detail) = if complete {
        (
            PrerequisiteState::Installed,
            "All required model files present.".to_string(),
        )
    } else if errored {
        (
            PrerequisiteState::Error,
            format!("{present} of {total} model files usable — re-download the model files."),
        )
    } else {
        (
            PrerequisiteState::Missing,
            format!("{present} of {total} model files present."),
        )
    };
    PrerequisiteReport {
        id: "modelFiles".to_string(),
        state,
        detail,
        resolved_path: if complete { Some(resolved_path) } else { None },
    }
}

/// The pure **FS-2** forced-not-installed rule: `true` when
/// [`COMPANION_FORCE_NOT_INSTALLED_ENV`] is set to a non-blank value other than
/// `0`/`false`, else `false`. Split out so the lever contract is unit-testable
/// without mutating process-global environment state (G-222). Inert by default.
fn force_not_installed_with(value: Option<&str>) -> bool {
    match value {
        Some(value) => {
            let raw = value.trim();
            !raw.is_empty() && !raw.eq_ignore_ascii_case("0") && !raw.eq_ignore_ascii_case("false")
        }
        None => false,
    }
}

/// The **FS-2** forced `Missing` readiness report. The ONE `modelFiles`
/// prerequisite reports `Missing` with the seam named in `detail`, so the tester
/// can confirm the seam is active and the frontend derives both companion lines
/// `notSetUp`. Pure so the report shape is unit-pinned without an `AppHandle`
/// (G-222).
fn forced_not_installed_readiness() -> CompanionReadiness {
    let detail = format!("{COMPANION_FORCE_NOT_INSTALLED_ENV} is set: forced Missing (test seam)");
    CompanionReadiness {
        ready: false,
        prerequisites: vec![PrerequisiteReport {
            id: "modelFiles".to_string(),
            state: PrerequisiteState::Missing,
            detail,
            resolved_path: None,
        }],
    }
}

/// The companion's ONLY prerequisite: the pinned model files. Read-only.
///
/// The in-process runtime ships with Fredo (#3141), so there is no executable to
/// resolve, no PATH/winget lookup, and no second installer — a fresh machine
/// needs the model files and nothing else (R-17.1).
#[tauri::command]
pub fn check_companion_readiness(app: AppHandle) -> CompanionReadiness {
    // **FS-2** test-only seam, scoped to this READINESS PROBE ONLY: force the
    // model-files prerequisite `Missing` so the never-installed companion state
    // is live-drivable (G-275). Inert when unset.
    if force_not_installed_with(std::env::var(COMPANION_FORCE_NOT_INSTALLED_ENV).ok().as_deref()) {
        return forced_not_installed_readiness();
    }

    let manifest = resolve_manifest(&app);
    let models_dir = resolve_models_dir(&app);
    let model_files = probe_files(&models_dir, &manifest);
    let prerequisite = model_files_prerequisite(
        &model_files,
        models_subdir(&models_dir, &manifest)
            .to_string_lossy()
            .into_owned(),
    );
    let ready = prerequisite.state == PrerequisiteState::Installed;
    CompanionReadiness {
        ready,
        prerequisites: vec![prerequisite],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── REQ-8: Setup types serialize/deserialize correctly ────────────────

    #[test]
    fn cli_check_result_round_trip() {
        let original = CliCheckResult {
            opencode: true,
            opencode_plugin_installed: false,
            opencode_version: Some("2.4.1".into()),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: CliCheckResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.opencode, original.opencode);
        assert_eq!(deserialized.opencode_plugin_installed, original.opencode_plugin_installed);
        assert_eq!(deserialized.opencode_version, Some("2.4.1".into()));
    }

    #[test]
    fn install_result_round_trip_with_error() {
        let original = InstallResult {
            success: false,
            output: "".into(),
            error: Some("something went wrong".into()),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: InstallResult = serde_json::from_str(&json).unwrap();
        assert!(!deserialized.success);
        assert_eq!(deserialized.error, Some("something went wrong".into()));
    }

    #[test]
    fn install_result_round_trip_no_error() {
        let original = InstallResult {
            success: true,
            output: "done".into(),
            error: None,
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: InstallResult = serde_json::from_str(&json).unwrap();
        assert!(deserialized.success);
        assert_eq!(deserialized.output, "done");
        assert!(deserialized.error.is_none());
    }

    #[test]
    fn fredo_path_status_round_trip() {
        let original = FredoPathStatus {
            in_path: true,
            binary_path: r"C:\fredo\fredo.exe".into(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: FredoPathStatus = serde_json::from_str(&json).unwrap();
        assert!(deserialized.in_path);
        assert_eq!(deserialized.binary_path, r"C:\fredo\fredo.exe");
    }

    #[test]
    fn setup_plan_step_round_trip_all_fields() {
        let original = SetupPlanStep {
            id: "fredo-path".into(),
            label: "Add Fredo CLI to PATH".into(),
            status: "needed".into(),
            command: Some("export PATH=...".into()),
            detail: Some("Binary at /usr/bin/fredo".into()),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: SetupPlanStep = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "fredo-path");
        assert_eq!(deserialized.label, "Add Fredo CLI to PATH");
        assert_eq!(deserialized.status, "needed");
        assert_eq!(deserialized.command, Some("export PATH=...".into()));
        assert_eq!(deserialized.detail, Some("Binary at /usr/bin/fredo".into()));
    }

    #[test]
    fn setup_plan_step_round_trip_optional_none() {
        let original = SetupPlanStep {
            id: "opencode-cli".into(),
            label: "Install OpenCode CLI".into(),
            status: "skipped".into(),
            command: None,
            detail: None,
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: SetupPlanStep = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.command, None);
        assert_eq!(deserialized.detail, None);
    }

    #[test]
    fn setup_plan_round_trip() {
        let step = SetupPlanStep {
            id: "fredo-path".into(),
            label: "Foo".into(),
            status: "skipped".into(),
            command: None,
            detail: None,
        };
        let original = SetupPlan {
            steps: vec![step],
            can_proceed: true,
            opencode_docs_url: OPENCODE_INSTALL_DOCS_URL.into(),
            opencode_version: Some("2.4.1".into()),
            opencode_min_major: MIN_SUPPORTED_OPENCODE_MAJOR,
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: SetupPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.steps.len(), 1);
        assert!(deserialized.can_proceed);
        assert_eq!(deserialized.opencode_docs_url, OPENCODE_INSTALL_DOCS_URL);
        assert_eq!(deserialized.opencode_version, Some("2.4.1".into()));
        assert_eq!(
            deserialized.opencode_min_major,
            MIN_SUPPORTED_OPENCODE_MAJOR
        );
    }

    #[test]
    fn step_status_round_trip() {
        let original = StepStatus {
            status: "ok".into(),
            detail: Some("All good".into()),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: StepStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.status, "ok");
        assert_eq!(deserialized.detail, Some("All good".into()));
    }

    #[test]
    fn check_all_setup_result_round_trip() {
        let original = CheckAllSetupResult {
            fredo_path: StepStatus { status: "ok".into(), detail: Some("In PATH".into()) },
            opencode: StepStatus { status: "ok".into(), detail: Some("Installed".into()) },
            plugin: StepStatus { status: "missing".into(), detail: Some("Not installed".into()) },
            model: StepStatus { status: "missing".into(), detail: Some("No model files".into()) },
            otel: StepStatus { status: "missing".into(), detail: Some("Not configured".into()) },
            opencode_version: Some("2.4.1".into()),
            opencode_min_major: MIN_SUPPORTED_OPENCODE_MAJOR,
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: CheckAllSetupResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.fredo_path.status, "ok");
        assert_eq!(deserialized.opencode.status, "ok");
        assert_eq!(deserialized.plugin.status, "missing");
        assert_eq!(deserialized.model.status, "missing");
        assert_eq!(deserialized.otel.status, "missing");
        assert_eq!(deserialized.opencode_version, Some("2.4.1".into()));
        assert_eq!(
            deserialized.opencode_min_major,
            MIN_SUPPORTED_OPENCODE_MAJOR
        );
    }

    // ── Spec #3198 ST-2: the OpenCode-2 gate, the global install, no writer ──

    fn supported_version() -> OpenCodeVersion {
        OpenCodeVersion::Supported {
            raw: "2.4.1".to_string(),
            major: MIN_SUPPORTED_OPENCODE_MAJOR,
        }
    }

    fn too_old_version() -> OpenCodeVersion {
        OpenCodeVersion::Unsupported {
            raw: "1.15.5".to_string(),
            major: MIN_SUPPORTED_OPENCODE_MAJOR - 1,
        }
    }

    fn undetermined_version() -> OpenCodeVersion {
        OpenCodeVersion::Undetermined {
            detail: "`opencode --version` exited with 1".to_string(),
        }
    }

    /// (a) A supported CLI keeps `opencode: true` and carries the version token.
    #[test]
    fn cli_check_serializes_a_supported_cli_with_its_version() {
        let result = cli_check_result_for(&supported_version(), true);
        assert!(result.opencode);
        assert!(result.opencode_plugin_installed);

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["opencode"], serde_json::json!(true));
        assert_eq!(
            json.get("opencode_version").and_then(|v| v.as_str()),
            Some("2.4.1")
        );
    }

    /// (a) A 1.x CLI is INSTALLED but unusable: `opencode` flips to false, the
    /// found version is still reported, and no usable plugin is claimed.
    #[test]
    fn cli_check_serializes_a_too_old_cli_as_unusable() {
        let result = cli_check_result_for(&too_old_version(), true);
        assert!(!result.opencode, "a 1.x CLI must not read as usable");
        assert!(!result.opencode_plugin_installed);

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["opencode"], serde_json::json!(false));
        assert_eq!(
            json.get("opencode_version").and_then(|v| v.as_str()),
            Some("1.15.5")
        );
    }

    /// (g) + G-413: an undetermined version is an ABSENT KEY on every setup
    /// payload — never `null`, never `""`.
    #[test]
    fn every_setup_payload_omits_the_version_key_when_undetermined() {
        let version = undetermined_version();

        let cli_json = serde_json::to_value(cli_check_result_for(&version, false)).unwrap();
        assert!(
            cli_json.get("opencode_version").is_none(),
            "cli check: absent key, not null: {cli_json}"
        );

        let all = CheckAllSetupResult {
            fredo_path: StepStatus { status: "ok".into(), detail: None },
            opencode: opencode_step_for(&version),
            plugin: plugin_step_for(false, false),
            model: StepStatus { status: "ok".into(), detail: None },
            otel: otel_step_for(false),
            opencode_version: version_wire(&version),
            opencode_min_major: MIN_SUPPORTED_OPENCODE_MAJOR,
        };
        let all_json = serde_json::to_value(&all).unwrap();
        assert!(
            all_json.get("opencode_version").is_none(),
            "check_all_setup: absent key, not null: {all_json}"
        );
        // snake_case wire (these structs carry no rename_all) + the constant.
        assert_eq!(
            all_json["opencode_min_major"],
            serde_json::json!(MIN_SUPPORTED_OPENCODE_MAJOR)
        );
        assert_eq!(all_json["opencode"]["status"], serde_json::json!("error"));

        let plan = SetupPlan {
            steps: Vec::new(),
            can_proceed: false,
            opencode_docs_url: OPENCODE_INSTALL_DOCS_URL.to_string(),
            opencode_version: version_wire(&version),
            opencode_min_major: MIN_SUPPORTED_OPENCODE_MAJOR,
        };
        let plan_json = serde_json::to_value(&plan).unwrap();
        assert!(
            plan_json.get("opencode_version").is_none(),
            "setup plan: absent key, not null: {plan_json}"
        );
        assert_eq!(plan_json["can_proceed"], serde_json::json!(false));
    }

    /// (b) R-1a: `error` with the gate message — found version, the RENDERED
    /// minimum, the bare upgrade verb — and no flag the runtime rejects.
    #[test]
    fn the_too_old_step_is_an_error_naming_the_version_and_the_bare_upgrade() {
        let step = opencode_step_for(&too_old_version());
        assert_eq!(step.status, "error");
        let detail = step.detail.expect("a gate detail");
        assert!(detail.contains("1.15.5"), "{detail}");
        assert!(
            detail.contains(&format!("{MIN_SUPPORTED_OPENCODE_MAJOR}.x")),
            "the minimum is rendered from the constant: {detail}"
        );
        assert!(detail.contains("opencode upgrade"), "{detail}");
        assert!(detail.contains("fredo setup --check"), "{detail}");
        assert!(!detail.contains("--major"), "{detail}");
        // Never the false install framing for a binary that IS installed.
        assert!(!detail.contains("Install from"), "{detail}");
        assert!(!detail.contains("not found"), "{detail}");
    }

    /// (b) R-1b: an undeterminable version is `error` naming the probe's own
    /// failure and the diagnostic command — never `ok`, never "not installed".
    #[test]
    fn the_undetermined_step_is_an_error_naming_the_probe_failure() {
        let step = opencode_step_for(&undetermined_version());
        assert_eq!(step.status, "error");
        let detail = step.detail.expect("an error detail");
        assert!(detail.contains("exited with 1"), "{detail}");
        assert!(detail.contains("opencode --version"), "{detail}");
        assert!(!detail.contains("not installed"), "{detail}");
    }

    #[test]
    fn a_supported_cli_yields_an_ok_opencode_step() {
        let step = opencode_step_for(&supported_version());
        assert_eq!(step.status, "ok");
        assert_eq!(step.detail.as_deref(), Some("OpenCode CLI is installed."));
    }

    /// (b) The plugin step is gated by the CLI, never `missing` on a bad CLI.
    #[test]
    fn the_plugin_step_is_gated_by_the_cli() {
        assert_eq!(plugin_step_for(false, false).status, "error");
        assert_eq!(plugin_step_for(true, true).status, "ok");
        assert_eq!(plugin_step_for(true, false).status, "missing");
    }

    /// (b) R-2c/R-2e′: an installed plugin is `ok` and its detail states the
    /// MECHANISM (how the plugin reaches the runtime) — never a bare
    /// "configured", never `missing` (which would send the user looking for
    /// environment variables), and never a lifecycle claim setup does not
    /// perform.
    #[test]
    fn the_otel_step_states_the_capture_mechanism_for_an_installed_plugin() {
        let step = otel_step_for(true);
        assert_eq!(step.status, "ok");
        let detail = step.detail.expect("a detail");
        assert!(detail.contains("OpenCode loads the global plugin itself"), "{detail}");
        assert!(
            !detail.contains("configured"),
            "the false-green wording is gone: {detail}"
        );
    }

    /// (b) R-2e′: the mechanism detail names the absent environment variable and
    /// carries **no** lifecycle claim — round 3 removed the install-time restart,
    /// so a step that promised or reported one would describe machinery that no
    /// longer exists (the QA row asserts the same absence).
    #[test]
    fn otel_step_reports_the_mechanism_and_never_a_restart_claim() {
        let step = otel_step_for(true);
        assert_eq!(step.status, "ok");
        let detail = step.detail.expect("a detail").to_lowercase();
        assert!(
            detail.contains("no opencode environment variable"),
            "the mechanism names the absent variable: {detail}"
        );
        assert!(
            !detail.contains("restart"),
            "no lifecycle claim survives the removal: {detail}"
        );
        // The not-installed wording is equally lifecycle-free.
        let other = otel_step_for(false)
            .detail
            .expect("a detail")
            .to_lowercase();
        assert!(!other.contains("restart"), "{other}");
    }

    /// (c) R-2c: the plan's copy command is the COPY ALONE — no environment
    /// wiring — and it is never offered when the gate failed (R-1c) or the
    /// plugin is already in place.
    #[test]
    fn the_plugin_install_plan_command_is_the_copy_alone() {
        let artifact = Path::new("/repo/apps/opencode-plugin/dist/index.js");
        let destination = Path::new("/home/x/.config/opencode/plugins/fredo.js");

        let command = plugin_install_command(true, false, artifact, destination)
            .expect("a copy command");
        assert!(command.contains("index.js"), "{command}");
        assert!(command.contains("fredo.js"), "the flat global file: {command}");
        // Constructed so this assertion never matches its own source text.
        let banned = [
            format!("{}{}", "set", "x"),
            format!("{} ", "set"),
            format!("{} ", "export"),
            format!("{}_", "OPENCODE"),
        ];
        for token in &banned {
            assert!(
                !command.contains(token.as_str()),
                "the copy must carry no receiver wiring ({token}): {command}"
            );
        }

        assert_eq!(
            plugin_install_command(false, false, artifact, destination),
            None,
            "never copy when the gate failed (R-1c)"
        );
        assert_eq!(
            plugin_install_command(true, true, artifact, destination),
            None,
            "no command when the plugin is already installed"
        );
    }

    /// (e) The telemetry step is an idempotent report: for a GIVEN install flag
    /// the claim does not move between calls, and the not-installed wording keeps
    /// naming the global plugin and the absence of any environment variable.
    #[test]
    fn the_telemetry_step_reports_the_same_claim_for_the_same_install_flag() {
        let first = otel_step_for(false);
        let second = otel_step_for(false);
        assert_eq!(first.status, second.status);
        assert_eq!(first.detail, second.detail);
        assert_eq!(first.detail.as_deref(), Some(OTEL_NOT_REQUIRED_MSG));
        assert!(OTEL_NOT_REQUIRED_MSG.contains("environment variables"),
            "the not-required state must say no variable is needed: {OTEL_NOT_REQUIRED_MSG}");
        // ... and the installed claim is equally stable.
        assert_eq!(otel_step_for(true).detail, otel_step_for(true).detail);
    }

    /// (f) + R-2c absence guard (G-430): this surface carries no persistent
    /// environment writer. The raw source is scanned — comments and doc comments
    /// included, because the AC's predicate is a raw grep — and every banned
    /// token is CONSTRUCTED here so the guard cannot match its own text. The
    /// non-vacuity controls prove the universe is the real file and the matcher
    /// fires on tokens that are present.
    #[test]
    fn the_setup_surface_carries_no_persistent_opencode_env_writer() {
        let source = include_str!("commands.rs");

        assert!(source.len() > 10_000, "the scan universe is the whole file");
        assert!(
            source.contains("install_plugin"),
            "the matcher fires on a token that is present"
        );

        let banned = [
            format!("{}{}", "set", "x"),
            format!("{}-{}-{}", "fredo", "otel", "opencode"),
            ["OPENCODE", "ENABLE", "TELEMETRY"].join("_"),
            ["OPENCODE", "OTLP", "ENDPOINT"].join("_"),
            ["OPENCODE", "OTLP", "PROTOCOL"].join("_"),
        ];
        for token in &banned {
            assert!(
                !source.contains(token.as_str()),
                "the retired persistent writer must not survive: {token}"
            );
        }
    }

    // ── Spec #2855: companion readiness (in-process runtime since #3141) ──

    /// #3141: the runtime ships inside Fredo, so the model-files prerequisite is
    /// the ONLY one — there is no `llamaServer` id and no install affordance.
    #[test]
    fn companion_readiness_serializes_camel_case_with_one_prerequisite() {
        let readiness = CompanionReadiness {
            ready: false,
            prerequisites: vec![PrerequisiteReport {
                id: "modelFiles".into(),
                state: PrerequisiteState::Missing,
                detail: "0 of 3 model files present.".into(),
                resolved_path: None,
            }],
        };
        let json = serde_json::to_string(&readiness).unwrap();
        assert!(json.contains("\"resolvedPath\""));
        assert!(json.contains("\"modelFiles\""));
        assert!(json.contains("\"missing\""));
        assert!(json.contains("\"ready\":false"));
        // The retired prerequisite is gone from the wire vocabulary.
        assert!(!json.contains("\"llamaServer\""));
    }

    // ── Spec #3052 round 2 FS-2: forced-not-installed readiness seam ──────

    /// FS-2: the forced-not-installed lever is inert unless explicitly set, and a
    /// `0`/`false` value leaves it off. The pure rule is pinned so the contract is
    /// tested without mutating process-global env (G-222).
    #[test]
    fn force_not_installed_rule_is_inert_by_default_and_reads_the_lever() {
        assert!(!force_not_installed_with(None), "unset is inert");
        assert!(!force_not_installed_with(Some("")), "blank is inert");
        assert!(!force_not_installed_with(Some("   ")), "blank is inert");
        assert!(!force_not_installed_with(Some("0")), "0 is inert");
        assert!(!force_not_installed_with(Some("false")), "false is inert");
        assert!(!force_not_installed_with(Some("FALSE")), "false is case-insensitive");
        assert!(force_not_installed_with(Some("1")));
        assert!(force_not_installed_with(Some("true")));
        assert!(force_not_installed_with(Some("yes")));
    }

    /// FS-2: the seam env name matches the QA-facing contract.
    #[test]
    fn companion_force_not_installed_env_name_matches_the_contract() {
        assert_eq!(
            COMPANION_FORCE_NOT_INSTALLED_ENV,
            "FREDO_COMPANION_FORCE_NOT_INSTALLED"
        );
    }

    /// FS-2 (#3141): the forced readiness report marks the ONE `modelFiles`
    /// prerequisite `Missing` (never `ready`), so the frontend derives both
    /// companion lines `notSetUp` and the aggregate stays healthy-or-neutral.
    #[test]
    fn forced_not_installed_readiness_reports_the_model_files_prerequisite_missing() {
        let report = forced_not_installed_readiness();
        assert!(!report.ready, "forced readiness is never ready");
        assert_eq!(report.prerequisites.len(), 1);
        assert_eq!(report.prerequisites[0].id, "modelFiles");
        assert_eq!(report.prerequisites[0].state, PrerequisiteState::Missing);
        assert!(report.prerequisites[0].resolved_path.is_none());
        assert!(
            report
                .prerequisites
                .iter()
                .all(|p| p.state != PrerequisiteState::Installed)
        );
    }

    #[test]
    fn model_files_prerequisite_is_installed_only_when_every_manifest_file_is_present() {
        let file = |id: &str, state: FileState| ModelFileStatus {
            id: id.to_string(),
            filename: format!("{id}.gguf"),
            relative_path: format!("gemma-4-e2b-it-qat/{id}.gguf"),
            state,
            downloaded_bytes: 0,
            expected_bytes: 10,
            detail: None,
            path: (state == FileState::Present).then(|| format!("/models/{id}.gguf")),
        };

        let all = vec![
            file("model", FileState::Present),
            file("vision", FileState::Present),
            file("mtp", FileState::Present),
        ];
        let report = model_files_prerequisite(&all, "/models/gemma-4-e2b-it-qat".to_string());
        assert_eq!(report.state, PrerequisiteState::Installed);
        assert_eq!(
            report.resolved_path.as_deref(),
            Some("/models/gemma-4-e2b-it-qat")
        );

        // 2 of 3 — a truncated `mtp` classifies as Missing, so never Installed.
        let partial = vec![
            file("model", FileState::Present),
            file("vision", FileState::Present),
            file("mtp", FileState::Missing),
        ];
        let report = model_files_prerequisite(&partial, "/models/gemma-4-e2b-it-qat".to_string());
        assert_eq!(report.state, PrerequisiteState::Missing);
        assert_eq!(report.detail, "2 of 3 model files present.");
        assert!(report.resolved_path.is_none());

        // An errored file blocks completion and reports `Error` (a determination
        // failure), never `Installed`.
        let errored = vec![
            file("model", FileState::Present),
            file("vision", FileState::Error),
            file("mtp", FileState::Present),
        ];
        let report = model_files_prerequisite(&errored, "/models".to_string());
        assert_eq!(report.state, PrerequisiteState::Error);
        assert!(
            report.detail.contains("re-download"),
            "an errored file must name the recovery: {}",
            report.detail
        );
        assert!(report.resolved_path.is_none());

        // An empty/misconfigured manifest is never complete.
        let empty: Vec<ModelFileStatus> = Vec::new();
        assert_eq!(
            model_files_prerequisite(&empty, "/models".to_string()).state,
            PrerequisiteState::Missing
        );
    }

    #[test]
    fn default_manifest_is_the_three_engine_files_in_acquisition_order() {
        let manifest = default_manifest();
        let ids: Vec<&str> = manifest.files.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["model", "vision", "mtp"]);
        assert_eq!(manifest.subdir, "gemma-4-e2b-it-qat");
        assert!(manifest.files[2].path.starts_with("MTP/"));
    }
}
