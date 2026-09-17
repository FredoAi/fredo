/**
 * #2883 ST-5 — the GROWN-tier reply scroller (AC3 + the AC5 scroll legs).
 *
 * A self-contained scroll region that:
 *   - always spans the WHOLE reply (AC3 / R-3.1) — the surface stops growing and
 *     this region scrolls, so the last line can always be brought into view;
 *   - is keyboard operable and named (R-3.2 — `role="region"` + `aria-label` +
 *     `tabIndex={0}`; Arrow/Page/Home/End scroll it natively, Tab never traps);
 *   - FOLLOWS new content only while the reader is at the bottom, and HOLDS the
 *     reading position (R-5.1) — while scrolled back it never writes `scrollTop`,
 *     so arriving tokens only lengthen `scrollHeight` below the reader;
 *   - offers a deliberate, labelled `Newest` control (R-5.2) that returns to the
 *     newest content and resumes following — and only that activation resumes it.
 *
 * Perf contract (plan's Performance NFR + AGENTS.md #523): the "at bottom" anchor
 * lives in a REF, the follow is an imperative `scrollTop` write in a layout
 * effect, and NO React state is written per token. The one piece of state
 * (`following`) flips ONLY on a real scroll event or on the `Newest` activation,
 * so the streaming cadence is untouched. The parent's height-freeze need is
 * reported through `onFollowingChange` — CHANGE-ONLY and delivered
 * SYNCHRONOUSLY with the change (see `notifyFollowing`), so a measurement can
 * never run against a stale follow state — and is expected to be stored by the
 * parent in a REF (the callback is never a state setter).
 *
 * Tier invariant (R-5.3): this component IS the grown tier. `SpeechBubble` mounts
 * it only when the content no longer fits the base 240×120 card, so the base tier
 * gains no scrollbar, no rail and no gutter. The rail is scoped to this element's
 * own `css` block and there is deliberately NO `scrollbar-gutter` anywhere — a
 * reserved gutter would change today's base-tier geometry.
 *
 * The streaming `<Text>` + `.fredo-cursor` markup stays in `SpeechBubble.tsx`; it
 * arrives here as `children`.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, chakra } from '@chakra-ui/react';
import { LuArrowDown } from 'react-icons/lu';
import { tint } from '../../utils/colorTint';

/** The QA-bound identity of the scroll region (ST-4 / REQ-7 / REQ-10/11/15). */
export const REPLY_SCROLL_TESTID = 'fredo-reply-scroll';
/** The return-to-newest control (additive testid; also reachable by its label). */
export const REPLY_SCROLL_NEWEST_TESTID = 'fredo-reply-newest';

/** A reply counts as "at the bottom" within this many px of the end. */
export const REPLY_SCROLL_BOTTOM_EPSILON_PX = 4;
/** Reserved end gutter in the grown tier — constant, so the rail never re-wraps. */
export const REPLY_SCROLL_RESERVED_GUTTER_PX = 8;
/** Bottom padding so the `Newest` pill never covers the final line. */
export const REPLY_SCROLL_BOTTOM_PAD_PX = 28;
/**
 * Safety bound on the in-flight `Newest` return. While a smooth return animates,
 * intermediate scroll events are NOT the reader scrolling away, so they must not
 * flash the pill; the guard is also released by any user gesture and by the
 * moment the view actually settles at the end. This is only the last resort.
 */
export const REPLY_SCROLL_RETURN_SETTLE_MS = 1200;
export const REPLY_SCROLL_DEFAULT_LABEL = "Fredo's reply";
export const REPLY_SCROLL_NEWEST_LABEL = "Jump to the newest part of Fredo's reply";

/**
 * The anchor rule, as a pure function (REQ-10/REQ-11): the reader is "following"
 * only when the viewport bottom is within `epsilon` of the content end.
 */
export function isAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  epsilon: number = REPLY_SCROLL_BOTTOM_EPSILON_PX,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - epsilon;
}

/**
 * `prefers-reduced-motion: reduce` — read once per mount. Under reduced motion
 * the `Newest` jump is instant (`scroll-behavior: auto`), never a smooth scroll.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The launcher's existing thin rail (`LauncherShell.tsx:1466-1470`), scoped to
 * THIS element — theme-correct in light and dark with zero new tokens. It is the
 * only scrollbar styling the component contributes; nothing is global.
 */
