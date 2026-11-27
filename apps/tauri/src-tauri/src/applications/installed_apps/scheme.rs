//! The `fredoapp` URI-scheme handler: the installed document, its policy, and
//! verify-at-serve (Spec #3147, ST-3).
//!
//! # What this module is for
//!
//! An installed application is a **document at an origin the host does not
//! own**. Tauri maps a registered custom scheme to
//! `fredoapp://localhost/<id>/<relative>` on macOS/Linux and
//! `http://fredoapp.localhost/<id>/<relative>` on Windows/Android
//! (`tauri` 2.10.3 `src/webview/mod.rs:1705-1717`); both forms arrive here with
//! `<id>/<relative>` in the **URL path**, so routing is path-based and
//! platform-agnostic.
//!
//! The handler owns five things, and only these:
//!
//! 1. **Routing** — the app's entry document, its files, and the two reserved
//!    host paths (`__fredo/bootstrap.js` and `__fredo/beacon`). Nothing outside
//!    `<id>/files/` is reachable; `record.json` and `manifest.json` live outside
//!    `files/` and have no route at all.
//! 2. **Integrity at serve time** (AC-4.4 / R-4.4, CWE-367) — each requested
//!    file is read **once**, that same buffer is hashed, the hash is compared to
//!    the install record, and **that buffer** is served. There is deliberately
//!    no "verify this path, then open this path" step.
//! 3. **The child document's policy** — the exact [`INSTALLED_APP_CSP`] string
//!    below. `tauri.conf.json`'s `app.security.csp` is injected only for Tauri's
//!    own asset protocol (`manager/mod.rs:423-445` → `protocol/tauri.rs:217`),
//!    so a response this handler authors never passes through it and
//!    `tauri.conf.json` needs no edit.
//! 4. **The served document** — the app's HTML with the host-authored
//!    `<style>` block (theme custom properties + the panel styles) and the
//!    `__fredo/bootstrap.js` script injected, so the loading → usable /
//!    loading → failure lifecycle lives at the same origin as the app.
//! 5. **The outline uplink** (Spec #3244 ST-7) — the `__fredo/beacon` INGRESS: a
//!    same-origin sub-resource load from the child document carrying its screen
//!    outline, observed here and handed to [`super::beacon`] (which treats it as
//!    untrusted input: size-bounded, nonce-gated, typed failure, and a
//!    `telemetry_spans` receipt). The handler is therefore not only a server but a
//!    bounded **uplink** — a **human-approved** expansion (Option A, 2026-11-26),
//!    with **no new command and no new capability**.
//!
//! # What this module must never do
//!
//! Serve the host bundle, list a directory, resolve a path outside
//! `<id>/files`, serve an **unrecorded** file, or let a package shadow
//! `__fredo/` (ST-2 already refuses that at install).

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::Manager;

use super::store::{self, InstalledAppMode, InstalledAppRecord, InstalledFileRecord};
use super::theme_state::{InstalledThemeState, ThemePayload};
use super::{InstalledAppRefusalCode, INSTALLED_FILES_SUBDIR, RESERVED_PATH_SEGMENT};

/// The registered URI scheme name. Tauri turns this into
/// `fredoapp://localhost` (macOS/Linux) / `http://fredoapp.localhost`
/// (Windows/Android); the difference is Tauri's, not ours.
pub const INSTALLED_APP_SCHEME: &str = "fredoapp";

/// The reserved host path the bootstrap is served from. ST-2 refuses any
/// package that claims `__fredo/`, so this path can never be an app file.
pub const BOOTSTRAP_PATH: &str = "__fredo/bootstrap.js";

/// The reserved segment itself (mirrors [`RESERVED_PATH_SEGMENT`]).
pub const RESERVED_SEGMENT: &str = RESERVED_PATH_SEGMENT;

/// The bootstrap, embedded at compile time. It is host-authored code, so its
/// bytes are trusted by construction and are not in an install record.
pub const BOOTSTRAP_SCRIPT: &str = include_str!("bootstrap.js");

/// The child document's Content-Security-Policy — **the exact string**, pinned
/// verbatim by `the_csp_string_is_the_plans_and_the_tauri_config_is_untouched`.
///
/// `connect-src ipc: http://ipc.localhost` deliberately keeps the IPC transport
/// reachable, so AC-2's refusal is the **ACL's** refusal rather than a network
/// error (a sharper, verifiable proof — and `T-2.2` reads the rejection class).
pub const INSTALLED_APP_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'";

/// The content type used for every JSON/plain diagnostic body.
const TEXT_CONTENT_TYPE: &str = "text/plain; charset=utf-8";
/// The bootstrap is JavaScript; `import()`/`<script src>` require a JS MIME type.
const JAVASCRIPT_CONTENT_TYPE: &str = "text/javascript; charset=utf-8";
/// The served document.
const HTML_CONTENT_TYPE: &str = "text/html; charset=utf-8";
/// Fallback for an extension with no known type.
const BINARY_CONTENT_TYPE: &str = "application/octet-stream";

/// The host-owned document config block's element id (read by the bootstrap).
const CONFIG_ELEMENT_ID: &str = "__fredo-config";

/// The host-owned mount region's test id.
const ROOT_TESTID: &str = "installed-app-root";

/// S2's DOM hook — the host-authored marking band (Spec #3241).
pub const DEVELOPMENT_BAND_TESTID: &str = "installed-app-development-banner";

/// S2's band sentence — bound as a constant so the QA row can quote it verbatim.
///
/// `F-10.2` asserts **containment with position**: the band's text BEGINS with the
/// painted token `Development` (`DEVELOPMENT_MARKER_TOKEN` in the frontend mirror),
/// and this exact sentence is quoted in the row so any drift is visible. The token
/// is the LEADING phrase on purpose — a band reading `Released; not Development`
/// would satisfy a bare `contains` and fail the position clause.
pub const DEVELOPMENT_BAND_SENTENCE: &str =
    "Development build — not a normally installed application.";

/// The CSP/response header carrying a refusal reason to the bootstrap.
const REASON_HEADER: &str = "x-fredo-reason";

/// The one tracing target for this feature. The QA plan greps the env log for
/// `fredoapp`; [`serve_line`] is the positive host-side instrument.
pub const TRACE_TARGET: &str = "fredo::installed_apps";

// ---------------------------------------------------------------------------
// Route model
// ---------------------------------------------------------------------------

/// Where a request lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The host-authored bootstrap.
    Bootstrap,
    /// Spec #3244 ST-7 — the outline uplink's reserved host path
    /// (`/__fredo/beacon`). A SECOND serve under the reserved `__fredo/` segment,
    /// admitted deliberately (human-approved Option A, 2026-11-26).
    Beacon,
    /// An installed application's document or one of its files. `relative` is
    /// empty for the entry document.
    App { id: String, relative: String },
}

/// Why a request did not land on a route. Kept separate from
/// [`InstalledAppRefusalCode`] because a routing miss is an HTTP fact (404),
/// not a user-facing refusal code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteMiss {
    /// The path names no application (empty, no id segment, or an invalid id).
    NoApp,
    /// A reserved `__fredo/` path other than the bootstrap.
    Reserved,
    /// The relative path would escape `<id>/files/`.
    Escapes,
}

/// Percent-decode a URL path.
///
/// Returns `None` for a malformed escape or a byte sequence that is not valid
/// UTF-8. Decoding happens **before** every path-safety check, so `%2e%2e%2f`
/// is rejected on exactly the same rule as `../`.
pub fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            out.push((high << 4) | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Reject a relative path that could leave `<id>/files/`.
///
/// Refuses, in this order: an empty segment, an absolute path, a backslash, a
/// drive or scheme prefix, a UNC prefix, `.`/`..` components, and a NUL byte.
/// The same rule the installer applied to archive entry names — the serve path
/// must be at least as strict as the install path, or a recorded file could be
/// reached through a path it never had.
pub fn sanitize_relative(relative: &str) -> Result<String, RouteMiss> {
    if relative.is_empty() {
        return Ok(String::new());
    }
    if relative.contains('\0') {
        return Err(RouteMiss::Escapes);
    }
    if relative.contains('\\') {
        return Err(RouteMiss::Escapes);
    }
    // `/` alone is the entry document, not an absolute path. Everything else
    // that starts with a slash is absolute and refused.
    if relative == "/" {
        return Ok(String::new());
    }
    if relative.starts_with('/') {
        return Err(RouteMiss::Escapes);
    }
    if relative.contains(':') {
        return Err(RouteMiss::Escapes);
    }

    let trimmed = relative.trim_end_matches('/');
    if trimmed.is_empty() {
        // `/` alone is the entry document, not an escape.
        return Ok(String::new());
    }

    if trimmed.starts_with(RESERVED_SEGMENT)
        && (trimmed.len() == RESERVED_SEGMENT.len() || trimmed[RESERVED_SEGMENT.len()..].starts_with('/'))
    {
        return Err(RouteMiss::Reserved);
    }

    for segment in trimmed.split('/') {
        match segment {
            "" => return Err(RouteMiss::Escapes),
            "." | ".." => return Err(RouteMiss::Escapes),
            _ => {}
        }
        if segment == RESERVED_SEGMENT {
            return Err(RouteMiss::Reserved);
        }
    }

    Ok(trimmed.to_string())
}

/// The bootstrap path, normalised for comparison.
const BOOTSTRAP_SEGMENTS: [&str; 2] = ["__fredo", "bootstrap.js"];

/// Route a request path to the bootstrap or an application resource.
///
/// `path` is the URL path (`/<id>/<relative>`), already percent-decoded.
pub fn route(path: &str) -> Result<Route, RouteMiss> {
    let decoded = percent_decode(path).ok_or(RouteMiss::NoApp)?;
    // A leading double slash is a UNC-ish path, not a document: refuse it rather
    // than silently stripping both slashes into a valid id.
    if decoded.starts_with("//") {
        return Err(RouteMiss::Escapes);
    }
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return Err(RouteMiss::NoApp);
    }

    let mut segments = trimmed.splitn(2, '/');
    let id = segments.next().unwrap_or("");
    let rest = segments.next().unwrap_or("");

    // The reserved host path. `__fredo` can never be an app id (the manifest id
    // pattern starts with an alphanumeric), so this branch cannot shadow a real
    // application.
    if id == BOOTSTRAP_SEGMENTS[0] {
        let relative = rest.trim_end_matches('/');
        if relative == BOOTSTRAP_SEGMENTS[1] {
            return Ok(Route::Bootstrap);
        }
        // Spec #3244 ST-7 — the outline uplink. A SECOND serve under `__fredo/`
        // is now DELIBERATE (human-approved Option A, 2026-11-26): the child
        // document delivers its screen outline to the host's OWN origin server.
        // Every OTHER reserved path stays a miss.
        if relative == super::beacon::BEACON_RELATIVE {
            return Ok(Route::Beacon);
        }
        return Err(RouteMiss::Reserved);
    }

    if id.is_empty() || !super::manifest::is_valid_app_id(id) {
        return Err(RouteMiss::NoApp);
    }

    match sanitize_relative(rest) {
        Ok(relative) => Ok(Route::App {
            id: id.to_string(),
            relative,
        }),
        Err(miss) => Err(miss),
    }
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

/// The content type for a served file, chosen by extension.
///
/// Text types carry `charset=utf-8` so a document/file is decoded predictably;
/// an unknown extension is `application/octet-stream` (never sniffed — every
/// response also carries `X-Content-Type-Options: nosniff`).
pub fn content_type_for(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => HTML_CONTENT_TYPE,
        "js" | "mjs" => JAVASCRIPT_CONTENT_TYPE,
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => TEXT_CONTENT_TYPE,
        "xml" => "application/xml; charset=utf-8",
        _ => BINARY_CONTENT_TYPE,
    }
}

