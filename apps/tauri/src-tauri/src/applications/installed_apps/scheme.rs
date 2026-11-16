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
//! The handler owns four things, and only these:
//!
//! 1. **Routing** — the app's entry document, its files, and the one reserved
//!    host path (`__fredo/bootstrap.js`). Nothing outside `<id>/files/` is
//!    reachable; `record.json` and `manifest.json` live outside `files/` and
//!    have no route at all.
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

use super::store::{self, InstalledAppRecord, InstalledFileRecord};
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
) -> String {
    let lowered = html.to_ascii_lowercase();

    let style_markup = format!("<style id=\"__fredo-style\">{style}</style>");
    let head_insert = format!("{extra_head}{style_markup}");

    let mut output = String::with_capacity(html.len() + head_insert.len() + config_block.len() + root_markup.len() + script_markup.len() + 64);

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

    let tail = format!("{config_block}{root_markup}{script_markup}");
    let lowered = output.to_ascii_lowercase();
    if let Some(index) = lowered.rfind("</body>") {
        output.insert_str(index, &tail);
    } else {
        output.push_str(&tail);
    }

    output
}

/// Build the complete served document for one installed application.
pub fn render_document(
    html: &str,
    theme: &ThemePayload,
    config: &DocumentConfig,
    entry_document: &str,
    has_root: bool,
) -> String {
    let style = format!("{}{}", theme_style_block(theme), PANEL_CSS);
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

    inject_into_document(html, &style, &config_block, &root_markup, &script_markup, &extra_head)
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
    let base_config = || DocumentConfig {
        app_id: record.id.clone(),
        version: record.version.clone(),
        display_name: record
            .display_name
            .clone()
            .unwrap_or_else(|| record.id.clone()),
        module: format!("/{}/{}", record.id, record.entry_module),
        startup_failure: None,
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
pub fn serve_line(url: &str, response: &ServedResponse) {
    match response.reason {
        Some(reason) => tracing::info!(
            target: TRACE_TARGET,
            url = %url,
            status = response.status,
            reason = %reason,
            bytes = response.body.len(),
            "installed-app serve"
        ),
        None => tracing::info!(
            target: TRACE_TARGET,
            url = %url,
            status = response.status,
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

    let Some(data_dir) = app_data_dir(app) else {
        let response = ServedResponse::not_found("this build cannot resolve its app data directory");
        serve_line(&url, &response);
        return to_http_response(response);
    };

    let install_root = store::install_root(&data_dir);
    let theme = InstalledThemeState::read();
    let response = serve_request(&install_root, &path, &theme);
    serve_line(&url, &response);
    to_http_response(response)
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
        assert_eq!(route("/__fredo/bootstrap.js"), Ok(Route::Bootstrap));
        assert_eq!(route("__fredo/bootstrap.js"), Ok(Route::Bootstrap));

        for reserved in ["/__fredo/other.js", "/__fredo/", "/__fredo"] {
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
        serve_line("http://fredoapp.localhost/qa3147-test/", &response);
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
