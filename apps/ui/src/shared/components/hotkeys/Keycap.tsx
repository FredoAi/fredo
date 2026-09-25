/**
 * Spec #2946 ST-3 — the shared `Keycap` primitive (plan UI/UX §"Shared primitive").
 *
 * ONE renderer for every hotkey display surface (which-key overlay, Hotkeys
 * settings list, cheat sheet, command palette, terminal passthrough pill), so a
 * binding never renders differently across surfaces.
 *
 * Presentational only: no engine/registry import. A serialized `KeySequence`
 * renders as one `<kbd>` chip per chord step:
 *   - `primary+space` → one chip  ("Ctrl + Space")
 *   - `@leader g`     → two chips ("Leader", "G")
 *   - `g g`           → two chips ("G", "G")
 *
 * The chips are `aria-hidden` (the shared announcer carries the speech, R-3.2);
 * the group carries the fully-spelled accessible name (`accessibleSequence`).
 * `data-chord-token` holds the canonical serialized sequence on every chip.
 * The only colour inputs are semantic tokens and the shared `tint()` helper —
 * never a hex/rgba literal, never an alpha-append onto a `var()`.
 */

import React from 'react';
import { chakra } from '@chakra-ui/react';
import { tint } from '../../utils/colorTint';
import { displayStroke, parseSequence } from '../../hotkeys/keys';
import { describeSequence } from '../../hotkeys/describe';
import type { Platform } from '../../hotkeys/types';

export interface KeycapProps {
  /** The serialized binding, e.g. `primary+space`, `@leader g`, `g g`. */
  readonly sequence: string;
  /** Layout override so display/accessible output is deterministic in tests. */
  readonly platform?: Platform;
  /** Optional className passthrough for the wrapper. */
  readonly className?: string;
}

export function Keycap({ sequence, platform, className }: KeycapProps) {
  const steps = React.useMemo(() => parseSequence(sequence), [sequence]);
  const description = React.useMemo(
    () => describeSequence(steps, platform),
    [steps, platform],
  );

  // An unrepresentable sequence renders nothing — the invalid sentinel surfaces
  // as an unavailable-with-reason row in the consuming surface, not as junk.
  if (!description.valid) return null;

  return (
    <chakra.span
      className={className}
      data-testid="hotkeys-keycap-group"
      role="img"
      aria-label={description.accessible}
      display="inline-flex"
      alignItems="center"
      gap="1"
    >
      {steps.map((stroke, index) => {
        const label = displayStroke(stroke, platform);
        return (
          <chakra.kbd
            key={`${index}:${label}`}
            data-testid="hotkeys-keycap"
            data-chord-token={description.serialized}
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
            userSelect="none"
          >
            {label}
          </chakra.kbd>
        );
      })}
    </chakra.span>
  );
}
