/**
 * Spec #2960 ST-1 — the shared top-cluster inset (`topStack.ts`).
 *
 * Pins the G-253 derivation: the top offset is measured from the ACTUAL rendered
 * `.fredo-window__header` (borders/padding included) that covers the cluster's
 * anchor point — never a nominal sum — and falls back to the documented base
 * inset when no header covers it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  measureTopOffsetPx,
  resolveClusterTopPx,
  TOP_STACK_ANCHOR_X_PX,
  TOP_STACK_ANCHOR_Y_PX,
  TOP_STACK_CLEARANCE_GAP_PX,
  TOP_STACK_HEADER_SELECTOR,
  TOP_STACK_MIN_PX,
} from '../topStack';

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function mountHeader(rect: Rect, style: { visibility?: string; display?: string } = {}): HTMLElement {
  const header = document.createElement('header');
  header.className = 'fredo-window__header';
  if (style.visibility) header.style.visibility = style.visibility;
  if (style.display) header.style.display = style.display;
  header.getBoundingClientRect = () =>
    ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(header);
  return header;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('topStack — binding constants', () => {
  it('declares the documented base inset and anchor point', () => {
    expect(TOP_STACK_MIN_PX).toBe(12);
    expect(TOP_STACK_ANCHOR_X_PX).toBe(12);
    expect(TOP_STACK_ANCHOR_Y_PX).toBe(12);
    expect(TOP_STACK_HEADER_SELECTOR).toBe('.fredo-window__header');
  });
});

describe('measureTopOffsetPx — header-derived inset (G-253)', () => {
  it('uses the base inset when no header is rendered', () => {
    expect(measureTopOffsetPx()).toBe(TOP_STACK_MIN_PX);
  });

  it('returns the ACTUAL rendered header bottom when it covers the anchor point', () => {
    mountHeader({ left: 0, top: 0, right: 1280, bottom: 44 });
    expect(measureTopOffsetPx()).toBe(44);
  });

  it('ignores a header that does not cover the anchor point horizontally', () => {
    mountHeader({ left: 300, top: 0, right: 900, bottom: 44 });
    expect(measureTopOffsetPx()).toBe(TOP_STACK_MIN_PX);
  });

  it('ignores a header that does not cover the anchor point vertically', () => {
    mountHeader({ left: 0, top: 200, right: 1280, bottom: 244 });
    expect(measureTopOffsetPx()).toBe(TOP_STACK_MIN_PX);
  });

  it('uses the base inset for a hidden or zero-size header', () => {
    mountHeader({ left: 0, top: 0, right: 1280, bottom: 44 }, { visibility: 'hidden' });
    expect(measureTopOffsetPx()).toBe(TOP_STACK_MIN_PX);

    document.body.innerHTML = '';
    mountHeader({ left: 0, top: 0, right: 1280, bottom: 44 }, { display: 'none' });
    expect(measureTopOffsetPx()).toBe(TOP_STACK_MIN_PX);

    document.body.innerHTML = '';
    mountHeader({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(measureTopOffsetPx()).toBe(TOP_STACK_MIN_PX);
  });

  it('picks the covering header among several (off-anchor headers never lower it)', () => {
    mountHeader({ left: 400, top: 0, right: 900, bottom: 44 });
    mountHeader({ left: 0, top: 0, right: 1280, bottom: 52 });
    expect(measureTopOffsetPx()).toBe(52);
  });

  it('is deterministic for identical DOM', () => {
    mountHeader({ left: 0, top: 0, right: 1280, bottom: 44 });
    expect(measureTopOffsetPx()).toBe(measureTopOffsetPx());
  });
});

// ── Collision-aware cluster placement (Spec #2960 round 2, F-65) ─────────────

describe('resolveClusterTopPx — collision-aware cluster placement (F-65)', () => {
  const RESTING_TOP_PX = TOP_STACK_MIN_PX; // 12
  const CLUSTER_LEFT_PX = TOP_STACK_ANCHOR_X_PX; // 12
  const CLUSTER_WIDTH_PX = 83;
  const CLUSTER_HEIGHT_PX = 75;
  const VIEWPORT_HEIGHT_PX = 800;

  /** The real Mission Monitor session-filter input resting rect (live F-65). */
  const MM_FIELD = { left: 24, top: 79, right: 202, bottom: 102 };

  function resolve(field: Rect | null, viewportHeightPx = VIEWPORT_HEIGHT_PX): number {
    return resolveClusterTopPx({
      restingTopPx: RESTING_TOP_PX,
      clusterLeftPx: CLUSTER_LEFT_PX,
      clusterWidthPx: CLUSTER_WIDTH_PX,
      clusterHeightPx: CLUSTER_HEIGHT_PX,
      field,
      viewportHeightPx,
    });
  }

  it('declares the documented clearance gap', () => {
    expect(TOP_STACK_CLEARANCE_GAP_PX).toBe(8);
  });

  it('returns the resting top when no field is focused', () => {
    expect(resolve(null)).toBe(RESTING_TOP_PX);
  });

  it('returns the resting top when the field is to the right of the cluster', () => {
    expect(resolve({ left: 300, top: 79, right: 478, bottom: 102 })).toBe(RESTING_TOP_PX);
  });

  it('returns the resting top when the field is above the cluster', () => {
    expect(resolve({ left: 24, top: -100, right: 202, bottom: -77 })).toBe(RESTING_TOP_PX);
  });

  it('returns the resting top when the field is below the cluster', () => {
    expect(resolve({ left: 24, top: 200, right: 202, bottom: 223 })).toBe(RESTING_TOP_PX);
  });

  it('treats edge-touching rects as non-overlapping (zero shared area)', () => {
    // Field starts exactly at the cluster's resting bottom (12 + 75 = 87).
    expect(resolve({ left: 24, top: 87, right: 202, bottom: 110 })).toBe(RESTING_TOP_PX);
  });

  it('displaces BELOW the Mission Monitor field when it fits', () => {
    // 102 (field.bottom) + 8 (gap) = 110; 110 + 75 = 185 <= 800.
    expect(resolve(MM_FIELD)).toBe(MM_FIELD.bottom + TOP_STACK_CLEARANCE_GAP_PX);
    expect(resolve(MM_FIELD)).toBe(110);
  });

  it('displaces ABOVE the field when there is no room below', () => {
    const field = { left: 24, top: 85, right: 202, bottom: 108 };
    // Below would need 116 + 75 = 191; viewport 130 has no room.
    // Above: 85 - 8 - 75 = 2 >= 0.
    expect(resolve(field, 130)).toBe(2);
  });

  it('leaves the cluster at rest when neither side fits (documented degradation)', () => {
    const field = { left: 24, top: 50, right: 202, bottom: 73 };
    // Below: 81 + 75 = 156 > 100. Above: 50 - 8 - 75 = -33 < 0.
    expect(resolve(field, 100)).toBe(RESTING_TOP_PX);
  });
});
