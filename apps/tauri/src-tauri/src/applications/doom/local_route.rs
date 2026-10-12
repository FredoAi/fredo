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
//! 2. reads the player's integer `(x, y)` and asks [`navigation::route_waypoints`]
//!    for a deterministic route to the nearest non-secret exit, emitting as many
//!    [`DoomPlanStep`]s as fit in [`DOOM_PLAN_MAX_STEPS`] — the next call
//!    recomputes from the then-current position (a receding horizon);
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

use crate::infrastructure::companion::doom_decision::{
    DoomDecisionError, DoomDecisionSource, DoomPlan, DoomPlanStep, DOOM_PLAN_DISTANCE_MAX,
    DOOM_PLAN_MAX_STEPS,
};

use super::actions::{DOOM_ACTION_TURN_TO, DOOM_ACTION_USE};
use super::agent::DOOM_LOCAL_DOOR_NEAR_RANGE;
use super::engine::load_wad;
use super::navigation::route_waypoints;

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

/// The local, map-derived [`DoomDecisionSource`] (Spec #3039 ST-7).
///
/// `maps` caches the parsed [`MapData`] per level so the WAD is parsed at most
/// once per level (deterministic; the map is never mutated). The `Mutex` guards
/// only a short synchronous critical section — it is NEVER held across an
/// `.await`.
pub struct LocalRouteSource {
    maps: Mutex<HashMap<i64, MapData>>,
}

impl LocalRouteSource {
    /// Build an empty local source; maps are parsed lazily on first use.
    pub fn new() -> Self {
        Self {
            maps: Mutex::new(HashMap::new()),
        }
    }

    /// Lock the map cache, recovering from a poisoned lock (a panic in a prior
    /// `decide` must not wedge the run).
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, MapData>> {
        self.maps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Ensure the [`MapData`] for `level` is cached, parsing the WAD once.
    fn ensure_map(&self, level: i64) -> Result<(), DoomDecisionError> {
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
        let map = engine.map().clone();
        self.lock().insert(level, map);
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
        self.ensure_map(level)?;

        let steps = {
            let maps = self.lock();
            match (maps.get(&level), player_position(observation)) {
                (Some(map), Some(from)) => route_steps(map, from),
                _ => Vec::new(),
            }
        };

        let steps = if steps.is_empty() {
            fallback_steps(observation)
        } else {
            steps
        };
        Ok(DoomPlan { steps })
    }
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

/// Turn the route from `from` into the plan for the NEXT waypoint (Spec #3039
/// ST-7).
///
/// Only the nearest waypoint is planned, and its bearing/distance are taken from
/// [`navigation::route_waypoints`], which computes the FIRST waypoint's bearing
/// from `from` — so the plan is always FRESH (a receding horizon: the next call
/// recomputes from the then-current position). Emitting the nearest waypoint
/// only keeps the `use` trace aimed at the door the player is actually
/// approaching; packing far waypoints would carry stale bearings the `use` trace
/// would miss.
///
/// A door waypoint is opened (`OpenDoor`, facing its fresh bearing) only when the
/// player is within [`DOOM_LOCAL_DOOR_USE_RANGE`] — pressing `use` from further
/// away never opens it. Every waypoint also contributes the `Move` toward its
/// midpoint. Empty when the route is empty.
fn route_steps(map: &MapData, from: (i64, i64)) -> Vec<DoomPlanStep> {
    let Some(waypoint) = route_waypoints(map, from).into_iter().next() else {
        return Vec::new();
    };
    let mut steps: Vec<DoomPlanStep> = Vec::new();
    if waypoint.door && waypoint.distance <= DOOM_LOCAL_DOOR_USE_RANGE {
        // Press `use` ONCE, facing the door, via a one-tick legacy hold. The
        // hold routes through the retained `effective_intent` pipeline (which
        // preserves the `use` and appends bounded forward locomotion), so the
        // door opens WITHOUT relying on the executor's `OpenDoor` step — whose
        // completion waits for `state == "waiting"`, which the real engine never
        // reports (it goes `"opening"` → fully open).
        steps.push(DoomPlanStep::Hold {
            tics: 1,
            actions: vec![
                json!({ "type": DOOM_ACTION_TURN_TO, "angle": waypoint.bearing }),
                json!({ "type": DOOM_ACTION_USE }),
            ],
        });
    }
    steps.push(DoomPlanStep::Move {
        bearing: waypoint.bearing,
        distance: waypoint.distance.min(DOOM_LOCAL_MOVE_STEP_MAX),
    });
    debug_assert!(steps.len() <= DOOM_PLAN_MAX_STEPS);
    steps
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

    #[test]
    fn route_steps_are_bounded_non_empty_and_deterministic() {
        let map = e1m7_map();
        let from = super::super::navigation::spawn_point(&map)
            .map(|(x, y)| (i64::from(x), i64::from(y)))
            .expect("E1M7 has a player-1 start");
        let steps = route_steps(&map, from);
        assert!(!steps.is_empty(), "E1M7 must yield a non-empty route plan");
        assert!(
            steps.len() <= DOOM_PLAN_MAX_STEPS,
            "the plan must fit the shared bound: {}",
            steps.len()
        );
        assert_eq!(steps, route_steps(&map, from), "byte-identical across calls");
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
