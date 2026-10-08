/**
 * backgroundMotion — the ONE module that owns the desktop-background motion
 * CONTRACT (Spec #2905 ST-2 / ST-3; per-layer envelopes + generated keyframes +
 * overscan in Spec #2909 ST-1).
 *
 * This module is the source of truth for the motion TYPES
 * (`BackgroundMotionKind` / `BackgroundLayerMotion` / `MotionEnvelope`) — the
 * registry imports them (type-only, no runtime cycle). It is also the ONLY
 * module allowed to author `@keyframes`.
 *
 * Motion is declarative CSS `@keyframes` applied to already-painted gradient
 * layers. It animates `transform` and `opacity` ONLY — never a colour property,
 * never `background-position`/`background-size` (those repaint every frame), and
 * never a JS frame loop (no `requestAnimationFrame`, no `setInterval`).
 *
 * Amplitude is now a PER-LAYER envelope (`translateXPct` / `translateYPct` /
 * `opacity` / `scale` / `rotateDeg`) instead of a fixed per-kind table, and one
 * `@keyframes` block is generated PER ANIMATED LAYER ID (`fredo-bg-<layerId>`)
 * so two layers of the same kind can carry different amplitudes. Every motion is
 * bounded by the constants below so it can never strobe or blank out:
 *
 *   - no cycle shorter than `MOTION_DURATION_MIN_MS` (8 s);
 *   - layer opacity stays within `[MOTION_OPACITY_MIN, 1]` and swings at most
 *     `MOTION_OPACITY_SWING_MAX`;
 *   - every `translate` endpoint is within `MOTION_TRANSLATE_MAX_PCT` of the
 *     layer box;
 *   - `scale` stays within `[MOTION_SCALE_MIN, MOTION_SCALE_MAX]`;
 *   - `rotate` stays within `MOTION_ROTATE_MAX_DEG`;
 *   - every motion declares at least one non-zero amplitude envelope.
 *
 * A layer that carries `motion` is OVERSIZED by `MOTION_LAYER_OVERSCAN_PCT` per
 * edge via the shared `layerBoxStyle` helper (G-169) so translate/scale/rotate
 * never expose an edge. The required overscan is a pure function of the composed
 * envelope (`requiredOverscanPct`) and `overscanCovers` asserts it fits.
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

/** The bounded motion vocabulary. `rotate`/`pulse` are retained for compatible
 *  recipes even though the six shipped recipes do not all use them. */
export type BackgroundMotionKind =
  | 'drift' // lateral translate (translate3d)
  | 'breathe' // scale + gentle opacity swell
  | 'pulse' // small scale + small opacity
  | 'twinkle' // opacity only, phase-varied
  | 'sweep' // directional translate of a line/contour layer
  | 'rotate'; // slow rotate (transform only)

/** An envelope pair: the keyframe emits `from` at 0%/100% and `to` at 50%. */
export interface MotionEnvelope {
  from: number;
  to: number;
}

/**
 * The bounded motion declaration for ONE animated layer. Amplitude is
 * PER-LAYER (`translateXPct`/`translateYPct`/`opacity`/`scale`/`rotateDeg`), so
 * two layers of the same `kind` can move by different amounts.
 */
export interface BackgroundLayerMotion {
  kind: BackgroundMotionKind;
  /** >= MOTION_DURATION_MIN_MS (8000). */
  durationMs: number;
  /** 0 <= delayMs < durationMs (phase offset). */
  delayMs: number;
  /** Never `steps()` — no visible restart seam / strobe. */
  easing: 'linear' | 'ease-in-out';
  direction?: 'normal' | 'alternate' | 'reverse';
  /** translate as a % of the LAYER box (0 = no x travel). */
  translateXPct?: MotionEnvelope;
  translateYPct?: MotionEnvelope;
  /** Both endpoints within [MOTION_OPACITY_MIN, 1]. */
  opacity?: MotionEnvelope;
  /** Both endpoints within [MOTION_SCALE_MIN, MOTION_SCALE_MAX]. */
  scale?: MotionEnvelope;
  /** Symmetrical -d..+d (|d| <= MOTION_ROTATE_MAX_DEG). */
  rotateDeg?: number;
}

