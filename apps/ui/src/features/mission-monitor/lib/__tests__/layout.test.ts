/**
 * Tests for force-directed layout algorithm — collision-aware behavior.
 *
 * Validates that the layout produces non-overlapping, level-aware
 * positions for all node types in the Mission Monitor graph.
 *
 * These tests validate the collision force (forceCollide), per-type
 * charge strengths, and layout stability behaviors added by Capsule A.
 * They use the `type` field on LayoutNode for level derivation.
 */
import { describe, it, expect } from 'vitest';
import {
  computeForceLayout,
  computeChatChainPositions,
  computeSubagentChainPositions,
  resolveRectOverlaps,
  CHAIN_GAP,
  CHAIN_TOP_Y,
  CHAIN_X_CENTER,
  DEFAULT_NODE_HEIGHT,
  AGENT_NODE_HALF_WIDTH,
  AGENT_NODE_MAX_WIDTH,
  COMPANION_GAP,
  SUBAGENT_CHAIN_X,
  SUBAGENT_GAP,
  SUBAGENT_NODE_HEIGHT,
  SUBAGENT_NODE_MAX_WIDTH,
  NESTED_TIER_INDENT_Y,
  SUBAGENT_CARD_FALLBACK_HEIGHT,
  computeCompanionExtents,
  layoutLevelForType,
  TYPE_TO_LEVEL,
} from '../layout';
import type { LayoutNode, LayoutEdge, RectNode, ChainSubagentNode } from '../layout';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Euclidean distance between two points. */
function distance(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): number {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
}

/** Distance from a point to the origin (0,0). */
function distanceFromOrigin(p: { x: number; y: number }): number {
  return distance(p, { x: 0, y: 0 });
}

// ── Collision Avoidance ─────────────────────────────────────────────────────

describe('collision avoidance', () => {
  it('separates two agent nodes at same position by at least 540px', () => {
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
    ];
    const edges: LayoutEdge[] = [{ source: 'agent-1', target: 'agent-2' }];

    // Both nodes start at the same position (0,0) via existing positions
    const existingPositions = new Map([
      ['agent-1', { x: 0, y: 0 }],
      ['agent-2', { x: 0, y: 0 }],
    ]);

    const { positions } = computeForceLayout(nodes, edges, {
      existingPositions,
    });

    const p1 = positions.get('agent-1')!;
    const p2 = positions.get('agent-2')!;
    const dist = distance(p1, p2);

    // Agent collision radius = 270px (#2743 AC-6: scaled from 180 with the
    // wider nodes), so minimum center-to-center separation is 2 × 270px =
    // 540px (non-overlapping circles)
    expect(dist).toBeGreaterThanOrEqual(540);
  });
});

// ── Level-Based Collision Radii ─────────────────────────────────────────────

describe('level-based collision radii', () => {
  it('agent pairs separate more than file pairs at same starting distance', () => {
    // Two agents (charge -600, radius 270) at 50px apart — no edge between them
    const agentNodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
    ];
    const agentStart = new Map([
      ['agent-1', { x: 0, y: 0 }],
      ['agent-2', { x: 50, y: 0 }],
    ]);
    const agentResult = computeForceLayout(agentNodes, [], {
      existingPositions: agentStart,
    });
    const agentDist = distance(
      agentResult.positions.get('agent-1')!,
      agentResult.positions.get('agent-2')!,
    );

    // Two files (charge -300, radius 210) at 50px apart — no edge between them
    const fileNodes: LayoutNode[] = [
      { id: 'file-1', status: 'in-progress', type: 'file', depth: 0 },
      { id: 'file-2', status: 'in-progress', type: 'file', depth: 0 },
    ];
    const fileStart = new Map([
      ['file-1', { x: 0, y: 0 }],
      ['file-2', { x: 50, y: 0 }],
    ]);
    const fileResult = computeForceLayout(fileNodes, [], {
      existingPositions: fileStart,
    });
    const fileDist = distance(
      fileResult.positions.get('file-1')!,
      fileResult.positions.get('file-2')!,
    );

    // Agents (-600 charge, 270px radius) should repel more strongly than
    // files (-300 charge, 210px radius), resulting in a greater center-to-center
    // separation distance. Both pairs have the same initial separation and depth,
    // so the difference is purely due to level-based charge and collision radius.
    expect(agentDist).toBeGreaterThan(fileDist);
  });

  it('all four node types get distinct positions when placed at origin', () => {
    // One node of each type at the same position — the layout should
    // separate all four with type-aware collision radii and charges
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'subagent-1', status: 'in-progress', type: 'subagent', depth: 0 },
      { id: 'tool-1', status: 'in-progress', type: 'tool', depth: 0 },
      { id: 'file-1', status: 'in-progress', type: 'file', depth: 0 },
    ];

    const existingPositions = new Map([
      ['agent-1', { x: 0, y: 0 }],
      ['subagent-1', { x: 0, y: 0 }],
      ['tool-1', { x: 0, y: 0 }],
      ['file-1', { x: 0, y: 0 }],
    ]);

    const { positions } = computeForceLayout(nodes, [], {
      existingPositions,
    });

    // Collect all resulting positions as a set of coordinate strings
    const positionSet = new Set<string>();
    for (const node of nodes) {
      const pos = positions.get(node.id)!;
      positionSet.add(`${pos.x.toFixed(2)},${pos.y.toFixed(2)}`);
    }

    // All 4 nodes should have distinct positions — none overlap
    expect(positionSet.size).toBe(4);
  });
});

