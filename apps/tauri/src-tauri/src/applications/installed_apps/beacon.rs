//! Spec #3244 ST-7 — the installed-webview outline uplink ("beacon").
//!
//! # The problem this module solves
//!
//! An installed application renders in a **separate `fredoapp://` webview** the
//! host does not own and the main webview cannot read. The companion still needs
//! that app's screen outline on every turn, and the ONE host→child script channel
//! is `Webview::eval` (fire-and-forget — `theme_push.rs`), which has **no return
//! path**. A host-owned reply *command* is forbidden: the installed tier's ACL
//! surface is pinned to exactly one command (`allow-installed-app-invoke`,
//! `runtime/capability_guard.rs`).
//!
//! The missing **child→host result channel is not a command** — it is the host's
//! **own `fredoapp` scheme handler**. The host `eval`s a reporter (built exactly
//! like [`super::theme_push::apply_theme_statement`]: data serialized into a JS
//! string position, never concatenated into source) into the target
//! `installed-<id>` window; the reporter projects the live DOM with the shared
//! projector and loads a **same-origin sub-resource**,
//! `new Image().src = "/__fredo/beacon?nonce=<n>&d=<base64(json)>"`; the handler
//! ([`super::scheme`], `Route::Beacon`) observes that request and decodes it.
//!
//! This mechanism was **approved by the human (Option A, 2026-11-26)** after a
//! four-option review — `"human selected Option A on 2026-11-26 after reviewing
//! the four-option table."` There is **no new command and no new capability**;
//! nothing under `capabilities/`, `permissions/`, or `runtime/capability_guard.rs`
//! changes.
//!
//! # The ingress is UNTRUSTED input (the human's second condition)
//!
//! A sandboxed document can push bytes at the host, so the ingress is defensive
//! at every step and **fails typed and loud**, never silently:
//!
//! | Bound | Constant | Behaviour on breach |
//! |---|---|---|
//! | Payload size | [`BEACON_MAX_BYTES`] | refused (`oversize`) — never buffered unbounded |
//! | Nonce gate | [`open_nonce`] / single-use | a missing/unknown/replayed nonce is dropped (`missing-nonce` / `unknown-nonce`) |
//! | Nonce TTL | [`BEACON_NONCE_TTL_MS`] | a stale nonce is dropped (`expired`) |
//! | Correlation timeout | [`BEACON_TIMEOUT_MS`] | [`request_outline`] abandons the wait (`timeout`) and frees the buffer |
//! | Outstanding set | [`BEACON_NONCE_STORE_CAP`] | oldest-first eviction, so the store is bounded |
//!
//! Every attempt — accepted OR rejected — emits ONE [`BEACON_INGRESS_SPAN_NAME`]
//! span into `telemetry_spans` (the QA's ING-1 receipt; a `telemetry_logs` line
//! is NOT an accepted live receipt — M9).
//!
//! # Chunking seam (the human's first condition — the live gate)
//!
//! The two load-bearing platform assumptions (a same-origin sub-resource load is
//! delivered to the handler WITH the query intact; a ~11 KB URL is accepted) are
//! discharged **live** by the tester. If the platform needs chunking,
//! [`BEACON_CHUNK_MAX_BYTES`] is the declared per-load bound and
//! [`BeaconOutcome::ChunkIncomplete`] is the typed "a chunked beacon never
//! completed" outcome — so a length failure is a small change, not a redesign.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::telemetry::TelemetrySpan;

use super::scheme::{self, ServedResponse};
use super::window;
use super::InstalledAppError;

/// The reserved host path the beacon is delivered to (a same-origin sub-resource
/// load; never an app file — `__fredo/` is host-owned).
pub const BEACON_PATH: &str = "/__fredo/beacon";

/// The reserved path SEGMENT the beacon lives under (mirrors
/// [`super::RESERVED_PATH_SEGMENT`]).
pub const BEACON_SEGMENT: &str = "__fredo";

/// The final path segment of the beacon route (`beacon`, as `bootstrap.js` is
/// `bootstrap.js`).
pub const BEACON_RELATIVE: &str = "beacon";

/// The decoded-payload size bound, in bytes. A payload over the bound is refused
/// (`oversize`) — the host never buffers an unbounded body (human condition 2).
pub const BEACON_MAX_BYTES: usize = 16 * 1024;

/// The per-turn correlation timeout (eval → beacon), in milliseconds. Also the
/// nonce's time-to-live: a nonce is valid ONLY inside its correlation window.
pub const BEACON_TIMEOUT_MS: u64 = 2_000;

/// The nonce's time-to-live — the same window as the correlation timeout, so a
/// nonce that arrives after [`request_outline`] has abandoned the wait is
/// `expired`, not silently accepted.
pub const BEACON_NONCE_TTL_MS: u64 = BEACON_TIMEOUT_MS;

