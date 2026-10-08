//! Platform-wide per-app window presentation (Spec #2955 ST-1).
//!
//! Generalizes the shipped Terminal-only presentation choice (#2947) into a
//! single contract every app shares:
//!
//! - [`AppPresentation`] — the ONE enum (`same-window` / `new-window`), reusing
//!   #2947's wire vocabulary unchanged.
//! - [`app_presentation`] — read the persisted `app_window_presentation` JSON
//!   map, with a one-way legacy fallback to `terminal_presentation_mode` for
//!   Terminal (correct routing before the first frontend hydrate).
//! - [`open_app_window`] / [`close_app_window`] — the cross-webview singleton /
//!   focus authority: only the Rust window manager sees every webview, so the
//!   singleton is enforced here by window label (`terminal` / `doom` /
//!   `app-<id>`), never in the main webview.
//!
//! The backend owns only the host window + focus. What an app renders inside the
//! window is the app's own concern (the generic `?view=app&id=<id>` route is a
//! later frontend sub-task).

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::infrastructure::storage::AppStore;

/// Whether an app renders inside the main Fredo window or in its own OS window.
///
/// Wire form is kebab-case (`same-window` / `new-window`) — the SAME vocabulary
/// #2947 shipped, now platform-wide. This is the ONE naming authority (G-255).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppPresentation {
    /// Render inside the main Fredo window's in-window kernel.
    SameWindow,
    /// Open in the app's own native OS window (singleton per app).
    NewWindow,
}

/// The AppStore control-plane KV key holding the persisted per-app map.
pub const APP_WINDOW_PRESENTATION_KEY: &str = "app_window_presentation";

/// The legacy Terminal-only key (#2947). Read as a one-way fallback, NEVER
/// rewritten by this code.
pub const LEGACY_TERMINAL_PRESENTATION_KEY: &str = "terminal_presentation_mode";

/// The presentation for an app with no stored (or unrecognized) choice: inside
/// the main Fredo window (AC2 — the default changed from #2947's Terminal
/// `new-window`).
pub const DEFAULT_APP_PRESENTATION: AppPresentation = AppPresentation::SameWindow;

/// The label prefix for a generic app's native window (`app-<appId>`). Bespoke
/// hosts use their own fixed labels (`terminal`, `doom`).
pub const GENERIC_APP_WINDOW_LABEL_PREFIX: &str = "app-";

impl AppPresentation {
    /// Parse a persisted wire value. `None` for an absent / blank / unrecognized
    /// value — the caller falls back to [`DEFAULT_APP_PRESENTATION`].
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "same-window" => Some(Self::SameWindow),
            "new-window" => Some(Self::NewWindow),
            _ => None,
        }
    }

    /// The kebab-case wire value — the inverse of [`Self::parse`].
    pub fn wire(self) -> &'static str {
        match self {
            Self::SameWindow => "same-window",
            Self::NewWindow => "new-window",
        }
    }
}

/// Map an app id to its native window label: the bespoke `terminal` / `doom`
/// hosts keep their fixed labels; every other app gets `app-<id>`.
pub fn app_window_label(app_id: &str) -> String {
    match app_id {
        "terminal" => "terminal".to_string(),
        "doom" => "doom".to_string(),
        other => format!("{GENERIC_APP_WINDOW_LABEL_PREFIX}{other}"),
    }
}

/// Parse the persisted `app_window_presentation` raw string into a mode map.
///
/// Empty/absent ⇒ an empty map (`{}`). An unparseable value, a non-object JSON
/// value, or an entry with an unrecognized mode is dropped (R-4 — never a
/// failure); the app then resolves to its default.
fn parse_presentation_map(raw: Option<&str>) -> HashMap<String, AppPresentation> {
    let Some(raw) = raw else {
        return HashMap::new();
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return HashMap::new();
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::Object(map)) => map
            .into_iter()
            .filter_map(|(app_id, value)| {
                let mode = value.as_str().and_then(AppPresentation::parse)?;
                Some((app_id, mode))
            })
            .collect(),
        _ => HashMap::new(),
    }
}

/// Pure resolution: the map entry wins; a Terminal entry absent from the map
/// falls back to the legacy raw value; otherwise the default (R-4 / AC4).
fn resolve_presentation(
    map: &HashMap<String, AppPresentation>,
    legacy_terminal: Option<&str>,
    app_id: &str,
) -> AppPresentation {
    if let Some(mode) = map.get(app_id) {
        return *mode;
    }
    if app_id == "terminal" {
        if let Some(mode) = legacy_terminal.and_then(AppPresentation::parse) {
            return mode;
        }
    }
    DEFAULT_APP_PRESENTATION
}

