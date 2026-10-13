//! Doom observation geometry (Spec #3030, S1).
//!
//! Additive, bounded wall/obstacle geometry appended to the Doom Companion's
//! observation ([`super::engine::observation`]). The geometry is derived from
//! the engine's semantic/depth buffers via
//! [`neurodoom::perception::PerceptionFrame`] and summarized as a bounded
//! `walls` array — one entry per sampled horizontal ray:
//! `{ direction, distance, blocked }`.
//!
//! # Contract (Architect-pinned — do not deviate)
//!
//! * `walls` is ALWAYS a present JSON array — `[]` in open space AND on the AC4
//!   fallback path (never absent / `null`).
//! * `direction` uses the `enemies`/`items`/`doors` vocabulary
//!   ([`super::engine::relative_direction`]): `"front"` / `"left"` / `"right"`.
//!   `"back"` is never emitted — the forward perception frame has no rear
//!   columns.
//! * `blocked == (distance <= DOOM_PERCEPTION_NEAR_RANGE)`.
//! * The array is bounded by construction: ≤ [`DOOM_PERCEPTION_RAY_COUNT`]
//!   rays, capped at [`DOOM_OBSERVATION_MAX_WALLS`]. No per-pixel payload ever
//!   reaches the prompt.
//!
//! # Purity / determinism
//!
//! [`walls_observation`] is a pure function of the frame — no wall clock, no RNG
//! — so two identical position/angle reads produce byte-identical geometry
//! (NFR-DET).
//!
//! # Test-only induction
//!
//! [`DOOM_FAIL_PERCEPTION_ENV`] (`FREDO_DOOM_FAIL_PERCEPTION=1`) makes the
//! perception bridge report the buffers as unavailable (AC4 / G-275 / G-300). It
//! is inert when unset, so the production path is unchanged.

use neurodoom::engine::ClassicEngine;
use neurodoom::math::{Fixed, FRACBITS};
use neurodoom::perception::PerceptionFrame;
use neurodoom::render::SemanticClass;
use serde_json::{json, Value};

use super::engine::OBSERVATION_MAX_ENTRIES;

// ── Pinned geometry-contract constants (Spec #3030 ST-1) ─────────────────────

/// Near/blocked threshold, integer map units. An obstruction at or below this
/// distance marks its ray `blocked` (REQ-2 / AC2).
pub const DOOM_PERCEPTION_NEAR_RANGE: i64 = 64;

/// Sampling range, integer map units. An obstruction farther than this is never
/// emitted (REQ-1 / REQ-5).
pub const DOOM_PERCEPTION_SAMPLING_RANGE: i64 = 1024;

/// Fixed number of horizontal sample rays across the perception frame.
pub const DOOM_PERCEPTION_RAY_COUNT: usize = 9;

/// Hard cap on the emitted `walls` array length — mirrors
/// [`OBSERVATION_MAX_ENTRIES`] (= 16). By construction the builder emits
/// ≤ [`DOOM_PERCEPTION_RAY_COUNT`].
pub const DOOM_OBSERVATION_MAX_WALLS: usize = OBSERVATION_MAX_ENTRIES;

/// Byte budget for the serialized observation JSON (NFR-BOUND).
pub const DOOM_OBSERVATION_BYTE_BUDGET: usize = 8192;

/// Byte budget for the model request `messages[1].content` (NFR-BOUND).
pub const DOOM_REQUEST_BYTE_BUDGET: usize = 16384;

/// The `FREDO_DOOM_FAIL_PERCEPTION` AC4 induction lever (ST-2). When set to
/// `1`, [`perception_frame`] reports the buffers as unavailable. Inert when
/// unset, so the production path is unchanged.
pub const DOOM_FAIL_PERCEPTION_ENV: &str = "FREDO_DOOM_FAIL_PERCEPTION";

// ── Pinned forward-sensor contract constants (Spec #3039 ST-2, AC1) ──────────

/// Fixed number of horizontal sample rays emitted by the `forward` sensor.
/// Mirrors [`DOOM_PERCEPTION_RAY_COUNT`] (the sensor reuses the same sampling).
pub const DOOM_SENSOR_RAY_COUNT: usize = 9;

/// Hard cap on the emitted `forward.rays` array length.
pub const DOOM_SENSOR_MAX_RAYS: usize = 9;

/// Hard cap on the emitted `forward.openings` array length.
pub const DOOM_SENSOR_MAX_OPENINGS: usize = 8;

/// Hard cap on the emitted `forward.doorBearings` array length.
pub const DOOM_SENSOR_MAX_DOORS: usize = 8;

// ── AC4 induction lever (mirrors failure_seam.rs) ────────────────────────────

/// The `FREDO_DOOM_FAIL_PERCEPTION` lever: `true` iff set to `"1"`.
pub fn fail_perception_requested() -> bool {
    fail_perception_from(std::env::var(DOOM_FAIL_PERCEPTION_ENV).ok().as_deref())
}

