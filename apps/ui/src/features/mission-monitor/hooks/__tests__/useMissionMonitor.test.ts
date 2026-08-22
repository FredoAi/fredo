/**
 * Tests for useDeliveryGraph â€” delivery-driven graph building.
 *
 * Prerequisites: vitest, @testing-library/react, @testing-library/jest-dom, jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

// Mock StreamContext
const mockDeliveries: ContractDelivery[] = [];
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    deliveries: mockDeliveries,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

// #2752 ST-4: mock ONLY the live force-simulation builder at the ST-1
// boundary (lib/layout.ts `createLiveForceSimulation`). Every deterministic
// chain function + constant stays REAL (importOriginal), so existing chain
// assertions keep testing the actual geometry (AC4) and the new force-mode
// tests drive a controllable stand-in sim — jsdom has no rAF and d3 ticks are
// nondeterministic; the builder's own unit behavior belongs to ST-1
// (layout.test.ts), not these hook tests.
const { mockForceSims } = vi.hoisted(() => ({
  mockForceSims: [] as MockForceSimHandle[],
}));
vi.mock('../../lib/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/layout')>();
  return {
    ...actual,
    createLiveForceSimulation: vi.fn(),
  };
});

import { useDeliveryGraph } from '../useMissionMonitor';
import {
  DEFAULT_NODE_HEIGHT,
  CHAIN_GAP,
  TOOLS_CHAIN_X,
  SUBAGENT_CHAIN_X,
  SUBAGENT_GAP,
  SUBAGENT_NODE_HEIGHT,
  SUBAGENT_NODE_MAX_WIDTH,
  computeChatChainPositions,
  computeToolsChainPositions,
  computeSubagentChainPositions,
  FORCE_POSITION_STRENGTH,
  createLiveForceSimulation,
  type LayoutMode,
  type LayoutNode,
  type LayoutEdge,
  type NodePosition,
  type LiveForceSimulation,
  type LiveForceSimulationOptions,
} from '../../lib/layout';

// ── Shared Helpers (module-level for access by all describe blocks) ──────────

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
        // Contract-compliant fields (adapter-injected)
        promptTokens: 0,
        completionTokens: 0,
        agent: '',
        model: '',
        userMessage: '',
        agentReply: '',
        agentThinking: '',
        // Legacy fields (backward compat)
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
        // Canonical adapter-injected fields (plan API contract 2): flat span
        // attrs preserved verbatim + injected input/output.
        'gen_ai.tool.name': toolName,
        'tool_name': toolName,
        input: '',
        output: '',
        ...innerPayload,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

// ── #2752 ST-4: controllable live-force-simulation stand-in ──────────────────
//
// The hook consumes `createLiveForceSimulation` + the `LiveForceSimulation`
// contract (lib/layout.ts). ST-4 replaces the builder with a deterministic
// fake the tests drive frame-by-frame, so the HOOK's mode-switching contract
// (chain→force seed, structural-change re-seed, freeze-on-settled, force→chain
// byte-identical restore) is pinned without d3/rAF nondeterminism (T16).

/** A fake LiveForceSimulation handle + its recorded invocations. */
interface MockForceSimHandle {
  sim: LiveForceSimulation;
  /** restart(nodes, edges, seed) invocations, in call order. */
  restarts: { nodes: LayoutNode[]; edges: LayoutEdge[]; seed: Map<string, NodePosition> }[];
  /** stop() invocation count (force→chain / session change / unmount). */
  stops: number;
  /** The hook's onTick (captured at creation) — driven by tick(). */
  onTick: ((positions: Map<string, NodePosition>) => void) | null;
  /** The hook's onSettled (captured at creation) — driven by fireSettled(). */
  onSettled: ((positions: Map<string, NodePosition>) => void) | null;
  /** The builder options the hook passed at creation (#2756 ST-2: the disjoint
   *  per-node forceX/forceY positioning callbacks + exported strength constant,
   *  with `snapToSettled` from prefersReducedMotion(); NO `pinned` set). */
  options: LiveForceSimulationOptions | null;
  /** Latest positions — what positions() returns. */
  positions: Map<string, NodePosition>;
  /** Settled — while true, tick() is a no-op (freeze-on-settled, EARS-3). */
  settled: boolean;
  /** Simulate one animation frame: emit `next` via onTick (EARS-2). */
  tick: (next: Map<string, NodePosition>) => void;
  /** Freeze-on-settled (alpha < alphaMin) — no further frames. */
  settle: () => void;
  /** #2756: fire the hook's onSettled ONCE with `final` positions — the hook
   *  caches them verbatim (the #2754 deterministic settled clamp is removed). */
  fireSettled: (final: Map<string, NodePosition>) => void;
}

function makeMockForceSim(
  options: LiveForceSimulationOptions | undefined,
): MockForceSimHandle {
  const handle = {} as MockForceSimHandle;
  handle.sim = {
    start: vi.fn(),
    stop: vi.fn(() => {
      handle.stops += 1;
      handle.settled = true;
    }),
    restart: vi.fn((nodes: LayoutNode[], edges: LayoutEdge[], seed: Map<string, NodePosition>) => {
      handle.restarts.push({ nodes, edges, seed: new Map(seed) });
      const next = new Map<string, NodePosition>();
      nodes.forEach((n, i) => {
        const seeded = seed.get(n.id);
        // Existing nodes keep their seeded position (no jump — EARS-4/8);
        // fresh nodes get a deterministic sim-assigned seed, never (0,0).
        next.set(n.id, seeded ? { x: seeded.x, y: seeded.y } : { x: 300, y: 500 * (i + 1) });
      });
      handle.positions = next;
      handle.settled = false;
    }),
    isRunning: vi.fn(() => !handle.settled),
    isSettled: vi.fn(() => handle.settled),
    positions: vi.fn(() => new Map(handle.positions)),
  } as LiveForceSimulation;
  handle.restarts = [];
  handle.stops = 0;
  handle.onTick = options?.onTick ?? null;
  handle.onSettled = options?.onSettled ?? null;
  handle.options = options ?? null;
  handle.positions = new Map();
  handle.settled = true;
  handle.tick = (next: Map<string, NodePosition>) => {
    if (handle.settled) return; // freeze-on-settled — the loop has stopped
    handle.positions = new Map(next);
    handle.onTick?.(handle.positions);
  };
  handle.settle = () => {
    handle.settled = true;
  };
  handle.fireSettled = (final: Map<string, NodePosition>) => {
    handle.positions = new Map(final);
    handle.settled = true;
    handle.onSettled?.(handle.positions);
  };
  return handle;
}

// Default factory for every test — each created sim is pushed into
// mockForceSims (reset per test in the ST-4 describe's beforeEach).
vi.mocked(createLiveForceSimulation).mockImplementation((options) => {
  const handle = makeMockForceSim(options);
  mockForceSims.push(handle);
  return handle.sim;
});

