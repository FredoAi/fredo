/**
 * lifeConstants — the ONE authored-constants home for the Life desktop
 * background (Spec #2915, ST-1).
 *
 * Every bound the Life subsystem honours lives here, exported and statically
 * readable, so the tester can derive the perceptibility floor (`LIFE_STEP_MS`
 * cadence → the F-61 interval/window), the grid/DPR caps (F-66) and the
 * re-seed cadence (F-69) without parsing implementation code. Nothing in the
 * Life domain hardcodes a bound inline — `background/life/**` imports these.
 *
 * This module is PURE (no DOM, no React, no canvas) and carries no colour
 * literal; rendering colours are resolved live from the theme CSS custom
 * properties at paint time (see `lifeEngine.ts`).
 */

/** Cell footprint in CSS px (each live cell is this square). */
export const LIFE_CELL_PX = 12;

/** Hard grid caps: at most 160 × 100 = 16,000 cells (two `Uint8Array` buffers). */
export const LIFE_COLS_MAX = 160;
export const LIFE_ROWS_MAX = 100;

/** Generation interval in ms (≈6.25 generations/s ≪ the 3 Hz strobe threshold). */
export const LIFE_STEP_MS = 160;

/** Re-randomize after this many generations (the deterministic cap). */
export const LIFE_RESEED_GENERATIONS = 150;

/** The re-seed cadence in ms — the tester's window unit (150 × 160 = 24,000). */
export const LIFE_RESEED_MS = LIFE_RESEED_GENERATIONS * LIFE_STEP_MS;

/** How many named catalogue patterns each populate/reseed places (2–4). */
export const LIFE_RESEED_PATTERNS_MIN = 2;
export const LIFE_RESEED_PATTERNS_MAX = 4;

/** Bounded random fill probability applied on top of the placed patterns. */
export const LIFE_FILL_DENSITY = 0.1;

/** Initial population density band — never settles/dies out, never saturated. */
export const LIFE_DENSITY_MIN = 0.04;
export const LIFE_DENSITY_MAX = 0.3;

/** Stagnation policy: unchanged population for N generations at/below this density. */
export const LIFE_STAGNATION_GENERATIONS = 3;
export const LIFE_STAGNATION_MIN_DENSITY = 0.04;

/** Canvas backing-store bound: ≤ 1.5 × the CSS viewport on each axis (linear). */
export const LIFE_DPR_MAX = 1.5;

/** Re-seed must not invert full-frame mean luminance by more than this (F-65). */
export const LIFE_LUMA_INVERSION_MAX = 0.005;

/** The bounded curated Life Lexicon catalogue size (never the full lexicon). */
export const LIFE_PATTERN_COUNT = 10;

/** The always-visible CC BY-SA 3.0 attribution notice (Life Lexicon, Stephen Silver). */
export const LIFE_ATTRIBUTION = 'Patterns: Life Lexicon (Stephen Silver), CC BY-SA 3.0.';

/* -------------------------------------------------------------------------- */
/* Painted-dim contract (Spec #2925, ST-1)                                    */
/* -------------------------------------------------------------------------- */
/*
 * The two authored weights below compose the derived `--life-cell` /
 * `--life-dim` expressions registered ONCE in `ThemeProvider.tsx` (base pass,
 * next to `--accent-strong`). They are the SINGLE authored-number home for the
 * calmer/less-glaring field: the provider string-interpolates them into the
 * two `color-mix()` custom properties, and `lifeEngine.ts` reads the resolved
 * values at paint time. See `docs/features/desktop-background-life.md`.
 */

/** Cell blend toward `--text-primary` — the desaturation leg of the cell mix. */
export const LIFE_CELL_MIX = 0.2;

/** `--overlay-bg` weight in `--life-dim` (black alpha = 0.6 × 0.2 = 0.12). */
export const LIFE_SCRIM_WEIGHT = 0.2;

/**
 * Contrast floor for the resolved dimmed cell-vs-ground pair. If the WCAG
 * contrast ratio drops below this, the engine paints the untransformed pair
 * (`--accent-strong` cells, no scrim) instead — a legibility safety net for
 * arbitrary user accents, not a colour value. It is a fallback TRIGGER, not a
 * colour, so it never participates in the pure CSS expression.
 */
export const LIFE_CONTRAST_MIN = 3;
