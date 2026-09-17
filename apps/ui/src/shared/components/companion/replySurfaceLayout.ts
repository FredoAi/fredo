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
 *
 * #2886 — the avatar-clearance contract (the SEAT and the away OVERLAY).
 * #2883 sized and clamped the surface against the window/band only, so a grown
 * reply was drawn ON Fredo. `computeReplyGeometry` above stays the byte-compatible
 * ANCHOR-RELATIVE path for callers that supply no measured avatar footprint (it is
 * what the #2883 unit suite pins). The production path is
 * `computeReplyPlacement`: it takes the MEASURED avatar footprint
 * (`.fredo-companion-avatar`, 80×100 at the seat) + the placement region as
 * first-class inputs and returns a VIEWPORT-px border box that
 *
 *   - never intersects the footprint (E1),
 *   - keeps the bound `REPLY_AVATAR_CLEARANCE` (14 px = tail 10 + 4) on the
 *     placement axis at every LIVE sample, with the FACING edge pinned at
 *     `footprint ± REPLY_AVATAR_PLACEMENT_OFFSET` — the bound PLUS
 *     `AVATAR_MOTION_RESERVE_PX` (8 px) — so the avatar's own whole-element CSS
 *     motion can never eat into the bound and growth stays one-directional with a
 *     constant strip at every size (E2/E3),
 *   - ranks `above > right > left` at the seat (`below` stays exclusive to the
 *     away overlay), rejecting any candidate that intersects the footprint, breaks
 *     the bound clearance, leaves the region or the viewport (E4/E6),
 *   - degrades to the reduced extent + `scrollable` — order height → width →
 *     NEVER the separation — when no candidate is viable (E5).
 *
 * Round-2 supersede: round 1 justified the bound against a "≤ ~5 px per side"
 * motion envelope. That was under-counted. The shipped `happy` keyframe
 * (`translateY(-3px) scale(1.03)`, origin `50% 100%`) lifts the CROWN by
 * 3 px translate + `100 × 0.03` = 3 px of top-edge scale lift = 6.0 px, and the
 * side sweeps (`joking` ±2.5°, `playful` ±3°) reach 4.4 px of corner sweep. The
 * bound is unchanged (it is the tester's `S`); the RESERVE absorbs the envelope —
 * see `AVATAR_MOTION_RESERVE_PX`.
 *
 * The size formula is NOT duplicated: the grown size still comes from
 * `grownHeight` / `REPLY_MAX_W` / `REPLY_MIN_H`; only the anchor arithmetic
 * differs (the footprint replaces the empty bubble wrapper).
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

// ── #2886 — avatar clearance + the viewport-px placement contract ────────────

/**
 * The minimum separation between the surface's border box and the avatar
 * footprint on the placement axis. BINDING value (PO decision 4): 14 px =
 * `REPLY_TAIL` (10) + 4 px of clear air at the tail tip. It out-runs the card's
 * own spacing rhythm (`REPLY_GAP` 10 > `REPLY_MARGIN` 8), and it is absolute —
 * the avatar is a constant 80×100 at the seat, so the strip is constant at every
 * surface size. This is the LIVE-separation FLOOR (`acceptsReplyCandidate`
 * rejects below it) and the tester's `S`; the PLACEMENT edge is pinned further
 * out by `AVATAR_MOTION_RESERVE_PX` so the floor survives the avatar's motion.
 */
export const REPLY_AVATAR_CLEARANCE = REPLY_TAIL + 4; // 14

/**
 * The avatar's whole-element CSS-motion envelope, absorbed by the PLACEMENT
 * offset (never by the bound). Derived from the shipped keyframes in
 * `companion.css` / `fredoAvatarIdle.css`, NOT asserted:
 *
 *  - VERTICAL 6.0 px — `happy` (`translateY(-3px) scale(1.03)`, origin
 *    `50% 100%`): 3 px of translate plus `100 × 0.03` = 3 px of top-edge scale
 *    lift. The live frame the round-1 tester sampled (`scale 1.0298` +
 *    `translateY(-2.98px)`) is 5.96 px — the same keyframe, and exactly the
 *    6.00 px shortfall it measured (`14.00 − 8.00`). `idle` (`translateY(-2px)`),
 *    `talk` (`scaleY(1.02)`), `teleport-in` (`scale(1.04)`) and `thinking` stay
 *    ≤ 2.0 px.
 *  - HORIZONTAL 4.4 px — the side sweeps: `joking` `rotate(±2.5°)` about
 *    `50% 100%` and `playful` `rotate(±3°)` about `50% 85%`; the corner sweep is
 *    `40·sin 3° + 85·(1−cos 3°) ≈ 4.39 px`.
 *
 * 8 = ceil(6.0) + 2 px of sub-pixel headroom, so the LIVE measured separation on
 * the placement axis never drops below the bound (`22 − 6.0 = 16.0`).
 */
export const AVATAR_MOTION_RESERVE_PX = 8;

/**
 * The facing-edge pin used by every candidate (`facingY` / `belowY`, the
 * horizontal span and the width budget): the bound PLUS the motion reserve. With
 * a motion-invariant LAYOUT-box anchor (the entity never samples the animated
 * rect — see `CompanionEntity.measureAvatarRect`) this makes the facing edge a
 * constant for the whole generation and keeps the live separation inside
 * `[bound, offset]`.
 */
export const REPLY_AVATAR_PLACEMENT_OFFSET =
  REPLY_AVATAR_CLEARANCE + AVATAR_MOTION_RESERVE_PX; // 22

/**
 * The shrink+scroll FLOOR (E5): at/below these the surface keeps its size and
 * scrolls internally instead of growing over Fredo. The never-cover rule still
 * wins over the floor when the region itself is smaller (documented residual,
 * dev-only sub-900×600 viewports). 48 = one 19 px text line inside the card's
 * 2 × 14 px padding, rounded to the launcher field's own 48 px minimum; 160 keeps
 * ≥ 2× the avatar's 80 px width so a side card is never a sliver.
 */
export const REPLY_MIN_USABLE_W = 160;
export const REPLY_MIN_USABLE_H = 48;

/**
 * #2886 — the avatar's footprint (viewport px). Same six fields as
 * `ReplyAnchor`, but the MEANING is the avatar element's **LAYOUT box** (no CSS
 * transform) — never the wrapper that contains only the bubble, and never the
 * animated rect. The entity derives it from the offset chain at the seat /
 * `displayPos` + the declared size in the away overlay, so an idle bob, a `happy`
 * scale or a `playful` sweep can never move the placement anchor (round-1 defect:
 * `getBoundingClientRect()` of the animated wrapper WAS the anchor).
 */
export type ReplyAvatarRect = ReplyAnchor;

/** The placement region (viewport px). Same four numbers #2883's band carries. */
export interface ReplyRegion {
  /** Notch bottom + `REPLY_MARGIN` (already inset — never inset twice). */
  safeTop: number;
  /** The bar/tiles barrier top (the raw box top; `REPLY_MARGIN` is applied here). */
  barrierTop: number;
  /** Already inset by `REPLY_MARGIN`. */
  boundsLeft: number;
  /** Already inset by `REPLY_MARGIN`. */
  boundsRight: number;
}

/** Seat placements plus the away overlay's legacy `below` candidate. */
export type ReplySide = ReplyPlacement | 'below';

/** An axis-aligned border box in viewport px. */
export interface ReplyRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ReplyPlacementInput {
  /** The MEASURED avatar footprint (use `completeAvatarRect` to normalise). */
  avatar: ReplyAvatarRect;
  region: ReplyRegion;
  viewport: { width: number; height: number };
  contentHeightPx: number;
  /** The away overlay ranks `below` too; the seat never allows it. */
  allowBelow: boolean;
}

/** The ONE placement decision, in viewport px (both surfaces consume it). */
export interface ReplyPlacementResult extends ReplyRect {
  tier: ReplyTier;
  placement: ReplySide;
  /** The separation actually applied on the placement axis (>= clearance). */
  clearance: number;
  /** Content exceeds the placed height — the #2883 scroller takes over. */
  scrollable: boolean;
}

/**
 * Complete a degenerate measured rect from the declared avatar size.
 * A hidden/zero-box element reports `width`/`height` 0 (and `right`/`bottom`
 * equal to `top`/`left`) — that is the LIVE state of the wrapper that contains
 * only the bubble, and the reason the #2883 grown card collapsed. Returns `null`
 * for a missing/non-finite rect so the caller keeps its no-footprint path.
 */
export function completeAvatarRect(
  rect: ReplyAnchor | null | undefined,
  fallback: { width: number; height: number },
): ReplyAvatarRect | null {
  if (!rect) return null;
  const { top, left, right, bottom, width, height } = rect;
  if (![top, left, right, bottom, width, height].every((n) => Number.isFinite(n))) return null;
  const w = width > 0 ? width : fallback.width;
  const h = height > 0 ? height : fallback.height;
  return {
    top,
    left,
    right: width > 0 ? right : left + w,
    bottom: height > 0 ? bottom : top + h,
    width: w,
    height: h,
  };
}

/**
 * The away overlay's region when no launcher measurement reaches it (the overlay
 * is rendered outside `LauncherShell`): the published launcher `safeTop` /
 * `barrierTop` tighten the viewport-derived bounds so the fixed card also keeps
 * clear of the bar and the tiles; without a publication (terminal window) the
 * region is the viewport inset by `REPLY_MARGIN`.
 */
export function deriveAwayRegion(
  published: { region: ReplyRegion } | null | undefined,
  viewport: { width: number; height: number },
): ReplyRegion {
  const vw = Number.isFinite(viewport.width) ? viewport.width : 0;
  const vh = Number.isFinite(viewport.height) ? viewport.height : 0;
  const bottom = vh - REPLY_MARGIN;
  return {
    safeTop: published ? published.region.safeTop : REPLY_MARGIN,
    barrierTop: Math.min(published ? published.region.barrierTop : bottom, bottom),
    boundsLeft: REPLY_MARGIN,
    boundsRight: vw - REPLY_MARGIN,
  };
}

const SEAT_SIDES: ReplySide[] = ['above', 'right', 'left'];
const AWAY_SIDES: ReplySide[] = ['above', 'right', 'left', 'below'];

function rectsIntersect(a: ReplyRect, b: ReplyAnchor): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Signed separation on the placement axis (negative ⇒ overlapping on that axis). */
export function separationOnAxis(
  rect: ReplyRect,
  avatar: ReplyAvatarRect,
  placement: ReplySide,
): number {
  switch (placement) {
    case 'above':
      return avatar.top - rect.bottom;
    case 'below':
      return rect.top - avatar.bottom;
    case 'right':
      return rect.left - avatar.right;
    default:
      return avatar.left - rect.right;
  }
}

export interface ReplyCandidate {
  placement: ReplySide;
  rect: ReplyRect;
  clearance: number;
  /** The extent available on the facing axis (height for above/below, vertical for a side). */
  available: number;
  /** The horizontal budget at the placement (drives the width and the viability floor). */
  widthBudget: number;
  scrollable: boolean;
}

function widthBudgetFor(
  placement: ReplySide,
  avatar: ReplyAvatarRect,
  region: ReplyRegion,
): number {
  if (placement === 'above' || placement === 'below') return region.boundsRight - region.boundsLeft;
  if (placement === 'right') return region.boundsRight - (avatar.right + REPLY_AVATAR_PLACEMENT_OFFSET);
  return avatar.left - REPLY_AVATAR_PLACEMENT_OFFSET - region.boundsLeft;
}

/** The bar/tiles barrier: the lowest y any surface edge may reach. */
function barrierBottom(region: ReplyRegion, viewport: { width: number; height: number }): number {
  return Math.min(region.barrierTop - REPLY_MARGIN, viewport.height - REPLY_MARGIN);
}

function horizontalSpan(
  placement: ReplySide,
  avatar: ReplyAvatarRect,
  region: ReplyRegion,
  width: number,
): { left: number; right: number } {
  if (placement === 'above' || placement === 'below') {
    const centred = avatar.left + avatar.width / 2 - width / 2;
    const maxLeft = region.boundsRight - width;
    const left = maxLeft < region.boundsLeft ? region.boundsLeft : clamp(centred, region.boundsLeft, maxLeft);
    return { left, right: left + width };
  }
  if (placement === 'right') {
    const left = avatar.right + REPLY_AVATAR_PLACEMENT_OFFSET;
    return { left, right: left + width };
  }
  const right = avatar.left - REPLY_AVATAR_PLACEMENT_OFFSET;
  return { left: right - width, right };
}

/**
 * Build one candidate at a ranked placement. `reduced` relaxes the size to the
 * available extent (the E5 degrade: height first, then width — never the
 * clearance), while the facing edge stays pinned at `footprint ± clearance` in
 * both modes.
 */
function buildCandidate(
  placement: ReplySide,
  avatar: ReplyAvatarRect,
  region: ReplyRegion,
  viewport: { width: number; height: number },
  contentHeightPx: number,
  tier: ReplyTier,
  reduced: boolean,
): ReplyCandidate {
  const widthBudget = Math.max(0, widthBudgetFor(placement, avatar, region));
  const naturalWidth = tier === 'base' ? REPLY_BASE_W : Math.min(REPLY_MAX_W, widthBudget);
  const width = Math.max(0, Math.min(REPLY_MAX_W, reduced ? widthBudget : naturalWidth));
  const content = normalizeContentHeight(contentHeightPx);

  const barrier = barrierBottom(region, viewport);
  // #2886 round 2 — the FACING edge is pinned at the bound PLUS the motion reserve
  // (see `REPLY_AVATAR_PLACEMENT_OFFSET`), so the avatar's own CSS bob/scale can
  // never eat into the bound `REPLY_AVATAR_CLEARANCE` at a live sample. The
  // acceptance rule below still tests the BOUND, not the offset.
  const facingY = avatar.top - REPLY_AVATAR_PLACEMENT_OFFSET;
  const belowY = avatar.bottom + REPLY_AVATAR_PLACEMENT_OFFSET;

  const { left, right } = horizontalSpan(placement, avatar, region, width);
  const maxHeight = placement === 'above' ? facingY - region.safeTop : placement === 'below' ? barrier - belowY : barrier - region.safeTop;

  let height: number;
  if (tier === 'base' && !reduced) {
    height = REPLY_BASE_H;
  } else {
    height = grownHeight(content, maxHeight);
    if (reduced) {
      // Floor the *size*, never the separation: keep the usable minimum when the
      // region can afford it, otherwise take what the region has.
      height = Math.min(Math.max(maxHeight, 0), Math.max(content, Math.min(REPLY_MIN_USABLE_H, Math.max(maxHeight, 0))));
    }
  }

  let top: number;
  let bottom: number;
  if (placement === 'above') {
    bottom = facingY;
    top = bottom - height;
  } else if (placement === 'below') {
    top = belowY;
    bottom = top + height;
  } else {
    bottom = barrier;
    top = bottom - height;
  }

  const rect: ReplyRect = { left, top, right, bottom, width, height };
  return {
    placement,
    rect,
    clearance: separationOnAxis(rect, avatar, placement),
    available: maxHeight,
    widthBudget,
    scrollable: content > height,
  };
}

/** The ONE acceptance rule (E4/E6) — applied to a candidate's clamped rect. */
export function acceptsReplyCandidate(
  candidate: ReplyCandidate,
  avatar: ReplyAvatarRect,
  region: ReplyRegion,
  viewport: { width: number; height: number },
  tier: ReplyTier,
): boolean {
  const minWidth = tier === 'base' ? REPLY_BASE_W : REPLY_MIN_USABLE_W;
  if (candidate.widthBudget < minWidth) return false;
  if (candidate.available < REPLY_MIN_H) return false;
  const { rect } = candidate;
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rectsIntersect(rect, avatar)) return false;
  if (candidate.clearance < REPLY_AVATAR_CLEARANCE) return false;
  if (rect.bottom > region.barrierTop - REPLY_MARGIN) return false;
  if (rect.left < region.boundsLeft) return false;
  if (rect.right > region.boundsRight) return false;
  if (rect.top < region.safeTop) return false;
  if (rect.left < 0 || rect.top < 0) return false;
  if (rect.right > viewport.width || rect.bottom > viewport.height) return false;
  return true;
}

function toResult(candidate: ReplyCandidate, tier: ReplyTier): ReplyPlacementResult {
  return {
    tier,
    placement: candidate.placement,
    ...candidate.rect,
    clearance: candidate.clearance,
    scrollable: candidate.scrollable,
  };
}

/**
 * The one pure placement decision for #2886: avatar footprint + region (viewport
 * px) → tier, ranked side, border box, clearance and `scrollable`.
 *
 * The natural size is the #2883 formula (`min(560, budget)` ×
 * `clamp(120, content, available)`, base 240×120 while the content fits); a
 * candidate is accepted only when it satisfies `acceptsReplyCandidate`. When no
 * candidate is viable the first side with any room degrades to the reduced extent
 * and `scrollable: true` — never an avatar-intersecting rect (E5/E6).
 */
export function computeReplyPlacement(input: ReplyPlacementInput): ReplyPlacementResult {
  const { avatar, region, viewport, contentHeightPx, allowBelow } = input;
  const tier = chooseReplyTier(contentHeightPx);
  const sides = allowBelow ? AWAY_SIDES : SEAT_SIDES;

  for (const placement of sides) {
    const candidate = buildCandidate(placement, avatar, region, viewport, contentHeightPx, tier, false);
    if (acceptsReplyCandidate(candidate, avatar, region, viewport, tier)) {
      return toResult(candidate, tier);
    }
  }

  for (const placement of sides) {
    const candidate = buildCandidate(placement, avatar, region, viewport, contentHeightPx, 'grown', true);
    if (candidate.available <= 0 || candidate.rect.width <= 0 || candidate.rect.height <= 0) continue;
    if (rectsIntersect(candidate.rect, avatar)) continue;
    if (candidate.clearance < REPLY_AVATAR_CLEARANCE) continue;
    // E5: the degraded surface scrolls — the #2883 scroller takes the overflow.
    return { ...toResult(candidate, 'grown'), scrollable: true };
  }

  // Enclosed region (never reachable at the shipped 900×600 minimum): keep the
  // top-ranked placement, pinned to the facing edge, at whatever extent is left —
  // still never overlapping the avatar.
  const fallback = buildCandidate(sides[0], avatar, region, viewport, contentHeightPx, 'grown', true);
  return toResult(fallback, 'grown');
}
