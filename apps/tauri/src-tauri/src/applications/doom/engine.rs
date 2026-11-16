//! Native in-process Doom engine adapter (Spec #3023, ST-1).
//!
//! This module is the single native replacement for the retired out-of-process
//! RESTful-DOOM engine client (`client.rs`) and its supervised child process
//! (`process.rs`). It drives a **pure-Rust, BSD-3-Clause** Doom simulator
//! ([`neurodoom`] v0.6.7, a cargo dependency — never vendored, never built with
//! a C/`cc` toolchain) entirely in-process:
//!
//! * no child process, no PID, no orphan (teardown is take-and-drop);
//! * no network listener, no loopback socket, no HTTP bridge;
//! * a headless, deterministic 320×200 RGBA framebuffer.
//!
//! # Contract preserved
//!
//! The observation this adapter emits keeps the exact JSON paths the autoplay
//! loop ([`super::agent`]) and the model persona
//! (`applications::llm_server::doom_agent`) consume verbatim —
//! `tic` / `done` / `outcome` / `level.*` / `player.{x,y}` — and adds the
//! native parity fields `enemies` / `items` / `doors` (LOS-gated enemy intel,
//! nearby items, door/switch state) plus the bounded `walls` geometry summary
//! (Spec #3030 S1; see [`super::perception`]). `x`/`y` are integer map units
//! derived from the engine's 16.16 `Fixed`, because `is_progress` compares
//! integers.
//!
//! # Threading
//!
//! The session is Tauri-managed application state behind a `std::sync::Mutex`.
//! Every method takes `&self` and locks narrowly for a short synchronous
//! critical section. The mutex is never held across an `.await` (the async
//! autoplay loop invokes these through `tauri::async_runtime::spawn_blocking`).
//! A **dedicated engine thread is never spawned** — no orphan is constructible.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

use crate::infrastructure::companion::doom_decision::DoomDecisionSource;

use neurodoom::game_data::{MobjFlag, SPRNAMES};
use neurodoom::map::{point_to_angle, MapData, SectorId};
use neurodoom::math::{Angle, Fixed, FRACBITS};
use neurodoom::specials::{is_exit_line, DoorDirection, SpecialThinker};
use neurodoom::types::{AmmoType, Button, Buttons, WeaponType};
use neurodoom::world::{Entity, EntityId, PeerId};
use neurodoom::{ClassicEngine, DoomError, PlayerAction, SCREENHEIGHT, SCREENWIDTH};

use super::actions::{
    DOOM_ACTION_AMOUNT_DEFAULT, DOOM_ACTION_ANGLE_MAX, DOOM_ACTION_ANGLE_MIN, DOOM_ACTION_BACKWARD,
    DOOM_ACTION_FORWARD, DOOM_ACTION_RUN, DOOM_ACTION_SHOOT, DOOM_ACTION_STRAFE_LEFT,
    DOOM_ACTION_STRAFE_RIGHT, DOOM_ACTION_SWITCH_WEAPON, DOOM_ACTION_TURN_LEFT,
    DOOM_ACTION_TURN_RIGHT, DOOM_ACTION_TURN_TO, DOOM_ACTION_USE, DOOM_ACTION_WEAPON_SLOT_MAX,
    DOOM_ACTION_WEAPON_SLOT_MIN, DOOM_STEP_TICS_MAX,
};
use super::autoplay::{
    DoomAutoplayStatus, DOOM_AUTOPLAY_MAX_FAILURES, DOOM_AUTOPLAY_MAX_STEPS,
    DOOM_CONTINUOUS_RATE_HZ,
};
use super::agent::{run_continuous_loop, AutoplayRun, DoomAutoplayConfig, DoomAutoplayEngine};
use super::clock::{DoomTickClock, DOOM_CONTINUOUS_TICK_PERIOD_MS, DOOM_DEGRADED_TICK_PERIOD_MS};
use super::perception;
use super::progress::DoomProgressWriter;
use super::save::DoomCampaign;

// ── G-275 WAD seam ────────────────────────────────────────────────────────────

/// Test-only WAD path override (G-275). Inert when unset: the shipped path
/// returns the embedded `DOOM1.WAD` by default. QA points this at a
/// tester-written absent/corrupt copy under `.opencode/tmp/3023/wad/`.
///
/// # QA test-data convention (Spec #3023 ST-9)
///
/// The tester writes throwaway fixtures under the gitignored scratch root
/// `.opencode/tmp/3023/` — the shipped `apps/tauri/src-tauri/doom/DOOM1.WAD` is
/// **never** mutated:
///
/// * `.opencode/tmp/3023/wad/absent.wad` — an absent path (or any path that does
///   not exist) resolves to [`DoomEngineErrorCode::WadMissing`];
/// * `.opencode/tmp/3023/wad/corrupt.wad` — a truncated/garbage file resolves to
///   [`DoomEngineErrorCode::WadCorrupt`];
/// * `.opencode/tmp/3023/doom-save/` — the `FREDO_DOOM_SAVE_STATE_DIR` target
///   for the save/persistence rows.
///
/// Both WAD seams are inert when unset, so the production path is unchanged.
pub const DOOM_WAD_PATH_ENV: &str = "FREDO_DOOM_WAD_PATH";

/// The bundled shareware `DOOM1.WAD`, embedded at compile time.
///
/// Resolves relative to this file:
/// `src/applications/doom/engine.rs` → `src-tauri/doom/DOOM1.WAD`.
const EMBEDDED_WAD: &[u8] = include_bytes!("../../../doom/DOOM1.WAD");

/// Bytes in one 320×200 RGBA frame.
const FRAME_BYTES: usize = SCREENWIDTH * SCREENHEIGHT * 4;

/// The single player's peer id (single-player flows use `PeerId(0)`).
const LOCAL_PEER: PeerId = PeerId(0);

// ── Movement / turn constants (classic Doom speeds, in engine units) ──────────

/// Forward impulse per tic, walking (classic Doom `forwardmove` 0x19).
const DOOM_FORWARD_WALK: i8 = 25;
/// Forward impulse per tic, running (classic Doom `forwardmove` 0x32).
const DOOM_FORWARD_RUN: i8 = 50;
/// Side impulse per tic, walking (classic Doom `sidemove` 0x18).
const DOOM_SIDE_WALK: i8 = 24;
/// Side impulse per tic, running (classic Doom `sidemove` 0x28).
const DOOM_SIDE_RUN: i8 = 40;
/// Per-tic turn, in [`PlayerAction::angle_turn`] units (classic keyboard turn).
const DOOM_TURN_PER_TIC: i16 = 640;

/// Bound on the number of parity entries emitted per list (keeps the
/// observation payload bounded regardless of map size).
pub(crate) const OBSERVATION_MAX_ENTRIES: usize = 16;

// ── Typed native engine errors ────────────────────────────────────────────────

/// The typed native-engine failure vocabulary.
///
/// These are the three classes the in-window error panel renders (per the
/// UI/UX contract): the bundled WAD is missing, the bundled WAD is damaged,
/// or the engine failed to construct/load a level. The wire strings are the
/// stable `camelCase` codes the frontend matches on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomEngineErrorCode {
    /// No WAD file exists at the resolved path (`FREDO_DOOM_WAD_PATH`).
    WadMissing,
    /// The WAD exists but could not be read or parsed as a valid IWAD.
    WadCorrupt,
    /// The engine could not be constructed, or a level could not be loaded.
    EngineStartFailed,
}

impl DoomEngineErrorCode {
    /// The stable wire string (matches `#[serde(rename_all = "camelCase")]`).
    pub fn as_str(self) -> &'static str {
        match self {
            DoomEngineErrorCode::WadMissing => "wadMissing",
            DoomEngineErrorCode::WadCorrupt => "wadCorrupt",
            DoomEngineErrorCode::EngineStartFailed => "engineStartFailed",
        }
    }
}

/// A typed native-engine failure: the code plus a human-readable detail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomEngineError {
    /// The typed failure class.
    pub code: DoomEngineErrorCode,
    /// Human-readable detail (safe to log/show).
    pub message: String,
}

impl DoomEngineError {
    /// Build a typed failure.
    pub fn new(code: DoomEngineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// A failure because no live session exists.
    fn no_session() -> Self {
        Self::new(
            DoomEngineErrorCode::EngineStartFailed,
            "no live Doom session",
        )
    }
}

impl std::fmt::Display for DoomEngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

// ── WAD loading ───────────────────────────────────────────────────────────────

/// Load the game data for a session.
///
/// Returns the embedded shareware `DOOM1.WAD` by default; when
/// [`DOOM_WAD_PATH_ENV`] names a non-blank path it reads that file instead
/// (inert when unset, so the production path is unchanged).
pub fn load_wad() -> Result<Vec<u8>, DoomEngineError> {
    let override_path = std::env::var(DOOM_WAD_PATH_ENV).ok();
    load_wad_from(override_path.as_deref())
}

/// Pure WAD loader (unit-testable without env mutation).
///
/// A named-but-absent file is [`DoomEngineErrorCode::WadMissing`]; a file that
/// exists but is unreadable or whose WAD header is invalid/truncated is
/// [`DoomEngineErrorCode::WadCorrupt`]. The embedded default WAD is validated the
/// same way, so a broken bundle surfaces the same typed error.
fn load_wad_from(override_path: Option<&str>) -> Result<Vec<u8>, DoomEngineError> {
    match override_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => {
            if !std::path::Path::new(path).exists() {
                return Err(DoomEngineError::new(
                    DoomEngineErrorCode::WadMissing,
                    format!("no WAD file at {path}"),
                ));
            }
            let bytes = std::fs::read(path).map_err(|error| {
                DoomEngineError::new(
                    DoomEngineErrorCode::WadCorrupt,
                    format!("could not read the WAD at {path}: {error}"),
                )
            })?;
            validate_wad_header(&bytes, path)?;
            Ok(bytes)
        }
        None => {
            validate_wad_header(EMBEDDED_WAD, "embedded DOOM1.WAD")?;
            Ok(EMBEDDED_WAD.to_vec())
        }
    }
}

/// Validate the 12-byte IWAD/PWAD header and the lump-directory bounds.
///
/// This is the deterministic `wadCorrupt` classifier (Spec #3023 ST-9): a file
/// that is too short, lacks the `IWAD`/`PWAD` magic, carries a negative lump
/// count / directory offset, or whose lump directory extends past end of file
/// (a truncated copy) is [`DoomEngineErrorCode::WadCorrupt`]. Deeper parse
/// failures (a valid header over damaged lump data) are still mapped by
/// [`construct_engine`]'s [`DoomError::WadError`] arm.
fn validate_wad_header(bytes: &[u8], source: &str) -> Result<(), DoomEngineError> {
    let corrupt = |detail: &str| {
        DoomEngineError::new(DoomEngineErrorCode::WadCorrupt, format!("{source}: {detail}"))
    };
    if bytes.len() < 12 {
        return Err(corrupt("file is shorter than a WAD header"));
    }
    let magic = &bytes[0..4];
    if magic != b"IWAD" && magic != b"PWAD" {
        return Err(corrupt("missing IWAD/PWAD magic"));
    }
    let numlumps = i32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let infotableofs = i32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    if numlumps < 0 || infotableofs < 0 {
        return Err(corrupt("negative lump count or directory offset"));
    }
    let directory_end = (infotableofs as usize).saturating_add((numlumps as usize).saturating_mul(16));
    if directory_end > bytes.len() {
        return Err(corrupt("lump directory extends past end of file (truncated)"));
    }
    Ok(())
}

/// Construct the classic engine at `map_name` from `wad`, mapping the crate's
/// [`DoomError`] onto the native typed vocabulary.
///
/// A WAD parse failure is [`DoomEngineErrorCode::WadCorrupt`]; every other
/// construction failure (missing map lump, texture load, no player start) is
/// [`DoomEngineErrorCode::EngineStartFailed`].
fn construct_engine(wad: &[u8], map_name: &str) -> Result<ClassicEngine, DoomEngineError> {
    ClassicEngine::new(wad, map_name).map_err(map_doom_error)
}

/// Map a `neurodoom::DoomError` onto the native typed error.
fn map_doom_error(error: DoomError) -> DoomEngineError {
    match error {
        DoomError::WadError(_) => {
            DoomEngineError::new(DoomEngineErrorCode::WadCorrupt, error.to_string())
        }
        _ => DoomEngineError::new(DoomEngineErrorCode::EngineStartFailed, error.to_string()),
    }
}

/// The Doom level lump name for `episode`/`map` (`E1M1`…`E4M9`).
fn level_name(episode: i64, map: i64) -> Option<String> {
    if (1..=4).contains(&episode) && (1..=9).contains(&map) {
        Some(format!("E{episode}M{map}"))
    } else {
        None
    }
}

// ── The session + Tauri-managed exactly-one state ─────────────────────────────

/// A live in-process engine session (no child, no socket, no thread).
pub struct DoomSession {
    /// The native engine; owns the world, map, textures, and renderer.
    engine: ClassicEngine,
    /// The WAD bytes (kept so level progression can re-load a map).
    wad: Vec<u8>,
    /// The campaign episode this session is playing.
    episode: i64,
    /// The campaign map this session is playing.
    map: i64,
    /// The requested skill (engine parity note: `ClassicDoomRules` exposes no
    /// skill — see the module report; the value is carried for persistence).
    skill: i64,
    /// The live `MobjFlag::Special` entity-id set as of the last
    /// [`DoomSession::observe_collection`] (Spec #3054 ST-1). Held on the session
    /// (not the bounded observation) so it survives every tick for the session's
    /// lifetime; cleared ONLY on [`reset`](DoomEngineState::reset) — a world
    /// reload starts a fresh id namespace.
    last_special_ids: HashSet<EntityId>,
    /// Per-world cumulative count of `MobjFlag::Special` ids that VANISHED since
    /// the previous observation (Spec #3054 ST-1) — the producer of the additive
    /// `level.itemsCollected`. Projected read-only by [`observation_with`].
    items_collected: i64,
}

impl DoomSession {
    /// The single-player entity this session is driving, if any.
    fn player_entity(&self) -> Option<&Entity> {
        let world = self.engine.world();
        world.controlled_by(LOCAL_PEER).and_then(|eid| world.get(eid))
    }

    /// The current player facing, or `0` when no player entity exists.
    fn player_angle(&self) -> Angle {
        self.player_entity().map(|e| e.angle).unwrap_or(0)
    }

    /// Post-simulation collection observer (Spec #3054 ST-1).
    ///
    /// Builds the CURRENT live `MobjFlag::Special` entity-id set over the FULL
    /// world (never the bounded observation list), counts the ids present in the
    /// previous set but absent now — the pickup path removes the mobj from the
    /// world (`check_pickups` → `world.remove`) — adds that delta to the
    /// per-world cumulative counter, and stores the new set. Deterministic (a set
    /// diff, no RNG, no clock); called AFTER the world is current by
    /// [`DoomEngineState::step`] / [`DoomEngineState::reset`] /
    /// [`DoomEngineState::read_state`].
    fn observe_collection(&mut self) -> i64 {
        let current: HashSet<EntityId> = self
            .engine
            .world()
            .iter()
            .filter(|entity| entity.flags.contains(MobjFlag::Special))
            .map(|entity| entity.id)
            .collect();
        self.items_collected = self
            .items_collected
            .saturating_add(special_diff(&self.last_special_ids, &current));
        self.last_special_ids = current;
        self.items_collected
    }
}

