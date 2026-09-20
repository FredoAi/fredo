/**
 * DockPositionStore tests (Spec #2848 ST-1).
 *
 * Exercises the module-scoped dock-position store: sync module reads, the
 * useSyncExternalStore subscriber contract, immediate cross-consumer notify on
 * set, persistence through settingsService (raw string value, NOT JSON-quoted),
 * idempotent once-only hydration, hydration-never-clobbers-user-selection, and
 * the jsdom default ('sidebar' — no Tauri host → settingsService.get falls back
 * to empty localStorage → default).
 *
 * settingsService is mocked (same seam as usePersistedSetting.test.ts /
 * ThemeProvider.test.tsx) so tests stay host-agnostic and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  getDockPosition,
  setDockPosition,
  hydrateDockPosition,
  useDockPosition,
  subscribeDockPosition,
  resetDockPositionStoreForTests,
  DOCK_POSITION_KEY,
  DEFAULT_DOCK_POSITION,
  type DockPosition,
} from '../dockPositionStore';

vi.mock('../../../../settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

import { settingsService } from '../../../../settings';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as ReturnType<typeof vi.fn>;

describe('dockPositionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDockPositionStoreForTests();
    getMock.mockResolvedValue(DEFAULT_DOCK_POSITION);
  });

  it('defaults to sidebar before any hydration or user write', () => {
    expect(DOCK_POSITION_KEY).toBe('Fredo_dock_position');
    expect(DEFAULT_DOCK_POSITION).toBe('sidebar');
    expect(getDockPosition()).toBe('sidebar');
  });

  it('setDockPosition updates the sync read + notifies subscribers immediately', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDockPosition(listener);

    // Returns a promise — the synchronous store move must happen before it resolves.
    let done = false;
    const p = setDockPosition('bottom').then(() => {
      done = true;
    });
    expect(getDockPosition()).toBe('bottom');
    expect(listener).toHaveBeenCalledTimes(1);

    return p.then(() => {
      expect(done).toBe(true);
      unsubscribe();
    });
  });

  it('persists the RAW string value (never JSON-quoted) through settingsService.set', async () => {
    await setDockPosition('bottom');
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith('Fredo_dock_position', 'bottom');
    expect(setMock).toHaveBeenLastCalledWith('Fredo_dock_position', 'bottom');
    // Raw string — NOT `"bottom"` (serializeValue passes strings through unquoted).
    const arg = setMock.mock.calls[0][1];
    expect(arg).toBe('bottom');
    // Raw string — NOT `"bottom"`: serializeValue passes strings through
    // unquoted, so a raw bareword is NOT valid JSON (JSON.parse must throw —
    // a JSON-quoted `"bottom"` would parse cleanly instead).
    expect(() => JSON.parse(arg)).toThrow();
  });

  it('does not notify subscribers when re-selecting the current position', async () => {
    const listener = vi.fn();
    subscribeDockPosition(listener);
    await setDockPosition('sidebar'); // already sidebar
    expect(listener).not.toHaveBeenCalled();
    expect(getDockPosition()).toBe('sidebar');
  });

  it('hydrates the stored value once and flips the module read + notifies', async () => {
    getMock.mockResolvedValue('bottom');

    const listener = vi.fn();
    subscribeDockPosition(listener);
    expect(getDockPosition()).toBe('sidebar');

    await hydrateDockPosition();

    expect(getDockPosition()).toBe('bottom');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('Fredo_dock_position', 'sidebar');
  });

  it('hydration is idempotent — a second call is a no-op and cannot overwrite a later user selection', async () => {
    getMock.mockResolvedValue('bottom');

    await hydrateDockPosition();
    expect(getDockPosition()).toBe('bottom');

    // User flips to sidebar → a re-hydration must NOT clobber it back to 'bottom'.
    await setDockPosition('sidebar');
    await hydrateDockPosition();
    expect(getDockPosition()).toBe('sidebar');
    // settingsService.get ran exactly once across both hydration calls.
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('never overwrites an in-flight user selection when hydration resolves late', async () => {
    // Simulate a slow async read that resolves AFTER the user already chose.
    let resolveRead: (v: DockPosition) => void = () => {};
    getMock.mockImplementation(
      () =>
        new Promise<DockPosition>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const hydration = hydrateDockPosition(); // kicks off the slow read
    await setDockPosition('bottom'); // user acts first

    await act(async () => {
      resolveRead('sidebar'); // the stale persisted value arrives late
      await hydration;
    });

    // The user's selection survives — the late hydration never clobbers.
    expect(getDockPosition()).toBe('bottom');
  });

  it('falls back to the stored value when settingsService.get resolves a non-literal', async () => {
    // Unknown/corrupt persisted value degrades to the DEFAULT (graceful).
    getMock.mockResolvedValue('sideways' as DockPosition);
    await hydrateDockPosition();
    expect(getDockPosition()).toBe('sidebar');
  });

  it('useDockPosition re-renders consumers when the position changes (sync store contract)', async () => {
    const { result } = renderHook(() => useDockPosition());
    expect(result.current).toBe('sidebar');

    act(() => {
      void setDockPosition('bottom');
    });
    expect(result.current).toBe('bottom');

    act(() => {
      void setDockPosition('sidebar');
    });
    expect(result.current).toBe('sidebar');
  });

  it('exposes the module reset (test-only) so state does not leak across tests', () => {
    void setDockPosition('bottom');
    expect(getDockPosition()).toBe('bottom');
    resetDockPositionStoreForTests();
    expect(getDockPosition()).toBe('sidebar');
    expect(getDockPosition()).not.toBe('bottom');
  });
});
