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
  TOP_STACK_ANCHOR_X_PX,
  TOP_STACK_ANCHOR_Y_PX,
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
