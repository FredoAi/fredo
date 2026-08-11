/**
 * layout.ts — Force-directed layout for Mission Monitor graph.
 *
 * Uses d3-force to compute positions where connected nodes cluster closer
 * and settled (complete/error) nodes are frozen in place.
 *
 * - forceCollide with level-based radii: agent 180px, subagent 180px, tool 160px, file 140px
 * - forceManyBody with per-node strength: agent -600, subagent -400, tool/file -300
 * - forceCenter(0, 0) prevents drift to canvas edges
 * - forceLink distance 400px for wide nodes (280-360px)
 * - Per-depth forceY for vertical layering (agent depth 0 at y=0, children at y+400)
 * - Level-based initial positioning: agents in vertical column, non-agents offset horizontally
 * - Convergence within maxIterations (300) or alpha below threshold
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceY,
  forceCollide,
  forceCenter,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

/** Input node for layout computation. */
export interface LayoutNode {
  id: string;
  status: string;
  /** Depth in the graph hierarchy (0=agent, 1=subagent/tool, 2=file) */
  depth?: number;
  /** Node type identifier ('agent' | 'subagent' | 'tool' | 'file') */
  type?: string;
  /** Level in the hierarchy (1=agent, 2=subagent, 3=tool, 4=file).
   *  Derived from `type` field when absent. */
  level?: number;
}

// ── #2688 ST4: deterministic vertical chat chain ──────────────────────────────

/** Vertical gap between consecutive chat nodes in the chain (px). */
export const CHAIN_NODE_SPACING = 260;

/** X coordinate shared by every chat node in the chain (px, canvas-centered). */
export const CHAIN_X_CENTER = 0;

/** Y coordinate of the OLDEST chat node in a session's chain (px). Newer
 *  nodes stack below it (larger y) at CHAIN_NODE_SPACING intervals, so the
 *  chain reads top-to-bottom (oldest at top, newest at bottom). */
export const CHAIN_TOP_Y = 0;

/**
 * A chat (agent) node's identity plus its session, in arrival order.
 */
export interface ChainAgent {
  id: string;
  sessionId: string;
}

/**
 * Compute deterministic per-session vertical chain positions for chat nodes.
 *
 * The oldest chat node of a session sits at the top (y = CHAIN_TOP_Y) and
 * each newer node is stacked CHAIN_NODE_SPACING below it, so the newest
 * chat node ends up at the bottom (largest y) and the conversation reads
 * top-to-bottom like a normal chat log. All nodes share CHAIN_X_CENTER.
 * Sessions are independent — a fresh second session starts its own chain
 * at the top.
 *
 * @param agents - Chat node ids with their session, in arrival order (oldest first).
 * @returns A Map of node id → { x, y } positions.
 */
export function computeChatChainPositions(agents: ChainAgent[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Group by session preserving arrival order.
  const bySession = new Map<string, ChainAgent[]>();
  for (const agent of agents) {
    const list = bySession.get(agent.sessionId) ?? [];
    list.push(agent);
    bySession.set(agent.sessionId, list);
  }

  for (const list of bySession.values()) {
    // list[0] = oldest → top (smallest y); list[last] = newest → bottom.
    for (let i = 0; i < list.length; i++) {
      const y = CHAIN_TOP_Y + i * CHAIN_NODE_SPACING;
      positions.set(list[i].id, { x: CHAIN_X_CENTER, y });
    }
  }

  return positions;
}

/** Input edge for layout computation. */
export interface LayoutEdge {
  source: string;
  target: string;
}

/** Extra options for force layout computation. */
export interface ForceLayoutOptions {
  maxIterations?: number;
  alphaMin?: number;
  alphaDecay?: number;
  /** Existing positions to preserve as initial positions for matching nodes. */
  existingPositions?: Map<string, { x: number; y: number }>;
}

/** Result of a force layout run. */
export interface ForceLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  converged: boolean;
  iterations: number;
}

/** Internal simulation node — extends d3-force SimulationNodeDatum. */
interface SimNode extends SimulationNodeDatum {
  id: string;
  status: string;
  depth?: number;
  type?: string;
  level?: number;
}

/**
 * Run force-directed layout on a set of nodes and edges using d3-force.
 *
 * - forceCollide prevents node overlap with level-based radii:
 *   agent=180px, subagent=180px, tool=160px, file=140px.
 * - forceManyBody repels with per-node strength: agent -600,
 *   subagent -400, tool/file -300.
 * - forceCenter(0, 0) prevents drift to canvas edges.
 * - forceLink attracts connected nodes at 400px distance.
 * - Per-depth forceY: agent nodes (depth 0) at y≈0, children (depth 1) at y≈400.
 * - Level-based initial positioning: agents in a vertical column (y-spacing 200px),
 *   non-agent nodes offset horizontally.
 * - Nodes with status 'complete' or 'error' are settled: their positions are
 *   frozen with fx/fy so they don't move during simulation.
 * - Converges when alpha drops below alphaMin (default 0.01) or after
 *   maxIterations (default 300).
 * - Returns a Map of node id to {x, y} positions.
 */
