/**
 * layout.ts — Force-directed layout for Mission Monitor graph.
 *
 * Uses d3-force to compute positions where connected nodes cluster closer.
 *
 * - forceCollide with level-based radii: agent 270px, subagent 270px, tool 240px, file 210px
 * - forceManyBody with per-node strength: agent -600, subagent -400, tool/file -300
 * - forceLink distance 600px for the ~1.5× wider nodes (420-540px)
 * - #2758: Force-mode is Bostock-faithful disjoint — clusters arise from
 *   disconnected link components + many-body repulsion + single center,
 *   no per-exchange positioning magnets. See buildForceSimulation.
 * - Level-based initial positioning: agents in vertical column, non-agents offset horizontally
 * - Convergence within maxIterations (300) or alpha below threshold
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  type Simulation,
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
// The rich SubagentNode lives in its OWN column LEFT of the chat chain
// (human decision: subagents left, tools right). A parent with BOTH tools and
// subagents never overlaps: subagent column x∈[−1128,−564], chat chain
// x∈[0,540], ToolsNode column x∈[564,1104]. The column x follows the same
// rule as the ToolsNode column: next column x = previous column's max node
// width + GAP (mirrored on the negative side).
//
// Subagent nodes are chain-owned exactly like ToolsNodes: placed by this pure
// geometry, NEVER by the d3-force pass, and excluded from the force residue
// pass (`useMissionMonitor.ts` skip list). Multi-subagent stacking places each
// dispatch FURTHER LEFT of the previous one at `index × (SUBAGENT_NODE_MAX_WIDTH
// + SUBAGENT_GAP)` — all vertically aligned with the parent chat node's y (a
// subagent is a peer of its parent, sitting beside it to the left — it is NOT
// stacked below the parent).

/** X coordinate of the FIRST (leftmost-closest) SubagentNode column — LEFT of
 *  the chat chain: `CHAIN_X_CENTER − AGENT_NODE_MAX_WIDTH − TOOLS_GAP`
 *  (= 0 − 540 − 24 = −564). */
export const SUBAGENT_CHAIN_X = CHAIN_X_CENTER - AGENT_NODE_MAX_WIDTH - TOOLS_GAP;

/** Horizontal gap between consecutive SubagentNode columns (px) — each new
 *  subagent column steps further LEFT by the previous column's max node width
 *  + this gap (mirrors TOOLS_GAP on the negative side). */
export const SUBAGENT_GAP = 24;

/** Shared min width bound for the rich SubagentNode (AC-1: no component
 *  literals — the component consumes this shared constant). */
export const SUBAGENT_NODE_MIN_WIDTH = 420;

/** Shared max width bound for the rich SubagentNode (AC-1: no component
 *  literals). */
export const SUBAGENT_NODE_MAX_WIDTH = 540;

/** Conservative stacking height for a subagent node (px) — legacy A-5 vertical
 *  stacking constant, kept for backward-compatible tests/consumers. Horizontal
 *  stacking does NOT use it (see computeSubagentChainPositions). */
export const SUBAGENT_NODE_HEIGHT = 400;

/**
 * A SubagentNode's chain identity: its own node id, its parent chat node id,
 * and its DISPATCH index among the parent's subagents (0-based — the horizontal
 * stacking position LEFT of the parent: x = SUBAGENT_CHAIN_X − index ×
 * (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP), y = parent.y). ST-4 builds these
 * entries from the collected task dispatches.
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
 * column to the LEFT of the chat chain.
 *
 * Each SubagentNode sits at `SUBAGENT_CHAIN_X − index × (SUBAGENT_NODE_MAX_WIDTH
 * + SUBAGENT_GAP)` and at its PARENT chat node's OWN y — the k-th dispatch of a
 * parent sits one column FURTHER LEFT of the previous one (the subagent is a
 * left-side peer of its parent, never stacked below it). So multiple subagents
 * of one chat node never overlap each other (nor the chat chain or ToolsNode
 * column — by construction). Pure and deterministic: the same inputs always
 * yield the same Map.
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
      x: SUBAGENT_CHAIN_X - subagent.index * (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP),
      y: parent.y,
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
          const dir = pa.x <= pb.x ? 1 : -1;
          pb.x += (overlapX + 1) * dir;
        } else {
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

// ── #2756 ST-2: per-exchange positioning anchors (retained for import compat, deprecated #2758) ─
// The Force simulation no longer uses per-exchange anchors (Bostock-faithful).
// This function is kept exported so existing tests importing it do not break,
// but it is no longer wired into the Force layout.

/** #2756 ST-2: strength of the per-exchange positioning forces. Deprecated #2758. */
export const FORCE_POSITION_STRENGTH = 10;

