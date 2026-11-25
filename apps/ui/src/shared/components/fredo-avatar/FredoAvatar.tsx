/**
 * Shared FREDO avatar — the ONE canonical brand mascot for every surface.
 *
 * Spec #3210 hard cut-over: the hand-authored SVG render path is DELETED. This
 * component now renders the shipped game-ready character through the injected
 * three.js renderer seam (`three/avatarRenderer.ts`), with `AvatarPoster` as the
 * pre-load / unavailable fallback. There is exactly ONE render path — the
 * poster+canvas shell — and no second (SVG) implementation.
 *
 * ## The shell (one probe surface, stable across poster/live)
 *
 * ```
 * <div class="fredo-avatar" data-avatar-render="poster|live"
 *      data-avatar-clip="<applied clip>"      (live only)
 *      data-avatar-motion="play|still"
 *      data-avatar-body-color="#rrggbb"       (live only)
 *      aria-hidden="true" style="width:80px;height:100px;position:relative">
 *   <span data-avatar-poster-layer />          (always mounted; hidden while live)
 *   <canvas data-avatar-canvas />              (mounted only on a WebGL2-capable host)
 * </div>
 * ```
 *
 * ## What this component owns, and what it does NOT
 *
 * - It owns the reserved footprint (`AVATAR_SIZE`), the poster/live swap and the
 *   two live hooks mirrored from the mixer's ACTUAL state (`data-avatar-clip`,
 *   `data-avatar-body-color`) — never the requested values.
 * - It does NOT own whole-element motion. Idle bob/glow, the per-state wrapper
 *   motion, teleport shrink/fade and pointer parallax stay on the CONSUMER's
 *   wrapper (`fredoAvatarIdle.css`, `companion.css`, `useAvatarParallax.ts`);
 *   everything the renderer animates lives INSIDE the canvas (#2850).
 * - It does NOT read the Doom visual store. Doom is a palette re-tint in this
 *   base (the accent is a live CSS-variable read inside the renderer); the
 *   clip-driven armour is #3223's landing.
 *
 * ## The poster is not a backdrop
 *
 * While the canvas is live the poster layer is `visibility: hidden` (mounted, so
 * its rect and the probe survive). A permanently painted poster behind a
 * transparent canvas would reveal an opaque standing `idle` figure through a
 * `teleport-out` dissolve. `AvatarPoster` owns that rule; this shell only feeds
 * it the phase.
 *
 * ## Why `capable` is component state
 *
 * The capability probe is a host property (`probeAvatar3d()`), so it is read
 * once per mount. Under jsdom the global `WebGL2RenderingContext` does not exist,
 * the probe returns false BEFORE any `getContext` call, no canvas is mounted and
 * every suite exercises the PRODUCTION poster path (U-1).
 */

import React, { useEffect, useState, type CSSProperties } from 'react';

import { useReducedMotion } from '../../hooks/useReducedMotion';
import { AVATAR_POSTER_HANDOFF_MS, AvatarPoster, type AvatarPosterPhase } from './AvatarPoster';
import { loadAvatarAsset, type AvatarAsset } from './avatarAsset';
import { AVATAR_SIZE, type FredoAvatarSize } from './fredoAvatarSizes';
import type { FredoAvatarState } from './fredoAvatarStates';
import { probeAvatar3d } from './three/avatarCapability';
import { useAvatarRenderer } from './useAvatarRenderer';
// Wrapper motion (the shipped idle bob + accent glow + per-state desktop motion)
// is NOT an expression overlay — it stays byte-identical and its import stays.
import './fredoAvatarIdle.css';

export type { FredoAvatarState } from './fredoAvatarStates';

export interface FredoAvatarProps {
  /** `sm` → 80×100 (both shipped surfaces); `md` → 132×165 (component-only). */
  size: FredoAvatarSize;
  /** Resolved display state — the clip the renderer plays. Default `idle`. */
  state?: FredoAvatarState;
  /** Gates `talk`: held at its first frame while the assistant is not streaming. */
  streaming?: boolean;
  /** Passthrough class for the avatar root. */
  className?: string;
}

export const FredoAvatar: React.FC<FredoAvatarProps> = ({
  size,
  state = 'idle',
  streaming = false,
  className,
}) => {
  const { width, height } = AVATAR_SIZE[size];
  const reducedMotion = useReducedMotion();

  // A host capability, not a per-render decision: read once per mount.
  const [capable] = useState(() => probeAvatar3d());
  const [asset, setAsset] = useState<AvatarAsset | null>(null);
  // `setCanvas` is a stable callback ref (a state setter never changes identity),
  // so React calls it only on mount/unmount — never on every render.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!capable) return undefined;

    let cancelled = false;
    loadAvatarAsset()
      .then((next) => {
        if (!cancelled) setAsset(next);
      })
      .catch(() => {
        // The poster is the fallback for this mount; `loadAvatarAsset` forgets a
        // failure so a later mount may retry. Never a retry storm.
      });

    return () => {
      cancelled = true;
    };
  }, [capable]);

  const status = useAvatarRenderer({ canvas, asset, state, streaming, enabled: capable });
  const live = status.render === 'live';

  // The poster -> live handoff is an opacity-only 150 ms crossfade; under reduced
  // motion every render boundary is instant. `handoff` is true only for that
  // window, so the poster can stop being painted afterwards.
  const [handoff, setHandoff] = useState(false);
  useEffect(() => {
    if (!live || reducedMotion) {
      setHandoff(false);
      return undefined;
    }

    setHandoff(true);
    const timer = window.setTimeout(() => setHandoff(false), AVATAR_POSTER_HANDOFF_MS);
    return () => window.clearTimeout(timer);
  }, [live, reducedMotion]);

  const posterPhase: AvatarPosterPhase = !live ? 'poster' : handoff ? 'handoff' : 'live';

  const rootStyle: CSSProperties = {
    position: 'relative',
    width,
    height,
  };

  const canvasStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
    pointerEvents: 'none',
    opacity: live ? 1 : 0,
    transition: handoff ? `opacity ${AVATAR_POSTER_HANDOFF_MS}ms linear` : 'none',
  };

  return (
    <div
      className={className ? `fredo-avatar ${className}` : 'fredo-avatar'}
      data-avatar-render={status.render}
      data-avatar-clip={live && status.clip ? status.clip : undefined}
      data-avatar-motion={status.motion}
      data-avatar-body-color={live && status.bodyColor ? status.bodyColor : undefined}
      aria-hidden="true"
      style={rootStyle}
    >
      <AvatarPoster phase={posterPhase} />
      {capable ? <canvas ref={setCanvas} data-avatar-canvas="" style={canvasStyle} /> : null}
    </div>
  );
};
