/**
 * #2883 ST-4 — the two-tier `SpeechBubble` text reply surface (AC2 render side).
 *
 * STATIC / PRODUCT-UNIT pins for the render half of AC2/AC5:
 *   - REQ-4  / R-2.1 + R-2.4: the text reply surface GROWS with the arriving
 *                             content — base 240×120 → the band's
 *                             `min(560, available)` × `clamp(120, content, available)`.
 *   - REQ-5  / R-2.2:         the grown rect is the pure module's clamped rect
 *                             (inside the launcher-measured band ⇒ inside the window).
 *   - REQ-6  / R-2.3:         the grown tier never has a `below` placement; the
 *                             band's `barrierTop` keeps it off the command bar.
 *   - REQ-7  / R-3.1:         at the cap the surface stops growing and the scroller
 *                             takes over (`fredo-reply-scroll` mounts in the grown
 *                             tier only).
 *   - REQ-10 / R-5.1:         while the reader is scrolled back the surface height
 *                             is frozen (released on the deliberate return).
 *   - REQ-12 / REQ-19 / R-5.3: with no band (or with a fixed/away or game surface)
 *                             today's 240×120 card is rendered EXACTLY — no
 *                             scrollbar, no rail, no gutter, no transition.
 *
 * jsdom performs no layout, so the seat slot's rect and the `<Text>`'s wrapped
 * height are stubbed on `Element.prototype.getBoundingClientRect` — the same DOM
 * lever ST-5 uses for its scroll simulation. This is NOT a live layout claim; the
 * live growth/clamping legs belong to the tester's MCP round.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  GAME_BUBBLE_TESTID,
  REPLY_SURFACE_TESTID,
  SpeechBubble,
} from '@/shared/components/companion/SpeechBubble';
import {
  REPLY_SCROLL_NEWEST_TESTID,
  REPLY_SCROLL_TESTID,
} from '@/shared/components/companion/ReplyScrollArea';

// ── framer-motion mock ─────────────────────────────────────────────────────────
// `motion.div` becomes a plain (forwardRef) div so the geometry style is readable
// and the ref the component needs for its anchor measurement still attaches.
const motionMock = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let react: any = null;
  const captured: Array<Record<string, unknown>> = [];
  let MotionDiv: any = null;
  const motion = {
    get div() {
      if (!MotionDiv) {
        if (!react) throw new Error('framer-motion mock: React not set yet');
        MotionDiv = react.forwardRef((props: Record<string, unknown>, ref: unknown) => {
          captured.push(props);
          const { initial, animate, exit, transition, style, children, ...rest } = props;
          void initial;
          void animate;
          void exit;
          void transition;
          const domStyle =
            style && typeof style === 'object'
              ? { ...(style as Record<string, unknown>) }
              : style;
          // `x` is a framer-motion transform value, not a valid CSS property.
          if (domStyle && typeof domStyle === 'object') {
            delete (domStyle as Record<string, unknown>).x;
          }
          return react.createElement('div', { ...rest, ref, style: domStyle }, children);
        });
      }
      return MotionDiv;
    },
  };
  return {
    setReact(r: unknown) {
      react = r;
    },
    motion,
    captured,
    AnimatePresence: ({ children }: { children?: unknown }) => children ?? null,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

vi.mock('framer-motion', () => ({
  AnimatePresence: motionMock.AnimatePresence,
  motion: motionMock.motion,
  useReducedMotion: () => false,
}));

motionMock.setReact(React);

// ── Helpers ────────────────────────────────────────────────────────────────────
const lastProps = (): Record<string, unknown> => {
  expect(motionMock.captured.length).toBeGreaterThan(0);
  return motionMock.captured[motionMock.captured.length - 1];
};
const lastStyle = (): Record<string, unknown> => lastProps().style as Record<string, unknown>;

type RectLike = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** The stubbed measurements: the seat slot's rect and the Text's wrapped height. */
const measurement = {
  slot: { top: 600, left: 460, right: 540, bottom: 700, width: 80, height: 100 } as RectLike,
  textHeight: 300,
};

function rect(r: RectLike): DOMRect {
  return { x: r.left, y: r.top, ...r, toJSON: () => r } as unknown as DOMRect;
}

/** Seat slot 80×100 @ (460,600); a band 960 px wide with the bar's top at 900. */
const BAND = { safeTop: 66, barrierTop: 900, boundsLeft: 40, boundsRight: 1000 };

const bubble = (props: Partial<React.ComponentProps<typeof SpeechBubble>> = {}) => (
  <div data-testid="seat-slot">
    <SpeechBubble
      message="A reply that is long enough to be interesting."
      companionX={500}
      companionY={660}
      positioning="absolute"
      {...props}
    />
  </div>
);

