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

use std::collections::VecDeque;

use neurodoom::map::{doomednum, line_special, MapData, SectorId};
use neurodoom::math::FRACBITS;

// ── Pinned model constants ────────────────────────────────────────────────────

/// The classic Doom player collision radius, in integer map units.
pub const DOOM_PLAYER_RADIUS: i64 = 16;

/// The minimum opening width a radius-[`DOOM_PLAYER_RADIUS`] player can squeeze
/// through with zero margin (`2 * radius`).
pub const DOOM_PASSAGE_MIN_WIDTH: i64 = DOOM_PLAYER_RADIUS * 2;

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
