//! In-repo, feature-gated Doom **stub engine** (Spec #2968, ST-8).
//!
//! The real RESTful-DOOM fork is source-only (ST-1: no trustworthy prebuilt), so
//! the runtime lifecycle, HTTP round trip, no-orphan, and every error path are
//! made deterministically testable OFFLINE by this stub. It is **never shipped**:
//! it lives behind `required-features = ["doom-stub"]` in `Cargo.toml`, so a
//! normal `cargo build` (and the Tauri bundler) never compiles or packages it.
//!
//! It serves the ST-1-corrected real contract shapes on the `-apiport <port>`
//! port:
//!
//! * `GET  /api/state` → the whole observation JSON (`tic` is the advanced field).
//! * `POST /api/step`  → body `{ "tics": <int>, "actions": <json> }`; advances the
//!   monotonic tick by `tics` (clamped to the engine's 1–350 range) and returns
//!   the post-step state.
//! * `GET  /api/frame` → `{width,height,format:"indexed8",pixels,palette}`.
//!
//! ## G-275 / G-300 induction levers (inert when unset)
//!
//! | Env | Effect |
//! |-----|--------|
//! | `FREDO_DOOM_STUB_EXIT=1` | Exit immediately before binding (drives `readyTimeout`). |
//! | `FREDO_DOOM_STUB_HANG=1` | Ignore termination requests (drives the hard-kill fallback). |
//! | `FREDO_DOOM_STUB_FAIL=state\|step\|frame` | That endpoint returns HTTP 500 (drives `requestFailed`, QA F-14). |
//! | `FREDO_DOOM_STUB_FRAME_503=<count\|duration>` | `GET /api/frame` returns HTTP **503** (transient) for the first `<count>` requests, or for a `<duration>` (`250ms` / `2s` / `1m`, anchored at the first frame request), then 200 resumes — the deterministic `frameNotReady` / R-1.4 / QA F-4 lever. |
//!
//! Run it with a finite bound only — it is a long-running server.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

const FRAME_WIDTH: u32 = 320;
const FRAME_HEIGHT: u32 = 200;
const DEFAULT_PORT: u16 = 6666;

#[derive(Clone)]
struct StubState {
    tick: Arc<Mutex<u64>>,
    fail_state: bool,
    fail_step: bool,
    fail_frame: bool,
    frame_503: Arc<Mutex<Frame503Runtime>>,
}

#[tokio::main]
async fn main() {
    let port = parse_port(std::env::args().skip(1));

    if env_flag("FREDO_DOOM_STUB_EXIT") {
        eprintln!("doom-stub: FREDO_DOOM_STUB_EXIT set — exiting immediately");
        std::process::exit(0);
    }
    if env_flag("FREDO_DOOM_STUB_HANG") {
        install_ignore_termination();
        eprintln!("doom-stub: FREDO_DOOM_STUB_HANG set — ignoring termination requests");
    }

    let state = StubState {
        tick: Arc::new(Mutex::new(0)),
        fail_state: fail_flag("state"),
        fail_step: fail_flag("step"),
        fail_frame: fail_flag("frame"),
        frame_503: Arc::new(Mutex::new(Frame503Runtime {
            spec: std::env::var("FREDO_DOOM_STUB_FRAME_503")
                .ok()
                .and_then(|value| parse_frame_503(&value)),
            consumed: 0,
            deadline: None,
        })),
    };
    if state.frame_503.lock().expect("stub frame503 lock").spec.is_some() {
        eprintln!(
            "doom-stub: FREDO_DOOM_STUB_FRAME_503 set — GET /api/frame returns 503 while active"
        );
    }

    let router = Router::new()
        .route("/api/state", get(get_state))
        .route("/api/step", post(post_step))
        .route("/api/frame", get(get_frame))
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("doom-stub: failed to bind {addr}: {error}");
            std::process::exit(1);
        }
    };
    eprintln!("doom-stub: listening on {addr}");

    if let Err(error) = axum::serve(listener, router).await {
        eprintln!("doom-stub: serve error: {error}");
        std::process::exit(1);
    }
}

// ── Args + env levers ─────────────────────────────────────────────────────────