// ── Level-Based Charge ───────────────────────────────────────────────────────

describe('level-based charge', () => {
  it('agent pairs separate more than tool pairs at same starting distance', () => {
    // Two agents (charge -600) at 50px apart — no edge between them
    const agentNodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
    ];
    const agentStart = new Map([
      ['agent-1', { x: 0, y: 0 }],
      ['agent-2', { x: 50, y: 0 }],
    ]);
    const agentResult = computeForceLayout(agentNodes, [], {
      existingPositions: agentStart,
    });
    const agentDist = distance(
      agentResult.positions.get('agent-1')!,
      agentResult.positions.get('agent-2')!,
    );

    // Two tools (charge -300) at 50px apart — no edge between them
    const toolNodes: LayoutNode[] = [
      { id: 'tool-1', status: 'in-progress', type: 'tool', depth: 0 },
      { id: 'tool-2', status: 'in-progress', type: 'tool', depth: 0 },
    ];
    const toolStart = new Map([
      ['tool-1', { x: 0, y: 0 }],
      ['tool-2', { x: 50, y: 0 }],
    ]);
    const toolResult = computeForceLayout(toolNodes, [], {
      existingPositions: toolStart,
    });
    const toolDist = distance(
      toolResult.positions.get('tool-1')!,
      toolResult.positions.get('tool-2')!,
    );

    // Agents (-600 charge) should repel more strongly than tools (-300 charge),
    // resulting in a greater center-to-center distance
    expect(agentDist).toBeGreaterThan(toolDist);
  });
});

// ── Settled Nodes Preserved ──────────────────────────────────────────────────

describe('settled nodes preserved', () => {
  it('complete node keeps its position after layout', () => {
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'complete', type: 'agent', depth: 0 },
    ];

    const existingPositions = new Map([
      ['agent-1', { x: 100, y: 100 }],
    ]);

    const { positions } = computeForceLayout(nodes, [], {
      existingPositions,
    });

    const pos = positions.get('agent-1')!;
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(100);
  });

  it('error node keeps its position after layout', () => {
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'error', type: 'agent', depth: 0 },
    ];

    const existingPositions = new Map([
      ['agent-1', { x: -200, y: 150 }],
    ]);

    const { positions } = computeForceLayout(nodes, [], {
      existingPositions,
    });

    const pos = positions.get('agent-1')!;
    expect(pos.x).toBe(-200);
    expect(pos.y).toBe(150);
  });

  it('in-progress node is not frozen and can move', () => {
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
    ];

    const existingPositions = new Map([
      ['agent-1', { x: 100, y: 100 }],
    ]);

    const { positions } = computeForceLayout(nodes, [], {
      existingPositions,
    });

    const pos = positions.get('agent-1')!;
    // An in-progress node with no other nodes has only forceY pulling it
    // to depth 0 → y≈0. So y should no longer be 100.
    // The exact position depends on simulation, but it must have moved
    // (fx/fy not set, so it's free to move)
    const posChanged = pos.x !== 100 || pos.y !== 100;
    expect(posChanged).toBe(true);
  });
});

// ── Multi-Agent Graph ────────────────────────────────────────────────────────

describe('multi-agent graph', () => {
  it('produces distinct positions for all nodes in a session graph', () => {
    // Exact structure: 1 agent + 3 subagents, all connected via parent edges
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'subagent-1', status: 'in-progress', type: 'subagent', depth: 1 },
      { id: 'subagent-2', status: 'in-progress', type: 'subagent', depth: 1 },
      { id: 'subagent-3', status: 'in-progress', type: 'subagent', depth: 1 },
    ];

    const edges: LayoutEdge[] = [
      { source: 'agent-1', target: 'subagent-1' },
      { source: 'agent-1', target: 'subagent-2' },
      { source: 'agent-1', target: 'subagent-3' },
    ];

    // All subagents start at the same position relative to the agent
    // to make the test deterministic
    const existingPositions = new Map([
      ['agent-1', { x: 0, y: 0 }],
      ['subagent-1', { x: 0, y: 0 }],
      ['subagent-2', { x: 0, y: 0 }],
      ['subagent-3', { x: 0, y: 0 }],
    ]);

    const { positions } = computeForceLayout(nodes, edges, {
      existingPositions,
    });

    // Collect all resulting positions as a set of coordinate strings
    const positionSet = new Set<string>();
    for (const node of nodes) {
      const pos = positions.get(node.id)!;
      positionSet.add(`${pos.x.toFixed(2)},${pos.y.toFixed(2)}`);
    }

    // All 4 nodes should be at distinct XY positions — none overlapping
    // (forceCollide prevents overlap, forceLink separates connected pairs,
    //  and forceY creates vertical hierarchy between depths)
    expect(positionSet.size).toBe(4);
  });
});

