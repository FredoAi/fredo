/**
 * Canonical FREDO avatar geometry — a pure 1:1 transcription of the
 * `.opencode/wireframes/fredo-avatar.html` rectangle decomposition.
 *
 * The wireframe draws FREDO entirely from absolutely-positioned `<div>` rects in
 * a 1014 x 1264 reference space whose vertical center axis is X = 507. Every
 * left-side rectangle is mirrored by `addMirrored` at
 * `x' = 1014 - x - width` (fredo-avatar.html:169-228), so mirror generation is a
 * derived operation here — mirrored pairs are NEVER hand-duplicated literals.
 *
 * This module is the single auditable geometry source: QA byte-diffs this table
 * against the html rect calls (fredo-avatar.html:251-653), never against planner
 * prose or pixel art. Coordinates are transcribed AS-AUTHORED — the as-authored
 * center rect (491,991,31,36) is 0.5 unit off-center and is NOT "fixed".
 *
 * Pure TS — no React, no SVG, no colors.
 */

/** The wireframe coordinate space (fredo-avatar.html:45-53). */
export const FREDO_AVATAR_SPACE = { width: 1014, height: 1264, centerX: 507 } as const;

/** The SVG viewBox that IS the wireframe coordinate space. */
export const FREDO_AVATAR_VIEWBOX = '0 0 1014 1264';

export interface FredoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One wireframe rectangle call as authored in fredo-avatar.html:251-653.
 *
 * `mirrored: true`  === html `addMirrored` (render at x AND at 1014 - x - width);
 * `mirrored: false` === html `addRect` (center bars/buttons, single render).
 */
export interface FredoAvatarSourceRect extends FredoRect {
  /** Source html line range for auditability, e.g. '251-256'. */
  src: string;
  mirrored: boolean;
}

/**
 * 31 source entries — 4 center `addRect` singles (forehead band, lower-face bar,
 * two center buttons) + 27 `addMirrored` pairs — transcribed 1:1 from the html in
 * call order. Expands to 58 rendered rects (27 x 2 + 4).
 *
 * @see C:\Code\fredo\.opencode\wireframes\fredo-avatar.html:251-653
 */
export const FREDO_AVATAR_SOURCE_RECTS: readonly FredoAvatarSourceRect[] = [
  // ---- HEAD: wide flat forehead band (single center rect) ----
  { x: 373, y: 67, width: 268, height: 38, src: '251-256', mirrored: false },
  // ---- UPPER HEAD STEPS (mirrored) ----
  { x: 320, y: 106, width: 50, height: 43, src: '265-270', mirrored: true },
  { x: 277, y: 107, width: 42, height: 41, src: '272-277', mirrored: true },
  // Upper diagonals (mirrored)
  { x: 218, y: 150, width: 58, height: 43, src: '284-289', mirrored: true },
  { x: 168, y: 194, width: 48, height: 75, src: '298-303', mirrored: true },
  // Shoulder / transition into the vertical head side (mirrored)
  { x: 123, y: 271, width: 44, height: 46, src: '311-316', mirrored: true },
  // MAIN HEAD SIDE — long vertical wall (mirrored)
  { x: 87, y: 317, width: 41, height: 267, src: '325-330', mirrored: true },
  // ---- LOWER HEAD STEPS (mirrored) ----
  { x: 126, y: 585, width: 40, height: 58, src: '337-342', mirrored: true },
  { x: 169, y: 644, width: 46, height: 41, src: '344-349', mirrored: true },
  { x: 218, y: 686, width: 58, height: 41, src: '351-356', mirrored: true },
  { x: 276, y: 727, width: 67, height: 33, src: '358-363', mirrored: true },
  // ---- LOWER-FACE BAR — broad continuous jaw (single center rect, NO mouth) ----
  { x: 344, y: 761, width: 326, height: 33, src: '377-382', mirrored: false },
  // ---- EYES — large mirrored 68x131 blocks (mirrored) ----
  { x: 323, y: 453, width: 68, height: 131, src: '398-403', mirrored: true },
  // ---- BOW TIE (mirrored) ----
  { x: 427, y: 812, width: 26, height: 10, src: '425-430', mirrored: true },
  { x: 455, y: 812, width: 23, height: 10, src: '433-438', mirrored: true },
  { x: 427, y: 823, width: 52, height: 69, src: '447-452', mirrored: true },
  { x: 479, y: 834, width: 28, height: 34, src: '459-464', mirrored: true },
  // ---- BODY / ARMS — open and fragmented, NOT a solid torso (mirrored) ----
  { x: 274, y: 824, width: 58, height: 87, src: '487-492', mirrored: true },
  { x: 358, y: 824, width: 30, height: 31, src: '499-504', mirrored: true },
  { x: 358, y: 857, width: 30, height: 26, src: '511-516', mirrored: true },
  { x: 426, y: 858, width: 26, height: 33, src: '523-528', mirrored: true },
  { x: 358, y: 885, width: 30, height: 29, src: '531-536', mirrored: true },
  // ---- CENTER BUTTON / BODY PIXELS (single center rects) ----
  { x: 492, y: 917, width: 30, height: 32, src: '545-550', mirrored: false },
  { x: 491, y: 991, width: 31, height: 36, src: '552-557', mirrored: false },
  // ---- LOWER ARMS (mirrored) ----
  { x: 241, y: 916, width: 31, height: 75, src: '570-575', mirrored: true },
  { x: 390, y: 916, width: 30, height: 33, src: '578-583', mirrored: true },
  { x: 241, y: 993, width: 31, height: 36, src: '586-591', mirrored: true },
  { x: 274, y: 1009, width: 59, height: 52, src: '594-599', mirrored: true },
  // ---- LEGS — short and wide (mirrored) ----
  { x: 327, y: 1085, width: 34, height: 115, src: '622-627', mirrored: true },
  { x: 460, y: 1097, width: 28, height: 103, src: '634-639', mirrored: true },
  // ---- FOOT — wide bottom bar (mirrored) ----
  { x: 339, y: 1201, width: 119, height: 33, src: '648-653', mirrored: true },
];

