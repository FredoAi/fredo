//! Resident shell lifecycle (Spec #3192 ST-1).
//!
//! Fredo keeps running when the main window is closed: the OS close destroys the
//! `main` webview (the default close path — **no `CloseRequested` handler is
//! wired here**, that default IS the required destroy), and this process keeps
//! ingesting telemetry with no window at all. [`ensure_main_window`] is the ONE
//! recreate-or-focus primitive: the tray `Open` item (ST-2), the
//! `open_main_window` command and the second-launch probe (ST-3) all call it, so
//! the semantics are proven once.
//!
//! The exit policy lives at `RunEvent::ExitRequested` in `lib.rs` (see
//! [`should_prevent_exit`]): the process only refuses to exit while
//! [`ResidentShellState::tray_installed`] is `true`. A tray that failed to
//! install therefore degrades to the pre-feature close semantics (X exits)
//! instead of stranding a windowless process nobody can reach (R-2d).
//!
//! `tray_installed` is the ONE piece of policy state: [`ResidentShellState`]
//! starts `false` and ST-2 flips it to `true` only after the tray icon is really
//! built. ST-1 alone is inert-safe — closing the window still exits exactly as
//! before — and becomes observable only once the tray lands.
//!
//! No persistence, no window-visible surface and no `infrastructure/rtdb` touch:
//! the row pipeline, the Terminal/Doom close handlers and the `RunEvent::Exit`
//! teardown order are untouched.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::infrastructure::env::EnvConfig;

/// The OS window label Fredo's main webview keeps for its whole life. Mirrors
/// `tauri.conf.json`'s single window (which omits `label`, so it takes Tauri's
/// `main` default) — the drift guard below keeps the two artifacts in lockstep.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// The document a rebuilt main window loads — the same asset entry a cold launch
/// loads (`tauri.conf.json` sets no `url`, which is Tauri's `index.html`).
pub const MAIN_WINDOW_URL: &str = "index.html";

/// Cold-launch geometry, mirroring `tauri.conf.json` `app.windows[0]`.
pub const MAIN_WINDOW_SIZE: (f64, f64) = (1400.0, 900.0);
pub const MAIN_WINDOW_MIN_SIZE: (f64, f64) = (900.0, 600.0);
pub const MAIN_WINDOW_RESIZABLE: bool = true;
pub const MAIN_WINDOW_MAXIMIZED: bool = true;

/// Whether a `code: None` exit request is also how the platform delivers a
/// SYSTEM-initiated quit (⌘Q / the macOS app menu).
///
/// Tauri exposes no discriminator on `RunEvent::ExitRequested`: macOS delivers
/// both "the last window closed" and "the user pressed ⌘Q" as `code: None`
/// (programmatic exits carry `code: Some(_)`). The recorded convergence decision
/// for this spec is **macOS ⌘Q quits** — a resident process that swallows the
/// platform's own Quit is a macOS-hostile app, and the tray still *offers* Quit
/// as AC2 requires. So on macOS the gate never prevents a `None` exit: ⌘Q runs
/// the bounded `RunEvent::Exit` teardown, and the tray `Quit` (`quit`) remains the
/// visible exit there. Windows/Linux have no such ambiguity, so the
/// "last window closed" path stays resident while the tray is installed.
const SYSTEM_QUIT_SHARES_NONE_CODE: bool = cfg!(target_os = "macos");

/// What [`ensure_main_window`] did, reported to the caller (and, through the
/// `open_main_window` command, to the webview).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainWindowOutcome {
    /// `true` when the `main` window had to be built (it was destroyed, or its
    /// handle no longer focused), `false` when an existing window was reused.
    pub recreated: bool,
    /// `true` when the final `set_focus()` succeeded.
    pub focused: bool,
}

/// The ONE policy bit of the resident shell (R-2d).
///
/// `false` until [`Self::mark_tray_installed`] is called — which ST-2 does only
/// after `TrayIconBuilder::build` returns `Ok`. Until then the exit gate in
/// `lib.rs` lets every exit through, exactly like the pre-feature behaviour.
#[derive(Debug, Default)]
pub struct ResidentShellState {
    tray_installed: AtomicBool,
}

impl ResidentShellState {
    /// Record that a tray icon now exists (ST-2, once, on a successful build).
    pub fn mark_tray_installed(&self) {
        self.tray_installed.store(true, Ordering::SeqCst);
    }

    /// Whether the process currently has a reachable tray surface.
    pub fn tray_installed(&self) -> bool {
        self.tray_installed.load(Ordering::SeqCst)
    }
}

