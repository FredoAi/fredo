//! The native tray icon (Spec #3192 ST-2).
//!
//! Once closes destroy the `main` webview (ST-1) the tray is the only surface
//! that can bring Fredo back: it offers exactly two verbs, `Open` and `Quit`,
//! separated so a stray click cannot reach the destructive one. Both dispatch
//! into the ONE lifecycle module (`infrastructure::app_lifecycle`):
//! `tray-open` → [`app_lifecycle::ensure_main_window`] and `tray-quit` →
//! [`app_lifecycle::quit`], so the tray, the `open_main_window`/`quit_app`
//! commands and the second-launch probe share one implementation.
//!
//! Why a NATIVE menu: the premise of the resident shell is that the main webview
//! may be destroyed, so a menu hosted by that webview would die with it — and
//! take `Quit` with it. The menu is built with `MenuBuilder` on the OS, never in
//! the webview.
//!
//! [`install_tray`] is called ONCE from `setup` (a second tray would leak an
//! icon — `TrayIcon` is reference-counted and removes the icon when the last
//! instance is dropped, so [`TrayHandle`] is managed for the process lifetime).
//! [`ResidentShellState::mark_tray_installed`] is flipped only AFTER
//! `TrayIconBuilder::build` returns `Ok`, so a failed tray degrades to the
//! pre-feature close semantics instead of orphaning a windowless process (R-2d).
//!
//! macOS: the application bar's Quit item is REPLACED by one that routes through
//! [`app_lifecycle::quit`] ([`install_app_menu`]). That is what lets the exit gate
//! prevent every `code: None` exit on every platform (so closing the last window
//! stays resident — R-1a) while ⌘Q still exits cleanly through the bounded
//! `RunEvent::Exit` teardown (R-3): the platform quit now arrives as a menu event
//! we own, and the exit it requests is programmatic (`code: Some(0)`).
//!
//! No webview event, no IPC round-trip, no new icon asset: the icon is the shipped
//! application icon (`app.default_window_icon()`), set as a macOS template image
//! so it reads in light and dark menu bars.

use tauri::menu::{Menu, MenuBuilder, MenuEvent};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};

use crate::infrastructure::app_lifecycle::{self, ResidentShellState};
use crate::infrastructure::env::EnvConfig;

/// The tray icon's identity. One icon per process.
pub const TRAY_ICON_ID: &str = "fredo-tray";

/// The `Open` item — the non-destructive verb, first in the menu.
pub const TRAY_MENU_OPEN_ID: &str = "tray-open";
/// The `Quit` item — last, behind a separator.
pub const TRAY_MENU_QUIT_ID: &str = "tray-quit";

/// Menu labels exactly as AC2 pins them (`Open` / `Quit`). Identity lives in the
/// tooltip, not the labels.
pub const TRAY_MENU_OPEN_LABEL: &str = "Open";
pub const TRAY_MENU_QUIT_LABEL: &str = "Quit";

/// The macOS application-menu Quit item (see [`install_app_menu`]). Defined on
/// every platform so the shared dispatch arm is compiled and pinned everywhere;
/// the item only ever exists on macOS.
pub const APP_MENU_QUIT_ID: &str = "app-menu-quit";

/// Windows caps a notification-area tooltip at 128 characters (`szTip`); the
/// accessible name must stay non-empty and inside it on every platform.
pub const TRAY_TOOLTIP_MAX_CHARS: usize = 128;

/// One entry of the shipped tray menu, in order.
///
/// This is the ONE description of the menu: [`install_tray`] builds the real
/// `Menu` by iterating it, and the unit pin reads it back, so the pin and the
/// shipped menu cannot drift. (Constructing a `Menu` headlessly needs a mock app
/// handle — enabling Tauri's `test` feature in the shipped binary — so the pin is
/// builder-level, and the live content is read back from the real `Menu` through
/// `app_lifecycle_status`.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayMenuEntry {
    /// An actionable item: `MenuBuilder::text(id, label)`.
    Item {
        id: &'static str,
        label: &'static str,
    },
    /// A non-actionable separator (`MenuBuilder::separator`).
    Separator,
}

use TrayMenuEntry::{Item as TrayItem, Separator as TraySeparator};

/// Exactly two actionable items — `Open`, a separator, `Quit`. No third entry,
/// no status label, no settings/refresh verb.
pub const TRAY_MENU: &[TrayMenuEntry] = &[
    TrayItem {
        id: TRAY_MENU_OPEN_ID,
        label: TRAY_MENU_OPEN_LABEL,
    },
    TraySeparator,
    TrayItem {
        id: TRAY_MENU_QUIT_ID,
        label: TRAY_MENU_QUIT_LABEL,
    },
];

