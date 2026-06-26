/**
 * Tests for useDeliverySessions — delivery-driven session derivation.
 *
 * Prerequisites: vitest, @testing-library/react, @testing-library/jest-dom, jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

import { useDeliverySessions } from '../useSessionHistory';

describe('useDeliverySessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDelivery(
    id: string,
    lifecycle: 'init' | 'update' | 'end',
    sessionId: string,
    correlationId: string,
  ): ContractDelivery {
    return {
      id,
      contractName: 'chat-node',
      lifecycle,
      key: { sessionId, correlationId },
      payload: { payload: {} },
      timestamp: new Date().toISOString(),
    };
  }

  it('should return empty sessions for no deliveries', () => {
    const { result } = renderHook(() =>
      useDeliverySessions([]),
    );

    expect(result.current.sessions).toEqual([]);
    expect(result.current.filteredSessions).toEqual([]);
    expect(result.current.selectedSessionId).toBeNull();
  });

  it('should derive sessions from deliveries', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'session-a', 'corr-1'),
      makeDelivery('d2', 'init', 'session-b', 'corr-2'),
      makeDelivery('d3', 'init', 'session-a', 'corr-3'),
    ];

    const { result } = renderHook(() =>
      useDeliverySessions(deliveries),
    );

    expect(result.current.sessions).toHaveLength(2);

    const sessionA = result.current.sessions.find((s) => s.sessionId === 'session-a');
    const sessionB = result.current.sessions.find((s) => s.sessionId === 'session-b');

    expect(sessionA).toBeDefined();
    expect(sessionA!.deliveryCount).toBe(2);
    expect(sessionB).toBeDefined();
    expect(sessionB!.deliveryCount).toBe(1);
  });

  it('should filter sessions by search filter', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'my-session', 'corr-1'),
      makeDelivery('d2', 'init', 'other-session', 'corr-2'),
    ];

    const { result } = renderHook(() =>
      useDeliverySessions(deliveries),
    );

    expect(result.current.filteredSessions).toHaveLength(2);

    act(() => {
      result.current.setSearchFilter('my-');
    });

    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].sessionId).toBe('my-session');
  });

  it('should support session selection', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'session-a', 'corr-1'),
    ];

    const { result } = renderHook(() =>
      useDeliverySessions(deliveries),
    );

    expect(result.current.selectedSessionId).toBeNull();

    act(() => {
      result.current.selectSession('session-a');
    });

    expect(result.current.selectedSessionId).toBe('session-a');
  });

  it('should return empty filtered sessions when no match', () => {
    const deliveries: ContractDelivery[] = [
      makeDelivery('d1', 'init', 'abc', 'corr-1'),
    ];

    const { result } = renderHook(() =>
      useDeliverySessions(deliveries),
    );

    act(() => {
      result.current.setSearchFilter('xyz');
    });

    expect(result.current.filteredSessions).toHaveLength(0);
  });

  it('should sort sessions newest-first', () => {
    const oldTs = new Date('2024-01-01').toISOString();
    const newTs = new Date('2024-06-01').toISOString();

    const deliveries: ContractDelivery[] = [
      {
        ...makeDelivery('d1', 'init', 'old-session', 'corr-1'),
        timestamp: oldTs,
      },
      {
        ...makeDelivery('d2', 'init', 'new-session', 'corr-2'),
        timestamp: newTs,
      },
    ];

    const { result } = renderHook(() =>
      useDeliverySessions(deliveries),
    );

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].sessionId).toBe('new-session');
    expect(result.current.sessions[1].sessionId).toBe('old-session');
  });
});