/** At most three simultaneously animated layers per recipe. */
export const MOTION_LAYERS_MAX = 3;
/** No opacity/transform cycle shorter than 8 s (≈0.125 Hz — far below the
 *  three-flashes-per-second WCAG 2.3.1 threshold). */
export const MOTION_DURATION_MIN_MS = 8000;
/** A layer's opacity never drops below this — never a blank-out. */
export const MOTION_OPACITY_MIN = 0.35;
/** A layer's opacity delta across the whole cycle is never larger than this. */
export const MOTION_OPACITY_SWING_MAX = 0.45;
/** The largest `|translate|` a layer may travel, as a % of its own box. */
export const MOTION_TRANSLATE_MAX_PCT = 12;
/** The smallest / largest `scale` a layer may reach. */
export const MOTION_SCALE_MIN = 0.85;
export const MOTION_SCALE_MAX = 1.2;
/** The largest `|rotate|` (degrees) a layer may reach. */
export const MOTION_ROTATE_MAX_DEG = 4;
/**
 * The automatic overscan (viewport % per edge) applied to EVERY layer carrying
 * motion — so travel/scale/rotate never exposes a hard edge (G-169). The shared
 * `layerBoxStyle` helper is the single source of the geometry, used by the
 * backdrop AND the chooser thumbnails so the preview cannot drift.
 */
export const MOTION_LAYER_OVERSCAN_PCT = 30;

/** The class the injected stylesheet (and the declarative static gates) target. */
export const MOTION_LAYER_CLASS = 'fredo-bg-layer';

/** Every motion kind, in the order the kind vocabulary is declared. */
export const BACKGROUND_MOTION_KINDS: readonly BackgroundMotionKind[] = [
  'drift',
  'breathe',
  'pulse',
  'twinkle',
  'sweep',
  'rotate',
];

const MOTION_KIND_SET: ReadonlySet<string> = new Set(BACKGROUND_MOTION_KINDS);
const MOTION_EASINGS: ReadonlySet<string> = new Set(['linear', 'ease-in-out']);
const MOTION_DIRECTIONS: ReadonlySet<string> = new Set(['normal', 'alternate', 'reverse']);

/**
 * The layer-box factor implied by the maximum overscan: the layer spans
 * `100 + 2*overscan` % of the viewport, so one layer-box percent is
 * `K = 1 + 2*overscan/100` viewport percent. Used to translate envelopes
 * (expressed in layer-box %) into the viewport-relative overscan they need.
 */
const MOTION_LAYER_BOX_FACTOR = 1 + (2 * MOTION_LAYER_OVERSCAN_PCT) / 100;

/** A minimal layer shape the motion helpers accept (structurally `BackgroundLayer`). */
export interface MotionLayerLike {
  id: string;
  motion?: BackgroundLayerMotion;
}

function envelopeIsFinite(envelope: MotionEnvelope): boolean {
  return Number.isFinite(envelope.from) && Number.isFinite(envelope.to);
}

function envelopeWithin(envelope: MotionEnvelope, min: number, max: number): boolean {
  return envelope.from >= min && envelope.from <= max && envelope.to >= min && envelope.to <= max;
}

function envelopeMoves(envelope: MotionEnvelope | undefined): boolean {
  return (
    envelope !== undefined &&
    Number.isFinite(envelope.from) &&
    Number.isFinite(envelope.to) &&
    envelope.from !== envelope.to
  );
}

/** At least one declared envelope must actually move (NF-1: no no-op motion). */
function hasNonZeroAmplitude(motion: BackgroundLayerMotion): boolean {
  return (
    envelopeMoves(motion.translateXPct) ||
    envelopeMoves(motion.translateYPct) ||
    envelopeMoves(motion.opacity) ||
    envelopeMoves(motion.scale) ||
    (motion.rotateDeg !== undefined && Number.isFinite(motion.rotateDeg) && motion.rotateDeg !== 0)
  );
}

