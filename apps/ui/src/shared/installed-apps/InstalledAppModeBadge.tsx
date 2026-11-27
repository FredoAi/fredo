/**
 * The ONE development-mode marker renderer (Spec #3241, ST-5; UI/UX §7).
 *
 * Two painted surfaces carry the mode — the settings row (S3) and the launcher
 * shelf (S4) — and both render through THIS component, so the visible word cannot
 * drift between them. A per-surface wrapper would be two places to change the
 * word back; one component with two hook props is the smallest shape that keeps a
 * single source of truth for the word while letting each surface own its own
 * bound `data-testid` (G-266).
 *
 * # Text-bearing, never colour-only
 *
 * The visible text IS the accessible name: there is no `aria-label` and no
 * `aria-hidden`, so what is painted and what is announced cannot diverge. That is
 * the AC's "a user cannot mistake it" requirement — the hue is redundant.
 *
 * # `released` renders NOTHING
 *
 * No node, no wrapper, no empty span. The absence IS the released state, and a
 * row/entry that is not a development build must be byte-identical to what it was
 * before this feature (INV-6).
 *
 * # Not a control
 *
 * No hover, no `cursor: pointer`, not focusable, no role. The mode is static
 * state; a `role="status"` or `aria-live` here would announce on every re-render,
 * which is noise (the *installation* event is the thing worth announcing, and it
 * has its own shipped live region).
 */

import React from 'react';
import { chakra } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import { DEVELOPMENT_MARKER_TOKEN, type InstalledAppMode } from './types';

/** The two surfaces' bound hooks. A required prop, so neither name can be lost. */
export type InstalledAppModeBadgeTestId =
  | 'installed-apps-entry-mode'
  | 'launcher-installed-app-mode';

/** The two sizes this one renderer serves. */
export type InstalledAppModeBadgeSize = 'row' | 'shelf';

export interface InstalledAppModeBadgeProps {
  /** The projection member — read directly, no fallback chain. */
  mode: InstalledAppMode;
  /** The surface's OWN bound hook. Required: a default would duplicate one name. */
  testId: InstalledAppModeBadgeTestId;
  /** `row` (settings, 11 px) or `shelf` (launcher, 10 px). */
  size: InstalledAppModeBadgeSize;
}

const SIZE_PX: Record<InstalledAppModeBadgeSize, { fontSize: string; padding: string }> = {
  row: { fontSize: '11px', padding: '0 8px' },
  shelf: { fontSize: '10px', padding: '0 6px' },
};

export const InstalledAppModeBadge: React.FC<InstalledAppModeBadgeProps> = ({
  mode,
  testId,
  size,
}) => {
  // The absence IS the released state — no wrapper, no empty node.
  if (mode !== 'development') return null;

  const { fontSize, padding } = SIZE_PX[size];

  return (
    <chakra.span
      data-testid={testId}
      // The word is painted VERBATIM (no textTransform) so the token is identical
      // on every painted surface — R-3.6's uniformity rule.
      fontFamily="mono"
      fontSize={fontSize}
      lineHeight="1.6"
      padding={padding}
      borderRadius="sm"
      borderWidth="1px"
      borderStyle="solid"
      borderColor="border.default"
      bg={tint('var(--status-info)', 10)}
      color="fg.default"
      flexShrink={0}
      whiteSpace="nowrap"
    >
      {DEVELOPMENT_MARKER_TOKEN}
    </chakra.span>
  );
};
