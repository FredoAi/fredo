/**
 * WorkspaceLayoutStore persistence + hydration tests (Spec #2949 ST-4).
 *
 * ST-1's `paneLayout.test.ts` pins the pure math and the store's placement /
 * named-layout mechanics. This file pins the DURABILITY seam the plan assigns to
 * ST-4 (AC3/AC5, R8/R14, contributing to R9):
 *
 *   - `settingsService` is the ONLY persistence channel, under the single
 *     `Fredo_workspace_layout` key, written as the versioned JSON payload
 *     (`{version, activeLayoutId, activeSlots, savedLayouts}`) — never a
 *     `WindowEntry`.
 *   - a structural change is persisted AFTER the debounce and within 500 ms
 *     (R14), coalescing rapid changes into ONE write.
 *   - a persistence write is SUPPRESSED for the whole gesture: a timer scheduled
 *     just before the gesture must not fire mid-gesture (R5), and a gesture end
 *     writes exactly one time with the final geometry (R14).
 *   - persistence is best-effort: a rejected or synchronous-throwing write never
 *     throws to the caller and never corrupts the in-memory arrangement.
 *   - boot hydration (R8) re-applies the persisted LAST-ACTIVE arrangement with
 *     no user action, runs exactly once, never clobbers an in-flight user write,
 *     never writes back, KEEPS an unknown `windowId` (R9 tolerant hydrate), and
 *     degrades a corrupt value or an unknown schema version to a clean desktop
 *     without throwing.
 *
 * `settingsService` is mocked at the same seam as `dockPositionStore.test.ts` /
 * `paneLayout.test.ts` (the real `serializeValue` is kept) so the tests stay
 * host-agnostic and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  WORKSPACE_LAYOUT_KEY,
  addPane,
  beginLayoutGesture,
  endLayoutGesture,
  getLayoutSnapshot,
  hydrateWorkspaceLayout,
  removePane,
  resetWorkspaceLayoutStoreForTests,
  setLayoutWorkspace,
  setPaneRect,
} from '../workspaceLayoutStore';

vi.mock('../../../features/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../features/settings')>();
  return {
    ...actual,
    settingsService: {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { settingsService } from '../../../features/settings';

const getMock = settingsService.get as unknown as ReturnType<typeof vi.fn>;
const setMock = settingsService.set as unknown as ReturnType<typeof vi.fn>;

const WS = { width: 1000, height: 800 };

/** A persisted v1 arrangement — terminal left / mission-monitor right. */
const persisted = {
  version: 1,
  activeLayoutId: 'saved-1',
  activeSlots: [
    { windowId: 'terminal', region: 'left', rect: { x: 0, y: 0, width: 500, height: 800 } },
    { windowId: 'mission-monitor', region: 'right', rect: { x: 500, y: 0, width: 500, height: 800 } },
  ],
  savedLayouts: [],
};

/** Route `settingsService.get` through the store's own tolerant deserializer. */
function persistRaw(raw: string): void {
  getMock.mockImplementation(
    async (_key: string, _def: unknown, deserialize?: (value: string) => unknown) =>
      deserialize ? deserialize(raw) : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceLayoutStoreForTests();
  setLayoutWorkspace(WS);
  getMock.mockResolvedValue(null);
  setMock.mockResolvedValue(undefined);
});

afterEach(() => {
  resetWorkspaceLayoutStoreForTests();
  vi.useRealTimers();
});

