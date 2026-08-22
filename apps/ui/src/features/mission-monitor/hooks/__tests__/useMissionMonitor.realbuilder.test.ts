/**
 * Real-builder integration tests for the #2756 DISJOINT Force wiring (G-028 gap).
 *
 * #2756 DELIBERATE UPDATE: this file's #2754 hybrid assertions (chat nodes land
 * at EXACTLY `computeChatChainPositions` output, only companions move across
 * ticks, the settled halo clamp) are DELIBERATELY REWRITTEN for the true
 * disjoint force layout: every node — chat, tools, subagent — is a body of the
 * REAL d3-force simulation and settles at FORCE-SIMULATED positions (AC1:
 * chat nodes do NOT occupy `computeChatChainPositions` output).
 *
 * The main hook suite (useMissionMonitor.test.ts) mocks `createLiveForceSimulation`
 * at the lib/layout.ts boundary, so the REAL builder → onTick/onSettled → ReactFlow
 * store path is NOT unit-covered there. These tests exercise the actual d3-force
 * sim through the hook's wiring:
 *
 *  1. chat nodes LAND at force-simulated positions — NOT computeChatChainPositions
 *     output — and every node's settled coordinates are finite (AC1/REQ-1);
 *  2. nodes GLIDE: ≥2 distinct intermediate frames between the seed and the
 *     settled positions (R-4 motion proof / F-142 discriminator);
 *  3. reduced-motion snap (prefers-reduced-motion) settles synchronously with
 *     NO scheduled frame — positions applied exactly once (AC4 exception);
 *  4. a newly arrived chat node ENTERS VIA THE SEED — the fresh node glides in
 *     at its sim seed, existing nodes never jump, and nothing is re-pinned to a
 *     chain slot (R-1.2 / REQ-1).
 *
 * jsdom has no rAF (layout.test.ts:664) and no matchMedia, so this file stubs
 * both: `requestAnimationFrame`/`cancelAnimationFrame` with a manual frame
 * harness and `matchMedia` only for the snapToSettled test. d3's internal jiggle
 * uses Math.random — the assertions NEVER read exact settle coordinates
 * (stochastic): they use the injected-random determinism pattern only where the
 * builder is driven directly (layout.test.ts), and here the store assertions are
 * distance/bounds/inequality-based (a chat node differs from its chain slot by
 * ≥5px on ≥1 axis; nodes stay inside a bounded region; intermediate frames
 * differ from both seed and settled).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

// Mock StreamContext only — the layout module stays REAL (createLiveForceSimulation
// is the actual d3-force builder).
const mockDeliveries: ContractDelivery[] = [];
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    deliveries: mockDeliveries,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useDeliveryGraph } from '../useMissionMonitor';
import {
  computeChatChainPositions,
  VIEWPORT_BOUNDS,
  type ChainAgent,
  type NodePosition,
} from '../../lib/layout';

// ── Fixture helpers (mirror useMissionMonitor.test.ts:63-279) ─────────────────

function makeDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  payloadOverrides: Record<string, unknown> = {},
): ContractDelivery {
  return {
    id,
    contractName: 'chat-node',
    lifecycle,
    key: { sessionId, correlationId },
    payload: {
      payload: {
        promptTokens: 0,
        completionTokens: 0,
        agent: '',
        model: '',
        userMessage: '',
        agentReply: '',
        agentThinking: '',
        info: { text: '', modelID: '', agent: '' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 0,
        turnOutputTokens: 0,
        ...payloadOverrides,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function makeToolDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  toolName: string,
  innerPayload: Record<string, unknown> = {},
): ContractDelivery {
  return {
    id,
    contractName: 'tool-use-lifecycle',
    lifecycle,
    key: { sessionId, correlationId },
    payload: {
      toolName,
      state: lifecycle === 'init' ? 'Init' : lifecycle === 'end' ? 'Response' : 'Update',
      payload: {
        'gen_ai.tool.name': toolName,
        tool_name: toolName,
        input: '',
        output: '',
        ...innerPayload,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

/** Full fixture — 3 chat turns + 1 ToolsNode exchange + 1 @-subagent dispatch
 *  (mirrors useMissionMonitor.test.ts makeFullFixture:234-279). */