/// Pure parser for the AC4 lever (unit-testable without env mutation).
pub fn fail_perception_from(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

// ── Engine bridge (ST-2) ─────────────────────────────────────────────────────

/// The engine → perception bridge: `Some(frame)` iff the semantic and depth
/// buffers are populated AND the [`DOOM_FAIL_PERCEPTION_ENV`] lever is unset;
/// otherwise `None` (the AC4 fallback branch).
///
/// This is the ONLY coupling to the `neurodoom` buffer signatures
/// (`buffer_size` / `semantic_buffer` / `depth_buffer` + `PerceptionFrame`); the
/// projection stays a pure function of the frame.
pub fn perception_frame(engine: &ClassicEngine) -> Option<PerceptionFrame> {
    perception_frame_with(engine, fail_perception_requested())
}

/// Deterministic form of [`perception_frame`] (§ST-2): the failure lever is
/// injected, so the fallback branch is unit-testable without mutating
/// process-global env (G-222).
pub(crate) fn perception_frame_with(
    engine: &ClassicEngine,
    fail: bool,
) -> Option<PerceptionFrame> {
    if fail || !perception_buffers_populated(engine) {
        return None;
    }
    Some(PerceptionFrame::from_engine(engine))
}

/// Whether the engine's semantic/depth buffers are populated (`width × height`).
///
/// An unrendered session (e.g. the first `read_state`, before any `render_for`)
/// has empty buffers — this is the AC4 fallback condition.
fn perception_buffers_populated(engine: &ClassicEngine) -> bool {
    let (width, height) = engine.buffer_size();
    let Some(expected) = width.checked_mul(height) else {
        return false;
    };
    expected > 0
        && engine.semantic_buffer().len() == expected
        && engine.depth_buffer().len() == expected
}

// ── Pure projection (ST-1) ───────────────────────────────────────────────────

/// Pure geometry projection — unit-testable with no env, no clock, no RNG.
///
/// `None` ⇒ the AC4 fallback branch: `[]` (the current field set with an empty
/// geometry list). `Some(frame)` ⇒ ≤ [`DOOM_PERCEPTION_RAY_COUNT`] entries, each
/// `{ direction, distance, blocked }`.
pub fn walls_observation(frame: Option<&PerceptionFrame>) -> Vec<Value> {
    let Some(frame) = frame else {
        return Vec::new();
    };
    if frame.width == 0 || frame.height == 0 {
        return Vec::new();
    }

    let rays = DOOM_PERCEPTION_RAY_COUNT.min(frame.width).max(1);
    let mut walls = Vec::new();
    for ray in 0..rays {
        let column = sample_column(ray, rays, frame.width);
        let Some(distance) = nearest_obstruction_units(frame, column) else {
            continue;
        };
        if distance <= 0 || distance > DOOM_PERCEPTION_SAMPLING_RANGE {
            continue;
        }
        walls.push(json!({
            "direction": ray_direction(column, frame.width),
            "distance": distance,
            "blocked": distance <= DOOM_PERCEPTION_NEAR_RANGE,
        }));
        if walls.len() >= DOOM_OBSERVATION_MAX_WALLS {
            break;
        }
    }
    walls
}

/// The frame column sampled by ray `ray` of `rays`, evenly spaced and
/// deterministic (the middle column for a single ray).
fn sample_column(ray: usize, rays: usize, width: usize) -> usize {
    if rays <= 1 {
        width / 2
    } else {
        ray * (width - 1) / (rays - 1)
    }
}

/// The nearest wall/door depth, in integer map units, down column `column`, or
/// `None` when the column sees no obstruction.
fn nearest_obstruction_units(frame: &PerceptionFrame, column: usize) -> Option<i64> {
    if column >= frame.width {
        return None;
    }
    let wall = SemanticClass::Wall as u8;
    let door = SemanticClass::Door as u8;
    let mut nearest: Option<Fixed> = None;
    for row in 0..frame.height {
        let index = row * frame.width + column;
        let is_obstruction = matches!(
            frame.semantic.get(index).copied(),
            Some(class) if class == wall || class == door
        );
        if !is_obstruction {
            continue;
        }
        let Some(&depth) = frame.depth.get(index) else {
            continue;
        };
        if depth <= 0 {
            continue;
        }
        if nearest.is_none_or(|previous| depth < previous) {
            nearest = Some(depth);
        }
    }
    nearest.map(|depth| i64::from(depth >> FRACBITS))
}

/// Bucket a frame column into the `enemies`/`items`/`doors` direction
/// vocabulary (`front`/`left`/`right`; never `back`).
fn ray_direction(column: usize, width: usize) -> &'static str {
    if width < 3 {
        return "front";
    }
    let third = width / 3;
    if column < third {
        "left"
    } else if column < third * 2 {
        "front"
    } else {
        "right"
    }
}

// ── Forward sensor (Spec #3039 ST-2, AC1) ─────────────────────────────────────
//
// The additive, bounded `forward` observation — a SIBLING of `walls`. It
// projects the same semantic/depth buffers into:
//
// * `rays`         — one entry per sampled ray: `{index, direction, distance,
//                    class, blocked}`, `class ∈ {wall, door, enemy, floor,
//                    unknown}`;
// * `openings`     — a contiguous free (floor-class) run between obstructions:
//                    `{direction, distance, width}`;
// * `doorBearings` — the engine's doors as relative bearings:
//                    `{bearing (-180..=180), distance, state}`;
// * `exitBearing`  — the nearest exit line as an absolute bearing:
//                    `{bearing (0..=359), distance}` or `null`.
//
// The projection is a pure function of the frame + the engine-supplied door/
// enemy/exit bearings — no wall clock, no RNG (NFR-DET). When the buffers are
// unavailable ([`perception_frame`] returns `None`) the whole object falls back
// to `{rays:[],openings:[],doorBearings:[],exitBearing:null}` — present, never
// absent/`null`, and the run never fails.

/// An LOS-gated enemy's direction/distance, projected by the engine adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnemyBearing {
    /// `"front"` / `"left"` / `"right"` (the observation direction vocabulary).
    pub direction: &'static str,
    /// Integer map-unit distance.
    pub distance: i64,
}

/// A door's relative bearing/distance/state, projected by the engine adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoorBearing {
    /// Relative bearing in degrees, normalized to `-180..=180`.
    pub bearing: i64,
    /// Integer map-unit distance.
    pub distance: i64,
    /// `"opening"` / `"waiting"` / `"closing"`.
    pub state: &'static str,
}

