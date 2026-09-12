use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::companion::resolve_llama_server;
#[cfg(test)]
use crate::infrastructure::companion::resolve_llama_server_order;
use crate::infrastructure::storage::AppStore;
use super::model_download::{
    download_missing_files, DownloadProgress, ModelDownloadOutcome, ProgressReporter,
    ReqwestTransport, SystemClock,
};
use super::model_download_state::{
    default_manifest, is_step_complete, load_manifest, probe_files, FileState, ModelFileStatus,
    ModelManifest,
};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct CliCheckResult {
    pub opencode: bool,
    pub opencode_plugin_installed: bool,
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
    pub can_proceed: bool,
    pub opencode_docs_url: String,
}

#[derive(Serialize, Deserialize)]
pub struct StepStatus {
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct CheckAllSetupResult {
    pub fredo_path: StepStatus,
    pub opencode: StepStatus,
    pub plugin: StepStatus,
    pub model: StepStatus,
    pub otel: StepStatus,
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

/// AppStore key holding an optional whole-manifest JSON override (#2856 test seam).
const MODEL_MANIFEST_PATH_KEY: &str = "model_manifest_path";

// ── Helpers ───────────────────────────────────────────────────────────────────

fn is_binary_available(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    let finder = "where";
    #[cfg(not(target_os = "windows"))]
    let finder = "which";

    std::process::Command::new(finder)
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn opencode_plugins_dir(home: &Path) -> PathBuf {
    home.join(".config").join("opencode").join("plugins")
}

/// The plugin file is installed as a flat .js file directly in the plugins directory,
/// which is how OpenCode discovers local plugins (not in subdirectories).
fn opencode_plugin_file(home: &Path) -> PathBuf {
    opencode_plugins_dir(home).join("fredo.js")
}

fn is_opencode_plugin_installed(home: &Path) -> bool {
    // OpenCode discovers local plugins as flat .js files in the plugins directory.
    // No config registration needed — local plugins are auto-loaded from the directory.
    opencode_plugin_file(home).exists()
}

/// Write OTEL environment variables into OpenCode's configuration
/// so OpenCode pushes telemetry to the Fredo embedded gRPC receiver on 127.0.0.1:4317.
///
/// Persistence strategy:
///   • Windows  — sets User-level env vars via `setx` (survives new shells/sessions).
///   • Unix/Mac — appends export lines to ~/.zshrc, ~/.bashrc, and ~/.profile
///               (guarded by a sentinel comment so re-runs are idempotent).
fn configure_opencode_otel(_home: &PathBuf) -> Result<(), String> {
    let vars = [
        ("OPENCODE_ENABLE_TELEMETRY",  "1"),
        ("OPENCODE_OTLP_ENDPOINT",     "http://localhost:4317"),
        ("OPENCODE_OTLP_PROTOCOL",     "grpc"),
    ];

    #[cfg(target_os = "windows")]
    {
        for (key, val) in &vars {
            let status = std::process::Command::new("setx")
                .args([key, val])
                .status()
                .map_err(|e| format!("setx failed for {key}: {e}"))?;
            if !status.success() {
                return Err(format!("setx returned non-zero for {key}"));
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let sentinel = "# fredo-otel-opencode";
        let block = {
            let mut s = format!("\n{sentinel}\n");
            for (key, val) in &vars {
                s.push_str(&format!("export {key}={val}\n"));
            }
            s
        };

        let rc_files = ["~/.zshrc", "~/.bashrc", "~/.profile"];
        for rc in &rc_files {
            let expanded = rc.replacen("~", &home.to_string_lossy(), 1);
            let path = std::path::Path::new(&expanded);
            // Only touch files that exist, except .profile which we always create
            if !path.exists() && *rc != "~/.profile" {
                continue;
            }
            let current = if path.exists() {
                std::fs::read_to_string(path)
                    .map_err(|e| format!("Could not read {rc}: {e}"))?
            } else {
                String::new()
            };
            // Idempotent: skip if sentinel already present
            if current.contains(sentinel) {
                continue;
            }
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|e| format!("Could not open {rc}: {e}"))?;
            use std::io::Write;
            file.write_all(block.as_bytes())
                .map_err(|e| format!("Could not write {rc}: {e}"))?;
        }
        Ok(())
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

/// Check whether OpenCode CLI is installed and whether the Fredo plugin is present.
#[tauri::command]
pub fn check_cli_installations(app: AppHandle) -> CliCheckResult {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let opencode = is_binary_available("opencode");
    CliCheckResult {
        opencode_plugin_installed: opencode && is_opencode_plugin_installed(&home),
        opencode,
    }
}

/// Returns a setup plan with steps for fredo-path, opencode-cli, and plugin-install.
/// Status is "skipped", "needed", or "blocked" based on detection results.
#[tauri::command]
pub fn get_setup_plan(app: AppHandle) -> SetupPlan {
    let cli = check_cli_installations(app.clone());
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let fredo_status = check_fredo_in_path();
    let plugin_installed = is_opencode_plugin_installed(&home);

    let opencode_available = cli.opencode;
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
        let src = if workspace.exists() {
            workspace
        } else {
            prod
        };
        src.to_string_lossy().into_owned()
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
        command: Some("https://opencode.ai/docs/install".to_string()),
        detail: if opencode_available {
            Some("OpenCode CLI is installed.".to_string())
        } else {
            Some("OpenCode CLI is required to proceed. Install from https://opencode.ai/docs/install".to_string())
        },
    });

    // Step 3: plugin-build
    let plugin_src_path = std::path::Path::new(&plugin_src);
    let needs_plugin_build = !plugin_src_path.join("dist").join("index.js").exists();
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
            Some("Install OpenCode CLI first to enable plugin build.".to_string())
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
    let plugin_command = if !opencode_available || plugin_installed {
        None
    } else {
        #[cfg(target_os = "windows")]
        {
            let src = plugin_src.replace('/', "\\");
            Some(format!(
                "copy \"{src}\\dist\\index.js\" \"%USERPROFILE%\\.config\\opencode\\plugins\\fredo.js\"\n\
set OPENCODE_ENABLE_TELEMETRY=1\n\
set OPENCODE_OTLP_ENDPOINT=http://localhost:4317\n\
set OPENCODE_OTLP_PROTOCOL=grpc\n\
rem Persist for future terminals:\n\
setx OPENCODE_ENABLE_TELEMETRY 1\n\
setx OPENCODE_OTLP_ENDPOINT http://localhost:4317\n\
setx OPENCODE_OTLP_PROTOCOL grpc"
            ))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Some(format!(
                "cp {plugin_src}/dist/index.js ~/.config/opencode/plugins/fredo.js\n\
export OPENCODE_ENABLE_TELEMETRY=1\nexport OPENCODE_OTLP_ENDPOINT=http://localhost:4317\nexport OPENCODE_OTLP_PROTOCOL=grpc"
            ))
        }
    };
    steps.push(SetupPlanStep {
        id: "plugin-install".to_string(),
        label: "Install Fredo Plugin".to_string(),
        status: plugin_status.to_string(),
        command: plugin_command,
        detail: if plugin_installed {
            Some("Fredo plugin is already installed.".to_string())
        } else if !opencode_available {
            Some("Install OpenCode CLI first to enable plugin installation.".to_string())
        } else {
            None
        },
    });

    SetupPlan {
        steps,
        can_proceed,
        opencode_docs_url: "https://opencode.ai/docs/install".to_string(),
    }
}

/// Install the Fredo plugin for OpenCode.
/// Builds the plugin via `bun build` if dist/index.js is missing, then copies
/// plugin.json, package.json, and dist/index.js to ~/.config/opencode/plugins/fredo/
/// and registers fredo in opencode.json config.
#[tauri::command]
pub async fn install_plugin(app: AppHandle) -> InstallResult {
    let home = match app.path().home_dir() {
        Ok(h)  => h,
        Err(e) => {
            let err = format!("Could not resolve home directory: {e}");
            tracing::warn!("install_plugin early-exit [home-dir]: {err}");
            return InstallResult {
                success: false,
                output: String::new(),
                error: Some(err),
            };
        }
    };

    // Workspace-first: prefer the adjacent checkout (dev/debug machines); fall back
    // to the bundled resource dir only for packaged deployments (issue #2758 F1).
    let (src_dir, src_label) = {
        let ws = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("apps/opencode-plugin");
        let workspace = ws.canonicalize().unwrap_or(ws);
        let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        let prod = resource_dir.join("plugin");
        if workspace.exists() {
            (workspace, "workspace")
        } else {
            (prod, "resource-dir")
        }
    };
    tracing::info!(
        "install_plugin resolved source ({src_label}): {}",
        src_dir.display()
    );

    if !src_dir.exists() {
        let err = format!("Plugin source directory not found: {}", src_dir.display());
        tracing::warn!("install_plugin early-exit [missing-src]: {err}");
        return InstallResult {
            success: false,
            output: String::new(),
            error: Some(err),
        };
    }

    // Build step: run `bun build` if dist/index.js is missing
    let dist_index_js = src_dir.join("dist").join("index.js");
    let needs_build = !dist_index_js.exists();
    tracing::info!(
        "install_plugin build gate: needs_build={needs_build}, artifact={}",
        dist_index_js.display()
    );
    if needs_build {
        tracing::info!("install_plugin running `bun build` in {}", src_dir.display());
        let build_output = std::process::Command::new("bun")
            .args(["build", "src/index.ts", "--outdir", "dist", "--target", "bun"])
            .current_dir(&src_dir)
            .output();

        match build_output {
            Ok(output) if output.status.success() => {
                tracing::info!("install_plugin `bun build` succeeded");
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let err = format!(
                    "bun build failed with exit code {:?}\nstdout: {}\nstderr: {}",
                    output.status.code(),
                    stdout,
                    stderr
                );
                tracing::warn!("install_plugin early-exit [bun-build-nonzero]: {err}");
                return InstallResult {
                    success: false,
                    output: String::new(),
                    error: Some(err),
                };
            }
            Err(e) => {
                let err = format!("Failed to run bun build: {e}");
                tracing::warn!("install_plugin early-exit [bun-build-spawn]: {err}");
                return InstallResult {
                    success: false,
                    output: String::new(),
                    error: Some(err),
                };
            }
        }
    }

    // OpenCode discovers local plugins as flat .js files in the plugins directory.
    // Copy dist/index.js as fredo.js (flat file for auto-discovery).
    let plugins_dir = opencode_plugins_dir(&home);
    if let Err(e) = std::fs::create_dir_all(&plugins_dir) {
        let err = format!("Could not create plugins directory {}: {e}", plugins_dir.display());
        tracing::warn!("install_plugin early-exit [plugins-dir-create]: {err}");
        return InstallResult {
            success: false,
            output: String::new(),
            error: Some(err),
        };
    }
    tracing::info!(
        "install_plugin plugins directory ready: {}",
        plugins_dir.display()
    );

    let dest_file = opencode_plugin_file(&home);
    let copied_bytes = match std::fs::copy(&dist_index_js, &dest_file) {
        Ok(n) => n,
        Err(e) => {
            let err = format!("Failed to copy plugin to {}: {e}", dest_file.display());
            tracing::warn!("install_plugin early-exit [copy]: {err}");
            return InstallResult {
                success: false,
                output: String::new(),
                error: Some(err),
            };
        }
    };
    tracing::info!(
        "install_plugin copied {copied_bytes} bytes -> {}",
        dest_file.display()
    );

    // Configure OTEL env vars so OpenCode sends telemetry to Fredo.
    // Deferred OFF the reply critical path: setx only affects FUTURE processes,
    // so running it after this command replies never changes behavior — but a
    // slow/hung setx child-process wait can no longer stall the invoke reply
    // path (E1, issue #2758). Completion (or failure) is logged via tracing.
    let home_for_otel = home.clone();
    tauri::async_runtime::spawn(async move {
        let otel_result =
            tauri::async_runtime::spawn_blocking(move || configure_opencode_otel(&home_for_otel))
                .await;
        let otel_result = match otel_result {
            Ok(r) => r,
            Err(e) => Err(format!("OTEL configuration task failed to complete: {e}")),
        };
        match &otel_result {
            Ok(()) => tracing::info!(
                "OpenCode OTEL env configured — applies to future opencode processes"
            ),
            Err(e) => tracing::warn!("Could not write OpenCode OTEL config: {e}"),
        }
    });

    // Self-describing result so callers can distinguish completed installs from
    // early-exits machine-readably even under fire-and-forget invocation (#2758 F2).
    let output = format!(
        "Installed plugin to {} (source-dir: {}, copied {copied_bytes} bytes)",
        dest_file.display(),
        src_label,
    );
    tracing::info!("install_plugin completed: {output}");
    InstallResult { success: true, output, error: None }
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

#[derive(Serialize)]
pub struct OtelStatus {
    /// Whether OpenCode OTEL env vars are present (shell profiles on Unix,
    /// User env vars on Windows).
    pub opencode_configured: bool,
}

/// Check whether Fredo OTEL telemetry is already configured for OpenCode.
#[tauri::command]
pub fn check_otel_configured(app: AppHandle) -> OtelStatus {
    let _home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));

    let opencode_configured = {
        #[cfg(target_os = "windows")]
        {
            // setx writes to HKCU\Environment in the registry — the current process
            // env is never updated, so we must query the registry directly.
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile", "-Command",
                    "[System.Environment]::GetEnvironmentVariable('OPENCODE_ENABLE_TELEMETRY', 'User')",
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Check current process env first (fast path), then shell profiles
            // for the sentinel written by configure_opencode_otel.
            std::env::var("OPENCODE_ENABLE_TELEMETRY").map(|v| v == "1").unwrap_or(false)
            || [".zshrc", ".bashrc", ".profile"].iter().any(|rc| {
                let p = _home.join(rc);
                std::fs::read_to_string(p)
                    .map(|c| c.contains("# fredo-otel-opencode"))
                    .unwrap_or(false)
            })
        }
    };

    OtelStatus { opencode_configured }
}

/// Explicitly configure OTEL telemetry for OpenCode.
/// Called from the Setup wizard's telemetry step.
#[tauri::command]
pub fn configure_otel(app: AppHandle) -> InstallResult {
    let home = match app.path().home_dir() {
        Ok(h)  => h,
        Err(e) => return InstallResult {
            success: false,
            output: String::new(),
            error: Some(format!("Could not resolve home directory: {e}")),
        },
    };

    match configure_opencode_otel(&home) {
        Ok(())  => {
            #[cfg(target_os = "windows")]
            let msg = "OpenCode: OTEL env vars set via setx (persistent user env).".to_string();
            #[cfg(not(target_os = "windows"))]
            let msg = "OpenCode: OTEL export lines written to ~/.zshrc / ~/.bashrc / ~/.profile.".to_string();
            InstallResult { success: true, output: msg, error: None }
        }
        Err(e)  => InstallResult {
            success: false,
            output: String::new(),
            error: Some(format!("OpenCode: {e}")),
        },
    }
}

// ── New Setup Commands ─────────────────────────────────────────────────────────

/// Resolve the configured models_dir from AppStore, falling back to {home}/fredo-models.
fn resolve_models_dir(app: &AppHandle) -> PathBuf {
    let store_ref = app.state::<Arc<AppStore>>();
    let configured = store_ref.get("models_dir").ok().flatten();
    if let Some(val) = configured {
        if !val.is_empty() {
            return PathBuf::from(val);
        }
    }
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    home.join("fredo-models")
}

/// Resolve the acquisition manifest: the AppStore `model_manifest_path` JSON
/// override when present and valid, else the compiled [`default_manifest`].
/// An invalid override never breaks the probe — it logs and falls back.
fn resolve_manifest(app: &AppHandle) -> ModelManifest {
    let override_json = app
        .state::<Arc<AppStore>>()
        .get(MODEL_MANIFEST_PATH_KEY)
        .ok()
        .flatten();
    match load_manifest(override_json.as_deref()) {
        Ok(manifest) => manifest,
        Err(error) => {
            tracing::warn!(
                "invalid {MODEL_MANIFEST_PATH_KEY} override — using the compiled default manifest: {error}"
            );
            default_manifest()
        }
    }
}

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
    let bin_is_available = is_binary_available("opencode");
    let plugin_installed = is_opencode_plugin_installed(&home);

    // fredo-path
    let fredo_status = check_fredo_in_path();
    let fredo_path = if fredo_status.in_path {
        StepStatus { status: "ok".into(), detail: Some("Fredo binary is in PATH.".into()) }
    } else {
        StepStatus { status: "missing".into(), detail: Some(format!("Not in PATH. Binary at: {}", fredo_status.binary_path)) }
    };

    // opencode
    let opencode = if bin_is_available {
        StepStatus { status: "ok".into(), detail: Some("OpenCode CLI is installed.".into()) }
    } else {
        StepStatus { status: "missing".into(), detail: Some("OpenCode CLI not found. Install from https://opencode.ai/docs/install.".into()) }
    };

    // plugin
    let plugin = if !bin_is_available {
        StepStatus { status: "error".into(), detail: Some("OpenCode CLI not installed — cannot verify plugin.".into()) }
    } else if plugin_installed {
        StepStatus { status: "ok".into(), detail: Some("Fredo plugin is installed.".into()) }
    } else {
        StepStatus { status: "missing".into(), detail: Some("Fredo plugin not installed.".into()) }
    };

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

    // otel
    let otel_configured = {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile", "-Command",
                    "[System.Environment]::GetEnvironmentVariable('OPENCODE_ENABLE_TELEMETRY', 'User')",
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::env::var("OPENCODE_ENABLE_TELEMETRY").map(|v| v == "1").unwrap_or(false)
                || [".zshrc", ".bashrc", ".profile"].iter().any(|rc| {
                    let p = home.join(rc);
                    std::fs::read_to_string(p)
                        .map(|c| c.contains("# fredo-otel-opencode"))
                        .unwrap_or(false)
                })
        }
    };
    let otel = if otel_configured {
        StepStatus { status: "ok".into(), detail: Some("OTEL telemetry configured.".into()) }
    } else {
        StepStatus { status: "missing".into(), detail: Some("OpenCode OTEL not configured.".into()) }
    };

    CheckAllSetupResult { fredo_path, opencode, plugin, model, otel }
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

// ── Companion readiness + llama.cpp install (Spec #2855) ───────────────────────
//
// ONE canonical prerequisite set for the Companion setup wizard. The backend
// owns the set; the frontend renders exactly what `check_companion_readiness`
// returns through its ordered `COMPANION_SETUP_STEPS` registry. #2856 appends a
// model-download action; #2857 appends a `serverLaunch` prerequisite.

const WINGET_BIN: &str = "winget";
#[cfg(target_os = "windows")]
const WINGET_APP_ID: &str = "ggml.llamacpp";

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
    /// Stable id: "llamaServer" | "modelFiles" (#2857 adds "serverLaunch").
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

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum LlamaCppInstallCode {
    WingetUnavailable,
    InstallFailed,
    SpawnFailed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaCppInstallResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub code: Option<LlamaCppInstallCode>,
}

/// Aggregate the manifest probe into the `modelFiles` prerequisite. Pure — the
/// resolved manifest is the single source of required files, so a partial set
/// (or an empty manifest) can never read `Installed`.
fn model_files_prerequisite(
    files: &[ModelFileStatus],
    resolved_path: String,
) -> PrerequisiteReport {
    let total = files.len();
    let present = files
        .iter()
        .filter(|status| status.state == FileState::Present)
        .count();
    let complete = total > 0 && present == total;
    let (state, detail) = if complete {
        (
            PrerequisiteState::Installed,
            "All required model files present.".to_string(),
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

/// The two prerequisites the companion needs before it can run. Read-only.
#[tauri::command]
pub fn check_companion_readiness(app: AppHandle) -> CompanionReadiness {
    let mut prerequisites = Vec::with_capacity(2);

    // Prerequisite 1 — a usable llama-server executable.
    let (llama_state, llama_detail, llama_path) = match resolve_llama_server(&app) {
        Ok(Some(path)) => (
            PrerequisiteState::Installed,
            format!("llama-server found at {}", path.display()),
            Some(path.to_string_lossy().into_owned()),
        ),
        Ok(None) => (
            PrerequisiteState::Missing,
            "llama-server not found. Install llama.cpp to continue.".to_string(),
            None,
        ),
        Err(e) => (
            PrerequisiteState::Error,
            format!("Could not determine llama-server availability: {e}"),
            None,
        ),
    };
    prerequisites.push(PrerequisiteReport {
        id: "llamaServer".to_string(),
        state: llama_state,
        detail: llama_detail,
        resolved_path: llama_path,
    });

    // Prerequisite 2 — the required model files, derived from the manifest.
    let manifest = resolve_manifest(&app);
    let models_dir = resolve_models_dir(&app);
    let model_files = probe_files(&models_dir, &manifest);
    let models_subdir = models_dir.join(&manifest.subdir);
    prerequisites.push(model_files_prerequisite(
        &model_files,
        models_subdir.to_string_lossy().into_owned(),
    ));

    let ready = prerequisites
        .iter()
        .all(|p| p.state == PrerequisiteState::Installed);
    CompanionReadiness { ready, prerequisites }
}

/// Tail of a (possibly long) install output for an actionable error.
fn tail_of(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - max_chars).collect()
}

fn combine_output(stdout: &[u8], stderr: &[u8]) -> String {
    let out = String::from_utf8_lossy(stdout).trim().to_string();
    let err = String::from_utf8_lossy(stderr).trim().to_string();
    match (out.is_empty(), err.is_empty()) {
        (false, false) => format!("{out}\n{err}"),
        (false, true) => out,
        (true, false) => err,
        (true, true) => String::new(),
    }
}

/// Shape a successful/failed exit into the structured wire result. Pure.
fn classify_install_outcome(success: bool, combined_output: String) -> LlamaCppInstallResult {
    if success {
        LlamaCppInstallResult {
            success: true,
            output: combined_output,
            error: None,
            code: None,
        }
    } else {
        LlamaCppInstallResult {
            success: false,
            error: Some(format!(
                "Setup failed: {}. Choose Retry or Re-check.",
                tail_of(&combined_output, 400)
            )),
            output: combined_output,
            code: Some(LlamaCppInstallCode::InstallFailed),
        }
    }
}

/// Decide the install result from winget availability + the executed command.
/// The `execute` closure is injected so the failure branches are unit-testable
/// WITHOUT running a real `winget install`. Pure.
fn run_install_with(
    winget_available: bool,
    execute: impl FnOnce() -> std::io::Result<(bool, String)>,
) -> LlamaCppInstallResult {
    if !winget_available {
        return LlamaCppInstallResult {
            success: false,
            output: String::new(),
            error: Some(
                "Couldn't install llama.cpp — winget isn't available on this machine. \
                 Install llama.cpp manually, then choose Re-check."
                    .to_string(),
            ),
            code: Some(LlamaCppInstallCode::WingetUnavailable),
        };
    }
    match execute() {
        Ok((success, combined)) => classify_install_outcome(success, combined),
        Err(e) => LlamaCppInstallResult {
            success: false,
            output: String::new(),
            error: Some(format!(
                "Couldn't run winget: {e}. Install llama.cpp manually, then choose Re-check."
            )),
            code: Some(LlamaCppInstallCode::SpawnFailed),
        },
    }
}

/// One-click `winget install --id ggml.llamacpp -e`. Runs OFF the UI thread; does
/// NOT launch the server and does NOT re-check readiness — the frontend re-probes.
#[tauri::command]
pub async fn install_llama_cpp() -> LlamaCppInstallResult {
    let winget_available = is_binary_available(WINGET_BIN);
    let joined = tauri::async_runtime::spawn_blocking(move || {
        run_install_with(winget_available, || {
            #[cfg(target_os = "windows")]
            {
                let output = std::process::Command::new(WINGET_BIN)
                    .args([
                        "install",
                        "--id",
                        WINGET_APP_ID,
                        "-e",
                        "--accept-package-agreements",
                        "--accept-source-agreements",
                        "--disable-interactivity",
                    ])
                    .output()?;
                Ok((
                    output.status.success(),
                    combine_output(&output.stdout, &output.stderr),
                ))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "llama.cpp install is Windows-only",
                ))
            }
        })
    })
    .await;

    match joined {
        Ok(result) => result,
        Err(e) => LlamaCppInstallResult {
            success: false,
            output: String::new(),
            error: Some(format!("Install task failed: {e}. Choose Retry.")),
            code: Some(LlamaCppInstallCode::SpawnFailed),
        },
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
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: CliCheckResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.opencode, original.opencode);
        assert_eq!(deserialized.opencode_plugin_installed, original.opencode_plugin_installed);
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
            opencode_docs_url: "https://opencode.ai/docs/install".into(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: SetupPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.steps.len(), 1);
        assert!(deserialized.can_proceed);
        assert_eq!(deserialized.opencode_docs_url, "https://opencode.ai/docs/install");
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
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: CheckAllSetupResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.fredo_path.status, "ok");
        assert_eq!(deserialized.opencode.status, "ok");
        assert_eq!(deserialized.plugin.status, "missing");
        assert_eq!(deserialized.model.status, "missing");
        assert_eq!(deserialized.otel.status, "missing");
    }