// ── #2688 ST4 / #2723 ST4: deterministic vertical chat chain ─────────────────
// #2723 ST4 (R-4): the chain stacks by MEASURED height —
// y_next = y_prev + (prev.height ?? DEFAULT_NODE_HEIGHT) + CHAIN_GAP — so a
// content node with a full response box never overlaps the node beneath it.
// Unmeasured fresh nodes fall back to DEFAULT_NODE_HEIGHT (conservative 320px).

describe('computeChatChainPositions (#2688 ST4 / #2723 ST4)', () => {
  it('stacks chat nodes top-to-bottom (oldest at the top) for a single session', () => {
    const positions = computeChatChainPositions([
      { id: 'agent-1', sessionId: 's1' }, // oldest
      { id: 'agent-2', sessionId: 's1' },
      { id: 'agent-3', sessionId: 's1' }, // newest
    ]);

    const p1 = positions.get('agent-1')!;
    const p2 = positions.get('agent-2')!;
    const p3 = positions.get('agent-3')!;

    // Oldest (agent-1) on top (y = CHAIN_TOP_Y), newest (agent-3) at the bottom.
    expect(p1.y).toBe(CHAIN_TOP_Y);
    expect(p1.y).toBeLessThan(p2.y);
    expect(p2.y).toBeLessThan(p3.y);
    // Unmeasured nodes use the conservative DEFAULT_NODE_HEIGHT fallback.
    expect(p2.y - p1.y).toBe(DEFAULT_NODE_HEIGHT + CHAIN_GAP);
    expect(p3.y - p2.y).toBe(DEFAULT_NODE_HEIGHT + CHAIN_GAP);
    // X centered.
    expect(p1.x).toBe(0);
    expect(p2.x).toBe(0);
    expect(p3.x).toBe(0);
  });

  it('gives every session its own independent chain', () => {
    const positions = computeChatChainPositions([
      { id: 'agent-1', sessionId: 's1' },
      { id: 'agent-2', sessionId: 's1' },
      { id: 'agent-b1', sessionId: 's2' },
    ]);

    // Session 1: oldest (agent-1) above newest (agent-2).
    expect(positions.get('agent-1')!.y).toBeLessThan(positions.get('agent-2')!.y);
    // Session 2 is an independent chain — its only node sits at the top.
    expect(positions.get('agent-b1')!.y).toBe(0);
  });

  it('#2723 ST4: stacks by MEASURED height — a taller node pushes its successor down', () => {
    const positions = computeChatChainPositions([
      { id: 'agent-1', sessionId: 's1', height: 200 }, // measured 200px
      { id: 'agent-2', sessionId: 's1', height: 400 }, // measured 400px
      { id: 'agent-3', sessionId: 's1' }, // unmeasured → DEFAULT_NODE_HEIGHT
    ]);

    const p1 = positions.get('agent-1')!;
    const p2 = positions.get('agent-2')!;
    const p3 = positions.get('agent-3')!;

    expect(p1.y).toBe(CHAIN_TOP_Y);
    // y2 = y1 + 200 + CHAIN_GAP (measured height of agent-1).
    expect(p2.y).toBe(p1.y + 200 + CHAIN_GAP);
    // y3 = y2 + 400 + CHAIN_GAP (measured height of agent-2).
    expect(p3.y).toBe(p2.y + 400 + CHAIN_GAP);
    // The 400px node requires MORE space than the fixed 260px spacing would
    // have allowed — the measured-height contract is what guarantees no
    // overlap for a full response box (min ≈ 314px).
    expect(p3.y - p2.y).toBeGreaterThan(400);
    expect(p3.y - p2.y).toBe(400 + CHAIN_GAP);
  });

  it('#2723 ST4: 15 chat nodes never overlap — every consecutive gap ≥ height + CHAIN_GAP', () => {
    const agents = Array.from({ length: 15 }, (_, i) => ({
      id: `agent-${i + 1}`,
      sessionId: 's1',
      height: 280 + (i % 3) * 120, // varied measured heights (280/400/520)
    }));
    const positions = computeChatChainPositions(agents);

    const sorted = agents.map(a => positions.get(a.id)!).map(p => p.y);
    for (let i = 1; i < sorted.length; i++) {
      const prevHeight = agents[i - 1].height!;
      expect(sorted[i] - sorted[i - 1]).toBe(prevHeight + CHAIN_GAP);
      // Chain stays vertical — all x centered.
      expect(positions.get(agents[i].id)!.x).toBe(0);
    }
    // All positions distinct → no two nodes cover each other.
    expect(new Set(sorted).size).toBe(15);
  });
});

