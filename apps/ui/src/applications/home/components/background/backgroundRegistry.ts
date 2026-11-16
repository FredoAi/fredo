/**
 * Background registry — the closed set of desktop-background descriptors
 * (Spec #2899 ST-1; layered in Spec #2905 ST-2; identity + structured paint in
 * Spec #2909 ST-2).
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
 * (`color-mix(in srgb, var(--…) N%, transparent)` — layer tint alpha ≤45% over
 * an opaque token ground), which resolves at paint time — so a theme/accent
 * switch recolours every recipe with zero JS and no restart (AC5). Motion
 * metadata is declarative and bounded (see `backgroundMotion.ts`); this module
 * contains no CSS `@keyframes` and no animation shorthand.
 *
 * Motion identity (#2909 — Architect-bound identity table): each recipe carries
 * a structured, trackable paint (ribbon bands / banded cloud / dust / lattice
 * node cores / crossing contour lines / star dots / halo bands) and
 * incommensurate 9–40 s cycles so its motion reads as its own and can never
 * resync. Every recipe has ≥1 broad-edge PRIMARY driver meeting NF-2; dot /
 * texture layers are ancillary.
 *
 * The paint anchors are authored for the OVERSIZED layer box: a layer-percent
 * `p` maps to viewport `-30 + 1.6p` (%), i.e. `p = (viewport + 30) / 1.6`.
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

/** The closed background id set: `none` (default) + six procedural recipes +
 *  `life` (the engine-backed Conway's Game of Life surface, Spec #2915). */
export type BackgroundId =
  | 'none'
  | 'aurora'
  | 'nebula'
  | 'mesh'
  | 'topography'
  | 'constellation'
  | 'halo'
  | 'life';

/** Paint-engine discriminator: absent ⇒ the declarative CSS-recipe renderer. */
export type BackgroundRenderer = 'css' | 'life';

/** ONE paint layer. The renderer adds `position: absolute` and the shared
 *  `layerBoxStyle` geometry (`inset`). */
