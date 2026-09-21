import React from 'react';

import {
  buildInteriorPathD,
  expandFredoRects,
  FREDO_AVATAR_INTERIOR_RECTS,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_VIEWBOX,
} from './fredoAvatarGeometry';
import { AVATAR_SIZE, type FredoAvatarSize } from './fredoAvatarSizes';
import type { FredoAvatarState } from './fredoAvatarStates';
import './fredo-avatar.css';
import './fredoAvatarIdle.css';

export type { FredoAvatarState } from './fredoAvatarStates';

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
 * #2917 ST-1 — the head interior + mouth void are no longer transparent: ONE
 * unconditional `<path id="fredo-interior">` (NEVER a `<rect>` — the shipped pin
 * asserts `svg.querySelectorAll('rect') === 58`) is drawn BEFORE the 58 base
 * rects and filled with the opaque derived token `--fredo-avatar-interior`. The
 * base table and its mirror/count-parity guard are untouched.
 *
 * FROZEN-GEOMETRY INVARIANT (AC-2): the 58 base rects are byte-identical in
 * EVERY state. State expression is a SEPARATE conditional overlay `<g>` (this
 * component) plus whole-element motion on the CONSUMER's own wrapper (never
 * here — the launcher's idle DOM must stay byte-identical to today's
 * `PixelButler`, and that component must never animate the base figure).
 *
 *   idle         — no overlay; exactly the 58 base rects + the interior fill.
 *   talk         — mouth overlay in the hollow lower-face region (~y672-736):
 *                  closed frame {440,700,134,36} / open frame {440,672,134,64},
 *                  toggled by the `fredo-talk-mouth` keyframe (steps(2) loop).
 *   teleport-out — closed-eyes line rects across each eye column near its bottom
 *                  {323,556,68,32} + mirror {623,556,68,32}, plus a vertical
 *                  energy streak {491,180,32,520} that flashes ≤ 1 frame.
 *   teleport-in  — sparkle highlight rects near each eye's top-inner edge
 *                  {332,444,32,32} + mirror {650,444,32,32}, fading over ~200 ms
 *                  (under reduced motion they HOLD at opacity 1 — never erased).
 *   thinking     — 3-dot ellipsis in the hollow mouth void plus a thought-bubble
 *                  trail rising into the empty upper-right canvas (no mouth flap).
 *   joking       — a wide open laugh in the mouth void, a half-tone tongue, and
 *                  laugh lines beside each outer eye corner.
 *   happy        — a 5-rect upward smile arc in the mouth void plus a 3-star burst
 *                  around the head.
 *   playful      — an asymmetric smirk + cocked brow above the right eye + a cheek
 *                  star (the one deliberately off-symmetry expression).
 *   listening    — a 3-bar level meter on the right cheek hollow (voice capture).
 *   working      — two conveyor chevrons `»` marching in the left cheek hollow.
 *   error        — a V frown + slanted brows in `--status.error` ink.
 *   greeting     — a waving hand + raised brows + a 3-bar upward smile arc.
 *
 * EXPRESSION-INK RULE (supersedes the old additive-into-empty-regions rule):
 * the interior is now FILLED, so an overlay drawn over it in the base accent
 * would blend away. The whole overlay `<g>` therefore carries a group-level ink
 * `color="var(--accent-strong)"` (a deepened/lightened accent that contrasts the
 * accent-tinted fill in both light and dark), and its rects keep
 * `fill="currentColor"`. `error` is the sole override (`var(--status.error)`).
 * The 58 base rects' own `currentColor` (accent) is unchanged.
 *
 * Token-native: the SVG carries NO colour literal of its own — the interior fill
 * reads `var(--fredo-avatar-interior)` and every expression rect uses
 * `currentColor`, so theme/accent changes restyle the avatar with zero hardcoded
 * hex/rgba.
 */

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

