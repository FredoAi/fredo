/**
 * Shared FREDO avatar display sizes — the SINGLE source for the sm/md aspect.
 *
 * Height is ALWAYS derived from the width via the canonical wireframe aspect
 * (1014:1264, from `FREDO_AVATAR_SPACE`) — never a separate height literal, so
 * every size is undistorted and a new width can never drift from the aspect.
 */

import { FREDO_AVATAR_SPACE } from './fredoAvatarGeometry';

const aspectHeight = (width: number): number =>
  Math.round((width * FREDO_AVATAR_SPACE.height) / FREDO_AVATAR_SPACE.width);

/** Small — the desktop companion (~80 px wide × ~100 px tall). */
export const AVATAR_SM = { width: 80, height: aspectHeight(80) };

/** Medium — the launcher (132 px wide × 165 px tall, unchanged from PixelButler). */
export const AVATAR_MD = { width: 132, height: aspectHeight(132) };

/**
 * Chakra-prop concern: convert a numeric pixel length to its CSS unit-string
 * form (`80` → `"80px"`).
 *
 * Chakra v3 resolves a BARE NUMBER in `width`/`height` as a theme `sizes`
 * token, NOT px — `width={80}` becomes `sizes.80` (320 px at a 16 px root).
 * Any Chakra `Box` that must render the avatar's exact footprint therefore has
 * to pass a unit STRING. This helper is that single conversion; the numeric
 * `AVATAR_SM` values stay untouched for the SVG-attribute / inline-style
 * consumers (`FredoAvatar.tsx`, `CompanionEntity.tsx`, `computeTeleportTarget`,
 * `SpeechBubble.tsx`).
 */
export const toCssPx = (value: number): string => `${value}px`;

/**
 * The sm avatar dimensions as Chakra-ready CSS unit strings (80px × 100px) —
 * the SHARED conversion both seat consumers (`LauncherShell` slot wrapper and
 * `EmptySeat`) pass to Chakra `Box` width/height, so the reserved seat renders
 * at the exact avatar footprint (never the 320 px `sizes.80` token).
 */
export const AVATAR_SM_CSS = {
  width: toCssPx(AVATAR_SM.width),
  height: toCssPx(AVATAR_SM.height),
};

export type FredoAvatarSize = 'sm' | 'md';

export const AVATAR_SIZE: Record<FredoAvatarSize, { width: number; height: number }> = {
  sm: AVATAR_SM,
  md: AVATAR_MD,
};