// ---------------------------------------------------------------------------
// The served document
// ---------------------------------------------------------------------------

/// The document-level facts the bootstrap needs, as a JSON data block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentConfig {
    pub app_id: String,
    pub version: String,
    pub display_name: String,
    /// An **origin-root-absolute** path (`/<id>/<entry.module>`), so the
    /// bootstrap's `import` does not depend on the document's base URL.
    pub module: String,
    /// Set when the host refused this load before an application document
    /// existed (the entry document's bytes no longer match the install record).
    /// The bootstrap renders the failure panel and imports nothing.
    pub startup_failure: Option<&'static str>,
    /// How this application was loaded (Spec #3241) — read through
    /// `store::read_development_marker` (the ONE presence check).
    ///
    /// It rides in the RUST-side config only: [`config_json`] deliberately does
    /// **not** project it onto the child's `__fredo-config` block. The child has no
    /// use for its own mode in this slice, and adding the key would be an
    /// unrequested wire-contract change that implied the application could act on
    /// it.
    pub mode: InstalledAppMode,
}

/// Escape the three characters that must never appear raw inside an HTML text
/// node we author (`<`, `>`, `&`) plus the quote (used in attributes).
fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Strip characters that could terminate a CSS declaration or open a comment,
/// and collapse newlines. Theme values come from the host's own
/// `getComputedStyle`, but the document's stylesheet must stay structurally
/// intact even if a value is odd: a `}` or `;` in a value must never be able to
/// start a new declaration or rule, and `/*` must never be able to comment out
/// the rest of the sheet.
fn sanitize_css_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '{' | '}' | ';' | '<' | '>' | '*' | '\\' => {}
            '\n' | '\r' | '\u{0}' => out.push(' '),
            other => out.push(other),
        }
    }
    out.trim().to_string()
}

/// The theme half of the served `<style>` block: one `:root` rule declaring
/// every token the mirror carries (or the documented fallback).
///
/// This is what makes a correctly-themed **first paint** possible with no IPC:
/// the bootstrap's stylesheet reads `var(--body-bg)` and the value is already
/// here.
pub fn theme_style_block(theme: &ThemePayload) -> String {
    let mut css = String::from(":root {\n");
    for token in &theme.tokens {
        let name = sanitize_css_value(&token.name);
        if !name.starts_with("--") || name.len() < 3 {
            continue;
        }
        if !name[2..]
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            continue;
        }
        let value = sanitize_css_value(&token.value);
        if value.is_empty() {
            continue;
        }
        css.push_str(&format!("  {name}: {value};\n"));
    }
    css.push_str("}\n");
    css
}

/// The host-authored panel stylesheet. Every colour is a `var(--…)` read with a
/// CSS **system-colour** fallback (`Canvas`/`CanvasText`/`GrayText`); tints are
/// written as `color-mix(...)`. No hex, no `rgb()`/`hsl()`, and never an alpha
/// suffix appended to a `var()` reference (`var(--accent-primary)22` is invalid
/// CSS).
///
/// **This constant is emitted into EVERY served document, released included**, so
/// it must never gain a marking rule: a released build's served bytes are
/// byte-identical to a pre-#3241 document (INV-6), and a declaration added here
/// would change them. The marking band and the three-layer z-index stack live in
/// [`MODE_BAND_CSS`], which is appended on the development arm only.
pub const PANEL_CSS: &str = r#"
html, body { margin: 0; padding: 0; }
[data-testid="installed-app-root"] {
  min-height: 100dvh;
  background: var(--body-bg, Canvas);
  color: var(--text-primary, CanvasText);
  font-family: var(--font-base, system-ui);
}
.fredo-panel { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; }
[data-testid="installed-app-loading"] { background: var(--body-bg, Canvas); }
[data-testid="installed-app-failure"] {
  background: color-mix(in srgb, var(--status-error) 10%, var(--body-bg, Canvas));
}
.fredo-panel-card { width: min(420px, 84vw); }
[data-testid="installed-app-loading"] .fredo-panel-card { width: min(320px, 80vw); }
.fredo-status-text { font-size: 15px; line-height: 1.4; color: var(--text-primary, CanvasText); }
.fredo-panel-note { font-size: 12px; line-height: 1.5; margin: 8px 0 0; color: var(--text-secondary, GrayText); }
.fredo-progress {
  position: relative; height: 2px; margin-top: 12px; overflow: hidden;
  background: color-mix(in srgb, var(--accent-primary) 18%, transparent);
}
.fredo-progress-segment {
  position: absolute; top: 0; bottom: 0; width: 40%;
  background: var(--accent-primary);
  animation: fredo-progress-slide 1.1s ease-in-out infinite;
}
@keyframes fredo-progress-slide {
  from { inset-inline-start: -40%; }
  to { inset-inline-start: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .fredo-progress-segment { animation: none; display: none; }
}
.fredo-glyph { display: block; width: 24px; height: 24px; margin-bottom: 10px; color: var(--status-error, CanvasText); }
.fredo-failure-heading { font-size: 17px; line-height: 1.35; font-weight: 600; margin: 0 0 8px; color: var(--text-primary, CanvasText); }
.fredo-failure-reason { font-size: 13px; line-height: 1.5; margin: 0 0 8px; color: var(--text-primary, CanvasText); }
.fredo-reason-code { font-family: var(--font-mono, ui-monospace, Consolas, monospace); font-size: 11px; margin: 0 0 16px; color: var(--text-secondary, GrayText); }
.fredo-retry {
  font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 6px; cursor: pointer;
  background: none; border: 1px solid var(--border-color, GrayText); color: var(--text-primary, CanvasText);
}
.fredo-retry:hover { background: color-mix(in srgb, var(--accent-primary) 14%, transparent); }
.fredo-retry:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
"#;

/// S2's stylesheet — appended to the host style block **only for a development
/// build** (Spec #3241).
///
/// Kept out of [`PANEL_CSS`] on purpose: `PANEL_CSS` is emitted into every served
/// document, so a rule added there would change a **released** build's bytes and
/// break INV-6. The band and the three-layer stack it needs are therefore scoped
/// to the one document kind that carries the missing fact.
///
/// # The three-layer stack (adjudicated — UI/UX D-3 / Architect D-11)
///
///     [data-testid="installed-app-root"]   z-index: 0   the untrusted content
///     .fredo-panel (loading + failure)     z-index: 2   opaque `inset: 0` grounds
///     .fredo-mode-band                     z-index: 3   the marking
///
/// The band sits **above** the panels by design: `R-3.2` requires the marking to be
/// perceivable *"including the host's failure document when the build cannot
/// load"*, and the panels are opaque full-viewport grounds — so "the panel keeps
/// winning" would make that clause unsatisfiable. Stacking the band above costs the
/// panel nothing: `.fredo-panel` is a centred grid (`place-items: center`), so its
/// card never reaches the band at the window's 360 px minimum inner height.
///
/// Colour discipline is [`PANEL_CSS`]'s: `var()` reads with system-colour fallbacks,
/// no hex/rgb()/hsl(), no alpha-append onto a `var()`. Two names the theme fallback
/// already carries (`--text-primary`, `--body-bg`) keep this file out of
/// `theme_state.rs`'s fallback token set entirely.
pub const MODE_BAND_CSS: &str = r#"
[data-testid="installed-app-root"] { position: relative; z-index: 0; }
.fredo-panel { position: fixed; inset: 0; z-index: 2; display: grid; place-items: center; padding: 24px; }
.fredo-mode-band {
  position: fixed; top: 0; left: 0; right: 0; z-index: 3;
  box-sizing: border-box;
  padding: 7px 12px; font-size: 12px; line-height: 16px;
  font-family: var(--font-base, system-ui, sans-serif);
  color: var(--body-bg, Canvas);
  background: var(--text-primary, CanvasText);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fredo-mode-band strong { font-weight: 600; }
"#;

/// S2's band markup — the host-authored marking strip, emitted as the **first
/// child of `<body>`** (Spec #3241, R-3.2).
///
/// `role="note"` makes it an announcement (never a landmark, never a control): it
/// is **not** `aria-hidden` (it is the point) and **not** focusable. There is no
/// whitespace between the tags, so a `textContent` equality pin cannot fail a
/// correct build on a collapsed-text technicality (UI/UX D-21) — the tag-stripped
/// text is EXACTLY [`DEVELOPMENT_BAND_SENTENCE`], which
/// `the_band_sentence_is_the_emitted_text` asserts.
///
/// The `<strong>` wraps only the leading phrase. That is a presentation choice, not
/// a second claim: the emphasis channel (weight) is redundant with the text, and a
/// reader that ignores markup still reads the whole sentence. The hook comes from
/// [`DEVELOPMENT_BAND_TESTID`], so the attribute and the pin cannot drift.
fn mode_band_markup() -> String {
    format!(
        "<div data-testid=\"{DEVELOPMENT_BAND_TESTID}\" class=\"fredo-mode-band\" role=\"note\"><strong>Development build</strong> — not a normally installed application.</div>"
    )
}

/// Serialize the bootstrap's config block.
///
/// `serde_json` escapes everything that could close the element, and `<`/`>`
/// are escaped as `\u003c`/`\u003e` so the JSON can never be mistaken for
/// markup.
fn config_json(config: &DocumentConfig, theme: &ThemePayload) -> String {
    let theme_value = serde_json::json!({
        "tokens": theme
            .tokens
            .iter()
            .map(|token| serde_json::json!({ "name": token.name, "value": token.value }))
            .collect::<Vec<_>>(),
        "colorScheme": theme.color_scheme,
    });

    let mut object = serde_json::Map::new();
    object.insert("appId".to_string(), serde_json::Value::from(config.app_id.clone()));
    object.insert("version".to_string(), serde_json::Value::from(config.version.clone()));
    object.insert(
        "displayName".to_string(),
        serde_json::Value::from(config.display_name.clone()),
    );
    object.insert("module".to_string(), serde_json::Value::from(config.module.clone()));
    object.insert("theme".to_string(), theme_value);
    // An unset optional is an ABSENT KEY, never an explicit null.
    if let Some(failure) = config.startup_failure {
        object.insert(
            "startupFailure".to_string(),
            serde_json::Value::from(failure),
        );
    }

    let serialized =
        serde_json::to_string(&serde_json::Value::Object(object)).unwrap_or_else(|_| "{}".to_string());
    serialized.replace('<', "\\u003c").replace('>', "\\u003e")
}

/// The `<base href>` a nested entry document needs so the app's own relative
/// references resolve under `<id>/files/<dir>/`.
fn base_tag(config: &DocumentConfig, entry_document: &str) -> String {
    let Some((directory, _)) = entry_document.rsplit_once('/') else {
        return String::new();
    };
    if directory.is_empty() {
        return String::new();
    }
    format!(
        "<base href=\"/{}/{}/\">",
        escape_html(&config.app_id),
        escape_html(directory)
    )
}

/// Is there already a `<base>` in the document? (A package may legitimately
/// ship one; ours is only a fallback for a nested entry document.)
fn has_base_element(html: &str) -> bool {
    html.to_ascii_lowercase().contains("<base ")
}

/// Inject the host's style, config block, mount region and bootstrap script
/// into the application's HTML.
///
/// Robustness rule (the plan's "keep it simple"): if the document has a
/// `</head>`/`<body` the style goes into the head and the tail goes at the end
/// of the body; otherwise the style is prepended and the tail appended. An app
/// that ships neither still gets a valid document.
pub fn inject_into_document(
    html: &str,
    style: &str,
    config_block: &str,
    root_markup: &str,
    script_markup: &str,
    extra_head: &str,
    body_lead: &str,
) -> String {
    let lowered = html.to_ascii_lowercase();

    let style_markup = format!("<style id=\"__fredo-style\">{style}</style>");
    let head_insert = format!("{extra_head}{style_markup}");

    let mut output = String::with_capacity(html.len() + head_insert.len() + config_block.len() + root_markup.len() + script_markup.len() + body_lead.len() + 64);

    if let Some(index) = lowered.find("</head>") {
        output.push_str(&html[..index]);
        output.push_str(&head_insert);
        output.push_str(&html[index..]);
    } else if let Some(index) = lowered.find("<body") {
        output.push_str(&html[..index]);
        output.push_str(&head_insert);
        output.push_str(&html[index..]);
    } else {
        output.push_str(&head_insert);
        output.push_str(html);
    }

    // `body_lead` (S2's marking band, Spec #3241) is the FIRST CHILD of `<body>`:
    // it is spliced immediately after the `<body …>` tag's closing `>`, so an
    // assistive reading meets it BEFORE the application's own markup. The tail form
    // would be last in reading order — a screen-reader user would hear the whole
    // application (and, on a long document, might never reach the end) before
    // learning it is a development build (UI/UX D-2).
    //
    // The scan is BOUNDED: the `<body` match is advanced to the next `>` and if
    // there is none before end-of-input the band is PREPENDED to the document
    // instead of being spliced at an arbitrary offset (the plan's hazard note). A
    // document with no `<body` at all takes the same prepend path, mirroring the
    // head-insert fallback above. The comparison runs on the lowercased copy, whose
    // `to_ascii_lowercase` preserves byte length, so `html[..index]` slicing stays
    // valid.
    if !body_lead.is_empty() {
        let lowered = output.to_ascii_lowercase();
        match body_open_end(&lowered) {
            Some(index) => output.insert_str(index, body_lead),
            None => output.insert_str(0, body_lead),
        }
    }

    let tail = format!("{config_block}{root_markup}{script_markup}");
    let lowered = output.to_ascii_lowercase();
    if let Some(index) = lowered.rfind("</body>") {
        output.insert_str(index, &tail);
    } else {
        output.push_str(&tail);
    }

    output
}

/// The byte offset just past the `<body …>` tag's closing `>` — `None` when the
/// document has no `<body` tag OR the tag never closes before end-of-input.
///
/// Bounded by construction: `find('>')` is scoped to the slice that starts at the
/// `<body` match, so a truncated document can never produce a splice offset beyond
/// its own length.
fn body_open_end(lowered: &str) -> Option<usize> {
    let start = lowered.find("<body")?;
    let close = lowered[start..].find('>')?;
    Some(start + close + 1)
}

/// Build the complete served document for one installed application.
pub fn render_document(
    html: &str,
    theme: &ThemePayload,
    config: &DocumentConfig,
    entry_document: &str,
    has_root: bool,
) -> String {
    let development = config.mode.is_development();
    // S2's stylesheet rides the DEVELOPMENT arm only: a released document's bytes
    // stay byte-identical to a pre-#3241 document (INV-6).
    let style = if development {
        format!("{}{}{}", theme_style_block(theme), PANEL_CSS, MODE_BAND_CSS)
    } else {
        format!("{}{}", theme_style_block(theme), PANEL_CSS)
    };
    let json = config_json(config, theme);
    let config_block = format!(
        "<script type=\"application/json\" id=\"{CONFIG_ELEMENT_ID}\">{json}</script>"
    );

    let root_markup = if has_root {
        String::new()
    } else {
        format!(
            "<div data-testid=\"{ROOT_TESTID}\" role=\"region\" aria-label=\"{}\" tabindex=\"-1\"></div>",
            escape_html(&config.display_name)
        )
    };

    let script_markup = format!(
        "<script src=\"/{BOOTSTRAP_PATH}\" type=\"text/javascript\"></script>"
    );

    let extra_head = if has_base_element(html) {
        String::new()
    } else {
        base_tag(config, entry_document)
    };

    let body_lead = if development { mode_band_markup() } else { String::new() };

    inject_into_document(
        html,
        &style,
        &config_block,
        &root_markup,
        &script_markup,
        &extra_head,
        &body_lead,
    )
}

/// The host-authored document served when the entry document's bytes no longer
/// match the install record.
///
/// This document contains **no application markup and no application module**:
/// it exists so a window that was already created (a race against ST-4's
/// pre-open verification) shows the specific failure — the app's name, the
/// plain-language reason, the `integrity_mismatch` code and a working Retry —
/// instead of the browser's raw 403 page. The failure is still a refusal: not
/// one byte of the mutated entry document is served.
pub fn render_failure_document(
    theme: &ThemePayload,
    config: &DocumentConfig,
) -> String {
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{}</title></head><body></body></html>",
        escape_html(&config.display_name)
    );
    render_document(&body, theme, config, "index.html", false)
}

/// Verify every recorded file of an installed application against its pin.
///
/// This is the pre-flight ST-4 calls **before creating a window**, so
/// `integrity_mismatch` is rendered by the launcher (T-4.4's "no window is
/// created") rather than inside a child document. Each file is read once, that
/// same buffer is hashed, and it is dropped — ST-3's serve path does the same
/// thing per request, so neither reads a path it has already verified
/// (CWE-367).
pub fn verify_install(app_dir: &Path) -> super::InstalledAppResult<()> {
    let record = store::read_record(app_dir)?;
    for file in &record.files {
        store::verify_file(app_dir, file)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The response model
// ---------------------------------------------------------------------------

/// One resolved response, independent of `http::Response` so routing and
/// integrity can be unit-tested without a Tauri runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServedResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    /// The refusal reason, surfaced to the bootstrap through
    /// `x-fredo-reason` (one of the four reason codes) — `None` on success.
    pub reason: Option<&'static str>,
}

impl ServedResponse {
    fn ok(content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            status: StatusCode::OK.as_u16(),
            content_type,
            body,
            reason: None,
        }
    }

    fn not_found(detail: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND.as_u16(),
            content_type: TEXT_CONTENT_TYPE,
            body: detail.as_bytes().to_vec(),
            reason: None,
        }
    }

    fn refused(reason: &'static str, detail: &str) -> Self {
        Self {
            status: StatusCode::FORBIDDEN.as_u16(),
            content_type: TEXT_CONTENT_TYPE,
            body: detail.as_bytes().to_vec(),
            reason: Some(reason),
        }
    }

    /// The reason code string for an integrity refusal (used by the tests and
    /// by the tracing line).
    pub fn reason_code(&self) -> Option<&'static str> {
        self.reason
    }
}

