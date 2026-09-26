/**
 * Pane layout — pure, DOM-free types + region/divider math (Spec #2949 ST-1).
 *
 * This is the single shared-state PRODUCER for the tiled workspace: it owns the
 * arrangement types (`PaneSlot` / `SavedLayout` / `WorkspaceLayoutSnapshot` /
 * `PaneDividerSpec`) and every pure rule the store and the renderers share. It
 * mirrors `windowGeometry.ts` — no DOM, no React, no store state — so the math
 * is unit-testable in isolation and has exactly ONE implementation (the live
 * store and every consumer call the same functions).
 *
 * Region model (workspace-local px — the single persisted unit):
 *   - the four edge regions split the workspace in half along one axis
 *     (`left`/`right` = vertical halves, `top`/`bottom` = horizontal halves);
 *   - the four corner regions are quarters;
 *   - `center` is the whole workspace.
 * `resolveRegionRect` narrows the region band to the largest free piece that
 * avoids the `occupied` slots, then clamps to `MIN_WIDTH` / `MIN_HEIGHT`
 * (`windowGeometry.ts`), so a layout saved on a large display degrades safely
 * on a small one.
 *
 * `PaneSlot.rect` reuses `Geometry` from `windowGeometry.ts`; no fraction-based
 * geometry is ever produced or persisted. Nothing here imports `WindowEntry` or
 * any React node — only serializable ids + px rects cross the persistence seam.
 */

import {
  MIN_WIDTH,
  MIN_HEIGHT,
  type Geometry,
  type WorkspaceSize,
} from './windowGeometry';

/** The nine region drop targets: four edges, four corners, and the center. */
export type PaneRegion =
  | 'center'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

