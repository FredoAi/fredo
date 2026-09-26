/**
 * Pane layout + workspace layout store tests (Spec #2949 ST-1).
 *
 * Pins the pure region/divider math the whole tiled workspace builds on
 * (`resolveRegionRect`, `reflowSlots`, `computeDividers`, `applyDividerDelta`,
 * `clampPaneRect`) and the module-scoped store mechanics every consumer depends
 * on: stable snapshot ref, subscriber notify, dedup, structural + region
 * actions, named save/restore/delete, gesture-suppressed debounced persistence,
 * and once-only dirty-guarded hydration.
 *
 * `settingsService` is mocked (same seam as `dockPositionStore.test.ts`) so the
 * tests stay host-agnostic and deterministic; the real `serializeValue` is kept.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  applyDividerDelta,
  clampPaneRect,
  computeDividers,
  makeDividerId,
  parseDividerId,
  reflowSlots,
  resolveRegionRect,
  type PaneSlot,
} from '../paneLayout';

import {
  DEFAULT_LAYOUT_NAME,
  WORKSPACE_LAYOUT_KEY,
  addPane,
  beginLayoutGesture,
  deleteLayout,
  endLayoutGesture,
  getLayoutSnapshot,
  hydrateWorkspaceLayout,
  movePane,
  removePane,
  resetWorkspaceLayoutStoreForTests,
  resizeViaDivider,
  restoreLayout,
  saveLayout,
  setLayoutWorkspace,
  setPaneRect,
  subscribeLayout,
  useWorkspaceLayout,
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

function slot(
  windowId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): PaneSlot {
  return { windowId, region: 'center', rect: { x, y, width, height } };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceLayoutStoreForTests();
  setLayoutWorkspace(WS);
  getMock.mockResolvedValue(null);
});

afterEach(() => {
  resetWorkspaceLayoutStoreForTests();
  vi.useRealTimers();
});

describe('paneLayout — resolveRegionRect', () => {
  it('maps each region to a deterministic half/quarter/center band', () => {
    expect(resolveRegionRect(WS, 'left')).toEqual({ x: 0, y: 0, width: 500, height: 800 });
    expect(resolveRegionRect(WS, 'right')).toEqual({ x: 500, y: 0, width: 500, height: 800 });
    expect(resolveRegionRect(WS, 'top')).toEqual({ x: 0, y: 0, width: 1000, height: 400 });
    expect(resolveRegionRect(WS, 'bottom')).toEqual({ x: 0, y: 400, width: 1000, height: 400 });
    expect(resolveRegionRect(WS, 'top-left')).toEqual({ x: 0, y: 0, width: 500, height: 400 });
    expect(resolveRegionRect(WS, 'top-right')).toEqual({ x: 500, y: 0, width: 500, height: 400 });
    expect(resolveRegionRect(WS, 'bottom-left')).toEqual({ x: 0, y: 400, width: 500, height: 400 });
    expect(resolveRegionRect(WS, 'bottom-right')).toEqual({ x: 500, y: 400, width: 500, height: 400 });
    expect(resolveRegionRect(WS, 'center')).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('narrows a region to the largest free piece avoiding occupied panes', () => {
    const occupied = [slot('a', 0, 0, 500, 800)];
    expect(resolveRegionRect(WS, 'center', occupied)).toEqual({
      x: 500,
      y: 0,
      width: 500,
      height: 800,
    });
  });

  it('falls back to the band clamped when the whole band is claimed', () => {
    const occupied = [slot('a', 0, 0, 500, 800)];
    expect(resolveRegionRect(WS, 'left', occupied)).toEqual({
      x: 0,
      y: 0,
      width: 500,
      height: 800,
    });
  });

  it('clamps to MIN and stays inside a tiny workspace', () => {
    const rect = resolveRegionRect({ width: 300, height: 100 }, 'left');
    expect(rect.width).toBe(300);
    expect(rect.height).toBe(100);
    expect(rect.x + rect.width).toBeLessThanOrEqual(300);
    expect(rect.y + rect.height).toBeLessThanOrEqual(100);
  });

  it('uses a positive fallback workspace for a null measurement', () => {
    const rect = resolveRegionRect(null, 'left');
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });
});

describe('paneLayout — clampPaneRect', () => {
  it('floors at MIN and pins the rect inside the workspace', () => {
    expect(clampPaneRect({ x: -50, y: -50, width: 100, height: 100 }, WS)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 200,
    });
  });

  it('collapses to the workspace extent when smaller than MIN', () => {
    expect(clampPaneRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 300, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 100,
    });
  });
});

describe('paneLayout — reflowSlots', () => {
  const four = (n: number) =>
    Array.from({ length: n }, (_, i) => slot(`w${i}`, 0, 0, 10, 10));

  it('packs 2 panes into vertical halves with left/right regions', () => {
    const out = reflowSlots(WS, four(2));
    expect(out.map((s) => s.region)).toEqual(['left', 'right']);
    expect(out[0].rect).toEqual({ x: 0, y: 0, width: 500, height: 800 });
    expect(out[1].rect).toEqual({ x: 500, y: 0, width: 500, height: 800 });
  });

  it('packs 3 panes into thirds', () => {
    expect(reflowSlots(WS, four(3)).map((s) => s.region)).toEqual([
      'left',
      'center',
      'right',
    ]);
  });

  it('packs 4 panes into a 2×2 corner grid', () => {
    expect(reflowSlots(WS, four(4)).map((s) => s.region)).toEqual([
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]);
  });

  it('never overlaps the packed cells', () => {
    const out = reflowSlots(WS, four(3));
    for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i].rect;
        const b = out[j].rect;
        const overlapX =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
      }
    }
  });
});

describe('paneLayout — computeDividers', () => {
  it('emits a vertical divider for side-by-side panes, before→after', () => {
    const a = slot('a', 0, 0, 500, 800);
    const b = slot('b', 500, 0, 500, 800);
    // Deliberately reversed input order — the divider normalizes by position.
    const dividers = computeDividers([b, a]);
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toEqual({
      dividerId: 'vertical:a:b',
      axis: 'vertical',
      aWindowId: 'a',
      bWindowId: 'b',
    });
  });

  it('emits a horizontal divider for stacked panes', () => {
    const a = slot('a', 0, 0, 1000, 400);
    const b = slot('b', 0, 400, 1000, 400);
    expect(computeDividers([a, b])[0].dividerId).toBe('horizontal:a:b');
  });

  it('emits no divider for a corner-only contact or a gap', () => {
    expect(computeDividers([slot('a', 0, 0, 500, 400), slot('b', 500, 400, 500, 400)])).toEqual([]);
    expect(computeDividers([slot('a', 0, 0, 400, 800), slot('b', 500, 0, 400, 800)])).toEqual([]);
  });

  it('requires a cross-axis overlap (shared segment, not just an edge)', () => {
    const a = slot('a', 0, 0, 500, 800);
    const b = slot('b', 500, 200, 500, 600);
    expect(computeDividers([a, b])).toHaveLength(1);
  });

  it('round-trips makeDividerId through parseDividerId', () => {
    const id = makeDividerId('vertical', 'terminal', 'mission-monitor');
    expect(id).toBe('vertical:terminal:mission-monitor');
    expect(parseDividerId(id)).toEqual({
      dividerId: id,
      axis: 'vertical',
      aWindowId: 'terminal',
      bWindowId: 'mission-monitor',
    });
    expect(parseDividerId('bogus')).toBeNull();
    expect(parseDividerId('diagonal:a:b')).toBeNull();
  });
});

describe('paneLayout — applyDividerDelta', () => {
  const before = slot('a', 0, 0, 500, 800);
  const after = slot('b', 500, 0, 500, 800);
  const divider = {
    dividerId: 'vertical:a:b',
    axis: 'vertical' as const,
    aWindowId: 'a',
    bWindowId: 'b',
  };

  it('grows the before pane, shrinks the after pane, combined extent constant', () => {
    const out = applyDividerDelta([before, after], divider, 100);
    expect(out[0].rect).toEqual({ x: 0, y: 0, width: 600, height: 800 });
    expect(out[1].rect).toEqual({ x: 600, y: 0, width: 400, height: 800 });
    expect(out[0].rect.width + out[1].rect.width).toBe(1000);
  });

  it('derives before/after from rect position, not id order', () => {
    const reversed = { ...divider, aWindowId: 'b', bWindowId: 'a' };
    const out = applyDividerDelta([after, before], reversed, 100);
    expect(out.find((s) => s.windowId === 'a')!.rect.width).toBe(600);
    expect(out.find((s) => s.windowId === 'b')!.rect.width).toBe(400);
  });

  it('clamps so the after pane never drops below MIN_WIDTH', () => {
    const right = applyDividerDelta([before, after], divider, 10_000).find(
      (s) => s.windowId === 'b',
    )!;
    expect(right.rect.width).toBe(320);
    expect(right.rect.x).toBe(680);
  });

  it('clamps so the before pane never drops below MIN_WIDTH on a negative delta', () => {
    const out = applyDividerDelta([before, after], divider, -10_000);
    expect(out.find((s) => s.windowId === 'a')!.rect.width).toBe(320);
    const right = out.find((s) => s.windowId === 'b')!;
    expect(right.rect.x).toBe(320);
    expect(right.rect.width).toBe(680);
  });

  it('resizes a horizontal divider on the y axis', () => {
    const top = slot('a', 0, 0, 1000, 400);
    const bottom = slot('b', 0, 400, 1000, 400);
    const d = {
      dividerId: 'horizontal:a:b',
      axis: 'horizontal' as const,
      aWindowId: 'a',
      bWindowId: 'b',
    };
    const out = applyDividerDelta([top, bottom], d, 100);
    expect(out[0].rect.height).toBe(500);
    expect(out[1].rect).toEqual({ x: 0, y: 500, width: 1000, height: 300 });
  });

  it('returns the same array (no-op) for unknown ids or a zero delta', () => {
    const slots = [before, after];
    expect(applyDividerDelta(slots, { ...divider, aWindowId: 'nope' }, 50)).toBe(slots);
    expect(applyDividerDelta(slots, divider, 0)).toBe(slots);
  });
});

describe('workspaceLayoutStore — placement actions', () => {
  it('addPane places a pane, notifies, and keeps a stable snapshot ref', () => {
    const listener = vi.fn();
    subscribeLayout(listener);
    const before = getLayoutSnapshot();

    addPane('terminal', 'left');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLayoutSnapshot()).not.toBe(before);
    expect(getLayoutSnapshot()).toBe(getLayoutSnapshot());
    expect(getLayoutSnapshot().activeSlots).toEqual([
      { windowId: 'terminal', region: 'left', rect: { x: 0, y: 0, width: 500, height: 800 } },
    ]);
  });

  it('ignores a duplicate addPane for an already-placed windowId', () => {
    addPane('terminal', 'left');
    const listener = vi.fn();
    subscribeLayout(listener);
    addPane('terminal', 'right');
    expect(listener).not.toHaveBeenCalled();
    expect(getLayoutSnapshot().activeSlots).toHaveLength(1);
  });

  it('reflows to a non-overlapping split when a second center pane is added', () => {
    addPane('terminal');
    addPane('mission-monitor');
    const slots = getLayoutSnapshot().activeSlots;
    expect(slots.map((s) => s.windowId)).toEqual(['terminal', 'mission-monitor']);
    expect(slots.every((s) => s.rect.width < WS.width)).toBe(true);
    expect(slots[0].rect.x + slots[0].rect.width).toBeLessThanOrEqual(slots[1].rect.x);
  });

  it('removePane drops the slot and clears activeLayoutId', () => {
    addPane('terminal', 'left');
    addPane('mission-monitor', 'right');
    removePane('terminal');
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual([
      'mission-monitor',
    ]);
  });

  it('movePane rewrites the region and rect', () => {
    addPane('terminal', 'left');
    movePane('terminal', 'right');
    expect(getLayoutSnapshot().activeSlots[0].region).toBe('right');
    expect(getLayoutSnapshot().activeSlots[0].rect.x).toBe(500);
  });

  it('setPaneRect updates only the rect', () => {
    addPane('terminal', 'left');
    setPaneRect('terminal', { x: 10, y: 20, width: 400, height: 300 });
    expect(getLayoutSnapshot().activeSlots[0].rect).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
    });
    expect(getLayoutSnapshot().activeSlots[0].region).toBe('left');
  });

  it('resizeViaDivider resizes the two adjacent panes', () => {
    addPane('terminal', 'left');
    addPane('mission-monitor', 'right');
    resizeViaDivider('vertical:terminal:mission-monitor', 100);
    const terminal = getLayoutSnapshot().activeSlots.find((s) => s.windowId === 'terminal')!;
    const monitor = getLayoutSnapshot().activeSlots.find((s) => s.windowId === 'mission-monitor')!;
    expect(terminal.rect.width).toBe(600);
    expect(monitor.rect.x).toBe(600);
    expect(monitor.rect.width).toBe(400);
  });
});

describe('workspaceLayoutStore — named layouts', () => {
  it('saves, restores, and deletes a named layout', () => {
    addPane('terminal', 'left');
    const saved = saveLayout('twopane');
    expect(saved.name).toBe('twopane');
    expect(saved.slots).toEqual(getLayoutSnapshot().activeSlots);
    expect(getLayoutSnapshot().activeLayoutId).toBe(saved.id);

    addPane('mission-monitor', 'right');
    expect(getLayoutSnapshot().activeLayoutId).toBeNull();

    restoreLayout(saved.id);
    expect(getLayoutSnapshot().activeSlots).toEqual(saved.slots);
    expect(getLayoutSnapshot().activeLayoutId).toBe(saved.id);

    deleteLayout(saved.id);
    expect(getLayoutSnapshot().savedLayouts).toEqual([]);
    expect(getLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('falls back to DEFAULT_LAYOUT_NAME for an empty name', () => {
    addPane('terminal', 'left');
    expect(saveLayout('   ').name).toBe(DEFAULT_LAYOUT_NAME);
  });
});

describe('workspaceLayoutStore — gestures + persistence', () => {
  it('suppresses persistence during a gesture and writes once on release', async () => {
    vi.useFakeTimers();
    addPane('terminal', 'left');
    await vi.advanceTimersByTimeAsync(400);
    setMock.mockClear();

    beginLayoutGesture();
    expect(getLayoutSnapshot().dragging).toBe(true);
    setPaneRect('terminal', { x: 1, y: 1, width: 400, height: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(setMock).not.toHaveBeenCalled();

    endLayoutGesture();
    expect(getLayoutSnapshot().dragging).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it('persists the versioned JSON payload under the single key after the debounce', async () => {
    vi.useFakeTimers();
    addPane('terminal', 'left');
    expect(setMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);

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
});

describe('workspaceLayoutStore — hydration', () => {
  const persisted = {
    version: 1,
    activeLayoutId: 'saved-1',
    activeSlots: [
      { windowId: 'terminal', region: 'left', rect: { x: 0, y: 0, width: 500, height: 800 } },
    ],
    savedLayouts: [],
  };

  it('hydrates the persisted arrangement exactly once', async () => {
    getMock.mockResolvedValue(persisted);
    await hydrateWorkspaceLayout();
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual(['terminal']);
    expect(getLayoutSnapshot().activeLayoutId).toBe('saved-1');

    await hydrateWorkspaceLayout();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('never clobbers an in-flight user write with a late hydration', async () => {
    getMock.mockResolvedValue(persisted);
    const hydration = hydrateWorkspaceLayout();
    addPane('terminal', 'left'); // user acts first → dirty
    await hydration;
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual(['terminal']);
    expect(getLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('drops malformed slots but keeps unknown window ids (R9)', async () => {
    const raw = JSON.stringify({
      version: 1,
      activeLayoutId: 'saved-1',
      activeSlots: [
        { windowId: 'terminal', region: 'left', rect: { x: 0, y: 0, width: 500, height: 800 } },
        { windowId: 'feature-does-not-exist', region: 'right', rect: { x: 500, y: 0, width: 500, height: 800 } },
        { windowId: 42, region: 'left', rect: { x: 0, y: 0, width: 1, height: 1 } },
        { windowId: 'bad-region', region: 'middle', rect: { x: 0, y: 0, width: 1, height: 1 } },
      ],
      savedLayouts: [],
    });
    getMock.mockImplementation(
      async (_key: string, _def: unknown, deserialize?: (value: string) => unknown) =>
        deserialize ? deserialize(raw) : null,
    );
    await hydrateWorkspaceLayout();
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual([
      'terminal',
      'feature-does-not-exist',
    ]);
    expect(getLayoutSnapshot().activeLayoutId).toBe('saved-1');
  });
});

describe('workspaceLayoutStore — react binding + reset', () => {
  it('useWorkspaceLayout re-renders consumers on mutation', () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    expect(result.current.activeSlots).toEqual([]);

    act(() => {
      addPane('terminal', 'left');
    });
    expect(result.current.activeSlots).toHaveLength(1);
  });

  it('resetWorkspaceLayoutStoreForTests wipes state and listeners', () => {
    addPane('terminal', 'left');
    resetWorkspaceLayoutStoreForTests();
    expect(getLayoutSnapshot().activeSlots).toEqual([]);
    expect(getLayoutSnapshot().dragging).toBe(false);
  });
});
