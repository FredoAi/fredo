use clap::Parser;
use std::path::{Path, PathBuf};

use crate::features::setup::model_download::{
    download_missing_files, DownloadProgress, ProgressReporter, ProgressState, ReqwestTransport,
    SystemClock,
};
use crate::features::setup::model_download_state::{default_manifest, probe_files, FileState};

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

    /// Install Fredo plugin for OpenCode and configure OTEL telemetry
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

fn is_opencode_plugin_installed(home: &Path) -> bool {
    opencode_plugins_dir(home).join("fredo.js").exists()
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

fn cli_check_otel_configured() -> bool {
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
                let p = home_dir().join(rc);
                std::fs::read_to_string(p)
                    .map(|c| c.contains("# fredo-otel-opencode"))
                    .unwrap_or(false)
            })
    }
}

fn cli_configure_opencode_otel() -> Result<(), String> {
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

        let home = home_dir();
        let rc_files = ["~/.zshrc", "~/.bashrc", "~/.profile"];
        for rc in &rc_files {
            let expanded = rc.replacen("~", &home.to_string_lossy(), 1);
            let path = std::path::Path::new(&expanded);
            if !path.exists() && *rc != "~/.profile" {
                continue;
            }
            let current = if path.exists() {
                std::fs::read_to_string(path)
                    .map_err(|e| format!("Could not read {rc}: {e}"))?
            } else {
                String::new()
            };
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

/// Run CLI setup commands standalone (no IPC / no AppHandle).
pub async fn run_setup(args: &SetupArgs) -> anyhow::Result<()> {
    if args.check {
        let bin_is_available = is_binary_available("opencode");
        let home = home_dir();
        let plugin_installed = is_opencode_plugin_installed(&home);

        // fredo-path
        let fredo_status = crate::features::setup::commands::check_fredo_in_path();
        let fredo_path = if fredo_status.in_path {
            serde_json::json!({"status": "ok", "detail": "Fredo binary is in PATH."})
        } else {
            serde_json::json!({"status": "missing", "detail": format!("Not in PATH. Binary at: {}", fredo_status.binary_path)})
        };

        // opencode
        let opencode = if bin_is_available {
            serde_json::json!({"status": "ok", "detail": "OpenCode CLI is installed."})
        } else {
            serde_json::json!({"status": "missing", "detail": "OpenCode CLI not found. Install from https://opencode.ai/docs/install."})
        };

        // plugin
        let plugin = if !bin_is_available {
            serde_json::json!({"status": "error", "detail": "OpenCode CLI not installed — cannot verify plugin."})
        } else if plugin_installed {
            serde_json::json!({"status": "ok", "detail": "Fredo plugin is installed."})
        } else {
            serde_json::json!({"status": "missing", "detail": "Fredo plugin not installed."})
        };

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

        // otel
        let otel = if cli_check_otel_configured() {
            serde_json::json!({"status": "ok", "detail": "OTEL telemetry configured."})
        } else {
            serde_json::json!({"status": "missing", "detail": "OpenCode OTEL not configured."})
        };

        let result = serde_json::json!({
            "fredo_path": fredo_path,
            "opencode": opencode,
            "plugin": plugin,
            "model": model,
            "otel": otel,
        });

        println!("{}", serde_json::to_string_pretty(&result)?);
    }

    if args.add_to_path {
        let result = crate::features::setup::commands::add_fredo_to_path();
        if result.success {
            println!("{}", result.output);
        } else {
            tracing::error!(target: "fredo::cli", error = %result.error.as_deref().unwrap_or("unknown error"), "setup step error");
            std::process::exit(1);
        }
    }

    if args.install_plugin {
        let home = home_dir();
        let src_dir = {
            let prod = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .join("apps/opencode-plugin");
            prod.canonicalize().unwrap_or(prod)
        };

        if !src_dir.exists() {
            tracing::error!(target: "fredo::cli", dir = %src_dir.display(), "plugin source not found");
            std::process::exit(1);
        }

        // Build step
        let dist_index_js = src_dir.join("dist").join("index.js");
        let needs_build = !dist_index_js.exists();
        if needs_build {
            let build_output = std::process::Command::new("bun")
                .args(["build", "src/index.ts", "--outdir", "dist", "--target", "bun"])
                .current_dir(&src_dir)
                .output()
                .map_err(|e| anyhow::anyhow!("Failed to run bun build: {e}"))?;

            if !build_output.status.success() {
                let stderr = String::from_utf8_lossy(&build_output.stderr);
                let stdout = String::from_utf8_lossy(&build_output.stdout);
                tracing::error!(target: "fredo::cli", stdout = %stdout, stderr = %stderr, "bun build failed");
                std::process::exit(1);
            }
        }

        // Copy plugin file
        let plugins_dir = opencode_plugins_dir(&home);
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| anyhow::anyhow!("Could not create plugins directory: {e}"))?;

        let dest_file = plugins_dir.join("fredo.js");
        std::fs::copy(&dist_index_js, &dest_file)
            .map_err(|e| anyhow::anyhow!("Failed to copy plugin: {e}"))?;

        // Configure OTEL
        if let Err(e) = cli_configure_opencode_otel() {
            tracing::warn!(target: "fredo::cli", error = %e, "OTEL configuration failed");
        }

        tracing::info!(target: "fredo::cli", path = %dest_file.display(), "plugin installed");
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
}
