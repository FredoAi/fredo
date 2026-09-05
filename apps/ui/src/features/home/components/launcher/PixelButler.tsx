import React from 'react';

/**
 * Pixel-butler avatar (base form) — the FREDO brand mascot.
 *
 * Renders the avatar-guide.png base NEUTRAL butler: a 21x21 pixel grid (hollow
 * round head, two vertical-bar eyes, bow-tie torso + arm nubs + two legs).
 *
 * Token-native (AC5): the SVG carries NO color of its own. Every pixel uses
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

// 21x21 pixel matrix (top → bottom, left → right): '#' = filled, '.' = empty.
// Base NEUTRAL butler (authoritative avatar-guide.png "BASE FORM" — transcribed
// cell-for-cell, symmetric about col 11): HOLLOW round head outline (rows 2-15)
// with TWO FILLED vertical-bar eyes (rows 8-13, cols 8-9 & 13-14) + a body
// (rows 17-20): small arm nubs (cols 5 & 17), a collar/vest, and two legs
// (cols 8-9 & 13-14). The interior of the head is transparent ('.'), so the
// accent forms only the outline + eyes + body — never the old solid blob.
const BASE_FORM = [
  '.....................',
  '......#########......',
  '....##.........##....',
  '...##...........##...',
  '..##.............##..',
  '..#...............#..',
  '.#.................#.',
  '.#.....##...##.....#.',
  '.#.....##...##.....#.',
  '.#.....##...##.....#.',
  '.#.....##...##.....#.',
  '.#.....##...##.....#.',
  '.#.....##...##.....#.',
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
      width={48}
      height={48}
      viewBox="0 0 21 21"
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
