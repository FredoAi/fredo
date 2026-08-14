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
  resolveRectOverlaps,
  CHAIN_GAP,
  CHAIN_TOP_Y,
  CHAIN_X_CENTER,
  DEFAULT_NODE_HEIGHT,
  AGENT_NODE_HALF_WIDTH,
  AGENT_NODE_MAX_WIDTH,
  TOOLS_GAP,
  TOOLS_CHAIN_X,
  layoutLevelForType,
  TYPE_TO_LEVEL,
} from '../layout';
import type { LayoutNode, LayoutEdge, RectNode, ChainToolsNode } from '../layout';

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
  it('separates two agent nodes at same position by at least 240px', () => {
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

    // Agent collision radius = 120px, so minimum center-to-center
    // separation is 2 × 120px = 240px (non-overlapping circles)
    expect(dist).toBeGreaterThanOrEqual(240);
  });
});

// ── Level-Based Collision Radii ─────────────────────────────────────────────

describe('level-based collision radii', () => {
  it('agent pairs separate more than file pairs at same starting distance', () => {
    // Two agents (charge -600, radius 120) at 50px apart — no edge between them
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

    // Two files (charge -300, radius 60) at 50px apart — no edge between them
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

    // Agents (-600 charge, 120px radius) should repel more strongly than
    // files (-300 charge, 60px radius), resulting in a greater center-to-center
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
    expect(TOOLS_CHAIN_X).toBe(384);
  });

  it('never overlaps the vertical chat chain for ANY chat node width', () => {
    // A chain-anchored chat node spans [CHAIN_X_CENTER, CHAIN_X_CENTER + width]
    // with width up to AGENT_NODE_MAX_WIDTH (360). The tools column x starts at
    // the right edge of the WIDEST chat node + TOOLS_GAP, so even a full-width
    // chat node's right edge (360) leaves a clean TOOLS_GAP before the node.
    expect(TOOLS_CHAIN_X - (CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH)).toBe(TOOLS_GAP);
    // Sanity: the half-width alone would place the slot INSIDE the chat box —
    // the binding geometry must use the full width (NFR-3 zero overlap).
    expect(AGENT_NODE_HALF_WIDTH).toBe(180);
    expect(AGENT_NODE_MAX_WIDTH).toBe(360);
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
