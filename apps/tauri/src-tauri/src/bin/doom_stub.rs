//! In-repo, build-gated Doom **stub engine** (Spec #2968, ST-8).
//!
//! The real RESTful-DOOM fork is source-only (ST-1: no trustworthy prebuilt), so
//! the runtime lifecycle, HTTP round trip, no-orphan, and every error path are
//! made deterministically testable OFFLINE by this stub. It is **never shipped**:
//! it lives behind `required-applications = ["doom-stub"]` in `Cargo.toml`, so a
//! normal `cargo build` (and the Tauri bundler) never compiles or packages it.
//!
//! It serves the ST-1-corrected real contract shapes on the `-apiport <port>`
//! port:
//!
//! * `GET  /api/state` → the whole observation JSON (`tic` is the advanced field).
//! * `POST /api/step`  → body `{ "tics": <int>, "actions": <json> }`; advances the
//!   monotonic tick by `tics` (clamped to the engine's 1–350 range) and returns
//!   the post-step state.
//! * `POST /api/episode` → body `{ "episode": <int>, "map": <int>, "skill": <int>,
//!   "seed": <int> }`; restarts the level (resets the tick + step count, clears
//!   dead/done) and returns the new-level observation (R-3).
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
//! ## ST-6 deterministic play levers (inert when unset; G-275 / G-316)
//!
//! | Env | Effect |
//! |-----|--------|
//! | `FREDO_DOOM_STUB_PROGRESS=1` | Each `POST /api/step` reduces `exit.distance` and bumps `level.kills`. |
//! | `FREDO_DOOM_STUB_DIE_AFTER=<n>` | After `n` steps the observation reports `outcome:"dead"`, `player.health:0` (latches until `/api/episode`). |
//! | `FREDO_DOOM_STUB_DONE_AFTER=<n>` | After `n` steps the observation reports `done:true`, `outcome:"exited"` (latches until `/api/episode`). |
//! | `FREDO_DOOM_STUB_EPISODE_FAIL=1` | `POST /api/episode` returns HTTP 500 (drives the R-3 restart failure path, QA F-32). |
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

/// Where `exit.distance` starts under `FREDO_DOOM_STUB_PROGRESS` (the plan fixes
/// only the *direction* — each step must reduce it — not the magnitude).
const PROGRESS_START_EXIT_DISTANCE: i64 = 1000;
/// How far each step moves `exit.distance` toward the exit under the progress lever.
const PROGRESS_EXIT_DISTANCE_STEP: i64 = 10;

#[derive(Clone)]
struct StubState {
    runtime: Arc<Mutex<StubRuntime>>,
    fail_state: bool,
    fail_step: bool,
    fail_frame: bool,
    fail_episode: bool,
    progress: bool,
    die_after: Option<u64>,
    done_after: Option<u64>,
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

