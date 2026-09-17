/**
 * #2883 ST-3 (R-2.1, R-2.2, R-2.3, R-3.1) — the pure reply-surface layout.
 *
 * Static/product-unit pin for the growth policy: the tier boundary, the exact
 * base tier, `min(560, available)` width, `clamp(120, contentHeight, available)`
 * height, the `above > right > left` seat ranking (with `below` unreachable) and
 * the band/window containment guarantees — all without a DOM.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  REPLY_BASE_H,
  REPLY_BASE_W,
  REPLY_MARGIN,
  REPLY_MAX_W,
  REPLY_MIN_H,
  REPLY_PAD,
  REPLY_TAIL,
  chooseReplyPlacement,
  chooseReplyTier,
  computeReplyGeometry,
  type ReplyAnchor,
  type ReplyGeometry,
  type ReplyPlacement,
  type ReplySurfaceBounds,
} from '@/shared/components/companion/replySurfaceLayout';

const SEAT_W = 80;
const SEAT_H = 100;
/** Notch (58) + REPLY_MARGIN (8) — the band's top, per the plan's bound numbers. */
const SAFE_TOP = 66;
const COLUMN_MAX_W = 960;
const COLUMN_PAD_X = 32;
/** Seat `mb="4"` (16) + the column's flex `gap={6}` (24). */
const COLUMN_GAP_ABOVE_BAR = 40;
/** 34vh — the launcher column's `paddingTop`, i.e. the seat's viewport top. */
const SEAT_TOP_FRACTION = 0.34;

/** The base card's inner content box: 240 × 120 minus 2 × 14 px padding. */
const BASE_CONTENT_H = REPLY_BASE_H - REPLY_PAD * 2;

function seat(left: number, top: number): ReplyAnchor {
  return { top, left, right: left + SEAT_W, bottom: top + SEAT_H, width: SEAT_W, height: SEAT_H };
}

/** Mirrors the launcher's measurement (ST-2): window + seat top → the reply band. */
function bandFor(windowW: number, anchorTop: number): ReplySurfaceBounds {
  const columnW = Math.min(windowW, COLUMN_MAX_W);
  const columnLeft = (windowW - columnW) / 2;
  return {
    safeTop: SAFE_TOP,
    barrierTop: anchorTop + SEAT_H + COLUMN_GAP_ABOVE_BAR,
    boundsLeft: columnLeft + COLUMN_PAD_X + REPLY_MARGIN,
    boundsRight: columnLeft + columnW - COLUMN_PAD_X - REPLY_MARGIN,
  };
}

/** The shipped seat: 80×100, centred in the column, 34vh down. */
function seatLayout(windowW: number, windowH: number, seatOffsetX = 0) {
  const anchorTop = Math.round(windowH * SEAT_TOP_FRACTION);
  return {
    anchor: seat(windowW / 2 - SEAT_W / 2 + seatOffsetX, anchorTop),
    bounds: bandFor(windowW, anchorTop),
  };
}

/** The geometry is anchor-relative; this is the card's rect in viewport px. */
function viewportRect(anchor: ReplyAnchor, geometry: ReplyGeometry) {
  const left = anchor.left + geometry.left;
  const bottom = anchor.bottom - geometry.bottom;
  return { left, right: left + geometry.width, top: bottom - geometry.height, bottom };
}

describe('#2883 replySurfaceLayout — tier boundary', () => {
  it('pins the base content box the tier decision is measured against', () => {
    expect(REPLY_BASE_H).toBe(120);
    expect(REPLY_BASE_W).toBe(240);
    expect(REPLY_PAD).toBe(14);
    expect(BASE_CONTENT_H).toBe(92);
  });

  it('is `base` up to and including the base content box, `grown` one px past it', () => {
    expect(chooseReplyTier(0)).toBe('base');
    expect(chooseReplyTier(1)).toBe('base');
    expect(chooseReplyTier(BASE_CONTENT_H)).toBe('base');
    expect(chooseReplyTier(BASE_CONTENT_H + 0.5)).toBe('grown');
    expect(chooseReplyTier(BASE_CONTENT_H + 1)).toBe('grown');
    expect(chooseReplyTier(5000)).toBe('grown');
  });

  it('treats unknown content as short (never grows on a measurement it does not have)', () => {
    expect(chooseReplyTier(Number.NaN)).toBe('base');
    expect(chooseReplyTier(Number.POSITIVE_INFINITY)).toBe('base');
  });

  it('flips the whole geometry at the boundary', () => {
    const { anchor, bounds } = seatLayout(900, 600);
    expect(computeReplyGeometry({ anchor, bounds, contentHeightPx: BASE_CONTENT_H }).tier).toBe(
      'base',
    );
    expect(
      computeReplyGeometry({ anchor, bounds, contentHeightPx: BASE_CONTENT_H + 1 }).tier,
    ).toBe('grown');
  });
});

