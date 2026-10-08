/**
 * ZoneLayoutStore tests (Spec #2980 ST-1).
 *
 * Pins the module-scoped store mechanics every later capsule consumes: stable
 * snapshot ref + `useSyncExternalStore` notify, configuration actions
 * (enable/active/save/delete/gap/chord), the zero-zone reject (R-2.4), the
 * assignment + transient drag actions (R-3.1/R-3.2/R-3.4), debounced +
 * gesture-suppressed persistence (R-1.2), once-only dirty-guarded hydration with
 * a tolerant v1 parse that keeps unknown windowIds and drops zero-zone layouts
 * (R-4.1/R-4.4) plus the legacy-key purge, and the boot reopen (R-4.2).
 *
 * `settingsService` is mocked at the same seam as the sibling store tests so the
 * suite stays host-agnostic and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  assignWindowToZone,
  beginZoneDrag,
  cancelZoneDrag,
  clearWindowZone,
  deleteZoneLayout,
  endZoneDrag,
  getZoneLayoutSnapshot,
  hydrateZoneLayout,
  reopenZonedWindows,
  resetZoneLayoutStoreForTests,
  saveZoneLayout,
  setActiveZoneLayout,
  setZoneChord,
  setZoneGap,
  setZoneLayoutEnabled,
  setZoneLayoutWorkspace,
  subscribeZoneLayout,
  updateZoneDragPointer,
  useZoneLayout,
} from '../zoneLayoutStore';
import {
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '../windowStore';
import {
  buildTemplateZones,
  LEGACY_WORKSPACE_LAYOUT_KEY,
  ZONE_LAYOUT_KEY,
  type ZoneLayout,
} from '../zoneLayout';

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
const removeMock = settingsService.remove as unknown as ReturnType<typeof vi.fn>;

/** The raw string the mocked `settingsService.get` deserializes. */
let raw: string | null = null;

function columnsLayout(id = 'l1'): ZoneLayout {
  return { id, name: 'Work', template: 'columns', zones: buildTemplateZones('columns') };
}

function seedActiveLayout(): ZoneLayout {
  setZoneLayoutEnabled(true);
  const layout = saveZoneLayout(columnsLayout());
  setActiveZoneLayout(layout.id);
  return layout;
}

function openFeature(id: string): void {
  openWindow({
    id,
    title: id.toUpperCase(),
    icon: null,
    component: null,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
  });
}

function persistedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    enabled: true,
    activeLayoutId: 'l1',
    layouts: [columnsLayout()],
    gap: 8,
    chord: 'alt',
    assignments: [],
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWindowStoreForTests();
  resetZoneLayoutStoreForTests();
  setZoneLayoutWorkspace({ left: 0, top: 0, width: 1000, height: 800 });
  raw = null;
  getMock.mockImplementation(
    async (_key: string, def: unknown, deserialize?: (value: string) => unknown) => {
      if (raw === null) return def;
      return deserialize ? deserialize(raw) : raw;
    },
  );
  setMock.mockResolvedValue(undefined);
  removeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  resetWindowStoreForTests();
  resetZoneLayoutStoreForTests();
  vi.useRealTimers();
});

describe('zoneLayoutStore — snapshot', () => {
  it('starts on the clean default and keeps a stable reference until a mutation', () => {
    const snap = getZoneLayoutSnapshot();
    expect(snap).toEqual({
      enabled: false,
      activeLayoutId: null,
      layouts: [],
      gap: 8,
      chord: 'alt',
      assignments: [],
      dragActive: false,
      dragWindowId: null,
      hoveredZoneId: null,
    });
    expect(getZoneLayoutSnapshot()).toBe(snap);
  });

  it('notifies subscribers once per mutation and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeZoneLayout(listener);
    const before = getZoneLayoutSnapshot();
    setZoneLayoutEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getZoneLayoutSnapshot()).not.toBe(before);
    unsubscribe();
    setZoneLayoutEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-renders useZoneLayout() consumers on a real mutation', () => {
    const { result } = renderHook(() => useZoneLayout());
    expect(result.current.enabled).toBe(false);
    act(() => {
      setZoneLayoutEnabled(true);
    });
    expect(result.current.enabled).toBe(true);
  });
});

