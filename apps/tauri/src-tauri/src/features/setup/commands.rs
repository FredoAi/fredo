use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CliCheckResult {
    pub opencode: bool,
    pub opencode_plugin_installed: bool,
}

#[derive(Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct FredoPathStatus {
    pub in_path: bool,
    pub binary_path: String,
}

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

fn opencode_plugin_dir(home: &PathBuf) -> PathBuf {
    home.join(".config")
        .join("opencode")
        .join("plugins")
        .join("fredo")
}

fn is_opencode_plugin_installed(home: &PathBuf) -> bool {
    opencode_plugin_dir(home).join("plugin.json").exists()
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
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let prod = resource_dir.join("plugin");
    let src = if prod.exists() {
        prod
    } else {
        let ws = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("apps/opencode-plugin");
        ws.canonicalize().unwrap_or(ws)
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

/// Install the Fredo plugin for OpenCode.
/// Copies plugin files to ~/.config/opencode/plugins/fredo/ and configures OTEL.
#[tauri::command]
pub fn install_plugin(app: AppHandle) -> InstallResult {
    let home = match app.path().home_dir() {
        Ok(h)  => h,
        Err(e) => return InstallResult {
            success: false,
            output: String::new(),
            error: Some(format!("Could not resolve home directory: {e}")),
        },
    };

    let src_dir = {
        let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        let prod = resource_dir.join("plugin");
        if prod.exists() {
            prod
        } else {
            let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .join("apps/opencode-plugin");
            workspace.canonicalize().unwrap_or(workspace)
        }
    };

    if !src_dir.exists() {
        return InstallResult {
            success: false,
            output: String::new(),
            error: Some(format!("Plugin source directory not found: {}", src_dir.display())),
        };
    }

    let dest_dir = opencode_plugin_dir(&home);
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        return InstallResult {
            success: false,
            output: String::new(),
            error: Some(format!("Could not create {}: {e}", dest_dir.display())),
        };
    }

    let mut copied = Vec::new();
    let entries = match std::fs::read_dir(&src_dir) {
        Ok(e)  => e,
        Err(e) => return InstallResult {
            success: false,
            output: String::new(),
            error: Some(format!("Could not read source directory: {e}")),
        },
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let dest = dest_dir.join(entry.file_name());
            if let Err(e) = std::fs::copy(&path, &dest) {
                return InstallResult {
                    success: false,
                    output: copied.join(", "),
                    error: Some(format!("Failed to copy {}: {e}", entry.file_name().to_string_lossy())),
                };
            }
            copied.push(entry.file_name().to_string_lossy().into_owned());
        }
    }

    // Configure OTEL env vars so OpenCode sends telemetry to Fredo
    let otel_result = configure_opencode_otel(&home);
    let output = format!(
        "Copied {} file(s) to {}{}",
        copied.len(),
        dest_dir.display(),
        if let Err(ref e) = otel_result {
            format!("\n[fredo] Warning: could not write OTEL config: {e}")
        } else {
            String::new()
        }
    );
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
$user   = [System.Environment]::GetEnvironmentVariable('PATH', 'User')   ?? ''
$system = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') ?? ''
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
