/**
 * backgroundMotion — the ONE module that owns desktop-background motion
 * (Spec #2905 ST-2 / ST-3).
 *
 * Motion is declARATIVE CSS `@keyframes` applied to already-painted gradient
 * layers. It animates `transform` and `opacity` ONLY — never a colour property,
 * never `background-position`/`background-size` (those repaint every frame), and
 * never a JS frame loop (no `requestAnimationFrame`, no `setInterval`). Every
 * motion is bounded by the constants below so it can never strobe or blank out:
 *
 *   - no cycle shorter than `MOTION_DURATION_MIN_MS` (8 s);
 *   - layer opacity never drops below `MOTION_OPACITY_MIN` and never swings more
 *     than `MOTION_OPACITY_SWING_MAX` (no 0↔1 blank-out);
 *   - `translate` stays within `MOTION_TRANSLATE_MAX_PCT` of the layer box;
 *   - `scale` stays within `[MOTION_SCALE_MIN, MOTION_SCALE_MAX]`;
 *   - `rotate` stays within `MOTION_ROTATE_MAX_DEG`.
 *
 * The static gate is DECLARATIVE (belt-and-braces): the injected stylesheet
 * removes the animation property under `@media (prefers-reduced-motion: reduce)`
 * AND under `[data-motion="static"]`. JS only stamps `data-motion` and drives
 * the (display-only) caption — the visual suppression is pure CSS, so a live OS
 * preference flip applies with no re-render of the paint.
 *
 * `resolveBackgroundMotion` is a PURE product-unit gate (no `matchMedia`) so the
 * reduced-motion contract is exhaustively unit-testable on both legs; the live
 * `matchMedia` flip cannot be driven on this host (G-050/#2870).
 */

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

import type {
  BackgroundLayerMotion,
  BackgroundMotionKind,
} from './backgroundRegistry';

/** At most three simultaneously animated layers per recipe. */
export const MOTION_LAYERS_MAX = 3;
/** No opacity/transform cycle shorter than 8 s (≈0.125 Hz — far below the
 *  three-flashes-per-second WCAG 2.3.1 threshold). */
export const MOTION_DURATION_MIN_MS = 8000;
/** A layer's opacity never drops below this — never a blank-out. */
export const MOTION_OPACITY_MIN = 0.35;
/** A layer's opacity delta across the whole cycle is never larger than this. */
export const MOTION_OPACITY_SWING_MAX = 0.25;
/** The largest `|translate|` a layer may travel, as a % of its own box. */
export const MOTION_TRANSLATE_MAX_PCT = 3;
/** The smallest / largest `scale` a layer may reach. */
export const MOTION_SCALE_MIN = 0.94;
export const MOTION_SCALE_MAX = 1.1;
/** The largest `|rotate|` (degrees) a layer may reach. */
export const MOTION_ROTATE_MAX_DEG = 2;

/** Speed classes (UI/UX §2 identity table). Plain numeric literals — timings
 *  are not colours and are allowed in the registry/motion layer. */
export const MOTION_DRIFT_SLOW_MIN_MS = 90000;
export const MOTION_DRIFT_MEDIUM_MIN_MS = 45000;
export const MOTION_BREATHE_MIN_MS = 18000;
export const MOTION_TWINKLE_MIN_MS = 8000;

/** The class the injected stylesheet (and the declarative static gates) target. */
export const MOTION_LAYER_CLASS = 'fredo-bg-layer';

/** One `@keyframes` kind's paint budget. `isBoundedMotion` validates a motion
 *  against its kind's spec (overridable so violations are unit-testable). */
export interface BackgroundMotionKeyframes {
  /** Minimum opacity the cycle reaches (>= `MOTION_OPACITY_MIN`). */
  opacityMin: number;
  /** Maximum opacity the cycle reaches (<= 1). */
  opacityMax: number;
  /** Smallest scale reached (>= `MOTION_SCALE_MIN`). */
  scaleMin: number;
  /** Largest scale reached (<= `MOTION_SCALE_MAX`). */
  scaleMax: number;
  /** Largest `|translate|` as a % of the layer box (<= `MOTION_TRANSLATE_MAX_PCT`). */
  translatePct: number;
  /** Largest `|rotate|` in degrees (<= `MOTION_ROTATE_MAX_DEG`). */
  rotateDeg: number;
}

