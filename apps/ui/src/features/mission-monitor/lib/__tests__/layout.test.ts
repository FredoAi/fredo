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
  computeToolsChainPositions,
  computeSubagentChainPositions,
  resolveRectOverlaps,
  CHAIN_GAP,
  CHAIN_TOP_Y,
  CHAIN_X_CENTER,
  DEFAULT_NODE_HEIGHT,
  AGENT_NODE_HALF_WIDTH,
  AGENT_NODE_MAX_WIDTH,
  TOOLS_GAP,
  TOOLS_CHAIN_X,
  SUBAGENT_CHAIN_X,
  SUBAGENT_GAP,
  SUBAGENT_NODE_HEIGHT,
  SUBAGENT_NODE_MAX_WIDTH,
  layoutLevelForType,
  TYPE_TO_LEVEL,
  createLiveForceSimulation,
  LAYOUT_MODE_KEY,
  computeExchangeAnchors,
  FORCE_POSITION_STRENGTH,
  FORCE_LINK_DISTANCE,
  FORCE_CHARGE_SCALE,
  FORCE_COLLIDE_SCALE,
} from '../layout';
import type { LayoutNode, LayoutEdge, RectNode, ChainToolsNode, ChainSubagentNode } from '../layout';

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

// ── #2739 ST-3: deterministic right-side ToolsNode chain slots ───────────────
// Each ToolsNode sits to the RIGHT of its parent chat node at the parent's own
// y — x = parent.x + widest-chat-node-width (360) + TOOLS_GAP (24) = 384 for a
// chain-anchored parent. Pure geometry, no d3-force involvement (NFR-3).

describe('computeToolsChainPositions (#2739 ST-3)', () => {
  it('places each ToolsNode to the right of its chat node at the parent y', () => {
    const parentPositions = new Map<string, { x: number; y: number }>([
      ['agent-1', { x: CHAIN_X_CENTER, y: CHAIN_TOP_Y }],
      ['agent-2', { x: CHAIN_X_CENTER, y: DEFAULT_NODE_HEIGHT + CHAIN_GAP }],
    ]);
    const tools: ChainToolsNode[] = [
      { id: 'tools-corr-1', parentId: 'agent-1' },
      { id: 'tools-corr-2', parentId: 'agent-2' },
    ];

    const positions = computeToolsChainPositions(tools, parentPositions);

    // x = TOOLS_CHAIN_X (right of the widest chat node + gap) — same for every
    // chain-anchored parent; y mirrors the parent chat node's own y.
    expect(positions.get('tools-corr-1')).toEqual({ x: TOOLS_CHAIN_X, y: CHAIN_TOP_Y });
    expect(positions.get('tools-corr-2')).toEqual({
      x: TOOLS_CHAIN_X,
      y: DEFAULT_NODE_HEIGHT + CHAIN_GAP,
    });
    // The plan's equivalence: x = chatNode.x + chatNode.width + TOOLS_GAP.
    expect(TOOLS_CHAIN_X).toBe(CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH + TOOLS_GAP);
    expect(TOOLS_CHAIN_X).toBe(564);
  });

  it('never overlaps the vertical chat chain for ANY chat node width', () => {
    // A chain-anchored chat node spans [CHAIN_X_CENTER, CHAIN_X_CENTER + width]
    // with width up to AGENT_NODE_MAX_WIDTH (540). The tools column x starts at
    // the right edge of the WIDEST chat node + TOOLS_GAP, so even a full-width
    // chat node's right edge (540) leaves a clean TOOLS_GAP before the node.
    expect(TOOLS_CHAIN_X - (CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH)).toBe(TOOLS_GAP);
    // Sanity: the half-width alone would place the slot INSIDE the chat box —
    // the binding geometry must use the full width (NFR-3 zero overlap).
    expect(AGENT_NODE_HALF_WIDTH).toBe(270);
    expect(AGENT_NODE_MAX_WIDTH).toBe(540);
  });

  it('skips tools nodes whose parent chat node has no chain position', () => {
    const positions = computeToolsChainPositions(
      [{ id: 'tools-orphan', parentId: 'agent-missing' }],
      new Map([['agent-1', { x: CHAIN_X_CENTER, y: 0 }]]),
    );
    expect(positions.has('tools-orphan')).toBe(false);
    expect(positions.size).toBe(0);
  });

  it('is pure and deterministic — same inputs always yield the same positions', () => {
    const parentPositions = new Map<string, { x: number; y: number }>([
      ['agent-1', { x: CHAIN_X_CENTER, y: CHAIN_TOP_Y }],
      ['agent-2', { x: CHAIN_X_CENTER, y: 480 }],
    ]);
    const tools: ChainToolsNode[] = [
      { id: 'tools-corr-1', parentId: 'agent-1' },
      { id: 'tools-corr-2', parentId: 'agent-2' },
    ];
    const first = computeToolsChainPositions(tools, parentPositions);
    const second = computeToolsChainPositions(tools, parentPositions);
    expect(first).toEqual(second);
    // Input maps are not mutated.
    expect(parentPositions.get('agent-1')).toEqual({ x: CHAIN_X_CENTER, y: CHAIN_TOP_Y });
  });

  it('y aligns with the parent chat node across a measured-height chain', () => {
    // #2723 ST4 measured-height stacking is the frozen vertical geometry — the
    // tools slots must track each parent's y exactly (no independent spacing).
    const agents = [
      { id: 'agent-1', sessionId: 's1', height: 200 },
      { id: 'agent-2', sessionId: 's1', height: 400 },
    ];
    const chain = computeChatChainPositions(agents);
    const positions = computeToolsChainPositions(
      agents.map(a => ({ id: `tools-${a.id}`, parentId: a.id })),
      chain,
    );
    expect(positions.get('tools-agent-1')!.y).toBe(chain.get('agent-1')!.y);
    expect(positions.get('tools-agent-2')!.y).toBe(chain.get('agent-2')!.y);
    // Vertical spacing between the two tools nodes mirrors the chat chain gap
    // (200 + CHAIN_GAP), i.e. they cannot collide with each other either.
    expect(positions.get('tools-agent-2')!.y - positions.get('tools-agent-1')!.y)
      .toBe(200 + CHAIN_GAP);
  });

  it('tracks a parent chat node with a non-default x (positional robustness)', () => {
    const parentPositions = new Map<string, { x: number; y: number }>([
      ['agent-1', { x: 100, y: 50 }],
    ]);
    const positions = computeToolsChainPositions(
      [{ id: 'tools-corr-1', parentId: 'agent-1' }],
      parentPositions,
    );
    expect(positions.get('tools-corr-1')).toEqual({
      x: 100 + AGENT_NODE_MAX_WIDTH + TOOLS_GAP,
      y: 50,
    });
  });
});

describe('tools level/type mapping (#2739 ST-3)', () => {
  it('maps the tools summary type to the agent level (180px radius)', () => {
    expect(TYPE_TO_LEVEL.tools).toBe(1);
    expect(layoutLevelForType('tools')).toBe(1);
    // Legacy levels are unchanged — the #2723 mapping is frozen.
    expect(layoutLevelForType('agent')).toBe(1);
    expect(layoutLevelForType('subagent')).toBe(2);
    expect(layoutLevelForType('tool')).toBe(3);
    expect(layoutLevelForType('file')).toBe(4);
  });

  it('falls back to the file level (4) for unknown/absent types', () => {
    expect(layoutLevelForType(undefined)).toBe(4);
    expect(layoutLevelForType('unknown')).toBe(4);
  });
});

// ── #2745 ST-4: deterministic SubagentNode companion column ─────────────────
// Each SubagentNode sits in its OWN column LEFT of the chat chain (human
// decision: subagents left, tools right):
// x = SUBAGENT_CHAIN_X − index × (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP);
// y = parent chat node y. A parent's subagents stack FURTHER LEFT of each other
// (each new dispatch one column left of the previous) — all vertically aligned
// with the parent, never stacked below it. Pure geometry — the subagent nodes
// are chain-owned, excluded from the d3-force pass and the resolveRectOverlaps
// residue pass (asserted in the hook tests via the exact chain-slot positions).

