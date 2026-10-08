/**
 * appPresentationStore tests (Spec #2955 ST-2).
 *
 * Pins the generalized per-app presentation store that supersedes #2947's
 * Terminal-only store:
 *   - the shared names block (canonical + legacy keys, default);
 *   - `normalizeAppPresentation` absent/unrecognized → `same-window` (R-4);
 *   - map hydration + per-value normalization, tolerant of malformed JSON;
 *   - the one-way legacy `terminal_presentation_mode` migration (never rewritten);
 *   - idempotent, bounded hydration (settles even on a read failure);
 *   - the OPTIMISTIC write contract: `setAppPresentation` moves the module store
 *     synchronously (notifies before the KV write) and restores the prior value
 *     on a rejected write (binding adjudication #8);
 *   - the factory (`isMultiWindow`) defensive read;
 *   - the `useSyncExternalStore` bindings.
 *
 * `controlSettingAccessor` (the control-plane KV seam) and `applicationRegistry`
 * are mocked, so the suite stays host-agnostic and deterministic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../controlSettingAccessor', () => ({
  getControlSetting: vi.fn(),
  saveControlSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../applications/applicationRegistry', () => ({
  getApplications: vi.fn(() => []),
}));

import {
  APP_PRESENTATION_KEY,
  DEFAULT_APP_PRESENTATION,
  LEGACY_TERMINAL_PRESENTATION_KEY,
  getAppPresentation,
  getAppPresentationSnapshot,
  hydrateAppPresentation,
  isAppPresentationHydrated,
  normalizeAppPresentation,
  resetAppPresentationStoreForTests,
  setAppPresentation,
  subscribeAppPresentation,
  useAppPresentation,
  useAppPresentationMap,
} from '../appPresentationStore';
import { getControlSetting, saveControlSetting } from '../controlSettingAccessor';
import { getApplications } from '../../../applications/applicationRegistry';

const getMock = getControlSetting as unknown as ReturnType<typeof vi.fn>;
const setMock = saveControlSetting as unknown as ReturnType<typeof vi.fn>;
const getApplicationsMock = getApplications as unknown as ReturnType<typeof vi.fn>;

/**
 * Route the control-plane accessor by key: the canonical key returns the RAW
 * map JSON, the legacy key returns the RAW mode. `null`/`undefined` = absent.
 */
function stored(map: unknown, legacy: unknown = null): void {
  const rawMap = map == null ? null : typeof map === 'string' ? map : JSON.stringify(map);
  const rawLegacy =
    legacy == null ? null : typeof legacy === 'string' ? legacy : JSON.stringify(legacy);
  getMock.mockImplementation(async (key: string) =>
    key === APP_PRESENTATION_KEY ? rawMap : rawLegacy,
  );
}

