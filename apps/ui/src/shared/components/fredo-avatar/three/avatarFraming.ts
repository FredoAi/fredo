/**
 * #3210 ST-3 — the avatar's camera framing contract.
 *
 * The flat SVG this base replaces occupied a known fraction of its canvas: the
 * union of its 58 body rects spanned x 87…927 of 1014 (0.8284) and y 67…1234 of
 * 1264 (0.9233), leaving a 0.0237 bottom margin and symmetric side margins. That
 * union is the proportion the mascot occupies inside its reserved 80x100 seat, so
 * it is the contract the orthographic camera reproduces — not a design choice.
 *
 * The table that produced it is deleted by this base's cut-over, so the four
 * fractions are FROZEN LITERALS here. Nothing shipped depends on a module this
 * spec deletes.
 *
 * Camera-space convention (what `computeOrthoFraming` returns):
 *   - `left` / `right` / `top` / `bottom` are OFFSETS from the frame centre, i.e.
 *     directly assignable to an `OrthographicCamera`'s frustum while the camera
 *     sits at the frame centre in X and at `centerY` in Y.
 *   - `centerY` is the ABSOLUTE world Y of the frame centre (the caller places the
 *     camera there); the body's feet therefore land `bottomMarginFraction` above
 *     the frame's bottom edge.
 *
 * The fitting span is the TIGHTER of the vertical and horizontal requirements, so
 * neither the height nor the width of the measured body can overflow the frame.
 */

import type { Box3 } from 'three';

/** The frozen SVG-derived framing fractions (`### Resolved Unknowns` U-5, Domain Model §3). */
export const AVATAR_FRAMING = {
  /** Body width as a fraction of the frame width (840 / 1014). */
  contentWidthFraction: 0.8284,
  /** Body height as a fraction of the frame height (1167 / 1264). */
  contentHeightFraction: 0.9233,
  /** Margin below the feet, as a fraction of the frame height (30 / 1264). */
  bottomMarginFraction: 0.0237,
  /** The body's horizontal centre as a fraction of the frame width (symmetric). */
  anchorXFraction: 0.5,
} as const;

/** A camera-space orthographic frustum plus the absolute Y of its centre. */
export interface OrthoFraming {
  /** Horizontal half-extent to the left of the frame centre (`-frameWidth / 2`). */
  readonly left: number;
  /** Horizontal half-extent to the right of the frame centre (`frameWidth / 2`). */
  readonly right: number;
  /** Vertical half-extent above the frame centre (`frameHeight / 2`). */
  readonly top: number;
  /** Vertical half-extent below the frame centre (`-frameHeight / 2`). */
  readonly bottom: number;
  /** ABSOLUTE world Y of the frame centre. */
  readonly centerY: number;
}

/**
 * Fallback aspect when the caller supplies a non-positive / non-finite one: the
 * portrait ratio every shipped avatar box uses (80x100 and 132x165).
 */
const FALLBACK_BOX_ASPECT = 0.8;

/** A degenerate (empty) measured box still has to yield a finite, drawable frame. */
const MIN_FRAME_SPAN = 1;

/**
 * Fit an orthographic frame to a measured body box.
 *
 * `boxAspect` is the render target's width / height (0.8 at both shipped sizes),
 * so the frame's own aspect always matches the canvas and nothing distorts.
 */
export function computeOrthoFraming(box: Box3, boxAspect: number): OrthoFraming {
  const aspect =
    Number.isFinite(boxAspect) && boxAspect > 0 ? boxAspect : FALLBACK_BOX_ASPECT;

  const bodyWidth = box.max.x - box.min.x;
  const bodyHeight = box.max.y - box.min.y;
  const centreX = (box.min.x + box.max.x) / 2;
  const measured =
    Number.isFinite(bodyWidth) &&
    Number.isFinite(bodyHeight) &&
    Number.isFinite(centreX) &&
    bodyWidth >= 0 &&
    bodyHeight >= 0 &&
    !box.isEmpty();

  if (!measured) {
    // No usable measurement (an empty or non-finite box): a centred unit frame, so
    // the caller still has a finite camera rather than a NaN frustum.
    const halfHeight = MIN_FRAME_SPAN / 2;
    const halfWidth = halfHeight * aspect;
    return { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight, centerY: 0 };
  }

  // The frame must be tall enough for BOTH constraints; the larger span wins.
  const spanForHeight = bodyHeight > 0 ? bodyHeight / AVATAR_FRAMING.contentHeightFraction : 0;
  const spanForWidth =
    bodyWidth > 0 ? bodyWidth / (AVATAR_FRAMING.contentWidthFraction * aspect) : 0;
  const frameHeight = Math.max(spanForHeight, spanForWidth, MIN_FRAME_SPAN);
  const frameWidth = frameHeight * aspect;

  // Feet sit `bottomMarginFraction` above the frame's bottom edge.
  const centerY =
    box.min.y - AVATAR_FRAMING.bottomMarginFraction * frameHeight + frameHeight / 2;

  return {
    left: -frameWidth / 2,
    right: frameWidth / 2,
    top: frameHeight / 2,
    bottom: -frameHeight / 2,
    centerY,
  };
}

/** The measured body box's horizontal centre — where the camera is placed in X. */
export function framingCenterX(box: Box3): number {
  const centreX = (box.min.x + box.max.x) / 2;
  return Number.isFinite(centreX) ? centreX : 0;
}
