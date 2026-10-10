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
//! nearby items, door/switch state). `x`/`y` are integer map units derived from
//! the engine's 16.16 `Fixed`, because `is_progress` compares integers.
//!
//! # Threading
//!
//! The session is Tauri-managed application state behind a `std::sync::Mutex`.
//! Every method takes `&self` and locks narrowly for a short synchronous
//! critical section. The mutex is never held across an `.await` (the async
//! autoplay loop invokes these through `tauri::async_runtime::spawn_blocking`).
//! A **dedicated engine thread is never spawned** — no orphan is constructible.

use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};

use neurodoom::game_data::{MobjFlag, SPRNAMES};
use neurodoom::map::{point_to_angle, MapData, SectorId};
use neurodoom::math::{Angle, Fixed, FRACBITS};
use neurodoom::specials::{is_exit_line, DoorDirection, SpecialThinker};
use neurodoom::types::{AmmoType, Button, Buttons, WeaponType};
use neurodoom::world::{Entity, PeerId};
use neurodoom::{ClassicEngine, DoomError, PlayerAction, SCREENHEIGHT, SCREENWIDTH};

use super::actions::{
    DOOM_ACTION_AMOUNT_DEFAULT, DOOM_ACTION_ANGLE_MAX, DOOM_ACTION_ANGLE_MIN, DOOM_ACTION_BACKWARD,
    DOOM_ACTION_FORWARD, DOOM_ACTION_RUN, DOOM_ACTION_SHOOT, DOOM_ACTION_STRAFE_LEFT,
    DOOM_ACTION_STRAFE_RIGHT, DOOM_ACTION_SWITCH_WEAPON, DOOM_ACTION_TURN_LEFT,
    DOOM_ACTION_TURN_RIGHT, DOOM_ACTION_TURN_TO, DOOM_ACTION_USE, DOOM_ACTION_WEAPON_SLOT_MAX,
    DOOM_ACTION_WEAPON_SLOT_MIN, DOOM_STEP_TICS_MAX,
};

// ── G-275 WAD seam ────────────────────────────────────────────────────────────

