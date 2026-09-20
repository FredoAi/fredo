import React from 'react';

import {
  expandFredoRects,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_VIEWBOX,
} from './fredoAvatarGeometry';
import { AVATAR_SIZE, type FredoAvatarSize } from './fredoAvatarSizes';
import './fredo-avatar.css';
import './fredoAvatarIdle.css';

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
 *   thinking     — 3-dot ellipsis in the hollow mouth void plus a thought-bubble
 *                  trail rising into the empty upper-right canvas (no mouth flap).
 *   joking       — a wide open laugh in the mouth void, a half-tone tongue, and
 *                  laugh lines beside each outer eye corner.
 *   happy        — a 5-rect upward smile arc in the mouth void plus a 3-star burst
 *                  around the head.
 *   playful      — an asymmetric smirk + cocked brow above the right eye + a cheek
 *                  star (the one deliberately off-symmetry expression).
 *
 * ADDITIVE-INTO-EMPTY-REGIONS: the base figure is solid `fill="currentColor"`, so
 * a new `currentColor` shape drawn OVER a base rect is invisible. Every new delta
 * is placed in an EMPTY region — the mouth void (x≈276-738, y≈590-755), the hollow
 * head interior beside the eyes, or the empty canvas around the head.
 *
 * Token-native: the SVG carries NO color of its own. Every rect uses
 * `fill="currentColor"` and the root SVG sets `color="var(--accent-primary)"`,
 * so theme/accent changes restyle the avatar with zero hardcoded hex/rgba.
 */

export type FredoAvatarState =
  | 'idle'
  | 'talk'
  | 'teleport-out'
  | 'teleport-in'
  | 'thinking'
  | 'happy'
  | 'playful'
  | 'joking';

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
          {state === 'thinking' && (
            <>
              {/* 3-dot ellipsis in the hollow mouth void — pondering, no mouth flap
                  (echoes the `💭 Thinking...` placeholder). Outer dots mirror the
                  center X=507: x=470 / 528, mid x=499. */}
              <rect className="fredo-thinking-dot" x={470} y={700} width={16} height={16} fill="currentColor" />
              <rect className="fredo-thinking-dot" x={499} y={700} width={16} height={16} fill="currentColor" />
              <rect className="fredo-thinking-dot" x={528} y={700} width={16} height={16} fill="currentColor" />
              {/* Thought-bubble trail rising into the empty upper-right canvas. */}
              <rect className="fredo-thinking-bubble" x={846} y={150} width={20} height={20} fill="currentColor" />
              <rect className="fredo-thinking-bubble" x={884} y={110} width={28} height={28} fill="currentColor" />
              <rect className="fredo-thinking-bubble" x={930} y={58} width={40} height={40} fill="currentColor" />
            </>
          )}
          {state === 'joking' && (
            <>
              {/* Wide open laugh — clearly wider/warmer than talk's 134-wide toggle.
                  Sits in the hollow lower-face void (center X=507). */}
              <rect className="fredo-joking-mouth" x={432} y={682} width={150} height={52} fill="currentColor" />
              {/* Half-tone tongue inside the laugh (reinforcement, not load-bearing;
                  the only permitted second tone is opacity — no hex/rgba). */}
              <rect
                className="fredo-joking-tongue"
                x={452}
                y={708}
                width={110}
                height={20}
                opacity={0.5}
                fill="currentColor"
              />
              {/* Laugh lines beside each outer eye corner (hollow interior). */}
              <rect className="fredo-joking-laugh" x={300} y={468} width={14} height={22} fill="currentColor" />
              <rect className="fredo-joking-laugh" x={700} y={468} width={14} height={22} fill="currentColor" />
            </>
          )}
          {state === 'happy' && (
            <>
              {/* 5-rect upward smile arc in the lower-face void — corners high, slopes,
                  then the low center bar (symmetric about X=507). */}
              <rect className="fredo-happy-mouth" x={440} y={690} width={26} height={22} fill="currentColor" />
              <rect className="fredo-happy-mouth" x={548} y={690} width={26} height={22} fill="currentColor" />
              <rect className="fredo-happy-mouth" x={466} y={714} width={36} height={16} fill="currentColor" />
              <rect className="fredo-happy-mouth" x={512} y={714} width={36} height={16} fill="currentColor" />
              <rect className="fredo-happy-mouth" x={489} y={730} width={36} height={12} fill="currentColor" />
              {/* 3-star burst — two outside the head, one in the left cheek hollow. */}
              <rect className="fredo-happy-star" x={150} y={150} width={22} height={22} fill="currentColor" />
              <rect className="fredo-happy-star" x={862} y={180} width={20} height={20} fill="currentColor" />
              <rect className="fredo-happy-star" x={330} y={700} width={18} height={18} fill="currentColor" />
            </>
          )}
          {state === 'playful' && (
            <>
              {/* Asymmetric smirk — flat bar + raised right corner (the one
                  deliberately off-symmetry expression). */}
              <rect className="fredo-playful-smirk" x={464} y={716} width={72} height={16} fill="currentColor" />
              <rect className="fredo-playful-smirk" x={536} y={704} width={18} height={12} fill="currentColor" />
              {/* Cocked brow above the right eye (hollow band y430-444, above the
                  eye top y453). */}
              <rect className="fredo-playful-brow" x={600} y={430} width={64} height={14} fill="currentColor" />
              {/* Cheek star in the hollow interior right of the eye. */}
              <rect className="fredo-playful-star" x={700} y={600} width={20} height={20} fill="currentColor" />
            </>
          )}
        </g>
      )}
    </svg>
  );
};
