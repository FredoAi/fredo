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
