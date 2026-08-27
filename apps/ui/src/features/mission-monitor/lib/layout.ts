/**
 * layout.ts — Mission Monitor graph geometry.
 *
 * Two concerns:
 * - Deterministic chain geometry (#2688/#2723/#2739/#2745): the vertical chat
 *   chain plus its ToolsNode (right) and SubagentNode (left) companion columns.
 *   Pure closed-form math — no randomness, no simulation.
 * - The d3-force residue pass (`computeForceLayout`): the frozen Chain-mode
 *   position source for non-agent residue nodes before the chain geometry
 *   overrides the agents. Part of the frozen Chain output — do not remove.
 *
 * The #2752/#2756/#2758 Force MODE (live simulation, layout-mode toggle,
 * persisted `Fredo_mm_layout_mode` preference, per-exchange anchors) was
 * removed by #2760 — Chain is the only layout.
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

// ── #2745 ST-4 / #2762 ST-4: deterministic SubagentNode companion columns ───
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
// pass (`useMissionMonitor.ts` skip list).
//
// #2762 ST-4 — recursive SUBTREE-BAND allocation: nesting (a subagent's own
// dispatched subagents) extends the same companion-column grammar one lane
// further left per level (D-1a), with the lanes allocated as per-parent BANDS
// so two sibling branches can never share an x-lane (lane-conflation risk in
// the plan's Risks section). Each child subtree's lane count is computed
// recursively (spanOf); siblings are walked left-to-right in dispatch-index
// order, each occupying a disjoint lane range; a node sits at the FIRST
// (rightmost/nearest-to-parent) lane of its own band. With flat (lane-width-1)
// subtrees the walk degenerates EXACTLY to today's closed form
// `SUBAGENT_CHAIN_X − index × (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP)` —
// R-7 flat parity is pinned by layout.chain-parity.test.ts.
//
// Vertical: Option B (D-1c-3) — an L1 SubagentNode aligns with its parent
// chat node's y; each deeper nesting level offsets DOWN by LEVEL_INDENT_Y
// (L2 = L1.y + 24, L3 = L2.y + 24, …), a deterministic closed-form slot.

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

/** #2762 ST-4 (D-1c-3 Option B): vertical downward indent per nesting level
 *  BELOW level 1 (px). An L1 SubagentNode (child of a chat node) aligns with
 *  its parent chat node's y; each deeper level offsets down by this amount
 *  (L2 = L1.y + 24, L3 = L2.y + 24, …) — a subtle deterministic staircase
 *  that makes "belongs to the one above-right" preattentive without changing
 *  any flat-session geometry (flat sessions never reach depth 2). */
export const LEVEL_INDENT_Y = 24;

/**
 * A SubagentNode's chain identity: its own node id, its parent node id, and
 * its DISPATCH index among the parent's subagents (0-based — the horizontal
 * stacking position LEFT of the parent).
 *
 * #2762 ST-4: `parentId` is the parent CHAT node id (`agent-<corrId>`) for
 * level-1 dispatches, or the parent SUBAGENT node id (`subagent-<corrId>`) for
 * nested dispatches — the same entry shape expresses the delegation tree at
 * any depth. ST-4 builds these entries from the collected task dispatches.
 */
export interface ChainSubagentNode {
  /** SubagentNode id — `subagent-<corrId>`. */
  id: string;
  /** Parent chat node id (`agent-<corrId>`) or parent SubagentNode id
   *  (`subagent-<corrId>`) — the node this dispatch hangs off. */
  parentId: string;
  /** Dispatch order among the parent's subagents (0-based). */
  index: number;
}

/** Lane step between adjacent SubagentNode columns (px) — the frozen #2745
 *  rule: each lane steps further LEFT by the previous column's max node width
 *  + SUBAGENT_GAP. */
const SUBAGENT_LANE_STEP = SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP;

