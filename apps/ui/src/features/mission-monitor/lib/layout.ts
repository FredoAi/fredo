/**
 * layout.ts — Force-directed layout for Mission Monitor graph.
 *
 * Uses d3-force to compute positions where connected nodes cluster closer
 * and settled (complete/error) nodes are frozen in place.
 *
 * - forceCollide with level-based radii: agent 270px, subagent 270px, tool 240px, file 210px
 * - forceManyBody with per-node strength: agent -600, subagent -400, tool/file -300
 * - forceCenter(0, 0) prevents drift to canvas edges
 * - forceLink distance 600px for the ~1.5× wider nodes (420-540px)
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

// ── #2688 ST4 / #2723 ST4: deterministic vertical chat chain ─────────────────
//
// #2688 ST4 introduced the vertical chain; #2723 ST4 (R-4 / AC4) made the
// stacking MEASURED-HEIGHT aware. The old fixed CHAIN_NODE_SPACING (260px)
// could not fit a content node's variable height (min ≈ 314px with a full
// response box), so collisions between consecutive chat nodes were
// structurally guaranteed. The chain now stacks each node BELOW its
// predecessor's last measured ReactFlow height + CHAIN_GAP:
//
//   y_next = y_prev + (prev.height ?? DEFAULT_NODE_HEIGHT) + CHAIN_GAP
//
// Unmeasured fresh nodes fall back to DEFAULT_NODE_HEIGHT (a conservative
// 320px — the real content node is ~314px minimum), so a fresh node can
// never overlap its neighbors even before ReactFlow reports its size.

/** Vertical gap between consecutive chat nodes in the chain (px). */
export const CHAIN_GAP = 28;

/** Conservative fallback height for an unmeasured (fresh) chat node (px).
 *  #2743 AC-6: the full-label token row + cost row make content nodes taller,
 *  so the fallback rises 320 → 360. Still guarantees a fresh node can never
 *  cover its neighbor below it. */
export const DEFAULT_NODE_HEIGHT = 360;

/** X coordinate shared by every chat node in the chain (px, canvas-centered). */
export const CHAIN_X_CENTER = 0;

/** Y coordinate of the OLDEST chat node in a session's chain (px). Newer
 *  nodes stack below it (larger y) at measured-height + CHAIN_GAP intervals,
 *  so the chain reads top-to-bottom (oldest at top, newest at bottom). */
export const CHAIN_TOP_Y = 0;

/**
 * A chat (agent) node's identity plus its session, in arrival order.
 */
export interface ChainAgent {
  id: string;
  sessionId: string;
  /** Last measured ReactFlow height of the node (px). Falls back to
   *  DEFAULT_NODE_HEIGHT when unmeasured (fresh node not yet rendered). */
  height?: number;
}

/**
 * Compute deterministic per-session vertical chain positions for chat nodes.
 *
 * The oldest chat node of a session sits at the top (y = CHAIN_TOP_Y) and
 * each newer node is stacked BELOW its predecessor by the predecessor's
 * measured height + CHAIN_GAP, so the newest chat node ends up at the bottom
 * (largest y) and the conversation reads top-to-bottom like a normal chat
 * log. Because the gap derives from the actual measured height, a content
 * node with a full response box can never overlap or cover the node beneath
 * it (R-4 / AC4). All nodes share CHAIN_X_CENTER. Sessions are independent —
 * a fresh second session starts its own chain at the top.
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
    let y = CHAIN_TOP_Y;
    for (let i = 0; i < list.length; i++) {
      positions.set(list[i].id, { x: CHAIN_X_CENTER, y });
      // Stack the NEXT node below THIS node's measured height (+ gap).
      y += (list[i].height ?? DEFAULT_NODE_HEIGHT) + CHAIN_GAP;
    }
  }

  return positions;
}

// ── #2739 ST-3: deterministic right-side ToolsNode chain slots ──────────────
//
// Each ToolsNode (a per-chat-node summary of that exchange's tool calls) sits
// in a dedicated column to the RIGHT of its parent chat node, at the parent's
// own y — a deterministic, chain-adjacent slot (plan NFR-3 / UI-UX §4):
//
//   x = CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH + TOOLS_GAP
//     (= chatNode.x + chatNode.width + 24 for a chain-anchored chat node)
//   y = parent chat node y
//
// Why the FULL max chat-node width (540px), not the half-width (270px): the
// chat chain is anchored top-left at CHAIN_X_CENTER, so a chat node spans
// [CHAIN_X_CENTER, CHAIN_X_CENTER + width] with width up to 540 (ChatNode
// maxWidth). A slot computed from the half-width (0 + 270 + 24 = 294) would
// land INSIDE the chat node's box (overlap — violates NFR-3). Using the max
// width guarantees zero overlap with the vertical chat chain for ANY chat
// node width (min 420 / max 540) by construction.
//
// Tools nodes are chain-owned: they are placed by this pure geometry, NOT by
// the d3-force pass, and ST-1 excludes them from the force residue pass. The
// agent/tool/file force-collide radii and the #2723 chain geometry are frozen.

/** Half of the widest chat (agent) node (540px max → 270px half). Matches the
 *  agent forceCollide radius used by the d3-force pass (see computeForceLayout)
 *  and the plan's `AGENT_NODE_HALF_WIDTH` constant name. #2743 AC-6: scaled
 *  180 → 270 with the ~1.5× node widths. */
