import React from 'react';

import {
  expandFredoRects,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_VIEWBOX,
} from './fredoAvatarGeometry';

/**
 * Pixel-butler avatar — the FREDO brand mascot.
 *
 * Renders a faithful VECTOR transcription of the authoritative
 * `.opencode/wireframes/fredo-avatar.html` rectangle decomposition (#2837): the
 * wireframe's 1014x1264 coordinate space IS the SVG viewBox, and every figure
 * rect is one `<rect>` whose (x, y, width, height) matches the html call 1:1
 * (mirrored pairs derived at x' = 1014 - x - width by `expandFredoRects`). The
 * head is a stepped outline rim with a hollow interior — the eyes are the only
 * interior content, and there is NO mouth (the jaw is the broad lower-face bar).
 *
 * Token-native (AC5): the SVG carries NO color of its own. Every rect uses
 * `fill="currentColor"` and the root SVG sets `color="var(--accent-primary)"`,
 * so theme/accent changes restyle the avatar with zero hardcoded hex/rgba.
 *
 * The `status` prop is an optional extension point for the icon-guide evolution
 * states (STANDBY / AWAITING / ANALYZING / PLANNING / EXECUTING / COMPLETE) —
 * NOT implemented by this slice's ACs; the figure always renders the base
 * neutral FREDO.
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
  /** Optional expression/evolution extension point — base NEUTRAL is the default render. */
  status?: PixelButlerStatus;
}

// Display size (Architect band: DISPLAY_HEIGHT ∈ [128, 210] ⇔ DISPLAY_WIDTH ∈
// [103, 168]). Shipped default 132 wide; height is aspect-locked to the
// wireframe 1014:1264 so the render is undistorted.
const DISPLAY_WIDTH = 132;
const DISPLAY_HEIGHT = Math.round((DISPLAY_WIDTH * 1264) / 1014);

// Expanded once at module scope — no per-mount rebuild (58 rects).
const RECTS = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);

export const PixelButler: React.FC<PixelButlerProps> = ({ visible }) => {
  if (!visible) return null;

  return (
    <svg
      width={DISPLAY_WIDTH}
      height={DISPLAY_HEIGHT}
      viewBox={FREDO_AVATAR_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      shapeRendering="crispEdges"
      color="var(--accent-primary)"
    >
      {RECTS.map((rect, index) => (
        <rect
          key={index}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          fill="currentColor"
        />
      ))}
    </svg>
  );
};
