/**
 * BackgroundStore tests (Spec #2899 ST-2).
 *
 * Exercises the module-scoped background store: sync module reads, the
 * useSyncExternalStore subscriber contract, immediate cross-consumer notify on
 * select, persistence through settingsService (raw id string, NOT
 * JSON-quoted), idempotent once-only + dirty-guarded hydration, lenient
 * normalization of unknown/stale/malformed stored values to `'none'` (never
 * throws), and the test-only reset.
 *
 * settingsService is mocked (same seam as dockPositionStore.test.ts /
 * usePersistedSetting.test.ts) so tests stay host-agnostic and deterministic.
 * The registry guard is the REAL one (ST-1) — the normalization tests must
 * exercise the actual `isBackgroundId` contract, not a stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  getBackgroundId,
  selectBackground,
  hydrateBackground,
  useBackgroundId,
  subscribeBackground,
  resetBackgroundStoreForTests,
  BACKGROUND_SETTING_KEY,
  DEFAULT_BACKGROUND_ID,
  type BackgroundId,
} from '../backgroundStore';

vi.mock('../../../../settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

import { settingsService } from '../../../../settings';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as ReturnType<typeof vi.fn>;

describe('backgroundStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBackgroundStoreForTests();
    getMock.mockResolvedValue(DEFAULT_BACKGROUND_ID);
  });

  it('defaults to none before any hydration or user write', () => {
    expect(BACKGROUND_SETTING_KEY).toBe('Fredo_desktop_background');
    expect(DEFAULT_BACKGROUND_ID).toBe('none');
    expect(getBackgroundId()).toBe('none');
  });

  it('selectBackground notifies synchronously and persists the raw id string', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBackground(listener);

    // Returns a promise — the synchronous store move must happen before it resolves.
    let done = false;
    const p = selectBackground('aurora').then(() => {
      done = true;
    });
    expect(getBackgroundId()).toBe('aurora');
    expect(listener).toHaveBeenCalledTimes(1);

    await p;
    expect(done).toBe(true);
    expect(setMock).toHaveBeenCalledWith('Fredo_desktop_background', 'aurora');
    // Raw string — NOT JSON-quoted (serializeValue passes strings through
    // unquoted; a JSON-quoted `"aurora"` would parse cleanly instead).
    const arg = setMock.mock.calls[0][1];
    expect(arg).toBe('aurora');
    expect(() => JSON.parse(arg)).toThrow();

    unsubscribe();
  });

  it('does not notify subscribers when re-selecting the current id', async () => {
    const listener = vi.fn();
    subscribeBackground(listener);
    await selectBackground('none'); // already none
    expect(listener).not.toHaveBeenCalled();
    expect(getBackgroundId()).toBe('none');
  });

  it('hydrates a stored valid id once and flips the module read + notifies', async () => {
    getMock.mockResolvedValue('nebula');

    const listener = vi.fn();
    subscribeBackground(listener);
    expect(getBackgroundId()).toBe('none');

    await hydrateBackground();

    expect(getBackgroundId()).toBe('nebula');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('Fredo_desktop_background', 'none');
  });

  it.each(['__nope__', '', 'not-a-background', '{"id":"aurora"}'])(
    'normalizes a stored unknown value (%j) to none without throwing',
    async (stored) => {
      getMock.mockResolvedValue(stored);
      await expect(hydrateBackground()).resolves.toBeUndefined();
      expect(getBackgroundId()).toBe('none');
    },
  );

  it('normalizes an unknown value passed to selectBackground to none and persists the fallback', async () => {
    await expect(selectBackground('__nope__')).resolves.toBeUndefined();
    expect(getBackgroundId()).toBe('none');
    expect(setMock).toHaveBeenCalledWith('Fredo_desktop_background', 'none');
  });

  it('hydration is idempotent — a second call is a no-op and cannot overwrite a later user selection', async () => {
    getMock.mockResolvedValue('mesh');

    await hydrateBackground();
    expect(getBackgroundId()).toBe('mesh');

    // User flips to none → a re-hydration must NOT clobber it back to 'mesh'.
    await selectBackground('none');
    await hydrateBackground();
    expect(getBackgroundId()).toBe('none');
    // settingsService.get ran exactly once across both hydration calls.
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('never overwrites an in-flight user selection when hydration resolves late', async () => {
    // Simulate a slow async read that resolves AFTER the user already chose.
    let resolveRead: (v: string) => void = () => {};
    getMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const hydration = hydrateBackground(); // kicks off the slow read
    await selectBackground('aurora'); // user acts first

    await act(async () => {
      resolveRead('nebula'); // the stale persisted value arrives late
      await hydration;
    });

    // The user's selection survives — the late hydration never clobbers.
    expect(getBackgroundId()).toBe('aurora');
  });

  it('useBackgroundId re-renders consumers when the selection changes (sync store contract)', () => {
    const { result } = renderHook(() => useBackgroundId());
    expect(result.current).toBe('none');

    act(() => {
      void selectBackground('halo');
    });
    expect(result.current).toBe('halo');

    act(() => {
      void selectBackground('none');
    });
    expect(result.current).toBe('none');
  });

  it('exposes the module reset (test-only) so state does not leak across tests', () => {
    void selectBackground('topography');
    expect(getBackgroundId()).toBe('topography');
    resetBackgroundStoreForTests();
    expect(getBackgroundId()).toBe(DEFAULT_BACKGROUND_ID);
    expect(getBackgroundId()).not.toBe('topography');
  });

  it('exposes the closed BackgroundId union through the store API', () => {
    const ids: BackgroundId[] = [
      'none',
      'aurora',
      'nebula',
      'mesh',
      'topography',
      'constellation',
      'halo',
    ];
    for (const id of ids) {
      expect(typeof id).toBe('string');
    }
  });
});
