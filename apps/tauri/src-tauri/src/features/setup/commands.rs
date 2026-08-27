use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::storage::AppStore;

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

#[derive(Serialize)]
pub struct ModelFilesStatus {
    pub gguf_exists: bool,
    pub mmproj_exists: bool,
    pub gguf_path: Option<String>,
    pub mmproj_path: Option<String>,
}

#[derive(Serialize)]
pub struct SetupStepResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub file: String,
    pub total: u64,
    pub downloaded: u64,
    pub percent: f64,
}

/// Model constants for download and checking
const MODEL_SUBDIR: &str = "gemma-e2b-it";
const MODEL_GGUF: &str = "gemma-4-E2B-it-Q4_K_M.gguf";
const MODEL_MMPROJ: &str = "mmproj-F16.gguf";

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

/// Resolve a model file path relative to the configured models_dir.
fn resolve_model_path(app: &AppHandle, subdir: &str, filename: &str) -> Option<PathBuf> {
    let base = resolve_models_dir(app);
    let path = base.join(subdir).join(filename);
    if path.exists() {
        Some(path)
    } else {
        None
    }
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

    // model
    let gguf_path = resolve_model_path(&app, MODEL_SUBDIR, MODEL_GGUF);
    let mmproj_path = resolve_model_path(&app, MODEL_SUBDIR, MODEL_MMPROJ);
    let model = if gguf_path.is_some() && mmproj_path.is_some() {
        StepStatus { status: "ok".into(), detail: Some("Both model files present.".into()) }
    } else if gguf_path.is_some() {
        StepStatus { status: "missing".into(), detail: Some("GGUF model found but mmproj missing.".into()) }
    } else if mmproj_path.is_some() {
        StepStatus { status: "missing".into(), detail: Some("mmproj found but GGUF model missing.".into()) }
    } else {
        StepStatus { status: "missing".into(), detail: Some("No model files found. Run download_model to fetch them.".into()) }
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

/// Check whether GGUF and mmproj model files exist in the configured models directory.
#[tauri::command]
pub fn check_model_files(app: AppHandle) -> ModelFilesStatus {
    let gguf_path = resolve_model_path(&app, MODEL_SUBDIR, MODEL_GGUF);
    let mmproj_path = resolve_model_path(&app, MODEL_SUBDIR, MODEL_MMPROJ);

    ModelFilesStatus {
        gguf_exists: gguf_path.is_some(),
        mmproj_exists: mmproj_path.is_some(),
        gguf_path: gguf_path.map(|p| p.to_string_lossy().into_owned()),
        mmproj_path: mmproj_path.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Download both model files from Hugging Face.
/// Emits `setup:download-progress` events per file with progress info.
#[tauri::command]
pub async fn download_model(app: AppHandle) -> SetupStepResult {
    let models_dir = resolve_models_dir(&app).join(MODEL_SUBDIR);
    if let Err(e) = std::fs::create_dir_all(&models_dir) {
        return SetupStepResult {
            success: false,
            output: String::new(),
            error: Some(format!("Failed to create models directory: {e}")),
        };
    }

    let base_url = "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main";
    let files = [MODEL_GGUF, MODEL_MMPROJ];

    for filename in &files {
        let url = format!("{base_url}/{filename}");
        let dest = models_dir.join(filename);

        // Skip if already exists
        if dest.exists() {
            let _ = app.emit("setup:download-progress", DownloadProgress {
                file: filename.to_string(),
                total: 0,
                downloaded: 0,
                percent: 100.0,
            });
            continue;
        }

        // Download with progress
        let client = reqwest::Client::new();
        let response = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return SetupStepResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to download {filename}: {e}")),
            },
        };

        let total = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();

        use futures_util::StreamExt;
        let mut file = match tokio::fs::File::create(&dest).await {
            Ok(f) => f,
            Err(e) => return SetupStepResult {
                success: false,
                output: String::new(),
                error: Some(format!("Failed to create file {filename}: {e}")),
            },
        };

        use tokio::io::AsyncWriteExt;
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    downloaded += chunk.len() as u64;
                    if let Err(e) = file.write_all(&chunk).await {
                        return SetupStepResult {
                            success: false,
                            output: String::new(),
                            error: Some(format!("Failed to write {filename}: {e}")),
                        };
                    }
                    let percent = if total > 0 {
                        (downloaded as f64 / total as f64) * 100.0
                    } else {
                        0.0
                    };
                    let _ = app.emit("setup:download-progress", DownloadProgress {
                        file: filename.to_string(),
                        total,
                        downloaded,
                        percent,
                    });
                }
                Err(e) => return SetupStepResult {
                    success: false,
                    output: String::new(),
                    error: Some(format!("Download stream error for {filename}: {e}")),
                },
            }
        }
    }

    SetupStepResult {
        success: true,
        output: format!("Downloaded model files to {}", models_dir.display()),
        error: None,
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
}
