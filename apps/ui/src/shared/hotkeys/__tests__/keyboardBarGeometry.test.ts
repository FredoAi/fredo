/**
 * Spec #2959 ST-3 — the PURE bottom-edge keyboard-bar geometry.
 *
 * Pins the binding constants, the dock-derived inset (G-253 — no nominal sum),
 * the documented no-dock / bottom-dock reconciliations, and the invariant that
 * there is NO hide rule and NO min-width clamp (the bar is always present).
 */

import { describe, expect, it } from 'vitest';

import {
  KEYBOARD_BAR_FADE_MS,
  KEYBOARD_BAR_HEIGHT_PX,
  KEYBOARD_BAR_MIN_BOTTOM_PX,
  KEYBOARD_BAR_STACK_GAP_PX,
  resolveKeyboardBarLayout,
} from '../keyboardBarGeometry';

describe('keyboardBarGeometry — binding constants', () => {
  it('declares the exact contract values', () => {
    expect(KEYBOARD_BAR_HEIGHT_PX).toBe(34);
    expect(KEYBOARD_BAR_STACK_GAP_PX).toBe(8);
    expect(KEYBOARD_BAR_MIN_BOTTOM_PX).toBe(24);
    expect(KEYBOARD_BAR_FADE_MS).toBe(150);
  });
});

describe('resolveKeyboardBarLayout — dock-derived bottom inset (G-253)', () => {
  it('uses the 66px base inset when no dock offset is measured (null)', () => {
    const expected = KEYBOARD_BAR_MIN_BOTTOM_PX + KEYBOARD_BAR_HEIGHT_PX + KEYBOARD_BAR_STACK_GAP_PX;
    expect(resolveKeyboardBarLayout({ dockTopPx: null }).bottomInsetPx).toBe(expected);
    expect(expected).toBe(66);
  });

  it('stacks one height+gap band above a bottom dock (80px dock → 122px)', () => {
    expect(resolveKeyboardBarLayout({ dockTopPx: 80 }).bottomInsetPx).toBe(122);
  });

  it('adds the bar band on top of the measured offset (no nominal height sum)', () => {
    expect(resolveKeyboardBarLayout({ dockTopPx: 100 }).bottomInsetPx).toBe(
      100 + KEYBOARD_BAR_HEIGHT_PX + KEYBOARD_BAR_STACK_GAP_PX,
    );
  });

  it('has NO hide rule and NO min-width clamp: every input yields a positive band', () => {
    for (const dockTopPx of [null, 24, 42, 80, 200]) {
      const layout = resolveKeyboardBarLayout({ dockTopPx });
      expect(layout.bottomInsetPx).toBeGreaterThanOrEqual(
        KEYBOARD_BAR_HEIGHT_PX + KEYBOARD_BAR_STACK_GAP_PX,
      );
      expect('hidden' in layout).toBe(false);
    }
  });

  it('is deterministic for identical input', () => {
    expect(resolveKeyboardBarLayout({ dockTopPx: 80 })).toEqual(
      resolveKeyboardBarLayout({ dockTopPx: 80 }),
    );
  });
});
