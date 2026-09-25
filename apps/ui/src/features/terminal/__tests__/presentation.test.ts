/**
 * TerminalPresentationStore tests (Spec #2947 ST-1).
 *
 * Exercises the module-scoped presentation store: the shared names block, the
 * absent/unrecognized → `new-window` normalization (R-4.1), the sync
 * store-first notify contract (R-1.1), raw-string persistence, idempotent
 * once-only dirty-guarded hydration (R-1.2), the bounded hydration gate flag,
 * and the `useSyncExternalStore` binding.
 *
 * settingsService is mocked (same seam as dockPositionStore.test.ts /
 * usePersistedSetting.test.ts) so tests stay host-agnostic and deterministic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DEFAULT_PRESENTATION,
  PRESENTATION_MODE_KEY,
  TERMINAL_INTENT_AVAILABLE_EVENT,
  getTerminalPresentation,
  hydrateTerminalPresentation,
  isTerminalPresentationHydrated,
  normalizePresentationMode,
  resetTerminalPresentationStoreForTests,
  setTerminalPresentation,
  subscribeTerminalPresentation,
  useTerminalPresentation,
} from '../presentation';

vi.mock('../../settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

import { settingsService } from '../../settings';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as ReturnType<typeof vi.fn>;

describe('terminalPresentationStore (Spec #2947 ST-1 — shared presentation contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTerminalPresentationStoreForTests();
    getMock.mockResolvedValue(DEFAULT_PRESENTATION);
    setMock.mockResolvedValue(undefined);
  });

  it('pins the shared names block (key, default, event)', () => {
    expect(PRESENTATION_MODE_KEY).toBe('terminal_presentation_mode');
    expect(DEFAULT_PRESENTATION).toBe('new-window');
    expect(TERMINAL_INTENT_AVAILABLE_EVENT).toBe('terminal-intent-available');
  });

  it('normalizes the two wire values', () => {
    expect(normalizePresentationMode('same-window')).toBe('same-window');
    expect(normalizePresentationMode('new-window')).toBe('new-window');
  });

  it('falls back to new-window for absent/unrecognized values (R-4.1)', () => {
    expect(normalizePresentationMode(undefined)).toBe('new-window');
    expect(normalizePresentationMode(null)).toBe('new-window');
    expect(normalizePresentationMode('')).toBe('new-window');
    expect(normalizePresentationMode('not-a-mode')).toBe('new-window');
    expect(normalizePresentationMode('SameWindow')).toBe('new-window');
    expect(normalizePresentationMode(42)).toBe('new-window');
  });

  it('defaults to new-window before any hydration or user write', () => {
    expect(getTerminalPresentation()).toBe('new-window');
    expect(isTerminalPresentationHydrated()).toBe(false);
  });

  it('setTerminalPresentation notifies synchronously, before persistence resolves', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalPresentation(listener);

    let resolveSet: () => void = () => {};
    setMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSet = resolve;
        }),
    );

    const p = setTerminalPresentation('same-window');
    // The store moved and subscribers were notified synchronously, before the
    // persistence promise can resolve.
    expect(getTerminalPresentation()).toBe('same-window');
    expect(listener).toHaveBeenCalledTimes(1);

    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSet();
    await p;
    expect(settled).toBe(true);
    unsubscribe();
  });

  it('persists the RAW string value (never JSON-quoted)', async () => {
    await setTerminalPresentation('same-window');
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith('terminal_presentation_mode', 'same-window');
    const arg = setMock.mock.calls[0][1];
    expect(arg).toBe('same-window');
    // Raw string — NOT `"same-window"`: serializeValue passes strings through
    // unquoted, so JSON.parse must throw.
    expect(() => JSON.parse(arg)).toThrow();
  });

  it('does not notify subscribers when re-selecting the current mode', async () => {
    const listener = vi.fn();
    subscribeTerminalPresentation(listener);
    await setTerminalPresentation('new-window'); // already the default
    expect(listener).not.toHaveBeenCalled();
    expect(getTerminalPresentation()).toBe('new-window');
  });

  it('hydrates the stored value once, flips the read, and marks hydrated', async () => {
    getMock.mockResolvedValue('same-window');
    const listener = vi.fn();
    subscribeTerminalPresentation(listener);

    expect(isTerminalPresentationHydrated()).toBe(false);
    await hydrateTerminalPresentation();

    expect(getTerminalPresentation()).toBe('same-window');
    expect(isTerminalPresentationHydrated()).toBe(true);
    expect(getMock).toHaveBeenCalledWith('terminal_presentation_mode', 'new-window');
    // Two notifies: one for the value change ('new-window' → 'same-window'),
    // one for the `hydrated` settle in the `finally` (the entry gate's wakeup).
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('hydration normalizes an unrecognized stored value to new-window (R-4.1)', async () => {
    getMock.mockResolvedValue('sideways');
    await hydrateTerminalPresentation();
    expect(getTerminalPresentation()).toBe('new-window');
    expect(isTerminalPresentationHydrated()).toBe(true);
  });

  it('hydration is idempotent — a second call is a no-op', async () => {
    getMock.mockResolvedValue('same-window');
    await hydrateTerminalPresentation();
    await hydrateTerminalPresentation();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getTerminalPresentation()).toBe('same-window');
  });

  it('never overwrites an in-flight user selection when hydration resolves late', async () => {
    let resolveRead: (v: string) => void = () => {};
    getMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const hydration = hydrateTerminalPresentation(); // kicks off the slow read
    await setTerminalPresentation('same-window'); // user acts first

    await act(async () => {
      resolveRead('new-window'); // stale persisted value arrives late
      await hydration;
    });

    // The user's selection survives — the late hydration never clobbers.
    expect(getTerminalPresentation()).toBe('same-window');
  });

  it('settles the hydrated flag even when the read rejects (bounded hold)', async () => {
    getMock.mockRejectedValue(new Error('no host'));
    await hydrateTerminalPresentation();
    expect(isTerminalPresentationHydrated()).toBe(true);
    expect(getTerminalPresentation()).toBe('new-window');
  });

  it('guards a concurrent double hydration (read starts once)', async () => {
    getMock.mockResolvedValue('same-window');
    await Promise.all([hydrateTerminalPresentation(), hydrateTerminalPresentation()]);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('useTerminalPresentation re-renders consumers when the mode changes', async () => {
    const { result } = renderHook(() => useTerminalPresentation());
    expect(result.current).toBe('new-window');

    await act(async () => {
      await setTerminalPresentation('same-window');
    });
    expect(result.current).toBe('same-window');
  });

  it('exposes the module reset (test-only) so state does not leak across tests', () => {
    void setTerminalPresentation('same-window');
    expect(getTerminalPresentation()).toBe('same-window');
    resetTerminalPresentationStoreForTests();
    expect(getTerminalPresentation()).toBe('new-window');
    expect(isTerminalPresentationHydrated()).toBe(false);
  });
});