describe('computeSubagentChainPositions (#2745 ST-4)', () => {
  it('places each SubagentNode LEFT of the chat chain (x = SUBAGENT_CHAIN_X = -564), aligned with its parent', () => {
    const parentPositions = new Map<string, { x: number; y: number }>([
      ['agent-1', { x: CHAIN_X_CENTER, y: CHAIN_TOP_Y }],
    ]);
    const subagents: ChainSubagentNode[] = [
      { id: 'subagent-a', parentId: 'agent-1', index: 0 },
      { id: 'subagent-b', parentId: 'agent-1', index: 1 },
    ];

    const positions = computeSubagentChainPositions(subagents, parentPositions);

    // index 0 sits in the first subagent column, aligned with the parent's y;
    // index 1 sits one column FURTHER LEFT (never below — A-5).
    expect(positions.get('subagent-a')).toEqual({ x: SUBAGENT_CHAIN_X, y: CHAIN_TOP_Y });
    expect(positions.get('subagent-b')).toEqual({
      x: SUBAGENT_CHAIN_X - (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP),
      y: CHAIN_TOP_Y,
    });
    // The plan's equivalence: the subagent column is LEFT of the chat chain
    // (mirror of the ToolsNode column rule on the negative side).
    expect(SUBAGENT_CHAIN_X).toBe(CHAIN_X_CENTER - AGENT_NODE_MAX_WIDTH - TOOLS_GAP);
    expect(SUBAGENT_CHAIN_X).toBe(-564);
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
      // Each dispatch is one column further LEFT — all share the parent's y.
      expect(positions.get(`subagent-${i}`)!.y).toBe(120);
      expect(positions.get(`subagent-${i - 1}`)!.x - positions.get(`subagent-${i}`)!.x)
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

// ── #2752 ST-1: createLiveForceSimulation (live d3-force builder) ────────────
//
// The AC5 test target: a rAF-driven, stoppable force-simulation controller.
// Determinism comes from the injected scheduleTick/cancelTick (jsdom has no
// rAF) and the injected `random` source (Math.random at layout.ts:474 breaks
// determinism). freeze-on-settled is the WHOLE-simulation stop when alpha <
// alphaMin (EARS-3) — the live builder deliberately carries NO per-status
// fx/fy freezing, so a fully all-complete graph must still animate.

/** Manual rAF harness — collects scheduled frame callbacks and runs them on
 *  demand, so tests control exactly when animation frames fire. */
function createFrameHarness() {
  let nextHandle = 1;
  const scheduled = new Map<number, () => void>();
  return {
    scheduleTick: (cb: () => void): number => {
      const handle = nextHandle++;
      scheduled.set(handle, cb);
      return handle;
    },
    cancelTick: (handle: number): void => {
      scheduled.delete(handle);
    },
    /** Run one animation frame — invoke every currently scheduled callback. */
    frame(): void {
      const callbacks = Array.from(scheduled.values());
      scheduled.clear();
      for (const cb of callbacks) cb();
    },
    /** Number of frames currently scheduled. */
    get pending(): number {
      return scheduled.size;
    },
    /** Run frames until none are pending (or the guard exhausts). */
    drain(maxFrames = 5000): number {
      let frames = 0;
      while (scheduled.size > 0 && frames < maxFrames) {
        this.frame();
        frames++;
      }
      return frames;
    },
  };
}

/** Deterministic pseudo-random source (mulberry32). d3-force's internal jiggle
 *  for coincident nodes is `(random() - 0.5) * 1e-6` — a constant source (e.g.
 *  `() => 0.5`) makes the jiggle zero and NaN-explodes coincident seeds. A
 *  seeded PRNG keeps every frame reproducible while still varying the jiggle. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createLiveForceSimulation (#2752 ST-1)', () => {
  it('freezes on settle: stops the whole simulation at alpha < alphaMin and fires onSettled once (EARS-3)', () => {
    const harness = createFrameHarness();
    let settledCalls = 0;
    let lastSettled: Map<string, { x: number; y: number }> | null = null;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      onSettled: (p) => {
        settledCalls++;
        lastSettled = p;
      },
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      ],
      [{ source: 'agent-1', target: 'agent-2' }],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['agent-2', { x: 100, y: 0 }],
      ]),
    );

    expect(sim.isRunning()).toBe(true);
    expect(sim.isSettled()).toBe(false);

    // alphaDecay 0.02 / alphaMin 0.01 → settles after ~229 ticks.
    const frames = harness.drain();
    expect(frames).toBeGreaterThan(0);

    expect(sim.isSettled()).toBe(true);
    expect(sim.isRunning()).toBe(false);
    expect(settledCalls).toBe(1);
    expect(lastSettled).not.toBeNull();

    // Freeze-on-settled = whole-sim stop: no more frames are scheduled and
    // positions stay byte-identical across subsequent (no-op) ticks.
    const settledPositions = sim.positions();
    expect(harness.pending).toBe(0);
    harness.frame();
    expect(sim.positions()).toEqual(settledPositions);
    expect(settledCalls).toBe(1);

    // start() after settle is a no-op — the loop must NOT restart (EARS-3).
    sim.start();
    expect(harness.pending).toBe(0);
    expect(sim.positions()).toEqual(settledPositions);
    expect(settledCalls).toBe(1);
  });

  it('carries NO per-status fx/fy freezing — a fully all-complete graph still animates at start', () => {
    const harness = createFrameHarness();
    let tickCount = 0;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      onTick: () => {
        tickCount++;
      },
    });

    // Every node settled (complete/error) — computeForceLayout would freeze all
    // of them with fx/fy (layout.ts:458/486-487); the live builder must not.
    sim.restart(
      [
        { id: 'agent-1', status: 'complete', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'error', type: 'agent', depth: 0 },
      ],
      [],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['agent-2', { x: 0, y: 0 }],
      ]),
    );

    const initial = sim.positions();
    harness.frame();
    harness.frame();
    harness.frame();

    expect(tickCount).toBe(3);
    const moved = ['agent-1', 'agent-2'].some((id) => {
      const a = initial.get(id)!;
      const b = sim.positions().get(id)!;
      return a.x !== b.x || a.y !== b.y;
    });
    // Both nodes collide (radius 270) and repel (charge -600) — they must have
    // moved off their shared seed, proving nothing is pinned.
    expect(moved).toBe(true);
    sim.stop();
  });

  it('honors the forceY option — per-node target Y drives the settled vertical order', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      forceY: (n) => (n.id === 'agent-1' ? -800 : 800),
      forceYStrength: 0.2,
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      ],
      [],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['agent-2', { x: 0, y: 0 }],
      ]),
    );

    harness.drain();
    const p1 = sim.positions().get('agent-1')!;
    const p2 = sim.positions().get('agent-2')!;
    // forceY pushes agent-1 toward -800 and agent-2 toward +800 — the
    // persistent Y bias must dominate the (symmetric) charge/collide spread.
    expect(p2.y).toBeGreaterThan(p1.y);
    expect(p2.y - p1.y).toBeGreaterThan(200);
  });

  it('#2756 DELIBERATE UPDATE: default forceX/forceY targets are NEUTRAL () => 0 — the #2754 per-depth Y band ((n.depth ?? 0) * 400) is gone (REQ-3: no chain-y bias)', () => {
    // Under the #2754 hybrid the DEFAULT forceY target was `(depth ?? 0) * 400`,
    // which layered nodes into depth bands (agent→0, subagent→400, tool→800).
    // #2756 removes the depth bias: the default target is () => 0 for BOTH
    // positioning forces. Determinism proof: an explicit `forceY: () => 0` /
    // `forceX: () => 0` run must settle byte-identical to the default run with
    // the SAME injected random source — the neutral default and an explicit
    // neutral target are the same recipe.
    const run = (explicitNeutral: boolean) => {
      const harness = createFrameHarness();
      const sim = createLiveForceSimulation({
        scheduleTick: harness.scheduleTick,
        cancelTick: harness.cancelTick,
        random: seededRandom(42),
        ...(explicitNeutral
          ? { forceX: (): number => 0, forceY: (): number => 0 }
          : {}),
      });
      sim.restart(
        [
          { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
          { id: 'subagent-1', status: 'in-progress', type: 'subagent', depth: 1 },
          { id: 'tool-1', status: 'in-progress', type: 'tool', depth: 2 },
        ],
        [],
        new Map([
          ['agent-1', { x: 0, y: 0 }],
          ['subagent-1', { x: 0, y: 0 }],
          ['tool-1', { x: 0, y: 0 }],
        ]),
      );
      harness.drain();
      return sim.positions();
    };

    expect(run(false)).toEqual(run(true));

    // The neutral target also means NO deterministic per-depth band survives:
    // with all three seeds coincident, the settled vertical order is NOT
    // forced to depth-order (agent < subagent < tool). Any monotonic banding
    // would be a residue of the removed (depth ?? 0) * 400 recipe — the
    // neutral-positioning recipe leaves the vertical spread to charge/collide
    // alone, which is symmetric around the shared origin for coincident seeds.
    const positions = run(false);
    const pa = positions.get('agent-1')!;
    const ps = positions.get('subagent-1')!;
    const pt = positions.get('tool-1')!;
    // The depth-2 tool is NOT deterministically pushed 800px below the agent
    // — its y target is 0 now, so the settled y separation is charge/collide
    // spread (bounded well under the old 400px-per-depth band gap; the #2754
    // recipe forced tool-vs-agent ≈ 800 by construction).
    expect(Math.abs(pt.y - pa.y)).toBeLessThan(700);
    expect(Math.abs(ps.y - pa.y)).toBeLessThan(700);
  });

  it('restarts seeded from the current positions — pre-existing nodes do not jump, new nodes glide in (EARS-4)', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      ],
      [],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['agent-2', { x: 400, y: 0 }],
      ]),
    );
    // Let the first run move a little — the restart must seed from the CURRENT
    // (post-frame) positions, not the original seed.
    harness.frame();
    harness.frame();
    harness.frame();
    const beforeRestart = sim.positions();

    // Structural change: agent-3 arrives; seed = current node positions.
    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-3', status: 'in-progress', type: 'agent', depth: 0 },
      ],
      [],
      new Map(beforeRestart),
    );

    // Immediately after restart, pre-existing nodes sit exactly at their
    // pre-restart positions (no jump, no re-snap)...
    expect(sim.positions().get('agent-1')).toEqual(beforeRestart.get('agent-1'));
    expect(sim.positions().get('agent-2')).toEqual(beforeRestart.get('agent-2'));
    // ...and the fresh node is placed at its level-based seed (not 0,0).
    expect(sim.positions().get('agent-3')).toEqual({ x: -100, y: -400 });
    // The simulation restarted (rAF loop active again).
    expect(sim.isRunning()).toBe(true);
    expect(harness.pending).toBeGreaterThan(0);
  });

  it('uses options.existingPositions as the fallback seed for nodes missing from the restart seed', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      existingPositions: new Map([['agent-1', { x: 111, y: 222 }]]),
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      ],
      [],
      new Map([['agent-2', { x: 50, y: 60 }]]), // seed lacks agent-1
    );

    expect(sim.positions().get('agent-1')).toEqual({ x: 111, y: 222 });
    expect(sim.positions().get('agent-2')).toEqual({ x: 50, y: 60 });
  });

  it('stop() cancels the rAF loop and simulation; start() resumes it', () => {
    const harness = createFrameHarness();
    let tickCount = 0;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      onTick: () => {
        tickCount++;
      },
    });

    sim.restart(
      [{ id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 }],
      [],
      new Map([['agent-1', { x: 0, y: 0 }]]),
    );
    expect(sim.isRunning()).toBe(true);

    harness.frame();
    expect(tickCount).toBe(1);
    sim.stop();
    expect(sim.isRunning()).toBe(false);

    const afterStop = tickCount;
    harness.frame();
    harness.frame();
    expect(tickCount).toBe(afterStop); // no orphan rAF loop
    expect(harness.pending).toBe(0);

    sim.start();
    expect(sim.isRunning()).toBe(true);
    harness.frame();
    expect(tickCount).toBe(afterStop + 1);
    sim.stop();
  });

  it('handles 0 nodes: settles immediately with empty positions and no scheduled frames', () => {
    const harness = createFrameHarness();
    let settledCalls = 0;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      onSettled: () => {
        settledCalls++;
      },
    });

    // Fresh controller has nothing to animate — already settled.
    expect(sim.isSettled()).toBe(true);
    expect(sim.isRunning()).toBe(false);

    sim.restart([], [], new Map());
    expect(sim.isSettled()).toBe(true);
    expect(sim.isRunning()).toBe(false);
    expect(sim.positions().size).toBe(0);
    expect(harness.pending).toBe(0);
    expect(settledCalls).toBe(1);

    sim.start(); // no-op when settled
    expect(harness.pending).toBe(0);
    expect(settledCalls).toBe(1);
  });

  it('handles 1 node: runs to settle with a stable finite position', () => {
    const harness = createFrameHarness();
    let settledCalls = 0;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      onSettled: () => {
        settledCalls++;
      },
    });

    sim.restart(
      [{ id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 }],
      [],
      new Map([['agent-1', { x: 0, y: 0 }]]),
    );
    expect(sim.isRunning()).toBe(true);

    harness.drain();
    expect(sim.isSettled()).toBe(true);
    expect(settledCalls).toBe(1);
    const pos = sim.positions().get('agent-1')!;
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);

    // Stable after settle.
    const snapshot = sim.positions();
    harness.frame();
    expect(sim.positions()).toEqual(snapshot);
  });

  it('skips edges whose endpoints are missing from the node set (no crash, still runs)', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      ],
      [
        { source: 'agent-1', target: 'ghost-a' }, // missing target
        { source: 'ghost-b', target: 'agent-2' }, // missing source
        { source: 'agent-1', target: 'agent-2' }, // valid
      ],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['agent-2', { x: 0, y: 0 }],
      ]),
    );

    expect(sim.isRunning()).toBe(true);
    harness.drain();
    expect(sim.isSettled()).toBe(true);
    expect(sim.positions().has('agent-1')).toBe(true);
    expect(sim.positions().has('agent-2')).toBe(true);
    expect(Number.isFinite(sim.positions().get('agent-1')!.x)).toBe(true);
    expect(Number.isFinite(sim.positions().get('agent-2')!.y)).toBe(true);
  });

  it('exports LAYOUT_MODE_KEY following the Fredo_mm_* persisted-setting pattern', () => {
    expect(LAYOUT_MODE_KEY).toBe('Fredo_mm_layout_mode');
    expect(LAYOUT_MODE_KEY).toMatch(/^Fredo_mm_/);
  });

  // ── #2756 DELIBERATE UPDATE: NO pinned set — disjoint positioning forces ──
  // The #2754 ST-1 pinned + snapToSettled builder tests are DELIBERATELY
  // rewritten: `pinned` is removed (every node is a sim body — REQ-1) and the
  // positioning-force options (forceX/forceY/forceXStrength/forceYStrength)
  // drive the disjoint recipe. `snapToSettled` stays as the reduced-motion
  // synchronous settle (G-059) but now settles the disjoint recipe — the pin
  // semantics are what was removed, not the a11y snap.

  it('#2756 DELIBERATE UPDATE: NO pinned set — every node is a sim body: the chat node AND its companions all glide off their seeds (REQ-1: no fx/fy pinning)', () => {
    const harness = createFrameHarness();
    let settledCalls = 0;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      // #2756: no `pinned` — the chat node is NOT frozen at its chain slot.
      // forceX/forceY positioning targets (the per-exchange anchors) pull every
      // node toward its exchange instead (REQ-3).
      forceX: (n) => (n.id === 'agent-1' ? -400 : 400),
      forceY: () => 0,
      onSettled: () => {
        settledCalls++;
      },
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
        { id: 'subagent-1', status: 'in-progress', type: 'subagent', depth: 1 },
      ],
      [
        { source: 'agent-1', target: 'tools-1' },
        { source: 'agent-1', target: 'subagent-1' },
      ],
      new Map([
        ['agent-1', { x: 0, y: 0 }], // old chain slot — must NOT stay fixed
        ['tools-1', { x: 564, y: 0 }], // right companion slot
        ['subagent-1', { x: -564, y: 0 }], // left companion slot
      ]),
    );

    // The seed is applied at restart (EARS-4 seed contract — no jump)...
    expect(sim.positions().get('agent-1')).toEqual({ x: 0, y: 0 });

    // ...but NO node is pinned: after a few ticks the chat node has moved off
    // its chain slot toward its forceX anchor (-400), exactly like the
    // companions (REQ-1 — every node is a sim body).
    harness.frame();
    harness.frame();
    harness.frame();
    const agentAfterTicks = sim.positions().get('agent-1')!;
    expect(agentAfterTicks).not.toEqual({ x: 0, y: 0 });

    // And through settle the chat node keeps force-simulated (not chain) coords.
    harness.drain();
    expect(sim.isSettled()).toBe(true);
    expect(settledCalls).toBe(1);
    const agentSettled = sim.positions().get('agent-1')!;
    expect(agentSettled).not.toEqual({ x: 0, y: 0 });
    // The agents' forceX target was -400 — the chat node is pulled toward its
    // exchange anchor region (NOT held at the chain slot x=0).
    expect(Math.abs(agentSettled.x + 400)).toBeLessThan(600);

    // The companions were also force-placed (moved off their deterministic
    // chain slots) to finite positions — nothing is pinned (REQ-1). Their
    // exact settle side around the anchor is stochastic (link/charge dominate
    // the weak positioning force), so only finiteness + off-seed are asserted
    // here; the deterministic cluster-cohesion contract is the two-exchange
    // test below.
    const toolsPos = sim.positions().get('tools-1')!;
    const subPos = sim.positions().get('subagent-1')!;
    expect(toolsPos).not.toEqual({ x: 564, y: 0 });
    expect(subPos).not.toEqual({ x: -564, y: 0 });
    expect(Number.isFinite(toolsPos.x)).toBe(true);
    expect(Number.isFinite(toolsPos.y)).toBe(true);
    expect(Number.isFinite(subPos.x)).toBe(true);
    expect(Number.isFinite(subPos.y)).toBe(true);
    sim.stop();
  });

  it('#2756 DELIBERATE UPDATE: snapToSettled (prefers-reduced-motion) settles the DISJOINT recipe synchronously — every node moves off its seed, exactly like the rAF path (no pin in the snap path either)', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      // No `pinned` — the reduced-motion snap settles the same disjoint recipe
      // as the rAF path (the #2754 pin semantics are removed; G-059 keeps the
      // snap as the a11y synchronous-settle path, now over the disjoint recipe).
      forceX: (n) => (n.id === 'agent-1' ? -400 : 400),
      forceY: () => 0,
      snapToSettled: true,
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
      ],
      [{ source: 'agent-1', target: 'tools-1' }],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['tools-1', { x: 564, y: 0 }],
      ]),
    );

    expect(harness.pending).toBe(0);
    expect(sim.isSettled()).toBe(true);
    // No node is pinned: the chat node moved off its seed toward its forceX
    // anchor (-400) — the snap path does NOT freeze it at a chain slot.
    const agentSnap = sim.positions().get('agent-1')!;
    expect(agentSnap).not.toEqual({ x: 0, y: 0 });
    expect(agentSnap.x).toBeLessThan(0);

    // rAF-path control: the SAME config through the frame harness must settle
    // to byte-identical positions — the snap path is the reduced-motion variant
    // of the exact same disjoint force result.
    const rAF = createFrameHarness();
    const simRAF = createLiveForceSimulation({
      scheduleTick: rAF.scheduleTick,
      cancelTick: rAF.cancelTick,
      random: seededRandom(42),
      forceX: (n) => (n.id === 'agent-1' ? -400 : 400),
      forceY: () => 0,
    });
    simRAF.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
      ],
      [{ source: 'agent-1', target: 'tools-1' }],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['tools-1', { x: 564, y: 0 }],
      ]),
    );
    rAF.drain();

    expect(simRAF.isSettled()).toBe(true);
    expect(sim.positions()).toEqual(simRAF.positions());

    // The companion WAS force-placed (moved off its seed to a finite spot) —
    // the synchronous loop actually ran the forces.
    const toolsPos = sim.positions().get('tools-1')!;
    expect(toolsPos).not.toEqual({ x: 564, y: 0 });
    expect(toolsPos.x).toBeGreaterThan(0);
    expect(Number.isFinite(toolsPos.x)).toBe(true);
    expect(Number.isFinite(toolsPos.y)).toBe(true);
  });

  it('snapToSettled applies final positions synchronously — no rAF frame is scheduled (prefers-reduced-motion path)', () => {
    const harness = createFrameHarness();
    let tickCalls = 0;
    let settledCalls = 0;
    let lastSettledPositions: Map<string, { x: number; y: number }> | null = null;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      snapToSettled: true,
      onTick: () => {
        tickCalls++;
      },
      onSettled: (p) => {
        settledCalls++;
        lastSettledPositions = p;
      },
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
      ],
      [{ source: 'agent-1', target: 'tools-1' }],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['tools-1', { x: 564, y: 0 }],
      ]),
    );

    // Synchronous settle: no frame was ever scheduled and the sim is already
    // settled immediately after restart.
    expect(harness.pending).toBe(0);
    expect(sim.isRunning()).toBe(false);
    expect(sim.isSettled()).toBe(true);
    // onTick and onSettled each fired exactly once, with the final positions.
    expect(tickCalls).toBe(1);
    expect(settledCalls).toBe(1);
    expect(lastSettledPositions).not.toBeNull();

    // The synchronous loop actually ran the forces — the companion moved off
    // its seed to a finite, non-overlapping position.
    const toolsPos = sim.positions().get('tools-1')!;
    expect(toolsPos).not.toEqual({ x: 564, y: 0 });
    expect(Number.isFinite(toolsPos.x)).toBe(true);
    expect(Number.isFinite(toolsPos.y)).toBe(true);

    // start() after a snap is a no-op — nothing further is scheduled and
    // positions stay byte-identical.
    const snapshot = sim.positions();
    sim.start();
    harness.frame();
    expect(harness.pending).toBe(0);
    expect(sim.positions()).toEqual(snapshot);
  });

  it('snapToSettled caps the synchronous loop at maxIterations', () => {
    const runSnap = (maxIterations?: number) => {
      const harness = createFrameHarness();
      const sim = createLiveForceSimulation({
        scheduleTick: harness.scheduleTick,
        cancelTick: harness.cancelTick,
        random: seededRandom(42),
        snapToSettled: true,
        maxIterations,
      });
      sim.restart(
        [
          { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
          { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
        ],
        [{ source: 'agent-1', target: 'tools-1' }],
        new Map([
          ['agent-1', { x: 0, y: 0 }],
          ['tools-1', { x: 564, y: 0 }],
        ]),
      );
      return { harness, sim };
    };

    // A single-tick cap leaves the companion measurably off its full-settle
    // position — proving the loop was bounded by maxIterations (not alpha).
    const capped = runSnap(1);
    expect(capped.harness.pending).toBe(0);
    expect(capped.sim.isSettled()).toBe(true);

    const full = runSnap(undefined); // default 300
    expect(full.sim.positions().get('tools-1')).not.toEqual(capped.sim.positions().get('tools-1'));
    expect(full.harness.pending).toBe(0);
  });

  // ── #2756 DELIBERATE UPDATE: two-exchange disjoint cohesion (REQ-2) ──
  //
  // The #2754 ST-5 multi-pin chain test is DELIBERATELY rewritten: the whole
  // chat spine is no longer fx/fy-pinned. Every node is a sim body and the
  // positioning forces pull each EXCHANGE (chat + its tools + its subagents)
  // toward its own forceX/forceY anchor — the Bostock disjoint pattern. The
  // rewritten test asserts the disjoint invariants instead of pinning:
  //  (a) NO node id stays byte-identical at its seed through settle — every
  //      node (chat included) is a sim body (REQ-1);
  //  (b) after settle, exchange-internal pairs are closer than any
  //      cross-exchange pair — max intra-exchange distance < min inter-exchange
  //      distance (REQ-2 — each exchange is its own connected component that
  //      drifts into its own blob);
  //  (c) each exchange's nodes cluster around their shared anchor — within a
  //      bounded region of the anchor (REQ-3 viewport containment analogue).

  it('#2756 DELIBERATE UPDATE: two-exchange disjoint cohesion — every node is a sim body and each exchange settles as its own blob (max intra < min inter distance, REQ-1/REQ-2/REQ-3)', () => {
    const harness = createFrameHarness();
    let settledCalls = 0;
    // Positioning targets = one anchor per exchange (the computeExchangeAnchors
    // contract): exchange-1 (agent-1 + tools-1) at (-500, 0), exchange-2
    // (agent-2 + subagent-2) at (+500, 0). Weak strength (the exported
    // FORCE_POSITION_STRENGTH) so link/charge/collide keep the organic feel.
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      forceX: (n) => (n.id === 'agent-1' || n.id === 'tools-1' ? -500 : 500),
      forceY: () => 0,
      forceXStrength: FORCE_POSITION_STRENGTH,
      forceYStrength: FORCE_POSITION_STRENGTH,
      onSettled: () => {
        settledCalls++;
      },
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
        { id: 'subagent-2', status: 'in-progress', type: 'subagent', depth: 1 },
      ],
      [
        { source: 'agent-1', target: 'tools-1' },
        { source: 'agent-2', target: 'subagent-2' },
      ],
      new Map([
        // All four seeded coincident — the seed is applied at restart (EARS-4)
        // but NO node is pinned there (REQ-1: no fx/fy freezing).
        ['agent-1', { x: 0, y: 0 }],
        ['agent-2', { x: 0, y: 0 }],
        ['tools-1', { x: 0, y: 0 }],
        ['subagent-2', { x: 0, y: 0 }],
      ]),
    );

    // Seed contract (EARS-4): the seed is authoritative immediately after
    // restart — before the first frame every node sits at its seed.
    expect(sim.positions().get('agent-1')).toEqual({ x: 0, y: 0 });
    expect(sim.positions().get('agent-2')).toEqual({ x: 0, y: 0 });

    // Intermediate ticks: NO node stays pinned at the coincident seed — after a
    // few frames every node (chat included) has moved off it.
    harness.frame();
    harness.frame();
    harness.frame();
    for (const id of ['agent-1', 'agent-2', 'tools-1', 'subagent-2']) {
      expect(sim.positions().get(id)!).not.toEqual({ x: 0, y: 0 });
    }

    harness.drain();
    expect(sim.isSettled()).toBe(true);
    expect(settledCalls).toBe(1);

    const pos = (id: string) => sim.positions().get(id)!;
    // REQ-1: the chat nodes did NOT settle at the old chain slots — they sit at
    // force-simulated coordinates (never (0,0), never a chain column).
    expect(pos('agent-1')).not.toEqual({ x: 0, y: 0 });
    expect(pos('agent-2')).not.toEqual({ x: 0, y: 0 });

    // REQ-2 cohesion: exchange-internal pairs are closer than ANY cross-exchange
    // pair after settle (the disjoint requirement — clusters separate).
    const intraMax = Math.max(
      distance(pos('agent-1'), pos('tools-1')),
      distance(pos('agent-2'), pos('subagent-2')),
    );
    const interMin = Math.min(
      distance(pos('agent-1'), pos('agent-2')),
      distance(pos('agent-1'), pos('subagent-2')),
      distance(pos('tools-1'), pos('agent-2')),
      distance(pos('tools-1'), pos('subagent-2')),
    );
    expect(intraMax).toBeLessThan(interMin);

    // REQ-3: each exchange's nodes cluster around their shared anchor — within
    // a bounded region of the anchor (the anchor arrangement keeps clusters in
    // the viewport; charge/collide keep them at least one node-width apart).
    expect(distance(pos('agent-1'), { x: -500, y: 0 })).toBeLessThan(400);
    expect(distance(pos('tools-1'), { x: -500, y: 0 })).toBeLessThan(400);
    expect(distance(pos('agent-2'), { x: 500, y: 0 })).toBeLessThan(400);
    expect(distance(pos('subagent-2'), { x: 500, y: 0 })).toBeLessThan(400);
    sim.stop();
  });

  // ── #2756 round-11 (AC2): full live-fixture-shape cohesion (REQ-2) ──
  //
  // The round-10 tester measured the FULL clean-slate fixture
  // (`ses_fd8c5b0feffeeO9osQYY1EgNn2`: 5 agentNodes + 2 ToolsNodes + 1
  // SubagentNode, pane 1708×947.5) and found the cohesion inequality STILL
  // failing LIVE: E3 (chat _9 + subagent _7) 453.71 vs 412.42, E4 (chat _13 +
  // tools _13) 462.77 vs 353.77, E5 (chat _16 + tools _16) 585.26 vs 720.30.
  // The round-10 fix (full-pane golden-angle ellipse + FORCE_POSITION_STRENGTH
  // 1.5 + charge 0.08 + collide 0.86) passed the harness with 5-10px margins
  // but the LIVE inter-exchange distances were much smaller (353-412 live vs
  // 416-477 harness): the live settle had taken the FALLBACK-pane path
  // (VIEWPORT_BOUNDS 2400×1600 while the pane measurement was pending, then a
  // restart seeded from the fallback-settled positions) — a DIFFERENT
  // equilibrium the harness did not model. Round-11 fixes BOTH sides:
  // (1) the hook now DEFERS the Force sim until the real pane is measured
  // (the fallback→restart path is never taken — see useMissionMonitor.ts);
  // (2) the anchor geometry + force recipe are retuned so the cohesion
  // inequality holds with a COMFORTABLE margin on the real-pane settle:
  //   - computeExchangeAnchors: the round-10 golden-angle spiral (adjacent
  //     anchors ~313px apart — smaller than an exchange's members) is replaced
  //     by a 2-ROW STAGGERED grid (3 top slots across ±(halfW×0.8) at
  //     y=−rowY, 2 bottom slots at HALF the offsets at y=+rowY) whose minimum
  //     pairwise slot distance (~596-651px on the real pane) exceeds the
  //     measured intra (~305-343px);
  //   - FORCE_POSITION_STRENGTH 1.5 → 10 (clusters hug their anchors);
  //   - FORCE_LINK_DISTANCE 600 → 440 (members settle at the collide floor);
  //   - FORCE_COLLIDE_SCALE 0.86 → 0.7 (intra ~305-343px);
  //   - FORCE_CHARGE_SCALE 0.08 → 0.02 (an arriving companion is never
  //     deflected across a neighbor exchange — the incremental-build failure
  //     mode).
  // This test pins the ENTIRE tuned recipe on the full fixture shape inside
  // the REAL pane bounds: the cohesion inequality must hold for EVERY
  // exchange, containment must stay within |x| ≤ paneWidth/2 + 100 AND
  // |y| ≤ paneHeight/2 + 100 (AC3), and the sim must settle (freeze, AC4).
  // Deterministic venue: injected rAF harness + seeded random (d3 jiggle is
  // negligible at these distinct seeds) + the hook's REAL Chain→Force seed
  // (chats at the chain column, tools at +564, subagent at −564 — the actual
  // seed the live sim receives on toggle).
  it('#2756 round-11 (AC2): the FULL live-fixture shape (5 agent + 2 tools + 1 subagent) settles with max intra-exchange < min inter-exchange for EVERY exchange inside the REAL pane bounds — the tuned recipe (FORCE_POSITION_STRENGTH 10 + FORCE_LINK_DISTANCE 440 + FORCE_CHARGE_SCALE 0.02 + FORCE_COLLIDE_SCALE 0.7 + the 2-row staggered anchors) replaces the round-10 packed clusters', () => {
    const REAL_PANE = { width: 1708, height: 947.5 };
    const nodes: LayoutNode[] = [
      { id: 'agent-3', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-7', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-9', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-13', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-16', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'subagent-7', status: 'in-progress', type: 'subagent', depth: 1 },
      { id: 'tools-13', status: 'in-progress', type: 'tools', depth: 1 },
      { id: 'tools-16', status: 'in-progress', type: 'tools', depth: 1 },
    ];
    // Exchange edge set — chat→tools + chat→subagent links only (chat→chat
    // edges are excluded upstream in the hook — AC2 preserved invariant).
    const edges: LayoutEdge[] = [
      { source: 'agent-9', target: 'subagent-7' },
      { source: 'agent-13', target: 'tools-13' },
      { source: 'agent-16', target: 'tools-16' },
    ];
    // Exchange membership (edge-identified, round-9): E1={agent-3},
    // E2={agent-7}, E3={agent-9,subagent-7}, E4={agent-13,tools-13},
    // E5={agent-16,tools-16}.
    const exchangeOf: Record<string, string> = {
      'agent-3': 'E1',
      'agent-7': 'E2',
      'agent-9': 'E3',
      'subagent-7': 'E3',
      'agent-13': 'E4',
      'tools-13': 'E4',
      'agent-16': 'E5',
      'tools-16': 'E5',
    };

    const harness = createFrameHarness();
    // The REAL hook wiring (useMissionMonitor.ts:2082-2113): anchors from the
    // measured pane, forceX/forceY reading the per-exchange anchors, the
    // exported strengths/scales + link distance, containmentBounds = the same
    // pane.
    const anchors = computeExchangeAnchors(nodes, edges, REAL_PANE);
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      forceX: (n) => anchors.get(n.id)?.x ?? 0,
      forceY: (n) => anchors.get(n.id)?.y ?? 0,
      forceXStrength: FORCE_POSITION_STRENGTH,
      forceYStrength: FORCE_POSITION_STRENGTH,
      chargeScale: FORCE_CHARGE_SCALE,
      collideScale: FORCE_COLLIDE_SCALE,
      linkDistance: FORCE_LINK_DISTANCE,
      containmentBounds: REAL_PANE,
    });

    // The Chain→Force toggle seed (the hook seeds layoutPositionsRef from the
    // chain branch: chats at CHAIN_X_CENTER stacked by measured-height+gap,
    // tools at TOOLS_CHAIN_X=564 at the parent y, subagents at −564).
    const seed = new Map<string, { x: number; y: number }>();
    const STEP = DEFAULT_NODE_HEIGHT + CHAIN_GAP;
    let y = 0;
    for (const id of ['agent-3', 'agent-7', 'agent-9', 'agent-13', 'agent-16']) {
      seed.set(id, { x: 0, y });
      y += STEP;
    }
    seed.set('tools-13', { x: TOOLS_CHAIN_X, y: seed.get('agent-13')!.y });
    seed.set('tools-16', { x: TOOLS_CHAIN_X, y: seed.get('agent-16')!.y });
    seed.set('subagent-7', { x: SUBAGENT_CHAIN_X, y: seed.get('agent-9')!.y });

    sim.restart(nodes, edges, seed);
    const frames = harness.drain();
    expect(frames).toBeGreaterThan(0);
    expect(sim.isSettled()).toBe(true);
    expect(harness.pending).toBe(0);

    const pos = (id: string) => sim.positions().get(id)!;
    const ids = nodes.map((n) => n.id);

    // AC3: every node inside the real pane bounds (+100 slack).
    for (const id of ids) {
      const p = pos(id);
      expect(Math.abs(p.x), `${id} |x|`).toBeLessThanOrEqual(REAL_PANE.width / 2 + 100);
      expect(Math.abs(p.y), `${id} |y|`).toBeLessThanOrEqual(REAL_PANE.height / 2 + 100);
    }

    // AC2: max intra-exchange distance < min inter-exchange distance for EVERY
    // exchange (the round-9 FAIL — a deterministic per-exchange table; never
    // exact coordinates — d3 settle is stochastic).
    for (const label of ['E1', 'E2', 'E3', 'E4', 'E5']) {
      const members = ids.filter((id) => exchangeOf[id] === label);
      let intra = 0;
      if (members.length >= 2) {
        intra = Math.max(
          ...members.flatMap((a, i) =>
            members.slice(i + 1).map((b) => distance(pos(a), pos(b))),
          ),
        );
      }
      const inter = Math.min(
        ...ids.filter((id) => exchangeOf[id] !== label).map((id) =>
          Math.min(...members.map((m) => distance(pos(m), pos(id)))),
        ),
      );
      expect(intra, `${label} intra=${intra.toFixed(2)} inter=${inter.toFixed(2)} — max intra-exchange must be < min inter-exchange`).toBeLessThan(inter);
    }

    // The round-10 failing exchanges hold with a comfortable margin — E3
    // (subagent) no longer sits ~453px from its chat; E4/E5 (tools) settle at
    // ~305px (not 462-585px).
    const e3Intra = distance(pos('agent-9'), pos('subagent-7'));
    const e4Intra = distance(pos('agent-13'), pos('tools-13'));
    const e5Intra = distance(pos('agent-16'), pos('tools-16'));
    expect(e3Intra).toBeLessThan(400);
    expect(e4Intra).toBeLessThan(360);
    expect(e5Intra).toBeLessThan(360);
    sim.stop();
  });

  it('#2756 round-11 (AC2): the tuned cohesion recipe is robust across injected random sources and the empty (fresh-graph) seed — the inequality holds for every exchange with ANY jiggle (the live settle uses Math.random)', () => {
    const REAL_PANE = { width: 1708, height: 947.5 };
    const nodes: LayoutNode[] = [
      { id: 'agent-3', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-7', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-9', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-13', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'agent-16', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'subagent-7', status: 'in-progress', type: 'subagent', depth: 1 },
      { id: 'tools-13', status: 'in-progress', type: 'tools', depth: 1 },
      { id: 'tools-16', status: 'in-progress', type: 'tools', depth: 1 },
    ];
    const edges: LayoutEdge[] = [
      { source: 'agent-9', target: 'subagent-7' },
      { source: 'agent-13', target: 'tools-13' },
      { source: 'agent-16', target: 'tools-16' },
    ];
    const exchangeOf: Record<string, string> = {
      'agent-3': 'E1',
      'agent-7': 'E2',
      'agent-9': 'E3',
      'subagent-7': 'E3',
      'agent-13': 'E4',
      'tools-13': 'E4',
      'agent-16': 'E5',
      'tools-16': 'E5',
    };
    const chainSeedMap = (): Map<string, { x: number; y: number }> => {
      const s = new Map<string, { x: number; y: number }>();
      const STEP = DEFAULT_NODE_HEIGHT + CHAIN_GAP;
      let yy = 0;
      for (const id of ['agent-3', 'agent-7', 'agent-9', 'agent-13', 'agent-16']) {
        s.set(id, { x: 0, y: yy });
        yy += STEP;
      }
      s.set('tools-13', { x: TOOLS_CHAIN_X, y: s.get('agent-13')!.y });
      s.set('tools-16', { x: TOOLS_CHAIN_X, y: s.get('agent-16')!.y });
      s.set('subagent-7', { x: SUBAGENT_CHAIN_X, y: s.get('agent-9')!.y });
      return s;
    };
    const anchors = computeExchangeAnchors(nodes, edges, REAL_PANE);

    const run = (seed: Map<string, { x: number; y: number }>, random: () => number) => {
      const h = createFrameHarness();
      const sim = createLiveForceSimulation({
        scheduleTick: h.scheduleTick,
        cancelTick: h.cancelTick,
        random,
        forceX: (n) => anchors.get(n.id)?.x ?? 0,
        forceY: (n) => anchors.get(n.id)?.y ?? 0,
        forceXStrength: FORCE_POSITION_STRENGTH,
        forceYStrength: FORCE_POSITION_STRENGTH,
        chargeScale: FORCE_CHARGE_SCALE,
        collideScale: FORCE_COLLIDE_SCALE,
        linkDistance: FORCE_LINK_DISTANCE,
        containmentBounds: REAL_PANE,
      });
      sim.restart(nodes, edges, seed);
      h.drain();
      const ids = nodes.map((n) => n.id);
      for (const label of ['E1', 'E2', 'E3', 'E4', 'E5']) {
        const members = ids.filter((id) => exchangeOf[id] === label);
        let intra = 0;
        if (members.length >= 2) {
          intra = Math.max(
            ...members.flatMap((a, i) =>
              members.slice(i + 1).map((b) => distance(sim.positions().get(a)!, sim.positions().get(b)!)),
            ),
          );
        }
        const inter = Math.min(
          ...ids.filter((id) => exchangeOf[id] !== label).map((id) =>
            Math.min(...members.map((m) => distance(sim.positions().get(m)!, sim.positions().get(id)!))),
          ),
        );
        expect(intra, `${label} with ${random === seededRandom(42) ? 'seed42' : 'seed7'}`).toBeLessThan(inter);
      }
      sim.stop();
    };

    run(chainSeedMap(), seededRandom(42));
    run(chainSeedMap(), seededRandom(7));
    run(chainSeedMap(), seededRandom(99));
    run(new Map(), seededRandom(42));
  });

  it('#2756 DELIBERATE UPDATE: restart seeds from the CURRENT positions — NO re-pin (the #2754 chain re-stack re-pin is gone; every node keeps its current spot through the restart seed and glides onward)', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      forceX: () => 0,
      forceY: () => 0,
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
      ],
      [{ source: 'agent-1', target: 'tools-1' }],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['tools-1', { x: 564, y: 0 }],
      ]),
    );
    // Let the first run move both nodes off their seeds (nothing is pinned).
    harness.frame();
    harness.frame();
    harness.frame();
    const agentBefore = sim.positions().get('agent-1')!;
    const companionBefore = sim.positions().get('tools-1')!;
    expect(agentBefore).not.toEqual({ x: 0, y: 0 });
    expect(companionBefore).not.toEqual({ x: 564, y: 0 });

    // A restart (structural change / heightsChanged) seeds BOTH nodes at their
    // CURRENT positions — the seed map is authoritative (EARS-4: no jump, no
    // rebuild-from-scratch). NO node is re-pinned to a new chain slot: the
    // seed for the chat node is its current force position, not a chain column.
    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tool', depth: 1 },
      ],
      [{ source: 'agent-1', target: 'tools-1' }],
      new Map([
        ['agent-1', agentBefore],
        ['tools-1', companionBefore],
      ]),
    );

    // IMMEDIATELY after restart the seed is authoritative: both nodes sit at
    // their exact pre-restart positions (no jump, no re-pin to a chain slot).
    expect(sim.positions().get('agent-1')).toEqual(agentBefore);
    expect(sim.positions().get('tools-1')).toEqual(companionBefore);
    // Through further ticks BOTH nodes continue to glide (the chat node is NOT
    // held at its seed — it is a sim body; the #2754 re-pin is gone).
    harness.frame();
    harness.frame();
    expect(sim.positions().get('agent-1')).not.toEqual(agentBefore);
    expect(sim.positions().get('tools-1')).not.toEqual(companionBefore);
    sim.stop();
  });
});

// ── #2756 ST-2/ST-3: computeExchangeAnchors (per-exchange positioning anchors) ─
//
// #2756 DELIBERATE UPDATE: the #2754 ST-3 companion halo-band constants +
// clampSettledCompanions describes are DELETED — those exported the hybrid's
// chain-anchored geometry (CHAIN_BAND_*, COMPANION_HALO_*, COMPANION_*_DISTANCE,
// clampSettledCompanions), ALL removed in ST-1/ST-2 with the chain spine. They
// are replaced by unit tests for the NEW disjoint mechanism:
// computeExchangeAnchors — one bounded forceX/forceY target per EXCHANGE
// (connected component of the exchange edge set), arranged inside the framable
// viewport region so settled clusters stay on-canvas (REQ-3). Pure +
// deterministic (same inputs → same anchors), so exact coordinates ARE asserted
// here (unlike the stochastic d3 settle, which is asserted by inequalities).

describe('computeExchangeAnchors (#2756 ST-2)', () => {
  // Round-3 (AC3): the anchor spiral is centered at the flow origin (0,0) —
  // the pane center after fitView frames the graph — and clamped to the passed
  // pane half-extents, so every anchor satisfies |x| ≤ bounds.width/2 AND
  // |y| ≤ bounds.height/2 (the pane-relative contract). The old fixed
  // 2400×1600 VIEWPORT_BOUNDS (centered at (1200,800)) was LARGER than the
  // real pane and placed anchors beyond it — settled clusters sat outside the
  // viewport (round-2 AC3 FAIL).
  const bounds = { width: 2400, height: 1600 };

  it('assigns one anchor per connected component of the exchange edge set — chat + its tools + its subagents share a single anchor', () => {
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'tools-1', status: 'in-progress', type: 'tools', depth: 1 },
      { id: 'subagent-1', status: 'in-progress', type: 'subagent', depth: 1 },
    ];
    const edges: LayoutEdge[] = [
      { source: 'agent-1', target: 'tools-1' },
      { source: 'agent-1', target: 'subagent-1' },
    ];

    const anchors = computeExchangeAnchors(nodes, edges, bounds);

    // One exchange → all three nodes pull toward the SAME anchor — the flow
    // origin (0,0), the pane center (the golden-angle spiral radius 0 for a
    // single component; round-3 AC3: pane-relative, NOT the old bounds-center
    // (1200,800) which sat beyond the real pane).
    expect(anchors.get('agent-1')).toEqual({ x: 0, y: 0 });
    expect(anchors.get('tools-1')).toEqual({ x: 0, y: 0 });
    expect(anchors.get('subagent-1')).toEqual({ x: 0, y: 0 });
    expect(anchors.size).toBe(3);
  });

  it('separates distinct exchanges onto distinct anchors inside the pane half-extents — the disjoint requirement (REQ-2/REQ-3)', () => {
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'tools-1', status: 'in-progress', type: 'tools', depth: 1 },
      { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'subagent-2', status: 'in-progress', type: 'subagent', depth: 1 },
    ];
    // chat→chat edges are EXCLUDED upstream (useMissionMonitor.ts:2035-2042) —
    // each exchange is its own connected component.
    const edges: LayoutEdge[] = [
      { source: 'agent-1', target: 'tools-1' },
      { source: 'agent-2', target: 'subagent-2' },
    ];

    const anchors = computeExchangeAnchors(nodes, edges, bounds);

    // Exchange-1's nodes share exchange-1's anchor; exchange-2's nodes share
    // exchange-2's anchor; the two anchors are DISTINCT (clusters separate).
    const a1 = anchors.get('agent-1');
    expect(anchors.get('tools-1')).toEqual(a1);
    const a2 = anchors.get('agent-2');
    expect(anchors.get('subagent-2')).toEqual(a2);
    expect(a1).not.toEqual(a2);

    // Round-3 pane-relative contract: every anchor lies within the PASSED
    // bounds' half-extents — |x| ≤ bounds.width/2 AND |y| ≤ bounds.height/2
    // (the anchors are relative to the flow origin / pane center, NOT merely
    // inside the [0,width]×[0,height] box — the round-2 AC3 fix).
    for (const anchor of [a1!, a2!]) {
      expect(Math.abs(anchor.x)).toBeLessThanOrEqual(bounds.width / 2);
      expect(Math.abs(anchor.y)).toBeLessThanOrEqual(bounds.height / 2);
    }
  });

  it('treats an isolated node (no edges / dangling-edge anchor absent) as its own single-node exchange with its own anchor', () => {
    // tools-orphan has no edges — a ToolsNode whose anchor chat is absent
    // (dangling edge skipped: both endpoints must be real nodes). It must
    // still get an anchor so the single-node cluster drifts somewhere bounded.
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'tools-orphan', status: 'in-progress', type: 'tools', depth: 1 },
    ];
    const edges: LayoutEdge[] = [{ source: 'agent-1', target: 'tools-missing' }];

    const anchors = computeExchangeAnchors(nodes, edges, bounds);

    expect(anchors.size).toBe(2);
    // The dangling edge was skipped → agent-1 is its own exchange and the
    // orphan its own exchange — distinct anchors, both within the pane
    // half-extents (round-3 pane-relative contract).
    expect(anchors.get('agent-1')).not.toEqual(anchors.get('tools-orphan'));
    for (const anchor of anchors.values()) {
      expect(Math.abs(anchor.x)).toBeLessThanOrEqual(bounds.width / 2);
      expect(Math.abs(anchor.y)).toBeLessThanOrEqual(bounds.height / 2);
    }
  });

  it('is pure and deterministic — the same inputs always yield the same anchors (never random, never mutating)', () => {
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'tools-1', status: 'in-progress', type: 'tools', depth: 1 },
      { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'subagent-2', status: 'in-progress', type: 'subagent', depth: 1 },
    ];
    const edges: LayoutEdge[] = [
      { source: 'agent-1', target: 'tools-1' },
      { source: 'agent-2', target: 'subagent-2' },
    ];

    const first = computeExchangeAnchors(nodes, edges, bounds);
    const second = computeExchangeAnchors(nodes, edges, bounds);
    expect(second).toEqual(first);

    // The input arrays were not mutated.
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(2);
  });

  it('handles the empty graph: no nodes → no anchors', () => {
    expect(computeExchangeAnchors([], [], bounds).size).toBe(0);
  });

  it('#2756 round-3 (AC3): places EVERY anchor within the REAL pane half-extents — |x| ≤ paneWidth/2 AND |y| ≤ paneHeight/2 (the live pane is ~1708×947.5, NOT the fixed 2400×1600 — the round-2 defect was anchors beyond the real pane)', () => {
    // The round-2 live pane (1708×947.5): the old fixed VIEWPORT_BOUNDS
    // (2400×1600) centered the spiral at (1200,800) — ~350px right + down of
    // the real pane center — so anchors (and the settled clusters orbiting
    // them) sat outside the viewport (observed x=1808.13, y=1590.52 vs the
    // AC3 bound |x| ≤ 954, |y| ≤ 573.75). The hook now passes the measured
    // pane; every anchor must lie within the pane half-extents.
    const realPane = { width: 1708, height: 947.5 };
    const nodes: LayoutNode[] = [
      { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'tools-1', status: 'in-progress', type: 'tools', depth: 1 },
      { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      { id: 'subagent-2', status: 'in-progress', type: 'subagent', depth: 1 },
    ];
    const edges: LayoutEdge[] = [
      { source: 'agent-1', target: 'tools-1' },
      { source: 'agent-2', target: 'subagent-2' },
    ];

    const anchors = computeExchangeAnchors(nodes, edges, realPane);

    // Pane-relative: every anchor within the passed bounds' half-extents —
    // the anchors ARE the forceX/forceY targets in flow coords (origin = pane
    // center after fitView), so the settled clusters they pull toward stay
    // inside the framable region (REQ-3 / the human's "stays inside the
    // viewport" requirement).
    for (const anchor of anchors.values()) {
      expect(Math.abs(anchor.x)).toBeLessThanOrEqual(realPane.width / 2);
      expect(Math.abs(anchor.y)).toBeLessThanOrEqual(realPane.height / 2);
    }
    // Non-trivial: the multi-exchange spiral actually USES the real pane —
    // at least one anchor sits measurably off the center (exchanges distribute
    // across the pane rather than piling at the origin).
    const offCenter = [...anchors.values()].some(
      (a) => Math.abs(a.x) > 1 || Math.abs(a.y) > 1,
    );
    expect(offCenter).toBe(true);
  });

  it('#2756 round-3 (AC3): zero/unknown pane bounds degrade to the SAFE in-pane origin — every anchor at (0,0), never NaN (the hook falls back to VIEWPORT_BOUNDS before this, but the pure helper must not explode on a degenerate input)', () => {
    const anchors = computeExchangeAnchors(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tools', depth: 1 },
      ],
      [{ source: 'agent-1', target: 'tools-1' }],
      { width: 0, height: 0 },
    );

    expect(anchors.size).toBe(2);
    for (const anchor of anchors.values()) {
      expect(Number.isFinite(anchor.x)).toBe(true);
      expect(Number.isFinite(anchor.y)).toBe(true);
      // maxRadius = 0 → the spiral collapses to the pane center (the flow
      // origin) — a safe in-pane region (the hook's VIEWPORT_BOUNDS fallback
      // normally prevents reaching this with a larger region).
      expect(anchor).toEqual({ x: 0, y: 0 });
    }
  });
});

// ── #2756 ST-1/ST-3: forceX/forceY positioning-force options ─────────────────
//
// #2756 DELIBERATE UPDATE: the #2754 per-depth forceY + forceCenter recipe is
// gone; the live sim now takes per-node forceX/forceY POSITIONING targets
// (one anchor pair per exchange) with configurable strengths. These unit tests
// pin the new option surface: forceX / forceY targets and forceXStrength /
// forceYStrength. Exact settle coordinates stay OUT (d3 settle is stochastic)
// — assertions use order/bound inequalities, and byte-identical determinism is
// covered by the injected-random equality pattern above.

describe('createLiveForceSimulation forceX/forceY positioning options (#2756 ST-1)', () => {
  it('honors the forceX option — per-node target X drives the settled horizontal order', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      forceX: (n) => (n.id === 'agent-1' ? -800 : 800),
      forceXStrength: 0.2,
    });

    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'agent-2', status: 'in-progress', type: 'agent', depth: 0 },
      ],
      [],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['agent-2', { x: 0, y: 0 }],
      ]),
    );

    harness.drain();
    const p1 = sim.positions().get('agent-1')!;
    const p2 = sim.positions().get('agent-2')!;
    // forceX pushes agent-1 toward -800 and agent-2 toward +800 — the
    // persistent X bias must dominate the (symmetric) charge/collide spread.
    expect(p2.x).toBeGreaterThan(p1.x);
    expect(p2.x - p1.x).toBeGreaterThan(200);
  });

  it('honors forceXStrength / forceYStrength — a stronger positioning force pulls the node closer to its target', () => {
    const run = (strength: number) => {
      const harness = createFrameHarness();
      const sim = createLiveForceSimulation({
        scheduleTick: harness.scheduleTick,
        cancelTick: harness.cancelTick,
        random: seededRandom(42),
        forceX: () => 600,
        forceY: () => 400,
        forceXStrength: strength,
        forceYStrength: strength,
      });
      sim.restart(
        [{ id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 }],
        [],
        new Map([['agent-1', { x: 0, y: 0 }]]),
      );
      harness.drain();
      return sim.positions().get('agent-1')!;
    };

    const weak = run(0.01);
    const strong = run(1.0);
    // A single node has no charge/collide partners — the settled position is
    // the positioning-force equilibrium. Stronger strength ⇒ closer to the
    // (600, 400) target.
    expect(strong.x).toBeGreaterThan(weak.x);
    expect(strong.y).toBeGreaterThan(weak.y);
    expect(strong.x).toBeGreaterThan(500);
    expect(strong.y).toBeGreaterThan(300);
  });

  it('#2756 DELIBERATE UPDATE: the forceX/forceY recipe registers NO forceCenter — a lone node drifts toward its positioning target, not the origin', () => {
    // The #2754 recipe used forceCenter(0, 0): a lone node seeded away from
    // the origin with NO positioning forces would drift back toward (0,0).
    // The disjoint recipe REPLACES the center force with per-node forceX/forceY
    // positioning — a lone node must pull toward its anchor instead.
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      forceX: () => 900,
      forceY: () => -700,
      forceXStrength: 0.2,
      forceYStrength: 0.2,
    });
    sim.restart(
      [{ id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 }],
      [],
      new Map([['agent-1', { x: 0, y: 0 }]]),
    );
    harness.drain();
    const p = sim.positions().get('agent-1')!;
    // Settled toward the (900, −700) anchor — NOT pulled back to the origin by
    // a center force (a forceCenter-only sim would settle near (0,0)).
    expect(p.x).toBeGreaterThan(600);
    expect(p.y).toBeLessThan(-400);
  });
});

// ── #2756 round-4 (AC3): bounded pane containment (wall force + read clamp) ──
//
// The round-3 fix made the exchange anchors pane-relative, but the SETTLED
// clusters still orbited far off them — link distance 600 + charge −600 +
// collide 270/270/240/210 dominate the weak 0.1 positioning force, so a
// multi-exchange live session settled nodes at y=876/681 on a pane whose
// half-height is 474 (the round-3 AC3 FAIL). The round-4 fix adds a BOUNDED
// CONTAINMENT PULL: a wall force clamps every node to the pane half-extents
// and zeroes outward velocity, and every position read is projected into the
// same region. These tests pin that contract — a node whose forces would
// otherwise settle it far outside the pane is contained within
// |x| ≤ paneWidth/2, |y| ≤ paneHeight/2 (the AC3 +100px slack stays free).

describe('createLiveForceSimulation bounded pane containment (#2756 round-4)', () => {
  const REAL_PANE = { width: 1708, height: 948 };

  it('containmentBounds clamps a settled node to the pane half-extents when link/charge would push it far outside (AC3)', () => {
    // A single linked pair with anchors far outside the pane (as the OLD
    // 2400×1600 spiral produced for the real 1708×948 pane). Without
    // containment the nodes settle near their off-pane anchors; with the wall
    // every reported position stays within |x| ≤ 854, |y| ≤ 474.
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(7),
      forceX: () => 700,
      forceY: () => 600,
      forceXStrength: 0.3,
      forceYStrength: 0.3,
      containmentBounds: REAL_PANE,
    });
    sim.restart(
      [
        { id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 },
        { id: 'tools-1', status: 'in-progress', type: 'tools', depth: 1 },
      ],
      [{ source: 'agent-1', target: 'tools-1' }],
      new Map([
        ['agent-1', { x: 0, y: 0 }],
        ['tools-1', { x: 300, y: 300 }],
      ]),
    );
    harness.drain();
    for (const id of ['agent-1', 'tools-1']) {
      const p = sim.positions().get(id)!;
      expect(Math.abs(p.x)).toBeLessThanOrEqual(REAL_PANE.width / 2);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(REAL_PANE.height / 2);
    }
  });

  it('containmentBounds resolves a GETTER fresh per read — a pane resize re-clamps without a rebuild (the hook passes () => lastPaneBoundsRef.current)', () => {
    // Simulate the hook's paneChanged flow: the sim is created with the
    // VIEWPORT_BOUNDS fallback, then the real pane measurement lands. The
    // getter read at readPositions time must pick up the NEW bounds, so a node
    // that was in-bounds for the fallback (wide) pane is clamped to the real
    // (narrow) pane without calling restart().
    let pane = { width: 2400, height: 1600 };
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(11),
      forceX: () => 1000,
      forceY: () => 800,
      forceXStrength: 0.3,
      forceYStrength: 0.3,
      containmentBounds: () => pane,
    });
    sim.restart(
      [{ id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 }],
      [],
      new Map([['agent-1', { x: 0, y: 0 }]]),
    );
    // Pane measurement arrives (real 1708×948) — no rebuild, the getter alone
    // must re-clamp the reported position.
    pane = REAL_PANE;
    harness.drain();
    const p = sim.positions().get('agent-1')!;
    expect(Math.abs(p.x)).toBeLessThanOrEqual(REAL_PANE.width / 2);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(REAL_PANE.height / 2);
  });

  it('absent containmentBounds is byte-identical to the pre-round-4 recipe — no wall, no clamp (backward-compatible)', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      forceX: () => 900,
      forceY: () => -700,
      forceXStrength: 0.2,
      forceYStrength: 0.2,
    });
    sim.restart(
      [{ id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 }],
      [],
      new Map([['agent-1', { x: 0, y: 0 }]]),
    );
    harness.drain();
    const p = sim.positions().get('agent-1')!;
    // The lone node pulls to its (900, −700) anchor UNCLAMPED — containment
    // disabled means the pre-round-4 behavior is preserved exactly.
    expect(p.x).toBeGreaterThan(600);
    expect(p.y).toBeLessThan(-400);
  });

  it('containmentBounds zero-width/zero-height disables the wall (a degenerate pane never NaN-explodes)', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(5),
      forceX: () => 200,
      forceY: () => 100,
      forceXStrength: 0.2,
      forceYStrength: 0.2,
      containmentBounds: { width: 0, height: 0 },
    });
    sim.restart(
      [{ id: 'agent-1', status: 'in-progress', type: 'agent', depth: 0 }],
      [],
      new Map([['agent-1', { x: 0, y: 0 }]]),
    );
    harness.drain();
    const p = sim.positions().get('agent-1')!;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});
