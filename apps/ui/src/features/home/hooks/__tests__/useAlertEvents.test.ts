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

// Mock StreamContext
const mockGetEventsByTool = vi.fn();
const mockGetLatestEventByTool = vi.fn();
vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    events: [],
    getEventsByTool: mockGetEventsByTool,
    getLatestEventByTool: mockGetLatestEventByTool,
  })),
  StreamProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useAlertEvents } from '../useAlertEvents';

describe('useAlertEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty arrays and undefined latest when no alerts', () => {
    mockGetEventsByTool.mockReturnValue([]);
    mockGetLatestEventByTool.mockReturnValue(undefined);

    const { result } = renderHook(() => useAlertEvents());

    expect(result.current.alertEvents).toEqual([]);
    expect(result.current.latestAlert).toBeUndefined();
  });

  it('should return alert events from the stream (state transition)', () => {
    const mockAlert: FredoEvent = {
      id: 'alert-1',
      eventType: 'tool_use',
      state: 'Response',
      provider: 'open_code',
      transport: 'hook',
      sessionId: 'session-1',
      timestamp: new Date().toISOString(),
      toolName: 'Fredo_ui_alert',
      payload: {
        alertId: 'a1',
        text: 'Test alert',
        isAlert: true,
        needsConfirmation: false,
        timestamp: new Date().toISOString(),
        sent: true,
        message: 'Test alert',
      },
    };

    mockGetEventsByTool.mockReturnValue([mockAlert]);
    mockGetLatestEventByTool.mockReturnValue(mockAlert);

    const { result } = renderHook(() => useAlertEvents());

    expect(result.current.alertEvents).toHaveLength(1);
    expect(result.current.alertEvents[0].toolName).toBe('Fredo_ui_alert');
    expect(result.current.latestAlert?.toolName).toBe('Fredo_ui_alert');
    // Use 'payload' via the underlying FredoEvent since AlertEvent extends StreamEvent
    const latestPayload = result.current.latestAlert as unknown as FredoEvent;
    expect(latestPayload.payload?.text).toBe('Test alert');
  });

  it('should return multiple alert events', () => {
    const alerts: FredoEvent[] = [
      {
        id: 'a1', eventType: 'tool_use', state: 'Response',
        provider: 'open_code', transport: 'hook', sessionId: 's1',
        timestamp: '2024-01-01T00:00:00Z', toolName: 'Fredo_ui_alert',
        payload: { alertId: 'a1', text: 'First', isAlert: true, needsConfirmation: false, timestamp: '', sent: true, message: 'First' },
      },
      {
        id: 'a2', eventType: 'tool_use', state: 'Response',
        provider: 'open_code', transport: 'hook', sessionId: 's1',
        timestamp: '2024-01-01T00:01:00Z', toolName: 'Fredo_ui_alert',
        payload: { alertId: 'a2', text: 'Second', isAlert: true, needsConfirmation: false, timestamp: '', sent: true, message: 'Second' },
      },
    ];

    mockGetEventsByTool.mockReturnValue(alerts);
    mockGetLatestEventByTool.mockReturnValue(alerts[1]);

    const { result } = renderHook(() => useAlertEvents());

    expect(result.current.alertEvents).toHaveLength(2);
    const latestPayload = result.current.latestAlert as unknown as FredoEvent;
    expect(latestPayload.payload?.alertId).toBe('a2');
  });

  it('should handle missing/undefined events (edge case)', () => {
    mockGetEventsByTool.mockReturnValue(undefined);
    mockGetLatestEventByTool.mockReturnValue(undefined);

    const { result } = renderHook(() => useAlertEvents());

    expect(result.current.alertEvents).toBeUndefined();
    expect(result.current.latestAlert).toBeUndefined();
  });
});
