/**
 * Spec #2959 ST-3 — the shared bottom inset (`measureBottomOffsetPx`).
 *
 * Extracted from `WhichKeyOverlay.tsx` (G-253) so the which-key overlay and the
 * persistent keyboard bar share ONE derivation of the bottom band rather than the
 * bar importing (and coupling to) another surface's module. The overlay re-exports
 * this function, so its public API and behaviour are unchanged.
 *
 * Spec #2954 ST-4 — the persistent `app-dock` was removed, so the previous
 * `[data-testid="app-dock"]` rect measurement matched nothing. The dock lookup is
 * retired: the offset is the documented base inset (`BOTTOM_STACK_MIN_PX`)
 * unconditionally, for both the persistent keyboard bar and the which-key overlay.
 */

/** Base bottom inset when no bottom-anchored dock is rendered (px). */
export const BOTTOM_STACK_MIN_PX = 24;

/**
 * The bottom offset for the consuming surfaces. Exported so the derivation can be
 * pinned directly. The persistent dock was removed (Spec #2954 ST-4), so this is
 * the base inset unconditionally — there is no dock measurement left to perform.
 */
export function measureBottomOffsetPx(): number {
  return BOTTOM_STACK_MIN_PX;
}