describe('#2883 replySurfaceLayout — the base tier is exactly today’s card', () => {
  it('renders 240 × 120, centred on the seat, `bottom: calc(100% + 10px)`, never scrollable', () => {
    const { anchor, bounds } = seatLayout(900, 600);
    const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 40 });

    expect(geometry.tier).toBe('base');
    expect(geometry.placement).toBe('above');
    expect(geometry.width).toBe(REPLY_BASE_W);
    expect(geometry.height).toBe(REPLY_BASE_H);
    expect(geometry.scrollable).toBe(false);
    // Today's shipped anchor math (SpeechBubble.tsx:137-153): left:50% + x:-50%, bottom:calc(100% + 10px).
    expect(geometry.left).toBe(anchor.width / 2 - REPLY_BASE_W / 2);
    expect(geometry.bottom).toBe(anchor.height + REPLY_TAIL);

    const rect = viewportRect(anchor, geometry);
    expect(rect.left + rect.right).toBe(anchor.left + anchor.right); // horizontally centred on the seat
    expect(rect.bottom).toBe(anchor.top - REPLY_TAIL); // sits TAIL above the seat
  });

  it('keeps the base tier byte-identical whether or not a band was measured', () => {
    const { anchor, bounds } = seatLayout(900, 600);
    const short = computeReplyGeometry({ anchor, bounds, contentHeightPx: 40 });
    const unmeasured = computeReplyGeometry({ anchor, contentHeightPx: 40 });
    expect(short).toEqual(unmeasured);
    expect(unmeasured).toEqual({
      tier: 'base',
      placement: 'above',
      width: REPLY_BASE_W,
      height: REPLY_BASE_H,
      left: -80,
      bottom: 110,
      scrollable: false,
    });
  });
});

describe('#2883 replySurfaceLayout — no measurement ⇒ today’s behaviour', () => {
  it('falls back to the base tier for an undefined band, even for a huge reply', () => {
    const { anchor } = seatLayout(900, 600);
    const geometry = computeReplyGeometry({ anchor, contentHeightPx: 5000 });
    expect(geometry.tier).toBe('base');
    expect(geometry.width).toBe(REPLY_BASE_W);
    expect(geometry.height).toBe(REPLY_BASE_H);
    expect(geometry.scrollable).toBe(false);
  });

  it('falls back to the base tier for an empty / degenerate band', () => {
    const { anchor } = seatLayout(900, 600);
    const empty = { safeTop: 0, barrierTop: 0, boundsLeft: 0, boundsRight: 0 };
    const blank = {} as ReplySurfaceBounds;
    for (const bounds of [empty, blank]) {
      const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
      expect(geometry.tier).toBe('base');
      expect(geometry.height).toBe(REPLY_BASE_H);
    }
  });

  it('falls back to the base tier when the band cannot carry a positive-height rect', () => {
    const anchor = seat(410, 10); // seat above the safe top
    const bounds = bandFor(900, 10);
    const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
    expect(geometry.tier).toBe('base');
    expect(geometry.height).toBe(REPLY_BASE_H);
  });
});

