//! The theme transport payload and the backend's in-memory mirror (Spec #3147).
//!
//! Two things live here and nothing else:
//!
//! 1. The wire types the host and an installed document exchange:
//!    [`ThemeToken`] and [`ThemePayload`] (camelCase, mirroring the frontend's
//!    `FredoThemeTokens`).
//! 2. [`InstalledThemeState`] — the process-wide, **in-memory** mirror the
//!    scheme handler reads at document-serve time (ST-3) and the live push
//!    command writes while an installed window is open (ST-5).
//!
//! # Why a mirror at all
//!
//! A correctly-themed first paint must not depend on IPC: an installed
//! application has **zero** capability grants, so a document that had to ask
//! the backend for its colours would paint unthemed (or not at all). So the
//! host's own `ThemeProvider` pushes the resolved token VALUES into this
//! mirror, and the scheme handler inlines them into the served document.
//!
//! # Why a module-level `static` rather than Tauri managed state
//!
//! The mirror is a single process-wide value with no per-window or per-app
//! data, and it must be readable from a URI-scheme handler that runs outside
//! any command. Keeping it in this module means the composition root
//! (`lib.rs`) needs no startup registration for it — which is also what keeps
//! R-5.5's "nothing installed-app-shaped happens at startup" true by
//! construction: registering the scheme performs no read, and this cell is
//! empty until the host's theme effect pushes a value.
//!
//! # No persistence
//!
//! Deliberately not stored: no database, no file, no settings key. A theme is
//! a projection of the host's live CSS custom properties, and the host
//! re-pushes it after every launch.

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// One theme custom property: the CSS name (`--body-bg`) and its resolved
/// value string (whatever the host's `getComputedStyle` returned).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeToken {
    pub name: String,
    pub value: String,
}

/// The theme transport payload (the Rust mirror of the frontend's
/// `FredoThemeTokens`). No optional fields, so there is no absent-key case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePayload {
    pub tokens: Vec<ThemeToken>,
    /// `"light"` or `"dark"` — derived host-side from the resolved `--body-bg`
    /// luminance, never a stored mode.
    pub color_scheme: String,
}

impl Default for ThemePayload {
    fn default() -> Self {
        fallback_theme()
    }
}

/// The documented fallback token set, used when the mirror is empty (a first
/// paint before any theme push, or a document opened by a direct command).
///
/// The values are **CSS system colours**, not literals: `Canvas`,
/// `CanvasText`, `GrayText` and `Highlight`. Two reasons:
///
/// * They are theme-aware and OS-supplied, so the fallback is legible in both
///   light and dark appearances without the host having told us which is
///   active — the exact job system colours exist for.
/// * It keeps the host-authored surfaces free of hardcoded colour literals
///   even on the fallback path (the bootstrap's own rules already read only
///   `var(--…)` with system-colour fallbacks).
///
/// Every name is one the host's theme contract actually sets (see
/// `ThemeProvider`'s `setProperty` calls), so a real push simply overwrites the
/// same declarations — the fallback never shadows a token the host owns under a
/// different name, and never invents one it does not.
pub const FALLBACK_THEME_TOKENS: &[(&str, &str)] = &[
    ("--body-bg", "Canvas"),
    ("--card-bg", "Canvas"),
    ("--text-primary", "CanvasText"),
    ("--text-secondary", "GrayText"),
    ("--border-color", "GrayText"),
    ("--accent-primary", "Highlight"),
    ("--status-error", "CanvasText"),
    ("--font-base", "system-ui, sans-serif"),
    ("--font-primary", "system-ui, sans-serif"),
];

/// The fallback payload: [`FALLBACK_THEME_TOKENS`] with `colorScheme: "light"`.
///
/// Recorded as a function (not a `const`) so the token list is a `Vec` the
/// caller owns; the values are the same every call.
pub fn fallback_theme() -> ThemePayload {
    ThemePayload {
        tokens: FALLBACK_THEME_TOKENS
            .iter()
            .map(|(name, value)| ThemeToken {
                name: (*name).to_string(),
                value: (*value).to_string(),
            })
            .collect(),
        color_scheme: "light".to_string(),
    }
}

/// The process-wide mirror cell. Lazily created; never touched at startup.
static MIRROR: OnceLock<Mutex<Option<ThemePayload>>> = OnceLock::new();

fn mirror() -> &'static Mutex<Option<ThemePayload>> {
    MIRROR.get_or_init(|| Mutex::new(None))
}