/** Every motion kind, in the order the keyframe blocks are emitted. */
export const BACKGROUND_MOTION_KINDS: readonly BackgroundMotionKind[] = [
  'drift',
  'breathe',
  'pulse',
  'twinkle',
  'sweep',
  'rotate',
];

/**
 * The per-kind keyframe budget. These MUST stay within the hard bounds above —
 * the keyframe CSS below is authored to match, and `isBoundedMotion` is the
 * guard that keeps a future edit honest.
 */
export const MOTION_KEYFRAME_SPECS: Readonly<
  Record<BackgroundMotionKind, BackgroundMotionKeyframes>
> = {
  // Pure lateral/parallax travel — opacity is constant (never a flicker).
  drift: { opacityMin: 1, opacityMax: 1, scaleMin: 1, scaleMax: 1, translatePct: 3, rotateDeg: 0 },
  // Slow radial scale + gentle opacity swell.
  breathe: { opacityMin: 0.85, opacityMax: 0.95, scaleMin: 0.96, scaleMax: 1.06, translatePct: 0, rotateDeg: 0 },
  // Small, calm scale + opacity pulse.
  pulse: { opacityMin: 0.88, opacityMax: 0.94, scaleMin: 0.98, scaleMax: 1.04, translatePct: 0, rotateDeg: 0 },
  // Opacity only, phase-varied (constellation's signature).
  twinkle: { opacityMin: 0.4, opacityMax: 0.65, scaleMin: 1, scaleMax: 1, translatePct: 0, rotateDeg: 0 },
  // Directional travel of a line/contour layer — ZERO opacity change.
  sweep: { opacityMin: 1, opacityMax: 1, scaleMin: 1, scaleMax: 1, translatePct: 3, rotateDeg: 0 },
  // Slow rotation (transform only) + a whisper of opacity.
  rotate: { opacityMin: 0.9, opacityMax: 0.95, scaleMin: 1, scaleMax: 1, translatePct: 0, rotateDeg: 1 },
};

/**
 * The ONE injected stylesheet: one `@keyframes` block per kind
 * (`transform`/`opacity` ONLY) plus the two declarative static gates. It is
 * emitted only while the backdrop is animated (`data-motion="animated"`) — the
 * static leg renders zero motion CSS and zero inline animation properties.
 */
export const BACKGROUND_MOTION_CSS = `
@keyframes fredo-bg-drift {
  0% { transform: translate3d(-3%, 1.5%, 0); }
  50% { transform: translate3d(3%, -1.5%, 0); }
  100% { transform: translate3d(-3%, 1.5%, 0); }
}
@keyframes fredo-bg-breathe {
  0%, 100% { opacity: 0.85; transform: scale(0.96); }
  50% { opacity: 0.95; transform: scale(1.06); }
}
@keyframes fredo-bg-pulse {
  0%, 100% { opacity: 0.88; transform: scale(0.98); }
  50% { opacity: 0.94; transform: scale(1.04); }
}
@keyframes fredo-bg-twinkle {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.65; }
}
@keyframes fredo-bg-sweep {
  0% { transform: translate3d(-3%, 3%, 0); }
  50% { transform: translate3d(3%, -3%, 0); }
  100% { transform: translate3d(-3%, 3%, 0); }
}
@keyframes fredo-bg-rotate {
  0%, 100% { opacity: 0.9; transform: rotate(-1deg); }
  50% { opacity: 0.95; transform: rotate(1deg); }
}
.${MOTION_LAYER_CLASS} {
  will-change: transform, opacity;
}
@media (prefers-reduced-motion: reduce) {
  .${MOTION_LAYER_CLASS} { animation: none !important; }
}
[data-motion="static"] .${MOTION_LAYER_CLASS} {
  animation: none !important;
}
`.trim();

