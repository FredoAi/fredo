//! `llama-server` executable resolution (Spec #2857 ST-1).
//!
//! Shared by `features/setup` (readiness detection) and `features/llm_server`
//! (launch) so both consume ONE resolution order — configured
//! `llama_server_path` → PATH `llama-server` → winget Links shim.
//!
//! PURE MOVE of the #2855 resolver out of `features/setup/commands.rs`; the
//! resolution order and the wire output of `check_companion_readiness` are
//! unchanged.

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;

pub const LLAMA_SERVER_BIN: &str = "llama-server";
pub const LLAMA_SERVER_SETTING_KEY: &str = "llama_server_path";

/// Resolve an executable on PATH (first match). Local helper — no cross-feature import.
fn find_on_path(bin: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let finder = "where";
    #[cfg(not(target_os = "windows"))]
    let finder = "which";

    std::process::Command::new(finder)
        .arg(bin)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// The winget shim location — required because the running process's inherited
/// PATH does not refresh after `winget install` (keeps AC-3's "no reload" honest).
#[cfg(target_os = "windows")]
fn winget_links_shim() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| {
        PathBuf::from(dir)
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join(format!("{LLAMA_SERVER_BIN}.exe"))
    })
}

#[cfg(not(target_os = "windows"))]
fn winget_links_shim() -> Option<PathBuf> {
    None
}

/// Pure resolution order (unit-tested): configured path → PATH → winget shim.
/// `on_path` is the already-resolved PATH candidate; `shim` the winget Link.
pub fn resolve_llama_server_order(
    configured: Option<&str>,
    on_path: Option<PathBuf>,
    shim: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = configured {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Some(path) = on_path {
        return Some(path);
    }
    shim.filter(|p| p.is_file())
}

/// Resolve a usable `llama-server` executable. #2855 only DETECTS — never launches.
/// `Err` means the configured path could not be read (the prerequisite is then
/// reported as `Error` — "could not determine" — never as `Missing`).
pub fn resolve_llama_server(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let configured = app
        .state::<Arc<AppStore>>()
        .get(LLAMA_SERVER_SETTING_KEY)
        .map_err(|e| e.to_string())?;
    Ok(resolve_llama_server_order(
        configured.as_deref(),
        find_on_path(LLAMA_SERVER_BIN),
        winget_links_shim(),
    ))
}
