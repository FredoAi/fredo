/**
 * Own window-kernel float geometry (Spec #2924 ST-1) — pure, DOM-free rules.
 *
 * The float geometry math used to live inline in `WindowFrame` (a 48 + idx·16
 * cascade offset seeded into `useState`). Spec #2924 makes full-bleed the
 * kernel default, so a restored float must instead be *derived* from the
 * measured workspace: centered, cascade-free, and no larger than the default
 * card. Extracting it here keeps that rule unit-testable without a DOM and
 * gives the frame ONE source for the size/inset constants.
 *
 * Geometry stays frame-local (no store field) — this module is the shared
 * pure implementation, not state.
 */

/** A frame rect in workspace coordinates. */
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The measured workspace (the `WindowManager` container) — width/height only. */
export interface WorkspaceSize {
  width: number;
  height: number;
}

/** Preferred floating card size (Spec #2807 ballpark). */
export const DEFAULT_WIDTH = 480;
export const DEFAULT_HEIGHT = 320;

/** Minimum floating size — resize floors (REQ-7, unchanged from #2807). */
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 200;

/** At least this much of a floating window stays inside the workspace. */
export const GESTURE_INSET = 24;

/**
 * Container-derived CENTERED float (REQ-8) — never a cascade offset.
 *
 * Size = `min(DEFAULT, workspace − 2×GESTURE_INSET)` floored at MIN, centered
 * in the workspace. When the workspace is unmeasured (`null` or a zero/degenerate
 * rect — jsdom / pre-layout), falls back to `DEFAULT_WIDTH × DEFAULT_HEIGHT`
 * at `0,0`.
 */
export function resolveFloatGeometry(workspace: WorkspaceSize | null): Geometry {
  if (!workspace || workspace.width <= 0 || workspace.height <= 0) {
    return { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  const width = Math.max(MIN_WIDTH, Math.min(DEFAULT_WIDTH, workspace.width - GESTURE_INSET * 2));
  const height = Math.max(MIN_HEIGHT, Math.min(DEFAULT_HEIGHT, workspace.height - GESTURE_INSET * 2));
  const x = Math.max(0, (workspace.width - width) / 2);
  const y = Math.max(0, (workspace.height - height) / 2);
  return { x, y, width, height };
}

/**
 * Clamp a gesture result so the window keeps its grabbable edges inside the
 * workspace (REQ-7, #2807 behavior preserved): at least `GESTURE_INSET` of the
 * window stays on screen horizontally, and the top edge never leaves the top
 * (`y >= 0`). A `null`/degenerate workspace leaves the geometry untouched
 * (nothing to clamp against). Size is never changed here — resize floors are
 * the resize math's concern.
 */
export function clampToWorkspace(geom: Geometry, workspace: WorkspaceSize | null): Geometry {
  if (!workspace || workspace.width <= 0) return geom;
  const minX = GESTURE_INSET - geom.width;
  const maxX = workspace.width - GESTURE_INSET;
  const x = Math.min(Math.max(geom.x, minX), maxX);
  const y = Math.max(0, geom.y);
  return { ...geom, x, y };
}