/// The nearest exit line's absolute bearing/distance, projected by the adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExitBearing {
    /// Absolute bearing in degrees, `0..=359`.
    pub bearing: i64,
    /// Integer map-unit distance.
    pub distance: i64,
}

/// The exhaustive `SemanticClass` → wire-vocabulary mapping (AC1 class
/// discriminator). Every crate variant is mapped explicitly; the classes that
/// are not part of the sensor vocabulary collapse to `"unknown"`.
pub fn semantic_class_to_wire(class: SemanticClass) -> &'static str {
    match class {
        SemanticClass::Wall => "wall",
        SemanticClass::Door => "door",
        SemanticClass::Enemy => "enemy",
        SemanticClass::Floor => "floor",
        SemanticClass::Void
        | SemanticClass::Ceiling
        | SemanticClass::Projectile
        | SemanticClass::Player
        | SemanticClass::Item => "unknown",
    }
}

/// The wire class for a raw semantic-buffer byte, or `None` when the byte is not
/// one of the sensor's obstruction classes (`Wall`/`Door`/`Enemy`). Open
/// surfaces (`Floor`/`Ceiling`/`Void`) are never obstructions.
fn obstruction_class(raw: u8) -> Option<&'static str> {
    [SemanticClass::Wall, SemanticClass::Door, SemanticClass::Enemy]
        .into_iter()
        .find(|class| raw == *class as u8)
        .map(semantic_class_to_wire)
}

/// The empty `forward` object — the buffers-unavailable fallback (AC1).
pub fn empty_forward() -> Value {
    json!({
        "rays": Vec::<Value>::new(),
        "openings": Vec::<Value>::new(),
        "doorBearings": Vec::<Value>::new(),
        "exitBearing": Value::Null,
    })
}

/// Pure `forward` projection (AC1). `frame == None` (the buffers-unavailable /
/// `FREDO_DOOM_FAIL_PERCEPTION` fallback) yields [`empty_forward`]; otherwise the
/// bounded sensor object. The engine supplies `enemies`/`doors`/`exit` from its
/// LOS-gated lists.
pub fn forward_observation(
    frame: Option<&PerceptionFrame>,
    enemies: &[EnemyBearing],
    doors: &[DoorBearing],
    exit: Option<ExitBearing>,
) -> Value {
    let Some(frame) = frame else {
        return empty_forward();
    };
    if frame.width == 0 || frame.height == 0 {
        return empty_forward();
    }

    let rays = forward_rays(frame, enemies);
    let openings = forward_openings(&rays);
    let ray_values: Vec<Value> = rays.iter().take(DOOM_SENSOR_MAX_RAYS).map(ray_json).collect();

    json!({
        "rays": ray_values,
        "openings": openings,
        "doorBearings": door_bearings_json(doors),
        "exitBearing": exit_bearing_json(exit),
    })
}

/// One sampled forward ray (internal, pre-JSON).
struct RaySample {
    index: usize,
    direction: &'static str,
    distance: i64,
    class: &'static str,
    blocked: bool,
}

/// Sample the bounded ray set and apply the LOS-enemy overlay.
fn forward_rays(frame: &PerceptionFrame, enemies: &[EnemyBearing]) -> Vec<RaySample> {
    let rays = DOOM_SENSOR_RAY_COUNT.min(frame.width).max(1);
    let mut samples = Vec::new();
    for index in 0..rays {
        let column = sample_column(index, rays, frame.width);
        let direction = ray_direction(column, frame.width);
        let (class, distance) = match nearest_obstruction_class_units(frame, column) {
            Some((class, distance)) if distance <= DOOM_PERCEPTION_SAMPLING_RANGE => (class, distance),
            _ => ("floor", DOOM_PERCEPTION_SAMPLING_RANGE),
        };
        samples.push(RaySample {
            index,
            direction,
            distance,
            class,
            blocked: distance <= DOOM_PERCEPTION_NEAR_RANGE,
        });
    }
    apply_enemy_overlay(&mut samples, enemies);
    samples.truncate(DOOM_SENSOR_MAX_RAYS);
    samples
}

