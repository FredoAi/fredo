/**
 * Background registry — the closed set of desktop-background descriptors
 * (Spec #2899 ST-1).
 *
 * Every descriptor's `css` is a PURE function of live theme CSS custom
 * properties: no color literal, no raster asset, no `url()`/`data:` URI, no
 * animation. Translucency is produced exclusively through the shared `tint()`
 * helper (`color-mix(in srgb, var(--…) N%, transparent)`), which resolves at
 * paint time — so a theme/accent switch recolors every recipe with zero JS and
 * no restart (AC2).
 *
 * `none` reuses the shell's shipped desktop texture verbatim, moved here so the
 * grid has ONE definition shared by the launcher surface and the registry.
 *
 * `getBackgroundDescriptor` is LENIENT: any unknown, stale, malformed, or
 * removed id normalizes to `NONE_BACKGROUND` and never throws (AC3).
 */

import type { CSSProperties } from 'react';
import { tint } from '../../../../shared/utils/colorTint';

/** The closed background id set: `none` (default) + six procedural recipes. */
export type BackgroundId =
  | 'none'
  | 'aurora'
  | 'nebula'
  | 'mesh'
  | 'topography'
  | 'constellation'
  | 'halo';

/** A named background and the paint it contributes. `css` is a pure function
 *  of live theme variables (theme-driven, literal-free). */
export interface BackgroundDescriptor {
  id: BackgroundId;
  label: string;
  css: CSSProperties;
}

/**
 * The shell's shipped desktop texture (Asset 1.7) — moved VERBATIM from
 * `LauncherShell.tsx` so it has exactly one definition. Faint border-color
 * color-mix lines behind every window.
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
};

/** Two large accent blooms over the body ground. */
const AURORA_BACKGROUND: BackgroundDescriptor = {
  id: 'aurora',
  label: 'Aurora',
  css: {
    backgroundColor: 'var(--body-bg)',
    backgroundImage: [
      `radial-gradient(120% 90% at 15% 0%, ${tint('var(--accent-primary)', 26)}, transparent 60%)`,
      `radial-gradient(120% 90% at 85% 20%, ${tint('var(--accent-secondary)', 22)}, transparent 60%)`,
    ].join(', '),
  },
};

/** A primary bloom with a counter-bloom and a faint dot grain. */
const NEBULA_BACKGROUND: BackgroundDescriptor = {
  id: 'nebula',
  label: 'Nebula',
  css: {
    backgroundColor: 'var(--card-bg)',
    backgroundImage: [
      `radial-gradient(90% 70% at 70% 15%, ${tint('var(--accent-primary)', 20)}, transparent 65%)`,
      `radial-gradient(90% 70% at 20% 80%, ${tint('var(--accent-secondary)', 16)}, transparent 65%)`,
      `radial-gradient(${tint('var(--text-primary)', 8)} 1px, transparent 1px)`,
    ].join(', '),
    backgroundSize: 'auto, auto, 22px 22px',
  },
};

/** Three corner tints over the body ground. */
const MESH_BACKGROUND: BackgroundDescriptor = {
  id: 'mesh',
  label: 'Mesh',
  css: {
    backgroundColor: 'var(--body-bg)',
    backgroundImage: [
      `radial-gradient(80% 80% at 15% 10%, ${tint('var(--accent-primary)', 18)}, transparent 60%)`,
      `radial-gradient(80% 80% at 85% 15%, ${tint('var(--accent-secondary)', 16)}, transparent 60%)`,
      `radial-gradient(80% 80% at 50% 100%, ${tint('var(--status-info)', 12)}, transparent 60%)`,
    ].join(', '),
  },
};

/** Concentric accent contour rings over the card ground. */
const TOPOGRAPHY_BACKGROUND: BackgroundDescriptor = {
  id: 'topography',
  label: 'Topography',
  css: {
    backgroundColor: 'var(--card-bg)',
    backgroundImage: [
      `repeating-radial-gradient(circle at 30% 40%, transparent 0 22px, ${tint('var(--accent-primary)', 10)} 22px 23px)`,
    ].join(', '),
  },
};

/** A star-like dot field over the body ground with a soft accent bloom. */
const CONSTELLATION_BACKGROUND: BackgroundDescriptor = {
  id: 'constellation',
  label: 'Constellation',
  css: {
    backgroundColor: 'var(--body-bg)',
    backgroundImage: [
      `radial-gradient(${tint('var(--text-primary)', 16)} 1.2px, transparent 1.2px)`,
      `radial-gradient(100% 80% at 50% 50%, ${tint('var(--accent-primary)', 10)}, transparent 60%)`,
    ].join(', '),
    backgroundSize: '26px 26px, auto',
  },
};

/** One soft accent halo near the top over the card ground. */
const HALO_BACKGROUND: BackgroundDescriptor = {
  id: 'halo',
  label: 'Halo',
  css: {
    backgroundColor: 'var(--card-bg)',
    backgroundImage: [
      `radial-gradient(120% 100% at 50% 18%, ${tint('var(--accent-primary)', 16)}, transparent 62%)`,
    ].join(', '),
  },
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