function makeFullFixture(): ContractDelivery[] {
  const TASK_ARGS = JSON.stringify({
    subagent_type: 'explore',
    prompt: 'Inspect the marker and reply exactly CHILD',
  });
  return [
    makeDelivery('i1', 'init', 's1', 'corr-1', {
      userMessage: 'first', startTime: '2026-08-17T10:00:00.000Z',
    }),
    makeDelivery('e1', 'end', 's1', 'corr-1', {
      userMessage: 'first', agentReply: 'reply-1',
      startTime: '2026-08-17T10:00:00.000Z', endTime: '2026-08-17T10:00:20.000Z',
    }),
    makeDelivery('i2', 'init', 's1', 'corr-2', {
      userMessage: 'run the tool', startTime: '2026-08-17T10:00:30.000Z',
    }),
    makeDelivery('e2', 'end', 's1', 'corr-2', {
      userMessage: 'run the tool', agentReply: 'ran',
      startTime: '2026-08-17T10:00:30.000Z', endTime: '2026-08-17T10:01:00.000Z',
    }),
    makeToolDelivery('t1', 'init', 's1', 'tool-corr-1', 'Bash', {
      input: 'ls', startTime: '2026-08-17T10:00:35.000Z',
    }),
    makeToolDelivery('t2', 'end', 's1', 'tool-corr-1', 'Bash', {
      input: 'ls', output: 'files',
      startTime: '2026-08-17T10:00:35.000Z', endTime: '2026-08-17T10:00:36.000Z',
    }),
    makeDelivery('i3', 'init', 's1', 'corr-3', {
      userMessage: 'delegate', startTime: '2026-08-17T10:01:10.000Z',
    }),
    makeDelivery('e3', 'end', 's1', 'corr-3', {
      userMessage: 'delegate', agentReply: 'done',
      startTime: '2026-08-17T10:01:10.000Z', endTime: '2026-08-17T10:01:40.000Z',
    }),
    makeToolDelivery('d3', 'init', 's1', 'task-corr-1', 'task', {
      input: TASK_ARGS, startTime: '2026-08-17T10:01:15.000Z',
    }),
    makeToolDelivery('d4', 'end', 's1', 'task-corr-1', 'task', {
      input: TASK_ARGS, output: 'CHILD',
      startTime: '2026-08-17T10:01:15.000Z', endTime: '2026-08-17T10:01:30.000Z',
    }),
  ];
}

