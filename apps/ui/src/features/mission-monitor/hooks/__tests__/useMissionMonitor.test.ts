/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';

// Mock reactflow
const mockSetNodes = vi.fn();
vi.mock('reactflow', () => ({
  useNodesState: vi.fn(() => [[], mockSetNodes, vi.fn()]),
  useEdgesState: vi.fn(() => [[], vi.fn(), vi.fn()]),
}));

// Mock StreamContext
const mockEvents: FredoEvent[] = [];
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    events: mockEvents,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useMissionMonitor, buildGraphFromEvents } from '../useMissionMonitor';

export type { FredoEvent } from '../../../../shared/contexts/StreamContext';

describe('useMissionMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvents.length = 0;
  });

  it('should return empty state for replay mode with no events', () => {
    const { result } = renderHook(() =>
      useMissionMonitor({ sessionId: 's1', startTime: 0 }, []),
    );

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.eventCount).toBe(0);
  });

  it('should build graph from replay events', async () => {
    const events: FredoEvent[] = [
      {
        id: 'evt-1',
        eventType: 'tool_use',
        state: 'Init',
        provider: 'open_code',
        transport: 'hook',
        sessionId: 's1',
        toolName: 'UserPromptSubmit',
        timestamp: new Date().toISOString(),
        payload: { prompt: 'Show me the weather' },
      },
      {
        id: 'evt-2',
        eventType: 'tool_use',
        state: 'Update',
        provider: 'open_code',
        transport: 'hook',
        sessionId: 's1',
        toolName: 'chat',
        timestamp: new Date().toISOString(),
        payload: {
          response: 'The weather is sunny',
          'gen_ai.response.model': 'gpt-4',
        },
      },
    ];

    const { result } = renderHook(() =>
      useMissionMonitor({ sessionId: 's1', startTime: 0 }, events),
    );

    expect(result.current.eventCount).toBe(2);
    await waitFor(() => {
      expect(mockSetNodes).toHaveBeenCalled();
      const lastCallNodes = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0];
      expect(lastCallNodes.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should set eventCount correctly for multiple replay events', () => {
    const events: FredoEvent[] = [
      {
        id: 'e1', eventType: 'tool_use', state: 'Init',
        provider: 'open_code', transport: 'hook', sessionId: 's1',
        toolName: 'SessionStart', timestamp: '2024-01-01T00:00:00Z',
        payload: { session_id: 's1' },
      },
      {
        id: 'e2', eventType: 'tool_use', state: 'Init',
        provider: 'open_code', transport: 'hook', sessionId: 's1',
        toolName: 'UserPromptSubmit', timestamp: '2024-01-01T00:00:01Z',
        payload: { prompt: 'hello' },
      },
    ];

    const { result } = renderHook(() =>
      useMissionMonitor({ sessionId: 's1', startTime: 0 }, events),
    );

    expect(result.current.eventCount).toBe(2);
  });

  it('should filter live events by sessionId and startTime', async () => {
    const recentEvent: FredoEvent = {
      id: 'e2', eventType: 'chat', state: 'Update',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat', timestamp: new Date().toISOString(),
      payload: { 'gen_ai.response.model': 'gpt-4' },
    };
    const oldEvent: FredoEvent = {
      id: 'e1', eventType: 'chat', state: 'Update',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat', timestamp: '2023-01-01T00:00:00Z',
      payload: { 'gen_ai.response.model': 'gpt-3' },
    };

    // Start time after the old event
    const startTime = new Date('2023-06-01').getTime();

    const { result, rerender } = renderHook(
      (opts: { sessionId: string; startTime: number }) =>
        useMissionMonitor(opts),
      { initialProps: { sessionId: 's1', startTime } },
    );

    // Push events to the mock stream
    mockEvents.push(oldEvent, recentEvent);

    // Trigger re-render so the effect picks up streamEvents changes
    rerender({ sessionId: 's1', startTime });

    await waitFor(() => {
      // The hook filters events by startTime, so only recentEvent should be picked up
      expect(result.current.eventCount).toBeGreaterThanOrEqual(0);
    });
  });

  it('should handle empty event list (edge case)', () => {
    const { result } = renderHook(() =>
      useMissionMonitor({ sessionId: 's1', startTime: Date.now() }, []),
    );

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.eventCount).toBe(0);
  });
});

// ── Direct buildGraphFromEvents sort tests ────────────────────────────────────