/// Was this response a successful serve?
pub fn is_success(response: &ServedResponse) -> bool {
    response.status == StatusCode::OK.as_u16()
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/// Find the record entry for a relative path.
///
/// An unrecorded file is **not servable**: the record is the whitelist, so a
/// file the installer did not hash (added later, or left by a crash) has no
/// route.
pub fn recorded_file<'a>(
    record: &'a InstalledAppRecord,
    relative: &str,
) -> Option<&'a InstalledFileRecord> {
    record.files.iter().find(|file| file.path == relative)
}

/// Serve one request from a registry root.
///
/// Pure enough to test end-to-end: it needs the install root on disk (a
/// `tempfile` in the tests) and a theme, and it touches nothing else.
pub fn serve_request(install_root: &Path, path: &str, theme: &ThemePayload) -> ServedResponse {
    match route(path) {
        Ok(Route::Bootstrap) => {
            ServedResponse::ok(JAVASCRIPT_CONTENT_TYPE, BOOTSTRAP_SCRIPT.as_bytes().to_vec())
        }
        // The beacon ingress is STATEFUL (a nonce store + the ingress receipt),
        // so the real serve happens in `handle_uri_request`, which holds the app
        // handle. This pure helper answers only so routing stays unit-testable.
        Ok(Route::Beacon) => ServedResponse::ok("image/gif", Vec::new()),
        Ok(Route::App { id, relative }) => serve_app(install_root, &id, &relative, theme),
        Err(RouteMiss::Reserved) => ServedResponse::not_found("reserved path"),
        Err(RouteMiss::Escapes) => ServedResponse::not_found("path escapes the application root"),
        Err(RouteMiss::NoApp) => ServedResponse::not_found("no application at this path"),
    }
}

fn serve_app(
    install_root: &Path,
    id: &str,
    relative: &str,
    theme: &ThemePayload,
) -> ServedResponse {
    let app_dir = store::app_dir(install_root, id);

    let record = match store::read_record(&app_dir) {
        Ok(record) => record,
        // A missing/damaged record means we cannot prove any byte, so nothing
        // is served. ST-4 turns this into the launcher's
        // `integrity_record_corrupt` refusal before a window is created.
        Err(_) => return ServedResponse::not_found("no readable install record"),
    };

    if relative.is_empty() {
        return serve_entry_document(&app_dir, &record, theme);
    }

    let Some(file) = recorded_file(&record, relative) else {
        return ServedResponse::not_found("no recorded file at this path");
    };

    // Belt and braces: the record's path was validated at install, but the
    // serve path re-proves containment so a tampered record cannot escape.
    let files_root = app_dir.join(INSTALLED_FILES_SUBDIR);
    if super::archive::join_under_root(&files_root, &file.path).is_err() {
        return ServedResponse::not_found("recorded path escapes the application root");
    }

    match store::read_verified_file(&app_dir, file) {
        Ok(bytes) => ServedResponse::ok(content_type_for(&file.path), bytes),
        Err(_) => ServedResponse::refused(
            InstalledAppRefusalCode::IntegrityMismatch.as_str(),
            "the file on disk does not match its recorded hash",
        ),
    }
}

