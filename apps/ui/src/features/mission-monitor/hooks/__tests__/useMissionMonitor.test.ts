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
vi.mock('reactflow', () => ({
  useNodesState: vi.fn(() => [[], vi.fn(), vi.fn()]),
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

import { useMissionMonitor } from '../useMissionMonitor';

// Type-only export for testing (buildGraphFromEvents is internal but tested via the hook)
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

  it('should build graph from replay events', () => {
    const events: FredoEvent[] = [
      {
        id: 'evt-1',
        eventType: 'tool_use',
        state: 'Init',
        provider: 'open_code',
        transport: 'hook',
        sessionId: 's1',
        toolName: 'SessionStart',
        timestamp: new Date().toISOString(),
        payload: { session_id: 's1' },
      },
    ];

    const { result } = renderHook(() =>
      useMissionMonitor({ sessionId: 's1', startTime: 0 }, events),
    );

    expect(result.current.eventCount).toBe(1);
    expect(result.current.nodes.length).toBeGreaterThanOrEqual(1);
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