/// Parse `-apiport <port>` (the ST-1-corrected flag), defaulting to 6666.
fn parse_port<I: Iterator<Item = String>>(mut args: I) -> u16 {
    let mut port = DEFAULT_PORT;
    while let Some(arg) = args.next() {
        if arg == "-apiport" || arg == "--apiport" {
            if let Some(value) = args.next() {
                if let Ok(parsed) = value.trim().parse::<u16>() {
                    port = parsed;
                }
            }
        }
    }
    port
}

/// A truthy env flag: set and not `0`/`false`/blank.
fn env_flag(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let value = value.trim().to_ascii_lowercase();
            !(value.is_empty() || value == "0" || value == "false")
        }
        Err(_) => false,
    }
}

/// `FREDO_DOOM_STUB_FAIL == which` (case-insensitive, trimmed).
fn fail_flag(which: &str) -> bool {
    std::env::var("FREDO_DOOM_STUB_FAIL")
        .map(|value| value.trim().eq_ignore_ascii_case(which))
        .unwrap_or(false)
}

// ── FREDO_DOOM_STUB_FRAME_503 seam (R-1.4 / F-4) ─────────────────────────────

/// The parsed `FREDO_DOOM_STUB_FRAME_503` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Frame503Spec {
    /// Return 503 for the first `n` frame requests, then 200.
    Count(u64),
    /// Return 503 until `duration` after the FIRST frame request, then 200.
    Duration(Duration),
}

/// Mutable state for the frame-503 seam (countdown / lazily-anchored deadline).
struct Frame503Runtime {
    spec: Option<Frame503Spec>,
    consumed: u64,
    deadline: Option<Instant>,
}

/// Parse `FREDO_DOOM_STUB_FRAME_503` = `<count>|<duration>`:
///
/// * a bare integer is a request **count** (`5` => the next 5 `/api/frame` calls 503);
/// * a `ms`/`s`/`m` suffix is a **duration** (`250ms`, `2s`, `1m`) anchored at the
///   first frame request.
///
/// Blank / unset / `0` / unparseable => `None` (the seam is inert).
fn parse_frame_503(value: &str) -> Option<Frame503Spec> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }
    let positive = |text: &str| text.trim().parse::<u64>().ok().filter(|n| *n > 0);
    if let Some(rest) = value.strip_suffix("ms") {
        return positive(rest).map(|n| Frame503Spec::Duration(Duration::from_millis(n)));
    }
    if let Some(rest) = value.strip_suffix('s') {
        return positive(rest).map(|n| Frame503Spec::Duration(Duration::from_secs(n)));
    }
    if let Some(rest) = value.strip_suffix('m') {
        return positive(rest)
            .map(|n| Frame503Spec::Duration(Duration::from_secs(n.saturating_mul(60))));
    }
    positive(&value).map(Frame503Spec::Count)
}

/// Whether the next `/api/frame` request should be answered with HTTP 503. Counts
/// down by request; a duration anchors at the first call. Once exhausted/elapsed
/// the seam clears itself so 200 frames resume.
fn frame_503_active(gate: &Arc<Mutex<Frame503Runtime>>) -> bool {
    let mut runtime = gate.lock().expect("stub frame503 lock");
    match runtime.spec {
        None => false,
        Some(Frame503Spec::Count(limit)) => {
            if runtime.consumed < limit {
                runtime.consumed += 1;
                true
            } else {
                runtime.spec = None;
                false
            }
        }
        Some(Frame503Spec::Duration(duration)) => {
            let deadline = *runtime
                .deadline
                .get_or_insert_with(|| Instant::now() + duration);
            if Instant::now() < deadline {
                true
            } else {
                runtime.spec = None;
                false
            }
        }
    }
}

// ── Contract shapes ───────────────────────────────────────────────────────────

