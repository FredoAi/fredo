/**
 * paneLayout edge-rule tests — Spec #2949 ST-6 (R9/R10) + ST-7 (R12).
 *
 * ST-1's `paneLayout.test.ts` pins the core region/divider math. This file pins
 * the three ST-6/ST-7 additions:
 *
 *   - `findDegradedSlots` (R9) — placements whose window is no longer open;
 *   - `absorbRemovedSlot` (R10) — the freed space of a closed pane is absorbed
 *     by the edge-adjacent sibling (or repartitioned when none is adjacent), so
 *     the survivors stay a valid, non-overlapping arrangement;
 *   - `findPaneNeighbor` (R12) — the deterministic Arrow-key focus neighbour,
 *     with `null` at every boundary.
 *
 * `settingsService` is mocked at the same seam as the sibling store tests (the
 * layout store persists through it) so the store-level reflow pin stays
 * host-agnostic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  absorbRemovedSlot,
  findDegradedSlots,
  findPaneNeighbor,
  type PaneSlot,
} from '../paneLayout';
import {
  addPane,
  getLayoutSnapshot,
  removePane,
  resetWorkspaceLayoutStoreForTests,
  setLayoutWorkspace,
} from '../workspaceLayoutStore';

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

function slot(windowId: string, x: number, y: number, width: number, height: number): PaneSlot {
  return { windowId, region: 'center', rect: { x, y, width, height } };
}

function byId(slots: PaneSlot[], windowId: string): PaneSlot {
  const found = slots.find((s) => s.windowId === windowId);
  if (!found) throw new Error(`${windowId} not found`);
  return found;
}

describe('findDegradedSlots (R9)', () => {
  it('returns the placements whose windowId is not open, in order', () => {
    const slots = [slot('terminal', 0, 0, 500, 800), slot('ghost', 500, 0, 500, 800)];
    const degraded = findDegradedSlots(slots, new Set(['terminal']));
    expect(degraded.map((s) => s.windowId)).toEqual(['ghost']);
  });

  it('returns nothing when every placement is backed by an open window', () => {
    const slots = [slot('terminal', 0, 0, 500, 800), slot('mission-monitor', 500, 0, 500, 800)];
    expect(findDegradedSlots(slots, new Set(['terminal', 'mission-monitor']))).toEqual([]);
  });

  it('does not mutate the input slots', () => {
    const slots = [slot('ghost', 0, 0, 400, 300)];
    findDegradedSlots(slots, new Set());
    expect(slots[0].rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });
});

describe('absorbRemovedSlot (R10)', () => {
  it('absorbs a removed LEFT pane into the right sibling (slide left + widen)', () => {
    const left = slot('a', 0, 0, 500, 800);
    const right = slot('b', 500, 0, 500, 800);
    const out = absorbRemovedSlot(WS, left, [right]);
    expect(out).toHaveLength(1);
    expect(out[0].rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    expect(out[0].region).toBe('center');
  });

  it('widens the left sibling when the RIGHT pane is removed', () => {
    const left = slot('a', 0, 0, 500, 800);
    const right = slot('b', 500, 0, 500, 800);
    const out = absorbRemovedSlot(WS, right, [left]);
    expect(out[0].windowId).toBe('a');
    expect(out[0].rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('absorbs a removed BOTTOM pane into the top sibling', () => {
    const top = slot('a', 0, 0, 1000, 400);
    const bottom = slot('b', 0, 400, 1000, 400);
    const out = absorbRemovedSlot(WS, bottom, [top]);
    expect(out[0].rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('widens the left pane when the MIDDLE of three columns is removed', () => {
    const a = slot('a', 0, 0, 400, 800);
    const b = slot('b', 400, 0, 300, 800);
    const c = slot('c', 700, 0, 300, 800);
    const out = absorbRemovedSlot(WS, b, [a, c]);
    expect(byId(out, 'a').rect).toEqual({ x: 0, y: 0, width: 700, height: 800 });
    expect(byId(out, 'c').rect).toEqual({ x: 700, y: 0, width: 300, height: 800 });
    // No overlap, combined extent unchanged.
    expect(byId(out, 'a').rect.width + byId(out, 'c').rect.width).toBe(1000);
  });

  it('repartitions cleanly when no survivor is edge-adjacent', () => {
    const removed = slot('gone', 0, 0, 100, 100);
    const p = slot('p', 200, 200, 100, 100);
    const q = slot('q', 400, 400, 100, 100);
    const out = absorbRemovedSlot(WS, removed, [p, q]);
    expect(out.map((s) => s.windowId)).toEqual(['p', 'q']);
    expect(out[0].rect).toEqual({ x: 0, y: 0, width: 500, height: 800 });
    expect(out[1].rect).toEqual({ x: 500, y: 0, width: 500, height: 800 });
  });

  it('returns an empty arrangement when nothing remains', () => {
    expect(absorbRemovedSlot(WS, slot('a', 0, 0, 500, 800), [])).toEqual([]);
  });
});

describe('findPaneNeighbor (R12)', () => {
  const tl = slot('tl', 0, 0, 500, 400);
  const tr = slot('tr', 500, 0, 500, 400);
  const bl = slot('bl', 0, 400, 500, 400);
  const br = slot('br', 500, 400, 500, 400);
  const grid = [tl, tr, bl, br];

  it('picks the horizontally aligned neighbour first', () => {
    expect(findPaneNeighbor(tl, 'right', grid)?.windowId).toBe('tr');
    expect(findPaneNeighbor(br, 'left', grid)?.windowId).toBe('bl');
  });

  it('picks the vertically aligned neighbour first', () => {
    expect(findPaneNeighbor(tl, 'down', grid)?.windowId).toBe('bl');
    expect(findPaneNeighbor(tr, 'down', grid)?.windowId).toBe('br');
    expect(findPaneNeighbor(br, 'up', grid)?.windowId).toBe('tr');
  });

  it('returns null at every boundary (no focus trap)', () => {
    expect(findPaneNeighbor(tl, 'left', grid)).toBeNull();
    expect(findPaneNeighbor(tl, 'up', grid)).toBeNull();
    expect(findPaneNeighbor(tr, 'up', grid)).toBeNull();
    expect(findPaneNeighbor(bl, 'left', grid)).toBeNull();
    expect(findPaneNeighbor(br, 'right', grid)).toBeNull();
    expect(findPaneNeighbor(br, 'down', grid)).toBeNull();
  });

  it('is a no-op when it is the only pane', () => {
    expect(findPaneNeighbor(tl, 'right', [tl])).toBeNull();
  });
});

describe('workspaceLayoutStore.removePane — reflow (R10)', () => {
  beforeEach(() => {
    resetWorkspaceLayoutStoreForTests();
    setLayoutWorkspace(WS);
  });

  afterEach(() => {
    resetWorkspaceLayoutStoreForTests();
  });

  it('absorbs the freed space into the adjacent sibling', () => {
    addPane('a', 'left');
    addPane('b', 'right');
    removePane('a');

    const slots = getLayoutSnapshot().activeSlots;
    expect(slots.map((s) => s.windowId)).toEqual(['b']);
    expect(slots[0].rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('clears the arrangement when the last pane is removed', () => {
    addPane('a', 'left');
    removePane('a');
    expect(getLayoutSnapshot().activeSlots).toEqual([]);
  });

  it('is a no-op for an unknown windowId', () => {
    addPane('a', 'left');
    removePane('ghost');
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual(['a']);
  });
});
