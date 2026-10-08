/**
 * layout.deep-tree.test.ts — #2770 ST-4 (R-12 stress, R-9 determinism;
 * verification support for R-1/R-3/R-6/R-7/R-11): deep-tree layout fixture
 * + integration verification with ST-2's rendering in place.
 *
 * Fixture shape (the plan's R-12 minimums): L3+ (compact-variant) cards,
 * ≥ 3 sibling branches, ≥ 15 total nodes, and consecutive chat nodes whose
 * subagent cards are TALLER than their parent chat node — the exact shape
 * that produced the same-lane collision this spec fixes (a lane-k card
 * anchored to chat i occupying [y_i, y_i + cardHeight] while chat i+1's
 * same-lane card used to start at y_i + chatHeight + CHAIN_GAP).
 *
 * Three legs, per AC3:
 *   (a) initial render — cards UNMEASURED, so every card reserves the
 *       conservative SUBAGENT_CARD_FALLBACK_HEIGHT and unmeasured chat nodes
 *       reserve DEFAULT_NODE_HEIGHT;
 *   (b) measured-height reflow — every card measured (still taller than its
 *       parent chat node); the companion-extent pitch TIGHTENS vs (a) and the
 *       graph still holds zero AABB overlap;
 *   (c) full rebuild determinism — repeated layouts (initial/reflow/rebuild)
 *       over identical inputs yield IDENTICAL position sets (R-9, pure
 *       closed-form math — asserted via position-set equality).
 *
 * Plus the two frozen geometry pins:
 *   - width-variance pin (candidate (d) closed-form freeze): lane step
 *     564 > max card width 540 ⇒ ≥24px horizontal clearance between adjacent
 *     lanes — a future max-width change fails loudly here;
 *   - nested-tier placement pin: NESTED_TIER_INDENT_Y = 64 per level below L1,
 *     L1 cards flush with their parent chat node's y (R-3).
 *
 * The layout runner below mirrors the hook's integration EXACTLY
 * (useMissionMonitor.ts): computeCompanionExtents over the shared
 * ChainSubagentNode entries → ChainAgent.companionExtent →
 * computeChatChainPositions → computeSubagentChainPositions. Rects use the
 * same fallbacks the chain math reserves (chat: DEFAULT_NODE_HEIGHT, card:
 * SUBAGENT_CARD_FALLBACK_HEIGHT) with the MAX node widths (540 both), so the
 * AABB check is conservative.
 *
 * ST-2 integration verification (bottom describe): the nested accent swap +
 * 3px inset tier stripe must be LAYOUT-NEUTRAL — after normalizing the
 * accent-var swap and stripping the stripe prefix, EVERY inline style value
 * in the rendered node tree is byte-identical between an L1 and a nested
 * (depth 2) card, i.e. no sizing/layout property changes ⇒ measured heights
 * are unaffected (the stripe paints INSIDE the card rect via inset
 * box-shadow; border stays the neutral #2748 contract).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';
import type { CSSProperties } from 'react';
import type { NodeProps } from 'reactflow';
import {
  computeChatChainPositions,
  computeSubagentChainPositions,
  computeCompanionExtents,
  CHAIN_GAP,
  CHAIN_TOP_Y,
  CHAIN_X_CENTER,
  DEFAULT_NODE_HEIGHT,
  NESTED_TIER_INDENT_Y,
  SUBAGENT_CARD_FALLBACK_HEIGHT,
  SUBAGENT_CHAIN_X,
  SUBAGENT_GAP,
  SUBAGENT_NODE_MAX_WIDTH,
  AGENT_NODE_MAX_WIDTH,
  COMPANION_GAP,
  type ChainSubagentNode,
} from '../layout';
import type { MonitorNodeData } from '../../types';
import { SubagentNode } from '../../components/nodes/SubagentNode';

// SubagentNode renders ReactFlow Handles — stub them so the node can be
// asserted in isolation (same stub as SubagentNode.test.tsx).
vi.mock('reactflow', () => ({
  Handle: ({ id, type, position, style }: { id?: string; type?: string; position?: string; style?: CSSProperties }) =>
    createElement('div', {
      'data-testid': `handle-${id ?? 'default'}`,
      'data-type': type,
      'data-position': position,
      style,
    }),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

// The vitest config does not enable `globals` — explicit cleanup (the two
// SubagentNode renders below coexist for the style diff).
afterEach(() => cleanup());

/** R-6 clearance margin (graph-coordinate px) — the plan's binding value. */
const CLEARANCE_PX = 24;

