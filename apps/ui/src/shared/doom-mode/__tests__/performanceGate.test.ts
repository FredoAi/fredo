/**
 * Spec #2970 ST-5 — pins the module-scoped `performanceGate` store (UI/UX §2).
 *
 * The store is the ONE bridge from `useDoomMode` to `LauncherShell`; it must be
 * readable outside React, idempotent on repeated sets, and notify subscribers
 * only on an actual change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isPerformanceGateActive,
  setPerformanceGateActive,
  subscribePerformanceGate,
} from '../performanceGate';

beforeEach(() => {
  setPerformanceGateActive(false);
});

describe('performanceGate', () => {
  it('defaults to inactive', () => {
    expect(isPerformanceGateActive()).toBe(false);
  });

  it('sets and clears, notifying subscribers only on an actual change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePerformanceGate(listener);

    setPerformanceGateActive(true);
    expect(isPerformanceGateActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // Idempotent re-set — no extra notification.
    setPerformanceGateActive(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setPerformanceGateActive(false);
    expect(isPerformanceGateActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setPerformanceGateActive(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('supports multiple independent subscribers', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribePerformanceGate(first);
    const offSecond = subscribePerformanceGate(second);

    setPerformanceGateActive(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    offFirst();
    setPerformanceGateActive(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
  });
});