/// The cap on outstanding (issued, unconsumed) nonces. Oldest-first eviction keeps
/// the store bounded.
pub const BEACON_NONCE_STORE_CAP: usize = 64;

/// The per-load bound a CHUNKED beacon would use (the chunking seam — declared so
/// a live length failure is a small change, not a redesign).
pub const BEACON_CHUNK_MAX_BYTES: usize = 4 * 1024;

/// The node cap the reporter is told to enforce — the installed-tier mirror of
/// ST-4's `SCREEN_OUTLINE_MAX_NODES` (`screenOutline.ts`). Bound by the carrier
/// contract pin so the two projectors cannot drift.
pub const BEACON_MAX_NODES: usize = 120;

/// The `telemetry_spans` name the QA reads the ingress receipt back by (ING-1).
pub const BEACON_INGRESS_SPAN_NAME: &str = "installed.beacon.ingress";

/// The provider/transport labels on the ingress span (host-local, in-process).
const BEACON_PROVIDER: &str = "fredo";
const BEACON_TRANSPORT: &str = "in_process";

/// The frontend→host request event (no command: the event channel is granted to
/// the built-in windows already — `core:event:allow-emit`).
pub const BEACON_REQUEST_EVENT: &str = "fredo:installed-outline:request";
/// The host→frontend correlated reply event.
pub const BEACON_REPLY_EVENT: &str = "fredo:installed-outline:reply";

/// The reporter function the eval statement calls (defined in `bootstrap.js`).
pub const REPORT_FUNCTION: &str = "__FREDO_REPORT_OUTLINE__";

/// The projector global the eval statement defines (the installed-tier carrier).
pub const PROJECTOR_GLOBAL: &str = "__FREDO_SIMPLIFY_DOM__";

/// The installed-tier projector source, embedded at compile time and shipped
/// INSIDE the eval statement. Host-authored, so its bytes are trusted by
/// construction (like [`super::scheme::BOOTSTRAP_SCRIPT`]).
pub const OUTLINE_PROJECTOR_SOURCE: &str = include_str!("outline_projector.js");

/// A 1×1 transparent GIF — the tiny image the ingress answers a beacon with, so
/// the child's `new Image()` load completes instead of erroring.
const BEACON_GIF: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xFF, 0xFF, 0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3B,
];

/// The ingestion outcome of one beacon request — the typed, non-silent result the
/// ingress span carries. `reason()` is the exact string the QA reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeaconOutcome {
    /// A valid, unexpired, single-use nonce carried a bounded, well-formed outline.
    Accepted { bytes: usize, nodes: usize },
    /// The payload exceeded [`BEACON_MAX_BYTES`].
    Oversize { bytes: usize },
    /// No `nonce` query parameter was present.
    MissingNonce,
    /// The nonce was never issued, or has already been consumed (single-use).
    UnknownNonce,
    /// The nonce was past its TTL ([`BEACON_NONCE_TTL_MS`]).
    Expired,
    /// The payload was absent, undecodable, or not an outline shape.
    Malformed,
    /// A chunked beacon was seen but never completed (the chunking seam).
    ChunkIncomplete,
}

impl BeaconOutcome {
    /// The named reason the QA reads off the ingress span. `"accepted"` on success.
    pub fn reason(&self) -> &'static str {
        match self {
            BeaconOutcome::Accepted { .. } => "accepted",
            BeaconOutcome::Oversize { .. } => "oversize",
            BeaconOutcome::MissingNonce => "missing-nonce",
            BeaconOutcome::UnknownNonce => "unknown-nonce",
            BeaconOutcome::Expired => "expired",
            BeaconOutcome::Malformed => "malformed",
            BeaconOutcome::ChunkIncomplete => "chunk-incomplete",
        }
    }

    /// Was the payload accepted?
    pub fn accepted(&self) -> bool {
        matches!(self, BeaconOutcome::Accepted { .. })
    }
}

/// Why a turn's installed-app outline could not be correlated. Typed so the
/// caller surfaces a non-silent failure (R-2c/R-2d), never a blind turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeaconFailure {
    /// The application is not open — there is no document to ask.
    NotOpen,
    /// The reporter was `eval`ed but no beacon arrived inside the timeout.
    Timeout,
    /// The `eval` into the window failed (the document is closing/gone).
    EvalFailed(String),
    /// The application id was malformed or named a built-in.
    InvalidApp(String),
}

