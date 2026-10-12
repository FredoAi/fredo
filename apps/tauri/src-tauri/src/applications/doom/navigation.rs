//! Deterministic in-process route planner (Spec #3031 — AC5 / ST-1).
//!
//! [`plan_route`] is a **pure, bounded** function of the loaded level geometry
//! ([`neurodoom::map::MapData`]) and the player's integer map position. It
//! searches a uniform grid (cell size [`DOOM_NAV_CELL_UNITS`]) with a
//! breadth-first search and returns a collinear-merged sequence of cell-center
//! waypoints leading to the **nearest reachable exit-line vertex**.
//!
//! This is the route-level knowledge a FOV-limited, purely reactive policy cannot
//! supply — the reason round-2's bounded local exit-seek could not solve a level.
//!
//! # Geometry model
//!
//! `MapData` exposes the level as `lines` over `vertexes`. A line is a **solid
//! one-sided wall** iff `line.back_sector.is_none()`; otherwise it is a two-sided
//! portal. Exit lines are identified by `is_exit_line(line.special)`. A grid-cell
//! edge is traversable unless the segment between the two cell centers properly
//! crosses a solid line. Two-sided portals — including doors, which the follow
//! policy opens with its `use` aid — pass through.
//!
//! # Determinism
//!
//! No RNG, no wall clock, and no hash-map iteration on the result path: the BFS
//! expands neighbours in a fixed order, the visited set is capped at
//! [`DOOM_NAV_MAX_CELLS`], and the goal is chosen by a deterministic
//! `(steps, cell_x, cell_y)` key. Two calls on identical input are byte-identical.
//!
//! # Bounded
//!
//! Visited cells never exceed [`DOOM_NAV_MAX_CELLS`]; the returned route never
//! exceeds [`DOOM_NAV_MAX_WAYPOINTS`]. An unreachable (or empty) goal yields
//! `None` — never a panic.

use std::collections::{HashMap, VecDeque};

use neurodoom::map::MapData;
use neurodoom::math::{Fixed, FRACBITS};
use neurodoom::specials::is_exit_line;

// ── Pinned constants (Architect-owned, Spec #3031 G-255) ───────────────────────

/// Uniform grid cell size in map units.
pub const DOOM_NAV_CELL_UNITS: i64 = 64;
/// BFS visited cap (bounded compute/memory).
pub const DOOM_NAV_MAX_CELLS: usize = 16_384;
/// Route length cap.
pub const DOOM_NAV_MAX_WAYPOINTS: usize = 64;
/// Arrival radius in map units (consumed by the route-follow policy).
pub const DOOM_NAV_WAYPOINT_RADIUS: i64 = 96;
/// Forward hold (tics) per tick toward a waypoint (route-follow policy).
pub const DOOM_NAV_FORWARD_AMOUNT: i64 = 10;
/// No-progress ticks before skipping a waypoint (route-follow policy).
pub const DOOM_NAV_STALL_TICKS: u32 = 45;
/// Bounded waypoint skips before reactive fallback (route-follow policy).
pub const DOOM_NAV_MAX_SKIPS: u32 = 3;

// Compile-time invariants for the pinned planner/follow tuning (G-255): every cap
// must be non-zero so the planner and follow state stay bounded and productive.
const _: () = {
    assert!(DOOM_NAV_CELL_UNITS > 0);
    assert!(DOOM_NAV_MAX_CELLS > 0);
    assert!(DOOM_NAV_MAX_WAYPOINTS > 0);
    assert!(DOOM_NAV_WAYPOINT_RADIUS > 0);
    assert!(DOOM_NAV_FORWARD_AMOUNT > 0);
    assert!(DOOM_NAV_STALL_TICKS > 0);
    assert!(DOOM_NAV_MAX_SKIPS > 0);
};

// ── Route model ────────────────────────────────────────────────────────────────

/// A single route waypoint in integer map units (a grid cell center).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoomWaypoint {
    pub x: i64,
    pub y: i64,
}

/// A planned route: collinear-merged cell centers from the player to the exit.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct DoomRoute {
    pub waypoints: Vec<DoomWaypoint>,
}

impl DoomRoute {
    /// True when the route carries no waypoints.
    pub fn is_empty(&self) -> bool {
        self.waypoints.is_empty()
    }

    /// The number of waypoints.
    pub fn len(&self) -> usize {
        self.waypoints.len()
    }
}

