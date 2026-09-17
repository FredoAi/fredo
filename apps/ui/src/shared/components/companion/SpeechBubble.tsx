import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Box, Text } from '@chakra-ui/react';
import { AVATAR_SM } from '../fredo-avatar';
import { tint } from '../../utils/colorTint';
import { ReplyScrollArea } from './ReplyScrollArea';
import {
  REPLY_BASE_H,
  REPLY_PAD,
  chooseReplyTier,
  completeAvatarRect,
  computeReplyGeometry,
  computeReplyPlacement,
  deriveAwayRegion,
  type ReplyAvatarRect,
  type ReplyAnchor,
  type ReplyGeometry,
  type ReplyPlacementResult,
  type ReplyRegion,
  type ReplySurfaceBounds,
} from './replySurfaceLayout';
import { getLauncherRegion } from './companionGeometry';

export interface SpeechBubbleProps {
  message: string | null;
  companionX: number;
  companionY: number;
  companionWidth?: number;
  companionHeight?: number;
  color?: string;
  isStreaming?: boolean;
  /**
   * Anchoring mode. `'fixed'` (default) is the legacy viewport-relative bubble
   * positioned by the `chooseSide` math. `'absolute'` anchors the bubble above
   * its parent slot (tail pointing down) and expects the consumer to supply a
   * `position: relative` wrapper — it takes no part in document flow.
   */
  positioning?: 'fixed' | 'absolute';
  children?: React.ReactNode;
  /**
   * #2883 ST-4 — the launcher-MEASURED reply band (viewport px: `safeTop` under
   * the notch, `barrierTop` = the command-bar box top, `boundsLeft`/`boundsRight`
   * = the launcher column's clip box inset by the margin). Present only for the
   * SEAT text reply; the grown tier is decided by `replySurfaceLayout` from it.
   * `undefined` ⇒ today's fixed rendering exactly (no measurement, no growth — R-5.3).
   */
  growth?: ReplySurfaceBounds;
  /**
   * #2886 ST-2/ST-4 — the MEASURED avatar footprint (viewport px: the
   * `.fredo-companion-avatar` wrapper box, 80×100 at the seat), supplied by the
   * entity. When present, the placement is derived in viewport px from this box
   * plus the region, so the surface can never be drawn over Fredo (`above` /
   * `right` / `left` only at the seat, with `REPLY_AVATAR_CLEARANCE` on the
   * placement axis). Absent ⇒ today's path exactly (the #2883 anchor-relative
   * geometry / CSS branch), which is what the shipped fixture asserts.
   */
  avatarRect?: ReplyAvatarRect;
  /**
   * #2883 ST-4 — the reply surface's identity for the QA collision frames
   * (`data-reply-kind`). Defaults to `'reply'` (the welcome bubble may pass
   * `'welcome'`); the game card is never this surface.
   */
  replyKind?: 'reply' | 'welcome';
  /**
   * #2883 ST-6 (AC4) — pointer/keyboard protection for the reply being read,
   * forwarded by `CompanionEntity` and bound on the text card. The card is the
   * hit target (`pointerEvents: 'auto'`), so a pointer over the reply can never
   * be "none".
   */
  onSurfaceEnter?: () => void;
  onSurfaceLeave?: () => void;
  onSurfaceFocus?: () => void;
  onSurfaceBlur?: () => void;
}

// Fixed bubble dimensions — never resize during streaming.
const BUBBLE_W  = 240;
const BUBBLE_H  = 120;
const PAD       = 14;
const TAIL      = 10;
const MARGIN    = 8;
const GAP       = 10;
// Inner content area height (bubble minus top+bottom padding)
const CONTENT_H = BUBBLE_H - PAD * 2;

// Game bubble dimensions — larger to fit the TicTacToe board.
const GAME_W = 208;
const GAME_H = 268;