// ── #2764 ST-1: the standalone ToolsNode chain-slot geometry was removed ─────
// The right-side tools column (`computeToolsChainPositions`, `TOOLS_CHAIN_X`,
// `ChainToolsNode`, the `tools` level mapping) was deleted with the standalone
// ToolsNode — tool calls now embed inside the chat node's payload, so there is
// no tools-column geometry left to pin. The subagent companion column below
// is the surviving companion geometry.

// ── #2745 ST-4 / #2766 ST-2: deterministic SubagentNode companion column ─────
// Each SubagentNode sits in its OWN column RIGHT of the chat chain (#2745
// human decision placed it LEFT; #2766 ST-2 mirrored the column into the
// right-side slot #2764 ST-1 freed):
// x = SUBAGENT_CHAIN_X + index × (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP);
// y = parent chat node y. A parent's subagents stack FURTHER RIGHT of each
// other (each new dispatch one column right of the previous) — all vertically
// aligned with the parent, never stacked below it. Pure geometry — the
// subagent nodes are chain-owned, excluded from the d3-force pass and the
// resolveRectOverlaps residue pass (asserted in the hook tests via the exact
// chain-slot positions).

describe('computeSubagentChainPositions (#2745 ST-4 / #2766 ST-2 mirror)', () => {
  it('places each SubagentNode RIGHT of the chat chain (x = SUBAGENT_CHAIN_X = +564), aligned with its parent', () => {
    const parentPositions = new Map<string, { x: number; y: number }>([
      ['agent-1', { x: CHAIN_X_CENTER, y: CHAIN_TOP_Y }],
    ]);
    const subagents: ChainSubagentNode[] = [
      { id: 'subagent-a', parentId: 'agent-1', index: 0 },
      { id: 'subagent-b', parentId: 'agent-1', index: 1 },
    ];

    const positions = computeSubagentChainPositions(subagents, parentPositions);

    // index 0 sits in the first subagent column, aligned with the parent's y;
    // index 1 sits one column FURTHER RIGHT (never below — A-5).
    expect(positions.get('subagent-a')).toEqual({ x: SUBAGENT_CHAIN_X, y: CHAIN_TOP_Y });
    expect(positions.get('subagent-b')).toEqual({
      x: SUBAGENT_CHAIN_X + (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP),
      y: CHAIN_TOP_Y,
    });
    // The plan's equivalence: the subagent column is RIGHT of the chat chain
    // (#2766 ST-2 mirror — the companion-gap rule applied outward from the
    // chain on the positive side).
    expect(SUBAGENT_CHAIN_X).toBe(CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH + COMPANION_GAP);
    expect(SUBAGENT_CHAIN_X).toBe(564);
    expect(SUBAGENT_NODE_MAX_WIDTH).toBe(540);
    expect(SUBAGENT_GAP).toBe(24);
  });

  it('stacks multiple subagents without horizontal overlap — every consecutive gap = SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP', () => {
    const parentPositions = new Map<string, { x: number; y: number }>([
      ['agent-1', { x: CHAIN_X_CENTER, y: 120 }],
    ]);
    const subagents: ChainSubagentNode[] = [0, 1, 2].map(i => ({
      id: `subagent-${i}`,
      parentId: 'agent-1',
      index: i,
    }));

    const positions = computeSubagentChainPositions(subagents, parentPositions);

    expect(positions.get('subagent-0')).toEqual({ x: SUBAGENT_CHAIN_X, y: 120 });
    for (let i = 1; i < subagents.length; i++) {
      // Each dispatch is one column further RIGHT — all share the parent's y.
      expect(positions.get(`subagent-${i}`)!.y).toBe(120);
      expect(positions.get(`subagent-${i}`)!.x - positions.get(`subagent-${i - 1}`)!.x)
        .toBe(SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP);
    }
    // Distinct x — no two nodes cover each other.
    const xs = subagents.map(s => positions.get(s.id)!.x);
    expect(new Set(xs).size).toBe(3);
  });

  it('skips subagent nodes whose parent chat node has no chain position', () => {
    const positions = computeSubagentChainPositions(
      [{ id: 'subagent-orphan', parentId: 'agent-missing', index: 0 }],
      new Map([['agent-1', { x: CHAIN_X_CENTER, y: 0 }]]),
    );
    expect(positions.has('subagent-orphan')).toBe(false);
    expect(positions.size).toBe(0);
  });

  it('is pure and deterministic — same inputs always yield the same positions; inputs not mutated', () => {
    const parentPositions = new Map<string, { x: number; y: number }>([
      ['agent-1', { x: CHAIN_X_CENTER, y: 200 }],
    ]);
    const subagents: ChainSubagentNode[] = [
      { id: 'subagent-1', parentId: 'agent-1', index: 0 },
      { id: 'subagent-2', parentId: 'agent-1', index: 1 },
    ];

    const first = computeSubagentChainPositions(subagents, parentPositions);
    const second = computeSubagentChainPositions(subagents, parentPositions);
    expect(first).toEqual(second);
    // Input maps are not mutated.
    expect(parentPositions.get('agent-1')).toEqual({ x: CHAIN_X_CENTER, y: 200 });
  });

  it('a lone subagent rect is never displaced by the residue overlap pass (chain-owned — excluded from mutation)', () => {
    // resolveRectOverlaps is the belt-and-suspenders pass the builder runs for
    // non-chain-owned residue; a lone chain-owned subagent rect has no partner,
    // so its exact chain slot survives untouched.
    const rects: RectNode[] = [
      {
        id: 'subagent-1',
        x: SUBAGENT_CHAIN_X,
        y: 0,
        width: SUBAGENT_NODE_MAX_WIDTH,
        height: SUBAGENT_NODE_HEIGHT,
      },
    ];
    const resolved = resolveRectOverlaps(rects);
    expect(resolved.get('subagent-1')).toEqual({ x: SUBAGENT_CHAIN_X, y: 0 });
  });
});

