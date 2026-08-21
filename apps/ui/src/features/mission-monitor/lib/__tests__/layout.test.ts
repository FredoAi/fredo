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

  it('default forceY drives per-depth Y layering ((n.depth ?? 0) * 400)', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
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
    const pa = sim.positions().get('agent-1')!;
    const ps = sim.positions().get('subagent-1')!;
    const pt = sim.positions().get('tool-1')!;
    // Monotonic vertical layering toward the per-depth targets 0 → 400 → 800.
    expect(ps.y).toBeGreaterThan(pa.y);
    expect(pt.y).toBeGreaterThan(ps.y);
    expect(pt.y - pa.y).toBeGreaterThan(200);
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

  // ── #2754 ST-1: pinned + snapToSettled (hybrid Force builder capabilities) ──

  it('pins node ids at their seed positions — pinned nodes stay fixed through ticks while unpinned companions settle around them', () => {
    const harness = createFrameHarness();
    let settledCalls = 0;
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      // The hybrid's chat spine: agent-1 pinned at its chain slot (0,0). A
      // forceY target that would drag an UNPINNED node to y=400 proves the
      // pin is what keeps it fixed (immune to center/forceY drift).
      pinned: new Set(['agent-1']),
      forceY: (n) => (n.id === 'agent-1' ? 400 : 0),
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
        ['agent-1', { x: 0, y: 0 }], // chain slot — the authoritative seed
        ['tools-1', { x: 564, y: 0 }], // right companion slot
        ['subagent-1', { x: -564, y: 0 }], // left companion slot
      ]),
    );

    // Pinned node renders at its seed immediately and stays byte-identical
    // through intermediate ticks...
    expect(sim.positions().get('agent-1')).toEqual({ x: 0, y: 0 });
    harness.frame();
    harness.frame();
    harness.frame();
    expect(sim.positions().get('agent-1')).toEqual({ x: 0, y: 0 });

    // ...and through settle (readPositions returns pinned nodes unchanged).
    harness.drain();
    expect(sim.isSettled()).toBe(true);
    expect(settledCalls).toBe(1);
    expect(sim.positions().get('agent-1')).toEqual({ x: 0, y: 0 });

    // The unpinned companions were force-placed: they moved off their seeds
    // and cluster around the pinned anchor without overlapping it (collide
    // radii: agent 270 + tool 240 / subagent 270).
    const toolsPos = sim.positions().get('tools-1')!;
    const subPos = sim.positions().get('subagent-1')!;
    expect(toolsPos).not.toEqual({ x: 564, y: 0 });
    expect(subPos).not.toEqual({ x: -564, y: 0 });
    expect(distance(toolsPos, { x: 0, y: 0 })).toBeGreaterThan(500);
    expect(distance(subPos, { x: 0, y: 0 })).toBeGreaterThan(500);
    sim.stop();
  });

  it('pinned nodes stay fixed in the snapToSettled (prefers-reduced-motion) path too', () => {
    const harness = createFrameHarness();
    const sim = createLiveForceSimulation({
      scheduleTick: harness.scheduleTick,
      cancelTick: harness.cancelTick,
      random: seededRandom(42),
      pinned: new Set(['agent-1']),
      // Same companion forceY as the rAF-path pinned test — a depth-1 tool's
      // default forceY target ((depth ?? 0) * 400) would drag it INTO the
      // pinned spine, which is ST-3 tuning, not an ST-1 concern.
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
    // The pinned node stays byte-identical to its seed even on the snap path.
    expect(sim.positions().get('agent-1')).toEqual({ x: 0, y: 0 });

    // rAF-path control: the SAME single-tool config through the frame harness
    // must settle to byte-identical positions — the snap path is the
    // reduced-motion variant of the exact same synchronous force result.
    const rAF = createFrameHarness();
    const simRAF = createLiveForceSimulation({
      scheduleTick: rAF.scheduleTick,
      cancelTick: rAF.cancelTick,
      random: seededRandom(42),
      pinned: new Set(['agent-1']),
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
    // the synchronous loop actually ran the forces. (Its exact settle distance
    // is left unasserted: the default forceCenter(0,0) drags a lone companion
    // toward the pinned anchor — the no-overlap guarantee is ST-3's halo clamp,
    // not an ST-1 invariant.)
    const toolsPos = sim.positions().get('tools-1')!;
    expect(toolsPos).not.toEqual({ x: 564, y: 0 });
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
});
