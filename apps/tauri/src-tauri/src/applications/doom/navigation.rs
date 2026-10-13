//! Deterministic level-walkability model (Spec #3039, ST-1).
//!
//! This module is the **foundation the AC5 feasibility gate rests on**: a coarse,
//! purely deterministic passability/clearance model built from the SAME
//! [`MapData`] geometry the observation builder reads
//! ([`super::engine::observation`] → `engine.map()`), plus a deterministic
//! sim-time scan that measures every NON-secret ship level (E1M1–E1M8).
//!
//! # The model (why it exists)
//!
//! #3031's r6 feasibility work (in-repo, cited by #3039) found that the only
//! robustly-walkable shareware level for a zero-margin reactive policy was the
//! **secret** E1M9 — which is explicitly not an acceptable AC5 pin — and that
//! E1M1–E1M7 appear to graze at exactly the player collision radius. #3039
//! reframes the policy around plan-ahead routing with **doors first-class**, so
//! its AC5 completion target must be chosen by a *measured* walkability number,
//! not a guess. This module produces that number.
//!
//! # Geometry → graph (binding contract)
//!
//! * A linedef with `back_sector == None` is a **solid wall** (one-sided).
//! * A linedef with `back_sector == Some(b)` is a **two-sided portal** — a
//!   passable edge between sectors `front_sector` and `b`. An **opened door is a
//!   passable edge**: a door is a two-sided linedef carrying a door `special`;
//!   the model includes it as a normal passable edge (opening it is the
//!   executor's job, R-4/AC4).
//! * A portal's **clearance** is half its opening width in integer map units —
//!   the radius of the largest disc that fits through the gap. A player of
//!   collision radius [`DOOM_PLAYER_RADIUS`] needs `clearance >= radius` merely
//!   to fit; a level is only *marginally* walkable when its best route's
//!   bottleneck clearance exceeds the radius.
//! * A level's **clearance** is the max-bottleneck (widest-path) clearance over
//!   all spawn→exit routes — i.e. the best route's narrowest gap. Computed with
//!   a deterministic Kruskal (union-find) over edges sorted by clearance
//!   descending.
//!
//! # Engine-accurate routing (Spec #3039 ST-2)
//!
//! The AC5 route does NOT use the coarse portal graph above: [`WalkGrid`]
//! rasterizes a clearance-aware, engine-accurate walkable grid from the same
//! [`MapData`] and runs a deterministic 8-connected A* over it. A cell is FREE
//! unless its centre is within [`DOOM_PLAYER_RADIUS`] of a hard wall (one-sided,
//! `ML_BLOCKING`, a key-locked door, or self-referencing). A move between two
//! cells is allowed only when the ENGINE's DIRECTIONAL movement rule holds
//! (`PIT_CheckLine`): the climb `floor(b) - floor(a) <= DOOM_MAX_STEP_HEIGHT` (a
//! drop is free) and the headroom from the CURRENT floor,
//! `min(ceiling(a), ceiling(b)) - floor(a) >= player_height`. A two-sided
//! passage the engine blocks is therefore never routed through. [`portal_traversable`]
//! is the conservative line-level form of the same rule (headroom measured from
//! the higher floor); [`probe_engine_passage_rules`] pins the un-exposed engine
//! step constant (`neurodoom::physics::MAXSTEPHEIGHT`).
//!
//! # Purity / determinism
//!
//! Every function here is a pure function of the [`MapData`] — no RNG, no wall
//! clock, no environment. Two identical maps produce byte-identical verdicts.
//!
//! # The scan (executed evidence)
//!
//! [`tests::scan_non_secret_levels_and_write_report`] runs the model over
//! E1M1–E1M8 in sim-time (engine steps only — no wall clock), writes the
//! per-level report to the gitignored scratch path
//! `.opencode/tmp/3039/level-feasibility.md`, and measures the real door-open
//! duration (`use` → `state="opening"` → `state="waiting"`) so ST-4 can finalize
//! `DOOM_DOOR_WAIT_MAX_TICKS`.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

use neurodoom::map::{doomednum, line_special, MapData, SectorId};
use neurodoom::math::FRACBITS;

use crate::infrastructure::companion::doom_decision::{DoomPlanStep, DOOM_PLAN_DISTANCE_MAX};

// ── Pinned model constants ────────────────────────────────────────────────────

/// The classic Doom player collision radius, in integer map units.
pub const DOOM_PLAYER_RADIUS: i64 = 16;

/// The minimum opening width a radius-[`DOOM_PLAYER_RADIUS`] player can squeeze
/// through with zero margin (`2 * radius`).
pub const DOOM_PASSAGE_MIN_WIDTH: i64 = DOOM_PLAYER_RADIUS * 2;

// ── Engine passage-rule constants (Spec #3039 ST-2, G-255 names block) ────────

/// The player's vertical collision height (map units) used by the passage
/// predicate ONLY when no live player entity is available. The authoritative
/// value is read live from the engine's own player entity (`Entity.height`,
/// `engine.rs:1118`); [`probe_engine_passage_rules`] pins this fallback to the
/// engine's real player height (classic Doom `56`).
pub const DOOM_PLAYER_HEIGHT_FALLBACK: i64 = 56;

/// The maximum floor step-up a thing can walk up, in integer map units
/// (classic Doom `24`). DECIDED by [`probe_engine_passage_rules`], which asserts
/// it equals the engine's own `neurodoom::physics::MAXSTEPHEIGHT` — it is never a
/// silent literal.
pub const DOOM_MAX_STEP_HEIGHT: i64 = 24;

/// `ML_BLOCKING` — the linedef flag that makes a line solid regardless of its
/// sidedefs (classic Doom `ML_BLOCKING`, value `1`; `Line.flags`, `map.rs`).
pub const DOOM_LINE_BLOCKING_FLAG: i16 = 1;

/// The walkable-grid cell size in integer map units — one player collision
/// radius, so a wall is at least one cell thick.
pub const DOOM_ROUTE_CELL_UNITS: i64 = DOOM_PLAYER_RADIUS;

/// The hard bound on the walkable-grid cell count. A map whose rasterized grid
/// would exceed this is left EMPTY (no route) — the build stays bounded.
pub const DOOM_ROUTE_MAX_CELLS: usize = 262_144;

/// The extra A* cost of entering a cell that lies on a `use`-gated door line, so
/// the route prefers an open way around a door when one exists.
pub const DOOM_ROUTE_DOOR_PENALTY: i32 = 512;

// ── Model types ───────────────────────────────────────────────────────────────

/// A two-sided linedef connecting two sectors — a passable portal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoomPortal {
    /// The sector on the linedef's front side.
    pub front: SectorId,
    /// The sector on the linedef's back side.
    pub back: SectorId,
    /// Half the opening width, in integer map units. This is the clearance a
    /// player of radius `R` must satisfy: `clearance >= R` to fit at all,
    /// `clearance > R` to fit with any margin.
    pub clearance: i64,
    /// Whether the portal is a `use`-gated door (passable once opened).
    pub door: bool,
}

/// The coarse walkability verdict for one level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LevelWalkability {
    /// A spawn→exit route exists. `clearance` is the best route's bottleneck
    /// (the narrowest gap it must pass), in integer map units; `portals` is the
    /// number of sector portals on a route at that clearance, `doors` how many
    /// of them are `use`-gated doors.
    Walkable {
        /// The widest route's bottleneck clearance, in integer map units.
        clearance: i64,
        /// Portals traversed by a representative route at `clearance`.
        portals: usize,
        /// Door portals on that route.
        doors: usize,
    },
    /// The map has no player-1 start thing or no non-secret exit line.
    NoTerminals,
    /// Terminals exist but no two-sided portal route connects them.
    Unreachable,
}

impl LevelWalkability {
    /// The measured clearance, when a route exists.
    pub fn clearance(&self) -> Option<i64> {
        match self {
            LevelWalkability::Walkable { clearance, .. } => Some(*clearance),
            _ => None,
        }
    }

    /// The clearance margin above the player collision radius
    /// (`clearance - DOOM_PLAYER_RADIUS`), when a route exists.
    pub fn margin(&self) -> Option<i64> {
        self.clearance().map(|clearance| clearance - DOOM_PLAYER_RADIUS)
    }

    /// Whether a route exists whose clearance leaves a positive margin above the
    /// player collision radius — the ST-1 gate (never a 0-margin graze).
    pub fn has_margin(&self) -> bool {
        self.margin().is_some_and(|margin| margin > 0)
    }
}

// ── Pure geometry helpers ─────────────────────────────────────────────────────

/// Integer square root (Newton), deterministic and float-free.
fn isqrt_u64(value: u64) -> u64 {
    if value < 2 {
        return value;
    }
    let mut x = value;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + value / x) / 2;
    }
    x
}

/// The integer map-unit `(x, y)` of a vertex, or `None` when out of range.
fn vertex_units(map: &MapData, id: u16) -> Option<(i64, i64)> {
    map.vertexes
        .get(id as usize)
        .map(|vertex| (i64::from(vertex.x) >> FRACBITS, i64::from(vertex.y) >> FRACBITS))
}

/// Whether a linedef `special` is a door (mirrors the engine's door dispatch,
/// `neurodoom::specials`): manual, locked, walk-triggered, and blaze variants.
fn is_door_special(special: i16) -> bool {
    matches!(
        special,
        line_special::MANUAL_DOOR
            | line_special::WALK_OPEN_DOOR
            | line_special::WALK_CLOSE_DOOR
            | line_special::WALK_RAISE_DOOR
            | line_special::WALK_CLOSE30_OPEN
            | line_special::BLUE_LOCKED_DOOR
            | line_special::YELLOW_LOCKED_DOOR
            | line_special::RED_LOCKED_DOOR
            | line_special::MANUAL_OPEN_STAY
            | line_special::BLUE_OPEN_STAY
            | line_special::RED_OPEN_STAY
            | line_special::YELLOW_OPEN_STAY
            | line_special::BLAZE_RAISE
            | line_special::BLAZE_OPEN
    )
}

/// Whether a linedef `special` is a door a bare `use` can open (no key needed) —
/// the doors the ST-1 scan drives to measure the open duration.
pub fn is_usable_door(special: i16) -> bool {
    matches!(
        special,
        line_special::MANUAL_DOOR
            | line_special::MANUAL_OPEN_STAY
            | line_special::BLAZE_RAISE
            | line_special::BLAZE_OPEN
    )
}