/// The tray's accessible name / tooltip: `"<window title> — running"`.
///
/// `window_title` is [`EnvConfig::window_title`] — `Fredo`, or `Fredo [<envId>]`
/// for an isolated environment — so the tray carries the same identity as the
/// window it restores.
///
/// It says **running**, never "capturing": the tooltip is set once when the icon
/// is built, before the OTLP receivers are bound, and no health observable is
/// wired to it — claiming a capture state nobody reads would be a lie the tray
/// could never correct (UI/UX §1 accuracy rule). Always non-empty: an icon-only
/// affordance's accessible name is the only label a screen reader receives.
pub fn tray_tooltip(window_title: &str) -> String {
    let base = match window_title.trim() {
        "" => "Fredo",
        trimmed => trimmed,
    };
    let tooltip = format!("{base} — running");
    tooltip.chars().take(TRAY_TOOLTIP_MAX_CHARS).collect()
}

/// The process-lifetime keeper of the native tray.
///
/// `TrayIcon` is reference-counted and the icon is removed when the last instance
/// is dropped, so holding it in managed state is what keeps the icon on screen —
/// no explicit removal is needed at exit. The `Menu` is held as well because
/// [`tray_menu_items`] reads the REAL menu back (never a copy of [`TRAY_MENU`]).
pub struct TrayHandle {
    /// The icon owns the OS resource: the last `TrayIcon` dropped removes it, so
    /// this field is the process-lifetime keeper (never read directly).
    _icon: TrayIcon<tauri::Wry>,
    /// The real menu, read back by [`tray_menu_items`].
    menu: Menu<tauri::Wry>,
}

/// Build and attach the ONE tray icon. Called once, from `setup`.
///
/// The `tray_installed` policy bit is flipped only after a successful build, so
/// the exit gate keeps the pre-feature semantics when no tray exists (R-2d).
pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .menu(&menu)
        .tooltip(tray_tooltip(&EnvConfig::from_env().window_title()))
        // Primary click opens this same menu on every platform: one interaction
        // model, and `Quit` stays one click away (UI/UX §2 click model).
        .show_menu_on_left_click(true)
        .on_menu_event(dispatch_menu_event);

    // No new icon asset: the shipped application icon
    // (`bundle.icon` → `app.default_window_icon()`, with the shipped
    // `icons/32x32.png` as the documented contingency). On macOS it is set as a
    // template image below so it reads in both menu-bar themes.
    if let Some(icon) = tray_icon_image(app) {
        builder = builder.icon(icon);
    }

    let icon = builder.build(app)?;

    #[cfg(target_os = "macos")]
    if let Err(error) = icon.set_icon_as_template(true) {
        tracing::warn!(
            target: "fredo::tray",
            error = %error,
            "could not mark the tray icon as a macOS template image"
        );
    }

    app.manage(TrayHandle { _icon: icon, menu });
    app.state::<ResidentShellState>().mark_tray_installed();
    Ok(())
}

/// Build the real `Menu` from [`TRAY_MENU`], in order.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let mut builder = MenuBuilder::new(app);
    for entry in TRAY_MENU {
        builder = match entry {
            TrayItem { id, label } => builder.text(*id, *label),
            TraySeparator => builder.separator(),
        };
    }
    builder.build()
}

/// The tray's artwork: the shipped application icon, with the shipped
/// `icons/32x32.png` as the contingency when the bundle icon is not populated
/// (the icon is the only affordance once the window is destroyed, so it is never
/// silently omitted).
fn tray_icon_image(app: &AppHandle) -> Option<tauri::image::Image<'_>> {
    if let Some(icon) = app.default_window_icon() {
        return Some(icon.clone());
    }

    tracing::warn!(
        target: "fredo::tray",
        "the bundled application icon is unavailable; falling back to icons/32x32.png"
    );
    match tauri::image::Image::from_bytes(include_bytes!("../../icons/32x32.png")) {
        Ok(image) => Some(image),
        Err(error) => {
            tracing::error!(
                target: "fredo::tray",
                error = %error,
                "could not decode the fallback tray icon; the tray keeps the OS placeholder"
            );
            None
        }
    }
}

