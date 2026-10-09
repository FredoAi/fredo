//! Doom engine + IWAD resolution (Spec #3013, ST-1; originally #2968 ST-4).
//!
//! **Engine resolution is managed-only** (#3013 AC1): the only engine Doom Mode
//! uses is the one Fredo staged into the chosen managed install directory
//! (`<install_dir>/engine/restful-doom.exe`, validated by
//! [`super::provision::staged_engine_path`]). There is NO PATH (`where`/`which`)
//! lookup, NO configured engine override, and NO runtime-downloaded engine. An
//! absent/unbuilt managed engine resolves to `None`; the caller then reports the
//! provisioning state — never a substitute.
//!
//! IWAD resolution is unchanged (Spec #2968 ST-4): a **configured** IWAD path
//! (env `FREDO_DOOM_IWAD_PATH` → setting `doom_iwad_path`) is returned **verbatim**
//! even when it does not exist on disk, so a bad configured path surfaces as
//! `notConfigured` rather than silently falling through to the Freedoom download.
//! The staged `<install_dir>/freedoom/freedoom1.wad` candidate must exist to be
//! selected.
//!
//! Nothing resolves ⇒ `None`. No filesystem search outside the repo and the
//! managed install directory happens here (G-172).

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;

use super::acquisition::{
    DOOM_ENGINE_EXE, DOOM_ENGINE_SUBDIR, DOOM_IWAD_FILENAME, FREEDOOM_SUBDIR,
};
use super::state::{DOOM_IWAD_PATH_ENV, DOOM_IWAD_PATH_KEY};

/// A non-blank, trimmed string; `None` for absent/blank/whitespace-only.
fn non_blank(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// Configured IWAD path (non-blank env override → non-blank setting), trimmed.
/// Returned verbatim — a configured-but-missing path is the caller's
/// `notConfigured` signal, never a silent fall-through.
pub fn configured_iwad(app: &AppHandle) -> Option<String> {
    let env = std::env::var(DOOM_IWAD_PATH_ENV).ok();
    let configured = app
        .state::<Arc<AppStore>>()
        .cached_get(DOOM_IWAD_PATH_KEY)
        .ok()
        .flatten();
    non_blank(env.as_deref()).or_else(|| non_blank(configured.as_deref()))
}

/// The staged managed engine executable `<install_dir>/engine/restful-doom.exe`,
/// when it exists — the ONLY engine candidate (#3013).
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

/// Pure engine resolution (unit-tested): the managed staged candidate **only when
/// it exists on disk**. No PATH or configured candidate is ever considered.
pub fn resolve_engine_order(downloaded: Option<PathBuf>) -> Option<PathBuf> {
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

/// Resolve a usable Doom engine executable (managed-only, #3013 ST-1). `None`
/// when the managed staged engine is absent/unbuilt — the caller then reports the
/// provisioning state (never a substitute engine, never a download).
pub fn resolve_engine(app: &AppHandle) -> Option<String> {
    resolve_engine_order(downloaded_engine(app)).map(|path| path.to_string_lossy().into_owned())
}

/// Resolve the configured/staged IWAD. `None` when nothing is configured or
/// staged — the caller then attempts the Freedoom acquisition.
pub fn resolve_iwad(app: &AppHandle) -> Option<String> {
    resolve_iwad_order(configured_iwad(app).as_deref(), downloaded_iwad(app))
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_resolution_is_the_managed_staged_candidate_only() {
        // A managed candidate that does not exist on disk is NOT selected, and
        // there is no other leg to fall through to.
        let missing = PathBuf::from("C:/app/doom/engine/restful-doom.exe");
        assert_eq!(resolve_engine_order(Some(missing)), None);
        assert_eq!(resolve_engine_order(None), None);
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
    fn a_staged_managed_engine_resolves_via_the_staged_candidate() {
        // The #3012 staged build (`<install_dir>/engine/restful-doom.exe`) is the
        // ONLY engine candidate (#3013 AC1).
        let dir = tempfile::tempdir().expect("tempdir");
        let staged = dir.path().join("engine").join(DOOM_ENGINE_EXE);
        std::fs::create_dir_all(staged.parent().expect("engine dir")).expect("mkdir");
        std::fs::write(&staged, b"MZ").expect("write staged engine");

        assert_eq!(resolve_engine_order(Some(staged.clone())), Some(staged));
    }
}
