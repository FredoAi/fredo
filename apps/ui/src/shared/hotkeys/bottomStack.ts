/**
 * Spec #2959 ST-3 — the shared dock-derived bottom inset (`measureBottomOffsetPx`).
 *
 * Extracted verbatim from `WhichKeyOverlay.tsx` (G-253) so the which-key overlay
 * and the persistent keyboard bar share ONE derivation of the bottom band rather
 * than the bar importing (and coupling to) another surface's module. The overlay
 * re-exports this function, so its public API and behaviour are byte-identical.
 *
 * Measures `[data-testid="app-dock"]`'s LIVE `getBoundingClientRect().top`, so the
 * REAL rendered dock height (borders/padding included) is used — never a sum of
 * nominal constants. A hidden (edge-peek) dock, a side-rail dock (not anchored to
 * the bottom edge), or no dock at all yields the documented base inset.
 */

/** The dock root the offset is measured from; absent when zero windows. */
export const BOTTOM_STACK_DOCK_SELECTOR = '[data-testid="app-dock"]';
/** Base bottom inset when no bottom-anchored dock is rendered (px). */
export const BOTTOM_STACK_MIN_PX = 24;
/** Gap between the measured dock top and the consuming surface's bottom edge (px). */
export const BOTTOM_STACK_GAP_PX = 16;
/** Tolerance for "is the dock anchored at the bottom edge" (px). The bottom pill
 *  rests `12px` above the viewport edge, so the window is generous enough to
 *  admit a bottom inset while still excluding a mid-viewport side rail. */
const BOTTOM_STACK_DOCK_BOTTOM_TOLERANCE_PX = 64;

/**
 * The dock-derived bottom offset. Exported so the derivation can be pinned
 * directly. A non-rendered / hidden / side-rail dock yields `BOTTOM_STACK_MIN_PX`.
 */
export function measureBottomOffsetPx(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return BOTTOM_STACK_MIN_PX;
  }
  const dock = document.querySelector<HTMLElement>(BOTTOM_STACK_DOCK_SELECTOR);
  if (!dock) return BOTTOM_STACK_MIN_PX;

  const style = window.getComputedStyle(dock);
  if (style.visibility === 'hidden' || style.display === 'none') return BOTTOM_STACK_MIN_PX;

  const viewportH = window.innerHeight;
  const rect = dock.getBoundingClientRect();
  // Only a dock anchored at the bottom edge clears the surface; a left rail does not.
  if (rect.bottom < viewportH - BOTTOM_STACK_DOCK_BOTTOM_TOLERANCE_PX) return BOTTOM_STACK_MIN_PX;

  return Math.max(BOTTOM_STACK_MIN_PX, viewportH - rect.top + BOTTOM_STACK_GAP_PX);
}
