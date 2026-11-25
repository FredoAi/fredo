/**
 * `AvatarPoster` — the static stand-in that fills the avatar's reserved box
 * wherever the live 3D render is not (yet) painting (spec 3210 ST-2).
 *
 * It is built out of the two committed poster passes, in this order:
 *
 *   1. BODY   — a solid `var(--accent-primary)` fill masked by `poster-body.png`
 *               (an ALPHA mask), so the body follows the user's accent with zero
 *               JavaScript: the browser repaints the variable, the fallback is
 *               never a frozen picture of the accent that happened to be live.
 *   2. DETAIL — `poster-detail.png` on top, carrying the authored colours (the
 *               wardrobe, the trim, the expression) that the accent must never
 *               reach.
 *
 * THE TRAP THIS COMPONENT EXISTS TO PREVENT — the poster must never be a
 * permanent backdrop. If the poster stayed painted underneath a transparent
 * canvas, a `teleport-out` dissolve would reveal a fully opaque standing idle
 * figure *through* the vanishing body: the mascot would appear to stay put while
 * the wrapper's shrink/fade ran around it, silently breaking the shipped
 * teleport read. So while the canvas is live the poster layer is
 * `visibility: hidden` — mounted (its rect, its probe and its transitions
 * survive) but painting nothing — and it is re-shown only by a fall back to the
 * poster. THE LIVING HALF OF THIS CONTRACT IS THE RENDERER'S: the canvas must
 * also clear transparent (alpha buffer, clear alpha 0). An opaque clear would
 * paint a rectangle of background colour over the seat and over whatever the
 * floating companion hovers above.
 *
 * Four render boundaries, four rules (they are NOT one "fade everything" rule):
 *
 *   poster first paint      INSTANT, no fade-in. A fade from empty IS the blank
 *                           seat the acceptance criterion forbids, and the box is
 *                           already reserved so nothing can shift. The body fill
 *                           additionally starts at `opacity: 0` and flips to 1 only
 *                           once its mask bitmap is decoded: an undecoded mask that
 *                           painted a solid accent rectangle would be worse than a
 *                           two-frame gap.
 *   poster -> live          OPACITY ONLY, `AVATAR_POSTER_HANDOFF_MS` (150 ms): the
 *                           silhouettes coincide, so only the shading changes. No
 *                           transform, no size change, no reflow.
 *   live -> poster          INSTANT. A fade would read as the character leaving and
 *                           coming back — two motions for one event.
 *   any boundary, reduced   INSTANT. "No animation plays" includes our transitions.
 *   motion
 *
 * Layout: every layer is `position: absolute; inset: 0; pointer-events: none` and
 * exactly fills its parent, so the poster inherits the reserved footprint (80x100
 * CSS px on both shipped surfaces) with no intrinsic size of its own: it can
 * neither shift the seat nor capture the click/double-click/ctrl+right-click that
 * the consumer wrapper owns. Nothing here is focusable and nothing is announced —
 * the avatar root is `aria-hidden`, the detail image is `alt=""`, and the state is
 * announced once by the consumer wrapper's label.
 */

import { useState, type CSSProperties } from 'react';

import { useReducedMotion } from '../../hooks/useReducedMotion';
import { AVATAR_POSTER_BODY_URL, AVATAR_POSTER_DETAIL_URL } from './avatarAsset';

/**
 * Where the shell is in the poster/live swap. The parent owns the sequencing; this
 * component owns what each phase paints.
 */
export type AvatarPosterPhase = 'poster' | 'handoff' | 'live';

/** The poster-to-live handoff duration (opacity only). */
export const AVATAR_POSTER_HANDOFF_MS = 150;

/**
 * Whether the poster paints anything in a phase. `handoff` still paints (both
 * layers must be visible for a crossfade); only `live` hides it.
 *
 * This is the PHASE-level rule. The component additionally drops `handoff` to
 * hidden under reduced motion, where every boundary is instant.
 */
export function isAvatarPosterPainted(phase: AvatarPosterPhase): boolean {
  return phase !== 'live';
}

export interface AvatarPosterProps {
  /** Where the shell is in the poster/live swap. Defaults to `poster`. */
  phase?: AvatarPosterPhase;
  /** Extra class for the poster layer (the shell's own hooks stay here). */
  className?: string;
}

export function AvatarPoster({ phase = 'poster', className }: AvatarPosterProps) {
  const reducedMotion = useReducedMotion();
  const [maskDecoded, setMaskDecoded] = useState(false);
  const [maskFailed, setMaskFailed] = useState(false);

  // Under reduced motion the handoff is not a transition at all: the poster is
  // simply gone the moment the shell reports the canvas is up.
  const crossfading = phase === 'handoff' && !reducedMotion;
  const painted = phase === 'poster' || crossfading;

  const layerStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    // `hidden` (not `display: none`) keeps the reserved rect and the probe alive
    // while the canvas paints — and hides it from the compositor, which is what
    // stops a ghost idle figure showing through a teleport dissolve.
    visibility: painted ? 'visible' : 'hidden',
    opacity: phase === 'poster' ? 1 : 0,
    transition: crossfading ? `opacity ${AVATAR_POSTER_HANDOFF_MS}ms linear` : 'none',
  };

  const bodyStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'var(--accent-primary)',
    maskImage: `url("${AVATAR_POSTER_BODY_URL}")`,
    WebkitMaskImage: `url("${AVATAR_POSTER_BODY_URL}")`,
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
    // Instant on purpose (poster first paint): no fade-in, and nothing painted
    // until the mask bitmap is decoded.
    opacity: maskDecoded && !maskFailed ? 1 : 0,
    transition: 'none',
  };

  const detailStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    // `fill` (never `contain`): the pass is authored at the box's own aspect, so
    // filling cannot letterbox it or make the crossfade jump.
    objectFit: 'fill',
    imageRendering: 'auto',
    display: 'block',
    pointerEvents: 'none',
  };

  const maskLoaderStyle: CSSProperties = {
    position: 'absolute',
    width: 0,
    height: 0,
    opacity: 0,
    pointerEvents: 'none',
  };

  return (
    <span data-avatar-poster-layer="" aria-hidden="true" className={className} style={layerStyle}>
      <span data-avatar-poster-body="" style={bodyStyle} />
      <img data-avatar-poster-detail="" src={AVATAR_POSTER_DETAIL_URL} alt="" draggable={false} style={detailStyle} />
      {/*
        The body pass is applied as a CSS mask, which exposes no load event, so a
        zero-size image of the SAME url (one cache entry) is what tells us the
        bitmap is decoded. Its load flips the body fill on in the same frame.
      */}
      <img
        data-avatar-poster-mask-loader=""
        src={AVATAR_POSTER_BODY_URL}
        alt=""
        draggable={false}
        onLoad={() => setMaskDecoded(true)}
        onError={() => setMaskFailed(true)}
        style={maskLoaderStyle}
      />
    </span>
  );
}
