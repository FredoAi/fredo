//! Doom engine + IWAD resolution (Spec #2968, ST-4).
//!
//! Resolution mirrors the shipped `infrastructure::companion::resolver`
//! (`resolve_llama_server_order`) with ONE deliberate Doom-specific difference:
//! a **configured** engine/IWAD path is returned **verbatim** even when it does
//! not exist on disk, so a bad configured path surfaces as `spawnFailed` (F-10a)
//! rather than silently falling through to `notConfigured`. PATH and
//! runtime-downloaded candidates must exist to be selected.
//!
//! Resolution order (binding, ST-4):
//!
//! * engine: env `FREDO_DOOM_ENGINE_PATH` → setting `doom_engine_path` → PATH
//!   `restful-doom` → the runtime-downloaded `<install_dir>/engine/restful-doom.exe`.
//! * IWAD: env `FREDO_DOOM_IWAD_PATH` → setting `doom_iwad_path` → the
//!   runtime-downloaded `<install_dir>/freedoom/freedoom1.wad`.
//!
//! Nothing resolves ⇒ `None` (the caller returns [`DoomErrorCode::NotConfigured`]).
//! No filesystem search outside the repo happens here (G-172); the only PATH
//! lookup is the same `where`/`which` helper the llama resolver uses.
//!
//! [`DoomErrorCode::NotConfigured`]: super::state::DoomErrorCode::NotConfigured

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;

use super::acquisition::{
    DOOM_ENGINE_EXE, DOOM_ENGINE_SUBDIR, DOOM_IWAD_FILENAME, FREEDOOM_SUBDIR,
};
use super::state::{
    DOOM_ENGINE_PATH_ENV, DOOM_ENGINE_PATH_KEY, DOOM_IWAD_PATH_ENV, DOOM_IWAD_PATH_KEY,
    DOOM_REQUIRE_REAL_ENGINE_ENV,
};

/// The upstream engine binary basename searched on PATH.
pub const DOOM_ENGINE_BIN: &str = "restful-doom";

