/**
 * Spec #2959 ST-3 — the PURE bottom-edge layout for the persistent keyboard bar.
 *
 * The bar is a full-bleed strip pinned to the BOTTOM edge. Its bottom inset is
 * DERIVED from the ACTUAL rendered dock stack (G-253) — never a nominal sum:
 *
 *   bottomInsetPx = (dockBottomOffsetPx ?? KEYBOARD_BAR_MIN_BOTTOM_PX)
 *                 + KEYBOARD_BAR_HEIGHT_PX
 *                 + KEYBOARD_BAR_STACK_GAP_PX
 *
 * `dockBottomOffsetPx` is `measureBottomOffsetPx()` (`bottomStack.ts`): the dock's
 * live distance from the viewport bottom. No bottom-anchored dock ⇒ the `24px`
 * base ⇒ `24 + 34 + 8 = 66px`; a bottom dock at `80px` ⇒ `80 + 34 + 8 = 122px`,
 * one `height + gap` band above the which-key overlay. There is NO hide rule and
 * NO min-width clamp — the bar is present at every viewport.
 *
 * PURE: no DOM, no React, no store — a deterministic number from a number.
 */

/** Single-row bar height (px). */
export const KEYBOARD_BAR_HEIGHT_PX = 34;
/** Gap between the bar and the surface below it / the dock (px). */
export const KEYBOARD_BAR_STACK_GAP_PX = 8;
/** Base bottom inset when no bottom-anchored dock is rendered (px; mirrors WhichKey). */
export const KEYBOARD_BAR_MIN_BOTTOM_PX = 24;
/** Fade duration (opacity/transform only; none under `prefers-reduced-motion`). */
export const KEYBOARD_BAR_FADE_MS = 150;

export interface KeyboardBarLayoutInput {
  /** `measureBottomOffsetPx()` — the dock's live bottom offset, or `null` when absent. */
  readonly dockTopPx: number | null;
}

export interface KeyboardBarLayout {
  /** The bar's `bottom` inset (px). Always defined — the bar is never hidden. */
  readonly bottomInsetPx: number;
}

/**
 * Resolve the bar's bottom-edge inset. `dockTopPx` is `measureBottomOffsetPx()`
 * (`null` ⇒ the documented base). Deterministic and total — no hide outcome.
 */
export function resolveKeyboardBarLayout(input: KeyboardBarLayoutInput): KeyboardBarLayout {
  const base = input.dockTopPx ?? KEYBOARD_BAR_MIN_BOTTOM_PX;
  return {
    bottomInsetPx: base + KEYBOARD_BAR_HEIGHT_PX + KEYBOARD_BAR_STACK_GAP_PX,
  };
}