    // ── Spec #2855: companion readiness + llama.cpp install ──────────────

    #[test]
    fn resolve_llama_server_prefers_configured_then_path_then_shim() {
        let existing = std::env::current_exe().expect("current exe");
        let existing_str = existing.to_string_lossy().into_owned();
        let on_path = PathBuf::from(r"C:\fake\llama-server.exe");

        // 1. A configured path that exists wins over PATH + shim.
        assert_eq!(
            resolve_llama_server_order(Some(&existing_str), Some(on_path.clone()), Some(existing.clone())),
            Some(existing.clone())
        );
        // 2. A configured path that does not exist falls through to PATH.
        assert_eq!(
            resolve_llama_server_order(Some("Z:\\missing\\llama-server.exe"), Some(on_path.clone()), None),
            Some(on_path.clone())
        );
        // 3. No configured path → PATH candidate.
        assert_eq!(
            resolve_llama_server_order(None, Some(on_path.clone()), None),
            Some(on_path.clone())
        );
        // 4. No configured/PATH → winget shim (when it exists).
        assert_eq!(
            resolve_llama_server_order(None, None, Some(existing.clone())),
            Some(existing)
        );
        // 5. A shim that does not exist is rejected; empty resolution → None.
        assert_eq!(
            resolve_llama_server_order(None, None, Some(PathBuf::from("Z:\\nope.exe"))),
            None
        );
        assert_eq!(resolve_llama_server_order(None, None, None), None);
    }