export function computeForceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options?: ForceLayoutOptions,
): ForceLayoutResult {
  const maxIterations = options?.maxIterations ?? 300;
  const alphaMin = options?.alphaMin ?? 0.01;
  const alphaDecay = options?.alphaDecay ?? 0.02;
  const existingPositions = options?.existingPositions;

  if (nodes.length === 0) {
    return { positions: new Map(), converged: true, iterations: 0 };
  }

  // Build simulation nodes with stable initial positions
  // - Existing positions preserved for layout stability (AC-6 / REQ-6)
  // - Settled (complete/error) nodes frozen so they don't move
  // - New nodes get level-based initial positions: agents in staggered vertical
  //   column, non-agent nodes offset horizontally from agent column
  let agentIndex = 0;
  const simNodes: SimNode[] = nodes.map((n) => {
    const isSettled = n.status === 'complete' || n.status === 'error';
    const level = n.level ?? (n.type === 'agent' ? 1 : n.type === 'subagent' ? 2 : n.type === 'tool' ? 3 : 4);
    // Use existing position if available, otherwise level-based initial position
    const existing = existingPositions?.get(n.id);
    let x: number;
    let y: number;
    if (existing) {
      x = existing.x;
      y = existing.y;
    } else if (level === 1) {
      // Agent nodes: staggered vertical column with 200px y-spacing
      x = -100;
      y = -400 + agentIndex * 200;
      agentIndex++;
    } else {
      // Non-agent nodes: offset horizontally from agent column with random spread
      x = 200 + Math.random() * 300;
      y = -400;
    }
    return {
      id: n.id,
      status: n.status,
      depth: n.depth,
      type: n.type,
      level,
      x,
      y,
      // Freeze settled nodes at their position so they don't move
      fx: isSettled ? x : undefined,
      fy: isSettled ? y : undefined,
    };
  });

  // Build index map for link resolution
  const nodeIndexMap = new Map<string, number>();
  simNodes.forEach((n, i) => nodeIndexMap.set(n.id, i));

  // Build simulation links — only for edges where both endpoints exist
  const simLinks: SimulationLinkDatum<SimNode>[] = [];
  for (const edge of edges) {
    const sourceIdx = nodeIndexMap.get(edge.source);
    const targetIdx = nodeIndexMap.get(edge.target);
    if (sourceIdx !== undefined && targetIdx !== undefined) {
      simLinks.push({ source: sourceIdx, target: targetIdx });
    }
  }

  // Helper: derive level from node fields (used by multiple force functions)
  const resolveLevel = (d: SimNode): number =>
    d.level ?? (d.type === 'agent' ? 1 : d.type === 'subagent' ? 2 : d.type === 'tool' ? 3 : 4);

  // Create simulation with level-based collision, charge, centering, and depth layering
  // - forceLink: connected nodes attract at 400px distance (sufficient for 280-360px-wide nodes)
  // - forceCollide: level-based radii prevent overlap (agent=180, subagent=180, tool=160, file=140)
  // - charge: per-node strength based on level (agent=-600, subagent=-400, tool/file=-300)
  // - center: prevents drift to canvas edges while forceCollide+forceManyBody distribute nodes
  // - y: each depth layer has its own Y target (depth*400), with 0.1 strength
  //   to allow horizontal spread while maintaining vertical hierarchy
  const simulation = forceSimulation(simNodes)
    .alphaDecay(alphaDecay)
    .alphaMin(alphaMin)
    .force('link', forceLink(simLinks).distance(400))
    .force('charge', forceManyBody<SimNode>().strength((d) => {
      const lvl = resolveLevel(d);
      return lvl === 1 ? -600 : lvl === 2 ? -400 : -300;
    }))
    .force('collide', forceCollide<SimNode>().radius((d) => {
      const lvl = resolveLevel(d);
      // Collision radii match actual node dimensions:
      //   agent:   max 360px wide → half-width 180px
      //   subagent: max 360px wide → half-width 180px
      //   tool:    max 320px wide → half-width 160px
      //   file:    max 280px wide → half-width 140px
      return lvl === 1 ? 180 : lvl === 2 ? 180 : lvl === 3 ? 160 : 140;
    }))
    .force('center', forceCenter(0, 0))
    .force('y', forceY<SimNode>().y((d) => (d.depth ?? 0) * 400).strength(0.1));

  // Run simulation with iteration cap (REQ-7)
  let iterations = 0;
  for (let i = 0; i < maxIterations; i++) {
    simulation.tick();
    iterations++;
    if (simulation.alpha() < alphaMin) {
      break;
    }
  }

  simulation.stop();

  const converged = simulation.alpha() < alphaMin;

  // Build result map of node id → {x, y}
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of simNodes) {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }

  return { positions, converged, iterations };
}
