/**
 * layout.ts — Force-directed layout for Mission Monitor graph.
 *
 * Uses d3-force to compute positions where connected nodes cluster closer.
 *
 * - forceCollide with level-based radii: agent 270px, subagent 270px, tool 240px, file 210px
 * - forceManyBody with per-node strength: agent -600, subagent -400, tool/file -300
 * - forceLink distance 600px for the ~1.5× wider nodes (420-540px)
 * - #2756: the LIVE Force-mode sim uses per-node forceX/forceY POSITIONING
 *   forces (one anchor pair per exchange — computeExchangeAnchors, the
 *   Bostock disjoint-force pattern) instead of forceCenter + the per-depth
 *   forceY, so each exchange drifts into its own blob inside the viewport.
 *   The synchronous computeForceLayout (Chain-mode residue) keeps the legacy
 *   center + depth forces (frozen — chain mode is byte-identical).
 * - Level-based initial positioning: agents in vertical column, non-agents offset horizontally
 * - Convergence within maxIterations (300) or alpha below threshold
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
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

// ── #2756 ST-2: per-exchange positioning anchors (true disjoint force layout) ─
//
// The Force branch feeds createLiveForceSimulation ONE (x, y) positioning
// target per EXCHANGE (Bostock's "Force-Directed Graph, Disjoint" pattern): an
// exchange — one chat node + its ToolsNode + its SubagentNodes — is a connected
// component of the exchange edge set, and computeExchangeAnchors assigns the
// whole component a single anchor arranged inside the framable viewport region.
// Weak positioning forces (FORCE_POSITION_STRENGTH) pull each cluster toward
// its anchor while link/charge/collide keep the organic feel. forceCenter is
// deliberately NOT used: it only recenters the centroid and cannot pull an
// individual blob back once it drifts out of view (REQ-3).

/** #2756 ST-2: strength of the per-exchange forceX/forceY positioning forces.
 *  Weak on purpose (≈ the default 0.1) — link/charge/collide dominate locally
 *  while the anchors keep each exchange's blob inside the viewport (REQ-3).
 *  Exported next to the chain constants (G-023 — never an inline literal). */
export const FORCE_POSITION_STRENGTH = 0.1;

/** #2756 ST-2 / round-3 (AC3): FALLBACK pane bounds used when the live pane
 *  size is not yet measured (zero/unknown). The LIVE Force path derives the
 *  anchor region from the REAL pane size measured in the canvas container
 *  (MissionMonitorPanel → useDeliveryGraph `viewportBounds`) — the fixed
 *  2400×1600 window is LARGER than the real pane (~1708×947.5 in round 2), so
 *  feeding it to computeExchangeAnchors placed anchors beyond the actual pane
 *  and settled clusters sat outside the viewport (the round-2 AC3 FAIL). This
 *  constant remains only as the safe in-pane fallback default. */
export const VIEWPORT_BOUNDS = { width: 2400, height: 1600 };

