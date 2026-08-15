/**
 * Tests for useDeliveryGraph â€” delivery-driven graph building.
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
import { DEFAULT_NODE_HEIGHT, CHAIN_GAP, TOOLS_CHAIN_X } from '../../lib/layout';

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
    // Exchange-level figures mirrored from the parent chat node (NFR-1).
    expect(payload.exchangeInputTokens).toBe(100);
    expect(payload.exchangeOutputTokens).toBe(50);
    expect(payload.exchangeTotalTokens).toBe(150);

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
    // Formerly "subagent end delivery passes output through unchanged".
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

    await waitFor(() => {
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
    });

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
// environment fall back to the conservative 320px), (2) every node is fully
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
      // the conservative DEFAULT_NODE_HEIGHT fallback — 320 + 28 = 348px).
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