/// The whole observation; `tic` is the advanced field (ST-1 `engine-contract.md`).
fn state_json(tick: u64) -> serde_json::Value {
    serde_json::json!({
        "tic": tick,
        "episodeTic": tick,
        "level": {
            "episode": 1, "map": 1, "skill": 3, "tic": tick,
            "kills": 0, "totalKills": 29, "items": 0, "totalItems": 37,
            "secrets": 0, "totalSecrets": 3
        },
        "player": {
            "health": 100, "armor": 0, "x": 0, "y": 0, "angle": 0,
            "weapon": "pistol", "ammo": 50, "keys": []
        },
        "threats": [],
        "hazards": [],
        "pickups": [],
        "clearance": {
            "ahead": 0, "right": 0, "behind": 0, "left": 0,
            "aheadRight": 0, "aheadLeft": 0
        },
        "exit": {"distance": 0, "bearing": 0, "kind": "none", "clearance": 0},
        "events": [],
        "done": false,
        "outcome": "alive"
    })
}

/// A deterministic indexed8 frame whose pattern varies with `tick`, so two frames
/// spaced by the poll interval differ (the CU-4 canvas can show motion).
fn frame_json(tick: u64) -> serde_json::Value {
    let mut pixels = vec![0u8; (FRAME_WIDTH * FRAME_HEIGHT) as usize];
    for y in 0..FRAME_HEIGHT {
        for x in 0..FRAME_WIDTH {
            let index = ((x + y + tick as u32) % 256) as u8;
            pixels[(y * FRAME_WIDTH + x) as usize] = index;
        }
    }
    let mut palette = vec![0u8; 768];
    for i in 0..256u32 {
        palette[(i * 3) as usize] = i as u8;
        palette[(i * 3 + 1) as usize] = (255 - i) as u8;
        palette[(i * 3 + 2) as usize] = ((i * 2) % 256) as u8;
    }
    serde_json::json!({
        "width": FRAME_WIDTH,
        "height": FRAME_HEIGHT,
        "format": "indexed8",
        "pixels": STANDARD.encode(&pixels),
        "palette": STANDARD.encode(&palette),
    })
}

/// Advance the monotonic tick by the requested tics (default 1, clamped 1–350).
fn advance(tick: u64, body: &[u8]) -> u64 {
    let tics = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("tics").and_then(|t| t.as_i64()))
        .unwrap_or(1)
        .clamp(1, 350);
    tick.saturating_add(tics as u64)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

fn failure(what: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": format!("stub fail {what}") })),
    )
        .into_response()
}

/// The engine's transient not-ready response (ST-1 contract: HTTP 503 while the
/// graphics subsystem is not up yet). The runtime maps this to `frameNotReady`.
fn frame_not_ready() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": "Graphics are not up yet" })),
    )
        .into_response()
}

async fn get_state(State(state): State<StubState>) -> Response {
    if state.fail_state {
        return failure("state");
    }
    let tick = *state.tick.lock().expect("stub tick lock");
    Json(state_json(tick)).into_response()
}

async fn post_step(State(state): State<StubState>, body: Bytes) -> Response {
    if state.fail_step {
        return failure("step");
    }
    let tick = {
        let mut guard = state.tick.lock().expect("stub tick lock");
        *guard = advance(*guard, &body);
        *guard
    };
    Json(state_json(tick)).into_response()
}

async fn get_frame(State(state): State<StubState>) -> Response {
    if state.fail_frame {
        return failure("frame");
    }
    if frame_503_active(&state.frame_503) {
        return frame_not_ready();
    }
    let tick = *state.tick.lock().expect("stub tick lock");
    Json(frame_json(tick)).into_response()
}

// ── Termination-ignoring lever (Windows) ─────────────────────────────────────

/// Register a console control handler that reports every event as handled, so a
/// graceful termination request (`taskkill /T`, Ctrl+C) is ignored. The
/// hard-kill fallback (`taskkill /T /F`) is unaffected — `TerminateProcess`
/// cannot be intercepted.
#[cfg(target_os = "windows")]
fn install_ignore_termination() {
    unsafe extern "system" fn ignore_handler(_ctrl_type: u32) -> i32 {
        1
    }
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    // SAFETY: `ignore_handler` is a valid `extern "system"` function that touches
    // no Rust state; registering it is the documented Windows API contract.
    let _ = unsafe { SetConsoleCtrlHandler(Some(ignore_handler), 1) };
}

