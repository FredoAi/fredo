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

/**
 * #2917 ST-1 — ADDITIVE interior-fill geometry (head interior + mouth void).
 *
 * This table is SEPARATE from `FREDO_AVATAR_SOURCE_RECTS`: the 58 base rects stay
 * byte-identical (the canonical count-parity guard is keyed off the base table
 * only — `expandFredoRects`), and the fill is rendered as ONE `<path>` (never a
 * `<rect>`), so `svg.querySelectorAll('rect')` stays exactly 58.
 *
 * Bands 1–9 tile the head cavity (#2917): rows 1–5 cover the head interior (the
 * eyes sit on top of the fill) and rows 6–9 cover the mouth void down to the jaw
 * bar (y=761). Their x-ranges are the cavity's inner faces expanded 6 units
 * outward so each band tucks UNDER the opaque accent rim (invisible there) and
 * every band is symmetric about X=507.
 *
 * Bands 10–17 (#2922) extend the SAME single fill through the body cavity
 * (torso/hips/legs, y 824–1200) so the whole figure reads opaque: the inter-leg
 * slit (x 488–526) and the shoulder/neck + armpit notches stay background (bound
 * negative space, never filled), the feet rows keep the between-feet gap, and
 * each band tucks ~6 units under the base-rect rim so no fill paints past the
 * silhouette.
 *
 * Bands 6 and 7 are trimmed 1 unit at their bottom edge (h=58 / h=41) versus the
 * triage table (h=59 / h=42): the head rim steps INWARD at y=644 (the inner face
 * jumps x166 → x215 on the left and x848 → x799 on the right) and again at
 * y=686 (x215 → x276 / x799 → x738). A band that extends across those step lines
 * would expose the fill outside the head silhouette (9–15 units horizontally
 * over 1 unit of height), exceeding the plan's own ≤8-unit tolerance. Band 6's
 * width is 694 (not 700) so it tucks exactly 6 units under both rim faces, per
 * the table's stated "inner faces expanded 6 units outward" rule.
 *
 * @see C:\Code\fredo\.opencode\wireframes\fredo-avatar.html
 */
export const FREDO_AVATAR_INTERIOR_RECTS: readonly FredoAvatarSourceRect[] = [
  { x: 364, y: 106, width: 286, height: 43, src: 'interior-1', mirrored: false }, // crown under forehead band
  { x: 270, y: 150, width: 474, height: 44, src: 'interior-2', mirrored: false }, // crown
  { x: 210, y: 194, width: 594, height: 76, src: 'interior-3', mirrored: false }, // crown
  { x: 161, y: 270, width: 692, height: 47, src: 'interior-4', mirrored: false }, // crown → temples
  { x: 122, y: 317, width: 770, height: 268, src: 'interior-5', mirrored: false }, // face (eyes on top)
  { x: 160, y: 585, width: 694, height: 58, src: 'interior-6', mirrored: false }, // lower face
  { x: 209, y: 644, width: 596, height: 41, src: 'interior-7', mirrored: false }, // mouth void
  { x: 270, y: 686, width: 474, height: 42, src: 'interior-8', mirrored: false }, // mouth void
  { x: 337, y: 727, width: 340, height: 34, src: 'interior-9', mirrored: false }, // mouth void → jaw
  // ---- #2922 ST-1 — BODY interior fill (torso, hips, legs; additive, appended
  // AFTER the byte-identical 9 head bands). Tiles the body cavity so the torso,
  // arms and legs render opaque instead of letting the page show through. The
  // inter-leg slit (x 488–526, y 1097–1200) and the shoulder/neck + armpit
  // notches stay background (bound negative space); every band tucks ~6 units
  // under the opaque base-rect rim so its free edges terminate on an existing rim
  // edge and no fill paints past the silhouette. The feet rows (y 1201–1234) keep
  // the between-feet gap so two legs stay two legs.
  { x: 382, y: 824, width: 51, height: 10, src: 'interior-10', mirrored: false }, // left chest cavity, tucked 6 under the inner-arm + bow-tie rims
  { x: 581, y: 824, width: 51, height: 10, src: 'interior-11', mirrored: false }, // right chest cavity (mirror of band 10)
  { x: 382, y: 834, width: 250, height: 82, src: 'interior-12', mirrored: false }, // torso core — bow-tie knot + chest → waist, tucked under both inner-arm rims
  { x: 414, y: 916, width: 186, height: 93, src: 'interior-13', mirrored: false }, // lower torso around the centre button, tucked 6 under the inner lower-arm rims
  { x: 327, y: 1009, width: 360, height: 52, src: 'interior-14', mirrored: false }, // hips, tucked 6 under the hip rims
  { x: 327, y: 1061, width: 360, height: 24, src: 'interior-15', mirrored: false }, // hip → leg bridge — closes the rim gap so the body reads solid to the legs
  { x: 355, y: 1085, width: 133, height: 115, src: 'interior-16', mirrored: false }, // left leg interior, stops at the inter-leg slit (x 488)
  { x: 526, y: 1085, width: 133, height: 115, src: 'interior-17', mirrored: false }, // right leg interior (mirror of band 16), stops at the inter-leg slit (x 526)
];

/**
 * #2917 ST-1 — builds the single `<path>` `d` for the interior fill from
 * expanded interior rects (pure; unit-tested).
 *
 * Each rect becomes the relative subpath `M x y h w v h h -w Z` (clockwise in
 * SVG space); every subpath shares one winding direction, so the non-zero fill
 * rule unions them with no seams. Overlaps between adjacent bands are harmless.
 */
export function buildInteriorPathD(rects: readonly FredoRect[]): string {
  return rects
    .map((rect) => `M ${rect.x} ${rect.y} h ${rect.width} v ${rect.height} h ${-rect.width} Z`)
    .join(' ');
}
