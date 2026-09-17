/**
 * #2886 — the avatar-clearance placement contract (`replySurfaceLayout`).
 *
 * STATIC / PRODUCT-UNIT pins for E1/E2/E4/E5/E6 (pure geometry, no DOM):
 *   - E1/E2: the placement NEVER intersects the measured avatar footprint and
 *            keeps `REPLY_AVATAR_CLEARANCE` on the placement axis.
 *   - E3:    the FACING edge is pinned at `footprint ± clearance` across the whole
 *            generation, so growth is one-directional and the strip is constant.
 *   - E4/E6: ranked `above > right > left` at the seat (`below` is the away
 *            overlay's last resort); a candidate that would intersect the avatar,
 *            break the clearance or leave the region is REJECTED.
 *   - E5:    when no candidate is viable the surface takes the reduced extent and
 *            scrolls — never an avatar-intersecting rect.
 *
 * The legacy anchor-relative `computeReplyGeometry` path (the #2883 contract) is
 * pinned by the untouched `replySurfaceLayout.test.ts`; this suite pins the
 * #2886 viewport-px contract only.
 */

import { describe, it, expect } from 'vitest';

import {
  REPLY_AVATAR_CLEARANCE,
  REPLY_BASE_H,
  REPLY_BASE_W,
  REPLY_GAP,
  REPLY_MARGIN,
  REPLY_MAX_W,
  REPLY_MIN_H,
  REPLY_MIN_USABLE_H,
  REPLY_MIN_USABLE_W,
  REPLY_TAIL,
  acceptsReplyCandidate,
  completeAvatarRect,
  computeReplyPlacement,
  deriveAwayRegion,
  separationOnAxis,
  type ReplyAvatarRect,
  type ReplyCandidate,
  type ReplyRect,
  type ReplyRegion,
} from '@/shared/components/companion/replySurfaceLayout';

const SEAT_W = 80;
const SEAT_H = 100;
/** Notch (58) + REPLY_MARGIN (8) — the region's already-inset top. */
const SAFE_TOP = 66;
const COLUMN_MAX_W = 960;
const COLUMN_PAD_X = 32;
/** Seat `mb="4"` (16) + the column's flex `gap={6}` (24). */
const COLUMN_GAP_ABOVE_BAR = 40;
/** 34vh — the launcher column's `paddingTop`, i.e. the seat's viewport top. */
const SEAT_TOP_FRACTION = 0.34;

function avatarAt(left: number, top: number): ReplyAvatarRect {
  return {
    top,
    left,
    right: left + SEAT_W,
    bottom: top + SEAT_H,
    width: SEAT_W,
    height: SEAT_H,
  };
}

/** Mirrors the launcher's measurement: window + seat top → the region. */
function regionFor(windowW: number, avatarTop: number): ReplyRegion {
  const columnW = Math.min(windowW, COLUMN_MAX_W);
  const columnLeft = (windowW - columnW) / 2;
  return {
    safeTop: SAFE_TOP,
    barrierTop: avatarTop + SEAT_H + COLUMN_GAP_ABOVE_BAR,
    boundsLeft: columnLeft + COLUMN_PAD_X + REPLY_MARGIN,
    boundsRight: columnLeft + columnW - COLUMN_PAD_X - REPLY_MARGIN,
  };
}

/** The shipped seat: 80×100, centred in the column, 34vh down. */
function seatScene(windowW: number, windowH: number, offsetX = 0) {
  const avatarTop = Math.round(windowH * SEAT_TOP_FRACTION);
  return {
    avatar: avatarAt(windowW / 2 - SEAT_W / 2 + offsetX, avatarTop),
    region: regionFor(windowW, avatarTop),
    viewport: { width: windowW, height: windowH },
  };
}

function intersectArea(a: ReplyRect, b: ReplyAvatarRect): number {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return ix * iy;
}

