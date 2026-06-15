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
import { resetSeenMsgIds } from '../../MissionMonitorFeature';

describe('useMissionMonitorCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvents.length = 0;
    resetSeenMsgIds();
  });

  it('should not persist anything when there are no events', () => {
    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).not.toHaveBeenCalled();
  });

  it('should persist message.updated (user) events from the stream', () => {
    const event: FredoEvent = {
      id: 'evt-1',
      eventType: 'tool_use',
      state: 'Response',
      provider: 'open_code',
      transport: 'hook',
      sessionId: 'session-1',
      toolName: 'message.updated',
      timestamp: new Date().toISOString(),
      payload: { properties: { info: { role: 'user', id: 'msg-1' } } },
    };

    mockEvents.push(event);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(1);
    expect(mockPersistEvent).toHaveBeenCalledWith(event);
  });

  it('should persist message.updated (assistant) events', () => {
    const event: FredoEvent = {
      id: 'evt-2',
      eventType: 'tool_use',
      state: 'Response',
      provider: 'open_code',
      transport: 'hook',
      sessionId: 'session-1',
      toolName: 'message.updated',
      timestamp: new Date().toISOString(),
      payload: { properties: { info: { role: 'assistant', id: 'msg-2' } } },
    };

    mockEvents.push(event);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(1);
    expect(mockPersistEvent).toHaveBeenCalledWith(event);
  });

  it('should persist complete message.part.updated events', () => {
    const event: FredoEvent = {
      id: 'evt-3',
      eventType: 'tool_use',
      state: 'Update',
      provider: 'open_code',
      transport: 'hook',
      sessionId: 'session-1',
      toolName: 'message.part.updated',
      timestamp: new Date().toISOString(),
      payload: { properties: { part: { id: 'part-1', type: 'text', text: 'Hello', time: { end: new Date().toISOString() } } } },
    };

    mockEvents.push(event);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(1);
    expect(mockPersistEvent).toHaveBeenCalledWith(event);
  });

  it('should reject message.part.updated without part.time.end (streaming delta)', () => {
    const event: FredoEvent = {
      id: 'evt-4',
      eventType: 'tool_use',
      state: 'Update',
      provider: 'open_code',
      transport: 'hook',
      sessionId: 'session-1',
      toolName: 'message.part.updated',
      timestamp: new Date().toISOString(),
      payload: { properties: { part: { id: 'part-2', type: 'text', text: 'Hello', time: { start: new Date().toISOString() } } } },
    };

    mockEvents.push(event);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).not.toHaveBeenCalled();
  });

  it('should persist multiple unique events of different types', () => {
    const event1: FredoEvent = {
      id: 'e1', eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'message.updated', timestamp: '2024-01-01T00:00:00Z',
      payload: { properties: { info: { role: 'user', id: 'msg-1' } } },
    };
    const event2: FredoEvent = {
      id: 'e2', eventType: 'tool_use', state: 'Update',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'message.part.updated', timestamp: '2024-01-01T00:01:00Z',
      payload: { properties: { part: { id: 'part-1', type: 'text', text: 'Hello', time: { end: new Date().toISOString() } } } },
    };

    mockEvents.push(event1, event2);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(2);
  });

  it('should not persist duplicate events with the same id (edge case)', () => {
    const event: FredoEvent = {
      id: 'dup-id',
      eventType: 'tool_use', state: 'Response',
      provider: 'open_code', transport: 'hook', sessionId: 's1',
      toolName: 'message.updated', timestamp: '2024-01-01T00:00:00Z',
      payload: { properties: { info: { role: 'user', id: 'msg-1' } } },
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
      toolName: 'message.updated', timestamp: '2024-01-01T00:00:00Z',
      payload: { properties: { info: { role: 'user', id: 'msg-1' } } },
    };

    mockEvents.push(event);

    renderHook(() => useMissionMonitorCapture());

    expect(mockPersistEvent).toHaveBeenCalledTimes(1);
  });
});
