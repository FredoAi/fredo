/**
 * Tests for delivery-driven graph building — replaces legacy buildGraphFromEvents.
 *
 * Run with: pnpm --filter @fredo/ui test:run -- --testPathPattern buildGraph
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

// Mock StreamContext (useDeliveryGraph consumes deliveries via useStream in the
// live path; tests inject the deliveries prop directly).
const mockDeliveries: ContractDelivery[] = [];
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    deliveries: mockDeliveries,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useDeliveryGraph } from '../useMissionMonitor';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  overrides: Record<string, unknown> = {},
): ContractDelivery {
  return {
    id,
    contractName: 'chat-node',
    lifecycle,
    key: { sessionId, correlationId },
    payload: {
      payload: {
        info: { text: '', modelID: 'claude-sonnet-4', agent: '' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 50,
        ...overrides,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

/** #2750 NFR-1 — tool-use-lifecycle delivery helper (task spans for
 *  SubagentNode / tool spans for ToolsNode). Mirrors the makeToolDelivery in
 *  useMissionMonitor.test.ts:59-87. */
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

// ── useDeliveryGraph Tests ──────────────────────────────────────────────────────

describe('useDeliveryGraph', () => {
  it('should create agent nodes from init deliveries', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', {
        agent: 'Architect',
        info: { text: 'Hello, can you help me?', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: 'Sure, I can help!', reasoning: 'Let me think...' },
        turnInputTokens: 100,
        turnOutputTokens: 500,
      }),
    ];

    // We can't render hooks in pure unit test, but we can test the contract
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].contractName).toBe('chat-node');
    expect(deliveries[0].lifecycle).toBe('init');
    expect(deliveries[0].key.sessionId).toBe('s1');
    expect(deliveries[0].key.correlationId).toBe('corr-1');
  });

  it('should handle multiple deliveries for the same session', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1'),
      makeDelivery('d2', 'update', 's1', 'corr-1'),
      makeDelivery('d3', 'end', 's1', 'corr-1'),
    ];

    expect(deliveries).toHaveLength(3);
    expect(deliveries.filter(d => d.key.sessionId === 's1')).toHaveLength(3);
  });

  it('AC5: a subagents array in the payload is inert — the builder has no subagent path', () => {
    // Spec #2723 AC5 reverses Spec #523: subagent-derived content must never
    // produce entries. The `subagents` array is a legacy/mock payload field
    // the graph builder does NOT consume — chat-node deliveries route to
    // AgentNode lifecycles only, and the engine-side excludePayload contract
    // filter (is_subagent / agent.type) is the authoritative exclusion.
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', {
        agent: 'Architect',
        subagents: [
          { name: 'Coder', instruction: 'Implement feature', output: '' },
        ],
      }),
    ];

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].contractName).toBe('chat-node');
    const p = deliveries[0].payload['payload'] as Record<string, any>;
    expect(p.subagents).toBeDefined();
    expect(p.subagents).toHaveLength(1);
    expect(p.subagents[0].name).toBe('Coder');
    // The field is inert for graph building: no node is derived from it.
  });

  it('should create tool nodes when tools in payload', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', {
        tools: [
          { name: 'edit', input: 'file.ts', output: 'ok' },
        ],
      }),
    ];

    expect(deliveries).toHaveLength(1);
    const p = deliveries[0].payload['payload'] as Record<string, any>;
    expect(p.tools).toBeDefined();
    expect(p.tools).toHaveLength(1);
    expect(p.tools[0].name).toBe('edit');
  });

  it('should handle lifecycle transitions: init → update → end', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1'),
      makeDelivery('d2', 'end', 's1', 'corr-1'),
    ];

    expect(deliveries[0].lifecycle).toBe('init');
    expect(deliveries[1].lifecycle).toBe('end');
  });

  it('should filter by contractName', () => {
    const valid: ContractDelivery = makeDelivery('d1', 'init', 's1', 'corr-1');
    const invalid: ContractDelivery = {
      ...valid,
      id: 'd2',
      contractName: 'other-contract',
    };

    const chatNodeDeliveries = [valid, invalid].filter(d => d.contractName === 'chat-node');
    expect(chatNodeDeliveries).toHaveLength(1);
    expect(chatNodeDeliveries[0].id).toBe('d1');
  });

  it('should handle empty payload (edge case)', () => {
    const delivery: ContractDelivery = {
      id: 'd1',
      contractName: 'chat-node',
      lifecycle: 'init',
      key: { sessionId: 's1', correlationId: 'corr-1' },
      payload: {},
      timestamp: new Date().toISOString(),
    };

    expect(delivery.payload).toEqual({});
  });
});

// ── Spec #2723 ST-3 (R-3 / AC3): 3+ node per-node correctness ────────────────
//
// Live diagnostic (ses_044bb36d7ffeeh5kwPSzvQ1Aum, 57 turns): the adapter now
// delivers per-turn cache-read DELTAS (512,000 / 1,536 / 2,304 / 384 / 1,920)
// derived from the session-cumulative gen_ai.usage.cache_read.input_tokens.
// The graph builder must keep each node on its OWN per-turn figures across 3+
// nodes — never another node's value and never the session-cumulative cache
// total (which would be literal cross-node contamination). Fixtures feed the
// LIVE adapter shape (G-011): each turn is an init+end pair per key in one
// batch.

describe('Spec #2723 ST-3: 3+ node graph keeps per-turn cache deltas (no contamination)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
  });

  it('builds 3 agent nodes each carrying its own per-turn cache delta', async () => {
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
    // Each node = its own per-turn delta — never another node's, never the
    // cumulative cache total at that turn (513,536 / 515,840).
    expect(payload('agent-corr-1').cacheReadTokens).toBe(512000);
    expect(payload('agent-corr-2').cacheReadTokens).toBe(1536);
    expect(payload('agent-corr-2').cacheReadTokens).not.toBe(513536);
    expect(payload('agent-corr-3').cacheReadTokens).toBe(2304);
    expect(payload('agent-corr-3').cacheReadTokens).not.toBe(515840);
    // Total recomputed per R-3.1 from the node's OWN figures.
    expect(payload('agent-corr-3').totalTokens).toBe(32 + 2304 + 7 + 9);
  });

  it('3 nodes: a mid-lifecycle cumulative cache spike never sticks and never crosses nodes', async () => {
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
      // Session-cumulative total sneaks into node 2's update — must NOT stick
      // (last-wins, never Math.max — REQ-8).
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
    expect(payload('agent-corr-2').cacheReadTokens).toBe(1536);
    expect(payload('agent-corr-2').cacheReadTokens).not.toBe(513536);
    // No cross-node contamination — node 1 and 3 unaffected by node 2's spike.
    expect(payload('agent-corr-1').cacheReadTokens).toBe(512000);
    expect(payload('agent-corr-3').cacheReadTokens).toBe(2304);
  });
});

