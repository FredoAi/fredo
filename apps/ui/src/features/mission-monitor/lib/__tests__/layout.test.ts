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
import { computeForceLayout, computeChatChainPositions, CHAIN_NODE_SPACING } from '../layout';
import type { LayoutNode, LayoutEdge } from '../layout';

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

// ── #2688 ST4: deterministic vertical chat chain ────────────────────────────

describe('computeChatChainPositions (#2688 ST4)', () => {
  it('stacks newer chat nodes above older ones for a single session', () => {
    const positions = computeChatChainPositions([
      { id: 'agent-1', sessionId: 's1' }, // oldest
      { id: 'agent-2', sessionId: 's1' },
      { id: 'agent-3', sessionId: 's1' }, // newest
    ]);

    const p1 = positions.get('agent-1')!;
    const p2 = positions.get('agent-2')!;
    const p3 = positions.get('agent-3')!;

    // Newest (agent-3) on top (smallest y), oldest (agent-1) at the bottom.
    expect(p3.y).toBeLessThan(p2.y);
    expect(p2.y).toBeLessThan(p1.y);
    // Uniform spacing.
    expect(p1.y - p2.y).toBe(CHAIN_NODE_SPACING);
    expect(p2.y - p3.y).toBe(CHAIN_NODE_SPACING);
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

    // Session 1: newest (agent-2) above oldest (agent-1).
    expect(positions.get('agent-2')!.y).toBeLessThan(positions.get('agent-1')!.y);
    // Session 2 is an independent chain — its only node sits at the top.
    expect(positions.get('agent-b1')!.y).toBe(0);
  });
});