/** Map node id → {x, y} from rendered ReactFlow nodes. */
function nodePositions(nodes: Array<{ id: string; position: { x: number; y: number } }>): Map<string, NodePosition> {
  return new Map(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
}

/** Byte-identical map comparison (key-sorted so iteration order never matters). */
function expectSamePositions(actual: Map<string, NodePosition>, expected: Map<string, NodePosition>): void {
  const sortEntries = (m: Map<string, NodePosition>) =>
    [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  expect(sortEntries(actual)).toEqual(sortEntries(expected));
}

/** All three node families in one session — chat chain + ToolsNode (right
 *  column) + SubagentNode (left column). Timestamps make the chain order
 *  deterministic (corr-1 oldest → corr-3 newest). */
function makeFullFixture(): ContractDelivery[] {
  const TASK_ARGS = JSON.stringify({
    subagent_type: 'explore',
    prompt: 'Inspect the marker and reply exactly CHILD',
  });
  return [
    // Turn 1 (oldest).
    makeDelivery('i1', 'init', 's1', 'corr-1', {
      userMessage: 'first', startTime: '2026-08-17T10:00:00.000Z',
    }),
    makeDelivery('e1', 'end', 's1', 'corr-1', {
      userMessage: 'first', agentReply: 'reply-1',
      startTime: '2026-08-17T10:00:00.000Z', endTime: '2026-08-17T10:00:20.000Z',
    }),
    // Turn 2 — makes a Bash tool call (→ ToolsNode beside corr-2).
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
    // Turn 3 (newest) — dispatches a subagent (→ SubagentNode beside corr-3).
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

describe('useDeliveryGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
  });

  it('should return empty state for no deliveries', () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [], sessionId: null }),
    );

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.eventCount).toBe(0);
  });

  it('should create agent nodes from chat-node init deliveries', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 's1', {
        agent: 'Architect',
        model: 'claude-sonnet-4',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.eventCount).toBe(1);
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    // First node should be an agent node
    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();
    expect(agentNode!.type).toBe('agentNode');
  });

  it('#2739 ST-1: a chat exchange with tool calls builds a ToolsNode + tools edge', async () => {
    // Replaces the pre-#2739 behavior where tool deliveries were ignored
    // (contract deactivated). The tool-use-lifecycle contract is now active and
    // the builder produces one ToolsNode per chat node whose exchange made tool
    // calls (R-1/R-6).
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        agent: 'Architect',
        userMessage: 'run the tests',
        startTime: '2026-08-14T04:35:00.000Z',
        promptTokens: 100,
        completionTokens: 50,
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'run the tests',
        agentReply: 'done',
        startTime: '2026-08-14T04:35:00.000Z',
        endTime: '2026-08-14T04:35:30.000Z',
        promptTokens: 100,
        completionTokens: 50,
      }),
      makeToolDelivery('d3', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls -la',
        startTime: '2026-08-14T04:35:05.000Z',
      }),
      makeToolDelivery('d4', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls -la',
        output: 'total 48',
        startTime: '2026-08-14T04:35:05.000Z',
        endTime: '2026-08-14T04:35:06.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'tools-chat-corr-1')).toHaveLength(1);
    });

    const toolsNode = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!;
    expect(toolsNode.type).toBe('toolsNode');
    const payload = toolsNode.data.payload as any;
    expect(payload.toolCalls).toHaveLength(1);
    expect(payload.toolCalls[0].toolName).toBe('Bash');
    expect(payload.toolCalls[0].input).toBe('ls -la');
    expect(payload.toolCalls[0].output).toBe('total 48');
    expect(payload.toolCalls[0].correlationId).toBe('tool-corr-1');
    expect(payload.parentCorrelationId).toBe('chat-corr-1');
    expect(payload.sessionId).toBe('s1');
    // #2743 AC-1: the exchange-level figures are no longer mirrored (removed
    // from ToolsNodePayload + associateToolCalls).
    expect(payload.exchangeInputTokens).toBeUndefined();
    expect(payload.exchangeOutputTokens).toBeUndefined();
    expect(payload.exchangeTotalTokens).toBeUndefined();

    // R-6: one edge from the chat node to its OWN ToolsNode, with the explicit
    // source-right → target-left handles (D-5).
    const toolsEdge = result.current.edges.find(e => e.id === 'e-tools-chat-corr-1');
    expect(toolsEdge).toBeDefined();
    expect(toolsEdge!.source).toBe('agent-chat-corr-1');
    expect(toolsEdge!.target).toBe('tools-chat-corr-1');
    expect(toolsEdge!.type).toBe('smoothstep');
    expect(toolsEdge!.sourceHandle).toBe('source-right');
    expect(toolsEdge!.targetHandle).toBe('target-left');
  });

  it('#2739 ST-1: a tool call accumulates through init→update→end into one ToolCallSummary (no legacy tool node)', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d0', 'init', 's1', 'chat-corr-1', {
        userMessage: 'edit the file',
        startTime: '2026-08-14T04:36:00.000Z',
      }),
      makeToolDelivery('d1', 'init', 's1', 'tool-corr-1', 'Edit', {
        input: 'file.ts',
        startTime: '2026-08-14T04:36:05.000Z',
      }),
      makeToolDelivery('d2', 'update', 's1', 'tool-corr-1', 'Edit', {
        input: 'file.ts',
        output: 'ok',
      }),
      makeToolDelivery('d3', 'end', 's1', 'tool-corr-1', 'Edit', {
        input: 'file.ts',
        output: 'changes applied',
        endTime: '2026-08-14T04:36:10.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      const toolsNode = result.current.nodes.find(n => n.id === 'tools-chat-corr-1');
      expect(toolsNode).toBeDefined();
    });

    const toolsNode = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!;
    const calls = (toolsNode.data.payload as any).toolCalls as any[];
    expect(calls).toHaveLength(1);
    // init→update→end merged into ONE summary — the completed output survives.
    expect(calls[0].toolName).toBe('Edit');
    expect(calls[0].input).toBe('file.ts');
    expect(calls[0].output).toBe('changes applied');
    expect(calls[0].endTime).toBe('2026-08-14T04:36:10.000Z');
    // No legacy tool node is created — the ToolsNode summary path owns tool
    // deliveries now (the legacy `tool-` node path stays deactivated).
    expect(result.current.nodes.find(n => n.id === 'tool-tool-corr-1')).toBeUndefined();
  });

  it('#2739 ST-1: association is order-independent — tool deliveries before their chat node resolve the same ToolsNode', async () => {
    // Restored SQLite and live deliveries interleave: tool deliveries arrive
    // FIRST in the array, the chat node's init/end afterwards. The association
    // pass runs over the collected maps, so arrival order must not matter.
    const deliveries: ContractDelivery[] = [
      makeToolDelivery('d1', 'init', 's1', 'tool-corr-1', 'Read', {
        input: 'src/main.ts',
        startTime: '2026-08-14T04:37:05.000Z',
      }),
      makeToolDelivery('d2', 'end', 's1', 'tool-corr-1', 'Read', {
        input: 'src/main.ts',
        output: 'file content',
        startTime: '2026-08-14T04:37:05.000Z',
        endTime: '2026-08-14T04:37:06.000Z',
      }),
      makeDelivery('d3', 'init', 's1', 'chat-corr-1', {
        userMessage: 'read the file',
        startTime: '2026-08-14T04:37:00.000Z',
      }),
      makeDelivery('d4', 'end', 's1', 'chat-corr-1', {
        userMessage: 'read the file',
        agentReply: 'done',
        startTime: '2026-08-14T04:37:00.000Z',
        endTime: '2026-08-14T04:37:30.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'tools-chat-corr-1')).toHaveLength(1);
    });

    const toolsNode = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!;
    const calls = (toolsNode.data.payload as any).toolCalls as any[];
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('Read');
    expect(calls[0].output).toBe('file content');
  });

  it('#2739 R-5: a no-tool exchange produces no ToolsNode; a lone tool delivery without a chat node produces no ToolsNode', async () => {
    const deliveries: ContractDelivery[] = [
      // No-tool exchange in the selected session.
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'say hello',
        startTime: '2026-08-14T04:38:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'say hello',
        agentReply: 'Hello!',
        startTime: '2026-08-14T04:38:00.000Z',
      }),
      // Tool delivery in session s2 — no chat node exists for s2 → unresolved.
      makeToolDelivery('d3', 'init', 's2', 'tool-corr-2', 'Bash', {
        input: 'ls',
        startTime: '2026-08-14T04:38:05.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    // Zero ToolsNodes: chat-corr-1's exchange made no tool calls (R-5 — no node
    // for no-tool exchanges), and the s2 tool call has no chat node to attach to.
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-tools-'))).toHaveLength(0);
  });

  it('#2739 D-2: each tool call attaches to the chat node with the greatest startTime strictly before it — adjacent exchanges get their OWN ToolsNodes', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'chat-1', { userMessage: 'first', startTime: '2026-08-14T04:40:00.000Z' }),
      makeDelivery('e1', 'end', 's1', 'chat-1', { userMessage: 'first', agentReply: 'r1', startTime: '2026-08-14T04:40:00.000Z' }),
      // Tool of exchange 1 — starts after chat-1, before chat-2.
      makeToolDelivery('t1i', 'init', 's1', 'tool-a', 'Bash', { input: 'ls', startTime: '2026-08-14T04:40:10.000Z' }),
      makeToolDelivery('t1e', 'end', 's1', 'tool-a', 'Bash', { input: 'ls', output: 'ok', startTime: '2026-08-14T04:40:10.000Z' }),
      makeDelivery('i2', 'init', 's1', 'chat-2', { userMessage: 'second', startTime: '2026-08-14T04:41:00.000Z' }),
      makeDelivery('e2', 'end', 's1', 'chat-2', { userMessage: 'second', agentReply: 'r2', startTime: '2026-08-14T04:41:00.000Z' }),
      // Tool of exchange 2 — starts after chat-2.
      makeToolDelivery('t2i', 'init', 's1', 'tool-b', 'Read', { input: 'a.ts', startTime: '2026-08-14T04:41:10.000Z' }),
      makeToolDelivery('t2e', 'end', 's1', 'tool-b', 'Read', { input: 'a.ts', output: 'c', startTime: '2026-08-14T04:41:10.000Z' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(2);
    });

    const tools1 = result.current.nodes.find(n => n.id === 'tools-chat-1')!;
    const tools2 = result.current.nodes.find(n => n.id === 'tools-chat-2')!;
    expect((tools1.data.payload as any).parentCorrelationId).toBe('chat-1');
    expect((tools1.data.payload as any).toolCalls[0].toolName).toBe('Bash');
    expect((tools2.data.payload as any).parentCorrelationId).toBe('chat-2');
    expect((tools2.data.payload as any).toolCalls[0].toolName).toBe('Read');

    // Two independent edges — each ToolsNode connected to ITS OWN chat node
    // (R-6: no cross-links to a neighbor).
    const edge1 = result.current.edges.find(e => e.id === 'e-tools-chat-1');
    const edge2 = result.current.edges.find(e => e.id === 'e-tools-chat-2');
    expect(edge1).toBeDefined();
    expect(edge1!.source).toBe('agent-chat-1');
    expect(edge1!.target).toBe('tools-chat-1');
    expect(edge2).toBeDefined();
    expect(edge2!.source).toBe('agent-chat-2');
    expect(edge2!.target).toBe('tools-chat-2');
  });

  it('#2739 NFR-1/D-1: per-call tokens are zero-guarded; gen_ai.tool.name is the primary name path', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'x',
        startTime: '2026-08-14T04:42:00.000Z',
      }),
      // gen_ai.tool.name wins over tool_name (innerPayload overrides the helper
      // default); token fields absent → zero-guarded to 0 (NFR-1 — opencode
      // tool spans carry no gen_ai.usage.*).
      makeToolDelivery('d2', 'end', 's1', 'tool-corr-1', 'fallback-name', {
        'gen_ai.tool.name': 'read_file',
        input: 'a.ts',
        output: 'content',
        startTime: '2026-08-14T04:42:05.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'tools-chat-corr-1')).toBeDefined();
    });

    const payload = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!.data.payload as any;
    expect(payload.toolCalls[0].toolName).toBe('read_file');
    expect(payload.toolCalls[0].inputTokens).toBe(0);
    expect(payload.toolCalls[0].reasoningTokens).toBe(0);
    expect(payload.toolCalls[0].outputTokens).toBe(0);
    expect(payload.toolCalls[0].totalTokens).toBe(0);
  });

  it('#2743 ST-1 (AC-12): the agent node payload carries costUsd from the delivered cost_usd flat attr', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        agent: 'Architect',
        userMessage: 'x',
        startTime: '2026-08-14T04:44:00.000Z',
        promptTokens: 100,
        completionTokens: 50,
        cost_usd: 0.0234,
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        agent: 'Architect',
        userMessage: 'x',
        agentReply: 'done',
        startTime: '2026-08-14T04:44:00.000Z',
        promptTokens: 100,
        completionTokens: 50,
        cost_usd: 0.0234,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      const node = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(node).toBeDefined();
      expect((node!.data.payload as any).costUsd).toBe(0.0234);
    });
  });

  it('#2743 ST-1 (AC-12): costUsd stays absent when the delivery never carried cost_usd (degrades to neutral)', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'x',
        startTime: '2026-08-14T04:45:00.000Z',
        promptTokens: 100,
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'x',
        agentReply: 'done',
        startTime: '2026-08-14T04:45:00.000Z',
        promptTokens: 100,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-chat-corr-1')).toBeDefined();
    });

    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(payload.costUsd).toBeUndefined();
  });

  it('#2743 ST-1 (AC-9/AC-10): the ToolCallSummary carries success / error / durationMs from the literal-dot flat keys', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'run the failing command',
        startTime: '2026-08-14T04:46:00.000Z',
      }),
      makeToolDelivery('d2', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'exit 1',
        startTime: '2026-08-14T04:46:05.000Z',
      }),
      makeToolDelivery('d3', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'exit 1',
        output: 'Error: command failed',
        startTime: '2026-08-14T04:46:05.000Z',
        endTime: '2026-08-14T04:46:06.250Z',
        // The literal-dot flat attrs the plugin emits (message.ts:545/556/546).
        'tool.success': false,
        'tool.error': 'exit code 1',
        'duration_ms': 1250,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'tools-chat-corr-1')).toBeDefined();
    });

    const payload = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!.data.payload as any;
    const call = payload.toolCalls[0];
    expect(call.success).toBe(false);
    expect(call.error).toBe('exit code 1');
    expect(call.durationMs).toBe(1250);
  });

  it('#2743 ST-1 (AC-9/AC-10): absent outcome keys keep the summary neutral — no phantom success/error/duration', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'read the file',
        startTime: '2026-08-14T04:47:00.000Z',
      }),
      // A restored/legacy tool delivery without the #2743 attrs.
      makeToolDelivery('d2', 'end', 's1', 'tool-corr-1', 'Read', {
        input: 'a.ts',
        output: 'content',
        startTime: '2026-08-14T04:47:05.000Z',
        endTime: '2026-08-14T04:47:06.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'tools-chat-corr-1')).toBeDefined();
    });

    const payload = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!.data.payload as any;
    const call = payload.toolCalls[0];
    expect(call.success).toBeUndefined();
    expect(call.error).toBeUndefined();
    expect(call.durationMs).toBeUndefined();
  });

  it('#2743 ST-1 (AC-9/AC-10): success/error/duration are last-wins across init→end and a later delivery never clears them', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'edit the file',
        startTime: '2026-08-14T04:48:00.000Z',
      }),
      // Init: no outcome attrs yet (in-progress).
      makeToolDelivery('d2', 'init', 's1', 'tool-corr-1', 'Edit', {
        input: 'a.ts',
        startTime: '2026-08-14T04:48:05.000Z',
      }),
      // Update: duration arrives first.
      makeToolDelivery('d3', 'update', 's1', 'tool-corr-1', 'Edit', {
        'duration_ms': 800,
      }),
      // End: success + error-less completion (green default at render).
      makeToolDelivery('d4', 'end', 's1', 'tool-corr-1', 'Edit', {
        input: 'a.ts',
        output: 'changes applied',
        startTime: '2026-08-14T04:48:05.000Z',
        endTime: '2026-08-14T04:48:05.800Z',
        'tool.success': true,
        'duration_ms': 800,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'tools-chat-corr-1')).toBeDefined();
    });

    const payload = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!.data.payload as any;
    const call = payload.toolCalls[0];
    expect(call.success).toBe(true);
    expect(call.error).toBeUndefined();
    expect(call.durationMs).toBe(800);
  });

  it('#2739 NFR-3: the ToolsNode sits in the deterministic right-side chain slot (x = TOOLS_CHAIN_X, y = parent y)', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'x',
        startTime: '2026-08-14T04:43:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'x',
        agentReply: 'r',
        startTime: '2026-08-14T04:43:00.000Z',
      }),
      makeToolDelivery('d3', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls',
        startTime: '2026-08-14T04:43:05.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'tools-chat-corr-1')).toBeDefined();
    });

    const toolsNode = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!;
    const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!;
    // Right of the chat chain: x = CHAIN_X_CENTER + AGENT_NODE_MAX_WIDTH +
    // TOOLS_GAP = TOOLS_CHAIN_X; y aligned with the parent chat node (NFR-3).
    expect(toolsNode.position.x).toBe(TOOLS_CHAIN_X);
    expect(toolsNode.position.y).toBe(agentNode.position.y);
  });

  it('AC5: composited-child chat-node delivery produces NO subagent node (exclusion)', async () => {
    // Spec #2723 AC5 reverses Spec #523: a delivery carrying
    // compositedChildSessionId (the old ECE-compositing detection signal) must
    // never create a SubagentNode. The contract's excludePayload filter stops
    // such events at the engine; the builder itself also has no subagent path.
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-s1', correlationId: 'sa-corr-1' },
        payload: {
          compositedChildSessionId: 'sa-corr-1',
          payload: {
            name: 'Coder',
            instruction: 'Implement feature X',
            output: '',
            // Legacy paths for backward compat
            properties: {
              info: { agent: 'Coder', title: 'Implement feature X' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-s1' }),
    );

    // The delivery is processed through the (subagent-less) agent path — wait
    // for the effect to run so the exclusion assertion is post-processing.
    await waitFor(() => {
      expect(result.current.eventCount).toBe(1);
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    // Zero subagent-derived entries/nodes/edges — AC5 exclusion holds.
    const saNodes = result.current.nodes.filter(n => n.id.startsWith('subagent-'));
    expect(saNodes).toHaveLength(0);
    const saEdges = result.current.edges.filter(e =>
      e.source.startsWith('subagent-') || e.target.startsWith('subagent-'),
    );
    expect(saEdges).toHaveLength(0);
  });

  it('should pass all contract types through sessionDeliveries filter', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'session-a', 'session-a', { agent: 'Agent A' }),
      makeToolDelivery('d2', 'init', 'session-a', 'tool-1', 'Bash'),
      makeDelivery('d3', 'init', 'session-b', 'session-b', { agent: 'Agent B' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'session-a' }),
    );

    // session-a has 2 deliveries, session-b has 1
    expect(result.current.eventCount).toBe(2);
  });

  it('#2745 ST-4: a tool delivery with a `files` payload produces the ToolsNode summary — the legacy file-node path is gone (AC-5)', async () => {
    // The dead fileNodes builder path was removed (#2745 ST-4) — a `files`
    // field in the tool payload is inert (the ToolsNode accordion owns the
    // tool-call representation; no file node is ever created).
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'read the file',
        startTime: '2026-08-15T11:00:00.000Z',
      }),
      makeToolDelivery('d2', 'end', 's1', 'tool-corr-1', 'Read', {
        input: 'src/main.ts',
        output: 'content',
        files: [
          { path: 'src/main.ts', operation: 'read' },
        ],
        startTime: '2026-08-15T11:00:05.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.eventCount).toBe(2);
      expect(result.current.nodes.filter(n => n.id === 'tools-chat-corr-1')).toHaveLength(1);
    });

    // The tool call lands in the ToolsNode accordion (its summary owns the
    // tool-call representation)…
    const toolsPayload = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!.data.payload as any;
    expect(toolsPayload.toolCalls[0].toolName).toBe('Read');
    // …and NO file node is created anywhere (the dead path is gone).
    expect(result.current.nodes.filter(n => n.id.includes('file'))).toHaveLength(0);
  });

  it('should handle mixed contract types in the same session', async () => {
    const deliveries: ContractDelivery[] = [
      // Agent node first
      makeDelivery('d1', 'init', 's1', 's1', {
        agent: 'Architect',
        model: 'claude-sonnet-4',
      }),
      // Tool deliveries
      makeToolDelivery('d2', 'init', 's1', 'tool-corr-1', 'Bash', { input: 'ls' }),
      makeToolDelivery('d3', 'end', 's1', 'tool-corr-1', 'Bash', { input: 'ls', output: 'ok' }),
      // Subagent-shaped delivery (compositedChildSessionId — #2723 AC5 exclusion:
      // the builder has no subagent path, so it must NOT render a SubagentNode).
      {
        id: 'd4', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 's1', correlationId: 'sa-corr-1' },
        payload: {
          compositedChildSessionId: 'sa-corr-1',
          payload: {
            name: 'Coder',
            instruction: 'Implement',
            output: '',
            // Legacy paths for backward compat
            properties: {
              info: { agent: 'Coder', title: 'Implement' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.eventCount).toBe(4);
      // Agent node
      expect(result.current.nodes.filter(n => n.type === 'agentNode').length).toBeGreaterThanOrEqual(1);
    });

    // AC5: zero subagent-derived nodes despite the subagent-shaped delivery.
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
  });

  it('should NOT increment layoutVersion on dimension changes (force layout runs in processing effect)', async () => {
    // Two agent nodes in different sessions
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'node-sess-1', 'node-sess-1', {
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: 'Response', reasoning: 'Thinking...' },
        turnInputTokens: 100,
        turnOutputTokens: 50,
      }),
      makeDelivery('d2', 'init', 'node-sess-2', 'node-sess-2', {
        info: { text: 'Follow-up', modelID: 'claude-sonnet-4', agent: 'Coder' },
        part: { text: 'Code', reasoning: 'Implementing...' },
        turnInputTokens: 50,
        turnOutputTokens: 25,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'node-sess-1' }),
    );

    // Wait for the agent node to be created
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    expect(result.current.layoutVersion).toBe(0);

    // Trigger dimension change on an existing node
    act(() => {
      result.current.onNodesChange([
        { type: 'dimensions', id: 'agent-node-sess-1', dimensions: { width: 300, height: 200 }, updateStyle: true },
      ] as any);
    });

    // layoutVersion should remain 0 (no forced layout recomputation)
    expect(result.current.layoutVersion).toBe(0);
  });

  it('should NOT increment layoutVersion on non-dimension changes', () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [], sessionId: 's1' }),
    );

    expect(result.current.layoutVersion).toBe(0);

    act(() => {
      result.current.onNodesChange([
        { type: 'position', id: 'agent-nonexistent', position: { x: 100, y: 200 } },
      ] as any);
    });

    expect(result.current.layoutVersion).toBe(0);
  });

  it('should filter deliveries by sessionId', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'session-a', 'session-a', { agent: 'Agent A' }),
      makeDelivery('d2', 'init', 'session-b', 'session-b', { agent: 'Agent B' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'session-a' }),
    );

    expect(result.current.eventCount).toBe(1);
  });

  it('should return empty for sessionId null', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 's1'),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: null }),
    );

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.eventCount).toBe(0);
  });
});

// ── ChatNode Label (R-4) ────────────────────────────────────────────

describe('ChatNode Label', () => {
  it('R-4: ChatNode label renders "agent · model" when both are present', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 's1', {
        agent: 'opencode',
        model: 'deepseek-v4-flash',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();
    expect(agentNode!.data.label).toBe('opencode · deepseek-v4-flash');
  });

  it('R-4: ChatNode label falls back to the agent alone when model is absent', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 's1', {
        agent: 'build',
        model: '',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();
    expect(agentNode!.data.label).toBe('build');
  });

  it('R-4: ChatNode label falls back to the model alone when agent is absent', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 's1', {
        agent: '',
        model: 'claude-sonnet-4',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();
    expect(agentNode!.data.label).toBe('claude-sonnet-4');
  });

  it('R-4: ChatNode label renders "Chat" when neither agent nor model is present', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 's1'),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();
    expect(agentNode!.data.label).toBe('Chat');
  });
});

// ── End Lifecycle Concatenation (AC-5) ───────────────────────────────

