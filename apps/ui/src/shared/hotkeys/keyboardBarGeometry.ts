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

/**
 * Spec #2959 round 2 (F-2) — the deterministic visible-row ceiling used when the
 * list width cannot be measured (jsdom / SSR). When the width IS measurable the
 * capacity is derived from it; this is only the fallback.
 */
export const KEYBOARD_BAR_MAX_VISIBLE_ROWS = 8;
/**
 * The maximum width of one action chip (px). Every chip is clamped to this so the
 * capacity arithmetic (`listWidth / (rowWidth + gap)`) is exact and no chip can
 * blow past its allotted slot.
 */
export const KEYBOARD_BAR_ROW_MAX_WIDTH_PX = 240;
/** The width (px) reserved for the pinned `+N more` overflow chip. */
export const KEYBOARD_BAR_MORE_RESERVE_PX = 72;

/**
 * Spec #2959 round 3 (F-1) — the dedicated width budget for an UNAVAILABLE chip
 * (px). An unavailable row carries fixed content the available chip does not: the
 * `LuCircleSlash` status icon, the literal `unavailable` keyword and the declared
 * reason string (`unavailableReasonFor`, `keyboardBarModel.ts`). This budget is
 * sized to hold the longest declared reason (`'The focused control captures this
 * key'`, ~37 chars ≈ 190 px) plus the keyword, the icon, up to a 3-key `Keycap`,
 * the title floor and gaps/padding (~438 px worst case) — with margin. Only the
 * unavailable chip class uses it; the available clamp stays
 * `KEYBOARD_BAR_ROW_MAX_WIDTH_PX` (240) so the round-2 capacity arithmetic is
 * unaffected for available rows.
 */
export const KEYBOARD_BAR_UNAVAILABLE_ROW_MAX_WIDTH_PX = 480;
/**
 * The minimum width (px) of an action chip's title. The title is the ONLY
 * ellipsis target; this floor guarantees it can never collapse to a 0 px box when
 * an over-budget sibling (the un-ellipsized reason) claims the shrink.
 */
export const KEYBOARD_BAR_ROW_TITLE_MIN_WIDTH_PX = 48;
/**
 * The capacity arithmetic's row budget (px): the widest row class, so every slot
 * is large enough for EITHER an available (240 px) or an unavailable (480 px) chip.
 * Feeding this to `resolveKeyboardBarCapacity` keeps the bound deterministic and
 * clipping-free — no rendered chip can exceed its allotted slot.
 */
export const KEYBOARD_BAR_ROW_BUDGET_PX = Math.max(
  KEYBOARD_BAR_ROW_MAX_WIDTH_PX,
  KEYBOARD_BAR_UNAVAILABLE_ROW_MAX_WIDTH_PX,
);

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

export interface KeyboardBarCapacityInput {
  /**
   * The measured width of the row list (px). `null`/`undefined` (unmeasurable —
   * jsdom, SSR, or a detached/zero-width list) ⇒ the fallback ceiling.
   */
  readonly listWidthPx: number | null | undefined;
  /** The width budget of ONE row (px) — the chip clamp. */
  readonly rowWidthPx: number;
  /** The gap between adjacent rows (px). */
  readonly gapPx: number;
  /** The width (px) reserved for the pinned `+N more` chip. */
  readonly reservePx: number;
}

/**
 * Resolve how many action chips fit in `listWidthPx` (F-2). PURE and TOTAL: an
 * unknown / non-positive / non-finite width returns `KEYBOARD_BAR_MAX_VISIBLE_ROWS`
 * (the deterministic fallback); otherwise
 * `max(1, floor((listWidthPx - reservePx) / (rowWidthPx + gapPx)))`. Never `< 1`,
 * so the bar always shows at least one action when it has rows.
 */
export function resolveKeyboardBarCapacity(input: KeyboardBarCapacityInput): number {
  const { listWidthPx, rowWidthPx, gapPx, reservePx } = input;
  if (
    typeof listWidthPx !== 'number' ||
    !Number.isFinite(listWidthPx) ||
    listWidthPx <= 0
  ) {
    return KEYBOARD_BAR_MAX_VISIBLE_ROWS;
  }
  const perRow = rowWidthPx + gapPx;
  if (!Number.isFinite(perRow) || perRow <= 0) {
    return KEYBOARD_BAR_MAX_VISIBLE_ROWS;
  }
  return Math.max(1, Math.floor((listWidthPx - reservePx) / perRow));
}