// ── #2762 ST-4 / #2766 ST-2: recursive subtree-band allocation (nested
//    delegation trees, mirrored RIGHT) ────────────────────────────────────────
// R-5: pure deterministic geometry for any depth; R-7: depth-1-only parity is
// pinned by layout.chain-parity.test.ts. Grammar (D-1a / D-1c-3 Option B):
//   x_child = x_parent + (1 + lane) × (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP)
//   y_child = y_parent + NESTED_TIER_INDENT_Y   (nested parents only; L1 mirrors chat y)
// Sibling branch subtrees occupy DISJOINT lane ranges (no lane conflation).

describe('computeSubagentChainPositions — recursive subtree bands (#2762 ST-4)', () => {
  const CHAT_Y = 120;
  const rootParents = () => new Map([['agent-1', { x: CHAIN_X_CENTER, y: CHAT_Y }]]);
  const LANE = SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP; // 564

  it('renders a 4-level delegation chain: one lane RIGHT + NESTED_TIER_INDENT_Y down per level', () => {
    // chat → L1 → L2 → L3 → L4 (single dispatch at each level).
    const positions = computeSubagentChainPositions(
      [
        { id: 'l1', parentId: 'agent-1', index: 0 },
        { id: 'l2', parentId: 'l1', index: 0 },
        { id: 'l3', parentId: 'l2', index: 0 },
        { id: 'l4', parentId: 'l3', index: 0 },
      ],
      rootParents(),
    );

    expect(positions.get('l1')).toEqual({ x: 564, y: CHAT_Y });
    expect(positions.get('l2')).toEqual({ x: 564 + LANE, y: CHAT_Y + NESTED_TIER_INDENT_Y });
    expect(positions.get('l3')).toEqual({ x: 564 + 2 * LANE, y: CHAT_Y + 2 * NESTED_TIER_INDENT_Y });
    expect(positions.get('l4')).toEqual({ x: 564 + 3 * LANE, y: CHAT_Y + 3 * NESTED_TIER_INDENT_Y });
    expect(NESTED_TIER_INDENT_Y).toBe(64);
  });

  it('allocates disjoint bands: a sibling is pushed PAST an earlier sibling\'s whole subtree', () => {
    // chat dispatches two subagents; the FIRST has two own children (band
    // width 3). The second sibling must land beyond lanes 0..2 — never share
    // an x-lane with the first branch's subtree.
    const positions = computeSubagentChainPositions(
      [
        { id: 'branch-a', parentId: 'agent-1', index: 0 },
        { id: 'branch-a-0', parentId: 'branch-a', index: 0 },
        { id: 'branch-a-1', parentId: 'branch-a', index: 1 },
        { id: 'branch-b', parentId: 'agent-1', index: 1 },
      ],
      rootParents(),
    );

    // Branch A: lane 0 (+564); its children lanes 1,2 (nested base = parent.x
    // + 1 lane, then index steps).
    expect(positions.get('branch-a')).toEqual({ x: 564, y: CHAT_Y });
    expect(positions.get('branch-a-0')).toEqual({ x: 564 + LANE, y: CHAT_Y + NESTED_TIER_INDENT_Y });
    expect(positions.get('branch-a-1')).toEqual({ x: 564 + 2 * LANE, y: CHAT_Y + NESTED_TIER_INDENT_Y });
    // Branch B: flat closed form would put index 1 at lane 1 (+1128) — that
    // lane belongs to branch-a-0's subtree, so the band walk pushes it to
    // lane 3.
    expect(positions.get('branch-b')).toEqual({ x: 564 + 3 * LANE, y: CHAT_Y });

    // No two nodes share an x-lane.
    const xs = [...positions.values()].map((p) => p.x);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('nested dispatch indexes continue the mirrored rule under a subagent parent (D-1a)', () => {
    // A level-1 subagent dispatching three of its own: one lane further right
    // per index, all at NESTED_TIER_INDENT_Y below the parent.
    const positions = computeSubagentChainPositions(
      [
        { id: 'parent', parentId: 'agent-1', index: 0 },
        { id: 'kid-0', parentId: 'parent', index: 0 },
        { id: 'kid-1', parentId: 'parent', index: 1 },
        { id: 'kid-2', parentId: 'parent', index: 2 },
      ],
      rootParents(),
    );

    expect(positions.get('parent')).toEqual({ x: 564, y: CHAT_Y });
    for (let i = 0; i < 3; i++) {
      expect(positions.get(`kid-${i}`)).toEqual({
        x: 564 + (i + 1) * LANE,
        y: CHAT_Y + NESTED_TIER_INDENT_Y,
      });
    }
  });

  it('wide flat tree (8 siblings) stays exactly on the closed form and never shares a lane', () => {
    const subagents = Array.from({ length: 8 }, (_, i) => ({
      id: `wide-${i}`,
      parentId: 'agent-1',
      index: i,
    }));
    const positions = computeSubagentChainPositions(subagents, rootParents());

    for (let i = 0; i < 8; i++) {
      expect(positions.get(`wide-${i}`)).toEqual({ x: 564 + i * LANE, y: CHAT_Y });
    }
    const xs = subagents.map((s) => positions.get(s.id)!.x);
    expect(new Set(xs).size).toBe(8);
  });

  it('deep + wide combined (4 levels × branching) keeps every node on a disjoint lane', () => {
    // agent-1 → a(L1); a → a0, a1 (L2); a0 → a0x (L3); a0x → a0xy (L4);
    // agent-1 → b(L1) — b's band must clear the ENTIRE a-subtree.
    const positions = computeSubagentChainPositions(
      [
        { id: 'a', parentId: 'agent-1', index: 0 },
        { id: 'a0', parentId: 'a', index: 0 },
        { id: 'a1', parentId: 'a', index: 1 },
        { id: 'a0x', parentId: 'a0', index: 0 },
        { id: 'a0xy', parentId: 'a0x', index: 0 },
        { id: 'b', parentId: 'agent-1', index: 1 },
      ],
      rootParents(),
    );

    // a-subtree spans lanes 0..4 (a=1 + a0[=1+a0x(=1+a0xy)] =3 + a1 =1 → width 5)
    // → b sits at lane 5.
    expect(positions.get('a')!.x).toBe(564);
    expect(positions.get('b')!.x).toBe(564 + 5 * LANE);
    const xs = [...positions.values()].map((p) => p.x);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('is pure and deterministic on nested input — same inputs yield the same positions; inputs not mutated', () => {
    const subagents: ChainSubagentNode[] = [
      { id: 'p', parentId: 'agent-1', index: 0 },
      { id: 'k0', parentId: 'p', index: 0 },
      { id: 'k1', parentId: 'p', index: 1 },
      { id: 'q', parentId: 'agent-1', index: 1 },
    ];
    const parents = rootParents();
    const parentsSnapshot = [...parents.entries()];

    const first = computeSubagentChainPositions(subagents, parents);
    const second = computeSubagentChainPositions(subagents, parents);
    expect([...second.entries()]).toEqual([...first.entries()]);
    expect([...parents.entries()]).toEqual(parentsSnapshot);
  });

  it('terminates on parent-link cycles (visited guard) — cyclic entries get no position', () => {
    // x ↔ y cycle: neither is chat-rooted, so neither (nor a child of the
    // cycle) can be placed — and the computation must not hang.
    const positions = computeSubagentChainPositions(
      [
        { id: 'cyc-x', parentId: 'cyc-y', index: 0 },
        { id: 'cyc-y', parentId: 'cyc-x', index: 0 },
      ],
      rootParents(),
    );
    expect(positions.size).toBe(0);
  });

  it('a nested entry whose parent subagent has no resolvable position is skipped (whole subtree)', () => {
    // 'orphan-parent' is a subagent id, but ITS parent chat node has no chain
    // position → the parent and its child get no slot.
    const positions = computeSubagentChainPositions(
      [
        { id: 'orphan-parent', parentId: 'agent-missing', index: 0 },
        { id: 'orphan-child', parentId: 'orphan-parent', index: 0 },
      ],
      rootParents(),
    );
    expect(positions.has('orphan-parent')).toBe(false);
    expect(positions.has('orphan-child')).toBe(false);
    expect(positions.size).toBe(0);
  });

  it('nested children are positioned relative to the parent subagent x, even for a non-default chat anchor', () => {
    // Positional robustness: a level-1 slot is anchored at the absolute
    // SUBAGENT_CHAIN_X (frozen #2745 rule, mirrored RIGHT by #2766), while a
    // nested slot anchors at its parent SubagentNode's own x.
    const positions = computeSubagentChainPositions(
      [
        { id: 'p', parentId: 'agent-1', index: 0 },
        { id: 'k', parentId: 'p', index: 0 },
      ],
      new Map([['agent-1', { x: 999, y: 50 }]]),
    );
    expect(positions.get('p')).toEqual({ x: SUBAGENT_CHAIN_X, y: 50 });
    expect(positions.get('k')).toEqual({
      x: SUBAGENT_CHAIN_X + LANE,
      y: 50 + NESTED_TIER_INDENT_Y,
    });
  });
});

// ── #2723 ST4: rectangular de-overlap (non-agent residue belt-and-suspenders) ─

describe('resolveRectOverlaps (#2723 ST4)', () => {
  it('pushes apart two overlapping rectangles along the axis of least penetration', () => {
    const rects: RectNode[] = [
      { id: 'tool-1', x: 0, y: 0, width: 320, height: 180 },
      // Center overlap: dx overlap = 320, dy overlap = 180 → separate on Y.
      { id: 'tool-2', x: 0, y: 40, width: 320, height: 180 },
    ];

    const resolved = resolveRectOverlaps(rects);
    const p1 = resolved.get('tool-1')!;
    const p2 = resolved.get('tool-2')!;

    const overlapX = 320 - Math.abs(p1.x - p2.x);
    const overlapY = 180 - Math.abs(p1.y - p2.y);
    // One axis must be fully resolved (no remaining overlap).
    expect(overlapX <= 0 || overlapY <= 0).toBe(true);
  });

  it('leaves non-overlapping rectangles untouched', () => {
    const rects: RectNode[] = [
      { id: 'tool-1', x: 0, y: 0, width: 320, height: 180 },
      { id: 'tool-2', x: 400, y: 300, width: 320, height: 180 },
    ];

    const resolved = resolveRectOverlaps(rects);
    expect(resolved.get('tool-1')).toEqual({ x: 0, y: 0 });
    expect(resolved.get('tool-2')).toEqual({ x: 400, y: 300 });
  });
});

// ── #2770 ST-3: companion-extent chain pitch (R-7 / R-10) ────────────────────
//
// The chain pitch after a chat node becomes
//   max(height ?? DEFAULT_NODE_HEIGHT, companionExtent ?? 0) + CHAIN_GAP
// so a subagent card taller than its anchor chat node pushes the NEXT chat
// node below the card's bottom edge (the same-lane collision root cause).
// R-10 parity: with companionExtent ABSENT the formula degenerates to the
// legacy pitch exactly — layout.chain-parity.test.ts's goldens (which never
// pass a companionExtent) stay the unmodified gate for that case.

describe('#2770 ST-3: chain pitch with companionExtent', () => {
  it('R-10 degenerate parity: absent companionExtent reproduces the legacy pitch formula exactly', () => {
    // Hand-derived from the legacy formula: y += (height ?? DEFAULT) + CHAIN_GAP.
    const positions = computeChatChainPositions([
      { id: 'a1', sessionId: 's-a', height: 360 },
      { id: 'a2', sessionId: 's-a', height: 314 },
      { id: 'a3', sessionId: 's-a' },
    ]);
    expect(positions.get('a1')).toEqual({ x: 0, y: 0 });
    expect(positions.get('a2')).toEqual({ x: 0, y: 360 + CHAIN_GAP });
    expect(positions.get('a3')).toEqual({ x: 0, y: 360 + CHAIN_GAP + 314 + CHAIN_GAP });
  });

  it('R-7 extent-fed pitch: a companion extent taller than the chat node extends the pitch', () => {
    // a1's companion card (700px) exceeds a1's chat height (360px) — the next
    // chat node must land BELOW the card's bottom edge (+ the chain gap).
    const positions = computeChatChainPositions([
      { id: 'a1', sessionId: 's-a', height: 360, companionExtent: 700 },
      { id: 'a2', sessionId: 's-a', height: 314 },
    ]);
    expect(positions.get('a1')).toEqual({ x: 0, y: 0 });
    expect(positions.get('a2')).toEqual({ x: 0, y: 700 + CHAIN_GAP });
  });

  it('R-7 extent-fed pitch: a companion extent shorter than the chat node leaves the pitch unchanged', () => {
    const positions = computeChatChainPositions([
      { id: 'a1', sessionId: 's-a', height: 800, companionExtent: 500 },
      { id: 'a2', sessionId: 's-a', height: 314 },
    ]);
    expect(positions.get('a2')).toEqual({ x: 0, y: 800 + CHAIN_GAP });
  });

  it('R-7 fallback reservation: an unmeasured chat node with a companion extent reserves the extent (not DEFAULT_NODE_HEIGHT) when larger', () => {
    const positions = computeChatChainPositions([
      { id: 'a1', sessionId: 's-a', companionExtent: SUBAGENT_CARD_FALLBACK_HEIGHT },
      { id: 'a2', sessionId: 's-a', height: 314 },
    ]);
    expect(positions.get('a2')).toEqual({ x: 0, y: SUBAGENT_CARD_FALLBACK_HEIGHT + CHAIN_GAP });
  });

  it('R-9 determinism: identical inputs (with extents) yield identical positions across repeated rebuilds', () => {
    const agents = [
      { id: 'a1', sessionId: 's-a', height: 360, companionExtent: 700 },
      { id: 'a2', sessionId: 's-a', height: 314, companionExtent: 640 },
      { id: 'b1', sessionId: 's-b', height: 200 },
    ];
    const first = computeChatChainPositions(agents);
    const second = computeChatChainPositions(agents);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });
});

describe('#2770 ST-3: computeCompanionExtents', () => {
  it('R-7: a tall measured L1 card contributes its full height to its chat anchor', () => {
    const extents = computeCompanionExtents(
      [{ id: 'subagent-t1', parentId: 'agent-1', index: 0 }],
      new Map([['subagent-t1', 700]]),
    );
    expect(extents.get('agent-1')).toBe(700);
  });

  it('R-7: an unmeasured card reserves the conservative SUBAGENT_CARD_FALLBACK_HEIGHT', () => {
    const extents = computeCompanionExtents(
      [{ id: 'subagent-t1', parentId: 'agent-1', index: 0 }],
      new Map(),
    );
    expect(SUBAGENT_CARD_FALLBACK_HEIGHT).toBe(640);
    expect(extents.get('agent-1')).toBe(SUBAGENT_CARD_FALLBACK_HEIGHT);
  });

  it('R-7: a nested (L2) card contributes NESTED_TIER_INDENT_Y × (depth−1) + height', () => {
    const extents = computeCompanionExtents(
      [
        { id: 'subagent-l1', parentId: 'agent-1', index: 0 },
        { id: 'subagent-l2', parentId: 'subagent-l1', index: 0 },
      ],
      new Map([['subagent-l1', 300], ['subagent-l2', 500]]),
    );
    // L1 contributes 0 + 300; L2 sits NESTED_TIER_INDENT_Y below the chat y
    // (its L1 parent anchors to the chat y, not its bottom edge) → 64 + 500.
    expect(extents.get('agent-1')).toBe(NESTED_TIER_INDENT_Y + 500);
  });

  it('R-7: a deeper (L3) card stacks two indents below the chat anchor', () => {
    const extents = computeCompanionExtents(
      [
        { id: 'subagent-l1', parentId: 'agent-1', index: 0 },
        { id: 'subagent-l2', parentId: 'subagent-l1', index: 0 },
        { id: 'subagent-l3', parentId: 'subagent-l2', index: 0 },
      ],
      new Map([['subagent-l1', 200], ['subagent-l2', 200], ['subagent-l3', 400]]),
    );
    expect(extents.get('agent-1')).toBe(2 * NESTED_TIER_INDENT_Y + 400);
  });

  it('R-7: the extent is the MAX over the whole subtree — sibling branches and multiple roots stay independent', () => {
    const extents = computeCompanionExtents(
      [
        // agent-1's subtree: L1 (300) + nested L2 (64 + 500 = 564) → 564 wins.
        { id: 'subagent-a-0', parentId: 'agent-1', index: 0 },
        { id: 'subagent-a-0-0', parentId: 'subagent-a-0', index: 0 },
        // agent-2's subtree: one tall flat L1 (700).
        { id: 'subagent-b-0', parentId: 'agent-2', index: 0 },
      ],
      new Map([
        ['subagent-a-0', 300], ['subagent-a-0-0', 500], ['subagent-b-0', 700],
      ]),
    );
    expect(extents.get('agent-1')).toBe(NESTED_TIER_INDENT_Y + 500);
    expect(extents.get('agent-2')).toBe(700);
  });

  it('R-9: deterministic across repeated invocations (same inputs → same map)', () => {
    const subagents = [
      { id: 'subagent-l1', parentId: 'agent-1', index: 0 },
      { id: 'subagent-l2', parentId: 'subagent-l1', index: 0 },
      { id: 'subagent-b-0', parentId: 'agent-2', index: 0 },
    ];
    const heights = new Map([['subagent-l1', 300], ['subagent-l2', 500], ['subagent-b-0', 700]]);
    const first = computeCompanionExtents(subagents, heights);
    const second = computeCompanionExtents(subagents, heights);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('R-9: empty input yields an empty map (no extents — degenerate parity)', () => {
    expect(computeCompanionExtents([], new Map()).size).toBe(0);
  });
});


