/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';

// Mock StreamContext
const mockEvents: FredoEvent[] = [];
const mockClearStreamEvents = vi.fn();
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    events: mockEvents,
    isConnected: true,
    clearEvents: mockClearStreamEvents,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useDevModeStream } from '../useDevModeStream';
import type { EventSource } from '../../../../shared/contexts/StreamContext';

describe('useDevModeStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvents.length = 0;
  });

  it('should return initial state with empty events', () => {
    const { result } = renderHook(() => useDevModeStream());

    expect(result.current.events).toEqual([]);
    expect(result.current.eventTypes).toEqual([]);
    expect(result.current.sources).toEqual([]);
    expect(result.current.isConnected).toBe(true);
  });

  it('should accumulate events from stream (state transition)', async () => {
    const event: FredoEvent = {
      id: 'e1', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'test_tool', timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: { event_type: 'test_tool' },
    };

    const { result, rerender } = renderHook(() => useDevModeStream());

    // Push event and trigger re-render
    mockEvents.push(event);
    rerender();

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });
    expect(result.current.events[0].id).toBe('e1');
  });

  it('should derive event types from accumulated events', async () => {
    const event1: FredoEvent = {
      id: 'e1', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'type_a', timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: { event_type: 'type_a' },
    };
    const event2: FredoEvent = {
      id: 'e2', eventType: 'chat', state: 'Update',
      provider: 'open_code', transport: 'otlp_grpc', sessionId: 's1',
      toolName: 'invoke_agent', timestamp: new Date(Date.now() + 2000).toISOString(),
      payload: { model: 'gpt-4' },
      metadata: { signal: 'Span' },
    };

    const { result, rerender } = renderHook(() => useDevModeStream());

    mockEvents.push(event1, event2);
    rerender();

    await waitFor(() => {
      expect(result.current.eventTypes.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should derive sources from events', async () => {
    const hookEvent: FredoEvent = {
      id: 'e1', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'test', timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: null,
    };
    const otlpEvent: FredoEvent = {
      id: 'e2', eventType: 'chat', state: 'Update',
      provider: 'open_code', transport: 'otlp_grpc', sessionId: 's1',
      toolName: 'chat', timestamp: new Date(Date.now() + 2000).toISOString(),
      payload: null,
    };

    const { result, rerender } = renderHook(() => useDevModeStream());

    mockEvents.push(hookEvent, otlpEvent);
    rerender();

    await waitFor(() => {
      expect(result.current.sources.length).toBeGreaterThanOrEqual(1);
    });
    expect(result.current.sources).toContain('hook');
  });

  it('should clear events and reset', async () => {
    const event: FredoEvent = {
      id: 'e1', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'test', timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: null,
    };

    const { result, rerender } = renderHook(() => useDevModeStream());

    mockEvents.push(event);
    rerender();

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    act(() => {
      result.current.clearEvents();
    });

    expect(result.current.events).toEqual([]);
    expect(mockClearStreamEvents).toHaveBeenCalled();
  });

  it('should handle events without an id (edge case)', async () => {
    const event: FredoEvent = {
      id: '', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'edge', timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: null,
    };

    const { result, rerender } = renderHook(() => useDevModeStream());

    mockEvents.push(event);
    rerender();

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });
  });

  it('should not include events from before mount time (edge case)', () => {
    const oldEvent: FredoEvent = {
      id: 'old', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'old_tool', timestamp: '2023-01-01T00:00:00Z',
      payload: null,
    };

    // Push before hook mounts
    mockEvents.push(oldEvent);

    const { result } = renderHook(() => useDevModeStream());

    // Event is before mount time, should be filtered out
    expect(result.current.events).toHaveLength(0);
  });
});
