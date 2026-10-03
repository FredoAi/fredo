/**
 * Spec #2960 ST-1 — the shared top-cluster inset (`measureTopOffsetPx`).
 *
 * Mirrors `bottomStack.ts` (G-253): the S3 surfaces (regime chip, discovery
 * control, first-run card) are laid out in a fixed top-left cluster, and their
 * top inset must be DERIVED from the ACTUAL rendered `.fredo-window__header`
 * (borders/padding included) — never a nominal sum of heights. A maximized
 * window header is the only thing that can sit under the cluster's anchor point,
 * so only a header whose rect actually covers that point moves the cluster down;
 * otherwise the documented base inset is returned.
 *
 * No React/DOM state is held; this only measures the tree it is handed.
 *
 * Spec #2960 round 2 (F-65) — the cluster is collision-aware against a focused
 * text field. The top-left lane can hold a feature's OWN text field (e.g.
 * Mission Monitor's session-filter input), and the resting cluster would paint
 * over it. `resolveClusterTopPx` is the PURE resolver that displaces the cluster
 * vertically to clear the field (prefer below, else above, else documented
 * degradation); it takes the field + the cluster's resting box as plain rects,
 * so it holds no React/DOM state of its own.
 */

/** The window header the top inset is measured from (one per open window). */
export const TOP_STACK_HEADER_SELECTOR = '.fredo-window__header';
/** Base top inset when no header covers the anchor point (px). */
export const TOP_STACK_MIN_PX = 12;
/** The cluster's resting left offset (px) — the chip is `left: 12px`. */
export const TOP_STACK_ANCHOR_X_PX = 12;
/** The cluster's resting top offset (px) — the base anchor point. */
export const TOP_STACK_ANCHOR_Y_PX = 12;
/** Clearance between the focused field and the displaced cluster (px). */
export const TOP_STACK_CLEARANCE_GAP_PX = 8;

/** The minimal rect shape the collision resolver reads (a `DOMRect` satisfies it). */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Inputs to {@link resolveClusterTopPx}. All rects are viewport coordinates (px). */
export interface ResolveClusterTopOptions {
  /** The header-derived resting top (px) — what the cluster uses with no collision. */
  readonly restingTopPx: number;
  /** The cluster's left offset (px) — `TOP_STACK_ANCHOR_X_PX`. */
  readonly clusterLeftPx: number;
  /** The measured cluster width (px). */
  readonly clusterWidthPx: number;
  /** The measured cluster height (px). */
  readonly clusterHeightPx: number;
  /** The focused text field's rect, or `null` when no text control is focused. */
  readonly field: RectLike | null;
  /** The viewport height (px) — `window.innerHeight`. */
  readonly viewportHeightPx: number;
}

/**
 * Resolve the cluster's `top` for the current focus state (Spec #2960 round 2,
 * F-65). Pure: given the focused field's rect and the cluster's RESTING box, it
 * returns:
 *  - `restingTopPx` when there is no field or the field does not intersect the
 *    resting box (the common case — the resting inset is byte-identical to the
 *    pre-fix behaviour);
 *  - `field.bottom + TOP_STACK_CLEARANCE_GAP_PX` when the field intersects and
 *    the cluster fits BELOW it in the viewport (preferred);
 *  - `field.top - TOP_STACK_CLEARANCE_GAP_PX - clusterHeightPx` when it does not
 *    fit below but fits ABOVE (`>= 0`);
 *  - `restingTopPx` when neither side fits — a documented degradation, never a
 *    silent overlap "fix".
 */
export function resolveClusterTopPx(options: ResolveClusterTopOptions): number {
  const {
    restingTopPx,
    clusterLeftPx,
    clusterWidthPx,
    clusterHeightPx,
    field,
    viewportHeightPx,
  } = options;

  if (!field) return restingTopPx;

  const clusterRightPx = clusterLeftPx + clusterWidthPx;
  const clusterBottomPx = restingTopPx + clusterHeightPx;

  // Half-open intersection: touching edges (zero shared area) do NOT overlap.
  const intersects =
    clusterLeftPx < field.right &&
    field.left < clusterRightPx &&
    restingTopPx < field.bottom &&
    field.top < clusterBottomPx;
  if (!intersects) return restingTopPx;

  // Prefer below the field when the displaced cluster still fits in the viewport.
  const belowTopPx = field.bottom + TOP_STACK_CLEARANCE_GAP_PX;
  if (belowTopPx + clusterHeightPx <= viewportHeightPx) return belowTopPx;

  // Else above the field when the displaced cluster stays on-screen.
  const aboveTopPx = field.top - TOP_STACK_CLEARANCE_GAP_PX - clusterHeightPx;
  if (aboveTopPx >= 0) return aboveTopPx;

  // Neither side fits — documented degradation (never a silent overlap "fix").
  return restingTopPx;
}

/**
 * The header-derived top offset. Exported so the derivation can be pinned
 * directly. No covering header / a hidden / zero-size / off-anchor header yields
 * `TOP_STACK_MIN_PX`.
 */
export function measureTopOffsetPx(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return TOP_STACK_MIN_PX;
  }

  let bottom = TOP_STACK_MIN_PX;
  const headers = document.querySelectorAll<HTMLElement>(TOP_STACK_HEADER_SELECTOR);
  for (const header of headers) {
    const style = window.getComputedStyle(header);
    if (style.visibility === 'hidden' || style.display === 'none') continue;

    const rect = header.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Only a header that actually covers the cluster's anchor point pushes it down.
    const coversAnchor =
      rect.left <= TOP_STACK_ANCHOR_X_PX &&
      rect.right >= TOP_STACK_ANCHOR_X_PX &&
      rect.top <= TOP_STACK_ANCHOR_Y_PX &&
      rect.bottom >= TOP_STACK_ANCHOR_Y_PX;
    if (!coversAnchor) continue;

    bottom = Math.max(bottom, rect.bottom);
  }
  return bottom;
}