    let progress = env_flag("FREDO_DOOM_STUB_PROGRESS");
    let die_after = parse_step_count("FREDO_DOOM_STUB_DIE_AFTER");
    let done_after = parse_step_count("FREDO_DOOM_STUB_DONE_AFTER");
    let state = StubState {
        runtime: Arc::new(Mutex::new(StubRuntime::initial(progress))),
        fail_state: fail_flag("state"),
        fail_step: fail_flag("step"),
        fail_frame: fail_flag("frame"),
        fail_episode: env_flag("FREDO_DOOM_STUB_EPISODE_FAIL"),
        progress,
        die_after,
        done_after,
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
    if state.progress {
        eprintln!(
            "doom-stub: FREDO_DOOM_STUB_PROGRESS set — each step reduces exit.distance and bumps kills"
        );
    }
    if let Some(n) = state.die_after {
        eprintln!("doom-stub: FREDO_DOOM_STUB_DIE_AFTER={n} — outcome becomes dead after {n} steps");
    }
    if let Some(n) = state.done_after {
        eprintln!("doom-stub: FREDO_DOOM_STUB_DONE_AFTER={n} — done becomes true after {n} steps");
    }
    if state.fail_episode {
        eprintln!("doom-stub: FREDO_DOOM_STUB_EPISODE_FAIL set — POST /api/episode returns 500");
    }

    let router = Router::new()
        .route("/api/state", get(get_state))
        .route("/api/step", post(post_step))
        .route("/api/episode", post(post_episode))
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

/// Parse a positive step count; blank / `0` / unparseable => `None` (inert).
fn parse_step_count_value(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok().filter(|n| *n > 0)
}

/// Read a positive step count from env (`FREDO_DOOM_STUB_DIE_AFTER` /
/// `FREDO_DOOM_STUB_DONE_AFTER`); unset => `None` (the lever is inert).
fn parse_step_count(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|value| parse_step_count_value(&value))
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

// ── Runtime state + contract shapes ───────────────────────────────────────────

/// The stub's mutable world state. It is advanced ONLY by `POST /api/step` and
/// reset ONLY by `POST /api/episode`, mirroring the real `-apilockstep` engine
/// (the world is frozen between calls — G-316).
#[derive(Clone, Debug)]
struct StubRuntime {
    tick: u64,
    /// Number of `POST /api/step` calls since the last episode reset — the unit the
    /// `FREDO_DOOM_STUB_DIE_AFTER` / `FREDO_DOOM_STUB_DONE_AFTER` levers count.
    steps: u64,
    kills: u64,
    exit_distance: i64,
    dead: bool,
    done: bool,
    episode: i64,
    map: i64,
    skill: i64,
}

impl StubRuntime {
    /// A fresh level. `progress` seeds `exit.distance` so the progress lever has
    /// somewhere to reduce from; without it the field stays at the slice-1 `0`.
    fn initial(progress: bool) -> Self {
        Self {
            tick: 0,
            steps: 0,
            kills: 0,
            exit_distance: if progress {
                PROGRESS_START_EXIT_DISTANCE
            } else {
                0
            },
            dead: false,
            done: false,
            episode: 1,
            map: 1,
            skill: 3,
        }
    }

    /// Advance by `tics` (already clamped) and apply the deterministic levers.
    /// Terminal levers latch: once dead/done they persist until `reset`.
    fn apply_step(
        &mut self,
        tics: u64,
        progress: bool,
        die_after: Option<u64>,
        done_after: Option<u64>,
    ) {
        self.tick = self.tick.saturating_add(tics);
        self.steps = self.steps.saturating_add(1);
        if progress {
            self.kills = self.kills.saturating_add(1);
            self.exit_distance = (self.exit_distance - PROGRESS_EXIT_DISTANCE_STEP).max(0);
        }
        if die_after.is_some_and(|n| self.steps >= n) {
            self.dead = true;
        }
        if done_after.is_some_and(|n| self.steps >= n) {
            self.done = true;
        }
    }

    /// Restart the level (R-3): clear tick/steps/progress and dead/done, and adopt
    /// the requested level coordinates.
    fn reset(&mut self, progress: bool, episode: i64, map: i64, skill: i64) {
        *self = Self::initial(progress);
        self.episode = episode;
        self.map = map;
        self.skill = skill;
    }

    /// The observation's `outcome`; death takes precedence over level exit.
    fn outcome(&self) -> &'static str {
        if self.dead {
            "dead"
        } else if self.done {
            "exited"
        } else {
            "alive"
        }
    }
}

/// The whole observation; `tic` is the advanced field (ST-1 `engine-contract.md`).
fn observation_json(rt: &StubRuntime) -> serde_json::Value {
    serde_json::json!({
        "tic": rt.tick,
        "episodeTic": rt.tick,
        "level": {
            "episode": rt.episode, "map": rt.map, "skill": rt.skill, "tic": rt.tick,
            "kills": rt.kills, "totalKills": 29, "items": 0, "totalItems": 37,
            "secrets": 0, "totalSecrets": 3
        },
        "player": {
            "health": if rt.dead { 0 } else { 100 },
            "armor": 0, "x": 0, "y": 0, "angle": 0,
            "weapon": "pistol", "ammo": 50, "keys": []
        },
        "threats": [],
        "hazards": [],
        "pickups": [],
        "clearance": {
            "ahead": 0, "right": 0, "behind": 0, "left": 0,
            "aheadRight": 0, "aheadLeft": 0
        },
        "exit": {"distance": rt.exit_distance, "bearing": 0, "kind": "none", "clearance": 0},
        "events": [],
        "done": rt.done,
        "outcome": rt.outcome()
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

/// Parse the requested `tics` from a `POST /api/step` body (default 1, clamped to
/// the engine's 1–350 range; a malformed body still advances by one — never panics).
fn parse_tics(body: &[u8]) -> u64 {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("tics").and_then(|t| t.as_i64()))
        .unwrap_or(1)
        .clamp(1, 350) as u64
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
    let observation = {
        let runtime = state.runtime.lock().expect("stub runtime lock");
        observation_json(&runtime)
    };
    Json(observation).into_response()
}

async fn post_step(State(state): State<StubState>, body: Bytes) -> Response {
    if state.fail_step {
        return failure("step");
    }
    let tics = parse_tics(&body);
    let observation = {
        let mut runtime = state.runtime.lock().expect("stub runtime lock");
        runtime.apply_step(tics, state.progress, state.die_after, state.done_after);
        observation_json(&runtime)
    };
    Json(observation).into_response()
}

/// `POST /api/episode` — restart the level reproducibly (R-3). Resets the tick and
/// step count, clears dead/done, adopts the requested level coordinates, and
/// answers with the new-level observation.
async fn post_episode(State(state): State<StubState>, body: Bytes) -> Response {
    if state.fail_episode {
        return failure("episode");
    }
    let request =
        serde_json::from_slice::<serde_json::Value>(&body).unwrap_or(serde_json::Value::Null);
    let observation = {
        let mut runtime = state.runtime.lock().expect("stub runtime lock");
        let episode = request
            .get("episode")
            .and_then(|v| v.as_i64())
            .unwrap_or(runtime.episode);
        let map = request
            .get("map")
            .and_then(|v| v.as_i64())
            .unwrap_or(runtime.map);
        let skill = request
            .get("skill")
            .and_then(|v| v.as_i64())
            .unwrap_or(runtime.skill);
        runtime.reset(state.progress, episode, map, skill);
        observation_json(&runtime)
    };
    Json(observation).into_response()
}

async fn get_frame(State(state): State<StubState>) -> Response {
    if state.fail_frame {
        return failure("frame");
    }
    if frame_503_active(&state.frame_503) {
        return frame_not_ready();
    }
    let tick = state.runtime.lock().expect("stub runtime lock").tick;
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
    fn observation_uses_tic_as_the_advanced_field() {
        let rt = StubRuntime {
            tick: 574,
            ..StubRuntime::initial(false)
        };
        let state = observation_json(&rt);
        assert_eq!(state["tic"], 574);
        assert_eq!(state["level"]["tic"], 574);
        assert_eq!(state["episodeTic"], 574);
        assert_eq!(state["player"]["weapon"], "pistol");
        assert_eq!(state["outcome"], "alive");
    }

    #[test]
    fn parse_tics_clamps_to_the_engine_range() {
        // Default tics = 1.
        assert_eq!(parse_tics(b"{}"), 1);
        // Body {tics, actions} — actions ignored for the tick advance.
        assert_eq!(parse_tics(br#"{"tics":4,"actions":[{"type":"shoot"}]}"#), 4);
        // Out-of-range tics clamp to 1..=350.
        assert_eq!(parse_tics(br#"{"tics":0}"#), 1);
        assert_eq!(parse_tics(br#"{"tics":9999}"#), 350);
        // A malformed body still advances by one (never panics).
        assert_eq!(parse_tics(b"not json"), 1);
    }

    #[test]
    fn parse_step_count_value_is_inert_for_non_positive_values() {
        assert_eq!(parse_step_count_value(""), None);
        assert_eq!(parse_step_count_value("   "), None);
        assert_eq!(parse_step_count_value("0"), None);
        assert_eq!(parse_step_count_value("nope"), None);
        assert_eq!(parse_step_count_value(" 3 "), Some(3));
    }

    #[test]
    fn apply_step_advances_the_tick_by_the_clamped_tics() {
        let mut rt = StubRuntime::initial(false);
        rt.apply_step(parse_tics(br#"{"tics":4}"#), false, None, None);
        assert_eq!(rt.tick, 4);
        rt.apply_step(parse_tics(br#"{"tics":9999}"#), false, None, None);
        assert_eq!(rt.tick, 354);
    }

    #[test]
    fn progress_lever_reduces_exit_distance_and_bumps_kills() {
        let mut rt = StubRuntime::initial(true);
        let start = rt.exit_distance;
        assert!(start > 0, "the progress lever seeds a non-zero exit distance");
        rt.apply_step(1, true, None, None);
        assert_eq!(rt.kills, 1);
        assert!(rt.exit_distance < start, "exit.distance must fall each step");
        rt.apply_step(1, true, None, None);
        assert_eq!(rt.kills, 2);
        assert!(rt.exit_distance < start);

        // The lever is inert when off.
        let mut idle = StubRuntime::initial(false);
        idle.apply_step(1, false, None, None);
        assert_eq!(idle.kills, 0);
        assert_eq!(idle.exit_distance, 0);
    }

    #[test]
    fn die_after_latches_death_after_n_steps() {
        let mut rt = StubRuntime::initial(false);
        rt.apply_step(1, false, Some(2), None);
        assert!(!rt.dead, "not dead before the threshold");
        assert_eq!(rt.outcome(), "alive");
        rt.apply_step(1, false, Some(2), None);
        assert!(rt.dead, "dead once the step count reaches the threshold");
        assert_eq!(rt.outcome(), "dead");
        let obs = observation_json(&rt);
        assert_eq!(obs["outcome"], "dead");
        assert_eq!(obs["player"]["health"], 0);
        // The terminal condition latches across further steps.
        rt.apply_step(1, false, Some(2), None);
        assert!(rt.dead);
    }

    #[test]
    fn done_after_latches_exit_after_n_steps() {
        let mut rt = StubRuntime::initial(false);
        rt.apply_step(1, false, None, Some(1));
        assert!(rt.done);
        assert_eq!(rt.outcome(), "exited");
        let obs = observation_json(&rt);
        assert_eq!(obs["done"], true);
        assert_eq!(obs["outcome"], "exited");
        assert_eq!(obs["player"]["health"], 100, "an exit is not a death");
    }

    #[test]
    fn episode_reset_clears_terminal_state_and_adopts_level() {
        let mut rt = StubRuntime::initial(true);
        rt.apply_step(4, true, Some(1), Some(1));
        assert!(rt.dead && rt.done);
        assert!(rt.tick > 0 && rt.steps > 0);

        rt.reset(true, 2, 5, 4);
        assert_eq!(rt.tick, 0);
        assert_eq!(rt.steps, 0);
        assert!(!rt.dead && !rt.done);
        assert_eq!(rt.outcome(), "alive");
        assert_eq!(rt.exit_distance, PROGRESS_START_EXIT_DISTANCE);
        let obs = observation_json(&rt);
        assert_eq!(obs["level"]["episode"], 2);
        assert_eq!(obs["level"]["map"], 5);
        assert_eq!(obs["level"]["skill"], 4);
        assert_eq!(obs["outcome"], "alive");
        assert_eq!(obs["player"]["health"], 100);
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