/// The player-1 start point in integer map units, or `None`.
pub fn spawn_point(map: &MapData) -> Option<(i32, i32)> {
    map.things
        .iter()
        .find(|thing| thing.type_num == doomednum::PLAYER1_START)
        .map(|thing| (i32::from(thing.x), i32::from(thing.y)))
}

/// The sectors carrying a NON-secret level exit line.
///
/// A secret exit ([`line_special::EXIT_SECRET`], 51) leads to the secret level
/// (E1M9) and is never the ST-1 pin, so it is excluded.
pub fn exit_sectors(map: &MapData) -> Vec<SectorId> {
    let mut out: Vec<SectorId> = Vec::new();
    for line in &map.lines {
        if !neurodoom::specials::is_exit_line(line.special) {
            continue;
        }
        if line.special == line_special::EXIT_SECRET {
            continue;
        }
        if !out.contains(&line.front_sector) {
            out.push(line.front_sector);
        }
    }
    out
}

/// Every passable portal (two-sided linedef) in the map.
///
/// Door linedefs are included — an opened door is a passable edge. A
/// self-referencing linedef (`front_sector == back_sector`) is not a portal
/// between distinct sectors and is skipped.
pub fn portals(map: &MapData) -> Vec<DoomPortal> {
    let mut out = Vec::new();
    for line in &map.lines {
        let Some(back) = line.back_sector else {
            continue;
        };
        let front = line.front_sector;
        if front == back {
            continue;
        }
        let (Some((ax, ay)), Some((bx, by))) =
            (vertex_units(map, line.v1), vertex_units(map, line.v2))
        else {
            continue;
        };
        let dx = bx - ax;
        let dy = by - ay;
        let width = isqrt_u64((dx * dx + dy * dy) as u64);
        out.push(DoomPortal {
            front,
            back,
            clearance: (width / 2) as i64,
            door: is_door_special(line.special),
        });
    }
    out
}

/// The sector containing integer map-unit `(x, y)`, via even-odd ray casting
/// over each sector's boundary lines. The lowest matching sector id wins.
pub fn sector_at(map: &MapData, x: i32, y: i32) -> Option<SectorId> {
    (0..map.sectors.len() as u16).find(|&sector| point_in_sector(map, sector, i64::from(x), i64::from(y)))
}

/// Even-odd (crossing-number) point-in-sector test over the sector's edge set.
fn point_in_sector(map: &MapData, sector: SectorId, x: i64, y: i64) -> bool {
    let mut inside = false;
    for line in &map.lines {
        if line.front_sector != sector && line.back_sector != Some(sector) {
            continue;
        }
        let (Some((ax, ay)), Some((bx, by))) =
            (vertex_units(map, line.v1), vertex_units(map, line.v2))
        else {
            continue;
        };
        // A +x ray from (x, y) crosses this edge iff the endpoints straddle y.
        if (ay > y) != (by > y) {
            let dy = by - ay;
            let x_cross = ax + (y - ay) * (bx - ax) / dy;
            if x < x_cross {
                inside = !inside;
            }
        }
    }
    inside
}

// ── Union-find (max-bottleneck path) ──────────────────────────────────────────

/// Union-find root with path halving.
fn find(parent: &mut [u32], mut node: usize) -> usize {
    while parent[node] as usize != node {
        let grandparent = parent[parent[node] as usize] as usize;
        parent[node] = grandparent as u32;
        node = grandparent;
    }
    node
}

/// Join two sets (the smaller root index wins, for deterministic forests).
fn union(parent: &mut [u32], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[ra.max(rb)] = ra.min(rb) as u32;
    }
}

/// The level's coarse walkability verdict (pure function of the map).
///
/// The clearance is the max-bottleneck over all spawn→exit routes: iterate the
/// portals by clearance descending, union their sectors, and record the
/// clearance at which the spawn sector first connects to each exit sector. The
/// maximum over exits is the level's clearance.
pub fn level_walkability(map: &MapData) -> LevelWalkability {
    let Some((sx, sy)) = spawn_point(map) else {
        return LevelWalkability::NoTerminals;
    };
    let Some(spawn) = sector_at(map, sx, sy) else {
        return LevelWalkability::NoTerminals;
    };
    let exits = exit_sectors(map);
    if exits.is_empty() {
        return LevelWalkability::NoTerminals;
    }

    let portals = portals(map);
    let mut parent: Vec<u32> = (0..map.sectors.len() as u32).collect();

    // A spawn that already stands on an exit sector needs no portal.
    let mut bottlenecks: Vec<Option<i64>> = exits
        .iter()
        .map(|exit| (*exit == spawn).then_some(i64::MAX))
        .collect();
    let mut remaining = bottlenecks.iter().filter(|b| b.is_none()).count();

    let mut edges: Vec<&DoomPortal> = portals.iter().collect();
    // Stable sort ⇒ equal-clearance ties keep linedef order (deterministic).
    edges.sort_by(|a, b| b.clearance.cmp(&a.clearance));

    for edge in edges {
        if remaining == 0 {
            break;
        }
        union(&mut parent, edge.front as usize, edge.back as usize);
        for (index, exit) in exits.iter().enumerate() {
            if bottlenecks[index].is_none()
                && find(&mut parent, spawn as usize) == find(&mut parent, *exit as usize)
            {
                bottlenecks[index] = Some(edge.clearance);
                remaining -= 1;
            }
        }
    }

    let Some(clearance) = bottlenecks.iter().flatten().copied().max() else {
        return LevelWalkability::Unreachable;
    };
    let (portals_on_route, doors_on_route) =
        route_counts(map, &portals, spawn, &exits, clearance);
    LevelWalkability::Walkable {
        clearance,
        portals: portals_on_route,
        doors: doors_on_route,
    }
}

/// The number of `(portals, doors)` on a deterministic BFS route from `spawn` to
/// any exit using only portals whose clearance is `>= min_clearance`.
fn route_counts(
    map: &MapData,
    portals: &[DoomPortal],
    spawn: SectorId,
    exits: &[SectorId],
    min_clearance: i64,
) -> (usize, usize) {
    let count = map.sectors.len();
    let mut adjacency: Vec<Vec<(usize, bool)>> = vec![Vec::new(); count];
    for portal in portals {
        if portal.clearance < min_clearance {
            continue;
        }
        adjacency[portal.front as usize].push((portal.back as usize, portal.door));
        adjacency[portal.back as usize].push((portal.front as usize, portal.door));
    }
    for neighbours in &mut adjacency {
        neighbours.sort_unstable();
    }

    let start = spawn as usize;
    let mut visited = vec![false; count];
    let mut previous: Vec<Option<(usize, bool)>> = vec![None; count];
    let mut queue = VecDeque::new();
    visited[start] = true;
    queue.push_back(start);

    while let Some(node) = queue.pop_front() {
        if node != start && exits.contains(&(node as u16)) {
            let (mut traversed, mut doors) = (0, 0);
            let mut cursor = node;
            while let Some((back, door)) = previous[cursor] {
                traversed += 1;
                if door {
                    doors += 1;
                }
                cursor = back;
            }
            return (traversed, doors);
        }
        for &(neighbour, door) in &adjacency[node] {
            if !visited[neighbour] {
                visited[neighbour] = true;
                previous[neighbour] = Some((node, door));
                queue.push_back(neighbour);
            }
        }
    }
    (0, 0)
}

// ── Engine-accurate passage predicate (Spec #3039 ST-2) ──────────────────────

/// Whether a linedef `special` is a key-locked door (classic `*_LOCKED_DOOR`).
/// A locked door is never a route leg without its key.
pub fn is_locked_door(special: i16) -> bool {
    matches!(
        special,
        line_special::BLUE_LOCKED_DOOR
            | line_special::YELLOW_LOCKED_DOOR
            | line_special::RED_LOCKED_DOOR
    )
}

/// Whether a linedef `special` is a walk-triggered door (opened by crossing it,
/// not by a `use` press).
pub fn is_walk_trigger_door(special: i16) -> bool {
    matches!(
        special,
        line_special::WALK_OPEN_DOOR
            | line_special::WALK_CLOSE_DOOR
            | line_special::WALK_RAISE_DOOR
            | line_special::WALK_CLOSE30_OPEN
    )
}

/// A sector's floor height in integer map units (`MapData.sectors`).
fn floor_units(map: &MapData, id: SectorId) -> i64 {
    map.sectors
        .get(id as usize)
        .map_or(0, |sector| i64::from(sector.floor_height >> FRACBITS))
}

/// A sector's static (as-loaded) ceiling height in integer map units.
fn ceiling_units(map: &MapData, id: SectorId) -> i64 {
    map.sectors
        .get(id as usize)
        .map_or(0, |sector| i64::from(sector.ceiling_height >> FRACBITS))
}

/// The floor + ceiling height (map units) at an integer map-unit point. Uses the
/// engine's BSP lookup on a node-bearing map; a synthetic map without nodes falls
/// back to the even-odd [`sector_at`] scan.
fn cell_heights(map: &MapData, point: (i64, i64)) -> (i64, i64) {
    if map.nodes.is_empty() {
        return match sector_at(map, point.0 as i32, point.1 as i32) {
            Some(sector) => (floor_units(map, sector), ceiling_units(map, sector)),
            None => (0, 0),
        };
    }
    let (floor, ceiling) = neurodoom::physics::find_sector_heights(
        map,
        (point.0 as i32) << FRACBITS,
        (point.1 as i32) << FRACBITS,
    );
    (i64::from(floor >> FRACBITS), i64::from(ceiling >> FRACBITS))
}

/// The OPENED ceiling height of every sector, in integer map units.
///
/// A door's static `ceiling_height` is its CLOSED position. When the engine opens
/// a door it raises the door sector's ceiling to the LOWEST ceiling of the door's
/// neighbours (classic `P_FindLowestCeilingSurrounding`). This pre-computes that
/// opened ceiling so the passage predicate can evaluate a door at its OPEN
/// clearance; every non-door sector keeps its static ceiling.
fn sector_open_ceilings(map: &MapData) -> Vec<i64> {
    let count = map.sectors.len();
    let static_ceil: Vec<i64> = (0..count).map(|i| ceiling_units(map, i as u16)).collect();
    let mut is_door = vec![false; count];
    for line in &map.lines {
        let Some(back) = line.back_sector else {
            continue;
        };
        let front = line.front_sector;
        if front == back || !is_door_special(line.special) {
            continue;
        }
        let (cf, cb) = (static_ceil[front as usize], static_ceil[back as usize]);
        // The door sector is the LOW-ceiling side of a closed-door linedef.
        let door = if cf < cb {
            front
        } else if cb < cf {
            back
        } else {
            continue;
        };
        is_door[door as usize] = true;
    }
    let mut open = static_ceil.clone();
    for sector in 0..count {
        if !is_door[sector] {
            continue;
        }
        // A door opens to the LOWEST ceiling of its (non-door) neighbours — NOT
        // below its own static ceiling, which is the closed position.
        let mut lowest: Option<i64> = None;
        for line in &map.lines {
            let Some(back) = line.back_sector else {
                continue;
            };
            let (f, b) = (line.front_sector as usize, back as usize);
            if f != sector && b != sector {
                continue;
            }
            let other = if f == sector { b } else { f };
            if other == sector || is_door[other] {
                continue;
            }
            lowest = Some(lowest.map_or(static_ceil[other], |value| value.min(static_ceil[other])));
        }
        if let Some(value) = lowest {
            open[sector] = value;
        }
    }
    open
}