/** The DOM-level scroll lever (jsdom does no layout) — ST-5's pattern. */
function simulateScroll(
  region: HTMLElement,
  init: { clientHeight: number; scrollHeight: number; scrollTop?: number },
) {
  let top = init.scrollTop ?? 0;
  const state = { clientHeight: init.clientHeight, scrollHeight: init.scrollHeight };
  Object.defineProperty(region, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  Object.defineProperty(region, 'clientHeight', {
    configurable: true,
    get: () => state.clientHeight,
  });
  Object.defineProperty(region, 'scrollHeight', {
    configurable: true,
    get: () => state.scrollHeight,
  });
  return { state, top: () => top, setTop: (value: number) => { top = value; } };
}

const settleFrames = () => new Promise((resolve) => setTimeout(resolve, 60));

/**
 * Flush ONE real animation frame through React. Not a fixed millisecond budget:
 * it resolves on the browser's own frame boundary, so it settles any rAF-
 * coalesced work the component has already scheduled.
 */
const flushAnimationFrame = () =>
  act(async () => {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
      } else {
        resolve();
      }
    });
  });

/**
 * Deterministic barrier: run the pending animation-frame chain (the measurement
 * the pre-scroll commit registered, plus the re-measure its commit schedules) to
 * completion. `waitFor(Newest)` only proves the scroller's LOCAL state — not that
 * the parent's measurement has observed the flip — so it is not a barrier on its
 * own.
 */
const flushAnimationFrames = async () => {
  await flushAnimationFrame();
  await flushAnimationFrame();
};

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  motionMock.captured.length = 0;
  measurement.slot = { top: 600, left: 460, right: 540, bottom: 700, width: 80, height: 100 };
  measurement.textHeight = 300;
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.getAttribute('data-testid') === 'seat-slot') return rect(measurement.slot);
    if (this.tagName === 'P') {
      const height = measurement.textHeight;
      return rect({ top: 0, left: 0, right: 200, bottom: height, width: 200, height });
    }
    return rect({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });
});

afterEach(() => {
  rectSpy.mockRestore();
  cleanup();
});

