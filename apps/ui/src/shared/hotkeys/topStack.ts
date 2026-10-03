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
 */

/** The window header the top inset is measured from (one per open window). */
export const TOP_STACK_HEADER_SELECTOR = '.fredo-window__header';
/** Base top inset when no header covers the anchor point (px). */
export const TOP_STACK_MIN_PX = 12;
/** The cluster's resting left offset (px) — the chip is `left: 12px`. */
export const TOP_STACK_ANCHOR_X_PX = 12;
/** The cluster's resting top offset (px) — the base anchor point. */
export const TOP_STACK_ANCHOR_Y_PX = 12;

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
