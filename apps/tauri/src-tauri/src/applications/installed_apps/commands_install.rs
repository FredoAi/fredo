//! The two install/list Tauri commands (Spec #3147, ST-2).
//!
//! ST-4 (`open`/`close`) and ST-5 (`push_theme`) own the other three commands;
//! this module deliberately carries **exactly** two:
//!
//! | Command | Args | Success | Failure |
//! |---|---|---|---|
//! | [`installed_app_install`] | `archivePath?: string` (absent ⇒ native picker) | [`InstalledAppEntry`] | [`InstalledAppError`] |
//! | [`installed_apps_list`] | none | `Vec<InstalledAppEntry>` | [`InstalledAppError`] |
//!
//! # Nothing runs at startup
//!
//! [`installed_apps_list`] is the ONLY reader of the install root, and nothing
//! calls it from `lib.rs`'s setup closure — the listing happens when the
//! settings pane asks (R-5.5: startup cost must not grow with the number of
//! installed applications).
//!
//! # Why the manifest is safe by construction
//!
//! The archive's `fredo-app.json` reaches [`super::manifest::parse_manifest`],
//! which is `serde_json` and nothing else. No field of the manifest is ever
//! interpreted as code, a path to execute, or a URL to fetch.

use std::path::{Path, PathBuf};

use tauri::Manager;

use super::consent;
use super::store::{self, InstalledAppEntry};
use super::{InstalledAppError, InstalledAppRefusalCode, InstalledAppResult};

/// The native picker's filter label and extensions.
const PACKAGE_DIALOG_TITLE: &str = "Choose an application package";
const PACKAGE_DIALOG_FILTER_LABEL: &str = "Fredo application package";
const PACKAGE_DIALOG_EXTENSIONS: [&str; 1] = ["zip"];

/// Resolve the app-data dir through the ONE shipped resolver.
///
/// `infrastructure::storage::boot_config::resolve_app_data_dir` is the single
/// `FREDO_DATA_DIR`-aware rule the whole app uses (Spec #2977 G-275), so
/// installed apps follow `FREDO_DATA_DIR` exactly like every other app-data
/// consumer. A failure to resolve the OS dir is `io_error` — the app cannot
/// work without it.
///
/// `pub(super)` so the consent commands resolve the SAME directory (the consent
/// file is a sibling of the install root) rather than re-deriving it.
pub(super) fn app_data_dir(app: &tauri::AppHandle) -> InstalledAppResult<PathBuf> {
    let os_dir = app.path().app_data_dir().map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("this build cannot resolve its application data directory: {error}"),
        )
    })?;
    Ok(crate::infrastructure::storage::boot_config::resolve_app_data_dir(&os_dir))
}

/// Open the native "choose a package" dialog off the UI thread.
///
/// `rfd` is already a direct dependency with a shipped precedent at
/// `applications/wireframe/commands.rs`. The dialog blocks, so it runs on the
/// blocking pool; a cancelled dialog is `Ok(None)`.
async fn pick_archive() -> InstalledAppResult<Option<PathBuf>> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title(PACKAGE_DIALOG_TITLE)
            .add_filter(PACKAGE_DIALOG_FILTER_LABEL, &PACKAGE_DIALOG_EXTENSIONS)
            .pick_file()
    })
    .await
    .map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the package picker could not be opened: {error}"),
        )
    })?;
    Ok(picked)
}

/// The picked package, resolved from the optional argument or the native picker.
///
/// A blank `archivePath` is treated as absent (the common "the frontend passed
/// an empty string" case) rather than as "open the file named ``".
fn resolve_archive_path(archive_path: Option<&str>, picked: Option<PathBuf>) -> InstalledAppResult<PathBuf> {
    if let Some(given) = archive_path.map(str::trim).filter(|value| !value.is_empty()) {
        let path = Path::new(given).to_path_buf();
        if !path.is_file() {
            return Err(InstalledAppError::new(
                InstalledAppRefusalCode::IoError,
                format!("no package exists at {given}"),
            ));
        }
        return Ok(path);
    }

    picked.ok_or_else(|| InstalledAppError::new(InstalledAppRefusalCode::IoError, CANCEL_DETAIL))
}

/// A short, non-fatal note when the user cancels the native picker.
pub const CANCEL_DETAIL: &str = "the package picker was dismissed; nothing was installed";

