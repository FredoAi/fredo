/**
 * #2883 ST-3 — pure reply-surface layout (R-2.1, R-2.2, R-2.3, R-3.1).
 *
 * ONE pure module owns every tier / placement / clamp / size decision for the
 * companion's SEAT reply surface, so the growth policy is unit-pinned without a
 * DOM and `SpeechBubble` stays a thin renderer (ST-4 consumes this — see the
 * plan's `### API Contracts & Data Models`).
 *
 * Invariants (binding):
 * - No React, no DOM, no theme import. `document` / `window` are never read:
 *   the four viewport-px bounds are MEASURED by the launcher (ST-2, rAF-coalesced)
 *   and passed IN.
 * - The base tier is byte-identical to today's fixed card: 240 × 120, anchored
 *   `bottom: calc(100% + 10px)` and centred on the seat slot
 *   (`SpeechBubble.tsx:26-33`, `:137-153`). Short content keeps that geometry.
 * - The grown tier is `min(560, available)` wide ×
 *   `clamp(120, contentHeight, available)` tall, where `available` comes from the
 *   launcher-measured band — never the window alone.
 * - Seat placement candidates are `above > right > left` ONLY (`ReplyPlacement`
 *   has no `below` member). A seat `below` would occupy the command bar's own
 *   band and could never satisfy R-2.3; `below` stays exclusive to the fixed
 *   away-overlay path (`SpeechBubble.tsx:41-58`), which this module never touches.
 * - The grown width is capped by the launcher column's clip box (`boundsLeft` /
 *   `boundsRight`): the column is `overflowY:auto`, which per CSS clips both axes
 *   (`LauncherShell.tsx:1465-1470`), so a wider card would be clipped at the
 *   right edge (and could not be brought into view).
 * - The shipped `chooseSide` ranking/clamp for the FIXED (away overlay) path and
 *   the 208 × 268 game card are untouched by this module.
 *
 * Precondition on the inputs (holds by construction): the measured anchor is the
 * seat slot, a child of the launcher column the band is measured from, so the
 * anchor is inside the band (`boundsLeft <= anchor.left`,
 * `anchor.right <= boundsRight`) and below `safeTop`. Under that precondition
 * every grown result is contained in the band, hence in the window.
 */

/** The bar's own `maxWidth` — the reply reads as "the bar's answer". */
export const REPLY_MAX_W = 560;
/** Today's height: a grown reply is never rendered shorter than the base tier. */
export const REPLY_MIN_H = 120;
/** Tail length: the gap between the card and the seat it points at. */
export const REPLY_TAIL = 10;
/** Shared gap constant (the fixed away-overlay ranking uses it; the seat maths here is TAIL-based). */
export const REPLY_GAP = 10;
/** Safety margin kept between the card and the band's edges / the command bar's box. */
export const REPLY_MARGIN = 8;
/** Today's fixed text card width. */
export const REPLY_BASE_W = 240;
/** Today's fixed text card height. */
export const REPLY_BASE_H = 120;
/** Today's card padding (`SpeechBubble.tsx:28`). */
export const REPLY_PAD = 14;

/** Inner content height of the base card (240 × 120 minus 2 × 14 px padding). */
const REPLY_BASE_CONTENT_H = REPLY_BASE_H - REPLY_PAD * 2;

export type ReplyTier = 'base' | 'grown';

/**
 * Seat placements — ranked `above > right > left`.
 * `below` is deliberately NOT a member (see the module header).
 */
export type ReplyPlacement = 'above' | 'right' | 'left';