describe('#2883 replySurfaceLayout — grown size = min(560, available) × clamp(120, content, available)', () => {
  it('caps the width at REPLY_MAX_W when the band is wider', () => {
    const { anchor, bounds } = seatLayout(1400, 900);
    expect(bounds.boundsRight - bounds.boundsLeft).toBeGreaterThan(REPLY_MAX_W);
    const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
    expect(geometry.tier).toBe('grown');
    expect(geometry.width).toBe(REPLY_MAX_W);
    expect(REPLY_MAX_W).toBe(560);
  });

  it('caps the width at the band when the band is narrower than REPLY_MAX_W', () => {
    const narrow = seatLayout(500, 600).bounds;
    const bandWidth = narrow.boundsRight - narrow.boundsLeft;
    expect(bandWidth).toBeLessThan(REPLY_MAX_W);

    const anchor = seat(500 / 2 - SEAT_W / 2, 204);
    const geometry = computeReplyGeometry({ anchor, bounds: narrow, contentHeightPx: 5000 });
    expect(geometry.width).toBe(bandWidth);

    const rect = viewportRect(anchor, geometry);
    expect(rect.left).toBe(narrow.boundsLeft);
    expect(rect.right).toBe(narrow.boundsRight);
  });

  it('never lets the width exceed the column band (nothing clipped at either edge)', () => {
    for (const [windowW, windowH] of [
      [900, 600],
      [1024, 768],
      [1280, 800],
      [1400, 900],
      [1600, 1000],
    ]) {
      for (const offset of [-200, 0, 200]) {
        const { anchor, bounds } = seatLayout(windowW, windowH, offset);
        const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
        expect(geometry.width).toBeLessThanOrEqual(bounds.boundsRight - bounds.boundsLeft);
      }
    }
  });

  it('clamps the height: min 120, content when it fits, available when it does not (then scrolls)', () => {
    const { anchor, bounds } = seatLayout(1400, 900);
    const available = anchor.top - REPLY_TAIL - bounds.safeTop;
    expect(available).toBe(230);

    // content just past the base box still renders at least today's height
    const justGrown = computeReplyGeometry({ anchor, bounds, contentHeightPx: BASE_CONTENT_H + 1 });
    expect(justGrown.tier).toBe('grown');
    expect(justGrown.height).toBe(REPLY_MIN_H);
    expect(justGrown.scrollable).toBe(false);

    // content between the floor and the cap renders at its own height
    const mid = computeReplyGeometry({ anchor, bounds, contentHeightPx: 150 });
    expect(mid.height).toBe(150);
    expect(mid.scrollable).toBe(false);

    // content past the cap is held at the cap and scrolls (R-3.1)
    const capped = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
    expect(capped.height).toBe(available);
    expect(capped.scrollable).toBe(true);
  });

  it('holds the height at the band cap at the minimum supported window (900×600)', () => {
    const { anchor, bounds } = seatLayout(900, 600);
    expect(anchor.top - REPLY_TAIL - bounds.safeTop).toBe(128);
    const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
    expect(geometry.height).toBe(128);
    expect(geometry.scrollable).toBe(true);
  });

  it('never renders a grown reply shorter than REPLY_MIN_H when the band allows it', () => {
    for (const [windowW, windowH] of [
      [900, 600],
      [1400, 900],
      [1600, 1000],
    ]) {
      const { anchor, bounds } = seatLayout(windowW, windowH);
      const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
      expect(geometry.height).toBeGreaterThanOrEqual(REPLY_MIN_H);
    }
  });
});

describe('#2883 replySurfaceLayout — seat placement above > right > left', () => {
  it('prefers `above` whenever the space to the safe top holds the minimum surface', () => {
    const { anchor, bounds } = seatLayout(900, 600);
    expect(anchor.top - REPLY_TAIL - bounds.safeTop).toBeGreaterThanOrEqual(REPLY_MIN_H);
    expect(chooseReplyPlacement(anchor, bounds)).toBe('above');
  });

  it('prefers `above` at the exact boundary (available === REPLY_MIN_H)', () => {
    const anchor = seat(410, SAFE_TOP + REPLY_TAIL + REPLY_MIN_H);
    const bounds = bandFor(900, anchor.top);
    expect(chooseReplyPlacement(anchor, bounds)).toBe('above');
  });

  it('falls to `right` when `above` is short and the right side has room', () => {
    const anchor = seat(410, 120);
    const bounds = bandFor(900, 120);
    expect(anchor.top - REPLY_TAIL - bounds.safeTop).toBeLessThan(REPLY_MIN_H);
    expect(bounds.barrierTop - REPLY_MARGIN - bounds.safeTop).toBeGreaterThanOrEqual(REPLY_MIN_H);
    expect(bounds.boundsRight - (anchor.right + REPLY_TAIL)).toBeGreaterThan(0);
    expect(chooseReplyPlacement(anchor, bounds)).toBe('right');
  });

  it('falls to `left` when `above` is short and the right side has no room at all', () => {
    const anchor = seat(410, 120);
    const bounds = { ...bandFor(900, 120), boundsRight: anchor.right + REPLY_TAIL };
    expect(bounds.boundsRight - (anchor.right + REPLY_TAIL)).toBe(0);
    expect(anchor.left - REPLY_TAIL - bounds.boundsLeft).toBeGreaterThan(0);
    expect(chooseReplyPlacement(anchor, bounds)).toBe('left');
  });

  it('falls back to `above` when neither side has horizontal room (never `below`)', () => {
    const anchor = seat(410, 120);
    const bounds = {
      ...bandFor(900, 120),
      boundsLeft: anchor.left - REPLY_TAIL,
      boundsRight: anchor.right + REPLY_TAIL,
    };
    expect(chooseReplyPlacement(anchor, bounds)).toBe('above');
  });

  it('falls back to `above` when even a side placement cannot hold the minimum height', () => {
    const anchor = seat(410, 120);
    const bounds = { ...bandFor(900, 120), barrierTop: SAFE_TOP + REPLY_MARGIN + REPLY_MIN_H - 1 };
    expect(chooseReplyPlacement(anchor, bounds)).toBe('above');
  });

  it('picks `right` at the exact side boundary (side extent === REPLY_MIN_H)', () => {
    const anchor = seat(410, 120);
    const bounds = { ...bandFor(900, 120), barrierTop: SAFE_TOP + REPLY_MARGIN + REPLY_MIN_H };
    expect(chooseReplyPlacement(anchor, bounds)).toBe('right');
  });

  it('never returns `below` (no seat placement below the seat can exist)', () => {
    const allowed: ReplyPlacement[] = ['above', 'right', 'left'];
    for (const [windowW, windowH] of [
      [900, 450],
      [900, 600],
      [1400, 900],
      [500, 300],
    ]) {
      for (const offset of [-250, 0, 250]) {
        for (const contentHeightPx of [0, 93, 5000]) {
          const { anchor, bounds } = seatLayout(windowW, windowH, offset);
          expect(allowed).toContain(chooseReplyPlacement(anchor, bounds));
          const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx });
          expect(allowed).toContain(geometry.placement);
        }
      }
    }
  });
});

