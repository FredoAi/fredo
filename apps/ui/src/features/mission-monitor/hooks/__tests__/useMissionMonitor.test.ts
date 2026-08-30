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

import { useDeliveryGraph } from '../useMissionMonitor';
import {
  DEFAULT_NODE_HEIGHT,
  CHAIN_GAP,
  SUBAGENT_CHAIN_X,
  SUBAGENT_GAP,
  SUBAGENT_NODE_HEIGHT,
  SUBAGENT_NODE_MAX_WIDTH,
  LEVEL_INDENT_Y,
  computeChatChainPositions,
  computeSubagentChainPositions,
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

  it('#2764 ST-1: a chat exchange with tool calls embeds them into the chat node payload — no standalone tools node or edge', async () => {
    // #2764 ST-1: the standalone ToolsNode + `e-tools-*` edge were removed —
    // the resolved non-task tool call EMBEDS into the anchor chat node's
    // payload.tools (the #2762 SubagentNodePayload.tools pattern).
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
      expect(result.current.nodes.find(n => n.id === 'agent-chat-corr-1')).toBeDefined();
    });

    // AC1: ZERO standalone tools nodes / e-tools-* edges anywhere.
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-tools-'))).toHaveLength(0);

    // The chat node's payload carries the embedded call.
    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].toolName).toBe('Bash');
    expect(payload.tools[0].input).toBe('ls -la');
    expect(payload.tools[0].output).toBe('total 48');
    expect(payload.tools[0].correlationId).toBe('tool-corr-1');
    expect(payload.sessionId).toBe('s1');
  });

  it('#2764 ST-1: a tool call accumulates through init→update→end into one ToolCallSummary (no legacy tool node, no standalone tools node)', async () => {
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const calls = (result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any).tools as any[];
    expect(calls).toHaveLength(1);
    // init→update→end merged into ONE summary — the completed output survives.
    expect(calls[0].toolName).toBe('Edit');
    expect(calls[0].input).toBe('file.ts');
    expect(calls[0].output).toBe('changes applied');
    expect(calls[0].endTime).toBe('2026-08-14T04:36:10.000Z');
    // No legacy tool node is created, and no standalone tools node either.
    expect(result.current.nodes.find(n => n.id === 'tool-tool-corr-1')).toBeUndefined();
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
  });

  it('#2764 ST-1: association is order-independent — tool deliveries before their chat node embed into the same chat node payload', async () => {
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const calls = (result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any).tools as any[];
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('Read');
    expect(calls[0].output).toBe('file content');
  });

  it('#2764 ST-1 / FR-3: a no-tool exchange embeds NO tools key; a lone tool delivery without a chat node produces no tools artifact', async () => {
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

    // FR-3: the no-tool chat node carries NO tools key at all (section hidden,
    // byte-identical rendering) and zero standalone tools artifacts exist.
    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(payload.tools).toBeUndefined();
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-tools-'))).toHaveLength(0);
  });

  it('#2764 ST-1: each tool call attaches to the chat node with the greatest startTime strictly before it — adjacent exchanges get their OWN embedded lists', async () => {
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
      expect(result.current.nodes.filter(n => n.id.startsWith('agent-'))).toHaveLength(2);
    });

    // Each chat node carries its OWN embedded call (no cross-attachment).
    const payload1 = result.current.nodes.find(n => n.id === 'agent-chat-1')!.data.payload as any;
    const payload2 = result.current.nodes.find(n => n.id === 'agent-chat-2')!.data.payload as any;
    expect(payload1.tools).toHaveLength(1);
    expect(payload1.tools[0].toolName).toBe('Bash');
    expect(payload2.tools).toHaveLength(1);
    expect(payload2.tools[0].toolName).toBe('Read');

    // Zero standalone tools nodes / edges anywhere (AC1).
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-tools-'))).toHaveLength(0);
  });

  it('#2764 ST-1: the embedded tools key SURVIVES chat update and end lifecycle re-sets (payload-spread invariant)', async () => {
    // Chat update/end merges spread {...existing.payload, ...newPayload} where
    // makeAgentNodePayload never sets `tools` — the embedded key must survive
    // every lifecycle re-set (the plan's ST-1 regression invariant).
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'run the tests',
        startTime: '2026-08-14T04:49:00.000Z',
      }),
      // Tool call embeds on the in-progress node.
      makeToolDelivery('d2', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls -la',
        output: 'total 48',
        startTime: '2026-08-14T04:49:05.000Z',
        endTime: '2026-08-14T04:49:06.000Z',
      }),
      // UPDATE delivery — re-sets the entry (status active, agentReply chunk).
      makeDelivery('d3', 'update', 's1', 'chat-corr-1', {
        userMessage: 'run the tests',
        agentReply: 'ran the tests,',
        startTime: '2026-08-14T04:49:00.000Z',
      }),
      // END delivery — final re-set.
      makeDelivery('d4', 'end', 's1', 'chat-corr-1', {
        userMessage: 'run the tests',
        agentReply: 'ran the tests, all green',
        startTime: '2026-08-14T04:49:00.000Z',
        endTime: '2026-08-14T04:49:30.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      const node = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(node).toBeDefined();
      // Both lifecycle re-sets landed (the end delivery finalized the node).
      expect((node!.data.payload as any).endTime).toBe('2026-08-14T04:49:30.000Z');
    });

    // After BOTH lifecycle re-sets, the embedded tools are still there.
    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].toolName).toBe('Bash');
    expect(payload.tools[0].output).toBe('total 48');
  });

  it('#2764 ST-1: the embedded tools payload reference is STABLE across association passes with unchanged content (no-loop pattern)', async () => {
    // Spec #275/#523 no-loop pattern: the anchor's payload object must only be
    // replaced when the embedded tools CONTENT changes. A second batch whose
    // deliveries do not touch the tool set must keep the same payload
    // reference (the incremental builder's Pass-2 deep compare keys on it).
    const batch1: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'chat-corr-1', {
        userMessage: 'run the tests',
        startTime: '2026-08-14T04:50:00.000Z',
      }),
      makeDelivery('d2', 'end', 's1', 'chat-corr-1', {
        userMessage: 'run the tests',
        agentReply: 'done',
        startTime: '2026-08-14T04:50:00.000Z',
        endTime: '2026-08-14T04:50:30.000Z',
      }),
      makeToolDelivery('d3', 'init', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls -la',
        startTime: '2026-08-14T04:50:05.000Z',
      }),
      makeToolDelivery('d4', 'end', 's1', 'tool-corr-1', 'Bash', {
        input: 'ls -la',
        output: 'total 48',
        startTime: '2026-08-14T04:50:05.000Z',
        endTime: '2026-08-14T04:50:06.000Z',
      }),
    ];
    // Batch 2 adds an UNRELATED delivery (another session's chat node) — the
    // association pass re-runs over the full collected maps, but s1's embedded
    // tools content is unchanged.
    const batch2: ContractDelivery[] = [
      ...batch1,
      makeDelivery('d5', 'init', 's2', 'other-chat-1', {
        userMessage: 'unrelated session traffic',
        startTime: '2026-08-14T04:51:00.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: batch1 } },
    );

    await waitFor(() => {
      const node = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(node).toBeDefined();
      expect(((node!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const payloadBefore = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload;

    rerender({ deliveries: batch2 });
    await waitFor(() => {
      // Settle the second batch (the unrelated s2 delivery is processed — it
      // does not count toward s1's eventCount).
      expect(result.current.eventCount).toBe(4);
    });

    const nodeAfter = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!;
    const payloadAfter = nodeAfter.data.payload;
    // SAME payload reference — the association did not churn the node
    // (a fresh object every pass would re-render the node every batch).
    expect(payloadAfter).toBe(payloadBefore);
    expect((payloadAfter as any).tools).toHaveLength(1);
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(payload.tools[0].toolName).toBe('read_file');
    expect(payload.tools[0].inputTokens).toBe(0);
    expect(payload.tools[0].reasoningTokens).toBe(0);
    expect(payload.tools[0].outputTokens).toBe(0);
    expect(payload.tools[0].totalTokens).toBe(0);
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    const call = payload.tools[0];
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    const call = payload.tools[0];
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const payload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    const call = payload.tools[0];
    expect(call.success).toBe(true);
    expect(call.error).toBeUndefined();
    expect(call.durationMs).toBe(800);
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

  it('#2745 ST-4 / #2764 ST-1: a tool delivery with a `files` payload still embeds its call — the legacy file-node path is gone (AC-5)', async () => {
    // The dead fileNodes builder path was removed (#2745 ST-4) — a `files`
    // field in the tool payload is inert (the embedded TOOLS accordion owns
    // the tool-call representation; no file node is ever created).
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    // The tool call lands in the chat node's embedded TOOLS section (its
    // payload owns the tool-call representation)…
    const toolsPayload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(toolsPayload.tools[0].toolName).toBe('Read');
    // …and NO file node is created anywhere (the dead path is gone).
    expect(result.current.nodes.filter(n => n.id.includes('file'))).toHaveLength(0);
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
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
// split out of the tool list and rendered as one rich SubagentNode per
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

    // R-1 / #2766 ST-2 (R6): edge-connected like the chat node's other
    // companions — parent source-right → subagent target-left (subagents sit
    // RIGHT of the chat chain).
    const edge = result.current.edges.find(e => e.id === 'e-calls-task-corr-1');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('agent-chat-corr-1');
    expect(edge!.target).toBe('subagent-task-corr-1');
    expect(edge!.sourceHandle).toBe('source-right');
    expect(edge!.targetHandle).toBe('target-left');
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

  it('R-4/AC-4: an internal-agent `task` dispatch (build/plan) creates NO SubagentNode AND no embedded tool item', async () => {
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

    // Zero subagent nodes AND zero embedded tools (the internal dispatch is
    // dropped from BOTH paths — no node, no tool item, no tools key).
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    const agentPayload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(agentPayload.tools).toBeUndefined();
    expect(result.current.edges.filter(e => e.id.startsWith('e-calls-'))).toHaveLength(0);
  });

  it('R-3/AC-3: the `task` call is split OUT of the embedded tools — other tools still appear', async () => {
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
      const agentNode = result.current.nodes.find(n => n.id === 'agent-chat-corr-1');
      expect(agentNode).toBeDefined();
      expect(((agentNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    // The chat node embeds ONLY the non-task call — the dispatch is never an item.
    const agentPayload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(agentPayload.tools).toHaveLength(1);
    expect(agentPayload.tools[0].toolName).toBe('Bash');
    expect(agentPayload.tools.find((c: any) => c.toolName === 'task')).toBeUndefined();

    // SubagentNode is the dispatch's SOLE representation (AC-3 — no double-render).
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
  });

  it('A-4: a task-only exchange renders the SubagentNode and NO empty TOOLS artifact', async () => {
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

    // One SubagentNode; the chat node embeds NO tools (no "── TOOLS (0) ──"
    // placeholder — A-4) and zero standalone tools artifacts exist.
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
    const agentPayload = result.current.nodes.find(n => n.id === 'agent-chat-corr-1')!.data.payload as any;
    expect(agentPayload.tools).toBeUndefined();
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
    // Chain-owned slot: RIGHT of the chat chain (#2766 ST-2 mirror); the first
    // dispatch (index 0) aligns with the parent chat node's y. The exact slot
    // value proves the node was NOT moved by the d3-force/residue passes
    // (excluded from overlap mutation — A-5).
    expect(saNode.position.x).toBe(SUBAGENT_CHAIN_X);
    expect(saNode.position.y).toBe(agentNode.position.y);
  });

  it('A-5: two sequential dispatches of one parent stack RIGHT (x = SUBAGENT_CHAIN_X + index × (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP)), both aligned with the parent', async () => {
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
    // Dispatch-ordered horizontal stacking RIGHT of the parent (#2766 ST-2
    // mirror of A-5): both align with the parent's y; the second dispatch sits
    // one column further right.
    expect(sa1.position.x).toBe(SUBAGENT_CHAIN_X);
    expect(sa1.position.y).toBe(agentNode.position.y);
    expect(sa2.position.x).toBe(SUBAGENT_CHAIN_X + (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP));
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
// SubagentNode edges + companion-column layout to the nearest
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
    expect(edge!.sourceHandle).toBe('source-right');
    expect(edge!.targetHandle).toBe('target-left');
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

  it('#2764 ST-1: tool calls of a suppressed transitional turn embed into the SAME-EXCHANGE reply turn\u0027s chat node', async () => {
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
      const anchorNode = result.current.nodes.find(n => n.id === 'agent-corr-3');
      expect(anchorNode).toBeDefined();
      expect(((anchorNode!.data.payload as any).tools ?? []).length).toBe(1);
    });

    // The transitional parent renders NO chat node; the tool call EMBEDS under
    // the same-exchange reply's chat node (final-anchor gate — never the
    // preceding unrelated corr-1).
    expect(result.current.nodes.find(n => n.id === 'agent-corr-2')).toBeUndefined();
    const anchorPayload = result.current.nodes.find(n => n.id === 'agent-corr-3')!.data.payload as any;
    expect(anchorPayload.tools).toHaveLength(1);
    expect(anchorPayload.tools[0].toolName).toBe('Bash');
    expect(anchorPayload.tools[0].output).toBe('total 48');
    const suppressedPayload = (result.current.nodes.find(n => n.id === 'agent-corr-1')!.data.payload as any);
    expect(suppressedPayload.tools).toBeUndefined();

    // Zero standalone tools nodes / edges anywhere (AC1).
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.edges.filter(e => e.id.startsWith('e-tools-'))).toHaveLength(0);
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
    // Mirrors the SubagentNode source guards (readFileSync from
    // cwd = apps/ui). The #2754 ST-3 EDGE_STYLES migration (#6366f1/#a855f7/
    // #334155 → var(--accent-primary)/var(--accent-subagent)/var(--border-color))
    // must not regress. (#2764 ST-1: the `tools` edge — the only consumer of
    // var(--accent-secondary) in this file — was removed with the standalone
    // ToolsNode, so that token no longer appears here.)
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
    expect(source).toContain('var(--border-color)');
  });
});

// ── Spec #2762 — nested subagent activity (R-1…R-10) ─────────────────────────
//
// The `subagent-tool-activity` contract delivers CHILD-session tool_use spans
// keyed by the child session's OWN sessionId (no compositing). The builder's
// nested association joins them to the owning SubagentNode via its
// payload.childSessionId — recursively, at any depth — while the R-2 guard
// drops primary-session spans that also arrive under the new contract.

/** subagent-tool-activity delivery helper — mirrors makeToolDelivery with the
 *  nested contract's name. `innerPayload.is_subagent` defaults to true (the
 *  R-2 guard's accept path); pass `is_subagent: false` explicitly for the
 *  primary-session double-delivery guard tests.
 *  #2768 round 3: `outerPayload` merges into the OUTER delivery payload's top
 *  level — that is where the ECE injects `compositedChildSessionId` on
 *  composited (parent-keyed) deliveries. Pass `sessionId: '<parent>'` +
 *  `outerPayload: { compositedChildSessionId: '<child>' }` to mirror the
 *  engine's re-keyed row shape. */
function makeSubagentActivityDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  toolName: string,
  innerPayload: Record<string, unknown> = {},
  outerPayload: Record<string, unknown> = {},
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
      ...outerPayload,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Base nested fixture: one visible root exchange (corr-1) whose task dispatch
 *  (task-1, childSessionId ses_child_1) delegates a subagent. Child/grandchild
 *  activity is returned separately so tests control arrival order. */
function makeNestedBase(): { root: ContractDelivery[]; childA: (o?: Record<string, unknown>) => ContractDelivery[] } {
  const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'level 1' });
  const root: ContractDelivery[] = [
    makeDelivery('n-i1', 'init', 's1', 'corr-1', {
      userMessage: 'delegate work', startTime: '2026-08-21T10:00:00.000Z',
    }),
    makeDelivery('n-e1', 'end', 's1', 'corr-1', {
      userMessage: 'delegate work', agentReply: 'done',
      startTime: '2026-08-21T10:00:00.000Z', endTime: '2026-08-21T10:01:00.000Z',
    }),
    makeToolDelivery('n-t1', 'init', 's1', 'task-1', 'task', {
      input: TASK_ARGS, startTime: '2026-08-21T10:00:10.000Z',
    }),
    makeToolDelivery('n-t2', 'end', 's1', 'task-1', 'task', {
      input: TASK_ARGS, output: 'level-1 done', childSessionId: 'ses_child_1',
      startTime: '2026-08-21T10:00:10.000Z', endTime: '2026-08-21T10:00:50.000Z',
    }),
  ];
  // The child session's own activity: two non-task tools (one FAILED — R-10)
  // and one nested `task` dispatch (subagent_type general — user-requested).
  // Every child payload carries `parentSessionId: 's1'` (#2762 D4a): the
  // adapter propagates the child's parent session id onto EVERY child payload
  // (mirrors the real plugin's `session.parent_id` — the R-8 orphan fixtures
  // must carry it for the scoped orphan count, D4b).
  const childA = (): ContractDelivery[] => [
    makeSubagentActivityDelivery('c-a1', 'init', 'ses_child_1', 'sub-tool-1', 'Bash', {
      input: 'ls', parentSessionId: 's1', startTime: '2026-08-21T10:00:20.000Z',
    }),
    makeSubagentActivityDelivery('c-a2', 'end', 'ses_child_1', 'sub-tool-1', 'Bash', {
      input: 'ls', output: 'files',
      'tool.success': false, 'tool.error': 'permission denied', duration_ms: 120,
      parentSessionId: 's1',
      startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
    }),
    makeSubagentActivityDelivery('c-a3', 'init', 'ses_child_1', 'sub-task-1', 'task', {
      input: JSON.stringify({ subagent_type: 'general', prompt: 'level 2' }),
      parentSessionId: 's1', startTime: '2026-08-21T10:00:30.000Z',
    }),
    makeSubagentActivityDelivery('c-a4', 'end', 'ses_child_1', 'sub-task-1', 'task', {
      input: JSON.stringify({ subagent_type: 'general', prompt: 'level 2' }),
      output: 'level-2 done', childSessionId: 'ses_child_2',
      parentSessionId: 's1',
      startTime: '2026-08-21T10:00:30.000Z', endTime: '2026-08-21T10:00:45.000Z',
    }),
  ];
  return { root, childA };
}

describe('Spec #2762 — nested subagent activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
  });

  it('R-1/D-1b: a child session\u0027s tool calls aggregate onto the owning SubagentNode payload.tools — never onto a root chat node', async () => {
    const { root, childA } = makeNestedBase();
    const deliveries = [...root, ...childA()];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-1');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    const payload = sa.data.payload as any;
    // The child's own (non-task) calls ride the node payload — the embedded
    // TOOLS accordion input. The `task` dispatch of the child is NOT a tool
    // item (it becomes the nested SubagentNode instead).
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].toolName).toBe('Bash');
    expect(payload.tools[0].output).toBe('files');
    expect(payload.nestedCount).toBe(1);
    // R-1: never attached to a root chat node — the root exchange
    // made no non-task calls, so NO root chat node embeds tools at all.
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
  });

  it('R-2: a primary-session span delivered under subagent-tool-activity (is_subagent absent) is ignored — root rendering is unchanged', async () => {
    const { root } = makeNestedBase();
    // A ROOT-session (s1) tool span arriving under the NEW contract without
    // the is_subagent marker — exactly what the engine delivers for the
    // selected session (it cannot express "only subagent").
    const rootSpan = makeSubagentActivityDelivery('r-a1', 'end', 's1', 'root-tool-1', 'Bash', {
      input: 'ls', output: 'root files',
      is_subagent: false,
      startTime: '2026-08-21T10:00:20.000Z',
    });

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [...root, rootSpan], sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeDefined();
    });

    // The guard dropped the primary-session span: the SubagentNode has no
    // tools (its child session sent nothing), and no node/edge was derived
    // from the ignored delivery.
    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    expect((sa.data.payload as any).tools).toBeUndefined();
    expect(result.current.nodes.filter(n => n.id.startsWith('tools-'))).toHaveLength(0);
    expect(result.current.unattributedCount).toBe(0);
  });

  it('R-3: the child\u0027s own task dispatch creates ONE nested SubagentNode whose edge sources from the dispatching SubagentNode', async () => {
    const { root, childA } = makeNestedBase();
    const deliveries = [...root, ...childA()];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-sub-task-1')).toBeDefined();
    });

    const nested = result.current.nodes.find(n => n.id === 'subagent-sub-task-1')!;
    const payload = nested.data.payload as any;
    // Parent = the dispatching SubagentNode's corrId; session stays the ROOT
    // session (visibility is root-scoped).
    expect(payload.parentCorrelationId).toBe('task-1');
    expect(payload.sessionId).toBe('s1');
    expect(payload.childSessionId).toBe('ses_child_2');
    expect(payload.name).toBe('general');

    // Nested edge family: parent SubagentNode (source-right) → child
    // (target-left), reusing the `calls` style.
    const edge = result.current.edges.find(e => e.id === 'e-calls-sub-task-1');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('subagent-task-1');
    expect(edge!.target).toBe('subagent-sub-task-1');
    expect(edge!.sourceHandle).toBe('source-right');
    expect(edge!.targetHandle).toBe('target-left');

    // Depth stamping (D-1c): with max depth 2 the whole session's subagents
    // carry depth fields; a depth-1-only session carries none (see R-7 test).
    expect((result.current.nodes.find(n => n.id === 'subagent-task-1')!.data.payload as any).depth).toBe(1);
    expect(payload.depth).toBe(2);
    expect(payload.sessionMaxDepth).toBe(2);

    // The nested node slots one column RIGHT of its parent (#2766 ST-2
    // mirror) and LEVEL_INDENT_Y DOWN from it (D-1a + D-1c-3 Option B —
    // ST-4's subtree-band geometry).
    const parent = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    expect(nested.position.x).toBe(parent.position.x + (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP));
    expect(nested.position.y).toBe(parent.position.y + LEVEL_INDENT_Y);
  });

  it('R-3 (internal agents): the child\u0027s build/plan dispatches create NO nested SubagentNode and no nested-count entry', async () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'level 1' });
    const deliveries: ContractDelivery[] = [
      ...makeNestedBase().root,
      // The child session dispatched ONLY an internal tool-execution agent.
      makeSubagentActivityDelivery('b-a1', 'init', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeSubagentActivityDelivery('b-a2', 'end', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', output: 'files', startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeSubagentActivityDelivery('b-a3', 'end', 'ses_child_1', 'sub-task-9', 'task', {
        input: JSON.stringify({ subagent_type: 'build', prompt: 'internal' }),
        childSessionId: 'ses_build', startTime: '2026-08-21T10:00:30.000Z',
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

    expect(result.current.nodes.find(n => n.id === 'subagent-sub-task-9')).toBeUndefined();
    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    expect((sa.data.payload as any).nestedCount).toBeUndefined();
  });

  it('R-4: recursion reaches 3+ levels — a level-3 dispatch renders with its own tools', async () => {
    const { root, childA } = makeNestedBase();
    const deliveries: ContractDelivery[] = [
      ...root,
      ...childA(),
      // The grandchild session (ses_child_2) made one tool call and dispatched
      // a level-3 subagent.
      makeSubagentActivityDelivery('g-a1', 'end', 'ses_child_2', 'sub-tool-2', 'Read', {
        input: 'f.ts', output: 'contents',
        startTime: '2026-08-21T10:00:40.000Z',
      }),
      makeSubagentActivityDelivery('g-a2', 'end', 'ses_child_2', 'sub-sub-task-1', 'task', {
        input: JSON.stringify({ subagent_type: 'general', prompt: 'level 3' }),
        childSessionId: 'ses_child_3',
        startTime: '2026-08-21T10:00:42.000Z',
      }),
      makeSubagentActivityDelivery('g-a3', 'end', 'ses_child_3', 'sub-sub-tool-1', 'Grep', {
        input: 'needle', output: 'haystack hit',
        startTime: '2026-08-21T10:00:44.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-sub-sub-task-1')).toBeDefined();
    });

    const l2 = result.current.nodes.find(n => n.id === 'subagent-sub-task-1')!;
    const l3 = result.current.nodes.find(n => n.id === 'subagent-sub-sub-task-1')!;
    expect((l2.data.payload as any).depth).toBe(2);
    expect((l3.data.payload as any).depth).toBe(3);
    expect((l3.data.payload as any).tools).toHaveLength(1);
    expect((l3.data.payload as any).tools[0].toolName).toBe('Grep');

    // Edges chain level by level — never skipping to the chat spine.
    const e23 = result.current.edges.find(e => e.id === 'e-calls-sub-sub-task-1')!;
    expect(e23.source).toBe('subagent-sub-task-1');
    expect(e23.target).toBe('subagent-sub-sub-task-1');

    // Session max depth 3 → all stamped.
    expect((l3.data.payload as any).sessionMaxDepth).toBe(3);
    expect((result.current.nodes.find(n => n.id === 'subagent-task-1')!.data.payload as any).sessionMaxDepth).toBe(3);
  });

  it('R-6: a cycle in the collected parent links terminates — the cyclic remainder never renders and the acyclic root still does', async () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'general', prompt: 'cycle' });
    const deliveries: ContractDelivery[] = [
      makeDelivery('c-i1', 'init', 's1', 'corr-1', {
        userMessage: 'start', startTime: '2026-08-21T10:00:00.000Z',
      }),
      makeDelivery('c-e1', 'end', 's1', 'corr-1', {
        userMessage: 'start', agentReply: 'ok',
        startTime: '2026-08-21T10:00:00.000Z', endTime: '2026-08-21T10:01:00.000Z',
      }),
      // task-1 → child session ses_c1.
      makeToolDelivery('c-t1', 'end', 's1', 'task-1', 'task', {
        input: TASK_ARGS, childSessionId: 'ses_c1',
        startTime: '2026-08-21T10:00:10.000Z',
      }),
      // ses_c1 dispatches task-2 → ses_c2.
      makeSubagentActivityDelivery('c-a1', 'end', 'ses_c1', 'task-2', 'task', {
        input: TASK_ARGS, childSessionId: 'ses_c2',
        startTime: '2026-08-21T10:00:20.000Z',
      }),
      // ses_c2 dispatches task-3 → ses_c1 (points BACK at ses_c1's activity —
      // the association re-creates task-2 under task-3, closing the cycle
      // task-2 ⇄ task-3).
      makeSubagentActivityDelivery('c-a2', 'end', 'ses_c2', 'task-3', 'task', {
        input: TASK_ARGS, childSessionId: 'ses_c1',
        startTime: '2026-08-21T10:00:30.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    // The acyclic root still renders; the hook terminates (test completes —
    // an unguarded recursion would hang or throw Maximum update depth).
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeDefined();
    });

    // The cyclic nodes never render (visited-set guard) and get no edges.
    expect(result.current.nodes.find(n => n.id === 'subagent-task-2')).toBeUndefined();
    expect(result.current.nodes.find(n => n.id === 'subagent-task-3')).toBeUndefined();
    expect(result.current.edges.find(e => e.id === 'e-calls-task-2')).toBeUndefined();
    expect(result.current.edges.find(e => e.id === 'e-calls-task-3')).toBeUndefined();
  });

  it('R-8: orphaned child activity is retained unattached (counted), then attaches order-independently when the SubagentNode appears', async () => {
    const { childA } = makeNestedBase();
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'late parent' });
    // Batch 1: the child session's activity arrives while NO SubagentNode
    // with childSessionId ses_child_1 exists yet (the task dispatch is still
    // in flight — restored/live interleaving shape).
    const batch1: ContractDelivery[] = [
      makeDelivery('o-i1', 'init', 's1', 'corr-1', {
        userMessage: 'delegate work', startTime: '2026-08-21T10:00:00.000Z',
      }),
      makeDelivery('o-e1', 'end', 's1', 'corr-1', {
        userMessage: 'delegate work', agentReply: 'done',
        startTime: '2026-08-21T10:00:00.000Z', endTime: '2026-08-21T10:01:00.000Z',
      }),
      ...childA(),
    ];
    // Batch 2: the task dispatch lands (end carries the childSessionId).
    const batch2: ContractDelivery[] = [
      makeToolDelivery('o-t1', 'init', 's1', 'task-9', 'task', {
        input: TASK_ARGS, startTime: '2026-08-21T10:00:10.000Z',
      }),
      makeToolDelivery('o-t2', 'end', 's1', 'task-9', 'task', {
        input: TASK_ARGS, output: 'late', childSessionId: 'ses_child_1',
        startTime: '2026-08-21T10:00:10.000Z', endTime: '2026-08-21T10:00:50.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries }: { deliveries: ContractDelivery[] }) =>
        useDeliveryGraph({ deliveries, sessionId: 's1' }),
      { initialProps: { deliveries: batch1 } },
    );

    // Phase 1: orphans — the child call is retained in its collector, never
    // rendered as a floating node, and counted for the D-6 chip.
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    });
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
    expect(result.current.unattributedCount).toBe(2); // sub-tool-1 + sub-task-1

    // Phase 2: the SubagentNode appears — the orphan attaches (order-
    // independent) and the orphan count drops to 0.
    rerender({ deliveries: [...batch1, ...batch2] });
    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-9');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });
    expect(result.current.unattributedCount).toBe(0);
    const sa = result.current.nodes.find(n => n.id === 'subagent-task-9')!;
    expect((sa.data.payload as any).nestedCount).toBe(1);
    expect(result.current.nodes.find(n => n.id === 'subagent-sub-task-1')).toBeDefined();
  });

  it('R-8 (internal-orphan exemption): a build-dispatch chain counts unattributedCount === 0 — the child activity stays collected but exempt', async () => {
    // Internal `build` sessions DO call `task` (live DB evidence, fix plan D3).
    // Their dispatches carry NO is_subagent marker, so the dispatch itself is
    // R-2-dropped and no SubagentNode owner ever exists for their children —
    // WITHOUT the exemption the `⚠ N unattributed` chip surfaced on ordinary
    // flat sessions (R-7/D-7 invariant 5 violation).
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'level 1' });
    const deliveries: ContractDelivery[] = [
      ...makeNestedBase().root,
      // ses_child_1 (a REAL subagent) dispatched the INTERNAL build agent.
      makeSubagentActivityDelivery('x-a1', 'end', 'ses_child_1', 'sub-task-9', 'task', {
        input: JSON.stringify({ subagent_type: 'build', prompt: 'internal' }),
        childSessionId: 'ses_build',
        startTime: '2026-08-21T10:00:30.000Z',
      }),
      // The internal build session's own tool activity — collected (R-8
      // retention unchanged) but EXEMPT from the unattributed count.
      // `parentSessionId: 'ses_child_1'` mirrors D4a (ses_build's parent IS
      // ses_child_1, inside the selected subtree) — so WITHOUT the exemption
      // the scoped count would surface 1; the exemption is what keeps it 0.
      makeSubagentActivityDelivery('x-a2', 'end', 'ses_build', 'build-tool-1', 'Grep', {
        input: 'needle', output: 'hit',
        parentSessionId: 'ses_child_1',
        startTime: '2026-08-21T10:00:32.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeDefined();
    });

    // R-3 unchanged: the internal dispatch still creates NO nested node...
    expect(result.current.nodes.find(n => n.id.startsWith('subagent-sub-'))).toBeUndefined();
    // ...and its child's activity no longer counts as unattributed (was 1
    // before the fix — QA-6's non-internal orphans still count; see the R-8
    // regression test above, kept green).
    expect(result.current.unattributedCount).toBe(0);
  });

  it('R-8 (internal-orphan exemption, ROOT path): a build dispatch from the ROOT session exempts its child — the chip stays 0 on the flat session (D4b-4)', async () => {
    // The nested-path case above covers the association pass; THIS is the root
    // task-call path (associateToolCalls) — the ROOT session s1 itself
    // dispatched the internal build agent. The child's recorded parent is s1
    // (D4a), INSIDE the selected subtree, so without the root-path exemption
    // the scoped count would surface the chip on an ordinary flat session.
    const TASK_ARGS = JSON.stringify({ subagent_type: 'build', prompt: 'internal root dispatch' });
    const deliveries: ContractDelivery[] = [
      makeDelivery('ri-i1', 'init', 's1', 'corr-1', {
        userMessage: 'dispatch build', startTime: '2026-08-21T10:00:00.000Z',
      }),
      makeDelivery('ri-e1', 'end', 's1', 'corr-1', {
        userMessage: 'dispatch build', agentReply: 'done',
        startTime: '2026-08-21T10:00:00.000Z', endTime: '2026-08-21T10:01:00.000Z',
      }),
      makeToolDelivery('ri-t1', 'init', 's1', 'task-root-build', 'task', {
        input: TASK_ARGS, startTime: '2026-08-21T10:00:10.000Z',
      }),
      makeToolDelivery('ri-t2', 'end', 's1', 'task-root-build', 'task', {
        input: TASK_ARGS, output: 'internal done', childSessionId: 'ses_root_build',
        startTime: '2026-08-21T10:00:10.000Z', endTime: '2026-08-21T10:00:40.000Z',
      }),
      // The internal build child's own activity (is_subagent marker passes
      // R-2 — same fixture shape as the nested-path case).
      makeSubagentActivityDelivery('ri-a1', 'init', 'ses_root_build', 'build-tool-1', 'Grep', {
        input: 'needle', parentSessionId: 's1',
        startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeSubagentActivityDelivery('ri-a2', 'end', 'ses_root_build', 'build-tool-1', 'Grep', {
        input: 'needle', output: 'hit', parentSessionId: 's1',
        startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    });

    // R-3 unchanged: the internal root dispatch creates NO SubagentNode...
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
    // ...and its child's activity is EXEMPT — retained in the collector but
    // never counted (the `⚠ N unattributed` chip stays hidden, R-7/QA-5).
    expect(result.current.unattributedCount).toBe(0);
  });

  it('R-7 (D4b scope): orphans whose parentSessionId belongs to a DIFFERENT session are retained but not counted for the selected session — the flat-session noise class', async () => {
    // The 36-chip noise class (fix plan D4): a FLAT selected session (s1, no
    // delegation) receives other sessions' child activity through the
    // all-deliveries feed. The unscoped global count surfaced `⚠ N
    // unattributed` on ordinary sessions; the scoped count only counts
    // orphans whose recorded parent lies inside s1's subtree.
    const deliveries: ContractDelivery[] = [
      // Selected flat session s1: one chat exchange, no delegation.
      makeDelivery('n1-i1', 'init', 's1', 'corr-1', {
        userMessage: 'flat work', startTime: '2026-08-21T10:00:00.000Z',
      }),
      makeDelivery('n1-e1', 'end', 's1', 'corr-1', {
        userMessage: 'flat work', agentReply: 'done',
        startTime: '2026-08-21T10:00:00.000Z', endTime: '2026-08-21T10:01:00.000Z',
      }),
      // Another session's subagent child (dispatched by s_other) — arrives
      // under the same contract feed with parentSessionId s_other.
      makeSubagentActivityDelivery('n1-a1', 'init', 'ses_other_child', 'other-tool-1', 'Bash', {
        input: 'ls', parentSessionId: 's_other',
        startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeSubagentActivityDelivery('n1-a2', 'end', 'ses_other_child', 'other-tool-1', 'Bash', {
        input: 'ls', output: 'files', parentSessionId: 's_other',
        startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries, sessionId }: { deliveries: ContractDelivery[]; sessionId: string }) =>
        useDeliveryGraph({ deliveries, sessionId }),
      { initialProps: { deliveries, sessionId: 's1' } },
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    });

    // QA-5: the flat session shows NO chip despite the other-session noise...
    expect(result.current.unattributedCount).toBe(0);
    // ...and the foreign orphan never renders as a floating node.
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);

    // Retention proof (R-8 attach semantics unchanged): selecting the recorded
    // PARENT session (s_other) counts the SAME retained collector entries —
    // only the scoping moved, nothing was dropped.
    rerender({ deliveries, sessionId: 's_other' });
    await waitFor(() => {
      expect(result.current.unattributedCount).toBe(1);
    });
    // Still never rendered there either (no owner exists in the feed).
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);
  });

  it('R-7 (D4b scope): an orphan with NO parentSessionId (injected FIX-ORPHAN shape) is retained, never rendered, and not counted', async () => {
    // Injected fixture sessions (inject-otlp-fixture.ts, D2) carry
    // is_subagent but deliberately NO session.parent_id → the adapter derives
    // NO parentSessionId (D4a requires a resolvable parent) → the collector
    // records no parent → the scoped count skips it (QA-6: injected orphans
    // never show the chip).
    const deliveries: ContractDelivery[] = [
      makeDelivery('f2-i1', 'init', 's1', 'corr-1', {
        userMessage: 'flat work', startTime: '2026-08-21T10:00:00.000Z',
      }),
      makeDelivery('f2-e1', 'end', 's1', 'corr-1', {
        userMessage: 'flat work', agentReply: 'done',
        startTime: '2026-08-21T10:00:00.000Z', endTime: '2026-08-21T10:01:00.000Z',
      }),
      makeSubagentActivityDelivery('f2-a1', 'init', 'ses_orphan2762-1', 'orphan-tool-1', 'read', {
        input: 'x.ts', startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeSubagentActivityDelivery('f2-a2', 'end', 'ses_orphan2762-1', 'orphan-tool-1', 'read', {
        input: 'x.ts', output: 'contents',
        startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries, sessionId }: { deliveries: ContractDelivery[]; sessionId: string }) =>
        useDeliveryGraph({ deliveries, sessionId }),
      { initialProps: { deliveries, sessionId: 's1' } },
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'agent-corr-1')).toBeDefined();
    });

    // Never counted, never rendered as a floating node.
    expect(result.current.unattributedCount).toBe(0);
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(0);

    // Retention proof (R-8 unchanged): when the owner dispatch arrives late,
    // the retained orphan attaches to it order-independently.
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'late owner' });
    rerender({
      deliveries: [
        ...deliveries,
        makeToolDelivery('f2-t1', 'init', 's1', 'task-9', 'task', {
          input: TASK_ARGS, startTime: '2026-08-21T10:00:10.000Z',
        }),
        makeToolDelivery('f2-t2', 'end', 's1', 'task-9', 'task', {
          input: TASK_ARGS, output: 'late', childSessionId: 'ses_orphan2762-1',
          startTime: '2026-08-21T10:00:10.000Z', endTime: '2026-08-21T10:00:50.000Z',
        }),
      ],
      sessionId: 's1',
    });
    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-9');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });
    expect(result.current.unattributedCount).toBe(0);
  });

  it('session reset clears the internalOrphanExempt set with the collectors — a rebuilt session re-derives the exemption from scratch', async () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'level 1' });
    const internalChain: ContractDelivery[] = [
      ...makeNestedBase().root,
      makeSubagentActivityDelivery('r-a1', 'end', 'ses_child_1', 'sub-task-9', 'task', {
        input: JSON.stringify({ subagent_type: 'build', prompt: 'internal' }),
        childSessionId: 'ses_build',
        startTime: '2026-08-21T10:00:30.000Z',
      }),
      makeSubagentActivityDelivery('r-a2', 'end', 'ses_build', 'build-tool-1', 'Grep', {
        input: 'needle', output: 'hit',
        parentSessionId: 'ses_child_1',
        startTime: '2026-08-21T10:00:32.000Z',
      }),
    ];

    const { result, rerender } = renderHook(
      ({ deliveries, sessionId }: { deliveries: ContractDelivery[]; sessionId: string }) =>
        useDeliveryGraph({ deliveries, sessionId }),
      { initialProps: { deliveries: internalChain, sessionId: 's1' } },
    );

    // s1: the exemption is active — the build child's call counts 0.
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeDefined();
    });
    expect(result.current.unattributedCount).toBe(0);

    // Switch away: the builder state (collectors + exempt set) is dropped.
    rerender({ deliveries: [], sessionId: 's2' });
    await waitFor(() => {
      expect(result.current.nodes).toHaveLength(0);
    });
    expect(result.current.unattributedCount).toBe(0);

    // Back to s1: state is rebuilt from the deliveries and the exemption is
    // re-derived — identical outcome, no stale or leaked exemption state.
    rerender({ deliveries: internalChain, sessionId: 's1' });
    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeDefined();
    });
    expect(result.current.unattributedCount).toBe(0);
  });

  it('R-10: nested tool summaries carry the same outcome fields the embedded accordion renders (error/success/durationMs)', async () => {
    const { root, childA } = makeNestedBase();
    const deliveries = [...root, ...childA()];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-1');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const call = (result.current.nodes.find(n => n.id === 'subagent-task-1')!.data.payload as any).tools[0];
    // Same fields getToolCallOutcome consumes — error beats success, duration
    // carried through (the embedded accordion renders them via the SHARED
    // ToolCallAccordionItem → getToolCallOutcome path).
    expect(call.success).toBe(false);
    expect(call.error).toBe('permission denied');
    expect(call.durationMs).toBe(120);
  });

  it('R-7: a session whose subagents have NO nested activity renders byte-identical to today — no tools/nestedCount/depth fields, no chips', async () => {
    const TASK_ARGS = JSON.stringify({ subagent_type: 'explore', prompt: 'flat' });
    const deliveries: ContractDelivery[] = [
      makeDelivery('f-i1', 'init', 's1', 'corr-1', {
        userMessage: 'delegate work', startTime: '2026-08-21T10:00:00.000Z',
      }),
      makeDelivery('f-e1', 'end', 's1', 'corr-1', {
        userMessage: 'delegate work', agentReply: 'done',
        startTime: '2026-08-21T10:00:00.000Z', endTime: '2026-08-21T10:00:40.000Z',
      }),
      makeToolDelivery('f-t1', 'init', 's1', 'task-1', 'task', {
        input: TASK_ARGS, startTime: '2026-08-21T10:00:10.000Z',
      }),
      makeToolDelivery('f-t2', 'end', 's1', 'task-1', 'task', {
        input: TASK_ARGS, output: 'flat done', childSessionId: 'ses_flat_child',
        startTime: '2026-08-21T10:00:10.000Z', endTime: '2026-08-21T10:00:30.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-task-1')).toBeDefined();
    });

    // Exactly the pre-#2762 node/edge set: one chat node, one subagent node,
    // one e-calls edge. No nested nodes, no orphan count, and the payload
    // carries NONE of the conditional nested fields (absent → sections/chips
    // hidden — D-7 invariant 5).
    expect(result.current.nodes.map(n => n.id).sort()).toEqual(['agent-corr-1', 'subagent-task-1']);
    expect(result.current.edges.map(e => e.id)).toEqual(['e-calls-task-1']);
    const payload = result.current.nodes.find(n => n.id === 'subagent-task-1')!.data.payload as any;
    expect(payload.tools).toBeUndefined();
    expect(payload.nestedCount).toBeUndefined();
    expect(payload.depth).toBeUndefined();
    expect(payload.sessionMaxDepth).toBeUndefined();
    expect(result.current.unattributedCount).toBe(0);
  });

  it('session reset: switching sessions drops the nested graph and the orphan count', async () => {
    const { root, childA } = makeNestedBase();
    // An orphan in s1 (no SubagentNode yet) so the count is non-zero.
    const { result, rerender } = renderHook(
      ({ deliveries, sessionId }: { deliveries: ContractDelivery[]; sessionId: string }) =>
        useDeliveryGraph({ deliveries, sessionId }),
      { initialProps: { deliveries: [root[0], root[1], ...childA()], sessionId: 's1' } },
    );

    await waitFor(() => {
      expect(result.current.unattributedCount).toBe(2);
    });

    // Switch to another session: builder state resets — nodes and count drop.
    rerender({ deliveries: [], sessionId: 's2' });
    await waitFor(() => {
      expect(result.current.unattributedCount).toBe(0);
    });
    expect(result.current.nodes).toHaveLength(0);
  });
});