/// The number of ids present in `previous` but absent from `current` (Spec #3054
/// ST-1) — the collection delta. Pure, so the diff is unit-testable without an
/// engine (F-5).
fn special_diff(previous: &HashSet<EntityId>, current: &HashSet<EntityId>) -> i64 {
    previous
        .iter()
        .filter(|id| !current.contains(id))
        .count() as i64
}

/// Session coordinates returned by [`DoomEngineState::launch`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomSessionInfo {
    /// The campaign episode (shareware `DOOM1.WAD` is episode 1 only).
    pub episode: i64,
    /// The campaign map (1..=9).
    pub map: i64,
    /// The requested skill.
    pub skill: i64,
}

/// Tauri-managed **exactly-one** session.
///
/// The `Mutex` only ever guards a short synchronous critical section; it is
/// never held across an `.await`. `Arc` lets the async autoplay loop move an
/// owned handle into `spawn_blocking` without holding the lock across a yield.
#[derive(Clone, Default)]
pub struct DoomEngineState(pub Arc<Mutex<Option<DoomSession>>>);

impl DoomEngineState {
    /// Lock the session mutex, recovering from a poisoned lock (a panic in a
    /// prior engine call must not wedge the runtime permanently).
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<DoomSession>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Construct the session at `(episode=1, map, skill)`, or return the live
    /// session's coordinates when one already exists (idempotent exactly-one:
    /// a second engine instance is never constructed).
    ///
    /// Fails with [`DoomEngineErrorCode::WadMissing`] / `WadCorrupt` for a WAD
    /// problem, and `EngineStartFailed` when the engine cannot start (including
    /// the `FREDO_DOOM_FAIL_ENGINE_SPAWN` induction lever). Both the WAD override
    /// ([`DOOM_WAD_PATH_ENV`]) and the failure lever are read here; each is inert
    /// when unset, so the production path is unchanged. The deterministic form
    /// ([`Self::launch_with`]) carries them as injectable inputs.
    pub fn launch(&self, map: i64, skill: i64) -> Result<DoomSessionInfo, DoomEngineError> {
        let wad_override = std::env::var(DOOM_WAD_PATH_ENV).ok();
        let fail_spawn = super::failure_seam::fail_engine_spawn_requested();
        self.launch_with(map, skill, wad_override.as_deref(), fail_spawn)
    }

    /// Deterministic construction (Spec #3023 ST-9): the WAD override and the
    /// failure lever are injected, so the FULL launch path — including the
    /// typed-error ordering (the failure lever short-circuits before the WAD is
    /// read) — is unit-testable without mutating process-global env (G-222).
    fn launch_with(
        &self,
        map: i64,
        skill: i64,
        wad_override: Option<&str>,
        fail_spawn: bool,
    ) -> Result<DoomSessionInfo, DoomEngineError> {
        let mut guard = self.lock();
        if let Some(session) = guard.as_ref() {
            return Ok(session_info(session));
        }

        // G-275 failure lever (inert when unset): refuse construction before any
        // session exists, so the typed error surfaces with no engine and no orphan.
        if fail_spawn {
            return Err(DoomEngineError::new(
                DoomEngineErrorCode::EngineStartFailed,
                "engine start refused by FREDO_DOOM_FAIL_ENGINE_SPAWN",
            ));
        }

        let map_name = level_name(1, map).ok_or_else(|| {
            DoomEngineError::new(
                DoomEngineErrorCode::EngineStartFailed,
                format!("invalid level coordinates E1M{map}"),
            )
        })?;
        let wad = load_wad_from(wad_override)?;
        let engine = construct_engine(&wad, &map_name)?;
        *guard = Some(DoomSession {
            engine,
            wad,
            episode: 1,
            map,
            skill,
            last_special_ids: HashSet::new(),
            items_collected: 0,
        });
        Ok(DoomSessionInfo {
            episode: 1,
            map,
            skill,
        })
    }

    /// Drop the session (teardown). Bounded — there is no thread or process to
    /// join, so take-and-drop cannot orphan anything (G-263).
    pub fn stop(&self) {
        *self.lock() = None;
    }

    /// Whether a live session exists.
    pub fn is_running(&self) -> bool {
        self.lock().is_some()
    }

    /// The parity observation (see the module-level observation contract).
    pub fn read_state(&self) -> Result<Value, DoomEngineError> {
        let mut guard = self.lock();
        let session = guard.as_mut().ok_or_else(DoomEngineError::no_session)?;
        session.observe_collection();
        Ok(observation(session))
    }

    /// Translate the existing action vocabulary into per-tic
    /// [`PlayerAction`]s, hold them over `tics`, then render once.
    ///
    /// `tics` is clamped to the engine's `1..=350` range. Unknown or malformed
    /// action objects are ignored (never a panic).
    pub fn step(&self, tics: i64, actions: &Value) -> Result<Value, DoomEngineError> {
        let mut guard = self.lock();
        let session = guard.as_mut().ok_or_else(DoomEngineError::no_session)?;
        let specs = parse_actions(actions);
        let tics = tics.clamp(1, DOOM_STEP_TICS_MAX);
        for tic in 0..tics {
            let angle = session.player_angle();
            let action = build_player_action(&specs, tic, angle);
            session.engine.simulate(&[(LOCAL_PEER, action)], &[]);
        }
        session.engine.render_for(LOCAL_PEER);
        session.observe_collection();
        Ok(observation(session))
    }

    /// Level progression / resume positioning: re-load the requested map (which
    /// resets the world), re-spawn its things, and answer the new observation.
    pub fn reset(&self, episode: i64, map: i64, skill: i64) -> Result<Value, DoomEngineError> {
        let mut guard = self.lock();
        let session = guard.as_mut().ok_or_else(DoomEngineError::no_session)?;
        let map_name = level_name(episode, map).ok_or_else(|| {
            DoomEngineError::new(
                DoomEngineErrorCode::EngineStartFailed,
                format!("invalid level coordinates E{episode}M{map}"),
            )
        })?;
        session.engine.load_map(&session.wad, &map_name).map_err(map_doom_error)?;
        session.engine.spawn_map_things(LOCAL_PEER);
        session.episode = episode;
        session.map = map;
        session.skill = skill;
        // A world reload starts a fresh entity-id namespace: clear the collection
        // diff state (Spec #3054 ST-1) so no cross-map counting occurs, then seed
        // the new world's live set.
        session.last_special_ids.clear();
        session.items_collected = 0;
        session.observe_collection();
        session.engine.render_for(LOCAL_PEER);
        Ok(observation(session))
    }

    /// The current frame as raw RGBA bytes (`320 * 200 * 4 = 256_000` bytes),
    /// row-major with byte order R, G, B, A — NO PNG, NO base64 (Spec #3026
    /// ST-3). This is the AC2 frame transport: the webview wraps it in an
    /// `ImageData` and draws with `putImageData`.
    ///
    /// Renders from the local player's POV when the framebuffer is not yet
    /// populated (a freshly constructed session has no frame until it renders).
    pub fn frame_rgba(&self) -> Result<Vec<u8>, DoomEngineError> {
        let mut guard = self.lock();
        let session = guard.as_mut().ok_or_else(DoomEngineError::no_session)?;
        if session.engine.framebuffer().len() != FRAME_BYTES {
            session.engine.render_for(LOCAL_PEER);
        }
        let framebuffer = session.engine.framebuffer();
        if framebuffer.len() != FRAME_BYTES {
            return Err(DoomEngineError::new(
                DoomEngineErrorCode::EngineStartFailed,
                format!(
                    "framebuffer is {} bytes, expected {FRAME_BYTES}",
                    framebuffer.len()
                ),
            ));
        }
        Ok(framebuffer.to_vec())
    }
}

/// The coordinates of a session (for the idempotent launch reply).
fn session_info(session: &DoomSession) -> DoomSessionInfo {
    DoomSessionInfo {
        episode: session.episode,
        map: session.map,
        skill: session.skill,
    }
}

// ── Deterministic engine-native driver (Spec #3023 ST-9 / QA harness) ────────

/// The bounded configuration of [`run_bounded_driver`].
///
/// Defaults to the shared [`super::autoplay`] budgets and [`super::save`]'s
/// default skill; [`Self::from_env`] resolves the budget overrides from the
/// existing `FREDO_DOOM_AGENT_*` seams (inert when unset), so the driver and the
/// production loop share one seam (G-275).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoomDriverConfig {
    /// The campaign map to construct at (shareware `DOOM1.WAD` is episode 1).
    pub map: i64,
    /// The requested skill (carried; the crate exposes no skill knob).
    pub skill: i64,
    /// Maximum engine-advancing steps before the run stops cleanly.
    pub max_steps: u32,
    /// Maximum consecutive unusable decisions before the run stops.
    pub max_failures: u32,
    /// Test-only (Spec #3039 ST-8): when `true`, the driven run terminates
    /// STABLY at the FIRST non-final level exit (the AC5 completion surface)
    /// instead of advancing the campaign. Defaults to `false` (inert), so the
    /// shipped advance path is byte-identical.
    pub stop_at_first_exit: bool,
    /// Test-only per-run low-health threshold override (Spec #3053 Option A),
    /// threaded into the loop's [`super::agent::DoomAutoplayConfig`] and captured
    /// into the run's combat policy. `None` (the production default) resolves the
    /// retained env seam; `Some(DOOM_COMBAT_LOW_HEALTH_OFF)` makes the survival
    /// brake inert for a brake-inert completion leg.
    pub combat_low_health: Option<i64>,
}

impl Default for DoomDriverConfig {
    fn default() -> Self {
        Self {
            map: 1,
            skill: super::save::DOOM_DEFAULT_SKILL,
            max_steps: DOOM_AUTOPLAY_MAX_STEPS,
            max_failures: DOOM_AUTOPLAY_MAX_FAILURES,
            stop_at_first_exit: false,
            combat_low_health: None,
        }
    }
}

impl DoomDriverConfig {
    /// Resolve the bounded budgets from the existing `FREDO_DOOM_AGENT_*` env
    /// seams ([`super::decision::DOOM_AGENT_MAX_STEPS_ENV`] /
    /// [`super::decision::DOOM_AGENT_MAX_FAILURES_ENV`]); unset/blank/invalid
    /// values fall back to the binding defaults (inert when unset).
    pub fn from_env() -> Self {
        let default = Self::default();
        Self {
            max_steps: super::decision::max_steps_from_env().unwrap_or(default.max_steps),
            max_failures: super::decision::max_failures_from_env().unwrap_or(default.max_failures),
            ..default
        }
    }
}

/// The deterministic outcome of [`run_bounded_driver`] — the start/end
/// observation plus the run counters.
///
/// `Eq` is intentionally not derived: [`Self::fps_estimate`] is an `f64`.
#[derive(Clone, Debug, PartialEq)]
pub struct DoomDriverReport {
    /// The campaign episode the session played (always 1 for `DOOM1.WAD`).
    pub episode: i64,
    /// The campaign map the session played.
    pub map: i64,
    /// The requested skill.
    pub skill: i64,
    /// Engine-advancing ticks completed (the continuous loop's tick count).
    pub steps: u32,
    /// The engine ticks advanced (equals [`Self::steps`] for the current
    /// one-tic-per-iteration loop; kept as the explicit AC2 quantity).
    pub ticks: u32,
    /// Consecutive DISTINCT (world-reflecting) frames produced — the AC2
    /// observable. A frame is distinct iff its framebuffer bytes differ from
    /// the immediately preceding frame's.
    pub distinct_frames: u32,
    /// Distinct frames per SIMULATED second
    /// (`distinct_frames / (ticks / DOOM_CONTINUOUS_RATE_HZ)`), or `0.0` for an
    /// empty run — wall-clock-free (AC5).
    pub fps_estimate: f64,
    /// Decisions obtained from the source.
    pub decisions: u32,
    /// Escape maneuvers issued this run (Spec #3031 ST-2) — lifted from the
    /// loop status exactly like [`Self::decisions`].
    pub escapes: u32,
    /// Unusable (malformed/failed) decisions seen.
    pub failures: u32,
    /// The starting engine tic.
    pub start_tic: u64,
    /// The last observed engine tic.
    pub last_tic: u64,
    /// The starting player map-unit x.
    pub start_x: i64,
    /// The starting player map-unit y.
    pub start_y: i64,
    /// The last observed player map-unit x.
    pub last_x: i64,
    /// The last observed player map-unit y.
    pub last_y: i64,
    /// The exact final `level.kills` of the run (Spec #3053 ST-4).
    ///
    /// DEAD OBSERVABLE (Spec #3053 AC2 amendment, Option D): the pinned
    /// `neurodoom 0.6.7` never increments `PlayerState.kill_count`, so this is
    /// permanently `0`. Kept additive for observability; NOT an AC observable —
    /// never assert it non-zero and never re-target it in a later cycle.
    pub kills: i64,
    /// The engaged front enemy's hp on the first observation that had a `front`
    /// enemy (Spec #3053 AC2, re-scoped by the Option-D amendment), or `None`
    /// when the run never observed one.
    pub front_enemy_hp_start: Option<i64>,
    /// The minimum engaged front-enemy hp observed across the run (Spec #3053
    /// AC2, re-scoped), or `None` when the run never observed a `front` enemy.
    /// `floor < start` proves the companion's fire landed damage.
    pub front_enemy_hp_floor: Option<i64>,
    /// The terminal kind reached (`"dead"` / `"exited"`), or `None` when the
    /// step/failure budget ended the run first.
    pub terminal: Option<&'static str>,
}

impl DoomDriverReport {
    /// Whether the engine's tic counter advanced across the run.
    pub fn advanced(&self) -> bool {
        self.last_tic > self.start_tic
    }

    /// Whether the player's integer position changed across the run.
    pub fn moved(&self) -> bool {
        self.last_x != self.start_x || self.last_y != self.start_y
    }
}

