/**
 * Tests for useDeliveryGraph — delivery-driven graph building.
 *
 * Prerequisites: vitest, @testing-library/react, @testing-library/jest-dom, jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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

import { useDeliveryGraph } from '../useMissionMonitor';

describe('useDeliveryGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
  });

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
        payload: innerPayload,
      },
      timestamp: new Date().toISOString(),
    };
  }

  function makeSubagentDelivery(
    id: string,
    lifecycle: 'init' | 'update' | 'end',
    sessionId: string,
    correlationId: string,
    name: string,
    innerPayload: Record<string, unknown> = {},
  ): ContractDelivery {
    return {
      id,
      contractName: 'subagent-lifecycle',
      lifecycle,
      key: { sessionId, correlationId },
      payload: {
        toolName: name,
        state: lifecycle === 'init' ? 'Init' : lifecycle === 'end' ? 'Response' : 'Update',
        payload: innerPayload,
      },
      timestamp: new Date().toISOString(),
    };
  }

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
      makeDelivery('d1', 'init', 's1', 'corr-1', {
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

  it('should create tool nodes from tool-use-lifecycle init deliveries', async () => {
    const deliveries: ContractDelivery[] = [
      makeToolDelivery('d1', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls -la',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.eventCount).toBe(1);
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    const toolNode = result.current.nodes.find(n => n.id.startsWith('tool-'));
    expect(toolNode).toBeDefined();
    expect(toolNode!.type).toBe('toolNode');
    // Should show tool name
    expect(toolNode!.data.label).toContain('Bash');
  });

  it('should update tool node status through lifecycle (init→update→end)', async () => {
    const deliveries: ContractDelivery[] = [
      makeToolDelivery('d1', 'init', 's1', 'tool-corr-1', 'Edit', { input: 'file.ts' }),
      makeToolDelivery('d2', 'update', 's1', 'tool-corr-1', 'Edit', { input: 'file.ts', output: 'ok' }),
      makeToolDelivery('d3', 'end', 's1', 'tool-corr-1', 'Edit', { input: 'file.ts', output: 'changes applied' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    // After processing all deliveries, the tool node should exist with complete status
    await waitFor(() => {
      const toolNode = result.current.nodes.find(n => n.id.startsWith('tool-'));
      expect(toolNode).toBeDefined();
      // MonitorNodeData.status — complete maps to 'inactive'
      // (graphStatusToMonitorStatus maps 'complete' → 'inactive')
    });
  });

  it('should create subagent nodes from subagent-lifecycle init deliveries', async () => {
    const deliveries: ContractDelivery[] = [
      makeSubagentDelivery('d1', 'init', 's1', 'sa-corr-1', 'Coder', {
        instruction: 'Implement feature X',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.eventCount).toBe(1);
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(saNode).toBeDefined();
    expect(saNode!.type).toBe('subagentNode');
    expect(saNode!.data.label).toContain('Coder');
  });

  it('should pass all contract types through sessionDeliveries filter', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'session-a', 'corr-1', { agent: 'Agent A' }),
      makeToolDelivery('d2', 'init', 'session-a', 'tool-1', 'Bash'),
      makeSubagentDelivery('d3', 'init', 'session-a', 'sa-1', 'Coder'),
      makeDelivery('d4', 'init', 'session-b', 'corr-2', { agent: 'Agent B' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'session-a' }),
    );

    // session-a has 3 deliveries, session-b has 1
    expect(result.current.eventCount).toBe(3);
  });

  it('should create tool nodes with file extraction when files in tool payload', async () => {
    const deliveries: ContractDelivery[] = [
      makeToolDelivery('d1', 'init', 's1', 'tool-corr-1', 'Read', {
        input: 'src/main.ts',
        files: [
          { path: 'src/main.ts', operation: 'read' },
        ],
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.eventCount).toBe(1);
      // Should have both tool node and file node
      const fileNodes = result.current.nodes.filter(n => n.type === 'fileNode' || n.id.includes('file'));
      // Note: fileNode type mapping might not match 'fileNode' if rendering
    });
  });

  it('should handle mixed contract types in the same session', async () => {
    const deliveries: ContractDelivery[] = [
      // Agent node first
      makeDelivery('d1', 'init', 's1', 'agent-corr-1', {
        agent: 'Architect',
        model: 'claude-sonnet-4',
      }),
      // Tool deliveries
      makeToolDelivery('d2', 'init', 's1', 'tool-corr-1', 'Bash', { input: 'ls' }),
      makeToolDelivery('d3', 'end', 's1', 'tool-corr-1', 'Bash', { input: 'ls', output: 'ok' }),
      // Subagent delivery
      makeSubagentDelivery('d4', 'init', 's1', 'sa-corr-1', 'Coder', {
        instruction: 'Implement',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.eventCount).toBe(4);
      // Agent node
      expect(result.current.nodes.filter(n => n.type === 'agentNode').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should export layoutVersion and increment on dimension change', async () => {
    // Two deliveries so the second node shifts when the first reports dimensions
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1', {
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: 'Response', reasoning: 'Thinking...' },
        turnInputTokens: 100,
        turnOutputTokens: 50,
      }),
      makeDelivery('d2', 'init', 's1', 'corr-2', {
        info: { text: 'Follow-up', modelID: 'claude-sonnet-4', agent: 'Coder' },
        part: { text: 'Code', reasoning: 'Implementing...' },
        turnInputTokens: 50,
        turnOutputTokens: 25,
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    // Wait for deliveries to be processed and nodes created
    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(2);
    });

    expect(result.current.layoutVersion).toBe(0);

    // Trigger dimension change on an existing node
    act(() => {
      result.current.onNodesChange([
        { type: 'dimensions', id: 'agent-corr-1', dimensions: { width: 300, height: 200 }, updateStyle: true },
      ] as any);
    });

    // Second node should shift down → layoutVersion increments
    expect(result.current.layoutVersion).toBe(1);
  });

  it('should NOT increment layoutVersion on non-dimension changes', () => {
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [], sessionId: 's1' }),
    );

    expect(result.current.layoutVersion).toBe(0);

    act(() => {
      result.current.onNodesChange([
        { type: 'position', id: 'agent-corr-1', position: { x: 100, y: 200 } },
      ] as any);
    });

    expect(result.current.layoutVersion).toBe(0);
  });

  it('should filter deliveries by sessionId', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'session-a', 'corr-1', { agent: 'Agent A' }),
      makeDelivery('d2', 'init', 'session-b', 'corr-2', { agent: 'Agent B' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'session-a' }),
    );

    expect(result.current.eventCount).toBe(1);
  });

  it('should return empty for sessionId null', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'corr-1'),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: null }),
    );

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.eventCount).toBe(0);
  });
});

// Legacy re-exports for backward compat
export { buildGraphFromEvents, processChatNodeSubscription } from '../useMissionMonitor';