    #[test]
    fn install_llama_cpp_winget_unavailable_is_actionable_and_not_complete() {
        let result = run_install_with(false, || {
            panic!("must not execute when winget is unavailable")
        });
        assert!(!result.success);
        assert_eq!(result.code, Some(LlamaCppInstallCode::WingetUnavailable));
        let error = result.error.expect("actionable error");
        assert!(error.contains("winget"));
        assert!(error.contains("Re-check"));
        assert!(!error.to_lowercase().contains("complete"));
    }

    #[test]
    fn install_llama_cpp_nonzero_exit_reports_failure_with_tail() {
        let result = run_install_with(true, || Ok((false, "0x8A150 something failed".to_string())));
        assert!(!result.success);
        assert_eq!(result.code, Some(LlamaCppInstallCode::InstallFailed));
        assert!(result.error.expect("error").contains("something failed"));
    }

    #[test]
    fn install_llama_cpp_success_reports_complete() {
        let result = run_install_with(true, || Ok((true, "Successfully installed".to_string())));
        assert!(result.success);
        assert_eq!(result.code, None);
        assert!(result.error.is_none());
        assert!(result.output.contains("Successfully installed"));
    }

    #[test]
    fn install_llama_cpp_spawn_error_is_structured() {
        let result = run_install_with(true, || {
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "winget missing"))
        });
        assert!(!result.success);
        assert_eq!(result.code, Some(LlamaCppInstallCode::SpawnFailed));
    }

    /// Guard: `-e` forces an exact PackageIdentifier match, so a wrong id fails with
    /// "No package found matching input criteria." and the one-click install can never
    /// succeed. Canonical id per the microsoft/winget-pkgs manifest
    /// `manifests/g/ggml/llamacpp/<version>/ggml.llamacpp.installer.yaml`
    /// (`PackageIdentifier: ggml.llamacpp`). `WINGET_APP_ID` is Windows-only.
    #[cfg(target_os = "windows")]
    #[test]
    fn winget_app_id_is_the_canonical_winget_package_identifier() {
        assert_eq!(WINGET_APP_ID, "ggml.llamacpp");
    }

    #[test]
    fn companion_readiness_serializes_camel_case() {
        let readiness = CompanionReadiness {
            ready: false,
            prerequisites: vec![
                PrerequisiteReport {
                    id: "llamaServer".into(),
                    state: PrerequisiteState::Missing,
                    detail: "not found".into(),
                    resolved_path: None,
                },
                PrerequisiteReport {
                    id: "modelFiles".into(),
                    state: PrerequisiteState::Installed,
                    detail: "present".into(),
                    resolved_path: Some(r"C:\models".into()),
                },
            ],
        };
        let json = serde_json::to_string(&readiness).unwrap();
        assert!(json.contains("\"resolvedPath\""));
        assert!(json.contains("\"llamaServer\""));
        assert!(json.contains("\"missing\""));
        assert!(json.contains("\"installed\""));
        assert!(json.contains("\"ready\":false"));

        let install = LlamaCppInstallResult {
            success: false,
            output: String::new(),
            error: Some("x".into()),
            code: Some(LlamaCppInstallCode::WingetUnavailable),
        };
        let json = serde_json::to_string(&install).unwrap();
        assert!(json.contains("\"wingetUnavailable\""));
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

        // An errored file also blocks completion.
        let errored = vec![
            file("model", FileState::Present),
            file("vision", FileState::Error),
            file("mtp", FileState::Present),
        ];
        assert_eq!(
            model_files_prerequisite(&errored, "/models".to_string()).state,
            PrerequisiteState::Missing
        );

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

    #[test]
    fn tail_of_truncates_long_output() {
        let long = "x".repeat(1000);
        assert_eq!(tail_of(&long, 400).chars().count(), 400);
        assert_eq!(tail_of("short", 400), "short");
    }
}