export const AGENT_NODE_HALF_WIDTH = 270;

/** Full width of the widest chat (agent) node (ChatNode.tsx `maxWidth: 540`).
 *  The ToolsNode column sits just right of the WIDEST chat node so no chat
 *  node width can overlap it (NFR-3 — zero overlap by construction). */
export const AGENT_NODE_MAX_WIDTH = AGENT_NODE_HALF_WIDTH * 2;

/** Horizontal gap between a chat node's right edge and its ToolsNode's left
 *  edge (px). #2739 NFR-3 / UI-UX §4 — binding (TOOLS_GAP = 24). */
export const TOOLS_GAP = 24;

/** X coordinate of the ToolsNode column — the deterministic, chain-adjacent
 *  slot to the right of the chat chain:
 *  `CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH + TOOLS_GAP` (= 0 + 540 + 24 = 564).
 *  For a chain-anchored parent this equals `parent.x + parent.maxWidth +
 *  TOOLS_GAP` — the plan's "chatNode.x + chatNode.width + 24" equivalence.
 *  #2743 AC-6: recomputed from the scaled AGENT_NODE_MAX_WIDTH (360 → 540). */
export const TOOLS_CHAIN_X = CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH + TOOLS_GAP;

/**
 * Level map for layout-node types.
 *
 * The `tools` entry (the #2739 ToolsNode summary type — added to GraphNodeType
 * by ST-1) maps to the AGENT level: a ToolsNode can be up to 540px wide, so any
 * overlap check involving one uses the agent-node radius (270px — plan UI-UX §4
 * resolution). Legacy agent/subagent/tool/file levels are unchanged (frozen
 * #2723 geometry). NOTE: tools nodes are chain-owned and excluded from the
 * d3-force pass; this map is for ST-1's signature/overlap handling only.
 */
export const TYPE_TO_LEVEL: Record<string, number> = {
  agent: 1,
  subagent: 2,
  tool: 3,
  file: 4,
  tools: 1,
};

/** Resolve a layout-node type to its level. Unknown types fall back to the
 *  file level (4), mirroring computeForceLayout's fallback. */
export function layoutLevelForType(type: string | undefined): number {
  return type ? (TYPE_TO_LEVEL[type] ?? 4) : 4;
}

/**
 * A ToolsNode's chain identity: its own node id plus the chat node it
 * summarizes. ST-1 builds these entries when a chat node's exchange resolves
 * its first tool call (one ToolsNode per chat node).
 */
export interface ChainToolsNode {
  /** ToolsNode id — `tools-<corrId>` (plan API contract 4). */
  id: string;
  /** Parent chat node id — `agent-<corrId>` — the chat node this ToolsNode
   *  sits beside (the edge source for the `e-tools-<corrId>` edge). */
  parentId: string;
}