/** #2756 round-11 (AC2): the LIVE sim's forceLink distance. Deprecated #2758. */
export const FORCE_LINK_DISTANCE = 440;

/** #2756 round-11 (AC2): scale factor for the LIVE sim's many-body charge. Deprecated #2758. */
export const FORCE_CHARGE_SCALE = 0.02;

/** #2756 round-11 (AC2): scale factor for the LIVE sim's collision radii. Deprecated #2758. */
export const FORCE_COLLIDE_SCALE = 0.7;

/** #2756 fallback pane bounds. Deprecated #2758. */
export const VIEWPORT_BOUNDS = { width: 2400, height: 1600 };

/** #2756 round-10 (AC2): how far the exchange-anchor ellipse sits inside the pane. Deprecated. */
export const ANCHOR_EDGE_MARGIN = 40;

/** #2756 round-11 (AC2): the 2-row anchor schedule's row Y fraction. Deprecated. */
export const ANCHOR_ROW_Y_FRACTION = 0.62;

/** #2756 round-11 (AC2): upper clamp for the anchor rows' |y|. Deprecated. */
export const ANCHOR_ROW_Y_MAX = 300;

/** #2756 round-11 (AC2): the anchor rows' horizontal span fraction. Deprecated. */
export const ANCHOR_ROW_SPAN_FRACTION = 0.8;

/**
 * #2756 ST-2 / round-3 (AC3): compute one bounded positioning target per EXCHANGE.
 * Deprecated #2758 — retained for import compat, no longer used by Force layout.
 */
export function computeExchangeAnchors(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  bounds: { width: number; height: number },
): Map<string, { x: number; y: number }> {
  const anchors = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return anchors;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
      adjacency.get(edge.target)!.push(edge.source);
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of [...nodeIds].sort()) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    component.sort();
    components.push(component);
  }

  if (components.length === 1) {
    for (const nodeId of components[0]) {
      anchors.set(nodeId, { x: 0, y: 0 });
    }
    return anchors;
  }

  const halfW = Math.max(bounds.width / 2 - ANCHOR_EDGE_MARGIN, 0);
  const halfH = Math.max(bounds.height / 2 - ANCHOR_EDGE_MARGIN, 0);
  const rowY = Math.min(halfH * ANCHOR_ROW_Y_FRACTION, ANCHOR_ROW_Y_MAX);
  const span = halfW * ANCHOR_ROW_SPAN_FRACTION;
  const topCount = Math.ceil(components.length / 2);
  const bottomCount = Math.floor(components.length / 2);
  const rowXs = (k: number, half: boolean): number[] => {
    if (k <= 1) return [0];
    const out: number[] = [];
    for (let i = 0; i < k; i++) {
      const x = -span + (2 * span * i) / (k - 1);
      out.push(half ? x / 2 : x);
    }
    return out;
  };
  const slots: Array<{ x: number; y: number }> = [];
  for (const x of rowXs(topCount, false)) slots.push({ x, y: -rowY });
  for (const x of rowXs(bottomCount, true)) slots.push({ x, y: rowY });
  components.forEach((component, i) => {
    const slot = slots[i] ?? { x: 0, y: 0 };
    for (const nodeId of component) {
      anchors.set(nodeId, { x: slot.x, y: slot.y });
    }
  });

  return anchors;
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

  let agentIndex = 0;
  const simNodes: SimNode[] = nodes.map((n) => {
    const isSettled = n.status === 'complete' || n.status === 'error';
    const level = n.level ?? (n.type === 'agent' ? 1 : n.type === 'subagent' ? 2 : n.type === 'tool' ? 3 : 4);
    const existing = existingPositions?.get(n.id);
    let x: number;
    let y: number;
    if (existing) {
      x = existing.x;
      y = existing.y;
    } else if (level === 1) {
      x = -100;
      y = -400 + agentIndex * 200;
      agentIndex++;
    } else {
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
      fx: isSettled ? x : undefined,
      fy: isSettled ? y : undefined,
    };
  });

  const nodeIndexMap = new Map<string, number>();
  simNodes.forEach((n, i) => nodeIndexMap.set(n.id, i));

  const simLinks: SimulationLinkDatum<SimNode>[] = [];
  for (const edge of edges) {
    const sourceIdx = nodeIndexMap.get(edge.source);
    const targetIdx = nodeIndexMap.get(edge.target);
    if (sourceIdx !== undefined && targetIdx !== undefined) {
      simLinks.push({ source: sourceIdx, target: targetIdx });
    }
  }

  const resolveLevel = (d: SimNode): number =>
    d.level ?? (d.type === 'agent' ? 1 : d.type === 'subagent' ? 2 : d.type === 'tool' ? 3 : 4);

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
      return lvl === 1 ? 270 : lvl === 2 ? 270 : lvl === 3 ? 240 : 210;
    }))
    .force('center', forceCenter(0, 0));

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

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of simNodes) {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }

  return { positions, converged, iterations };
}