/**
 * PURE bound validator. A motion is bounded when every declared envelope stays
 * inside the hard caps and it declares at least one non-zero amplitude (NF-1).
 */
export function isBoundedMotion(motion: BackgroundLayerMotion): boolean {
  if (!MOTION_KIND_SET.has(motion.kind)) return false;
  if (!Number.isFinite(motion.durationMs) || motion.durationMs < MOTION_DURATION_MIN_MS) return false;
  if (!Number.isFinite(motion.delayMs) || motion.delayMs < 0 || motion.delayMs >= motion.durationMs) {
    return false;
  }
  if (!MOTION_EASINGS.has(motion.easing)) return false; // rejects steps(...)
  if (motion.direction !== undefined && !MOTION_DIRECTIONS.has(motion.direction)) return false;

  const translate = [motion.translateXPct, motion.translateYPct];
  for (const envelope of translate) {
    if (envelope === undefined) continue;
    if (!envelopeIsFinite(envelope)) return false;
    if (Math.abs(envelope.from) > MOTION_TRANSLATE_MAX_PCT) return false;
    if (Math.abs(envelope.to) > MOTION_TRANSLATE_MAX_PCT) return false;
  }

  if (motion.opacity !== undefined) {
    if (!envelopeIsFinite(motion.opacity)) return false;
    if (!envelopeWithin(motion.opacity, MOTION_OPACITY_MIN, 1)) return false;
    // Epsilon: `0.8 - 0.35` is `0.45000000000000007` in IEEE-754, so an
    // envelope exactly AT the cap must still pass.
    if (Math.abs(motion.opacity.to - motion.opacity.from) > MOTION_OPACITY_SWING_MAX + 1e-9) {
      return false;
    }
  }

  if (motion.scale !== undefined) {
    if (!envelopeIsFinite(motion.scale)) return false;
    if (!envelopeWithin(motion.scale, MOTION_SCALE_MIN, MOTION_SCALE_MAX)) return false;
  }

  if (motion.rotateDeg !== undefined) {
    if (!Number.isFinite(motion.rotateDeg)) return false;
    if (Math.abs(motion.rotateDeg) > MOTION_ROTATE_MAX_DEG) return false;
  }

  return hasNonZeroAmplitude(motion);
}

/**
 * The overscan (viewport % per edge) a motion's COMPOSED envelope requires
 * (G-169): the largest translate × the layer-box factor, plus the scale shrink
 * (`0.5·(1−scaleMin)`), plus the rotate corner slack (`0.5·sin θ`), all scaled
 * by the layer-box factor. Pure, and unit-pinned.
 */
export function requiredOverscanPct(motion: BackgroundLayerMotion): number {
  const translate = Math.max(
    Math.abs(motion.translateXPct?.from ?? 0),
    Math.abs(motion.translateXPct?.to ?? 0),
    Math.abs(motion.translateYPct?.from ?? 0),
    Math.abs(motion.translateYPct?.to ?? 0),
  );
  const scaleMin = motion.scale ? Math.min(motion.scale.from, motion.scale.to) : 1;
  const rotateDeg = Math.abs(motion.rotateDeg ?? 0);
  const rotateSlack = 0.5 * Math.sin((rotateDeg * Math.PI) / 180);
  const scaleSlack = 0.5 * (1 - scaleMin);
  return (translate + scaleSlack + rotateSlack) * MOTION_LAYER_BOX_FACTOR;
}

/** True when the automatic overscan covers the motion's required envelope. */
export function overscanCovers(motion: BackgroundLayerMotion): boolean {
  return requiredOverscanPct(motion) <= MOTION_LAYER_OVERSCAN_PCT;
}