/**
 * Compute deterministic SubagentNode positions in the subagent companion
 * columns to the LEFT of the chat chain — recursively, for delegation trees
 * of any depth (#2762 ST-4 subtree-band allocation).
 *
 * Horizontal grammar (per parent — a chat node OR a deeper-level subagent):
 * each child subtree's lane count is computed recursively (`spanOf`); the
 * siblings are walked LEFT-to-RIGHT in dispatch-index order, each occupying a
 * disjoint lane range, and a node sits at the FIRST lane of its own band (the
 * one nearest its parent). Sibling branches therefore NEVER share an x-lane
 * (no lane conflation at 3+ levels), and with flat (width-1) subtrees the walk
 * degenerates exactly to the frozen closed form
 * `SUBAGENT_CHAIN_X − index × (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP)` for
 * level-1 dispatches and `x_parent − (index + 1) × (…)` for nested ones
 * (D-1a). Level-1 slots are anchored at the absolute SUBAGENT_CHAIN_X (the
 * frozen #2745 rule — independent of the parent chat node's x); nested slots
 * are anchored at the parent SubagentNode's own x.
 *
 * Vertical grammar (Option B, D-1c-3): a level-1 node mirrors its parent chat
 * node's y; each deeper level offsets DOWN by LEVEL_INDENT_Y from its parent
 * SubagentNode's y.
 *
 * Pure and deterministic: the same inputs always yield the same Map. Entries
 * whose parent has no resolvable position are skipped (no slot) — an orphaned
 * parent skips its whole subtree. Parent-link cycles are terminated by a
 * visited guard (cyclic entries get no position; the acyclic remainder still
 * renders).
 *
 * @param subagents - SubagentNode entries, each referencing its parent node
 *   id + dispatch index (flat and nested entries together — the tree is the
 *   parent-id relation over this array).
 * @param parentPositions - Positions of the ROOT parents from
 *   `computeChatChainPositions` (chat node id → { x, y }). Nested parent
 *   positions are resolved by this function itself.
 * @returns A Map of SubagentNode id → { x, y } positions.
 */
export function computeSubagentChainPositions(
  subagents: ChainSubagentNode[],
  parentPositions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (subagents.length === 0) return positions;

  // Children grouped by parent; sibling lists sorted by dispatch index so the
  // band walk is input-order-independent (deterministic).
  const childIds = new Set<string>(subagents.map((s) => s.id));
  const childrenByParent = new Map<string, ChainSubagentNode[]>();
  for (const s of subagents) {
    const list = childrenByParent.get(s.parentId) ?? [];
    list.push(s);
    childrenByParent.set(s.parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.index - b.index);
  }

  // Subtree lane width (spanOf): 1 (the node's own lane) + Σ child subtree
  // widths, memoized. A visited guard terminates parent-link cycles by
  // treating the cyclic node as a leaf (the cycle gets no position below).
  const spanMemo = new Map<string, number>();
  const spanning = new Set<string>();
  const spanOf = (id: string): number => {
    const memo = spanMemo.get(id);
    if (memo !== undefined) return memo;
    if (spanning.has(id)) return 1;
    spanning.add(id);
    let width = 1;
    for (const child of childrenByParent.get(id) ?? []) {
      width += spanOf(child.id);
    }
    spanning.delete(id);
    spanMemo.set(id, width);
    return width;
  };

  /**
   * Place one entry under its parent anchor, then recurse into its subtree.
   * `laneBase` = the first lane a child may occupy relative to the anchor
   * (0 for chat-anchored roots at the absolute SUBAGENT_CHAIN_X; 1 for
   * nested parents — one lane left of the parent SubagentNode).
   */
  const place = (
    entry: ChainSubagentNode,
    anchorX: number,
    parentY: number,
    laneBase: number,
    isNested: boolean,
  ): void => {
    // Walk the (index-sorted) sibling list, granting each subtree a disjoint
    // lane range. `lane = max(laneBase + index, firstFree)` makes a flat
    // sibling list land EXACTLY on the frozen closed form (lane == index for
    // roots) while a wider earlier subtree pushes later siblings past it.
    const siblings = childrenByParent.get(entry.parentId) ?? [entry];
    let firstFree = laneBase;
    let lane = laneBase;
    for (const sib of siblings) {
      lane = Math.max(laneBase + sib.index, firstFree);
      firstFree = lane + spanOf(sib.id);
      if (sib.id === entry.id) break;
    }
    const pos = {
      x: anchorX - lane * SUBAGENT_LANE_STEP,
      y: parentY + (isNested ? LEVEL_INDENT_Y : 0),
    };
    positions.set(entry.id, pos);
    for (const child of childrenByParent.get(entry.id) ?? []) {
      place(child, pos.x, pos.y, 1, true);
    }
  };

  // Place every entry whose parent is an external ROOT with a chain position
  // (a chat node). Nested subtrees are placed by the recursion above; entries
  // whose parent is neither a positioned root nor a placeable subagent are
  // skipped (no slot — mirrors the historical orphan rule).
  for (const s of subagents) {
    if (!childIds.has(s.parentId) && parentPositions.has(s.parentId)) {
      const parent = parentPositions.get(s.parentId)!;
      place(s, SUBAGENT_CHAIN_X, parent.y, 0, false);
    }
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