/// The backend's in-memory theme mirror.
///
/// The type is a zero-sized handle over the module's `static`; both operations
/// are on the type so the reader (the scheme handler) and the writer (ST-5's
/// `installed_apps_push_theme`) go through ONE documented surface.
#[derive(Debug, Clone, Copy, Default)]
pub struct InstalledThemeState;

impl InstalledThemeState {
    /// The payload to inline into a served document: the mirror's value when a
    /// theme has been pushed, else [`fallback_theme`].
    ///
    /// A poisoned lock (a panic while the push held it) is treated as "no
    /// mirror": a fallback theme is a legible document, an error here would be
    /// a blank one.
    pub fn read() -> ThemePayload {
        match mirror().lock() {
            Ok(guard) => guard.clone().unwrap_or_else(fallback_theme),
            Err(_) => fallback_theme(),
        }
    }

    /// Replace the mirror. ST-5's live push calls this on every host theme
    /// change; the value is only ever read back at document-serve time.
    pub fn store(payload: ThemePayload) {
        if let Ok(mut guard) = mirror().lock() {
            *guard = Some(payload);
        }
    }

    /// Whether a theme has actually been pushed (i.e. [`Self::read`] is not
    /// returning the fallback). Used by the tests and by ST-5's diagnostics.
    pub fn has_mirror() -> bool {
        match mirror().lock() {
            Ok(guard) => guard.is_some(),
            Err(_) => false,
        }
    }

    /// Drop the mirror, returning the next read to the documented fallback.
    ///
    /// Test support, and a clean reset path for a host that wants to prove the
    /// unthemed first-paint behaviour.
    pub fn clear() {
        if let Ok(mut guard) = mirror().lock() {
            *guard = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_is_legible_and_system_coloured() {
        let theme = fallback_theme();
        assert!(theme.tokens.len() >= 5, "a fallback must cover the panel surfaces");
        assert_eq!(theme.color_scheme, "light");

        for token in &theme.tokens {
            assert!(
                token.name.starts_with("--"),
                "{} must be a CSS custom property name",
                token.name
            );
            assert!(
                token.name[2..]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-'),
                "{} must be a plain custom-property name",
                token.name
            );
            assert!(!token.value.is_empty(), "{} must carry a value", token.name);
            let lowered = token.value.to_ascii_lowercase();
            for banned in ["#", "rgb(", "hsl("] {
                assert!(
                    !lowered.contains(banned),
                    "the fallback must stay on system colours, found {banned:?} in {}",
                    token.value
                );
            }
        }

        // The four surfaces the loading/failure panels actually read.
        for required in [
            "--body-bg",
            "--text-primary",
            "--text-secondary",
            "--status-error",
            "--accent-primary",
            "--font-base",
        ] {
            assert!(
                theme.tokens.iter().any(|token| token.name == required),
                "the fallback must define {required}"
            );
        }
    }

    #[test]
    fn the_payload_is_camel_case() {
        let payload = ThemePayload {
            tokens: vec![ThemeToken {
                name: "--body-bg".to_string(),
                value: "Canvas".to_string(),
            }],
            color_scheme: "dark".to_string(),
        };
        let value = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(value.get("colorScheme").and_then(|v| v.as_str()), Some("dark"));
        assert!(
            value.get("color_scheme").is_none(),
            "the wire form is camelCase"
        );
        let tokens = value.get("tokens").and_then(|v| v.as_array()).expect("tokens");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].get("name").and_then(|v| v.as_str()), Some("--body-bg"));
        assert_eq!(tokens[0].get("value").and_then(|v| v.as_str()), Some("Canvas"));

        // And it round-trips from the frontend's exact wire shape.
        let parsed: ThemePayload = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, payload);
    }

    #[test]
    fn the_mirror_round_trips_and_falls_back_when_empty() {
        InstalledThemeState::clear();
        assert!(!InstalledThemeState::has_mirror());
        assert_eq!(
            InstalledThemeState::read(),
            fallback_theme(),
            "an empty mirror must yield the documented fallback"
        );

        let pushed = ThemePayload {
            tokens: vec![
                ThemeToken {
                    name: "--body-bg".to_string(),
                    value: "color-mix(in srgb, Canvas 90%, GrayText)".to_string(),
                },
                ThemeToken {
                    name: "--text-primary".to_string(),
                    value: "CanvasText".to_string(),
                },
            ],
            color_scheme: "dark".to_string(),
        };
        InstalledThemeState::store(pushed.clone());
        assert!(InstalledThemeState::has_mirror());
        assert_eq!(InstalledThemeState::read(), pushed);

        InstalledThemeState::clear();
        assert!(!InstalledThemeState::has_mirror());
        assert_eq!(InstalledThemeState::read(), fallback_theme());
    }
}