describe('ChatNode Lifecycle Concatenation', () => {
  it('AC-5: ChatNode agentReply concatenates across update and end lifecycle, preserving all text', async () => {
    const deliveries: ContractDelivery[] = [
      // Init — creates the agent node
      makeDelivery('d1', 'init', 's1', 's1', {
        agent: 'Architect',
        userMessage: 'Hello',
        agentReply: '',
        promptTokens: 10,
        completionTokens: 5,
        // Legacy fields for backward compat
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
      }),
      // Update — first response chunk
      makeDelivery('d2', 'update', 's1', 's1', {
        agentReply: 'Sure, I can ',
        promptTokens: 10,
        completionTokens: 5,
        // Legacy for backward compat
        part: { text: 'Sure, I can ', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
      }),
      // End — final response chunk
      makeDelivery('d3', 'end', 's1', 's1', {
        agentReply: 'help you with that!',
        promptTokens: 10,
        completionTokens: 5,
        // Legacy for backward compat
        part: { text: 'help you with that!', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      // After processing all lifecycle stages, the agent node should exist
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    // The deliverable payload is in the node data payload
    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();

    const agentReply = (agentNode!.data.payload as any)?.agentReply as string;
    expect(agentReply).toBe('Sure, I can help you with that!');
  });

  it('end lifecycle skips duplicate agentReply when already contained', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 's1', {
        agentReply: '',
        // Legacy for backward compat
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
      }),
      // Update — first chunk
      makeDelivery('d2', 'update', 's1', 's1', {
        agentReply: 'Hello world',
        // Legacy for backward compat
        part: { text: 'Hello world', reasoning: '' },
      }),
      // End — same text arrives again (should dedup)
      makeDelivery('d3', 'end', 's1', 's1', {
        agentReply: 'Hello world',
        // Legacy for backward compat
        part: { text: 'Hello world', reasoning: '' },
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();

    const agentReply = (agentNode!.data.payload as any)?.agentReply as string;
    // Dedup should prevent 'Hello worldHello world'
    expect(agentReply).toBe('Hello world');
  });
});

// ── AC5: Subagent exclusion (Spec #523 reversal) ─────────────────────
//
// #2723 AC5: subagent-derived chat-node deliveries must produce ZERO
// entries/nodes/edges in Mission Monitor. The chat-node contract declares
// excludePayload rules (is_subagent / agent.type) so the engine filters such
// events before they reach the frontend, and the graph builder has no subagent
// path at all (Contract-Trust Cleanup). These cases pin the builder side: even
// when a subagent-shaped delivery (compositedChildSessionId / is_subagent /
// agent.type) is fed directly, no subagent artifact is ever created.

describe('Subagent exclusion (AC5 — Spec #523 reversal)', () => {
  // Shared helper: assert zero subagent-derived nodes and edges on the result.
  function expectNoSubagentArtifacts(result: { current: { nodes: any[]; edges: any[] } }) {
    const saNodes = result.current.nodes.filter((n) => n.id.startsWith('subagent-'));
    expect(saNodes).toHaveLength(0);
    const saEdges = result.current.edges.filter((e) =>
      e.source.startsWith('subagent-') || e.target.startsWith('subagent-'),
    );
    expect(saEdges).toHaveLength(0);
  }

  it('AC5: compositedChildSessionId delivery across init→update creates no subagent node', async () => {
    // Formerly "SubagentNode accumulates output through update lifecycle".
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-s5', correlationId: 'sa-corr-5' },
        payload: {
          compositedChildSessionId: 'sa-corr-5',
          payload: {
            name: 'coder',
            instruction: 'Implement feature X',
            output: '',
            properties: {
              info: { agent: 'coder', title: 'Implement feature X' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'update',
        key: { sessionId: 'parent-s5', correlationId: 'sa-corr-5' },
        payload: {
          compositedChildSessionId: 'sa-corr-5',
          payload: {
            output: 'Let me write the code now',
            part: { text: 'Let me write the code now', reasoning: '' },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-s5' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    expectNoSubagentArtifacts(result);
  });

  it('AC5: compositedChildSessionId delivery across init→end creates no subagent node', async () => {
    // Formerly "subagent end delivery passes output through unchanged". The
    // delivery is subagent-shaped (output/part.text) — the chat-node path does
    // NOT consume those (Contract-Trust Cleanup: only the adapter-injected
    // typed fields). Its end delivery carries no agentReply, so the completed
    // chat entry is a #2750 AC4 transitional text-less turn → it renders NO
    // node at all (neither agent nor subagent).
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-s6', correlationId: 'sa-corr-6' },
        payload: {
          compositedChildSessionId: 'sa-corr-6',
          payload: {
            name: 'reviewer',
            instruction: 'Review the PR',
            output: '',
            properties: {
              info: { agent: 'reviewer', title: 'Review the PR' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'end',
        key: { sessionId: 'parent-s6', correlationId: 'sa-corr-6' },
        payload: {
          compositedChildSessionId: 'sa-corr-6',
          payload: {
            output: 'Changes look good, approved!',
            part: { text: 'Changes look good, approved!', reasoning: '' },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-s6' }),
    );

    // Settle on the processed event count (the delivery set is synchronous),
    // then assert the completed text-less chat entry is suppressed from the
    // canvas — ZERO nodes — and zero subagent artifacts.
    await waitFor(() => {
      expect(result.current.eventCount).toBe(2);
    });
    expect(result.current.nodes).toHaveLength(0);

    expectNoSubagentArtifacts(result);
  });

  it('AC5: a subagent init with instruction/output fields creates no subagent node', async () => {
    // Formerly BUG-1 (instruction/output extraction) — the whole subagent path
    // is gone, so no node carries subagent instruction/output semantics.
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-b1', correlationId: 'sa-corr-b1' },
        payload: {
          compositedChildSessionId: 'sa-corr-b1',
          payload: {
            name: 'coder',
            instruction: 'Analyze code',
            output: 'Analyze code',
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-b1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    expectNoSubagentArtifacts(result);
  });

  it('AC5: agentReply/response_text on a subagent-shaped delivery never renders as subagent output', async () => {
    // Formerly BUG-1 (agentReply preferred over output) + BUG-1 (response_text
    // preferred over output) — combined into one exclusion case.
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-b1b', correlationId: 'sa-corr-b1b' },
        payload: {
          compositedChildSessionId: 'sa-corr-b1b',
          payload: {
            name: 'coder',
            instruction: 'Analyze code',
            output: 'Analyze code',
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'update',
        key: { sessionId: 'parent-b1b', correlationId: 'sa-corr-b1b' },
        payload: {
          compositedChildSessionId: 'sa-corr-b1b',
          payload: {
            output: 'Analyze code',
            agentReply: 'The code looks clean and well-structured.',
            response_text: 'Module refactored successfully.',
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-b1b' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    expectNoSubagentArtifacts(result);
  });
});

// ── AC5: cross-session subagent exclusion (Spec #523 reversal) ─────────────

describe('Subagent exclusion — cross-session (AC5)', () => {
  it('AC5: an OTLP subagent session (is_subagent/agent.type) leaks no node into the selected session', async () => {
    // Formerly BUG-3 (SubagentNode layout order). The OTLP subagent delivery
    // carries its own sessionId + is_subagent/agent.type markers — under
    // Spec #523 it created a SubagentNode linked to the parent. Under #2723
    // AC5 it must produce NO subagent artifact: the builder has no subagent
    // path, and the session-scoped filter shows only the selected parent
    // session's own chat activity.
    const deliveries: ContractDelivery[] = [
      // Parent agent (selected session)
      makeDelivery('d1', 'init', 'parent-session-b3', 'agent-corr-b3', {
        agent: 'Architect',
        userMessage: 'Analyze this code',
        agentReply: '',
        promptTokens: 10,
        completionTokens: 5,
      }),
      // OTLP subagent-shaped delivery — own session, subagent markers
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'sub-session-b3', correlationId: 'sub-corr-b3' },
        payload: {
          payload: {
            name: 'code-reviewer',
            instruction: '',
            output: '',
            is_subagent: true,
            'agent.type': 'subagent',
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-session-b3' }),
    );

    await waitFor(() => {
      // Only the parent session's own agent node is visible.
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    // Zero subagent-derived nodes/edges — AC5 exclusion holds across sessions.
    const saNodes = result.current.nodes.filter(n => n.id.startsWith('subagent-'));
    expect(saNodes).toHaveLength(0);
    const saEdges = result.current.edges.filter(e =>
      e.source.startsWith('subagent-') || e.target.startsWith('subagent-'),
    );
    expect(saEdges).toHaveLength(0);

    // The parent agent node itself is present and unchanged.
    const agentNode = result.current.nodes.find(n => n.id === 'agent-agent-corr-b3');
    expect(agentNode).toBeDefined();
  });
});

// ── #2688 ST11: shrink-safe incremental delivery consumption ───────────────

describe('ST11 — shrink-safe incremental delivery consumption (#2688)', () => {
  it('no silent gap: all deliveries reach the graph after the input array is TTL-shrunk below the cursor', async () => {
    const d1 = makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' });
    const d2 = makeDelivery('d2', 'init', 's1', 'corr-2', { userMessage: 'second' });
    const d3 = makeDelivery('d3', 'init', 's1', 'corr-3', { userMessage: 'third' });
    const d4 = makeDelivery('d4', 'init', 's1', 'corr-4', { userMessage: 'fourth' });
    const d5 = makeDelivery('d5', 'init', 's1', 'corr-5', { userMessage: 'fifth' });
    const d6 = makeDelivery('d6', 'init', 's1', 'corr-6', { userMessage: 'sixth' });
    const d7 = makeDelivery('d7', 'init', 's1', 'corr-7', { userMessage: 'seventh' });
    const d8 = makeDelivery('d8', 'init', 's1', 'corr-8', { userMessage: 'eighth' });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: [d1, d2, d3] } },
    );

    // (a) feed N=3 deliveries.
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(3);
    });

    // (b) TTL shrink — oldest M=2 evicted from the front.
    rerender({ deliveries: [d3] });

    // (c) feed N+M=5 more — the array re-grows past the OLD cursor (3).
    rerender({ deliveries: [d3, d4, d5, d6, d7, d8] });

    // (d) all 8 deliveries that were fed (3 initial + 5 after the shrink)
    // reach the graph — no silent gap.
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(8);
    });
    for (let i = 1; i <= 8; i++) {
      expect(result.current.nodes.find((n) => n.id === `agent-corr-${i}`)).toBeDefined();
    }
  });

  it('array re-grows past the old cursor after a shrink without stale-index skip', async () => {
    const d1 = makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' });
    const d2 = makeDelivery('d2', 'init', 's1', 'corr-2', { userMessage: 'second' });
    const d3 = makeDelivery('d3', 'init', 's1', 'corr-3', { userMessage: 'third' });
    const d4 = makeDelivery('d4', 'init', 's1', 'corr-4', { userMessage: 'fourth' });
    const d5 = makeDelivery('d5', 'init', 's1', 'corr-5', { userMessage: 'fifth' });
    const d6 = makeDelivery('d6', 'init', 's1', 'corr-6', { userMessage: 'sixth' });
    const d7 = makeDelivery('d7', 'init', 's1', 'corr-7', { userMessage: 'seventh' });
    const d8 = makeDelivery('d8', 'init', 's1', 'corr-8', { userMessage: 'eighth' });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: [d1, d2, d3, d4] } },
    );

    // N=4 initial.
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(4);
    });

    // Shrink — remove the 3 oldest (old cursor 4 > 1 → reset).
    rerender({ deliveries: [d4] });

    // Growth batch 1: len 3 is still BELOW the old cursor of 4 — d5, d6 must
    // NOT be silently skipped.
    rerender({ deliveries: [d4, d5, d6] });
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(6);
    });

    // Growth batch 2: len 5 now exceeds the old cursor — d7, d8 emitted too.
    rerender({ deliveries: [d4, d5, d6, d7, d8] });
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(8);
    });

    for (let i = 1; i <= 8; i++) {
      expect(result.current.nodes.find((n) => n.id === `agent-corr-${i}`)).toBeDefined();
    }
  });

  it('duplicate delivery ids are not double-processed (update concatenation does not duplicate text)', async () => {
    // The SAME delivery id emitted twice (re-emitted by the bus / post-shrink
    // re-scan). The update must be processed exactly once, otherwise the
    // non-idempotent concatenation in processDelivery would produce "chunkchunk".
    const d1Init = makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'hello' });
    const d2Update = makeDelivery('d2', 'update', 's1', 'corr-1', { agentReply: 'chunk' });
    const d2UpdateDup = makeDelivery('d2', 'update', 's1', 'corr-1', { agentReply: 'chunk' });

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [d1Init, d2Update, d2UpdateDup], sessionId: 's1' }),
    );

    await waitFor(() => {
      const agentNode = result.current.nodes.find((n) => n.id.startsWith('agent-'));
      expect(agentNode).toBeDefined();
    });

    const agentNode = result.current.nodes.find((n) => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();
    // Only ONE agent node for the correlationId.
    expect(result.current.nodes.filter((n) => n.id === 'agent-corr-1')).toHaveLength(1);
    const agentReply = (agentNode!.data.payload as any)?.agentReply as string;
    expect(agentReply).toBe('chunk');
  });
});

// ── Graph Edge + Unified Session View (AC5 exclusion) ────────────────

describe('Subagent Graph Integration — AC5 exclusion', () => {
  it('AC5: a subagent dispatch renders no subagent node and no subagent edge', async () => {
    // Parent agent + subagent-shaped delivery (ECE compositedChildSessionId).
    // Under #2723 AC5 the graph shows ZERO subagent-derived entries — only the
    // parent session's own chat activity (its AgentNode + chat chain edges).
    const deliveries: ContractDelivery[] = [
      // Parent agent init
      makeDelivery('d1', 'init', 'parent-s7', 'parent-s7', {
        agent: 'Architect',
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
        event_type: 'UserPromptSubmit',
      }),
      // Subagent-shaped chat-node init with compositedChildSessionId
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-s7', correlationId: 'sa-corr-7' },
        payload: {
          compositedChildSessionId: 'sa-corr-7',
          payload: {
            name: 'coder',
            instruction: 'Implement',
            output: '',
            properties: {
              info: { agent: 'coder', title: 'Implement' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-s7' }),
    );

    await waitFor(() => {
      // The parent agent node renders.
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-')).length).toBeGreaterThanOrEqual(1);
    });

    // Zero subagent nodes and zero edges touching a subagent node.
    const saNodes = result.current.nodes.filter(n => n.id.startsWith('subagent-'));
    expect(saNodes).toHaveLength(0);
    const saEdges = result.current.edges.filter(e =>
      e.source.startsWith('subagent-') || e.target.startsWith('subagent-'),
    );
    expect(saEdges).toHaveLength(0);
  });

  it('AC5: selecting the parent session shows only parent chat activity — no subagent edge', async () => {
    const deliveries: ContractDelivery[] = [
      // Parent agent
      makeDelivery('d1', 'init', 'parent-s8', 'parent-s8', {
        agent: 'Architect',
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
        event_type: 'UserPromptSubmit',
      }),
      // Subagent-shaped delivery with compositedChildSessionId
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-s8', correlationId: 'sa-corr-8' },
        payload: {
          compositedChildSessionId: 'sa-corr-8',
          payload: {
            name: 'coder',
            instruction: 'Implement feature',
            output: '',
            properties: {
              info: { agent: 'coder', title: 'Implement feature' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-s8' }),
    );

    await waitFor(() => {
      // Parent chat activity renders.
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-')).length).toBeGreaterThanOrEqual(1);
    });

    // Agent node exists (parent session's own activity).
    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();

    // Zero subagent nodes/edges — AC5 exclusion.
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
    expect(result.current.edges.filter(e =>
      e.source.startsWith('subagent-') || e.target.startsWith('subagent-'),
    )).toHaveLength(0);
  });
});

// ── #2745 ST-4: rich SubagentNode data path + `task` exclusion ─────────────
//
// The parent's `task` tool call represents a whole delegated session: it is
// split out of the ToolsNode list and rendered as one rich SubagentNode per
// user-requested dispatch (R-1), gated by the AC-4 internal-agent exclusion.
// Fixtures feed the LIVE adapter shape (G-011) — each turn is an init+end pair
// for the same correlationId in ONE batch; the ST-1-pinned task-args keys are
// `subagent_type` (name) + `prompt` (instruction), with the AC-2 canonical
// child keys (`childSessionId`/`childAgent`/`childTokens`/`childCost`/
// `childMessages`) projected by ST-3.

describe('#2745 ST-4: SubagentNode data path + task-tool exclusion', () => {
  // Live-shaped task-args JSON (ST-1 Phase-0: `subagent_type`/`prompt`).
  const TASK_ARGS = JSON.stringify({
    subagent_type: 'explore',
    description: 'Investigate the marker',
    prompt: 'Investigate marker e2e-2745-8f3c1d2a and reply exactly CHILD',
  });

  it('R-1: a user-requested `task` dispatch (init+end in one batch) renders one rich SubagentNode', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        agent: 'Architect',
        userMessage: 'delegate this',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        agent: 'Architect',
        userMessage: 'delegate this',
        agentReply: 'done',
        startTime: '2026-08-15T10:00:00.000Z',
        endTime: '2026-08-15T10:01:00.000Z',
      }),
      // The task dispatch — init+end pair, one correlationId, one batch.
      makeToolDelivery('d3', 'init', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-15T10:00:05.000Z',
      }),
      makeToolDelivery('d4', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: 'CHILD-e2e-2745-8f3c1d2a',
        startTime: '2026-08-15T10:00:05.000Z',
        endTime: '2026-08-15T10:00:45.000Z',
        'duration_ms': 40000,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    const saNode = result.current.nodes.find(n => n.id === 'subagent-task-corr-1')!;
    // One rich SubagentNode with the ST-1-pinned name/instruction + output.
    expect(saNode.type).toBe('subagentNode');
    const payload = saNode.data.payload as any;
    expect(payload.name).toBe('explore');
    expect(payload.instruction).toBe('Investigate marker e2e-2745-8f3c1d2a and reply exactly CHILD');
    expect(payload.output).toBe('CHILD-e2e-2745-8f3c1d2a');
    expect(payload.durationMs).toBe(40000);
    expect(payload.parentCorrelationId).toBe('chat-corr-1');
    expect(payload.correlationId).toBe('task-corr-1');
    expect(payload.sessionId).toBe('s1');

    // R-1: edge-connected like the ToolsNode — parent source-left → subagent
    // target-right (subagents sit LEFT of the chat chain).
    const edge = result.current.edges.find(e => e.id === 'e-calls-task-corr-1');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('agent-chat-corr-1');
    expect(edge!.target).toBe('subagent-task-corr-1');
    expect(edge!.sourceHandle).toBe('source-left');
    expect(edge!.targetHandle).toBe('target-right');
    expect(edge!.type).toBe('smoothstep');
  });

  it('R-2: a child-completion delivery populates the node payload (canonical AC-2 keys)', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        agent: 'Architect',
        userMessage: 'delegate',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        agent: 'Architect',
        userMessage: 'delegate',
        agentReply: 'done',
        startTime: '2026-08-15T10:00:00.000Z',
        endTime: '2026-08-15T10:01:00.000Z',
      }),
      // Init: dispatch intent only — NO child data yet (working state).
      makeToolDelivery('d3', 'init', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-15T10:00:05.000Z',
      }),
      // End: the ST-3 canonical child-completion keys arrive AFTER the child
      // completes (payload.childSessionId / childAgent / childTokens /
      // childCost / childMessages).
      makeToolDelivery('d4', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: 'CHILD-done',
        startTime: '2026-08-15T10:00:05.000Z',
        endTime: '2026-08-15T10:00:45.000Z',
        childSessionId: 'ses_child_8f3c1d2a',
        childAgent: 'explore',
        childTokens: 1234,
        childCost: 0.0456,
        childMessages: 12,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      const saNode = result.current.nodes.find(n => n.id === 'subagent-task-corr-1');
      expect(saNode).toBeDefined();
    });

    const payload = result.current.nodes.find(n => n.id === 'subagent-task-corr-1')!.data.payload as any;
    expect(payload.childSessionId).toBe('ses_child_8f3c1d2a');
    expect(payload.childAgent).toBe('explore');
    expect(payload.childTokens).toBe(1234);
    expect(payload.childCost).toBe(0.0456);
    expect(payload.childMessages).toBe(12);
  });

  it('R-2: absent child-completion fields stay absent (no phantom zeros until the child completes)', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'delegate',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      // The dispatch delivery carries NO child-completion keys (child still in
      // flight) — the node payload must keep them ABSENT, never 0/undefined
      // artifacts that would render as phantom figures.
      makeToolDelivery('d2', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: '',
        startTime: '2026-08-15T10:00:05.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    const payload = result.current.nodes.find(n => n.id === 'subagent-task-corr-1')!.data.payload as any;
    expect(payload.childSessionId).toBeUndefined();
    expect(payload.childAgent).toBeUndefined();
    expect(payload.childTokens).toBeUndefined();
    expect(payload.childCost).toBeUndefined();
    expect(payload.childMessages).toBeUndefined();
  });

  it('R-4/AC-4: an internal-agent `task` dispatch (build/plan) creates NO SubagentNode AND no ToolsNode item', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'run the tool',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'run the tool',
        agentReply: 'done',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      // Internal opencode tool-execution dispatch — name key `build`.
      makeToolDelivery('d3', 'end', 's1', 'task-corr-1', 'task', {
        input: JSON.stringify({ subagent_type: 'build', prompt: 'execute tool' }),
        output: 'ok',
        startTime: '2026-08-15T10:00:05.000Z',
        endTime: '2026-08-15T10:00:06.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    // Zero subagent nodes AND zero ToolsNodes (the internal dispatch is dropped
    // from BOTH paths — no node, no tool item).
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-calls-'))).toHaveLength(0);
  });

  it('R-3/AC-3: the `task` call is split OUT of ToolsNodePayload.toolCalls — other tools still appear', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'delegate + run a tool',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'delegate + run a tool',
        agentReply: 'done',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      // An ordinary tool call in the SAME exchange.
      makeToolDelivery('d3', 'init', 's1', 'tool-corr-bash', 'Bash', {
        input: 'ls -la',
        startTime: '2026-08-15T10:00:10.000Z',
      }),
      makeToolDelivery('d4', 'end', 's1', 'tool-corr-bash', 'Bash', {
        input: 'ls -la',
        output: 'total 48',
        startTime: '2026-08-15T10:00:10.000Z',
        endTime: '2026-08-15T10:00:11.000Z',
      }),
      // The subagent dispatch in the SAME exchange.
      makeToolDelivery('d5', 'init', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-15T10:00:05.000Z',
      }),
      makeToolDelivery('d6', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: 'CHILD-done',
        startTime: '2026-08-15T10:00:05.000Z',
        endTime: '2026-08-15T10:00:45.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
      expect(result.current.nodes.filter(n => n.id === 'tools-chat-corr-1')).toHaveLength(1);
    });

    // ToolsNode lists ONLY the non-task call — the dispatch is never an item.
    const toolsPayload = result.current.nodes.find(n => n.id === 'tools-chat-corr-1')!.data.payload as any;
    expect(toolsPayload.toolCalls).toHaveLength(1);
    expect(toolsPayload.toolCalls[0].toolName).toBe('Bash');
    expect(toolsPayload.toolCalls.find((c: any) => c.toolName === 'task')).toBeUndefined();

    // SubagentNode is the dispatch's SOLE representation (AC-3 — no double-render).
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
  });

  it('A-4: a task-only exchange renders the SubagentNode and NO empty ToolsNode artifact', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'delegate only',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'delegate only',
        agentReply: 'done',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      // ONLY the dispatch — no other tool call in the exchange.
      makeToolDelivery('d3', 'init', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-15T10:00:05.000Z',
      }),
      makeToolDelivery('d4', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: 'CHILD-done',
        startTime: '2026-08-15T10:00:05.000Z',
        endTime: '2026-08-15T10:00:45.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    // One SubagentNode; ZERO ToolsNodes (no "Tools · 0 calls" artifact — A-4).
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-tools-'))).toHaveLength(0);
  });

  it('A-5: the SubagentNode sits in the deterministic companion column (x = SUBAGENT_CHAIN_X, y = parent y) — never displaced by force/residue', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'delegate',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'delegate',
        agentReply: 'done',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeToolDelivery('d3', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: 'CHILD-done',
        startTime: '2026-08-15T10:00:05.000Z',
        endTime: '2026-08-15T10:00:45.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    const saNode = result.current.nodes.find(n => n.id === 'subagent-task-corr-1')!;
    const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!;
    // Chain-owned slot: LEFT of the chat chain; the first dispatch (index 0)
    // aligns with the parent chat node's y. The exact slot value proves the
    // node was NOT moved by the d3-force/residue passes (excluded from overlap
    // mutation — A-5).
    expect(saNode.position.x).toBe(SUBAGENT_CHAIN_X);
    expect(saNode.position.y).toBe(agentNode.position.y);
  });

  it('A-5: two sequential dispatches of one parent stack LEFT (x = SUBAGENT_CHAIN_X − index × (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP)), both aligned with the parent', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'delegate twice',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'delegate twice',
        agentReply: 'done',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      // Dispatch 1 — earlier startTime.
      makeToolDelivery('d3', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: 'A',
        startTime: '2026-08-15T10:00:05.000Z',
        endTime: '2026-08-15T10:00:45.000Z',
      }),
      // Dispatch 2 — later startTime.
      makeToolDelivery('d4', 'end', 's1', 'task-corr-2', 'task', {
        input: JSON.stringify({ subagent_type: 'coder', prompt: 'implement' }),
        output: 'B',
        startTime: '2026-08-15T10:01:00.000Z',
        endTime: '2026-08-15T10:01:40.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(2);
    });

    const sa1 = result.current.nodes.find(n => n.id === 'subagent-task-corr-1')!;
    const sa2 = result.current.nodes.find(n => n.id === 'subagent-task-corr-2')!;
    const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!;
    // Dispatch-ordered horizontal stacking LEFT of the parent (A-5): both align
    // with the parent's y; the second dispatch sits one column further left.
    expect(sa1.position.x).toBe(SUBAGENT_CHAIN_X);
    expect(sa1.position.y).toBe(agentNode.position.y);
    expect(sa2.position.x).toBe(SUBAGENT_CHAIN_X - (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP));
    expect(sa2.position.y).toBe(agentNode.position.y);
  });
});