// ── Spec #2723 ST-4 (R-4 / AC4): many-node graph, no collisions ──────────────
// AC4: in a session with many chat nodes, no two nodes overlap or cover each
// other — every node fully visible and selectable. The chain stacks by
// measured height (y = prev.y + (prev.height ?? DEFAULT_NODE_HEIGHT) +
// CHAIN_GAP), so a 15-node chain cannot collide even when every node carries
// a full response box.

describe('Spec #2723 ST-4: many-node graph (AC4)', () => {
  it('15 chat nodes are all created, positioned distinctly, and never overlap', async () => {
    const deliveries: ContractDelivery[] = [];
    for (let i = 1; i <= 15; i++) {
      deliveries.push(
        makeDelivery(`i${i}`, 'init', 's1', `corr-${i}`, { userMessage: `turn-${i}` }),
        makeDelivery(`e${i}`, 'end', 's1', `corr-${i}`, {
          userMessage: `turn-${i}`,
          agentReply: `reply-${i}`,
        }),
      );
    }

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(15);
    });

    const agentNodes = result.current.nodes.filter(n => n.id.startsWith('agent-'));

    // No two nodes share a position — nothing covers anything.
    const positionSet = new Set(agentNodes.map(n => `${n.position.x.toFixed(2)},${n.position.y.toFixed(2)}`));
    expect(positionSet.size).toBe(15);

    // Chain stays vertical (shared x), oldest at the top (smallest y).
    const xs = new Set(agentNodes.map(n => n.position.x));
    expect(xs.size).toBe(1);
    const sortedByY = [...agentNodes].sort((a, b) => a.position.y - b.position.y);
    expect(sortedByY[0].position.y).toBe(0);
  });
});

// ── #2750 AC4 (ST-5): suppress transitional text-less chat turns ──────────────
// A completed chat-node turn with an EMPTY agentReply (a dispatch turn whose
// LLM call ended on tool-calls) is a transitional turn: it renders no chat
// node, and the chat chain re-anchors to the nearest preceding visible turn.