/// Whether the `RunEvent::ExitRequested` gate must call `api.prevent_exit()`.
///
/// - `code: Some(_)` — a programmatic exit (`AppHandle::exit`, which is what
///   [`quit`] and the tray's `Quit` item call). Always allowed: the bounded
///   `RunEvent::Exit` teardown (companion engine, PostgreSQL, Doom) must run.
/// - `code: None` — the last-window-closed path. Prevented ONLY while a tray is
///   installed, so the process stays resident and reachable; with no tray the
///   pre-feature behaviour (X exits) is preserved (R-2d).
/// - macOS: a system quit shares `code: None`, so it is never prevented — see
///   [`SYSTEM_QUIT_SHARES_NONE_CODE`].
pub fn should_prevent_exit(code: Option<i32>, tray_installed: bool) -> bool {
    should_prevent_exit_for(code, tray_installed, SYSTEM_QUIT_SHARES_NONE_CODE)
}

/// The platform-parameterised core of [`should_prevent_exit`], so both platform
/// branches are pinned by one deterministic test on any host.
fn should_prevent_exit_for(
    code: Option<i32>,
    tray_installed: bool,
    system_quit_shares_none_code: bool,
) -> bool {
    match code {
        Some(_) => false,
        None => tray_installed && !system_quit_shares_none_code,
    }
}

/// Focus the `main` window, rebuilding it when there is nothing left to focus.
///
/// An existing window is unminimized if needed and focused — never duplicated.
/// A focus error means the handle is unusable, so it is destroyed and rebuilt
/// rather than left unreachable. A rebuild failure is logged at
/// `fredo::app_lifecycle` and returned as `Err` — never a dialog: there may be no
/// window at all to host one. The next call simply retries.
pub fn ensure_main_window(app: &AppHandle) -> Result<MainWindowOutcome, String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if window.is_minimized().unwrap_or(false) {
            if let Err(error) = window.unminimize() {
                tracing::warn!(
                    target: "fredo::app_lifecycle",
                    error = %error,
                    "could not unminimize the main window"
                );
            }
        }

        match window.set_focus() {
            Ok(()) => {
                return Ok(MainWindowOutcome {
                    recreated: false,
                    focused: true,
                })
            }
            Err(error) => {
                tracing::warn!(
                    target: "fredo::app_lifecycle",
                    error = %error,
                    "could not focus the main window; destroying and rebuilding it"
                );
                if let Err(destroy_error) = window.destroy() {
                    tracing::error!(
                        target: "fredo::app_lifecycle",
                        error = %destroy_error,
                        "could not destroy the unusable main window before rebuilding it"
                    );
                }
            }
        }
    }

    let window = build_main_window(app)?;
    let focused = match window.set_focus() {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(
                target: "fredo::app_lifecycle",
                error = %error,
                "rebuilt the main window but could not focus it"
            );
            false
        }
    };

    Ok(MainWindowOutcome {
        recreated: true,
        focused,
    })
}

/// Build the `main` window at the cold-launch contract (label, title, geometry,
/// `index.html`). A failure is logged at `fredo::app_lifecycle` — no dialog.
fn build_main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let title = EnvConfig::from_env().window_title();

    let built = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        WebviewUrl::App(MAIN_WINDOW_URL.into()),
    )
    .title(title)
    .inner_size(MAIN_WINDOW_SIZE.0, MAIN_WINDOW_SIZE.1)
    .min_inner_size(MAIN_WINDOW_MIN_SIZE.0, MAIN_WINDOW_MIN_SIZE.1)
    .resizable(MAIN_WINDOW_RESIZABLE)
    .maximized(MAIN_WINDOW_MAXIMIZED)
    .build();

    match built {
        Ok(window) => Ok(window),
        Err(error) => {
            tracing::error!(
                target: "fredo::app_lifecycle",
                error = %error,
                "failed to rebuild the main window; no dialog is shown, the tray stays live and the next Open retries"
            );
            Err(format!("failed to rebuild the main window: {error}"))
        }
    }
}

/// The ONE quit primitive: exit with code `0`, which runs the bounded
/// `RunEvent::Exit` teardown. Called by the tray `Quit` item (ST-2) and the
/// `quit_app` command (the IPC seam).
pub fn quit(app: &AppHandle) {
    app.exit(0);
}

/// Focus or rebuild the `main` window (the webview / second-launch seam).
#[tauri::command]
pub async fn open_main_window(app: AppHandle) -> Result<MainWindowOutcome, String> {
    ensure_main_window(&app)
}