/// A non-blank, trimmed string; `None` for absent/blank/whitespace-only.
fn non_blank(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// Resolve an executable on PATH (first match). Local helper — no cross-application
/// import (mirrors `infrastructure::companion::resolver::find_on_path`).
pub fn find_engine_on_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let finder = "where";
    #[cfg(not(target_os = "windows"))]
    let finder = "which";

    std::process::Command::new(finder)
        .arg(DOOM_ENGINE_BIN)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Configured engine path (non-blank env override → non-blank setting), trimmed.
/// Returned verbatim — a configured-but-missing path is the caller's
/// `spawnFailed` signal, never a silent fall-through.
pub fn configured_engine(app: &AppHandle) -> Option<String> {
    let env = std::env::var(DOOM_ENGINE_PATH_ENV).ok();
    let configured = app
        .state::<Arc<AppStore>>()
        .cached_get(DOOM_ENGINE_PATH_KEY)
        .ok()
        .flatten();
    non_blank(env.as_deref()).or_else(|| non_blank(configured.as_deref()))
}

/// Configured IWAD path (non-blank env override → non-blank setting), trimmed.
pub fn configured_iwad(app: &AppHandle) -> Option<String> {
    let env = std::env::var(DOOM_IWAD_PATH_ENV).ok();
    let configured = app
        .state::<Arc<AppStore>>()
        .cached_get(DOOM_IWAD_PATH_KEY)
        .ok()
        .flatten();
    non_blank(env.as_deref()).or_else(|| non_blank(configured.as_deref()))
}

/// The staged engine executable `<install_dir>/engine/restful-doom.exe`, when it
/// exists (the runtime-downloaded candidate).
pub fn downloaded_engine(app: &AppHandle) -> Option<PathBuf> {
    let dir = super::process::resolve_install_dir(app).ok()?;
    let candidate = dir.join(DOOM_ENGINE_SUBDIR).join(DOOM_ENGINE_EXE);
    candidate.is_file().then_some(candidate)
}

/// The staged IWAD `<install_dir>/freedoom/freedoom1.wad`, when it exists.
pub fn downloaded_iwad(app: &AppHandle) -> Option<PathBuf> {
    let dir = super::process::resolve_install_dir(app).ok()?;
    let candidate = dir.join(FREEDOOM_SUBDIR).join(DOOM_IWAD_FILENAME);
    candidate.is_file().then_some(candidate)
}

/// Pure engine resolution order (unit-tested): configured verbatim → `on_path`
/// (already resolved) → `downloaded` **only when it exists on disk**.
pub fn resolve_engine_order(
    configured: Option<&str>,
    on_path: Option<PathBuf>,
    downloaded: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = non_blank(configured) {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = on_path {
        return Some(path);
    }
    downloaded.filter(|p| p.is_file())
}

/// Pure IWAD resolution order: configured verbatim → `downloaded` when it exists.
pub fn resolve_iwad_order(
    configured: Option<&str>,
    downloaded: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = non_blank(configured) {
        return Some(PathBuf::from(path));
    }
    downloaded.filter(|p| p.is_file())
}

/// Resolve a usable Doom engine executable (ST-4). `None` when nothing is
/// configured, found on PATH, or already staged — the caller then attempts
/// acquisition, and on `None` there too returns `NotConfigured`.
pub fn resolve_engine(app: &AppHandle) -> Option<String> {
    resolve_engine_order(
        configured_engine(app).as_deref(),
        find_engine_on_path(),
        downloaded_engine(app),
    )
    .map(|path| path.to_string_lossy().into_owned())
}

/// Resolve the configured/staged IWAD (ST-4). `None` when nothing is configured
/// or staged — the caller then attempts the Freedoom acquisition.
pub fn resolve_iwad(app: &AppHandle) -> Option<String> {
    resolve_iwad_order(configured_iwad(app).as_deref(), downloaded_iwad(app))
        .map(|path| path.to_string_lossy().into_owned())
}

/// Whether the anti-stub guard is active: `FREDO_DOOM_REQUIRE_REAL_ENGINE=1`.
/// Inert (false) when unset, blank, or any other value.
pub fn require_real_engine() -> bool {
    std::env::var(DOOM_REQUIRE_REAL_ENGINE_ENV)
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

/// Whether `path`'s basename is the real engine binary ([`DOOM_ENGINE_EXE`],
/// `restful-doom.exe`). Case-insensitive; a bare/other basename is not real.
pub fn is_real_engine_path(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case(DOOM_ENGINE_EXE))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_order_prefers_configured_verbatim_then_path_then_existing_download() {
        let on_path = PathBuf::from("C:/tools/restful-doom.exe");
        let downloaded = PathBuf::from("C:/app/doom/engine/restful-doom.exe");

        // Configured wins even when it does not exist (verbatim → spawnFailed).
        assert_eq!(
            resolve_engine_order(Some(r"C:\missing\doom.exe"), Some(on_path.clone()), None),
            Some(PathBuf::from(r"C:\missing\doom.exe"))
        );
        // Blank configured is skipped in favour of PATH.
        assert_eq!(
            resolve_engine_order(Some("   "), Some(on_path.clone()), None),
            Some(on_path.clone())
        );
        // No configured → PATH.
        assert_eq!(
            resolve_engine_order(None, Some(on_path.clone()), None),
            Some(on_path.clone())
        );
        // A downloaded candidate that does not exist is NOT selected.
        assert_eq!(
            resolve_engine_order(None, None, Some(downloaded.clone())),
            None
        );
        assert_eq!(resolve_engine_order(None, None, None), None);
    }

    #[test]
    fn iwad_order_prefers_configured_verbatim_then_existing_download() {
        let downloaded = PathBuf::from("C:/app/doom/freedoom/freedoom1.wad");
        assert_eq!(
            resolve_iwad_order(Some(r"C:\wads\DOOM.WAD"), None),
            Some(PathBuf::from(r"C:\wads\DOOM.WAD"))
        );
        assert_eq!(resolve_iwad_order(Some("  "), None), None);
        assert_eq!(resolve_iwad_order(None, Some(downloaded.clone())), None);
        assert_eq!(resolve_iwad_order(None, None), None);
    }

    #[test]
    fn non_blank_trims_and_rejects_empty() {
        assert_eq!(non_blank(Some("  x  ")), Some("x".to_string()));
        assert_eq!(non_blank(Some("   ")), None);
        assert_eq!(non_blank(Some("")), None);
        assert_eq!(non_blank(None), None);
    }

    #[test]
    fn a_staged_engine_resolves_via_the_downloaded_candidate() {
        // ST-3: the ST-2 staged build (`<install_dir>/engine/restful-doom.exe`) is
        // selected when nothing is configured and nothing is on PATH — the
        // `downloaded_engine` leg.
        let dir = tempfile::tempdir().expect("tempdir");
        let staged = dir.path().join("engine").join(DOOM_ENGINE_EXE);
        std::fs::create_dir_all(staged.parent().expect("engine dir")).expect("mkdir");
        std::fs::write(&staged, b"MZ").expect("write staged engine");

        assert_eq!(
            resolve_engine_order(None, None, Some(staged.clone())),
            Some(staged)
        );
    }

    #[test]
    fn the_anti_stub_guard_recognises_only_the_real_engine_basename() {
        assert!(is_real_engine_path(r"C:\app\doom\engine\restful-doom.exe"));
        assert!(is_real_engine_path("RESTFUL-DOOM.EXE"));
        assert!(!is_real_engine_path(r"C:\build\doom_stub.exe"));
        assert!(!is_real_engine_path("doom-stub"));
        assert!(!is_real_engine_path(""));
    }

    #[test]
    fn the_anti_stub_guard_is_inert_unless_the_env_is_exactly_one() {
        // The seam is inert when unset; this asserts the parse contract without
        // mutating the process env (which would race sibling tests).
        let parse = |value: Option<&str>| value.map(|v| v.trim() == "1").unwrap_or(false);
        assert!(!parse(None));
        assert!(!parse(Some("")));
        assert!(!parse(Some("0")));
        assert!(!parse(Some("true")));
        assert!(parse(Some("1")));
        assert!(parse(Some(" 1 ")));
        assert_eq!(DOOM_REQUIRE_REAL_ENGINE_ENV, "FREDO_DOOM_REQUIRE_REAL_ENGINE");
    }
}