/**
 * #2756 ST-2 / round-3 (AC3): compute one bounded forceX/forceY target per EXCHANGE.
 *
 * An exchange = a connected component of the exchange edge set (chat→tools +
 * chat→subagent links; chat→chat edges are excluded upstream in the hook), so
 * each exchange drifts into its own blob. Components are discovered over the
 * nodes + edges input, ordered deterministically (sorted node ids), and each
 * component is assigned ONE anchor on a golden-angle spiral around the PANE
 * CENTER (the flow origin — fitView frames the graph centered on the pane) —
 * every node of the component pulls toward the same anchor, keeping the
 * cluster together AND inside the framable viewport (REQ-3).
 *
 * Round-3 pane-relative contract (the round-2 AC3 fix): the spiral is centered
 * at the flow origin (0, 0) — NOT at (bounds.width/2, bounds.height/2) — and
 * the outermost radius is clamped so EVERY anchor satisfies
 *   |x| ≤ bounds.width / 2  AND  |y| ≤ bounds.height / 2
 * (anchors inside the passed pane half-extents; the AC3 +100px slack stays
 * available for the cluster orbit around an anchor). The hook passes the REAL
 * measured pane size (falling back to VIEWPORT_BOUNDS while unmeasured); the
 * old fixed 2400×1600 region centered anchors ~350px right+down of where the
 * real pane is, so settled clusters landed outside the viewport.
 *
 * Pure + deterministic: the same inputs always yield the same anchors (no
 * randomness, no mutation) — ST-3 unit tests assert exactly that.
 *
 * @param nodes  - All layout nodes (every node is a sim body — REQ-1).
 * @param edges  - The exchange edge set (only exchange-internal edges).
 * @param bounds - The real pane bounds (width × height in canvas px).
 * @returns A Map of node id → its exchange's { x, y } anchor target.
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
    // Only exchange-internal edges whose BOTH endpoints are real nodes —
    // dangling edges (a tools/subagent node whose anchor chat is absent) are
    // skipped, so the isolated node is its own (single-node) exchange.
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
      adjacency.get(edge.target)!.push(edge.source);
    }
  }

  // Connected components in deterministic order (sorted node ids — the same
  // inputs always yield the same components → the same anchors).
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

  // Golden-angle spiral around the PANE CENTER = the flow origin (0,0): the
  // pane center after fitView frames the graph (the round-2 AC3 defect was the
  // spiral being centered at (bounds.width/2, bounds.height/2) — ~350px right
  // + down of the real pane — so clusters settled outside the viewport).
  // Component i sits at radius t × outermost (t = i/(N−1)) and angle
  // i × goldenAngle. The radius is clamped to the pane half-extents: an
  // adaptive orbit margin reserves room for a cluster's nodes (spread around
  // the anchor by link/charge/collide) so they stay inside the pane plus the
  // AC3 +100px slack. A fixed 400px margin would leave only ~74px of usable
  // radius in a ~950px-tall pane (cramming every exchange at the center), so
  // the margin scales down with the pane — larger panes still get the old
  // ~400px reservation.
  const maxRadius = Math.min(bounds.width, bounds.height) / 2;
  const orbitMargin = Math.min(400, Math.max(maxRadius * 0.5, 120));
  const outermost = Math.max(maxRadius - orbitMargin, 0);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const lastIndex = components.length - 1;
  components.forEach((component, i) => {
    const t = lastIndex === 0 ? 0 : i / lastIndex;
    const radius = outermost * t;
    const angle = i * goldenAngle;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    for (const nodeId of component) {
      anchors.set(nodeId, { x, y });
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

// ── #2752 ST-1: live force-simulation builder (Force layout mode) ─────────────
//
// Turns the dormant synchronous computeForceLayout into a live, rAF-driven,
// stoppable controller for the Force layout mode. The force recipe (link
// distance 600, per-level charge, collide 270/270/240/210) is copied
// unchanged from computeForceLayout (:516-535); #2756 replaces the center +
// hardcoded depth-Y forces with per-node forceX/forceY POSITIONING forces
// (one anchor pair per exchange — the disjoint pattern, ST-2). Deliberate
// differences from computeForceLayout:
//  - NO per-status fx/fy freezing (layout.ts:458/486-487) AND no #2754
//    `pinned` freezing — freeze-on-settled is the WHOLE-simulation stop when
//    alpha < alphaMin (EARS-3), so a fully-restored all-complete session
//    still animates on switch to Force and every node is a sim body (REQ-1).
//  - The loop is driven by the injected scheduleTick/cancelTick (default
//    window.requestAnimationFrame), and fresh-node seed placement uses the
//    injected `random` source (default Math.random) — deterministic in tests.

/** Layout mode for the Mission Monitor graph. */
export type LayoutMode = 'chain' | 'force';

/** Persisted-setting key for the layout mode — Fredo_mm_* pattern (same key
 *  family as `Fredo_mm_detail_panel_width`, DetailPanel.tsx:18). */
export const LAYOUT_MODE_KEY = 'Fredo_mm_layout_mode';

/** A node position in canvas coordinates. */
export interface NodePosition {
  x: number;
  y: number;
}

