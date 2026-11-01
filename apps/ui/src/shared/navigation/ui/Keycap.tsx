/**
 * Spec #3118 (P4), ST-2 — `NavKeycap`, the navigation-owned keycap primitive.
 *
 * One renderer for the declaration's key strings (`[a-z0-9]`, `Escape|Enter|Tab`) and for
 * the two display glyphs (`?` / `/`). The declaration's bindable tokens come from the
 * resolver's grammar, so the display + spoken forms reuse the shipped `displayStroke` /
 * `accessibleSequence` helpers (`shared/navigation/keys.ts`) rather than inventing a second
 * key parser (P4 data-flow fact 10).
 *
 * Accessibility (R-7.2 / QA Q7-02):
 *   - the root is `role="img"` with a NON-EMPTY accessible name (the spoken sequence, or
 *     `NAV_GLYPH_ACCESSIBLE_NAME` for a glyph);
 *   - every chip is `aria-hidden="true"` (the root carries the name — never duplicate speech);
 *   - `keys: []` with no glyph renders `null` (no empty-named `role="img"`).
 *
 * Colour is theme tokens + the shared `tint()` helper only — zero hex/rgb/hsl literals and
 * zero `var(--x)NN` alpha-appends (R-5.2). No motion: chips are static (R-5.1 applies to the
 * animated surfaces).
 *
 * NOTE: the exported symbol is `NavKeycap`, NOT `Keycap` — `apps/ui/src/index.ts` already
 * root-exports the legacy `Keycap`, so the two names must never collide (Architect §6).
 */

import React from 'react';
import { chakra } from '@chakra-ui/react';

import { tint } from '../../utils/colorTint';
import { accessibleSequence, displayStroke, parseSequence } from '../keys';
import type { Platform } from '../types';
import {
  NAV_GLYPH_ACCESSIBLE_NAME,
  NAV_KEYCAP_GROUP_TESTID,
  NAV_KEYCAP_TESTID,
} from './constants';

export interface NavKeycapProps {
  /** Declaration key strings, e.g. `['c']` or `['w n']` (the FIRST binding is displayed). */
  readonly keys: readonly string[];
  /** `'?'` / `/` → a single glyph chip whose name comes from `NAV_GLYPH_ACCESSIBLE_NAME`. */
  readonly glyph?: string | null;
  /** Layout override so display/speech is deterministic in tests. */
  readonly platform?: Platform;
}

/** The chip gap (plan UI/UX §3.4 — `gap 4px`). */
const KEYCAP_GAP = '4px';

/** Spoken name for a glyph, falling back to the glyph itself for an unknown value. */
function glyphName(glyph: string): string {
  const names = NAV_GLYPH_ACCESSIBLE_NAME as Readonly<Record<string, string>>;
  return names[glyph] ?? glyph;
}

/**
 * `NavKeycap` — the declaration's key string as one `role="img"` group.
 *
 * The glyph wins when present (the map's global rows pass `glyph` with no `keys`); otherwise
 * the first binding is parsed as a sequence and each stroke becomes one chip. An
 * unrepresentable/empty binding renders `null`, exactly like `keys: []` — a keycap never
 * ships an empty accessible name.
 */
export function NavKeycap({ keys, glyph, platform }: NavKeycapProps): React.ReactElement | null {
  if (typeof glyph === 'string' && glyph.length > 0) {
    return (
      <chakra.span
        data-testid={NAV_KEYCAP_GROUP_TESTID}
        data-nav-keycap="true"
        role="img"
        aria-label={glyphName(glyph)}
        display="inline-flex"
        alignItems="center"
        gap={KEYCAP_GAP}
        flexShrink={0}
        userSelect="none"
      >
        <chakra.kbd
          data-testid={NAV_KEYCAP_TESTID}
          aria-hidden="true"
          fontFamily="mono"
          fontSize="xs"
          lineHeight="1.5"
          color="fg.default"
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="border.subtle"
          borderBottomWidth="2px"
          borderBottomColor={tint('var(--text-primary)', 22)}
          borderRadius="sm"
          boxShadow={`0 1px 0 0 ${tint('var(--text-primary)', 12)}`}
          px="1.5"
          py="0.5"
          whiteSpace="nowrap"
        >
          {glyph}
        </chakra.kbd>
      </chakra.span>
    );
  }

  const first = keys[0];
  if (first === undefined) return null;
  const strokes = parseSequence(first);
  if (strokes.length === 0) return null;

  const spoken = accessibleSequence(strokes, platform);
  if (spoken.length === 0) return null;

  return (
    <chakra.span
      data-testid={NAV_KEYCAP_GROUP_TESTID}
      data-nav-keycap="true"
      role="img"
      aria-label={spoken}
      display="inline-flex"
      alignItems="center"
      gap={KEYCAP_GAP}
      flexShrink={0}
      userSelect="none"
    >
      {strokes.map((stroke, index) => {
        const label = displayStroke(stroke, platform);
        return (
          <chakra.kbd
            key={`${index}:${label}`}
            data-testid={NAV_KEYCAP_TESTID}
            aria-hidden="true"
            fontFamily="mono"
            fontSize="xs"
            lineHeight="1.5"
            color="fg.default"
            bg="bg.subtle"
            borderWidth="1px"
            borderColor="border.subtle"
            borderBottomWidth="2px"
            borderBottomColor={tint('var(--text-primary)', 22)}
            borderRadius="sm"
            boxShadow={`0 1px 0 0 ${tint('var(--text-primary)', 12)}`}
            px="1.5"
            py="0.5"
            whiteSpace="nowrap"
          >
            {label}
          </chakra.kbd>
        );
      })}
    </chakra.span>
  );
}
