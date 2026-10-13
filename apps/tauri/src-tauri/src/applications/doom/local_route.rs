//! Local, map-derived decision source (Spec #3039 ST-7).
//!
//! [`LocalRouteSource`] is the **deterministic, model-independent** decision
//! source that makes AC5's completion capability a real mechanism instead of a
//! model-quality gamble. It implements the SAME
//! [`DoomDecisionSource`](crate::infrastructure::companion::doom_decision::DoomDecisionSource)
//! contract the model path uses, so the continuous loop drives it unchanged.
//!
//! On every [`DoomDecisionSource::decide`] it:
//!
//! 1. resolves the level from `observation["level"]["map"]` and lazily builds +
//!    caches the [`MapData`] for `E1{map}` (once per level) via
//!    [`super::engine::load_wad`] + `neurodoom::ClassicEngine::new` — the exact
//!    API [`super::navigation`] already uses;
//! 2. reads the player's integer `(x, y)` and asks the cached
//!    [`navigation::WalkGrid`] for a deterministic route to the nearest
//!    non-secret exit (an engine-accurate A* over free cells, string-pulled into
//!    wall-free legs), then pure-pursues it — the next call recomputes from the
//!    then-current position (a receding horizon);
//! 3. when the route is empty (no exit reachable, or the player stands outside
//!    every sector) falls back to a reactive plan — an `OpenDoor` for a near
//!    front door plus a `Move` toward the forward sensor's exit bearing — and
//!    ALWAYS returns a non-empty plan (the shared parser rejects an empty one).
//!
//! # Purity / determinism (NFR-DET)
//!
//! `decide` is fully synchronous and bounded: no RNG, no wall clock, no network,
//! no child process. The only process-env read is the pre-existing
//! [`DOOM_WAD_PATH_ENV`](super::engine::DOOM_WAD_PATH_ENV) seam inside
//! [`super::engine::load_wad`], read at most once per level and inert when unset
//! — production is byte-identical. Two calls on the same map and position are
//! byte-identical (the cache is a lookup-only map, never iterated).

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{json, Value};

use neurodoom::engine::ClassicEngine;
use neurodoom::map::MapData;
use neurodoom::math::FRACBITS;
use neurodoom::world::PeerId;

use crate::infrastructure::companion::doom_decision::{
    DoomDecisionError, DoomDecisionSource, DoomPlan, DoomPlanStep, DOOM_PLAN_DISTANCE_MAX,
    DOOM_PLAN_MAX_STEPS,
};

use super::actions::{DOOM_ACTION_TURN_TO, DOOM_ACTION_USE};
use super::agent::DOOM_LOCAL_DOOR_NEAR_RANGE;
use super::engine::load_wad;
use super::navigation::{
    bearing_between, distance_between, nearest_door_crossing, RouteOutcome, WalkGrid, DoomDoorKind,
    DOOM_PLAYER_HEIGHT_FALLBACK,
};
use super::plan::DOOM_DOOR_FACING_TOLERANCE_DEGREES;

/// The `use` reach (map units) at which the source opens a door waypoint. The
/// engine's `P_UseLines` traces ~64 units ahead; 56 is the measured reach the
/// ST-1 scan used to trigger a real door, so a door is opened only when the
/// player is within this of its midpoint.
pub const DOOM_LOCAL_DOOR_USE_RANGE: i64 = 56;

/// The maximum distance of one local `Move` step, in map units. The executor's
/// `Move` step completes on ANY accumulated movement (not progress toward the
/// target), while the engine's `turn-to` servo turns only ~3.5°/tick — so a long
/// step wastes its budget moving off-bearing before the player has turned. A
/// short step makes the source re-aim frequently, so the player converges on the
/// bearing.
pub const DOOM_LOCAL_MOVE_STEP_MAX: i64 = 8;

/// The half-angle (degrees) of the "front" cone for the fallback door press —
/// a door whose relative bearing is within this of straight ahead counts as
/// front-facing.
pub const DOOM_LOCAL_FRONT_DOOR_CONE_DEGREES: i64 = 45;

/// The pure-pursuit look-ahead (map units): the follower drives toward the
/// FARTHEST route waypoint within this distance that is directly visible, so it
/// smooths the string-pulled legs instead of stop-starting cell by cell.
pub const DOOM_LOCAL_LOOKAHEAD_UNITS: i64 = 96;

/// The cached per-level route data: the parsed [`MapData`] and the [`WalkGrid`]
/// built ONCE from it (a lookup-only structure).
struct LevelCache {
    map: MapData,
    grid: WalkGrid,
}