/**
 * Compute deterministic, chain-adjacent ToolsNode positions to the RIGHT of the
 * chat chain.
 *
 * Each ToolsNode sits at the ToolsNode column x (`TOOLS_CHAIN_X` — the widest
 * chat node's right edge + TOOLS_GAP) and at its parent chat node's own y, so
 * every ToolsNode is vertically aligned with the chat node it summarizes and
 * can never overlap the vertical chat chain (NFR-3). Pure and deterministic:
 * the same inputs always yield the same Map (no randomness, no mutation).
 *
 * @param tools - ToolsNode entries, each referencing its parent chat node.
 * @param parentPositions - The chat chain positions from
 *   `computeChatChainPositions` (parent id → { x, y }).
 * @returns A Map of ToolsNode id → { x, y } positions. Entries whose parent
 *   chat node has no chain position are skipped (no slot — ST-1 must not
 *   create a ToolsNode for a chat node without a chain slot).
 */
export function computeToolsChainPositions(
  tools: ChainToolsNode[],
  parentPositions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const tool of tools) {
    const parent = parentPositions.get(tool.parentId);
    if (!parent) continue;
    positions.set(tool.id, {
      x: parent.x + AGENT_NODE_MAX_WIDTH + TOOLS_GAP,
      y: parent.y,
    });
  }
  return positions;
}

// ── #2745 ST-4: deterministic SubagentNode companion column ─────────────────
//
// The rich SubagentNode lives in its OWN third column, right of the ToolsNode
// column (Architect A-5 — binding). A parent with BOTH tools and subagents
// never overlaps: chat chain x∈[0,540], ToolsNode column x∈[564,1104],
// subagent column x∈[1128,…]. The column x follows the same rule as the
// ToolsNode column: next column x = previous column's max node width + GAP.
//
// Subagent nodes are chain-owned exactly like ToolsNodes: placed by this pure
// geometry, NEVER by the d3-force pass, and excluded from the force residue
// pass (`useMissionMonitor.ts` skip list). Multi-subagent stacking stacks each
// dispatch BELOW the previous one at `index × (SUBAGENT_NODE_HEIGHT +
// CHAIN_GAP)` under the parent chat node's y (A-5).

/** X coordinate of the SubagentNode column — right of the ToolsNode column:
 *  `TOOLS_CHAIN_X + AGENT_NODE_MAX_WIDTH + TOOLS_GAP` (= 564 + 540 + 24 = 1128). */
export const SUBAGENT_CHAIN_X = TOOLS_CHAIN_X + AGENT_NODE_MAX_WIDTH + TOOLS_GAP;

/** Shared min width bound for the rich SubagentNode (AC-1: no component
 *  literals — the component consumes this shared constant). */
export const SUBAGENT_NODE_MIN_WIDTH = 420;

/** Shared max width bound for the rich SubagentNode (AC-1: no component
 *  literals). */
export const SUBAGENT_NODE_MAX_WIDTH = 540;

/** Conservative stacking height for a subagent node (px) — the A-5 stacking
 *  step (mirrors DEFAULT_NODE_HEIGHT's conservative role; a fresh node can
 *  never cover the dispatch below it). */
export const SUBAGENT_NODE_HEIGHT = 400;

/**
 * A SubagentNode's chain identity: its own node id, its parent chat node id,
 * and its DISPATCH index among the parent's subagents (0-based — the stacking
 * position below the parent: y = parent.y + index × (SUBAGENT_NODE_HEIGHT +
 * CHAIN_GAP)). ST-4 builds these entries from the collected task dispatches.
 */
export interface ChainSubagentNode {
  /** SubagentNode id — `subagent-<corrId>`. */
  id: string;
  /** Parent chat node id — `agent-<corrId>` — the chat node that dispatched it. */
  parentId: string;
  /** Dispatch order among the parent's subagents (0-based). */
  index: number;
}

/**
 * Compute deterministic SubagentNode positions in the subagent companion
 * column to the RIGHT of the ToolsNode column.
 *
 * Each SubagentNode sits at the subagent column x (`SUBAGENT_CHAIN_X`) and at
 * `parent.y + index × (SUBAGENT_NODE_HEIGHT + CHAIN_GAP)` — the k-th dispatch
 * of a parent stacks BELOW the previous ones, so multiple subagents of one
 * chat node never overlap each other (nor the chat chain or ToolsNode column —
 * by construction). Pure and deterministic: the same inputs always yield the
 * same Map.
 *
 * @param subagents - SubagentNode entries, each referencing its parent chat
 *   node + dispatch index.
 * @param parentPositions - The chat chain positions from
 *   `computeChatChainPositions` (parent id → { x, y }).
 * @returns A Map of SubagentNode id → { x, y } positions. Entries whose parent
 *   chat node has no chain position are skipped (no slot).
 */