describe('appPresentationStore (Spec #2955 ST-2 — generalized per-app presentation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAppPresentationStoreForTests();
    getApplicationsMock.mockReturnValue([]);
    setMock.mockResolvedValue(undefined);
    stored({});
  });

  it('pins the shared names block (canonical key, legacy key, default)', () => {
    expect(APP_PRESENTATION_KEY).toBe('app_window_presentation');
    expect(LEGACY_TERMINAL_PRESENTATION_KEY).toBe('terminal_presentation_mode');
    expect(DEFAULT_APP_PRESENTATION).toBe('same-window');
  });

  it('normalizes the two wire values and trims whitespace', () => {
    expect(normalizeAppPresentation('same-window')).toBe('same-window');
    expect(normalizeAppPresentation('new-window')).toBe('new-window');
    expect(normalizeAppPresentation(' same-window ')).toBe('same-window');
    expect(normalizeAppPresentation('\tnew-window\n')).toBe('new-window');
  });

  it('falls back to same-window for absent/unrecognized values (R-4)', () => {
    expect(normalizeAppPresentation(undefined)).toBe('same-window');
    expect(normalizeAppPresentation(null)).toBe('same-window');
    expect(normalizeAppPresentation('')).toBe('same-window');
    expect(normalizeAppPresentation('   ')).toBe('same-window');
    expect(normalizeAppPresentation('not-a-mode')).toBe('same-window');
    expect(normalizeAppPresentation('not-json')).toBe('same-window');
    expect(normalizeAppPresentation('SameWindow')).toBe('same-window');
    expect(normalizeAppPresentation(42)).toBe('same-window');
    expect(normalizeAppPresentation(['new-window'])).toBe('same-window');
    expect(normalizeAppPresentation({ mode: 'new-window' })).toBe('same-window');
  });

  it('defaults every app to same-window before any hydration or write', () => {
    expect(getAppPresentation('terminal')).toBe('same-window');
    expect(getAppPresentation('doom')).toBe('same-window');
    expect(getAppPresentationSnapshot()).toEqual({});
    expect(isAppPresentationHydrated()).toBe(false);
  });

  it('hydrates the persisted map, normalizing each entry (R-1/R-4)', async () => {
    stored({ terminal: 'new-window', doom: 'same-window', bogus: 'sideways' });
    await hydrateAppPresentation();

    expect(getAppPresentation('terminal')).toBe('new-window');
    expect(getAppPresentation('doom')).toBe('same-window');
    expect(getAppPresentation('bogus')).toBe('same-window');
    expect(getAppPresentation('missing')).toBe('same-window');
    expect(getAppPresentationSnapshot()).toEqual({
      terminal: 'new-window',
      doom: 'same-window',
      bogus: 'same-window',
    });
    expect(isAppPresentationHydrated()).toBe(true);
  });

  it('tolerates a malformed / non-object persisted map (R-4)', async () => {
    stored('not-json');
    await hydrateAppPresentation();
    expect(getAppPresentationSnapshot()).toEqual({});
    expect(isAppPresentationHydrated()).toBe(true);

    resetAppPresentationStoreForTests();
    stored(['new-window']);
    await hydrateAppPresentation();
    expect(getAppPresentationSnapshot()).toEqual({});
  });

  it('migrates the legacy terminal key one-way when the map lacks terminal (R-1/R-4)', async () => {
    stored({}, 'new-window');
    await hydrateAppPresentation();

    expect(getAppPresentation('terminal')).toBe('new-window');
    // One-way: the legacy key is NEVER rewritten, and hydrate never writes back.
    expect(setMock).not.toHaveBeenCalled();
  });

  it('does not migrate the legacy value when the map already has terminal', async () => {
    stored({ terminal: 'same-window' }, 'new-window');
    await hydrateAppPresentation();
    expect(getAppPresentation('terminal')).toBe('same-window');
  });

  it('does not create a terminal entry from an unrecognized/absent legacy value', async () => {
    stored({}, 'sideways');
    await hydrateAppPresentation();
    expect(getAppPresentation('terminal')).toBe('same-window');
    expect(getAppPresentationSnapshot()).toEqual({});
  });

  it('resolves an authoritative absent read to the default and never consults localStorage (B-2)', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    stored(null, null);
    await hydrateAppPresentation();

    expect(getAppPresentationSnapshot()).toEqual({});
    expect(getAppPresentation('terminal')).toBe('same-window');
    expect(getAppPresentation('doom')).toBe('same-window');
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it('routes the canonical and legacy reads through the control-plane accessor (B-2/B-3)', async () => {
    stored(null, 'new-window');
    await hydrateAppPresentation();

    expect(getAppPresentation('terminal')).toBe('new-window');
    expect(getMock).toHaveBeenNthCalledWith(1, APP_PRESENTATION_KEY);
    expect(getMock).toHaveBeenNthCalledWith(2, LEGACY_TERMINAL_PRESENTATION_KEY);
    // One-way migration never writes the legacy key back.
    expect(setMock).not.toHaveBeenCalled();
  });

  it('is idempotent — a second hydrate reuses the settled read', async () => {
    stored({ terminal: 'new-window' });
    await hydrateAppPresentation();
    await hydrateAppPresentation();
    // Map read once (the legacy read is skipped when terminal is present).
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getAppPresentation('terminal')).toBe('new-window');
  });

  it('settles the hydrated flag even when the read rejects (bounded hold)', async () => {
    getMock.mockRejectedValue(new Error('no host'));
    await hydrateAppPresentation();
    expect(isAppPresentationHydrated()).toBe(true);
    expect(getAppPresentationSnapshot()).toEqual({});
  });

  it('setAppPresentation moves the store synchronously and notifies before the write resolves', async () => {
    const listener = vi.fn();
    subscribeAppPresentation(listener);

    let resolveSet: () => void = () => {};
    setMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSet = resolve;
        }),
    );

    const p = setAppPresentation('terminal', 'new-window');
    // Optimistic: the store moved and subscribers were notified synchronously,
    // before the persistence promise can settle.
    expect(getAppPresentation('terminal')).toBe('new-window');
    expect(listener).toHaveBeenCalledTimes(1);

    let settled = false;
    void p.then(() => {
      settled = true;
    });

    // Wait until the store actually reaches the (pending) persistence write.
    await vi.waitFor(() => expect(setMock).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    resolveSet();
    await p;
    expect(settled).toBe(true);
  });

  it('persists the map as a RAW JSON string under the canonical key', async () => {
    await setAppPresentation('terminal', 'new-window');
    expect(setMock).toHaveBeenCalledTimes(1);
    const [key, value] = setMock.mock.calls[0];
    expect(key).toBe(APP_PRESENTATION_KEY);
    expect(typeof value).toBe('string');
    expect(JSON.parse(value)).toEqual({ terminal: 'new-window' });
  });

  it('merges other apps into the persisted map (no data loss)', async () => {
    stored({ doom: 'new-window' });
    await setAppPresentation('terminal', 'new-window');
    expect(JSON.parse(setMock.mock.calls[0][1])).toEqual({
      doom: 'new-window',
      terminal: 'new-window',
    });
  });

  it('restores the prior (absent) value and rejects when the write fails', async () => {
    setMock.mockRejectedValue(new Error('nope'));
    const listener = vi.fn();
    subscribeAppPresentation(listener);

    await expect(setAppPresentation('terminal', 'new-window')).rejects.toThrow('nope');

    expect(getAppPresentation('terminal')).toBe('same-window');
    expect(getAppPresentationSnapshot()).toEqual({});
    // Optimistic move + rollback both notified (hydration settle may add one).
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('restores the prior explicit value when the write fails', async () => {
    stored({ terminal: 'same-window' });
    await hydrateAppPresentation();
    setMock.mockRejectedValue(new Error('nope'));

    await expect(setAppPresentation('terminal', 'new-window')).rejects.toThrow('nope');

    expect(getAppPresentation('terminal')).toBe('same-window');
    expect(getAppPresentationSnapshot()).toEqual({ terminal: 'same-window' });
  });

  it('defensively returns same-window for a factory (isMultiWindow) app', async () => {
    getApplicationsMock.mockReturnValue([{ id: 'query-viewer', isMultiWindow: true }]);
    stored({ 'query-viewer': 'new-window', terminal: 'new-window' });
    await hydrateAppPresentation();

    expect(getAppPresentation('query-viewer')).toBe('same-window');
    // A non-factory app keeps its stored value.
    expect(getAppPresentation('terminal')).toBe('new-window');
  });

  it('never clobbers a user write with a late hydration read (per-app dirty guard)', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    getMock.mockImplementation((key: string) =>
      key === APP_PRESENTATION_KEY
        ? new Promise<unknown>((resolve) => {
            resolveRead = resolve;
          })
        : Promise.resolve(undefined),
    );

    const hydration = hydrateAppPresentation(); // slow read
    const write = setAppPresentation('terminal', 'new-window'); // user acts first

    expect(getAppPresentation('terminal')).toBe('new-window');

    resolveRead(JSON.stringify({ terminal: 'same-window', doom: 'new-window' }));
    await hydration;
    await write;

    // The user's Terminal selection survives; the other stored entry merges in.
    expect(getAppPresentation('terminal')).toBe('new-window');
    expect(getAppPresentation('doom')).toBe('new-window');
  });

  it('keeps the map snapshot reference stable until a real mutation', async () => {
    const before = getAppPresentationSnapshot();
    expect(getAppPresentationSnapshot()).toBe(before);
    await setAppPresentation('terminal', 'new-window');
    expect(getAppPresentationSnapshot()).not.toBe(before);
  });

  it('useAppPresentation re-renders consumers when the app mode changes', async () => {
    const { result } = renderHook(() => useAppPresentation('terminal'));
    expect(result.current).toBe('same-window');

    await act(async () => {
      await setAppPresentation('terminal', 'new-window');
    });
    expect(result.current).toBe('new-window');
  });

  it('useAppPresentationMap reflects the persisted map', async () => {
    const { result } = renderHook(() => useAppPresentationMap());
    expect(result.current).toEqual({});

    await act(async () => {
      await setAppPresentation('terminal', 'new-window');
    });
    expect(result.current).toEqual({ terminal: 'new-window' });
  });

  it('exposes the module reset (test-only) so state does not leak across tests', async () => {
    await setAppPresentation('terminal', 'new-window');
    resetAppPresentationStoreForTests();
    expect(getAppPresentationSnapshot()).toEqual({});
    expect(isAppPresentationHydrated()).toBe(false);
    expect(getAppPresentation('terminal')).toBe('same-window');
  });
});