/// Install a package from a `.zip` chosen by the user (AC-1 / R-3.x).
///
/// `archivePath` absent (or blank) opens the native picker. Every failure is a
/// named [`InstalledAppError`]; on refusal nothing is written to the install
/// root (see [`store::install_archive`]).
#[tauri::command]
pub async fn installed_app_install(
    app: tauri::AppHandle,
    archive_path: Option<String>,
) -> InstalledAppResult<InstalledAppEntry> {
    let named = archive_path.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let picked = if named.is_some() {
        None
    } else {
        pick_archive().await?
    };
    let path = resolve_archive_path(named, picked)?;

    let data_dir = app_data_dir(&app)?;

    // The install is synchronous filesystem work with bounded, archive-declared
    // sizes; it runs on the blocking pool so the IPC thread stays responsive.
    tauri::async_runtime::spawn_blocking(move || store::install_archive(&data_dir, &path))
        .await
        .map_err(|error| {
            InstalledAppError::new(
                InstalledAppRefusalCode::IoError,
                format!("the install task could not be run: {error}"),
            )
        })?
}

/// List every installed application (R-1.1's read surface).
///
/// The ONLY reader of the install root. Deliberately NOT called at startup
/// (R-5.5) — the settings pane asks when it mounts.
///
/// The projection's `capabilities.consented` is filled from the host-owned consent
/// record (Spec #3146) — one read of `<app_data_dir>/installed-apps-consent.json`
/// for the whole listing, never one per row — and a grant is applied to the ONE
/// application it names.
#[tauri::command]
pub async fn installed_apps_list(app: tauri::AppHandle) -> InstalledAppResult<Vec<InstalledAppEntry>> {
    let data_dir = app_data_dir(&app)?;
    let root = store::install_root(&data_dir);

    tauri::async_runtime::spawn_blocking(move || -> InstalledAppResult<Vec<InstalledAppEntry>> {
        let entries = store::list_installed(&root)?;
        let document = consent::read_document(&data_dir);
        Ok(entries
            .into_iter()
            .map(|entry| {
                let granted = document.grants.get(&entry.id).cloned().unwrap_or_default();
                entry.with_consented(&granted)
            })
            .collect())
    })
    .await
    .map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the listing task could not be run: {error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picker_filter_is_a_zip_filter() {
        assert_eq!(PACKAGE_DIALOG_EXTENSIONS, ["zip"]);
        assert!(!PACKAGE_DIALOG_TITLE.is_empty());
        assert!(!PACKAGE_DIALOG_FILTER_LABEL.is_empty());
    }

    #[test]
    fn a_blank_archive_path_falls_back_to_the_picked_file() {
        let picked = Some(PathBuf::from("C:/tmp/package.zip"));
        assert_eq!(
            resolve_archive_path(Some("   "), picked.clone()).expect("picked"),
            PathBuf::from("C:/tmp/package.zip"),
            "a blank argument is not a file name"
        );
        assert_eq!(
            resolve_archive_path(None, picked).expect("picked"),
            PathBuf::from("C:/tmp/package.zip")
        );
    }

    #[test]
    fn a_missing_archive_path_and_no_pick_is_an_io_error() {
        let error = resolve_archive_path(None, None).expect_err("nothing chosen");
        assert_eq!(error.code, InstalledAppRefusalCode::IoError);
        assert!(!error.detail.is_empty(), "the cancellation names itself");
    }

    #[test]
    fn a_named_path_that_does_not_exist_is_an_io_error() {
        let error =
            resolve_archive_path(Some("C:/definitely/not/here.zip"), None).expect_err("absent");
        assert_eq!(error.code, InstalledAppRefusalCode::IoError);
        assert!(error.detail.contains("here.zip"));
    }

    #[test]
    fn an_existing_named_path_wins_over_a_pick() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("chosen.zip");
        std::fs::write(&path, b"not read here").expect("write");

        let resolved = resolve_archive_path(
            Some(path.to_string_lossy().as_ref()),
            Some(PathBuf::from("C:/ignored/other.zip")),
        )
        .expect("named path");
        assert_eq!(resolved, path);
    }

    /// The command surface this module owns is exactly two functions — a guard
    /// so a later sub-task's command cannot be added here by accident (the plan
    /// assigns `open`/`close` to ST-4 and `push_theme` to ST-5).
    #[test]
    fn the_module_owns_exactly_the_two_install_commands() {
        // Scan the PRODUCT source only. The `#[cfg(test)]` module below quotes
        // the attribute marker in its own assertions, and counting those would
        // make this guard count itself.
        let source = include_str!("commands_install.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            2,
            "commands_install.rs must carry exactly installed_app_install + installed_apps_list"
        );
        assert!(product.contains("pub async fn installed_app_install("));
        assert!(product.contains("pub async fn installed_apps_list("));
        for other in [
            "installed_app_open",
            "installed_app_close",
            "installed_apps_push_theme",
        ] {
            assert!(
                !product.contains(&format!("pub async fn {other}(")),
                "{other} belongs to another sub-task"
            );
        }
    }
}