// #2883 ST-4 — the base card's inner content box (240 × 120 minus two 14 px
// paddings): the tier boundary `chooseReplyTier` measures against. Derived from
// the layout module's constants — never a second copy of the number.
const BASE_CONTENT_H = REPLY_BASE_H - REPLY_PAD * 2;
// Sub-pixel tolerance for "the measured layout did not really change" — the
// state-write loop guard (AGENTS.md #523).
const LAYOUT_EPSILON_PX = 0.5;

/** #2883 QA-bound surface identities (the collision frames query these). */
export const REPLY_SURFACE_TESTID = 'fredo-reply-surface';
export const GAME_BUBBLE_TESTID = 'fredo-game-bubble';

type Side = 'above' | 'below' | 'left' | 'right';

/** #2883 ST-4 / #2886 ST-2 — the measured avatar footprint + the pure module's decision. */
interface SeatReplyLayout {
  /** The measured avatar footprint (or, on the legacy no-footprint path, the wrapper box). */
  anchor: ReplyAnchor;
  /**
   * #2886 — true when the geometry came from the avatar-footprint + region
   * contract (viewport px). Such a layout is applied even at the base tier, so
   * the separation strip is the bound `REPLY_AVATAR_CLEARANCE`.
   */
  regionBased: boolean;
  geometry: ReplyGeometry;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < LAYOUT_EPSILON_PX;
}

function sameAnchor(a: ReplyAnchor, b: ReplyAnchor): boolean {
  return (
    near(a.top, b.top) &&
    near(a.left, b.left) &&
    near(a.right, b.right) &&
    near(a.bottom, b.bottom) &&
    near(a.width, b.width) &&
    near(a.height, b.height)
  );
}