/// Read the persisted presentation for `app_id`: the `app_window_presentation`
/// map first, then the legacy Terminal key (Terminal only, and only when the map
/// has no Terminal entry), else [`DEFAULT_APP_PRESENTATION`].
///
/// The map is ONE KV read; the legacy read happens only on the pre-hydrate
/// Terminal path, so the per-chunk [`crate::applications::terminal::commands::terminal_host_label`]
/// hot path stays a single lookup + small parse in steady state.
pub fn app_presentation(app: &AppHandle, app_id: &str) -> AppPresentation {
    let Some(store) = app.try_state::<Arc<AppStore>>() else {
        return DEFAULT_APP_PRESENTATION;
    };
    let map = parse_presentation_map(
        store
            .control_get(APP_WINDOW_PRESENTATION_KEY)
            .ok()
            .flatten()
            .as_deref(),
    );
    let legacy = if app_id == "terminal" && !map.contains_key(app_id) {
        store
            .control_get(LEGACY_TERMINAL_PRESENTATION_KEY)
            .ok()
            .flatten()
    } else {
        None
    };
    resolve_presentation(&map, legacy.as_deref(), app_id)
}

/// Build (or focus) a generic app's singleton native window.
///
/// An existing `app-<id>` window is focused and NEVER rebuilt (AC3 exactly-one);
/// a fresh one is built against `index.html?view=app&id=<id>`. No
/// `CloseRequested` handler is wired here — a generic app owns no backend
/// resource (Terminal/Doom keep their shipped teardown handlers).
fn open_generic_app_window(
    app: &AppHandle,
    app_id: &str,
    title: Option<String>,
) -> Result<(), String> {
    let label = app_window_label(app_id);
    if let Some(window) = app.get_webview_window(&label) {
        tracing::debug!(target: "fredo::app_window", %label, "focusing existing app window");
        window.set_focus().ok();
        return Ok(());
    }

    tracing::debug!(target: "fredo::app_window", %label, "building generic app window");
    let builder = WebviewWindowBuilder::new(
        app,
        label.as_str(),
        WebviewUrl::App(format!("index.html?view=app&id={app_id}").into()),
    )
    .title(title.unwrap_or_else(|| app_id.to_string()))
    .inner_size(900.0, 600.0)
    .min_inner_size(560.0, 360.0)
    .resizable(true);

    builder
        .build()
        .map_err(|e| format!("Failed to open {app_id} window: {e}"))?;
    Ok(())
}

/// Open an app in its presentation window (singleton per app).
///
/// Dispatches to the shipped bespoke openers for `terminal` / `doom` (each
/// already focus-if-exists) and to the generic `app-<id>` builder otherwise.
#[tauri::command]
pub async fn open_app_window(
    app_id: String,
    title: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    match app_id.as_str() {
        "terminal" => {
            crate::applications::terminal::commands::open_terminal_window_with_intent(&app, None).await
        }
        "doom" => crate::applications::doom::commands::open_doom_window(app).await,
        _ => open_generic_app_window(&app, &app_id, title),
    }
}