// ── #2758 ST-1: Bostock-faithful disjoint force simulation ───────────────────
//
// Replaces per-exchange positioning magnets with Bostock recipe:
// forceLink(distance 30, strength 1) on disjoint edges + forceManyBody(-30)
// + single forceCenter(viewportW/2, viewportH/2) + optional forceCollide.
// Params from Bostock defaults: alpha 1, alphaDecay 0.0228, velocityDecay 0.4.
// Every Force node fx==null && fy==null. Bounded in viewport via center+collide
// only — no wall-clamping Math.max/Math.min.

/** Layout mode for the Mission Monitor graph. */
export type LayoutMode = 'chain' | 'force';

/** Persisted-setting key for the layout mode — Fredo_mm_* pattern. */
export const LAYOUT_MODE_KEY = 'Fredo_mm_layout_mode';

/** A node position in canvas coordinates. */
export interface NodePosition {
  x: number;
  y: number;
}

/** Options for buildForceSimulation / createLiveForceSimulation (Bostock). */
export interface LiveForceSimulationOptions {
  /** Seed positions (restart / mode-switch path). */
  existingPositions?: Map<string, NodePosition>;
  /** Settle threshold — default 0.001 (Bostock). */
  alphaMin?: number;
  /** Alpha decay per tick — default 0.0228 (Bostock). */
  alphaDecay?: number;
  /** Velocity decay — default 0.4 (Bostock). */
  velocityDecay?: number;
  /** Viewport width for forceCenter — default 800. Falls back to containmentBounds. */
  viewportWidth?: number;
  /** Viewport height for forceCenter — default 600. Falls back to containmentBounds. */
  viewportHeight?: number;
  /** Pane bounds (viewport) — alternative to viewportWidth/Height, may be getter. */
  containmentBounds?: { width: number; height: number } | (() => { width: number; height: number });
  /** Optional collide radius — default 10. */
  collideRadius?: number;
  /** Default true: when alpha < alphaMin the rAF loop stops and onSettled fires once. */
  freezeOnSettled?: boolean;
  /** Per-frame callback with the latest positions. */
  onTick?: (positions: Map<string, NodePosition>) => void;
  /** Called once when the simulation freezes on settle. */
  onSettled?: (positions: Map<string, NodePosition>) => void;
  /** Frame scheduler — default window.requestAnimationFrame. */
  scheduleTick?: (cb: () => void) => number;
  /** Frame cancel — default window.cancelAnimationFrame. */
  cancelTick?: (handle: number) => void;
  /** Random source for fresh-node seed placement — default Math.random. */
  random?: () => number;
  /** When true, rebuild() runs a bounded synchronous tick loop and fires once. */
  snapToSettled?: boolean;
  /** Tick cap for the snapToSettled synchronous loop. Default 300. */
  maxIterations?: number;
  /** @deprecated — use collideRadius */
  linkDistance?: number;
  /** @deprecated */
  chargeScale?: number;
  /** @deprecated */
  collideScale?: number;
}

/** A live, stoppable d3-force simulation controller. */
export interface LiveForceSimulation {
  /** Begin the rAF loop (no-op when settled). */
  start(): void;
  /** Cancel the rAF loop and stop the simulation. */
  stop(): void;
  /** Rebuild the simulation from nodes/edges seeded by `seed` — pre-existing
   *  nodes keep their seeded positions, new nodes glide in. */
  restart(nodes: LayoutNode[], edges: LayoutEdge[], seed: Map<string, NodePosition>): void;
  /** True while the rAF loop is scheduled. */
  isRunning(): boolean;
  /** True once alpha < alphaMin has been reached (or the graph is empty). */
  isSettled(): boolean;
  /** Latest node positions (the initial seed before the first frame). */
  positions(): Map<string, NodePosition>;
}

/**
 * Build a Bostock-faithful disjoint force simulation — synchronous version.
 * Used for snapshot tests and as the core of the live simulation.
 *
 * Bostock recipe: forceLink(disjoint edges, distance 30, strength 1) +
 * forceManyBody(-30) + forceCenter(viewportW/2, viewportH/2) + optional forceCollide.
 * Params: alpha 1, alphaDecay 0.0228, velocityDecay 0.4. Every node fx==null && fy==null.
 */
