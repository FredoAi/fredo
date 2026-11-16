//! The live installed-application theme push (Spec #3147, ST-5).
//!
//! Exactly one command, and no others:
//!
//! | Command | Args (camelCase) | Success | Failure |
//! |---|---|---|---|
//! | [`installed_apps_push_theme`] | `payload: FredoThemeTokens` | `()` | [`InstalledAppError`] |
//!
//! # What one push does
//!
//! 1. **Validate and normalize** the payload (see [`normalize_payload`]): a
//!    token name must be a plain CSS custom property (`--body-bg`), a value must
//!    be non-empty, duplicate names resolve first-wins in the order the host
//!    sent them, and `colorScheme` is clamped to exactly `"light"` / `"dark"`.
//!    An unusable payload is refused with [`InstalledAppError`] rather than
//!    written: a half-valid mirror would be inlined into every future document.
//! 2. **Write the mirror** ([`super::theme_state::InstalledThemeState::store`]).
//!    The mirror is the process-wide, in-memory value the scheme handler reads
//!    at document-serve time (ST-3). **No database and no file** — a theme is a
//!    projection of the host's live CSS custom properties and is re-pushed after
//!    every launch.
//! 3. **Broadcast live** into every already-open installed window: one
//!    `webview.eval("window.__FREDO_APPLY_THEME__(<json>)")` per window, which is
//!    the apply path ST-3's bootstrap already defines. That is R-1.5 — a change
//!    follows into an open document **without reloading it**.
//!
//! # Why the eval payload is built the way it is
//!
//! The payload crosses into a JavaScript SOURCE position, so it is serialized
//! with `serde_json::to_string` (which escapes every quote, backslash and control
//! character) and *then* embedded as a single-quoted JS string literal with the
//! two characters that are still special inside single quotes — `\` and `'` —
//! escaped. No raw user data is ever concatenated into the source, so a token
//! value containing `'` or `\` cannot break out of the literal.
//!
//! # Failure behaviour (R-1.5 must never wedge a theme change)
//!
//! A window whose eval fails (it is closing; its JS context is gone) is skipped
//! and logged at `warn` — a closing window must not fail the whole push. A push
//! that reaches **no** installed window is a success, not an error: the mirror is
//! written and the next open is themed (R-1.4). Only a total failure to reach the
//! window registry is surfaced, and only at `debug` — the mirror write already
//! made the change durable for the next open.

use tauri::{AppHandle, WebviewWindow};

use super::theme_state::{InstalledThemeState, ThemePayload, ThemeToken};
use super::{InstalledAppError, InstalledAppRefusalCode, InstalledAppResult};
use super::INSTALLED_APP_WINDOW_LABEL_PREFIX;

/// The bootstrap's theme-apply function (`bootstrap.js`), the ONE apply path.
pub const APPLY_THEME_FUNCTION: &str = "__FREDO_APPLY_THEME__";

/// The bounded token count a single push may carry.
///
/// The host declares a few dozen custom properties; the cap only stops a runaway
/// DOM from turning one theme change into an unbounded IPC payload (each token is
/// mirrored and inlined into every future served document).
pub const MAX_THEME_TOKENS: usize = 256;

/// Truncated rendering of one sanitized value in a refusal detail.
const MAX_DETAIL_VALUE_CHARS: usize = 48;

/// Is this a plain CSS custom-property name (`--body-bg`)?
///
/// The same rule the scheme handler applies before inlining a token
/// (`scheme.rs`'s `theme_style_block`), so a name accepted here is one the child
/// will actually receive.
pub fn is_theme_token_name(name: &str) -> bool {
    name.starts_with("--")
        && name.len() > 2
        && name[2..]
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// One `__FREDO_APPLY_THEME__(<json>)` statement for a payload.
///
/// The JSON is serialized first and embedded as a single-quoted JS string
/// literal with `\` and `'` escaped, so the payload is DATA at every position —
/// never source. The bootstrap accepts either a string or an object and parses a
/// string with `JSON.parse`, which is why the transport is a string literal.
pub fn apply_theme_statement(payload: &ThemePayload) -> Result<String, InstalledAppError> {
    let json = serde_json::to_string(payload).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the theme payload could not be serialized: {error}"),
        )
    })?;
    let mut literal = String::with_capacity(json.len() + 2);
    literal.push('\'');
    for character in json.chars() {
        match character {
            '\\' => literal.push_str("\\\\"),
            '\'' => literal.push_str("\\'"),
            other => literal.push(other),
        }
    }
    literal.push('\'');
    Ok(format!(
        "window.{APPLY_THEME_FUNCTION}({literal})"
    ))
}