describe('#2883 ST-4 SpeechBubble — the two-tier text reply surface', () => {
  describe('base tier (R-5.3 / REQ-12 / REQ-19)', () => {
    it('renders today’s 240×120 card — no scroller, no rail, no growth — when no band is supplied', async () => {
      renderWithChakra(bubble());

      const surface = screen.getByTestId(REPLY_SURFACE_TESTID);
      expect(surface).toHaveAttribute('data-reply-tier', 'base');
      expect(surface).toHaveAttribute('data-reply-kind', 'reply');
      expect(screen.queryByTestId(REPLY_SCROLL_TESTID)).toBeNull();
      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeNull();

      // The shipped fixed content area, clipped by the card's `overflow:hidden`:
      // the Text renders directly in today's content box, nothing inside is
      // scrollable or focusable — no rail, no gutter, no scrollbar (REQ-12/REQ-19).
      const text = surface.querySelector('p');
      expect(text).not.toBeNull();
      expect(surface.querySelector('[tabindex="0"]')).toBeNull();
      expect(text?.parentElement).toBe(surface.firstElementChild);

      await waitFor(() =>
        expect(lastStyle()).toMatchObject({
          position: 'absolute',
          bottom: 'calc(100% + 10px)',
          left: '50%',
          x: '-50%',
          width: 240,
          height: 120,
          // The ONLY base-tier change (AC4's hit target).
          pointerEvents: 'auto',
        }),
      );
    });

    it('reflects the surface kind when the caller names it', () => {
      renderWithChakra(bubble({ replyKind: 'welcome' }));
      expect(screen.getByTestId(REPLY_SURFACE_TESTID)).toHaveAttribute(
        'data-reply-kind',
        'welcome',
      );
    });
  });

  describe('grown tier (R-2.1 / R-2.4 / R-2.2 / R-3.1 — REQ-4, REQ-5, REQ-7)', () => {
    it('grows to min(560, band) × clamp(120, contentHeight, available) once the content passes the base box', async () => {
      measurement.textHeight = 300;
      renderWithChakra(bubble({ growth: BAND, isStreaming: true }));

      const surface = screen.getByTestId(REPLY_SURFACE_TESTID);
      await waitFor(() => expect(surface).toHaveAttribute('data-reply-tier', 'grown'));

      // anchor 80×100 at top 600, safeTop 66 ⇒ available = 600 − 10 − 66 = 524.
      // width = min(560, 1000 − 40) = 560; height = clamp(120, 300, 524) = 300.
      await waitFor(() =>
        expect(lastStyle()).toMatchObject({
          position: 'absolute',
          left: -240,
          bottom: 110,
          width: 560,
          height: 300,
        }),
      );
      // At the cap the scroller takes over (REQ-7).
      expect(screen.getByTestId(REPLY_SCROLL_TESTID)).toBeInTheDocument();
      // Growth is inline style, never a CSS transition (perf NFR).
      expect(lastStyle()).not.toHaveProperty('transition');
    });

    it('opens the grown tier at the floor and lifts it to the content height — monotonic growth', async () => {
      measurement.textHeight = 300;
      renderWithChakra(bubble({ growth: BAND, isStreaming: true }));

      await waitFor(() => expect(lastStyle().height).toBe(300));

      // The pass that LATCHES the tier is still measured at the base width, so it
      // opens at the floor; the next frame measures at the grown width. Never a
      // grow-then-shrink pop (REQ-4's monotonic size increase).
      const grownHeights = motionMock.captured
        .map((props) => props.style as Record<string, unknown>)
        .filter((style) => style.width === 560)
        .map((style) => style.height);
      expect(grownHeights[0]).toBe(120);
      expect(grownHeights[grownHeights.length - 1]).toBe(300);
      for (let i = 1; i < grownHeights.length; i += 1) {
        expect(grownHeights[i] as number).toBeGreaterThanOrEqual(grownHeights[i - 1] as number);
      }
    });

    it('caps the height at the band and hands the overflow to the scroller', async () => {
      measurement.textHeight = 5000;
      renderWithChakra(bubble({ growth: BAND, isStreaming: true }));

      await waitFor(() => expect(lastStyle().height).toBe(524));
      expect(screen.getByTestId(REPLY_SCROLL_TESTID)).toBeInTheDocument();
    });

    it('freezes the grown tier across a re-render that changes the content height', async () => {
      const { rerender } = renderWithChakra(bubble({ growth: BAND, isStreaming: true }));
      await waitFor(() =>
        expect(screen.getByTestId(REPLY_SURFACE_TESTID)).toHaveAttribute(
          'data-reply-tier',
          'grown',
        ),
      );

      // The content now FITS the base box (40 ≤ 92) — but the tier is latched for
      // the generation, so the surface must not collapse back to 240×120.
      measurement.textHeight = 40;
      rerender(bubble({ growth: BAND, isStreaming: true, message: 'Hi there!' }));
      await settleFrames();

      const surface = screen.getByTestId(REPLY_SURFACE_TESTID);
      expect(surface).toHaveAttribute('data-reply-tier', 'grown');
      expect(lastStyle().width).toBe(560);
      expect(screen.getByTestId(REPLY_SCROLL_TESTID)).toBeInTheDocument();
    });

    it('wires the scroller and the Newest control in the grown tier only', async () => {
      const base = renderWithChakra(bubble());
      expect(screen.queryByTestId(REPLY_SCROLL_TESTID)).toBeNull();
      base.unmount();

      renderWithChakra(bubble({ growth: BAND, isStreaming: true }));
      const region = await screen.findByTestId(REPLY_SCROLL_TESTID);
      expect(region).toHaveAttribute('role', 'region');
      expect(region).toHaveAttribute('tabindex', '0');
      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeNull();

      // A deliberate scroll-back is reported to the parent (R-5.1) and surfaces
      // the labelled Newest control — proof the wiring is live, not decorative.
      simulateScroll(region, { clientHeight: 300, scrollHeight: 3000, scrollTop: 500 });
      fireEvent.scroll(region);
      await waitFor(() =>
        expect(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeInTheDocument(),
      );
    });

    it('freezes the surface height while the reader is scrolled back, and releases it on return', async () => {
      const { rerender } = renderWithChakra(bubble({ growth: BAND, isStreaming: true }));
      const region = await screen.findByTestId(REPLY_SCROLL_TESTID);
      await waitFor(() => expect(lastStyle().height).toBe(300));

      simulateScroll(region, { clientHeight: 300, scrollHeight: 3000, scrollTop: 500 });
      fireEvent.scroll(region);
      await waitFor(() =>
        expect(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeInTheDocument(),
      );

      // Deterministic barrier (frame flush, never a bigger fixed sleep): the
      // `Newest` wait above proves only the scroller's local state, so flush the
      // pending animation-frame chain and re-assert the freeze is in effect
      // BEFORE the content grows — no measurement may still be racing the frame.
      await flushAnimationFrames();
      expect(lastStyle().height).toBe(300);

      // More content arrives while the reader is scrolled back: the height is HELD.
      measurement.textHeight = 520;
      rerender(bubble({ growth: BAND, isStreaming: true, message: 'A longer arriving reply…' }));
      await settleFrames();
      expect(lastStyle().height).toBe(300);

      // The deliberate return releases the freeze and re-clamps to the content.
      fireEvent.click(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID));
      await waitFor(() => expect(lastStyle().height).toBe(520));
    });

    it('never measures with a stale follow state — content arriving in the scroll task stays frozen', async () => {
      const { rerender } = renderWithChakra(bubble({ growth: BAND, isStreaming: true }));
      const region = await screen.findByTestId(REPLY_SCROLL_TESTID);
      await waitFor(() => expect(lastStyle().height).toBe(300));

      // Scroll back AND deliver the arrival in the SAME task, before any pending
      // animation frame can run. The scroller's report is synchronous, so the
      // measurement the pre-scroll commit already registered must observe the
      // scrolled-back state — not the stale `following: true` it was scheduled
      // under — and the surface must not grow by one pixel (R-5.1).
      simulateScroll(region, { clientHeight: 300, scrollHeight: 3000, scrollTop: 500 });
      fireEvent.scroll(region);
      measurement.textHeight = 520;
      rerender(bubble({ growth: BAND, isStreaming: true, message: 'A longer arriving reply…' }));

      await settleFrames();
      expect(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeInTheDocument();
      expect(lastStyle().height).toBe(300);
    });
  });

  describe('the surfaces growth must never touch (R-5.3 / must-not-change)', () => {
    it('keeps the game card as fredo-game-bubble — never the reply surface', async () => {
      renderWithChakra(
        bubble({ message: null, children: <span data-testid="board">board</span> }),
      );

      const card = screen.getByTestId(GAME_BUBBLE_TESTID);
      expect(card).not.toHaveAttribute('data-reply-tier');
      expect(card).not.toHaveAttribute('data-reply-kind');
      expect(screen.queryByTestId(REPLY_SURFACE_TESTID)).toBeNull();
      expect(screen.getByTestId('board')).toBeInTheDocument();
      await waitFor(() =>
        expect(lastStyle()).toMatchObject({ width: 208, height: 268, pointerEvents: 'auto' }),
      );
    });

    it('leaves the fixed away-overlay path on today’s geometry even if a band is passed', async () => {
      renderWithChakra(bubble({ growth: BAND, positioning: 'fixed', isStreaming: true }));

      const surface = screen.getByTestId(REPLY_SURFACE_TESTID);
      await waitFor(() =>
        expect(lastStyle()).toMatchObject({ position: 'fixed', width: 240, height: 120 }),
      );
      expect(surface).toHaveAttribute('data-reply-tier', 'base');
      expect(screen.queryByTestId(REPLY_SCROLL_TESTID)).toBeNull();
    });
  });

  describe('AC4 hook-up — the forwarded protection props reach the text card', () => {
    it('binds pointer and focus protection on the surface', () => {
      const onSurfaceEnter = vi.fn();
      const onSurfaceLeave = vi.fn();
      const onSurfaceFocus = vi.fn();
      const onSurfaceBlur = vi.fn();
      renderWithChakra(
        bubble({ onSurfaceEnter, onSurfaceLeave, onSurfaceFocus, onSurfaceBlur }),
      );

      const surface = screen.getByTestId(REPLY_SURFACE_TESTID);
      fireEvent.pointerOver(surface);
      expect(onSurfaceEnter).toHaveBeenCalledTimes(1);
      fireEvent.pointerOut(surface);
      expect(onSurfaceLeave).toHaveBeenCalledTimes(1);
      fireEvent.focusIn(surface);
      expect(onSurfaceFocus).toHaveBeenCalledTimes(1);
      fireEvent.focusOut(surface);
      expect(onSurfaceBlur).toHaveBeenCalledTimes(1);
    });
  });

  describe('static pins (REQ-22 / R-5.3)', () => {
    const SOURCE_PATH = 'src/shared/components/companion/SpeechBubble.tsx';

    it('contributes no colour literal, no alpha-append and no scrollbar-gutter', () => {
      const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');

      expect(source).not.toMatch(/scrollbar-gutter/);
      expect(source).not.toMatch(/rgba?\(|hsla?\(/);
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      // `var(--x)NN` alpha-append is invalid CSS (#2770) — tints go through tint().
      expect(source).not.toMatch(/var\(--[\w-]+\)\d/);
    });
  });
});
