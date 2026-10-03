/**
 * Spec #2960 ST-1 — the PURE input-regime derivation (plan binding names block).
 *
 * The S3 signal must never disagree with the engine, so the regime is a PURE
 * function of the engine's ONE `FocusSnapshot` (`engine.ts`). No component may
 * re-derive `isTextControl`/`classifyFocusContext` from `document.activeElement`;
 * the snapshot's `textEntry` field is the only added input.
 *
 * This module imports only a TYPE from `engine.ts` (erased at build time) and
 * holds no DOM/React/store state.
 *
 * Resolution order (first match wins):
 *   context === 'terminal' -> null         (the shipped terminal pill owns it)
 *   textEntry === true     -> 'typing'     (top-level fields AND modal fields)
 *   otherwise              -> 'navigating' (default/interactive, and a modal's
 *                                           non-text focus)
 */

import type { FocusSnapshot } from './engine';

/** The two legible regimes a non-terminal focus can be in. */
export type InputRegime = 'typing' | 'navigating';

/**
 * Derive the input regime from the engine's ONE focus snapshot. Returns `null`
 * for the `terminal` context (no signal — the shipped terminal passthrough pill
 * is the terminal's regime signal).
 */
export function regimeForFocusSnapshot(
  snapshot: Pick<FocusSnapshot, 'context' | 'textEntry'>,
): InputRegime | null {
  if (snapshot.context === 'terminal') return null;
  if (snapshot.textEntry) return 'typing';
  return 'navigating';
}

/** The ONE announcement copy for a regime transition. */
export function inputRegimeAnnouncement(regime: InputRegime): string {
  return regime === 'typing'
    ? 'Typing. Letters are text; navigation keys are inactive.'
    : 'Navigating. Keyboard actions are active.';
}
