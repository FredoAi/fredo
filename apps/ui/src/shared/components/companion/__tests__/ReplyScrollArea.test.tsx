/**
 * #2883 ST-5 — `ReplyScrollArea` (AC3 + the AC5 scroll legs).
 *
 * Pins the scroller contract the QA Plan scores:
 *   - REQ-7  / R-3.1: the region spans the whole reply (children + testid + the
 *                     grown-tier overflow geometry) so the last line is reachable.
 *   - REQ-15 / R-3.2: `role="region"` + `aria-label` + `tabIndex={0}` — keyboard
 *                     reachable, named, no trap (Tab leaves a plain tabIndex node).
 *   - REQ-10 / R-5.1: the at-bottom FOLLOW vs scrolled-back HOLD decision — pinned
 *                     both as a pure function and at DOM level with a simulated
 *                     `scrollTop`/`clientHeight`/`scrollHeight`. The report to
 *                     `onFollowingChange` is CHANGE-ONLY and SYNCHRONOUS with the
 *                     change (never deferred to a later animation frame), so the
 *                     parent's rAF-coalesced measurement can never run against a
 *                     stale follow state (round-2 ordering fix).
 *   - REQ-11 / R-5.2: the labelled `Newest` control is the ONLY path back to
 *                     following; a new generation resets to following.
 *   - REQ-17 / REQ-18: reduced motion ⇒ instant jump; the anchor is a ref and the
 *                     click path is the only state write (no per-arrival state).
 *   - REQ-12 / REQ-19: the rail is scoped to the region, there is NO
 *                     `scrollbar-gutter`, and no colour literal/alpha-append — so
 *                     the base tier (which never mounts this component) is
 *                     geometrically untouched.
 *
 * STATIC/PRODUCT-UNIT pins are used for the two legs the MCP driver cannot drive
 * on this host (the `matchMedia` reduced-motion flip — G-148 precedent — and the
 * source-level token/`scrollbar-gutter` scan). They are NOT live claims.
 */

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  ReplyScrollArea,
  REPLY_SCROLL_TESTID,
  REPLY_SCROLL_NEWEST_TESTID,
  REPLY_SCROLL_NEWEST_LABEL,
  REPLY_SCROLL_DEFAULT_LABEL,
  REPLY_SCROLL_RESERVED_GUTTER_PX,
  REPLY_SCROLL_BOTTOM_PAD_PX,
  REPLY_SCROLL_BOTTOM_EPSILON_PX,
  isAtBottom,
} from '@/shared/components/companion/ReplyScrollArea';

const SOURCE_PATH = 'src/shared/components/companion/ReplyScrollArea.tsx';

/** vitest runs with cwd = apps/ui (the package root). */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/** Strip comments so issue refs (`#2883`) are never mistaken for colour literals. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

interface ScrollSim {
  state: { clientHeight: number; scrollHeight: number };
  top: () => number;
  setTop: (value: number) => void;
}

/**
 * jsdom performs no layout, so `scrollTop`/`clientHeight`/`scrollHeight` are
 * stubbed on the region to model a scrollable reply (the DOM-level lever the
 * dispatch asks for). The component only ever reads these from handlers/effects,
 * so they can be installed after the initial render.
 */