/// Pure + deterministic. Goal = the nearest REACHABLE exit-line vertex (lines
/// where `is_exit_line(line.special)`); BFS over a uniform grid of
/// [`DOOM_NAV_CELL_UNITS`] cells; a cell edge is traversable unless it crosses a
/// SOLID line (`line.back_sector.is_none()`) or a closed-door line; two-sided
/// portals pass through. Bounds: <= [`DOOM_NAV_MAX_CELLS`] visited, <=
/// [`DOOM_NAV_MAX_WAYPOINTS`] returned. `None` => no exit cell reachable
/// (fallback), or a level with no exit lines at all.
pub fn plan_route(map: &MapData, from: (i64, i64)) -> Option<DoomRoute> {
    let cell = DOOM_NAV_CELL_UNITS;

    // Solid one-sided walls block movement; two-sided portals (including doors,
    // which the follow policy opens with its `use` aid) pass through.
    let mut solids: Vec<(i64, i64, i64, i64)> = Vec::new();
    for line in &map.lines {
        if line.back_sector.is_some() {
            continue;
        }
        let (Some(v1), Some(v2)) = (
            map.vertexes.get(line.v1 as usize),
            map.vertexes.get(line.v2 as usize),
        ) else {
            continue;
        };
        solids.push((
            to_units(v1.x),
            to_units(v1.y),
            to_units(v2.x),
            to_units(v2.y),
        ));
    }

    // Goal cells: every cell containing an exit-line vertex.
    let mut goals: Vec<(i64, i64)> = Vec::new();
    for line in &map.lines {
        if !is_exit_line(line.special) {
            continue;
        }
        for vertex_id in [line.v1, line.v2] {
            let Some(vertex) = map.vertexes.get(vertex_id as usize) else {
                continue;
            };
            let goal = (div_floor(to_units(vertex.x), cell), div_floor(to_units(vertex.y), cell));
            if !goals.contains(&goal) {
                goals.push(goal);
            }
        }
    }
    if goals.is_empty() {
        return None;
    }

    let start = (div_floor(from.0, cell), div_floor(from.1, cell));

    // BFS over 4-neighbour grid cells. Fixed expansion order => deterministic.
    let mut dist: HashMap<(i64, i64), u32> = HashMap::new();
    let mut prev: HashMap<(i64, i64), (i64, i64)> = HashMap::new();
    let mut queue: VecDeque<(i64, i64)> = VecDeque::new();
    dist.insert(start, 0);
    queue.push_back(start);

    const NEIGHBOURS: [(i64, i64); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

    while let Some(current) = queue.pop_front() {
        let Some(&steps) = dist.get(&current) else {
            continue;
        };
        for (dx, dy) in NEIGHBOURS {
            if dist.len() >= DOOM_NAV_MAX_CELLS {
                break;
            }
            let (cx, cy) = current;
            let next = (cx + dx, cy + dy);
            if dist.contains_key(&next) {
                continue;
            }
            if edge_blocked(current, next, cell, &solids) {
                continue;
            }
            dist.insert(next, steps + 1);
            prev.insert(next, current);
            queue.push_back(next);
        }
    }

    // Choose the nearest reachable exit cell by a deterministic key.
    let mut best: Option<(u32, i64, i64)> = None;
    for (goal_x, goal_y) in &goals {
        if let Some(&steps) = dist.get(&(*goal_x, *goal_y)) {
            let key = (steps, *goal_x, *goal_y);
            if best.is_none_or(|previous| key < previous) {
                best = Some(key);
            }
        }
    }
    let (_, goal_x, goal_y) = best?;

    // Reconstruct the cell path from start to the chosen goal cell.
    let mut cells: Vec<(i64, i64)> = vec![(goal_x, goal_y)];
    let mut cursor = (goal_x, goal_y);
    while cursor != start {
        let Some(&parent) = prev.get(&cursor) else {
            break;
        };
        cells.push(parent);
        cursor = parent;
    }
    cells.reverse();

    let centers: Vec<DoomWaypoint> = cells
        .iter()
        .map(|(cx, cy)| DoomWaypoint {
            x: cx * cell + cell / 2,
            y: cy * cell + cell / 2,
        })
        .collect();
    let mut merged = merge_collinear(centers);
    if merged.len() > DOOM_NAV_MAX_WAYPOINTS {
        merged.truncate(DOOM_NAV_MAX_WAYPOINTS);
    }
    if merged.is_empty() {
        return None;
    }
    Some(DoomRoute { waypoints: merged })
}

/// Collapse runs of waypoints that continue in the same direction, keeping the
/// first and last point of each straight run.
fn merge_collinear(points: Vec<DoomWaypoint>) -> Vec<DoomWaypoint> {
    let mut out: Vec<DoomWaypoint> = Vec::new();
    for point in points {
        if out.len() < 2 {
            out.push(point);
            continue;
        }
        let second_last = &out[out.len() - 2];
        let last = &out[out.len() - 1];
        let first_dir = (last.x - second_last.x, last.y - second_last.y);
        let second_dir = (point.x - last.x, point.y - last.y);
        if first_dir.0 * second_dir.1 == first_dir.1 * second_dir.0 {
            if let Some(slot) = out.last_mut() {
                *slot = point;
            }
        } else {
            out.push(point);
        }
    }
    out
}

/// True when the segment between two adjacent cell centers properly crosses a
/// solid line (a touching endpoint without a crossing does not block).
fn edge_blocked(
    a: (i64, i64),
    b: (i64, i64),
    cell: i64,
    solids: &[(i64, i64, i64, i64)],
) -> bool {
    let (ax, ay) = cell_center(a, cell);
    let (bx, by) = cell_center(b, cell);
    solids
        .iter()
        .any(|&(sx, sy, ex, ey)| segments_cross((ax, ay), (bx, by), (sx, sy), (ex, ey)))
}

/// The integer map-unit center of a grid cell.
fn cell_center(cell_index: (i64, i64), cell: i64) -> (i64, i64) {
    (cell_index.0 * cell + cell / 2, cell_index.1 * cell + cell / 2)
}

/// Proper segment intersection (strict straddle on both segments). Endpoints that
/// merely touch without crossing are not counted.
fn segments_cross(a: (i64, i64), b: (i64, i64), c: (i64, i64), d: (i64, i64)) -> bool {
    let d1 = orient(c, d, a);
    let d2 = orient(c, d, b);
    let d3 = orient(a, b, c);
    let d4 = orient(a, b, d);
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/// Twice the signed area of the triangle `(a, b, c)`.
fn orient(a: (i64, i64), b: (i64, i64), c: (i64, i64)) -> i128 {
    let abx = i128::from(b.0 - a.0);
    let aby = i128::from(b.1 - a.1);
    let acx = i128::from(c.0 - a.0);
    let acy = i128::from(c.1 - a.1);
    abx * acy - aby * acx
}

/// Convert a 16.16 `Fixed` to integer map units (mirrors `engine::fixed_to_units`).
fn to_units(value: Fixed) -> i64 {
    i64::from(value >> FRACBITS)
}

/// Floor division that rounds toward negative infinity (map coordinates may be
/// negative; cell indices must be consistent).
fn div_floor(value: i64, divisor: i64) -> i64 {
    let quotient = value / divisor;
    if value % divisor != 0 && (value < 0) != (divisor < 0) {
        quotient - 1
    } else {
        quotient
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neurodoom::world::PeerId;
    use neurodoom::ClassicEngine;

    /// The bundled shareware `DOOM1.WAD` (same relative path as `engine.rs`).
    const EMBEDDED_WAD: &[u8] = include_bytes!("../../../doom/DOOM1.WAD");

    fn e1m1() -> ClassicEngine {
        ClassicEngine::new(EMBEDDED_WAD, "E1M1").expect("E1M1 constructs from DOOM1.WAD")
    }

    fn player_position(engine: &ClassicEngine) -> (i64, i64) {
        let player_id = engine
            .world()
            .controlled_by(PeerId(0))
            .expect("E1M1 spawns a player start");
        let entity = engine.world().get(player_id).expect("player entity");
        (to_units(entity.x), to_units(entity.y))
    }

    #[test]
    fn e1m1_route_from_spawn_exists_bounded_and_deterministic() {
        let engine = e1m1();
        let from = player_position(&engine);

        let route = plan_route(engine.map(), from).expect("E1M1 has a reachable exit route");
        assert!(!route.is_empty(), "a non-empty route is returned");
        assert!(
            route.len() <= DOOM_NAV_MAX_WAYPOINTS,
            "the route respects DOOM_NAV_MAX_WAYPOINTS ({} <= {})",
            route.len(),
            DOOM_NAV_MAX_WAYPOINTS
        );

        let again = plan_route(engine.map(), from).expect("the route is stable");
        assert_eq!(route, again, "plan_route is byte-identical across two calls");
    }

    #[test]
    fn unreachable_or_empty_goal_returns_none() {
        let engine = e1m1();
        // A position far outside the level cannot reach any exit cell within the
        // visited cap: a bounded `None`, never a panic.
        assert!(
            plan_route(engine.map(), (10_000_000, 10_000_000)).is_none(),
            "an unreachable start yields None"
        );
    }
}
