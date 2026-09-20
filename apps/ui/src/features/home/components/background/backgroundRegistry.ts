/**
 * Background registry — the closed set of desktop-background descriptors
 * (Spec #2899 ST-1; reshaped to layered descriptors in Spec #2905 ST-2).
 *
 * Every descriptor carries:
 *   - `css` — the GROUND fill: an opaque, theme-derived surface (`var(--…)`);
 *   - `layers` — the ordered paint stack (bottom → top). Each layer is one or
 *     more stacked token-only gradients plus optional bounded motion metadata.
 *     The renderer adds `position: absolute` and the shared `layerBoxStyle`
 *     geometry (overscan for animated layers); the registry owns paint + motion.
 *
 * Every colour is a PURE function of live theme CSS custom properties: no colour
 * literal, no raster asset, no `url()`/`data:` URI. Translucency is produced
 * exclusively through the shared `tint()` helper
 * (`color-mix(in srgb, var(--…) N%, transparent)`), which resolves at paint time
 * — so a theme/accent switch recolours every recipe with zero JS and no restart
 * (AC2). Motion metadata is declarative and bounded (see `backgroundMotion.ts`);
 * this module contains no CSS `@keyframes` and no animation shorthand.
 *
 * `none` reuses the shell's shipped desktop texture verbatim, moved here so the
 * grid has ONE definition shared by the launcher surface and the registry; its
 * `css` is UNCHANGED and it carries `layers: []`.
 *
 * `getBackgroundDescriptor` is LENIENT: any unknown, stale, malformed, or
 * removed id normalizes to `NONE_BACKGROUND` and never throws (AC3).
 */

import type { CSSProperties } from 'react';
import { tint } from '../../../../shared/utils/colorTint';
import type { BackgroundLayerMotion } from './backgroundMotion';

/** The closed background id set: `none` (default) + six procedural recipes. */
export type BackgroundId =
  | 'none'
  | 'aurora'
  | 'nebula'
  | 'mesh'
  | 'topography'
  | 'constellation'
  | 'halo';

/** ONE paint layer. The renderer adds `position: absolute` and the shared
 *  `layerBoxStyle` geometry (`inset`). */
export interface BackgroundLayer {
  /** Drives `data-background-layer` — unique within a descriptor. */
  id: string;
  /** Exactly ONE gradient/fill, token-only. */
  css: CSSProperties;
  /** Absent → a static layer (never animated). */
  motion?: BackgroundLayerMotion;
}

/** A named background: an opaque ground plus its ordered paint layers. */
export interface BackgroundDescriptor {
  id: BackgroundId;
  label: string;
  /** The GROUND fill. `NONE_BACKGROUND` keeps the shipped texture verbatim. */
  css: CSSProperties;
  /** Paint order (bottom → top). `none`: `[]`. */
  layers: readonly BackgroundLayer[];
}

/**
 * The shell's shipped desktop texture (Asset 1.7) — moved VERBATIM from
 * `LauncherShell.tsx` so it has exactly one definition. Faint border-color
 * color-mix lines behind every window. Carries no layers (byte-identical to
 * pre-#2905 — ST-4).
 */
export const NONE_BACKGROUND: BackgroundDescriptor = {
  id: 'none',
  label: 'None',
  css: {
    backgroundColor: 'var(--card-bg)',
    backgroundImage: [
      `linear-gradient(to right, ${tint('var(--border-color)', 12)} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${tint('var(--border-color)', 12)} 1px, transparent 1px)`,
    ].join(', '),
    backgroundSize: '28px 28px',
  },
  layers: [],
};

