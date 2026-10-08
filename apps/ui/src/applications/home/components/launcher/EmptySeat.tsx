import React from 'react';
import { Box } from '@chakra-ui/react';

import { AVATAR_SM_CSS } from '../../../../shared/components/fredo-avatar';
import { tint } from '../../../../shared/utils/colorTint';

/**
 * EmptySeat — the away placeholder for the launcher's reserved home seat
 * (#2870 ST-3 / R-4).
 *
 * While Fredo is ON but away from the home seat (`isVisible && isAway`), the
 * launcher still reserves the SAME 80×100 + 16px band as the seated companion,
 * so the command bar below it never jumps. This component is that band's
 * content: a STATIC dashed outline marking the vacated seat.
 *
 * Deliberately inert and motionless:
 *   - STATIC — no animation / pulse / skeleton (reduced-motion trivially
 *     satisfied; no keyframes, no transition).
 *   - No element `opacity` (the dashed token outline carries the "vacant" read).
 *   - `pointerEvents="none"`, NOT focusable, no `onClick`/`title` — it is a
 *     visual marker only, never an interaction target.
 *   - Zero margin — the parent seat wrapper owns the `mb="4"` band.
 *
 * Token-native: the border + fill come from theme CSS vars via `tint()`
 * (never a hex/rgba literal, never alpha-append onto a `var()`).
 */

export const EmptySeat: React.FC = () => (
  <Box
    role="img"
    aria-label="Fredo is away"
    data-state="away"
    width={AVATAR_SM_CSS.width}
    height={AVATAR_SM_CSS.height}
    boxSizing="border-box"
    borderRadius="14px"
    border="1.5px dashed var(--text-subtle)"
    background={tint('var(--accent-primary)', 5)}
    pointerEvents="none"
  />
);

export default EmptySeat;