describe('#2886 — the bound clearance', () => {
  it('binds 14 px = tail 10 + 4 and out-runs the card’s own spacing rhythm', () => {
    expect(REPLY_AVATAR_CLEARANCE).toBe(14);
    expect(REPLY_AVATAR_CLEARANCE).toBe(REPLY_TAIL + 4);
    // The UI/UX design constraint that must survive: separation > GAP > MARGIN,
    // with the 10 px tail strictly inside the strip (≥ 4 px of clear air).
    expect(REPLY_AVATAR_CLEARANCE).toBeGreaterThan(REPLY_GAP);
    expect(REPLY_GAP).toBeGreaterThan(REPLY_MARGIN);
    expect(REPLY_AVATAR_CLEARANCE - REPLY_TAIL).toBeGreaterThanOrEqual(4);
  });

  it('binds the shrink+scroll floor', () => {
    expect(REPLY_MIN_USABLE_W).toBe(160);
    expect(REPLY_MIN_USABLE_H).toBe(48);
    expect(REPLY_MIN_USABLE_W).toBeGreaterThanOrEqual(SEAT_W * 2);
  });
});

describe('#2886 — completeAvatarRect (a degenerate box can never collapse the placement)', () => {
  it('passes a real measured rect through unchanged', () => {
    const rect = avatarAt(660, 306);
    expect(completeAvatarRect(rect, { width: 80, height: 100 })).toEqual(rect);
  });

  it('completes a zero-height/zero-width box from the declared avatar size', () => {
    // The LIVE state of the wrapper that contains only the bubble: height 0.
    expect(
      completeAvatarRect(
        { top: 600, left: 460, right: 460, bottom: 600, width: 0, height: 0 },
        { width: 80, height: 100 },
      ),
    ).toEqual({ top: 600, left: 460, right: 540, bottom: 700, width: 80, height: 100 });

    // A zero-HEIGHT-only box (a full-width in-flow wrapper) keeps its width.
    expect(
      completeAvatarRect(
        { top: 600, left: 460, right: 540, bottom: 600, width: 80, height: 0 },
        { width: 80, height: 100 },
      ),
    ).toEqual({ top: 600, left: 460, right: 540, bottom: 700, width: 80, height: 100 });
  });

  it('returns null for a missing or non-finite rect', () => {
    expect(completeAvatarRect(null, { width: 80, height: 100 })).toBeNull();
    expect(completeAvatarRect(undefined, { width: 80, height: 100 })).toBeNull();
    expect(
      completeAvatarRect(
        { top: Number.NaN, left: 0, right: 1, bottom: 1, width: 1, height: 1 },
        { width: 80, height: 100 },
      ),
    ).toBeNull();
  });
});

describe('#2886 — the acceptance rule (E4/E6)', () => {
  const avatar = avatarAt(660, 306);
  const region = regionFor(1400, 306);
  const viewport = { width: 1400, height: 900 };

  const REPLY_W_BUDGET = 880;
  const candidate = (rect: ReplyRect, placement: ReplyCandidate['placement'] = 'above'): ReplyCandidate => ({
    placement,
    rect,
    clearance: separationOnAxis(rect, avatar, placement),
    available: 226,
    widthBudget: REPLY_W_BUDGET,
    scrollable: false,
  });

  it('accepts a rect pinned at the clearance, inside the region', () => {
    const rect: ReplyRect = { left: 420, top: 66, right: 980, bottom: 292, width: 560, height: 226 };
    expect(candidate(rect).clearance).toBe(REPLY_AVATAR_CLEARANCE);
    expect(acceptsReplyCandidate(candidate(rect), avatar, region, viewport, 'grown')).toBe(true);
  });

  it('rejects a rect that intersects the avatar, even when it looks contained', () => {
    const rect: ReplyRect = { left: 660, top: 200, right: 900, bottom: 350, width: 240, height: 150 };
    expect(intersectArea(rect, avatar)).toBeGreaterThan(0);
    expect(acceptsReplyCandidate(candidate(rect), avatar, region, viewport, 'grown')).toBe(false);
  });

  it('rejects a rect that leaves the region (bar/tiles, column clip, notch) or the window', () => {
    const base: ReplyRect = { left: 420, top: 100, right: 980, bottom: 292, width: 560, height: 192 };
    const tooLow: ReplyRect = { ...base, bottom: region.barrierTop, top: region.barrierTop - 192 };
    const tooFarRight: ReplyRect = { ...base, right: region.boundsRight + 1 };
    const tooHigh: ReplyRect = { ...base, top: region.safeTop - 1, bottom: region.safeTop - 1 + 192 };
    const aboveWindow: ReplyRect = { ...base, left: -1, right: 559 };
    for (const rect of [tooLow, tooFarRight, tooHigh, aboveWindow]) {
      expect(acceptsReplyCandidate(candidate(rect), avatar, region, viewport, 'grown')).toBe(false);
    }
  });

  it('rejects a candidate with no usable width', () => {
    const narrow: ReplyCandidate = { ...candidate({ left: 420, top: 66, right: 980, bottom: 292, width: 560, height: 226 }), widthBudget: REPLY_MIN_USABLE_W - 1 };
    expect(acceptsReplyCandidate(narrow, avatar, region, viewport, 'grown')).toBe(false);
  });
});