// #2917 ST-1 — the additive interior fill, expanded + flattened to ONE path `d`.
// The expansion uses the SAME helper as the base table; the count-parity guard is
// keyed off the base table only, so this additive table cannot move the 58 count.
const INTERIOR_PATH_D = buildInteriorPathD(expandFredoRects(FREDO_AVATAR_INTERIOR_RECTS));

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
      {/* 1. Interior fill — additive, present in EVERY state (idle included),
          opaque + theme-derived. One <path>, never a <rect> (58-rect pin). */}
      <path
        id="fredo-interior"
        data-layer="interior"
        d={INTERIOR_PATH_D}
        fill="var(--fredo-avatar-interior)"
        pointerEvents="none"
      />
      {/* 2. The 58 frozen base rects (byte-identical in every state). */}
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
      {/* 3. Expression overlay — ALWAYS last, so expressions draw over the fill
          and the base figure. Group-level ink; `error` overrides to status.error. */}
      {state !== 'idle' && (
        <g
          id="fredo-expression"
          data-state={state}
          color={state === 'error' ? 'var(--status.error)' : 'var(--accent-strong)'}
        >
          {state === 'talk' && (
            <>
              {/* Closed mouth frame — mouth void between the eyes' bottom and the
                  jaw bar (y=761), center X=507. */}
              <rect
                className="fredo-talk-mouth-closed"
                x={440}
                y={700}
                width={134}
                height={36}
                fill="currentColor"
              />
              {/* Open mouth frame — same x/w, taller, y shifted up. */}
              <rect
                className="fredo-talk-mouth-open"
                x={440}
                y={672}
                width={134}
                height={64}
                fill="currentColor"
              />
            </>
          )}
          {state === 'teleport-out' && (
            <>
              {/* Closed-eyes lines across each eye column near its bottom (mirror
                  x' = 1014 − 323 − 68 = 623). Ink is accent-strong → visible over
                  the accent eye rect. */}
              <rect x={323} y={556} width={68} height={32} fill="currentColor" />
              <rect x={623} y={556} width={68} height={32} fill="currentColor" />
              {/* Energy-gather streak on the vertical center axis (x=507 ± 8). */}
              <rect className="fredo-teleport-streak" x={491} y={180} width={32} height={520} fill="currentColor" />
            </>
          )}
          {state === 'teleport-in' && (
            <>
              {/* Surprise/wide-eye sparkle highlights near each eye's top-inner
                  edge (mirror x' = 1014 − 332 − 32 = 650). */}
              <rect className="fredo-teleport-sparkle" x={332} y={444} width={32} height={32} fill="currentColor" />
              <rect className="fredo-teleport-sparkle" x={650} y={444} width={32} height={32} fill="currentColor" />
            </>
          )}
          {state === 'thinking' && (
            <>
              {/* 3-dot ellipsis in the hollow mouth void — pondering, no mouth flap
                  (echoes the `💭 Thinking...` placeholder). Outer dots mirror the
                  center X=507: x=470 / 528, mid x=499. */}
              <rect className="fredo-thinking-dot" x={470} y={688} width={32} height={32} fill="currentColor" />
              <rect className="fredo-thinking-dot" x={499} y={688} width={32} height={32} fill="currentColor" />
              <rect className="fredo-thinking-dot" x={528} y={688} width={32} height={32} fill="currentColor" />
              {/* Thought-bubble trail rising into the empty upper-right canvas. */}
              <rect className="fredo-thinking-bubble" x={846} y={150} width={40} height={40} fill="currentColor" />
              <rect className="fredo-thinking-bubble" x={884} y={110} width={56} height={56} fill="currentColor" />
              <rect className="fredo-thinking-bubble" x={930} y={58} width={72} height={72} fill="currentColor" />
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
              {/* Laugh lines beside each outer eye corner (mirror x' = 1014 − 296 − 24 = 694). */}
              <rect className="fredo-joking-laugh" x={296} y={456} width={24} height={44} fill="currentColor" />
              <rect className="fredo-joking-laugh" x={694} y={456} width={24} height={44} fill="currentColor" />
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
              <rect className="fredo-happy-star" x={150} y={150} width={36} height={36} fill="currentColor" />
              <rect className="fredo-happy-star" x={862} y={180} width={32} height={32} fill="currentColor" />
              <rect className="fredo-happy-star" x={330} y={700} width={40} height={40} fill="currentColor" />
            </>
          )}
          {state === 'playful' && (
            <>
              {/* Asymmetric smirk — flat bar + raised right corner (the one
                  deliberately off-symmetry expression). */}
              <rect className="fredo-playful-smirk" x={464} y={716} width={72} height={16} fill="currentColor" />
              <rect className="fredo-playful-smirk" x={536} y={704} width={18} height={12} fill="currentColor" />
              {/* Cocked brow above the right eye (hollow band y420-452, above the
                  eye top y453). */}
              <rect className="fredo-playful-brow" x={592} y={420} width={72} height={32} fill="currentColor" />
              {/* Cheek star in the hollow interior right of the eye. */}
              <rect className="fredo-playful-star" x={696} y={592} width={36} height={36} fill="currentColor" />
            </>
          )}
          {state === 'listening' && (
            <>
              {/* 3-bar level meter on the RIGHT cheek hollow (right of the right
                  eye, inside the head). Height-coded bars — a complete static frame
                  at rest. No mouth shape, so it can never read as a mouth state.
                  #2917 r2 FIX-2a: grown from 48-wide to 60-wide and taller so the
                  meter union (35,100 u² = 218.5 px² at sm) clears the rendered
                  dense-delta floor with margin; bottoms all at y=578 and the right
                  edge stays at x=892. */}
              <rect className="fredo-listening-bar" x={696} y={388} width={60} height={190} fill="currentColor" />
              <rect className="fredo-listening-bar" x={764} y={328} width={60} height={250} fill="currentColor" />
              <rect className="fredo-listening-bar" x={832} y={433} width={60} height={145} fill="currentColor" />
            </>
          )}
          {state === 'working' && (
            <>
              {/* Two chunky conveyor chevrons `»` marching in the LEFT cheek hollow
                  (a skill/tool is executing). Neutral face. #2917 r2 FIX-2c: each
                  rect grown 44×44 → 60×60 (union 20,952 u² = 130.4 px² at sm) so the
                  marker clears the dense floor; glyph layout + grouping unchanged. */}
              <g className="fredo-working-chevron">
                <rect x={166} y={606} width={60} height={60} fill="currentColor" />
                <rect x={166} y={672} width={60} height={60} fill="currentColor" />
                <rect x={220} y={639} width={60} height={60} fill="currentColor" />
              </g>
              <g className="fredo-working-chevron">
                <rect x={292} y={606} width={60} height={60} fill="currentColor" />
                <rect x={292} y={672} width={60} height={60} fill="currentColor" />
                <rect x={346} y={639} width={60} height={60} fill="currentColor" />
              </g>
            </>
          )}
          {state === 'error' && (
            <>
              {/* Downward V frown in the mouth void (ink = --status.error via the
                  group colour override). */}
              <rect x={455} y={700} width={56} height={40} fill="currentColor" />
              <rect x={503} y={724} width={56} height={40} fill="currentColor" />
              {/* Down-slanted brows (outer high, inner low). */}
              <rect x={310} y={424} width={44} height={28} fill="currentColor" />
              <rect x={352} y={444} width={44} height={28} fill="currentColor" />
              <rect x={660} y={444} width={44} height={28} fill="currentColor" />
              <rect x={618} y={424} width={44} height={28} fill="currentColor" />
            </>
          )}
          {state === 'greeting' && (
            <>
              {/* Waving hand in the upper-left empty canvas (a region no other
                  state uses) — the hand rotates about its wrist. */}
              <g className="fredo-greeting-hand">
                <rect x={132} y={246} width={84} height={72} fill="currentColor" />
                <rect x={140} y={182} width={28} height={64} fill="currentColor" />
                <rect x={176} y={166} width={28} height={80} fill="currentColor" />
                <rect x={212} y={182} width={28} height={64} fill="currentColor" />
                <rect x={116} y={262} width={32} height={44} fill="currentColor" />
              </g>
              {/* Motion arcs (static — never part of the rotating hand). */}
              <rect className="fredo-greeting-arc" x={84} y={196} width={28} height={60} fill="currentColor" />
              <rect className="fredo-greeting-arc" x={84} y={258} width={28} height={60} fill="currentColor" />
              {/* Raised brows (outer low, inner high — the mirror image of error). */}
              <rect x={314} y={420} width={44} height={28} fill="currentColor" />
              <rect x={356} y={404} width={44} height={28} fill="currentColor" />
              <rect x={656} y={404} width={44} height={28} fill="currentColor" />
              <rect x={614} y={420} width={44} height={28} fill="currentColor" />
              {/* 3-bar upward smile arc in the mouth void. */}
              <rect x={451} y={704} width={52} height={26} fill="currentColor" />
              <rect x={503} y={704} width={52} height={26} fill="currentColor" />
              <rect x={483} y={730} width={64} height={22} fill="currentColor" />
            </>
          )}
        </g>
      )}
    </svg>
  );
};
