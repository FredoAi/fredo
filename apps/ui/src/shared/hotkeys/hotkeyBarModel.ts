/**
 * Spec #3009 CU-1 (ST-2) — the PURE hotkey-bar model (plan API Contracts block).
 *
 * Projects the ST-1 `data-hotkey` element listing into the read-only rows the
 * always-on bottom bar renders, in document order (the listing is already
 * document-ordered), together with the pending-prefix and disabled state.
 *
 * PURE (mirrors `keys.ts`): no DOM, no React, no store,
 * no engine runtime read — `FocusSnapshot` is a TYPE-ONLY import (erased at
 * compile time) so the model has no runtime dependency on the engine.
 *
 * Defined rules: `empty` is `rows.length === 0` (G-265 reach-back → the caller
 * renders `null`); the disabled pair covers a text-entry control OR a terminal
 * session (R-2.3/R-2.4), and the model mirrors the shipped focus classification
 * exactly (`context`/`textEntry`).
 *
 * R-3.4 (ST-2R): the model carries a duplicate channel (`duplicate` +
 * `duplicateKey`) derived by calling ST-1's EXISTING pure
 * `detectDuplicateHotkeys(entries)` over the same listing — the detector is
 * DOM-free, so the model stays PURE (no re-implementation of detection here).
 */

import { detectDuplicateHotkeys } from './hotkeyElements';
import type { FocusSnapshot } from './engine';
import type { HotkeyElementEntry } from './hotkeyElements';

/** The two availability states a bar row can be in. */
export type HotkeyBarAvailability = 'available' | 'disabled';

/** One hotkey row in the bar — availability + the storage/display units (G-187). */
export interface HotkeyBarRow {
  readonly actionId: string;
  /** `grammar.key` — the FIRST step (the storage / duplicate key). */
  readonly key: string;
  /** `grammar.serialized` — the display unit, e.g. `'a'` | `'a b'`. */
  readonly serialized: string;
  readonly title: string;
  readonly availability: HotkeyBarAvailability;
}

/** The bar's read-only projection of the mounted element hotkeys. */
export interface HotkeyBarModel {
  /** Document order, element-only; keeps the listing's ownership order. */
  readonly rows: readonly HotkeyBarRow[];
  /** The serialized pending prefix (`'a'`), or `null`. */
  readonly pendingPrefix: string | null;
  /** `true` while focus is in a text-entry control or a terminal session. */
  readonly disabled: boolean;
  /** `rows.length === 0` — the caller renders `null` (R-2.2 / G-265). */
  readonly empty: boolean;
  /** `true` when two mounted elements declare the same key (R-3.4). */
  readonly duplicate: boolean;
  /** The shared key, or `null` when there is no duplicate (R-3.4). */
  readonly duplicateKey: string | null;
}

/** The model's input — the ST-1 listing + the pending prefix + focus snapshot. */
export interface HotkeyBarModelInput {
  readonly entries: readonly HotkeyElementEntry[];
  readonly pending: string | null;
  readonly focus: FocusSnapshot;
}

/**
 * True while element hotkeys are suppressed: focus is in a text-entry control
 * (`context === 'text-entry'`, or the `textEntry` flag — covering a textbox
 * inside a modal) or a terminal session (`context === 'terminal'`).
 */
function focusDisablesHotkeys(focus: FocusSnapshot): boolean {
  return (
    focus.context === 'terminal' ||
    focus.context === 'text-entry' ||
    focus.textEntry === true
  );
}

/**
 * Build the bar model from the element listing. PURE: no store reads, no
 * mutation, one row per mounted valid element in the listing's (document) order.
 */
export function buildHotkeyBarModel(input: HotkeyBarModelInput): HotkeyBarModel {
  const { entries, pending, focus } = input;
  const disabled = focusDisablesHotkeys(focus);
  const availability: HotkeyBarAvailability = disabled ? 'disabled' : 'available';
  const rows: HotkeyBarRow[] = entries.map((entry) => ({
    actionId: entry.actionId,
    key: entry.grammar.key,
    serialized: entry.grammar.serialized,
    title: entry.title,
    availability,
  }));
  // R-3.4 — reuse ST-1's pure detector (do NOT re-implement it here).
  const duplicateResult = detectDuplicateHotkeys(entries);
  return {
    rows,
    pendingPrefix: pending,
    disabled,
    empty: rows.length === 0,
    duplicate: duplicateResult.duplicate,
    duplicateKey: duplicateResult.key,
  };
}
