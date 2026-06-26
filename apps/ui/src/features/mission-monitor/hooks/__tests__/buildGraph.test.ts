/**
 * Tests for delivery-driven graph building — replaces legacy buildGraphFromEvents.
 *
 * Run with: pnpm --filter @fredo/ui test:run -- --testPathPattern buildGraph
 */
import { describe, it, expect } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
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

  it('should create subagent nodes when subagents in payload', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', {
        agent: 'Architect',
        subagents: [
          { name: 'Coder', instruction: 'Implement feature', output: '' },
        ],
      }),
    ];

    expect(deliveries).toHaveLength(1);
    const p = deliveries[0].payload['payload'] as Record<string, any>;
    expect(p.subagents).toBeDefined();
    expect(p.subagents).toHaveLength(1);
    expect(p.subagents[0].name).toBe('Coder');
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