/// Quit Fredo through [`quit`] — the same path the tray `Quit` item takes. Never
/// wired to a visible control: the tray stays the only visible quit surface.
#[tauri::command]
pub async fn quit_app(app: AppHandle) {
    quit(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Constants ───────────────────────────────────────────────────────────

    #[test]
    fn main_window_constants_are_the_documented_values() {
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        assert_eq!(MAIN_WINDOW_URL, "index.html");
        assert_eq!(MAIN_WINDOW_SIZE, (1400.0, 900.0));
        assert_eq!(MAIN_WINDOW_MIN_SIZE, (900.0, 600.0));
        assert!(MAIN_WINDOW_RESIZABLE);
        assert!(MAIN_WINDOW_MAXIMIZED);
    }

    /// Drift guard: the rebuilt window and the cold-launch window are two
    /// artifacts pinning the SAME geometry, so they must not disagree. Parses the
    /// real `tauri.conf.json` — never a hand-kept copy.
    #[test]
    fn rebuilt_geometry_matches_tauri_conf() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json"))
                .expect("tauri.conf.json must be valid JSON");

        let windows = config["app"]["windows"]
            .as_array()
            .expect("tauri.conf.json must declare app.windows[]");
        // Non-vacuity: the guard must really be reading the window entry.
        assert!(
            !windows.is_empty(),
            "app.windows[] is empty; the drift guard would be vacuous"
        );
        let window = &windows[0];

        assert_eq!(
            window["width"].as_f64(),
            Some(MAIN_WINDOW_SIZE.0),
            "app.windows[0].width disagrees with MAIN_WINDOW_SIZE.0"
        );
        assert_eq!(
            window["height"].as_f64(),
            Some(MAIN_WINDOW_SIZE.1),
            "app.windows[0].height disagrees with MAIN_WINDOW_SIZE.1"
        );
        assert_eq!(
            window["minWidth"].as_f64(),
            Some(MAIN_WINDOW_MIN_SIZE.0),
            "app.windows[0].minWidth disagrees with MAIN_WINDOW_MIN_SIZE.0"
        );
        assert_eq!(
            window["minHeight"].as_f64(),
            Some(MAIN_WINDOW_MIN_SIZE.1),
            "app.windows[0].minHeight disagrees with MAIN_WINDOW_MIN_SIZE.1"
        );
        assert_eq!(
            window["resizable"].as_bool(),
            Some(MAIN_WINDOW_RESIZABLE),
            "app.windows[0].resizable disagrees with MAIN_WINDOW_RESIZABLE"
        );
        assert_eq!(
            window["maximized"].as_bool(),
            Some(MAIN_WINDOW_MAXIMIZED),
            "app.windows[0].maximized disagrees with MAIN_WINDOW_MAXIMIZED"
        );
        // Tauri's default label for a config window is `main`; an explicit label
        // must agree with the constant the rebuild uses.
        assert_eq!(
            window["label"].as_str().unwrap_or("main"),
            MAIN_WINDOW_LABEL,
            "app.windows[0].label disagrees with MAIN_WINDOW_LABEL"
        );
        // Likewise the loaded document: no `url` key means `index.html`.
        assert_eq!(
            window["url"].as_str().unwrap_or(MAIN_WINDOW_URL),
            MAIN_WINDOW_URL,
            "app.windows[0].url disagrees with MAIN_WINDOW_URL"
        );
    }

    // ── ResidentShellState (R-2d policy bit) ────────────────────────────────

    #[test]
    fn resident_shell_state_starts_with_no_tray_and_flips_once() {
        let state = ResidentShellState::default();
        assert!(
            !state.tray_installed(),
            "a fresh process has no tray; the exit gate must not prevent exit"
        );
        state.mark_tray_installed();
        assert!(state.tray_installed());
    }

    // ── Exit policy ────────────────────────────────────────────────────────

    #[test]
    fn programmatic_exit_is_never_prevented() {
        for tray_installed in [false, true] {
            for code in [Some(0), Some(1)] {
                assert!(
                    !should_prevent_exit(code, tray_installed),
                    "AppHandle::exit (code {code:?}) must always reach the teardown \
                     (tray_installed={tray_installed})"
                );
            }
        }
    }

    #[test]
    fn last_window_closed_is_prevented_only_with_a_tray() {
        assert!(
            should_prevent_exit(None, true),
            "a None exit with a live tray must keep the process resident"
        );
        assert!(
            !should_prevent_exit(None, false),
            "without a tray a None exit must be allowed (R-2d: never strand a \
             windowless process)"
        );
    }

    #[test]
    fn a_system_quit_sharing_the_none_code_always_exits() {
        // The macOS rule: a platform that reports ⌘Q as `code: None` must never
        // be prevented, for either tray state.
        assert!(!should_prevent_exit_for(None, true, true));
        assert!(!should_prevent_exit_for(None, false, true));
        // ...while non-macOS keeps the residency gate exactly.
        assert!(should_prevent_exit_for(None, true, false));
        assert!(!should_prevent_exit_for(None, false, false));
        // A programmatic exit exits on every platform.
        assert!(!should_prevent_exit_for(Some(0), true, true));
        assert!(!should_prevent_exit_for(Some(0), true, false));
    }

    // ── MainWindowOutcome wire shape ───────────────────────────────────────

    #[test]
    fn main_window_outcome_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(MainWindowOutcome {
                recreated: false,
                focused: true
            })
            .unwrap(),
            serde_json::json!({ "recreated": false, "focused": true })
        );
    }

    #[test]
    fn main_window_outcome_round_trips() {
        let outcome = MainWindowOutcome {
            recreated: true,
            focused: false,
        };
        let raw = serde_json::to_string(&outcome).unwrap();
        let parsed: MainWindowOutcome = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, outcome);
    }
}