/// Test-only WAD path override (G-275). Inert when unset: the shipped path
/// returns the embedded `DOOM1.WAD` by default. QA points this at a
/// tester-written absent/corrupt copy under `.opencode/tmp/3023/wad/`.
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
const OBSERVATION_MAX_ENTRIES: usize = 16;

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
/// exists but cannot be read is [`DoomEngineErrorCode::WadCorrupt`].
fn load_wad_from(override_path: Option<&str>) -> Result<Vec<u8>, DoomEngineError> {
    match override_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => {
            if !std::path::Path::new(path).exists() {
                return Err(DoomEngineError::new(
                    DoomEngineErrorCode::WadMissing,
                    format!("no WAD file at {path}"),
                ));
            }
            std::fs::read(path).map_err(|error| {
                DoomEngineError::new(
                    DoomEngineErrorCode::WadCorrupt,
                    format!("could not read the WAD at {path}: {error}"),
                )
            })
        }
        None => Ok(EMBEDDED_WAD.to_vec()),
    }
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
    /// the `FREDO_DOOM_FAIL_ENGINE_SPAWN` induction lever).
    pub fn launch(&self, map: i64, skill: i64) -> Result<DoomSessionInfo, DoomEngineError> {
        let mut guard = self.lock();
        if let Some(session) = guard.as_ref() {
            return Ok(session_info(session));
        }

        // G-275 failure lever (inert when unset): refuse construction before any
        // session exists, so the typed error surfaces with no engine and no orphan.
        if super::failure_seam::fail_engine_spawn_requested() {
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
        let wad = load_wad()?;
        let engine = construct_engine(&wad, &map_name)?;
        *guard = Some(DoomSession {
            engine,
            wad,
            episode: 1,
            map,
            skill,
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
        let guard = self.lock();
        let session = guard.as_ref().ok_or_else(DoomEngineError::no_session)?;
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
        session.engine.render_for(LOCAL_PEER);
        Ok(observation(session))
    }

    /// The current frame as a base64-encoded PNG (RGBA 320×200).
    ///
    /// Renders from the local player's POV when the framebuffer is not yet
    /// populated (a freshly constructed session has no frame until it renders).
    pub fn frame_png(&self) -> Result<String, DoomEngineError> {
        let mut guard = self.lock();
        let session = guard.as_mut().ok_or_else(DoomEngineError::no_session)?;
        if session.engine.framebuffer().len() != FRAME_BYTES {
            session.engine.render_for(LOCAL_PEER);
        }
        encode_frame_png(session.engine.framebuffer())
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

/// Encode a 320×200 RGBA framebuffer as a base64 PNG (the binding
/// `DoomFrame { pngBase64 }` shape the webview canvas draws).
fn encode_frame_png(framebuffer: &[u8]) -> Result<String, DoomEngineError> {
    let width = SCREENWIDTH as u32;
    let height = SCREENHEIGHT as u32;
    let buffer = image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(
        width,
        height,
        framebuffer.to_vec(),
    )
    .ok_or_else(|| {
        DoomEngineError::new(
            DoomEngineErrorCode::EngineStartFailed,
            format!(
                "framebuffer is {} bytes, expected {}",
                framebuffer.len(),
                FRAME_BYTES
            ),
        )
    })?;
    let dynamic = image::DynamicImage::ImageRgba8(buffer);
    let mut png = std::io::Cursor::new(Vec::new());
    dynamic
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| {
            DoomEngineError::new(
                DoomEngineErrorCode::EngineStartFailed,
                format!("frame PNG encode failed: {error}"),
            )
        })?;
    Ok(STANDARD.encode(png.into_inner()))
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

/// Build the parity observation for a session (see the module docs).
fn observation(session: &DoomSession) -> Value {
    let engine = &session.engine;
    let world = engine.world();
    let map = engine.map();
    let done = engine.level_complete();

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

    json!({
        "tic": u64::from(world.tick),
        "done": done,
        "outcome": outcome,
        "level": {
            "episode": session.episode,
            "map": session.map,
            "skill": session.skill,
            "kills": kills,
            "items": items,
            "secrets": secrets,
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
        },
        "enemies": enemies(world, map, px, py, eye_z, angle, player_id),
        "items": items_observation(world, px, py, angle, player_id),
        "doors": doors(world, map, px, py, angle),
        "exit": exit_observation(map, px, py),
    })
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
        out.push(json!({
            "kind": entity_kind(entity),
            "hp": entity.health,
            "direction": relative_direction(px, py, angle, entity.x, entity.y),
            "distance": distance_units(entity.x - px, entity.y - py),
        }));
        if out.len() >= OBSERVATION_MAX_ENTRIES {
            break;
        }
    }
    out
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

/// The optional exit-distance observation: the nearest exit-line vertex in
/// integer map units, or an empty object when no exit line is reachable.
fn exit_observation(map: &MapData, px: Fixed, py: Fixed) -> Value {
    let mut best: Option<i64> = None;
    for line in &map.lines {
        if !is_exit_line(line.special) {
            continue;
        }
        for vertex_id in [line.v1, line.v2] {
            let Some(vertex) = map.vertexes.get(vertex_id as usize) else {
                continue;
            };
            let distance = distance_units(vertex.x - px, vertex.y - py);
            if best.is_none_or(|previous| distance < previous) {
                best = Some(distance);
            }
        }
    }
    match best {
        Some(distance) => json!({ "distance": distance }),
        None => json!({}),
    }
}

/// The nearest door-sector vertex, as `(distance_in_units, direction)`.
fn door_distance_and_direction(
    map: &MapData,
    sector: SectorId,
    px: Fixed,
    py: Fixed,
    angle: Angle,
) -> (i64, &'static str) {
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
    match best {
        Some((distance, vx, vy)) => (distance, relative_direction(px, py, angle, vx, vy)),
        None => (0, "front"),
    }
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

        let png = state.frame_png().expect("frame_png");
        let bytes = STANDARD.decode(png).expect("base64");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "PNG magic");
        let decoded = image::load_from_memory(&bytes).expect("decode png");
        assert_eq!((decoded.width(), decoded.height()), (320, 200));
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
            state.frame_png().expect_err("no session").code,
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
        let bytes = load_wad_from(Some(path.to_str().expect("utf-8 path"))).expect("read");
        let error = construct_engine(&bytes, "E1M1")
            .err()
            .expect("garbage does not build");
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
}