describe('#2886 — the two shipped viewports (the plan’s tables)', () => {
  it('1400×900: `above`, bottom pinned at avatar.top − 14, height capped at 226 and scrolling', () => {
    const { avatar, region, viewport } = seatScene(1400, 900);
    expect(avatar.top).toBe(306);
    const placement = computeReplyPlacement({
      avatar,
      region,
      viewport,
      contentHeightPx: 5000,
      allowBelow: false,
    });

    expect(placement.placement).toBe('above');
    expect(placement.bottom).toBe(avatar.top - REPLY_AVATAR_CLEARANCE); // 292
    expect(placement.bottom).toBe(292);
    expect(placement.height).toBe(226); // 292 − safeTop 66
    expect(placement.top).toBe(region.safeTop);
    expect(placement.width).toBe(REPLY_MAX_W);
    expect(placement.scrollable).toBe(true);
    expect(placement.clearance).toBe(REPLY_AVATAR_CLEARANCE);
    expect(intersectArea(placement, avatar)).toBe(0);
  });

  it('900×600 (shipped minimum): `above`, bottom 190, height capped at 124 and scrolling', () => {
    const { avatar, region, viewport } = seatScene(900, 600);
    expect(avatar.top).toBe(204);
    const placement = computeReplyPlacement({
      avatar,
      region,
      viewport,
      contentHeightPx: 5000,
      allowBelow: false,
    });

    expect(placement.placement).toBe('above');
    expect(placement.bottom).toBe(190);
    expect(placement.height).toBe(124);
    expect(placement.scrollable).toBe(true);
    expect(placement.clearance).toBe(REPLY_AVATAR_CLEARANCE);
    expect(intersectArea(placement, avatar)).toBe(0);
    // E5: the degraded/scrolling card is never narrower than the usable floor.
    expect(placement.width).toBeGreaterThanOrEqual(REPLY_MIN_USABLE_W);
  });

  it('< 900 wide (dev viewport): the sides take over when `above` has no room', () => {
    // Avatar high in a short window: above-air = 130 − 14 − 66 = 50 < 120.
    const avatar = avatarAt(410, 130);
    const region: ReplyRegion = { safeTop: 66, barrierTop: 270, boundsLeft: 40, boundsRight: 860 };
    const viewport = { width: 900, height: 600 };
    const placement = computeReplyPlacement({ avatar, region, viewport, contentHeightPx: 5000, allowBelow: false });

    expect(placement.placement).toBe('right');
    expect(placement.left).toBe(avatar.right + REPLY_AVATAR_CLEARANCE);
    expect(placement.clearance).toBe(REPLY_AVATAR_CLEARANCE);
    expect(placement.bottom).toBe(region.barrierTop - REPLY_MARGIN);
    expect(placement.right).toBeLessThanOrEqual(region.boundsRight);
    expect(intersectArea(placement, avatar)).toBe(0);
  });

  it('mirrors to `left` when the right side has no horizontal room', () => {
    const avatar = avatarAt(410, 130);
    const region: ReplyRegion = {
      safeTop: 66,
      barrierTop: 270,
      boundsLeft: 40,
      boundsRight: avatar.right + REPLY_AVATAR_CLEARANCE,
    };
    const placement = computeReplyPlacement({
      avatar,
      region,
      viewport: { width: 900, height: 600 },
      contentHeightPx: 5000,
      allowBelow: false,
    });

    expect(placement.placement).toBe('left');
    expect(placement.right).toBe(avatar.left - REPLY_AVATAR_CLEARANCE);
    expect(placement.left).toBeGreaterThanOrEqual(region.boundsLeft);
    expect(intersectArea(placement, avatar)).toBe(0);
  });
});