/** Expected rendered-rect count after mirror expansion (27 pairs x 2 + 4 singles). */
const EXPANDED_RECT_COUNT = 58;

/**
 * Expands mirror-source entries into the full render list: the as-authored rect
 * plus (for `mirrored: true`) its mirror at x' = 1014 - x - width.
 *
 * A bounds guard throws if any source rect (or its derived mirror) falls outside
 * the 1014 x 1264 canvas, so a mistranscribed table fails loudly instead of
 * rendering silently wrong. When fed the canonical `FREDO_AVATAR_SOURCE_RECTS`
 * constant the expansion is additionally checked for count parity (31 sources →
 * 58 rects), catching a mistranscribed `mirrored` flag that would change the
 * rendered count.
 */
export function expandFredoRects(src: readonly FredoAvatarSourceRect[]): FredoRect[] {
  const expanded: FredoRect[] = [];
  let mirroredCount = 0;
  for (const rect of src) {
    if (
      !Number.isInteger(rect.x) ||
      !Number.isInteger(rect.y) ||
      !Number.isInteger(rect.width) ||
      !Number.isInteger(rect.height)
    ) {
      throw new Error(`fredoAvatarGeometry: non-integer rect at html ${rect.src}: ${JSON.stringify(rect)}`);
    }
    if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`fredoAvatarGeometry: out-of-canvas rect at html ${rect.src}: ${JSON.stringify(rect)}`);
    }
    if (
      rect.x + rect.width > FREDO_AVATAR_SPACE.width ||
      rect.y + rect.height > FREDO_AVATAR_SPACE.height
    ) {
      throw new Error(
        `fredoAvatarGeometry: rect exceeds ${FREDO_AVATAR_SPACE.width}x${FREDO_AVATAR_SPACE.height} canvas at html ${rect.src}: ${JSON.stringify(rect)}`,
      );
    }

    expanded.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    if (rect.mirrored) {
      const mirrorX = FREDO_AVATAR_SPACE.width - rect.x - rect.width;
      if (mirrorX < 0 || mirrorX + rect.width > FREDO_AVATAR_SPACE.width) {
        throw new Error(
          `fredoAvatarGeometry: mirrored rect exceeds canvas at html ${rect.src}: mirrorX=${mirrorX} for ${JSON.stringify(rect)}`,
        );
      }
      mirroredCount += 1;
      expanded.push({ x: mirrorX, y: rect.y, width: rect.width, height: rect.height });
    }
  }

  if (src === FREDO_AVATAR_SOURCE_RECTS && expanded.length !== EXPANDED_RECT_COUNT) {
    throw new Error(
      `fredoAvatarGeometry: canonical table count parity failed — ${src.length} source rects (${mirroredCount} mirrored) expand to ${expanded.length}, expected ${EXPANDED_RECT_COUNT}`,
    );
  }

  return expanded;
}
