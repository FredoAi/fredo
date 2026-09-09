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

export type FredoAvatarSize = 'sm' | 'md';

export const AVATAR_SIZE: Record<FredoAvatarSize, { width: number; height: number }> = {
  sm: AVATAR_SM,
  md: AVATAR_MD,
};