function sameSeatReplyLayout(prev: SeatReplyLayout | null, next: SeatReplyLayout): boolean {
  if (!prev) return false;
  const a = prev.geometry;
  const b = next.geometry;
  return (
    a.tier === b.tier &&
    a.placement === b.placement &&
    a.scrollable === b.scrollable &&
    near(a.width, b.width) &&
    near(a.height, b.height) &&
    near(a.left, b.left) &&
    near(a.bottom, b.bottom) &&
    sameAnchor(prev.anchor, next.anchor) &&
    prev.regionBased === next.regionBased
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function chooseSide(cx: number, cy: number, cw: number, ch: number, bw: number, bh: number): Side {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const space: Record<Side, number> = {
    above: cy,
    below: vh - (cy + ch),
    left:  cx,
    right: vw - (cx + cw),
  };
  const needed: Record<Side, number> = {
    above: bh + TAIL + GAP,
    below: bh + TAIL + GAP,
    left:  bw + TAIL + GAP,
    right: bw + TAIL + GAP,
  };
  const ranked: Side[] = ['above', 'right', 'left', 'below'];
  return ranked.find(s => space[s] >= needed[s]) ?? 'above';
}

export const SpeechBubble: React.FC<SpeechBubbleProps> = ({
  message,
  companionX,
  companionY,
  companionWidth  = AVATAR_SM.width,
  companionHeight = AVATAR_SM.height,
  color = 'var(--accent-primary)',
  isStreaming = false,
  positioning = 'fixed',
  growth,
  avatarRect,
  replyKind = 'reply',
  onSurfaceEnter,
  onSurfaceLeave,
  onSurfaceFocus,
  onSurfaceBlur,
  children,
}) => {
  // Reduced motion: the bubble entry/exit degrades to fade-only (opacity) with no
  // scale/translate transform. The 4 s auto-hide timing and the seat anchor are
  // unaffected — only the entrance/exit variant changes.
  const reduceMotion = useReducedMotion() ?? false;
  const hasGame = Boolean(children);
  const bw = hasGame ? GAME_W : BUBBLE_W;
  const bh = hasGame ? GAME_H : BUBBLE_H;
  const cx = companionX;
  const cy = companionY;
  const cw = companionWidth;
  const ch = companionHeight;

  const isAbsolute = positioning === 'absolute';

  // #2886 — the viewport is an INPUT of the placement (both the region maths and
  // the on-screen guarantee), so a window resize must re-decide it. State, not a
  // ref (the placement is computed during render), with an equality guard so a
  // sub-pixel resize never re-renders (AGENTS.md #523).
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => {
      setViewportSize((prev) =>
        prev.width === window.innerWidth && prev.height === window.innerHeight
          ? prev
          : { width: window.innerWidth, height: window.innerHeight },
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── #2886 ST-4 — the AWAY overlay ranks the same candidates ────────────────
  // The fixed path used to clamp to the VIEWPORT edges only, so it could land the
  // card on Fredo, on the command bar or on the tiles. With a measured footprint
  // (the overlay's own `.fredo-companion-avatar` box) and the launcher region
  // published through the #2870 ST-2c-style registry (`main.tsx` renders the
  // overlay OUTSIDE `LauncherShell`, so a prop cannot reach it), the placement is
  // the same pure decision the seat uses — with `below` allowed (the legacy
  // #2850 ranking) and the card kept at its fixed 240×120 (`contentHeightPx: 0`
  // ⇒ base tier; the #2883 grown tier and its scroller stay seat-only).
  const awayViewport = viewportSize;
  const awayFootprint = !isAbsolute && !hasGame && avatarRect
    ? completeAvatarRect(avatarRect, AVATAR_SM)
    : null;
  const awayPlacement: ReplyPlacementResult | null = awayFootprint
    ? computeReplyPlacement({
        avatar: awayFootprint,
        region: deriveAwayRegion(getLauncherRegion(), awayViewport),
        viewport: awayViewport,
        contentHeightPx: 0,
        allowBelow: true,
      })
    : null;

  // In `absolute` mode the bubble always sits above its parent slot with the
  // tail pointing down, irrespective of viewport space — force the 'above'
  // geometry so the tail + entrance animation match that anchor.
  const side: Side = isAbsolute
    ? 'above'
    : awayPlacement
      ? awayPlacement.placement
      : chooseSide(cx, cy, cw, ch, bw, bh);

  let bubbleLeft = 0;
  let bubbleTop  = 0;

  if (side === 'above') {
    bubbleTop  = cy - bh - TAIL - GAP;
    bubbleLeft = cx + cw / 2 - bw / 2;
  } else if (side === 'below') {
    bubbleTop  = cy + ch + TAIL + GAP;
    bubbleLeft = cx + cw / 2 - bw / 2;
  } else if (side === 'right') {
    bubbleLeft = cx + cw + TAIL + GAP;
    bubbleTop  = cy + ch / 2 - bh / 2;
  } else {
    bubbleLeft = cx - bw - TAIL - GAP;
    bubbleTop  = cy + ch / 2 - bh / 2;
  }

  bubbleLeft = Math.max(MARGIN, Math.min(bubbleLeft, window.innerWidth  - bw - MARGIN));
  bubbleTop  = Math.max(MARGIN, Math.min(bubbleTop,  window.innerHeight - bh - MARGIN));

  // The verified placement is the LAST word: it already honours the footprint,
  // the launcher region and the viewport, so it is never re-clamped by the
  // viewport-only MARGIN rule above.
  if (awayPlacement) {
    bubbleLeft = awayPlacement.left;
    bubbleTop = awayPlacement.top;
  }

  const companionCX = cx + cw / 2;
  const companionCY = cy + ch / 2;

  // ── #2883 ST-4 — the two-tier text reply surface (AC2 render side) ──────────
  // The grown tier is a SEAT (`position:absolute`) text-reply concern only: the
  // fixed away-overlay path and the 208×268 game card keep today's handling even
  // if a band were passed. `undefined` band ⇒ today's rendering exactly (R-5.3).
  const growthApplies = isAbsolute && growth !== undefined && !hasGame;

  const [seatLayout, setSeatLayout] = useState<SeatReplyLayout | null>(null);
  const [replyGeneration, setReplyGeneration] = useState(0);
  /** Latest layout (mirrors `seatLayout`) — read from the rAF callback. */
  const seatLayoutRef = useRef<SeatReplyLayout | null>(null);
  /**
   * The card — the surface Box the DOM tests query and the element the LEGACY
   * (no-footprint) path measures the seat wrapper from. #2886: the production
   * path never measures this node's ancestors; the placement anchor is the
   * entity-supplied `avatarRect` footprint.
   */
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /**
   * #2886 — the normalized footprint for the rAF callback. A prop object is a new
   * identity each render, so it is mirrored into a ref rather than a dependency:
   * the measurement already re-runs on every commit, and the epsilon guard keeps
   * the state write out of the loop (AGENTS.md #523).
   */
  const footprintRef = useRef<ReplyAvatarRect | null>(null);
  footprintRef.current = avatarRect ? completeAvatarRect(avatarRect, AVATAR_SM) : null;
  /** The streaming `<Text>` — its own rect height is the wrapped content height. */
  const textRef = useRef<HTMLParagraphElement | null>(null);
  /** Latched tier: once grown, the surface stays grown for the generation. */
  const grownRef = useRef(false);
  /** The reader's follow state, reported ref-only by `ReplyScrollArea` (R-5.1). */
  const followingRef = useRef(true);
  const streamingRef = useRef(isStreaming);
  const frameRef = useRef<number | null>(null);

  const applySeatLayout = useCallback((next: SeatReplyLayout | null) => {
    seatLayoutRef.current = next;
    setSeatLayout(next);
  }, []);

  const measureSeatReply = useCallback(() => {
    if (!growthApplies) {
      if (seatLayoutRef.current !== null) applySeatLayout(null);
      return;
    }
    const text = textRef.current;
    if (!text) return;
    const footprint = footprintRef.current;

    // The `<Text>`'s own border box is its FULL wrapped height even when the
    // base content box clips it — that is the measurement the tier needs.
    const contentHeightPx = text.getBoundingClientRect().height;

    // Latch the tier: once the content no longer fits the base box the surface
    // stays grown for the rest of the generation (AC2 — no mid-stream flapping),
    // so the re-measure at the WIDER grown width can never collapse it back.
    const latchedNow = !grownRef.current && chooseReplyTier(contentHeightPx) === 'grown';
    if (latchedNow) grownRef.current = true;
    // A height is only meaningful at the tier's OWN width: on the latching pass
    // the Text is still laid out at the BASE width, so its (taller) height is
    // discarded — the surface opens at the floor and the next frame measures at
    // the grown width (growth stays monotonic: base → grown@120 → grown@content).
    // Keeping the value above the base boundary also makes the module return a
    // grown rect; the extra pixel never changes the size maths, because
    // `clamp(120, content, available)` is identical for any content ≤ 120.
    const measuredContent = !grownRef.current
      ? contentHeightPx
      : latchedNow
        ? BASE_CONTENT_H + 1
        : Math.max(contentHeightPx, BASE_CONTENT_H + 1);

    const prev = seatLayoutRef.current;
    let anchor: ReplyAnchor;
    let geometry: ReplyGeometry;
    let regionBased: boolean;

    if (footprint) {
      // #2886 ST-2/ST-3 — the ONE placement decision: measured footprint + the
      // launcher-measured region, in VIEWPORT px. `above` / `right` / `left`
      // only (a seat `below` is the command bar's band); every candidate is
      // validated against the footprint + the bound clearance before it is
      // accepted, and the facing edge is pinned at `footprint ± clearance` so
      // growth is one-directional. The seat slot's content box IS the avatar's
      // box, so the containing block origin is the footprint: converting the
      // viewport rect to anchor-relative offsets is the only conversion.
      const placement = computeReplyPlacement({
        avatar: footprint,
        region: growth as ReplyRegion,
        viewport: viewportSize,
        contentHeightPx: measuredContent,
        allowBelow: false,
      });
      anchor = footprint;
      regionBased = true;
      geometry = {
        tier: placement.tier,
        // A seat `below` is unreachable (`allowBelow: false`); narrow the type.
        placement: placement.placement === 'below' ? 'above' : placement.placement,
        width: placement.width,
        height: placement.height,
        left: placement.left - footprint.left,
        bottom: footprint.bottom - placement.bottom,
        scrollable: placement.scrollable,
      };
    } else {
      // Legacy path (no measured footprint — the #2883 unit fixture shape, where
      // the bubble's direct parent IS the 80×100 seat slot). Absent footprint ⇒
      // today's anchor-relative geometry exactly.
      const motionEl = surfaceRef.current?.parentElement ?? null;
      const anchorEl = motionEl?.parentElement ?? null;
      if (!anchorEl) return;
      const rect = anchorEl.getBoundingClientRect();
      anchor = {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
      regionBased = false;
      geometry = computeReplyGeometry({
        anchor,
        bounds: growth,
        contentHeightPx: measuredContent,
      });
    }

    // Reading position (R-5.1): while the reader is scrolled back, the surface
    // height is FROZEN — arriving tokens only lengthen `scrollHeight` below them.
    const frozenHeight =
      !followingRef.current &&
      prev !== null &&
      prev.geometry.tier === 'grown' &&
      geometry.tier === 'grown' &&
      prev.geometry.placement === geometry.placement &&
      near(prev.geometry.width, geometry.width)
        ? prev.geometry.height
        : null;

    const next: SeatReplyLayout = {
      anchor,
      regionBased,
      geometry: frozenHeight === null ? geometry : { ...geometry, height: frozenHeight },
    };
    if (!sameSeatReplyLayout(prev, next)) applySeatLayout(next);
  }, [applySeatLayout, growth, growthApplies, viewportSize]);

  // Perf NFR: the measurement is rAF-coalesced, so many token commits inside one
  // frame cost ONE layout read — never one forced reflow per token.
  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return;
    const run = () => {
      frameRef.current = null;
      measureSeatReply();
    };
    if (typeof requestAnimationFrame === 'function') {
      frameRef.current = requestAnimationFrame(run);
    } else {
      run();
    }
  }, [measureSeatReply]);

  // Never a state setter (ST-5's contract): `ReplyScrollArea` reports the follow
  // state through this callback, the height freeze reads the ref, and the
  // re-measure this schedules is what RELEASES the freeze when the reader
  // deliberately returns to the newest content (R-5.1/R-5.2) — even after the
  // stream has settled and no further token commits arrive.
  const handleFollowingChange = useCallback((following: boolean) => {
    followingRef.current = following;
    scheduleMeasure();
  }, [scheduleMeasure]);

  useLayoutEffect(() => {
    if (!growthApplies && seatLayoutRef.current === null) return;
    scheduleMeasure();
  });

  useEffect(() => () => {
    if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = null;
  }, []);

  // A new generation is the entity's false → true streaming edge (the companion
  // runs one generation at a time). It re-evaluates base-vs-grown from the first
  // token, re-arms the reading anchor and clears the `Newest` control.
  useLayoutEffect(() => {
    if (isStreaming && !streamingRef.current) {
      grownRef.current = false;
      followingRef.current = true;
      if (seatLayoutRef.current !== null) applySeatLayout(null);
      setReplyGeneration((generation) => generation + 1);
    }
    streamingRef.current = isStreaming;
  }, [isStreaming, applySeatLayout]);

  // The pure module's decision (never re-derived here). A region-based layout is
  // applied even at the BASE tier (#2886: with a measured region the one-liner
  // also keeps the bound `REPLY_AVATAR_CLEARANCE` strip); `null` ⇒ today's
  // byte-for-byte CSS branch (no measured band — R-5.3).
  const seatGeometry =
    growthApplies && seatLayout !== null && (seatLayout.geometry.tier === 'grown' || seatLayout.regionBased)
      ? seatLayout.geometry
      : null;
  const replyTier = seatGeometry ? seatGeometry.tier : 'base';
  // The tail follows the effective placement (base ⇒ today's `side`).
  const effectiveSide: Side = seatGeometry ? seatGeometry.placement : side;
  const tailOnHoriz = effectiveSide === 'above' || effectiveSide === 'below';

  const tailOffsetX = tailOnHoriz
    ? Math.max(PAD + TAIL, Math.min(companionCX - bubbleLeft, BUBBLE_W - PAD - TAIL))
    : 0;
  const tailOffsetY = !tailOnHoriz
    ? Math.max(PAD + TAIL, Math.min(companionCY - bubbleTop, BUBBLE_H - PAD - TAIL))
    : 0;

  // #2883 ST-4 — the grown tier's tail anchor, computed from the MEASURED slot
  // (never from the `displayPos` prop, which is `{0,0}` at the seat).
  let grownTailOffsetX = tailOffsetX;
  let grownTailOffsetY = tailOffsetY;
  if (seatGeometry && seatLayout) {
    const { anchor } = seatLayout;
    grownTailOffsetX = clampNumber(
      anchor.width / 2 - seatGeometry.left,
      PAD + TAIL,
      seatGeometry.width - PAD - TAIL,
    );
    grownTailOffsetY = clampNumber(
      seatGeometry.bottom + seatGeometry.height - anchor.height / 2,
      PAD + TAIL,
      seatGeometry.height - PAD - TAIL,
    );
  }

  const initDelta = effectiveSide === 'above' ? 6 : effectiveSide === 'below' ? -6 : effectiveSide === 'right' ? -6 : 6;

  // The streaming `<Text>` + cursor markup stays in THIS file (pinned by
  // `companion.cursorReducedMotion.test.ts`); the grown tier passes it to the
  // scroller as `children`, the base tier renders it in today's fixed box.
  const replyText = (
    <Text
      ref={textRef}
      fontFamily='"Fira Mono", monospace'
      fontSize="12px"
      lineHeight="19px"
      color="var(--text-primary)"
      whiteSpace="pre-wrap"
    >
      {message as React.ReactNode}
      {isStreaming && (
        <Box
          as="span"
          className="fredo-cursor"
          display="inline-block"
          width="2px"
          height="14px"
          background={color}
          marginLeft="1px"
          verticalAlign="middle"
          animation="Fredo-cursor-blink 0.9s step-end infinite"
        />
      )}
    </Text>
  );

  return (
    <AnimatePresence>
      {((message || children) as React.ReactNode) && (
        <motion.div
          // Key is stable while the bubble is open — only changes on open/close.
          // Using a static key prevents re-mounting (and jank) on every token.
          key="speech-bubble"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, y: initDelta }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, y: initDelta }}
          transition={
            reduceMotion
              ? { duration: 0.2, ease: 'easeOut' as const }
              : { type: 'spring' as const, stiffness: 380, damping: 30 }
          }
          style={
            seatGeometry
              ? {
                  // #2883 ST-4 grown tier — the pure module's anchor-relative rect,
                  // inside the launcher-measured band and the column's clip box, and
                  // clamped to the window. Growth is inline style, never a transition.
                  position: 'absolute',
                  left: seatGeometry.left,
                  bottom: seatGeometry.bottom,
                  width: seatGeometry.width,
                  height: seatGeometry.height,
                  zIndex: 101,
                  // The text card is a hit target — a pointer can be "over the
                  // reply" (AC4). Not a pixel change.
                  pointerEvents: 'auto',
                }
              : isAbsolute
              ? {
                  // Anchored above the (position: relative) parent slot, centred.
                  position: 'absolute',
                  bottom: `calc(100% + ${TAIL}px)`,
                  left: '50%',
                  // framer-motion owns this element's transform (it animates
                  // y/scale), so the centering translate is expressed as its `x`
                  // motion value — it composes to `translateX(-50%)` in the
                  // generated transform instead of being clobbered.
                  x: '-50%',
                  width: bw,
                  height: bh,
                  zIndex: 101,
                  pointerEvents: 'auto',
                }
              : {
                  position: 'fixed',
                  left: bubbleLeft,
                  top: bubbleTop,
                  width: awayPlacement ? awayPlacement.width : bw,
                  height: awayPlacement ? awayPlacement.height : bh,
                  zIndex: 101,
                  pointerEvents: 'auto',
                }
          }
        >
          <Box
            ref={surfaceRef}
            data-testid={hasGame ? GAME_BUBBLE_TESTID : REPLY_SURFACE_TESTID}
            data-reply-tier={hasGame ? undefined : replyTier}
            data-reply-kind={hasGame ? undefined : replyKind}
            // #2886 ST-2 (E6) — the frozen placement hook: the chosen side is
            // machine-readable next to the tier/kind so a test can assert the
            // surface is strictly on that side of the avatar.
            data-reply-placement={hasGame ? undefined : effectiveSide}
            onPointerEnter={hasGame ? undefined : onSurfaceEnter}
            onPointerLeave={hasGame ? undefined : onSurfaceLeave}
            onFocus={hasGame ? undefined : onSurfaceFocus}
            onBlur={hasGame ? undefined : onSurfaceBlur}
            background="var(--card-bg)"
            border={`1.5px solid ${color}`}
            borderRadius="14px"
            padding={hasGame ? '0' : `${PAD}px`}
            boxShadow={`0 4px 24px ${tint('var(--border-color)', 45)}`}
            position="relative"
            width="100%"
            height="100%"
            overflow={hasGame ? 'visible' : 'hidden'}
          >
            {hasGame ? (
              children
            ) : seatGeometry && seatGeometry.tier === 'grown' ? (
              /* #2883 ST-4 grown tier — the surface stops growing at the cap and
                 the scroller takes over (AC3, R-3.1); the streaming Text + cursor
                 markup above is unchanged and mounts as its children. #2886 keeps
                 this seat-only: a base-tier region placement (the one-liner) uses
                 the fixed content box below, never a scroller. */
              <ReplyScrollArea
                isStreaming={isStreaming}
                onFollowingChange={handleFollowingChange}
                resetKey={replyGeneration}
              >
                {replyText}
              </ReplyScrollArea>
            ) : (
              /* Fixed-height text area — no layout shift during streaming */
              <Box height={`${CONTENT_H}px`} overflow="hidden" position="relative">
                {replyText}
              </Box>
            )}

            {effectiveSide === 'above' && (
              <Box position="absolute" bottom={`-${TAIL}px`} left={seatGeometry ? `${grownTailOffsetX}px` : isAbsolute ? '50%' : `${tailOffsetX}px`} transform="translateX(-50%)"
                width="0" height="0"
                borderTop={`${TAIL}px solid ${color}`}
                borderLeft={`${TAIL}px solid transparent`}
                borderRight={`${TAIL}px solid transparent`}
              />
            )}
            {effectiveSide === 'below' && (
              <Box position="absolute" top={`-${TAIL}px`} left={`${tailOffsetX}px`} transform="translateX(-50%)"
                width="0" height="0"
                borderBottom={`${TAIL}px solid ${color}`}
                borderLeft={`${TAIL}px solid transparent`}
                borderRight={`${TAIL}px solid transparent`}
              />
            )}
            {effectiveSide === 'right' && (
              <Box position="absolute" left={`-${TAIL}px`} top={seatGeometry ? `${grownTailOffsetY}px` : `${tailOffsetY}px`} transform="translateY(-50%)"
                width="0" height="0"
                borderRight={`${TAIL}px solid ${color}`}
                borderTop={`${TAIL}px solid transparent`}
                borderBottom={`${TAIL}px solid transparent`}
              />
            )}
            {effectiveSide === 'left' && (
              <Box position="absolute" right={`-${TAIL}px`} top={seatGeometry ? `${grownTailOffsetY}px` : `${tailOffsetY}px`} transform="translateY(-50%)"
                width="0" height="0"
                borderLeft={`${TAIL}px solid ${color}`}
                borderTop={`${TAIL}px solid transparent`}
                borderBottom={`${TAIL}px solid transparent`}
              />
            )}
          </Box>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