/// Validate and normalize a pushed payload.
///
/// * Token names must be plain custom properties; values must be non-empty.
/// * Duplicate names resolve FIRST-WINS (the host enumerates each declaration
///   once, so a repeat can only be a malformed producer; the first declaration
///   is the one the cascade painted).
/// * A payload with no usable token is refused — an empty mirror would inline
///   nothing into every future document and leave installed apps unthemed.
/// * `colorScheme` is clamped to `"dark"` or `"light"`, so the child's
///   `documentElement.style.colorScheme` assignment can never receive junk.
pub fn normalize_payload(payload: ThemePayload) -> InstalledAppResult<ThemePayload> {
    if payload.tokens.len() > MAX_THEME_TOKENS {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!(
                "the theme payload carries {} tokens; at most {MAX_THEME_TOKENS} are accepted",
                payload.tokens.len()
            ),
        ));
    }

    let mut tokens: Vec<ThemeToken> = Vec::with_capacity(payload.tokens.len());
    for token in payload.tokens {
        let name = token.name.trim().to_string();
        if !is_theme_token_name(&name) {
            let rendering: String = name.chars().take(MAX_DETAIL_VALUE_CHARS).collect();
            return Err(InstalledAppError::new(
                InstalledAppRefusalCode::IoError,
                format!("{rendering:?} is not a CSS custom-property name"),
            ));
        }
        if tokens.iter().any(|seen| seen.name == name) {
            continue;
        }
        let value = token.value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        tokens.push(ThemeToken { name, value });
    }

    if tokens.is_empty() {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            "the theme payload carries no usable CSS custom property",
        ));
    }

    let color_scheme = if payload.color_scheme.trim().eq_ignore_ascii_case("dark") {
        "dark"
    } else {
        "light"
    };

    Ok(ThemePayload {
        tokens,
        color_scheme: color_scheme.to_string(),
    })
}

/// Push a normalized payload into every live installed window.
///
/// Returns how many windows accepted the eval. A window that fails is skipped and
/// logged (`warn`) — a closing window must not fail the push. Zero windows is a
/// successful push: the mirror write already covers the next open (R-1.4).
pub fn broadcast_theme(app: &AppHandle, payload: &ThemePayload) -> usize {
    let windows = installed_windows(app);
    if windows.is_empty() {
        tracing::debug!(
            target: super::scheme::TRACE_TARGET,
            "no installed-app window is open; the theme mirror was updated for the next open"
        );
        return 0;
    }

    let statement = match apply_theme_statement(payload) {
        Ok(statement) => statement,
        Err(error) => {
            // The mirror is already written; only the live leg is lost.
            tracing::warn!(
                target: super::scheme::TRACE_TARGET,
                error = %error,
                "the theme broadcast statement could not be built"
            );
            return 0;
        }
    };

    let mut delivered = 0usize;
    for window in windows {
        let label = window.label().to_string();
        match window.eval(&statement) {
            Ok(()) => {
                delivered += 1;
                tracing::debug!(
                    target: super::scheme::TRACE_TARGET,
                    label = %label,
                    "pushed the theme into an open installed-app window"
                );
            }
            Err(error) => tracing::warn!(
                target: super::scheme::TRACE_TARGET,
                label = %label,
                error = %error,
                "an installed-app window refused the theme eval (closing?); skipped"
            ),
        }
    }
    delivered
}

/// Every live `installed-*` window. The enumeration is ST-4's
/// ([`super::window::installed_app_windows`]) so the label rule has ONE owner.
fn installed_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    let windows = super::window::installed_app_windows(app);
    // Defensive re-assertion: an `installed-` window is the ONLY thing the
    // broadcast may eval into, so a mislabelled window never receives script.
    windows
        .into_iter()
        .filter(|window| window.label().starts_with(INSTALLED_APP_WINDOW_LABEL_PREFIX))
        .collect()
}

