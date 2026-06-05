/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock sessionStorage
const mockSessions = [
  { sessionId: 's1', label: 'Session 1', startTime: 1704067200000, eventCount: 5 },
  { sessionId: 's2', label: 'Session 2', startTime: 1704153600000, eventCount: 3 },
];

const mockLoadSessions = vi.fn(() => mockSessions);
const mockGetSessionEvents = vi.fn();
const mockDeleteSession = vi.fn();
const mockFinalizeSession = vi.fn();

vi.mock('../../lib/sessionStorage', () => ({
  loadSessions: () => mockLoadSessions(),
  getSessionEvents: () => mockGetSessionEvents(),
  deleteSession: (id: string) => mockDeleteSession(id),
  finalizeSession: (id: string) => mockFinalizeSession(id),
}));

import { useSessionHistory } from '../useSessionHistory';

describe('useSessionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return sessions on mount', () => {
    const { result } = renderHook(() => useSessionHistory());

    expect(result.current.sessions).toEqual(mockSessions);
    expect(result.current.sessions).toHaveLength(2);
  });

  it('should refresh sessions from storage', () => {
    const { result } = renderHook(() => useSessionHistory());

    const updatedSessions = [mockSessions[0]];
    mockLoadSessions.mockReturnValue(updatedSessions);

    act(() => {
      result.current.refreshSessions();
    });

    expect(mockLoadSessions).toHaveBeenCalledTimes(2); // once on mount, once on refresh
    expect(result.current.sessions).toEqual(updatedSessions);
  });

  it('should delete a session', () => {
    const { result } = renderHook(() => useSessionHistory());

    act(() => {
      result.current.deleteSession('s1');
    });

    expect(mockDeleteSession).toHaveBeenCalledWith('s1');
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].sessionId).toBe('s2');
  });

  it('should finalize a session and reload', () => {
    const { result } = renderHook(() => useSessionHistory());

    const finalizedSessions = [
      { ...mockSessions[0], endTime: Date.now() },
      mockSessions[1],
    ];
    mockLoadSessions.mockReturnValue(finalizedSessions);

    act(() => {
      result.current.finalizeSession('s1');
    });

    expect(mockFinalizeSession).toHaveBeenCalledWith('s1');
    expect(result.current.sessions[0].endTime).toBeGreaterThan(0);
  });

  it('should handle deleting a non-existent session (edge case)', () => {
    const { result } = renderHook(() => useSessionHistory());

    act(() => {
      result.current.deleteSession('nonexistent');
    });

    expect(mockDeleteSession).toHaveBeenCalledWith('nonexistent');
    expect(result.current.sessions).toHaveLength(2);
  });

  it('should return empty sessions when storage is empty', () => {
    mockLoadSessions.mockReturnValue([]);

    const { result } = renderHook(() => useSessionHistory());

    expect(result.current.sessions).toEqual([]);
  });
});