function simulateScroll(
  region: HTMLElement,
  init: { clientHeight: number; scrollHeight: number; scrollTop?: number },
): ScrollSim {
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

function mockReducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderArea(props: Partial<React.ComponentProps<typeof ReplyScrollArea>> = {}) {
  return renderWithChakra(
    <ReplyScrollArea {...props}>
      <span>Fredo&apos;s reply body</span>
    </ReplyScrollArea>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReplyScrollArea (#2883 ST-5)', () => {
  describe('region identity + accessible name (REQ-7 / REQ-15)', () => {
    it('renders its children inside the named, focusable scroll region', () => {
      renderArea({ isStreaming: true });

      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      expect(region).toHaveAttribute('role', 'region');
      expect(region).toHaveAttribute('aria-label', REPLY_SCROLL_DEFAULT_LABEL);
      expect(region).toHaveAttribute('tabindex', '0');
      expect(region).toHaveAttribute('aria-busy', 'true');
      expect(region).toContainElement(screen.getByText("Fredo's reply body"));
    });

    it('carries no aria-busy and no live region once the reply has settled', () => {
      renderArea({ isStreaming: false });

      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      expect(region).not.toHaveAttribute('aria-busy');
      // Never per-token announcements: no aria-live / role="log" on the scroller.
      expect(region).not.toHaveAttribute('aria-live');
      expect(region).toHaveAttribute('role', 'region');
    });

    it('honours a custom label', () => {
      renderArea({ label: "Mia's reply" });
      expect(screen.getByTestId(REPLY_SCROLL_TESTID)).toHaveAttribute(
        'aria-label',
        "Mia's reply",
      );
    });
  });

  describe('the anchor rule is pure (REQ-10 / R-5.1)', () => {
    it('is at the bottom within the epsilon of the content end', () => {
      expect(isAtBottom(200, 100, 300)).toBe(true);
      expect(isAtBottom(300 - 100 - REPLY_SCROLL_BOTTOM_EPSILON_PX, 100, 300)).toBe(true);
      expect(isAtBottom(300 - 100 - REPLY_SCROLL_BOTTOM_EPSILON_PX - 1, 100, 300)).toBe(false);
    });

    it('is NOT at the bottom once the reader has scrolled back', () => {
      expect(isAtBottom(120, 100, 300)).toBe(false);
      expect(isAtBottom(0, 100, 300)).toBe(false);
      // Content that fits: always "at the bottom" — nothing to hold.
      expect(isAtBottom(0, 300, 300)).toBe(true);
    });
  });

  describe('follow while at bottom, hold while scrolled back (REQ-10)', () => {
    it('follows arriving content — scrollTop is pinned to the content end', () => {
      const { rerender } = renderArea();
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      const sim = simulateScroll(region, { clientHeight: 100, scrollHeight: 300 });

      // Next commit (an arrival) re-runs the follow effect with the simulated box.
      rerender(
        <ReplyScrollArea>
          <span>first</span>
        </ReplyScrollArea>,
      );
      expect(sim.top()).toBe(300);

      sim.state.scrollHeight = 500;
      rerender(
        <ReplyScrollArea>
          <span>first + second</span>
        </ReplyScrollArea>,
      );
      expect(sim.top()).toBe(500);
    });

    it('holds the reading position across arrivals once the reader scrolled back', async () => {
      const onFollowingChange = vi.fn();
      const { rerender } = renderWithChakra(
        <ReplyScrollArea onFollowingChange={onFollowingChange}>
          <span>long reply</span>
        </ReplyScrollArea>,
      );
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      const sim = simulateScroll(region, { clientHeight: 100, scrollHeight: 300 });

      // A deliberate scroll back: 120 is more than the epsilon away from the end.
      sim.setTop(120);
      fireEvent.scroll(region);

      await waitFor(() => expect(onFollowingChange).toHaveBeenLastCalledWith(false));
      expect(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeInTheDocument();

      const callsAtHold = onFollowingChange.mock.calls.length;

      // New content arrives: scrollHeight grows BELOW the reader, scrollTop holds.
      sim.state.scrollHeight = 900;
      rerender(
        <ReplyScrollArea onFollowingChange={onFollowingChange}>
          <span>long reply + more tokens</span>
        </ReplyScrollArea>,
      );
      expect(sim.top()).toBe(120);

      // ...and the arrival itself writes no state and reports nothing (REQ-18).
      expect(onFollowingChange.mock.calls.length).toBe(callsAtHold);
    });

    it('delivers the flip SYNCHRONOUSLY and change-only — no frame may outrun the report', () => {
      const onFollowingChange = vi.fn();
      renderWithChakra(
        <ReplyScrollArea onFollowingChange={onFollowingChange}>
          <span>long reply</span>
        </ReplyScrollArea>,
      );
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      const sim = simulateScroll(region, { clientHeight: 100, scrollHeight: 600 });

      // A deliberate scroll back: the parent must observe the flip in the SAME
      // task as the scroll. A deferred (rAF) report would let a measurement that
      // was already pending run first and latch an unfrozen surface height while
      // the reader is scrolled back (round-2 order-independence).
      sim.setTop(150);
      fireEvent.scroll(region);
      expect(onFollowingChange).toHaveBeenLastCalledWith(false);

      // Change-only: repeating the same scrolled-back position reports nothing.
      const callsAtHold = onFollowingChange.mock.calls.length;
      fireEvent.scroll(region);
      expect(onFollowingChange.mock.calls.length).toBe(callsAtHold);

      // A real change still reports — again synchronously.
      sim.setTop(500);
      fireEvent.scroll(region);
      expect(onFollowingChange).toHaveBeenLastCalledWith(true);
      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).not.toBeInTheDocument();
    });

    it('stays pinned and offers no control when the reply fits the surface', () => {
      renderArea();
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      // Not the grown tier: nothing overflows, so no scroll affordance is needed.
      simulateScroll(region, { clientHeight: 300, scrollHeight: 300 });

      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).not.toBeInTheDocument();
      // A follow write never surfaces the pill (it is not a deliberate scroll).
      expect(isAtBottom(0, 300, 300)).toBe(true);
    });
  });

  describe('the deliberate return to newest (REQ-11 / R-5.2)', () => {
    async function scrollBack() {
      const onFollowingChange = vi.fn();
      const view = renderWithChakra(
        <ReplyScrollArea onFollowingChange={onFollowingChange}>
          <span>long reply</span>
        </ReplyScrollArea>,
      );
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      const sim = simulateScroll(region, { clientHeight: 100, scrollHeight: 600 });
      sim.setTop(150);
      fireEvent.scroll(region);
      await waitFor(() => expect(onFollowingChange).toHaveBeenLastCalledWith(false));
      return { view, region, sim, onFollowingChange };
    }

    it('is a labelled button that jumps to the end and resumes following', async () => {
      const { region, sim, onFollowingChange } = await scrollBack();

      const newest = screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID);
      expect(newest).toHaveAccessibleName(REPLY_SCROLL_NEWEST_LABEL);
      expect(newest).toHaveTextContent('Newest');

      fireEvent.click(newest);

      expect(sim.top()).toBe(600);
      // The flip is delivered SYNCHRONOUSLY with the activation (round-2
      // order-independence) — the parent observes it in the same task.
      await waitFor(() => expect(onFollowingChange).toHaveBeenLastCalledWith(true));
      // Following resumed ⇒ the control is gone; focus stays on the region so the
      // arrow/page keys keep working.
      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).not.toBeInTheDocument();
      expect(document.activeElement).toBe(region);
    });

    it('is keyboard operable (Enter on the focused control)', async () => {
      const user = userEvent.setup();
      const { sim, onFollowingChange } = await scrollBack();

      const newest = screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID);
      newest.focus();
      await user.keyboard('{Enter}');

      expect(sim.top()).toBe(600);
      await waitFor(() => expect(onFollowingChange).toHaveBeenLastCalledWith(true));
      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).not.toBeInTheDocument();
    });

    it('does not silently resume following while the reader is scrolled back', async () => {
      const { sim, onFollowingChange } = await scrollBack();

      expect(sim.top()).toBe(150);
      expect(onFollowingChange).toHaveBeenLastCalledWith(false);
      expect(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeInTheDocument();
    });

    it('does not flash the control while the return animation is in flight', async () => {
      const { region, sim } = await scrollBack();

      fireEvent.click(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID));

      // Intermediate offsets during a SMOOTH return are not the reader scrolling
      // away — the pill must not reappear mid-animation.
      sim.setTop(300);
      fireEvent.scroll(region);
      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).not.toBeInTheDocument();

      // ...and it stays gone once the view settles at the newest content.
      sim.setTop(600);
      fireEvent.scroll(region);
      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).not.toBeInTheDocument();
    });

    it('a new generation resets to following', async () => {
      const onFollowingChange = vi.fn();
      const { rerender } = renderWithChakra(
        <ReplyScrollArea resetKey="gen-1" onFollowingChange={onFollowingChange}>
          <span>generation one</span>
        </ReplyScrollArea>,
      );
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      const sim = simulateScroll(region, { clientHeight: 100, scrollHeight: 600 });
      sim.setTop(150);
      fireEvent.scroll(region);
      await waitFor(() => expect(onFollowingChange).toHaveBeenLastCalledWith(false));
      expect(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID)).toBeInTheDocument();

      rerender(
        <ReplyScrollArea resetKey="gen-2" onFollowingChange={onFollowingChange}>
          <span>generation two</span>
        </ReplyScrollArea>,
      );

      expect(screen.queryByTestId(REPLY_SCROLL_NEWEST_TESTID)).not.toBeInTheDocument();
      await waitFor(() => expect(onFollowingChange).toHaveBeenLastCalledWith(true));
    });
  });

  describe('reduced motion ⇒ instant jump (REQ-17 / G-148 static pin)', () => {
    it('uses instant scroll-behavior under prefers-reduced-motion: reduce', () => {
      mockReducedMotion(true);
      renderArea();
      expect(screen.getByTestId(REPLY_SCROLL_TESTID).style.scrollBehavior).toBe('auto');
    });

    it('uses smooth scroll-behavior when motion is allowed', () => {
      mockReducedMotion(false);
      renderArea();
      expect(screen.getByTestId(REPLY_SCROLL_TESTID).style.scrollBehavior).toBe('smooth');
    });

    it('jumps to the end on the reduced-motion path (no animation needed)', async () => {
      mockReducedMotion(true);
      renderWithChakra(
        <ReplyScrollArea>
          <span>long reply</span>
        </ReplyScrollArea>,
      );
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);
      const sim = simulateScroll(region, { clientHeight: 100, scrollHeight: 600 });
      sim.setTop(150);
      fireEvent.scroll(region);

      fireEvent.click(screen.getByTestId(REPLY_SCROLL_NEWEST_TESTID));

      expect(region.style.scrollBehavior).toBe('auto');
      expect(sim.top()).toBe(600);
    });
  });

  describe('grown tier only — no gutter, no leak into the base tier (REQ-12 / REQ-19)', () => {
    it('reserves the gutter and rail on the region itself, with no scrollbar-gutter', () => {
      renderArea();
      const region = screen.getByTestId(REPLY_SCROLL_TESTID);

      expect(region.style.overflowY).toBe('auto');
      expect(region.style.overflowX).toBe('hidden');
      expect(region.style.overflowWrap).toBe('break-word');
      expect(region.style.overscrollBehavior).toBe('contain');
      expect(region.style.paddingInlineEnd).toBe(`${REPLY_SCROLL_RESERVED_GUTTER_PX}px`);
      expect(region.style.paddingBlockEnd).toBe(`${REPLY_SCROLL_BOTTOM_PAD_PX}px`);
      // `scrollbar-gutter` would reserve a gutter in the BASE tier too — banned.
      expect(region.style.scrollbarGutter).toBe('');
    });

    it('keeps the rail scoped and contributes no colour literals (static pin)', () => {
      const source = readSource(SOURCE_PATH);
      const code = stripComments(source);

      expect(code).not.toMatch(/scrollbar-gutter/);
      expect(code).not.toMatch(/rgba?\(|hsla?\(/);
      expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      // `var(--x)NN` alpha-append is invalid CSS (#2770) — tints go through tint().
      expect(code).not.toMatch(/var\(--[\w-]+\)\d/);
      // The rail is scoped to the region via its own nested selectors.
      expect(code).toMatch(/&::-webkit-scrollbar/);
    });
  });
});