/// The deterministic, engine-native autoplay driver (Spec #3023 ST-9; Spec
/// #3026 ST-3 extends it with the AC5 clock seam and the AC2 frame counters).
///
/// Constructs the session at `(episode=1, config.map, config.skill)` then runs
/// the SAME continuous loop the production host runs
/// ([`super::agent::run_continuous_loop`]) over the in-process adapter (no HTTP,
/// no model, no network), paced by the injected [`DoomTickClock`]. The decision
/// source is injected, so the existing scripted lever
/// ([`super::decision::ScriptedDecisionSource`] +
/// `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` + `FREDO_DOOM_AGENT_SCRIPT`)
/// reproduces a run deterministically; a [`super::clock::FixedTickClock`] makes
/// the replay a pure function of the iteration count (AC5 — no wall clock).
///
/// The framebuffer is fingerprinted after every step to count consecutive
/// DISTINCT (world-reflecting) frames — the AC2 assertion surface. Terminates on
/// the tick budget, the consecutive-failure budget, or a terminal observation
/// (death / level exit). Validation and terminal classification reuse the
/// production [`super::agent::validate_decision`] / [`super::agent::terminal_kind`],
/// so the driver can never drift from the loop.
pub async fn run_bounded_driver(
    state: &DoomEngineState,
    source: &dyn DoomDecisionSource,
    config: DoomDriverConfig,
    clock: &dyn DoomTickClock,
) -> Result<DoomDriverReport, DoomEngineError> {
    let info = state.launch(config.map, config.skill)?;

    // Play the resolved campaign coordinates; the driver never persists save
    // state (a no-op progress writer).
    let campaign = DoomCampaign {
        episode: 1,
        map: config.map,
        skill: config.skill,
        ..DoomCampaign::initial()
    };
    let run = AutoplayRun {
        campaign,
        progress: DoomProgressWriter::new(|_| Ok(())),
    };

    // The driver's `max_steps` bounds the continuous TICK budget: a step IS one
    // tick in the continuous loop, so the config seam keeps one meaning.
    let loop_config = DoomAutoplayConfig {
        max_steps: config.max_steps,
        max_ticks: config.max_steps,
        max_failures: config.max_failures,
        tick_period: Duration::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS),
        degraded_tick_period: Duration::from_millis(DOOM_DEGRADED_TICK_PERIOD_MS),
        stop_on_level_exit: config.stop_at_first_exit,
        combat_low_health: config.combat_low_health,
        ..DoomAutoplayConfig::default()
    };

    let engine = FrameCountingEngine::new(state.clone());
    let stop = AtomicBool::new(false);
    let mut last_status: Option<DoomAutoplayStatus> = None;

    let result = run_continuous_loop(
        &engine,
        source,
        &loop_config,
        clock,
        run,
        &stop,
        |status| {
            last_status = Some(status.clone());
        },
    )
    .await;

    let (decisions, failures) = last_status
        .as_ref()
        .map_or((0, 0), |status| (status.decisions, status.failures));
    let escapes = last_status.as_ref().map_or(0, |status| status.escapes);
    let counters = engine.lock();
    let first = counters.first.as_ref();
    let last = counters.last.as_ref();
    let start_tic = first.map_or(0, observation_tic);
    let (start_x, start_y) = first.map_or((0, 0), observation_position);
    let last_tic = last.map_or(start_tic, observation_tic);
    let (last_x, last_y) = last.map_or((start_x, start_y), observation_position);
    let terminal = last.and_then(super::agent::terminal_kind).map(terminal_label);
    let kills = last.map_or(0, observation_kills);
    let ticks = result.steps;
    let distinct_frames = counters.distinct_frames;
    let fps_estimate = if ticks == 0 {
        0.0
    } else {
        f64::from(distinct_frames) * f64::from(DOOM_CONTINUOUS_RATE_HZ) / f64::from(ticks)
    };

    Ok(DoomDriverReport {
        episode: info.episode,
        map: info.map,
        skill: info.skill,
        steps: ticks,
        ticks,
        distinct_frames,
        fps_estimate,
        decisions,
        escapes,
        failures,
        start_tic,
        last_tic,
        start_x,
        start_y,
        last_x,
        last_y,
        kills,
        front_enemy_hp_start: counters.front_enemy_hp_start,
        front_enemy_hp_floor: counters.front_enemy_hp_floor,
        terminal,
    })
}

/// The driver's frame-counting engine seam: it forwards every engine call to the
/// native adapter and, after each step, fingerprints the framebuffer to count
/// consecutive DISTINCT (world-reflecting) frames (AC2).
struct FrameCountingEngine {
    state: DoomEngineState,
    counters: Mutex<FrameCounters>,
}

/// The driver's accumulated counters + start/end observations.
#[derive(Default)]
struct FrameCounters {
    /// The previous step's framebuffer fingerprint (the first frame is NOT
    /// counted — distinctness is a consecutive-pair property).
    previous_fingerprint: Option<u64>,
    /// The number of consecutive DISTINCT frames seen so far.
    distinct_frames: u32,
    /// The first observation produced (post-positioning) — the run's start.
    first: Option<Value>,
    /// The most recent observation produced.
    last: Option<Value>,
    /// The engaged front enemy's hp on the first observation that had a `front`
    /// enemy (Spec #3053 AC2, re-scoped) — `None` when the run never observed one.
    front_enemy_hp_start: Option<i64>,
    /// The minimum engaged front-enemy hp observed across the run (Spec #3053 AC2,
    /// re-scoped) — `None` when the run never observed a `front` enemy.
    front_enemy_hp_floor: Option<i64>,
}