export function computeSubagentChainPositions(
  subagents: ChainSubagentNode[],
  parentPositions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const subagent of subagents) {
    const parent = parentPositions.get(subagent.parentId);
    if (!parent) continue;
    positions.set(subagent.id, {
      x: SUBAGENT_CHAIN_X,
      y: parent.y + subagent.index * (SUBAGENT_NODE_HEIGHT + CHAIN_GAP),
    });
  }
  return positions;
}

/**
 * A positioned rectangle used by the belt-and-suspenders de-overlap pass.
 */
export interface RectNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Deterministic pairwise de-overlap for non-agent residue rectangles.
 *
 * Belt-and-suspenders for the d3-force residue (tool/file/subagent legacy
 * paths): after the force layout computes their positions, this pass pushes
 * any overlapping pair apart along the axis of least penetration (newest
 * node wins — later entries in the input array move). Deterministic and
 * bounded (no random jitter), so a graph rebuild yields stable positions.
 *
 * @param nodes - Positioned rectangles (center x/y with width/height).
 * @returns A Map of node id → resolved { x, y } positions.
 */
export function resolveRectOverlaps(nodes: RectNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    positions.set(n.id, { x: n.x, y: n.y });
  }
  if (nodes.length < 2) return positions;

  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const pa = positions.get(a.id)!;
        const pb = positions.get(b.id)!;
        const overlapX = (a.width + b.width) / 2 - Math.abs(pa.x - pb.x);
        const overlapY = (a.height + b.height) / 2 - Math.abs(pa.y - pb.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX < overlapY) {
          // Separate along X (axis of least penetration). Push b AWAY from a
          // — in the direction of b relative to a (+x when b is to the right).
          const dir = pa.x <= pb.x ? 1 : -1;
          pb.x += (overlapX + 1) * dir;
        } else {
          // Separate along Y — push b away from a (+y when b is below).
          const dir = pa.y <= pb.y ? 1 : -1;
          pb.y += (overlapY + 1) * dir;
        }
        moved = true;
      }
    }
    if (!moved) break;
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
 *   agent=270px, subagent=270px, tool=240px, file=210px.
 * - forceManyBody repels with per-node strength: agent -600,
 *   subagent -400, tool/file -300.
 * - forceCenter(0, 0) prevents drift to canvas edges.
 * - forceLink attracts connected nodes at 600px distance.
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
  // - forceLink: connected nodes attract at 600px distance (sufficient for 420-540px-wide nodes)
  // - forceCollide: level-based radii prevent overlap (agent=270, subagent=270, tool=240, file=210)
  // - charge: per-node strength based on level (agent=-600, subagent=-400, tool/file=-300)
  // - center: prevents drift to canvas edges while forceCollide+forceManyBody distribute nodes
  // - y: each depth layer has its own Y target (depth*400), with 0.1 strength
  //   to allow horizontal spread while maintaining vertical hierarchy
  const simulation = forceSimulation(simNodes)
    .alphaDecay(alphaDecay)
    .alphaMin(alphaMin)
    .force('link', forceLink(simLinks).distance(600))
    .force('charge', forceManyBody<SimNode>().strength((d) => {
      const lvl = resolveLevel(d);
      return lvl === 1 ? -600 : lvl === 2 ? -400 : -300;
    }))
    .force('collide', forceCollide<SimNode>().radius((d) => {
      const lvl = resolveLevel(d);
      // Collision radii match actual node dimensions (#2743 AC-6 — scaled 1.5×
      // with the wider nodes):
      //   agent:   max 540px wide → half-width 270px
      //   subagent: max 540px wide → half-width 270px
      //   tool:    max 480px wide → half-width 240px
      //   file:    max 420px wide → half-width 210px
      return lvl === 1 ? 270 : lvl === 2 ? 270 : lvl === 3 ? 240 : 210;
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