/** R-12 minimums — the fixture FAILS ITS OWN SHAPE ASSERTIONS if it shrinks. */
const MIN_TOTAL_NODES = 15;
const MIN_SIBLING_BRANCHES = 3;
const MIN_L3_PLUS_CARDS = 2;

// ── The deep-tree fixture ─────────────────────────────────────────────────────
//
// Session 'ses-2770-deep', chat chain (arrival order):
//
//   agent-c1 (360px) ── branch A: sa-a (L1) → sa-a0 (L2) → sa-a0x (L3) → sa-a0xy (L4)
//                    │             └→ sa-a1 (L2)
//                    │   branch B: sa-b (L1) → sa-b0 (L2) → sa-b0x (L3)
//                    │   branch C: sa-c (L1) → sa-c0 (L2)
//   agent-c2 (314px) ── sa-d (L1, flat tall card)
//   agent-c3 (380px) ── sa-e (L1) → sa-e0 (L2)
//   agent-c4 (320px) ── (no companions)
//
// 4 chat + 13 subagent = 17 nodes; 3 sibling branches under agent-c1 (5 L1
// dispatches total); 3 L3+ cards (sa-a0x, sa-a0xy, sa-b0x — the compact
// variant class); every anchoring chat node's tallest card (620-660px
// measured, 640px fallback) exceeds its chat height.

/** Measured card heights (reflow leg) — all TALLER than their parent chat
 *  node and all BELOW the 640px fallback so the measured pitch strictly
 *  tightens vs the initial render (leg (a) → leg (b)). */
const MEASURED_CARD_HEIGHTS: Record<string, number> = {
  'subagent-sa-a': 620,
  'subagent-sa-a0': 580,
  'subagent-sa-a1': 600,
  'subagent-sa-a0x': 560,
  'subagent-sa-a0xy': 540,
  'subagent-sa-b': 610,
  'subagent-sa-b0': 590,
  'subagent-sa-b0x': 570,
  'subagent-sa-c': 600,
  'subagent-sa-c0': 580,
  'subagent-sa-d': 620,
  'subagent-sa-e': 610,
  'subagent-sa-e0': 590,
};

export interface DeepTreeFixture {
  sessionId: string;
  /** Chat nodes in arrival order (oldest first). */
  chats: Array<{ id: string; sessionId: string; height?: number }>;
  /** Companion entries (id/parentId/index) for BOTH placement and extents. */
  subagents: ChainSubagentNode[];
  /** Delegation depth per card id (L1 dispatch = 1). */
  depthOf: Map<string, number>;
  /** Root chat node id per card id (the extent anchor). */
  rootChatOf: Map<string, number>;
}

/** Builds the R-12 deep-tree fixture. Exported so hook-level tests can
 *  consume the SAME tree (single-sourced fixture). */
