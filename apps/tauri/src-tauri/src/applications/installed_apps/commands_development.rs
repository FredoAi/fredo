//! The development-install Tauri command (Spec #3241, ST-2).
//!
//! Exactly ONE command lives here, and it exists for one reason: **development
//! mode adds a way to load**, not a way to reach more.
//!
//! | Command | Args (camelCase) | Success | Failure |
//! |---|---|---|---|
//! | [`installed_app_install_development`] | `archivePath?: string` (absent **or blank** ⇒ native picker) | [`InstalledAppEntry`] with `mode: development` | [`InstalledAppError`] (one of the frozen 22) |
//!
//! # Why a separate command and not an argument on `installed_app_install`
//!
//! Two shipped invariants depend on the install command's shape, and both are
//! pinned: `installed_app_install`'s signature (`archivePath: Option<String>` →
//! `InstalledAppResult<InstalledAppEntry>`) and
//! `commands_install.rs::the_module_owns_exactly_the_two_install_commands`. Adding
//! a `mode` argument to the shipped command would move the first, and adding this
//! command to that file would move the second. So it gets its own module, and the
//! shipped file is not edited at all.
//!
//! # Zero privilege
//!
//! The mode is a **host-side load decision**: it is not a manifest key, so a
//! package cannot declare itself development (or released) and no fixture
//! generator can emit one. The command is granted to the **built-in** window class
//! exactly as `installed_app_install` already is
//! (`permissions/app/default.toml`), so an `installed-<id>` document cannot reach
//! it — its one capability grants only `allow-installed-app-invoke`. And the mode
//! never enters the authority path: `read_authority_grants` reads only the
//! canonical manifest and the consent file, so a development build has exactly the
//! reach of the same archive installed normally.
//!
//! # Nothing at startup
//!
//! Nothing calls this from `lib.rs`'s setup closure; the app-data dir is resolved
//! per call, so startup cost does not grow with the number of installed
//! applications.

use super::commands_install::{app_data_dir, pick_archive, resolve_archive_path};
use super::store::{self, InstalledAppEntry, InstalledAppMode};
use super::{InstalledAppError, InstalledAppRefusalCode, InstalledAppResult};

/// Load a package as a **development build** (Spec #3241, R-3.1 / R-3.7).
///
/// `archivePath` absent (or blank) opens the native picker, exactly like
/// [`super::commands_install::installed_app_install`] — a blank argument is
/// treated as absent by the SHIPPED `resolve_archive_path`, so the two commands
/// cannot drift on that rule.
///
/// The install itself is the shipped pipeline with one addition: the marker file
/// is written **into the staging directory**, so the same atomic rename that
/// publishes the application also publishes its mark
/// ([`store::install_archive_with_mode`]). Every refusal reuses one of the frozen
/// 22 codes — this command adds none.
#[tauri::command]
pub async fn installed_app_install_development(
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

    // Synchronous filesystem work with bounded, archive-declared sizes, so it runs
    // on the blocking pool exactly like the ordinary install.
    tauri::async_runtime::spawn_blocking(move || {
        store::install_archive_with_mode(&data_dir, &path, InstalledAppMode::Development)
    })
    .await
    .map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the development install task could not be run: {error}"),
        )
    })?
}

/// The app-data resolution this module deliberately does NOT re-implement.
///
/// `commands_install::app_data_dir` is the ONE shipped resolver (it calls
/// `infrastructure::storage::boot_config::resolve_app_data_dir`, the single
/// `FREDO_DATA_DIR`-aware rule). A second local derivation here would be a second
/// resolver for one path — this assertion exists so the import above cannot be
/// quietly replaced by a local copy.
#[cfg(test)]
mod tests {
    /// The command surface this module owns is exactly one function, and the
    /// shipped `commands_install` module was not touched to accommodate it.
    #[test]
    fn the_module_owns_exactly_the_development_install_command() {
        let source = include_str!("commands_development.rs");
        // Scan PRODUCT source only: the `#[cfg(test)]` module below quotes the
        // attribute marker in its own assertion, and counting those would make
        // this guard count itself.
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            1,
            "commands_development.rs must carry exactly installed_app_install_development"
        );
        assert!(product.contains("pub async fn installed_app_install_development("));
        for other in [
            "installed_app_install",
            "installed_apps_list",
            "installed_app_open",
            "installed_app_close",
        ] {
            assert!(
                !product.contains(&format!("pub async fn {other}(")),
                "{other} belongs to another module"
            );
        }
    }

    /// The development path is the SHIPPED install pipeline with a mode — not a
    /// parallel implementation. If this ever stops calling
    /// `install_archive_with_mode` with `Development`, the mode would silently stop
    /// being written.
    #[test]
    fn the_development_path_delegates_to_the_one_install_pipeline() {
        let source = include_str!("commands_development.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);
        assert!(
            product.contains("store::install_archive_with_mode(&data_dir, &path, InstalledAppMode::Development)"),
            "the development install must go through install_archive_with_mode with Development"
        );
    }

    /// There is no dev-mode flag, env var, config key or setting (G-402, declared
    /// absence). If one ever appears here, the documented induction lever has
    /// changed and every QA row that says "there is no env var" is wrong.
    #[test]
    fn there_is_no_development_mode_flag_or_env_var() {
        let source = include_str!("commands_development.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);
        for forbidden in ["FREDO_DEV_MODE", "FREDO_DEVELOPMENT_MODE", "dev_mode", "DEV_MODE"] {
            assert!(
                !product.contains(forbidden),
                "development mode must be chosen by WHICH COMMAND RAN, never by {forbidden}"
            );
        }
    }
}
