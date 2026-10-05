/**
 * Spec #2971 ST-2 — pins the module-scoped `doomVisual` store.
 *
 * The store is the ONE bridge from `useDoomMode` (ST-3) to the theme layer
 * (ST-4) and the armor overlay (ST-5); it must be readable outside React,
 * idempotent on repeated sets, and notify subscribers only on an actual change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isDoomVisualEngaged,
  setDoomVisualEngaged,
  subscribeDoomVisual,
} from '../doomVisual';

beforeEach(() => {
  setDoomVisualEngaged(false);
});

describe('doomVisual', () => {
  it('defaults to disengaged', () => {
    expect(isDoomVisualEngaged()).toBe(false);
  });

  it('sets and clears, notifying subscribers only on an actual change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDoomVisual(listener);

    setDoomVisualEngaged(true);
    expect(isDoomVisualEngaged()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // Idempotent re-set — no extra notification.
    setDoomVisualEngaged(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setDoomVisualEngaged(false);
    expect(isDoomVisualEngaged()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setDoomVisualEngaged(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('supports multiple independent subscribers', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeDoomVisual(first);
    const offSecond = subscribeDoomVisual(second);

    setDoomVisualEngaged(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    offFirst();
    setDoomVisualEngaged(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
  });
});