impl FrameCountingEngine {
    fn new(state: DoomEngineState) -> Self {
        Self {
            state,
            counters: Mutex::new(FrameCounters::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FrameCounters> {
        self.counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record_observation(&self, observation: &Value) {
        let mut counters = self.lock();
        if counters.first.is_none() {
            counters.first = Some(observation.clone());
        }
        counters.last = Some(observation.clone());
        record_front_enemy_hp(&mut counters, observation);
    }

    fn record_frame(&self, observation: &Value, frame: &[u8]) {
        let fingerprint = frame_fingerprint(frame);
        let mut counters = self.lock();
        if counters
            .previous_fingerprint
            .is_some_and(|previous| previous != fingerprint)
        {
            counters.distinct_frames = counters.distinct_frames.saturating_add(1);
        }
        counters.previous_fingerprint = Some(fingerprint);
        if counters.first.is_none() {
            counters.first = Some(observation.clone());
        }
        counters.last = Some(observation.clone());
        record_front_enemy_hp(&mut counters, observation);
    }
}

/// Fold the engaged front enemy's hp into the run tracker (Spec #3053 AC2,
/// re-scoped). The tracked entry is the FIRST-listed `enemies[]` element with
/// `direction == "front"` — the SAME rule `combat::combat_target` uses to fire
/// (`combat.rs:187-198`). `enemies[]` carries no id (`engine.rs:1260-1280`), so
/// identity is per-observation by `(kind, direction)`.
fn record_front_enemy_hp(counters: &mut FrameCounters, observation: &Value) {
    let Some(hp) = observation
        .get("enemies")
        .and_then(Value::as_array)
        .and_then(|enemies| {
            enemies.iter().find(|enemy| {
                enemy.get("direction").and_then(Value::as_str) == Some("front")
            })
        })
        .and_then(|front| front.get("hp"))
        .and_then(Value::as_i64)
    else {
        return;
    };
    counters.front_enemy_hp_start.get_or_insert(hp);
    counters.front_enemy_hp_floor = Some(counters.front_enemy_hp_floor.map_or(hp, |floor| floor.min(hp)));
}

#[async_trait]
impl DoomAutoplayEngine for FrameCountingEngine {
    async fn read_state(&self) -> Result<Value, DoomEngineError> {
        let state = self.state.clone();
        let observation = run_engine_task(move || state.read_state()).await?;
        self.record_observation(&observation);
        Ok(observation)
    }

    async fn step(&self, tics: i64, actions: &Value) -> Result<Value, DoomEngineError> {
        let state = self.state.clone();
        let actions = actions.clone();
        let observation = run_engine_task(move || state.step(tics, &actions)).await?;
        let frame_state = self.state.clone();
        let frame = run_engine_task(move || frame_state.frame_rgba()).await?;
        self.record_frame(&observation, &frame);
        Ok(observation)
    }

    async fn reset(&self, episode: i64, map: i64, skill: i64) -> Result<Value, DoomEngineError> {
        let state = self.state.clone();
        let observation = run_engine_task(move || state.reset(episode, map, skill)).await?;
        self.record_observation(&observation);
        Ok(observation)
    }
}

/// A stable 64-bit FNV-1a fingerprint of a framebuffer (AC2 distinctness).
/// Deterministic across runs and processes (never a randomly-seeded hasher).
fn frame_fingerprint(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Run one synchronous native engine call on the blocking pool (the driver's
/// copy of the loop's blocking seam).
async fn run_engine_task<T>(
    task: impl FnOnce() -> Result<T, DoomEngineError> + Send + 'static,
) -> Result<T, DoomEngineError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .unwrap_or_else(|join_error| {
            Err(DoomEngineError::new(
                DoomEngineErrorCode::EngineStartFailed,
                format!("the Doom engine task failed: {join_error}"),
            ))
        })
}

/// The engine tic of an observation, or `0` when absent.
fn observation_tic(observation: &Value) -> u64 {
    observation.get("tic").and_then(Value::as_u64).unwrap_or(0)
}

/// The player's integer map-unit `(x, y)` from an observation, or `(0, 0)`.
fn observation_position(observation: &Value) -> (i64, i64) {
    let x = observation
        .pointer("/player/x")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let y = observation
        .pointer("/player/y")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    (x, y)
}

/// The exact `level.kills` of an observation, or `0` when absent/malformed
/// (Spec #3053 ST-4). The engine builds `level.kills` from its `kill_count`,
/// which the pinned `neurodoom 0.6.7` never increments — so this is permanently
/// `0` (DEAD OBSERVABLE, Spec #3053 AC2 amendment, Option D).
fn observation_kills(observation: &Value) -> i64 {
    observation
        .pointer("/level/kills")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// The stable label for a terminal observation (`"dead"` / `"exited"`).
fn terminal_label(kind: super::agent::TerminalKind) -> &'static str {
    match kind {
        super::agent::TerminalKind::Death => "dead",
        super::agent::TerminalKind::Exit => "exited",
    }
}

// ── Action translation (existing vocabulary → PlayerAction) ───────────────────

/// One parsed action object from the existing vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActionSpec {
    /// Hold forward for `amount` tics.
    Forward { amount: i64 },
    /// Hold backward for `amount` tics.
    Backward { amount: i64 },
    /// Hold strafe-left for `amount` tics.
    StrafeLeft { amount: i64 },
    /// Hold strafe-right for `amount` tics.
    StrafeRight { amount: i64 },
    /// Hold turn-left for `amount` tics.
    TurnLeft { amount: i64 },
    /// Hold turn-right for `amount` tics.
    TurnRight { amount: i64 },
    /// Face an absolute map angle (0-359); the adapter servos toward it.
    TurnTo { angle: i64 },
    /// Hold the run modifier for `amount` tics.
    Run { amount: i64 },
    /// Hold fire for `amount` tics.
    Shoot { amount: i64 },
    /// Press use (resolved on the first held tic).
    Use,
    /// Select weapon slot 1-8.
    SwitchWeapon { slot: i64 },
}

/// Parse an `actions` array from the existing vocabulary. Malformed/unknown
/// entries are skipped (never a panic).
fn parse_actions(actions: &Value) -> Vec<ActionSpec> {
    let mut specs = Vec::new();
    let Some(entries) = actions.as_array() else {
        return specs;
    };
    for entry in entries {
        let Some(action) = entry.get("type").and_then(Value::as_str) else {
            continue;
        };
        let amount = entry
            .get("amount")
            .and_then(Value::as_i64)
            .unwrap_or(DOOM_ACTION_AMOUNT_DEFAULT)
            .max(0);
        let spec = match action {
            DOOM_ACTION_FORWARD => ActionSpec::Forward { amount },
            DOOM_ACTION_BACKWARD => ActionSpec::Backward { amount },
            DOOM_ACTION_STRAFE_LEFT => ActionSpec::StrafeLeft { amount },
            DOOM_ACTION_STRAFE_RIGHT => ActionSpec::StrafeRight { amount },
            DOOM_ACTION_TURN_LEFT => ActionSpec::TurnLeft { amount },
            DOOM_ACTION_TURN_RIGHT => ActionSpec::TurnRight { amount },
            DOOM_ACTION_TURN_TO => ActionSpec::TurnTo {
                angle: entry
                    .get("angle")
                    .and_then(Value::as_i64)
                    .unwrap_or(DOOM_ACTION_ANGLE_MIN)
                    .clamp(DOOM_ACTION_ANGLE_MIN, DOOM_ACTION_ANGLE_MAX),
            },
            DOOM_ACTION_RUN => ActionSpec::Run { amount },
            DOOM_ACTION_SHOOT => ActionSpec::Shoot { amount },
            DOOM_ACTION_USE => ActionSpec::Use,
            DOOM_ACTION_SWITCH_WEAPON => ActionSpec::SwitchWeapon {
                slot: amount.clamp(DOOM_ACTION_WEAPON_SLOT_MIN, DOOM_ACTION_WEAPON_SLOT_MAX),
            },
            _ => continue,
        };
        specs.push(spec);
    }
    specs
}

/// Build the [`PlayerAction`] for tic `tic` from the parsed specs.
///
/// Movement actions are holds: they apply while `tic < amount`. The run
/// modifier raises the movement magnitude; `turn-to` servos toward the target
/// using the *current* facing (read live each tic). Button actions set the
/// corresponding bit for their held window; `use` is applied on the first tic.
fn build_player_action(specs: &[ActionSpec], tic: i64, current_angle: Angle) -> PlayerAction {
    let mut forward: i32 = 0;
    let mut side: i32 = 0;
    let mut turn: i32 = 0;
    let mut running = false;
    let mut buttons = Buttons::empty();
    let mut weapon_select: u8 = 0;
    let mut turn_to: Option<i64> = None;

    for spec in specs {
        match *spec {
            ActionSpec::Run { amount } if tic < amount => running = true,
            ActionSpec::Forward { amount } if tic < amount => forward += 1,
            ActionSpec::Backward { amount } if tic < amount => forward -= 1,
            ActionSpec::StrafeLeft { amount } if tic < amount => side -= 1,
            ActionSpec::StrafeRight { amount } if tic < amount => side += 1,
            ActionSpec::TurnLeft { amount } if tic < amount => turn += 1,
            ActionSpec::TurnRight { amount } if tic < amount => turn -= 1,
            ActionSpec::Shoot { amount } if tic < amount => {
                buttons.insert(Button::Attack);
            }
            ActionSpec::Use if tic == 0 => {
                buttons.insert(Button::Use);
            }
            ActionSpec::SwitchWeapon { slot } => weapon_select = slot as u8,
            ActionSpec::TurnTo { angle } => turn_to = Some(angle),
            _ => {}
        }
    }

    let forward_magnitude = if running {
        DOOM_FORWARD_RUN
    } else {
        DOOM_FORWARD_WALK
    };
    let side_magnitude = if running {
        DOOM_SIDE_RUN
    } else {
        DOOM_SIDE_WALK
    };
    let forward_move = (forward.clamp(-1, 1) as i8).saturating_mul(forward_magnitude);
    let side_move = (side.clamp(-1, 1) as i8).saturating_mul(side_magnitude);
    let angle_turn = match turn_to {
        Some(target) => turn_toward(current_angle, target),
        None => turn.clamp(-1, 1).saturating_mul(i32::from(DOOM_TURN_PER_TIC)) as i16,
    };

    PlayerAction {
        forward_move,
        side_move,
        angle_turn,
        buttons,
        weapon_select,
    }
}

/// The bounded per-tic turn (in [`PlayerAction::angle_turn`] units) toward an
/// absolute map angle in degrees (0-359).
fn turn_toward(current: Angle, target_degrees: i64) -> i16 {
    let degrees = target_degrees.rem_euclid(360) as u64;
    let target = ((degrees * (1u64 << 32)) / 360) as u32;
    let delta = target.wrapping_sub(current) as i32;
    let units = delta >> FRACBITS;
    units.clamp(-i32::from(DOOM_TURN_PER_TIC), i32::from(DOOM_TURN_PER_TIC)) as i16
}

// ── Observation (the parity contract) ─────────────────────────────────────────

/// The `FREDO_DOOM_FORCE_EXIT` AC4 exit-induction lever (Spec #3031 ST-2). When
/// set to `1`, [`observation`] reports the terminal level exit once the engine
/// has advanced at least [`DOOM_FORCE_EXIT_AFTER_TICS`] tics, so the loop's real
/// terminal path (`agent::run_continuous_loop`) is drivable on the REAL engine.
/// Inert when unset, so the production observation is byte-identical.
pub const DOOM_FORCE_EXIT_ENV: &str = "FREDO_DOOM_FORCE_EXIT";

/// The engine-tic threshold at which [`DOOM_FORCE_EXIT_ENV`] reports the exit.
pub const DOOM_FORCE_EXIT_AFTER_TICS: u32 = 1;

/// The `FREDO_DOOM_FORCE_EXIT` lever: `true` iff set to `"1"`.
pub fn force_exit_requested() -> bool {
    force_exit_from(std::env::var(DOOM_FORCE_EXIT_ENV).ok().as_deref())
}

/// Pure parser for the AC4 lever (unit-testable without env mutation).
pub fn force_exit_from(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

/// Whether the force-exit lever should report the terminal exit at `tick`:
/// `true` iff the lever is on AND the engine has reached
/// [`DOOM_FORCE_EXIT_AFTER_TICS`].
pub fn forced_exit_at(force_exit: bool, tick: u64) -> bool {
    force_exit && tick >= u64::from(DOOM_FORCE_EXIT_AFTER_TICS)
}

/// The `FREDO_DOOM_INJECT_OBSERVATION` AC3 induction lever (Spec #3039 ST-2).
/// When set to a JSON object, [`observation`] top-level-merges that object into
/// the observation before the executor/model sees it — so the tester can drive a
/// `front` enemy, a `closing` door, or any re-plan trigger live against the real
/// engine. Inert when unset (production is byte-identical); mirrors
/// [`DOOM_FORCE_EXIT_ENV`] / [`super::perception::DOOM_FAIL_PERCEPTION_ENV`].
pub const DOOM_INJECT_OBSERVATION_ENV: &str = "FREDO_DOOM_INJECT_OBSERVATION";

/// The `FREDO_DOOM_INJECT_OBSERVATION` lever: the JSON object to merge, or `None`
/// when unset, blank, or not a JSON object (inert / never fatal).
pub fn injected_observation() -> Option<Value> {
    inject_observation_from(std::env::var(DOOM_INJECT_OBSERVATION_ENV).ok().as_deref())
}

/// Pure parser for the AC3 inject lever (unit-testable without env mutation).
/// Returns the object only when the value parses to a JSON object; anything else
/// (unset, blank, a bare scalar/array, malformed JSON) is inert.
pub fn inject_observation_from(value: Option<&str>) -> Option<Value> {
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(object @ Value::Object(_)) => Some(object),
        _ => None,
    }
}

/// Build the parity observation for a session (see the module docs). The
/// [`DOOM_FORCE_EXIT_ENV`] and [`DOOM_INJECT_OBSERVATION_ENV`] levers are read
/// here (inert when unset).
fn observation(session: &DoomSession) -> Value {
    observation_with(session, force_exit_requested(), injected_observation().as_ref())
}

/// Deterministic form of [`observation`] (mirrors [`super::perception`]'s
/// injectable seam): the force-exit and inject levers are inputs, so the AC4
/// terminal branch and the AC3 induction seam are unit-testable without mutating
/// process-global env (G-222).
fn observation_with(session: &DoomSession, force_exit: bool, inject: Option<&Value>) -> Value {
    let engine = &session.engine;
    let world = engine.world();
    let map = engine.map();
    let tick = u64::from(world.tick);
    // AC4 exit-induction lever (inert unless `FREDO_DOOM_FORCE_EXIT=1`): once the
    // engine has advanced past DOOM_FORCE_EXIT_AFTER_TICS, report the terminal
    // level exit so the loop's real terminal path is drivable.
    let done = engine.level_complete() || forced_exit_at(force_exit, tick);

    let player_id = world.controlled_by(LOCAL_PEER);
    let player = player_id.and_then(|eid| world.get(eid));
    let player_state = player_id.and_then(|eid| world.player_state(eid));

    let (px, py, health, angle) = player
        .map(|e| (e.x, e.y, e.health, e.angle))
        .unwrap_or((0, 0, 0, 0));
    let armor = player_state.map(|ps| ps.armor_points).unwrap_or(0);
    let kills = player_state.map(|ps| ps.kill_count).unwrap_or(0);
    let items = player_state.map(|ps| ps.item_count).unwrap_or(0);
    let secrets = player_state.map(|ps| ps.secret_count).unwrap_or(0);
    let weapon = player_state
        .map(|ps| weapon_name(ps.ready_weapon))
        .unwrap_or("none");
    // Additive weapon-set projection (Spec #3054 ST-1 / AC3): the owned-weapon
    // flags in slot order, via the retained `weapon_name` vocabulary. Baseline
    // `["fist","pistol"]`. `player.weapon` (the ready weapon) is untouched.
    let weapons = player_state
        .map(|ps| weapon_set(&ps.weapon_owned))
        .unwrap_or_default();
    let ammo = |kind: AmmoType| {
        player_state
            .and_then(|ps| ps.ammo.get(kind as usize).copied())
            .unwrap_or(0)
    };

    let outcome = if player.is_some() && health <= 0 {
        "dead"
    } else if done {
        "exited"
    } else {
        "alive"
    };

    let eye_z = player
        .map(|e| e.z + e.height - (e.height >> 2))
        .unwrap_or(0);

    // The additive `forward` sensor (AC1): per-ray distance+class + bounded
    // openings + door bearings + exit bearing, over the same semantic/depth
    // bridge as `walls`. The engine supplies the LOS-gated enemy bearings, the
    // door bearings, and the exit bearing; the projection itself is pure.
    let enemy_bearings = enemy_bearings(world, map, px, py, eye_z, angle, player_id);
    let door_bearings = door_bearings(world, map, px, py, angle);
    let exit_bearing = exit_bearing(map, px, py);

    let mut observation = json!({
        "tic": tick,
        "done": done,
        "outcome": outcome,
        "level": {
            "episode": session.episode,
            "map": session.map,
            "skill": session.skill,
            "kills": kills,
            "items": items,
            "secrets": secrets,
            "itemsCollected": session.items_collected,
        },
        "player": {
            "x": fixed_to_units(px),
            "y": fixed_to_units(py),
            "angle": angle_to_degrees(angle),
            "health": health,
            "armor": armor,
            "ammo": {
                "bullets": ammo(AmmoType::Bullets),
                "shells": ammo(AmmoType::Shells),
                "rockets": ammo(AmmoType::Rockets),
                "cells": ammo(AmmoType::Cells),
            },
            "weapon": weapon,
            "weapons": weapons,
        },
        "enemies": enemies(world, map, px, py, eye_z, angle, player_id),
        "items": items_observation(world, px, py, angle, player_id),
        "doors": doors(world, map, px, py, angle),
        "exit": exit_observation(map, px, py),
        "walls": perception::walls_observation(perception::perception_frame(engine).as_ref()),
        "forward": perception::forward_observation(
            perception::perception_frame(engine).as_ref(),
            &enemy_bearings,
            &door_bearings,
            exit_bearing,
        ),
    });

    // AC3 induction seam (inert unless `FREDO_DOOM_INJECT_OBSERVATION` is set):
    // top-level-merge the tester's patch so a re-plan trigger is drivable live.
    if let Some(patch) = inject {
        merge_observation(&mut observation, patch);
    }
    observation
}

/// Top-level merge of a tester-injected patch into the observation (the
/// [`DOOM_INJECT_OBSERVATION_ENV`] AC3 induction seam). Each top-level key of
/// `patch` replaces the corresponding observation key.
fn merge_observation(observation: &mut Value, patch: &Value) {
    if let (Some(target), Some(source)) = (observation.as_object_mut(), patch.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

/// One LOS-gated visible enemy (the single extraction rule shared by the
/// `enemies` observation and the `forward` sensor's enemy bearings).
struct VisibleEnemy {
    kind: String,
    hp: i32,
    direction: &'static str,
    distance: i64,
}

/// The bounded, LOS-gated visible-enemy list — one extraction rule (the
/// `enemies` observation and the `forward` enemy bearings both consume this).
fn visible_enemies(
    world: &neurodoom::world::World,
    map: &MapData,
    px: Fixed,
    py: Fixed,
    eye_z: Fixed,
    angle: Angle,
    player_id: Option<neurodoom::world::EntityId>,
) -> Vec<VisibleEnemy> {
    let mut out = Vec::new();
    for entity in world.iter() {
        if Some(entity.id) == player_id
            || !entity.flags.contains(MobjFlag::Shootable)
            || !entity.flags.contains(MobjFlag::CountKill)
            || entity.health <= 0
        {
            continue;
        }
        if !neurodoom::physics::check_sight(
            map, px, py, eye_z, entity.x, entity.y, entity.z, entity.height,
        ) {
            continue;
        }
        out.push(VisibleEnemy {
            kind: entity_kind(entity),
            hp: entity.health,
            direction: relative_direction(px, py, angle, entity.x, entity.y),
            distance: distance_units(entity.x - px, entity.y - py),
        });
        if out.len() >= OBSERVATION_MAX_ENTRIES {
            break;
        }
    }
    out
}

/// The LOS-gated enemy list (direction/distance/hp), bounded.
fn enemies(
    world: &neurodoom::world::World,
    map: &MapData,
    px: Fixed,
    py: Fixed,
    eye_z: Fixed,
    angle: Angle,
    player_id: Option<neurodoom::world::EntityId>,
) -> Vec<Value> {
    visible_enemies(world, map, px, py, eye_z, angle, player_id)
        .into_iter()
        .map(|enemy| {
            json!({
                "kind": enemy.kind,
                "hp": enemy.hp,
                "direction": enemy.direction,
                "distance": enemy.distance,
            })
        })
        .collect()
}

/// The LOS-gated enemy bearings for the `forward` sensor (same rule as
/// [`enemies`], reduced to the sensor's direction/distance pair).
fn enemy_bearings(
    world: &neurodoom::world::World,
    map: &MapData,
    px: Fixed,
    py: Fixed,
    eye_z: Fixed,
    angle: Angle,
    player_id: Option<neurodoom::world::EntityId>,
) -> Vec<perception::EnemyBearing> {
    visible_enemies(world, map, px, py, eye_z, angle, player_id)
        .into_iter()
        .map(|enemy| perception::EnemyBearing {
            direction: enemy.direction,
            distance: enemy.distance,
        })
        .collect()
}

/// The nearby pickups list (direction/distance), bounded.
fn items_observation(
    world: &neurodoom::world::World,
    px: Fixed,
    py: Fixed,
    angle: Angle,
    player_id: Option<neurodoom::world::EntityId>,
) -> Vec<Value> {
    let mut out = Vec::new();
    for entity in world.iter() {
        if Some(entity.id) == player_id || !entity.flags.contains(MobjFlag::Special) {
            continue;
        }
        out.push(json!({
            "kind": entity_kind(entity),
            "direction": relative_direction(px, py, angle, entity.x, entity.y),
            "distance": distance_units(entity.x - px, entity.y - py),
        }));
        if out.len() >= OBSERVATION_MAX_ENTRIES {
            break;
        }
    }
    out
}

/// The interactable door/switch list (state/distance), bounded.
fn doors(world: &neurodoom::world::World, map: &MapData, px: Fixed, py: Fixed, angle: Angle) -> Vec<Value> {
    let mut out = Vec::new();
    for thinker in &world.specials {
        let SpecialThinker::Door(door) = thinker else {
            continue;
        };
        let state = match door.direction {
            DoorDirection::Opening => "opening",
            DoorDirection::Waiting => "waiting",
            DoorDirection::Closing => "closing",
        };
        let (distance, direction) = door_distance_and_direction(map, door.sector, px, py, angle);
        out.push(json!({
            "kind": "door",
            "state": state,
            "direction": direction,
            "distance": distance,
        }));
        if out.len() >= OBSERVATION_MAX_ENTRIES {
            break;
        }
    }
    out
}

/// The nearest exit-line vertex as `(distance_units, x, y)`, or `None`.
fn nearest_exit_vertex(map: &MapData, px: Fixed, py: Fixed) -> Option<(i64, Fixed, Fixed)> {
    let mut best: Option<(i64, Fixed, Fixed)> = None;
    for line in &map.lines {
        if !is_exit_line(line.special) {
            continue;
        }
        for vertex_id in [line.v1, line.v2] {
            let Some(vertex) = map.vertexes.get(vertex_id as usize) else {
                continue;
            };
            let distance = distance_units(vertex.x - px, vertex.y - py);
            if best.is_none_or(|(previous, _, _)| distance < previous) {
                best = Some((distance, vertex.x, vertex.y));
            }
        }
    }
    best
}

/// The optional exit-distance observation: the nearest exit-line vertex in
/// integer map units, or an empty object when no exit line is reachable.
fn exit_observation(map: &MapData, px: Fixed, py: Fixed) -> Value {
    match nearest_exit_vertex(map, px, py) {
        Some((distance, _, _)) => json!({ "distance": distance }),
        None => json!({}),
    }
}

/// The nearest exit line as the `forward` sensor's `exitBearing` input
/// (absolute bearing `0..=359` + distance), or `None` when no exit is reachable.
fn exit_bearing(map: &MapData, px: Fixed, py: Fixed) -> Option<perception::ExitBearing> {
    nearest_exit_vertex(map, px, py).map(|(distance, vx, vy)| perception::ExitBearing {
        bearing: angle_to_degrees(point_to_angle(vx - px, vy - py)),
        distance,
    })
}

/// The nearest door-sector vertex as `(distance_units, x, y)`, or `None`.
fn nearest_door_vertex(
    map: &MapData,
    sector: SectorId,
    px: Fixed,
    py: Fixed,
) -> Option<(i64, Fixed, Fixed)> {
    let mut best: Option<(i64, Fixed, Fixed)> = None;
    for line in &map.lines {
        if line.front_sector != sector && line.back_sector != Some(sector) {
            continue;
        }
        for vertex_id in [line.v1, line.v2] {
            let Some(vertex) = map.vertexes.get(vertex_id as usize) else {
                continue;
            };
            let distance = distance_units(vertex.x - px, vertex.y - py);
            if best.is_none_or(|(previous, _, _)| distance < previous) {
                best = Some((distance, vertex.x, vertex.y));
            }
        }
    }
    best
}

/// The nearest door-sector vertex, as `(distance_in_units, direction)`.
fn door_distance_and_direction(
    map: &MapData,
    sector: SectorId,
    px: Fixed,
    py: Fixed,
    angle: Angle,
) -> (i64, &'static str) {
    match nearest_door_vertex(map, sector, px, py) {
        Some((distance, vx, vy)) => (distance, relative_direction(px, py, angle, vx, vy)),
        None => (0, "front"),
    }
}

/// The nearest door-sector vertex, as `(distance_in_units, relative_bearing)`.
fn door_distance_and_bearing(
    map: &MapData,
    sector: SectorId,
    px: Fixed,
    py: Fixed,
    angle: Angle,
) -> (i64, i64) {
    match nearest_door_vertex(map, sector, px, py) {
        Some((distance, vx, vy)) => (distance, relative_bearing_degrees(px, py, angle, vx, vy)),
        None => (0, 0),
    }
}

/// The engine's doors as the `forward` sensor's `doorBearings` input (state +
/// relative bearing + distance), bounded.
fn door_bearings(
    world: &neurodoom::world::World,
    map: &MapData,
    px: Fixed,
    py: Fixed,
    angle: Angle,
) -> Vec<perception::DoorBearing> {
    let mut out = Vec::new();
    for thinker in &world.specials {
        let SpecialThinker::Door(door) = thinker else {
            continue;
        };
        let state = match door.direction {
            DoorDirection::Opening => "opening",
            DoorDirection::Waiting => "waiting",
            DoorDirection::Closing => "closing",
        };
        let (distance, bearing) = door_distance_and_bearing(map, door.sector, px, py, angle);
        out.push(perception::DoorBearing {
            bearing,
            distance,
            state,
        });
        if out.len() >= perception::DOOM_SENSOR_MAX_DOORS {
            break;
        }
    }
    out
}

// ── Pure observation helpers ──────────────────────────────────────────────────

/// Convert a 16.16 `Fixed` to integer map units (the autoplay `is_progress`
/// compares integers).
fn fixed_to_units(value: Fixed) -> i64 {
    i64::from(value >> FRACBITS)
}

/// BAM `Angle` → integer degrees (0-359).
fn angle_to_degrees(angle: Angle) -> i64 {
    i64::from(((u64::from(angle) * 360) >> 32) as u32)
}

/// Approximate map-unit distance (Manhattan, converted from 16.16).
fn distance_units(dx: Fixed, dy: Fixed) -> i64 {
    let sum = u64::from(dx.unsigned_abs()) + u64::from(dy.unsigned_abs());
    (sum >> FRACBITS) as i64
}

/// Bucket a target's bearing relative to the player's facing into
/// `front` / `left` / `back` / `right`.
fn relative_direction(px: Fixed, py: Fixed, angle: Angle, tx: Fixed, ty: Fixed) -> &'static str {
    if tx == px && ty == py {
        return "front";
    }
    let to_target = point_to_angle(tx - px, ty - py);
    let relative = to_target.wrapping_sub(angle);
    let degrees = ((u64::from(relative) * 360) >> 32) as i64;
    if !(45..=315).contains(&degrees) {
        "front"
    } else if degrees < 135 {
        "left"
    } else if degrees < 225 {
        "back"
    } else {
        "right"
    }
}

/// A target's bearing relative to the player's facing, in degrees normalized to
/// `-180..=180` (the `forward.doorBearings` vocabulary).
fn relative_bearing_degrees(px: Fixed, py: Fixed, angle: Angle, tx: Fixed, ty: Fixed) -> i64 {
    if tx == px && ty == py {
        return 0;
    }
    let to_target = point_to_angle(tx - px, ty - py);
    let relative = to_target.wrapping_sub(angle);
    let degrees = ((u64::from(relative) * 360) >> 32) as i64; // 0..=359
    if degrees > 180 {
        degrees - 360
    } else {
        degrees
    }
}

/// The weapon types in CLASSIC SLOT ORDER (Spec #3054 ST-1), paired index-for-
/// index with `PlayerState.weapon_owned` (slot `i` ⇒ `weapon_owned[i]`). The
/// wire names come from [`weapon_name`]; baseline `[true,true,false×7]` ⇒
/// `["fist","pistol"]`.
const WEAPON_SLOTS: [WeaponType; 9] = [
    WeaponType::Fist,
    WeaponType::Pistol,
    WeaponType::Shotgun,
    WeaponType::Chaingun,
    WeaponType::RocketLauncher,
    WeaponType::PlasmaRifle,
    WeaponType::Bfg,
    WeaponType::Chainsaw,
    WeaponType::SuperShotgun,
];

/// Project the owned-weapon flags to the wire vocabulary, in slot order
/// (Spec #3054 ST-1 / AC3). Slot `i` ⇒ `owned[i]` ⇒ `WEAPON_SLOTS[i]`; a `false`
/// slot is omitted. Pure — the only source is the owned flags.
fn weapon_set(owned: &[bool]) -> Vec<&'static str> {
    owned
        .iter()
        .enumerate()
        .filter(|(_, held)| **held)
        .filter_map(|(slot, _)| WEAPON_SLOTS.get(slot).copied())
        .map(weapon_name)
        .collect()
}

/// The stable wire name for a weapon type.
fn weapon_name(weapon: WeaponType) -> &'static str {
    match weapon {
        WeaponType::Fist => "fist",
        WeaponType::Pistol => "pistol",
        WeaponType::Shotgun => "shotgun",
        WeaponType::Chaingun => "chaingun",
        WeaponType::RocketLauncher => "rocket-launcher",
        WeaponType::PlasmaRifle => "plasma-rifle",
        WeaponType::Bfg => "bfg",
        WeaponType::Chainsaw => "chainsaw",
        WeaponType::SuperShotgun => "super-shotgun",
    }
}

/// A human-readable entity kind. Derived deterministically from the entity's
/// sprite name (`SPRNAMES[entity.sprite]`), with a friendly name for the
/// classic E1 cast; falls back to the lowercased sprite name.
fn entity_kind(entity: &Entity) -> String {
    let sprite = SPRNAMES
        .get(entity.sprite.0 as usize)
        .copied()
        .unwrap_or("unknown");
    friendly_kind(sprite)
        .map(str::to_string)
        .unwrap_or_else(|| sprite.to_ascii_lowercase())
}

/// Map a classic sprite name to a friendly kind, or `None` when unmapped.
fn friendly_kind(sprite: &str) -> Option<&'static str> {
    Some(match sprite {
        // Monsters
        "TROO" => "imp",
        "POSS" => "zombieman",
        "SPOS" => "shotgun-guy",
        "SARG" => "demon",
        "HEAD" => "cacodemon",
        "BOSS" => "baron",
        "BOS2" => "hell-knight",
        "SKUL" => "lost-soul",
        "PAIN" => "pain-elemental",
        "CPOS" => "chaingunner",
        "VILE" => "arch-vile",
        "FATT" => "mancubus",
        "SKEL" => "revenant",
        "SPID" | "BSPI" => "spider-mastermind",
        "CYBR" => "cyberdemon",
        // Items — health & armor
        "STIM" => "stimpack",
        "MEDI" => "medikit",
        "BON1" => "health-bonus",
        "BON2" => "armor-bonus",
        "ARM1" => "green-armor",
        "ARM2" => "blue-armor",
        "SOUL" => "soulsphere",
        "MEGA" => "megaarmor",
        "PSTR" => "berserk",
        "PINV" => "invulnerability",
        "SUIT" => "radiation-suit",
        "PMAP" => "computer-map",
        "PVIS" => "light-visor",
        // Items — ammo
        "CLIP" => "clip",
        "AMMO" => "box-of-bullets",
        "SHEL" => "shells",
        "SBOX" => "shell-box",
        "ROCK" => "rocket",
        "BROK" => "rocket-box",
        "CELL" => "cell",
        "CELP" => "cell-pack",
        "BPAK" => "backpack",
        // Items — weapons
        "SHOT" => "shotgun",
        "MGUN" => "chaingun",
        "LAUN" => "rocket-launcher",
        "PLAS" => "plasma-rifle",
        "BFUG" => "bfg",
        "CSAW" => "chainsaw",
        // Items — keys
        "BKEY" => "blue-keycard",
        "RKEY" => "red-keycard",
        "YKEY" => "yellow-keycard",
        "BSKU" => "blue-skull",
        "RSKU" => "red-skull",
        "YSKU" => "yellow-skull",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::doom::clock::{FixedTickClock, DOOM_MIN_SMOOTH_FPS};
    use crate::applications::doom::decision::ScriptedDecisionSource;
    use neurodoom::math::FRACUNIT;

    fn temp_wad_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    // ── The crux: the native engine really runs E1M1 ─────────────────────────

    #[test]
    fn the_native_engine_really_runs_and_plays_e1m1() {
        let wad = load_wad_from(None).expect("the embedded DOOM1.WAD loads");
        let mut engine = ClassicEngine::new(&wad, "E1M1").expect("E1M1 constructs from DOOM1.WAD");

        let player_id = engine
            .world()
            .controlled_by(LOCAL_PEER)
            .expect("E1M1 spawns a player start");
        let (start_x, start_y) = {
            let player = engine.world().get(player_id).expect("player entity");
            (player.x, player.y)
        };

        engine.render_for(LOCAL_PEER);
        let framebuffer = engine.framebuffer();
        assert_eq!(framebuffer.len(), FRAME_BYTES, "320x200 RGBA framebuffer");
        assert!(
            framebuffer.iter().any(|byte| *byte != 0),
            "the rendered frame is not all-zero (real WAD pixels)"
        );

        let start_tic = engine.world().tick;
        for _ in 0..10 {
            engine.simulate(
                &[(
                    LOCAL_PEER,
                    PlayerAction {
                        forward_move: DOOM_FORWARD_WALK,
                        ..PlayerAction::default()
                    },
                )],
                &[],
            );
        }
        assert!(
            engine.world().tick > start_tic,
            "the engine advances its tic counter (step-driven)"
        );
        let moved = engine.world().get(player_id).expect("player still alive");
        assert!(
            moved.x != start_x || moved.y != start_y,
            "the player actually moved after 10 forward tics"
        );
    }

    // ── The adapter over the engine ──────────────────────────────────────────

    #[test]
    fn launch_read_state_and_frame_emit_the_contract() {
        let state = DoomEngineState::default();
        let info = state.launch(1, 3).expect("launch");
        assert_eq!(info.episode, 1);
        assert_eq!(info.map, 1);
        assert_eq!(info.skill, 3);
        assert!(state.is_running());

        // Idempotent exactly-one: a second launch reuses the live session.
        let again = state.launch(1, 3).expect("idempotent launch");
        assert_eq!(again, info);

        let observation = state.read_state().expect("read_state");
        assert_eq!(observation["level"]["episode"], 1);
        assert_eq!(observation["level"]["map"], 1);
        assert_eq!(observation["outcome"], "alive");
        assert_eq!(observation["done"], false);
        assert!(observation["tic"].as_u64().is_some());
        assert_eq!(observation["player"]["health"], 100);
        assert_eq!(observation["player"]["ammo"]["bullets"], 50);
        assert!(observation["player"]["x"].as_i64().is_some());
        assert!(observation["player"]["y"].as_i64().is_some());
        assert!(observation["enemies"].is_array());
        assert!(observation["items"].is_array());
        assert!(observation["doors"].is_array());

        let frame = state.frame_rgba().expect("frame_rgba");
        assert_eq!(frame.len(), 320 * 200 * 4, "raw RGBA 320x200x4");
        assert!(
            !frame.starts_with(b"\x89PNG\r\n\x1a\n"),
            "the frame is raw RGBA, never PNG"
        );
        // After a step the framebuffer is rendered (real WAD pixels) and differs
        // from the pre-render buffer.
        state
            .step(1, &json!([{ "type": "forward" }]))
            .expect("step");
        let rendered = state.frame_rgba().expect("frame_rgba");
        assert_eq!(rendered.len(), 320 * 200 * 4);
        assert!(
            rendered.iter().any(|byte| *byte != 0),
            "the rendered frame is not all-zero (real WAD pixels)"
        );
        assert_ne!(rendered, frame, "the framebuffer changed after a step");
    }

    #[test]
    fn step_advances_the_tic_and_moves_the_player() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        let before = state.read_state().expect("state");
        let after = state
            .step(10, &json!([{ "type": "forward" }]))
            .expect("step");

        let before_tic = before["tic"].as_u64().expect("tic");
        let after_tic = after["tic"].as_u64().expect("tic");
        assert!(after_tic > before_tic, "tic strictly increases");

        let moved_x = before["player"]["x"].as_i64() != after["player"]["x"].as_i64();
        let moved_y = before["player"]["y"].as_i64() != after["player"]["y"].as_i64();
        assert!(moved_x || moved_y, "the player moved");
    }

    #[test]
    fn reset_loads_the_requested_level() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        let observation = state.reset(1, 2, 3).expect("reset");
        assert_eq!(observation["level"]["episode"], 1);
        assert_eq!(observation["level"]["map"], 2);
    }

    #[test]
    fn stop_drops_the_session() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        assert!(state.is_running());
        state.stop();
        assert!(!state.is_running());
        assert!(state.read_state().is_err());
    }

    #[test]
    fn methods_without_a_session_fail_typed() {
        let state = DoomEngineState::default();
        assert_eq!(
            state.read_state().expect_err("no session").code,
            DoomEngineErrorCode::EngineStartFailed
        );
        assert_eq!(
            state.step(1, &json!([])).expect_err("no session").code,
            DoomEngineErrorCode::EngineStartFailed
        );
        assert_eq!(
            state.frame_rgba().expect_err("no session").code,
            DoomEngineErrorCode::EngineStartFailed
        );
    }

    // ── Typed error mapping (REQ-5.2) ────────────────────────────────────────

    #[test]
    fn a_missing_wad_maps_to_wad_missing() {
        let error = load_wad_from(Some("no/such/doom.wad")).expect_err("missing");
        assert_eq!(error.code, DoomEngineErrorCode::WadMissing);
        assert_eq!(error.code.as_str(), "wadMissing");
    }

    #[test]
    fn a_garbage_wad_maps_to_wad_corrupt() {
        let dir = temp_wad_dir();
        let path = dir.path().join("corrupt.wad");
        std::fs::write(&path, b"this is definitely not a Doom IWAD")
            .expect("write corrupt wad");
        // ST-9 extended the loader to reject an invalid header up front, so the
        // garbage file is classified `wadCorrupt` BEFORE engine construction.
        let error = load_wad_from(Some(path.to_str().expect("utf-8 path")))
            .expect_err("garbage is rejected at load time");
        assert_eq!(error.code, DoomEngineErrorCode::WadCorrupt);
        assert_eq!(error.code.as_str(), "wadCorrupt");
    }

    #[test]
    fn an_unknown_map_maps_to_engine_start_failed() {
        let wad = load_wad_from(None).expect("embedded wad");
        // E9M9 has no lump in the shareware WAD → the map load fails at start.
        let error = construct_engine(&wad, "E9M9")
            .err()
            .expect("no such map");
        assert_eq!(error.code, DoomEngineErrorCode::EngineStartFailed);
        assert_eq!(error.code.as_str(), "engineStartFailed");
    }

    #[test]
    fn invalid_coordinates_are_rejected() {
        let state = DoomEngineState::default();
        assert_eq!(
            state.launch(42, 3).expect_err("bad map").code,
            DoomEngineErrorCode::EngineStartFailed
        );
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        assert_eq!(
            state.reset(9, 9, 3).expect_err("bad coords").code,
            DoomEngineErrorCode::EngineStartFailed
        );
    }

    // ── Action translation (the existing vocabulary) ─────────────────────────

    #[test]
    fn action_translation_maps_the_existing_vocabulary() {
        let forward = build_player_action(&parse_actions(&json!([{ "type": "forward" }])), 0, 0);
        assert_eq!(forward.forward_move, DOOM_FORWARD_WALK);

        let backward = build_player_action(&parse_actions(&json!([{ "type": "backward" }])), 0, 0);
        assert_eq!(backward.forward_move, -DOOM_FORWARD_WALK);

        // strafe-right is a positive side_move; strafe-left negative.
        let right = build_player_action(&parse_actions(&json!([{ "type": "strafe-right" }])), 0, 0);
        assert_eq!(right.side_move, DOOM_SIDE_WALK);
        let left = build_player_action(&parse_actions(&json!([{ "type": "strafe-left" }])), 0, 0);
        assert_eq!(left.side_move, -DOOM_SIDE_WALK);

        // turn-left is a positive angle_turn; turn-right negative.
        let turn_left =
            build_player_action(&parse_actions(&json!([{ "type": "turn-left" }])), 0, 0);
        assert_eq!(turn_left.angle_turn, DOOM_TURN_PER_TIC);
        let turn_right =
            build_player_action(&parse_actions(&json!([{ "type": "turn-right" }])), 0, 0);
        assert_eq!(turn_right.angle_turn, -DOOM_TURN_PER_TIC);

        // shoot sets Attack; use sets Use (on the first tic only).
        let shoot = build_player_action(&parse_actions(&json!([{ "type": "shoot" }])), 0, 0);
        assert!(shoot.buttons.contains(Button::Attack));
        let use_first = build_player_action(&parse_actions(&json!([{ "type": "use" }])), 0, 0);
        assert!(use_first.buttons.contains(Button::Use));
        let use_later = build_player_action(&parse_actions(&json!([{ "type": "use" }])), 1, 0);
        assert!(!use_later.buttons.contains(Button::Use));

        // switch-weapon uses `amount` as the slot.
        let switch = build_player_action(
            &parse_actions(&json!([{ "type": "switch-weapon", "amount": 3 }])),
            0,
            0,
        );
        assert_eq!(switch.weapon_select, 3);
    }

    #[test]
    fn amount_is_a_hold_duration_and_run_doubles_the_move() {
        let specs = parse_actions(&json!([{ "type": "forward", "amount": 2 }]));
        assert_eq!(build_player_action(&specs, 0, 0).forward_move, DOOM_FORWARD_WALK);
        assert_eq!(build_player_action(&specs, 1, 0).forward_move, DOOM_FORWARD_WALK);
        assert_eq!(build_player_action(&specs, 2, 0).forward_move, 0);
        // The omitted amount defaults to 10 tics (so tic 5 is still held).
        let default_specs = parse_actions(&json!([{ "type": "forward" }]));
        assert_eq!(
            build_player_action(&default_specs, 5, 0).forward_move,
            DOOM_FORWARD_WALK
        );
        // run raises the magnitude.
        let running = build_player_action(
            &parse_actions(&json!([{ "type": "forward" }, { "type": "run" }])),
            0,
            0,
        );
        assert_eq!(running.forward_move, DOOM_FORWARD_RUN);
    }

    #[test]
    fn turn_to_servos_toward_an_absolute_angle() {
        // Facing east (0); target 90° (north) is a positive turn, bounded.
        let toward = build_player_action(
            &parse_actions(&json!([{ "type": "turn-to", "angle": 90 }])),
            0,
            0,
        );
        assert!(toward.angle_turn > 0);
        assert!(toward.angle_turn <= DOOM_TURN_PER_TIC);

        // Already facing the target → no turn.
        let target = ((90u64 * (1u64 << 32)) / 360) as u32;
        let settled = build_player_action(
            &parse_actions(&json!([{ "type": "turn-to", "angle": 90 }])),
            0,
            target,
        );
        assert_eq!(settled.angle_turn, 0);
    }

    #[test]
    fn malformed_actions_are_ignored_not_fatal() {
        assert!(parse_actions(&json!("not an array")).is_empty());
        assert!(parse_actions(&json!([{ "type": "not-a-real-action" }])).is_empty());
        assert!(parse_actions(&json!([{ "amount": 5 }])).is_empty());
        // A well-formed action alongside junk still parses.
        let specs = parse_actions(&json!([{ "type": "forward" }, { "type": "bogus" }]));
        assert_eq!(specs.len(), 1);
    }

    #[test]
    fn direction_buckets_are_relative_to_facing() {
        // Real map coordinates are 16.16 fixed-point, so scale by FRACUNIT.
        let u = FRACUNIT;
        // Facing east (0): a target due east is front; due north is left.
        assert_eq!(relative_direction(0, 0, 0, 64 * u, 0), "front");
        assert_eq!(relative_direction(0, 0, 0, 0, 64 * u), "left");
        assert_eq!(relative_direction(0, 0, 0, -64 * u, 0), "back");
        assert_eq!(relative_direction(0, 0, 0, 0, -64 * u), "right");
        // Coincident points never panic.
        assert_eq!(relative_direction(0, 0, 0, 0, 0), "front");
    }

    #[test]
    fn friendly_kinds_cover_the_classic_cast() {
        assert_eq!(friendly_kind("TROO"), Some("imp"));
        assert_eq!(friendly_kind("STIM"), Some("stimpack"));
        assert_eq!(friendly_kind("SHOT"), Some("shotgun"));
        assert_eq!(friendly_kind("NOPE"), None);
    }

    // ── Spec #3023 ST-9: WAD-path seam (REQ-5.2) ─────────────────────────────

    #[test]
    fn the_seam_env_names_are_pinned() {
        assert_eq!(DOOM_WAD_PATH_ENV, "FREDO_DOOM_WAD_PATH");
        assert_eq!(
            crate::applications::doom::failure_seam::DOOM_FAIL_ENGINE_SPAWN_ENV,
            "FREDO_DOOM_FAIL_ENGINE_SPAWN"
        );
    }

    #[test]
    fn an_absent_override_makes_launch_wad_missing() {
        let state = DoomEngineState::default();
        let error = state
            .launch_with(1, 3, Some("no/such/absent.wad"), false)
            .expect_err("absent wad");
        assert_eq!(error.code, DoomEngineErrorCode::WadMissing);
        assert_eq!(error.code.as_str(), "wadMissing");
        assert!(!state.is_running(), "no session is created on a WAD failure");
    }

    #[test]
    fn a_garbage_override_makes_launch_wad_corrupt() {
        let dir = temp_wad_dir();
        let path = dir.path().join("corrupt.wad");
        std::fs::write(&path, b"this is definitely not a Doom IWAD").expect("write");
        let state = DoomEngineState::default();
        let error = state
            .launch_with(1, 3, path.to_str(), false)
            .expect_err("garbage wad");
        assert_eq!(error.code, DoomEngineErrorCode::WadCorrupt);
        assert_eq!(error.code.as_str(), "wadCorrupt");
        assert!(!state.is_running());
    }

    #[test]
    fn a_truncated_override_makes_launch_wad_corrupt() {
        let dir = temp_wad_dir();
        let path = dir.path().join("truncated.wad");
        // A truncated copy of the REAL WAD: valid magic, directory past EOF.
        std::fs::write(&path, &EMBEDDED_WAD[..2048]).expect("write truncated");
        let state = DoomEngineState::default();
        let error = state
            .launch_with(1, 3, path.to_str(), false)
            .expect_err("truncated wad");
        assert_eq!(error.code, DoomEngineErrorCode::WadCorrupt);
        assert_eq!(error.code.as_str(), "wadCorrupt");
    }

    #[test]
    fn the_embedded_wad_passes_header_validation() {
        assert!(validate_wad_header(EMBEDDED_WAD, "embedded DOOM1.WAD").is_ok());
        // Blank/whitespace is treated as unset (inert) — the embedded WAD loads.
        assert!(load_wad_from(Some("")).is_ok());
        assert!(load_wad_from(Some("   ")).is_ok());
        assert!(load_wad_from(None).is_ok());
    }

    #[test]
    fn wad_header_validation_rejects_short_and_garbage() {
        assert_eq!(
            validate_wad_header(b"short", "x").expect_err("short").code,
            DoomEngineErrorCode::WadCorrupt
        );
        assert_eq!(
            validate_wad_header(b"NOPE\x00\x00\x00\x00\x00\x00\x00\x00", "x")
                .expect_err("magic")
                .code,
            DoomEngineErrorCode::WadCorrupt
        );
    }

    // ── Spec #3023 ST-9: engine-start-failure seam (REQ-5.2) ─────────────────

    #[test]
    fn the_engine_failure_lever_refuses_before_any_session() {
        let state = DoomEngineState::default();
        let error = state.launch_with(1, 3, None, true).expect_err("lever");
        assert_eq!(error.code, DoomEngineErrorCode::EngineStartFailed);
        assert_eq!(error.code.as_str(), "engineStartFailed");
        assert!(
            !state.is_running(),
            "the lever creates no session, so no orphan is possible"
        );
    }

    #[test]
    fn the_lever_short_circuits_before_the_wad_is_read() {
        // With the lever set, an ABSENT WAD still yields engineStartFailed (the
        // lever wins) — the failure surfaces before any engine construction.
        let state = DoomEngineState::default();
        let error = state
            .launch_with(1, 3, Some("no/such/absent.wad"), true)
            .expect_err("lever");
        assert_eq!(error.code, DoomEngineErrorCode::EngineStartFailed);
    }

    #[test]
    fn the_engine_failure_lever_is_inert_when_false() {
        let state = DoomEngineState::default();
        assert!(state.launch_with(1, 3, None, false).is_ok());
        assert!(state.is_running());
    }

    // ── Spec #3023 ST-9: deterministic driver (REQ-3.1) ──────────────────────

    fn scripted(entries: Value, repeat: bool) -> ScriptedDecisionSource {
        let script = json!({ "decisions": entries, "repeat": repeat });
        ScriptedDecisionSource::from_script_json(&script.to_string()).expect("script")
    }

    /// The deterministic clock the driver tests inject (AC5 — no wall clock).
    fn driver_clock() -> FixedTickClock {
        FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS)
    }