/** Two accent curtains that drift AGAINST each other (counter-drift). */
const AURORA_BACKGROUND: BackgroundDescriptor = {
  id: 'aurora',
  label: 'Aurora',
  css: { backgroundColor: 'var(--body-bg)' },
  layers: [
    {
      id: 'aurora-curtain-west',
      css: {
        backgroundImage: `radial-gradient(120% 90% at 15% 0%, ${tint('var(--accent-primary)', 26)}, transparent 60%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 45000,
        delayMs: 0,
        easing: 'ease-in-out',
        direction: 'normal',
        translateXPct: { from: -3, to: 3 },
        translateYPct: { from: 1.5, to: -1.5 },
      },
    },
    {
      id: 'aurora-curtain-east',
      css: {
        backgroundImage: `radial-gradient(120% 90% at 85% 20%, ${tint('var(--accent-secondary)', 22)}, transparent 60%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 68000,
        delayMs: 6000,
        easing: 'ease-in-out',
        direction: 'reverse',
        translateXPct: { from: -3, to: 3 },
        translateYPct: { from: 1.5, to: -1.5 },
      },
    },
  ],
};

/** A diffuse breathing cloud + a counter-rotating bloom, anchored by static grain. */
const NEBULA_BACKGROUND: BackgroundDescriptor = {
  id: 'nebula',
  label: 'Nebula',
  css: { backgroundColor: 'var(--card-bg)' },
  layers: [
    {
      id: 'nebula-bloom',
      css: {
        backgroundImage: `radial-gradient(90% 70% at 70% 15%, ${tint('var(--accent-primary)', 20)}, transparent 65%)`,
      },
      motion: {
        kind: 'breathe',
        durationMs: 110000,
        delayMs: 0,
        easing: 'ease-in-out',
        opacity: { from: 0.85, to: 0.95 },
        scale: { from: 0.96, to: 1.06 },
      },
    },
    {
      id: 'nebula-counter-bloom',
      css: {
        backgroundImage: `radial-gradient(90% 70% at 20% 80%, ${tint('var(--accent-secondary)', 16)}, transparent 65%)`,
      },
      motion: {
        kind: 'rotate',
        durationMs: 110000,
        delayMs: 0,
        easing: 'linear',
        opacity: { from: 0.9, to: 0.95 },
        rotateDeg: 1,
      },
    },
    {
      // The non-moving texture anchor — NO motion on purpose.
      id: 'nebula-grain',
      css: {
        backgroundImage: `radial-gradient(${tint('var(--text-primary)', 8)} 1px, transparent 1px)`,
        backgroundSize: '22px 22px',
      },
    },
  ],
};

/** Three tint nodes drifting on phase-staggered diagonal paths (parallax). */
const MESH_BACKGROUND: BackgroundDescriptor = {
  id: 'mesh',
  label: 'Mesh',
  css: { backgroundColor: 'var(--body-bg)' },
  layers: [
    {
      id: 'mesh-node-primary',
      css: {
        backgroundImage: `radial-gradient(80% 80% at 15% 10%, ${tint('var(--accent-primary)', 18)}, transparent 60%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 48000,
        delayMs: 0,
        easing: 'ease-in-out',
        translateXPct: { from: -3, to: 3 },
        translateYPct: { from: 1.5, to: -1.5 },
      },
    },
    {
      id: 'mesh-node-secondary',
      css: {
        backgroundImage: `radial-gradient(80% 80% at 85% 15%, ${tint('var(--accent-secondary)', 16)}, transparent 60%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 61000,
        delayMs: 12000,
        easing: 'ease-in-out',
        translateXPct: { from: -3, to: 3 },
        translateYPct: { from: 1.5, to: -1.5 },
      },
    },
    {
      id: 'mesh-node-info',
      css: {
        backgroundImage: `radial-gradient(80% 80% at 50% 100%, ${tint('var(--status-info)', 12)}, transparent 60%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 74000,
        delayMs: 24000,
        easing: 'ease-in-out',
        translateXPct: { from: -3, to: 3 },
        translateYPct: { from: 1.5, to: -1.5 },
      },
    },
  ],
};

/** Concentric accent contour rings that sweep directionally (no opacity change). */
const TOPOGRAPHY_BACKGROUND: BackgroundDescriptor = {
  id: 'topography',
  label: 'Topography',
  css: { backgroundColor: 'var(--card-bg)' },
  layers: [
    {
      id: 'topography-contours',
      css: {
        backgroundImage: `repeating-radial-gradient(circle at 30% 40%, transparent 0 22px, ${tint('var(--accent-primary)', 10)} 22px 23px)`,
      },
      motion: {
        kind: 'sweep',
        durationMs: 100000,
        delayMs: 0,
        easing: 'linear',
        translateXPct: { from: -3, to: 3 },
        translateYPct: { from: 3, to: -3 },
      },
    },
  ],
};

/** A drifting star field with two out-of-phase twinkle layers over a soft bloom. */
const CONSTELLATION_BACKGROUND: BackgroundDescriptor = {
  id: 'constellation',
  label: 'Constellation',
  css: { backgroundColor: 'var(--body-bg)' },
  layers: [
    {
      id: 'constellation-bloom',
      css: {
        backgroundImage: `radial-gradient(100% 80% at 50% 50%, ${tint('var(--accent-primary)', 10)}, transparent 60%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 120000,
        delayMs: 0,
        easing: 'linear',
        translateXPct: { from: -3, to: 3 },
        translateYPct: { from: 1.5, to: -1.5 },
      },
    },
    {
      id: 'constellation-stars-far',
      css: {
        backgroundImage: `radial-gradient(${tint('var(--text-primary)', 16)} 1.2px, transparent 1.2px)`,
        backgroundSize: '26px 26px',
      },
      motion: {
        kind: 'twinkle',
        durationMs: 11000,
        delayMs: 0,
        easing: 'ease-in-out',
        opacity: { from: 0.4, to: 0.65 },
      },
    },
    {
      id: 'constellation-stars-near',
      css: {
        backgroundImage: `radial-gradient(${tint('var(--text-primary)', 20)} 1.6px, transparent 1.6px)`,
        backgroundSize: '34px 34px',
      },
      motion: {
        kind: 'twinkle',
        durationMs: 8000,
        delayMs: 3500,
        easing: 'ease-in-out',
        opacity: { from: 0.4, to: 0.65 },
      },
    },
  ],
};

/** One soft accent halo breathing gently near the top (smallest amplitude). */
const HALO_BACKGROUND: BackgroundDescriptor = {
  id: 'halo',
  label: 'Halo',
  css: { backgroundColor: 'var(--card-bg)' },
  layers: [
    {
      id: 'halo-glow',
      css: {
        backgroundImage: `radial-gradient(120% 100% at 50% 18%, ${tint('var(--accent-primary)', 16)}, transparent 62%)`,
      },
      motion: {
        kind: 'breathe',
        durationMs: 18000,
        delayMs: 0,
        easing: 'ease-in-out',
        opacity: { from: 0.85, to: 0.95 },
        scale: { from: 0.96, to: 1.06 },
      },
    },
  ],
};

/** The six procedural recipes, in chooser order. `none` is intentionally
 *  separate (`NONE_BACKGROUND`) — it is the shipped texture, not a recipe. */
export const BACKGROUND_DESCRIPTORS: readonly BackgroundDescriptor[] = [
  AURORA_BACKGROUND,
  NEBULA_BACKGROUND,
  MESH_BACKGROUND,
  TOPOGRAPHY_BACKGROUND,
  CONSTELLATION_BACKGROUND,
  HALO_BACKGROUND,
];

/** Every valid id — `none` + the six procedural recipes. */
const BACKGROUND_IDS: readonly BackgroundId[] = [
  'none',
  'aurora',
  'nebula',
  'mesh',
  'topography',
  'constellation',
  'halo',
];

const BACKGROUND_ID_SET: ReadonlySet<string> = new Set(BACKGROUND_IDS);

/** True when `value` is a known, currently-shipped background id. */
export function isBackgroundId(value: string): value is BackgroundId {
  return BACKGROUND_ID_SET.has(value);
}

/**
 * Resolve a raw (possibly persisted or stale) background id to its descriptor.
 * LENIENT by contract: anything unknown, empty, malformed, or removed from the
 * set resolves to `NONE_BACKGROUND`; this function never throws (AC3).
 */
export function getBackgroundDescriptor(raw: string): BackgroundDescriptor {
  switch (raw) {
    case 'aurora':
      return AURORA_BACKGROUND;
    case 'nebula':
      return NEBULA_BACKGROUND;
    case 'mesh':
      return MESH_BACKGROUND;
    case 'topography':
      return TOPOGRAPHY_BACKGROUND;
    case 'constellation':
      return CONSTELLATION_BACKGROUND;
    case 'halo':
      return HALO_BACKGROUND;
    case 'none':
    default:
      return NONE_BACKGROUND;
  }
}
