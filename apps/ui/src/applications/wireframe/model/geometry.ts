/**
 * Wireframe editor geometry primitives (Spec #3070, ST-1).
 *
 * Pure functions shared by the store, the canvas (ST-2), the property panel
 * (ST-4) and the view actions (ST-5). No React, no Konva, no DOM.
 *
 * `WireframeView` lives here so the model layer stays dependency-free; the
 * store re-exports it (C3).
 */

export const MIN_PAGE_SIZE = 64;
export const MAX_PAGE_SIZE = 4096;
export const MIN_VIEW_SCALE = 0.1;
export const MAX_VIEW_SCALE = 4;
/** Zoom step in scale units (`+/- 10` percentage points). */
export const ZOOM_STEP = 0.1;
/** Minimum element box in logical px. */
export const ELEMENT_MIN_SIZE = 8;
/** Fit-page breathing room around the page, in screen px. */
export const FIT_PAGE_MARGIN_PX = 32;

export interface WireframeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WireframeViewport {
  width: number;
  height: number;
}

/** View transform: `x`/`y` are screen-space stage translations. */
export interface WireframeView {
  scale: number;
  x: number;
  y: number;
}

/** Clamp a finite number into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Round a logical page dimension and clamp it to the declared 64..4096 range. */
export function clampPageDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_PAGE_SIZE;
  return clamp(Math.round(value), MIN_PAGE_SIZE, MAX_PAGE_SIZE);
}

/** Clamp the view scale to the declared 0.1..4 range. */
export function clampViewScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return clamp(scale, MIN_VIEW_SCALE, MAX_VIEW_SCALE);
}

/** Round to one decimal place (used by the `wireframe-selection-geometry` hook). */
export function roundTo1dp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** The C7 geometry hook value: `"x,y,w,h"` rounded to 1 decimal place. */
export function formatGeometry(rect: WireframeRect): string {
  return [
    roundTo1dp(rect.x),
    roundTo1dp(rect.y),
    roundTo1dp(rect.width),
    roundTo1dp(rect.height),
  ].join(',');
}

/** True when two rects overlap (touching edges do not count). */
export function rectsIntersect(a: WireframeRect, b: WireframeRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Clamp an element box so its origin stays on the page. The size is never
 * shrunk here — a box larger than the page simply anchors at the origin.
 */
export function clampRectToPage<T extends WireframeRect>(
  rect: T,
  page: { width: number; height: number },
): T {
  const maxX = Math.max(0, page.width - rect.width);
  const maxY = Math.max(0, page.height - rect.height);
  return {
    ...rect,
    x: clamp(rect.x, 0, maxX),
    y: clamp(rect.y, 0, maxY),
  };
}

/** Centre a box of `width x height` on the page, rounded to whole logical px. */
export function centredRect(
  page: { width: number; height: number },
  width: number,
  height: number,
): WireframeRect {
  return {
    x: Math.round((page.width - width) / 2),
    y: Math.round((page.height - height) / 2),
    width,
    height,
  };
}

/** Centre the page in a viewport at the given scale. */
export function centrePageView(
  page: { width: number; height: number },
  scale: number,
  viewport: WireframeViewport,
): WireframeView {
  const nextScale = clampViewScale(scale);
  return {
    scale: nextScale,
    x: (viewport.width - page.width * nextScale) / 2,
    y: (viewport.height - page.height * nextScale) / 2,
  };
}

/**
 * Fit the whole page inside the measured viewport and centre it. The page is
 * never clipped; a degenerate viewport falls back to 100% at the origin.
 */
export function fitView(
  page: { width: number; height: number },
  viewport: WireframeViewport,
  margin: number = FIT_PAGE_MARGIN_PX,
): WireframeView {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { scale: 1, x: 0, y: 0 };
  }

  const availableWidth = viewport.width - margin * 2;
  const availableHeight = viewport.height - margin * 2;
  const widthScale = availableWidth > 0 ? availableWidth / page.width : viewport.width / page.width;
  const heightScale =
    availableHeight > 0 ? availableHeight / page.height : viewport.height / page.height;
  const scale = clampViewScale(Math.min(widthScale, heightScale));

  return centrePageView(page, scale, viewport);
}
