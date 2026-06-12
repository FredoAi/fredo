/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';

// Shared mutable state for mock events — declared at module level so both the
// StreamContext mock and the test blocks can access the same array reference.
const mockEvents: FredoEvent[] = [];

// Mock StreamContext — vi.mock is hoisted above imports, so we can reference
// mockEvents directly (it's a const declared before the hoisted block runs).
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    events: mockEvents,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

// Mock sessionStorage — use vi.hoisted() so the mock function is created BEFORE
// vi.mock is evaluated (vi.mock is hoisted to the top of the file).
const { mockPersistEvent } = vi.hoisted(() => ({
  mockPersistEvent: vi.fn(),
}));

vi.mock('../../lib/sessionStorage', () => ({
  persistEvent: mockPersistEvent,
}));

import { useMissionMonitorCapture } from '../useMissionMonitorCapture';

describe('useMissionMonitorCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvents.length = 0;
  });

  it('should not persist anything when there are no events', () => {
    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).not.toHaveBeenCalled();
  });

  it('should persist new events from the stream (state transition)', () => {
    const event: FredoEvent = {
      id: 'evt-1',
      eventType: 'tool_use',
      state: 'Response',
      provider: 'open_code',
      transport: 'hook',
      sessionId: 'session-1',
      toolName: 'chat',
      timestamp: new Date().toISOString(),
      payload: null,
    };

    mockEvents.push(event);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(1);
    expect(mockPersistEvent).toHaveBeenCalledWith(event);
  });

  it('should persist multiple unique events', () => {
    const event1: FredoEvent = {
      id: 'e1', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat', timestamp: '2024-01-01T00:00:00Z', payload: null,
    };
    const event2: FredoEvent = {
      id: 'e2', eventType: 'chat', state: 'Update',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'invoke_agent', timestamp: '2024-01-01T00:01:00Z', payload: null,
    };

    mockEvents.push(event1, event2);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(2);
    expect(mockPersistEvent).toHaveBeenCalledWith(event1);
    expect(mockPersistEvent).toHaveBeenCalledWith(event2);
  });

  it('should not persist duplicate events with the same id (edge case)', () => {
    const event: FredoEvent = {
      id: 'dup-id',
      eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat', timestamp: '2024-01-01T00:00:00Z', payload: null,
    };

    // Push the same event object — ref tracking won't detect this as the
    // hook specifically uses id-based dedup via seenKeysRef.
    mockEvents.push(event, event);

    renderHook(() => useMissionMonitorCapture());

    // Should only persist once
    expect(mockPersistEvent).toHaveBeenCalledTimes(1);
  });

  it('should handle events without an id by using composite key (edge case)', () => {
    const event: FredoEvent = {
      id: '', // empty id
      eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'chat', timestamp: '2024-01-01T00:00:00Z', payload: null,
    };

    mockEvents.push(event);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(1);
  });
});