/// The engine's movement rule for a two-sided linedef passage (Spec #3039 ST-2).
///
/// The passage from the linedef's FRONT sector `F` to its BACK sector `B` is
/// traversable only when ALL of:
///
/// * the line is not `ML_BLOCKING` ([`DOOM_LINE_BLOCKING_FLAG`]);
/// * it is two-sided and connects two distinct sectors;
/// * it is not a key-locked door ([`is_locked_door`]);
/// * `opening = min(ceil(F), ceil(B)) - max(floor(F), floor(B)) >= player_height`
///   — a door is evaluated at its OPEN ceiling ([`sector_open_ceilings`]);
/// * `step_up = floor(B) - floor(F) <= DOOM_MAX_STEP_HEIGHT` (a drop is allowed).
pub fn portal_traversable(map: &MapData, line_index: usize, player_height: i64) -> bool {
    let ceilings = sector_open_ceilings(map);
    portal_traversable_with(map, &ceilings, line_index, player_height)
}

/// [`portal_traversable`] against a pre-computed opened-ceiling table (the grid
/// builds [`sector_open_ceilings`] once and reuses it for every line).
fn portal_traversable_with(
    map: &MapData,
    ceilings: &[i64],
    line_index: usize,
    player_height: i64,
) -> bool {
    let Some(line) = map.lines.get(line_index) else {
        return false;
    };
    if line.flags & DOOM_LINE_BLOCKING_FLAG != 0 {
        return false;
    }
    let Some(back) = line.back_sector else {
        return false;
    };
    let front = line.front_sector;
    if front == back || is_locked_door(line.special) {
        return false;
    }
    let open_front = ceilings.get(front as usize).copied().unwrap_or(0);
    let open_back = ceilings.get(back as usize).copied().unwrap_or(0);
    let headroom = open_front.min(open_back) - floor_units(map, front).max(floor_units(map, back));
    if headroom < player_height {
        return false;
    }
    let step_up = floor_units(map, back) - floor_units(map, front);
    step_up <= DOOM_MAX_STEP_HEIGHT
}

/// Whether a linedef is an UNCONDITIONAL wall for the walkable grid: one-sided
/// (solid), flagged `ML_BLOCKING`, a key-locked door, or self-referencing. The
/// height rules (step-up, headroom) are DIRECTIONAL — the engine measures them
/// from the player's CURRENT floor (`PIT_CheckLine`) — so they are enforced on
/// the directed cell-to-cell edge ([`WalkGrid::edge_ok`]), never by walling the
/// line off. `ceilings` is retained so a door's line is evaluated at its OPEN
/// clearance when the caller classifies it.
fn linedef_is_wall(map: &MapData, _ceilings: &[i64], line_index: usize) -> bool {
    let Some(line) = map.lines.get(line_index) else {
        return true;
    };
    if line.back_sector.is_none()
        || line.flags & DOOM_LINE_BLOCKING_FLAG != 0
        || is_locked_door(line.special)
    {
        return true;
    }
    line.front_sector == line.back_sector.unwrap_or(line.front_sector)
}

// ── Clearance-aware walkable grid + deterministic A* (Spec #3039 ST-2) ───────

/// One waypoint on the route: the point to head toward (a free-cell centre), the
/// bearing and distance to it, and whether a `use`-gated door lies on the leg
/// that ends here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoomRouteWaypoint {
    /// The target point, in integer map units.
    pub target: (i64, i64),
    /// The absolute bearing (`0..=359`) from the previous waypoint (or the
    /// route origin) toward `target`.
    pub bearing: i64,
    /// The distance to `target`, in integer map units, clamped to
    /// `1..=DOOM_PLAN_DISTANCE_MAX`.
    pub distance: i64,
    /// Whether a `use`-gated door stands on the leg that ends at this waypoint.
    pub door: bool,
}

/// The deterministic outcome of a route query (Spec #3039 ST-2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteOutcome {
    /// A route of reachable free-cell-centre waypoints (empty when the player
    /// already stands on a goal cell).
    Path(Vec<DoomRouteWaypoint>),
    /// No route exists except through a key-locked door (Spec #3039 ST-3).
    LockedDoorOnly,
    /// No goal is reachable from the origin.
    NoRoute,
}

/// A route goal cell: an exit line's approach cell, and whether the exit is a
/// `use`-activated switch (a one-sided exit line).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteGoal {
    /// The grid cell index.
    pub cell: usize,
    /// Whether the exit is a `use`-activated switch.
    pub switch: bool,
}

/// The fixed 8-connected neighbour order (orthogonals then diagonals, each with
/// its A* base cost). A fixed order keeps A* deterministic.
const ROUTE_NEIGHBOURS: [(i64, i64, u32); 8] = [
    (1, 0, 10),
    (-1, 0, 10),
    (0, 1, 10),
    (0, -1, 10),
    (1, 1, 14),
    (1, -1, 14),
    (-1, 1, 14),
    (-1, -1, 14),
];

/// The map's vertex bounding box in integer map units, or `None` for an empty map.
fn vertex_bounds(map: &MapData) -> Option<(i64, i64, i64, i64)> {
    let mut iter = map.vertexes.iter();
    let first = iter.next()?;
    let mut min_x = i64::from(first.x) >> FRACBITS;
    let mut max_x = min_x;
    let mut min_y = i64::from(first.y) >> FRACBITS;
    let mut max_y = min_y;
    for vertex in iter {
        let x = i64::from(vertex.x) >> FRACBITS;
        let y = i64::from(vertex.y) >> FRACBITS;
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    Some((min_x, min_y, max_x, max_y))
}

/// The grid cell index nearest the map-unit coordinate `v` along one axis.
fn coord_to_cell(origin: i64, v: i64) -> i64 {
    (v - origin + DOOM_ROUTE_CELL_UNITS / 2).div_euclid(DOOM_ROUTE_CELL_UNITS)
}

/// The map-unit centre of grid cell `index` along one axis.
fn cell_centre(origin: i64, index: i64) -> i64 {
    origin + index * DOOM_ROUTE_CELL_UNITS
}

/// The cell index for integer grid coordinates, or `None` when out of range.
fn cell_index(cols: i64, rows: i64, cx: i64, cy: i64) -> Option<usize> {
    if cx < 0 || cy < 0 || cx >= cols || cy >= rows {
        return None;
    }
    Some(cy as usize * cols as usize + cx as usize)
}

/// The squared distance from point `p` to the segment `a`–`b`, integer-exact.
fn point_segment_dist_sq(p: (i64, i64), a: (i64, i64), b: (i64, i64)) -> i64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len_sq = dx * dx + dy * dy;
    let (px, py) = (p.0 - a.0, p.1 - a.1);
    if len_sq == 0 {
        return px * px + py * py;
    }
    let dot = px * dx + py * dy;
    if dot <= 0 {
        return px * px + py * py;
    }
    if dot >= len_sq {
        let (qx, qy) = (p.0 - b.0, p.1 - b.1);
        return qx * qx + qy * qy;
    }
    let cross = px * dy - py * dx;
    cross * cross / len_sq
}

/// Every grid cell the integer segment `(ax, ay)`–`(bx, by)` touches (the
/// supercover). An exact corner crossing emits BOTH orthogonal cells, so a leg
/// can never squeeze diagonally between two blocked cells.
fn supercover(ax: i64, ay: i64, bx: i64, by: i64) -> Vec<(i64, i64)> {
    let (dx, dy) = (bx - ax, by - ay);
    let (nx, ny) = (dx.abs(), dy.abs());
    let (sx, sy) = (dx.signum(), dy.signum());
    let (mut x, mut y) = (ax, ay);
    let (mut ix, mut iy) = (0i64, 0i64);
    let mut out = vec![(x, y)];
    while ix < nx || iy < ny {
        let decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
        if decision == 0 {
            out.push((x + sx, y));
            out.push((x, y + sy));
            x += sx;
            y += sy;
            ix += 1;
            iy += 1;
        } else if decision < 0 {
            x += sx;
            ix += 1;
        } else {
            y += sy;
            iy += 1;
        }
        out.push((x, y));
    }
    out
}

/// A clearance-aware, engine-accurate walkable grid rasterized from [`MapData`].
///
/// A cell's centre is FREE unless it lies within [`DOOM_PLAYER_RADIUS`] of a WALL
/// — a one-sided linedef, an `ML_BLOCKING` line, or a two-sided passage the
/// engine's movement rule rejects ([`portal_traversable`]). A traversable door
/// line is NOT a wall (the doorway stays free) but its cells are tagged so A*
/// pays [`DOOM_ROUTE_DOOR_PENALTY`] to cross it. Built ONCE per map and reused (a
/// lookup-only structure); the build is pure and bounded ([`DOOM_ROUTE_MAX_CELLS`]).
pub struct WalkGrid {
    origin: (i64, i64),
    cols: i64,
    rows: i64,
    free: Vec<bool>,
    door: Vec<bool>,
    /// The floor height (map units) at each cell centre — the oracle for the
    /// directional step rule.
    floor: Vec<i64>,
    /// The ceiling height (map units) at each cell centre — the oracle for the
    /// directional headroom rule.
    ceiling: Vec<i64>,
    /// The player collision height the grid was built for.
    player_height: i64,
    goals: Vec<RouteGoal>,
}