/// Push the host's current theme into the backend mirror and every open
/// installed application (R-1.4 / R-1.5).
///
/// This is the ONLY writer of [`InstalledThemeState`]. It never persists: the
/// database is not involved (a theme is a live projection of the host's CSS
/// custom properties, re-pushed after every launch). The mirror write happens
/// before the broadcast, so an app opened a moment later — or a window whose eval
/// fails because it is closing — is still themed correctly at serve time.
#[tauri::command]
pub async fn installed_apps_push_theme(
    app: AppHandle,
    payload: ThemePayload,
) -> InstalledAppResult<()> {
    let normalized = normalize_payload(payload)?;
    InstalledThemeState::store(normalized.clone());
    let delivered = broadcast_theme(&app, &normalized);
    tracing::debug!(
        target: super::scheme::TRACE_TARGET,
        tokens = normalized.tokens.len(),
        color_scheme = %normalized.color_scheme,
        delivered,
        "installed-app theme mirror updated"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::installed_apps::theme_state::fallback_theme;

    fn sample_payload() -> ThemePayload {
        ThemePayload {
            tokens: vec![
                ThemeToken {
                    name: "--body-bg".to_string(),
                    value: "#ffffff".to_string(),
                },
                ThemeToken {
                    name: "--accent-primary".to_string(),
                    value: "rgb(147, 51, 234)".to_string(),
                },
            ],
            color_scheme: "light".to_string(),
        }
    }

    // ── 1. The wire shape (G-413) ───────────────────────────────────────────

    /// `ThemePayload` has NO optional field, so there is no absent-key case. The
    /// JSON shape is asserted EXACTLY — key order and both member names — because
    /// the frontend's `FredoThemeTokens` and the bootstrap's `applyTheme` both
    /// read these literals.
    #[test]
    fn the_serialized_payload_is_exactly_the_camel_case_shape() {
        let json = serde_json::to_string(&sample_payload()).expect("serialize");
        assert_eq!(
            json,
            "{\"tokens\":[{\"name\":\"--body-bg\",\"value\":\"#ffffff\"},\
             {\"name\":\"--accent-primary\",\"value\":\"rgb(147, 51, 234)\"}],\
             \"colorScheme\":\"light\"}",
            "the transport shape is exactly {{tokens, colorScheme}} in camelCase"
        );

        // The explicit present case for every key, read off the parsed object so
        // a rename cannot pass the string check above by accident.
        let value = serde_json::to_value(sample_payload()).expect("to_value");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 2, "exactly two fields, neither optional: {value}");
        assert!(object.contains_key("tokens"));
        assert!(object.contains_key("colorScheme"));
        assert!(
            !object.contains_key("color_scheme"),
            "the wire form is camelCase, never the Rust field name"
        );
        assert!(
            !object.contains_key("colorSchemeKind"),
            "no extra alias is introduced"
        );

        let tokens = object.get("tokens").and_then(|v| v.as_array()).expect("tokens");
        assert_eq!(tokens.len(), 2);
        for token in tokens {
            let entry = token.as_object().expect("token object");
            assert_eq!(entry.len(), 2, "a token is exactly {{name, value}}: {token}");
            assert!(entry.contains_key("name"));
            assert!(entry.contains_key("value"));
        }

        // And it round-trips from that exact wire shape.
        let parsed: ThemePayload = serde_json::from_str(
            "{\"tokens\":[{\"name\":\"--body-bg\",\"value\":\"#ffffff\"}],\"colorScheme\":\"dark\"}",
        )
        .expect("deserialize the frontend's exact wire shape");
        assert_eq!(parsed.tokens.len(), 1);
        assert_eq!(parsed.color_scheme, "dark");
    }

    // ── 2. Payload acceptance / normalization ───────────────────────────────

    #[test]
    fn a_valid_payload_is_accepted_unchanged() {
        let payload = sample_payload();
        let normalized = normalize_payload(payload.clone()).expect("valid payload accepted");
        assert_eq!(normalized, payload);
    }

    #[test]
    fn the_scheme_is_clamped_to_exactly_light_or_dark() {
        for (input, expected) in [
            ("light", "light"),
            ("dark", "dark"),
            ("DARK", "dark"),
            (" Dark ", "dark"),
            ("", "light"),
            ("sepia", "light"),
        ] {
            let mut payload = sample_payload();
            payload.color_scheme = input.to_string();
            let normalized = normalize_payload(payload).expect("accepted");
            assert_eq!(normalized.color_scheme, expected, "input {input:?}");
        }
    }

    #[test]
    fn a_token_that_is_not_a_custom_property_is_refused() {
        for bad in ["body-bg", "--", "-x", "--body bg", "--body-bg;", "--a{b}"] {
            let payload = ThemePayload {
                tokens: vec![ThemeToken {
                    name: bad.to_string(),
                    value: "red".to_string(),
                }],
                color_scheme: "light".to_string(),
            };
            let error = normalize_payload(payload).expect_err("must be refused");
            assert_eq!(error.code, InstalledAppRefusalCode::IoError);
            assert!(!error.detail.is_empty(), "the refusal names the offending name");
        }
    }

    #[test]
    fn a_payload_with_no_usable_token_is_refused() {
        let empty = ThemePayload {
            tokens: Vec::new(),
            color_scheme: "light".to_string(),
        };
        assert_eq!(
            normalize_payload(empty).expect_err("empty refused").code,
            InstalledAppRefusalCode::IoError
        );

        let blank_value = ThemePayload {
            tokens: vec![ThemeToken {
                name: "--body-bg".to_string(),
                value: "   ".to_string(),
            }],
            color_scheme: "light".to_string(),
        };
        assert_eq!(
            normalize_payload(blank_value).expect_err("blank value refused").code,
            InstalledAppRefusalCode::IoError
        );
    }

    #[test]
    fn duplicate_names_resolve_first_wins_and_blank_values_are_dropped() {
        let payload = ThemePayload {
            tokens: vec![
                ThemeToken {
                    name: "--body-bg".to_string(),
                    value: "#111111".to_string(),
                },
                ThemeToken {
                    name: " --body-bg ".to_string(),
                    value: "#ffffff".to_string(),
                },
                ThemeToken {
                    name: "--card-bg".to_string(),
                    value: "  ".to_string(),
                },
                ThemeToken {
                    name: "--text-primary".to_string(),
                    value: " #eeeeee ".to_string(),
                },
            ],
            color_scheme: "dark".to_string(),
        };
        let normalized = normalize_payload(payload).expect("accepted");
        assert_eq!(
            normalized.tokens,
            vec![
                ThemeToken {
                    name: "--body-bg".to_string(),
                    value: "#111111".to_string(),
                },
                ThemeToken {
                    name: "--text-primary".to_string(),
                    value: "#eeeeee".to_string(),
                },
            ],
            "the first declaration wins and a blank value is dropped"
        );
    }

    #[test]
    fn a_payload_over_the_token_cap_is_refused() {
        let tokens: Vec<ThemeToken> = (0..=MAX_THEME_TOKENS)
            .map(|index| ThemeToken {
                name: format!("--token-{index}"),
                value: "value".to_string(),
            })
            .collect();
        let payload = ThemePayload {
            tokens,
            color_scheme: "light".to_string(),
        };
        let error = normalize_payload(payload).expect_err("over cap refused");
        assert_eq!(error.code, InstalledAppRefusalCode::IoError);
        assert!(error.detail.contains(&MAX_THEME_TOKENS.to_string()));
    }

    #[test]
    fn the_mirror_write_is_the_only_persistence() {
        InstalledThemeState::clear();
        assert!(!InstalledThemeState::has_mirror());

        // `push_theme` needs a live app handle for the broadcast, so the mirror
        // half is proven through the same two steps the command performs.
        let normalized = normalize_payload(sample_payload()).expect("valid");
        InstalledThemeState::store(normalized.clone());

        assert!(InstalledThemeState::has_mirror());
        assert_eq!(InstalledThemeState::read(), normalized);

        InstalledThemeState::clear();
        assert_eq!(
            InstalledThemeState::read(),
            fallback_theme(),
            "an empty mirror still yields the documented fallback"
        );
    }

    // ── 3. The eval statement ──────────────────────────────────────────────

    #[test]
    fn the_eval_statement_calls_the_bootstraps_apply_function_with_a_json_literal() {
        let statement = apply_theme_statement(&sample_payload()).expect("statement");
        assert!(statement.starts_with("window.__FREDO_APPLY_THEME__("));
        assert!(statement.ends_with(')'));
        assert_eq!(
            statement.matches("window.__FREDO_APPLY_THEME__(").count(),
            1,
            "exactly ONE call, never a second apply path"
        );

        // The argument is a single-quoted JavaSCRIPT STRING holding the JSON, so
        // the bootstrap's `typeof payload === "string"` branch parses it.
        let open = statement.find('(').expect("open paren") + 1;
        assert_eq!(statement.as_bytes()[open], b'\'');
        assert_eq!(
            statement.as_bytes()[statement.len() - 2],
            b'\'',
            "the literal is closed before the call's closing paren"
        );

        // Unquote and unescape to read the JSON back out of the source position.
        let inner = &statement[open + 1..statement.len() - 2];
        let unescaped = inner.replace("\\\\", "\\").replace("\\'", "'");
        let parsed: ThemePayload = serde_json::from_str(&unescaped).expect("the literal holds JSON");
        assert_eq!(parsed, sample_payload());
    }

    #[test]
    fn a_hostile_value_cannot_escape_the_string_literal() {
        let payload = ThemePayload {
            tokens: vec![
                ThemeToken {
                    name: "--body-bg".to_string(),
                    // A JSON-breaking, source-breaking value: quote, backslash,
                    // a line separator and a script-closing fragment.
                    value: "'); alert('x'); ('\\\u{2028}</script>".to_string(),
                },
            ],
            color_scheme: "dark".to_string(),
        };
        let statement = apply_theme_statement(&payload).expect("statement");

        // The literal's body: every single quote in it must be preceded by a
        // backslash, so the payload can never close the string early and land in
        // a source position. (A substring check cannot see the difference —
        // `\');` still CONTAINS `');` — so the check is a walk.)
        let open = statement.find('(').expect("open paren") + 1;
        let inner = &statement[open + 1..statement.len() - 2];
        let characters: Vec<char> = inner.chars().collect();
        for (index, character) in characters.iter().enumerate() {
            if *character != '\'' {
                continue;
            }
            let escaped = index > 0 && characters[index - 1] == '\\';
            assert!(
                escaped,
                "an unescaped single quote at byte {index} could close the literal: {statement}"
            );
        }
        // And the payload contains at least one quote, so the walk above was not
        // vacuous.
        assert!(payload.tokens[0].value.contains('\''));

        // It still parses back to exactly the payload that went in.
        let unescaped = inner.replace("\\\\", "\\").replace("\\'", "'");
        let parsed: ThemePayload = serde_json::from_str(&unescaped).expect("still valid JSON");
        assert_eq!(parsed, payload, "the value round-trips byte-exactly");
    }

    // ── 4. The broadcast contract (source shape, no runtime needed) ────────

    #[test]
    fn the_module_owns_exactly_one_command_and_one_apply_function() {
        let source = include_str!("theme_push.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            1,
            "theme_push.rs owns exactly installed_apps_push_theme"
        );
        assert!(product.contains("pub async fn installed_apps_push_theme("));
        assert_eq!(
            APPLY_THEME_FUNCTION, "__FREDO_APPLY_THEME__",
            "the eval target is the bootstrap's own apply function"
        );
        assert!(
            product.contains("window.{APPLY_THEME_FUNCTION}"),
            "the broadcast builds its statement from the single constant"
        );

        // The broadcast enumerates through ST-4's owner of the label rule and
        // filters on the SAME prefix — never a second label derivation.
        assert!(product.contains("super::window::installed_app_windows(app)"));
        assert!(product.contains("INSTALLED_APP_WINDOW_LABEL_PREFIX"));
        // The apply path is the ONLY one: the statement is built from the
        // constant in ONE `format!`, never a second hand-written call site.
        assert_eq!(
            product.matches("{APPLY_THEME_FUNCTION}(").count(),
            1,
            "the call site is built from the constant exactly once"
        );

        // No persistence: neither the database nor a file appears in the product.
        for banned in ["application_store", "sqlx", "std::fs::", "save_control_setting"] {
            assert!(
                !product.contains(banned),
                "a theme push persists nothing (found {banned})"
            );
        }
        // The repo's spawn rule: this module spawns nothing at all.
        assert!(!product.contains("tokio::spawn"));
        assert!(!product.contains("async_runtime::spawn"));
    }
}