const REPLY_SCROLLBAR_CSS = {
  '&::-webkit-scrollbar': { width: '8px', height: '8px' },
  '&::-webkit-scrollbar-thumb': { background: 'var(--card-hover-bg)', borderRadius: '8px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
};

/** The bar's control convention (`LauncherCommandBar.tsx:550`). */
const REPLY_FOCUS_VISIBLE = {
  outline: '2px solid var(--accent-primary)',
  outlineOffset: '2px',
} as const;

export interface ReplyScrollAreaProps {
  /** The streaming `<Text>` + cursor markup, composed by `SpeechBubble`. */
  children: React.ReactNode;
  /** Exposed as `aria-busy` on the region while the reply is still arriving. */
  isStreaming?: boolean;
  /** Accessible name of the region. */
  label?: string;
  /**
   * Reports the follow state so the parent can FREEZE the surface height while
   * the reader is scrolled back. CHANGE-ONLY and delivered SYNCHRONOUSLY with
   * the change — the parent's rAF-coalesced measurement must never be able to
   * run against a stale follow state (R-5.1 order-independence). The parent is
   * expected to record it in a ref (never a state setter — see the loop guard).
   */
  onFollowingChange?: (following: boolean) => void;
  /**
   * Identity of the current generation. A change resets the anchor to "following"
   * (R-5.2: a new generation follows again). Optional — a remount has the same
   * effect, so a consumer that always unmounts between turns can omit it.
   */
  resetKey?: string | number;
}

export const ReplyScrollArea: React.FC<ReplyScrollAreaProps> = ({
  children,
  isStreaming = false,
  label = REPLY_SCROLL_DEFAULT_LABEL,
  onFollowingChange,
  resetKey,
}) => {
  const regionRef = useRef<HTMLDivElement | null>(null);
  /** The anchor rule's source of truth — a REF, never state (no per-token write). */
  const atBottomRef = useRef(true);
  const followingCallbackRef = useRef(onFollowingChange);
  /** True while a deliberate (smooth) return is animating — see handleScroll. */
  const returningRef = useRef(false);
  const returningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirrors `following` for the `Newest` control's presence. It flips only on a
  // real scroll event (deliberate) or on the `Newest` activation — never on an
  // arrival, so it cannot re-render per token.
  const [following, setFollowing] = useState(true);

  // Reduced-motion read once per mount — not per render, so a token arrival never
  // touches `matchMedia`.
  const [reduceMotion] = useState<boolean>(() => prefersReducedMotion());

  // Keep the callback ref current (it is only ever invoked from handlers/effects,
  // so a post-render refresh is in time) without re-creating `notifyFollowing`.
  useEffect(() => {
    followingCallbackRef.current = onFollowingChange;
  }, [onFollowingChange]);

  /**
   * CHANGE-ONLY report of the follow state, delivered SYNCHRONOUSLY to the
   * parent in the same task as the change (R-5.1 order-independence).
   *
   * Deferring this to a `requestAnimationFrame` let a measurement that was
   * already pending run BEFORE the flip in the same frame (rAF callbacks run in
   * registration order): it measured the newly arrived content while
   * `following` still read `true`, applied the UNFROZEN grown height, and the
   * freeze then latched that height for the whole scrolled-back episode — the
   * surface grew once and stayed grown while the reader was reading.
   *
   * Synchronous delivery costs nothing per frame and nothing per token: it is
   * only ever reached from a real scroll event, the `Newest` activation, or a
   * generation reset, and each of those is already change-only (`handleScroll`
   * early-returns when the value did not change). The parent's own
   * rAF-coalesced measurement remains THE per-frame layout-read coalescer.
   */
  const notifyFollowing = useCallback((next: boolean) => {
    followingCallbackRef.current?.(next);
  }, []);

  /** Releases the in-flight return guard (settled, interrupted, or timed out). */
  const clearReturning = useCallback(() => {
    returningRef.current = false;
    if (returningTimerRef.current !== null) {
      clearTimeout(returningTimerRef.current);
      returningTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (returningTimerRef.current !== null) {
        clearTimeout(returningTimerRef.current);
        returningTimerRef.current = null;
      }
    },
    [],
  );

  // FOLLOW: while the reader is at the bottom, new content moves the view itself.
  // No dependency array on purpose — this runs once per commit (i.e. per arrival)
  // and writes ONLY the DOM scroll offset, never React state.
  useLayoutEffect(() => {
    const el = regionRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  // A new generation follows again (R-5.2's reset edge).
  useEffect(() => {
    atBottomRef.current = true;
    setFollowing(true);
    notifyFollowing(true);
  }, [resetKey, notifyFollowing]);

  // HOLD vs FOLLOW: the ONLY place the anchor is re-decided. A programmatic
  // follow re-fires a scroll event while already at the bottom, so the early
  // return keeps that path silent (no state write, no callback).
  const handleScroll = useCallback(() => {
    const el = regionRef.current;
    if (!el) return;
    const next = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    if (returningRef.current) {
      // A deliberate return is animating: these intermediate offsets are the
      // animation, not the reader scrolling away. Only settle when we arrive.
      if (!next) return;
      clearReturning();
    }
    if (next === atBottomRef.current) return;
    atBottomRef.current = next;
    setFollowing(next);
    // Synchronous on purpose: the parent must observe this flip in the SAME task
    // as the scroll (see `notifyFollowing`), so a measurement can never latch an
    // unfrozen height while the reader is scrolled back.
    notifyFollowing(next);
  }, [clearReturning, notifyFollowing]);

  // DELIBERATE return: the pill is the only path back to following.
  const returnToNewest = useCallback(() => {
    const el = regionRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setFollowing(true);
    notifyFollowing(true);
    if (reduceMotion) {
      // Reduced motion ⇒ instant jump: `scroll-behavior` is `auto`, so this one
      // assignment lands at the end with no intermediate frames.
      el.scrollTop = el.scrollHeight;
    } else {
      // Animate (`scroll-behavior: smooth`); intermediate scroll events are held
      // back by the guard so the pill cannot flash while the view travels.
      returningRef.current = true;
      returningTimerRef.current = setTimeout(clearReturning, REPLY_SCROLL_RETURN_SETTLE_MS);
      el.scrollTop = el.scrollHeight;
    }
    // Focus the REGION, not the pill: the pill unmounts as following resumes and
    // the arrow/page keys keep working on the region.
    el.focus({ preventScroll: true });
  }, [clearReturning, notifyFollowing, reduceMotion]);

  return (
    <Box position="relative" width="100%" height="100%" minHeight="0">
      <Box
        ref={regionRef}
        data-testid={REPLY_SCROLL_TESTID}
        role="region"
        aria-label={label}
        aria-busy={isStreaming ? true : undefined}
        tabIndex={0}
        onScroll={handleScroll}
        // Any real user gesture interrupts a return: release the guard at once.
        onWheel={clearReturning}
        onPointerDown={clearReturning}
        onTouchStart={clearReturning}
        onKeyDown={clearReturning}
        style={{
          height: '100%',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          overflowWrap: 'break-word',
          // Scrolling past the end must not scroll the launcher behind it.
          overscrollBehavior: 'contain',
          // Reserved ALWAYS in the grown tier, so the rail appearing never
          // re-wraps the reply. No `scrollbar-gutter` anywhere (base tier).
          paddingInlineEnd: `${REPLY_SCROLL_RESERVED_GUTTER_PX}px`,
          paddingBlockEnd: `${REPLY_SCROLL_BOTTOM_PAD_PX}px`,
          scrollBehavior: reduceMotion ? 'auto' : 'smooth',
        }}
        css={REPLY_SCROLLBAR_CSS}
        _focusVisible={REPLY_FOCUS_VISIBLE}
      >
        {children}
      </Box>

      {/* Present ONLY once the reader has deliberately scrolled away; the pill's
          presence (a labelled button, not colour or motion) is the state. */}
      {!following && (
        <chakra.button
          type="button"
          data-testid={REPLY_SCROLL_NEWEST_TESTID}
          aria-label={REPLY_SCROLL_NEWEST_LABEL}
          onClick={returnToNewest}
          position="absolute"
          insetInlineEnd={`${REPLY_SCROLL_RESERVED_GUTTER_PX}px`}
          insetBlockEnd="8px"
          zIndex={1}
          display="inline-flex"
          alignItems="center"
          gap="4px"
          height="20px"
          paddingInline="8px"
          borderRadius="4px"
          fontSize="12px"
          fontFamily="var(--font-primary)"
          bg="accent.subtle"
          color="fg.default"
          border={`1px solid ${tint('var(--accent-primary)', 30)}`}
          cursor="pointer"
          _focusVisible={REPLY_FOCUS_VISIBLE}
        >
          Newest
          <Box as="span" aria-hidden="true" display="inline-flex" lineHeight="0">
            <LuArrowDown size={10} />
          </Box>
        </chakra.button>
      )}
    </Box>
  );
};