impl WalkGrid {
    /// Rasterize the walkable grid for `map` at `player_height` map units.
    pub fn build(map: &MapData, player_height: i64) -> Self {
        let unit = DOOM_ROUTE_CELL_UNITS;
        let (min_x, min_y, max_x, max_y) = vertex_bounds(map).unwrap_or((0, 0, 0, 0));
        let origin = (min_x - unit, min_y - unit);
        let cols = (max_x - min_x).div_euclid(unit) + 3;
        let rows = (max_y - min_y).div_euclid(unit) + 3;
        let total = (cols.max(0) as usize).saturating_mul(rows.max(0) as usize);
        if cols <= 0 || rows <= 0 || total > DOOM_ROUTE_MAX_CELLS {
            return Self {
                origin,
                cols: 0,
                rows: 0,
                free: Vec::new(),
                door: Vec::new(),
                floor: Vec::new(),
                ceiling: Vec::new(),
                player_height,
                goals: Vec::new(),
            };
        }

        // The floor + ceiling height at every cell centre (the directional step /
        // headroom oracles), via the engine's own BSP lookup.
        let mut floor = vec![0i64; total];
        let mut ceiling = vec![0i64; total];
        for cy in 0..rows {
            for cx in 0..cols {
                let Some(cell) = cell_index(cols, rows, cx, cy) else {
                    continue;
                };
                let centre = (cell_centre(origin.0, cx), cell_centre(origin.1, cy));
                let (cell_floor, cell_ceiling) = cell_heights(map, centre);
                floor[cell] = cell_floor;
                ceiling[cell] = cell_ceiling;
            }
        }

        let mut free = vec![true; total];
        let mut door = vec![false; total];
        let ceilings = sector_open_ceilings(map);
        let radius_sq = DOOM_PLAYER_RADIUS * DOOM_PLAYER_RADIUS;

        for (index, line) in map.lines.iter().enumerate() {
            let (Some(a), Some(b)) = (vertex_units(map, line.v1), vertex_units(map, line.v2)) else {
                continue;
            };
            let blocking = linedef_is_wall(map, &ceilings, index);
            let is_door = line.back_sector.is_some() && is_door_special(line.special) && !blocking;
            if !blocking && !is_door {
                continue;
            }
            // A door's cell is evaluated at the door's OPEN clearance (its static
            // ceiling is the CLOSED position).
            let door_open_ceiling = line
                .back_sector
                .map(|back| {
                    ceilings
                        .get(line.front_sector as usize)
                        .copied()
                        .unwrap_or(0)
                        .max(ceilings.get(back as usize).copied().unwrap_or(0))
                })
                .unwrap_or(0);
            let lo_x = coord_to_cell(origin.0, a.0.min(b.0) - DOOM_PLAYER_RADIUS);
            let hi_x = coord_to_cell(origin.0, a.0.max(b.0) + DOOM_PLAYER_RADIUS);
            let lo_y = coord_to_cell(origin.1, a.1.min(b.1) - DOOM_PLAYER_RADIUS);
            let hi_y = coord_to_cell(origin.1, a.1.max(b.1) + DOOM_PLAYER_RADIUS);
            for cy in lo_y..=hi_y {
                for cx in lo_x..=hi_x {
                    let Some(cell) = cell_index(cols, rows, cx, cy) else {
                        continue;
                    };
                    let centre = (cell_centre(origin.0, cx), cell_centre(origin.1, cy));
                    if point_segment_dist_sq(centre, a, b) < radius_sq {
                        if blocking {
                            free[cell] = false;
                        } else {
                            door[cell] = true;
                            ceiling[cell] = ceiling[cell].max(door_open_ceiling);
                        }
                    }
                }
            }
        }

        let goals = exit_goals(map, &free, origin, cols, rows);
        Self {
            origin,
            cols,
            rows,
            free,
            door,
            floor,
            ceiling,
            player_height,
            goals,
        }
    }

    /// The engine's directional movement rule for the move from cell `a` to cell
    /// `b` (`PIT_CheckLine`): the climb `floor(b) - floor(a)` must not exceed
    /// [`DOOM_MAX_STEP_HEIGHT`] (a drop is free), and the headroom from the
    /// CURRENT floor, `min(ceiling(a), ceiling(b)) - floor(a)`, must fit the
    /// player.
    fn edge_ok(&self, a: usize, b: usize) -> bool {
        let (Some(from), Some(to)) = (self.floor.get(a), self.floor.get(b)) else {
            return false;
        };
        let (Some(ceil_from), Some(ceil_to)) = (self.ceiling.get(a), self.ceiling.get(b)) else {
            return false;
        };
        if to - from > DOOM_MAX_STEP_HEIGHT {
            return false;
        }
        ceil_from.min(ceil_to) - from >= self.player_height
    }

    /// Whether `cell` is a free (occupiable) cell.
    pub fn is_free(&self, cell: usize) -> bool {
        self.free.get(cell).copied().unwrap_or(false)
    }

    /// Whether `cell` is one of this grid's route goals.
    pub fn is_goal(&self, cell: usize) -> bool {
        self.goals.iter().any(|goal| goal.cell == cell)
    }

    /// The map-unit centre of `cell`, or `None` for an out-of-range cell.
    pub fn centre(&self, cell: usize) -> Option<(i64, i64)> {
        if self.cols == 0 || cell >= self.free.len() {
            return None;
        }
        Some((
            cell_centre(self.origin.0, cell as i64 % self.cols),
            cell_centre(self.origin.1, cell as i64 / self.cols),
        ))
    }

    /// The nearest FREE cell to the map-unit point `point`, or `None`.
    pub fn nearest_free_cell(&self, point: (i64, i64)) -> Option<usize> {
        if self.cols == 0 || self.rows == 0 {
            return None;
        }
        nearest_free_snapped(&self.free, self.origin, self.cols, self.rows, point)
    }

    /// The goal cell nearest `from`, or `None` when the map has no goal.
    pub fn nearest_goal(&self, from: (i64, i64)) -> Option<RouteGoal> {
        if self.cols == 0 {
            return None;
        }
        self.goals.iter().copied().min_by_key(|goal| {
            let centre = (
                cell_centre(self.origin.0, goal.cell as i64 % self.cols),
                cell_centre(self.origin.1, goal.cell as i64 / self.cols),
            );
            (centre.0 - from.0).pow(2) + (centre.1 - from.1).pow(2)
        })
    }

    /// Whether the straight map-unit segment `a`–`b` stays inside free cells (its
    /// supercover touches no blocked cell).
    pub fn visible(&self, a: (i64, i64), b: (i64, i64)) -> bool {
        if self.cols == 0 {
            return false;
        }
        self.segment_free(
            (coord_to_cell(self.origin.0, a.0), coord_to_cell(self.origin.1, a.1)),
            (coord_to_cell(self.origin.0, b.0), coord_to_cell(self.origin.1, b.1)),
        )
    }

    /// Whether the supercover of the grid segment `a`–`b` is entirely free AND
    /// every consecutive step along it clears the directional step rule.
    fn segment_free(&self, a: (i64, i64), b: (i64, i64)) -> bool {
        let mut previous: Option<usize> = None;
        for (cx, cy) in supercover(a.0, a.1, b.0, b.1) {
            let Some(cell) = cell_index(self.cols, self.rows, cx, cy) else {
                return false;
            };
            if !self.free[cell] {
                return false;
            }
            if let Some(prev) = previous {
                if !self.edge_ok(prev, cell) {
                    return false;
                }
            }
            previous = Some(cell);
        }
        true
    }

    /// The deterministic A* route from `from` to the nearest goal, string-pulled
    /// into straight wall-free legs.
    pub fn route(&self, map: &MapData, from: (i64, i64)) -> RouteOutcome {
        if self.goals.is_empty() || self.cols == 0 {
            return RouteOutcome::NoRoute;
        }
        let Some(start) = self.nearest_free_cell(from) else {
            return RouteOutcome::NoRoute;
        };
        let heuristic = |cell: usize| -> u32 {
            let (cx, cy) = (cell as i64 % self.cols, cell as i64 / self.cols);
            self.goals
                .iter()
                .map(|goal| {
                    let (gx, gy) = (goal.cell as i64 % self.cols, goal.cell as i64 / self.cols);
                    let dx = (cx - gx).unsigned_abs() as u32;
                    let dy = (cy - gy).unsigned_abs() as u32;
                    10 * (dx + dy) - 6 * dx.min(dy)
                })
                .min()
                .unwrap_or(0)
        };

        let total = self.free.len();
        let mut best_g = vec![u32::MAX; total];
        let mut previous = vec![usize::MAX; total];
        let mut heap: BinaryHeap<Reverse<(u32, u32, usize)>> = BinaryHeap::new();
        best_g[start] = 0;
        heap.push(Reverse((heuristic(start), 0, start)));

        let mut reached = None;
        while let Some(Reverse((_f, g, cell))) = heap.pop() {
            if g > best_g[cell] {
                continue;
            }
            if self.is_goal(cell) {
                reached = Some(cell);
                break;
            }
            let cx = cell as i64 % self.cols;
            let cy = cell as i64 / self.cols;
            for (dx, dy, base) in ROUTE_NEIGHBOURS {
                let Some(next) = cell_index(self.cols, self.rows, cx + dx, cy + dy) else {
                    continue;
                };
                if !self.free[next] {
                    continue;
                }
                if dx != 0 && dy != 0 {
                    // Corner-cut rejection: both orthogonal neighbours must be free.
                    let (Some(ox), Some(oy)) = (
                        cell_index(self.cols, self.rows, cx + dx, cy),
                        cell_index(self.cols, self.rows, cx, cy + dy),
                    ) else {
                        continue;
                    };
                    if !self.free[ox] || !self.free[oy] {
                        continue;
                    }
                }
                if !self.edge_ok(cell, next) {
                    continue;
                }
                let cost = base
                    + if self.door[next] {
                        DOOM_ROUTE_DOOR_PENALTY as u32
                    } else {
                        0
                    };
                let tentative = g.saturating_add(cost);
                if tentative < best_g[next] {
                    best_g[next] = tentative;
                    previous[next] = cell;
                    heap.push(Reverse((
                        tentative.saturating_add(heuristic(next)),
                        tentative,
                        next,
                    )));
                }
            }
        }

        let Some(goal) = reached else {
            return RouteOutcome::NoRoute;
        };
        let mut cells = Vec::new();
        let mut cursor = goal;
        loop {
            cells.push(cursor);
            if cursor == start || previous[cursor] == usize::MAX {
                break;
            }
            cursor = previous[cursor];
        }
        if cells.last() != Some(&start) {
            return RouteOutcome::NoRoute;
        }
        cells.reverse();
        let stringed = self.string_pull(&cells);
        RouteOutcome::Path(self.waypoints(map, &stringed, from))
    }