describe('#2886 — a one-liner keeps today’s 240×120 (E5) at the bound clearance', () => {
  it('renders the base card centred on the avatar, 14 px above it, no scroller', () => {
    const { avatar, region, viewport } = seatScene(900, 600);
    const placement = computeReplyPlacement({
      avatar,
      region,
      viewport,
      contentHeightPx: 40,
      allowBelow: false,
    });

    expect(placement.tier).toBe('base');
    expect(placement.width).toBe(REPLY_BASE_W);
    expect(placement.height).toBe(REPLY_BASE_H);
    expect(placement.scrollable).toBe(false);
    expect(placement.left + placement.width / 2).toBe(avatar.left + avatar.width / 2);
    expect(placement.bottom).toBe(avatar.top - REPLY_AVATAR_CLEARANCE);
    expect(placement.clearance).toBe(REPLY_AVATAR_CLEARANCE);
  });
});

describe('#2886 — the facing edge is pinned across the whole generation (E3)', () => {
  it('holds the bottom edge at avatar.top − 14 and grows only upward', () => {
    const { avatar, region, viewport } = seatScene(1400, 900);
    const heights: number[] = [];
    for (const contentHeightPx of [0, 93, 150, 400, 5000]) {
      const placement = computeReplyPlacement({ avatar, region, viewport, contentHeightPx, allowBelow: false });
      expect(placement.placement).toBe('above');
      expect(placement.bottom).toBe(avatar.top - REPLY_AVATAR_CLEARANCE);
      expect(placement.top).toBeGreaterThanOrEqual(region.safeTop);
      expect(intersectArea(placement, avatar)).toBe(0);
      heights.push(placement.height);
    }
    // Growth is monotonic: base 120 → the content height → the cap.
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
    }
    expect(heights[0]).toBe(REPLY_BASE_H);
    expect(heights[heights.length - 1]).toBe(226);
  });
});

describe('#2886 — the never-cover invariant holds for every scene (E1/E4/E6)', () => {
  const windows: Array<[number, number]> = [
    [900, 600],
    [1024, 768],
    [1280, 800],
    [1400, 900],
    [1600, 1000],
    [900, 450],
  ];

  it('never intersects the avatar, never leaves the region, never picks a seat `below`', () => {
    for (const [windowW, windowH] of windows) {
      for (const offset of [-250, -120, 0, 120, 250]) {
        for (const contentHeightPx of [0, 40, 93, 500, 5000]) {
          const { avatar, region, viewport } = seatScene(windowW, windowH, offset);
          const placement = computeReplyPlacement({ avatar, region, viewport, contentHeightPx, allowBelow: false });

          expect(['above', 'right', 'left']).toContain(placement.placement);
          expect(intersectArea(placement, avatar)).toBe(0);
          expect(placement.clearance).toBeGreaterThanOrEqual(REPLY_AVATAR_CLEARANCE);
          expect(placement.width).toBeGreaterThan(0);
          expect(placement.height).toBeGreaterThan(0);
          // Region + window containment.
          expect(placement.left).toBeGreaterThanOrEqual(region.boundsLeft);
          expect(placement.right).toBeLessThanOrEqual(region.boundsRight);
          expect(placement.top).toBeGreaterThanOrEqual(region.safeTop);
          expect(placement.bottom).toBeLessThanOrEqual(region.barrierTop - REPLY_MARGIN);
          expect(placement.top).toBeGreaterThanOrEqual(0);
          expect(placement.bottom).toBeLessThanOrEqual(windowH);
          expect(placement.left).toBeGreaterThanOrEqual(0);
          expect(placement.right).toBeLessThanOrEqual(windowW);
        }
      }
    }
  });

  it('uses `below` only when the caller allows it (the away overlay)', () => {
    // No room above (20 px) and both sides are narrower than the usable floor;
    // the region itself is wide enough for the `below` candidate.
    const avatar = avatarAt(660, 100);
    const region: ReplyRegion = { safeTop: 66, barrierTop: 400, boundsLeft: 500, boundsRight: 900 };
    const viewport = { width: 900, height: 600 };

    const seat = computeReplyPlacement({ avatar, region, viewport, contentHeightPx: 5000, allowBelow: false });
    expect(['above', 'right', 'left']).toContain(seat.placement);
    expect(intersectArea(seat, avatar)).toBe(0);

    const away = computeReplyPlacement({ avatar, region, viewport, contentHeightPx: 0, allowBelow: true });
    expect(away.placement).toBe('below');
    expect(away.top).toBe(avatar.bottom + REPLY_AVATAR_CLEARANCE);
    expect(away.clearance).toBe(REPLY_AVATAR_CLEARANCE);
    expect(intersectArea(away, avatar)).toBe(0);
  });
});