/** Compose the transform functions for a `from`/`to` keyframe stop. */
function transformFor(motion: BackgroundLayerMotion, stop: 'from' | 'to'): string | undefined {
  const parts: string[] = [];
  if (motion.translateXPct || motion.translateYPct) {
    const x = (stop === 'from' ? motion.translateXPct?.from : motion.translateXPct?.to) ?? 0;
    const y = (stop === 'from' ? motion.translateYPct?.from : motion.translateYPct?.to) ?? 0;
    parts.push(`translate3d(${x}%, ${y}%, 0)`);
  }
  if (motion.scale) {
    parts.push(`scale(${stop === 'from' ? motion.scale.from : motion.scale.to})`);
  }
  if (motion.rotateDeg !== undefined) {
    parts.push(`rotate(${stop === 'from' ? -motion.rotateDeg : motion.rotateDeg}deg)`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** The declarations emitted at one keyframe stop (transform/opacity ONLY). */
function declarationFor(motion: BackgroundLayerMotion, stop: 'from' | 'to'): string {
  const declarations: string[] = [];
  if (motion.opacity) {
    declarations.push(`opacity: ${stop === 'from' ? motion.opacity.from : motion.opacity.to};`);
  }
  const transform = transformFor(motion, stop);
  if (transform) declarations.push(`transform: ${transform};`);
  return declarations.join(' ');
}

/** One generated `@keyframes` block for one animated layer. */
function keyframesBlockFor(layer: MotionLayerLike & { motion: BackgroundLayerMotion }): string {
  const from = declarationFor(layer.motion, 'from');
  const to = declarationFor(layer.motion, 'to');
  return [
    `@keyframes fredo-bg-${layer.id} {`,
    `  0%, 100% { ${from} }`,
    `  50% { ${to} }`,
    `}`,
  ].join('\n');
}

/**
 * The declarative gates shared by every generated stylesheet (the shared layer
 * class + the two static gates). Keyframe blocks are per descriptor.
 */
export const MOTION_GATES_CSS = [
  `.${MOTION_LAYER_CLASS} {`,
  `  will-change: transform, opacity;`,
  `}`,
  `@media (prefers-reduced-motion: reduce) {`,
  `  .${MOTION_LAYER_CLASS} { animation: none !important; }`,
  `}`,
  `[data-motion="static"] .${MOTION_LAYER_CLASS} {`,
  `  animation: none !important;`,
  `}`,
].join('\n');

/**
 * The ONE injected stylesheet for the ACTIVE descriptor: one `@keyframes` block
 * per animated layer id (`fredo-bg-<layerId>`, 0%/100% `from`, 50% `to`,
 * transform/opacity ONLY) plus the declarative static gates. Static layers get
 * no block. Emitted only while the backdrop is animated — the static leg renders
 * zero motion CSS and zero inline animation properties.
 */
export function buildBackgroundMotionCss(layers: readonly MotionLayerLike[]): string {
  const blocks = layers
    .filter(
      (layer): layer is MotionLayerLike & { motion: BackgroundLayerMotion } =>
        layer.motion !== undefined,
    )
    .map(keyframesBlockFor);
  return [...blocks, MOTION_GATES_CSS].join('\n');
}

/** The inline animation properties for one bounded layer (animated leg only). */
export function layerAnimationStyle(layer: {
  id: string;
  motion: BackgroundLayerMotion;
}): CSSProperties {
  const { motion } = layer;
  return {
    animationName: `fredo-bg-${layer.id}`,
    animationDuration: `${motion.durationMs}ms`,
    animationDelay: `${motion.delayMs}ms`,
    animationTimingFunction: motion.easing,
    animationIterationCount: 'infinite',
    animationDirection: motion.direction ?? 'normal',
    animationFillMode: 'both',
  };
}

/**
 * ONE shared layer-box geometry (UX-3): the backdrop AND the chooser thumbnails
 * call this, so the static preview cannot drift from the composition. A layer
 * carrying motion is oversized by `MOTION_LAYER_OVERSCAN_PCT` per edge (G-169);
 * a static layer stays at `inset: 0`. Returns `{ inset }` as CSS unit strings
 * (Chakra numeric props are SPACE TOKENS — references.md:24).
 */
export function layerBoxStyle(layer: { motion?: BackgroundLayerMotion }): CSSProperties {
  if (!layer.motion) return { inset: '0' };
  return { inset: `-${MOTION_LAYER_OVERSCAN_PCT}%` };
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