/// The nearest obstruction `(wire_class, distance_units)` down `column`, or
/// `None` when the column sees no obstruction class.
fn nearest_obstruction_class_units(
    frame: &PerceptionFrame,
    column: usize,
) -> Option<(&'static str, i64)> {
    if column >= frame.width {
        return None;
    }
    let mut nearest: Option<(&'static str, Fixed)> = None;
    for row in 0..frame.height {
        let index = row * frame.width + column;
        let Some(&raw) = frame.semantic.get(index) else {
            continue;
        };
        let Some(class) = obstruction_class(raw) else {
            continue;
        };
        let Some(&depth) = frame.depth.get(index) else {
            continue;
        };
        if depth <= 0 {
            continue;
        }
        if nearest.is_none_or(|(_, previous)| depth < previous) {
            nearest = Some((class, depth));
        }
    }
    nearest.map(|(class, depth)| (class, i64::from(depth >> FRACBITS)))
}

/// Overlay the engine's LOS-gated enemies onto the nearest ray in each facing
/// direction (belt-and-suspenders for the AC1 `enemy` class: the buffer's
/// `SemanticClass::Enemy` is the primary source, this guarantees the class when
/// an enemy is in LOS).
fn apply_enemy_overlay(samples: &mut [RaySample], enemies: &[EnemyBearing]) {
    for direction in ["left", "front", "right"] {
        let Some(nearest) = samples
            .iter()
            .filter(|ray| ray.direction == direction)
            .min_by_key(|ray| ray.distance)
            .map(|ray| ray.index)
        else {
            continue;
        };
        let Some(enemy_distance) = enemies
            .iter()
            .filter(|enemy| enemy.direction == direction)
            .map(|enemy| enemy.distance)
            .min()
        else {
            continue;
        };
        if enemy_distance < samples[nearest].distance {
            samples[nearest].class = "enemy";
            samples[nearest].distance = enemy_distance;
            samples[nearest].blocked = enemy_distance <= DOOM_PERCEPTION_NEAR_RANGE;
        }
    }
}

/// A maximal contiguous run of floor-class rays → an `opening` entry.
fn forward_openings(rays: &[RaySample]) -> Vec<Value> {
    let mut openings = Vec::new();
    let mut start = 0;
    while start < rays.len() {
        if rays[start].class != "floor" {
            start += 1;
            continue;
        }
        let mut end = start;
        while end + 1 < rays.len() && rays[end + 1].class == "floor" {
            end += 1;
        }
        openings.push(opening_json(rays, start, end));
        if openings.len() >= DOOM_SENSOR_MAX_OPENINGS {
            break;
        }
        start = end + 1;
    }
    openings
}

/// One `opening`: direction of the run's centre, the passage distance (the
/// nearest flanking obstruction, or the sampling range when unbounded), and a
/// deterministic integer width estimate of the run's span at that distance.
fn opening_json(rays: &[RaySample], start: usize, end: usize) -> Value {
    let center = (start + end) / 2;
    let direction = rays[center].direction;
    let left = start.checked_sub(1).and_then(|i| rays.get(i)).map(|ray| ray.distance);
    let right = rays.get(end + 1).map(|ray| ray.distance);
    let distance = [left, right]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(DOOM_PERCEPTION_SAMPLING_RANGE);
    let run = (end - start + 1) as i64;
    let width = (2 * distance * run / DOOM_SENSOR_RAY_COUNT as i64).max(1);
    json!({
        "direction": direction,
        "distance": distance,
        "width": width,
    })
}

/// One `forward.rays` entry.
fn ray_json(ray: &RaySample) -> Value {
    json!({
        "index": ray.index,
        "direction": ray.direction,
        "distance": ray.distance,
        "class": ray.class,
        "blocked": ray.blocked,
    })
}

/// The bounded `forward.doorBearings` array.
fn door_bearings_json(doors: &[DoorBearing]) -> Vec<Value> {
    doors
        .iter()
        .take(DOOM_SENSOR_MAX_DOORS)
        .map(|door| {
            json!({
                "bearing": door.bearing.clamp(-180, 180),
                "distance": door.distance,
                "state": door.state,
            })
        })
        .collect()
}

/// The `forward.exitBearing` value — `{bearing, distance}` or `null`.
fn exit_bearing_json(exit: Option<ExitBearing>) -> Value {
    match exit {
        Some(exit) => json!({
            "bearing": exit.bearing.rem_euclid(360),
            "distance": exit.distance,
        }),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic perception frame for the pure-projection pins.
    fn frame(width: usize, height: usize, semantic: Vec<u8>, depth: Vec<Fixed>) -> PerceptionFrame {
        PerceptionFrame {
            tick: 0,
            width,
            height,
            semantic,
            depth,
        }
    }

    /// A frame that is uniformly open (no wall/door classes).
    fn open_frame(width: usize, height: usize) -> PerceptionFrame {
        frame(width, height, vec![SemanticClass::Floor as u8; width * height], vec![0; width * height])
    }

    // ── ST-1 / ST-2: pinned names + lever parser ─────────────────────────────

    #[test]
    fn perception_binding_names_are_pinned() {
        assert_eq!(DOOM_FAIL_PERCEPTION_ENV, "FREDO_DOOM_FAIL_PERCEPTION");
        assert_eq!(DOOM_PERCEPTION_NEAR_RANGE, 64);
        assert_eq!(DOOM_PERCEPTION_SAMPLING_RANGE, 1024);
        assert_eq!(DOOM_PERCEPTION_RAY_COUNT, 9);
        assert_eq!(DOOM_OBSERVATION_MAX_WALLS, OBSERVATION_MAX_ENTRIES);
        assert_eq!(DOOM_OBSERVATION_MAX_WALLS, 16);
        assert_eq!(DOOM_OBSERVATION_BYTE_BUDGET, 8192);
        assert_eq!(DOOM_REQUEST_BYTE_BUDGET, 16384);
    }

    #[test]
    fn fail_perception_lever_parser() {
        assert!(fail_perception_from(Some("1")));
        assert!(fail_perception_from(Some(" 1 ")));
        assert!(!fail_perception_from(Some("0")));
        assert!(!fail_perception_from(Some("01")));
        assert!(!fail_perception_from(Some("true")));
        assert!(!fail_perception_from(Some("")));
        assert!(!fail_perception_from(Some("   ")));
        assert!(!fail_perception_from(None));
    }

    // ── ST-1: pure projection + fallback branch ──────────────────────────────

    #[test]
    fn walls_observation_none_is_the_empty_fallback() {
        assert!(walls_observation(None).is_empty());
    }

    #[test]
    fn walls_observation_empty_frame_is_empty() {
        let empty = frame(0, 0, Vec::new(), Vec::new());
        assert!(walls_observation(Some(&empty)).is_empty());
        let open = open_frame(9, 4);
        assert!(walls_observation(Some(&open)).is_empty());
    }

    #[test]
    fn walls_observation_reports_a_forward_blocked_wall() {
        // A 9-wide column frame; the centre column (4) sees a wall 48 units
        // away → one `front` entry, blocked (48 <= 64).
        let width = 9;
        let height = 3;
        let mut semantic = vec![SemanticClass::Floor as u8; width * height];
        let mut depth = vec![0 as Fixed; width * height];
        for row in 0..height {
            let index = row * width + 4;
            semantic[index] = SemanticClass::Wall as u8;
            depth[index] = 48 << FRACBITS;
        }
        let walls = walls_observation(Some(&frame(width, height, semantic, depth)));
        assert_eq!(walls.len(), 1, "exactly one obstructed ray");
        assert_eq!(walls[0]["direction"], "front");
        assert_eq!(walls[0]["distance"], 48);
        assert_eq!(walls[0]["blocked"], true);
    }

    #[test]
    fn walls_observation_marks_blocked_at_the_near_threshold() {
        let at_threshold = forward_wall_frame(DOOM_PERCEPTION_NEAR_RANGE);
        assert_eq!(walls_observation(Some(&at_threshold))[0]["blocked"], true);
        let beyond_threshold = forward_wall_frame(DOOM_PERCEPTION_NEAR_RANGE + 1);
        assert_eq!(walls_observation(Some(&beyond_threshold))[0]["blocked"], false);
    }

    #[test]
    fn walls_observation_omits_obstructions_beyond_the_sampling_range() {
        let far = forward_wall_frame(DOOM_PERCEPTION_SAMPLING_RANGE + 1);
        assert!(
            walls_observation(Some(&far)).is_empty(),
            "an obstruction beyond the sampling range is never emitted (REQ-5)"
        );
        let at_range = forward_wall_frame(DOOM_PERCEPTION_SAMPLING_RANGE);
        assert_eq!(
            walls_observation(Some(&at_range)).len(),
            1,
            "an obstruction exactly at the sampling range is kept"
        );
    }

    #[test]
    fn walls_observation_is_bounded_and_uses_only_the_direction_vocabulary() {
        // Every column sees a close wall → one entry per ray, capped.
        let width = 320;
        let height = 2;
        let semantic = vec![SemanticClass::Wall as u8; width * height];
        let depth = vec![10 << FRACBITS; width * height];
        let walls = walls_observation(Some(&frame(width, height, semantic, depth)));
        assert!(walls.len() <= DOOM_PERCEPTION_RAY_COUNT, "≤ the ray budget");
        assert!(walls.len() <= DOOM_OBSERVATION_MAX_WALLS, "≤ the wall cap");
        assert_eq!(walls.len(), DOOM_PERCEPTION_RAY_COUNT);
        for entry in &walls {
            let direction = entry["direction"].as_str().expect("direction string");
            assert!(
                matches!(direction, "front" | "left" | "right"),
                "\"back\" is never emitted, got {direction}"
            );
            assert!(entry["distance"].as_i64().is_some());
            assert!(entry["blocked"].as_bool().is_some());
        }
    }

    #[test]
    fn nearest_obstruction_units_picks_the_nearest_wall() {
        let width = 9;
        let height = 3;
        let mut semantic = vec![SemanticClass::Floor as u8; width * height];
        let mut depth = vec![0 as Fixed; width * height];
        // Column 4: a near wall (row 0) and a far wall (row 1) → nearest wins.
        semantic[0 * width + 4] = SemanticClass::Wall as u8;
        depth[0 * width + 4] = 48 << FRACBITS;
        semantic[1 * width + 4] = SemanticClass::Wall as u8;
        depth[1 * width + 4] = 500 << FRACBITS;
        // A door pixel counts as an obstruction too.
        semantic[2 * width + 4] = SemanticClass::Door as u8;
        depth[2 * width + 4] = 32 << FRACBITS;
        let f = frame(width, height, semantic, depth);
        assert_eq!(nearest_obstruction_units(&f, 4), Some(32));
        assert_eq!(nearest_obstruction_units(&f, 0), None);
        assert_eq!(nearest_obstruction_units(&f, width), None, "out of range");
    }

    #[test]
    fn ray_direction_buckets_three_columns_per_third() {
        // width 9 → thirds [0,3) left, [3,6) front, [6,9) right.
        assert_eq!(ray_direction(0, 9), "left");
        assert_eq!(ray_direction(2, 9), "left");
        assert_eq!(ray_direction(3, 9), "front");
        assert_eq!(ray_direction(5, 9), "front");
        assert_eq!(ray_direction(6, 9), "right");
        assert_eq!(ray_direction(8, 9), "right");
        // Degenerate widths never panic and default to the forward ray.
        assert_eq!(ray_direction(0, 0), "front");
        assert_eq!(ray_direction(0, 1), "front");
        assert_eq!(ray_direction(1, 2), "front");
    }

    #[test]
    fn sample_column_is_deterministic_and_evenly_spaced() {
        assert_eq!(sample_column(0, 1, 9), 4);
        assert_eq!(sample_column(0, 9, 9), 0);
        assert_eq!(sample_column(8, 9, 9), 8);
        assert_eq!(sample_column(4, 9, 9), 4);
        // Two calls are identical (pure).
        assert_eq!(sample_column(3, 9, 320), sample_column(3, 9, 320));
    }

    /// A 9-wide frame whose centre column carries a wall `distance` units away.
    fn forward_wall_frame(distance: i64) -> PerceptionFrame {
        let width = 9;
        let height = 3;
        let mut semantic = vec![SemanticClass::Floor as u8; width * height];
        let mut depth = vec![0 as Fixed; width * height];
        for row in 0..height {
            let index = row * width + 4;
            semantic[index] = SemanticClass::Wall as u8;
            depth[index] = (distance as Fixed) << FRACBITS;
        }
        frame(width, height, semantic, depth)
    }

    // ── ST-4 (F-6/F-7 static leg): fallback + determinism + bound + payload ──

    /// The length of the longest array nested anywhere in a JSON value. Used to
    /// prove no array scales with the 320×200 framebuffer (F-6c) — a per-pixel
    /// payload would be ~64,000 elements.
    fn longest_array_len(value: &Value) -> usize {
        match value {
            Value::Array(items) => items
                .iter()
                .map(longest_array_len)
                .max()
                .unwrap_or(0)
                .max(items.len()),
            Value::Object(map) => map.values().map(longest_array_len).max().unwrap_or(0),
            _ => 0,
        }
    }

    /// **ST-4 (AC4 fallback, F-7 static).** `walls_observation(None)` is the AC4
    /// fallback branch: `[]` — never absent, never a panic.
    #[test]
    fn st4_none_falls_back_to_an_empty_walls_array() {
        assert!(
            walls_observation(None).is_empty(),
            "the AC4 fallback branch is `[]`"
        );
    }

    /// **ST-4 (NFR-DET, F-7 static).** `walls_observation(Some(frame))` is
    /// deterministic (two calls on identical input are byte-identical) and its
    /// length is bounded by BOTH the wall cap (16) and the ray budget (9).
    #[test]
    fn st4_projection_is_deterministic_and_bounded() {
        // A busy full-frame scene: every column sees a close wall → one entry
        // per emitted ray.
        let width = 320;
        let height = 200;
        let semantic = vec![SemanticClass::Wall as u8; width * height];
        let depth = vec![10 << FRACBITS; width * height];
        let f = frame(width, height, semantic, depth);

        let first = walls_observation(Some(&f));
        let second = walls_observation(Some(&f));
        assert_eq!(
            first, second,
            "identical input ⇒ byte-identical output (no clock, no RNG)"
        );
        assert!(
            first.len() <= DOOM_OBSERVATION_MAX_WALLS,
            "≤ the wall cap ({DOOM_OBSERVATION_MAX_WALLS})"
        );
        assert!(
            first.len() <= DOOM_PERCEPTION_RAY_COUNT,
            "≤ the ray budget ({DOOM_PERCEPTION_RAY_COUNT})"
        );
        assert_eq!(first.len(), DOOM_PERCEPTION_RAY_COUNT);
    }

    /// **ST-4 (NFR-BOUND, F-6a/F-6c/F-6d).** A representative *bounded*
    /// observation — capped `enemies`/`items`/`doors` plus a full `walls` array
    /// — serializes within [`DOOM_OBSERVATION_BYTE_BUDGET`], and NO array scales
    /// with the 320×200 framebuffer (~64,000 elements): there is no per-pixel
    /// payload.
    #[test]
    fn st4_bounded_observation_fits_the_byte_budget_with_no_per_pixel_array() {
        let width = 320;
        let height = 200;
        let semantic = vec![SemanticClass::Wall as u8; width * height];
        let depth = vec![10 << FRACBITS; width * height];
        let walls = Value::Array(walls_observation(Some(&frame(width, height, semantic, depth))));
        let walls_len = walls.as_array().map(Vec::len).unwrap_or(0);

        let enemies: Vec<Value> = (0..OBSERVATION_MAX_ENTRIES)
            .map(|i| {
                serde_json::json!({
                    "kind": "imp",
                    "hp": 60,
                    "direction": "front",
                    "distance": (i as i64) * 96,
                })
            })
            .collect();
        let items: Vec<Value> = (0..OBSERVATION_MAX_ENTRIES)
            .map(|i| {
                serde_json::json!({
                    "kind": "stimpack",
                    "direction": "left",
                    "distance": (i as i64) * 48,
                })
            })
            .collect();
        let doors: Vec<Value> = (0..OBSERVATION_MAX_ENTRIES)
            .map(|i| {
                serde_json::json!({
                    "kind": "door",
                    "state": "opening",
                    "direction": "right",
                    "distance": (i as i64) * 64 + 32,
                })
            })
            .collect();

        let observation = serde_json::json!({
            "tic": 12345u64,
            "done": false,
            "outcome": "alive",
            "level": { "episode": 1, "map": 1, "skill": 3, "kills": 0, "items": 0, "secrets": 0 },
            "player": {
                "x": 1056, "y": -3616, "angle": 90, "health": 100, "armor": 0,
                "ammo": { "bullets": 50, "shells": 0, "rockets": 0, "cells": 0 },
                "weapon": "pistol",
            },
            "enemies": enemies,
            "items": items,
            "doors": doors,
            "exit": { "distance": 812 },
            "walls": walls,
        });

        let serialized = observation.to_string();
        assert!(
            serialized.len() <= DOOM_OBSERVATION_BYTE_BUDGET,
            "F-6a: serialized observation is {} bytes, budget {DOOM_OBSERVATION_BYTE_BUDGET}",
            serialized.len()
        );
        assert_eq!(walls_len, DOOM_PERCEPTION_RAY_COUNT, "a full walls array");

        // F-6c: no per-pixel payload — the longest array is the 16-entry cap, far
        // below the 320×200 framebuffer (~64,000).
        let framebuffer_elements = width * height;
        let longest = longest_array_len(&observation);
        assert_eq!(
            longest, OBSERVATION_MAX_ENTRIES,
            "the longest array is the {OBSERVATION_MAX_ENTRIES}-entry cap"
        );
        assert!(
            longest < framebuffer_elements,
            "no array scales with the framebuffer: {longest} < {framebuffer_elements}"
        );
    }

    // ── Spec #3039 ST-2: the additive `forward` sensor (AC1) ─────────────────

    #[test]
    fn forward_sensor_constants_are_pinned() {
        assert_eq!(DOOM_SENSOR_RAY_COUNT, 9);
        assert_eq!(DOOM_SENSOR_MAX_RAYS, 9);
        assert_eq!(DOOM_SENSOR_MAX_OPENINGS, 8);
        assert_eq!(DOOM_SENSOR_MAX_DOORS, 8);
        assert_eq!(
            DOOM_SENSOR_RAY_COUNT, DOOM_PERCEPTION_RAY_COUNT,
            "the sensor reuses the perception ray count"
        );
    }

    /// **AC1 class discriminator (G-028/G-299).** The mapping covers EVERY
    /// `neurodoom::SemanticClass` variant explicitly; only the sensor vocabulary
    /// (`wall`/`door`/`enemy`/`floor`) is named, the rest collapse to `unknown`.
    #[test]
    fn semantic_class_to_wire_is_exhaustive() {
        assert_eq!(semantic_class_to_wire(SemanticClass::Wall), "wall");
        assert_eq!(semantic_class_to_wire(SemanticClass::Door), "door");
        assert_eq!(semantic_class_to_wire(SemanticClass::Enemy), "enemy");
        assert_eq!(semantic_class_to_wire(SemanticClass::Floor), "floor");
        assert_eq!(semantic_class_to_wire(SemanticClass::Void), "unknown");
        assert_eq!(semantic_class_to_wire(SemanticClass::Ceiling), "unknown");
        assert_eq!(semantic_class_to_wire(SemanticClass::Projectile), "unknown");
        assert_eq!(semantic_class_to_wire(SemanticClass::Player), "unknown");
        assert_eq!(semantic_class_to_wire(SemanticClass::Item), "unknown");
    }

    #[test]
    fn forward_observation_none_is_the_empty_fallback() {
        let forward = forward_observation(None, &[], &[], None);
        assert_eq!(forward["rays"].as_array().map(Vec::len), Some(0));
        assert_eq!(forward["openings"].as_array().map(Vec::len), Some(0));
        assert_eq!(forward["doorBearings"].as_array().map(Vec::len), Some(0));
        assert_eq!(forward["exitBearing"], Value::Null);
    }

    #[test]
    fn forward_observation_empty_frame_is_the_empty_fallback() {
        let empty = frame(0, 0, Vec::new(), Vec::new());
        let forward = forward_observation(Some(&empty), &[], &[], None);
        assert_eq!(forward["rays"].as_array().map(Vec::len), Some(0));
        assert_eq!(forward["exitBearing"], Value::Null);
    }

    #[test]
    fn forward_observation_reports_a_classed_wall_ray() {
        // Centre column (4) sees a wall 48 units away → ray 4 is `front`/`wall`.
        let forward = forward_observation(Some(&forward_wall_frame(48)), &[], &[], None);
        let rays = forward["rays"].as_array().expect("rays");
        assert_eq!(rays.len(), DOOM_SENSOR_RAY_COUNT);
        assert_eq!(rays[4]["index"], 4);
        assert_eq!(rays[4]["direction"], "front");
        assert_eq!(rays[4]["class"], "wall");
        assert_eq!(rays[4]["distance"], 48);
        assert_eq!(rays[4]["blocked"], true);
        // Open rays report `floor` at the sampling range (never blocked).
        assert_eq!(rays[0]["class"], "floor");
        assert_eq!(rays[0]["distance"], DOOM_PERCEPTION_SAMPLING_RANGE);
        assert_eq!(rays[0]["blocked"], false);
    }

    #[test]
    fn forward_observation_reports_a_door_class_ray() {
        let width = 9;
        let height = 3;
        let mut semantic = vec![SemanticClass::Floor as u8; width * height];
        let mut depth = vec![0 as Fixed; width * height];
        for row in 0..height {
            semantic[row * width + 4] = SemanticClass::Door as u8;
            depth[row * width + 4] = 96 << FRACBITS;
        }
        let forward = forward_observation(Some(&frame(width, height, semantic, depth)), &[], &[], None);
        assert_eq!(forward["rays"][4]["class"], "door");
        assert_eq!(forward["rays"][4]["distance"], 96);
        assert_eq!(forward["rays"][4]["blocked"], false, "96 > near range");
    }

    #[test]
    fn forward_observation_reports_enemy_from_the_buffer() {
        let width = 9;
        let height = 3;
        let mut semantic = vec![SemanticClass::Floor as u8; width * height];
        let mut depth = vec![0 as Fixed; width * height];
        for row in 0..height {
            semantic[row * width + 4] = SemanticClass::Enemy as u8;
            depth[row * width + 4] = 128 << FRACBITS;
        }
        let forward = forward_observation(Some(&frame(width, height, semantic, depth)), &[], &[], None);
        assert_eq!(
            forward["rays"][4]["class"], "enemy",
            "the buffer's SemanticClass::Enemy maps to the `enemy` class"
        );
        assert_eq!(forward["rays"][4]["distance"], 128);
    }

    #[test]
    fn forward_observation_overlays_an_los_enemy_onto_the_nearest_ray() {
        // Fully open frame → every ray is `floor`; an LOS enemy in front is
        // projected onto the nearest front ray.
        let open = open_frame(9, 3);
        let enemies = [EnemyBearing {
            direction: "front",
            distance: 120,
        }];
        let forward = forward_observation(Some(&open), &enemies, &[], None);
        let rays = forward["rays"].as_array().expect("rays");
        let enemy = rays
            .iter()
            .find(|ray| ray["class"] == "enemy")
            .expect("an enemy ray");
        assert_eq!(enemy["direction"], "front");
        assert_eq!(enemy["distance"], 120);
        assert_eq!(enemy["blocked"], false);
        assert_eq!(
            rays.iter().filter(|ray| ray["class"] == "enemy").count(),
            1,
            "exactly one ray carries the enemy"
        );
    }

    #[test]
    fn forward_observation_reports_openings_between_obstructions() {
        // Columns 0 and 8 carry walls; columns 1..=7 are open → one opening.
        let width = 9;
        let height = 3;
        let mut semantic = vec![SemanticClass::Floor as u8; width * height];
        let mut depth = vec![0 as Fixed; width * height];
        for row in 0..height {
            semantic[row * width] = SemanticClass::Wall as u8;
            depth[row * width] = 100 << FRACBITS;
            semantic[row * width + 8] = SemanticClass::Wall as u8;
            depth[row * width + 8] = 200 << FRACBITS;
        }
        let forward = forward_observation(Some(&frame(width, height, semantic, depth)), &[], &[], None);
        let openings = forward["openings"].as_array().expect("openings");
        assert_eq!(openings.len(), 1, "one contiguous free run");
        assert_eq!(openings[0]["direction"], "front");
        assert_eq!(openings[0]["distance"], 100, "the nearest flank");
        let expected_width = 2 * 100 * 7 / DOOM_SENSOR_RAY_COUNT as i64;
        assert_eq!(openings[0]["width"], expected_width);
    }

    #[test]
    fn forward_observation_reports_door_and_exit_bearings() {
        let open = open_frame(9, 3);
        let doors = [DoorBearing {
            bearing: -45,
            distance: 96,
            state: "opening",
        }];
        let exit = ExitBearing {
            bearing: 90,
            distance: 812,
        };
        let forward = forward_observation(Some(&open), &[], &doors, Some(exit));
        let door_bearings = forward["doorBearings"].as_array().expect("doorBearings");
        assert_eq!(door_bearings.len(), 1);
        assert_eq!(door_bearings[0]["bearing"], -45);
        assert_eq!(door_bearings[0]["distance"], 96);
        assert_eq!(door_bearings[0]["state"], "opening");
        assert_eq!(forward["exitBearing"]["bearing"], 90);
        assert_eq!(forward["exitBearing"]["distance"], 812);
    }

    #[test]
    fn forward_observation_is_bounded_and_deterministic() {
        let width = 320;
        let height = 200;
        let semantic = vec![SemanticClass::Wall as u8; width * height];
        let depth = vec![10 << FRACBITS; width * height];
        let f = frame(width, height, semantic, depth);
        let many_doors: Vec<DoorBearing> = (0..32)
            .map(|i| DoorBearing {
                bearing: i * 10 - 180,
                distance: i * 32,
                state: "waiting",
            })
            .collect();

        let first = forward_observation(Some(&f), &[], &many_doors, None);
        let second = forward_observation(Some(&f), &[], &many_doors, None);
        assert_eq!(first, second, "identical input ⇒ byte-identical output");

        let rays = first["rays"].as_array().expect("rays");
        assert_eq!(rays.len(), DOOM_SENSOR_MAX_RAYS);
        assert!(rays.len() <= DOOM_SENSOR_MAX_RAYS);
        let openings = first["openings"].as_array().expect("openings");
        assert!(openings.len() <= DOOM_SENSOR_MAX_OPENINGS);
        let door_bearings = first["doorBearings"].as_array().expect("doorBearings");
        assert_eq!(door_bearings.len(), DOOM_SENSOR_MAX_DOORS);
        for door in door_bearings {
            let bearing = door["bearing"].as_i64().expect("bearing");
            assert!((-180..=180).contains(&bearing), "bearing in -180..=180");
        }
    }

    /// **NFR-1.** A representative observation with the `forward` sensor at its
    /// caps (9 rays + 8 openings + 8 doorBearings + exit) alongside the capped
    /// `enemies`/`items`/`doors`/`walls` stays within
    /// [`DOOM_OBSERVATION_BYTE_BUDGET`] and carries NO per-pixel array.
    #[test]
    fn forward_sensor_fits_the_observation_byte_budget() {
        let width = 320;
        let height = 200;
        let semantic = vec![SemanticClass::Wall as u8; width * height];
        let depth = vec![10 << FRACBITS; width * height];
        let walls = Value::Array(walls_observation(Some(&frame(width, height, semantic, depth))));

        let doors_input: Vec<DoorBearing> = (0..DOOM_SENSOR_MAX_DOORS)
            .map(|i| DoorBearing {
                bearing: i as i64 * 20 - 70,
                distance: i as i64 * 64 + 32,
                state: "opening",
            })
            .collect();
        let forward = forward_observation(
            Some(&frame(
                width,
                height,
                vec![SemanticClass::Floor as u8; width * height],
                vec![0 as Fixed; width * height],
            )),
            &[EnemyBearing {
                direction: "front",
                distance: 256,
            }],
            &doors_input,
            Some(ExitBearing {
                bearing: 270,
                distance: 812,
            }),
        );

        let observation = serde_json::json!({
            "tic": 12345u64,
            "done": false,
            "outcome": "alive",
            "level": { "episode": 1, "map": 1, "skill": 3, "kills": 0, "items": 0, "secrets": 0 },
            "player": {
                "x": 1056, "y": -3616, "angle": 90, "health": 100, "armor": 0,
                "ammo": { "bullets": 50, "shells": 0, "rockets": 0, "cells": 0 },
                "weapon": "pistol",
            },
            "enemies": vec![serde_json::json!({ "kind": "imp", "hp": 60, "direction": "front", "distance": 256 })],
            "items": Vec::<Value>::new(),
            "doors": Vec::<Value>::new(),
            "exit": { "distance": 812 },
            "walls": walls,
            "forward": forward,
        });

        let serialized = observation.to_string();
        assert!(
            serialized.len() <= DOOM_OBSERVATION_BYTE_BUDGET,
            "serialized observation is {} bytes, budget {DOOM_OBSERVATION_BYTE_BUDGET}",
            serialized.len()
        );
        let framebuffer_elements = width * height;
        let longest = longest_array_len(&observation);
        assert!(
            longest <= DOOM_SENSOR_MAX_RAYS.max(OBSERVATION_MAX_ENTRIES),
            "the longest array is a pinned cap, got {longest}"
        );
        assert!(
            longest < framebuffer_elements,
            "no array scales with the framebuffer: {longest} < {framebuffer_elements}"
        );
    }
}