// ── #2688 ST4: vertical chat chain ─────────────────────────────────────────

describe('chat chain (#2688 ST4)', () => {
  it('builds a prev→next chat edge between consecutive chat nodes of a session', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' }),
      makeDelivery('d2', 'init', 's1', 'corr-2', { userMessage: 'second' }),
      makeDelivery('d3', 'init', 's1', 'corr-3', { userMessage: 'third' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(3);
    });

    // Two chain edges: corr-1→corr-2 and corr-2→corr-3.
    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(2);

    expect(chatEdges[0].id).toBe('e-chat-corr-1-corr-2');
    expect(chatEdges[0].source).toBe('agent-corr-1');
    expect(chatEdges[0].target).toBe('agent-corr-2');

    expect(chatEdges[1].id).toBe('e-chat-corr-2-corr-3');
    expect(chatEdges[1].source).toBe('agent-corr-2');
    expect(chatEdges[1].target).toBe('agent-corr-3');

    for (const edge of chatEdges) {
      expect(edge.type).toBe('smoothstep');
    }
  });

  it('does not create a chain edge for the first chat node of a session', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    expect(result.current.edges.filter(e => e.id.startsWith('e-chat-'))).toHaveLength(0);
  });

  it('keeps sessions independent — no chain edge across sessions', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' }),
      makeDelivery('d2', 'init', 's2', 'corr-2', { userMessage: 'second' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    expect(result.current.edges.filter(e => e.id.startsWith('e-chat-'))).toHaveLength(0);
  });

  it('ST10: re-positions existing agent nodes when the chain grows incrementally (two sequential batches)', async () => {
    const d1 = makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' });
    const d2 = makeDelivery('d2', 'init', 's1', 'corr-2', { userMessage: 'second' });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: [d1] } },
    );

    // Batch 1: only corr-1 exists.
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    // Batch 2: corr-2 arrives as a NEW export (incremental arrival).
    rerender({ deliveries: [d1, d2] });

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(2);
    });

    const node1 = result.current.nodes.find(n => n.id === 'agent-corr-1');
    const node2 = result.current.nodes.find(n => n.id === 'agent-corr-2');
    expect(node1).toBeDefined();
    expect(node2).toBeDefined();

    // corr-1 is older → top (y = 0); corr-2 newest → below (larger y).
    // Distinct positions — no overlap at y=0 (the ST10 stacking fix).
    expect(node1!.position.y).toBeLessThan(node2!.position.y);
    expect(node1!.position.y).not.toBe(node2!.position.y);

    // Chain edge between the consecutive pair.
    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(1);
    expect(chatEdges[0].id).toBe('e-chat-corr-1-corr-2');
    expect(chatEdges[0].source).toBe('agent-corr-1');
    expect(chatEdges[0].target).toBe('agent-corr-2');
  });

  it('ST10: three incrementally-arrived chat nodes stack in order with two chain edges', async () => {
    const d1 = makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' });
    const d2 = makeDelivery('d2', 'init', 's1', 'corr-2', { userMessage: 'second' });
    const d3 = makeDelivery('d3', 'init', 's1', 'corr-3', { userMessage: 'third' });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: [d1] } },
    );

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });
    rerender({ deliveries: [d1, d2] });

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(2);
    });
    rerender({ deliveries: [d1, d2, d3] });

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(3);
    });

    const node1 = result.current.nodes.find(n => n.id === 'agent-corr-1');
    const node2 = result.current.nodes.find(n => n.id === 'agent-corr-2');
    const node3 = result.current.nodes.find(n => n.id === 'agent-corr-3');
    expect(node1).toBeDefined();
    expect(node2).toBeDefined();
    expect(node3).toBeDefined();

    // Oldest at the top (y = 0), newest at the bottom (largest y) — all distinct.
    expect(node1!.position.y).toBeLessThan(node2!.position.y);
    expect(node2!.position.y).toBeLessThan(node3!.position.y);

    // Two chain edges: corr-1→corr-2 and corr-2→corr-3.
    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(2);
    expect(chatEdges[0].id).toBe('e-chat-corr-1-corr-2');
    expect(chatEdges[1].id).toBe('e-chat-corr-2-corr-3');
  });

  // ST12 (#2688 round-9 AC2): the live Run CLI path delivers each turn as an
  // init+end pair sharing one correlationId IN THE SAME batch (feature-store
  // timestamps ~0.6 ms apart). The end-lifecycle re-set used to replace the
  // agentNodes entry with an object lacking prevCorrId, so buildChatEdge bailed
  // for every node after the first — zero e-chat edges in the live graph.
  it('ST12: builds the chain edge when each turn arrives as init+end in one batch (two turns)', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' }),
      makeDelivery('d2', 'end', 's1', 'corr-1', { userMessage: 'first', agentReply: 'reply-1' }),
      makeDelivery('d3', 'init', 's1', 'corr-2', { userMessage: 'second' }),
      makeDelivery('d4', 'end', 's1', 'corr-2', { userMessage: 'second', agentReply: 'reply-2' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
    });

    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(1);
    expect(chatEdges[0].id).toBe('e-chat-corr-1-corr-2');
    expect(chatEdges[0].source).toBe('agent-corr-1');
    expect(chatEdges[0].target).toBe('agent-corr-2');
    expect(chatEdges[0].type).toBe('smoothstep');
  });

  it('ST12: builds the full 5-turn live chain — 5 nodes, 4 edges (init+end pairs in one batch)', async () => {
    const corrs = ['c1', 'c3', 'c5', 'c7', 'c9'];
    const deliveries: ContractDelivery[] = [];
    corrs.forEach((c, i) => {
      deliveries.push(
        makeDelivery(`i${i}-${c}`, 'init', 's1', c, { userMessage: `turn-${i}` }),
        makeDelivery(`e${i}-${c}`, 'end', 's1', c, { userMessage: `turn-${i}`, agentReply: `reply-${i}` }),
      );
    });

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(5);
    });

    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(4);
    const expected = [
      { id: 'e-chat-c1-c3', source: 'agent-c1', target: 'agent-c3' },
      { id: 'e-chat-c3-c5', source: 'agent-c3', target: 'agent-c5' },
      { id: 'e-chat-c5-c7', source: 'agent-c5', target: 'agent-c7' },
      { id: 'e-chat-c7-c9', source: 'agent-c7', target: 'agent-c9' },
    ];
    expected.forEach((exp, i) => {
      expect(chatEdges[i].id).toBe(exp.id);
      expect(chatEdges[i].source).toBe(exp.source);
      expect(chatEdges[i].target).toBe(exp.target);
    });
  });

  it('ST12: edge survives the end re-set with incremental batches (exact round-9 live condition)', async () => {
    const initC1 = makeDelivery('d1', 'init', 's1', 'c1', { userMessage: 'first' });
    const endC1 = makeDelivery('d2', 'end', 's1', 'c1', { userMessage: 'first', agentReply: 'reply-1' });
    const initC2 = makeDelivery('d3', 'init', 's1', 'c2', { userMessage: 'second' });
    const endC2 = makeDelivery('d4', 'end', 's1', 'c2', { userMessage: 'second', agentReply: 'reply-2' });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: [initC1, endC1] } },
    );

    // Batch 1: single turn (init+end) — no chain edge yet (first node).
    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });
    expect(result.current.edges.filter(e => e.id.startsWith('e-chat-'))).toHaveLength(0);

    // Batch 2: second turn (init+end) arrives incrementally. The end re-set
    // for c2 must preserve prevCorrId so the c1→c2 chain edge is built.
    rerender({ deliveries: [initC1, endC1, initC2, endC2] });

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
    });

    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(1);
    expect(chatEdges[0].id).toBe('e-chat-c1-c2');
    expect(chatEdges[0].source).toBe('agent-c1');
    expect(chatEdges[0].target).toBe('agent-c2');
  });
});

// ── #2700 ST3: per-node per-turn token invariant ────────────────────────────
//
// REQ-7/REQ-8/REQ-9: each chat node's displayed token count must equal only
// that node's own turn's consumption (the promptTokens/completionTokens
// delivered for its correlationId), never a session-cumulative total and never
// a sticky max across its lifecycle deliveries. All fixtures below feed the
// LIVE adapter shape (G-011): each turn is an init+end pair for the same key
// in one batch, with distinct per-turn values.
//
// Spec #2711: the OTLP adapter now injects promptTokens as the per-message
// DELTA of the cumulative `gen_ai.usage.input_tokens` (2,731 → 2,758 → 2,790
// → 2,820 → 3,229 with cache_read pinned at 25,344) and completionTokens as
// that turn's own `output_tokens`. The fixtures below mirror that delta series
// (deltas 2,731 / 27 / 32 / 30 / 409) — they assert the per-message values the
// adapter delivers, never the old cumulative inputs.