fn serve_entry_document(
    app_dir: &Path,
    record: &InstalledAppRecord,
    theme: &ThemePayload,
) -> ServedResponse {
    let entry = record.entry_document.as_str();
    // The ONE presence check (Spec #3241) — never re-implemented here.
    let mode = store::read_development_marker(app_dir);
    let base_config = || DocumentConfig {
        app_id: record.id.clone(),
        version: record.version.clone(),
        display_name: record
            .display_name
            .clone()
            .unwrap_or_else(|| record.id.clone()),
        module: format!("/{}/{}", record.id, record.entry_module),
        startup_failure: None,
        mode,
    };

    let Some(file) = recorded_file(record, entry) else {
        return ServedResponse::not_found("the recorded entry document is not in the install record");
    };

    let files_root = app_dir.join(INSTALLED_FILES_SUBDIR);
    if super::archive::join_under_root(&files_root, &file.path).is_err() {
        return ServedResponse::not_found("entry document path escapes the application root");
    }

    // Verify-once: the SAME buffer that was hashed is the one parsed and served.
    let integrity = store::read_verified_file(app_dir, file).and_then(|bytes| {
        // The entry module is the one other file a document cannot start
        // without, and it is the file a tamper most often targets. It is
        // verified HERE, while the record is in hand, so the correct reason
        // code (`integrity_mismatch`) can be carried in the document — an
        // `import()` rejection cannot expose a response header to a script.
        //
        // A module that is not in the record at all is not a mismatched byte;
        // it is a broken install, and `import()` fails it as `load_failed`.
        if let Some(module) = recorded_file(record, &record.entry_module) {
            store::verify_file(app_dir, module)?;
        }
        Ok(bytes)
    });

    let bytes = match integrity {
        Ok(bytes) => bytes,
        Err(_) => {
            // Nothing of the application is served. The host-authored failure
            // document is, so the specific failure is visible with a working
            // Retry. The status stays 200 — the bootstrap must be able to run
            // to render the panel, and the refusal is carried by the panel, not
            // by an HTTP error page no script can decorate.
            let failing = DocumentConfig {
                startup_failure: Some(InstalledAppRefusalCode::IntegrityMismatch.as_str()),
                ..base_config()
            };
            let document = render_failure_document(theme, &failing);
            let mut response = ServedResponse::ok(HTML_CONTENT_TYPE, document.into_bytes());
            response.reason = Some(InstalledAppRefusalCode::IntegrityMismatch.as_str());
            return response;
        }
    };

    let html = String::from_utf8_lossy(&bytes).into_owned();
    let already_has_root = html.contains(&format!("data-testid=\"{ROOT_TESTID}\""));
    let document = render_document(&html, theme, &base_config(), entry, already_has_root);
    ServedResponse::ok(HTML_CONTENT_TYPE, document.into_bytes())
}

// ---------------------------------------------------------------------------
// Tauri plumbing
// ---------------------------------------------------------------------------

/// The app-data dir through the ONE shipped resolver (identical to ST-2's
/// `commands_install::app_data_dir`; both call
/// `infrastructure::storage::boot_config::resolve_app_data_dir`, so
/// `FREDO_DATA_DIR` is the single override).
pub fn app_data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|os_dir| {
        crate::infrastructure::storage::boot_config::resolve_app_data_dir(&os_dir)
    })
}

/// Emit the ONE serve line per request.
///
/// The QA plan's serve-line receipt (every refusal row, T-4.3, T-5.1, T-5.4,
/// T-5.5) greps the environment log for `fredoapp`; this is the only host-side
/// instrument that can distinguish "opened" from "never served". It logs at
/// `info` on target [`TRACE_TARGET`] with message `installed-app serve` and a
/// `url` field carrying the request URI verbatim.
///
/// `mode` is S5 (Spec #3241) — the host's own identification of WHAT it is
/// serving, carried on **every** request for an installed application (the entry
/// document, its module, an icon, a retry re-serve), because all of them are "the
/// host identifying what it is running" (UI/UX §6.2). A request that names no
/// application (`/__fredo/bootstrap.js`, the beacon uplink) carries `none`.
pub fn serve_line(url: &str, response: &ServedResponse, mode: Option<InstalledAppMode>) {
    let mode = mode.map(InstalledAppMode::as_str).unwrap_or("none");
    match response.reason {
        Some(reason) => tracing::info!(
            target: TRACE_TARGET,
            url = %url,
            status = response.status,
            mode = %mode,
            reason = %reason,
            bytes = response.body.len(),
            "installed-app serve"
        ),
        None => tracing::info!(
            target: TRACE_TARGET,
            url = %url,
            status = response.status,
            mode = %mode,
            bytes = response.body.len(),
            "installed-app serve"
        ),
    }
}

/// Build the `http::Response` for a resolved [`ServedResponse`].
pub fn to_http_response(response: ServedResponse) -> Response<Cow<'static, [u8]>> {
    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, response.content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        // The child document's own policy: authored HERE, because a response
        // this handler writes never passes through tauri.conf.json's CSP.
        .header("Content-Security-Policy", INSTALLED_APP_CSP);

    if let Some(reason) = response.reason {
        builder = builder.header(REASON_HEADER, reason);
    }

    builder
        .body(Cow::Owned(response.body))
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

/// The registered handler body: resolve the request, trace it, respond.
pub fn handle_uri_request(
    app: &tauri::AppHandle,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let url = request.uri().to_string();
    let path = request.uri().path().to_string();

    // Spec #3244 ST-7 — the outline uplink. Handled BEFORE the install-root work:
    // it needs no install directory (the payload is the child's own document), only
    // the app handle, so the ingress receipt can be recorded.
    if matches!(route(&path), Ok(Route::Beacon)) {
        let query = request.uri().query().map(str::to_string);
        let response = super::beacon::serve_beacon(app, query.as_deref());
        serve_line(&url, &response, None);
        return to_http_response(response);
    }

    let Some(data_dir) = app_data_dir(app) else {
        let response = ServedResponse::not_found("this build cannot resolve its app data directory");
        serve_line(&url, &response, None);
        return to_http_response(response);
    };

    let install_root = store::install_root(&data_dir);
    let theme = InstalledThemeState::read();
    let response = serve_request(&install_root, &path, &theme);
    // S5 (Spec #3241) — resolve the mode for the traced line through the SAME ONE
    // presence check the documents use. A path that names no installed application
    // (`/__fredo/bootstrap.js`, a routing miss) carries `none`, so the field is
    // always present and its absence is never ambiguous with `released`.
    let mode = served_app_mode(&install_root, &path);
    serve_line(&url, &response, mode);
    to_http_response(response)
}