    #[test]
    fn driver_config_defaults_to_the_shared_budgets_and_env_is_inert_when_unset() {
        let default = DoomDriverConfig::default();
        assert_eq!(default.map, 1);
        assert_eq!(default.skill, crate::applications::doom::save::DOOM_DEFAULT_SKILL);
        assert_eq!(default.max_steps, DOOM_AUTOPLAY_MAX_STEPS);
        assert_eq!(default.max_failures, DOOM_AUTOPLAY_MAX_FAILURES);

        if crate::applications::doom::decision::max_steps_from_env().is_none() {
            assert_eq!(DoomDriverConfig::from_env().max_steps, default.max_steps);
        }
        if crate::applications::doom::decision::max_failures_from_env().is_none() {
            assert_eq!(
                DoomDriverConfig::from_env().max_failures,
                default.max_failures
            );
        }
    }

    #[tokio::test]
    async fn the_scripted_driver_reproduces_a_bounded_run() {
        let state = DoomEngineState::default();
        let source = scripted(
            json!([
                { "tics": 4, "actions": [{ "type": "forward" }] },
                { "tics": 4, "actions": [{ "type": "forward" }] },
            ]),
            true,
        );
        let clock = driver_clock();
        let report = run_bounded_driver(
            &state,
            &source,
            DoomDriverConfig {
                map: 1,
                skill: 3,
                max_steps: 8,
                max_failures: 3,
                stop_at_first_exit: false,
                combat_low_health: None,
            },
            &clock,
        )
        .await
        .expect("driven run");

        assert_eq!(report.episode, 1);
        assert_eq!(report.map, 1);
        assert_eq!(report.skill, 3);
        // The tick budget (8) includes the one-tick resume positioning.
        assert_eq!(report.steps, 7, "the run advances the bounded tick budget");
        assert_eq!(report.ticks, report.steps);
        assert_eq!(report.decisions, 7, "one decision per tick");
        assert_eq!(report.failures, 0);
        assert!(report.advanced(), "the engine tic advanced");
        assert!(report.moved(), "the scripted forwards moved the player");
        assert!(report.terminal.is_none(), "the budget ended the run");
        // AC2: distinct world-reflecting frames were produced over the run.
        assert!(report.distinct_frames >= 1, "the frames changed across the run");
        assert!(report.distinct_frames <= report.ticks);
        assert!(report.fps_estimate > 0.0, "a positive fps estimate");
    }