impl BeaconFailure {
    /// The named reason the caller surfaces (and the ingress span records).
    pub fn reason(&self) -> &'static str {
        match self {
            BeaconFailure::NotOpen => "not-open",
            BeaconFailure::Timeout => "timeout",
            BeaconFailure::EvalFailed(_) => "eval-failed",
            BeaconFailure::InvalidApp(_) => "invalid-app",
        }
    }
}

// ---------------------------------------------------------------------------
// The nonce store (bounded, single-use, oldest-first)
// ---------------------------------------------------------------------------

struct NonceEntry {
    nonce: String,
    created: Instant,
    /// The validated outline JSON, once a beacon delivered it.
    delivered: Option<String>,
    /// A nonce is single-use: once it has carried a beacon it can never again.
    consumed: bool,
}

fn store() -> &'static Mutex<VecDeque<NonceEntry>> {
    static STORE: OnceLock<Mutex<VecDeque<NonceEntry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// Mint and register a fresh single-use nonce for one correlation window.
///
/// Expired entries are purged first, then the oldest entry is evicted while the
/// store is at its cap — so the outstanding set stays bounded
/// ([`BEACON_NONCE_STORE_CAP`], oldest-first).
pub fn open_nonce() -> String {
    open_nonce_at(Instant::now())
}

/// [`open_nonce`] with an explicit clock, so bounding/eviction is unit-pinned.
pub fn open_nonce_at(now: Instant) -> String {
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut guard = store().lock().expect("the beacon nonce store is never poisoned");
    let ttl = Duration::from_millis(BEACON_NONCE_TTL_MS);
    guard.retain(|entry| now.saturating_duration_since(entry.created) <= ttl);
    while guard.len() >= BEACON_NONCE_STORE_CAP {
        guard.pop_front();
    }
    guard.push_back(NonceEntry {
        nonce: nonce.clone(),
        created: now,
        delivered: None,
        consumed: false,
    });
    nonce
}

/// The current number of outstanding nonces (test/observability helper).
pub fn outstanding_nonces() -> usize {
    store().lock().expect("not poisoned").len()
}

/// Drop a nonce once the correlation window closes ([`request_outline`] on
/// timeout), so an abandoned wait leaves no residue.
fn close_nonce(nonce: &str) {
    let mut guard = store().lock().expect("not poisoned");
    guard.retain(|entry| entry.nonce != nonce);
}

/// Take the outline a beacon delivered for `nonce`, once.
fn take_outline(nonce: &str) -> Option<String> {
    let mut guard = store().lock().expect("not poisoned");
    let entry = guard.iter_mut().find(|entry| entry.nonce == nonce)?;
    entry.delivered.take()
}

// ---------------------------------------------------------------------------
// Query parsing + ingestion (pure apart from the nonce store, so unit-testable)
// ---------------------------------------------------------------------------

/// Split a raw query string into decoded `(key, value)` pairs.
///
/// A pair without `=` is a key with an empty value; a malformed percent escape
/// yields `None` for that value (the caller treats it as malformed). Deliberately
/// minimal: the beacon's query has exactly two keys and no `+`-as-space rule
/// (the reporter uses `encodeURIComponent`, which encodes `+` as `%2B`).
fn parse_query(query: &str) -> Vec<(String, Option<String>)> {
    let mut pairs = Vec::new();
    for part in query.split('&') {
        if part.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = match part.split_once('=') {
            Some((key, value)) => (key, Some(value)),
            None => (part, None),
        };
        let key = scheme::percent_decode(raw_key);
        let value = raw_value.and_then(scheme::percent_decode);
        if let Some(key) = key {
            pairs.push((key, value));
        }
    }
    pairs
}

/// The `nonce`/`d` pair a beacon query carries.
fn extract_beacon_params(query: &str) -> (Option<String>, Option<Option<String>>) {
    let mut nonce = None;
    let mut data = None;
    for (key, value) in parse_query(query) {
        match key.as_str() {
            "nonce" => nonce = value,
            "d" => data = Some(value),
            _ => {}
        }
    }
    (nonce, data)
}

/// Validate that a decoded payload is a `ScreenOutline` (`{ nodes, truncated }`).
fn outline_node_count(value: &serde_json::Value) -> Option<usize> {
    let object = value.as_object()?;
    let nodes = object.get("nodes")?.as_array()?;
    // `truncated` must be present and boolean (the carrier's exact shape).
    if !object.get("truncated").map(|v| v.is_boolean()).unwrap_or(false) {
        return None;
    }
    Some(nodes.len())
}

