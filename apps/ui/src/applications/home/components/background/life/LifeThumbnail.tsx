/**
 * LifeThumbnail — the STATIC chooser thumbnail for the Life background
 * (Spec #2915, ST-4; shared dimmed paint expression Spec #2925, ST-3).
 *
 * A deterministic, hand-authored "founder frame": a glider, a blinker and a
 * block drawn as a token-only inline SVG. It is STRUCTURALLY incapable of
 * animating — there is no canvas, no engine, no rAF and no timer in this module,
 * so the automaton can never run in the settings chooser. The only thing that
 * mounts the engine is the desktop backdrop, through
 * `LifeBackgroundCanvas` (which this component deliberately does NOT import).
 *
 * Paint contract (Spec #2925, R-5f): the preview mirrors the SAME shared dimmed
 * expression the live field paints — ground `var(--body-bg)`, cells
 * `var(--life-cell)` (the accent-strong cell blended toward the `--life-neutral`
 * mid-luminance chroma leg, itself `--text-primary` toward `--body-bg`), and a
 * final `var(--life-dim)` scrim rect composited over both so the tile can never
 * promise a brighter field than the desktop delivers. All three consumers name
 * the tokens only; the mix arithmetic lives once in `ThemeProvider.tsx` and the
 * authored weights in `lifeConstants.ts`. Alpha is expressed ONLY through the
 * numeric SVG `opacity` attribute — never a colour alpha-append and never a
 * literal.
 */

import React from 'react';

/** Cell geometry inside the 16 × 10 viewBox (a small seam between cells). */
const CELL_SIZE = 0.86;
const CELL_GAP = 0.07;

/** Glider (the smallest spaceship) — top-left cluster. */
const GLIDER_CELLS: readonly (readonly [number, number])[] = [
  [3, 3],
  [4, 4],
  [2, 5],
  [3, 5],
  [4, 5],
];

/** Blinker (the period-2 oscillator) — top-right. */
const BLINKER_CELLS: readonly (readonly [number, number])[] = [
  [7, 2],
  [8, 2],
  [9, 2],
];

/** Block (the smallest still life) — bottom-right. */
const BLOCK_CELLS: readonly (readonly [number, number])[] = [
  [12, 6],
  [13, 6],
  [12, 7],
  [13, 7],
];

function renderCells(
  cells: readonly (readonly [number, number])[],
  keyPrefix: string,
): React.ReactElement[] {
  return cells.map(([col, row], index) => (
    <rect
      key={`${keyPrefix}-${index}`}
      x={col + CELL_GAP}
      y={row + CELL_GAP}
      width={CELL_SIZE}
      height={CELL_SIZE}
    />
  ));
}

export const LifeThumbnail: React.FC = () => (
  <span
    data-testid="desktop-background-life-thumb"
    data-life-preview="static"
    aria-hidden="true"
    style={{ position: 'absolute', inset: 0, display: 'block', pointerEvents: 'none' }}
  >
    <svg
      viewBox="0 0 16 10"
      role="presentation"
      preserveAspectRatio="none"
      style={{ display: 'block', width: '100%', height: '100%' }}
    >
      <rect x={0} y={0} width={16} height={10} fill="var(--body-bg)" />
      <g fill="var(--life-cell)">
        {renderCells(GLIDER_CELLS, 'glider')}
        {renderCells(BLINKER_CELLS, 'blinker')}
      </g>
      {/* The still life sits a shade quieter — numeric SVG alpha only. */}
      <g fill="var(--life-cell)" opacity={0.72}>
        {renderCells(BLOCK_CELLS, 'block')}
      </g>
      {/* The field-wide dim, mirrored so the preview matches the live paint. */}
      <rect x={0} y={0} width={16} height={10} fill="var(--life-dim)" />
    </svg>
  </span>
);
