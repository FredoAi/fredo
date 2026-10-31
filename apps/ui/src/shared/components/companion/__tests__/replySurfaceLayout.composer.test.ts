/**
 * Spec #3120 (rework) ST-2 — pure instruction-composer placement.
 *
 * Work bullet (b): the composer never intersects Fredo, keeps at least 14 px of
 * facing separation, avoids the visible SpeechBubble rect, stays inside the
 * measured region/viewport, and degrades (shrink + scroll) without ever covering
 * the avatar. `below` is never returned.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPOSER_H,
  COMPOSER_W,
  REPLY_AVATAR_CLEARANCE,
  computeComposerPlacement,
} from '../replySurfaceLayout';
import type {
  ReplyAvatarRect,
  ReplyRect,
  ReplyRegion,
} from '../replySurfaceLayout';

const VIEWPORT = { width: 1000, height: 800 };
const REGION: ReplyRegion = { safeTop: 8, barrierTop: 800, boundsLeft: 8, boundsRight: 992 };
const SIZE = { width: COMPOSER_W, height: COMPOSER_H };

function avatar(left: number, top: number, width = 80, height = 100): ReplyAvatarRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function intersects(a: ReplyRect, b: ReplyRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

describe('computeComposerPlacement', () => {
  it('ranks ABOVE first when there is room', () => {
    const placement = computeComposerPlacement({
      avatar: avatar(400, 400),
      region: REGION,
      viewport: VIEWPORT,
      size: SIZE,
    });
    expect(placement.placement).toBe('above');
    expect(placement.top + placement.height).toBeLessThanOrEqual(400 - REPLY_AVATAR_CLEARANCE);
    expect(placement.clearance).toBeGreaterThanOrEqual(REPLY_AVATAR_CLEARANCE);
  });

  it('falls back to RIGHT when there is no vertical room above', () => {
    const placement = computeComposerPlacement({
      avatar: avatar(400, 30),
      region: REGION,
      viewport: VIEWPORT,
      size: SIZE,
    });
    expect(placement.placement).toBe('right');
    expect(placement.left).toBeGreaterThanOrEqual(480 + REPLY_AVATAR_CLEARANCE);
  });

  it('falls back to LEFT when neither above nor the right side fits', () => {
    const placement = computeComposerPlacement({
      avatar: avatar(900, 30),
      region: REGION,
      viewport: VIEWPORT,
      size: SIZE,
    });
    expect(placement.placement).toBe('left');
    expect(placement.right).toBeLessThanOrEqual(900 - REPLY_AVATAR_CLEARANCE);
  });

  it('NEVER returns `below`', () => {
    for (const top of [10, 100, 400, 700]) {
      for (const left of [10, 200, 500, 900]) {
        const placement = computeComposerPlacement({
          avatar: avatar(left, top),
          region: REGION,
          viewport: VIEWPORT,
          size: SIZE,
        });
        expect(['above', 'right', 'left']).toContain(placement.placement);
      }
    }
  });

  it('never intersects the avatar and always keeps >= 14 px clearance', () => {
    for (const top of [0, 8, 60, 300, 600, 700]) {
      for (const left of [0, 8, 60, 300, 600, 900]) {
        const footprint = avatar(left, top);
        const placement = computeComposerPlacement({
          avatar: footprint,
          region: REGION,
          viewport: VIEWPORT,
          size: SIZE,
        });
        expect(intersects(placement, footprint)).toBe(false);
        expect(placement.clearance).toBeGreaterThanOrEqual(REPLY_AVATAR_CLEARANCE);
      }
    }
  });

  it('avoids the visible SpeechBubble rect (a blocked side is not chosen)', () => {
    const bubble: ReplyRect = { left: 200, top: 340, right: 600, bottom: 390, width: 400, height: 50 };
    const placement = computeComposerPlacement({
      avatar: avatar(400, 400),
      region: REGION,
      viewport: VIEWPORT,
      size: SIZE,
      avoid: bubble,
    });
    expect(intersects(placement, bubble)).toBe(false);
    // `above` would land at 346–386 inside the bubble; the decision moves aside.
    expect(placement.placement).not.toBe('above');
  });

  it('stays inside the region and the viewport at every corner', () => {
    for (const top of [0, 20, 400, 760]) {
      for (const left of [0, 20, 400, 920]) {
        const placement = computeComposerPlacement({
          avatar: avatar(left, top),
          region: REGION,
          viewport: VIEWPORT,
          size: SIZE,
        });
        expect(placement.left).toBeGreaterThanOrEqual(REGION.boundsLeft - 0.001);
        expect(placement.right).toBeLessThanOrEqual(REGION.boundsRight + 0.001);
        expect(placement.top).toBeGreaterThanOrEqual(REGION.safeTop - 0.001);
        expect(placement.bottom).toBeLessThanOrEqual(VIEWPORT.height + 0.001);
        expect(placement.right).toBeLessThanOrEqual(VIEWPORT.width + 0.001);
      }
    }
  });

  it('degrades by shrinking (never covering Fredo) when the region is tiny', () => {
    const tinyViewport = { width: 160, height: 120 };
    const tinyRegion: ReplyRegion = { safeTop: 8, barrierTop: 120, boundsLeft: 8, boundsRight: 152 };
    const footprint = avatar(8, 10);
    const placement = computeComposerPlacement({
      avatar: footprint,
      region: tinyRegion,
      viewport: tinyViewport,
      size: SIZE,
    });
    expect(intersects(placement, footprint)).toBe(false);
    expect(placement.clearance).toBeGreaterThanOrEqual(REPLY_AVATAR_CLEARANCE);
    expect(placement.scrollable).toBe(true);
    expect(placement.width).toBeLessThanOrEqual(COMPOSER_W);
  });

  it('grows the card with the textarea without changing the clearance', () => {
    const footprint = avatar(400, 400);
    const resting = computeComposerPlacement({
      avatar: footprint,
      region: REGION,
      viewport: VIEWPORT,
      size: { width: COMPOSER_W, height: COMPOSER_H },
    });
    const grown = computeComposerPlacement({
      avatar: footprint,
      region: REGION,
      viewport: VIEWPORT,
      size: { width: COMPOSER_W, height: 96 },
    });
    expect(grown.clearance).toBe(resting.clearance);
    expect(grown.bottom).toBe(resting.bottom);
    expect(grown.top).toBeLessThan(resting.top);
  });
});