/// Close an app's native window if one is open; `Ok(true)` when one was closed.
///
/// Terminal drains + tree-kills its sessions through the shipped
/// [`crate::applications::terminal::commands::close_terminal_window`]; Doom and
/// generic apps simply close their window (their `CloseRequested` handlers own
/// teardown where one exists).
#[tauri::command]
pub async fn close_app_window(app_id: String, app: AppHandle) -> Result<bool, String> {
    if app_id == "terminal" {
        let existed = app
            .get_webview_window(crate::applications::terminal::commands::WINDOW_LABEL)
            .is_some();
        if existed {
            crate::applications::terminal::commands::close_terminal_window(
                app.clone(),
                app.state(),
                app.state(),
            )
            .await?;
        }
        return Ok(existed);
    }

    let label = app_window_label(&app_id);
    match app.get_webview_window(&label) {
        Some(window) => {
            window.close().map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── AppPresentation wire contract ───────────────────────────────────────

    #[test]
    fn presentation_parse_accepts_the_wire_values() {
        assert_eq!(
            AppPresentation::parse("same-window"),
            Some(AppPresentation::SameWindow)
        );
        assert_eq!(
            AppPresentation::parse("new-window"),
            Some(AppPresentation::NewWindow)
        );
    }

    #[test]
    fn presentation_parse_trims_surrounding_whitespace() {
        assert_eq!(
            AppPresentation::parse("  same-window\n"),
            Some(AppPresentation::SameWindow)
        );
        assert_eq!(
            AppPresentation::parse("\tnew-window "),
            Some(AppPresentation::NewWindow)
        );
    }

    #[test]
    fn presentation_parse_rejects_absent_or_unrecognized_values() {
        for raw in ["", "   ", "SameWindow", "same_window", "not-a-mode"] {
            assert_eq!(AppPresentation::parse(raw), None, "must reject {raw:?}");
        }
    }

    #[test]
    fn presentation_wire_is_the_inverse_of_parse() {
        assert_eq!(AppPresentation::SameWindow.wire(), "same-window");
        assert_eq!(AppPresentation::NewWindow.wire(), "new-window");
        for mode in [AppPresentation::SameWindow, AppPresentation::NewWindow] {
            assert_eq!(AppPresentation::parse(mode.wire()), Some(mode));
        }
    }

    #[test]
    fn presentation_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_value(AppPresentation::SameWindow).unwrap(),
            serde_json::json!("same-window")
        );
        assert_eq!(
            serde_json::to_value(AppPresentation::NewWindow).unwrap(),
            serde_json::json!("new-window")
        );
    }

    #[test]
    fn presentation_deserializes_from_its_wire_value() {
        let same: AppPresentation =
            serde_json::from_value(serde_json::json!("same-window")).unwrap();
        let new: AppPresentation =
            serde_json::from_value(serde_json::json!("new-window")).unwrap();
        assert_eq!(same, AppPresentation::SameWindow);
        assert_eq!(new, AppPresentation::NewWindow);
    }

    #[test]
    fn default_presentation_is_same_window() {
        assert_eq!(DEFAULT_APP_PRESENTATION, AppPresentation::SameWindow);
    }

    // ── Window labels ───────────────────────────────────────────────────────

    #[test]
    fn bespoke_apps_keep_their_fixed_labels() {
        assert_eq!(app_window_label("terminal"), "terminal");
        assert_eq!(app_window_label("doom"), "doom");
    }

    #[test]
    fn generic_apps_use_the_prefixed_label() {
        assert_eq!(app_window_label("query-viewer"), "app-query-viewer");
        assert_eq!(app_window_label("mission-monitor"), "app-mission-monitor");
        assert_eq!(
            app_window_label("x"),
            format!("{GENERIC_APP_WINDOW_LABEL_PREFIX}x")
        );
    }

    // ── Persisted map parsing ───────────────────────────────────────────────

    #[test]
    fn absent_or_empty_map_parses_to_an_empty_map() {
        assert!(parse_presentation_map(None).is_empty());
        assert!(parse_presentation_map(Some("")).is_empty());
        assert!(parse_presentation_map(Some("   ")).is_empty());
    }

    #[test]
    fn a_valid_map_parses_each_entry() {
        let map = parse_presentation_map(Some(
            r#"{"terminal":"new-window","doom":"same-window"}"#,
        ));
        assert_eq!(map.get("terminal"), Some(&AppPresentation::NewWindow));
        assert_eq!(map.get("doom"), Some(&AppPresentation::SameWindow));
    }

    #[test]
    fn unrecognized_values_are_dropped_not_fatal() {
        let map = parse_presentation_map(Some(
            r#"{"terminal":"bogus","doom":"new-window"}"#,
        ));
        assert!(!map.contains_key("terminal"));
        assert_eq!(map.get("doom"), Some(&AppPresentation::NewWindow));
    }

    #[test]
    fn non_object_or_malformed_json_is_an_empty_map() {
        for raw in ["not-json", "[]", "42", "\"same-window\"", "null"] {
            assert!(
                parse_presentation_map(Some(raw)).is_empty(),
                "must treat {raw:?} as an empty map"
            );
        }
    }

    // ── Resolution (map → legacy → default) ─────────────────────────────────

    #[test]
    fn map_entry_wins_over_legacy_and_default() {
        let mut map = HashMap::new();
        map.insert("terminal".to_string(), AppPresentation::SameWindow);
        assert_eq!(
            resolve_presentation(&map, Some("new-window"), "terminal"),
            AppPresentation::SameWindow
        );
    }

    #[test]
    fn terminal_falls_back_to_the_legacy_key_when_the_map_lacks_it() {
        let map = HashMap::new();
        assert_eq!(
            resolve_presentation(&map, Some("new-window"), "terminal"),
            AppPresentation::NewWindow
        );
        assert_eq!(
            resolve_presentation(&map, Some("same-window"), "terminal"),
            AppPresentation::SameWindow
        );
    }

    #[test]
    fn an_unrecognized_legacy_value_falls_through_to_the_default() {
        let map = HashMap::new();
        assert_eq!(
            resolve_presentation(&map, Some("not-a-mode"), "terminal"),
            DEFAULT_APP_PRESENTATION
        );
        assert_eq!(
            resolve_presentation(&map, None, "terminal"),
            DEFAULT_APP_PRESENTATION
        );
    }

    #[test]
    fn non_terminal_apps_never_use_the_legacy_key() {
        let map = HashMap::new();
        // A valid legacy Terminal value must not leak onto another app (R-4).
        assert_eq!(
            resolve_presentation(&map, Some("new-window"), "doom"),
            DEFAULT_APP_PRESENTATION
        );
    }
}