describe('#2883 replySurfaceLayout — the rect always stays inside the band and the window', () => {
  const windows: Array<[number, number]> = [
    [900, 600],
    [1024, 768],
    [1280, 800],
    [1400, 900],
    [1600, 1000],
    [900, 500], // short window ⇒ the side placement takes over
  ];

  it('holds for every band / seat-offset / content combination', () => {
    for (const [windowW, windowH] of windows) {
      for (const offset of [-250, -120, 0, 120, 250]) {
        for (const contentHeightPx of [93, 500, 5000]) {
          const { anchor, bounds } = seatLayout(windowW, windowH, offset);
          const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx });
          expect(geometry.tier).toBe('grown');

          const rect = viewportRect(anchor, geometry);

          // column clip box (overflowY:auto clips both axes)
          expect(rect.left).toBeGreaterThanOrEqual(bounds.boundsLeft);
          expect(rect.right).toBeLessThanOrEqual(bounds.boundsRight);
          // never over the command bar, never under the notch
          expect(rect.bottom).toBeLessThanOrEqual(bounds.barrierTop - REPLY_MARGIN);
          expect(rect.top).toBeGreaterThanOrEqual(bounds.safeTop);
          // and therefore always inside the window itself
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.top).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(windowW);
          expect(rect.bottom).toBeLessThanOrEqual(windowH);
        }
      }
    }
  });

  it('anchors a side placement at the bar barrier and grows no wider than the room', () => {
    const anchor = seat(410, 170);
    const bounds = bandFor(900, 170); // 900×500-ish: above is short
    const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
    expect(geometry.tier).toBe('grown');
    expect(geometry.placement).toBe('right');

    const rect = viewportRect(anchor, geometry);
    expect(rect.bottom).toBe(bounds.barrierTop - REPLY_MARGIN);
    expect(rect.left).toBe(anchor.right + REPLY_TAIL);
    expect(geometry.width).toBe(bounds.boundsRight - (anchor.right + REPLY_TAIL));
    expect(rect.right).toBe(bounds.boundsRight);
  });

  it('mirrors the geometry for a `left` placement', () => {
    const anchor = seat(610, 170);
    const bounds = { ...bandFor(900, 170), boundsRight: anchor.right + REPLY_TAIL };
    const geometry = computeReplyGeometry({ anchor, bounds, contentHeightPx: 5000 });
    expect(geometry.placement).toBe('left');

    const rect = viewportRect(anchor, geometry);
    expect(rect.bottom).toBe(bounds.barrierTop - REPLY_MARGIN);
    expect(rect.right).toBe(anchor.left - REPLY_TAIL);
    expect(geometry.width).toBe(anchor.left - REPLY_TAIL - bounds.boundsLeft);
    expect(rect.left).toBe(bounds.boundsLeft);
  });
});

describe('#2883 replySurfaceLayout — the module stays pure (no React / DOM / theme)', () => {
  const SOURCE_PATH = 'src/shared/components/companion/replySurfaceLayout.ts';

  /** Comments legitimately mention React / the window; the CODE must not touch them. */
  function strippedSource(): string {
    return readFileSync(resolve(process.cwd(), SOURCE_PATH), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it('imports nothing at all — no React, no DOM, no theme', () => {
    expect(strippedSource()).not.toMatch(/\bimport\b/);
  });

  it('never reads the DOM at call time (bounds are passed in)', () => {
    const code = strippedSource();
    expect(code).not.toMatch(/\bwindow\b/);
    expect(code).not.toMatch(/\bdocument\b/);
    expect(code).not.toMatch(/matchMedia/);
    expect(code).not.toMatch(/\b(useState|useEffect|useMemo|useCallback|useRef)\b/);
  });
});