/// The local, map-derived [`DoomDecisionSource`] (Spec #3039 ST-7/ST-2).
///
/// `levels` caches the parsed [`MapData`] and the walkable [`WalkGrid`] per level
/// so the WAD is parsed and the grid built at most once per level (deterministic;
/// the map is never mutated). The `Mutex` guards only a short synchronous
/// critical section — it is NEVER held across an `.await`.
pub struct LocalRouteSource {
    levels: Mutex<HashMap<i64, LevelCache>>,
}

impl LocalRouteSource {
    /// Build an empty local source; levels are parsed lazily on first use.
    pub fn new() -> Self {
        Self {
            levels: Mutex::new(HashMap::new()),
        }
    }

    /// Lock the level cache, recovering from a poisoned lock (a panic in a prior
    /// `decide` must not wedge the run).
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, LevelCache>> {
        self.levels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Ensure the level cache for `level` is built, parsing the WAD once.
    fn ensure_level(&self, level: i64) -> Result<(), DoomDecisionError> {
        if self.lock().contains_key(&level) {
            return Ok(());
        }
        let wad = load_wad().map_err(|error| {
            DoomDecisionError::Malformed(format!("cannot load the WAD for E1M{level}: {error}"))
        })?;
        let name = format!("E1M{level}");
        let engine = ClassicEngine::new(&wad, &name).map_err(|error| {
            DoomDecisionError::Malformed(format!("cannot build {name}: {error}"))
        })?;
        let player_height = live_player_height(&engine);
        let map = engine.map().clone();
        let grid = WalkGrid::build(&map, player_height);
        self.lock().insert(level, LevelCache { map, grid });
        Ok(())
    }

    /// The synchronous plan for `observation` (the whole of [`Self::decide`]).
    fn plan_for(&self, observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
        let level = observation
            .pointer("/level/map")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                DoomDecisionError::Malformed(
                    "observation is missing an integer `level.map`".to_string(),
                )
            })?;
        self.ensure_level(level)?;

        let steps = {
            let levels = self.lock();
            match (levels.get(&level), player_position(observation)) {
                (Some(cache), Some(from)) => {
                    route_steps(&cache.map, &cache.grid, from, player_angle(observation))
                }
                _ => Vec::new(),
            }
        };

        let steps = if steps.is_empty() {
            fallback_steps(observation)
        } else {
            steps
        };
        debug_assert!(
            !steps.is_empty() && steps.len() <= DOOM_PLAN_MAX_STEPS,
            "the local plan must be non-empty and fit the shared bound"
        );
        Ok(DoomPlan { steps })
    }
}

/// The engine's live player collision height (map units), read from its own
/// player entity (`Entity.height`, 16.16 `Fixed`), falling back to
/// [`DOOM_PLAYER_HEIGHT_FALLBACK`] when no live entity is present.
fn live_player_height(engine: &ClassicEngine) -> i64 {
    let world = engine.world();
    world
        .controlled_by(PeerId(0))
        .and_then(|id| world.get(id))
        .map(|entity| i64::from(entity.height >> FRACBITS))
        .filter(|height| *height > 0)
        .unwrap_or(DOOM_PLAYER_HEIGHT_FALLBACK)
}

impl Default for LocalRouteSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DoomDecisionSource for LocalRouteSource {
    async fn decide(&self, observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
        self.plan_for(observation)
    }
}

/// The player's integer map-unit `(x, y)` from an observation, or `None`.
fn player_position(observation: &Value) -> Option<(i64, i64)> {
    let x = observation.pointer("/player/x").and_then(Value::as_i64)?;
    let y = observation.pointer("/player/y").and_then(Value::as_i64)?;
    Some((x, y))
}

/// The player's facing in integer degrees (`0` when absent).
fn player_angle(observation: &Value) -> i64 {
    observation
        .pointer("/player/angle")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .rem_euclid(360)
}

/// Whether the facing `angle` is within `tolerance` degrees of `bearing`.
fn bearing_within(angle: i64, bearing: i64, tolerance: i64) -> bool {
    let delta = (bearing - angle).rem_euclid(360);
    let delta = if delta > 180 { 360 - delta } else { delta };
    delta <= tolerance
}