describe('workspaceLayoutStore — persistence (R14)', () => {
  it('writes once after the debounce, within 500 ms, for a structural change', async () => {
    vi.useFakeTimers();
    addPane('terminal', 'left');

    // Debounced — never synchronous, and not before the coalescing window.
    expect(setMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(149);
    expect(setMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(setMock).toHaveBeenCalledTimes(1);

    const [key, raw] = setMock.mock.calls[0];
    expect(key).toBe(WORKSPACE_LAYOUT_KEY);
    expect(JSON.parse(raw as string)).toEqual({
      version: 1,
      activeLayoutId: null,
      activeSlots: [
        { windowId: 'terminal', region: 'left', rect: { x: 0, y: 0, width: 500, height: 800 } },
      ],
      savedLayouts: [],
    });
  });

  it('coalesces rapid structural changes into a single write', async () => {
    vi.useFakeTimers();
    addPane('terminal', 'left');
    addPane('mission-monitor', 'right');
    removePane('terminal');
    expect(setMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(setMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(setMock.mock.calls[0][1] as string);
    expect(payload.activeSlots.map((s: { windowId: string }) => s.windowId)).toEqual([
      'mission-monitor',
    ]);
  });

  it('never persists mid-gesture and writes exactly once on gesture end', async () => {
    vi.useFakeTimers();
    // A structural change just BEFORE the gesture schedules a debounced write...
    addPane('terminal', 'left');
    // ...which entering the gesture must cancel (R5: no persist during a gesture).
    beginLayoutGesture();
    expect(getLayoutSnapshot().dragging).toBe(true);
    setPaneRect('terminal', { x: 5, y: 5, width: 450, height: 700 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(setMock).not.toHaveBeenCalled();

    endLayoutGesture();
    expect(getLayoutSnapshot().dragging).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(setMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(setMock.mock.calls[0][1] as string);
    expect(payload.activeSlots[0].rect).toEqual({ x: 5, y: 5, width: 450, height: 700 });
  });

  it('is best-effort — a rejected write never throws and keeps the in-memory arrangement', async () => {
    vi.useFakeTimers();
    setMock.mockRejectedValue(new Error('disk full'));
    addPane('terminal', 'left');

    await vi.advanceTimersByTimeAsync(200);
    expect(setMock).toHaveBeenCalledTimes(1);
    // The rejected write must not have corrupted module state.
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual(['terminal']);
  });

  it('is best-effort — a synchronous write throw never reaches the caller', async () => {
    vi.useFakeTimers();
    setMock.mockImplementation(() => {
      throw new Error('sync boom');
    });
    addPane('terminal', 'left');

    // The write throw is swallowed inside the store; awaiting the flushed timer
    // must not reject, and the in-memory arrangement must be intact.
    await vi.advanceTimersByTimeAsync(200);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual(['terminal']);
  });
});

describe('workspaceLayoutStore — hydration (R8 / R9)', () => {
  it('re-applies the persisted last-active arrangement exactly once (R8)', async () => {
    getMock.mockResolvedValue(persisted);

    await hydrateWorkspaceLayout();
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual([
      'terminal',
      'mission-monitor',
    ]);
    expect(getLayoutSnapshot().activeLayoutId).toBe('saved-1');

    await hydrateWorkspaceLayout();
    expect(getMock).toHaveBeenCalledTimes(1); // once-only across consumers
  });

  it('keeps an unknown windowId in place while sibling rects are untouched (R9)', async () => {
    persistRaw(
      JSON.stringify({
        version: 1,
        activeLayoutId: null,
        activeSlots: [
          { windowId: 'ghost-app', region: 'left', rect: { x: 0, y: 0, width: 400, height: 300 } },
          { windowId: 'terminal', region: 'right', rect: { x: 400, y: 0, width: 600, height: 800 } },
          // malformed entries are dropped (bad id, bad region, missing rect)
          { windowId: 42, region: 'left', rect: { x: 0, y: 0, width: 1, height: 1 } },
          { windowId: 'bad-region', region: 'middle', rect: { x: 0, y: 0, width: 1, height: 1 } },
          { windowId: 'no-rect', region: 'left' },
        ],
        savedLayouts: [],
      }),
    );

    await hydrateWorkspaceLayout();
    const slots = getLayoutSnapshot().activeSlots;
    expect(slots.map((s) => s.windowId)).toEqual(['ghost-app', 'terminal']);
    expect(slots[0].rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(slots[1].rect).toEqual({ x: 400, y: 0, width: 600, height: 800 });
  });

  it('degrades a corrupt persisted value to a clean desktop without throwing (R8)', async () => {
    persistRaw('{ not valid json');

    await expect(hydrateWorkspaceLayout()).resolves.toBeUndefined();
    expect(getLayoutSnapshot().activeSlots).toEqual([]);
    expect(getLayoutSnapshot().savedLayouts).toEqual([]);
    expect(getLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('degrades an unknown schema version to a clean desktop (R8)', async () => {
    persistRaw(
      JSON.stringify({
        version: 99,
        activeLayoutId: 'future-layout',
        activeSlots: [
          { windowId: 'terminal', region: 'left', rect: { x: 0, y: 0, width: 500, height: 800 } },
        ],
        savedLayouts: [],
      }),
    );

    await hydrateWorkspaceLayout();
    expect(getLayoutSnapshot().activeSlots).toEqual([]);
    expect(getLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('never clobbers an in-flight user write with a late hydration (dirty guard)', async () => {
    getMock.mockResolvedValue(persisted);

    const hydration = hydrateWorkspaceLayout(); // kicks off the read
    addPane('terminal', 'left'); // user acts first → store is dirty
    await hydration;

    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual(['terminal']);
    // The user's ad-hoc arrangement wins — the persisted `saved-1` never lands.
    expect(getLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('never writes back to persistence while hydrating', async () => {
    vi.useFakeTimers();
    persistRaw(JSON.stringify(persisted));

    await hydrateWorkspaceLayout();
    await vi.advanceTimersByTimeAsync(500);
    expect(setMock).not.toHaveBeenCalled();
  });
});