export function buildDeepTreeFixture(): DeepTreeFixture {
  const sessionId = 'ses-2770-deep';
  const chats = [
    { id: 'agent-c1', sessionId, height: 360 },
    { id: 'agent-c2', sessionId, height: 314 },
    { id: 'agent-c3', sessionId, height: 380 },
    { id: 'agent-c4', sessionId, height: 320 },
  ];
  const subagents: ChainSubagentNode[] = [
    // Branch A under agent-c1 (wide + deep: reaches L4).
    { id: 'subagent-sa-a', parentId: 'agent-c1', index: 0 },
    { id: 'subagent-sa-a0', parentId: 'subagent-sa-a', index: 0 },
    { id: 'subagent-sa-a1', parentId: 'subagent-sa-a', index: 1 },
    { id: 'subagent-sa-a0x', parentId: 'subagent-sa-a0', index: 0 },
    { id: 'subagent-sa-a0xy', parentId: 'subagent-sa-a0x', index: 0 },
    // Branch B under agent-c1 (deep: reaches L3).
    { id: 'subagent-sa-b', parentId: 'agent-c1', index: 1 },
    { id: 'subagent-sa-b0', parentId: 'subagent-sa-b', index: 0 },
    { id: 'subagent-sa-b0x', parentId: 'subagent-sa-b0', index: 0 },
    // Branch C under agent-c1 (shallow sibling — proves band separation).
    { id: 'subagent-sa-c', parentId: 'agent-c1', index: 2 },
    { id: 'subagent-sa-c0', parentId: 'subagent-sa-c', index: 0 },
    // agent-c2: one flat tall card (the same-lane collision shape).
    { id: 'subagent-sa-d', parentId: 'agent-c2', index: 0 },
    // agent-c3: L1 + nested L2.
    { id: 'subagent-sa-e', parentId: 'agent-c3', index: 0 },
    { id: 'subagent-sa-e0', parentId: 'subagent-sa-e', index: 0 },
  ];

  // Depth + root-chat walks over the parent relation (fixture-derived truth,
  // not a re-implementation of the SUT's internals).
  const byId = new Map(subagents.map((s) => [s.id, s]));
  const depthOf = new Map<string, number>();
  const rootChatOf = new Map<string, number>();
  for (const s of subagents) {
    let depth = 1;
    let ancestor = s.parentId;
    while (byId.has(ancestor)) {
      depth += 1;
      ancestor = byId.get(ancestor)!.parentId;
    }
    depthOf.set(s.id, depth);
    rootChatOf.set(s.id, chats.findIndex((c) => c.id === ancestor));
  }

  return { sessionId, chats, subagents, depthOf, rootChatOf };
}

// ── Layout runner (mirrors the hook's integration exactly) ───────────────────

interface LayoutResult {
  parents: Map<string, { x: number; y: number }>;
  cards: Map<string, { x: number; y: number }>;
  positions: Map<string, { x: number; y: number }>;
}

function runDeepTreeLayout(
  fixture: DeepTreeFixture,
  measuredHeights: Map<string, number>,
): LayoutResult {
  // 1. Companion extents over the shared entries (the hook feeds these at
  //    BOTH chainAgents build sites).
  const extents = computeCompanionExtents(fixture.subagents, measuredHeights);
  // 2. Chat chain with extents folded into the pitch.
  const parents = computeChatChainPositions(
    fixture.chats.map((c) => ({
      id: c.id,
      sessionId: c.sessionId,
      height: measuredHeights.get(c.id) ?? c.height,
      companionExtent: extents.get(c.id),
    })),
  );
  // 3. Companion-column placement.
  const cards = computeSubagentChainPositions(fixture.subagents, parents);
  const positions = new Map<string, { x: number; y: number }>([...parents, ...cards]);
  return { parents, cards, positions };
}

/** Measured-height maps for the three legs. */
function initialRenderHeights(fixture: DeepTreeFixture): Map<string, number> {
  // Initial render: chat nodes have measured (they render first); the
  // subagent cards are NOT yet measured → fallback reservation (R-7).
  const heights = new Map<string, number>();
  for (const c of fixture.chats) {
    if (c.height !== undefined) heights.set(c.id, c.height);
  }
  return heights;
}
function fullyUnmeasuredHeights(): Map<string, number> {
  return new Map();
}
function measuredReflowHeights(fixture: DeepTreeFixture): Map<string, number> {
  const heights = initialRenderHeights(fixture);
  for (const [id, h] of Object.entries(MEASURED_CARD_HEIGHTS)) {
    heights.set(id, h);
  }
  return heights;
}

// ── Rect + AABB machinery (conservative: MAX widths, chain-math fallbacks) ────

interface AABBRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function nodeRects(
  fixture: DeepTreeFixture,
  positions: Map<string, { x: number; y: number }>,
  measuredHeights: Map<string, number>,
): AABBRect[] {
  const rects: AABBRect[] = [];
  for (const c of fixture.chats) {
    const pos = positions.get(c.id);
    if (!pos) throw new Error(`fixture chat ${c.id} has no position`);
    rects.push({
      id: c.id,
      x: pos.x,
      y: pos.y,
      width: AGENT_NODE_MAX_WIDTH,
      height: measuredHeights.get(c.id) ?? c.height ?? DEFAULT_NODE_HEIGHT,
    });
  }
  for (const s of fixture.subagents) {
    const pos = positions.get(s.id);
    if (!pos) throw new Error(`fixture card ${s.id} has no position`);
    rects.push({
      id: s.id,
      x: pos.x,
      y: pos.y,
      width: SUBAGENT_NODE_MAX_WIDTH,
      height: measuredHeights.get(s.id) ?? SUBAGENT_CARD_FALLBACK_HEIGHT,
    });
  }
  return rects;
}