describe('zoneLayoutStore — save / active / delete (R-2.2/R-2.3/R-2.4/R-2.5)', () => {
  it('upserts by id and keeps layout names unique', () => {
    saveZoneLayout(columnsLayout('a'));
    const second = saveZoneLayout({ ...columnsLayout('b'), name: 'Work' });
    expect(second.name).toBe('Work (2)');

    const updated = saveZoneLayout({
      id: 'a',
      name: 'Work',
      template: 'grid',
      zones: buildTemplateZones('grid'),
    });
    expect(updated.name).toBe('Work');
    const layouts = getZoneLayoutSnapshot().layouts;
    expect(layouts.map((layout) => layout.id)).toEqual(['a', 'b']);
    expect(layouts.find((layout) => layout.id === 'a')?.zones).toHaveLength(4);
  });

  it('refuses to assign a zero-zone layout and ignores an unknown id (R-2.4)', () => {
    saveZoneLayout({ id: 'empty', name: 'Empty', template: 'custom', zones: [] });
    expect(() => setActiveZoneLayout('empty')).not.toThrow();
    expect(getZoneLayoutSnapshot().activeLayoutId).toBeNull();

    expect(() => setActiveZoneLayout('missing')).not.toThrow();
    expect(getZoneLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('assigns a valid layout, then clears the active pointer when a zero-zone edit lands (R-2.5)', () => {
    seedActiveLayout();
    expect(getZoneLayoutSnapshot().activeLayoutId).toBe('l1');

    saveZoneLayout({ id: 'l1', name: 'Work', template: 'custom', zones: [] });
    expect(getZoneLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('deletes a layout, clearing the active pointer and dependent assignments', () => {
    seedActiveLayout();
    assignWindowToZone('terminal', 'zone-0');

    deleteZoneLayout('l1');

    const snap = getZoneLayoutSnapshot();
    expect(snap.layouts).toEqual([]);
    expect(snap.activeLayoutId).toBeNull();
    expect(snap.assignments).toEqual([]);
    // Unknown id is a no-op.
    expect(() => deleteZoneLayout('nope')).not.toThrow();
  });
});

describe('zoneLayoutStore — assignments (R-3.2)', () => {
  it('assigns, replaces and clears a window assignment', () => {
    seedActiveLayout();

    assignWindowToZone('terminal', 'zone-0');
    expect(getZoneLayoutSnapshot().assignments).toEqual([
      { windowId: 'terminal', layoutId: 'l1', zoneId: 'zone-0' },
    ]);

    assignWindowToZone('terminal', 'zone-1');
    expect(getZoneLayoutSnapshot().assignments).toEqual([
      { windowId: 'terminal', layoutId: 'l1', zoneId: 'zone-1' },
    ]);

    assignWindowToZone('terminal', 'no-such-zone');
    expect(getZoneLayoutSnapshot().assignments).toHaveLength(1);

    clearWindowZone('terminal');
    expect(getZoneLayoutSnapshot().assignments).toEqual([]);
    // No-op when there is nothing to clear.
    expect(() => clearWindowZone('terminal')).not.toThrow();
  });

  it('ignores an assignment when no layout is active', () => {
    assignWindowToZone('terminal', 'zone-0');
    expect(getZoneLayoutSnapshot().assignments).toEqual([]);
  });
});

describe('zoneLayoutStore — gap / chord (AC1)', () => {
  it('clamps the gap', () => {
    setZoneGap(100);
    expect(getZoneLayoutSnapshot().gap).toBe(32);
    setZoneGap(-4);
    expect(getZoneLayoutSnapshot().gap).toBe(0);
    setZoneGap(16);
    expect(getZoneLayoutSnapshot().gap).toBe(16);
  });

  it('accepts a known chord and ignores an unknown one', () => {
    setZoneChord('primary+alt');
    expect(getZoneLayoutSnapshot().chord).toBe('primary+alt');
    setZoneChord('bogus' as never);
    expect(getZoneLayoutSnapshot().chord).toBe('primary+alt');
  });
});

describe('zoneLayoutStore — drag gesture (R-3.1/R-3.2/R-3.4)', () => {
  it('tracks the hovered zone and commits the assignment on release', () => {
    seedActiveLayout();

    beginZoneDrag('terminal');
    expect(getZoneLayoutSnapshot().dragActive).toBe(true);
    expect(getZoneLayoutSnapshot().dragWindowId).toBe('terminal');

    updateZoneDragPointer(250, 400);
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBe('zone-0');
    updateZoneDragPointer(750, 400);
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBe('zone-1');

    endZoneDrag(true);
    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(getZoneLayoutSnapshot().dragWindowId).toBeNull();
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBeNull();
    expect(getZoneLayoutSnapshot().assignments).toEqual([
      { windowId: 'terminal', layoutId: 'l1', zoneId: 'zone-1' },
    ]);
  });

  it('leaves the assignment unchanged when released over a gap', () => {
    seedActiveLayout();

    beginZoneDrag('terminal');
    updateZoneDragPointer(500, 400);
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBeNull();

    endZoneDrag(true);
    expect(getZoneLayoutSnapshot().assignments).toEqual([]);
  });

  it('cancels a drag without assigning (Escape, R-3.4)', () => {
    seedActiveLayout();

    beginZoneDrag('terminal');
    updateZoneDragPointer(250, 400);
    cancelZoneDrag();

    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBeNull();
    expect(getZoneLayoutSnapshot().assignments).toEqual([]);
  });

  it('reports no hovered zone while layout management is disabled (R-3.3)', () => {
    saveZoneLayout(columnsLayout());
    setActiveZoneLayout('l1');
    // enabled stays false.
    beginZoneDrag('terminal');
    updateZoneDragPointer(250, 400);
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBeNull();
  });
});

describe('zoneLayoutStore — persistence (R-1.2)', () => {
  it('writes once after the debounce with the versioned payload', async () => {
    vi.useFakeTimers();
    setZoneLayoutEnabled(true);
    expect(setMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(149);
    expect(setMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [key, value] = setMock.mock.calls[0];
    expect(key).toBe(ZONE_LAYOUT_KEY);
    expect(JSON.parse(value as string)).toEqual({
      version: 1,
      enabled: true,
      activeLayoutId: null,
      layouts: [],
      gap: 8,
      chord: 'alt',
      assignments: [],
    });
  });

  it('never persists mid-drag and flushes the pending config on drag end', async () => {
    vi.useFakeTimers();
    setZoneLayoutEnabled(true); // schedules a write...
    beginZoneDrag('terminal'); // ...which entering the gesture cancels (R17)

    await vi.advanceTimersByTimeAsync(1000);
    expect(setMock).not.toHaveBeenCalled();

    endZoneDrag(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setMock.mock.calls[0][1] as string).enabled).toBe(true);
  });

  it('is best-effort — a rejected write never throws and keeps the config', async () => {
    vi.useFakeTimers();
    setMock.mockRejectedValue(new Error('disk full'));
    setZoneLayoutEnabled(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(getZoneLayoutSnapshot().enabled).toBe(true);
  });

  it('is best-effort — a synchronous write throw never reaches the caller', async () => {
    vi.useFakeTimers();
    setMock.mockImplementation(() => {
      throw new Error('sync boom');
    });
    setZoneLayoutEnabled(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(getZoneLayoutSnapshot().enabled).toBe(true);
  });
});

describe('zoneLayoutStore — hydration (R-4.1/R-4.4)', () => {
  it('re-applies the persisted document exactly once and purges the legacy key', async () => {
    raw = persistedPayload({
      gap: 16,
      chord: 'primary+alt',
      assignments: [{ windowId: 'terminal', layoutId: 'l1', zoneId: 'zone-0' }],
    });

    await hydrateZoneLayout();
    const snap = getZoneLayoutSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.activeLayoutId).toBe('l1');
    expect(snap.gap).toBe(16);
    expect(snap.chord).toBe('primary+alt');
    expect(snap.layouts.map((layout) => layout.id)).toEqual(['l1']);
    expect(snap.assignments).toEqual([
      { windowId: 'terminal', layoutId: 'l1', zoneId: 'zone-0' },
    ]);
    expect(removeMock).toHaveBeenCalledWith(LEGACY_WORKSPACE_LAYOUT_KEY);

    await hydrateZoneLayout();
    expect(getMock).toHaveBeenCalledTimes(1); // once-only across consumers
  });

  it('keeps an assignment to an unknown/closed window (degraded render, R-4.4)', async () => {
    raw = persistedPayload({
      assignments: [{ windowId: 'ghost-app', layoutId: 'l1', zoneId: 'zone-0' }],
    });

    await hydrateZoneLayout();
    expect(getZoneLayoutSnapshot().assignments).toEqual([
      { windowId: 'ghost-app', layoutId: 'l1', zoneId: 'zone-0' },
    ]);
  });

  it('drops a zero-zone layout and never leaves the active pointer on it', async () => {
    raw = persistedPayload({
      activeLayoutId: 'empty',
      layouts: [
        { id: 'empty', name: 'Empty', template: 'custom', zones: [] },
        columnsLayout('good'),
      ],
    });

    await hydrateZoneLayout();
    expect(getZoneLayoutSnapshot().layouts.map((layout) => layout.id)).toEqual(['good']);
    expect(getZoneLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('degrades an unknown schema version to the clean default (R-4.4)', async () => {
    raw = persistedPayload({ version: 2, enabled: true });

    await hydrateZoneLayout();
    expect(getZoneLayoutSnapshot()).toMatchObject({
      enabled: false,
      activeLayoutId: null,
      layouts: [],
      gap: 8,
      chord: 'alt',
      assignments: [],
    });
  });

  it('degrades a corrupt payload to the clean default without throwing', async () => {
    raw = '{ not valid json';

    await expect(hydrateZoneLayout()).resolves.toBeUndefined();
    expect(getZoneLayoutSnapshot().layouts).toEqual([]);
    expect(getZoneLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('never clobbers an in-flight user write with a late hydration (dirty guard)', async () => {
    raw = persistedPayload({ gap: 30 });

    const hydration = hydrateZoneLayout();
    setZoneGap(20); // user acts first → store is dirty
    await hydration;

    const snap = getZoneLayoutSnapshot();
    expect(snap.gap).toBe(20);
    expect(snap.enabled).toBe(false);
    expect(snap.layouts).toEqual([]);
  });

  it('never writes back while hydrating', async () => {
    vi.useFakeTimers();
    raw = persistedPayload();

    await hydrateZoneLayout();
    await vi.advanceTimersByTimeAsync(500);
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('zoneLayoutStore — reopenZonedWindows (R-4.2)', () => {
  const features = [{ id: 'terminal' }, { id: 'mission-monitor' }];

  it('reopens the active layout assignments un-maximized', () => {
    seedActiveLayout();
    assignWindowToZone('terminal', 'zone-0');
    assignWindowToZone('mission-monitor', 'zone-1');

    const open = vi.fn();
    const update = vi.fn();
    reopenZonedWindows({ features, open, update });

    expect(open.mock.calls.map((call) => call[0])).toEqual(['terminal', 'mission-monitor']);
    expect(update.mock.calls).toEqual([
      ['terminal', { isMaximized: false }],
      ['mission-monitor', { isMaximized: false }],
    ]);
  });

  it('skips a window that is already open and one with no registered feature', () => {
    seedActiveLayout();
    assignWindowToZone('ghost-app', 'zone-0');
    assignWindowToZone('terminal', 'zone-0');
    assignWindowToZone('mission-monitor', 'zone-1');
    openFeature('terminal');

    const open = vi.fn();
    const update = vi.fn();
    reopenZonedWindows({ features, open, update });

    expect(open.mock.calls.map((call) => call[0])).toEqual(['mission-monitor']);
    expect(getWindowSnapshot().map((win) => win.id)).toEqual(['terminal']);
  });

  it('only reopens assignments of the ACTIVE layout', () => {
    setZoneLayoutEnabled(true);
    saveZoneLayout(columnsLayout('l1'));
    saveZoneLayout(columnsLayout('l2'));
    setActiveZoneLayout('l1');
    assignWindowToZone('a', 'zone-0');
    setActiveZoneLayout('l2');
    assignWindowToZone('b', 'zone-0');
    setActiveZoneLayout('l1');

    const open = vi.fn();
    const update = vi.fn();
    reopenZonedWindows({ features: [{ id: 'a' }, { id: 'b' }], open, update });

    expect(open.mock.calls.map((call) => call[0])).toEqual(['a']);
  });

  it('does nothing while layout management is disabled', () => {
    saveZoneLayout(columnsLayout());
    setActiveZoneLayout('l1');
    assignWindowToZone('terminal', 'zone-0');

    const open = vi.fn();
    const update = vi.fn();
    reopenZonedWindows({ features, open, update });

    expect(open).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