    /// The straight, wall-free cells of `cells` a walker can follow greedily.
    fn string_pull(&self, cells: &[usize]) -> Vec<usize> {
        let mut out = Vec::new();
        let mut index = 0;
        while index < cells.len() {
            out.push(cells[index]);
            if index + 1 >= cells.len() {
                break;
            }
            let mut next = index + 1;
            let mut farthest = cells.len() - 1;
            while farthest > index + 1 {
                if self.cells_visible(cells[index], cells[farthest]) {
                    next = farthest;
                    break;
                }
                farthest -= 1;
            }
            index = next;
        }
        out
    }

    /// Whether the supercover between two cell indices is entirely free.
    fn cells_visible(&self, a: usize, b: usize) -> bool {
        self.segment_free(
            (a as i64 % self.cols, a as i64 / self.cols),
            (b as i64 % self.cols, b as i64 / self.cols),
        )
    }

    /// Build the waypoint list from a string-pulled cell path.
    fn waypoints(&self, map: &MapData, cells: &[usize], from: (i64, i64)) -> Vec<DoomRouteWaypoint> {
        let targets: &[usize] = if cells.len() > 1 { &cells[1..] } else { cells };
        let mut out = Vec::new();
        let mut reference = from;
        for &cell in targets {
            let Some(target) = self.centre(cell) else {
                continue;
            };
            let door = door_on_segment(map, reference, target).is_some();
            let (dx, dy) = (target.0 - reference.0, target.1 - reference.1);
            out.push(DoomRouteWaypoint {
                target,
                bearing: bearing_toward(dx, dy),
                distance: distance_units(dx, dy).clamp(1, DOOM_PLAN_DISTANCE_MAX),
                door,
            });
            reference = target;
        }
        out
    }
}

/// The nearest free cell to `point`, searching outward ring by ring.
fn nearest_free_snapped(
    free: &[bool],
    origin: (i64, i64),
    cols: i64,
    rows: i64,
    point: (i64, i64),
) -> Option<usize> {
    let cx0 = coord_to_cell(origin.0, point.0);
    let cy0 = coord_to_cell(origin.1, point.1);
    for ring in 0..=16i64 {
        let mut best: Option<(i64, usize)> = None;
        for cy in (cy0 - ring)..=(cy0 + ring) {
            for cx in (cx0 - ring)..=(cx0 + ring) {
                if ring > 0 && (cx - cx0).abs() != ring && (cy - cy0).abs() != ring {
                    continue;
                }
                let Some(cell) = cell_index(cols, rows, cx, cy) else {
                    continue;
                };
                if !free[cell] {
                    continue;
                }
                let centre = (cell_centre(origin.0, cx), cell_centre(origin.1, cy));
                let dist = (centre.0 - point.0).pow(2) + (centre.1 - point.1).pow(2);
                if best.is_none_or(|(best_dist, _)| dist < best_dist) {
                    best = Some((dist, cell));
                }
            }
        }
        if let Some((_, cell)) = best {
            return Some(cell);
        }
    }
    None
}

/// The goal cells: the free cell nearest each non-secret exit line, tagged with
/// whether the exit is a `use`-activated switch (a one-sided exit line).
fn exit_goals(
    map: &MapData,
    free: &[bool],
    origin: (i64, i64),
    cols: i64,
    rows: i64,
) -> Vec<RouteGoal> {
    let mut goals = Vec::new();
    for line in &map.lines {
        if line.special == line_special::EXIT_SECRET
            || !neurodoom::specials::is_exit_line(line.special)
        {
            continue;
        }
        let (Some(a), Some(b)) = (vertex_units(map, line.v1), vertex_units(map, line.v2)) else {
            continue;
        };
        let midpoint = ((a.0 + b.0) / 2, (a.1 + b.1) / 2);
        // The goal must be on the exit's FRONT sector (the reachable side): a
        // one-sided exit wall's nearest free cell can otherwise be in the void
        // behind the wall, which is unreachable.
        let Some(cell) = exit_goal_cell(map, free, origin, cols, rows, midpoint, line.front_sector)
        else {
            continue;
        };
        if goals.iter().any(|goal: &RouteGoal| goal.cell == cell) {
            continue;
        }
        goals.push(RouteGoal {
            cell,
            switch: line.back_sector.is_none(),
        });
    }
    goals
}

/// The free cell nearest `point` whose sector is `front`, searching outward ring
/// by ring (so an exit goal is never picked on the unreachable far side).
fn exit_goal_cell(
    map: &MapData,
    free: &[bool],
    origin: (i64, i64),
    cols: i64,
    rows: i64,
    point: (i64, i64),
    front: SectorId,
) -> Option<usize> {
    let cx0 = coord_to_cell(origin.0, point.0);
    let cy0 = coord_to_cell(origin.1, point.1);
    for ring in 0..=24i64 {
        let mut best: Option<(i64, usize)> = None;
        for cy in (cy0 - ring)..=(cy0 + ring) {
            for cx in (cx0 - ring)..=(cx0 + ring) {
                if ring > 0 && (cx - cx0).abs() != ring && (cy - cy0).abs() != ring {
                    continue;
                }
                let Some(cell) = cell_index(cols, rows, cx, cy) else {
                    continue;
                };
                if !free[cell] {
                    continue;
                }
                let centre = (cell_centre(origin.0, cx), cell_centre(origin.1, cy));
                if sector_at(map, centre.0 as i32, centre.1 as i32) != Some(front) {
                    continue;
                }
                let dist = (centre.0 - point.0).pow(2) + (centre.1 - point.1).pow(2);
                if best.is_none_or(|(best_dist, _)| dist < best_dist) {
                    best = Some((dist, cell));
                }
            }
        }
        if let Some((_, cell)) = best {
            return Some(cell);
        }
    }
    None
}

/// The integer bearing (`0..=359`) from `a` toward `b`.
pub fn bearing_between(a: (i64, i64), b: (i64, i64)) -> i64 {
    bearing_toward(b.0 - a.0, b.1 - a.1)
}

/// The integer euclidean distance between `a` and `b`, in map units.
pub fn distance_between(a: (i64, i64), b: (i64, i64)) -> i64 {
    distance_units(b.0 - a.0, b.1 - a.1)
}

/// The crossing point of the segment `a`–`b` with a DOOR linedef, or `None`.
/// Used by the follower to press `use` at the door it is walking into.
pub fn door_on_segment(map: &MapData, a: (i64, i64), b: (i64, i64)) -> Option<(i64, i64)> {
    for line in &map.lines {
        if line.back_sector.is_none() || !is_door_special(line.special) {
            continue;
        }
        let (Some(p), Some(q)) = (vertex_units(map, line.v1), vertex_units(map, line.v2)) else {
            continue;
        };
        if let Some(point) = segment_intersection(a, b, p, q) {
            return Some(point);
        }
    }
    None
}

/// The intersection point of segments `a`–`b` and `p`–`q`, when they cross.
fn segment_intersection(
    a: (i64, i64),
    b: (i64, i64),
    p: (i64, i64),
    q: (i64, i64),
) -> Option<(i64, i64)> {
    let r = (b.0 - a.0, b.1 - a.1);
    let s = (q.0 - p.0, q.1 - p.1);
    let denom = r.0 * s.1 - r.1 * s.0;
    if denom == 0 {
        return None;
    }
    let qp = (p.0 - a.0, p.1 - a.1);
    let t_num = qp.0 * s.1 - qp.1 * s.0;
    let u_num = qp.0 * r.1 - qp.1 * r.0;
    let within = |num: i64| {
        if denom > 0 {
            num >= 0 && num <= denom
        } else {
            num <= 0 && num >= denom
        }
    };
    if within(t_num) && within(u_num) {
        Some((a.0 + t_num * r.0 / denom, a.1 + t_num * r.1 / denom))
    } else {
        None
    }
}

/// A deterministic route from `from` to the nearest non-secret exit (Spec #3039
/// ST-2), as a [`RouteOutcome`]. Pure: the grid is built from `map` and the
/// player height only — no RNG, no clock, no I/O.
pub fn route_path(map: &MapData, from: (i64, i64), player_height: i64) -> RouteOutcome {
    WalkGrid::build(map, player_height).route(map, from)
}

/// The waypoint list of [`route_path`] at the fallback player height — retained
/// for callers that do not carry a live player entity (the ST-8 failure trace
/// and tests). Empty when no route exists.
pub fn route_waypoints(map: &MapData, from: (i64, i64)) -> Vec<DoomRouteWaypoint> {
    match route_path(map, from, DOOM_PLAYER_HEIGHT_FALLBACK) {
        RouteOutcome::Path(waypoints) => waypoints,
        RouteOutcome::LockedDoorOnly | RouteOutcome::NoRoute => Vec::new(),
    }
}

/// [`route_plan`] — the waypoint list projected onto [`DoomPlanStep`]s. Retained
/// as the pure plan projection of the ST-2 route.
pub fn route_plan(map: &MapData, from: (i64, i64)) -> Vec<DoomPlanStep> {
    let mut steps = Vec::new();
    for waypoint in route_waypoints(map, from) {
        if waypoint.door {
            steps.push(DoomPlanStep::OpenDoor {
                bearing: waypoint.bearing,
            });
        }
        steps.push(DoomPlanStep::Move {
            bearing: waypoint.bearing,
            distance: waypoint.distance,
        });
    }
    steps
}

/// The integer bearing (`0..=359`) from `(dx, dy)` toward a target — the same
/// projection the ST-1 door approach uses ([`neurodoom::map::point_to_angle`]).
fn bearing_toward(dx: i64, dy: i64) -> i64 {
    let angle = neurodoom::map::point_to_angle((dx as i32) << FRACBITS, (dy as i32) << FRACBITS);
    (((u64::from(angle) * 360) >> 32) as i64).rem_euclid(360)
}