export interface BackgroundLayer {
  /** Drives `data-background-layer` — unique within a descriptor. */
  id: string;
  /** One or more stacked token-only gradients/fills. */
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
  /** Paint engine discriminator: absent ⇒ `'css'` (declarative recipe layers). */
  renderer?: BackgroundRenderer;
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

/**
 * Aurora — two wide diagonal ribbon curtains that sweep AGAINST each other
 * (counter-drift). The primary driver is the west ribbon (broad repeating band
 * edges + a soft radial wash), travelling ±7% of its box across a 26 s cycle.
 */
const AURORA_BACKGROUND: BackgroundDescriptor = {
  id: 'aurora',
  label: 'Aurora',
  css: { backgroundColor: 'var(--body-bg)' },
  layers: [
    {
      id: 'aurora-curtain-west',
      css: {
        backgroundImage: [
          // Broad repeating ribbon bands with a wide soft edge (trackable).
          `repeating-linear-gradient(115deg, ${tint('var(--accent-primary)', 40)} 0px, ${tint('var(--accent-primary)', 40)} 110px, transparent 260px)`,
          // Soft radial anchor so the curtain reads as a veil, not a stripe.
          `radial-gradient(90% 70% at 28% 19%, ${tint('var(--accent-primary)', 42)}, transparent 62%)`,
        ].join(', '),
      },
      motion: {
        kind: 'sweep',
        durationMs: 26000,
        delayMs: 0,
        easing: 'ease-in-out',
        direction: 'normal',
        translateXPct: { from: -7, to: 7 },
        translateYPct: { from: -4, to: 4 },
      },
    },
    {
      id: 'aurora-curtain-east',
      css: {
        backgroundImage: [
          `repeating-linear-gradient(-65deg, ${tint('var(--accent-secondary)', 36)} 0px, ${tint('var(--accent-secondary)', 36)} 150px, transparent 320px)`,
          `radial-gradient(95% 75% at 72% 31%, ${tint('var(--accent-secondary)', 40)}, transparent 64%)`,
        ].join(', '),
      },
      motion: {
        kind: 'sweep',
        durationMs: 34000,
        delayMs: 7000,
        easing: 'ease-in-out',
        direction: 'normal',
        translateXPct: { from: 6, to: -6 },
        translateYPct: { from: 4, to: -4 },
      },
    },
  ],
};

/**
 * Nebula — an in-place banded cloud that swells (breathe) over a static texture
 * anchor, with an ancillary dust twinkle. The primary driver is `nebula-cloud`
 * (scale 0.90→1.15 + opacity 0.70→1.0 across 24 s) whose band edges travel a
 * large fraction of the viewport in place.
 */
const NEBULA_BACKGROUND: BackgroundDescriptor = {
  id: 'nebula',
  label: 'Nebula',
  css: { backgroundColor: 'var(--card-bg)' },
  layers: [
    {
      id: 'nebula-cloud',
      css: {
        backgroundImage: [
          `radial-gradient(70% 55% at 62% 28%, ${tint('var(--accent-primary)', 42)}, transparent 58%)`,
          `radial-gradient(58% 44% at 34% 40%, ${tint('var(--accent-secondary)', 36)}, transparent 60%)`,
          `radial-gradient(82% 62% at 50% 56%, ${tint('var(--accent-primary)', 24)}, transparent 68%)`,
        ].join(', '),
      },
      motion: {
        kind: 'breathe',
        durationMs: 24000,
        delayMs: 0,
        easing: 'ease-in-out',
        direction: 'normal',
        scale: { from: 0.9, to: 1.15 },
        opacity: { from: 0.7, to: 1 },
      },
    },
    {
      id: 'nebula-dust',
      css: {
        // Ancillary phase texture: a fine dot grid that shimmers.
        backgroundImage: `radial-gradient(${tint('var(--accent-primary)', 42)} 1.6px, transparent 1.6px)`,
        backgroundSize: '20px 20px',
      },
      motion: {
        kind: 'twinkle',
        durationMs: 11000,
        delayMs: 0,
        easing: 'ease-in-out',
        direction: 'normal',
        opacity: { from: 0.35, to: 0.8 },
      },
    },
    {
      // The non-moving texture anchor — NO motion on purpose.
      id: 'nebula-grain',
      css: {
        backgroundImage: `radial-gradient(${tint('var(--text-primary)', 10)} 1px, transparent 1px)`,
        backgroundSize: '24px 24px',
      },
    },
  ],
};

/**
 * Mesh — three tinted node cores roaming on independent two-axis diagonals
 * (staggered phases). The primary driver is `mesh-node-primary` (core + lattice
 * lines) travelling ±6% on both axes across 21 s.
 */
const MESH_BACKGROUND: BackgroundDescriptor = {
  id: 'mesh',
  label: 'Mesh',
  css: { backgroundColor: 'var(--body-bg)' },
  layers: [
    {
      id: 'mesh-node-primary',
      css: {
        backgroundImage: [
          `radial-gradient(circle at 28% 25%, ${tint('var(--accent-primary)', 44)} 0 12%, transparent 24%)`,
          `repeating-linear-gradient(45deg, ${tint('var(--accent-primary)', 16)} 0px, ${tint('var(--accent-primary)', 16)} 1px, transparent 1px, transparent 72px)`,
          `repeating-linear-gradient(-45deg, ${tint('var(--accent-primary)', 16)} 0px, ${tint('var(--accent-primary)', 16)} 1px, transparent 1px, transparent 72px)`,
        ].join(', '),
      },
      motion: {
        kind: 'drift',
        durationMs: 21000,
        delayMs: 0,
        easing: 'ease-in-out',
        direction: 'normal',
        translateXPct: { from: -6, to: 6 },
        translateYPct: { from: -6, to: 6 },
      },
    },
    {
      id: 'mesh-node-secondary',
      css: {
        backgroundImage: `radial-gradient(circle at 72% 28%, ${tint('var(--accent-secondary)', 42)} 0 11%, transparent 23%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 29000,
        delayMs: 5000,
        easing: 'ease-in-out',
        direction: 'normal',
        translateXPct: { from: 6, to: -6 },
        translateYPct: { from: -5, to: 5 },
      },
    },
    {
      id: 'mesh-node-info',
      css: {
        backgroundImage: `radial-gradient(circle at 50% 81%, ${tint('var(--status-info)', 38)} 0 10%, transparent 22%)`,
      },
      motion: {
        kind: 'drift',
        durationMs: 37000,
        delayMs: 11000,
        easing: 'ease-in-out',
        direction: 'normal',
        translateXPct: { from: -5, to: 5 },
        translateYPct: { from: 5, to: -5 },
      },
    },
  ],
};

/**
 * Topography — two crossing contour line fields crawling in OPPOSITE directions
 * at constant velocity, on non-harmonic 23 px / 37 px pitches so the moire never
 * resyncs. Both layers are primary drivers (broad travelling line fields).
 */
const TOPOGRAPHY_BACKGROUND: BackgroundDescriptor = {
  id: 'topography',
  label: 'Topography',
  css: { backgroundColor: 'var(--card-bg)' },
  layers: [
    {
      id: 'topography-contours-a',
      css: {
        backgroundImage: `repeating-linear-gradient(55deg, transparent 0 22px, ${tint('var(--accent-primary)', 38)} 22px 23px)`,
      },
      motion: {
        kind: 'sweep',
        durationMs: 22000,
        delayMs: 0,
        easing: 'linear',
        direction: 'normal',
        translateXPct: { from: -7, to: 7 },
        translateYPct: { from: 0, to: 0 },
      },
    },
    {
      id: 'topography-contours-b',
      css: {
        // Non-harmonic pitch (23 px vs 37 px) and opposite direction.
        backgroundImage: `repeating-linear-gradient(125deg, transparent 0 36px, ${tint('var(--accent-primary)', 30)} 36px 37px)`,
      },
      motion: {
        kind: 'sweep',
        durationMs: 31000,
        delayMs: 4000,
        easing: 'linear',
        direction: 'normal',
        translateXPct: { from: 7, to: -7 },
        translateYPct: { from: 0, to: 0 },
      },
    },
  ],
};

/**
 * Constellation — a drifting banded glow over two asynchronous star twinkles.
 * The primary driver is `constellation-bloom` (banded glow) drifting on both
 * axes across 28 s; the dot fields sparkle out of phase.
 */
const CONSTELLATION_BACKGROUND: BackgroundDescriptor = {
  id: 'constellation',
  label: 'Constellation',
  css: { backgroundColor: 'var(--body-bg)' },
  layers: [
    {
      id: 'constellation-bloom',
      css: {
        backgroundImage: [
          `radial-gradient(60% 50% at 50% 50%, ${tint('var(--accent-primary)', 38)}, transparent 30%)`,
          `radial-gradient(76% 62% at 50% 50%, transparent 22%, ${tint('var(--accent-primary)', 28)} 30%, transparent 42%)`,
          `radial-gradient(96% 80% at 50% 50%, transparent 34%, ${tint('var(--accent-primary)', 18)} 44%, transparent 60%)`,
        ].join(', '),
      },
      motion: {
        kind: 'drift',
        durationMs: 28000,
        delayMs: 0,
        easing: 'linear',
        direction: 'normal',
        translateXPct: { from: -5, to: 5 },
        translateYPct: { from: 3, to: -3 },
      },
    },
    {
      id: 'constellation-stars-far',
      css: {
        backgroundImage: `radial-gradient(${tint('var(--text-primary)', 40)} 1.4px, transparent 1.4px)`,
        backgroundSize: '26px 26px',
      },
      motion: {
        kind: 'twinkle',
        durationMs: 9000,
        delayMs: 0,
        easing: 'ease-in-out',
        direction: 'normal',
        opacity: { from: 0.35, to: 0.8 },
      },
    },
    {
      id: 'constellation-stars-near',
      css: {
        backgroundImage: `radial-gradient(${tint('var(--text-primary)', 44)} 1.8px, transparent 1.8px)`,
        backgroundSize: '34px 34px',
      },
      motion: {
        kind: 'twinkle',
        durationMs: 13000,
        delayMs: 3000,
        easing: 'ease-in-out',
        direction: 'normal',
        opacity: { from: 0.35, to: 0.8 },
      },
    },
  ],
};

/**
 * Halo — one large concentric-band glow that breathes in place around a bright
 * core near the top (concentric halo bands + radial wash). The primary driver is
 * the scale swell 0.92→1.15 + opacity 0.70→1.0 across a 16 s cycle.
 */
const HALO_BACKGROUND: BackgroundDescriptor = {
  id: 'halo',
  label: 'Halo',
  css: { backgroundColor: 'var(--card-bg)' },
  layers: [
    {
      id: 'halo-glow',
      css: {
        backgroundImage: [
          `radial-gradient(50% 42% at 50% 30%, ${tint('var(--accent-primary)', 42)}, transparent 26%)`,
          `radial-gradient(66% 56% at 50% 30%, transparent 22%, ${tint('var(--accent-primary)', 30)} 30%, transparent 40%)`,
          `radial-gradient(86% 72% at 50% 30%, transparent 38%, ${tint('var(--accent-primary)', 20)} 48%, transparent 62%)`,
        ].join(', '),
      },
      motion: {
        kind: 'breathe',
        durationMs: 16000,
        delayMs: 0,
        easing: 'ease-in-out',
        direction: 'normal',
        scale: { from: 0.92, to: 1.15 },
        opacity: { from: 0.7, to: 1 },
      },
    },
  ],
};

/**
 * Life — the engine-backed Conway's Game of Life surface (Spec #2915). Unlike
 * the six declarative CSS recipes it paints through a canvas engine (exactly ONE
 * bounded `requestAnimationFrame` loop) in the sibling `life/` subsystem; its
 * `layers` is EMPTY by design (the generic layer loop maps zero children) and its
 * `renderer` discriminator dispatches the backdrop to the engine. The ground is
 * the deepest page surface and cells resolve the `--life-cell` token at paint
 * time — the dimmed `--accent-strong` expression (accent-strong mixed toward
 * the derived `--life-neutral` mid-luminance chroma leg), over which `paint()`
 * lays ONE field-wide `--life-dim` scrim
 * — zero colour literal, exactly like every recipe. It is deliberately NOT part of
 * `BACKGROUND_DESCRIPTORS` (the six declarative recipes, whose ≥1-layer contract
 * is byte-pinned); the chooser appends it explicitly.
 */
export const LIFE_BACKGROUND: BackgroundDescriptor = {
  id: 'life',
  label: 'Life',
  css: { backgroundColor: 'var(--body-bg)' },
  layers: [],
  renderer: 'life',
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

/** Every valid id — `none` + the six procedural recipes + `life`. */
const BACKGROUND_IDS: readonly BackgroundId[] = [
  'none',
  'aurora',
  'nebula',
  'mesh',
  'topography',
  'constellation',
  'halo',
  'life',
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
    case 'life':
      return LIFE_BACKGROUND;
    case 'none':
    default:
      return NONE_BACKGROUND;
  }
}
