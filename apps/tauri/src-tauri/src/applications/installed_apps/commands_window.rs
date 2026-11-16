//! The two window-lifecycle Tauri commands (Spec #3147, ST-4).
//!
//! Exactly two commands, and no others — an installed application's window is
//! opened on demand and closed on demand, and nothing else in this slice needs a
//! verb:
//!
//! | Command | Args (camelCase) | Success | Failure |
//! |---|---|---|---|
//! | [`installed_app_open`] | `appId: string` | `()` | [`InstalledAppError`] |
//! | [`installed_app_close`] | `appId: string` | `bool` (true iff a window was closed) | [`InstalledAppError`] |
//!
//! # Order of operations on open
//!
//! 1. The id is normalised and refused if malformed or if it names a built-in
//!    application (`id_invalid` / `id_is_installed_app`).
//! 2. [`window::resolve_open_target`] proves the whole install record against the
//!    bytes on disk (`integrity_mismatch` / `integrity_record_corrupt`) and the
//!    directory's existence (`id_not_installed`) — **before any window exists**,
//!    so the refusal is reported by the launcher the user clicked from (AC-4.4).
//! 3. Only then is the window built (or an existing one focused).
//!
//! # Nothing at startup
//!
//! Neither command is called from `lib.rs`'s setup closure; the app-data dir is
//! resolved per call, which is why startup cost does not grow with the number of
//! installed applications (R-5.5).
//!
//! # Why the filesystem work is off the IPC thread
//!
//! Verification reads and hashes every installed file, so it runs on the
//! blocking pool. The window itself is built on the async runtime's main thread
//! — a `WebviewWindowBuilder` cannot be constructed from a blocking worker.

use tauri::AppHandle;

use super::window;
use super::{InstalledAppError, InstalledAppRefusalCode, InstalledAppResult};

/// Resolve the app-data dir through the ONE shipped resolver.
///
/// `infrastructure::storage::boot_config::resolve_app_data_dir` is the single
/// `FREDO_DATA_DIR`-aware rule the whole app follows (Spec #2977 G-275), so the
/// installed-app window path reads the same install root the installer wrote to.
fn app_data_dir(app: &AppHandle) -> InstalledAppResult<std::path::PathBuf> {
    use tauri::Manager;
    let os_dir = app.path().app_data_dir().map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("this build cannot resolve its application data directory: {error}"),
        )
    })?;
    Ok(crate::infrastructure::storage::boot_config::resolve_app_data_dir(&os_dir))
}

/// Open an installed application in its own window (R-1.2's window half, R-5.4).
///
/// Creates the singleton `installed-<id>` window at the `fredoapp` document URL
/// with the application's `displayName` as the OS title; an already-open window
/// is focused and nothing is rebuilt. Every refusal is a named
/// [`InstalledAppError`], and **no window is created on a refusal**.
#[tauri::command]
pub async fn installed_app_open(app: AppHandle, app_id: String) -> InstalledAppResult<()> {
    let id = window::normalize_app_id(&app_id)?;
    let data_dir = app_data_dir(&app)?;

    // Verification + record reading is synchronous filesystem work; keep it off
    // the IPC thread.
    let target = tauri::async_runtime::spawn_blocking(move || {
        window::resolve_open_target(&data_dir, &id)
    })
    .await
    .map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the open check could not be run: {error}"),
        )
    })??;

    window::open_installed_app_window(&app, &target)
}

/// Close an installed application's window (R-5.3).
///
/// Returns `true` iff a window was actually closed; `false` when the application
/// was not open — that is a successful answer, not an error. Closing destroys
/// the window and therefore the document, which is what stops the application's
/// code (there is no `unmount` in the contract).
#[tauri::command]
pub async fn installed_app_close(app: AppHandle, app_id: String) -> InstalledAppResult<bool> {
    window::close_installed_window(&window::TauriWindowHost::new(&app), &app_id)
}

#[cfg(test)]
mod tests {
    /// The command surface this module owns is exactly two functions — a guard
    /// so a later sub-task's command cannot be added here by accident (the plan
    /// assigns `install`/`list` to ST-2 and `push_theme` to ST-5).
    #[test]
    fn the_module_owns_exactly_the_two_window_commands() {
        // Scan the PRODUCT source only: the `#[cfg(test)]` module quotes the
        // attribute marker in its own assertions, and counting those would make
        // this guard count itself.
        let source = include_str!("commands_window.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            2,
            "commands_window.rs must carry exactly installed_app_open + installed_app_close"
        );
        // The command's Rust parameter is `app_id`, so the serde/camelCase wire
        // key Tauri invokes with is `appId`.
        assert!(product.contains("pub async fn installed_app_open("));
        assert!(product.contains("pub async fn installed_app_close("));
        assert_eq!(
            product.matches("app_id: String").count(),
            2,
            "both commands take exactly one `appId: string` argument"
        );
        for other in [
            "installed_app_install",
            "installed_apps_list",
            "installed_apps_push_theme",
        ] {
            assert!(
                !product.contains(&format!("pub async fn {other}(")),
                "{other} belongs to another sub-task"
            );
        }

        // The return shapes are the plan's: open -> (), close -> bool.
        assert!(product.contains("InstalledAppResult<()>"));
        assert!(product.contains("InstalledAppResult<bool>"));
    }

    /// No startup hook: nothing in the product code calls either command.
    #[test]
    fn nothing_calls_the_commands_from_startup() {
        let setup_region = setup_closure_region();
        // Non-vacuity: the extractor must really have found the setup closure,
        // not an empty slice, or the absence assertions below prove nothing.
        assert!(
            setup_region.contains("EnvConfig::from_env()"),
            "the setup-closure extractor is vacuous: {} chars",
            setup_region.len()
        );
        assert!(
            setup_region.contains("get_webview_window(\"main\")"),
            "the setup closure really does touch windows, so an installed-window \
             creation here would have been visible"
        );
        // The region really ends at the setup closure: the `generate_handler!`
        // block (which DOES name both commands) is outside it.
        assert!(
            !setup_region.contains("generate_handler!"),
            "the extracted region must stop at the setup closure, not run into \
             the registration block"
        );
        for command in ["installed_app_open", "installed_app_close"] {
            assert!(
                !setup_region.contains(command),
                "{command} must never be reachable from lib.rs's setup closure (R-5.1)"
            );
        }
        for token in [
            "installed_app",
            "installed-apps",
            "installed_apps_list",
            "open_installed_app_window",
        ] {
            assert!(
                !setup_region.contains(token),
                "the setup closure performs no installed-app work (found {token})"
            );
        }
    }

    /// The `builder.setup(|app| { … })` closure's source text, balanced by
    /// braces from the real `lib.rs` — never a hand-kept copy.
    fn setup_closure_region() -> String {
        let lib = include_str!("../../lib.rs");
        let start = lib.find("builder.setup(|app|").expect("lib.rs has a setup closure");
        let mut depth: i32 = 0;
        let mut end = lib.len();
        for (index, character) in lib[start..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = start + index + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        lib[start..end].to_string()
    }
}