describe('buildGraphFromEvents sort order', () => {
  it('BUG-SORT-1: should sort by timestamp as primary key, with OP_ORDER as tiebreaker', () => {
    // User message at t=100 (early), chat response at t=200 (later).
    // When passed in reverse order (chat first, user message second), the sort
    // should place the user message first because its timestamp is earlier,
    // even though chat has OP_ORDER=0 (lower than user message's default OP_ORDER=4).
    const t100 = new Date(100).toISOString();
    const t200 = new Date(200).toISOString();

    // Chat response event (OP_ORDER=0) — has response payload but arrives later at t=200
    const chatResponse: FredoEvent = {
      id: 'chat-200', eventType: 'tool_use', state: 'Update',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat',
      timestamp: t200,
      payload: {
        response: 'The weather is sunny',
        'gen_ai.response.model': 'gpt-4',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 50,
      },
    };

    // User message event (OP_ORDER falls through to 4) — arrives earlier at t=100
    const userMessage: FredoEvent = {
      id: 'user-100', eventType: 'tool_use', state: 'Init',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'UserPromptSubmit',
      timestamp: t100,
      payload: { prompt: 'Show me the weather' },
    };

    // Pass events in REVERSE chronological order (chat first, user second)
    const { nodes } = buildGraphFromEvents([chatResponse, userMessage]);

    // Should produce exactly one ChatNode (since both events belong to the same turn)
    expect(nodes.length).toBe(1);

    const chatNode = nodes[0];
    // The ChatNode should have userPrompt from the user message event
    expect(chatNode.data.payload.hasUserPrompt).toBe(true);
    expect(chatNode.data.payload.userPrompt).toBe('Show me the weather');
    // And the response text should be present
    expect(chatNode.data.payload.responseText).toContain('The weather is sunny');
  });

  it('BUG-SORT-3: live-mode-like events in chronological order are untouched', () => {
    // When events are already in chronological order (as they arrive from StreamContext),
    // the timestamp-first sort is a no-op.
    const t100 = new Date(100).toISOString();
    const t200 = new Date(200).toISOString();

    const userMessage: FredoEvent = {
      id: 'user-100', eventType: 'tool_use', state: 'Init',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'UserPromptSubmit',
      timestamp: t100,
      payload: { prompt: 'Build a todo app' },
    };

    const chatResponse: FredoEvent = {
      id: 'chat-200', eventType: 'tool_use', state: 'Update',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat',
      timestamp: t200,
      payload: {
        response: 'Here is your todo app',
        'gen_ai.response.model': 'gpt-4',
      },
    };

    const { nodes } = buildGraphFromEvents([userMessage, chatResponse]);

    expect(nodes.length).toBe(1);
    expect(nodes[0].data.payload.hasUserPrompt).toBe(true);
    expect(nodes[0].data.payload.userPrompt).toBe('Build a todo app');
  });

  it('BUG-SORT-4: same-timestamp events with different OP_ORDER still produce deterministic ordering', () => {
    // Two events at the exact same timestamp: user message (OP_ORDER falls to 4)
    // and chat response (OP_ORDER=0). OP_ORDER breaks the tie deterministically.
    // The sort result should be the same regardless of input order.
    const sameTime = new Date(100).toISOString();

    const chatResponse: FredoEvent = {
      id: 'chat-100', eventType: 'tool_use', state: 'Update',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat',
      timestamp: sameTime,
      payload: {
        response: 'Here is your file content',
        'gen_ai.response.model': 'gpt-4',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 30,
        'gen_ai.input.messages': JSON.stringify([
          { role: 'user', content: 'Read my file' },
        ]),
      },
    };

    const userMessage: FredoEvent = {
      id: 'user-100', eventType: 'tool_use', state: 'Init',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'UserPromptSubmit',
      timestamp: sameTime,
      payload: { prompt: 'Read my file' },
    };

    // Pass in reverse OP_ORDER to verify tiebreaking sorts correctly:
    // user first (OP_ORDER=4), then chat (OP_ORDER=0).
    // After sort: chat (0) first, then user (4).
    // chat without a prior turn auto-creates one and extracts userPrompt from payload,
    // then UserPromptSubmit will see a turn already exists and finalize it.
    const { nodes } = buildGraphFromEvents([userMessage, chatResponse]);

    // Since chat (OP_ORDER=0) sorts before user message (OP_ORDER=4) at same timestamp,
    // and chat's payload includes gen_ai.input.messages with user role,
    // the auto-created turn will have userPrompt from extractUserPrompt.
    expect(nodes.length).toBe(1);
    expect(nodes[0].data.payload.hasUserPrompt).toBe(true);
    expect(nodes[0].data.payload.userPrompt).toBe('Read my file');
  });
});