    #[tokio::test]
    async fn the_driver_sustains_the_ac2_distinct_frame_floor_over_five_simulated_seconds() {
        // AC2 floor (R-2): >= DOOM_MIN_SMOOTH_FPS (30) DISTINCT world-reflecting
        // frames per SIMULATED second over a 5-simulated-second window, asserted
        // through the deterministic ST-9 driver (FixedTickClock + scripted source),
        // never a wall clock (G-316 / AC5).
        let state = DoomEngineState::default();
        // A VARIED-motion script (forward + run + periodic turns + a shot) keeps
        // the rendered view changing every tick; a single held `forward` can run
        // into a wall and stall the framebuffer (no distinct frame).
        let source = scripted(
            json!([
                { "tics": 1, "actions": [{ "type": "forward" }, { "type": "run" }, { "type": "turn-left" }] },
                { "tics": 1, "actions": [{ "type": "forward" }, { "type": "turn-to", "angle": 90 }] },
                { "tics": 1, "actions": [{ "type": "strafe-right" }, { "type": "turn-right" }, { "type": "shoot" }] },
                { "tics": 1, "actions": [{ "type": "forward" }, { "type": "turn-to", "angle": 270 }] },
            ]),
            true,
        );
        let clock = driver_clock();

        // 5 simulated seconds at the continuous rate.
        let window_ticks = DOOM_CONTINUOUS_RATE_HZ * 5;
        let report = run_bounded_driver(
            &state,
            &source,
            DoomDriverConfig {
                map: 1,
                skill: 3,
                // One budget tick is the resume positioning; the rest are engine ticks.
                max_steps: window_ticks + 1,
                max_failures: 3,
                stop_at_first_exit: false,
                combat_low_health: None,
            },
            &clock,
        )
        .await
        .expect("driven run");

        assert_eq!(
            report.ticks, window_ticks,
            "the run advances exactly the 5-simulated-second window"
        );
        assert_eq!(report.steps, report.ticks);
        assert!(report.terminal.is_none(), "the tick budget ended the run");

        let floor = DOOM_MIN_SMOOTH_FPS * 5;
        assert!(
            report.distinct_frames >= floor,
            "AC2: expected >= {floor} distinct frames over {window_ticks} ticks, got {}",
            report.distinct_frames
        );
        assert!(
            report.fps_estimate >= f64::from(DOOM_MIN_SMOOTH_FPS),
            "AC2: expected fps_estimate >= {0}, got {1}",
            DOOM_MIN_SMOOTH_FPS,
            report.fps_estimate
        );
    }

    #[tokio::test]
    async fn the_driver_report_is_deterministic_and_exposes_the_ac2_ac5_surface() {
        // The SAME scripted decisions + the SAME FixedTickClock schedule produce
        // field-for-field identical reports (AC5) — no wall clock leaks in.
        async fn run() -> DoomDriverReport {
            let state = DoomEngineState::default();
            let source = scripted(
                json!([{ "tics": 1, "actions": [{ "type": "forward" }] }]),
                true,
            );
            let clock = driver_clock();
            run_bounded_driver(
                &state,
                &source,
                DoomDriverConfig {
                    map: 1,
                    skill: 3,
                    max_steps: 40,
                    max_failures: 3,
                    stop_at_first_exit: false,
                    combat_low_health: None,
                },
                &clock,
            )
            .await
            .expect("driven run")
        }
        let first = run().await;
        let second = run().await;
        assert_eq!(first, second, "the injected-clock replay is deterministic");
        assert!(first.ticks > 0);
        assert!(first.distinct_frames > 0, "advancing frames are distinct");
        assert!(first.fps_estimate > 0.0);
    }

