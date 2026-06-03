use clap::Parser;
use futures_util::StreamExt;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

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

// ── Model constants (must match setup/commands.rs) ────────────────────────────

const MODEL_SUBDIR: &str = "gemma-e2b-it";
const MODEL_GGUF: &str = "gemma-4-E2B-it-Q4_K_M.gguf";
const MODEL_MMPROJ: &str = "mmproj-F16.gguf";

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

fn opencode_plugins_dir(home: &PathBuf) -> PathBuf {
    home.join(".config").join("opencode").join("plugins")
}

fn is_opencode_plugin_installed(home: &PathBuf) -> bool {
    opencode_plugins_dir(home).join("fredo.js").exists()
}

fn resolve_models_dir() -> PathBuf {
    home_dir().join("fredo-models").join(MODEL_SUBDIR)
}

fn resolve_model_path(subdir: &str, filename: &str) -> Option<PathBuf> {
    let fb = home_dir().join("fredo-models").join(subdir).join(filename);
    if fb.exists() { Some(fb) } else { None }
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

        // model
        let gguf_path = resolve_model_path(MODEL_SUBDIR, MODEL_GGUF);
        let mmproj_path = resolve_model_path(MODEL_SUBDIR, MODEL_MMPROJ);
        let model = if gguf_path.is_some() && mmproj_path.is_some() {
            serde_json::json!({"status": "ok", "detail": "Both model files present."})
        } else if gguf_path.is_some() {
            serde_json::json!({"status": "missing", "detail": "GGUF model found but mmproj missing."})
        } else if mmproj_path.is_some() {
            serde_json::json!({"status": "missing", "detail": "mmproj found but GGUF model missing."})
        } else {
            serde_json::json!({"status": "missing", "detail": "No model files found."})
        };

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
            eprintln!("Error: {}", result.error.unwrap_or_else(|| "unknown error".into()));
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
            eprintln!("Error: Plugin source directory not found: {}", src_dir.display());
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
                eprintln!("bun build failed:\nstdout: {stdout}\nstderr: {stderr}");
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
            eprintln!("Warning: could not configure OTEL: {e}");
        }

        println!("Installed plugin to {}", dest_file.display());
    }

    if args.download_model {
        let models_dir = resolve_models_dir();
        std::fs::create_dir_all(&models_dir)
            .map_err(|e| anyhow::anyhow!("Failed to create models directory: {e}"))?;

        let base_url = "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main";
        let files = [MODEL_GGUF, MODEL_MMPROJ];
        let client = reqwest::Client::new();

        for &filename in &files {
            let url = format!("{base_url}/{filename}");
            let dest = models_dir.join(filename);

            if dest.exists() {
                eprintln!("[fredo] {filename}: already exists, skipping.");
                continue;
            }

            eprint!("[fredo] Downloading {filename}...");

            let response = client.get(&url).send().await
                .map_err(|e| anyhow::anyhow!("Failed to start download: {e}"))?;

            let total = response.content_length().unwrap_or(0);
            let mut downloaded: u64 = 0;
            let mut stream = response.bytes_stream();
            let mut file = tokio::fs::File::create(&dest).await
                .map_err(|e| anyhow::anyhow!("Failed to create file: {e}"))?;

            while let Some(chunk_result) = stream.next().await {
                let chunk = chunk_result.map_err(|e| anyhow::anyhow!("Download failed: {e}"))?;
                downloaded += chunk.len() as u64;
                file.write_all(&chunk).await
                    .map_err(|e| anyhow::anyhow!("Write failed: {e}"))?;

                if total > 0 {
                    let percent = (downloaded as f64 / total as f64) * 100.0;
                    eprint!("\r[fredo] Downloading {filename}... {percent:.1}%");
                }
            }

            eprintln!("\r[fredo] Downloaded {filename} to {}", dest.display());
        }
    }

    Ok(())
}