/** The seat slot's viewport-px rect (measured by the launcher). */
export interface ReplyAnchor {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The launcher-measured band the reply must live inside (viewport px).
 * `barrierTop` is the command-bar box top: the reply's bottom edge stays
 * `<= barrierTop - REPLY_MARGIN`, so it can never collide with the bar (R-2.3).
 */
export interface ReplySurfaceBounds {
  /** Notch bottom + `REPLY_MARGIN`. */
  safeTop: number;
  /** Command-bar box top. */
  barrierTop: number;
  /** Launcher column padding-box left + `REPLY_MARGIN` (the column clips its descendants). */
  boundsLeft: number;
  /** Launcher column padding-box right − `REPLY_MARGIN`. */
  boundsRight: number;
}

export interface ReplyGeometryInput {
  anchor: ReplyAnchor;
  /**
   * The measured band. `undefined` (or a degenerate/empty band) means "no
   * measurement" ⇒ today's behaviour exactly (base tier, no growth) — unit tests
   * and the away overlay are unaffected.
   */
  bounds?: ReplySurfaceBounds;
  /** Wrapped height of the reply at the candidate width. */
  contentHeightPx: number;
}

export interface ReplyGeometry {
  tier: ReplyTier;
  placement: ReplyPlacement;
  /** px, viewport-measured inputs. */
  width: number;
  height: number;
  /** Anchor-relative (the card is `position:absolute` inside the seat slot). */
  left: number;
  bottom: number;
  /** True when the content exceeds the height cap (the scroller takes over — R-3.1). */
  scrollable: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeContentHeight(contentHeightPx: number): number {
  return Number.isFinite(contentHeightPx) ? Math.max(0, contentHeightPx) : 0;
}

/** A band that can carry a surface at all: finite, non-empty, positive height. */
function isUsableBounds(
  bounds: ReplySurfaceBounds | undefined,
): bounds is ReplySurfaceBounds {
  if (!bounds) return false;
  const { safeTop, barrierTop, boundsLeft, boundsRight } = bounds;
  if (
    !Number.isFinite(safeTop) ||
    !Number.isFinite(barrierTop) ||
    !Number.isFinite(boundsLeft) ||
    !Number.isFinite(boundsRight)
  ) {
    return false;
  }
  return boundsRight - boundsLeft > 0 && barrierTop - safeTop > 0;
}

/**
 * `base` iff the reply fits the base card's content box (`REPLY_BASE_H - 2 * REPLY_PAD`
 * = 92 px) — so short content keeps byte-identical geometry. Unknown (non-finite)
 * content is treated as short: never grow on a measurement we do not have.
 */
export function chooseReplyTier(contentHeightPx: number): ReplyTier {
  return normalizeContentHeight(contentHeightPx) <= REPLY_BASE_CONTENT_H ? 'base' : 'grown';
}

/**
 * Ranked seat placement: `above`, then `right`, then `left`.
 *
 * `above` is chosen whenever the space between the seat and the safe top can
 * hold the minimum surface; otherwise a side placement wins when the band's
 * vertical extent (`barrierTop - REPLY_MARGIN - safeTop`) can, preferring the
 * side that actually has horizontal room. The fallback is always `above` (never
 * `below`), and `computeReplyGeometry` degrades a non-viable result to the base
 * tier.
 */
export function chooseReplyPlacement(
  anchor: ReplyAnchor,
  bounds: ReplySurfaceBounds,
): ReplyPlacement {
  const aboveAvailable = anchor.top - REPLY_TAIL - bounds.safeTop;
  if (aboveAvailable >= REPLY_MIN_H) return 'above';

  const sideAvailable = bounds.barrierTop - REPLY_MARGIN - bounds.safeTop;
  if (sideAvailable >= REPLY_MIN_H) {
    if (bounds.boundsRight - (anchor.right + REPLY_TAIL) > 0) return 'right';
    if (anchor.left - REPLY_TAIL - bounds.boundsLeft > 0) return 'left';
  }
  return 'above';
}

/** Today's card, unchanged: 240 × 120, centred on the seat, `bottom: calc(100% + TAIL)`. */
function baseGeometry(anchor: ReplyAnchor): ReplyGeometry {
  return {
    tier: 'base',
    placement: 'above',
    width: REPLY_BASE_W,
    height: REPLY_BASE_H,
    left: anchor.width / 2 - REPLY_BASE_W / 2,
    bottom: anchor.height + REPLY_TAIL,
    scrollable: false,
  };
}

function grownWidth(
  anchor: ReplyAnchor,
  bounds: ReplySurfaceBounds,
  placement: ReplyPlacement,
): number {
  if (placement === 'above') {
    return Math.max(0, Math.min(REPLY_MAX_W, bounds.boundsRight - bounds.boundsLeft));
  }
  if (placement === 'right') {
    return Math.max(0, Math.min(REPLY_MAX_W, bounds.boundsRight - (anchor.right + REPLY_TAIL)));
  }
  return Math.max(0, Math.min(REPLY_MAX_W, anchor.left - REPLY_TAIL - bounds.boundsLeft));
}

/** `clamp(REPLY_MIN_H, content, available)` with the lower bound relaxed to the available extent. */
function grownHeight(contentHeightPx: number, available: number): number {
  const content = normalizeContentHeight(contentHeightPx);
  if (available >= REPLY_MIN_H) return Math.min(Math.max(REPLY_MIN_H, content), available);
  return Math.max(0, available);
}

function grownLeft(
  anchor: ReplyAnchor,
  bounds: ReplySurfaceBounds,
  placement: ReplyPlacement,
  width: number,
): number {
  if (placement === 'above') {
    // Centred on the seat, clamped inside the measured band so nothing is clipped.
    const centred = anchor.width / 2 - width / 2;
    return clamp(
      centred,
      bounds.boundsLeft - anchor.left,
      bounds.boundsRight - width - anchor.left,
    );
  }
  if (placement === 'right') return anchor.right + REPLY_TAIL - anchor.left;
  return -(REPLY_TAIL + width);
}

function grownGeometry(
  anchor: ReplyAnchor,
  bounds: ReplySurfaceBounds,
  contentHeightPx: number,
  placement: ReplyPlacement,
): ReplyGeometry {
  const width = grownWidth(anchor, bounds, placement);
  const bottomEdgeY =
    placement === 'above' ? anchor.top - REPLY_TAIL : bounds.barrierTop - REPLY_MARGIN;
  const height = grownHeight(contentHeightPx, bottomEdgeY - bounds.safeTop);
  return {
    tier: 'grown',
    placement,
    width,
    height,
    left: grownLeft(anchor, bounds, placement, width),
    bottom: anchor.bottom - bottomEdgeY,
    scrollable: normalizeContentHeight(contentHeightPx) > height,
  };
}

/**
 * The one pure decision: content height + the measured band → tier, placement,
 * size and anchor-relative position.
 *
 * Tier `base` (exactly today's 240 × 120 geometry) is returned when the content
 * fits the base box OR when no usable band was measured. A grown result is only
 * returned when it is a real, contained rectangle; otherwise the module degrades
 * to the base tier rather than emitting a rect outside the band.
 */
export function computeReplyGeometry(input: ReplyGeometryInput): ReplyGeometry {
  const { anchor, bounds, contentHeightPx } = input;
  if (!isUsableBounds(bounds)) return baseGeometry(anchor);
  if (chooseReplyTier(contentHeightPx) === 'base') return baseGeometry(anchor);

  const placement = chooseReplyPlacement(anchor, bounds);
  const geometry = grownGeometry(anchor, bounds, contentHeightPx, placement);
  if (geometry.width <= 0 || geometry.height <= 0) return baseGeometry(anchor);
  return geometry;
}