describe('per-node per-turn token invariant (#2700 ST3)', () => {
  it('REQ-7/REQ-9: multi-turn init+end batches keep each node on its own per-turn figure (no accumulation)', async () => {
    // Spec #2711 root-cause trace (ses_00bf7871dffexcyzy13MkdhiM9): cumulative
    // gen_ai.usage.input_tokens 2,731 → 2,758 → 2,790 → 2,820 → 3,229 (cache
    // 25,344 pinned) → per-message prompt deltas 2,731 / 27 / 32 / 30 / 409;
    // per-turn completion outputs 9 / 13 / 9 / 393 / 112.
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', { userMessage: 'turn-1', promptTokens: 2731, completionTokens: 9 }),
      makeDelivery('e1', 'end', 's1', 'corr-1', { userMessage: 'turn-1', agentReply: 'reply-1', promptTokens: 2731, completionTokens: 9 }),
      makeDelivery('i2', 'init', 's1', 'corr-2', { userMessage: 'turn-2', promptTokens: 27, completionTokens: 13 }),
      makeDelivery('e2', 'end', 's1', 'corr-2', { userMessage: 'turn-2', agentReply: 'reply-2', promptTokens: 27, completionTokens: 13 }),
      makeDelivery('i3', 'init', 's1', 'corr-3', { userMessage: 'turn-3', promptTokens: 32, completionTokens: 9 }),
      makeDelivery('e3', 'end', 's1', 'corr-3', { userMessage: 'turn-3', agentReply: 'reply-3', promptTokens: 32, completionTokens: 9 }),
      makeDelivery('i4', 'init', 's1', 'corr-4', { userMessage: 'turn-4', promptTokens: 30, completionTokens: 393 }),
      makeDelivery('e4', 'end', 's1', 'corr-4', { userMessage: 'turn-4', agentReply: 'reply-4', promptTokens: 30, completionTokens: 393 }),
      makeDelivery('i5', 'init', 's1', 'corr-5', { userMessage: 'turn-5', promptTokens: 409, completionTokens: 112 }),
      makeDelivery('e5', 'end', 's1', 'corr-5', { userMessage: 'turn-5', agentReply: 'reply-5', promptTokens: 409, completionTokens: 112 }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(5);
    });

    const payload = (id: string) => (result.current.nodes.find(n => n.id === id)!.data.payload as any);

    // Turn 1 — its own per-message delta only (first turn = full input).
    expect(payload('agent-corr-1').promptTokens).toBe(2731);
    expect(payload('agent-corr-1').completionTokens).toBe(9);
    expect(payload('agent-corr-1').totalTokens).toBe(2740);
    // Turn 2 — distinct, smaller delta — NEVER accumulated (2731 + 27) and
    // never the cumulative input (2758).
    expect(payload('agent-corr-2').promptTokens).toBe(27);
    expect(payload('agent-corr-2').completionTokens).toBe(13);
    expect(payload('agent-corr-2').totalTokens).toBe(40);
    expect(payload('agent-corr-2').promptTokens).not.toBe(2731 + 27);
    // Turn 3 — distinct delta — NEVER accumulated.
    expect(payload('agent-corr-3').promptTokens).toBe(32);
    expect(payload('agent-corr-3').completionTokens).toBe(9);
    expect(payload('agent-corr-3').totalTokens).toBe(41);
    expect(payload('agent-corr-3').promptTokens).not.toBe(2731 + 27 + 32);
    // Turn 4 — distinct delta — NEVER accumulated.
    expect(payload('agent-corr-4').promptTokens).toBe(30);
    expect(payload('agent-corr-4').completionTokens).toBe(393);
    expect(payload('agent-corr-4').totalTokens).toBe(423);
    expect(payload('agent-corr-4').promptTokens).not.toBe(2731 + 27 + 32 + 30);
    // Turn 5 — distinct delta — NEVER accumulated (the cumulative input 3,229
    // must never surface as a node's prompt).
    expect(payload('agent-corr-5').promptTokens).toBe(409);
    expect(payload('agent-corr-5').completionTokens).toBe(112);
    expect(payload('agent-corr-5').totalTokens).toBe(521);
    expect(payload('agent-corr-5').promptTokens).not.toBe(2731 + 27 + 32 + 30 + 409);
  });

  it('REQ-8: the last delivery carrying a token value wins — a later smaller figure replaces, never maxes', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'turn-1', promptTokens: 100, completionTokens: 50 }),
      // Update carries a DIFFERENT (smaller) figure for the same turn — the
      // old Math.max merge would have kept 100/50 sticky forever.
      makeDelivery('d2', 'update', 's1', 'corr-1', { agentReply: 'chunk', promptTokens: 30, completionTokens: 10 }),
      makeDelivery('d3', 'end', 's1', 'corr-1', { userMessage: 'turn-1', agentReply: 'reply-1', promptTokens: 30, completionTokens: 10 }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.promptTokens).toBe(30);
    expect(payload.completionTokens).toBe(10);
    expect(payload.totalTokens).toBe(40);
  });

  it('REQ-8: a mid-lifecycle session-cumulative spike is NOT sticky — the turn\'s own final figure wins', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'turn-1', promptTokens: 100, completionTokens: 50 }),
      // A session-cumulative total sneaks into a mid-lifecycle delivery. The
      // old Math.max merge made such a value sticky — the node could never
      // drop back to its per-turn figure.
      makeDelivery('d2', 'update', 's1', 'corr-1', { agentReply: 'chunk', promptTokens: 5000, completionTokens: 2500 }),
      // The turn's real per-turn figure arrives at end — last-wins must win.
      makeDelivery('d3', 'end', 's1', 'corr-1', { userMessage: 'turn-1', agentReply: 'reply-1', promptTokens: 100, completionTokens: 50 }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.promptTokens).toBe(100);
    expect(payload.completionTokens).toBe(50);
    expect(payload.totalTokens).toBe(150);
  });

  it('REQ-7/NFR-4: the session span flat total_tokens and sessionContextTokens never appear in a chat-node count', async () => {
    // The session span carries cumulative figures — the flat total_tokens
    // (e.g. 28417) and, per Spec #2711, the additive reconciliation field
    // sessionContextTokens (input_n + cache_read_n, e.g. 2,731 + 25,344 =
    // 28,075). Both are excluded from chat-node deliveries by the contract's
    // eventTypes: ['chat'] filter (NFR-4). This test pins the frontend side of
    // that contract: even if a payload carried them, the node must display
    // only its own per-message figures (the adapter-injected prompt DELTA and
    // the turn's own completion — never a cumulative context total).
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        promptTokens: 2731,
        completionTokens: 9,
        // Session-span flat attribute + derived total (would be cloned into the
        // delivery payload by the OTLP adapter if a session span ever leaked).
        total_tokens: 28417,
        totalTokens: 28417,
        // Spec #2711 additive reconciliation field: cumulative session context
        // at turn 1 (input 2,731 + cache_read 25,344). It must NEVER become
        // the node's own per-message prompt/completion/total.
        sessionContextTokens: 28075,
      }),
      makeDelivery('d2', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1',
        agentReply: 'reply-1',
        promptTokens: 2731,
        completionTokens: 9,
        total_tokens: 28417,
        totalTokens: 28417,
        sessionContextTokens: 28075,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    // Per-message figure only (first turn delta = full input 2,731).
    expect(payload.promptTokens).toBe(2731);
    expect(payload.completionTokens).toBe(9);
    expect(payload.totalTokens).toBe(2740);
    // The session-cumulative figures never become the node's displayed count:
    // neither the flat total_tokens nor the additive sessionContextTokens
    // (input + cache) that the adapter injects for AC3 reconciliation.
    expect(payload.promptTokens).not.toBe(28417);
    expect(payload.totalTokens).not.toBe(28417);
    expect(payload.promptTokens).not.toBe(28075);
    expect(payload.totalTokens).not.toBe(28075);
    // AC5: the 25,344 cache prefix cancels in every delta and must never be
    // summed into the node's prompt/completion.
    expect(payload.promptTokens).not.toBe(2731 + 25344);
  });
});

// ── Spec #2717 (Sub-task 2): five-way token payload ──────────────────────────
//
// The OTLP adapter injects canonical reasoningTokens / cacheReadTokens /
// cacheWriteTokens alongside promptTokens / completionTokens. The graph
// builder maps them into AgentNodePayload with per-field last-wins (never
// Math.max — #2700 ST3) and recomputes Total = prompt + cacheRead + reasoning
// + completion (R-3.1). cacheWrite is carried but NEVER summed (G-023).
// All fixtures feed the LIVE adapter shape (G-011): init+end pairs per turn.

describe('Spec #2717: five-way token payload + totalTokens arithmetic', () => {
  it('maps the canonical reasoning/cacheRead/cacheWrite fields; Total = I + C + R + O (cacheWrite never summed)', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 200,
        cacheWriteTokens: 999,
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1',
        agentReply: 'reply-1',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 200,
        cacheWriteTokens: 999,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.promptTokens).toBe(100);
    expect(payload.cacheReadTokens).toBe(200);
    expect(payload.reasoningTokens).toBe(25);
    expect(payload.completionTokens).toBe(50);
    expect(payload.cacheWriteTokens).toBe(999);
    // R-3.1: Total = Input + Cache + Reasoning + Output exactly.
    expect(payload.totalTokens).toBe(100 + 200 + 25 + 50);
    // G-023: cacheWrite is carried but NEVER summed into Total.
    expect(payload.totalTokens).not.toBe(100 + 200 + 25 + 50 + 999);
  });

  it('defaults reasoning/cacheRead/cacheWrite to 0 when the delivery omits them (backward compat)', async () => {
    // The pinned fixtures carry only prompt/completion — the new fields must
    // default to 0 and Total stays prompt+completion (unchanged values).
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', { userMessage: 'turn-1', promptTokens: 2731, completionTokens: 9 }),
      makeDelivery('e1', 'end', 's1', 'corr-1', { userMessage: 'turn-1', agentReply: 'reply-1', promptTokens: 2731, completionTokens: 9 }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.promptTokens).toBe(2731);
    expect(payload.completionTokens).toBe(9);
    expect(payload.reasoningTokens).toBe(0);
    expect(payload.cacheReadTokens).toBe(0);
    expect(payload.cacheWriteTokens).toBe(0);
    expect(payload.totalTokens).toBe(2740);
  });

  it('last-wins: a later smaller cache/reasoning figure replaces the init value, never maxes', async () => {
    // An early delivery carries inflated cache/reasoning; the turn's real
    // per-turn figures arrive later — the old Math.max merge would have kept
    // the inflated values sticky forever (same class of bug as #2700 ST3).
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 400,
        cacheReadTokens: 800,
      }),
      makeDelivery('u1', 'update', 's1', 'corr-1', {
        agentReply: 'chunk',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 200,
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1',
        agentReply: 'reply-1',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 200,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.reasoningTokens).toBe(25);
    expect(payload.cacheReadTokens).toBe(200);
    expect(payload.totalTokens).toBe(100 + 200 + 25 + 50);
  });

  it('last-wins: a mid-lifecycle cache/reasoning spike is NOT sticky — the turn\'s own final figure wins', async () => {
    // A session-cumulative cache/reasoning total sneaks into a mid-lifecycle
    // delivery. Per #2700 ST3 the node must drop back to its per-turn figure
    // when the end delivery arrives.
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 200,
      }),
      makeDelivery('u1', 'update', 's1', 'corr-1', {
        agentReply: 'chunk',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 5000,
        cacheReadTokens: 25000,
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1',
        agentReply: 'reply-1',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 200,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.reasoningTokens).toBe(25);
    expect(payload.cacheReadTokens).toBe(200);
    expect(payload.totalTokens).toBe(100 + 200 + 25 + 50);
    expect(payload.totalTokens).not.toBe(100 + 25000 + 5000 + 50);
  });

  it('an update delivery carrying no new cache/reasoning keeps the node\'s own per-turn values', async () => {
    // A delivery that carries no cache/reasoning figures (0/0) must not zero
    // the node's per-turn values (the same last-wins rule as prompt/completion).
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 200,
      }),
      // Update carries only text + prompt/completion — cache/reasoning absent.
      makeDelivery('u1', 'update', 's1', 'corr-1', {
        agentReply: 'chunk',
        promptTokens: 100,
        completionTokens: 50,
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1',
        agentReply: 'reply-1',
        promptTokens: 100,
        completionTokens: 50,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.reasoningTokens).toBe(25);
    expect(payload.cacheReadTokens).toBe(200);
    expect(payload.cacheWriteTokens).toBe(0);
    expect(payload.totalTokens).toBe(100 + 200 + 25 + 50);
  });
});

// ── Spec #2723 (R-6 / AC6): node payload carries span-derived times ───────────

describe('detail-panel timing from span-derived payload times (#2723 R-6)', () => {
  it('prefers the adapter-injected payload endTime over the end-delivery timestamp', async () => {
    // Live OTLP shape: one turn = init+end pair for the same key in one batch
    // (G-011). The end delivery carries the span's RFC3339 endTime (injected
    // by the adapter from endTimeUnixNano) — the node must use it, NOT the
    // end-delivery wall-clock.
    const endDeliveryTs = '2026-05-10T12:00:00.000Z';
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        startTime: '2026-05-10T11:59:00.000Z',
        endTime: '2026-05-10T11:59:45.000Z',
      }),
      {
        ...makeDelivery('e1', 'end', 's1', 'corr-1', {
          userMessage: 'turn-1',
          agentReply: 'reply-1',
          startTime: '2026-05-10T11:59:00.000Z',
          endTime: '2026-05-10T11:59:45.000Z',
        }),
        timestamp: endDeliveryTs,
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.startTime).toBe('2026-05-10T11:59:00.000Z');
    expect(payload.endTime).toBe('2026-05-10T11:59:45.000Z');
    expect(payload.endTime).not.toBe(endDeliveryTs);
  });

  it('falls back to the end-delivery timestamp when the payload lacks endTime (streaming span)', async () => {
    // Streaming span with no endTimeUnixNano: the payload carries startTime
    // only. The end delivery still finalizes the node — End falls back to the
    // end-delivery timestamp (non-goal, ST-7).
    const endDeliveryTs = '2026-05-10T12:00:00.000Z';
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        startTime: '2026-05-10T11:59:00.000Z',
      }),
      {
        ...makeDelivery('e1', 'end', 's1', 'corr-1', {
          userMessage: 'turn-1',
          agentReply: 'reply-1',
          startTime: '2026-05-10T11:59:00.000Z',
        }),
        timestamp: endDeliveryTs,
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.startTime).toBe('2026-05-10T11:59:00.000Z');
    expect(payload.endTime).toBe(endDeliveryTs);
  });

  it('carries startTime from the init delivery payload', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1',
        startTime: '2026-05-10T11:59:00.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });

    const payload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(payload.startTime).toBe('2026-05-10T11:59:00.000Z');
  });
});

// ── Spec #2723 ST-3 (R-3 / AC3): per-node per-turn, non-contaminated, Σ-reconciled ──
//
// Live diagnostic (ses_044bb36d7ffeeh5kwPSzvQ1Aum, 57 turns): the adapter's
// derive_turn_tokens now derives the per-turn cache-read DELTA from the
// session-cumulative gen_ai.usage.cache_read.input_tokens (512,000 → 513,536 →
// 515,840 → 516,224 → 518,144; deltas 512,000 / 1,536 / 2,304 / 384 / 1,920).
// These deliveries-driven fixtures feed the LIVE adapter shape (G-011) — each
// turn is an init+end pair carrying that turn's own per-turn delta — and assert
// (1) every node keeps its own per-turn cache figure across 3+ nodes, never
// another node's and never the session-cumulative total, and (2) the REQ-8
// last-wins merge never Math.maxes a node's figure.