/// Route a menu event to its one handler. Registered for the tray (its own
/// `on_menu_event`) and, on macOS, for the application menu (`Builder::
/// on_menu_event`) — one dispatch, so both surfaces reach the same primitives.
pub fn dispatch_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        TRAY_MENU_OPEN_ID => {
            // `ensure_main_window` is the ONE recreate-or-focus primitive: an
            // existing window is restored and focused (never duplicated), a
            // destroyed one is rebuilt with the cold-launch identity (R-2b/R-2c).
            if let Err(error) = app_lifecycle::ensure_main_window(app) {
                tracing::warn!(
                    target: "fredo::app_lifecycle",
                    error = %error,
                    "the tray Open item could not restore the main window; the next Open retries"
                );
            }
        }
        // Quit — the bounded-teardown path (`AppHandle::exit(0)`), the same one
        // the `quit_app` command takes (R-3).
        TRAY_MENU_QUIT_ID | APP_MENU_QUIT_ID => app_lifecycle::quit(app),
        other => tracing::trace!(
            target: "fredo::tray",
            id = other,
            "ignoring an unknown menu item id"
        ),
    }
}

/// macOS only: the application menu, with a Quit item that routes through
/// [`app_lifecycle::quit`].
///
/// Compiles on every platform (the menu API is platform-neutral) so its shape is
/// type-checked on the Windows CI host; only the call site is macOS-gated. The
/// standard Edit and Window submenus are rebuilt because replacing the app menu
/// must not cost the webview its clipboard accelerators. Replacing the default
/// menu also removes the platform's predefined Quit item, so ⌘Q now reaches
/// [`dispatch_menu_event`] instead of terminating the app behind the exit gate.
pub fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    let app_name = app.package_info().name.clone();
    let quit = MenuItemBuilder::with_id(APP_MENU_QUIT_ID, format!("Quit {app_name}"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, &app_name)
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&quit)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

/// macOS only: install the application menu built by [`build_app_menu`]. A
/// failure is logged and never fatal — the tray Quit item is the guaranteed quit
/// surface (R-2d), so Fredo is never left unquittable.
#[cfg(target_os = "macos")]
pub fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_app_menu(app)?;
    app.set_menu(menu)?;
    Ok(())
}

/// One actionable menu item as the webview reads it back from the REAL menu.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuItemView {
    pub id: String,
    pub label: String,
}

/// What `app_lifecycle_status` reports: whether the `main` window exists right
/// now (it is absent while resident-and-destroyed) and the tray's real menu.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLifecycleStatus {
    pub main_window_open: bool,
    pub tray_items: Vec<TrayMenuItemView>,
}

/// The tray's actionable items, read from the REAL `Menu` (`Menu::items()` →
/// `MenuItemKind::as_menuitem()` → `id()`/`text()`) — never from [`TRAY_MENU`].
/// Separators carry no `MenuItem` and are skipped, so the result is exactly the
/// two actionable entries.
pub fn tray_menu_items(app: &AppHandle) -> Vec<TrayMenuItemView> {
    let Some(handle) = app.try_state::<TrayHandle>() else {
        // No tray (it failed to build): the process is not resident, and the
        // honest answer is "no tray items" rather than a copy of the spec.
        return Vec::new();
    };

    match handle.menu.items() {
        Ok(items) => items
            .iter()
            .filter_map(|kind| kind.as_menuitem())
            .map(|item| TrayMenuItemView {
                id: item.id().as_ref().to_string(),
                label: item.text().unwrap_or_default(),
            })
            .collect(),
        Err(error) => {
            tracing::warn!(
                target: "fredo::tray",
                error = %error,
                "could not read the tray menu items"
            );
            Vec::new()
        }
    }
}

/// Whether the `main` window currently exists (a destroyed window is gone from
/// the manager; a hidden one would still be listed).
fn main_window_open(app: &AppHandle) -> bool {
    app.get_webview_window(app_lifecycle::MAIN_WINDOW_LABEL)
        .is_some()
}

