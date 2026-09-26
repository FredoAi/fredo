/**
 * Workspace-layout round-2 fix tests (Spec #2949 — AC1/AC2/AC3/AC5).
 *
 * Pins the three defects the round-1 tester found, at the store seam:
 *
 *   - AC2 — `movePane` makes the REQUESTED region authoritative for the moved
 *     pane (it previously discarded the request and repartitioned by index as
 *     soon as the band overlapped a sibling — which is always, at ≥2 panes).
 *   - AC1 — `arrangeOpenWindows` is ONE shared store action (the toolbar's
 *     `workspace-arrange` and the dock's `dock-arrange` both call it), placing
 *     every open non-minimized window and clearing full-bleed.
 *   - AC3/AC5 — `reopenHydratedSlots` reopens the hydrated arrangement's
 *     REGISTERED windows un-maximized so they land as panes; unregistered ids
 *     are skipped (degraded path) and an explicit `restoreLayout` NEVER reopens
 *     (the F-9 invariant).
 *
 * `settingsService` is mocked at the same seam as the sibling store tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  addPane,
  arrangeOpenWindows,
  getLayoutSnapshot,
  movePane,
  removePane,
  reopenHydratedSlots,
  resetWorkspaceLayoutStoreForTests,
  restoreLayout,
  saveLayout,
  setLayoutWorkspace,
} from '../workspaceLayoutStore';
import {
  focusWindow,
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '../windowStore';
import { findDegradedSlots, type PaneSlot } from '../paneLayout';
import type { Geometry } from '../windowGeometry';

vi.mock('../../../features/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../features/settings')>();
  return {
    ...actual,
    settingsService: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const WS = { width: 1000, height: 800 };

function openFeature(id: string, overrides: Record<string, unknown> = {}): void {
  openWindow({
    id,
    title: id.toUpperCase(),
    icon: null,
    component: null,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    ...overrides,
  });
}

function overlapArea(a: Geometry, b: Geometry): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, w) * Math.max(0, h);
}

function hasNoOverlap(slots: PaneSlot[]): boolean {
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      if (overlapArea(slots[i].rect, slots[j].rect) > 0.5) return false;
    }
  }
  return true;
}

function slotOf(windowId: string): PaneSlot {
  const found = getLayoutSnapshot().activeSlots.find((slot) => slot.windowId === windowId);
  if (!found) throw new Error(`${windowId} not found`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
  setLayoutWorkspace(WS);
});

afterEach(() => {
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
});

describe('workspaceLayoutStore.movePane — requested-region authority (R3/AC2)', () => {
  it('honours the requested corner region when it overlaps siblings (3 panes)', () => {
    addPane('a');
    addPane('b');
    addPane('c');

    movePane('a', 'bottom-right');

    const slots = getLayoutSnapshot().activeSlots;
    // Commit preserves the ORIGINAL activeSlots order.
    expect(slots.map((slot) => slot.windowId)).toEqual(['a', 'b', 'c']);
    // The moved pane's REGION and RECT are the requested band — never a
    // `nearestRegion` rewrite or an index repartition.
    expect(slotOf('a').region).toBe('bottom-right');
    expect(slotOf('a').rect).toEqual({ x: 500, y: 400, width: 500, height: 400 });
    // Siblings reflow non-overlapping.
    expect(hasNoOverlap(slots)).toBe(true);
  });

  it('keeps the moved pane in the requested region even when a sibling already occupies it (2 panes)', () => {
    addPane('a', 'left');
    addPane('b', 'right');

    movePane('a', 'right');

    expect(slotOf('a').region).toBe('right');
    expect(slotOf('a').rect).toEqual({ x: 500, y: 0, width: 500, height: 800 });
    expect(hasNoOverlap(getLayoutSnapshot().activeSlots)).toBe(true);
  });

  it('treats `center` against the siblings so the arrangement stays valid', () => {
    addPane('a', 'left');
    addPane('b', 'right');

    movePane('a', 'center');

    // `center` is narrowed against `b` → the free right band.
    expect(slotOf('a').region).toBe('center');
    expect(hasNoOverlap(getLayoutSnapshot().activeSlots)).toBe(true);
  });
});

describe('workspaceLayoutStore.arrangeOpenWindows — shared entry (R2/AC1)', () => {
  it('places every open non-minimized window as a pane and clears full-bleed', () => {
    openFeature('a'); // full-bleed default (canMaximize ⇒ isMaximized true)
    openFeature('b');

    const added = arrangeOpenWindows();

    expect(added).toBe(2);
    expect(getLayoutSnapshot().activeSlots.map((slot) => slot.windowId)).toEqual(['a', 'b']);
    expect(getWindowSnapshot().every((win) => !win.isMaximized)).toBe(true);
  });

  it('is idempotent — a second call adds nothing', () => {
    openFeature('a');
    openFeature('b');
    arrangeOpenWindows();

    expect(arrangeOpenWindows()).toBe(0);
    expect(getLayoutSnapshot().activeSlots).toHaveLength(2);
  });

  it('excludes minimized windows', () => {
    openFeature('a');
    openFeature('b');
    focusWindow('b', { minimize: true });

    arrangeOpenWindows();

    expect(getLayoutSnapshot().activeSlots.map((slot) => slot.windowId)).toEqual(['a']);
  });
});

describe('workspaceLayoutStore.reopenHydratedSlots — boot-only reopen (R8/AC5)', () => {
  const features = [{ id: 'terminal' }, { id: 'mission-monitor' }];

  it('reopens the registered hydrated slots un-maximized and skips unregistered ids', () => {
    addPane('terminal', 'left');
    addPane('mission-monitor', 'right');
    addPane('ghost-app', 'center'); // no registered feature → must be skipped

    const open = vi.fn();
    const update = vi.fn();
    reopenHydratedSlots({ features, open, update });

    const openedIds = open.mock.calls.map((call) => call[0]);
    expect(openedIds).toContain('terminal');
    expect(openedIds).toContain('mission-monitor');
    expect(openedIds).not.toContain('ghost-app');

    // Every reopened window lands un-maximized so it tiles into its slot.
    expect(update.mock.calls).toEqual([
      ['terminal', { isMaximized: false }],
      ['mission-monitor', { isMaximized: false }],
    ]);
  });

  it('skips a slot whose window is already open', () => {
    addPane('terminal', 'left');
    addPane('mission-monitor', 'right');
    openFeature('terminal'); // already open this session

    const open = vi.fn();
    const update = vi.fn();
    reopenHydratedSlots({ features, open, update });

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe('mission-monitor');
  });

  it('an explicit restoreLayout NEVER reopens — a closed app keeps degrading (F-9)', () => {
    addPane('terminal', 'left');
    addPane('mission-monitor', 'right');
    const saved = saveLayout('twopane');

    // No windows are open (the panes were seeded directly) — a closed app.
    removePane('terminal');
    removePane('mission-monitor');
    expect(getWindowSnapshot()).toHaveLength(0);

    restoreLayout(saved.id);

    // The store re-applied the arrangement but did NOT open any window.
    expect(getWindowSnapshot()).toHaveLength(0);
    expect(getLayoutSnapshot().activeSlots.map((slot) => slot.windowId)).toEqual([
      'terminal',
      'mission-monitor',
    ]);
    const degraded = findDegradedSlots(
      getLayoutSnapshot().activeSlots,
      new Set(getWindowSnapshot().map((win) => win.id)),
    );
    expect(degraded.map((slot) => slot.windowId)).toEqual(['terminal', 'mission-monitor']);
  });
});