/** Options for createLiveForceSimulation. */
export interface LiveForceSimulationOptions {
  /** Seed positions (restart / mode-switch path). Used as a fallback for any
   *  node missing from the restart `seed` map. */
  existingPositions?: Map<string, NodePosition>;
  /** Settle threshold — the loop stops when simulation.alpha() < alphaMin.
   *  Default 0.01 (matches computeForceLayout, layout.ts:443). */
  alphaMin?: number;
  /** Alpha decay per tick. Default 0.02 (matches computeForceLayout, layout.ts:444). */
  alphaDecay?: number;
  /** #2756 ST-1/ST-2: positioning-force target X per node — the disjoint
   *  anchor pair (one per exchange, from computeExchangeAnchors in the hook).
   *  Replaces forceCenter(0,0): a weak forceX pulls every node toward its
   *  exchange's anchor so blobs stay inside the viewport (REQ-3). Default:
   *  () => 0 (a neutral center column — no depth bias). */
  forceX?: (node: LayoutNode) => number;
  /** Strength of the X positioning force. Default 0.1 (weak — link/charge/
   *  collide dominate locally). */
  forceXStrength?: number;
  /** #2756 ST-1: positioning-force target Y per node — the disjoint anchor
   *  pair's y. Replaces the #2754 per-depth forceY ((depth ?? 0) * 400).
   *  Default: () => 0. */
  forceY?: (node: LayoutNode) => number;
  /** Strength of the Y positioning force. Default 0.1. */
  forceYStrength?: number;
  /** Default true: when alpha < alphaMin the rAF loop stops and onSettled
   *  fires once (EARS-3). When false, the loop keeps ticking until stop(). */
  freezeOnSettled?: boolean;
  /** Per-frame callback with the latest positions (EARS-2). */
  onTick?: (positions: Map<string, NodePosition>) => void;
  /** Called once when the simulation freezes on settle. */
  onSettled?: (positions: Map<string, NodePosition>) => void;
  /** Frame scheduler — default window.requestAnimationFrame (test injection:
   *  jsdom has no rAF). */
  scheduleTick?: (cb: () => void) => number;
  /** Frame cancel — default window.cancelAnimationFrame. */
  cancelTick?: (handle: number) => void;
  /** Random source for fresh-node seed placement — default Math.random
   *  (layout.ts:474 uses Math.random; injection keeps tests deterministic). */
  random?: () => number;
  /** #2754 ST-1 (KEPT, re-scoped #2756): when true, rebuild() runs a bounded
   *  synchronous tick loop (computeForceLayout-style, capped at maxIterations)
   *  and fires onTick / onSettled ONCE with the final positions — never
   *  scheduling an rAF frame. The prefers-reduced-motion path (AC4 exception;
   *  mirrors the panel camera snap, MissionMonitorPanel.tsx:83-93 — G-059).
   *  #2756: re-scoped to the disjoint recipe — the pin semantics are gone, but
   *  the reduced-motion synchronous settle is correct a11y behavior. */
  snapToSettled?: boolean;
  /** #2754 ST-1: tick cap for the snapToSettled synchronous loop. Default 300
   *  (matches computeForceLayout maxIterations, layout.ts:443). Ignored on the
   *  default rAF path, which runs until alpha < alphaMin. */
  maxIterations?: number;
  /** #2756 round-4 (AC3): pane half-extent containment bounds (width × height
   *  in canvas px). When provided, the sim applies a BOUNDED PULL so settled
   *  clusters stay inside the pane: a wall force clamps every node to
   *  |x| ≤ width/2 AND |y| ≤ height/2 (zeroing outward velocity at the
   *  boundary), and every position read (onTick / onSettled / positions()) is
   *  projected into the same half-extents. The round-3 fix made the exchange
   *  anchors pane-relative but the SETTLED clusters still orbited far off them
   *  (link distance 600 + charge −600 + collide 270/270/240/210 dominate the
   *  weak 0.1 positioning force — observed live y=876/681 vs the 474px pane
   *  half-height); this is the guaranteed containment leg of AC3. Interior
   *  layout is untouched — link/charge/collide still shape each exchange's
   *  organic arrangement, the wall only engages at the boundary. The value may
   *  be a plain object or a getter (the hook passes a getter reading a ref, so
   *  a pane resize re-clamps without a sim rebuild). Default: no containment
   *  (behavior byte-identical to before). */
  containmentBounds?: { width: number; height: number } | (() => { width: number; height: number });
}

