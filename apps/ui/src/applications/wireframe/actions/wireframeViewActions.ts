/**
 * Wireframe view controls (Spec #3070, ST-5, UI/UX 3.8 / R-4.2-R-4.5).
 *
 * Store-only view transforms: zoom in/out, fit page and reset view all read the
 * registered canvas stage and write `view` through `setView`; pan mode is a
 * store flag. Nothing here dispatches a document mutation, so the document,
 * the selection, the dirty flag and the undo history are never touched (R-4.2).
 *
 * The canvas needs no imperative zoom/pan API (ST-2 consumes the store view);
 * the command table (ST-3) and the companion action set (ST-6) call these
 * functions by name.
 *
 * When the canvas stage is not yet measured (`getCanvasStage()` is null or
 * degenerate) every viewport-dependent transform is a safe no-op: the current
 * view is kept and nothing throws.
 */

import {
  ZOOM_STEP,
  centrePageView,
  clampViewScale,
} from '../model/geometry';
import type { WireframeViewport } from '../model/geometry';
import {
  fitPageToViewport,
  getCanvasStage,
  getSnapshot,
  setView,
  togglePanMode,
} from '../store/wireframeDocumentStore';

/**
 * Read the measured canvas viewport, or `null` when the stage is unregistered,
 * throws, or reports a non-positive/non-finite size.
 */
function readViewport(): WireframeViewport | null {
  const stage = getCanvasStage();
  if (!stage) return null;
  try {
    const width = stage.width();
    const height = stage.height();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Remove binary floating-point noise from an accumulated step (`1 + 0.1` is
 * `1.1000000000000001`) so consecutive zoom presses land on clean values while
 * a fitted (non-round) scale still steps by the full `ZOOM_STEP`.
 */
function normaliseScale(scale: number): number {
  return Math.round(scale * 1_000_000) / 1_000_000;
}

/**
 * Apply one zoom step about the viewport centre (R-4.2): the page point under
 * the viewport centre before the step stays under the centre after it.
 * `view.x`/`view.y` are screen-space stage translations, so the world point at
 * the centre is `(centre - offset) / scale`.
 */
function zoomBy(delta: number): void {
  const viewport = readViewport();
  if (!viewport) return;

  const { view } = getSnapshot();
  const scale = clampViewScale(normaliseScale(view.scale + delta));
  if (scale === view.scale) return;

  const centreX = viewport.width / 2;
  const centreY = viewport.height / 2;
  const worldCentreX = (centreX - view.x) / view.scale;
  const worldCentreY = (centreY - view.y) / view.scale;

  setView({
    scale,
    x: centreX - worldCentreX * scale,
    y: centreY - worldCentreY * scale,
  });
}

/** Zoom in by one fixed step, clamped to 10%-400%, about the viewport centre. */
export function zoomIn(): void {
  zoomBy(ZOOM_STEP);
}

/** Zoom out by one fixed step, clamped to 10%-400%, about the viewport centre. */
export function zoomOut(): void {
  zoomBy(-ZOOM_STEP);
}

/**
 * Fit the whole page inside the measured viewport with `FIT_PAGE_MARGIN_PX`
 * breathing room and centre it (R-4.4). No-op until the stage is measured.
 */
export function fitPage(): void {
  if (!readViewport()) return;
  fitPageToViewport();
}

/** Reset to 100% with the page centred in the measured viewport (R-4.5). */
export function resetView(): void {
  const viewport = readViewport();
  if (!viewport) return;
  setView(centrePageView(getSnapshot().document.page, 1, viewport));
}

/** Flip pan mode (R-4.3). View-only; the document and selection stay intact. */
export function togglePan(): void {
  togglePanMode();
}