/// Ingest one beacon request: parse, size-bound, nonce-gate, decode, store.
///
/// Pure apart from the process-wide nonce store, so every outcome is unit-pinned.
/// The returned [`BeaconOutcome`] is exactly what the ingress span records.
pub fn ingest(query: Option<&str>, now: Instant) -> BeaconOutcome {
    let Some(query) = query else {
        return BeaconOutcome::MissingNonce;
    };
    let (nonce, data) = extract_beacon_params(query);
    let Some(nonce) = nonce else {
        return BeaconOutcome::MissingNonce;
    };
    // Base64 expands 3→4, so a payload within the cap is at most ~1.34×; a cap of
    // 2× bounds the raw query string BEFORE any decoding (no unbounded buffering).
    let Some(Some(raw)) = data else {
        return BeaconOutcome::Malformed;
    };
    if raw.len() > BEACON_MAX_BYTES * 2 {
        return BeaconOutcome::Oversize { bytes: raw.len() };
    }

    // Decode the base64 payload the reporter put in the query.
    let decoded = match base64_decode(&raw) {
        Some(decoded) => decoded,
        None => return BeaconOutcome::Malformed,
    };
    if decoded.len() > BEACON_MAX_BYTES {
        return BeaconOutcome::Oversize { bytes: decoded.len() };
    }
    let text = match String::from_utf8(decoded) {
        Ok(text) => text,
        Err(_) => return BeaconOutcome::Malformed,
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return BeaconOutcome::Malformed,
    };
    let Some(nodes) = outline_node_count(&value) else {
        return BeaconOutcome::Malformed;
    };

    ingest_nonce(&nonce, text, nodes, now)
}

/// The nonce half of ingestion: accept exactly once, inside the TTL.
fn ingest_nonce(nonce: &str, outline: String, nodes: usize, now: Instant) -> BeaconOutcome {
    let ttl = Duration::from_millis(BEACON_NONCE_TTL_MS);
    let mut guard = store().lock().expect("not poisoned");
    let Some(entry) = guard.iter_mut().find(|entry| entry.nonce == nonce) else {
        return BeaconOutcome::UnknownNonce;
    };
    if entry.consumed {
        // Single-use: a replay is not a serve.
        return BeaconOutcome::UnknownNonce;
    }
    if now.saturating_duration_since(entry.created) > ttl {
        return BeaconOutcome::Expired;
    }
    let bytes = outline.len();
    entry.delivered = Some(outline);
    entry.consumed = true;
    BeaconOutcome::Accepted { bytes, nodes }
}

/// Standard-alphabet base64 decode (`+`, `/`, `=`), tolerating absent padding.
fn base64_decode(value: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
    use base64::Engine as _;
    STANDARD
        .decode(value)
        .or_else(|_| STANDARD_NO_PAD.decode(value.trim_end_matches('=')))
        .ok()
}

// ---------------------------------------------------------------------------
// The eval statement (built exactly like `theme_push`'s: data at a string position)
// ---------------------------------------------------------------------------

/// Build the reporter statement the host `eval`s into one `installed-*` window.
///
/// The SHARED projector source is shipped INSIDE the statement (so the installed
/// tier runs the same algorithm as the main webview), and the nonce is
/// **serialized into a JS string position** — never concatenated raw into source —
/// exactly as [`super::theme_push::apply_theme_statement`] does.
pub fn report_statement(nonce: &str) -> Result<String, InstalledAppError> {
    let json = serde_json::to_string(nonce).map_err(|error| {
        InstalledAppError::new(
            super::InstalledAppRefusalCode::IoError,
            format!("the beacon nonce could not be serialized: {error}"),
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
        "{OUTLINE_PROJECTOR_SOURCE}\n;window.{REPORT_FUNCTION}({literal}, {BEACON_MAX_NODES});"
    ))
}

// ---------------------------------------------------------------------------
// The ingress receipt (the QA's ING-1 span)
// ---------------------------------------------------------------------------

/// The facts one ingress attempt records. Derived from the attempt itself — never
/// hand-authored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeaconIngressSpan {
    /// The typed outcome reason (`accepted` / `oversize` / `unknown-nonce` /
    /// `expired` / `timeout` / `missing-nonce` / `malformed` / `chunk-incomplete`).
    pub reason: String,
    /// Was the beacon accepted?
    pub accepted: bool,
    /// The payload byte size seen at the ingress (`0` when no payload arrived).
    pub payload_bytes: i64,
    /// The nonce's age in milliseconds at ingestion (`-1` when unknown).
    pub nonce_age_ms: i64,
    /// The target application id, when the attempt knows it (the timeout/eval leg
    /// does; a raw ingress request does not).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
}

fn now_ns() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as i64
}