/** A live, stoppable d3-force simulation controller. */
export interface LiveForceSimulation {
  /** Begin the rAF loop (no-op when settled). */
  start(): void;
  /** Cancel the rAF loop and stop the simulation. */
  stop(): void;
  /** Rebuild the simulation from nodes/edges seeded by `seed` — pre-existing
   *  nodes keep their seeded positions, new nodes glide in (EARS-4). */
  restart(nodes: LayoutNode[], edges: LayoutEdge[], seed: Map<string, NodePosition>): void;
  /** True while the rAF loop is scheduled. */
  isRunning(): boolean;
  /** True once alpha < alphaMin has been reached (or the graph is empty). */
  isSettled(): boolean;
  /** Latest node positions (the initial seed before the first frame). */
  positions(): Map<string, NodePosition>;
}

/** Charge strength per level — copied from computeForceLayout (:520-523). */
function chargeForLevel(level: number): number {
  return level === 1 ? -600 : level === 2 ? -400 : -300;
}

/** Collision radius per level — copied from computeForceLayout (:524-533). */
function collideRadiusForLevel(level: number): number {
  return level === 1 ? 270 : level === 2 ? 270 : level === 3 ? 240 : 210;
}

/** Level for a layout node — mirrors computeForceLayout (:459, :506-507). */
function layoutLevel(node: LayoutNode): number {
  return node.level ?? (node.type === 'agent' ? 1 : node.type === 'subagent' ? 2 : node.type === 'tool' ? 3 : 4);
}

/**
 * Create a live d3-force simulation controller.
 *
 * The simulation is driven manually by the injected frame scheduler (default
 * window.requestAnimationFrame) — one d3 tick per frame — and stops when alpha
 * falls below alphaMin (freeze-on-settled, EARS-3). Initial placement mirrors
 * computeForceLayout (:456-488): an existing seed position wins, fresh agent
 * nodes stack in a staggered column, fresh non-agent nodes get a random
 * horizontal offset. The per-status fx/fy freezing of computeForceLayout is
 * deliberately DROPPED so every node (including complete/error) animates.
 */