describe('Spec #2723 ST-3: 3+ nodes keep per-turn cache deltas, no cross-node contamination', () => {
  it('3 nodes with distinct per-turn cache deltas each keep their own figure (never cumulative, never another node\'s)', async () => {
    // Mirrors the live session's first 3 turns: per-turn cache deltas
    // 512,000 / 1,536 / 2,304. The cumulative total (515,840) must never
    // appear on any node.
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1', promptTokens: 100, completionTokens: 10,
        reasoningTokens: 5, cacheReadTokens: 512000,
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1', agentReply: 'reply-1', promptTokens: 100, completionTokens: 10,
        reasoningTokens: 5, cacheReadTokens: 512000,
      }),
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'turn-2', promptTokens: 27, completionTokens: 13,
        reasoningTokens: 3, cacheReadTokens: 1536,
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'turn-2', agentReply: 'reply-2', promptTokens: 27, completionTokens: 13,
        reasoningTokens: 3, cacheReadTokens: 1536,
      }),
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'turn-3', promptTokens: 32, completionTokens: 9,
        reasoningTokens: 7, cacheReadTokens: 2304,
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'turn-3', agentReply: 'reply-3', promptTokens: 32, completionTokens: 9,
        reasoningTokens: 7, cacheReadTokens: 2304,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(3);
    });

    const payload = (id: string) => (result.current.nodes.find(n => n.id === id)!.data.payload as any);

    // Node 1 — its own per-turn cache delta only (first turn = full cache).
    expect(payload('agent-corr-1').cacheReadTokens).toBe(512000);
    expect(payload('agent-corr-1').totalTokens).toBe(100 + 512000 + 5 + 10);
    // Node 2 — its OWN delta (1,536), never accumulated (512,000 + 1,536) and
    // never the cumulative cache at turn 2 (513,536).
    expect(payload('agent-corr-2').cacheReadTokens).toBe(1536);
    expect(payload('agent-corr-2').cacheReadTokens).not.toBe(512000 + 1536);
    expect(payload('agent-corr-2').cacheReadTokens).not.toBe(513536);
    expect(payload('agent-corr-2').totalTokens).toBe(27 + 1536 + 3 + 13);
    // Node 3 — its OWN delta (2,304), never accumulated, never the cumulative
    // cache at turn 3 (515,840).
    expect(payload('agent-corr-3').cacheReadTokens).toBe(2304);
    expect(payload('agent-corr-3').cacheReadTokens).not.toBe(512000 + 1536 + 2304);
    expect(payload('agent-corr-3').cacheReadTokens).not.toBe(515840);
    expect(payload('agent-corr-3').totalTokens).toBe(32 + 2304 + 7 + 9);
  });

  it('last-wins across 3 nodes: a mid-lifecycle cumulative cache spike is NOT sticky — each node ends on its own per-turn delta', async () => {
    // The REQ-8 invariant must hold per-node independently in a 3-node session:
    // an update that sneaks a session-cumulative cache figure (513,536) into
    // node 2 must not stick — the end delivery's own per-turn delta (1,536)
    // wins (never Math.max).
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1', promptTokens: 100, completionTokens: 10, cacheReadTokens: 512000,
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1', agentReply: 'reply-1', promptTokens: 100, completionTokens: 10, cacheReadTokens: 512000,
      }),
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'turn-2', promptTokens: 27, completionTokens: 13, cacheReadTokens: 1536,
      }),
      // A session-cumulative total sneaks into a mid-lifecycle update.
      makeDelivery('u2', 'update', 's1', 'corr-2', {
        agentReply: 'chunk', promptTokens: 27, completionTokens: 13, cacheReadTokens: 513536,
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'turn-2', agentReply: 'reply-2', promptTokens: 27, completionTokens: 13, cacheReadTokens: 1536,
      }),
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'turn-3', promptTokens: 32, completionTokens: 9, cacheReadTokens: 2304,
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'turn-3', agentReply: 'reply-3', promptTokens: 32, completionTokens: 9, cacheReadTokens: 2304,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(3);
    });

    const payload = (id: string) => (result.current.nodes.find(n => n.id === id)!.data.payload as any);
    // The spike (513,536) must never stick on node 2 — its own delta wins.
    expect(payload('agent-corr-2').cacheReadTokens).toBe(1536);
    expect(payload('agent-corr-2').cacheReadTokens).not.toBe(513536);
    // Node 1 and 3 unaffected by node 2's spike (no cross-node contamination).
    expect(payload('agent-corr-1').cacheReadTokens).toBe(512000);
    expect(payload('agent-corr-3').cacheReadTokens).toBe(2304);
  });

  it('delivery-level duplication regression: two nodes carrying the IDENTICAL cumulative flat cache attr keep per-turn deltas (post-adapter-fix merge)', async () => {
    // Spec #2734 (ST-2 adapter fix): each delivery's canonical cacheReadTokens
    // is that node's own per-turn DELTA, while the raw session-cumulative
    // gen_ai.usage.cache_read.input_tokens is preserved VERBATIM as a flat attr
    // (otlp.rs:998 attrs.clone()) — so EVERY delivery in the session carries the
    // SAME cumulative value (513,536). Pre-fix, the adapter injected that
    // cumulative as cacheReadTokens too (otlp.rs:1105-1108 fallback) — the R1
    // duplication (every node showing the same cache count). This test pins the
    // frontend merge: the node set must show per-turn deltas (512,000 / 1,536),
    // never the identical cumulative — the flat registry key is inert to the
    // payload merge and never becomes a node's displayed Cache.
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'turn-1', promptTokens: 100, completionTokens: 10, cacheReadTokens: 512000,
        'gen_ai.usage.cache_read.input_tokens': 513536,
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'turn-1', agentReply: 'reply-1', promptTokens: 100, completionTokens: 10, cacheReadTokens: 512000,
        'gen_ai.usage.cache_read.input_tokens': 513536,
      }),
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'turn-2', promptTokens: 27, completionTokens: 13, cacheReadTokens: 1536,
        'gen_ai.usage.cache_read.input_tokens': 513536,
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'turn-2', agentReply: 'reply-2', promptTokens: 27, completionTokens: 13, cacheReadTokens: 1536,
        'gen_ai.usage.cache_read.input_tokens': 513536,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
    });

    const payload = (id: string) => (result.current.nodes.find(n => n.id === id)!.data.payload as any);
    // The payload merge produces each node's OWN per-turn delta — the identical
    // cumulative (513,536) never becomes either node's displayed Cache, and a
    // node never shows another node's figure.
    expect(payload('agent-corr-1').cacheReadTokens).toBe(512000);
    expect(payload('agent-corr-1').cacheReadTokens).not.toBe(513536);
    expect(payload('agent-corr-2').cacheReadTokens).toBe(1536);
    expect(payload('agent-corr-2').cacheReadTokens).not.toBe(513536);
    expect(payload('agent-corr-2').cacheReadTokens).not.toBe(512000);
    // totalTokens recomputed from each node's own figures (I + C + R + O) — the
    // flat cumulative attr (513,536) leaks into neither Cache nor Total.
    expect(payload('agent-corr-1').totalTokens).toBe(100 + 512000 + 10);
    expect(payload('agent-corr-2').totalTokens).toBe(27 + 1536 + 13);
  });
});

// ── Spec #2723 ST-4 (R-4 / AC4): measured-height chain, no node collisions ──
//
// The old fixed CHAIN_NODE_SPACING (260px) could not fit a content node's
// variable height (min ≈ 314px with a full response box), so collisions were
// structurally guaranteed. The chain now stacks by MEASURED height:
// y_next = y_prev + (prev.height ?? DEFAULT_NODE_HEIGHT) + CHAIN_GAP. These
// tests feed many chat nodes (≥15) and assert (1) no two nodes overlap or
// cover each other — distinct, strictly increasing y positions with a gap of
// at least DEFAULT_NODE_HEIGHT + CHAIN_GAP (unmeasured nodes in the hook test
// environment fall back to the conservative 360px — #2743 AC-6 scaled the
// fallback from 320px with the wider nodes), (2) every node is fully
// visible (x centered, chain vertical oldest-at-top), and (3) a measured
// height change reflows the chain (height-aware layout signature).

describe('Spec #2723 ST-4: many chat nodes never overlap (AC4)', () => {
  it('15 chat nodes stack with distinct, non-overlapping positions — every node fully visible', async () => {
    const deliveries: ContractDelivery[] = [];
    for (let i = 1; i <= 15; i++) {
      deliveries.push(
        makeDelivery(`i${i}`, 'init', 's1', `corr-${i}`, {
          userMessage: `turn-${i}`,
        }),
        makeDelivery(`e${i}`, 'end', 's1', `corr-${i}`, {
          userMessage: `turn-${i}`, agentReply: `reply-${i}`,
        }),
      );
    }

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(15);
    });

    const agentNodes = result.current.nodes
      .filter(n => n.id.startsWith('agent-'))
      .sort((a, b) => a.position.y - b.position.y);

    // Oldest at top (y=0), newest at bottom — chain stays vertical.
    expect(agentNodes[0].position.y).toBe(0);
    for (let i = 1; i < agentNodes.length; i++) {
      // No two nodes overlap or cover each other: strictly increasing y.
      expect(agentNodes[i].position.y).toBeGreaterThan(agentNodes[i - 1].position.y);
      // Measured-height contract: every consecutive gap ≥ DEFAULT + CHAIN_GAP
      // (in the hook test no ReactFlow measurement happens, so every node uses
      // the conservative DEFAULT_NODE_HEIGHT fallback — 360 + 28 = 388px).
      expect(agentNodes[i].position.y - agentNodes[i - 1].position.y).toBe(
        DEFAULT_NODE_HEIGHT + CHAIN_GAP,
      );
      // Chain centered on x — fully visible (not pushed off-canvas).
      expect(agentNodes[i].position.x).toBe(0);
    }
    // Every node at a distinct position → each is individually clickable.
    const distinctYs = new Set(agentNodes.map(n => n.position.y));
    expect(distinctYs.size).toBe(15);
  });

  it('a measured height change reflows the chain — taller node pushes its successors down', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', { userMessage: 'turn-1' }),
      makeDelivery('e1', 'end', 's1', 'corr-1', { userMessage: 'turn-1', agentReply: 'r1' }),
      makeDelivery('i2', 'init', 's1', 'corr-2', { userMessage: 'turn-2' }),
      makeDelivery('e2', 'end', 's1', 'corr-2', { userMessage: 'turn-2', agentReply: 'r2' }),
      makeDelivery('i3', 'init', 's1', 'corr-3', { userMessage: 'turn-3' }),
      makeDelivery('e3', 'end', 's1', 'corr-3', { userMessage: 'turn-3', agentReply: 'r3' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(3);
    });

    // Before any measurement: all fall back to DEFAULT_NODE_HEIGHT.
    const byId = (id: string) => result.current.nodes.find(n => n.id === id)!;
    expect(byId('agent-corr-1').position.y).toBe(0);
    expect(byId('agent-corr-2').position.y).toBe(DEFAULT_NODE_HEIGHT + CHAIN_GAP);

    // ReactFlow reports the rendered height of corr-1 as 500px (a full
    // response box). The dimension change must reflow the chain.
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

    // corr-1 stays on top; corr-2 and corr-3 shift down by the measured 500px.
    await waitFor(() => {
      expect(byId('agent-corr-1').position.y).toBe(0);
    });
    expect(byId('agent-corr-2').position.y).toBe(500 + CHAIN_GAP);
    expect(byId('agent-corr-3').position.y).toBe(500 + CHAIN_GAP + DEFAULT_NODE_HEIGHT + CHAIN_GAP);
    // No overlap after the reflow.
    expect(byId('agent-corr-3').position.y).toBeGreaterThan(byId('agent-corr-2').position.y);
  });
});

// ── #2750 AC4 (ST-5): suppress transitional text-less chat turns + re-anchor ──
//
// Root cause (plan §Domain Model): the "duplicate node" for a subagent dispatch
// is the PARENT session's own two-turn pattern — a dispatch turn delivers
// userMessage + agentThinking with NO agentReply (the LLM turn ended on
// tool-calls), and the following reply turn shares the same userMessage. The
// graph emits a node for the text-less dispatch turn (rendering thinking as
// "response") PLUS the real reply node. Fix: suppress completed text-less
// (transitional) turns from the canvas and re-anchor the chat chain +
// SubagentNode/ToolsNode edges + companion-column layout to the nearest
// preceding visible chat node. NFR-5: suppression is EMISSION-only — builder
// state stays intact so a late reply can re-surface the node.

describe('#2750 AC4: suppress transitional text-less chat turns + re-anchor', () => {
  it('AC4-1: a completed text-less dispatch turn emits NO chat node — the chain skips it', async () => {
    const deliveries: ContractDelivery[] = [
      // Real turn 1.
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'first',
        startTime: '2026-08-16T10:00:00.000Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'first',
        agentReply: 'reply-1',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:20.000Z',
      }),
      // Transitional dispatch turn — completed with NO agentReply (thinking
      // only: the LLM turn ended on tool-calls).
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'dispatch the explore subagent',
        agentThinking: 'The user wants me to dispatch a subagent…',
        startTime: '2026-08-16T10:00:30.000Z',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'dispatch the explore subagent',
        agentThinking: 'The user wants me to dispatch a subagent…',
        startTime: '2026-08-16T10:00:30.000Z',
        endTime: '2026-08-16T10:00:31.000Z',
      }),
      // The real reply turn — same user message.
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'dispatch the explore subagent',
        startTime: '2026-08-16T10:00:45.000Z',
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'dispatch the explore subagent',
        agentReply: 'The explore subagent reported CHILD.',
        startTime: '2026-08-16T10:00:45.000Z',
        endTime: '2026-08-16T10:01:00.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
    });

    // The transitional turn is suppressed from the canvas (its builder state
    // stays intact — NFR-5); the two REAL turns render.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    expect(result.current.nodes.find(n => n.id === 'agent-corr-3')).toBeDefined();

    // The chat chain re-anchors: corr-1 → corr-3 (skips the suppressed corr-2).
    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(1);
    expect(chatEdges[0].id).toBe('e-chat-corr-1-corr-3');
    expect(chatEdges[0].source).toBe('agent-corr-1');
    expect(chatEdges[0].target).toBe('agent-corr-3');
  });

  it('AC4-2: a subagent dispatched from a suppressed transitional turn renders exactly ONE SubagentNode anchored to its same-exchange reply turn', async () => {
    const TASK_ARGS = JSON.stringify({
      subagent_type: 'explore',
      prompt: 'Investigate marker e2e-2750-8f3c1d2a and reply exactly CHILD',
    });
    const deliveries: ContractDelivery[] = [
      // Visible predecessor (the anchor).
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'plan the work',
        startTime: '2026-08-16T10:00:00.000Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'plan the work',
        agentReply: 'ok',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:20.000Z',
      }),
      // Transitional dispatch turn — the task dispatch's parent by the
      // time-window rule (greatest startTime < task start).
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'delegate to explore',
        agentThinking: 'I should dispatch the explore subagent…',
        startTime: '2026-08-16T10:00:30.000Z',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'delegate to explore',
        agentThinking: 'I should dispatch the explore subagent…',
        startTime: '2026-08-16T10:00:30.000Z',
        // The dispatch chat span closes AFTER the tool executes (documented live
        // shape: "the LLM turn ends on tool-calls, the tool executes, then the
        // turn closes") — so the turn's endTime covers the task call's window.
        endTime: '2026-08-16T10:01:20.000Z',
      }),
      // The task dispatch — init+end pair, one batch (G-011 live shape).
      makeToolDelivery('d3', 'init', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-16T10:00:35.000Z',
      }),
      makeToolDelivery('d4', 'end', 's1', 'task-corr-1', 'task', {
        input: TASK_ARGS,
        output: 'CHILD-e2e-2750-8f3c1d2a',
        startTime: '2026-08-16T10:00:35.000Z',
        endTime: '2026-08-16T10:01:15.000Z',
      }),
      // The real reply turn — same user message.
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'delegate to explore',
        startTime: '2026-08-16T10:01:30.000Z',
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'delegate to explore',
        agentReply: 'The explore subagent found the marker.',
        startTime: '2026-08-16T10:01:30.000Z',
        endTime: '2026-08-16T10:01:45.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    // The transitional dispatch turn renders NO chat node.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();

    // Exactly ONE SubagentNode per dispatch (AC4-2), carrying the child's real
    // output.
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
    const saNode = result.current.nodes.find(n => n.id === 'subagent-task-corr-1')!;
    expect((saNode.data.payload as any).output).toBe('CHILD-e2e-2750-8f3c1d2a');

    // The subagent edge re-anchors to the suppressed turn's SAME-EXCHANGE
    // reply corr-3 (both carry userMessage 'delegate to explore') — never the
    // suppressed dispatch turn (corr-2) nor the preceding unrelated corr-1.
    const edge = result.current.edges.find(e => e.id === 'e-calls-task-corr-1');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('agent-corr-3');
    expect(edge!.target).toBe('subagent-task-corr-1');
    expect(edge!.sourceHandle).toBe('source-left');
    expect(edge!.targetHandle).toBe('target-right');
    expect(result.current.edges.some(e => e.source === 'agent-corr-2')).toBe(false);

    // Companion column: the subagent sits at the ANCHOR's y (the same-exchange
    // reply's chain slot), not at a (0,0) fallback.
    const anchorNode = result.current.nodes.find(n => n.id === 'agent-corr-3')!;
    expect(saNode.position.x).toBe(SUBAGENT_CHAIN_X);
    expect(saNode.position.y).toBe(anchorNode.position.y);
  });

  it('NFR-5: a suppressed turn keeps its builder state — a late reply re-surfaces the node with its chain edge', async () => {
    const d1 = makeDelivery('d1', 'init', 's1', 'corr-1', { userMessage: 'first' });
    const d2 = makeDelivery('d2', 'end', 's1', 'corr-1', { userMessage: 'first', agentReply: 'reply-1' });
    const d3 = makeDelivery('d3', 'init', 's1', 'corr-2', {
      userMessage: 'delegate',
      agentThinking: 'I should dispatch…',
    });
    const d4 = makeDelivery('d4', 'end', 's1', 'corr-2', {
      userMessage: 'delegate',
      agentThinking: 'I should dispatch…',
      // NO agentReply — completes as a suppressed transitional turn.
    });
    const d5 = makeDelivery('d5', 'update', 's1', 'corr-2', {
      agentReply: 'The subagent reported CHILD.',
    });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: [d1, d2, d3, d4] } },
    );

    // Batch 1: corr-2 is complete + text-less → suppressed (emission only).
    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(1);
    });
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    expect(result.current.edges.filter(e => e.id.startsWith('e-chat-'))).toHaveLength(0);

    // Batch 2: a late reply lands on corr-2 → the node re-surfaces + gets its
    // chain edge (never deleted from builder state — NFR-5).
    rerender({ deliveries: [d1, d2, d3, d4, d5] });

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeDefined();
    });
    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(1);
    expect(chatEdges[0].id).toBe('e-chat-corr-1-corr-2');
    expect(chatEdges[0].source).toBe('agent-corr-1');
    expect(chatEdges[0].target).toBe('agent-corr-2');
  });

  it('AC4: a ToolsNode whose parent is a suppressed transitional turn anchors its edge + slot to the same-exchange reply turn', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'first',
        startTime: '2026-08-16T11:00:00.000Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'first',
        agentReply: 'ok',
        startTime: '2026-08-16T11:00:00.000Z',
        endTime: '2026-08-16T11:00:20.000Z',
      }),
      // Transitional turn that resolves the tool call (parent by time window).
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'run the tool',
        agentThinking: 'I need to run a tool first…',
        startTime: '2026-08-16T11:00:30.000Z',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'run the tool',
        agentThinking: 'I need to run a tool first…',
        startTime: '2026-08-16T11:00:30.000Z',
        // The dispatch chat span closes AFTER the tool executes (documented live
        // shape) — the turn's endTime covers the tool call's window.
        endTime: '2026-08-16T11:00:40.000Z',
      }),
      makeToolDelivery('t1', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls -la',
        output: 'total 48',
        startTime: '2026-08-16T11:00:35.000Z',
        endTime: '2026-08-16T11:00:36.000Z',
      }),
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'run the tool',
        startTime: '2026-08-16T11:00:45.000Z',
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'run the tool',
        agentReply: 'done',
        startTime: '2026-08-16T11:00:45.000Z',
        endTime: '2026-08-16T11:01:00.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'tools-corr-3')).toHaveLength(1);
    });

    // The transitional parent renders NO chat node; the MERGED ToolsNode (one
    // per VISIBLE chat node) still renders under the reply's id.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();

    // The tools edge re-anchors to the suppressed turn's SAME-EXCHANGE reply
    // corr-3 (both carry userMessage 'run the tool') — never the preceding
    // unrelated corr-1.
    const toolsEdge = result.current.edges.find(e => e.id === 'e-tools-corr-3');
    expect(toolsEdge).toBeDefined();
    expect(toolsEdge!.source).toBe('agent-corr-3');
    expect(toolsEdge!.target).toBe('tools-corr-3');
    expect(toolsEdge!.sourceHandle).toBe('source-right');
    expect(toolsEdge!.targetHandle).toBe('target-left');

    // The ToolsNode slot sits at the ANCHOR's y (right-side chain slot).
    const anchorNode = result.current.nodes.find(n => n.id === 'agent-corr-3')!;
    const toolsNode = result.current.nodes.find(n => n.id === 'tools-corr-3')!;
    expect(toolsNode.position.x).toBe(TOOLS_CHAIN_X);
    expect(toolsNode.position.y).toBe(anchorNode.position.y);
  });
});

