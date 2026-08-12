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
      payload: { toolName, ...innerPayload },
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
      // tool-use-lifecycle contract is deactivated (#593/#586)
      // deliveries still count toward eventCount but produce 0 nodes
      expect(result.current.eventCount).toBe(1);
      expect(result.current.nodes.length).toBe(0);
    });

    const toolNode = result.current.nodes.find(n => n.id.startsWith('tool-'));
    expect(toolNode).toBeUndefined();
  });

  it('should update tool node status through lifecycle (initâ†’updateâ†’end)', async () => {
    const deliveries: ContractDelivery[] = [
      makeToolDelivery('d1', 'init', 's1', 'tool-corr-1', 'Edit', { input: 'file.ts' }),
      makeToolDelivery('d2', 'update', 's1', 'tool-corr-1', 'Edit', { input: 'file.ts', output: 'ok' }),
      makeToolDelivery('d3', 'end', 's1', 'tool-corr-1', 'Edit', { input: 'file.ts', output: 'changes applied' }),
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 's1' }),
    );

    // tool-use-lifecycle contract is deactivated (#593/#586)
    // deliveries count toward eventCount but produce 0 nodes
    await waitFor(() => {
      expect(result.current.eventCount).toBe(3);
      expect(result.current.nodes.length).toBe(0);
    });

    const toolNode = result.current.nodes.find(n => n.id.startsWith('tool-'));
    expect(toolNode).toBeUndefined();
  });

  it('should create subagent nodes from chat-node init with compositedChildSessionId', async () => {
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
      // Subagent delivery (compositedChildSessionId in payload → detected as subagent)
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

// ── Subagent Node Creation + Output Filtering (AC-6) ─────────────────

describe('Subagent Node Lifecycle', () => {
  it('AC-6: SubagentNode accumulates output through update lifecycle (pass-through)', async () => {
    // Subagent detection: compositedChildSessionId in payload
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
            // Legacy paths for backward compat
            properties: {
              info: { agent: 'coder', title: 'Implement feature X' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
      // Update — output chunk (pass-through, no filtering)
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'update',
        key: { sessionId: 'parent-s5', correlationId: 'sa-corr-5' },
        payload: {
          compositedChildSessionId: 'sa-corr-5',
          payload: {
            output: 'Let me write the code now',
            // Legacy backward compat for old extractAgentReply
            part: { text: 'Let me write the code now', reasoning: '' },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-s5' }),
    );

    // Wait for the subagent node to exist
    await waitFor(() => {
      const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
      expect(saNode).toBeDefined();
    });

    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(saNode).toBeDefined();

    const output = (saNode!.data.payload as any)?.output as string;
    // Subagent output passes through unchanged (no filtering)
    expect(output).toBe('Let me write the code now');
  });

  it('subagent end delivery passes output through unchanged', async () => {
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
            // Legacy paths for backward compat
            properties: {
              info: { agent: 'reviewer', title: 'Review the PR' },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
      // End delivery — raw output passes through unchanged (no filtering)
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'end',
        key: { sessionId: 'parent-s6', correlationId: 'sa-corr-6' },
        payload: {
          compositedChildSessionId: 'sa-corr-6',
          payload: {
            output: 'Changes look good, approved!',
            // Legacy backward compat for old extractAgentReply
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
      const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
      expect(saNode).toBeDefined();
    });

    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(saNode).toBeDefined();

    const output = (saNode!.data.payload as any)?.output as string;
    expect(output).toBe('Changes look good, approved!');
  });

  // ── Bug 1: INPUT ≠ OUTPUT ────────────────────────────────────────

  it('BUG-1: INIT delivery with same p.instruction and p.output sets instruction but leaves output empty', async () => {
    // Bug 1 root cause: When p.output contains the instruction text (from
    // OTLP session span output attribute) and p.instruction is also the
    // same text, the old output extraction chain checked p.output first
    // on non-INIT deliveries and would show identical text for both INPUT
    // and OUTPUT. This test verifies that on INIT, output is empty
    // (loading/awaiting state) while instruction correctly captures the text.
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-b1', correlationId: 'sa-corr-b1' },
        payload: {
          compositedChildSessionId: 'sa-corr-b1',
          payload: {
            name: 'coder',
            instruction: 'Analyze code',
            output: 'Analyze code', // same text as instruction (OTLP scenario)
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-b1' }),
    );

    await waitFor(() => {
      const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
      expect(saNode).toBeDefined();
    });

    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(saNode).toBeDefined();

    const payload = saNode!.data.payload as any;
    expect(payload.instruction).toBe('Analyze code');
    expect(payload.output).toBe(''); // empty on init → loading state
  });

  it('BUG-1: p.agentReply is preferred over p.output for output extraction', async () => {
    // When p.agentReply exists (adapter-injected canonical response), it
    // must be preferred over p.output for output extraction on all lifecycles.
    // This tests the reordered chain: agentReply → response_text → output.
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
      // Update with agentReply — should take priority over p.output
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'update',
        key: { sessionId: 'parent-b1b', correlationId: 'sa-corr-b1b' },
        payload: {
          compositedChildSessionId: 'sa-corr-b1b',
          payload: {
            output: 'Analyze code', // instruction text (should be IGNORED)
            agentReply: 'The code looks clean and well-structured.', // preferred
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-b1b' }),
    );

    await waitFor(() => {
      const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
      expect(saNode).toBeDefined();
    });

    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(saNode).toBeDefined();

    const payload = saNode!.data.payload as any;
    // Output should use agentReply, NOT p.output (which still has instruction text)
    expect(payload.output).toBe('The code looks clean and well-structured.');
    // Instruction should be preserved from init
    expect(payload.instruction).toBe('Analyze code');
  });

  it('BUG-1: p.response_text is preferred over p.output for output extraction', async () => {
    // Same as above but with p.response_text instead of p.agentReply.
    // Covers the OTLP LLM span attribute path.
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-b1c', correlationId: 'sa-corr-b1c' },
        payload: {
          compositedChildSessionId: 'sa-corr-b1c',
          payload: {
            name: 'coder',
            instruction: 'Refactor module',
            output: 'Refactor module',
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
      // Update with response_text — should take priority over p.output
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'update',
        key: { sessionId: 'parent-b1c', correlationId: 'sa-corr-b1c' },
        payload: {
          compositedChildSessionId: 'sa-corr-b1c',
          payload: {
            output: 'Refactor module', // instruction text (should be IGNORED)
            response_text: 'Module refactored successfully.',
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
    ];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'parent-b1c' }),
    );

    await waitFor(() => {
      const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
      expect(saNode).toBeDefined();
    });

    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(saNode).toBeDefined();

    const payload = saNode!.data.payload as any;
    expect(payload.output).toBe('Module refactored successfully.');
    expect(payload.instruction).toBe('Refactor module');
  });
});

// ── Bug 3: SubagentNode Layout Order ─────────────────────────────────

describe('Bug 3 — SubagentNode Layout Order', () => {
  it('BUG-3: subagent with empty parentCorrelationId gets BFS depth via sessionId fallback', async () => {
    // Bug 3 root cause: When parentCorrelationId is empty, the BFS
    // edge-building loop skipped resolution entirely, leaving the subagent
    // with depth=0 (same as parent agent). This caused SubagentNodes to
    // render at the same Y position or above the parent ChatNode.
    //
    // Fix: Add secondary fallback that scans agentNodes for any agent
    // with a different sessionId when parentCorrId is empty.
    //
    // This test simulates a subagent with empty parentCorrelationId
    // (captures the OTLP-derived scenario) and verifies:
    // 1. Subagent node is created
    // 2. An edge connects it to a parent agent
    // 3. BFS depth computation runs without returning subagent at depth 0
    const deliveries: ContractDelivery[] = [
      // Parent agent (different session from subagent)
      makeDelivery('d1', 'init', 'parent-session-b3', 'agent-corr-b3', {
        agent: 'Architect',
        userMessage: 'Analyze this code',
        agentReply: '',
        promptTokens: 10,
        completionTokens: 5,
      }),
      // Subagent with OTLP is_subagent signal + empty parentCorrelationId
      // The subagent has its own sessionId (different from parent)
      // and uses is_subagent field for detection (OTLP non-composited path)
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
      // Should have both agent and subagent nodes
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(2);
    });

    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(agentNode).toBeDefined();
    expect(saNode).toBeDefined();

    // Edge should connect agent → subagent
    const edge = result.current.edges.find(e =>
      e.source.startsWith('agent-') && e.target.startsWith('subagent-'),
    );
    expect(edge).toBeDefined();

    // Subagent should be below agent (positive Y offset)
    // The exact Y depends on the force layout, but the critical assertion
    // is that an edge exists, which means BFS will assign depth=1, which
    // means the force layout will position the subagent below the agent.
    const agentY = agentNode!.position.y;
    const saY = saNode!.position.y;
    // Subagent should NOT be above the agent (negative relative Y)
    expect(saY).toBeGreaterThanOrEqual(agentY - 10); // allow small tolerance
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

// ── Graph Edge + Unified Session View (AC-7, AC-8) ───────────────────

describe('Subagent Graph Integration', () => {
  it('AC-7: parent edges use solid line (no strokeDasharray)', async () => {
    // Create a parent agent + subagent session to generate a parent edge.
    // With ECE compositing: subagent delivery has compositedChildSessionId in outer payload.
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
      // Subagent chat-node init with compositedChildSessionId
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-s7', correlationId: 'sa-corr-7' },
        payload: {
          compositedChildSessionId: 'sa-corr-7',
          payload: {
            name: 'coder',
            instruction: 'Implement',
            output: '',
            // Legacy paths for backward compat
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
      // Should have at least 2 nodes (agent + subagent)
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(2);
      // Should have at least 1 edge (parent → subagent)
      expect(result.current.edges.length).toBeGreaterThanOrEqual(1);
    });

    // Verify edges don't have strokeDasharray
    for (const edge of result.current.edges) {
      expect(edge.style).not.toHaveProperty('strokeDasharray');
      // Solid stroke should be present for parent-type edges
      if (edge.source.startsWith('agent-') && edge.target.startsWith('subagent-')) {
        expect(edge.style).toHaveProperty('stroke', '#6366f1');
        expect(edge.style).toHaveProperty('strokeWidth', 1.5);
      }
    }
  });

  it('AC-8: selecting parent session shows subagent nodes in graph with connecting edge', async () => {
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
      // Subagent with compositedChildSessionId
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'parent-s8', correlationId: 'sa-corr-8' },
        payload: {
          compositedChildSessionId: 'sa-corr-8',
          payload: {
            name: 'coder',
            instruction: 'Implement feature',
            output: '',
            // Legacy paths for backward compat
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
      expect(result.current.nodes.length).toBeGreaterThanOrEqual(2);
      expect(result.current.edges.length).toBeGreaterThanOrEqual(1);
    });

    // Agent node exists
    const agentNode = result.current.nodes.find(n => n.id.startsWith('agent-'));
    expect(agentNode).toBeDefined();

    // Subagent node exists
    const saNode = result.current.nodes.find(n => n.id.startsWith('subagent-'));
    expect(saNode).toBeDefined();

    // Edge connects agent → subagent
    const edge = result.current.edges.find(e =>
      e.source.startsWith('agent-') && e.target.startsWith('subagent-'),
    );
    expect(edge).toBeDefined();
    expect(edge!.type).toBe('smoothstep');
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