const MOTION_KIND_SET: ReadonlySet<string> = new Set(BACKGROUND_MOTION_KINDS);

const MOTION_EASINGS: ReadonlySet<string> = new Set(['linear', 'ease-in-out']);
const MOTION_DIRECTIONS: ReadonlySet<string> = new Set(['normal', 'alternate', 'reverse']);

/**
 * PURE bound validator (R-3.2/R-4.3). `spec` defaults to the motion's own kind
 * budget; passing an override lets a unit test prove a violation is rejected.
 */
export function isBoundedMotion(
  motion: BackgroundLayerMotion,
  spec?: BackgroundMotionKeyframes,
): boolean {
  if (!MOTION_KIND_SET.has(motion.kind)) return false;
  if (!Number.isFinite(motion.durationMs) || motion.durationMs < MOTION_DURATION_MIN_MS) return false;
  if (!Number.isFinite(motion.delayMs) || motion.delayMs < 0 || motion.delayMs >= motion.durationMs) {
    return false;
  }
  if (!MOTION_EASINGS.has(motion.easing)) return false; // rejects steps(...)
  if (motion.direction !== undefined && !MOTION_DIRECTIONS.has(motion.direction)) return false;

  const bounds = spec ?? MOTION_KEYFRAME_SPECS[motion.kind];
  if (bounds.opacityMin < MOTION_OPACITY_MIN) return false;
  if (bounds.opacityMax > 1) return false;
  if (bounds.opacityMax - bounds.opacityMin > MOTION_OPACITY_SWING_MAX) return false;
  if (bounds.scaleMin < MOTION_SCALE_MIN) return false;
  if (bounds.scaleMax > MOTION_SCALE_MAX) return false;
  if (Math.abs(bounds.translatePct) > MOTION_TRANSLATE_MAX_PCT) return false;
  if (Math.abs(bounds.rotateDeg) > MOTION_ROTATE_MAX_DEG) return false;
  // topography's sweep must NOT oscillate opacity at all.
  if (motion.kind === 'sweep' && bounds.opacityMin !== bounds.opacityMax) return false;

  return true;
}

/** The inline animation properties for one bounded layer (animated leg only). */
export function layerAnimationStyle(motion: BackgroundLayerMotion): CSSProperties {
  return {
    animationName: `fredo-bg-${motion.kind}`,
    animationDuration: `${motion.durationMs}ms`,
    animationDelay: `${motion.delayMs}ms`,
    animationTimingFunction: motion.easing,
    animationIterationCount: 'infinite',
    animationDirection: motion.direction ?? 'normal',
    animationFillMode: 'both',
  };
}

/** The resolved motion status the paint gates on. */
export type BackgroundMotionStatus = 'animated' | 'static';

/**
 * PURE product-unit gate (no `matchMedia`): `animated` iff the OS preference is
 * NOT reduce. There is no in-app toggle (UI/UX §1) — the OS preference is the
 * only motion off switch; `none` disables the backdrop dimension entirely.
 */
export function resolveBackgroundMotion(input: {
  systemReducedMotion: boolean;
}): BackgroundMotionStatus {
  return input.systemReducedMotion ? 'static' : 'animated';
}

/** Fail-safe read of the OS reduced-motion preference (no `matchMedia` → not reduced). */
function readSystemReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * React binding — the resolved motion status, re-resolved LIVE when the OS
 * reduced-motion preference flips (`matchMedia` `change` subscription with
 * cleanup). Drives only the `data-motion` stamp and the display caption; the
 * visual suppression itself is the declarative CSS above.
 */
export function useBackgroundMotion(): BackgroundMotionStatus {
  const [systemReducedMotion, setSystemReducedMotion] = useState(readSystemReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent): void => {
      setSystemReducedMotion(event.matches);
    };
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    // Older WebView2 fallback (deprecated MediaQueryList API).
    mediaQuery.addListener?.(handleChange);
    return () => mediaQuery.removeListener?.(handleChange);
  }, []);

  return resolveBackgroundMotion({ systemReducedMotion });
}