// ── #2752 ST-4: layout-mode switching + force lifecycle (T16) ────────────────
//
// Pins the FORCE-mode behavior at the hook boundary with the live builder
// mocked (ST-1 owns the builder's unit tests). QA Plan T16 cases:
// chain→Force yields force positions (not chain); Force→Chain restores
// byte-identical chain positions; a structural change while in Force re-seeds
// from current positions; edges: switch mid-stream, switch with no nodes, two
// switches in one render. EARS-1/2/3/4/6/8.

// ── #2754 ST-3: theme-token guard for the hook source (AC5) ──────────────────

describe('#2754 ST-3: useMissionMonitor.ts theme-token guard (AC5)', () => {
  it('has no hardcoded hex/rgba color literals in the hook source (EDGE_STYLES migrated to var(--*) tokens)', () => {
    // Mirrors the SubagentNode/ToolsNode source guards (readFileSync from
    // cwd = apps/ui). The #2754 ST-3 EDGE_STYLES migration (#6366f1/#a855f7/
    // #334155/#f97316 → var(--accent-primary)/var(--accent-subagent)/
    // var(--border-color)/var(--accent-secondary)) must not regress.
    const rawSource = readFileSync(
      resolve(process.cwd(), 'src/features/mission-monitor/hooks/useMissionMonitor.ts'),
      'utf8',
    );
    // Strip comments so spec references and doc prose never false-positive.
    const source = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    // The migrated edge styles resolve through theme tokens only.
    expect(source).toContain('var(--accent-primary)');
    expect(source).toContain('var(--accent-subagent)');
    expect(source).toContain('var(--accent-secondary)');
    expect(source).toContain('var(--border-color)');
  });
});

describe('#2752 ST-4: layout-mode switching + force lifecycle (EARS-1/2/3/4/6/8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForceSims.length = 0;
  });

  const latestSim = (): MockForceSimHandle => mockForceSims[mockForceSims.length - 1];

  it('EARS-6: chain mode is byte-identical to the deterministic chain computation — and never creates a live simulation', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    // All three node families render.
    expect(result.current.nodes.map(n => n.id).sort()).toEqual([
      'agent-corr-1', 'agent-corr-2', 'agent-corr-3', 'subagent-task-corr-1', 'tools-corr-2',
    ]);

    // Expected geometry from the REAL chain functions (the mock only replaces
    // createLiveForceSimulation) — chat chain + right tools column + left
    // subagent column.
    const expectedChain = computeChatChainPositions([
      { id: 'agent-corr-1', sessionId: 's1' },
      { id: 'agent-corr-2', sessionId: 's1' },
      { id: 'agent-corr-3', sessionId: 's1' },
    ]);
    const expected = new Map(expectedChain);
    for (const [id, pos] of computeToolsChainPositions(
      [{ id: 'tools-corr-2', parentId: 'agent-corr-2' }], expectedChain,
    )) expected.set(id, pos);
    for (const [id, pos] of computeSubagentChainPositions(
      [{ id: 'subagent-task-corr-1', parentId: 'agent-corr-3', index: 0 }], expectedChain,
    )) expected.set(id, pos);

    expectSamePositions(nodePositions(result.current.nodes), expected);

    // Spot checks on the frozen geometry (EARS-6): chat x=0 oldest→newest
    // measured-height stacking; ToolsNode right column at the parent's y;
    // SubagentNode left column at the parent's y.
    const byId = (id: string) => result.current.nodes.find(n => n.id === id)!;
    expect(byId('agent-corr-1').position).toEqual({ x: 0, y: 0 });
    expect(byId('agent-corr-2').position.y).toBe(DEFAULT_NODE_HEIGHT + CHAIN_GAP);
    expect(byId('agent-corr-3').position.y).toBe((DEFAULT_NODE_HEIGHT + CHAIN_GAP) * 2);
    expect(byId('tools-corr-2').position.x).toBe(TOOLS_CHAIN_X);
    expect(byId('tools-corr-2').position.y).toBe(byId('agent-corr-2').position.y);
    expect(byId('subagent-task-corr-1').position.x).toBe(SUBAGENT_CHAIN_X);
    expect(byId('subagent-task-corr-1').position.y).toBe(byId('agent-corr-3').position.y);

    // Chain mode must never instantiate a live simulation (NFR-3: no rAF in chain).
    expect(vi.mocked(createLiveForceSimulation)).not.toHaveBeenCalled();
  });

  it('EARS-8/T16: chain→Force re-layout — sim created + restarted seeded from the CURRENT chain positions; ticks drive FORCE positions for ALL nodes (chat nodes are sim bodies too — REQ-1) without clearing node data', async () => {
    // #2756 DELIBERATE UPDATE (round-2 AC7 stale-assertion fix): the #2754
    // hybrid framing (chat nodes pinned at the chain geometry, only companions
    // force-placed) is REMOVED. Under the TRUE disjoint force layout (REQ-1)
    // every node — chat, tools, subagent — is a body of the live simulation:
    // the seed is still the current chain positions (no jump on toggle), the
    // restart body carries ALL node ids, and the FIRST TICK drives force
    // positions for EVERY node, chat nodes included.
    const { result, rerender } = renderHook(
      ({ mode }: { mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: mode }),
      { initialProps: { mode: 'chain' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });
    const chainPositions = nodePositions(result.current.nodes);
    const chatBefore = result.current.nodes.find(n => n.id === 'agent-corr-2')!;

    // ── chain → force ──
    rerender({ mode: 'force' });

    await waitFor(() => {
      expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
    });
    const sim = latestSim();
    expect(sim).toBeDefined();
    // One restart, seeded from the current (chain) positions — existing nodes
    // must never jump on the switch (EARS-8).
    expect(sim.restarts).toHaveLength(1);
    expectSamePositions(sim.restarts[0].seed, chainPositions);
    // Restart body = ALL node ids — every node (chat included) is a sim body of
    // the disjoint simulation (REQ-1: no node is fx/fy-frozen at a chain slot).
    expect(sim.restarts[0].nodes.map(n => n.id).sort()).toEqual([
      'agent-corr-1', 'agent-corr-2', 'agent-corr-3', 'subagent-task-corr-1', 'tools-corr-2',
    ]);
    // Until the first frame, nodes keep their chain positions (seed applied).
    expectSamePositions(nodePositions(result.current.nodes), chainPositions);

    // ── first frame: EVERY node glides to force positions — the chat nodes
    // (REQ-1: they are sim bodies, not chain-pinned) and the companions ──
    const forcePositions = new Map<string, NodePosition>([
      ['agent-corr-1', { x: 120, y: 40 }],
      ['agent-corr-2', { x: 140, y: 300 }],
      ['agent-corr-3', { x: 160, y: 560 }],
      ['tools-corr-2', { x: 800, y: 200 }],
      ['subagent-task-corr-1', { x: -900, y: 480 }],
    ]);
    act(() => {
      sim.tick(forcePositions);
    });

    // #2756: every node renders at its force-simulated position — the chat
    // nodes do NOT stay at computeChatChainPositions output (AC1: no chain
    // pinning), companions sit at theirs. The #2754 "spine byte-identical to
    // chain" assertion is DELIBERATELY replaced.
    expectSamePositions(nodePositions(result.current.nodes), forcePositions);
    const byId = (id: string) => result.current.nodes.find(n => n.id === id)!;
    expect(byId('agent-corr-2').position).toEqual({ x: 140, y: 300 });
    expect(byId('agent-corr-2').position.x).not.toBe(0);
    expect(byId('tools-corr-2').position).toEqual({ x: 800, y: 200 });
    expect(byId('tools-corr-2').position.x).not.toBe(TOOLS_CHAIN_X);
    expect(byId('subagent-task-corr-1').position).toEqual({ x: -900, y: 480 });
    expect(byId('subagent-task-corr-1').position.x).not.toBe(SUBAGENT_CHAIN_X);

    // EARS-8: node data (payload/status) survives the switch AND the tick —
    // ticks are position-only functional setNodes merges.
    const chatAfter = result.current.nodes.find(n => n.id === 'agent-corr-2')!;
    expect(chatAfter.data).toBe(chatBefore.data);
    expect(chatAfter.data.status).toBe(chatBefore.data.status);
    expect((chatAfter.data.payload as any).agentReply).toBe('ran');
    // Edges survive the switch untouched.
    expect(result.current.edges.map(e => e.id).sort()).toEqual([
      'e-calls-task-corr-1', 'e-chat-corr-1-corr-2', 'e-chat-corr-2-corr-3', 'e-tools-corr-2',
    ]);
  });

  it('EARS-6/T16: Force→Chain restores byte-identical chain positions and stops the simulation', async () => {
    // #2756 DELIBERATE UPDATE (round-2 AC7 stale-assertion fix): the interim
    // force-tick fixture now moves ALL nodes (chat included — REQ-1: they are
    // sim bodies), not just the companions. The final Force→Chain byte-identical
    // restore assertions below stay EXACTLY as shipped.
    const { result, rerender } = renderHook(
      ({ mode }: { mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: mode }),
      { initialProps: { mode: 'chain' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });
    const chainPositions = nodePositions(result.current.nodes);

    // chain → force → the sim glides EVERY node (chat included) to force
    // positions — the disjoint all-nodes glide (REQ-1).
    rerender({ mode: 'force' });
    await waitFor(() => {
      expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
    });
    const sim = latestSim();
    act(() => {
      sim.tick(new Map<string, NodePosition>([
        ['agent-corr-1', { x: 120, y: 40 }],
        ['agent-corr-2', { x: 140, y: 300 }],
        ['agent-corr-3', { x: 160, y: 560 }],
        ['tools-corr-2', { x: 800, y: 200 }],
        ['subagent-task-corr-1', { x: -900, y: 480 }],
      ]));
    });
    // #2756: the chat node LEFT its chain slot (x ≠ 0) — it is a sim body.
    expect(nodePositions(result.current.nodes).get('agent-corr-1')).toEqual({ x: 120, y: 40 });
    expect(nodePositions(result.current.nodes).get('agent-corr-1')!.x).not.toBe(0);
    expect(nodePositions(result.current.nodes).get('tools-corr-2')).toEqual({ x: 800, y: 200 });

    // force → chain: the sim is stopped (no orphan rAF — NFR-3) and the graph
    // snaps back to the EXACT pre-toggle chain geometry (byte-identical).
    rerender({ mode: 'chain' });
    await waitFor(() => {
      expect(sim.stops).toBeGreaterThanOrEqual(1);
    });
    expectSamePositions(nodePositions(result.current.nodes), chainPositions);
    const byId = (id: string) => result.current.nodes.find(n => n.id === id)!;
    expect(byId('agent-corr-1').position).toEqual({ x: 0, y: 0 });
    expect(byId('tools-corr-2').position.x).toBe(TOOLS_CHAIN_X);
    expect(byId('subagent-task-corr-1').position.x).toBe(SUBAGENT_CHAIN_X);
    expect(result.current.edges.map(e => e.id).sort()).toEqual([
      'e-calls-task-corr-1', 'e-chat-corr-1-corr-2', 'e-chat-corr-2-corr-3', 'e-tools-corr-2',
    ]);
  });

  it('EARS-4/T16: a structural change while in Force restarts the sim seeded from the CURRENT positions (mid-stream) — new nodes slide in, existing nodes do not jump', async () => {
    // #2756 DELIBERATE UPDATE (round-2 AC7 stale-assertion fix): the #2754
    // "agents-only → no sim" rationale is gone — under the TRUE disjoint layout
    // an all-chat graph still simulates (REQ-1: every node is a body). The
    // companion (tools-corr-2, from corr-2's Bash exchange) is kept so the
    // mid-stream restart runs over a mixed node set; the tick moves ALL nodes
    // (chat included) to force positions.
    const batch1: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'first', startTime: '2026-08-17T10:00:00.000Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'first', agentReply: 'reply-1',
        startTime: '2026-08-17T10:00:00.000Z', endTime: '2026-08-17T10:00:20.000Z',
      }),
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'second', startTime: '2026-08-17T10:00:30.000Z',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'second', agentReply: 'reply-2',
        startTime: '2026-08-17T10:00:30.000Z', endTime: '2026-08-17T10:00:50.000Z',
      }),
      // The companion — corr-2's exchange makes a Bash call → tools-corr-2.
      makeToolDelivery('t1', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls', startTime: '2026-08-17T10:00:35.000Z',
      }),
      makeToolDelivery('t2', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls', output: 'files',
        startTime: '2026-08-17T10:00:35.000Z', endTime: '2026-08-17T10:00:36.000Z',
      }),
    ];
    const batch2: ContractDelivery[] = [
      ...batch1,
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'third', startTime: '2026-08-17T10:01:00.000Z',
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'third', agentReply: 'reply-3',
        startTime: '2026-08-17T10:01:00.000Z', endTime: '2026-08-17T10:01:20.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries, mode }: { deliveries: ContractDelivery[]; mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1', layoutMode: mode }),
      { initialProps: { deliveries: batch1, mode: 'force' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
      expect(result.current.nodes.filter(n => n.id === 'tools-corr-2')).toHaveLength(1);
    });
    expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
    const sim = latestSim();
    expect(sim.restarts).toHaveLength(1);

    // The first frame glides EVERY node (chat included) to a known force
    // position — the disjoint all-nodes glide (REQ-1).
    const p1 = new Map<string, NodePosition>([
      ['agent-corr-1', { x: 120, y: 40 }],
      ['agent-corr-2', { x: 140, y: 300 }],
      ['tools-corr-2', { x: 800, y: 200 }],
    ]);
    act(() => {
      sim.tick(p1);
    });
    // #2756: the chat node moved off its chain slot (x ≠ 0) — it is a sim body.
    expect(nodePositions(result.current.nodes).get('agent-corr-1')).toEqual({ x: 120, y: 40 });
    expect(nodePositions(result.current.nodes).get('agent-corr-1')!.x).not.toBe(0);
    expect(nodePositions(result.current.nodes).get('tools-corr-2')).toEqual({ x: 800, y: 200 });

    // Structural change while Force is active (a new turn arrives mid-stream).
    // #2756 DELIBERATE UPDATE: the #2754 `pinnedChanged` re-create gate is
    // GONE — there is no pinned set to change, so a structural change
    // RESTARTS the SAME sim handle (the builder is created once and re-seeded),
    // never stopping the old sim and never creating a fresh builder.
    rerender({ deliveries: batch2, mode: 'force' });

    await waitFor(() => {
      expect(latestSim()).toBe(sim);
      expect(sim.restarts).toHaveLength(2);
    });
    // The same handle was reused — no stop, no re-create (the #2754 stop+recreate
    // is a deliberate removal).
    expect(sim.stops).toBe(0);
    const newRestart = sim.restarts[1];
    expect(newRestart.nodes.map(n => n.id).sort()).toEqual([
      'agent-corr-1', 'agent-corr-2', 'agent-corr-3', 'tools-corr-2',
    ]);
    // The restart is seeded from the CURRENT node positions (the last frame —
    // the p1 force positions), never (0,0) and never the original chain
    // geometry (EARS-4). The seed assertion covers the companion (tools-corr-2
    // keeps its current spot) and the pre-existing agents (they keep their
    // force positions); the fresh agent-corr-3 is NOT in the seed (it enters at
    // the sim's fresh-node seed — no chain slot overlay).
    expect(newRestart.seed.get('tools-corr-2')).toEqual({ x: 800, y: 200 });
    expect(newRestart.seed.get('agent-corr-1')).toEqual({ x: 120, y: 40 });
    expect(newRestart.seed.get('agent-corr-2')).toEqual({ x: 140, y: 300 });
    expect(newRestart.seed.has('agent-corr-3')).toBe(false);

    // Existing nodes keep their exact spot (no jump); the new chat node enters
    // at the sim's fresh-node seed (REQ-1 — a chat node IS a sim body now, it
    // does NOT pin to a chain-bottom slot).
    const afterRestart = nodePositions(result.current.nodes);
    expect(afterRestart.get('agent-corr-1')).toEqual({ x: 120, y: 40 });
    expect(afterRestart.get('agent-corr-2')).toEqual({ x: 140, y: 300 });
    expect(afterRestart.get('tools-corr-2')).toEqual({ x: 800, y: 200 });
    const fresh = afterRestart.get('agent-corr-3')!;
    expect(fresh).toBeDefined();
    // NOT the chain-bottom slot (0, (DEFAULT_NODE_HEIGHT + CHAIN_GAP) * 2) and
    // NOT (0,0) — the mock's fresh-node seed, wherever the sim places it.
    expect(fresh).not.toEqual({ x: 0, y: (DEFAULT_NODE_HEIGHT + CHAIN_GAP) * 2 });
    expect(fresh).not.toEqual({ x: 0, y: 0 });
  });

  it('EARS-3: freeze-on-settled — after the sim settles, ticks stop, positions stay stable, and a height-only reflow never restarts the loop', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'first', startTime: '2026-08-17T10:00:00.000Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'first', agentReply: 'reply-1',
        startTime: '2026-08-17T10:00:00.000Z', endTime: '2026-08-17T10:00:20.000Z',
      }),
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'second', startTime: '2026-08-17T10:00:30.000Z',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'second', agentReply: 'reply-2',
        startTime: '2026-08-17T10:00:30.000Z', endTime: '2026-08-17T10:00:50.000Z',
      }),
      // The companion — corr-2's Bash exchange emits tools-corr-2 so the
      // freeze-on-settled + re-seed behaviors run over a mixed node set
      // (under REQ-1 an all-chat graph still simulates; the companion just
      // makes the fixture non-trivial).
      makeToolDelivery('t1', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls', startTime: '2026-08-17T10:00:35.000Z',
      }),
      makeToolDelivery('t2', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls', output: 'files',
        startTime: '2026-08-17T10:00:35.000Z', endTime: '2026-08-17T10:00:36.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ mode }: { mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1', layoutMode: mode }),
      { initialProps: { mode: 'force' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
      expect(result.current.nodes.filter(n => n.id === 'tools-corr-2')).toHaveLength(1);
    });
    const sim = latestSim();
    expect(sim.restarts).toHaveLength(1);

    // Two frames of glide — EVERY node moves (chat included — REQ-1: they are
    // sim bodies); the companion glides (800,200)→(850,210) and the chat nodes
    // move off the chain geometry too.
    act(() => {
      sim.tick(new Map([
        ['agent-corr-1', { x: 120, y: 40 }],
        ['agent-corr-2', { x: 140, y: 300 }],
        ['tools-corr-2', { x: 800, y: 200 }],
      ]));
    });
    act(() => {
      sim.tick(new Map([
        ['agent-corr-1', { x: 122, y: 42 }],
        ['agent-corr-2', { x: 142, y: 302 }],
        ['tools-corr-2', { x: 850, y: 210 }],
      ]));
    });
    expect(nodePositions(result.current.nodes).get('agent-corr-1')).toEqual({ x: 122, y: 42 });
    expect(nodePositions(result.current.nodes).get('agent-corr-1')!.x).not.toBe(0);
    expect(nodePositions(result.current.nodes).get('tools-corr-2')).toEqual({ x: 850, y: 210 });

    // alpha < alphaMin → the whole simulation freezes (freeze-on-settled).
    act(() => {
      sim.settle();
    });

    // Any further frame is a no-op — positions stay exactly where they settled
    // (the chat nodes at their force positions, off the chain geometry).
    act(() => {
      sim.tick(new Map([
        ['agent-corr-1', { x: 999, y: 999 }],
        ['tools-corr-2', { x: 888, y: 888 }],
      ]));
    });
    expect(nodePositions(result.current.nodes).get('agent-corr-1')).toEqual({ x: 122, y: 42 });
    expect(nodePositions(result.current.nodes).get('tools-corr-2')).toEqual({ x: 850, y: 210 });

    // #2756 DELIBERATE UPDATE (assertion FLIP): the #2754 height-only chain
    // re-pin is GONE — in Force there is no chain to re-pin. A measured-height
    // change RE-SEEDS the sim from the CURRENT positions: every node (chat
    // included) keeps its exact current spot via the seed — no re-stack, no
    // chain geometry is re-applied (the mock's restart seeds existing nodes
    // from the seed map verbatim).
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
    await waitFor(() => {
      expect(sim.restarts).toHaveLength(2);
    });
    // The height change restarted the sim (re-seed, not re-pin)…
    expect(sim.restarts).toHaveLength(2);
    // …without stopping it (no orphan rAF — the loop is re-seeded, not killed).
    expect(sim.stops).toBe(0);
    // Nodes keep their CURRENT settled positions — agent-corr-2 does NOT
    // re-stack under corr-1's taller measured height (the #2754 chain re-pin
    // would have moved it); the seed preserves every spot — chat nodes keep
    // their force positions, off the chain geometry.
    const afterRepin = nodePositions(result.current.nodes);
    expect(afterRepin.get('agent-corr-1')).toEqual({ x: 122, y: 42 });
    expect(afterRepin.get('agent-corr-2')).toEqual({ x: 142, y: 302 });
    expect(afterRepin.get('tools-corr-2')).toEqual({ x: 850, y: 210 });

    // A same-mode re-render never touches the sim either.
    rerender({ mode: 'force' });
    expect(sim.restarts).toHaveLength(2);
    expect(nodePositions(result.current.nodes).get('agent-corr-1')).toEqual({ x: 122, y: 42 });
  });

  it('T16 edge: switching to Force with no nodes is a silent no-op — no sim is created, no crash', async () => {
    const { result, rerender } = renderHook(
      ({ mode }: { mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries: [], sessionId: 's1', layoutMode: mode }),
      { initialProps: { mode: 'chain' as LayoutMode } },
    );

    expect(result.current.nodes).toEqual([]);
    rerender({ mode: 'force' });
    expect(vi.mocked(createLiveForceSimulation)).not.toHaveBeenCalled();
    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
  });

  it('T16 edge: two switches in one render — chain→force→chain leaves exactly one stopped sim and byte-identical chain positions', async () => {
    const { result, rerender } = renderHook(
      ({ mode }: { mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: mode }),
      { initialProps: { mode: 'chain' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });
    const chainPositions = nodePositions(result.current.nodes);

    // Two rapid switches back-to-back (chain→force→chain). Each rerender is
    // its own commit/effect (React would batch two nested rerenders in one
    // act into a single commit, discarding the intermediate force state) —
    // the force sim is created, then torn down by the chain restore; no
    // orphan rAF survives (NFR-3/T19).
    rerender({ mode: 'force' });
    rerender({ mode: 'chain' });

    expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
    const sim = latestSim();
    expect(sim.restarts).toHaveLength(1);
    expect(sim.stops).toBe(1);
    expectSamePositions(nodePositions(result.current.nodes), chainPositions);
    expect(result.current.edges.map(e => e.id).sort()).toEqual([
      'e-calls-task-corr-1', 'e-chat-corr-1-corr-2', 'e-chat-corr-2-corr-3', 'e-tools-corr-2',
    ]);
  });
});