/** The canonical ordered region list (drop-overlay / test iteration). */
export const PANE_REGIONS: readonly PaneRegion[] = [
  'center',
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

/** One window placed in the tiled workspace (`rect` is workspace-local px). */
export interface PaneSlot {
  windowId: string;
  region: PaneRegion;
  rect: Geometry;
}

/** A named saved arrangement (`id` = `crypto.randomUUID()`). */
export interface SavedLayout {
  id: string;
  name: string;
  slots: PaneSlot[];
}

/** The render-time snapshot the store exposes (stable ref until a mutation). */
export interface WorkspaceLayoutSnapshot {
  /** Ordered, keyed by `windowId`. */
  activeSlots: PaneSlot[];
  savedLayouts: SavedLayout[];
  /** Which `SavedLayout` is applied; `null` = ad-hoc arrangement. */
  activeLayoutId: string | null;
  /** True only during a move/resize gesture (R5). */
  dragging: boolean;
}

/** A shared edge between two panes → one divider. */
export interface PaneDividerSpec {
  /** `${axis}:${aWindowId}:${bWindowId}` (a = the pane before b on the axis). */
  dividerId: string;
  axis: 'vertical' | 'horizontal';
  aWindowId: string;
  bWindowId: string;
}

/** Axis a pane's shared edge runs along → its divider axis. */
export type DividerAxis = PaneDividerSpec['axis'];

/** Fallback workspace for pre-layout / unmeasured callers (jsdom, first paint). */
export const FALLBACK_WORKSPACE: WorkspaceSize = { width: 1280, height: 800 };

/** Sub-pixel tolerance for "these two edges are coincident". */
const EDGE_EPSILON = 1;
/** Sub-pixel tolerance for "these two ranges actually overlap". */
const OVERLAP_EPSILON = 0.5;

/**
 * `dividerId` builder — the ONE canonical format both `computeDividers` and the
 * store's `resizeViaDivider` rely on.
 */
export function makeDividerId(
  axis: DividerAxis,
  aWindowId: string,
  bWindowId: string,
): string {
  return `${axis}:${aWindowId}:${bWindowId}`;
}

/** Parse a `dividerId` back into its spec (returns null on a malformed id). */
export function parseDividerId(dividerId: string): PaneDividerSpec | null {
  const first = dividerId.indexOf(':');
  const second = first < 0 ? -1 : dividerId.indexOf(':', first + 1);
  if (first < 0 || second < 0) return null;
  const axis = dividerId.slice(0, first);
  if (axis !== 'vertical' && axis !== 'horizontal') return null;
  const aWindowId = dividerId.slice(first + 1, second);
  const bWindowId = dividerId.slice(second + 1);
  if (!aWindowId || !bWindowId) return null;
  return { dividerId, axis, aWindowId, bWindowId };
}

/** Region → fractional band of the workspace (exhaustive by type). */
const REGION_FRACTION: Record<
  PaneRegion,
  { x: number; y: number; width: number; height: number }
> = {
  center: { x: 0, y: 0, width: 1, height: 1 },
  left: { x: 0, y: 0, width: 0.5, height: 1 },
  right: { x: 0.5, y: 0, width: 0.5, height: 1 },
  top: { x: 0, y: 0, width: 1, height: 0.5 },
  bottom: { x: 0, y: 0.5, width: 1, height: 0.5 },
  'top-left': { x: 0, y: 0, width: 0.5, height: 0.5 },
  'top-right': { x: 0.5, y: 0, width: 0.5, height: 0.5 },
  'bottom-left': { x: 0, y: 0.5, width: 0.5, height: 0.5 },
  'bottom-right': { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
};

/** Resolve a measured (or fallback) workspace size. */
function measuredWorkspace(workspace: WorkspaceSize | null): WorkspaceSize {
  if (!workspace || workspace.width <= 0 || workspace.height <= 0) {
    return FALLBACK_WORKSPACE;
  }
  return workspace;
}

/** The full region band for `region` (before occupancy / min clamping). */
function regionBaseRect(workspace: WorkspaceSize, region: PaneRegion): Geometry {
  const fraction = REGION_FRACTION[region];
  return {
    x: fraction.x * workspace.width,
    y: fraction.y * workspace.height,
    width: fraction.width * workspace.width,
    height: fraction.height * workspace.height,
  };
}

/**
 * Clamp a pane rect to the workspace, flooring its size at `MIN_WIDTH` /
 * `MIN_HEIGHT` and keeping it fully on-screen. On a workspace smaller than the
 * floor the rect collapses to the workspace extent (never larger).
 */
export function clampPaneRect(
  rect: Geometry,
  workspace: WorkspaceSize | null,
): Geometry {
  const ws = measuredWorkspace(workspace);
  const width = Math.min(ws.width, Math.max(MIN_WIDTH, rect.width));
  const height = Math.min(ws.height, Math.max(MIN_HEIGHT, rect.height));
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, ws.width - width));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, ws.height - height));
  return { x, y, width, height };
}

/** Subtract `hole` from `base` → the up-to-four remaining rectangles. */
function subtractRect(base: Geometry, hole: Geometry): Geometry[] {
  const baseRight = base.x + base.width;
  const baseBottom = base.y + base.height;
  const holeRight = hole.x + hole.width;
  const holeBottom = hole.y + hole.height;
  if (
    holeRight <= base.x ||
    hole.x >= baseRight ||
    holeBottom <= base.y ||
    hole.y >= baseBottom
  ) {
    return [base]; // no overlap — base survives untouched
  }
  const pieces: Geometry[] = [];
  if (hole.x > base.x) {
    pieces.push({
      x: base.x,
      y: base.y,
      width: hole.x - base.x,
      height: base.height,
    });
  }
  if (holeRight < baseRight) {
    pieces.push({
      x: holeRight,
      y: base.y,
      width: baseRight - holeRight,
      height: base.height,
    });
  }
  const midLeft = Math.max(base.x, hole.x);
  const midRight = Math.min(baseRight, holeRight);
  if (hole.y > base.y) {
    pieces.push({
      x: midLeft,
      y: base.y,
      width: midRight - midLeft,
      height: hole.y - base.y,
    });
  }
  if (holeBottom < baseBottom) {
    pieces.push({
      x: midLeft,
      y: holeBottom,
      width: midRight - midLeft,
      height: baseBottom - holeBottom,
    });
  }
  return pieces.filter((piece) => piece.width > 0 && piece.height > 0);
}