/// Turn the grid route from `from` into the plan for the next leg (Spec #3039
/// ST-2, extended ST-3). A receding horizon: the route is recomputed from the
/// then-current position every call, so bearings are always FRESH.
///
/// * A `use`-activated exit SWITCH within [`DOOM_LOCAL_DOOR_USE_RANGE`] is
///   pressed (one-tick `[turn-to, use]` hold) — the exit wall itself is not a
///   walkable cell.
/// * A door on the immediate leg is honoured by its [`DoomDoorKind`] (ST-3): a
///   `Usable` door is faced (within [`DOOM_DOOR_FACING_TOLERANCE_DEGREES`]) and
///   pressed with `use` while pushing forward; a `WalkTrigger` door is walked
///   through (no press); a `Locked` door is refused.
/// * Otherwise the follower drives toward the FARTHEST visible route waypoint
///   within [`DOOM_LOCAL_LOOKAHEAD_UNITS`] (pure pursuit).
fn route_steps(map: &MapData, grid: &WalkGrid, from: (i64, i64), angle: i64) -> Vec<DoomPlanStep> {
    // Exit approach: press `use` on a switch exit within reach.
    if let Some(goal) = grid.nearest_goal(from) {
        if goal.switch {
            if let Some(target) = grid.centre(goal.cell) {
                if distance_between(from, target) <= DOOM_LOCAL_DOOR_USE_RANGE {
                    return vec![use_hold(from, target)];
                }
            }
        }
    }

    let RouteOutcome::Path(waypoints) = grid.route(map, from) else {
        return Vec::new();
    };
    let Some(target) = pursuit_target(grid, from, &waypoints) else {
        return Vec::new();
    };

    // A door on the immediate leg (nearest crossing) is honoured by its kind.
    // The door actions are a ONE-TICK `Hold`: the executor consumes a `Hold` in a
    // single tick and re-decides on the next, so `use` is re-pressed every tick
    // until the door opens AND the player crosses — never wedging on a `Move` that
    // can never consume its distance against a closed door.
    if let Some((crossing, kind)) = nearest_door_crossing(map, from, target) {
        if distance_between(from, crossing) <= DOOM_LOCAL_DOOR_USE_RANGE {
            match kind {
                // Refuse a locked door: it is never a route leg (the grid already
                // treats it as a wall, so this is belt-and-suspenders).
                DoomDoorKind::Locked => return Vec::new(),
                // A walk-trigger door opens by crossing it — walk straight through.
                DoomDoorKind::WalkTrigger => {}
                DoomDoorKind::Usable => {
                    let door_bearing = bearing_between(from, crossing);
                    if bearing_within(angle, door_bearing, DOOM_DOOR_FACING_TOLERANCE_DEGREES) {
                        return vec![DoomPlanStep::Hold {
                            tics: 1,
                            actions: vec![
                                json!({ "type": DOOM_ACTION_TURN_TO, "angle": door_bearing }),
                                json!({ "type": DOOM_ACTION_USE }),
                                json!({ "type": "run" }),
                                json!({ "type": "forward", "amount": 1 }),
                            ],
                        }];
                    }
                    // Not yet facing the door — turn toward it; do NOT press `use`
                    // while off-bearing (ST-3: press only within tolerance).
                    return vec![DoomPlanStep::Hold {
                        tics: 1,
                        actions: vec![json!({ "type": DOOM_ACTION_TURN_TO, "angle": door_bearing })],
                    }];
                }
            }
        }
    }

    // Drive toward the pursuit target. A `Move` step (issued as a
    // turn-to + run + forward hold by the executor) covers the leg at a RUN, so
    // the follower crosses open ground quickly and spends less time exposed to
    // enemy fire.
    vec![DoomPlanStep::Move {
        bearing: bearing_between(from, target),
        distance: distance_between(from, target).clamp(1, DOOM_LOCAL_MOVE_STEP_MAX),
    }]
}

/// A one-tick `[turn-to, use]` hold facing `target` from `from`.
fn use_hold(from: (i64, i64), target: (i64, i64)) -> DoomPlanStep {
    DoomPlanStep::Hold {
        tics: 1,
        actions: vec![
            json!({ "type": DOOM_ACTION_TURN_TO, "angle": bearing_between(from, target) }),
            json!({ "type": DOOM_ACTION_USE }),
        ],
    }
}