// ── Spec #2768 round 3 — composited child tool deliveries ────────────────────
//
// Since the round-1 emission fix, child tool spans self-carry session.parent_id
// so the ECE composites child `subagent-tool-activity` deliveries under the
// PARENT composite key and injects the ORIGINAL child session id into the
// OUTER delivery payload as `compositedChildSessionId`. The collector must key
// by the CHILD id (read from the outer payload), falling back to the delivery's
// own key sessionId for legacy child-keyed (F1-era) deliveries — otherwise the
// childSessionId join never matches and every child tool call counts as an
// in-scope orphan (`⚠ N unattributed` chip, lost TOOLS accordion).

/** A composited child tool delivery: key.sessionId = PARENT, outer payload
 *  carries `compositedChildSessionId` = CHILD, inner payload keeps
 *  `is_subagent: true` + `parentSessionId` = PARENT — the verified F5/F4B
 *  engine row shape. */
function makeCompositedChildDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  parentSessionId: string,
  childSessionId: string,
  correlationId: string,
  toolName: string,
  innerPayload: Record<string, unknown> = {},
): ContractDelivery {
  return makeSubagentActivityDelivery(
    id,
    lifecycle,
    parentSessionId,
    correlationId,
    toolName,
    { is_subagent: true, parentSessionId, ...innerPayload },
    { compositedChildSessionId: childSessionId },
  );
}