/// Build the `telemetry_spans` row for one ingress attempt. Pure, so the row shape
/// is pinnable without a store.
pub fn ingress_span_record(facts: &BeaconIngressSpan) -> TelemetrySpan {
    let start = now_ns();
    TelemetrySpan {
        trace_id: uuid::Uuid::new_v4().to_string(),
        span_id: uuid::Uuid::new_v4().to_string(),
        parent_span_id: None,
        span_name: BEACON_INGRESS_SPAN_NAME.to_string(),
        span_kind: "INTERNAL".to_string(),
        start_time_ns: start,
        end_time_ns: Some(start),
        status_code: if facts.accepted { "OK" } else { "ERROR" }.to_string(),
        status_message: if facts.accepted {
            None
        } else {
            Some(facts.reason.clone())
        },
        session_id: facts.app_id.clone().unwrap_or_default(),
        attributes_json: serde_json::to_string(facts).ok(),
        events_json: None,
        provider: Some(BEACON_PROVIDER.to_string()),
        transport: Some(BEACON_TRANSPORT.to_string()),
        event_type: Some(BEACON_INGRESS_SPAN_NAME.to_string()),
        ingested_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Record an ingress receipt into `telemetry_spans` (best-effort, off the IPC
/// thread). A missing store or a failed insert is logged, never fatal.
pub fn record_ingress(app: &AppHandle, facts: BeaconIngressSpan) {
    let Some(store) = app.try_state::<std::sync::Arc<SpanStore>>() else {
        tracing::warn!(
            target: scheme::TRACE_TARGET,
            reason = %facts.reason,
            "beacon ingress span not recorded: the span store is not managed"
        );
        return;
    };
    let record = ingress_span_record(&facts);
    let store = std::sync::Arc::clone(store.inner());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = store.insert_spans(&[record]).await {
            tracing::warn!(
                target: scheme::TRACE_TARGET,
                error = %error,
                "the beacon ingress span could not be inserted"
            );
        }
    });
}

/// Map an outcome onto the ingress facts (the span shape).
pub fn outcome_facts(outcome: &BeaconOutcome, nonce_age_ms: i64) -> BeaconIngressSpan {
    let payload_bytes = match outcome {
        BeaconOutcome::Accepted { bytes, .. } => *bytes as i64,
        BeaconOutcome::Oversize { bytes } => *bytes as i64,
        _ => 0,
    };
    BeaconIngressSpan {
        reason: outcome.reason().to_string(),
        accepted: outcome.accepted(),
        payload_bytes,
        nonce_age_ms,
        app_id: None,
    }
}

// ---------------------------------------------------------------------------
// The serve arm (called by the scheme handler)
// ---------------------------------------------------------------------------

/// Handle one `/__fredo/beacon` request: ingest, record the receipt, answer.
///
/// The response is a tiny opaque image so the child's `new Image()` load
/// completes; the interesting output is the stored outline + the ingress span.
pub fn serve_beacon(app: &AppHandle, query: Option<&str>) -> ServedResponse {
    let now = Instant::now();
    let nonce_age_ms = nonce_age(query, now);
    let outcome = ingest(query, now);
    record_ingress(app, outcome_facts(&outcome, nonce_age_ms));

    ServedResponse {
        status: 200,
        content_type: "image/gif",
        body: BEACON_GIF.to_vec(),
        reason: None,
    }
}

/// The age (ms) of the query's nonce, or `-1` when it was never issued.
fn nonce_age(query: Option<&str>, now: Instant) -> i64 {
    let Some(query) = query else {
        return -1;
    };
    let (nonce, _) = extract_beacon_params(query);
    let Some(nonce) = nonce else {
        return -1;
    };
    let guard = store().lock().expect("not poisoned");
    match guard.iter().find(|entry| entry.nonce == nonce) {
        Some(entry) => now.saturating_duration_since(entry.created).as_millis() as i64,
        None => -1,
    }
}

// ---------------------------------------------------------------------------
// The correlation seam (host → child eval, then wait for the beacon)
// ---------------------------------------------------------------------------

/// Ask one open installed application for its current outline via the beacon.
///
/// Mints a single-use nonce, `eval`s the reporter into the `installed-<id>`
/// window, and waits up to the timeout for the same-origin sub-resource load to
/// reach the handler. On timeout it abandons the wait, frees the buffer and
/// records a `timeout` ingress receipt. Every failure is [`BeaconFailure`] — a
/// typed, non-silent result the caller surfaces (never a blind turn).
pub fn request_outline(
    app: &AppHandle,
    app_id: &str,
    timeout: Duration,
) -> Result<serde_json::Value, BeaconFailure> {
    let id = window::normalize_app_id(app_id)
        .map_err(|error| BeaconFailure::InvalidApp(error.detail))?;
    let label = window::installed_app_window_label(&id);
    let Some(webview) = app.get_webview_window(&label) else {
        return Err(BeaconFailure::NotOpen);
    };

    let nonce = open_nonce();
    let statement = report_statement(&nonce)
        .map_err(|error| BeaconFailure::EvalFailed(error.detail))?;
    if let Err(error) = webview.eval(&statement) {
        close_nonce(&nonce);
        return Err(BeaconFailure::EvalFailed(error.to_string()));
    }

    let deadline = Instant::now() + timeout;
    loop {
        if let Some(outline) = take_outline(&nonce) {
            close_nonce(&nonce);
            return serde_json::from_str(&outline).map_err(|_| BeaconFailure::Timeout);
        }
        if Instant::now() >= deadline {
            close_nonce(&nonce);
            record_ingress(
                app,
                BeaconIngressSpan {
                    reason: "timeout".to_string(),
                    accepted: false,
                    payload_bytes: 0,
                    nonce_age_ms: timeout.as_millis() as i64,
                    app_id: Some(id.clone()),
                },
            );
            return Err(BeaconFailure::Timeout);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

// ---------------------------------------------------------------------------
// The frontend event round-trip (no command: the event channel is already granted)
// ---------------------------------------------------------------------------

/// The request payload the frontend emits.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlineRequest {
    request_id: String,
    app_id: String,
}

/// The correlated reply the host emits back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutlineReply {
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    outline: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// Install the frontend's outline-request listener.
///
/// A companion turn that targets an installed application needs that app's screen
/// outline, and there is **no command** for it (the host's own scheme handler is
/// the transport). The frontend therefore emits a request event — already granted
/// to the built-in windows (`core:event:allow-emit`) — and this listener answers
/// with the correlated reply. Registering a listener performs no installed-app
/// work (no window is built, no install directory is read).
pub fn install_beacon_listener(app: &AppHandle) {
    let handle = app.clone();
    app.listen(BEACON_REQUEST_EVENT, move |event| {
        let Ok(request) = serde_json::from_str::<OutlineRequest>(event.payload()) else {
            return;
        };
        let handle = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let reply = match request_outline(
                &handle,
                &request.app_id,
                Duration::from_millis(BEACON_TIMEOUT_MS),
            ) {
                Ok(outline) => OutlineReply {
                    request_id: request.request_id.clone(),
                    ok: true,
                    outline: Some(outline),
                    reason: None,
                },
                Err(failure) => OutlineReply {
                    request_id: request.request_id.clone(),
                    ok: false,
                    outline: None,
                    reason: Some(failure.reason().to_string()),
                },
            };
            let _ = handle.emit(BEACON_REPLY_EVENT, reply);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The nonce store is PROCESS-GLOBAL (one store per app — the scheme handler
    /// has no other place to keep it), so the tests that exercise it must not
    /// interleave, and each must start from a known-empty store.
    fn locked_store() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let guard = LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        store().lock().expect("not poisoned").clear();
        guard
    }

    fn encode(payload: &str) -> String {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        STANDARD.encode(payload.as_bytes())
    }

    fn outline_json(nodes: usize) -> String {
        let nodes: Vec<serde_json::Value> = (0..nodes)
            .map(|index| {
                serde_json::json!({
                    "role": "button",
                    "name": format!("button {index}"),
                    "tag": "button",
                    "bbox": [0, 0, 10, 10]
                })
            })
            .collect();
        serde_json::to_string(&serde_json::json!({ "nodes": nodes, "truncated": false }))
            .expect("serialize")
    }

    // ── 1. The route ────────────────────────────────────────────────────────

    #[test]
    fn the_beacon_path_is_the_reserved_host_path() {
        assert_eq!(BEACON_PATH, "/__fredo/beacon");
        assert_eq!(BEACON_SEGMENT, "__fredo");
        assert_eq!(BEACON_RELATIVE, "beacon");
        assert!(BEACON_PATH.starts_with('/'));
        assert!(BEACON_PATH.ends_with(BEACON_RELATIVE));
    }

    // ── 2. Nonce acceptance / rejection (single-use, bounded, TTL) ───────────

    #[test]
    fn a_valid_unexpired_nonce_accepts_exactly_once() {
        let _guard = locked_store();
        let now = Instant::now();
        let nonce = open_nonce_at(now);
        let query = format!("nonce={nonce}&d={}", encode(&outline_json(3)));

        let first = ingest(Some(&query), now);
        assert_eq!(first, BeaconOutcome::Accepted { bytes: outline_json(3).len(), nodes: 3 });

        // Single-use: the SAME nonce never serves twice.
        let second = ingest(Some(&query), now);
        assert_eq!(second, BeaconOutcome::UnknownNonce);
        close_nonce(&nonce);
    }

    #[test]
    fn an_unknown_nonce_is_dropped() {
        let _guard = locked_store();
        let now = Instant::now();
        let query = format!("nonce=nope-not-issued&d={}", encode(&outline_json(1)));
        assert_eq!(ingest(Some(&query), now), BeaconOutcome::UnknownNonce);
    }

    #[test]
    fn an_expired_nonce_is_dropped() {
        let _guard = locked_store();
        let issued = Instant::now();
        let nonce = open_nonce_at(issued);
        let later = issued + Duration::from_millis(BEACON_NONCE_TTL_MS + 1);
        let query = format!("nonce={nonce}&d={}", encode(&outline_json(1)));
        assert_eq!(ingest(Some(&query), later), BeaconOutcome::Expired);
        close_nonce(&nonce);
    }

    #[test]
    fn a_beacon_with_no_nonce_is_dropped() {
        let _guard = locked_store();
        let now = Instant::now();
        assert_eq!(ingest(None, now), BeaconOutcome::MissingNonce);
        let query = format!("d={}", encode(&outline_json(1)));
        assert_eq!(ingest(Some(&query), now), BeaconOutcome::MissingNonce);
    }

    #[test]
    fn an_oversize_payload_is_refused_never_buffered() {
        let _guard = locked_store();
        let now = Instant::now();
        let nonce = open_nonce_at(now);
        let huge = "A".repeat(BEACON_MAX_BYTES * 2 + 1);
        let query = format!("nonce={nonce}&d={huge}");
        match ingest(Some(&query), now) {
            BeaconOutcome::Oversize { bytes } => assert!(bytes > BEACON_MAX_BYTES),
            other => panic!("an oversize payload must be refused, got {other:?}"),
        }
        // The nonce was NOT consumed by the refused payload.
        let good = format!("nonce={nonce}&d={}", encode(&outline_json(1)));
        assert!(ingest(Some(&good), now).accepted());
        close_nonce(&nonce);
    }

    #[test]
    fn the_store_evicts_oldest_first_and_stays_bounded() {
        let _guard = locked_store();
        let now = Instant::now();
        let mut all = Vec::new();
        for _ in 0..(BEACON_NONCE_STORE_CAP + 5) {
            all.push(open_nonce_at(now));
        }
        assert_eq!(outstanding_nonces(), BEACON_NONCE_STORE_CAP);
        // The five oldest are gone; the newest survive.
        for evicted in &all[..5] {
            let query = format!("nonce={evicted}&d={}", encode(&outline_json(1)));
            assert_eq!(ingest(Some(&query), now), BeaconOutcome::UnknownNonce);
        }
        for survivor in &all[5..] {
            let query = format!("nonce={survivor}&d={}", encode(&outline_json(1)));
            assert!(ingest(Some(&query), now).accepted(), "{survivor} must survive");
        }
    }

    // ── 3. Shape validation + query decoding ─────────────────────────────────

    #[test]
    fn a_malformed_payload_is_refused() {
        let _guard = locked_store();
        let now = Instant::now();
        let nonce = open_nonce_at(now);
        for bad in ["not-base64!!", &encode("not json"), &encode("[1,2,3]"), &encode("{\"nodes\":[]}")] {
            let query = format!("nonce={nonce}&d={}", bad.replace('+', "%2B").replace('/', "%2F"));
            let outcome = ingest(Some(&query), now);
            assert!(
                matches!(outcome, BeaconOutcome::Malformed | BeaconOutcome::Oversize { .. }),
                "{bad:?} must be refused, got {outcome:?}"
            );
        }
        close_nonce(&nonce);
    }

    #[test]
    fn a_percent_encoded_payload_round_trips() {
        let _guard = locked_store();
        let now = Instant::now();
        let nonce = open_nonce_at(now);
        let json = outline_json(2);
        // The reporter's `encodeURIComponent(base64)` form.
        let b64 = encode(&json);
        let encoded: String = b64
            .chars()
            .map(|c| match c {
                '+' => "%2B".to_string(),
                '/' => "%2F".to_string(),
                '=' => "%3D".to_string(),
                other => other.to_string(),
            })
            .collect();
        let query = format!("nonce={nonce}&d={encoded}");
        assert!(ingest(Some(&query), now).accepted(), "a url-encoded payload must arrive intact");
        close_nonce(&nonce);
    }

    // ── 4. The statement + the projector carrier ─────────────────────────────

    #[test]
    fn the_report_statement_ships_the_projector_and_a_json_literal_nonce() {
        let statement = report_statement("abc-123").expect("statement");
        // The projector is shipped INSIDE the statement (one algorithm, two carriers).
        assert!(statement.contains(PROJECTOR_GLOBAL));
        assert!(statement.contains("simplifyDom"));
        // The reporter in bootstrap.js is invoked with a single-quoted JSON literal.
        let call = ["window.", REPORT_FUNCTION, "("].concat();
        assert!(statement.contains(&call));
        let open = statement.find(&call).expect("call") + call.len();
        assert_eq!(statement.as_bytes()[open], b'\'', "the nonce is a string literal");
        let mut tail = format!(", {BEACON_MAX_NODES}");
        tail.push(')');
        assert!(statement.contains(&tail));
    }

    /// The installed-tier carrier and the main-webview projector are the SAME
    /// algorithm: a drift in the caps, the name precedence, or the tag sets
    /// reddens this pin. Both sources are read at compile time.
    #[test]
    fn the_installed_carrier_and_the_main_webview_projector_agree() {
        let main_webview =
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../ui/src/shared/app-intelligibility/screenOutline.ts"));

        // The caps.
        assert!(main_webview.contains("SCREEN_OUTLINE_MAX_NODES = 120"));
        assert_eq!(BEACON_MAX_NODES, 120, "the installed carrier's node cap must match");
        assert!(main_webview.contains("SCREEN_OUTLINE_MAX_NAME_CHARS = 120"));
        assert!(OUTLINE_PROJECTOR_SOURCE.contains("MAX_NAME_CHARS = 120"));

        // The name precedence, in order.
        let precedence = ["aria-label", "alt", "title", "placeholder"];
        let main_positions: Vec<usize> = precedence
            .iter()
            .map(|key| main_webview.find(&format!("attribute('{key}')")).expect("main precedence"))
            .collect();
        assert!(main_positions.windows(2).all(|pair| pair[0] < pair[1]));
        let source_positions: Vec<usize> = precedence
            .iter()
            .map(|key| OUTLINE_PROJECTOR_SOURCE.find(key).unwrap_or_else(|| panic!("{key} in carrier")))
            .collect();
        assert!(source_positions.windows(2).all(|pair| pair[0] < pair[1]));

        // Both skip hidden subtrees and project interactive/named nodes only.
        for token in ["aria-hidden", "simplifyDom", "truncated"] {
            assert!(main_webview.contains(token), "main carrier lost {token}");
            assert!(OUTLINE_PROJECTOR_SOURCE.contains(token), "installed carrier lost {token}");
        }
    }

    // ── 5. The ingesr receipt ────────────────────────────────────────────────

    #[test]
    fn the_ingress_span_names_itself_and_carries_the_typed_reason() {
        let record = ingress_span_record(&BeaconIngressSpan {
            reason: "oversize".to_string(),
            accepted: false,
            payload_bytes: 40_000,
            nonce_age_ms: 5,
            app_id: Some("qa3244-untaught".to_string()),
        });
        assert_eq!(record.span_name, BEACON_INGRESS_SPAN_NAME);
        assert_eq!(record.span_name, "installed.beacon.ingress");
        assert_eq!(record.status_code, "ERROR");
        assert_eq!(record.status_message.as_deref(), Some("oversize"));
        assert_eq!(record.session_id, "qa3244-untaught");
        let stored: serde_json::Value =
            serde_json::from_str(record.attributes_json.as_deref().expect("attrs")).expect("json");
        assert_eq!(stored["reason"], serde_json::json!("oversize"));
        assert_eq!(stored["accepted"], serde_json::json!(false));
        assert_eq!(stored["payloadBytes"], serde_json::json!(40_000));
    }

    #[test]
    fn an_accepted_ingress_records_ok_and_the_payload_size() {
        let facts = outcome_facts(&BeaconOutcome::Accepted { bytes: 8192, nodes: 42 }, 3);
        assert_eq!(facts.reason, "accepted");
        assert!(facts.accepted);
        assert_eq!(facts.payload_bytes, 8192);
        let record = ingress_span_record(&facts);
        assert_eq!(record.status_code, "OK");
        assert!(record.status_message.is_none());
    }

    #[test]
    fn every_outcome_maps_to_the_plans_reason_string() {
        assert_eq!(BeaconOutcome::Accepted { bytes: 0, nodes: 0 }.reason(), "accepted");
        assert_eq!(BeaconOutcome::Oversize { bytes: 1 }.reason(), "oversize");
        assert_eq!(BeaconOutcome::MissingNonce.reason(), "missing-nonce");
        assert_eq!(BeaconOutcome::UnknownNonce.reason(), "unknown-nonce");
        assert_eq!(BeaconOutcome::Expired.reason(), "expired");
        assert_eq!(BeaconOutcome::Malformed.reason(), "malformed");
        assert_eq!(BeaconOutcome::ChunkIncomplete.reason(), "chunk-incomplete");
        assert_eq!(BeaconFailure::Timeout.reason(), "timeout");
        assert_eq!(BeaconFailure::NotOpen.reason(), "not-open");
    }
}