export function createLiveForceSimulation(options: LiveForceSimulationOptions): LiveForceSimulation {
  const alphaMin = options.alphaMin ?? 0.01;
  const alphaDecay = options.alphaDecay ?? 0.02;
  const forceXTarget = options.forceX ?? (() => 0);
  const forceYTarget = options.forceY ?? (() => 0);
  const forceXStrength = options.forceXStrength ?? 0.1;
  const forceYStrength = options.forceYStrength ?? 0.1;
  const freezeOnSettled = options.freezeOnSettled ?? true;
  const scheduleTick = options.scheduleTick ?? ((cb: () => void) => window.requestAnimationFrame(cb));
  const cancelTick = options.cancelTick ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const random = options.random ?? Math.random;
  const existingPositions = options.existingPositions;
  const snapToSettled = options.snapToSettled ?? false;
  const maxIterations = options.maxIterations ?? 300;

  // #2756 round-4 (AC3): resolve the pane half-extent containment bounds fresh
  // on EVERY read. The hook passes a GETTER (`() => lastPaneBoundsRef.current`)
  // so a pane resize re-clamps without rebuilding the sim; a plain object is
  // resolved once per read (cheap — a 2-field object). A zero/absent bounds
  // disables containment (byte-identical pre-round-4 behavior).
  const resolveContainment = (): { maxX: number; maxY: number } | null => {
    const b = typeof options.containmentBounds === 'function'
      ? options.containmentBounds()
      : options.containmentBounds;
    if (!b || b.width <= 0 || b.height <= 0) return null;
    return { maxX: b.width / 2, maxY: b.height / 2 };
  };

  /** #2756 round-4 (AC3): project a position into the pane half-extents — the
   *  final-read clamp. Belt-and-suspenders with the wall force: even if a tick's
   *  integration momentarily carries a node past the wall (a final-tick
   *  overshoot — the 35-body stress case), the REPORTED position (which is what
   *  ReactFlow renders and the AC3 bound asserts) can never leave the pane. */
  const clampToPane = (x: number, y: number): { x: number; y: number } => {
    const c = resolveContainment();
    if (!c) return { x, y };
    return {
      x: Math.max(-c.maxX, Math.min(c.maxX, x)),
      y: Math.max(-c.maxY, Math.min(c.maxY, y)),
    };
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
      out.set(node.id, clampToPane(node.x ?? 0, node.y ?? 0));
    }
    return out;
  };

  const buildSimNodes = (nodes: LayoutNode[], seed: Map<string, NodePosition>): SimNode[] => {
    let agentIndex = 0;
    return nodes.map((n) => {
      const level = layoutLevel(n);
      const existing = seed.get(n.id) ?? existingPositions?.get(n.id);
      let x: number;
      let y: number;
      if (existing) {
        x = existing.x;
        y = existing.y;
      } else if (level === 1) {
        // Agent nodes: staggered vertical column with 200px y-spacing (:467-471).
        x = -100;
        y = -400 + agentIndex * 200;
        agentIndex++;
      } else {
        // Non-agent nodes: offset horizontally with random spread (:473-475).
        x = 200 + random() * 300;
        y = -400;
      }
      const simNode: SimNode = { id: n.id, status: n.status, depth: n.depth, type: n.type, level, x, y };
      // #2756: NO fx/fy pinning — every node participates in the simulation
      // (REQ-1: no node id is frozen at a deterministic position). The #2754
      // `pinned` mechanism (chat nodes fx/fy-frozen at chain slots) is removed;
      // per-status freezing was never carried into the live path (#2752).
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
      // Only links where both endpoints exist (:495-503).
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
        return; // no further frames — freeze-on-settled (EARS-3)
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
    // #2756 ST-1 force recipe: link distance 600, per-level charge, collide
    // 270/270/240/210 (unchanged — layout.ts:1006-1008 in the old numbering)
    // PLUS per-node forceX/forceY POSITIONING forces (one anchor pair per
    // exchange, provided by the hook) — the Bostock disjoint-force pattern.
    // forceCenter(0,0) and the per-depth forceY of #2754 are GONE: no center
    // pull, no chain-y band — every node drifts toward its exchange's anchor
    // so each exchange becomes its own blob inside the viewport (REQ-3).
    simulation = forceSimulation<SimNode, SimulationLinkDatum<SimNode>>(simNodes)
      // Disable d3's internal timer — the injected rAF loop drives the ticks.
      .stop()
      .alphaDecay(alphaDecay)
      .alphaMin(alphaMin)
      .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks).distance(600))
      .force('charge', forceManyBody<SimNode>().strength((d) => chargeForLevel(layoutLevel(d))))
      .force('collide', forceCollide<SimNode>().radius((d) => collideRadiusForLevel(layoutLevel(d))))
      .force('x', forceX<SimNode>().x((d) => forceXTarget(d)).strength(forceXStrength))
      .force('y', forceY<SimNode>().y((d) => forceYTarget(d)).strength(forceYStrength))
      .randomSource(random);

    // #2756 round-4 (AC3): the BOUNDED PULL — a wall force engaged at the pane
    // half-extents. The weak 0.1 positioning force alone cannot hold settled
    // clusters against link 600 / charge −600 / collide 270 (the round-3 FAIL:
    // live y=876/681 on a 474px half-height pane), so any node pushed past the
    // boundary is snapped back and its outward velocity cancelled. This shapes
    // the DYNAMICS (clusters settle ON the wall rather than oscillating against
    // it); the final-read clamp (clampToPane in readPositions) guarantees the
    // reported position — what ReactFlow renders and AC3 asserts — can never
    // leave the pane even on a final-tick integration overshoot.
    const containment = resolveContainment();
    if (containment) {
      simulation.force('contain', () => {
        for (const n of simNodes) {
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          if (x >= containment.maxX) { n.x = containment.maxX; if ((n.vx ?? 0) > 0) n.vx = 0; }
          else if (x <= -containment.maxX) { n.x = -containment.maxX; if ((n.vx ?? 0) < 0) n.vx = 0; }
          if (y >= containment.maxY) { n.y = containment.maxY; if ((n.vy ?? 0) > 0) n.vy = 0; }
          else if (y <= -containment.maxY) { n.y = -containment.maxY; if ((n.vy ?? 0) < 0) n.vy = 0; }
        }
      });
    }

    if (snapToSettled) {
      // #2754 ST-1 (re-scoped #2756): prefers-reduced-motion path — a bounded
      // SYNCHRONOUS settle of the disjoint recipe (computeForceLayout-style,
      // capped at maxIterations). No rAF frame is ever scheduled;
      // onTick/onSettled fire once with the final positions (G-059: snap is
      // the correct a11y behavior — pin semantics are gone, the snap remains).
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
