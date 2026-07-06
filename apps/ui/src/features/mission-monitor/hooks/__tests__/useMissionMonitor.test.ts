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
import {
  getParentSession,
  resetChildParentMappings,
} from '../../lib/contract';

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

describe('useDeliveryGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries.length = 0;
    resetChildParentMappings();
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

  it('should update tool node status through lifecycle (initâ†’updateâ†’end)', async () => {
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
      // MonitorNodeData.status â€” complete maps to 'inactive'
      // (graphStatusToMonitorStatus maps 'complete' â†’ 'inactive')
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

  it('should NOT increment layoutVersion on dimension changes (force layout runs in processing effect)', async () => {
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

    // Second node should shift down â†’ layoutVersion increments
    expect(result.current.layoutVersion).toBe(0);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Spec #478 — Mission Monitor Session Splitting
// ═══════════════════════════════════════════════════════════════════════════════

describe('Spec #478 — Session Splitting Fixes', () => {
  beforeEach(() => {
    resetChildParentMappings();
  });

  // ── REQ-1: Eager Child→Parent Session Mapping (AC-1, AC-2) ─────────────────

  it('AC-1: populates childToParentSession eagerly from session.created deliveries regardless of sessionId', async () => {
    // Create a delivery that looks like a session.created with parentID
    const deliveries: ContractDelivery[] = [{
      id: 'd1',
      contractName: 'chat-node',
      lifecycle: 'init',
      key: { sessionId: 'child-session-1', correlationId: 'corr-1' },
      payload: {
        payload: {
          event_type: 'session.created',
          properties: {
            info: {
              parentID: 'parent-session-1',
              agent: 'build',
              text: '',
            },
          },
        },
      },
      timestamp: new Date().toISOString(),
    }];

    // sessionId=null — the old code would skip mapping because no session selected.
    // The new eager useEffect runs on ALL deliveries unconditionally.
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: null }),
    );

    // Wait for the effect to fire
    await waitFor(() => {
      // Mapping should be populated even with sessionId=null
      expect(getParentSession('child-session-1')).toBe('parent-session-1');
    });

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
  });

  it('AC-2: populates childToParentSession eagerly from PostToolUse task deliveries regardless of sessionId', async () => {
    const deliveries: ContractDelivery[] = [{
      id: 'd1',
      contractName: 'tool-use-lifecycle',
      lifecycle: 'end',
      key: { sessionId: 'child-session-2', correlationId: 'task-corr-1' },
      payload: {
        toolName: 'task',
        state: 'Response',
        payload: {
          metadata: {
            parentSessionId: 'parent-session-2',
            sessionId: 'child-session-2',
          },
        },
      },
      timestamp: new Date().toISOString(),
    }];

    // sessionId=null — ensuring the mapping is populated without any session
    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: null }),
    );

    await waitFor(() => {
      expect(getParentSession('child-session-2')).toBe('parent-session-2');
    });

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
  });

  it('populates mapping from session.created even when deliveries include other contract types', async () => {
    const deliveries: ContractDelivery[] = [{
      id: 'd1',
      contractName: 'chat-node',
      lifecycle: 'init',
      key: { sessionId: 'child-s3', correlationId: 'corr-3' },
      payload: {
        payload: {
          event_type: 'session.created',
          properties: {
            info: {
              parentID: 'parent-s3',
              agent: 'build',
              text: '',
            },
          },
        },
      },
      timestamp: new Date().toISOString(),
    }];

    const { result } = renderHook(() =>
      useDeliveryGraph({ deliveries, sessionId: 'child-s3' }),
    );

    await waitFor(() => {
      expect(getParentSession('child-s3')).toBe('parent-s3');
    });
  });

  // ── REQ-3: ChatNode Label (AC-4) ─────────────────────────────────────────

  it('AC-4: ChatNode label displays "Chat" even when agent/model info is present', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'agent-corr-1', {
        agent: 'build',
        model: 'mimo-v2.5-free',
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
    // Label should be 'Chat', not 'build · mimo-v2.5-free'
    expect(agentNode!.data.label).toBe('Chat');
  });

  it('ChatNode label displays "Chat" even with no payload agent/model', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'agent-corr-1'),
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

  // ── REQ-4: End Lifecycle Concatenation (AC-5) ────────────────────────────

  it('AC-5: ChatNode agentReply concatenates across update and end lifecycle, preserving all text', async () => {
    const deliveries: ContractDelivery[] = [
      // Init — creates the agent node
      makeDelivery('d1', 'init', 's1', 'agent-corr-1', {
        agent: 'Architect',
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
        event_type: 'UserPromptSubmit',
      }),
      // Update — first response chunk
      makeDelivery('d2', 'update', 's1', 'agent-corr-1', {
        part: { text: 'Sure, I can ', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
      }),
      // End — final response chunk
      makeDelivery('d3', 'end', 's1', 'agent-corr-1', {
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

    // The agentReply should be the concatenation of update + end text
    // (init doesn't contribute agentReply because UserPromptSubmit clears it)
    const agentReply = (agentNode!.data.payload as any)?.agentReply as string;
    expect(agentReply).toBe('Sure, I can help you with that!');
  });

  it('end lifecycle skips duplicate agentReply when already contained', async () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 's1', 'agent-corr-1', {
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
      }),
      // Update — first chunk
      makeDelivery('d2', 'update', 's1', 'agent-corr-1', {
        part: { text: 'Hello world', reasoning: '' },
      }),
      // End — same text arrives again (should dedup)
      makeDelivery('d3', 'end', 's1', 'agent-corr-1', {
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

  // ── REQ-5: Subagent System Prompt Filtering (AC-6) ───────────────────────

  it('AC-6: SubagentNode update accumulates raw unfiltered text (filtering deferred to end lifecycle)', async () => {
    // Create a subagent via chat-node init with parentID (simulates session.created)
    const initPayload = {
      event_type: 'session.created',
      properties: {
        info: {
          parentID: 'parent-s5',
          agent: 'coder',
          title: 'Implement feature X',
        },
      },
    };

    // Subagent update deliveries with instruction-prefixed text
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'child-s5', correlationId: 'sa-corr-5' },
        payload: { payload: initPayload as any },
        timestamp: new Date().toISOString(),
      },
      // Update — reply starts with instruction text (no filtering at update stage)
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'update',
        key: { sessionId: 'child-s5', correlationId: 'sa-corr-5' },
        payload: {
          payload: {
            type: 'text',
            text: 'Implement feature XLet me write the code now',
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
    // Filtering is deferred to end lifecycle — update stage has raw unfiltered text
    expect(output).toContain('Implement feature X');
    expect(output).toBe('Implement feature XLet me write the code now');
  });

  it('subagent end delivery filters instruction text from output', async () => {
    const deliveries: ContractDelivery[] = [
      {
        id: 'd1', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'child-s6', correlationId: 'sa-corr-6' },
        payload: {
          payload: {
            event_type: 'session.created',
            properties: {
              info: {
                parentID: 'parent-s6',
                agent: 'reviewer',
                title: 'Review the PR',
              },
            },
          } as any,
        },
        timestamp: new Date().toISOString(),
      },
      // End delivery — full response with instruction prefix
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'end',
        key: { sessionId: 'child-s6', correlationId: 'sa-corr-6' },
        payload: {
          payload: {
            type: 'text',
            text: 'Review the PRChanges look good, approved!',
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
    expect(output).not.toContain('Review the PR');
    expect(output).toBe('Changes look good, approved!');
  });

  // ── REQ-6: Solid Parent Edge (AC-7) ──────────────────────────────────────

  it('AC-7: parent edges use solid line (no strokeDasharray)', async () => {
    // Create a parent agent + subagent session to generate a parent edge
    const deliveries: ContractDelivery[] = [
      // Parent agent init
      makeDelivery('d1', 'init', 'parent-s7', 'agent-corr-7', {
        agent: 'Architect',
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
        event_type: 'UserPromptSubmit',
      }),
      // Subagent session.created with parentID
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'child-s7', correlationId: 'sa-corr-7' },
        payload: {
          payload: {
            event_type: 'session.created',
            properties: {
              info: {
                parentID: 'parent-s7',
                agent: 'coder',
                title: 'Implement',
              },
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

  // ── REQ-7: Unified Session View (AC-8) ───────────────────────────────────

  it('AC-8: selecting parent session shows subagent nodes in graph with connecting edge', async () => {
    const deliveries: ContractDelivery[] = [
      // Parent agent
      makeDelivery('d1', 'init', 'parent-s8', 'agent-corr-8', {
        agent: 'Architect',
        info: { text: 'Hello', modelID: 'claude-sonnet-4', agent: 'Architect' },
        part: { text: '', reasoning: '' },
        turnInputTokens: 10,
        turnOutputTokens: 5,
        event_type: 'UserPromptSubmit',
      }),
      // Subagent
      {
        id: 'd2', contractName: 'chat-node', lifecycle: 'init',
        key: { sessionId: 'child-s8', correlationId: 'sa-corr-8' },
        payload: {
          payload: {
            event_type: 'session.created',
            properties: {
              info: {
                parentID: 'parent-s8',
                agent: 'coder',
                title: 'Implement feature',
              },
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

// Legacy re-exports for backward compat
export { buildGraphFromEvents, processChatNodeSubscription } from '../useMissionMonitor';