describe('#2886 — no viable candidate ⇒ reduced extent + scroll, never an overlap (E5)', () => {
  it('degrades with `scrollable: true`, keeping the clearance and the pinned facing edge', () => {
    // above-air 20 px and side extent 26 px: below REPLY_MIN_H / the floor.
    const avatar = avatarAt(410, 100);
    const region: ReplyRegion = { safeTop: 66, barrierTop: 100, boundsLeft: 40, boundsRight: 860 };
    const placement = computeReplyPlacement({
      avatar,
      region,
      viewport: { width: 900, height: 600 },
      contentHeightPx: 5000,
      allowBelow: false,
    });

    expect(placement.scrollable).toBe(true);
    expect(placement.placement).toBe('above');
    expect(placement.bottom).toBe(avatar.top - REPLY_AVATAR_CLEARANCE);
    expect(placement.clearance).toBe(REPLY_AVATAR_CLEARANCE);
    expect(intersectArea(placement, avatar)).toBe(0);
    // The floor is honoured when the region can afford it; here the region itself
    // is smaller than the floor (the documented dev-only residual).
    expect(placement.height).toBeGreaterThan(0);
    expect(placement.height).toBeLessThanOrEqual(REPLY_MIN_USABLE_H);
    expect(placement.width).toBeGreaterThan(0);
  });

  it('floors the degraded height at REPLY_MIN_USABLE_H when the region can afford it', () => {
    // above-air 60 px (≥ the 48 px floor, < REPLY_MIN_H) and no side room at all;
    // short content so the floor — not the content — sets the height.
    const avatar = avatarAt(410, 140);
    const region: ReplyRegion = {
      safeTop: 66,
      barrierTop: 148,
      boundsLeft: avatar.left - REPLY_AVATAR_CLEARANCE,
      boundsRight: avatar.right + REPLY_AVATAR_CLEARANCE,
    };
    const placement = computeReplyPlacement({
      avatar,
      region,
      viewport: { width: 900, height: 600 },
      contentHeightPx: 10,
      allowBelow: false,
    });

    expect(placement.placement).toBe('above');
    expect(placement.height).toBe(REPLY_MIN_USABLE_H);
    expect(placement.scrollable).toBe(true);
    expect(placement.bottom).toBe(avatar.top - REPLY_AVATAR_CLEARANCE);
    expect(intersectArea(placement, avatar)).toBe(0);
  });
});

describe('#2886 — deriveAwayRegion', () => {
  it('tightens the viewport bounds with the published launcher region', () => {
    const published = {
      region: { safeTop: 66, barrierTop: 500, boundsLeft: 260, boundsRight: 1140 },
      viewport: { width: 1400, height: 900 },
    };
    expect(deriveAwayRegion(published, { width: 1400, height: 900 })).toEqual({
      safeTop: 66,
      barrierTop: 500,
      boundsLeft: REPLY_MARGIN,
      boundsRight: 1400 - REPLY_MARGIN,
    });
  });

  it('falls back to the viewport inset by REPLY_MARGIN without a publication (terminal window)', () => {
    expect(deriveAwayRegion(null, { width: 800, height: 600 })).toEqual({
      safeTop: REPLY_MARGIN,
      barrierTop: 600 - REPLY_MARGIN,
      boundsLeft: REPLY_MARGIN,
      boundsRight: 800 - REPLY_MARGIN,
    });
  });

  it('clamps a published barrier that would leave the viewport', () => {
    const published = {
      region: { safeTop: 66, barrierTop: 5000, boundsLeft: 0, boundsRight: 0 },
      viewport: { width: 800, height: 600 },
    };
    expect(deriveAwayRegion(published, { width: 800, height: 600 }).barrierTop).toBe(600 - REPLY_MARGIN);
  });
});
