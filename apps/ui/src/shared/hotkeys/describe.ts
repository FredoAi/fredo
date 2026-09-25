/**
 * Spec #2946 ST-3 — the ONE binding → display + accessible-name formatter
 * shared by every hotkey display surface (plan: "one renderer"): the which-key
 * overlay, the Hotkeys settings list, the cheat sheet, the command palette and
 * the terminal passthrough pill.
 *
 * PRESENTATIONAL ONLY: it composes ST-1's canonical parse/format helpers
 * (`parseSequence`, `serializeSequence`, `displaySequence`, `accessibleSequence`)
 * and never re-implements a key rule, imports the registry, or reads the engine.
 *
 * EARS: R-1.3 (keys are shown with their spelled names) feeds R-3.2 (the single
 * announcement channel speaks the `accessible` string).
 */

import {
  accessibleSequence,
  displaySequence,
  parseSequence,
  serializeSequence,
} from './keys';
import type { KeySequence, Platform } from './types';

/** A registry/persistence binding as consumed by the display layer. */
export interface DescribableBinding {
  /** The parsed canonical sequence. */
  readonly sequence: KeySequence;
  /** The stored serialized form; re-derived from `sequence` when omitted. */
  readonly serialized?: string;
}

/** The display + accessible projection of one binding (R-1.3). */
export interface BindingDescription {
  /** The canonical serialized sequence, e.g. `primary+space`. */
  readonly serialized: string;
  /** The layout-resolved human string, e.g. `Ctrl + Space`. */
  readonly display: string;
  /** The spelled form for assistive tech, e.g. `Control plus Space`. */
  readonly accessible: string;
  /** The number of chord steps in the sequence. */
  readonly stepCount: number;
  /** `false` when the input could not be parsed (the `[]` invalid sentinel). */
  readonly valid: boolean;
}

/** Describe a serialized sequence or an already-parsed `KeySequence`. */
export function describeSequence(
  input: string | KeySequence,
  platform?: Platform,
): BindingDescription {
  const sequence = typeof input === 'string' ? parseSequence(input) : input;
  return describeParsed(sequence, platform);
}

/** Describe a registry binding (its parsed sequence + optional stored form). */
export function describeBinding(
  binding: DescribableBinding,
  platform?: Platform,
): BindingDescription {
  return describeParsed(binding.sequence, platform, binding.serialized);
}

function describeParsed(
  sequence: KeySequence,
  platform?: Platform,
  serialized?: string,
): BindingDescription {
  const canonical = serializeSequence(sequence);
  if (canonical.length === 0) {
    return { serialized: '', display: '', accessible: '', stepCount: 0, valid: false };
  }
  return {
    serialized: serialized ?? canonical,
    display: displaySequence(sequence, platform),
    accessible: accessibleSequence(sequence, platform),
    stepCount: sequence.length,
    valid: true,
  };
}