/// Report the resident shell's observable state: the `main` window's presence
/// and the tray menu read back from the real native menu (AC2).
#[tauri::command]
pub async fn app_lifecycle_status(app: AppHandle) -> AppLifecycleStatus {
    AppLifecycleStatus {
        main_window_open: main_window_open(&app),
        tray_items: tray_menu_items(&app),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Menu content (exactly Open / separator / Quit) ──────────────────────

    #[test]
    fn the_menu_is_open_separator_quit_and_nothing_else() {
        assert_eq!(
            TRAY_MENU,
            &[
                TrayItem {
                    id: "tray-open",
                    label: "Open"
                },
                TraySeparator,
                TrayItem {
                    id: "tray-quit",
                    label: "Quit"
                },
            ],
            "the tray menu must be exactly Open, a separator, Quit — in that order"
        );

        let actionable: Vec<(&str, &str)> = TRAY_MENU
            .iter()
            .filter_map(|entry| match entry {
                TrayItem { id, label } => Some((*id, *label)),
                TraySeparator => None,
            })
            .collect();
        assert_eq!(
            actionable.len(),
            2,
            "exactly two actionable items; no Get/Refresh/Settings/status entry"
        );
        assert_eq!(
            actionable,
            vec![("tray-open", "Open"), ("tray-quit", "Quit")],
            "the ids and labels are the binding ones from the plan's names block"
        );
        assert_eq!(
            TRAY_MENU
                .iter()
                .filter(|entry| matches!(entry, TraySeparator))
                .count(),
            1,
            "one separator, between the two items"
        );
        assert_eq!(
            TRAY_MENU.first(),
            Some(&TrayItem {
                id: TRAY_MENU_OPEN_ID,
                label: TRAY_MENU_OPEN_LABEL
            }),
            "Open is first (the common, non-destructive verb)"
        );
        assert_eq!(
            TRAY_MENU.last(),
            Some(&TrayItem {
                id: TRAY_MENU_QUIT_ID,
                label: TRAY_MENU_QUIT_LABEL
            }),
            "Quit is last, behind the separator"
        );
    }

    #[test]
    fn the_tray_identity_constants_are_the_documented_values() {
        assert_eq!(TRAY_ICON_ID, "fredo-tray");
        assert_eq!(TRAY_MENU_OPEN_ID, "tray-open");
        assert_eq!(TRAY_MENU_QUIT_ID, "tray-quit");
        assert_eq!(TRAY_MENU_OPEN_LABEL, "Open");
        assert_eq!(TRAY_MENU_QUIT_LABEL, "Quit");
        assert_eq!(APP_MENU_QUIT_ID, "app-menu-quit");
        assert_eq!(TRAY_TOOLTIP_MAX_CHARS, 128);
        assert_ne!(
            TRAY_MENU_OPEN_ID, TRAY_MENU_QUIT_ID,
            "the two ids must be distinguishable in the dispatch arm"
        );
        assert_ne!(
            APP_MENU_QUIT_ID, TRAY_MENU_QUIT_ID,
            "the app-menu Quit must not collide with the tray Quit id"
        );
    }

    // ── Accessible name / tooltip ───────────────────────────────────────────

    #[test]
    fn the_tooltip_carries_the_window_identity() {
        assert_eq!(tray_tooltip("Fredo"), "Fredo — running");
        assert_eq!(
            tray_tooltip("Fredo [spec3192-b]"),
            "Fredo [spec3192-b] — running"
        );
    }

    #[test]
    fn the_tooltip_is_never_empty_and_never_claims_unobserved_health() {
        for title in ["", "   ", "Fredo"] {
            let tooltip = tray_tooltip(title);
            assert!(
                !tooltip.trim().is_empty(),
                "the accessible name must never be empty (it is the whole application \
                 once the window is destroyed)"
            );
            assert!(
                tooltip.ends_with("— running"),
                "the tooltip states the process is running: {tooltip}"
            );
            assert!(
                !tooltip.to_lowercase().contains("captur"),
                "the tooltip must not claim a capture state nobody observes: {tooltip}"
            );
            assert!(tooltip.len() <= TRAY_TOOLTIP_MAX_CHARS);
        }
    }

    #[test]
    fn the_tooltip_is_clamped_to_the_windows_limit() {
        let long_title = "F".repeat(TRAY_TOOLTIP_MAX_CHARS * 2);
        let tooltip = tray_tooltip(&long_title);
        assert_eq!(
            tooltip.chars().count(),
            TRAY_TOOLTIP_MAX_CHARS,
            "a longer title must be clamped, not dropped (the name stays non-empty)"
        );
        assert!(tooltip.starts_with("FF"), "the clamp keeps the identity's head");
    }

    // ── Wire shape of `app_lifecycle_status` ────────────────────────────────

    #[test]
    fn app_lifecycle_status_serializes_camel_case() {
        let status = AppLifecycleStatus {
            main_window_open: false,
            tray_items: vec![
                TrayMenuItemView {
                    id: "tray-open".to_string(),
                    label: "Open".to_string(),
                },
                TrayMenuItemView {
                    id: "tray-quit".to_string(),
                    label: "Quit".to_string(),
                },
            ],
        };

        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "mainWindowOpen": false,
                "trayItems": [
                    { "id": "tray-open", "label": "Open" },
                    { "id": "tray-quit", "label": "Quit" },
                ],
            })
        );
        // An open window must not be reported as absent (non-vacuity of the flag).
        assert_eq!(
            serde_json::to_value(AppLifecycleStatus {
                main_window_open: true,
                tray_items: Vec::new(),
            })
            .unwrap()["mainWindowOpen"],
            serde_json::json!(true)
        );
    }
}