#[cfg(not(target_os = "windows"))]
fn install_ignore_termination() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_port_reads_apiport_and_defaults() {
        let args = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(parse_port(args(&["-apiport", "7000"]).into_iter()), 7000);
        assert_eq!(
            parse_port(args(&["-iwad", "x.wad", "-apiport", "1234"]).into_iter()),
            1234
        );
        assert_eq!(parse_port(args(&[]).into_iter()), DEFAULT_PORT);
        // A non-numeric port falls back to the default (never panics).
        assert_eq!(
            parse_port(args(&["-apiport", "nope"]).into_iter()),
            DEFAULT_PORT
        );
    }

    #[test]
    fn state_json_uses_tic_as_the_advanced_field() {
        let state = state_json(574);
        assert_eq!(state["tic"], 574);
        assert_eq!(state["level"]["tic"], 574);
        assert_eq!(state["episodeTic"], 574);
        assert_eq!(state["player"]["weapon"], "pistol");
        assert_eq!(state["outcome"], "alive");
    }

    #[test]
    fn advance_is_monotonic_and_clamped() {
        // Default tics = 1.
        assert_eq!(advance(10, b"{}"), 11);
        // Body {tics, actions} — actions ignored for the tick advance.
        assert_eq!(advance(10, br#"{"tics":4,"actions":[{"type":"shoot"}]}"#), 14);
        // Out-of-range tics clamp to 1..=350.
        assert_eq!(advance(10, br#"{"tics":0}"#), 11);
        assert_eq!(advance(10, br#"{"tics":9999}"#), 360);
        // A malformed body still advances by one (never panics).
        assert_eq!(advance(10, b"not json"), 11);
    }

    #[test]
    fn frame_json_is_a_320x200_indexed8_payload() {
        let frame = frame_json(0);
        assert_eq!(frame["width"], 320);
        assert_eq!(frame["height"], 200);
        assert_eq!(frame["format"], "indexed8");

        let pixels = STANDARD
            .decode(frame["pixels"].as_str().expect("pixels"))
            .expect("pixels b64");
        assert_eq!(pixels.len(), (FRAME_WIDTH * FRAME_HEIGHT) as usize);
        let palette = STANDARD
            .decode(frame["palette"].as_str().expect("palette"))
            .expect("palette b64");
        assert_eq!(palette.len(), 768);
    }

    #[test]
    fn consecutive_frames_differ_with_the_tick() {
        let a = frame_json(0);
        let b = frame_json(1);
        assert_ne!(a["pixels"], b["pixels"], "frames must differ across ticks");
    }

    #[test]
    fn parse_frame_503_reads_counts_and_durations() {
        // Inert forms.
        assert_eq!(parse_frame_503(""), None);
        assert_eq!(parse_frame_503("   "), None);
        assert_eq!(parse_frame_503("0"), None);
        assert_eq!(parse_frame_503("nope"), None);
        assert_eq!(parse_frame_503("0s"), None);

        // Counts.
        assert_eq!(parse_frame_503("5"), Some(Frame503Spec::Count(5)));
        assert_eq!(parse_frame_503("  12 "), Some(Frame503Spec::Count(12)));

        // Durations (case-insensitive suffix; `ms` must win over `s`).
        assert_eq!(
            parse_frame_503("250ms"),
            Some(Frame503Spec::Duration(Duration::from_millis(250)))
        );
        assert_eq!(
            parse_frame_503("2S"),
            Some(Frame503Spec::Duration(Duration::from_secs(2)))
        );
        assert_eq!(
            parse_frame_503("1m"),
            Some(Frame503Spec::Duration(Duration::from_secs(60)))
        );
    }

    #[test]
    fn frame_503_count_exhausts_then_clears() {
        let gate = Arc::new(Mutex::new(Frame503Runtime {
            spec: Some(Frame503Spec::Count(2)),
            consumed: 0,
            deadline: None,
        }));
        assert!(frame_503_active(&gate), "first request 503s");
        assert!(frame_503_active(&gate), "second request 503s");
        assert!(!frame_503_active(&gate), "count exhausted => 200 resumes");
        assert!(!frame_503_active(&gate), "the seam stays clear");
    }

    #[test]
    fn frame_503_is_inert_when_unset() {
        let gate = Arc::new(Mutex::new(Frame503Runtime {
            spec: None,
            consumed: 0,
            deadline: None,
        }));
        assert!(!frame_503_active(&gate));
    }
}
