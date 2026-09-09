import React from 'react';

import {
  expandFredoRects,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_VIEWBOX,
} from './fredoAvatarGeometry';
import { AVATAR_SIZE, type FredoAvatarSize } from './fredoAvatarSizes';
import './fredo-avatar.css';

/**
 * Shared FREDO avatar — the ONE canonical brand mascot for every surface.
 *
 * Promoted out of the launcher feature (#2850): `PixelButler` was a faithful
 * VECTOR transcription of the authoritative `.opencode/wireframes/fredo-avatar.html`
 * rectangle decomposition (#2837) — the wireframe's 1014x1264 coordinate space
 * IS the SVG viewBox, and every figure rect is one `<rect>` whose (x, y, width,
 * height) matches the html call 1:1 (mirrored pairs derived at
 * x' = 1014 - x - width by `expandFredoRects`). The head is a stepped outline
 * rim with a hollow interior — the eyes are the only interior content and the
 * jaw is the broad lower-face bar (NO base mouth).
 *
 * FROZEN-GEOMETRY INVARIANT (AC-2): the 58 base rects are byte-identical in
 * EVERY state. State expression is a SEPARATE conditional overlay `<g>` (this
 * component) plus whole-element motion on the CONSUMER's own wrapper (never
 * here — the launcher's idle DOM must stay byte-identical to today's
 * `PixelButler`, and that component must never animate the base figure).
 *
 *   idle         — no overlay; exactly the 58 base rects.
 *   talk         — mouth overlay in the hollow lower-face region (~y692-713):
 *                  closed frame {440,692,134,14} / open frame {440,675,134,38},
 *                  toggled by the `fredo-talk-mouth` keyframe (steps(2) loop).
 *   teleport-out — closed-eyes line rects across each eye column near its bottom
 *                  {323,564,68,14} + mirror {623,564,68,14}, plus a vertical
 *                  energy streak {499,180,16,520} that flashes ≤ 1 frame.
 *   teleport-in  — sparkle highlight rects near each eye's top-inner edge
 *                  {340,452,16,16} + mirror {658,452,16,16}, fading over the
 *                  first ~120ms.
 *
 * Token-native: the SVG carries NO color of its own. Every rect uses
 * `fill="currentColor"` and the root SVG sets `color="var(--accent-primary)"`,
 * so theme/accent changes restyle the avatar with zero hardcoded hex/rgba.
 */

export type FredoAvatarState = 'idle' | 'talk' | 'teleport-out' | 'teleport-in';

export interface FredoAvatarProps {
  /** sm → AVATAR_SM (companion ~80x100); md → AVATAR_MD (launcher 132x165). */
  size: FredoAvatarSize;
  /** Expression state — default 'idle'. The launcher always renders idle. */
  state?: FredoAvatarState;
  /** Passthrough className (currently unused by consumers). */
  className?: string;
}

// Expanded once at module scope — no per-mount rebuild (58 rects).
const RECTS = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);

export const FredoAvatar: React.FC<FredoAvatarProps> = ({ size, state = 'idle', className }) => {
  const { width, height } = AVATAR_SIZE[size];

  return (
    <svg
      width={width}
      height={height}
      viewBox={FREDO_AVATAR_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      shapeRendering="crispEdges"
      color="var(--accent-primary)"
      className={className}
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
      {state !== 'idle' && (
        <g id="fredo-expression" data-state={state}>
          {state === 'talk' && (
            <>
              {/* Closed mouth frame — hollow lower-face region between the eyes'
                  bottom (y≈584) and the lower-face jaw bar (y=761), center X=507. */}
              <rect
                className="fredo-talk-mouth-closed"
                x={440}
                y={692}
                width={134}
                height={14}
                fill="currentColor"
              />
              {/* Open mouth frame — same x/w, taller, y shifted up. */}
              <rect
                className="fredo-talk-mouth-open"
                x={440}
                y={675}
                width={134}
                height={38}
                fill="currentColor"
              />
            </>
          )}
          {state === 'teleport-out' && (
            <>
              {/* Closed-eyes lines across each eye column near its bottom (mirror
                  x' = 1014 − 323 − 68 = 623). */}
              <rect x={323} y={564} width={68} height={14} fill="currentColor" />
              <rect x={623} y={564} width={68} height={14} fill="currentColor" />
              {/* Energy-gather streak on the vertical center axis (x=507 ± 8). */}
              <rect className="fredo-teleport-streak" x={499} y={180} width={16} height={520} fill="currentColor" />
            </>
          )}
          {state === 'teleport-in' && (
            <>
              {/* Surprise/wide-eye sparkle highlights near each eye's top-inner
                  edge (mirror x' = 1014 − 340 − 16 = 658). */}
              <rect className="fredo-teleport-sparkle" x={340} y={452} width={16} height={16} fill="currentColor" />
              <rect className="fredo-teleport-sparkle" x={658} y={452} width={16} height={16} fill="currentColor" />
            </>
          )}
        </g>
      )}
    </svg>
  );
};