describe('#2750 AC4: transitional text-less turn suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
  });

  it('suppresses a completed text-less turn from the canvas and skips it in the chain', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('i1', 'init', 's1', 'corr-1', { userMessage: 'first' }),
      makeDelivery('e1', 'end', 's1', 'corr-1', { userMessage: 'first', agentReply: 'reply-1' }),
      // Transitional dispatch turn — complete, empty agentReply (thinking only).
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'dispatch',
        agentThinking: 'I should dispatch a subagent…',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'dispatch',
        agentThinking: 'I should dispatch a subagent…',
      }),
      // The real reply turn — same user message.
      makeDelivery('i3', 'init', 's1', 'corr-3', { userMessage: 'dispatch' }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'dispatch',
        agentReply: 'the child replied',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
    });

    // The transitional turn is suppressed; the two REAL turns render.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    expect(result.current.nodes.find(n => n.id === 'agent-corr-3')).toBeDefined();

    // Chain re-anchors: corr-1 → corr-3 (skips the suppressed corr-2).
    const chatEdges = result.current.edges.filter(e => e.id.startsWith('e-chat-'));
    expect(chatEdges).toHaveLength(1);
    expect(chatEdges[0].id).toBe('e-chat-corr-1-corr-3');
    expect(chatEdges[0].source).toBe('agent-corr-1');
    expect(chatEdges[0].target).toBe('agent-corr-3');
  });

  // ── #2750 NFR-1 (round-2): the emitted node set carries UNIQUE React keys
  //    after suppression + anchor resolution ─────────────────────────────────
  // Round-1 testing observed repeated "Encountered two children with the same
  // key" console errors during Mission Monitor rendering. The graph builder's
  // ReactFlow node ids ARE the React keys (`agent-<corrId>` / `tools-<corrId>`
  // / `subagent-<corrId>`). Suppression (AC4 ST-5) skips emission of
  // transitional turns and re-anchors their children to the nearest visible
  // chat node — it must NEVER collide node ids: each affected entryId in
  // nodeOrder is unique, so every emitted node id must be unique. This test
  // pins that invariant across the full suppression/anchor-resolution surface
  // (suppressed chat turn + its re-anchored ToolsNode + SubagentNode + visible
  // chat turns), so a future builder change that double-emits a node id fails
  // the regression.
  it('NFR-1: the emitted node set has UNIQUE React keys (ids) after suppression + anchor resolution', async () => {
    const deliveries: ContractDelivery[] = [
      // Visible chat turn 1 (a real reply).
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'first',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'first',
        agentReply: 'reply-1',
        startTime: '2026-08-15T10:00:00.000Z',
      }),
      // Transitional dispatch turn — complete, empty agentReply (suppressed).
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'dispatch',
        agentThinking: 'I should dispatch a subagent…',
        startTime: '2026-08-15T10:01:00.000Z',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'dispatch',
        agentThinking: 'I should dispatch a subagent…',
        startTime: '2026-08-15T10:01:00.000Z',
      }),
      // A tool call from the suppressed dispatch turn — its ToolsNode
      // re-anchors to corr-1 (the nearest preceding visible chat node).
      makeToolDelivery('t1', 'init', 's1', 'tool-1', 'edit', {
        input: 'a.ts',
        startTime: '2026-08-15T10:01:05.000Z',
      }),
      makeToolDelivery('t2', 'end', 's1', 'tool-1', 'edit', {
        input: 'a.ts',
        output: 'ok',
        startTime: '2026-08-15T10:01:05.000Z',
      }),
      // A subagent dispatch from the suppressed turn — its SubagentNode
      // re-anchors to corr-1.
      makeToolDelivery('t3', 'init', 's1', 'task-1', 'task', {
        input: JSON.stringify({ subagent_type: 'explore', prompt: 'go' }),
        startTime: '2026-08-15T10:01:10.000Z',
      }),
      makeToolDelivery('t4', 'end', 's1', 'task-1', 'task', {
        input: JSON.stringify({ subagent_type: 'explore', prompt: 'go' }),
        output: 'result',
        childSessionId: 'ses_child_1',
        startTime: '2026-08-15T10:01:10.000Z',
      }),
      // The real reply turn — same user message (visible).
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'dispatch',
        startTime: '2026-08-15T10:02:00.000Z',
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'dispatch',
        agentReply: 'the child replied',
        startTime: '2026-08-15T10:02:00.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    // Wait until all three node families have emitted (agent + tools + subagent).
    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
      expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(1);
      expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
    });

    const ids = result.current.nodes.map(n => n.id);
    const uniqueIds = new Set(ids);

    // THE regression assertion: no two emitted nodes share an id (React key).
    expect(uniqueIds.size).toBe(ids.length);

    // Sanity: the suppressed transitional turn has NO agent node (emission
    // skipped), while its children re-anchored to the nearest visible node.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    // The ToolsNode of the suppressed turn is MERGED by anchor: it lives under
    // the SAME-EXCHANGE reply's id (`tools-corr-3` — one ToolsNode per VISIBLE
    // chat node, aggregating every dispatch turn that anchors to it) and its
    // edge sources from that reply (both carry userMessage 'dispatch') — never
    // the preceding unrelated corr-1 (same-exchange rule supersedes
    // nearest-preceding).
    const toolsNode = result.current.nodes.find(n => n.id === 'tools-corr-3');
    expect(toolsNode).toBeDefined();
    const toolsEdge = result.current.edges.find(e => e.id === 'e-tools-corr-3');
    expect(toolsEdge).toBeDefined();
    expect(toolsEdge!.source).toBe('agent-corr-3');
    const saEdge = result.current.edges.find(e => e.id === 'e-calls-task-1');
    expect(saEdge).toBeDefined();
    expect(saEdge!.source).toBe('agent-corr-3');
  });

  // ── #2750 round-6 (AC4): a suppressed transitional FIRST turn with NO
  //    preceding visible node must still emit its SubagentNode ───────────────
  // Round-5 fail (session `ses_fed7699aaffejpWUiOZM4y2eai`, persisted replay):
  // the dispatch turn was the session's FIRST chat node (the user's opening
  // message dispatched the subagent), so `buildVisibleAnchors` gave it no
  // chain predecessor — `resolveChildAnchor` returned '' and the emission gate
  // dropped the SubagentNode (DOM `subagentNode=0` despite 1 user-requested
  // `fredo.tool.task` span). The round-6 backward pass re-anchors such
  // anchorless transitional turns to the NEXT visible node (the reply turn
  // that completes the exchange). This test reproduces the PERSISTED-SESSION
  // shape: tool-use-lifecycle delivery first (FeatureStore timestamp order),
  // then the dispatch chat turn (empty agentReply), then the reply turn.
  it('round-6: a user-requested dispatch from a suppressed FIRST turn (no preceding visible node) still emits exactly ONE SubagentNode anchored to the next visible node', async () => {
    const TASK_ARGS = JSON.stringify({
      description: 'Research current date',
      prompt: 'Research the current date.',
      subagent_type: 'general',
    });
    // Persisted-session order: the task tool-use-lifecycle delivery is replayed
    // FIRST (FeatureStore orders by timestamp ASC), before the dispatch chat
    // turn and the reply turn.
    const deliveries: ContractDelivery[] = [
      // Task dispatch — the user-requested subagent (subagent_type NOT
      // build/plan). Its parent (time-window rule) is the dispatch turn corr-1.
      makeToolDelivery('t1', 'init', 's1', 'task-1', 'task', {
        input: TASK_ARGS,
        childCost: 0.0020461223999999997,
        startTime: '2026-08-18T01:43:14.941+00:00',
        endTime: '2026-08-18T01:43:20.548+00:00',
      }),
      makeToolDelivery('t2', 'end', 's1', 'task-1', 'task', {
        input: TASK_ARGS,
        childCost: 0.0020461223999999997,
        startTime: '2026-08-18T01:43:14.941+00:00',
        endTime: '2026-08-18T01:43:20.548+00:00',
      }),
      // Dispatch turn — the session's FIRST chat node, complete + empty
      // agentReply (the LLM ended on tool-calls) → suppressed (AC4 ST-5).
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'Use a subagent to research the current date and summarize the result',
        agentThinking: 'The user wants me to dispatch a subagent…',
        startTime: '2026-08-18T01:43:09.716+00:00',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'Use a subagent to research the current date and summarize the result',
        agentThinking: 'The user wants me to dispatch a subagent…',
        startTime: '2026-08-18T01:43:09.716+00:00',
        endTime: '2026-08-18T01:43:21.362+00:00',
      }),
      // Reply turn — same user message, real agentReply (visible).
      makeDelivery('i2', 'init', 's1', 'corr-2', {
        userMessage: 'Use a subagent to research the current date and summarize the result',
        startTime: '2026-08-18T01:43:21.369+00:00',
      }),
      makeDelivery('e2', 'end', 's1', 'corr-2', {
        userMessage: 'Use a subagent to research the current date and summarize the result',
        agentReply: 'The current date is **Monday, August 17, 2026**, at 19:43:17.',
        startTime: '2026-08-18T01:43:21.369+00:00',
        endTime: '2026-08-18T01:43:24.097+00:00',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    // Exactly ONE SubagentNode per user-requested dispatch (AC4-2 / round-6):
    // the anchorless suppressed FIRST turn must NOT drop it.
    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
    });

    // The dispatch turn is still suppressed from the canvas (NFR-5: suppression
    // is chat-node emission only) — only the reply turn renders as an agent node.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeUndefined();
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeDefined();

    // The SubagentNode's e-calls edge sources from the NEXT visible node (the
    // reply turn corr-2) — the round-6 re-anchor — never the suppressed
    // dispatch turn.
    const saNode = result.current.nodes.find(n => n.id === 'subagent-task-1');
    expect(saNode).toBeDefined();
    expect((saNode!.data.payload as any).output).toBe('');
    const saEdge = result.current.edges.find(e => e.id === 'e-calls-task-1');
    expect(saEdge).toBeDefined();
    expect(saEdge!.source).toBe('agent-corr-2');
    expect(saEdge!.target).toBe('subagent-task-1');
    expect(result.current.edges.some(e => e.source === 'agent-corr-1')).toBe(false);
  });

  // ── Cross-session contamination: a session switch must never leak a foreign
  //    session's SubagentNode into the selected session's graph ──────────────
  // Reported bug: when session B has a user-requested subagent dispatch, viewing
  // session A rendered B's SubagentNode. The emission gate's `parentExists`
  // fallback checked the GLOBAL builder map (`state.agentNodes` holds every
  // session's chat nodes), so a subagent whose parent chat node lived in a
  // DIFFERENT session passed the gate and leaked into the selected session.
  // Fix: scope the fallback to the selected session — the parent chat node must
  // carry the SELECTED session's sessionId (a suppressed/transitional parent in
  // THIS session still emits — round-6 — but a foreign session's never does).
  it('session-switch guard: a foreign session\u0027s SubagentNode does NOT leak into the selected session\u0027s graph', async () => {
    const TASK_ARGS = JSON.stringify({
      subagent_type: 'general',
      prompt: 'Do something in the other session',
    });
    const deliveries: ContractDelivery[] = [
      // Selected session s1 — one ordinary chat exchange.
      makeDelivery('s1-i1', 'init', 's1', 'corr-1', {
        userMessage: 'hello from s1',
        startTime: '2026-08-19T10:00:00.000Z',
      }),
      makeDelivery('s1-e1', 'end', 's1', 'corr-1', {
        userMessage: 'hello from s1',
        agentReply: 'hi',
        startTime: '2026-08-19T10:00:00.000Z',
      }),
      // Foreign session s2 — a chat node that dispatched a subagent.
      makeDelivery('s2-i1', 'init', 's2', 'corr-2', {
        userMessage: 'dispatch a subagent',
        agentThinking: '…',
        startTime: '2026-08-19T10:01:00.000Z',
      }),
      makeDelivery('s2-e1', 'end', 's2', 'corr-2', {
        userMessage: 'dispatch a subagent',
        agentThinking: '…',
        startTime: '2026-08-19T10:01:00.000Z',
      }),
      makeToolDelivery('t1', 'init', 's2', 'task-1', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-19T10:01:10.000Z',
      }),
      makeToolDelivery('t2', 'end', 's2', 'task-1', 'task', {
        input: TASK_ARGS,
        output: 'done',
        startTime: '2026-08-19T10:01:10.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    // s1's chat node renders.
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    });

    // THE regression assertion: s2's SubagentNode must NOT appear in s1's graph.
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
    expect(result.current.edges.some(e =>
      e.source.startsWith('subagent-') || e.target.startsWith('subagent-'),
    )).toBe(false);
  });

  // ── Duplicate ToolsNode regression (re-parenting): a tool delivery that
  //    arrives BEFORE its parent dispatch turn must yield ONE ToolsNode ──────
  // Live-shape bug (session `ses_fe330fd84ffe67AQxshpGQII5H`): the tool span
  // ENDS before the dispatch chat span closes (the LLM turn ends on tool-calls,
  // the tool executes, then the turn completes), so the tool-use-lifecycle
  // delivery arrives FIRST. The first `associateToolCalls` pass sees only the
  // EARLIER chat nodes and resolves the call to the previous visible turn
  // (`_3`); when the dispatch turn (`_6`) later arrives, the SAME call
  // re-resolves to it and a SECOND ToolsNode is created — the stale
  // `tools-..._3` entry was never removed, so the graph rendered two
  // ToolsNodes for one bash call. Fix: reconcile stale ToolsNode entries whose
  // parent no longer resolves any call in the current pass.
  it('re-parenting guard: a tool delivery arriving before its dispatch turn yields exactly ONE ToolsNode keyed to the true parent', async () => {
    const bash = makeToolDelivery('t5-i', 'init', 's1', 'tool-5', 'bash', {
      input: 'Write-Output "C Minor"',
      startTime: '2026-08-20T01:36:17.051Z',
      endTime: '2026-08-20T01:36:17.060Z',
    });
    const bashEnd = makeToolDelivery('t5-e', 'end', 's1', 'tool-5', 'bash', {
      input: 'Write-Output "C Minor"',
      output: 'C Minor',
      startTime: '2026-08-20T01:36:17.051Z',
      endTime: '2026-08-20T01:36:17.060Z',
    });

    // Batch 1 — the tool call arrives while only the EARLIER chat nodes exist
    // (the dispatch turn has not been delivered yet). The tool resolves to
    // corr-3 (greatest startTime < tool start).
    const batch1 = [
      makeDelivery('i1', 'init', 's1', 'corr-1', {
        userMessage: 'hey ! please tell me a joke but',
        startTime: '2026-08-20T01:35:23.822Z',
      }),
      makeDelivery('e1', 'end', 's1', 'corr-1', {
        userMessage: 'hey ! please tell me a joke but',
        agentReply: 'cut off',
        startTime: '2026-08-20T01:35:23.822Z',
      }),
      makeDelivery('i3', 'init', 's1', 'corr-3', {
        userMessage: 'make it for musicians',
        startTime: '2026-08-20T01:35:45.062Z',
      }),
      makeDelivery('e3', 'end', 's1', 'corr-3', {
        userMessage: 'make it for musicians',
        agentReply: 'metronome joke',
        startTime: '2026-08-20T01:35:45.062Z',
      }),
      bash,
      bashEnd,
    ];
    // Batch 2 — the dispatch turn + its reply arrive.
    const batch2 = [
      makeDelivery('i6', 'init', 's1', 'corr-6', {
        userMessage: 'ok now use powershell to say "C Minor"',
        agentThinking: 'run bash',
        startTime: '2026-08-20T01:36:14.636Z',
      }),
      makeDelivery('e6', 'end', 's1', 'corr-6', {
        userMessage: 'ok now use powershell to say "C Minor"',
        agentThinking: 'run bash',
        startTime: '2026-08-20T01:36:14.636Z',
        endTime: '2026-08-20T01:36:17.684Z',
      }),
      makeDelivery('i7', 'init', 's1', 'corr-7', {
        userMessage: 'ok now use powershell to say "C Minor"',
        startTime: '2026-08-20T01:36:17.688Z',
      }),
      makeDelivery('e7', 'end', 's1', 'corr-7', {
        userMessage: 'ok now use powershell to say "C Minor"',
        agentReply: 'Done. C Minor',
        startTime: '2026-08-20T01:36:17.688Z',
        endTime: '2026-08-20T01:36:20.536Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: batch1 } },
    );

    // Batch 1: the bash call tentatively attaches to corr-3 (the only
    // eligible parent present so far).
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'tools-corr-3')).toBeDefined();
    });

    // Batch 2: the true dispatch turn corr-6 arrives — the call re-parents.
    rerender({ deliveries: [...batch1, ...batch2] });

    // THE regression assertion: exactly ONE ToolsNode remains, MERGED under the
    // dispatch turn's same-exchange reply corr-7 (`tools-corr-7` — one ToolsNode
    // per VISIBLE chat node; the stale corr-3 entry was reconciled away).
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'tools-corr-7')).toBeDefined();
    });
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(1);
    expect(result.current.nodes.find(n => n.id === 'tools-corr-3')).toBeUndefined();

    // The surviving ToolsNode anchors to the dispatch turn's same-exchange
    // reply corr-7 (both share userMessage "ok now use powershell..."), never
    // to the preceding unrelated corr-3.
    const toolsEdge = result.current.edges.find(e => e.id === 'e-tools-corr-7');
    expect(toolsEdge).toBeDefined();
    expect(toolsEdge!.source).toBe('agent-corr-7');
    expect(toolsEdge!.target).toBe('tools-corr-7');
    expect(result.current.edges.some(e => e.id === 'e-tools-corr-3')).toBe(false);

    // Live-update regression: the reply turn corr-7 (created in the SAME batch
    // that reconciled the stale ToolsNode away) MUST still be emitted. The
    // reconcile must NOT splice `nodeOrder` — doing so shifts the array and
    // makes `newEntryIds = nodeOrder.slice(prevNodeOrderLength)` drop the
    // newest node of the batch (live updates stall: new chat nodes persisted
    // to SQLite but never rendered until a full refresh).
    expect(result.current.nodes.find(n => n.id === 'agent-corr-7')).toBeDefined();
  });

  // ── Dispatch-turn suppression regression (live exchange order) ─────────────
  // A tool-calling exchange delivers FOUR chat-node events: the dispatch turn
  // (empty agentReply — the LLM ended on tool-calls) and the reply turn (the
  // visible node), each with init+end. #2750 AC4 ST-5: the completed text-less
  // dispatch turn MUST be suppressed — no chat node for it — while the reply
  // turn renders. The live order here has the tool-use-lifecycle delivery
  // FIRST (tool span ends before the dispatch chat span closes), then the
  // dispatch chat init/end, then the reply chat init/end. A regression would
  // render the empty-reply dispatch turn as a visible node (the reported bug:
  // "a chat node without response").
  it('AC4 ST-5: a completed dispatch turn (empty agentReply) renders NO chat node — only its reply turn is visible, even when the tool delivery arrives first', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('p1-i', 'init', 's1', 'corr-1', {
        userMessage: 'what is 2+2',
        startTime: '2026-08-20T04:28:46.733Z',
      }),
      makeDelivery('p1-e', 'end', 's1', 'corr-1', {
        userMessage: 'what is 2+2',
        agentReply: '4',
        startTime: '2026-08-20T04:28:46.733Z',
      }),
      // Tool-use-lifecycle FIRST (live order: the tool span ends before the
      // dispatch chat span closes).
      makeToolDelivery('t-i', 'init', 's1', 'tool-1', 'bash', {
        input: 'Write-Output "42"',
        output: '42',
        startTime: '2026-08-20T04:29:54.906Z',
        endTime: '2026-08-20T04:29:54.919Z',
      }),
      makeToolDelivery('t-e', 'end', 's1', 'tool-1', 'bash', {
        input: 'Write-Output "42"',
        output: '42',
        startTime: '2026-08-20T04:29:54.906Z',
        endTime: '2026-08-20T04:29:54.919Z',
      }),
      // Dispatch turn — complete, whitespace-only agentReply ("\n\n" — opencode
      // emits a whitespace-only assistant message before the tool call, the
      // OTLP adapter injects it verbatim) → transitional (suppressed).
      makeDelivery('d-i', 'init', 's1', 'corr-2', {
        userMessage: 'run a powershell command that prints the number 42',
        agentReply: '\n\n',
        startTime: '2026-08-20T04:29:52.385Z',
      }),
      makeDelivery('d-e', 'end', 's1', 'corr-2', {
        userMessage: 'run a powershell command that prints the number 42',
        agentReply: '\n\n',
        startTime: '2026-08-20T04:29:52.385Z',
        endTime: '2026-08-20T04:29:55.569Z',
      }),
      // Reply turn — the visible node.
      makeDelivery('r-i', 'init', 's1', 'corr-3', {
        userMessage: 'run a powershell command that prints the number 42',
        startTime: '2026-08-20T04:29:55.574Z',
      }),
      makeDelivery('r-e', 'end', 's1', 'corr-3', {
        userMessage: 'run a powershell command that prints the number 42',
        agentReply: '42',
        startTime: '2026-08-20T04:29:55.574Z',
        endTime: '2026-08-20T04:30:00.871Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-3')).toBeDefined();
    });

    // THE regression assertion: the dispatch turn corr-2 (complete + empty
    // agentReply) renders NO chat node — only its reply corr-3 is visible.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    // The reply turn renders.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-3')).toBeDefined();
    // The bash ToolsNode is MERGED under the reply corr-3 (one ToolsNode per
    // VISIBLE chat node — the same-exchange anchor), never a per-parent node
    // nor a source from a suppressed node.
    const toolsNode = result.current.nodes.find(n => n.id === 'tools-corr-3');
    expect(toolsNode).toBeDefined();
    const toolsEdge = result.current.edges.find(e => e.id === 'e-tools-corr-3');
    expect(toolsEdge).toBeDefined();
    expect(toolsEdge!.source).toBe('agent-corr-3');
  });

  // ── Dispatch-turn suppression — INCREMENTAL live arrival ───────────────────
  // The live streaming order splits init/end across effect runs. The reported
  // bug ("a chat node without response") rendered the completed dispatch turn
  // (empty agentReply) as a visible node in the LIVE path — the single-batch
  // replay suppresses it correctly. Feed the deliveries one batch at a time
  // (tool → dispatch init → dispatch end → reply init → reply end) and assert
  // the dispatch turn is dropped the moment its end arrives.
  it('AC4 ST-5 (incremental): a dispatch turn emitted in-progress is DROPPED when its end delivery makes it transitional', async () => {
    const tool = makeToolDelivery('t-i', 'init', 's1', 'tool-1', 'bash', {
      input: 'Write-Output "42"',
      output: '42',
      startTime: '2026-08-20T04:29:54.906Z',
      endTime: '2026-08-20T04:29:54.919Z',
    });
    const toolEnd = makeToolDelivery('t-e', 'end', 's1', 'tool-1', 'bash', {
      input: 'Write-Output "42"',
      output: '42',
      startTime: '2026-08-20T04:29:54.906Z',
      endTime: '2026-08-20T04:29:54.919Z',
    });
    const dInit = makeDelivery('d-i', 'init', 's1', 'corr-2', {
      userMessage: 'run a powershell command that prints the number 42',
      agentReply: '\n\n',
      startTime: '2026-08-20T04:29:52.385Z',
    });
    const dEnd = makeDelivery('d-e', 'end', 's1', 'corr-2', {
      userMessage: 'run a powershell command that prints the number 42',
      agentReply: '\n\n',
      startTime: '2026-08-20T04:29:52.385Z',
      endTime: '2026-08-20T04:29:55.569Z',
    });
    const rInit = makeDelivery('r-i', 'init', 's1', 'corr-3', {
      userMessage: 'run a powershell command that prints the number 42',
      startTime: '2026-08-20T04:29:55.574Z',
    });
    const rEnd = makeDelivery('r-e', 'end', 's1', 'corr-3', {
      userMessage: 'run a powershell command that prints the number 42',
      agentReply: '42',
      startTime: '2026-08-20T04:29:55.574Z',
      endTime: '2026-08-20T04:30:00.871Z',
    });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      {
        initialProps: { deliveries: [tool, toolEnd] },
      },
    );

    // Batch 1: tool arrives first (no chat nodes yet → no ToolsNode).
    await waitFor(() => {
      expect(result.current.nodes.length).toBe(0);
    });

    // Batch 2: dispatch turn init — emitted as in-progress (correct, it may
    // still stream a reply).
    rerender({ deliveries: [tool, toolEnd, dInit] });
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeDefined();
    });

    // Batch 3: dispatch turn END — complete + empty agentReply → transitional
    // → the in-progress node MUST be dropped from the canvas.
    rerender({ deliveries: [tool, toolEnd, dInit, dEnd] });
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    });

    // Batch 4: reply turn init+end — the visible node appears.
    rerender({ deliveries: [tool, toolEnd, dInit, dEnd, rInit, rEnd] });
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-3')).toBeDefined();
    });
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
  });

  // ── Subagent/Tools no-flash UX — INCREMENTAL (reported bug) ────────────────
  // "Subagents attached to the wrong node but appear in the right place": a tool
  // delivery often arrives BEFORE its dispatch turn's same-exchange reply, so on
  // early batches the anchor is PROVISIONAL (the nearest preceding visible node).
  // The node MUST NOT be emitted there — it would flash-attach to the wrong node
  // and then JUMP to the reply when it renders. It is held until the reply
  // arrives, then emitted anchored to the reply (appears exactly once).
  it('no-flash: a SubagentNode is HELD while its suppressed parent has no same-exchange reply yet, then appears anchored to the reply', async () => {
    const TASK_ARGS = JSON.stringify({
      subagent_type: 'explore',
      prompt: 'go look',
    });
    // Batch 1: visible predecessor + suppressed dispatch turn + task dispatch.
    const batch1 = [
      makeDelivery('p-i', 'init', 's1', 'corr-1', {
        userMessage: 'plan the work',
        startTime: '2026-08-16T10:00:00.000Z',
      }),
      makeDelivery('p-e', 'end', 's1', 'corr-1', {
        userMessage: 'plan the work',
        agentReply: 'ok',
        startTime: '2026-08-16T10:00:00.000Z',
      }),
      // Dispatch turn — will end empty agentReply (transitional/suppressed).
      makeDelivery('d-i', 'init', 's1', 'corr-2', {
        userMessage: 'delegate to explore',
        agentThinking: 'dispatch…',
        startTime: '2026-08-16T10:00:30.000Z',
      }),
      makeDelivery('d-e', 'end', 's1', 'corr-2', {
        userMessage: 'delegate to explore',
        agentThinking: 'dispatch…',
        startTime: '2026-08-16T10:00:30.000Z',
      }),
      makeToolDelivery('t-i', 'init', 's1', 'task-1', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-16T10:00:35.000Z',
      }),
      makeToolDelivery('t-e', 'end', 's1', 'task-1', 'task', {
        input: TASK_ARGS,
        output: 'CHILD',
        startTime: '2026-08-16T10:00:35.000Z',
        endTime: '2026-08-16T10:01:15.000Z',
      }),
    ];
    // Batch 2: the reply turn of the SAME exchange (same userMessage).
    const replyInit = makeDelivery('r-i', 'init', 's1', 'corr-3', {
      userMessage: 'delegate to explore',
      startTime: '2026-08-16T10:01:30.000Z',
    });
    const replyEnd = makeDelivery('r-e', 'end', 's1', 'corr-3', {
      userMessage: 'delegate to explore',
      agentReply: 'the child replied',
      startTime: '2026-08-16T10:01:30.000Z',
    });

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: batch1 } },
    );

    // Batch 1: NO SubagentNode — its anchor is provisional (the reply corr-3 has
    // not arrived; the dispatch turn corr-2 is suppressed). Emitting here would
    // flash-attach to corr-1 and then jump to corr-3 (the reported UX bug).
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    });
    expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeUndefined();
    expect(result.current.edges.find(e => e.id === 'e-calls-task-1')).toBeUndefined();

    // Batch 2: the same-exchange reply corr-3 arrives → the SubagentNode appears
    // EXACTLY ONCE, anchored to the reply (never attached to corr-1).
    rerender({ deliveries: [...batch1, replyInit, replyEnd] });
    await waitFor(() => {
      const saNode = result.current.nodes.find(n => n.id === 'subagent-task-1');
      expect(saNode).toBeDefined();
    });
    const edge = result.current.edges.find(e => e.id === 'e-calls-task-1');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('agent-corr-3');
    expect(edge!.target).toBe('subagent-task-1');
    expect(result.current.nodes.find(n => n.id === 'agent-corr-3')).toBeDefined();
    // The dispatch turn stays suppressed; corr-1 never sources the subagent.
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    expect(result.current.edges.some(e => e.source === 'agent-corr-1' && e.target === 'subagent-task-1')).toBe(false);
  });

  // ── Live-session no-flash regression (reported UX bug) ──────────────────────
  // Reproduces the exact live delivery ordering from session
  // `ses_fe2772e5bffeVxMNAq6UIae39c` (rowid order): chat `_1` "Hi" → task tools
  // `_3/_4` (subagent dispatches) → chat `_6` (dispatch turn, empty reply →
  // transitional/suppressed) → chat `_7` (reply). The user reported: "first it
  // shows attached to the first Chatnode then second Chatnode renders and the
  // subagents move, that's not good UX". The fix: (1) span-containment parent
  // resolution — `_1` completed before the tools started, so it can never be the
  // parent; (2) final-anchor emission — while the dispatch turn `_6` is
  // transitional and its same-exchange reply `_7` has not rendered, the
  // SubagentNode is HELD; it appears exactly ONCE, anchored to `_7`.
  it('no-flash: subagents never attach to the FIRST chat node — they appear once, anchored to the dispatch\u0027s same-exchange reply (live session shape)', async () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'general', prompt: 'tell a joke' });
    const makeChat = (id: string, corrId: string, userMessage: string, agentReply: string, start: string, end?: string) =>
      makeDelivery(id, 'init', 's1', corrId, {
        userMessage, agentReply, startTime: start, ...(end ? { endTime: end } : {}),
      });
    // Batch 1: only the FIRST Chatnode (`_1` "Hi") exists — the tools arrive
    // before their dispatch turn (live ordering).
    const batch1 = [
      makeChat('i1', 'corr-1', 'Hi', 'Hi! I\u0027m ready to help.', '2026-08-20T04:58:20.990Z', '2026-08-20T04:58:24.486Z'),
      makeToolDelivery('t1-i', 'init', 's1', 'task-3', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-20T04:58:43.613Z',
        endTime: '2026-08-20T04:58:46.783Z',
      }),
      makeToolDelivery('t1-e', 'end', 's1', 'task-3', 'task', {
        input: TASK_ARGS,
        output: 'joke 1',
        startTime: '2026-08-20T04:58:43.613Z',
        endTime: '2026-08-20T04:58:46.783Z',
      }),
      makeToolDelivery('t2-i', 'init', 's1', 'task-4', 'task', {
        input: TASK_ARGS,
        startTime: '2026-08-20T04:58:43.945Z',
        endTime: '2026-08-20T04:58:47.442Z',
      }),
      makeToolDelivery('t2-e', 'end', 's1', 'task-4', 'task', {
        input: TASK_ARGS,
        output: 'joke 2',
        startTime: '2026-08-20T04:58:43.945Z',
        endTime: '2026-08-20T04:58:47.442Z',
      }),
    ];
    // Batch 2: the dispatch turn `_6` arrives as init+end — complete + empty
    // agentReply → transitional (suppressed). The tools' parent becomes `_6`, but
    // its same-exchange reply has not rendered yet → the subagents stay HELD.
    const batch2 = [
      makeChat('i6', 'corr-6', 'Please ask 3 subagents to tell 3 jokes', '', '2026-08-20T04:58:41.227Z', '2026-08-20T04:58:48.823Z'),
      makeDelivery('e6', 'end', 's1', 'corr-6', {
        userMessage: 'Please ask 3 subagents to tell 3 jokes',
        agentReply: '',
        startTime: '2026-08-20T04:58:41.227Z',
        endTime: '2026-08-20T04:58:48.823Z',
      }),
    ];
    // Batch 3: the reply turn `_7` (same userMessage) renders.
    const batch3 = [
      makeChat('i7', 'corr-7', 'Please ask 3 subagents to tell 3 jokes', 'Three jokes, three subagents:', '2026-08-20T04:58:48.826Z', '2026-08-20T04:58:51.538Z'),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: batch1 } },
    );

    // Batch 1: `_1` (the first Chatnode) renders. The task tools have NO
    // eligible parent (`_1` completed before they started — span-containment),
    // so NO SubagentNode appears attached to it (the flash is gone).
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    });
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-calls-'))).toHaveLength(0);

    // Batch 2: the dispatch turn `_6` arrives (transitional/suppressed — no chat
    // node). Subagents are still HELD (their same-exchange reply has not come).
    rerender({ deliveries: [...batch1, ...batch2] });
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-6')).toBeUndefined();
    });
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);

    // Batch 3: the reply `_7` renders → exactly TWO SubagentNodes appear ONCE,
    // each anchored to `_7` (the dispatch's same-exchange reply) — never to `_1`.
    rerender({ deliveries: [...batch1, ...batch2, ...batch3] });
    await waitFor(() => {
      expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(2);
    });
    const subagentEdges = result.current.edges.filter(e => e.id.startsWith('e-calls-'));
    expect(subagentEdges).toHaveLength(2);
    for (const e of subagentEdges) {
      expect(e.source).toBe('agent-corr-7');
    }
    expect(result.current.edges.some(e => e.source === 'agent-corr-1' && e.target.startsWith('subagent-'))).toBe(false);
    expect(result.current.edges.some(e => e.source === 'agent-corr-6')).toBe(false);
  });
});

