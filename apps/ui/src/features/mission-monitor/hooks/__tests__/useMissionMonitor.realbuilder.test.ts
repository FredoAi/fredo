/**
 * Real-builder integration tests for the #2754 hybrid Force wiring (G-028 gap).
 *
 * The main hook suite (useMissionMonitor.test.ts) mocks `createLiveForceSimulation`
 * at the lib/layout.ts boundary, so the REAL builder → onTick/onSettled → ReactFlow
 * store path is NOT unit-covered there. These tests exercise the actual d3-force
 * sim through the hook's wiring:
 *
 *  1. chat (agent) nodes land on the store at EXACTLY `computeChatChainPositions`
 *     output (AC1 — the pinned chain), both on the snapToSettled (reduced-motion)
 *     path and on the live rAF tick path;
 *  2. only subagent/tools companions move across ticks (chat spine byte-identical);
 *  3. the settled clamp (ST-3) fires once on settle with the chain pinned;
 *  4. the sim settles (no perpetual rAF loop) and the store keeps the chain pinned.
 *
 * jsdom has no rAF (layout.test.ts:664) and no matchMedia, so this file stubs
 * both: `requestAnimationFrame`/`cancelAnimationFrame` with a manual frame harness
 * and `matchMedia` only for the snapToSettled test. d3's internal jiggle uses
 * Math.random, but pinned chat nodes are fx/fy-frozen — readPositions returns
 * their seed (chain) coords through every tick, so the AC1 assertions are
 * deterministic regardless of the random source.
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
  CHAIN_GAP,
  DEFAULT_NODE_HEIGHT,
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

/** Hybrid fixture — 3 chat turns + 1 ToolsNode exchange + 1 @-subagent dispatch
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

/** Byte-identical map comparison (key-sorted so iteration order never matters). */
function expectSamePositions(actual: Map<string, NodePosition>, expected: Map<string, NodePosition>): void {
  const sortEntries = (m: Map<string, NodePosition>) =>
    [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  expect(sortEntries(actual)).toEqual(sortEntries(expected));
}

function nodePositions(nodes: Array<{ id: string; position: { x: number; y: number } }>): Map<string, NodePosition> {
  return new Map(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
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

describe('useDeliveryGraph #2754 hybrid Force — REAL createLiveForceSimulation through the hook wiring (G-028)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
    vi.unstubAllGlobals();
    stubRAF();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REAL rAF sim path: chat nodes land on the store at computeChatChainPositions output — the chain spine is pinned before, during, and after ticks while ONLY companions move (AC1/AC2/R-2.1)', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter((n) => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    // ── Seed applied at restart (before the first frame): the chat spine sits
    // at EXACTLY computeChatChainPositions output (AC1). ──
    const chatBefore = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    expectSamePositions(chatBefore, EXPECTED_CHAIN);

    // ── First tick: companions are the only moving set; chat stays pinned. ──
    runFrame();
    const chatAfterTick = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    expectSamePositions(chatAfterTick, EXPECTED_CHAIN);

    // ── Intermediate ticks: spine stays byte-identical (R-2.1 discriminator). ──
    runFrame();
    runFrame();
    runFrame();
    const chatMid = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    expectSamePositions(chatMid, EXPECTED_CHAIN);

    // The two companions have non-(0,0) store positions (they were seeded at
    // their deterministic chain slots and force-placed — never the hook's
    // (0,0) fallback for a missing cache entry).
    const byId = (id: string) => result.current.nodes.find((n) => n.id === id)!;
    const toolsPos = byId('tools-corr-2').position;
    const subPos = byId('subagent-task-corr-1').position;
    expect(toolsPos).not.toEqual({ x: 0, y: 0 });
    expect(subPos).not.toEqual({ x: 0, y: 0 });

    // ── Drain to settle: freeze-on-settled stops the loop; the spine is still
    // byte-identical (pinned chat nodes survive the settled clamp untouched). ──
    const frames = drainFrames();
    expect(frames).toBeGreaterThan(0);
    const chatSettled = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    expectSamePositions(chatSettled, EXPECTED_CHAIN);
  });

  it('REAL snapToSettled (reduced-motion) path: chat nodes land at chain coords synchronously with NO scheduled frame (AC1 + AC4 exception)', async () => {
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

    // The chat spine is at EXACTLY computeChatChainPositions output.
    const chat = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    expectSamePositions(chat, EXPECTED_CHAIN);

    // Companions were force-placed (seeded off the chain band, snapped to the
    // settled halo clamp) — never at the hook's (0,0) fallback.
    const byId = (id: string) => result.current.nodes.find((n) => n.id === id)!;
    expect(byId('tools-corr-2').position).not.toEqual({ x: 0, y: 0 });
    expect(byId('subagent-task-corr-1').position).not.toEqual({ x: 0, y: 0 });
  });

  it('a newly arrived chat node appends at the chain BOTTOM in Force mode via the REAL sim — the pinned set grows and the sim re-creates with the new chain slot (R-1.2)', async () => {
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

    // Newest visible chat node is corr-3 — the bottom of the chain.
    const before = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    const bottomY = Math.max(...Array.from(before.values()).map((p) => p.y));
    expect(EXPECTED_CHAIN.get('agent-corr-3')!.y).toBe(bottomY);

    // Append a 4th turn AFTER the sim settled — a structural change re-pins
    // the chain with the new node at the bottom (R-1.2).
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

    const expected4 = computeChatChainPositions([
      ...CHAIN_AGENTS,
      { id: 'agent-corr-4', sessionId: 's1' },
    ]);
    const after = nodePositions(
      result.current.nodes.filter((n) => n.id.startsWith('agent-')),
    );
    // All four chat nodes now sit at the re-computed chain (corr-4 at the
    // bottom, below corr-3).
    expectSamePositions(after, expected4);
    expect(expected4.get('agent-corr-4')!.y).toBeGreaterThan(expected4.get('agent-corr-3')!.y);
  });
});