export function buildForceSimulation(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width: number,
  height: number,
  options?: { collideRadius?: number; iterations?: number },
): Map<string, NodePosition> {
  const w = width > 0 ? width : 800;
  const h = height > 0 ? height : 600;
  const collideR = options?.collideRadius ?? 10;
  const iterations = options?.iterations ?? 300;

  if (nodes.length === 0) return new Map();

  const simNodes: SimNode[] = nodes.map((n) => ({
    id: n.id,
    status: n.status,
    depth: n.depth,
    type: n.type,
    level: n.level ?? (n.type === 'agent' ? 1 : n.type === 'subagent' ? 2 : n.type === 'tool' ? 3 : 4),
    x: Math.random() * w,
    y: Math.random() * h,
    fx: null as unknown as number | undefined,
    fy: null as unknown as number | undefined,
  }));
  // Ensure fx/fy are null (Bostock: no pinning)
  for (const nd of simNodes) {
    (nd as any).fx = null;
    (nd as any).fy = null;
  }

  const nodeIndexMap = new Map<string, number>();
  simNodes.forEach((n, i) => nodeIndexMap.set(n.id, i));

  const simLinks: SimulationLinkDatum<SimNode>[] = [];
  for (const edge of edges) {
    const s = nodeIndexMap.get(edge.source);
    const t = nodeIndexMap.get(edge.target);
    if (s !== undefined && t !== undefined) {
      simLinks.push({ source: s, target: t });
    }
  }

  const sim = forceSimulation(simNodes)
    .alpha(1)
    .alphaDecay(0.0228)
    .velocityDecay(0.4)
    .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks).id((d: any) => d.id).distance(30).strength(1))
    .force('charge', forceManyBody<SimNode>().strength(-30))
    .force('center', forceCenter(w / 2, h / 2))
    .force('collide', forceCollide<SimNode>().radius(collideR));

  for (let i = 0; i < iterations; i++) {
    sim.tick();
    if (sim.alpha() < 0.001) break;
  }
  sim.stop();

  const out = new Map<string, NodePosition>();
  for (const n of simNodes) {
    const x = n.x ?? w / 2;
    const y = n.y ?? h / 2;
    out.set(n.id, { x, y });
  }
  return out;
}

/**
 * Create a live Bostock-faithful d3-force simulation controller.
 *
 * Bostock recipe only: link(30,1) + manyBody(-30) + center(W/2,H/2) + collide.
 * No per-exchange positioning magnets, no wall-clamping, no fx/fy pinning.
 * Every node fx==null && fy==null throughout.
 */