    #[tokio::test]
    async fn the_scripted_driver_is_deterministic_across_fresh_sessions() {
        async fn run(steps: u32) -> DoomDriverReport {
            let state = DoomEngineState::default();
            let source = scripted(
                json!([{ "tics": 3, "actions": [{ "type": "forward" }] }]),
                true,
            );
            let clock = driver_clock();
            run_bounded_driver(
                &state,
                &source,
                DoomDriverConfig {
                    map: 1,
                    skill: 3,
                    max_steps: steps,
                    max_failures: 3,
                    stop_at_first_exit: false,
                    combat_low_health: None,
                },
                &clock,
            )
            .await
            .expect("driven run")
        }
        let first = run(6).await;
        let second = run(6).await;
        assert_eq!(first.last_tic, second.last_tic);
        assert_eq!((first.last_x, first.last_y), (second.last_x, second.last_y));
        assert_eq!(first.steps, second.steps);
        assert_eq!(first.ticks, second.ticks);
        assert_eq!(first.distinct_frames, second.distinct_frames);
        assert_eq!(first.fps_estimate, second.fps_estimate);
    }

    #[tokio::test]
    async fn the_driver_stops_at_the_tick_budget() {
        let state = DoomEngineState::default();
        let source = scripted(json!([{ "tics": 1, "actions": [] }]), true);
        let clock = driver_clock();
        let report = run_bounded_driver(
            &state,
            &source,
            DoomDriverConfig {
                map: 1,
                skill: 3,
                max_steps: 4,
                max_failures: 3,
                stop_at_first_exit: false,
                combat_low_health: None,
            },
            &clock,
        )
        .await
        .expect("driven run");
        // Tick budget 4 = positioning + 3 ticks.
        assert_eq!(report.steps, 3);
        assert!(report.advanced());
    }

    #[tokio::test]
    async fn the_driver_stops_at_the_failure_budget_while_keeping_motion() {
        let state = DoomEngineState::default();
        let source = scripted(json!([{ "malformed": true }]), true);
        let clock = driver_clock();
        let report = run_bounded_driver(
            &state,
            &source,
            DoomDriverConfig {
                map: 1,
                skill: 3,
                max_steps: 600,
                max_failures: 3,
                stop_at_first_exit: false,
                combat_low_health: None,
            },
            &clock,
        )
        .await
        .expect("driven run");
        assert_eq!(report.failures, 3, "bounded by the failure budget");
        assert_eq!(report.decisions, 0, "a malformed reply is never a decision");
        // The continuous loop keeps the world advancing between malformed
        // decisions (R-1); the failure budget — not the tick budget — ends it.
        assert!(report.steps > 0, "the world kept advancing");
    }

    #[test]
    fn terminal_labels_map_the_production_classifier() {
        use crate::applications::doom::agent::{terminal_kind, TerminalKind};
        assert_eq!(terminal_label(TerminalKind::Death), "dead");
        assert_eq!(terminal_label(TerminalKind::Exit), "exited");
        let dead = json!({ "tic": 1, "outcome": "dead", "done": false });
        assert_eq!(terminal_kind(&dead).map(terminal_label), Some("dead"));
        let exited = json!({ "tic": 1, "outcome": "exited", "done": true });
        assert_eq!(terminal_kind(&exited).map(terminal_label), Some("exited"));
    }

    // ── Spec #3030 S1: the observation `walls` geometry (REQ-1 / AC1) ────────

    #[test]
    fn observation_carries_a_bounded_walls_array() {
        use crate::applications::doom::perception::DOOM_PERCEPTION_RAY_COUNT;

        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");

        // The first read happens before any render, so the semantic/depth
        // buffers are unpopulated → the AC4 fallback branch emits `[]`.
        let first = state.read_state().expect("read_state");
        assert!(
            first["walls"].is_array(),
            "walls is always a present array (never absent/null)"
        );
        assert!(
            first["walls"].as_array().expect("array").is_empty(),
            "unpopulated buffers fall back to an empty walls array"
        );

        // After a step the engine has rendered → the buffers are populated and
        // the geometry is emitted, still bounded and in the direction vocab.
        let stepped = state
            .step(1, &json!([{ "type": "forward" }]))
            .expect("step");
        let walls = stepped["walls"].as_array().expect("walls array");
        assert!(
            walls.len() <= DOOM_PERCEPTION_RAY_COUNT,
            "the geometry stays bounded by the ray budget"
        );
        for entry in walls {
            let direction = entry["direction"].as_str().expect("direction string");
            assert!(
                matches!(direction, "front" | "left" | "right"),
                "\"back\" is never emitted, got {direction}"
            );
            assert!(entry["distance"].as_i64().is_some(), "integer distance");
            assert!(entry["blocked"].as_bool().is_some(), "boolean blocked");
        }
    }

    // ── Spec #3030 ST-4: driver determinism (F-7 static leg) ─────────────────

    /// **ST-4 (NFR-DET, F-7 static).** `run_bounded_driver` run TWICE with
    /// identical scripted decisions + a [`FixedTickClock`] yields a
    /// field-for-field identical [`DoomDriverReport`] — step-driven, no
    /// wall-clock motion assertion (G-316).
    #[tokio::test]
    async fn st4_bounded_driver_report_is_field_for_field_deterministic() {
        async fn run() -> DoomDriverReport {
            let state = DoomEngineState::default();
            let source = scripted(
                json!([
                    { "tics": 2, "actions": [{ "type": "forward" }, { "type": "turn-left" }] },
                    { "tics": 2, "actions": [{ "type": "strafe-right" }] },
                ]),
                true,
            );
            let clock = driver_clock();
            run_bounded_driver(
                &state,
                &source,
                DoomDriverConfig {
                    map: 1,
                    skill: 3,
                    max_steps: 24,
                    max_failures: 3,
                    stop_at_first_exit: false,
                    combat_low_health: None,
                },
                &clock,
            )
            .await
            .expect("driven run")
        }

        let first = run().await;
        let second = run().await;
        assert_eq!(
            first, second,
            "identical script + FixedTickClock ⇒ identical report"
        );
        // Field-for-field (explicit, beyond the derived `PartialEq`).
        assert_eq!(first.episode, second.episode);
        assert_eq!(first.map, second.map);
        assert_eq!(first.skill, second.skill);
        assert_eq!(first.steps, second.steps);
        assert_eq!(first.ticks, second.ticks);
        assert_eq!(first.distinct_frames, second.distinct_frames);
        assert_eq!(first.fps_estimate, second.fps_estimate);
        assert_eq!(first.decisions, second.decisions);
        assert_eq!(first.failures, second.failures);
        assert_eq!(first.start_tic, second.start_tic);
        assert_eq!(first.last_tic, second.last_tic);
        assert_eq!((first.start_x, first.start_y), (second.start_x, second.start_y));
        assert_eq!((first.last_x, first.last_y), (second.last_x, second.last_y));
        assert_eq!(first.terminal, second.terminal);
        assert!(first.ticks > 0, "the step-driven run advanced");
    }

    /// **ST-4 (AC2, re-scoped by the Option-D amendment).** A bounded real E1M1
    /// `run_bounded_driver` + `LocalRouteSource` run with the real product
    /// `combat::combat_intent` proves the re-scoped AC2 observable: the engaged
    /// front enemy's observed `hp` strictly decreases (aimed sustained fire lands
    /// damage). Runs TWICE and compares field-for-field (NFR-DET / G-316). No `kills`
    /// assertion — `kills` is a DEAD observable in the pinned engine.
    #[tokio::test]
    async fn st4_local_route_engagement_records_live_damage() {
        use crate::applications::doom::combat::DOOM_COMBAT_LOW_HEALTH_OFF;
        use crate::applications::doom::local_route::LocalRouteSource;
        use crate::applications::doom::save::{
            DOOM_COMPLETION_STEP_BUDGET, DOOM_COMPLETION_TARGET_MAP, DOOM_DEFAULT_SKILL,
        };

        async fn run() -> DoomDriverReport {
            let state = DoomEngineState::default();
            let source = LocalRouteSource::new();
            let clock = driver_clock();
            run_bounded_driver(
                &state,
                &source,
                DoomDriverConfig {
                    map: DOOM_COMPLETION_TARGET_MAP,
                    skill: DOOM_DEFAULT_SKILL,
                    max_steps: DOOM_COMPLETION_STEP_BUDGET,
                    max_failures: 3,
                    stop_at_first_exit: true,
                    combat_low_health: Some(DOOM_COMBAT_LOW_HEALTH_OFF), // Option A: brake inert
                },
                &clock,
            )
            .await
            .expect("the local-route driven run")
        }

        let first = run().await;
        let second = run().await;

        // The recorded floor for the tester — the assertion is the strict
        // decrease, never a magic number.
        println!("{first:?}");

        let start = first
            .front_enemy_hp_start
            .expect("the run must engage a front enemy (front_enemy_hp_start)");
        let floor = first
            .front_enemy_hp_floor
            .expect("the run must engage a front enemy (front_enemy_hp_floor)");
        assert!(floor >= 0, "never a fabricated hp: {first:?}");
        assert!(
            start > floor,
            "aimed sustained fire must land damage on the engaged front enemy \
             (start {start} → floor {floor}): {first:?}"
        );
        assert_eq!(
            first, second,
            "step-driven ⇒ field-for-field deterministic (G-316)"
        );
    }

    // ── Spec #3039 ST-8: committed deterministic target-level completion (AC5) ──

    /// **ST-8 (AC5, F-5a).** The committed, model-independent, deterministic
    /// completion leg: [`run_bounded_driver`] + [`FixedTickClock`] at
    /// [`DOOM_COMPLETION_TARGET_MAP`] (E1M1), `stop_at_first_exit: true`, driven by
    /// the [`LocalRouteSource`] reaches the target level's exit
    /// (`terminal == Some("exited")`), and the SAME run reproduces the report
    /// field-for-field (G-316). If it under-completes, the failing observation
    /// trace is printed so a re-scope can be judged from data — the assertion is
    /// never loosened.
    ///
    /// Per **Option A** (Spec #3053 amendment), the completion guarantee is scoped
    /// to a run that does **not** enter the survival brake: this leg runs with the
    /// brake **inert** through the test-only driver seam
    /// (`combat_low_health: Some(DOOM_COMBAT_LOW_HEALTH_OFF)`). The separate
    /// bounded-brake pin covers the brake path. `st8` still asserts deterministic
    /// completion within the committed [`DOOM_COMPLETION_STEP_BUDGET`].
    #[tokio::test]
    async fn st8_local_route_completes_the_target_level_deterministically() {
        use crate::applications::doom::combat::DOOM_COMBAT_LOW_HEALTH_OFF;
        use crate::applications::doom::local_route::LocalRouteSource;
        use crate::applications::doom::save::{
            DOOM_COMPLETION_STEP_BUDGET, DOOM_COMPLETION_TARGET_MAP, DOOM_DEFAULT_SKILL,
        };

        async fn run() -> DoomDriverReport {
            let state = DoomEngineState::default();
            let source = LocalRouteSource::new();
            let clock = driver_clock();
            run_bounded_driver(
                &state,
                &source,
                DoomDriverConfig {
                    map: DOOM_COMPLETION_TARGET_MAP,
                    skill: DOOM_DEFAULT_SKILL,
                    max_steps: DOOM_COMPLETION_STEP_BUDGET,
                    max_failures: 3,
                    stop_at_first_exit: true,
                    combat_low_health: Some(DOOM_COMBAT_LOW_HEALTH_OFF), // Option A: brake inert
                },
                &clock,
            )
            .await
            .expect("the local-route driven run")
        }

        let first = run().await;
        let second = run().await;

        if first.terminal != Some("exited") {
            print_completion_failure_trace(&first);
        }

        assert_eq!(
            first.terminal,
            Some("exited"),
            "the local route must reach the target level's exit: {first:?}"
        );
        assert_eq!(first.map, DOOM_COMPLETION_TARGET_MAP);
        assert!(
            first.steps > 64 && first.steps <= DOOM_COMPLETION_STEP_BUDGET,
            "the completion leg must fit the committed budget: {first:?}"
        );
        assert_eq!(
            first, second,
            "the local route + FixedTickClock must be field-for-field deterministic (G-316)"
        );
    }

    /// Print the failing observation trace for the ST-8 completion leg: the run
    /// report, a fresh target-map observation (`map` / `player` / `tic` /
    /// `terminal` inputs), and the emitted route from the spawn. Deterministic,
    /// read-only — it exists so a re-scope is judged from data, never a guess.
    fn print_completion_failure_trace(report: &DoomDriverReport) {
        use crate::applications::doom::navigation::{route_waypoints, spawn_point};
        use crate::applications::doom::save::DOOM_COMPLETION_TARGET_MAP;
        use neurodoom::engine::ClassicEngine;

        let level = DOOM_COMPLETION_TARGET_MAP;
        let name = format!("E1M{level}");

        println!("ST-8 FAILURE TRACE:");
        println!("  report = {report:?}");

        let wad = match load_wad() {
            Ok(wad) => wad,
            Err(error) => {
                println!("  cannot load the WAD: {error}");
                return;
            }
        };
        let engine = match ClassicEngine::new(&wad, &name) {
            Ok(engine) => engine,
            Err(error) => {
                println!("  cannot build {name}: {error}");
                return;
            }
        };
        let map = engine.map();
        match spawn_point(map) {
            Some((sx, sy)) => {
                let from = (i64::from(sx), i64::from(sy));
                println!("  {name} spawn = {from:?}");
                println!("  emitted route = {:?}", route_waypoints(map, from));
            }
            None => println!("  {name} has no player-1 start"),
        }

        let state = DoomEngineState::default();
        match state.launch(level, crate::applications::doom::save::DOOM_DEFAULT_SKILL) {
            Ok(info) => {
                println!("  launch = {info:?}");
                if let Ok(observation) = state.read_state() {
                    println!(
                        "  observation: map={:?} player={:?} tic={:?} outcome={:?}",
                        observation.pointer("/level/map"),
                        observation.get("player"),
                        observation.get("tic"),
                        observation.get("outcome"),
                    );
                    println!("  exitBearing = {:?}", observation.pointer("/forward/exitBearing"));
                }
            }
            Err(error) => println!("  launch failed: {error}"),
        }
    }

    // ── Spec #3023 ST-9: teardown (G-263 / REQ-5.3) ──────────────────────────

    #[test]
    fn teardown_is_take_and_drop_and_recovers() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        assert!(state.is_running());

        state.stop();
        assert!(!state.is_running(), "the session is dropped");
        assert_eq!(
            state.read_state().expect_err("dropped").code,
            DoomEngineErrorCode::EngineStartFailed
        );

        // Idempotent: a second close/app-exit path is a no-op.
        state.stop();
        assert!(!state.is_running());

