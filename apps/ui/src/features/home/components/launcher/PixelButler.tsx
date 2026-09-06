import React from 'react';

/**
 * Pixel-butler avatar (base form) — the FREDO brand mascot.
 *
 * Renders the avatar-guide.png base NEUTRAL butler: a 21x21 pixel grid (hollow
 * round head, two vertical-bar eyes, bow-tie torso + arm nubs + two legs).
 *
 * Token-native (AC4/AC5): the SVG carries NO color of its own. Every pixel uses
 * `fill="currentColor"` and the root SVG sets `color="var(--accent-primary)"`,
 * so the cyan lives in the accent token (CYAN is the default accent value) and
 * theme-switch restyles the avatar with zero hardcoded hex/rgba.
 *
 * The `status` prop is an optional extension point for the icon-guide evolution
 * states (STANDBY / AWAITING / ANALYZING / PLANNING / EXECUTING / COMPLETE) —
 * NOT required by this slice's ACs; the base form is the default render.
 */

export type PixelButlerStatus =
  | 'standby'
  | 'awaiting'
  | 'analyzing'
  | 'planning'
  | 'executing'
  | 'complete';

export interface PixelButlerProps {
  /** Whether the avatar is currently shown (open launcher). */
  visible: boolean;
  /** Optional expression/evolution extension point — base NEUTRAL (standby) is the default render. */
  status?: PixelButlerStatus;
}

// Guide grid dimension (cells). The guide renders it at a nominal 8px pixel-cell
// scale (PIXEL_SIZE below), but the shipped avatar renders at DISPLAY_SIZE px with
// a 21x21 viewBox so the on-screen size stays 48x48 (AC5).
const GRID_SIZE = 21;
// Guide pixel scale (px per cell) — auditability constant; the on-screen render
// is driven by DISPLAY_SIZE + GRID_SIZE (crispEdges quantizes the viewBox cells).
const PIXEL_SIZE = 8;
// Rendered SVG px (unchanged — AC5 layout invariance).
const DISPLAY_SIZE = 48;

// 21x21 pixel matrix (top → bottom, left → right): '#' = filled, '.' = empty.
// Base NEUTRAL butler (authoritative avatar-guide.png "BASE FORM" — transcribed
// cell-for-cell, symmetric about col 11, single accent fill): a large HOLLOW
// round-dome head OUTLINE (rows 1-15, interior TRANSPARENT — never a solid
// fill) with TWO vertical-bar eyes (rows 10-12, cols 8-9 & 13-14) and a compact
// chunky body (rows 17-20): arm nubs (cols 5 & 17), a torso, and two short legs
// (cols 8-9 & 13-14). The guide base form carries NO separate mouth — the only
// horizontal bar is the head's chin/neck arc (row 15) — so the eye/mouth region
// between the eyes and the chin is left transparent. Every figure element (head
// outline, eyes, body) is the SAME accent fill — there is no second light-contrast
// fill and no two-fill SVG; the head interior stays transparent.
const BASE_FORM = [
  '.....................',
  '......#########......',
  '....##.........##....',
  '...##...........##...',
  '..##.............##..',
  '..#...............#..',
  '.#.................#.',
  '.#.................#.',
  '.#.................#.',
  '.#.....##...##.....#.',
  '.#.....##...##.....#.',
  '.#.....##...##.....#.',
  '.#.................#.',
  '.#.................#.',
  '......#########......',
  '.....................',
  '....#..#######..#....',
  '.....###########.....',
  '.......##...##.......',
  '.......##...##.......',
  '.....................',
];

export const PixelButler: React.FC<PixelButlerProps> = ({ visible }) => {
  if (!visible) return null;

  return (
    <svg
      width={DISPLAY_SIZE}
      height={DISPLAY_SIZE}
      viewBox={`0 0 ${GRID_SIZE} ${GRID_SIZE}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      shapeRendering="crispEdges"
      color="var(--accent-primary)"
    >
      {BASE_FORM.flatMap((row, y) =>
        row
          .split('')
          .map((cell, x) =>
            cell === '#' ? (
              <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
            ) : null,
          ),
      )}
    </svg>
  );
};