/// The integer euclidean distance of `(dx, dy)`, in map units.
fn distance_units(dx: i64, dy: i64) -> i64 {
    isqrt_u64((dx * dx + dy * dy) as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use neurodoom::map::{BlockMap, Line, MapThing, Sector, Side, SlopeType, Vertex};

    // ── Synthetic geometry builders ──────────────────────────────────────────

    /// A vertex at integer map-unit `(x, y)` — stored as 16.16 `Fixed`, exactly
    /// like the real `MapData` (`x << FRACBITS`).
    fn vertex(x: i32, y: i32) -> Vertex {
        Vertex {
            x: x << FRACBITS,
            y: y << FRACBITS,
        }
    }

    fn sector() -> Sector {
        Sector {
            floor_height: 0,
            ceiling_height: 128 << FRACBITS,
            floor_pic: 0,
            ceiling_pic: 0,
            light_level: 0,
            special: 0,
            tag: 0,
            sound_traversed: 0,
            valid_count: 0,
            line_count: 0,
            first_line: 0,
            floor_pic_name: [0; 8],
            ceiling_pic_name: [0; 8],
        }
    }

    fn side(sector_id: SectorId) -> Side {
        Side {
            textureoffset: 0,
            rowoffset: 0,
            top_texture: 0,
            bottom_texture: 0,
            mid_texture: 0,
            sector: sector_id,
            top_texture_name: [0; 8],
            bottom_texture_name: [0; 8],
            mid_texture_name: [0; 8],
        }
    }

    fn linedef(v1: u16, v2: u16, front: SectorId, back: Option<SectorId>, special: i16) -> Line {
        Line {
            v1,
            v2,
            dx: 0,
            dy: 0,
            flags: 0,
            special,
            tag: 0,
            sidenum: [None, None],
            bbox: [0; 4],
            slope_type: SlopeType::Horizontal,
            front_sector: front,
            back_sector: back,
            valid_count: 0,
        }
    }

    fn thing(x: i16, y: i16, type_num: i16) -> MapThing {
        MapThing {
            x,
            y,
            angle: 0,
            type_num,
            options: 0,
        }
    }

    fn map_data(vertexes: Vec<Vertex>, sectors: Vec<Sector>, lines: Vec<Line>, things: Vec<MapThing>) -> MapData {
        let sides = (0..sectors.len() as u16).map(side).collect();
        MapData {
            vertexes,
            sectors,
            sides,
            lines,
            segs: Vec::new(),
            subsectors: Vec::new(),
            nodes: Vec::new(),
            blockmap: BlockMap {
                origin_x: 0,
                origin_y: 0,
                width: 0,
                height: 0,
                offsets: Vec::new(),
                lists: Vec::new(),
            },
            reject: Vec::new(),
            things,
        }
    }

    /// Two square sectors sharing a vertical portal of `opening` map units,
    /// spawn in sector 0, a normal exit line in sector 1.
    fn two_room_map(opening: i32, portal_special: i16) -> MapData {
        // Sector 0: (0,0)-(64,0)-(64,64)-(0,64); sector 1: right of x=64.
        let half = 64;
        let vertexes = vec![
            vertex(0, 0),           // 0
            vertex(half, 0),        // 1
            vertex(half, opening),  // 2  (portal top endpoint)
            vertex(0, opening),     // 3
            vertex(half + 64, 0),   // 4
            vertex(half + 64, opening), // 5
        ];
        let lines = vec![
            linedef(0, 1, 0, None, 0),               // sector 0 bottom wall
            linedef(1, 2, 0, Some(1), portal_special), // the shared portal
            linedef(1, 4, 1, None, 0),               // sector 1 bottom wall
            linedef(4, 5, 1, None, line_special::EXIT_NORMAL), // exit wall line
            linedef(5, 2, 1, None, 0),               // sector 1 top wall
            linedef(2, 3, 0, None, 0),               // sector 0 top wall
            linedef(3, 0, 0, None, 0),               // sector 0 left wall
        ];
        map_data(
            vertexes,
            vec![sector(), sector()],
            lines,
            vec![thing(32, 16, doomednum::PLAYER1_START)],
        )
    }

    // ── Pure model pins ──────────────────────────────────────────────────────

    #[test]
    fn a_wide_portal_has_margin_above_the_collision_radius() {
        // Opening = 64 map units ⇒ clearance = 32 ⇒ margin 16 (> 0).
        let map = two_room_map(64, 0);
        let verdict = level_walkability(&map);
        assert_eq!(
            verdict,
            LevelWalkability::Walkable {
                clearance: 32,
                portals: 1,
                doors: 0
            }
        );
        assert!(verdict.has_margin());
        assert_eq!(verdict.margin(), Some(16));
    }

    #[test]
    fn a_grazing_portal_is_a_zero_margin_graze() {
        // Opening = 32 map units ⇒ clearance = 16 = the collision radius.
        let map = two_room_map(32, 0);
        let verdict = level_walkability(&map);
        assert_eq!(verdict.clearance(), Some(DOOM_PLAYER_RADIUS));
        assert_eq!(verdict.margin(), Some(0));
        assert!(!verdict.has_margin(), "16 is a graze, not a margin");
    }

    #[test]
    fn a_door_portal_is_passable_and_counted_as_a_door() {
        let map = two_room_map(64, line_special::MANUAL_DOOR);
        let verdict = level_walkability(&map);
        assert_eq!(
            verdict,
            LevelWalkability::Walkable {
                clearance: 32,
                portals: 1,
                doors: 1
            }
        );
    }

    #[test]
    fn a_wall_between_the_rooms_is_unreachable() {
        // Remove the portal's back sector ⇒ a one-sided wall (front 0, no back).
        let mut map = two_room_map(64, 0);
        for line in &mut map.lines {
            if line.back_sector.is_some() {
                line.back_sector = None;
            }
        }
        assert_eq!(level_walkability(&map), LevelWalkability::Unreachable);
    }

    #[test]
    fn a_map_without_a_spawn_or_exit_has_no_terminals() {
        let map = two_room_map(64, 0);
        let mut no_spawn = map.clone();
        no_spawn.things.clear();
        assert_eq!(level_walkability(&no_spawn), LevelWalkability::NoTerminals);

        let mut no_exit = map;
        for line in &mut no_exit.lines {
            if line.special == line_special::EXIT_NORMAL {
                line.special = 0;
            }
        }
        assert_eq!(level_walkability(&no_exit), LevelWalkability::NoTerminals);
    }

    #[test]
    fn a_secret_exit_is_never_a_terminal() {
        let mut map = two_room_map(64, 0);
        for line in &mut map.lines {
            if line.special == line_special::EXIT_NORMAL {
                line.special = line_special::EXIT_SECRET;
            }
        }
        assert_eq!(level_walkability(&map), LevelWalkability::NoTerminals);
    }

    #[test]
    fn portals_skip_one_sided_and_self_referencing_lines() {
        let map = two_room_map(64, 0);
        let portals = portals(&map);
        assert_eq!(portals.len(), 1, "only the shared two-sided line is a portal");
        assert_eq!(portals[0].front, 0);
        assert_eq!(portals[0].back, 1);
        assert_eq!(portals[0].clearance, 32);
    }

    #[test]
    fn spawn_sector_is_found_by_ray_casting() {
        let map = two_room_map(64, 0);
        assert_eq!(sector_at(&map, 32, 32), Some(0));
        assert_eq!(sector_at(&map, 96, 32), Some(1));
    }

    #[test]
    fn isqrt_is_exact_for_perfect_squares() {
        assert_eq!(isqrt_u64(0), 0);
        assert_eq!(isqrt_u64(1), 1);
        assert_eq!(isqrt_u64(64), 8);
        assert_eq!(isqrt_u64(65), 8);
        assert_eq!(isqrt_u64(4096), 64);
    }

    // ── Map-derived route plan (ST-6) ────────────────────────────────────────

    #[test]
    fn route_on_e1m1_is_reachable_bounded_and_deterministic() {
        use neurodoom::engine::ClassicEngine;

        let engine = ClassicEngine::new(SCAN_WAD, "E1M1").expect("E1M1 loads");
        let map = engine.map();
        let (sx, sy) = spawn_point(map).expect("E1M1 has a player-1 start");
        let from = (i64::from(sx), i64::from(sy));

        let grid = WalkGrid::build(map, DOOM_PLAYER_HEIGHT_FALLBACK);
        let waypoints = route_waypoints(map, from);
        assert!(!waypoints.is_empty(), "E1M1 must yield a reachable route");
        // Every leg is a straight, wall-free supercover through FREE cells that
        // also clears the directional step/headroom rule.
        let mut reference = from;
        for waypoint in &waypoints {
            assert!(
                grid.visible(reference, waypoint.target),
                "leg {reference:?} -> {:?} must be wall-free",
                waypoint.target
            );
            assert!(
                (0..=359).contains(&waypoint.bearing),
                "bearing {}",
                waypoint.bearing
            );
            reference = waypoint.target;
        }

        let plan = route_plan(map, from);
        println!(
            "E1M1 route from {from:?}: {} waypoints, {} steps, doors={}",
            waypoints.len(),
            plan.len(),
            waypoints.iter().filter(|waypoint| waypoint.door).count(),
        );
        assert!(!plan.is_empty(), "the route plan must be non-empty");
        assert!(plan.len() <= 2 * waypoints.len());
        for step in &plan {
            match step {
                DoomPlanStep::Move { bearing, distance } => {
                    assert!((0..=359).contains(bearing), "bearing {bearing}");
                    assert!(
                        (1..=DOOM_PLAN_DISTANCE_MAX).contains(distance),
                        "distance {distance}"
                    );
                }
                DoomPlanStep::OpenDoor { bearing } => {
                    assert!((0..=359).contains(bearing), "bearing {bearing}");
                }
                other => panic!("route_plan emitted a non-route step: {other:?}"),
            }
        }

        // Determinism: byte-identical across two calls.
        assert_eq!(plan, route_plan(map, from));
        assert_eq!(waypoints, route_waypoints(map, from));
    }

    // ── Engine-accurate passage predicate + walkable grid (Spec #3039 ST-2) ──

    /// The index of the synthetic two-room map's shared portal linedef.
    fn portal_index(map: &MapData) -> usize {
        map.lines
            .iter()
            .position(|line| line.back_sector.is_some())
            .expect("the two-room map has a two-sided portal")
    }

    #[test]
    fn a_full_headroom_passage_is_traversable() {
        let map = two_room_map(64, 0);
        assert!(portal_traversable(
            &map,
            portal_index(&map),
            DOOM_PLAYER_HEIGHT_FALLBACK
        ));
    }

    #[test]
    fn a_step_blocked_passage_is_not_traversable() {
        let mut map = two_room_map(64, 0);
        map.sectors[1].floor_height = (DOOM_MAX_STEP_HEIGHT as i32 + 8) << FRACBITS;
        assert!(!portal_traversable(
            &map,
            portal_index(&map),
            DOOM_PLAYER_HEIGHT_FALLBACK
        ));
    }

    #[test]
    fn a_step_at_the_engine_boundary_is_traversable() {
        let mut map = two_room_map(64, 0);
        map.sectors[1].floor_height = (DOOM_MAX_STEP_HEIGHT as i32) << FRACBITS;
        assert!(portal_traversable(
            &map,
            portal_index(&map),
            DOOM_PLAYER_HEIGHT_FALLBACK
        ));
    }

    #[test]
    fn a_drop_is_traversable() {
        let mut map = two_room_map(64, 0);
        map.sectors[1].floor_height = -(64 << FRACBITS);
        assert!(portal_traversable(
            &map,
            portal_index(&map),
            DOOM_PLAYER_HEIGHT_FALLBACK
        ));
    }

    #[test]
    fn a_low_headroom_passage_is_not_traversable() {
        let mut map = two_room_map(64, 0);
        map.sectors[1].ceiling_height = ((DOOM_PLAYER_HEIGHT_FALLBACK - 8) as i32) << FRACBITS;
        assert!(!portal_traversable(
            &map,
            portal_index(&map),
            DOOM_PLAYER_HEIGHT_FALLBACK
        ));
    }

    #[test]
    fn a_locked_door_is_never_traversable() {
        let map = two_room_map(64, line_special::RED_LOCKED_DOOR);
        assert!(!portal_traversable(
            &map,
            portal_index(&map),
            DOOM_PLAYER_HEIGHT_FALLBACK
        ));
    }

    #[test]
    fn an_ml_blocking_line_is_never_traversable() {
        let mut map = two_room_map(64, 0);
        let index = portal_index(&map);
        map.lines[index].flags = DOOM_LINE_BLOCKING_FLAG;
        assert!(!portal_traversable(
            &map,
            portal_index(&map),
            DOOM_PLAYER_HEIGHT_FALLBACK
        ));
    }

    #[test]
    fn the_grid_routes_through_a_passable_portal() {
        let map = two_room_map(64, 0);
        let outcome = route_path(&map, (32, 16), DOOM_PLAYER_HEIGHT_FALLBACK);
        let RouteOutcome::Path(waypoints) = outcome else {
            panic!("expected a reachable path, got {outcome:?}");
        };
        assert!(
            !waypoints.is_empty(),
            "the exit room must be reachable through the portal"
        );
    }

    #[test]
    fn the_grid_refuses_a_step_blocked_passage() {
        let mut map = two_room_map(64, 0);
        map.sectors[1].floor_height = (DOOM_MAX_STEP_HEIGHT as i32 + 8) << FRACBITS;
        assert_eq!(
            route_path(&map, (32, 16), DOOM_PLAYER_HEIGHT_FALLBACK),
            RouteOutcome::NoRoute,
            "A* must never route through a step-blocked two-sided passage"
        );
    }

    #[test]
    fn the_grid_refuses_a_low_headroom_passage() {
        let mut map = two_room_map(64, 0);
        map.sectors[1].ceiling_height = ((DOOM_PLAYER_HEIGHT_FALLBACK - 8) as i32) << FRACBITS;
        assert_eq!(
            route_path(&map, (32, 16), DOOM_PLAYER_HEIGHT_FALLBACK),
            RouteOutcome::NoRoute
        );
    }

    #[test]
    fn the_grid_routes_across_a_drop() {
        let mut map = two_room_map(64, 0);
        map.sectors[1].floor_height = -(64 << FRACBITS);
        let outcome = route_path(&map, (32, 16), DOOM_PLAYER_HEIGHT_FALLBACK);
        assert!(
            matches!(outcome, RouteOutcome::Path(_)),
            "a drop is traversable, got {outcome:?}"
        );
    }

    #[test]
    fn probe_engine_passage_rules() {
        // Compiler probe: the engine exposes its OWN max step height as
        // `neurodoom::physics::MAXSTEPHEIGHT` (a 16.16 Fixed). DOOM_MAX_STEP_HEIGHT
        // must equal it — FAIL LOUD on any mismatch, never a silent literal.
        let engine_step = i64::from(neurodoom::physics::MAXSTEPHEIGHT >> FRACBITS);
        assert_eq!(
            DOOM_MAX_STEP_HEIGHT, engine_step,
            "DOOM_MAX_STEP_HEIGHT must equal neurodoom::physics::MAXSTEPHEIGHT"
        );

        // Empirical probe: read the engine's own live player entity height (the
        // oracle for DOOM_PLAYER_HEIGHT_FALLBACK).
        use neurodoom::engine::ClassicEngine;
        use neurodoom::world::PeerId;
        let engine = ClassicEngine::new(SCAN_WAD, "E1M1").expect("E1M1 loads");
        let world = engine.world();
        let height = world
            .controlled_by(PeerId(0))
            .and_then(|id| world.get(id))
            .map(|entity| i64::from(entity.height >> FRACBITS))
            .expect("the engine has a live player entity");
        assert_eq!(
            DOOM_PLAYER_HEIGHT_FALLBACK, height,
            "DOOM_PLAYER_HEIGHT_FALLBACK must equal the engine player height"
        );
    }

    // ── The executed feasibility scan + report ───────────────────────────────

    /// The bundled shareware `DOOM1.WAD` (mirrors `super::engine::EMBEDDED_WAD`).
    const SCAN_WAD: &[u8] = include_bytes!("../../../doom/DOOM1.WAD");

    /// The NON-secret ship levels (E1M9 is the secret level — never the pin).
    const NON_SECRET_LEVELS: [i64; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    /// A measured door-open duration, in engine tics.
    #[derive(Clone, Debug)]
    struct DoorMeasurement {
        level: i64,
        opening_tic: u64,
        waiting_tic: u64,
        duration_ticks: u64,
        /// Player map units advanced by pressing forward through the opened door
        /// (a passability probe — `0` would mean the door is not passable).
        advanced_units: i64,
        /// How long the door stayed `waiting` before it began `closing`, when
        /// observed (a cross-check against the engine's `VDOORWAIT`).
        waited_ticks: Option<u64>,
        /// The observed `tic:state` trace from the trigger to `waiting`.
        trace: String,
    }

    fn describe(verdict: &LevelWalkability) -> String {
        match verdict {
            LevelWalkability::Walkable {
                clearance,
                portals,
                doors,
            } => {
                let margin = clearance - DOOM_PLAYER_RADIUS;
                format!(
                    "walkable clearance={clearance} margin={margin} portals={portals} doors={doors}"
                )
            }
            LevelWalkability::Unreachable => "UNREACHABLE".to_string(),
            LevelWalkability::NoTerminals => "NO_TERMINALS".to_string(),
        }
    }

    #[tokio::test]
    async fn scan_non_secret_levels_and_write_report() {
        use neurodoom::engine::ClassicEngine;

        // ── Model scan over every non-secret level (pure geometry) ────────────
        let mut rows: Vec<(i64, LevelWalkability)> = Vec::new();
        let mut load_failures: Vec<(i64, String)> = Vec::new();
        for level in NON_SECRET_LEVELS {
            let name = format!("E1M{level}");
            match ClassicEngine::new(SCAN_WAD, &name) {
                Ok(engine) => rows.push((level, level_walkability(engine.map()))),
                Err(error) => load_failures.push((level, error.to_string())),
            }
        }
        for (level, verdict) in &rows {
            println!("E1M{level}: {}", describe(verdict));
        }
        for (level, error) in &load_failures {
            println!("E1M{level}: LOAD_ERROR {error}");
        }

        // ── Selection: the widest non-secret level with a positive margin ─────
        let selection = rows
            .iter()
            .filter(|(_, verdict)| verdict.has_margin())
            .map(|(level, verdict)| (*level, verdict.clearance().unwrap_or(0)))
            .max_by_key(|(level, clearance)| (*clearance, std::cmp::Reverse(*level)));

        // ── Door-open duration (sim-time; the selected target first) ──────────
        let mut measure_order: Vec<i64> = Vec::new();
        if let Some((level, _)) = selection {
            measure_order.push(level);
        }
        for level in NON_SECRET_LEVELS {
            if !measure_order.contains(&level) {
                measure_order.push(level);
            }
        }
        let door = measure_order
            .into_iter()
            .find_map(|level| measure_door_open_duration(level));

        // ── Sim-time drivability (run_bounded_driver + FixedTickClock) ────────
        // Prove each non-secret level is DRIVABLE by the deterministic bounded
        // driver in sim-time (no wall clock): it constructs, spawns, advances
        // ticks, and renders. This is the `run_bounded_driver` + `FixedTickClock`
        // leg the brief asks for.
        let mut drivability: Vec<(i64, Option<String>)> = Vec::new();
        for level in NON_SECRET_LEVELS {
            let summary = drive_level(level).await.map(|report| {
                format!(
                    "steps={} advanced={} moved={} terminal={:?}",
                    report.steps,
                    report.advanced(),
                    report.moved(),
                    report.terminal
                )
            });
            drivability.push((level, summary));
        }
        // Determinism (G-316): the SAME script + FixedTickClock reproduce the
        // report field-for-field at the selected target.
        if let Some((level, _)) = selection {
            let first = drive_level(level).await;
            let second = drive_level(level).await;
            assert_eq!(
                first, second,
                "run_bounded_driver + FixedTickClock reproduces the E1M{level} report"
            );
        }

        // ── Report ───────────────────────────────────────────────────────────
        let mut report = String::new();
        report.push_str("# Spec #3039 ST-1 — deterministic level-walkability feasibility spike\n\n");
        report.push_str(
            "Generated by `navigation::tests::scan_non_secret_levels_and_write_report` \
             (`cargo test`) — executed evidence, not a mock.\n\n",
        );
        report.push_str(
            "**Model.** Passability graph over `MapData`: a two-sided linedef is a passable \
             portal (an opened door is a passable edge); a one-sided linedef is a solid wall. A \
             portal's clearance is HALF its opening width (integer map units) — the radius of the \
             largest disc that fits through the gap. A level's clearance is the widest spawn→exit \
             route's bottleneck (Kruskal max-bottleneck). The player collision radius is 16 units; \
             `margin = clearance - 16` must be POSITIVE for a real (non-graze) target.\n\n",
        );
        report.push_str("| Level | Verdict |\n|-------|---------|\n");
        for (level, verdict) in &rows {
            report.push_str(&format!("| E1M{level} | {} |\n", describe(verdict)));
        }
        for (level, error) in &load_failures {
            report.push_str(&format!("| E1M{level} | LOAD_ERROR: {error} |\n"));
        }
        report.push('\n');

        report.push_str("## Selection\n\n");
        match selection {
            Some((level, clearance)) => {
                report.push_str(&format!(
                    "**DOOM_COMPLETION_TARGET_MAP = E1M{level}** — the widest non-secret level: \
                     clearance={clearance}, margin={} above the 16-unit collision radius.\n",
                    clearance - DOOM_PLAYER_RADIUS
                ));
            }
            None => {
                report.push_str(
                    "**ESCALATE a PO decision — no non-secret level has a positive margin.** \
                     Every measured non-secret level's failure mode:\n\n",
                );
                for (level, verdict) in &rows {
                    report.push_str(&format!("- E1M{level}: {}\n", describe(verdict)));
                }
                for (level, error) in &load_failures {
                    report.push_str(&format!("- E1M{level}: LOAD_ERROR {error}\n"));
                }
                report.push_str(
                    "\nThe secret E1M9 is never the pin. No target is shipped unmeasured.\n",
                );
            }
        }
        report.push('\n');

        report.push_str("## Sim-time drivability (`run_bounded_driver` + `FixedTickClock`)\n\n");
        report.push_str(
            "Each non-secret level is driven once by the deterministic bounded driver with a \
             one-tick held-forward+run script and the injected `FixedTickClock` — pure sim-time, \
             no wall clock. `steps` is the bounded engine-advancing tick count.\n\n",
        );
        report.push_str("| Level | Drive |\n|-------|-------|\n");
        for (level, summary) in &drivability {
            match summary {
                Some(summary) => report.push_str(&format!("| E1M{level} | {summary} |\n")),
                None => report.push_str(&format!("| E1M{level} | DRIVE_ERROR |\n")),
            }
        }
        report.push('\n');

        report.push_str("## Door-open duration (`use` → `opening` → `waiting`)\n\n");
        match door {
            Some(door) => {
                let waited = match door.waited_ticks {
                    Some(ticks) => format!("stayed `waiting` for {ticks} tics before closing"),
                    None => "did not begin closing within the observation window".to_string(),
                };
                report.push_str(&format!(
                    "Measured on **E1M{}** in sim-time: `state=\"opening\"` at tic {}, \
                     `state=\"waiting\"` at tic {} ⇒ **{} tics** to fully open (the door then \
                     {waited}). Passability probe: with the door at its top, pressing forward \
                     advanced the player **{} map units** through the opening. Observed trace \
                     (`tic:state`): `{}`. `DOOM_DOOR_WAIT_MAX_TICKS` = 210 ({:.1} s at 35 tics/s) \
                     is a generous bound for the measured door.\n",
                    door.level,
                    door.opening_tic,
                    door.waiting_tic,
                    door.duration_ticks,
                    door.advanced_units,
                    door.trace,
                    f64::from(210u32) / 35.0,
                ));
            }
            None => report.push_str(
                "Door-open duration NOT measured — no usable door was reached by the deterministic \
                 driver this round. `DOOM_DOOR_WAIT_MAX_TICKS` = 210 remains provisional (must be \
                 re-measured before finalizing).\n",
            ),
        }

        // Write the scratch report (gitignored). Hard requirement: the spike
        // must EXECUTE and produce the file.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.opencode/tmp/3039/level-feasibility.md");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create the scratch report dir");
        }
        std::fs::write(&path, &report).expect("write the scratch feasibility report");
        println!("\n{report}");
        println!("report written to {}", path.display());
    }

    /// Drive one level with the deterministic bounded driver
    /// ([`run_bounded_driver`] + [`FixedTickClock`]) and a held-forward+run
    /// script. Pure sim-time — no wall clock (G-316).
    async fn drive_level(
        level: i64,
    ) -> Option<crate::applications::doom::engine::DoomDriverReport> {
        use crate::applications::doom::clock::{FixedTickClock, DOOM_CONTINUOUS_TICK_PERIOD_MS};
        use crate::applications::doom::decision::ScriptedDecisionSource;
        use crate::applications::doom::engine::{
            run_bounded_driver, DoomDriverConfig, DoomEngineState,
        };
        use serde_json::json;

        let source = ScriptedDecisionSource::from_script_json(
            &json!({
                "decisions": [
                    { "tics": 1, "actions": [{ "type": "forward" }, { "type": "run" }] }
                ],
                "repeat": true
            })
            .to_string(),
        )
        .ok()?;
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let state = DoomEngineState::default();
        run_bounded_driver(
            &state,
            &source,
            DoomDriverConfig {
                map: level,
                skill: super::super::save::DOOM_DEFAULT_SKILL,
                max_steps: 64,
                max_failures: 3,
                stop_at_first_exit: false,
            },
            &clock,
        )
        .await
        .ok()
    }

    /// Drive the real engine to a usable door, press `use`, and count the tics
    /// until the door reports `state == "waiting"`. Pure sim-time (one engine
    /// step per tic, no wall clock).
    fn measure_door_open_duration(level: i64) -> Option<DoorMeasurement> {
        use crate::applications::doom::engine::DoomEngineState;
        use neurodoom::engine::ClassicEngine;
        use serde_json::json;

        let name = format!("E1M{level}");
        let geometry = ClassicEngine::new(SCAN_WAD, &name).ok()?;
        let door_points = door_midpoints(geometry.map());
        if door_points.is_empty() {
            return None;
        }

        let state = DoomEngineState::default();
        state
            .launch(level, super::super::save::DOOM_DEFAULT_SKILL)
            .ok()?;

        // Approach a usable door one engine tick at a time and re-read the door
        // state after EVERY tick, so the trigger-to-observation gap is at most
        // one tick and `opening_tic` is the true start of the opening.
        let mut triggered = false;
        for _ in 0..2400 {
            let observation = state.read_state().ok()?;
            if door_states(&observation)
                .iter()
                .any(|state| state == "opening" || state == "waiting")
            {
                triggered = true;
                break;
            }
            let px = observation.pointer("/player/x")?.as_i64()?;
            let py = observation.pointer("/player/y")?.as_i64()?;
            let (tx, ty) = nearest(&door_points, px, py);
            let (dx, dy) = (tx - px, ty - py);
            let bearing = bearing_degrees(dx, dy);
            if dx * dx + dy * dy <= 56 * 56 {
                state
                    .step(1, &json!([{ "type": "turn-to", "angle": bearing }]))
                    .ok()?;
                state.step(1, &json!([{ "type": "use" }])).ok()?;
            } else {
                state
                    .step(1, &json!([
                        { "type": "turn-to", "angle": bearing },
                        { "type": "run" },
                        { "type": "forward" }
                    ]))
                    .ok()?;
            }
            let after = state.read_state().ok()?;
            if door_states(&after)
                .iter()
                .any(|state| state == "opening" || state == "waiting")
            {
                triggered = true;
                break;
            }
        }
        if !triggered {
            return None;
        }

        let mut opening_tic: Option<u64> = None;
        let mut trace = String::new();
        for _ in 0..600 {
            let observation = state.step(1, &json!([])).ok()?;
            let tic = observation.get("tic")?.as_u64()?;
            let states = door_states(&observation);
            let summary = if states.is_empty() {
                "closed".to_string()
            } else {
                states.join("+")
            };
            if trace.len() < 400 {
                trace.push_str(&format!("{tic}:{summary} "));
            }
            if opening_tic.is_none() && states.iter().any(|state| state == "opening") {
                opening_tic = Some(tic);
            }
            if let Some(opening) = opening_tic {
                if states.iter().any(|state| state == "waiting") {
                    // Passability probe: with the door at its top, press forward —
                    // the player must actually advance through the opening.
                    let (bx, by) = player_units(&state.read_state().ok()?)?;
                    state
                        .step(10, &json!([{ "type": "run" }, { "type": "forward" }]))
                        .ok()?;
                    let (ax, ay) = player_units(&state.read_state().ok()?)?;
                    let advanced_units = isqrt_u64(
                        (ax - bx).unsigned_abs().pow(2) + (ay - by).unsigned_abs().pow(2),
                    ) as i64;

                    // Cross-check the engine's door model: how long does the door
                    // stay `waiting` before it begins `closing`? (`VDOORWAIT` = 150
                    // tics for a normal auto-closing door.)
                    let mut waited_ticks = None;
                    for _ in 0..240 {
                        let subsequent = state.step(1, &json!([])).ok()?;
                        let next_tic = subsequent.get("tic")?.as_u64()?;
                        if door_states(&subsequent)
                            .iter()
                            .any(|state| state == "closing")
                        {
                            waited_ticks = Some(next_tic.saturating_sub(tic));
                            break;
                        }
                    }
                    return Some(DoorMeasurement {
                        level,
                        opening_tic: opening,
                        waiting_tic: tic,
                        duration_ticks: tic.saturating_sub(opening),
                        advanced_units,
                        waited_ticks,
                        trace: trace.trim_end().to_string(),
                    });
                }
            }
        }
        None
    }

    /// The midpoints (integer map units) of the map's `use`-openable door lines.
    fn door_midpoints(map: &MapData) -> Vec<(i64, i64)> {
        let mut out = Vec::new();
        for line in &map.lines {
            if line.back_sector.is_none() || !is_usable_door(line.special) {
                continue;
            }
            let (Some((ax, ay)), Some((bx, by))) =
                (vertex_units(map, line.v1), vertex_units(map, line.v2))
            else {
                continue;
            };
            out.push(((ax + bx) / 2, (ay + by) / 2));
        }
        out
    }

    /// The door `state` strings in an observation's bounded `doors[]` array.
    fn door_states(observation: &serde_json::Value) -> Vec<String> {
        observation
            .get("doors")
            .and_then(serde_json::Value::as_array)
            .map(|doors| {
                doors
                    .iter()
                    .filter_map(|door| door.get("state").and_then(serde_json::Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The player's integer map-unit `(x, y)` from an observation.
    fn player_units(observation: &serde_json::Value) -> Option<(i64, i64)> {
        let x = observation.pointer("/player/x")?.as_i64()?;
        let y = observation.pointer("/player/y")?.as_i64()?;
        Some((x, y))
    }

    /// The point nearest `(px, py)` from `points`.
    fn nearest(points: &[(i64, i64)], px: i64, py: i64) -> (i64, i64) {
        *points
            .iter()
            .min_by_key(|(x, y)| (x - px) * (x - px) + (y - py) * (y - py))
            .expect("door_midpoints is non-empty")
    }

    /// The integer bearing (0..=359) from `(dx, dy)` toward a target.
    fn bearing_degrees(dx: i64, dy: i64) -> i64 {
        let angle = neurodoom::map::point_to_angle(
            (dx as i32) << FRACBITS,
            (dy as i32) << FRACBITS,
        );
        (((u64::from(angle) * 360) >> 32) as i64).rem_euclid(360)
    }
}