/// The install mode behind a request path — `None` when the path names no
/// installed application.
///
/// Resolution goes through [`store::read_development_marker`], the ONE presence
/// check, so the traced fact is derived exactly like the painted one. The
/// directory is only probed when routing already resolved an app id, so a
/// reserved path or a traversal attempt costs no filesystem read.
fn served_app_mode(install_root: &Path, path: &str) -> Option<InstalledAppMode> {
    match route(path) {
        Ok(Route::App { id, .. }) => Some(store::read_development_marker(&store::app_dir(
            install_root,
            &id,
        ))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::installed_apps::theme_state::{fallback_theme, ThemeToken};

    fn record_with(files: Vec<(&str, &[u8])>, entry_document: &str) -> (InstalledAppRecord, PathBuf) {
        let directory = tempfile::tempdir().expect("tempdir");
        let app_dir = directory.path().join("qa3147-test");
        let files_root = app_dir.join(INSTALLED_FILES_SUBDIR);
        std::fs::create_dir_all(&files_root).expect("create files dir");

        let mut records = Vec::new();
        for (path, bytes) in files {
            std::fs::write(files_root.join(path), bytes).expect("write file");
            records.push(InstalledFileRecord {
                path: path.to_string(),
                sha256: store::sha256_hex(bytes),
                bytes: bytes.len() as u64,
            });
        }
        records.sort_by(|left, right| left.path.cmp(&right.path));

        let record = InstalledAppRecord {
            id: "qa3147-test".to_string(),
            version: "1.0.0".to_string(),
            manifest_version: 1,
            engines_fredo: ">=0.0.0".to_string(),
            entry_document: entry_document.to_string(),
            entry_module: "main.js".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            aggregate_sha256: store::aggregate_digest(&records),
            files: records,
            description: None,
            display_name: Some("QA3147 Test".to_string()),
        };
        std::fs::write(
            app_dir.join(super::super::INSTALLED_RECORD_FILENAME),
            serde_json::to_vec(&record).expect("serialize record"),
        )
        .expect("write record");

        // Keep the tempdir alive: leak its path by returning it and forgetting
        // the guard's cleanup (a test process exit removes it).
        let root = directory.keep();
        (record, root)
    }

    // ── 1. Path escape ─────────────────────────────────────────────────────

    #[test]
    fn a_path_that_escapes_the_app_root_is_refused() {
        for escaping in [
            "../secret.txt",
            "assets/../../secret.txt",
            "..",
            "./main.js",
            "/etc/passwd",
            "//server/share/x",
            "C:/windows/system32/x.dll",
            "C:\\windows\\x.dll",
            "assets\\..\\..\\secret.txt",
            "main.js\0.png",
        ] {
            assert_eq!(
                sanitize_relative(escaping),
                Err(RouteMiss::Escapes),
                "{escaping:?} must not resolve inside <id>/files"
            );
        }

        // Percent-encoded traversal is decoded first and then rejected on the
        // SAME rule.
        assert_eq!(route("/qa3147-test/%2e%2e/secret.txt"), Err(RouteMiss::Escapes));
        assert_eq!(route("/qa3147-test/assets%2F%2e%2e%2fsecret.txt"), Err(RouteMiss::Escapes));

        // The controls: ordinary nested paths are accepted.
        assert_eq!(sanitize_relative("main.js"), Ok("main.js".to_string()));
        assert_eq!(sanitize_relative("assets/logo.png"), Ok("assets/logo.png".to_string()));
        assert_eq!(sanitize_relative(""), Ok(String::new()));
        assert_eq!(sanitize_relative("/"), Ok(String::new()));

        // A double slash is not the entry document: it is a malformed path.
        assert_eq!(sanitize_relative("//"), Err(RouteMiss::Escapes));
        assert_eq!(sanitize_relative("/main.js"), Err(RouteMiss::Escapes));

        // Routing applies the same rule to the whole URL, and rejects an id
        // that cannot be an app id before touching the filesystem.
        assert_eq!(route("/../etc/passwd"), Err(RouteMiss::NoApp));
        assert_eq!(route("/Qa3147-Test/main.js"), Err(RouteMiss::NoApp));
        assert_eq!(route("//qa3147-test/main.js"), Err(RouteMiss::Escapes));
        assert_eq!(route("/qa3147-test//main.js"), Err(RouteMiss::Escapes));

    }

    // ── 2. Reserved path ──────────────────────────────────────────────────

    #[test]
    fn only_the_bootstrap_is_reachable_under_the_reserved_segment() {
        // Spec #3244 ST-7 — RE-CUT, never deleted. `__fredo/` now serves TWO host
        // paths: the bootstrap AND the outline uplink (`/__fredo/beacon`). A second
        // serve under the reserved segment is a DELIBERATE, human-approved
        // expansion (Option A, 2026-11-26; see `docs/ARCHITECTURE.md`), so the
        // bootstrap assertions SURVIVE unchanged and the beacon route is ADDED —
        // while EVERY OTHER reserved path remains a miss.
        //
        // SURVIVING (the pin's original assertions, verbatim):
        assert_eq!(route("/__fredo/bootstrap.js"), Ok(Route::Bootstrap));
        assert_eq!(route("__fredo/bootstrap.js"), Ok(Route::Bootstrap));

        // ADDED (ST-7): the uplink route is reachable — and ONLY it is added.
        assert_eq!(route("/__fredo/beacon"), Ok(Route::Beacon));
        assert_eq!(route("__fredo/beacon"), Ok(Route::Beacon));
        assert_eq!(route("/__fredo/beacon/"), Ok(Route::Beacon));

        // SURVIVING: every OTHER reserved path is still a miss, never a serve.
        for reserved in [
            "/__fredo/other.js",
            "/__fredo/",
            "/__fredo",
            "/__fredo/beacon.js",
            "/__fredo/beaconextra",
        ] {
            assert_eq!(
                route(reserved),
                Err(RouteMiss::Reserved),
                "{reserved:?} must be a miss, never a serve"
            );
        }

        assert_eq!(
            route("/qa3147-test/__fredo/bootstrap.js"),
            Err(RouteMiss::Reserved),
            "an app may not shadow the host path"
        );
        assert_eq!(
            route("/qa3147-test/__fredo/beacon"),
            Err(RouteMiss::Reserved),
            "an app may not shadow the host uplink either"
        );
    }

    #[test]
    fn routing_never_reaches_the_record_or_manifest_files() {
        // `record.json` / `manifest.json` live OUTSIDE `files/`, so no relative
        // path inside `<id>/files` can name them.
        for path in ["/qa3147-test/record.json", "/qa3147-test/manifest.json"] {
            let (record, root) = record_with(vec![("main.js", b"export function mount() {}")], "index.html");
            let response = serve_request(&root, path, &fallback_theme());
            assert_eq!(
                response.status,
                StatusCode::NOT_FOUND.as_u16(),
                "{path} must not be servable: {record:?}"
            );
        }
    }

    // ── 3. Integrity mismatch ─────────────────────────────────────────────

    #[test]
    fn a_mutated_file_is_integrity_mismatch_and_is_never_served() {
        let (record, root) = record_with(
            vec![("index.html", b"<!doctype html><html><body><p>hi</p></body></html>"), ("main.js", b"export function mount() {}")],
            "index.html",
        );
        let app_dir = store::app_dir(&root, &record.id);
        let target = app_dir.join(INSTALLED_FILES_SUBDIR).join("main.js");

        // The untampered file serves.
        let clean = serve_request(&root, "/qa3147-test/main.js", &fallback_theme());
        assert!(is_success(&clean));
        assert_eq!(clean.body, b"export function mount() {}");
        assert_eq!(clean.content_type, JAVASCRIPT_CONTENT_TYPE);

        // One flipped byte → refused, with the code the failure panel reports,
        // and the mutated bytes are NOT in the body.
        std::fs::write(&target, b"export function Mount() {}").expect("tamper");
        let tampered = serve_request(&root, "/qa3147-test/main.js", &fallback_theme());
        assert_eq!(tampered.status, StatusCode::FORBIDDEN.as_u16());
        assert_eq!(
            tampered.reason,
            Some(InstalledAppRefusalCode::IntegrityMismatch.as_str())
        );
        assert_ne!(tampered.body, b"export function Mount() {}");
    }

    #[test]
    fn an_unrecorded_file_is_never_served() {
        let (_record, root) = record_with(vec![("main.js", b"export function mount() {}")], "index.html");
        let app_dir = store::app_dir(&root, "qa3147-test");

        // A file that exists on disk but is NOT in the record.
        std::fs::write(
            app_dir.join(INSTALLED_FILES_SUBDIR).join("planted.js"),
            b"export function mount() { /* planted */ }",
        )
        .expect("plant");

        let response = serve_request(&root, "/qa3147-test/planted.js", &fallback_theme());
        assert_eq!(response.status, StatusCode::NOT_FOUND.as_u16());
        assert!(!response.body.starts_with(b"export function mount"));
    }

    #[test]
    fn the_entry_document_is_served_wrapped_with_the_host_pieces() {
        let html = "<!doctype html><html><head><title>t</title></head><body><p>app body</p></body></html>";
        let (_record, root) = record_with(vec![("index.html", html.as_bytes()), ("main.js", b"export function mount() {}")], "index.html");

        let response = serve_request(&root, "/qa3147-test/", &fallback_theme());
        assert!(is_success(&response));
        assert_eq!(response.content_type, HTML_CONTENT_TYPE);
        let document = String::from_utf8(response.body).expect("utf8");

        // The app's own markup survives.
        assert!(document.contains("app body"));
        // And the host pieces are injected.
        assert!(document.contains("<style id=\"__fredo-style\">"));
        assert!(document.contains(BOOTSTRAP_PATH));
        assert!(document.contains(&format!("id=\"{CONFIG_ELEMENT_ID}\"")));
        assert!(document.contains(&format!("data-testid=\"{ROOT_TESTID}\"")));
        assert!(document.contains("\"displayName\":\"QA3147 Test\""));
        assert!(document.contains("\"module\":\"/qa3147-test/main.js\""));
    }

    // ── 4. MIME selection ────────────────────────────────────────────────

    #[test]
    fn content_types_are_selected_by_extension() {
        assert_eq!(content_type_for("index.html"), HTML_CONTENT_TYPE);
        assert_eq!(content_type_for("main.js"), JAVASCRIPT_CONTENT_TYPE);
        assert_eq!(content_type_for("lib.mjs"), JAVASCRIPT_CONTENT_TYPE);
        assert_eq!(content_type_for("styles.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("record.json"), "application/json; charset=utf-8");
        assert_eq!(content_type_for("icon.svg"), "image/svg+xml");
        assert_eq!(content_type_for("logo.png"), "image/png");
        assert_eq!(content_type_for("logo.JPG"), "image/jpeg");
        assert_eq!(content_type_for("font.woff2"), "font/woff2");
        assert_eq!(content_type_for("blob.wasm"), "application/wasm");
        assert_eq!(content_type_for("README"), BINARY_CONTENT_TYPE);
        assert_eq!(content_type_for("archive.unknownext"), BINARY_CONTENT_TYPE);
    }

    // ── 5. The exact CSP string ──────────────────────────────────────────

    #[test]
    fn the_csp_string_is_exactly_the_plans_and_the_tauri_config_csp_is_untouched() {
        // Byte equality against the constant (non-vacuous: the literal is
        // written out in full here, so an edit to either side fails).
        let expected = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'";
        assert_eq!(INSTALLED_APP_CSP, expected);
        assert_eq!(INSTALLED_APP_CSP.as_bytes(), expected.as_bytes());

        // Every directive the plan names, in the plan's order.
        let directives: Vec<&str> = INSTALLED_APP_CSP.split("; ").map(str::trim).collect();
        assert_eq!(
            directives,
            vec![
                "default-src 'none'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data:",
                "font-src 'self' data:",
                "connect-src ipc: http://ipc.localhost",
                "base-uri 'none'",
                "form-action 'none'",
            ]
        );

        // connect-src deliberately keeps the IPC transport reachable, so AC-2's
        // refusal is the ACL's and not a network error.
        assert!(INSTALLED_APP_CSP.contains("connect-src ipc: http://ipc.localhost"));
        assert!(!INSTALLED_APP_CSP.contains("script-src 'self' 'unsafe-inline'"));

        // The response carries it, and tauri.conf.json was not edited for it.
        let response = to_http_response(ServedResponse::ok(HTML_CONTENT_TYPE, b"x".to_vec()));
        assert_eq!(
            response
                .headers()
                .get("Content-Security-Policy")
                .and_then(|value| value.to_str().ok()),
            Some(expected)
        );

        let conf = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"));
        assert!(
            !conf.contains("fredoapp"),
            "the child policy belongs in this handler, never in tauri.conf.json"
        );
        assert!(
            !conf.contains("connect-src ipc: http://ipc.localhost"),
            "the child policy must not be mirrored into tauri.conf.json"
        );
    }

    // ── 6. The bootstrap source ──────────────────────────────────────────

    #[test]
    fn the_bootstrap_source_carries_all_five_hooks_and_the_contracts() {
        let source = BOOTSTRAP_SCRIPT;

        // All five `installed-app-*` hooks the QA rows read.
        for hook in [
            "installed-app-root",
            "installed-app-loading",
            "installed-app-failure",
            "installed-app-failure-reason",
            "installed-app-retry",
        ] {
            assert!(
                source.contains(&format!("\"{hook}\"")),
                "the bootstrap must reference the {hook} hook"
            );
        }

        // The derived mount budget, as a runtime constant.
        assert!(
            source.contains("INSTALLED_APP_MOUNT_TIMEOUT_MS = 10000"),
            "the watchdog budget must be the plan's 10 s"
        );
        assert!(source.contains("setTimeout"));

        // The theme entry points ST-5's live push needs.
        assert!(source.contains("window.__FREDO_APPLY_THEME__"));
        assert!(source.contains("fredo-theme-change"));
        assert!(source.contains("setProperty"));
        assert!(source.contains("colorScheme"));

        // The context the app-author contract promises.
        assert!(source.contains("window.__FREDO_INSTALLED__"));
        assert!(source.contains("appId"));
        assert!(source.contains("version"));

        // The failure surface: heading, the four reason codes, the exact button
        // label, and reload-based retry.
        assert!(source.contains("Couldn't open "));
        for code in ["mount_timeout", "mount_threw", "load_failed", "integrity_mismatch"] {
            assert!(source.contains(&format!("\"{code}\"")), "missing reason {code}");
        }
        assert!(source.contains("\"Try again\""));
        assert!(source.contains("location.reload()"));

        // Accessibility attributes the row reads off the live DOM.
        assert!(source.contains("\"status\""));
        assert!(source.contains("\"polite\""));
        assert!(source.contains("\"alert\""));
        assert!(source.contains("\"assertive\""));

        // Colour discipline: no hex/rgb/hsl literals and no alpha-append onto a
        // var() reference anywhere in the host-authored bootstrap.
        for banned in ["rgba(", "rgb(", "hsl(", "#"] {
            if banned == "#" {
                assert!(
                    !source.contains("'#'") && !source.contains("\"#"),
                    "the bootstrap must not hardcode a hex colour"
                );
                continue;
            }
            assert!(
                !source.contains(banned),
                "the bootstrap must not hardcode {banned:?}"
            );
        }
        assert!(
            !source.contains("var(--accent-primary)2"),
            "alpha-append onto a var() reference is invalid CSS"
        );
    }

    #[test]
    fn the_child_client_is_the_dispatchers_single_door() {
        let source = BOOTSTRAP_SCRIPT;

        // 1. The member exists on the app-facing global. It is the deliverable the
        //    QA rows drive (`window.__FREDO_INSTALLED__.invoke(action, args)`), and
        //    its absence is the `no-invoke-shim` redden signature.
        assert!(
            source.contains("invoke:"),
            "the app-facing global must carry the `invoke` child client"
        );
        assert!(
            source.contains("invoke: invokeAction"),
            "the `invoke` member must be the client function itself"
        );

        // 2. It reaches EXACTLY the dispatcher command — a second command name in
        //    this file would be a widening of the tier's single door.
        assert_eq!(
            source.matches("\"installed_app_invoke\"").count(),
            1,
            "the bootstrap must name exactly one transport command"
        );

        // 3. It uses the injected handle, resolved at call time.
        assert!(
            source.contains("__TAURI_INTERNALS__"),
            "the client must call the injected `__TAURI_INTERNALS__` handle"
        );

        // 4. The wire shape is the `request` wrapper — `dispatch.rs`'s command
        //    parameter is named `request`, so a bare `{action, args}` object is a
        //    malformed payload, not a call. Asserted as the exact argument object
        //    of that call, not as the bare token: this file's prose already
        //    contains `request:`, and a presence check on that would stay green
        //    on the failing shape.
        let call_at = source
            .find("internals.invoke(\"installed_app_invoke\",")
            .expect("the client must call the dispatcher through the injected handle");
        assert_eq!(
            source
                .matches("request: { action: action, args: payload }")
                .count(),
            1,
            "the client must send the `request` wrapper, not a flat payload"
        );
        let wrapper_at = source
            .find("request: { action: action, args: payload }")
            .expect("the client must send the `request` wrapper");
        assert!(
            call_at < wrapper_at,
            "the `request` wrapper must be the dispatcher call's own argument"
        );

        // 5. Ordering: the client exists BEFORE the module is imported, so an
        //    application's own module can call it during evaluation.
        let client_at = source
            .find("invoke: invokeAction")
            .expect("the child client must be assigned");
        let mount_at = source
            .find("beginMount();")
            .expect("the bootstrap must mount the application");
        assert!(
            client_at < mount_at,
            "the child client must be observable before the application is mounted"
        );

        // 6. No fabricated taxonomy, and no client-side vocabulary: the shim
        //    authors none of the six wire codes the dispatcher owns.
        for code in [
            "action_not_declared",
            "action_not_grantable",
            "consent_required",
            "scope_denied",
            "caller_unknown",
            "app_not_installed",
        ] {
            assert!(
                !source.contains(code),
                "the bootstrap must not author the host's refusal code {code}"
            );
        }

        // 7. No escape hatch: no evaluated source, no constructed function.
        assert!(
            !source.contains("eval("),
            "the child client must not evaluate source"
        );
        assert!(
            !source.contains("new Function"),
            "the child client must not construct a function from text"
        );
    }

    #[test]
    fn the_panel_stylesheet_stays_on_theme_vars_and_system_colours() {
        for banned in ["rgba(", "rgb(", "hsl(", "#"] {
            if banned == "#" {
                assert!(!PANEL_CSS.contains('#'), "no hex literals in the panel CSS");
                continue;
            }
            assert!(!PANEL_CSS.contains(banned), "no {banned:?} in the panel CSS");
        }
        // Only var() reads with system-colour fallbacks.
        assert!(PANEL_CSS.contains("var(--body-bg, Canvas)"));
        assert!(PANEL_CSS.contains("var(--text-primary, CanvasText)"));
        assert!(PANEL_CSS.contains("var(--text-secondary, GrayText)"));
        assert!(PANEL_CSS.contains("var(--border-color, GrayText)"));
        assert!(PANEL_CSS.contains("min-height: 100dvh"));
        // The reduced-motion rule removes the moving segment.
        assert!(PANEL_CSS.contains("prefers-reduced-motion: reduce"));
        assert!(PANEL_CSS.contains("animation: none"));
    }

    // ── Theme injection ──────────────────────────────────────────────────

    #[test]
    fn the_theme_style_block_declares_every_token() {
        let theme = ThemePayload {
            tokens: vec![
                ThemeToken {
                    name: "--body-bg".to_string(),
                    value: "color-mix(in srgb, Canvas 92%, GrayText)".to_string(),
                },
                ThemeToken {
                    name: "--text-primary".to_string(),
                    value: "CanvasText".to_string(),
                },
                // A value that tries to break out of the declaration is defused.
                ThemeToken {
                    name: "--card-bg".to_string(),
                    value: "Canvas } body { display: none }".to_string(),
                },
                // A name that is not a custom property is dropped.
                ThemeToken {
                    name: "body".to_string(),
                    value: "Canvas".to_string(),
                },
            ],
            color_scheme: "dark".to_string(),
        };

        let css = theme_style_block(&theme);
        assert!(css.starts_with(":root {"));
        assert!(css.contains("--body-bg: color-mix(in srgb, Canvas 92%, GrayText);"));
        assert!(css.contains("--text-primary: CanvasText;"));
        // The defused value cannot terminate the declaration: no `{`, `}` or `;`
        // survives inside it, so the leftover text stays part of ONE value.
        assert!(
            !css.contains("--card-bg: Canvas } body"),
            "a value cannot close the rule: {css}"
        );
        assert!(
            css.contains("--card-bg: Canvas  body  display: none;"),
            "the defused value is still a single declaration: {css}"
        );
        // Exactly one rule opens and one closes, regardless of the values
        // supplied.
        assert_eq!(css.matches('{').count(), 1, "one rule: {css}");
        assert_eq!(css.matches('}').count(), 1, "one rule: {css}");
        assert_eq!(
            css.matches(';').count(),
            3,
            "one declaration per KEPT token (the 4 supplied minus the non-custom-property name): {css}"
        );
        assert!(!css.contains("\n  body:"), "a non-custom-property name is dropped");
    }

    #[test]
    fn the_document_injects_a_base_tag_only_for_a_nested_entry_and_no_existing_base() {
        let theme = fallback_theme();
        let config = DocumentConfig {
            app_id: "qa3147-test".to_string(),
            version: "1.0.0".to_string(),
            display_name: "QA3147 Test".to_string(),
            module: "/qa3147-test/sub/main.js".to_string(),
            startup_failure: None,
            mode: InstalledAppMode::Released,
        };

        let flat = render_document(
            "<html><head></head><body></body></html>",
            &theme,
            &config,
            "index.html",
            false,
        );
        assert!(!flat.contains("<base "), "a root-level entry document needs no base");

        let nested = render_document(
            "<html><head></head><body></body></html>",
            &theme,
            &config,
            "sub/app.html",
            false,
        );
        assert!(nested.contains("<base href=\"/qa3147-test/sub/\">"));

        let with_base = render_document(
            "<html><head><base href=\"/x/\"></head><body></body></html>",
            &theme,
            &config,
            "sub/app.html",
            false,
        );
        assert_eq!(
            with_base.matches("<base ").count(),
            1,
            "an author-supplied base is never duplicated"
        );
    }

    #[test]
    fn a_document_with_neither_head_nor_body_still_gets_the_host_pieces() {
        let theme = fallback_theme();
        let config = DocumentConfig {
            app_id: "qa3147-test".to_string(),
            version: "1.0.0".to_string(),
            display_name: "QA3147 <Test>".to_string(),
            module: "/qa3147-test/main.js".to_string(),
            startup_failure: None,
            mode: InstalledAppMode::Released,
        };
        let document = render_document("<p>bare</p>", &theme, &config, "index.html", false);
        assert!(document.contains("<p>bare</p>"));
        assert!(document.contains("<style id=\"__fredo-style\">"));
        assert!(document.contains(BOOTSTRAP_PATH));
        // The display name is escaped in the aria-label attribute.
        assert!(document.contains("aria-label=\"QA3147 &lt;Test&gt;\""));
    }

    #[test]
    fn an_existing_root_markup_is_not_duplicated() {
        let theme = fallback_theme();
        let config = DocumentConfig {
            app_id: "qa3147-test".to_string(),
            version: "1.0.0".to_string(),
            display_name: "QA3147 Test".to_string(),
            module: "/qa3147-test/main.js".to_string(),
            startup_failure: None,
            mode: InstalledAppMode::Released,
        };
        let html = "<html><head></head><body><div data-testid=\"installed-app-root\"></div></body></html>";
        let document = render_document(html, &theme, &config, "index.html", true);
        // Count ELEMENT occurrences only: the panel stylesheet legitimately
        // contains the same `[data-testid="installed-app-root"]` selector, so a
        // bare substring count would be 2 even when injection is correct.
        assert_eq!(
            document.matches("<div data-testid=\"installed-app-root\"").count(),
            1,
            "the mount region is injected exactly once"
        );
        assert_eq!(
            document.matches("role=\"region\"").count(),
            0,
            "an author-supplied root is not re-stamped by the host"
        );
    }

    #[test]
    fn the_host_pieces_land_inside_the_head_and_body_of_a_real_fixture_document() {
        // The exact shape ST-7's generator emits: a real HTML document with a
        // <head>, an inline <style>, a <body data-fixture-document="..."> and a
        // <noscript>. Everything the fixture writes must survive and the host
        // pieces must land in the standard places.
        let fixture = "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\" />\n  <title>QA3147 Probe - Fredo QA fixture</title>\n  <style>\n    body { background: var(--body-bg); color: var(--text-primary); }\n  </style>\n</head>\n<body data-fixture-document=\"qa3147-probe\">\n  <noscript>This fixture needs JavaScript.</noscript>\n</body>\n</html>\n";
        let theme = fallback_theme();
        let config = DocumentConfig {
            app_id: "qa3147-probe".to_string(),
            version: "1.0.0".to_string(),
            display_name: "QA3147 Probe".to_string(),
            module: "/qa3147-probe/main.js".to_string(),
            startup_failure: None,
            mode: InstalledAppMode::Released,
        };

        let document = render_document(fixture, &theme, &config, "index.html", false);
        let lowered = document.to_ascii_lowercase();

        // The fixture's own content survives byte-for-byte.
        assert!(document.contains("QA3147 Probe - Fredo QA fixture"));
        assert!(document.contains("data-fixture-document=\"qa3147-probe\""));
        assert!(document.contains("<noscript>This fixture needs JavaScript.</noscript>"));

        // The host style + config + script land inside <head>, the mount region
        // and script inside <body>.
        let head_close = lowered.find("</head>").expect("head close");
        let style_at = document.find("<style id=\"__fredo-style\">").expect("host style");
        assert!(style_at < head_close, "the host style is in the head");
        let script_at = document.find(BOOTSTRAP_PATH).expect("bootstrap script");
        assert!(script_at > head_close, "the bootstrap script is in the body");

        // The bootstrap script comes AFTER the config block it reads.
        let config_at = document.find(&format!("id=\"{CONFIG_ELEMENT_ID}\"")).expect("config");
        assert!(config_at < script_at, "the config block precedes the bootstrap");

        // And the whole thing is still a valid single-document HTML shape.
        assert_eq!(document.matches("<html").count(), 1);
        assert_eq!(document.matches("</html>").count(), 1);
        assert_eq!(document.matches("<head").count(), 1);
        assert_eq!(document.matches("</head>").count(), 1);
        assert_eq!(document.matches("<body").count(), 1);
        assert_eq!(document.matches("</body>").count(), 1);
    }

    // ── S2: the development band (Spec #3241, R-3.2) ─────────────────────────

    /// A document config for the band pins, with the mode under test.
    fn band_config(mode: InstalledAppMode) -> DocumentConfig {
        DocumentConfig {
            app_id: "qa3147-probe".to_string(),
            version: "1.0.0".to_string(),
            display_name: "QA3147 Probe".to_string(),
            module: "/qa3147-probe/main.js".to_string(),
            startup_failure: None,
            mode,
        }
    }

    /// The document body the band pins drive: a full-bleed application document
    /// (`height:100dvh; overflow:hidden`) — the fixture the plan names for S2, so
    /// an in-flow banner would scroll out of view and a fixed band would not.
    const FULL_BLEED_BODY: &str = "<body><div data-testid=\"installed-app-root\" style=\"height:100dvh;overflow:hidden\"><p>app body</p></div></body>";

    /// The band's text with its host tags stripped — the oracle for the sentence
    /// pins, so the `<strong>` emphasis can never make a correct build fail.
    fn mode_band_text(document: &str) -> Option<String> {
        let start = document.find(&format!("<div data-testid=\"{DEVELOPMENT_BAND_TESTID}\""))?;
        let open_tag_end = start + document[start..].find('>')? + 1;
        let close = open_tag_end + document[open_tag_end..].find("</div>")?;
        Some(
            document[open_tag_end..close]
                .replace("<strong>", "")
                .replace("</strong>", ""),
        )
    }

    /// **R-3.2 / F-10.2's anchor — an EMITTED-STRING property.**
    ///
    /// The band's index is greater than the `<body …>` tag's closing `>` and less
    /// than the index of the document's original first body child. That is exactly
    /// what the tail-insertion form violates: it splices the band next to
    /// `</body>`, i.e. AFTER the application's markup, so a screen-reader user hears
    /// the whole application (or never reaches the end of a long document) before
    /// learning it is a development build.
    #[test]
    fn the_band_is_the_first_child_of_body_in_the_emitted_string() {
        let document = render_document(
            FULL_BLEED_BODY,
            &fallback_theme(),
            &band_config(InstalledAppMode::Development),
            "index.html",
            true,
        );

        let band_at = document
            .find(&format!("data-testid=\"{DEVELOPMENT_BAND_TESTID}\""))
            .expect("a development build's document carries the band");

        // The bound is the `<body …>` tag's own closing `>`, not the tag's start.
        let lowered = document.to_ascii_lowercase();
        let body_open_end = body_open_end(&lowered).expect("the fixture has a <body tag");
        assert!(
            band_at > body_open_end,
            "the band must come AFTER the <body> tag's closing '>', not inside it"
        );

        // The other bound: the document's ORIGINAL first body content.
        let first_child_at = document
            .find("<div data-testid=\"installed-app-root\"")
            .expect("the fixture's own first body child");
        assert!(
            band_at < first_child_at,
            "the band must precede the application's own first body child in the \
             emitted string — the tail-insertion form puts it AFTER, which is what \
             this pin exists to redden"
        );

        // And it is not inside the app root either (a sibling, never a child).
        let app_root_at = first_child_at;
        let app_root_depth = document[app_root_at..]
            .find("</div>")
            .map(|offset| app_root_at + offset)
            .expect("the app root closes");
        assert!(
            band_at < app_root_at || band_at > app_root_depth,
            "the band must be a SIBLING of the app root, never inside it"
        );
    }

    /// The band's own sentence, read from the emitted markup with the tags
    /// stripped — so a wording drift is visible, and the no-whitespace emission
    /// rule (UI/UX D-21) is pinned rather than assumed.
    #[test]
    fn the_band_sentence_is_the_emitted_text() {
        let document = render_document(
            FULL_BLEED_BODY,
            &fallback_theme(),
            &band_config(InstalledAppMode::Development),
            "index.html",
            true,
        );

        let start = document
            .find(&format!("<div data-testid=\"{DEVELOPMENT_BAND_TESTID}\""))
            .expect("the band");
        let open_tag_end = start + document[start..].find('>').expect("band open tag") + 1;
        let close = open_tag_end + document[open_tag_end..].find("</div>").expect("band close");
        let inner = &document[open_tag_end..close];
        let text = mode_band_text(&document).expect("the band's stripped text");

        assert_eq!(
            text, DEVELOPMENT_BAND_SENTENCE,
            "the band's text must BE the bound sentence, verbatim"
        );
        // The sentence BEGINS with the painted token (position, not containment):
        // a band reading `Released; not Development` fails here.
        assert!(
            text.starts_with("Development"),
            "the token must be the band's LEADING phrase: {text}"
        );
        // The full contract surface the QA row reads.
        assert!(document.contains("role=\"note\""), "the band is an announcement");
        assert!(
            !document.contains("data-testid=\"installed-app-development-banner\" aria-hidden"),
            "the band is never aria-hidden — it is the point"
        );
        assert!(
            !document.contains("tabindex") || !inner.contains("tabindex"),
            "the band is not focusable: it is not a control"
        );
    }

    /// **INV-6 — a released build's served document is BYTE-IDENTICAL.**
    ///
    /// The control is the document the pre-#3241 renderer produced: the theme
    /// block + `PANEL_CSS` + the config block + the root region + the bootstrap
    /// script, with no band and no band stylesheet. Asserting the WHOLE string
    /// (not "no band node") is what makes this failable: an implementation that
    /// also changed the released path's stylesheet or ordering would pass a
    /// badge-free check and fail this.
    #[test]
    fn render_document_leaves_a_released_build_byte_identical() {
        let theme = fallback_theme();
        let config = band_config(InstalledAppMode::Released);
        let html = FULL_BLEED_BODY;

        let actual = render_document(html, &theme, &config, "index.html", true);

        // The pre-#3241 shape, assembled by hand from the same public pieces —
        // `body_lead` empty is the whole delta under test.
        let expected = inject_into_document(
            html,
            &format!("{}{}", theme_style_block(&theme), PANEL_CSS),
            &format!(
                "<script type=\"application/json\" id=\"{CONFIG_ELEMENT_ID}\">{}</script>",
                config_json(&config, &theme)
            ),
            "",
            &format!("<script src=\"/{BOOTSTRAP_PATH}\" type=\"text/javascript\"></script>"),
            "",
            "",
        );

        assert_eq!(
            actual, expected,
            "a released document must be byte-identical to the pre-#3241 render"
        );
        // Non-vacuity: the SAME inputs in the development mode DO differ, so the
        // equality above is a reading rather than an inert comparison.
        let development = render_document(
            html,
            &theme,
            &band_config(InstalledAppMode::Development),
            "index.html",
            true,
        );
        assert_ne!(
            development, actual,
            "the mode must be what selects the band, or the equality proves nothing"
        );
    }

    /// **The three-layer stack — `F-10.11`'s `PANEL_CSS` pin, R-3.2's failure
    /// clause.**
    ///
    /// App root `0` / panels `2` / band `3`. Asserted as three literals TOGETHER,
    /// so a reversed order reddens. The band must be ABOVE the panels: both panels
    /// paint an opaque `inset: 0` ground, so "the panel keeps winning" would make a
    /// development build that fails to load the one development build whose marking
    /// is invisible.
    #[test]
    fn the_band_stacks_above_the_failure_panel() {
        fn rule_body<'a>(css: &'a str, selector: &str) -> &'a str {
            let start = css.find(selector).unwrap_or_else(|| panic!("missing rule {selector}"));
            let open = start + css[start..].find('{').expect("rule opens") + 1;
            let close = open + css[open..].find('}').expect("rule closes");
            &css[open..close]
        }
        fn z_index(body: &str) -> i32 {
            let at = body.find("z-index:").expect("the rule declares a z-index");
            body[at + "z-index:".len()..]
                .split(';')
                .next()
                .expect("a value")
                .trim()
                .parse()
                .expect("an integer z-index")
        }

        let app_root = z_index(rule_body(MODE_BAND_CSS, "[data-testid=\"installed-app-root\"]"));
        let panel = z_index(rule_body(MODE_BAND_CSS, ".fredo-panel"));
        let band = z_index(rule_body(MODE_BAND_CSS, ".fredo-mode-band"));

        assert_eq!((app_root, panel, band), (0, 2, 3));
        assert!(band > panel, "the band must stack ABOVE the opaque failure panel");

        // The panels really are opaque full-viewport grounds, so the ordering above
        // is load-bearing rather than cosmetic. Read from the SHIPPED panel CSS.
        assert!(PANEL_CSS.contains(".fredo-panel { position: fixed; inset: 0;"));
        assert!(PANEL_CSS.contains("[data-testid=\"installed-app-loading\"] { background: var(--body-bg, Canvas); }"));
        assert!(PANEL_CSS.contains("[data-testid=\"installed-app-failure\"] {"));

        // The band is a FIXED band, never in-flow: a scrollable banner is not a
        // marking (the in-flow form's redden signature).
        let band_rule = rule_body(MODE_BAND_CSS, ".fredo-mode-band");
        assert!(band_rule.contains("position: fixed"));
        assert!(band_rule.contains("top: 0"));

        // And `PANEL_CSS` itself carries NO marking rule, so the released path is
        // untouched by the band's stylesheet (INV-6).
        assert!(!PANEL_CSS.contains("fredo-mode-band"));
        assert!(!PANEL_CSS.contains(DEVELOPMENT_BAND_TESTID));
    }

    /// The band is emitted on the **failure document** too — R-3.2's clause "a
    /// development build that cannot load is still visibly and audibly a
    /// development build".
    #[test]
    fn the_failure_document_of_a_development_build_carries_the_band() {
        let mut config = band_config(InstalledAppMode::Development);
        config.startup_failure = Some(InstalledAppRefusalCode::IntegrityMismatch.as_str());

        let document = render_failure_document(&fallback_theme(), &config);
        assert!(
            document.contains(DEVELOPMENT_BAND_TESTID),
            "the failure document must still say the build is a development build"
        );
        // The sentence is read TAG-STRIPPED: the `<strong>` emphasis splits the raw
        // markup, so a raw `contains` on the full sentence would fail a correct
        // build. The stripped text must BE the bound sentence.
        let band_text = mode_band_text(&document).expect("the band's text");
        assert_eq!(band_text, DEVELOPMENT_BAND_SENTENCE);
        // The band precedes the host's own panel markup too, since the panel is
        // mounted by the bootstrap at the body tail.
        let band_at = document.find(DEVELOPMENT_BAND_TESTID).expect("band");
        let lowered = document.to_ascii_lowercase();
        assert!(band_at > body_open_end(&lowered).expect("body tag"));
        assert!(band_at < document.find(&format!("id=\"{CONFIG_ELEMENT_ID}\"")).expect("config"));

        // The released control: the SAME failure document, unmarked.
        let released = render_failure_document(&fallback_theme(), &band_config(InstalledAppMode::Released));
        assert!(!released.contains(DEVELOPMENT_BAND_TESTID));
        assert!(!released.contains("Development"));
    }

    /// A document with NO `<body>` tag still gets the band, by the prepend path
    /// that mirrors the existing no-body fallback — and a `<body` whose tag never
    /// closes falls through to the same prepend rather than splicing at an
    /// arbitrary offset.
    #[test]
    fn the_band_lands_on_a_document_with_no_body_and_on_a_truncated_body_tag() {
        let development = band_config(InstalledAppMode::Development);

        let no_body = render_document(
            "<p>bare</p>",
            &fallback_theme(),
            &development,
            "index.html",
            false,
        );
        assert!(
            no_body.starts_with(&format!("<div data-testid=\"{DEVELOPMENT_BAND_TESTID}\"")),
            "with no <body> the band is prepended: {no_body}"
        );

        // A `<body` tag that never closes within the document.
        let truncated = "<html><head></head><body";
        let document = render_document(truncated, &fallback_theme(), &development, "index.html", false);
        assert!(
            document.starts_with(&format!("<div data-testid=\"{DEVELOPMENT_BAND_TESTID}\"")),
            "an unterminated <body tag falls through to the prepend branch, never an \
             out-of-range splice: {document}"
        );
    }

    #[test]
    fn an_unreadable_record_serves_nothing() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().to_path_buf();
        std::fs::create_dir_all(store::app_dir(&root, "qa3147-test")).expect("app dir");

        let response = serve_request(&root, "/qa3147-test/", &fallback_theme());
        assert_eq!(response.status, StatusCode::NOT_FOUND.as_u16());
        assert!(response.reason.is_none(), "a routing miss carries no refusal code");
    }

    #[test]
    fn the_serve_line_carries_the_fredoapp_url() {
        // The tracing line's shape is what the tester greps: the target, the
        // message, and the `fredoapp` URL field. Assert the API surface exists
        // and that the constant is the documented one (the emission itself needs
        // a subscriber and is exercised live).
        assert_eq!(TRACE_TARGET, "fredo::installed_apps");
        let response = ServedResponse::ok(JAVASCRIPT_CONTENT_TYPE, b"x".to_vec());
        serve_line(
            "http://fredoapp.localhost/qa3147-test/",
            &response,
            Some(InstalledAppMode::Released),
        );
    }

    // ── S5: the serve line's `mode` field (Spec #3241, R-3.5) ────────────────

    /// A minimal `tracing` layer capturing each event's target, message and
    /// `(field-name, rendered-value)` pairs, so the serve line's FIELD NAME and
    /// VALUE can be asserted without a subscriber in the process.
    #[derive(Clone, Default)]
    struct CaptureLayer {
        events: std::sync::Arc<std::sync::Mutex<Vec<(String, Vec<(String, String)>)>>>,
    }

    struct CaptureVisitor<'a>(&'a mut Vec<(String, String)>);

    impl tracing::field::Visit for CaptureVisitor<'_> {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            self.0.push((field.name().to_string(), format!("{value:?}")));
        }
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            self.0.push((field.name().to_string(), value.to_string()));
        }
    }

    impl<S> tracing_subscriber::Layer<S> for CaptureLayer
    where
        S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let mut fields = Vec::new();
            event.record(&mut CaptureVisitor(&mut fields));
            self.events
                .lock()
                .expect("capture mutex poisoned")
                .push((event.metadata().target().to_string(), fields));
        }
    }

    /// Emit the serve line for one response and return its `(name, value)` pairs
    /// at [`TRACE_TARGET`] — the S5 instrument, read rather than assumed.
    fn captured_serve_line_fields(response: &ServedResponse, mode: Option<InstalledAppMode>) -> Vec<(String, String)> {
        use tracing_subscriber::layer::SubscriberExt;

        let capture = CaptureLayer::default();
        let events = capture.events.clone();
        let _guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(capture));

        serve_line("http://fredoapp.localhost/qa3147-test/", response, mode);

        let events = events.lock().expect("capture mutex poisoned");
        let ours: Vec<&(String, Vec<(String, String)>)> = events
            .iter()
            .filter(|(target, _)| target == TRACE_TARGET)
            .collect();
        assert_eq!(ours.len(), 1, "exactly one serve line per request");
        // The message is the grep target the tester uses.
        let has_message = ours[0]
            .1
            .iter()
            .any(|(name, value)| name == "message" && value == "installed-app serve");
        assert!(has_message, "the serve line's message must be `installed-app serve`");
        ours[0].1.clone()
    }

    fn field_value(fields: &[(String, String)], name: &str) -> Option<String> {
        fields
            .iter()
            .find(|(field, _)| field == name)
            .map(|(_, value)| value.clone())
    }

    /// **R-3.5 / F-10.5.** Both match arms carry `mode`, with the mode's own wire
    /// value — and the field is present on the arms that have a reason and the
    /// ones that do not.
    #[test]
    fn the_serve_line_carries_the_install_mode() {
        for mode in InstalledAppMode::ALL {
            // The no-`reason` arm.
            let ok = ServedResponse::ok(HTML_CONTENT_TYPE, b"<html></html>".to_vec());
            let fields = captured_serve_line_fields(&ok, Some(mode));
            assert_eq!(
                field_value(&fields, "mode"),
                Some(mode.as_str().to_string()),
                "the success arm must carry mode={}",
                mode.as_str()
            );

            // The `reason` arm.
            let refused = ServedResponse::refused(
                InstalledAppRefusalCode::IntegrityMismatch.as_str(),
                "the file on disk does not match its recorded hash",
            );
            let fields = captured_serve_line_fields(&refused, Some(mode));
            assert_eq!(
                field_value(&fields, "mode"),
                Some(mode.as_str().to_string()),
                "the refusal arm must carry mode={}",
                mode.as_str()
            );
            // Non-vacuity: the refusal arm's own field survived beside it.
            assert_eq!(
                field_value(&fields, "reason"),
                Some("integrity_mismatch".to_string())
            );
        }

        // A request that names no installed application says so explicitly, so an
        // absent `mode` can never be read as `released`.
        let fields = captured_serve_line_fields(&ServedResponse::ok(HTML_CONTENT_TYPE, Vec::new()), None);
        assert_eq!(field_value(&fields, "mode"), Some("none".to_string()));
    }

    /// The traced mode is derived from the install directory, through the ONE
    /// presence check — the SAME fact the painted surfaces read.
    #[test]
    fn the_served_mode_comes_from_the_install_directory() {
        let (_released, released_root) = record_with(
            vec![("main.js", b"export function mount() {}")],
            "index.html",
        );
        assert_eq!(
            served_app_mode(&released_root, "/qa3147-test/"),
            Some(InstalledAppMode::Released),
            "an install with no marker is released on the trace line too"
        );

        // The development marker is the PRESENCE of the file — the same rule
        // `store::read_development_marker` applies for the documents.
        let app_dir = store::app_dir(&released_root, "qa3147-test");
        store::write_development_marker(&app_dir).expect("write marker");
        assert_eq!(
            served_app_mode(&released_root, "/qa3147-test/"),
            Some(InstalledAppMode::Development)
        );
        assert_eq!(
            served_app_mode(&released_root, "/qa3147-test/main.js"),
            Some(InstalledAppMode::Development),
            "EVERY request for the application carries the fact, not only the entry document"
        );

        // A path that names no installed application has no mode at all.
        assert_eq!(served_app_mode(&released_root, "/__fredo/bootstrap.js"), None);
        assert_eq!(served_app_mode(&released_root, "/../etc/passwd"), None);
    }

    #[test]
    fn a_tampered_entry_document_serves_the_host_failure_document_not_app_bytes() {
        let marker = "APP-BYTES-THAT-MUST-NOT-SHIP";
        let html = format!("<!doctype html><html><body><p>{marker}</p></body></html>");
        let (_record, root) = record_with(
            vec![("index.html", html.as_bytes()), ("main.js", b"export function mount() {}")],
            "index.html",
        );
        let app_dir = store::app_dir(&root, "qa3147-test");
        std::fs::write(app_dir.join(INSTALLED_FILES_SUBDIR).join("index.html"), b"tampered")
            .expect("tamper");

        let response = serve_request(&root, "/qa3147-test/", &fallback_theme());
        // The bootstrap must be able to RUN, so this is a 200 with a panel —
        // never an HTTP error page no script can decorate.
        assert_eq!(response.status, StatusCode::OK.as_u16());
        assert_eq!(
            response.reason,
            Some(InstalledAppRefusalCode::IntegrityMismatch.as_str()),
            "the serve line must name the reason"
        );

        let document = String::from_utf8(response.body).expect("utf8");
        assert!(
            !document.contains(marker),
            "not one byte of the mutated entry document may be served"
        );
        // The document is still a working host document: panel hooks present,
        // name carried, and the startupFailure reason reachable by the bootstrap.
        assert!(document.contains(BOOTSTRAP_PATH));
        assert!(document.contains("\"startupFailure\":\"integrity_mismatch\""));
        assert!(document.contains("QA3147 Test"));
    }

    #[test]
    fn a_tampered_entry_module_also_yields_the_integrity_failure_document() {
        // The document served for a tampered MODULE must already know the
        // reason: `import()` cannot expose a response header to the bootstrap,
        // so the code has to ride in the config block. This is what makes the
        // launcher/child surfaces report `integrity_mismatch` rather than a
        // generic load failure.
        let (_record, root) = record_with(
            vec![
                ("index.html", b"<html><body><p>APP-BYTES</p></body></html>"),
                ("main.js", b"export function mount() {}"),
            ],
            "index.html",
        );
        let app_dir = store::app_dir(&root, "qa3147-test");
        std::fs::write(app_dir.join(INSTALLED_FILES_SUBDIR).join("main.js"), b"export function mount() { evil(); }")
            .expect("tamper");

        let response = serve_request(&root, "/qa3147-test/", &fallback_theme());
        assert_eq!(response.status, StatusCode::OK.as_u16());
        assert_eq!(
            response.reason,
            Some(InstalledAppRefusalCode::IntegrityMismatch.as_str())
        );
        let document = String::from_utf8(response.body).expect("utf8");
        assert!(
            !document.contains("APP-BYTES"),
            "the untouched entry document is NOT served when a sibling file fails verification"
        );
        assert!(document.contains("\"startupFailure\":\"integrity_mismatch\""));
    }

    #[test]
    fn the_startup_failure_key_is_absent_on_a_normal_document() {
        let (_record, root) = record_with(
            vec![("index.html", b"<html><body>x</body></html>"), ("main.js", b"export function mount() {}")],
            "index.html",
        );
        let response = serve_request(&root, "/qa3147-test/", &fallback_theme());
        let document = String::from_utf8(response.body).expect("utf8");
        assert!(
            !document.contains("startupFailure"),
            "an unset optional is an ABSENT key, never an explicit null"
        );
        assert!(!document.contains("null"));
    }

    #[test]
    fn a_normal_document_never_carries_a_refusal_reason() {
        let (_record, root) = record_with(
            vec![("index.html", b"<html><body>x</body></html>"), ("main.js", b"export function mount() {}")],
            "index.html",
        );
        let response = serve_request(&root, "/qa3147-test/", &fallback_theme());
        assert!(is_success(&response));
        assert!(response.reason.is_none());

        // And the reason header is only on a refusal.
        let http = to_http_response(response);
        assert!(http.headers().get(REASON_HEADER).is_none());
        // Every response carries the child policy and nosniff.
        assert_eq!(
            http.headers()
                .get("Content-Security-Policy")
                .and_then(|value| value.to_str().ok()),
            Some(INSTALLED_APP_CSP)
        );
        assert_eq!(
            http.headers()
                .get("X-Content-Type-Options")
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            http.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-store"),
            "a re-verified document is never served from a cache"
        );
    }

    #[test]
    fn verify_install_accepts_a_clean_install_and_names_the_tampered_file() {
        let (record, root) = record_with(
            vec![("index.html", b"<html><body>x</body></html>"), ("main.js", b"export function mount() {}")],
            "index.html",
        );
        let app_dir = store::app_dir(&root, &record.id);
        assert!(verify_install(&app_dir).is_ok(), "an untouched install verifies");

        // The whole-record verifier ST-4 calls BEFORE creating a window.
        std::fs::write(app_dir.join(INSTALLED_FILES_SUBDIR).join("main.js"), b"mutated")
            .expect("tamper");
        let error = verify_install(&app_dir).expect_err("a mutated file must fail");
        assert_eq!(error.code, InstalledAppRefusalCode::IntegrityMismatch);
        assert!(error.detail.contains("main.js"), "the detail names the file");
    }

    #[test]
    fn verify_install_reports_a_damaged_record_as_integrity_record_corrupt() {
        let (record, root) = record_with(vec![("main.js", b"export function mount() {}")], "index.html");
        let app_dir = store::app_dir(&root, &record.id);
        std::fs::write(app_dir.join(super::super::INSTALLED_RECORD_FILENAME), b"{")
            .expect("truncate");
        let error = verify_install(&app_dir).expect_err("a damaged record is a refusal");
        assert_eq!(error.code, InstalledAppRefusalCode::IntegrityRecordCorrupt);
    }

    // ── The bootstrap's load-vs-start reason split ────────────────────────

    #[test]
    fn the_bootstrap_never_fetches_a_module_under_the_pinned_policy() {
        // `connect-src` in the pinned policy is `ipc: http://ipc.localhost`, so
        // a `fetch()` of an app file would be blocked by our OWN policy. The
        // load path must therefore be `import()` only (authorised by
        // `script-src 'self'`). This is a non-vacuity guard for that decision.
        assert!(!INSTALLED_APP_CSP.contains("connect-src 'self'"));
        assert!(INSTALLED_APP_CSP.contains("script-src 'self'"));
        assert!(
            !BOOTSTRAP_SCRIPT.contains("window\n    .fetch(") && !BOOTSTRAP_SCRIPT.contains(".fetch("),
            "the bootstrap must not fetch an app file: the pinned connect-src would block it"
        );
        assert!(
            BOOTSTRAP_SCRIPT.contains("import(moduleUrl)"),
            "the module is loaded through import()"
        );
    }
}