function nodePositions(nodes: Array<{ id: string; position: { x: number; y: number } }>): Map<string, NodePosition> {
  return new Map(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
}

/** Euclidean distance between two points. */
function distance(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): number {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
}

// ── Manual rAF harness (jsdom has no rAF — layout.test.ts:664) ────────────────
let scheduledFrames: Array<() => void> = [];

function stubRAF(): void {
  scheduledFrames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    scheduledFrames.push(cb);
    return scheduledFrames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

/** Run one scheduled animation frame inside act(). */
function runFrame(): void {
  const cbs = scheduledFrames.splice(0);
  act(() => {
    for (const cb of cbs) cb();
  });
}

/** Run frames until none are pending (or the guard exhausts). */
function drainFrames(maxFrames = 2000): number {
  let frames = 0;
  while (scheduledFrames.length > 0 && frames < maxFrames) {
    runFrame();
    frames++;
  }
  return frames;
}

const CHAIN_AGENTS: ChainAgent[] = [
  { id: 'agent-corr-1', sessionId: 's1' },
  { id: 'agent-corr-2', sessionId: 's1' },
  { id: 'agent-corr-3', sessionId: 's1' },
];
const EXPECTED_CHAIN = computeChatChainPositions(CHAIN_AGENTS);

/** The chat-node ids of the fixture. */
const CHAT_IDS = ['agent-corr-1', 'agent-corr-2', 'agent-corr-3'];

/** REQ-3 containment margin around the framable region (canvas px). The
 *  exchange anchors sit within VIEWPORT_BOUNDS (computeExchangeAnchors keeps a
 *  400px margin from the region edge); the real sim's weak positioning force
 *  (0.1) lets charge/collide spread a cluster a few hundred px beyond its
 *  anchor. The assertion proves containment inside the framable region plus a
 *  comfortable spread margin — never asserting exact coordinates (stochastic). */
const CONTAINMENT_MARGIN = 800;

describe('useDeliveryGraph #2756 DISJOINT Force — REAL createLiveForceSimulation through the hook wiring (G-028)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
    vi.unstubAllGlobals();
    stubRAF();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#2756 DELIBERATE UPDATE: chat nodes land at FORCE-SIMULATED positions — NOT computeChatChainPositions output (AC1/REQ-1: no chain pinning, every node a sim body)', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    // ── Seed applied at restart (before the first frame): the level-based sim
    // seed, NOT the chain geometry (fresh Force graph → layoutPositionsRef is
    // empty → fresh nodes get the builder's level-based defaults; chat nodes
    // are NOT seeded at the chain column). ──
    const chatBefore = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    // The #2754 assertion (chat == EXPECTED_CHAIN) is DELIBERATELY inverted:
    // chat nodes are seeded at force-sim defaults, and after settle they land
    // at force-simulated coordinates that differ from the chain by ≥5px on ≥1
    // axis (AC1 numeric discriminator).
    expect(chatBefore.get('agent-corr-1')).not.toEqual(EXPECTED_CHAIN.get('agent-corr-1'));

    // ── Drain to settle: the whole graph (chat + companions) glides and every
    // node lands at force-simulated coordinates. ──
    const frames = drainFrames();
    expect(frames).toBeGreaterThan(0);

    const settled = nodePositions(result.current.nodes);
    for (const id of [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1']) {
      const p = settled.get(id);
      expect(p).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }

    // AC1: at least one chat node settled ≥5px away from its chain slot on ≥1
    // axis — the chat spine is NOT byte-identical to computeChatChainPositions
    // (the #2754 pinned-chain assertion is DELIBERATELY replaced).
    const movedOffChain = CHAT_IDS.some((id) => {
      const p = settled.get(id)!;
      const chain = EXPECTED_CHAIN.get(id)!;
      return Math.abs(p.x - chain.x) >= 5 || Math.abs(p.y - chain.y) >= 5;
    });
    expect(movedOffChain).toBe(true);

    // REQ-3 bounded containment: every settled node stays within the framable
    // viewport region (the forceX/forceY anchors keep clusters on-canvas) with
    // a comfortable margin for the weak-positioning charge/collide spread.
    for (const id of [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1']) {
      const p = settled.get(id)!;
      expect(Math.abs(p.x)).toBeLessThanOrEqual(VIEWPORT_BOUNDS.width / 2 + CONTAINMENT_MARGIN);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(VIEWPORT_BOUNDS.height / 2 + CONTAINMENT_MARGIN);
    }
  });

  it('#2756 DELIBERATE UPDATE: nodes GLIDE — ≥2 distinct intermediate frames between the seed and the settled positions for ≥1 node (R-4 motion proof / F-142 discriminator; chat included — they are sim bodies now)', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    const byId = (id: string) => result.current.nodes.find((n) => n.id === id)!;
    const at = (id: string) => byId(id).position;

    // t0 = the seed applied at restart (before any frame).
    const t0: Record<string, { x: number; y: number }> = {};
    for (const id of [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1']) {
      t0[id] = { ...at(id) };
    }

    // mid1 / mid2 — two intermediate frames inside the glide window
    // (alphaDecay 0.02 / alphaMin 0.01 → ~229 ticks to settle).
    runFrame();
    runFrame();
    const mid1: Record<string, { x: number; y: number }> = {};
    for (const id of [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1']) {
      mid1[id] = { ...at(id) };
    }
    runFrame();
    runFrame();
    runFrame();
    const mid2: Record<string, { x: number; y: number }> = {};
    for (const id of [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1']) {
      mid2[id] = { ...at(id) };
    }

    // Drain to settle and read the FINAL store positions.
    drainFrames();
    const settled: Record<string, { x: number; y: number }> = {};
    for (const id of [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1']) {
      settled[id] = { ...at(id) };
    }

    // F-142 discriminator: ≥2 intermediate samples differ from BOTH the initial
    // and the settled positions for ≥1 node ⇒ LIVE animation (a snap would make
    // t0 == mid1 == mid2 == settled for every node — the round-3 R-4 FAIL).
    // #2756: the chat nodes count as candidates too — they are sim bodies that
    // glide (the #2754 "chat spine stays pinned" discriminator is DELIBERATELY
    // replaced by "any node glides"; at least one chat node must be among the
    // gliding set to prove REQ-1 is observable in the motion).
    const allIds = [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1'];
    const glided = allIds.filter((id) => {
      const movedOffSeed = JSON.stringify(t0[id]) !== JSON.stringify(mid1[id]) ||
        JSON.stringify(t0[id]) !== JSON.stringify(mid2[id]);
      const midFramesDistinct = JSON.stringify(mid1[id]) !== JSON.stringify(mid2[id]);
      const notYetSettled = JSON.stringify(mid1[id]) !== JSON.stringify(settled[id]) ||
        JSON.stringify(mid2[id]) !== JSON.stringify(settled[id]);
      return movedOffSeed && midFramesDistinct && notYetSettled;
    });
    expect(glided.length).toBeGreaterThan(0);
    // REQ-1: the chat nodes themselves are sim bodies — at least one chat node
    // participated in the glide (the #2754 hybrid never moved the chat spine).
    const glidedChats = glided.filter((id) => id.startsWith('agent-'));
    expect(glidedChats.length).toBeGreaterThan(0);
  });

  it('#2756 DELIBERATE UPDATE: reduced-motion snap settles the DISJOINT recipe synchronously with NO scheduled frame — chat nodes land at force positions (not chain), applied exactly once (AC4 exception)', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    // snapToSettled → the rebuild ran the bounded synchronous settle; no rAF
    // frame was ever scheduled (AC4 exception).
    expect(scheduledFrames.length).toBe(0);

    const settled = nodePositions(result.current.nodes);
    // #2756: the chat nodes settled at FORCE positions — NOT the chain geometry
    // (the #2754 "chat == computeChatChainPositions" snap assertion is
    // DELIBERATELY replaced with "≠ chain by ≥5px on ≥1 axis" for ≥1 chat node).
    const movedOffChain = CHAT_IDS.some((id) => {
      const p = settled.get(id)!;
      const chain = EXPECTED_CHAIN.get(id)!;
      return Math.abs(p.x - chain.x) >= 5 || Math.abs(p.y - chain.y) >= 5;
    });
    expect(movedOffChain).toBe(true);

    // Every node landed at finite force positions — never the hook's (0,0)
    // fallback and inside the bounded viewport region (REQ-3).
    for (const id of [...CHAT_IDS, 'tools-corr-2', 'subagent-task-corr-1']) {
      const p = settled.get(id);
      expect(p).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
      expect(p).not.toEqual({ x: 0, y: 0 });
      expect(Math.abs(p!.x)).toBeLessThanOrEqual(VIEWPORT_BOUNDS.width / 2 + CONTAINMENT_MARGIN);
      expect(Math.abs(p!.y)).toBeLessThanOrEqual(VIEWPORT_BOUNDS.height / 2 + CONTAINMENT_MARGIN);
    }
  });

  it('#2756 DELIBERATE UPDATE: a newly arrived chat node enters via the SIM SEED and joins its exchange — existing nodes never jump, NO chain-bottom pin (R-1.2 / REQ-1)', async () => {
    const deliveries = makeFullFixture();
    const { result, rerender } = renderHook(
      ({ ds }: { ds: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries: ds, sessionId: 's1', layoutMode: 'force' }),
      { initialProps: { ds: deliveries } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });
    drainFrames();

    // All three chat nodes settled at force positions (never the chain slots).
    const before = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    const beforeAll = nodePositions(result.current.nodes);

    // Append a 4th turn AFTER the sim settled — a structural change restarts
    // the sim seeded from the CURRENT positions (EARS-4: no jump).
    const extended = [
      ...deliveries,
      makeDelivery('i4', 'init', 's1', 'corr-4', {
        userMessage: 'fourth', startTime: '2026-08-17T10:02:00.000Z',
      }),
      makeDelivery('e4', 'end', 's1', 'corr-4', {
        userMessage: 'fourth', agentReply: 'reply-4',
        startTime: '2026-08-17T10:02:00.000Z', endTime: '2026-08-17T10:02:30.000Z',
      }),
    ];
    act(() => {
      rerender({ ds: extended });
    });

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'agent-corr-4')).toHaveLength(1);
    });

    // The new chat node entered at the sim's fresh-node seed — NOT the chain
    // bottom slot (0, 3 × (DEFAULT_NODE_HEIGHT + CHAIN_GAP)) and NOT (0,0)
    // (REQ-1: it is a sim body, not a chain-pinned node). The exact seed is
    // the builder's level-based placement (staggered agent column) — the 
    // chain-position assertion below is DELIBERATELY negative.
    const fresh = nodePositions(result.current.nodes).get('agent-corr-4')!;
    expect(fresh).toBeDefined();
    const chainBottom4 = computeChatChainPositions([
      ...CHAIN_AGENTS,
      { id: 'agent-corr-4', sessionId: 's1' },
    ]).get('agent-corr-4')!;
    expect(fresh).not.toEqual(chainBottom4);
    expect(fresh).not.toEqual({ x: 0, y: 0 });

    // Pre-existing nodes did not jump: the restart seeded every existing node
    // from its current position (the mock-free real sim's seed contract). The
    // new node is the ONLY one whose store position differs from before.
    const after = nodePositions(result.current.nodes);
    const movedIds = [...after.keys()].filter(
      (id) => id !== 'agent-corr-4' && distance(after.get(id)!, beforeAll.get(id)!) > 1,
    );
    // At the instant the fresh node appears (before any frame), nothing else
    // moved — the restart seed is authoritative (EARS-4).
    expect(movedIds).toHaveLength(0);

    // The fresh node glides onward with the sim (it is a sim body — no pin).
    const freshSeed = { ...fresh };
    runFrame();
    runFrame();
    runFrame();
    const freshAfter = nodePositions(result.current.nodes).get('agent-corr-4')!;
    expect(freshAfter).not.toEqual(freshSeed);
  });

  it('#2756 round-3 (AC4): a QUIESCENT graph settles — freeze-on-settled stops the rAF loop and every position is byte-identical across the settle window (the round-2 FAIL was positions changing after the nominal settle)', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    // Drain to settle (~229 ticks at alphaDecay 0.02 / alphaMin 0.01).
    const frames = drainFrames();
    expect(frames).toBeGreaterThan(0);

    // Freeze-on-settled: the rAF loop has STOPPED — no scheduled frame remains
    // (the builder's freezeOnSettled path cancels the loop at alpha < alphaMin).
    expect(scheduledFrames.length).toBe(0);

    // Quiescent settle window: further frames are no-ops and every node keeps
    // its byte-identical settled position. The round-2 AC4 evidence showed a
    // live-but-idle graph changing AFTER the nominal settle window — under a
    // render-loop restart the sim would keep rescheduling frames here; the
    // frozen loop proves a quiescent graph settles (REQ-4).
    const settled = nodePositions(result.current.nodes);
    runFrame();
    runFrame();
    expect(scheduledFrames.length).toBe(0);
    expect(nodePositions(result.current.nodes)).toEqual(settled);
  });

  it('#2756 round-3 (AC4): a height-only change after settle does NOT restart the settled sim — measured height is layout-irrelevant in Force (no chain stack), so the loop stays frozen and positions stay byte-identical', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });
    drainFrames();
    expect(scheduledFrames.length).toBe(0);

    const settled = nodePositions(result.current.nodes);

    // A ReactFlow 'dimensions' change (measured height for agent-corr-1) bumps
    // heightReflowEpoch → the processing effect re-runs. In Force mode the
    // height signature is ABSORBED (positions come from the sim, NOT the chain
    // stack) — the settled sim is NOT restarted, no frame is scheduled, and the
    // store positions stay byte-identical. (The ST-2 behavior re-seeded the sim
    // on every height change — the round-2 AC4 defect: a live-but-idle session
    // that kept reporting dimensions never reached alphaMin.)
    act(() => {
      result.current.onNodesChange([
        {
          type: 'dimensions',
          id: 'agent-corr-1',
          dimensions: { width: 360, height: 500 },
          updateStyle: true,
        } as any,
      ]);
    });

    expect(scheduledFrames.length).toBe(0);
    expect(nodePositions(result.current.nodes)).toEqual(settled);
  });
});