/// The pure-pursuit target: the FARTHEST visible waypoint within
/// [`DOOM_LOCAL_LOOKAHEAD_UNITS`], else the first waypoint. `None` for an empty
/// route.
fn pursuit_target(
    grid: &WalkGrid,
    from: (i64, i64),
    waypoints: &[super::navigation::DoomRouteWaypoint],
) -> Option<(i64, i64)> {
    let mut target = None;
    for waypoint in waypoints {
        if distance_between(from, waypoint.target) <= DOOM_LOCAL_LOOKAHEAD_UNITS
            && grid.visible(from, waypoint.target)
        {
            target = Some(waypoint.target);
        } else {
            break;
        }
    }
    target.or_else(|| waypoints.first().map(|waypoint| waypoint.target))
}

/// The reactive fallback plan: an `OpenDoor` for a near front door (when one is
/// visible), then a `Move` toward the forward sensor's exit bearing. ALWAYS
/// non-empty — a bounded `forward` hold is the last resort.
fn fallback_steps(observation: &Value) -> Vec<DoomPlanStep> {
    let mut steps: Vec<DoomPlanStep> = Vec::new();
    if let Some(bearing) = front_near_door_bearing(observation) {
        steps.push(DoomPlanStep::OpenDoor { bearing });
    }
    if let Some(exit) = observation.pointer("/forward/exitBearing") {
        if let (Some(bearing), Some(distance)) = (
            exit.get("bearing").and_then(Value::as_i64),
            exit.get("distance").and_then(Value::as_i64),
        ) {
            steps.push(DoomPlanStep::Move {
                bearing: bearing.clamp(0, 359),
                distance: distance.clamp(1, DOOM_PLAN_DISTANCE_MAX),
            });
        }
    }
    if steps.is_empty() {
        // A bounded forward hold — the documented local/reflex fallback, so the
        // plan is never empty (the shared parser rejects an empty plan).
        steps.push(DoomPlanStep::Hold {
            tics: 1,
            actions: vec![json!({ "type": "forward" })],
        });
    }
    steps
}