/** Largest free area (ties → the first in deterministic scan order). */
function largestPiece(pieces: Geometry[]): Geometry | null {
  let best: Geometry | null = null;
  let bestArea = -1;
  for (const piece of pieces) {
    const area = piece.width * piece.height;
    if (area > bestArea) {
      bestArea = area;
      best = piece;
    }
  }
  return best;
}

/**
 * Resolve a pane rect for `region` against the measured `workspace`.
 *
 * Deterministic: the region band is halved/quartered from the workspace, then
 * narrowed to the largest free piece that avoids every `occupied` slot (so a
 * second `center` pane lands in a free half). The result is always clamped to
 * `MIN_WIDTH` / `MIN_HEIGHT` and stays inside the workspace. When the band is
 * fully claimed the band itself is returned clamped — the store treats an
 * overlap as a signal to reflow (`reflowSlots`).
 */
export function resolveRegionRect(
  workspace: WorkspaceSize | null,
  region: PaneRegion,
  occupied: PaneSlot[] = [],
): Geometry {
  const ws = measuredWorkspace(workspace);
  const band = regionBaseRect(ws, region);
  let pieces: Geometry[] = [band];
  for (const slot of occupied) {
    const remaining: Geometry[] = [];
    for (const piece of pieces) remaining.push(...subtractRect(piece, slot.rect));
    pieces = remaining;
  }
  const best = largestPiece(pieces);
  return clampPaneRect(best ?? band, ws);
}

/** Combine a horizontal band with a vertical band into a `PaneRegion`. */
function combineRegion(
  col: 'left' | 'center' | 'right',
  row: 'top' | 'center' | 'bottom',
): PaneRegion {
  if (col === 'center' && row === 'center') return 'center';
  if (row === 'center') return col;
  if (col === 'center') return row;
  return `${row}-${col}` as PaneRegion;
}

/** The `PaneRegion` nearest a point, derived from workspace thirds. */
function nearestRegion(cx: number, cy: number, ws: WorkspaceSize): PaneRegion {
  const col =
    cx < ws.width / 3 ? 'left' : cx > (2 * ws.width) / 3 ? 'right' : 'center';
  const row =
    cy < ws.height / 3 ? 'top' : cy > (2 * ws.height) / 3 ? 'bottom' : 'center';
  return combineRegion(col, row);
}

/** Grid dimensions for `n` panes: 1×N / N×1 / near-square rows×cols. */
function gridShape(n: number, ws: WorkspaceSize): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return ws.width >= ws.height ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
  if (n === 3) return ws.width >= ws.height ? { cols: 3, rows: 1 } : { cols: 1, rows: 3 };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

/**
 * Repartition `slots` into a deterministic, non-overlapping grid over the
 * workspace, assigning each slot its nearest `PaneRegion`. Used by the store
 * when a placement would overlap an existing pane (`addPane` / `movePane`) and
 * available to renderers that need a clean reflow. Order is preserved.
 */
export function reflowSlots(
  workspace: WorkspaceSize | null,
  slots: PaneSlot[],
): PaneSlot[] {
  const ws = measuredWorkspace(workspace);
  if (slots.length === 0) return [];
  const { cols, rows } = gridShape(slots.length, ws);
  const cellWidth = ws.width / cols;
  const cellHeight = ws.height / rows;
  return slots.map((slot, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const rect = clampPaneRect(
      {
        x: col * cellWidth,
        y: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      },
      ws,
    );
    return {
      ...slot,
      region: nearestRegion(rect.x + rect.width / 2, rect.y + rect.height / 2, ws),
      rect,
    };
  });
}

/**
 * Dividers for every pair of panes that share an edge: side-by-side panes (an
 * edge-coincident vertical boundary with an overlapping y-range) yield a
 * vertical divider; stacked panes yield a horizontal one. Corner-only contact
 * (a shared point) and gaps produce no divider. `a` is the pane before `b` on
 * the axis.
 */