        // The Retry path recovers with a clean session.
        assert!(state.launch(1, 3).is_ok());
        assert!(state.is_running());
    }

    #[test]
    fn window_close_and_app_exit_share_one_session() {
        // Both teardown entry points (`stop_doom_on_window_close` /
        // `stop_doom_on_exit`) delegate to this engine seam through a cloned
        // handle; dropping through EITHER drops the shared session for both.
        let window_close_handle = DoomEngineState::default();
        let app_exit_handle = window_close_handle.clone();
        window_close_handle.launch(1, 3).expect("launch");
        assert!(app_exit_handle.is_running());

        app_exit_handle.stop(); // the app-exit path
        assert!(
            !window_close_handle.is_running(),
            "the drop is shared (one session, take-and-drop)"
        );
    }

    #[test]
    fn repeated_close_paths_leave_no_session_accumulating() {
        // Models rapid open/close cycles: each cycle ends with the session
        // dropped and no thread/process left behind (take-and-drop; no orphan).
        let state = DoomEngineState::default();
        for _ in 0..16 {
            state.launch(1, 3).expect("launch");
            assert!(state.is_running());
            state.stop();
            assert!(!state.is_running());
        }
    }

    #[tokio::test]
    async fn the_driver_session_is_take_and_drop_after_a_run() {
        let state = DoomEngineState::default();
        let source = scripted(json!([{ "tics": 1, "actions": [] }]), true);
        let clock = driver_clock();
        let _ = run_bounded_driver(
            &state,
            &source,
            DoomDriverConfig {
                map: 1,
                skill: 3,
                max_steps: 2,
                max_failures: 3,
                stop_at_first_exit: false,
                combat_low_health: None,
            },
            &clock,
        )
        .await
        .expect("driven run");
        assert!(state.is_running());
        state.stop();
        assert!(!state.is_running(), "the driver leaves no orphan session");
    }

    // ── Spec #3031 ST-2: the AC4 exit-induction lever ────────────────────────

    #[test]
    fn force_exit_lever_names_and_parser_are_pinned() {
        assert_eq!(DOOM_FORCE_EXIT_ENV, "FREDO_DOOM_FORCE_EXIT");
        assert_eq!(DOOM_FORCE_EXIT_AFTER_TICS, 1);

        assert!(force_exit_from(Some("1")));
        assert!(force_exit_from(Some(" 1 ")));
        assert!(!force_exit_from(Some("0")));
        assert!(!force_exit_from(Some("01")));
        assert!(!force_exit_from(Some("true")));
        assert!(!force_exit_from(Some("")));
        assert!(!force_exit_from(Some("   ")));
        assert!(!force_exit_from(None));
    }

    #[test]
    fn forced_exit_at_honours_the_tic_threshold() {
        // Lever off: never forced, whatever the tick.
        assert!(!forced_exit_at(false, 0));
        assert!(!forced_exit_at(false, 1));
        assert!(!forced_exit_at(false, 1_000));
        // Lever on: inert at the launch observation, armed at the threshold.
        assert!(
            !forced_exit_at(true, 0),
            "the launch observation (tick 0) is not exited"
        );
        assert!(forced_exit_at(true, u64::from(DOOM_FORCE_EXIT_AFTER_TICS)));
        assert!(forced_exit_at(true, 5));
    }

    /// **ST-2 (AC4).** On the REAL engine, the force-exit lever reports the
    /// terminal level exit (`done: true`, `outcome: "exited"`) and is completely
    /// inert when off — the production observation is unchanged.
    #[test]
    fn force_exit_lever_reports_the_terminal_exit_on_the_real_engine() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        // Advance past the threshold so the lever is armed.
        state
            .step(
                i64::from(DOOM_FORCE_EXIT_AFTER_TICS),
                &json!([{ "type": "forward" }]),
            )
            .expect("step");

        let guard = state.0.lock().expect("session lock");
        let session = guard.as_ref().expect("live session");

        // Lever OFF (production): the real observation is unchanged.
        let inert = observation_with(session, false, None);
        assert_eq!(inert["done"], false);
        assert_eq!(inert["outcome"], "alive");

        // Lever ON: the observation reports the terminal exit.
        let forced = observation_with(session, true, None);
        assert_eq!(forced["done"], true);
        assert_eq!(forced["outcome"], "exited");
        // Additive only: every other field is byte-identical to the inert read.
        assert_eq!(forced["tic"], inert["tic"]);
        assert_eq!(forced["level"], inert["level"]);
        assert_eq!(forced["player"], inert["player"]);
        assert_eq!(forced["exit"], inert["exit"]);
    }

    // ── Spec #3039 ST-2: the additive `forward` sensor + AC3 inject seam ─────

    #[test]
    fn inject_observation_lever_names_and_parser_are_pinned() {
        assert_eq!(DOOM_INJECT_OBSERVATION_ENV, "FREDO_DOOM_INJECT_OBSERVATION");
        // A JSON object is accepted (trimmed); everything else is inert.
        let object = inject_observation_from(Some("  {\"a\":1}  ")).expect("object");
        assert_eq!(object["a"], 1);
        assert!(inject_observation_from(Some("")).is_none());
        assert!(inject_observation_from(Some("   ")).is_none());
        assert!(inject_observation_from(Some("[1,2]")).is_none());
        assert!(inject_observation_from(Some("42")).is_none());
        assert!(inject_observation_from(Some("not json")).is_none());
        assert!(inject_observation_from(None).is_none());
    }

    /// **AC1.** The observation always carries the additive `forward` sibling
    /// with its four keys, and after a step the ray geometry is bounded + typed.
    #[test]
    fn observation_carries_the_additive_forward_sensor() {
        use crate::applications::doom::perception::{
            DOOM_SENSOR_MAX_DOORS, DOOM_SENSOR_MAX_OPENINGS, DOOM_SENSOR_MAX_RAYS,
        };

        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");

        // `forward` is always present with the four keys — never absent/null.
        let first = state.read_state().expect("read_state");
        let forward = &first["forward"];
        assert!(forward.is_object(), "forward is always present");
        assert!(forward["rays"].is_array(), "rays is an array");
        assert!(forward["openings"].is_array(), "openings is an array");
        assert!(forward["doorBearings"].is_array(), "doorBearings is an array");
        assert!(forward.get("exitBearing").is_some(), "exitBearing present");

        // After a step the buffers are rendered → bounded, typed geometry.
        let stepped = state
            .step(1, &json!([{ "type": "forward" }]))
            .expect("step");
        let forward = &stepped["forward"];
        let rays = forward["rays"].as_array().expect("rays");
        assert!(rays.len() <= DOOM_SENSOR_MAX_RAYS);
        for ray in rays {
            assert!(ray["index"].as_i64().is_some(), "integer index");
            let direction = ray["direction"].as_str().expect("direction string");
            assert!(matches!(direction, "left" | "front" | "right"));
            let class = ray["class"].as_str().expect("class string");
            assert!(matches!(
                class,
                "wall" | "door" | "enemy" | "floor" | "unknown"
            ));
            assert!(ray["distance"].as_i64().is_some(), "integer distance");
            assert!(ray["blocked"].as_bool().is_some(), "boolean blocked");
        }
        assert!(forward["openings"].as_array().expect("openings").len() <= DOOM_SENSOR_MAX_OPENINGS);
        assert!(
            forward["doorBearings"].as_array().expect("doorBearings").len() <= DOOM_SENSOR_MAX_DOORS
        );
    }

    /// **AC1 fallback.** On the REAL engine, the `FREDO_DOOM_FAIL_PERCEPTION`
    /// lever makes the bridge report the buffers unavailable → the `forward`
    /// sensor falls back to the empty object (present, never absent) and the run
    /// never fails.
    #[test]
    fn forward_sensor_falls_back_to_empty_when_perception_fails() {
        use crate::applications::doom::perception::{forward_observation, perception_frame_with};

        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        state
            .step(1, &json!([{ "type": "forward" }]))
            .expect("step");

        let guard = state.0.lock().expect("session lock");
        let session = guard.as_ref().expect("live session");

        // Buffers are populated (lever off) but the fail lever reports them
        // unavailable (lever on) — the AC1 fallback condition.
        assert!(perception_frame_with(&session.engine, false).is_some());
        assert!(
            perception_frame_with(&session.engine, true).is_none(),
            "the fail lever reports the buffers unavailable"
        );

        let forward = forward_observation(None, &[], &[], None);
        assert!(forward["rays"].as_array().expect("rays").is_empty());
        assert!(forward["openings"].as_array().expect("openings").is_empty());
        assert!(forward["doorBearings"].as_array().expect("doorBearings").is_empty());
        assert_eq!(forward["exitBearing"], Value::Null);
    }

    /// **NFR-4.** The S1 `walls` contract is unchanged by the additive sensor —
    /// still the `{direction, distance, blocked}` triple, no `class` key.
    #[test]
    fn forward_sensor_is_additive_and_leaves_walls_unchanged() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        let stepped = state
            .step(1, &json!([{ "type": "forward" }]))
            .expect("step");
        assert!(stepped["forward"].is_object(), "forward is a sibling of walls");
        for wall in stepped["walls"].as_array().expect("walls") {
            assert!(wall.get("class").is_none(), "walls stays the S1 triple");
            assert!(wall["direction"].as_str().is_some());
            assert!(wall["distance"].as_i64().is_some());
            assert!(wall["blocked"].as_bool().is_some());
        }
    }

    /// **AC3 seam (G-275/G-300).** `observation_with(..., Some(patch))`
    /// top-level-merges the tester's patch before the executor/model sees it;
    /// `None` is inert (production is byte-identical).
    #[test]
    fn inject_observation_merges_a_patch_into_the_observation() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        state
            .step(1, &json!([{ "type": "forward" }]))
            .expect("step");

        let guard = state.0.lock().expect("session lock");
        let session = guard.as_ref().expect("live session");

        // Inert: no patch → no injected marker.
        let inert = observation_with(session, false, None);
        assert!(inert.get("injectedMarker").is_none());

        // A patch top-level-merges into the observation the model/executor sees.
        let patch = json!({
            "injectedMarker": true,
            "enemies": [{ "kind": "injected", "hp": 1, "direction": "front", "distance": 16 }],
        });
        let injected = observation_with(session, false, Some(&patch));
        assert_eq!(injected["injectedMarker"], true);
        assert_eq!(injected["enemies"], patch["enemies"]);
        // Every unpatched field is unchanged.
        assert_eq!(injected["tic"], inert["tic"]);
        assert_eq!(injected["player"], inert["player"]);
        assert_eq!(injected["forward"], inert["forward"]);
    }

    // ── Spec #3054 ST-1: the additive collection + weapon-set observation ────

    /// **F-5 (unit pin).** The pure `Special`-id diff counts ONLY ids that
    /// vanished from the previous set (the pickup path's `world.remove`); new ids
    /// and unchanged ids never count.
    #[test]
    fn the_special_id_diff_counts_only_vanished_ids() {
        let ids = |values: &[u32]| values.iter().copied().map(EntityId).collect::<HashSet<_>>();
        assert_eq!(special_diff(&ids(&[1, 2]), &ids(&[1])), 1, "one vanished");
        assert_eq!(special_diff(&ids(&[1, 2]), &ids(&[1, 2])), 0, "no change");
        assert_eq!(special_diff(&ids(&[]), &ids(&[1, 2])), 0, "a fresh world");
        assert_eq!(special_diff(&ids(&[1, 2, 3]), &ids(&[])), 3, "all vanished");
        assert_eq!(special_diff(&ids(&[1]), &ids(&[1, 2])), 0, "a new id is not a vanish");
    }

    /// **F-7 (unit pin).** The `player.weapons` projection is pure, slot-ordered,
    /// and omits `false` slots.
    #[test]
    fn the_weapon_set_projection_is_pure_and_slot_ordered() {
        assert_eq!(
            weapon_set(&[true, true, false, false, false, false, false, false, false]),
            vec!["fist", "pistol"],
            "the baseline weapon set"
        );
        assert_eq!(weapon_set(&[false; 9]), Vec::<&str>::new(), "all-false ⇒ empty");
        assert_eq!(
            weapon_set(&[true; 9]),
            vec![
                "fist",
                "pistol",
                "shotgun",
                "chaingun",
                "rocket-launcher",
                "plasma-rifle",
                "bfg",
                "chainsaw",
                "super-shotgun",
            ],
            "all-true ⇒ all nine in slot order"
        );
        assert_eq!(
            weapon_set(&[false, false, true, false, false, false, false, false, false]),
            vec!["shotgun"],
            "a flipped slot appears at its slot index"
        );
    }

    /// **AC2/AC3 (additive).** The observation carries the additive
    /// `level.itemsCollected` and `player.weapons`, leaves `player.weapon` and the
    /// dead `level.items` untouched.
    #[test]
    fn the_observation_carries_the_additive_collection_and_weapon_keys() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        let observation = state.read_state().expect("read_state");

        assert_eq!(
            observation
                .pointer("/level/itemsCollected")
                .and_then(Value::as_i64),
            Some(0),
            "the per-world cumulative counter is present and starts at 0"
        );
        assert_eq!(
            observation.pointer("/player/weapons"),
            Some(&json!(["fist", "pistol"])),
            "the weapon set is projected in slot order"
        );
        assert!(
            observation.pointer("/player/weapon").and_then(Value::as_str).is_some(),
            "the ready weapon is retained unchanged"
        );
        // The DEAD observable (`level.items` / `item_count`) stays untouched.
        assert_eq!(observation.pointer("/level/items"), Some(&json!(0)));
    }

    /// **F-5 (reset edge).** A world reload clears the collection diff state so no
    /// cross-map counting occurs, and seeds the fresh world's live set.
    #[test]
    fn reset_clears_the_collection_diff_state() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        // Simulate prior collection state on the live session.
        {
            let mut guard = state.0.lock().expect("session lock");
            let session = guard.as_mut().expect("live session");
            session.items_collected = 7;
            session.last_special_ids.insert(EntityId(9_999_999));
        }

        let observation = state.reset(1, 2, 3).expect("reset");
        assert_eq!(
            observation.pointer("/level/itemsCollected"),
            Some(&json!(0)),
            "a world reload starts the counter at 0"
        );

        let guard = state.0.lock().expect("session lock");
        let session = guard.as_ref().expect("live session");
        assert_eq!(session.items_collected, 0);
        assert!(
            !session.last_special_ids.contains(&EntityId(9_999_999)),
            "the stale world's id is dropped (fresh id namespace)"
        );
    }

    /// **NFR-1 (additive-only).** The collection observer reads the FULL world,
    /// not the bounded observation list: the stored set matches every live
    /// `MobjFlag::Special` id and is never smaller than the observation's list.
    #[test]
    fn observe_collection_reads_the_full_world_not_the_bounded_list() {
        let state = DoomEngineState::default();
        state.launch(1, 3).expect("launch");
        let observation = state.read_state().expect("read_state");

        let guard = state.0.lock().expect("session lock");
        let session = guard.as_ref().expect("live session");
        let live = session
            .engine
            .world()
            .iter()
            .filter(|entity| entity.flags.contains(MobjFlag::Special))
            .count();
        assert_eq!(
            session.last_special_ids.len(),
            live,
            "the FULL world's Special-id set is stored"
        );
        assert!(
            session.last_special_ids.len()
                >= observation["items"].as_array().map_or(0, Vec::len),
            "the stored set is never smaller than the bounded observation list"
        );
    }
}