/** R-6: every pair of rendered rects must be separated by ≥ CLEARANCE_PX on
 *  at least one axis (zero AABB overlap with the binding 24px margin). */
function assertNoOverlap(rects: AABBRect[]): void {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
      const gapY = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
      const separation = Math.max(gapX, gapY);
      if (separation < CLEARANCE_PX) {
        throw new Error(
          `AABB overlap (<${CLEARANCE_PX}px clearance) between ${a.id} ` +
            `(${a.x},${a.y} ${a.width}x${a.height}) and ${b.id} ` +
            `(${b.x},${b.y} ${b.width}x${b.height}): gapX=${gapX} gapY=${gapY}`,
        );
      }
    }
  }
}

/** Position-set equality (R-9): id-sorted [id, {x, y}] entry arrays. */
function positionSet(
  positions: Map<string, { x: number; y: number }>,
): Array<[string, { x: number; y: number }]> {
  return [...positions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ── The tests ─────────────────────────────────────────────────────────────────

describe('#2770 ST-4: deep-tree fixture shape (R-12 minimums)', () => {
  const fixture = buildDeepTreeFixture();

  it('carries ≥ 15 total nodes (chats + cards)', () => {
    expect(fixture.chats.length + fixture.subagents.length).toBeGreaterThanOrEqual(MIN_TOTAL_NODES);
  });

  it('carries ≥ 3 sibling branches (L1 dispatches sharing an anchor) — 5 here', () => {
    const roots = new Map<string, number>();
    for (const s of fixture.subagents) {
      if (!fixture.subagents.some((o) => o.id === s.parentId)) {
        roots.set(s.parentId, (roots.get(s.parentId) ?? 0) + 1);
      }
    }
    const maxSiblings = Math.max(...roots.values());
    expect(maxSiblings).toBeGreaterThanOrEqual(MIN_SIBLING_BRANCHES);
  });

  it('carries ≥ 2 L3+ cards (the compact SubagentNode variant class, depth ≥ 3)', () => {
    const l3Plus = [...fixture.depthOf.values()].filter((d) => d >= 3);
    expect(l3Plus.length).toBeGreaterThanOrEqual(MIN_L3_PLUS_CARDS);
  });

  it('every anchoring chat node has a companion card TALLER than its chat node (the collision shape)', () => {
    for (const chat of fixture.chats) {
      const anchored = fixture.subagents.filter((s) => fixture.rootChatOf.get(s.id) === fixture.chats.indexOf(chat));
      if (anchored.length === 0) continue;
      const chatHeight = chat.height ?? DEFAULT_NODE_HEIGHT;
      // Measured leg: tallest card > chat height.
      const tallestMeasured = Math.max(...anchored.map((s) => MEASURED_CARD_HEIGHTS[s.id]));
      expect(tallestMeasured).toBeGreaterThan(chatHeight);
      // Initial render: the 640px fallback also exceeds every chat height.
      expect(SUBAGENT_CARD_FALLBACK_HEIGHT).toBeGreaterThan(chatHeight);
    }
  });
});

describe('#2770 ST-4: width-variance pin (candidate (d) closed-form freeze)', () => {
  it('lane step 564 > max card width 540 ⇒ ≥24px horizontal clearance — a max-width change fails loudly', () => {
    // Frozen literals (#2745 grammar, mirrored RIGHT by #2766): a future
    // SUBAGENT_NODE_MAX_WIDTH bump without a SUBAGENT_GAP adjustment breaks
    // the ≥24px lane clearance AND these pins.
    expect(SUBAGENT_NODE_MAX_WIDTH).toBe(540);
    expect(SUBAGENT_GAP).toBe(24);
    expect(SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP).toBe(564); // the lane step
    // The clearance derivation: lane step exceeds the max card width by at
    // least the binding margin.
    expect(SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP - SUBAGENT_NODE_MAX_WIDTH)
      .toBeGreaterThanOrEqual(CLEARANCE_PX);
    // Chat chain → first companion lane: the same 24px rule (SUBAGENT_CHAIN_X
    // is anchored just past the WIDEST chat node + COMPANION_GAP).
    expect(AGENT_NODE_MAX_WIDTH).toBe(540);
    expect(COMPANION_GAP).toBe(24);
    expect(SUBAGENT_CHAIN_X).toBe(CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH + COMPANION_GAP);
    expect(SUBAGENT_CHAIN_X - AGENT_NODE_MAX_WIDTH).toBeGreaterThanOrEqual(CLEARANCE_PX);
  });

  it('holds structurally across the whole fixture: every cross-lane pair has ≥24px horizontal gap', () => {
    const fixture = buildDeepTreeFixture();
    const { positions } = runDeepTreeLayout(fixture, measuredReflowHeights(fixture));
    const cardRects = nodeRects(fixture, positions, measuredReflowHeights(fixture))
      .filter((r) => r.id.startsWith('subagent-'));
    for (let i = 0; i < cardRects.length; i++) {
      for (let j = i + 1; j < cardRects.length; j++) {
        const a = cardRects[i];
        const b = cardRects[j];
        const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
        if (gapX < 0) {
          // Same lane — legal ONLY with ≥24px vertical separation (already
          // enforced by assertNoOverlap); record the lane-sharing pair.
          const gapY = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
          expect(gapY).toBeGreaterThanOrEqual(CLEARANCE_PX);
        } else {
          expect(gapX).toBeGreaterThanOrEqual(CLEARANCE_PX);
        }
      }
    }
  });
});

describe('#2770 ST-4: nested-tier placement pin (R-3)', () => {
  const fixture = buildDeepTreeFixture();

  it('NESTED_TIER_INDENT_Y is frozen at 64 (the raised staircase, replacing LEVEL_INDENT_Y=24)', () => {
    expect(NESTED_TIER_INDENT_Y).toBe(64);
  });

  it('L1 cards sit flush with their parent chat node y; each deeper level offsets exactly +64px', () => {
    const { parents, cards } = runDeepTreeLayout(fixture, measuredReflowHeights(fixture));
    for (const s of fixture.subagents) {
      const rootIndex = fixture.rootChatOf.get(s.id)!;
      const rootY = parents.get(fixture.chats[rootIndex].id)!.y;
      const depth = fixture.depthOf.get(s.id)!;
      const pos = cards.get(s.id)!;
      // L1 flush (offset 0); depth d → NESTED_TIER_INDENT_Y × (d − 1).
      expect(pos.y).toBe(rootY + NESTED_TIER_INDENT_Y * (depth - 1));
      if (depth === 1) {
        expect(pos.y).toBe(rootY);
      }
    }
  });

  it('L1 cards also keep their lane anchored at SUBAGENT_CHAIN_X (closed form), nested lanes step +564 per level', () => {
    const { cards } = runDeepTreeLayout(fixture, measuredReflowHeights(fixture));
    const laneStep = SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP;
    // Spot the deep chain: sa-a (L1) → sa-a0 (L2) → sa-a0x (L3) → sa-a0xy (L4).
    const y1 = cards.get('subagent-sa-a')!;
    expect(y1.x).toBe(SUBAGENT_CHAIN_X);
    const y2 = cards.get('subagent-sa-a0')!;
    expect(y2.x).toBe(y1.x + laneStep);
    const y3 = cards.get('subagent-sa-a0x')!;
    expect(y3.x).toBe(y2.x + laneStep);
    expect(y3.y).toBe(y2.y + NESTED_TIER_INDENT_Y);
    const y4 = cards.get('subagent-sa-a0xy')!;
    expect(y4.x).toBe(y3.x + laneStep);
    expect(y4.y).toBe(y3.y + NESTED_TIER_INDENT_Y);
  });
});

describe('#2770 ST-4 leg (a): initial render — unmeasured cards at fallback height, zero AABB overlap', () => {
  const fixture = buildDeepTreeFixture();

  it('chats measured + cards unmeasured (fallback 640): zero overlap with ≥24px clearance', () => {
    const heights = initialRenderHeights(fixture);
    const { positions } = runDeepTreeLayout(fixture, heights);
    expect(positions.size).toBe(fixture.chats.length + fixture.subagents.length);
    assertNoOverlap(nodeRects(fixture, positions, heights));
  });

  it('fully unmeasured (chats at DEFAULT_NODE_HEIGHT too): zero overlap with ≥24px clearance', () => {
    const heights = fullyUnmeasuredHeights();
    const { positions } = runDeepTreeLayout(fixture, heights);
    assertNoOverlap(nodeRects(fixture, positions, heights));
  });

  it('the fallback reservation actually pushes the next chat node below the tallest card (R-7 regression anchor)', () => {
    // Without the companionExtent pitch, chat-c2 would land at 360 + 28 = 388
    // while agent-c1's deepest card reaches y=832 — the collision this spec
    // fixes. The extent-fed pitch must place chat-c2 BELOW it (+ CHAIN_GAP).
    const heights = initialRenderHeights(fixture);
    const { parents } = runDeepTreeLayout(fixture, heights);
    const deepestFallbackBottom =
      NESTED_TIER_INDENT_Y * 3 + SUBAGENT_CARD_FALLBACK_HEIGHT; // L4 card under agent-c1
    expect(parents.get('agent-c2')!.y).toBeGreaterThanOrEqual(
      deepestFallbackBottom + CHAIN_GAP,
    );
  });
});

describe('#2770 ST-4 leg (b): measured-height reflow — pitch tightens, still zero overlap', () => {
  const fixture = buildDeepTreeFixture();

  it('all cards measured (still taller than their chat anchors): zero overlap with ≥24px clearance', () => {
    const heights = measuredReflowHeights(fixture);
    const { positions } = runDeepTreeLayout(fixture, heights);
    assertNoOverlap(nodeRects(fixture, positions, heights));
  });

  it('the measured pitch TIGHTENS vs the fallback leg for every downstream chat node', () => {
    const initial = runDeepTreeLayout(fixture, initialRenderHeights(fixture)).parents;
    const reflow = runDeepTreeLayout(fixture, measuredReflowHeights(fixture)).parents;
    // agent-c1 stays at CHAIN_TOP_Y; chats c2..c4 strictly rise (smaller y).
    expect(reflow.get('agent-c1')!.y).toBe(CHAIN_TOP_Y);
    for (const id of ['agent-c2', 'agent-c3', 'agent-c4']) {
      expect(reflow.get(id)!.y).toBeLessThan(initial.get(id)!.y);
    }
  });

  it('reflow keeps ≥24px vertical clearance between same-lane cards of neighboring chat nodes (the root-cause shape)', () => {
    const heights = measuredReflowHeights(fixture);
    const { positions } = runDeepTreeLayout(fixture, heights);
    // agent-c1's flat L1 card (lane 0) vs agent-c2's flat L1 card (lane 0) —
    // the exact same-lane pair that overlapped pre-#2770.
    const aBottom = positions.get('subagent-sa-a')!.y + MEASURED_CARD_HEIGHTS['subagent-sa-a'];
    const dTop = positions.get('subagent-sa-d')!.y;
    expect(dTop - aBottom).toBeGreaterThanOrEqual(CLEARANCE_PX);
  });
});

describe('#2770 ST-4 leg (c): full rebuild determinism (R-9) — identical inputs ⇒ identical position sets', () => {
  const fixture = buildDeepTreeFixture();

  it('initial render, reflow, and two rebuilds: position-set equality per leg (position-set equality assertion)', () => {
    const initialHeights = initialRenderHeights(fixture);
    const reflowHeights = measuredReflowHeights(fixture);

    // Leg (a) twice — "rebuild" over identical inputs.
    const initial1 = runDeepTreeLayout(fixture, initialHeights).positions;
    const initial2 = runDeepTreeLayout(fixture, initialHeights).positions;
    expect(positionSet(initial2)).toEqual(positionSet(initial1));

    // Legs (b) + (c): reflow, then two full rebuilds (session switch away/
    // back with the same measured heights) — identical position sets.
    const reflow1 = runDeepTreeLayout(fixture, reflowHeights).positions;
    const rebuild1 = runDeepTreeLayout(fixture, reflowHeights).positions;
    const rebuild2 = runDeepTreeLayout(fixture, reflowHeights).positions;
    expect(positionSet(rebuild1)).toEqual(positionSet(reflow1));
    expect(positionSet(rebuild2)).toEqual(positionSet(reflow1));

    // The legs must genuinely differ (the reflow did work) — a vacuous
    // equality would pass the checks above while proving nothing.
    expect(positionSet(reflow1)).not.toEqual(positionSet(initial1));
  });

  it('determinism holds for the placement and extent maps individually (pure closed-form, no wall-clock)', () => {
    const heights = measuredReflowHeights(fixture);
    const run1 = runDeepTreeLayout(fixture, heights);
    const run2 = runDeepTreeLayout(fixture, heights);
    expect(positionSet(run1.parents)).toEqual(positionSet(run2.parents));
    expect(positionSet(run1.cards)).toEqual(positionSet(run2.cards));
  });
});

// ── ST-2 integration verification ─────────────────────────────────────────────
//
// The stripe is an INSET box-shadow (paints inside the card rect — zero
// layout footprint) and the nested accent swap is color-only. Proven here at
// the strongest available level: after normalizing the accent-var swap and
// stripping the stripe prefix, EVERY inline style value in the rendered tree
// is byte-identical between an L1 and a nested (depth 2) card — so no
// sizing/layout property changes ⇒ ReactFlow measured heights are unaffected
// by the nested rendering.

/** The 3px inset tier stripe (SubagentNode container box-shadow prefix). */
const NESTED_STRIPE = 'inset 3px 0 0 var(--accent-nested-subagent)';

/** Normalizes a style value for the L1↔nested diff: strips the stripe prefix
 *  and collapses the nested accent var back to the L1 var. (Plain string ops —
 *  the stripe literal's parens must NOT be treated as regex groups.) */
function normalizeStyleValue(value: string): string {
  let v = value.split(NESTED_STRIPE).join('');
  // Collapse the artifact left by the removed stripe prefix (", 0 2px…" → "0 2px…").
  v = v.replace(/^\s*,\s*/, '');
  v = v.split('var(--accent-nested-subagent)').join('var(--accent-subagent)');
  return v.trim();
}

/** Parses an inline style ATTRIBUTE string into a raw prop→value map (avoids
 *  cssstyle serialization quirks — the raw React-emitted text is compared). */
function parseStyleAttr(styleAttr: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!styleAttr) return map;
  for (const decl of styleAttr.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    map.set(trimmed.slice(0, idx).trim().toLowerCase(), trimmed.slice(idx + 1).trim());
  }
  return map;
}

function renderSubagentNode(depth: number | undefined): ReturnType<typeof render> {
  const payload: Record<string, unknown> = {
    name: 'explore',
    instruction: 'Investigate marker fredo-2770-FIXA',
    output: 'CHILD-output',
    childTokens: 1840,
    sessionId: 'ses-2770-deep',
    nestedCount: 1,
    sessionMaxDepth: 2,
  };
  if (depth !== undefined) payload.depth = depth;
  const data: MonitorNodeData = {
    eventType: 'subagent',
    status: 'inactive',
    payload: payload as MonitorNodeData['payload'],
    timestamp: '2026-08-30T10:00:00.000Z',
    label: 'Subagent · explore',
    threadId: 'main',
    relatedEvents: [],
  };
  const props: NodeProps<MonitorNodeData> = {
    id: 'subagent-corr-task',
    data,
    selected: false,
    type: 'subagentNode',
    isConnectable: true,
    zIndex: 1,
    xPos: 0,
    yPos: 0,
    dragging: false,
    targetPosition: 'right' as const,
    sourcePosition: 'left' as const,
    width: 420,
    height: 400,
  };
  return render(createElement(SubagentNode, props));
}

describe('#2770 ST-4: ST-2 integration — nested rendering is layout-neutral', () => {
  it('stripe rides an INSET box-shadow inside the card rect; border stays the neutral #2748 contract', () => {
    const { container } = renderSubagentNode(2);
    const node = container.querySelector('[role="article"]') as HTMLElement;
    // The stripe: inset → painted INSIDE the border box (zero footprint
    // outside the card rect; nothing for the collision math to budget).
    expect(node.getAttribute('style')).toContain(`${NESTED_STRIPE},`);
    // The border contract is untouched (never the accent).
    expect(node.style.border).toBe('1.5px solid var(--border-color)');
    // Handles stay neutral.
    const handle = container.querySelector('[data-testid="handle-target-left"]') as HTMLElement;
    expect(handle.style.background).toBe('var(--border-color)');
  });

  it('nested accent swap alters ZERO layout-relevant CSS: L1 vs depth-2 trees are byte-identical after accent normalization', () => {
    const l1 = renderSubagentNode(1);
    const nested = renderSubagentNode(2);

    const l1Els = Array.from(l1.container.querySelectorAll('*'));
    const nestedEls = Array.from(nested.container.querySelectorAll('*'));
    // Identical DOM structure (same element count, tags, classes in document
    // order) — the nested branch changes styles, not anatomy. NOTE: class is
    // read via getAttribute (SVG elements expose `className` as an
    // SVGAnimatedString object, not a string).
    expect(nestedEls.length).toBe(l1Els.length);
    for (let i = 0; i < l1Els.length; i++) {
      expect(nestedEls[i].tagName).toBe(l1Els[i].tagName);
      expect(nestedEls[i].getAttribute('class')).toBe(l1Els[i].getAttribute('class'));
    }

    // Inline-style diff, element by element: after normalizing the accent-var
    // swap + stripe prefix, every value must be byte-identical. Any surviving
    // diff is a layout-affecting change ⇒ a measured-height drift ⇒ FAIL.
    const l1StyleByEl = new Map<Element, string>();
    for (let i = 0; i < l1Els.length; i++) {
      l1StyleByEl.set(nestedEls[i], l1Els[i].getAttribute('style') ?? '');
    }
    const boxShadowDiffs: string[] = [];
    for (let i = 0; i < nestedEls.length; i++) {
      const nestedStyles = parseStyleAttr(nestedEls[i].getAttribute('style') ?? '');
      const l1Styles = parseStyleAttr(l1StyleByEl.get(nestedEls[i]) ?? '');
      const props = new Set([...nestedStyles.keys(), ...l1Styles.keys()]);
      for (const prop of props) {
        const nestedVal = normalizeStyleValue(nestedStyles.get(prop) ?? '');
        const l1Val = normalizeStyleValue(l1Styles.get(prop) ?? '');
        if (nestedVal !== l1Val) {
          throw new Error(
            `Layout-relevant style diff on element ${i} (${nestedEls[i].tagName}.${nestedEls[i].className}) ` +
              `prop "${prop}": L1="${l1Val}" nested="${nestedVal}"`,
          );
        }
        // Bookkeeping: confirm the stripe is the ONLY raw (un-normalized)
        // container-level diff — i.e. the box-shadow diff, which is NOT a
        // layout property (paint-only, inside the rect).
        if (prop === 'box-shadow' && (nestedStyles.get(prop) ?? '') !== (l1Styles.get(prop) ?? '')) {
          boxShadowDiffs.push(prop);
        }
      }
    }
    expect(boxShadowDiffs).toEqual(['box-shadow']);
  });

  it('aria-label sweep across the fixture depths: nested qualifier at depth ≥ 2, L1 label byte-identical (R-11 support)', () => {
    // depth 1 (L1) — unchanged.
    const d1 = renderSubagentNode(1);
    expect(
      (d1.container.querySelector('[role="article"]') as HTMLElement).getAttribute('aria-label'),
    ).toBe('Subagent · explore · level 1');
    cleanup();
    // depth 2 (nested, full variant).
    const d2 = renderSubagentNode(2);
    expect(
      (d2.container.querySelector('[role="article"]') as HTMLElement).getAttribute('aria-label'),
    ).toBe('Subagent (nested) · explore · level 2');
    cleanup();
    // depth 3 (nested, compact L3+ variant).
    const d3 = renderSubagentNode(3);
    expect(
      (d3.container.querySelector('[role="article"]') as HTMLElement).getAttribute('aria-label'),
    ).toBe('Subagent (nested) · explore · level 3');
    cleanup();
    // depth 4 (nested, compact).
    const d4 = renderSubagentNode(4);
    expect(
      (d4.container.querySelector('[role="article"]') as HTMLElement).getAttribute('aria-label'),
    ).toBe('Subagent (nested) · explore · level 4');
  });
});