export function createLiveForceSimulation(options: LiveForceSimulationOptions): LiveForceSimulation {
  const alphaMin = options.alphaMin ?? 0.001;
  const alphaDecay = options.alphaDecay ?? 0.0228;
  const velocityDecay = options.velocityDecay ?? 0.4;
  const collideRadius = options.collideRadius ?? 10;
  const freezeOnSettled = options.freezeOnSettled ?? true;
  const scheduleTick = options.scheduleTick ?? ((cb: () => void) => window.requestAnimationFrame(cb));
  const cancelTick = options.cancelTick ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const random = options.random ?? Math.random;
  const existingPositions = options.existingPositions;
  const snapToSettled = options.snapToSettled ?? false;
  const maxIterations = options.maxIterations ?? 300;

  const resolveViewport = (): { w: number; h: number } => {
    const b = typeof options.containmentBounds === 'function'
      ? options.containmentBounds()
      : options.containmentBounds;
    if (b && b.width > 0 && b.height > 0) return { w: b.width, h: b.height };
    const w = options.viewportWidth ?? 800;
    const h = options.viewportHeight ?? 600;
    return { w: w > 0 ? w : 800, h: h > 0 ? h : 600 };
  };

  let simulation: Simulation<SimNode, SimulationLinkDatum<SimNode>> | null = null;
  let simNodes: SimNode[] = [];
  let positions = new Map<string, NodePosition>();
  let tickHandle: number | null = null;
  let running = false;
  let settled = true;
  let settledFired = false;

  const readPositions = (): Map<string, NodePosition> => {
    const out = new Map<string, NodePosition>();
    for (const node of simNodes) {
      out.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
    }
    return out;
  };

  const buildSimNodes = (nodes: LayoutNode[], seed: Map<string, NodePosition>): SimNode[] => {
    let agentIndex = 0;
    return nodes.map((n) => {
      const level = n.level ?? (n.type === 'agent' ? 1 : n.type === 'subagent' ? 2 : n.type === 'tool' ? 3 : 4);
      const existing = seed.get(n.id) ?? existingPositions?.get(n.id);
      let x: number;
      let y: number;
      if (existing) {
        x = existing.x;
        y = existing.y;
      } else if (level === 1) {
        x = -100;
        y = -400 + agentIndex * 200;
        agentIndex++;
      } else {
        x = 200 + random() * 300;
        y = -400;
      }
      const simNode: SimNode = { id: n.id, status: n.status, depth: n.depth, type: n.type, level, x, y };
      (simNode as any).fx = null;
      (simNode as any).fy = null;
      return simNode;
    });
  };

  const buildSimLinks = (edges: LayoutEdge[]): SimulationLinkDatum<SimNode>[] => {
    const nodeIndexMap = new Map<string, number>();
    simNodes.forEach((n, i) => nodeIndexMap.set(n.id, i));
    const simLinks: SimulationLinkDatum<SimNode>[] = [];
    for (const edge of edges) {
      const sourceIdx = nodeIndexMap.get(edge.source);
      const targetIdx = nodeIndexMap.get(edge.target);
      if (sourceIdx !== undefined && targetIdx !== undefined) {
        simLinks.push({ source: sourceIdx, target: targetIdx });
      }
    }
    return simLinks;
  };

  const tick = (): void => {
    tickHandle = null;
    simulation?.tick();
    positions = readPositions();
    options.onTick?.(positions);
    if (simulation && simulation.alpha() < alphaMin) {
      settled = true;
      if (freezeOnSettled) {
        simulation.stop();
        running = false;
        if (!settledFired) {
          settledFired = true;
          options.onSettled?.(positions);
        }
        return;
      }
    }
    scheduleFrame();
  };

  const scheduleFrame = (): void => {
    if (!running) return;
    if (freezeOnSettled && settled) return;
    tickHandle = scheduleTick(tick);
  };

  const cancelLoop = (): void => {
    if (tickHandle !== null) {
      cancelTick(tickHandle);
      tickHandle = null;
    }
  };

  const rebuild = (nodes: LayoutNode[], edges: LayoutEdge[], seed: Map<string, NodePosition>): void => {
    cancelLoop();
    simNodes = buildSimNodes(nodes, seed);
    positions = readPositions();
    settledFired = false;

    if (simNodes.length === 0) {
      simulation?.stop();
      simulation = null;
      running = false;
      settled = true;
      if (freezeOnSettled) {
        settledFired = true;
        options.onSettled?.(positions);
      }
      return;
    }

    const simLinks = buildSimLinks(edges);
    const { w, h } = resolveViewport();

    // Bostock-faithful: link(30,1) + manyBody(-30) + center(W/2,H/2) + collide
    simulation = forceSimulation<SimNode, SimulationLinkDatum<SimNode>>(simNodes)
      .stop()
      .alpha(1)
      .alphaDecay(alphaDecay)
      .velocityDecay(velocityDecay)
      .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks).id((d: any) => d.id).distance(30).strength(1))
      .force('charge', forceManyBody<SimNode>().strength(-30))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collide', forceCollide<SimNode>().radius(collideRadius))
      .randomSource(random);

    // Ensure no fx/fy pinning — every node fx==null && fy==null
    for (const n of simNodes) {
      (n as any).fx = null;
      (n as any).fy = null;
    }

    if (snapToSettled) {
      for (let i = 0; i < maxIterations; i++) {
        simulation.tick();
        if (simulation.alpha() < alphaMin) {
          break;
        }
      }
      simulation.stop();
      positions = readPositions();
      options.onTick?.(positions);
      settled = true;
      running = false;
      settledFired = true;
      options.onSettled?.(positions);
      return;
    }

    settled = false;
    running = true;
    scheduleFrame();
  };

  return {
    start(): void {
      if (running) return;
      if (freezeOnSettled && settled) return;
      running = true;
      scheduleFrame();
    },
    stop(): void {
      cancelLoop();
      simulation?.stop();
      running = false;
    },
    restart(nodes: LayoutNode[], edges: LayoutEdge[], seed: Map<string, NodePosition>): void {
      rebuild(nodes, edges, seed);
    },
    isRunning(): boolean {
      return running;
    },
    isSettled(): boolean {
      return settled;
    },
    positions(): Map<string, NodePosition> {
      return positions;
    },
  };
}