describe('Spec #2768 round 3 — composited child tool deliveries key by the CHILD session id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
  });

  it('(a) a parent-composited child tool delivery attaches to the right SubagentNode — chip 0, no orphans', async () => {
    const { root } = makeNestedBase();
    // The child's Bash call arrives composited: keyed under the PARENT (s1),
    // outer payload injects the child id (ses_child_1).
    const compositedChild: ContractDelivery[] = [
      makeCompositedChildDelivery('cc-a1', 'init', 's1', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeCompositedChildDelivery('cc-a2', 'end', 's1', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', output: 'files',
        startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [...root, ...compositedChild], sessionId: 's1' }),
    );

    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-1');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    const payload = sa.data.payload as any;
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].toolName).toBe('Bash');
    expect(payload.tools[0].output).toBe('files');
    // Every child call attributed → the chip stays hidden (renders only when N > 0).
    expect(result.current.unattributedCount).toBe(0);
    // No orphan rendered: the ONLY subagent node is the owned one.
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-')).map(n => n.id))
      .toEqual(['subagent-task-1']);
  });

  it('(b) a child-keyed delivery (F1-era shape, no compositedChildSessionId) still attaches — no regression', async () => {
    const { root } = makeNestedBase();
    // Today's helper shape: key.sessionId = CHILD id, outer payload carries NO
    // compositedChildSessionId — the collector must keep using key.sessionId.
    const childKeyed: ContractDelivery[] = [
      makeSubagentActivityDelivery('ck-a1', 'init', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', parentSessionId: 's1', startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeSubagentActivityDelivery('ck-a2', 'end', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', output: 'files',
        parentSessionId: 's1',
        startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [...root, ...childKeyed], sessionId: 's1' }),
    );

    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-1');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    const payload = sa.data.payload as any;
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].toolName).toBe('Bash');
    expect(payload.tools[0].output).toBe('files');
    expect(result.current.unattributedCount).toBe(0);
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-')).map(n => n.id))
      .toEqual(['subagent-task-1']);
  });

  it('(c) mixed shapes in one rebuild (child-keyed init + composited end, same correlationId) do not double-count', async () => {
    const { root } = makeNestedBase();
    // The re-key replay shape: the SAME child call arrives child-keyed (early
    // init, pre-registration) then composited (the re-key end+init pair). Both
    // must collapse into ONE collector entry per correlationId.
    const mixed: ContractDelivery[] = [
      makeSubagentActivityDelivery('mx-a1', 'init', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', parentSessionId: 's1', startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeCompositedChildDelivery('mx-a2', 'end', 's1', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', output: 'files',
        startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [...root, ...mixed], sessionId: 's1' }),
    );

    await waitFor(() => {
      const sa = result.current.nodes.find(n => n.id === 'subagent-task-1');
      expect(sa).toBeDefined();
      expect(((sa!.data.payload as any).tools ?? []).length).toBe(1);
    });

    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    const payload = sa.data.payload as any;
    // Exactly ONE tool call — the child-keyed and composited deliveries of the
    // same correlationId merged into a single collector entry.
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].toolName).toBe('Bash');
    expect(payload.tools[0].output).toBe('files');
    expect(result.current.unattributedCount).toBe(0);
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-'))).toHaveLength(1);
  });

  it('(d) full nested tree with every child call composited — chip 0 and only owned subagent nodes', async () => {
    const { root } = makeNestedBase();
    // Dispatch + all child calls composited: the child's Bash tool AND its own
    // `task` dispatch (which creates the nested SubagentNode for ses_child_2).
    const TASK_ARGS_L2 = JSON.stringify({ subagent_type: 'general', prompt: 'level 2' });
    const compositedTree: ContractDelivery[] = [
      makeCompositedChildDelivery('ft-a1', 'init', 's1', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', startTime: '2026-08-21T10:00:20.000Z',
      }),
      makeCompositedChildDelivery('ft-a2', 'end', 's1', 'ses_child_1', 'sub-tool-1', 'Bash', {
        input: 'ls', output: 'files',
        startTime: '2026-08-21T10:00:20.000Z', endTime: '2026-08-21T10:00:21.000Z',
      }),
      makeCompositedChildDelivery('ft-a3', 'init', 's1', 'ses_child_1', 'sub-task-1', 'task', {
        input: TASK_ARGS_L2, startTime: '2026-08-21T10:00:30.000Z',
      }),
      makeCompositedChildDelivery('ft-a4', 'end', 's1', 'ses_child_1', 'sub-task-1', 'task', {
        input: TASK_ARGS_L2, output: 'level-2 done', childSessionId: 'ses_child_2',
        startTime: '2026-08-21T10:00:30.000Z', endTime: '2026-08-21T10:00:45.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries: [...root, ...compositedTree], sessionId: 's1' }),
    );

    await waitFor(() => {
      expect(result.current.nodes.find(n => n.id === 'subagent-sub-task-1')).toBeDefined();
    });

    // Both SubagentNodes render (parent + nested), each with the right payload.
    const sa = result.current.nodes.find(n => n.id === 'subagent-task-1')!;
    expect((sa.data.payload as any).tools).toHaveLength(1);
    expect((sa.data.payload as any).nestedCount).toBe(1);
    // Every child call attributed → chip 0 (hidden) and ZERO floating/orphan
    // subagent nodes — the only `subagent-` nodes are the owned ones.
    expect(result.current.unattributedCount).toBe(0);
    expect(result.current.nodes.filter(n => n.id.startsWith('subagent-')).map(n => n.id).sort())
      .toEqual(['subagent-sub-task-1', 'subagent-task-1']);
  });
});