/// The absolute bearing (`0..=359`) of the nearest near front door, or `None`.
///
/// Prefers the forward sensor's relative `doorBearings` (converted to an
/// absolute bearing via the player's facing), falling back to a `front` entry in
/// the observation's `doors[]` (face the current heading).
fn front_near_door_bearing(observation: &Value) -> Option<i64> {
    let angle = observation
        .pointer("/player/angle")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .rem_euclid(360);

    if let Some(doors) = observation
        .pointer("/forward/doorBearings")
        .and_then(Value::as_array)
    {
        let mut best: Option<(i64, i64)> = None;
        for door in doors {
            let relative = door.get("bearing").and_then(Value::as_i64).unwrap_or(0);
            let distance = door
                .get("distance")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX);
            if distance > DOOM_LOCAL_DOOR_NEAR_RANGE
                || relative.abs() > DOOM_LOCAL_FRONT_DOOR_CONE_DEGREES
            {
                continue;
            }
            if best.is_none_or(|(best_relative, _)| relative.abs() < best_relative.abs()) {
                best = Some((relative, (angle + relative).rem_euclid(360)));
            }
        }
        if let Some((_, bearing)) = best {
            return Some(bearing);
        }
    }

    observation
        .get("doors")
        .and_then(Value::as_array)
        .and_then(|doors| {
            doors.iter().find(|door| {
                door.get("direction").and_then(Value::as_str) == Some("front")
                    && door
                        .get("distance")
                        .and_then(Value::as_i64)
                        .unwrap_or(i64::MAX)
                        <= DOOM_LOCAL_DOOR_NEAR_RANGE
            })
        })
        .map(|_| angle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use neurodoom::map::MapData;

    /// Load the E1M7 map through the same seam the source uses.
    fn e1m7_map() -> MapData {
        let wad = load_wad().expect("the embedded WAD loads");
        ClassicEngine::new(&wad, "E1M7")
            .expect("E1M7 loads")
            .map()
            .clone()
    }

    /// Load the E1M1 map (the measured AC5 target) through the same seam.
    fn e1m1_map() -> MapData {
        let wad = load_wad().expect("the embedded WAD loads");
        ClassicEngine::new(&wad, "E1M1")
            .expect("E1M1 loads")
            .map()
            .clone()
    }

    #[test]
    fn route_steps_are_bounded_and_deterministic() {
        // E1M1 is the measured height-aware routable AC5 target, so `route_steps`
        // yields a non-empty route plan from its spawn.
        let map = e1m1_map();
        let grid = WalkGrid::build(&map, DOOM_PLAYER_HEIGHT_FALLBACK);
        let from = super::super::navigation::spawn_point(&map)
            .map(|(x, y)| (i64::from(x), i64::from(y)))
            .expect("E1M1 has a player-1 start");
        let steps = route_steps(&map, &grid, from, 0);
        assert!(!steps.is_empty(), "E1M1 routes from its spawn");
        assert!(
            steps.len() <= DOOM_PLAN_MAX_STEPS,
            "the plan must fit the shared bound: {}",
            steps.len()
        );
        assert_eq!(
            steps,
            route_steps(&map, &grid, from, 0),
            "byte-identical across calls"
        );
        for step in &steps {
            match step {
                DoomPlanStep::Move { bearing, distance } => {
                    assert!((0..=359).contains(bearing));
                    assert!((1..=DOOM_PLAN_DISTANCE_MAX).contains(distance));
                }
                DoomPlanStep::Hold { tics, actions } => {
                    assert!((1..=350).contains(tics));
                    assert!(!actions.is_empty());
                }
                other => panic!("route_steps emitted a non-route step: {other:?}"),
            }
        }
    }

    #[test]
    fn fallback_uses_the_exit_bearing_and_is_never_empty() {
        let observation = json!({
            "player": { "angle": 30 },
            "forward": { "exitBearing": { "bearing": 90, "distance": 5000 } },
        });
        let steps = fallback_steps(&observation);
        assert_eq!(
            steps,
            vec![DoomPlanStep::Move {
                bearing: 90,
                distance: DOOM_PLAN_DISTANCE_MAX,
            }],
            "the exit bearing is clamped to the bounded distance"
        );
    }

    #[test]
    fn fallback_prefers_a_near_front_door() {
        let observation = json!({
            "player": { "angle": 100 },
            "forward": {
                "doorBearings": [ { "bearing": 10, "distance": 40, "state": "closed" } ],
                "exitBearing": { "bearing": 90, "distance": 200 },
            },
        });
        let steps = fallback_steps(&observation);
        assert_eq!(
            steps,
            vec![
                DoomPlanStep::OpenDoor { bearing: 110 },
                DoomPlanStep::Move {
                    bearing: 90,
                    distance: 200,
                },
            ],
            "a near front door is opened first, at its absolute bearing"
        );
    }

    #[test]
    fn fallback_is_never_empty_without_any_sensor() {
        let steps = fallback_steps(&json!({}));
        assert_eq!(
            steps,
            vec![DoomPlanStep::Hold {
                tics: 1,
                actions: vec![json!({ "type": "forward" })],
            }],
            "the last-resort fallback is a bounded forward hold"
        );
    }

    /// The local source routes from the E1M1 spawn (the measured AC5 target) to a
    /// non-empty, bounded, byte-identical plan; the FIRST step is a route `Move`
    /// (the spawn is far from any door, so no door action is emitted).
    #[tokio::test]
    async fn the_source_plans_a_route_from_the_e1m1_spawn_deterministically() {
        let wad = load_wad().expect("the embedded WAD loads");
        let map = ClassicEngine::new(&wad, "E1M1")
            .expect("E1M1 loads")
            .map()
            .clone();
        let (sx, sy) = super::super::navigation::spawn_point(&map).expect("E1M1 spawn");
        let source = LocalRouteSource::new();
        let observation = json!({
            "level": { "map": 1 },
            "player": { "x": sx, "y": sy, "angle": 90 },
        });
        let plan = source.decide(&observation).await.expect("a plan");
        assert!(!plan.steps.is_empty());
        assert!(plan.steps.len() <= DOOM_PLAN_MAX_STEPS);
        assert!(
            matches!(plan.steps.first(), Some(DoomPlanStep::Move { .. })),
            "the E1M1 spawn is far from any door: the first step is a Move, got {:?}",
            plan.steps
        );
        assert_eq!(plan, source.decide(&observation).await.expect("a plan"));
    }

    #[tokio::test]
    async fn the_source_is_object_safe_and_decides_on_e1m7() {
        use std::sync::Arc;

        let source: Arc<dyn DoomDecisionSource> = Arc::new(LocalRouteSource::new());
        let map = e1m7_map();
        let (sx, sy) = super::super::navigation::spawn_point(&map).expect("spawn");
        let observation = json!({
            "level": { "map": 7 },
            "player": { "x": sx, "y": sy, "angle": 0 },
        });
        let plan = source.decide(&observation).await.expect("a plan");
        assert!(!plan.steps.is_empty());
        assert!(plan.steps.len() <= DOOM_PLAN_MAX_STEPS);
    }
}