// ── #2756 DELIBERATE UPDATE: disjoint Force branch coverage (AC7) ─────────────
//
// The #2754 hybrid capsule is DELIBERATELY rewritten for the true disjoint
// force layout (REQ-1/2/3/4). This block covers the #2756 guarantees:
//  - the restart edge set is the EXCHANGE set — subagent→parent + synthesized
//    tools→parent, with NO chat→chat link (AC2);
//  - the builder options surface the disjoint wiring — per-node forceX/forceY
//    positioning forces (one anchor pair per exchange) + the exported strength
//    constant, snapToSettled from prefers-reduced-motion (AC4 exception), and
//    NO `pinned` set (REQ-1);
//  - freeze-on-settled caches the delivered positions VERBATIM — the #2754
//    settled clamp (halo snap / 600px bound) is gone (REQ-1/REQ-3);
//  - a freshly added chat node enters at the SIM seed, NOT the chain bottom
//    (REQ-1).
//
// EARS: REQ-1, REQ-2, REQ-3, REQ-4. Files: hooks/__tests__/useMissionMonitor.test.ts.

describe('#2756 DELIBERATE UPDATE: disjoint Force branch — exchange edge set, positioning forces, no settled clamp, reduced-motion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForceSims.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const latestSim = (): MockForceSimHandle => mockForceSims[mockForceSims.length - 1];

  it('#2756 DELIBERATE UPDATE: the force restart carries the EXCHANGE edge set — the subagent→parent edge AND the synthesized tools→parent link, with NO chat→chat link (AC2: tools cluster too)', async () => {
    const { result, rerender } = renderHook(
      ({ mode }: { mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: mode }),
      { initialProps: { mode: 'chain' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    rerender({ mode: 'force' });
    await waitFor(() => {
      expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
    });
    const sim = latestSim();
    expect(sim.restarts).toHaveLength(1);

    // allLayoutEdges (subagent) survives; the ST-2 tools link is synthesized.
    // makeFullFixture: corr-2's Bash exchange → tools-corr-2; corr-3's task
    // dispatch → subagent-task-corr-1 anchored to agent-corr-3.
    expect(sim.restarts[0].edges).toContainEqual({ source: 'agent-corr-2', target: 'tools-corr-2' });
    expect(sim.restarts[0].edges).toContainEqual({ source: 'agent-corr-3', target: 'subagent-task-corr-1' });
    // Exactly those two companion links — no extra layout edges in the fixture.
    expect(sim.restarts[0].edges).toHaveLength(2);
  });

  it('#2756 DELIBERATE UPDATE: the force builder receives per-node forceX/forceY POSITIONING forces (one anchor pair per exchange) + the exported strength constant, and snapToSettled from prefers-reduced-motion (default: no reduce → false)', async () => {
    const { result, rerender } = renderHook(
      ({ mode }: { mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: mode }),
      { initialProps: { mode: 'chain' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });

    rerender({ mode: 'force' });
    await waitFor(() => {
      expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
    });
    const sim = latestSim();
    // #2756: NO `pinned` set — every node is a sim body (the #2754 chat-spine
    // pin contract is removed; REQ-1). Instead the builder gets the disjoint
    // positioning-force wiring: ref-read forceX/forceY callbacks resolving each
    // node's per-exchange anchor + the exported weak strength constant.
    expect(sim.options?.pinned).toBeUndefined();
    expect(sim.options?.forceX).toBeTypeOf('function');
    expect(sim.options?.forceY).toBeTypeOf('function');
    expect(sim.options?.forceXStrength).toBe(FORCE_POSITION_STRENGTH);
    expect(sim.options?.forceYStrength).toBe(FORCE_POSITION_STRENGTH);
    // Default (no prefers-reduced-motion): the rAF glide path is NOT replaced.
    expect(sim.options?.snapToSettled).toBe(false);
  });

  it('#2756 DELIBERATE UPDATE: prefers-reduced-motion → the force builder is created with snapToSettled: true (no rAF glide — AC4 exception); positioning forces + strength are wired on the snap path too', async () => {
    // Mirror the panel camera-snap wiring (MissionMonitorPanel.autofocus
    // test): matchMedia reports reduce → the hook passes snapToSettled: true.
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
    });
    const sim = latestSim();
    expect(sim.options?.snapToSettled).toBe(true);
    // The positioning-force wiring survives on the reduced-motion path too —
    // the snap settles the DISJOINT recipe (no pinned set, per-exchange
    // forceX/forceY anchors, weak exported strength).
    expect(sim.options?.pinned).toBeUndefined();
    expect(sim.options?.forceX).toBeTypeOf('function');
    expect(sim.options?.forceY).toBeTypeOf('function');
    expect(sim.options?.forceXStrength).toBe(FORCE_POSITION_STRENGTH);
    expect(sim.options?.forceYStrength).toBe(FORCE_POSITION_STRENGTH);
  });

  it('#2756 DELIBERATE UPDATE: freeze-on-settled caches the delivered positions VERBATIM — NO settled clamp (the #2754 halo/600px clampSettledCompanions pass is removed with the chain spine)', async () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: makeFullFixture(), sessionId: 's1', layoutMode: 'force' }),
    );

    await waitFor(() => {
      expect(vi.mocked(createLiveForceSimulation)).toHaveBeenCalledTimes(1);
      expect(result.current.nodes.filter(n => n.id === 'subagent-task-corr-1')).toHaveLength(1);
    });
    const sim = latestSim();

    // The sim delivers arbitrary force-settled positions — a companion INSIDE
    // the old chain band (x=300) and a subagent beyond the old 600px bound
    // (x=-900). Under the #2754 hybrid, freeze-on-settled ran the deterministic
    // clamp pass (snap to halo edge 564 / clamp to ±600). #2756 DELETED that
    // pass: the delivered positions are cached verbatim — no chain to clamp to.
    // As in the real sim, the final onTick delivers the same positions that
    // onSettled then receives.
    const chainY2 = DEFAULT_NODE_HEIGHT + CHAIN_GAP; // agent-corr-2's chain slot y
    const chainY3 = chainY2 + DEFAULT_NODE_HEIGHT + CHAIN_GAP; // agent-corr-3
    const settled = new Map<string, NodePosition>([
      ['agent-corr-1', { x: 0, y: 0 }],
      ['agent-corr-2', { x: 0, y: chainY2 }],
      ['agent-corr-3', { x: 0, y: chainY3 }],
      ['tools-corr-2', { x: 300, y: chainY2 }], // inside the old chain band
      ['subagent-task-corr-1', { x: -900, y: chainY3 }], // beyond the old 600px bound
    ]);
    act(() => {
      sim.tick(settled); // final frame — store renders the settled positions
      sim.fireSettled(settled); // freeze — onSettled caches them verbatim
    });

    // The settle delivered the positions AS-IS: the tools companion stays at
    // x=300 (no halo snap to 564) and the subagent stays at x=-900 (no 600px
    // clamp). The mock's onSettled syncs the cached positions; no deterministic
    // post-pass rewrites them (REQ-1 — nothing is pinned to a chain geometry).
    const byId = (id: string) => result.current.nodes.find(n => n.id === id)!;
    expect(byId('tools-corr-2').position).toEqual({ x: 300, y: chainY2 });
    expect(byId('subagent-task-corr-1').position).toEqual({ x: -900, y: chainY3 });
  });

  it('#2756 DELIBERATE UPDATE: a freshly added chat node enters at the SIM seed and joins its exchange — pre-existing nodes keep byte-identical positions, NO chain-bottom slot (REQ-1)', async () => {
    const batch1: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'first', startTime: '2026-08-17T10:00:00.000Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'first', agentReply: 'reply-1',
        startTime: '2026-08-17T10:00:00.000Z', endTime: '2026-08-17T10:00:20.000Z',
      }),
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'second', startTime: '2026-08-17T10:00:30.000Z',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'second', agentReply: 'reply-2',
        startTime: '2026-08-17T10:00:30.000Z', endTime: '2026-08-17T10:00:50.000Z',
      }),
      // The companion — corr-2's Bash exchange → tools-corr-2.
      makeToolDelivery('t1', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls', startTime: '2026-08-17T10:00:35.000Z',
      }),
      makeToolDelivery('t2', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls', output: 'files',
        startTime: '2026-08-17T10:00:35.000Z', endTime: '2026-08-17T10:00:36.000Z',
      }),
    ];
    const batch2: ContractDelivery[] = [
      ...batch1,
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'third', startTime: '2026-08-17T10:01:00.000Z',
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'third', agentReply: 'reply-3',
        startTime: '2026-08-17T10:01:00.000Z', endTime: '2026-08-17T10:01:20.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries, mode }: { deliveries: ContractDelivery[]; mode: LayoutMode }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1', layoutMode: mode }),
      { initialProps: { deliveries: batch1, mode: 'force' as LayoutMode } },
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
      expect(result.current.nodes.filter(n => n.id === 'tools-corr-2')).toHaveLength(1);
    });

    // Chat positions before the new node arrives — the SIM's seeded positions
    // (never computeChatChainPositions — chat nodes are sim bodies in Force).
    const before = nodePositions(result.current.nodes);
    expect(before.get('agent-corr-1')).toBeDefined();
    expect(before.get('agent-corr-2')).toBeDefined();
    // Explicitly NOT the deterministic chain geometry (x=0 column).
    expect(before.get('agent-corr-1')!.x).not.toBe(0);

    // A new chat turn arrives mid-stream while Force is active.
    rerender({ deliveries: batch2, mode: 'force' });

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id === 'agent-corr-3')).toHaveLength(1);
    });
    // #2756: the pre-existing chat nodes kept their EXACT positions (the
    // restart seed = current positions — no chain re-stack, no jump) and the
    // new chat node entered at the SIM's fresh-node seed — NOT a chain-bottom
    // slot (REQ-1: it is a sim body that glides to its exchange's anchor).
    const after = nodePositions(result.current.nodes);
    expect(after.get('agent-corr-1')).toEqual(before.get('agent-corr-1'));
    expect(after.get('agent-corr-2')).toEqual(before.get('agent-corr-2'));
    const fresh = after.get('agent-corr-3')!;
    expect(fresh).toBeDefined();
    // Not the chain-bottom slot and not (0,0) — the sim's fresh-node seed.
    expect(fresh).not.toEqual({ x: 0, y: (DEFAULT_NODE_HEIGHT + CHAIN_GAP) * 2 });
    expect(fresh).not.toEqual({ x: 0, y: 0 });
  });
});