export function computeDividers(slots: PaneSlot[]): PaneDividerSpec[] {
  const dividers: PaneDividerSpec[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const first = slots[i];
      const second = slots[j];
      const firstRight = first.rect.x + first.rect.width;
      const secondRight = second.rect.x + second.rect.width;
      const firstBottom = first.rect.y + first.rect.height;
      const secondBottom = second.rect.y + second.rect.height;
      const xOverlap =
        Math.min(firstRight, secondRight) - Math.max(first.rect.x, second.rect.x) >
        OVERLAP_EPSILON;
      const yOverlap =
        Math.min(firstBottom, secondBottom) - Math.max(first.rect.y, second.rect.y) >
        OVERLAP_EPSILON;

      if (xOverlap && Math.abs(firstBottom - second.rect.y) <= EDGE_EPSILON) {
        dividers.push(
          makeDividerSpec('horizontal', first, second),
        );
      } else if (xOverlap && Math.abs(secondBottom - first.rect.y) <= EDGE_EPSILON) {
        dividers.push(
          makeDividerSpec('horizontal', second, first),
        );
      } else if (yOverlap && Math.abs(firstRight - second.rect.x) <= EDGE_EPSILON) {
        dividers.push(
          makeDividerSpec('vertical', first, second),
        );
      } else if (yOverlap && Math.abs(secondRight - first.rect.x) <= EDGE_EPSILON) {
        dividers.push(
          makeDividerSpec('vertical', second, first),
        );
      }
    }
  }
  return dividers;
}

function makeDividerSpec(
  axis: DividerAxis,
  before: PaneSlot,
  after: PaneSlot,
): PaneDividerSpec {
  return {
    dividerId: makeDividerId(axis, before.windowId, after.windowId),
    axis,
    aWindowId: before.windowId,
    bWindowId: after.windowId,
  };
}

/**
 * Move the divider by `deltaPx` (positive = the +axis direction): the pane
 * BEFORE the divider grows, the pane AFTER it shrinks, and their combined
 * extent along the axis is held constant (the after-pane's far edge and the
 * before-pane's near edge never move). `deltaPx` is clamped so neither pane
 * drops below `MIN_WIDTH` / `MIN_HEIGHT`. Returns the SAME array reference when
 * there is nothing to change (unknown ids, zero/NaN delta, no room), so callers
 * can treat reference equality as a no-op.
 */
export function applyDividerDelta(
  slots: PaneSlot[],
  divider: PaneDividerSpec,
  deltaPx: number,
): PaneSlot[] {
  const first = slots.find((slot) => slot.windowId === divider.aWindowId);
  const second = slots.find((slot) => slot.windowId === divider.bWindowId);
  if (!first || !second || first === second || !Number.isFinite(deltaPx)) {
    return slots;
  }

  const vertical = divider.axis === 'vertical';
  // "Before" is the pane on the negative side of the axis; positive delta moves
  // the divider toward +axis, growing it and shrinking the other. Deriving this
  // from the rects (not the id order) keeps the math unambiguous.
  const firstLeads = vertical
    ? first.rect.x <= second.rect.x
    : first.rect.y <= second.rect.y;
  const before = firstLeads ? first : second;
  const after = firstLeads ? second : first;

  const floor = vertical ? MIN_WIDTH : MIN_HEIGHT;
  const beforeLength = vertical ? before.rect.width : before.rect.height;
  const afterLength = vertical ? after.rect.width : after.rect.height;
  const low = floor - beforeLength;
  const high = afterLength - floor;
  if (low > high) return slots; // combined extent can't hold both floors

  let effective = deltaPx;
  if (effective < low) effective = low;
  if (effective > high) effective = high;
  if (effective === 0) return slots;

  return slots.map((slot) => {
    if (slot.windowId === before.windowId) {
      return {
        ...slot,
        rect: vertical
          ? { ...slot.rect, width: beforeLength + effective }
          : { ...slot.rect, height: beforeLength + effective },
      };
    }
    if (slot.windowId === after.windowId) {
      return {
        ...slot,
        rect: vertical
          ? {
              ...slot.rect,
              x: slot.rect.x + effective,
              width: afterLength - effective,
            }
          : {
              ...slot.rect,
              y: slot.rect.y + effective,
              height: afterLength - effective,
            },
      };
    }
    return slot;
  });
}