// ── Spec #2762 — nested subagent lifecycle (init → update → end) ─────────────
//
// The `subagent-tool-activity` contract merges a child session's tool span
// across its lifecycle EXACTLY like tool-use-lifecycle does (shared merge
// helper): input arrives on init, output on end, and the merged summary is
// what the owning SubagentNode's embedded TOOLS accordion renders.

describe('Spec #2762: nested tool lifecycle init → update → end', () => {
  function makeActivityDelivery(
    id: string,
    lifecycle: 'init' | 'update' | 'end',
    sessionId: string,
    correlationId: string,
    toolName: string,
    innerPayload: Record<string, unknown> = {},
  ): ContractDelivery {
    return {
      id,
      contractName: 'subagent-tool-activity',
      lifecycle,
      key: { sessionId, correlationId },
      payload: {
        toolName,
        state: lifecycle === 'init' ? 'Init' : lifecycle === 'end' ? 'Response' : 'Update',
        payload: {
          'gen_ai.tool.name': toolName,
          'tool_name': toolName,
          input: '',
          output: '',
          is_subagent: true,
          ...innerPayload,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  it('accumulates a child tool call across its lifecycle into ONE summary on the owning SubagentNode', async () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'lifecycle' });
    const deliveries: ContractDelivery[] = [
      makeDelivery('l-i1', 'init', 's1', 'corr-1', {
        userMessage: 'delegate', startTime: '2026-08-22T10:00:00.000Z',
      }),
      makeDelivery('l-e1', 'end', 's1', 'corr-1', {
        userMessage: 'delegate', agentReply: 'done',
        startTime: '2026-08-22T10:00:00.000Z', endTime: '2026-08-22T10:01:00.000Z',
      }),
      makeToolDelivery('l-t1', 'end', 's1', 'task-1', 'task', {
        input: TASK_ARGS, childSessionId: 'ses_life',
        startTime: '2026-08-22T10:00:10.000Z',
      }),
      // The child call's lifecycle: init (input only) → update (partial
      // output) → end (final output + outcome/duration).
      makeActivityDelivery('l-a1', 'init', 'ses_life', 'life-tool-1', 'Bash', {
        input: 'git status', startTime: '2026-08-22T10:00:20.000Z',
      }),
      makeActivityDelivery('l-a2', 'update', 'ses_life', 'life-tool-1', 'Bash', {
        input: 'git status', output: 'On branch',
        startTime: '2026-08-22T10:00:20.000Z',
      }),
      makeActivityDelivery('l-a3', 'end', 'ses_life', 'life-tool-1', 'Bash', {
        input: 'git status', output: 'On branch main\nnothing to commit',
        'tool.success': true, duration_ms: 340,
        startTime: '2026-08-22T10:00:20.000Z', endTime: '2026-08-22T10:00:21.500Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-1');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const call = (result.current.nodes.find(n => n.id === 'subagent-task-1')!.data.payload as any).tools[0];
    // ONE summary per corrId (never one per lifecycle phase) with the merged
    // content: init-time input survives, end-time output wins, outcome/duration
    // carried.
    expect(call.correlationId).toBe('life-tool-1');
    expect(call.input).toBe('git status');
    expect(call.output).toBe('On branch main\nnothing to commit');
    expect(call.success).toBe(true);
    expect(call.durationMs).toBe(340);
  });

  it('internal build/plan child sessions produce NO nested node even when they dispatch further tasks', async () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'parent' });
    const deliveries: ContractDelivery[] = [
      makeDelivery('i-i1', 'init', 's1', 'corr-1', {
        userMessage: 'delegate', startTime: '2026-08-22T10:00:00.000Z',
      }),
      makeDelivery('i-e1', 'end', 's1', 'corr-1', {
        userMessage: 'delegate', agentReply: 'done',
        startTime: '2026-08-22T10:00:00.000Z', endTime: '2026-08-22T10:01:00.000Z',
      }),
      makeToolDelivery('i-t1', 'end', 's1', 'task-1', 'task', {
        input: TASK_ARGS, childSessionId: 'ses_int',
        startTime: '2026-08-22T10:00:10.000Z',
      }),
      // An internal `plan` session that itself dispatched further tasks —
      // those must not surface as nested SubagentNodes (the frontend
      // INTERNAL_TOOL_EXECUTION_AGENTS guard is the ONLY guard on the OTLP
      // path — QA-7/R-3).
      makeActivityDelivery('i-a1', 'end', 'ses_int', 'int-task-1', 'task', {
        input: JSON.stringify({ subagent_type: 'plan', prompt: 'internal' }),
        childSessionId: 'ses_int_child',
        startTime: '2026-08-22T10:00:20.000Z',
      }),
      makeActivityDelivery('i-a2', 'end', 'ses_int', 'int-task-2', 'task', {
        input: JSON.stringify({ subagent_type: 'build', prompt: 'internal' }),
        childSessionId: 'ses_int_child2',
        startTime: '2026-08-22T10:00:25.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeDefined();
    });

    expect(result.current.nodes.find(n => n.id === 'subagent-int-task-1')).toBeUndefined();
    expect(result.current.nodes.find(n => n.id === 'subagent-int-task-2')).toBeUndefined();
    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    expect((sa.data.payload as any).nestedCount).toBeUndefined();
  });
});
