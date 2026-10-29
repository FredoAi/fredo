/**
 * Spec #3009 CU-1 (ST-2) — the PURE hotkey-bar model (plan API Contracts block).
 *
 * Projects the ST-1 `data-hotkey` element listing into the read-only rows the
 * always-on bottom bar renders, in document order (the listing is already
 * document-ordered), together with the pending-prefix and disabled state.
 *
 * Spec #3097 ST-4 — the model also projects the FOCUSED application's active
 * command mode: when `activeMode` is present the rows are that mode's declared
 * keymap (in `Object.entries(keymap)` declaration order) and NOT the element
 * listing (R-2.2 — element rows are not merged while a mode is active). The
 * mode's surface is resolved from the application registry by `appId`, so the
 * row titles come from the SAME declared command specs the engine executes —
 * no duplicated command metadata. `mode`/`prompt` are always present on the
 * model (`null` when absent), and `empty` only becomes reachable for an opting
 * application's empty mode keymap through the prompt/mode channel:
 * `empty = rows.length === 0 && mode === null && prompt === null`.
 *
 * `activeMode`/`prompt` are optional inputs: every pre-#3097 caller omits them
 * and gets byte-identical rows/pending/disabled/duplicate output.
 *
 * Contract (Spec #3097 ST-4R): the model MUTATES NOTHING and reads NO STORE —
 * the registry lookups behind the mode/badge projection are plain module state,
 * and `FocusSnapshot` is a TYPE-ONLY import (erased at compile time) so the model
 * has no runtime dependency on the engine. Its ONLY DOM read is the ancestor
 * scope lookup for the duplicate channel (`getCommandSurfaceScopeId`), which is
 * deliberately THE SAME function the runtime flush uses
 * (`hotkeyElements.ts` flush → `detectDuplicateHotkeys(entries, { scopeOf })`),
 * so the bar banner and the body hook can never diverge.
 *
 * Defined rules: `empty` is `rows.length === 0` for the element listing (G-265
 * reach-back → the caller renders `null`); the disabled pair covers a text-entry
 * control OR a terminal session (R-2.3/R-2.4), and the model mirrors the shipped
 * focus classification exactly (`context`/`textEntry`).
 *
 * R-3.4 (ST-2R): the model carries a duplicate channel (`duplicate` +
 * `duplicateKey`) derived by calling ST-1's EXISTING pure
 * `detectDuplicateHotkeys(entries, { scopeOf })` over the same listing — the
 * detector is DOM-free, so the model stays PURE (no re-implementation of
 * detection here). Spec #3071 ST-3 relaxed that detector's rule to
 * full-sequence / strict-prefix uniqueness, so a repeated first step (`key`) is
 * no longer a duplicate.
 *
 * PER-SCOPE channel (Spec #3097 ST-4R): `scopeOf` resolves each entry's
 * command-surface scope via `getCommandSurfaceScopeId(entry.element)`, exactly
 * like the runtime flush, so the banner reports the SOURCE the body hook
 * enforces: two applications that both bind a key never collide, while a
 * collision inside one application's scope is still reported. `null`-scope
 * entries (an element outside every opted-in application root) keep the global
 * bucket, so they collide with each other but never with a scoped application.
 */

import { detectDuplicateHotkeys } from './hotkeyElements';
import { getApplicationCommandMode } from './commandSurface';
import {
  getCommandSurfaceScopeId,
  resolveApplicationCommandSurface,
} from './applicationFocus';
import type { FocusSnapshot } from './engine';
import type { HotkeyElementEntry } from './hotkeyElements';

/** The two availability states a bar row can be in. */
export type HotkeyBarAvailability = 'available' | 'disabled';

/** One hotkey row in the bar — availability + the storage/display units (G-187). */
export interface HotkeyBarRow {
  readonly actionId: string;
  /**
   * `grammar.key` — the FIRST step. NOTE (Spec #3071 ST-3): this is NO LONGER a
   * uniqueness key — two-step bindings may share a first step (the `g` namespace
   * repeats it), so a repeated `key` is NOT a duplicate.
   *
   * Spec #3097 ST-4: for a mode row this is the declared keymap stroke.
   */
  readonly key: string;
  /** `grammar.serialized` — the display unit, e.g. `'a'` | `'a b'`. */
  readonly serialized: string;
  readonly title: string;
  readonly availability: HotkeyBarAvailability;
  /** Spec #3097 ST-4 — `'mode'` for a command-surface keymap row; omitted for element rows. */
  readonly kind?: 'element' | 'mode';
  /** Spec #3097 ST-4 — the owning mode id (mode rows only). */
  readonly modeId?: string | null;
}

/** Spec #3097 ST-4 — the focused application's active command mode (badge). */
export interface HotkeyBarModeView {
  readonly appId: string;
  readonly modeId: string;
  readonly label: string;
  /** `root -> top` mode path, e.g. `['browse', 'tool']`. */
  readonly path: readonly string[];
}

/** Spec #3097 ST-4 — the engine-owned inline value prompt. */
export interface HotkeyBarPromptView {
  readonly appId: string;
  readonly commandId: string;
  readonly label: string;
  readonly placeholder?: string;
  /** The module-owned draft (`getOpenCommandPrompt(appId).value`). */
  readonly value: string;
}

/** The bar's read-only projection of the mounted element hotkeys. */
export interface HotkeyBarModel {
  /** Document order, element-only (or the active mode's keymap rows). */
  readonly rows: readonly HotkeyBarRow[];
  /** The serialized pending prefix (`'a'`), or `null`. */
  readonly pendingPrefix: string | null;
  /** `true` while focus is in a text-entry control or a terminal session. */
  readonly disabled: boolean;
  /**
   * `rows.length === 0 && mode === null && prompt === null` — the caller renders
   * `null` (R-2.2 / G-265). An opting app's empty mode keymap is NOT empty: it
   * renders its badge (ST-4).
   */
  readonly empty: boolean;
  /** `true` when two mounted elements declare a colliding binding (R-3.4). */
  readonly duplicate: boolean;
  /**
   * The colliding serialized unit, or `null` when there is no duplicate
   * (R-3.4). Spec #3071 ST-3: the collision unit is the full serialization, not
   * the shared first step.
   */
  readonly duplicateKey: string | null;
  /** Spec #3097 ST-4 — the focused app's active mode (badge), `null` when absent. */
  readonly mode: HotkeyBarModeView | null;
  /** Spec #3097 ST-4 — the open inline prompt, `null` when absent. */
  readonly prompt: HotkeyBarPromptView | null;
}

/** The model's input — the ST-1 listing + the pending prefix + focus snapshot. */
export interface HotkeyBarModelInput {
  readonly entries: readonly HotkeyElementEntry[];
  readonly pending: string | null;
  readonly focus: FocusSnapshot;
  /** Spec #3097 ST-4 — the focused app's active mode (optional; absent ⇒ today). */
  readonly activeMode?: HotkeyBarModeView | null;
  /** Spec #3097 ST-4 — the open inline prompt (optional; absent ⇒ today). */
  readonly prompt?: HotkeyBarPromptView | null;
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
 * Project the active mode's declared keymap into bar rows, in `Object.entries`
 * (declaration) order. Availability is the SAME focus-derived value as element
 * rows, so mode rows grey out exactly like the rest of the legend.
 */
function buildModeRows(
  activeMode: HotkeyBarModeView,
  availability: HotkeyBarAvailability,
): HotkeyBarRow[] {
  const surface = resolveApplicationCommandSurface(activeMode.appId);
  if (surface === null) return [];
  const mode = getApplicationCommandMode(surface, activeMode.modeId);
  if (mode === null) return [];
  return Object.entries(mode.keymap).map(([stroke, commandId]) => {
    const command = surface.commands.find((candidate) => candidate.id === commandId);
    return {
      actionId: `command:${activeMode.appId}.${commandId}`,
      key: stroke,
      serialized: stroke,
      title: command?.title ?? commandId,
      availability,
      kind: 'mode' as const,
      modeId: activeMode.modeId,
    };
  });
}

/** Project the element listing in document order (unchanged pre-#3097 path). */
function buildElementRows(
  entries: readonly HotkeyElementEntry[],
  availability: HotkeyBarAvailability,
): HotkeyBarRow[] {
  return entries.map((entry) => ({
    actionId: entry.actionId,
    key: entry.grammar.key,
    serialized: entry.grammar.serialized,
    title: entry.title,
    availability,
  }));
}

/**
 * Build the bar model from the element listing and (optionally) the focused
 * application's active mode + open prompt. PURE: no store reads, no mutation,
 * one row per mounted valid element in the listing's (document) order — or one
 * row per declared mode keymap entry when a mode is active.
 */
export function buildHotkeyBarModel(input: HotkeyBarModelInput): HotkeyBarModel {
  const { entries, pending, focus, activeMode, prompt } = input;
  const mode = activeMode ?? null;
  const promptView = prompt ?? null;
  const disabled = focusDisablesHotkeys(focus);
  const availability: HotkeyBarAvailability = disabled ? 'disabled' : 'available';
  const rows =
    mode === null
      ? buildElementRows(entries, availability)
      : buildModeRows(mode, availability);
  // R-3.4 — reuse ST-1's pure detector (do NOT re-implement it here). The
  // duplicate channel stays element-listing-derived: mode keymaps are contract
  // data keyed by unique object keys and never enter the DOM grammar.
  // Spec #3097 ST-4R — partition EXACTLY like the runtime flush
  // (`hotkeyElements.ts`), so the banner and the body hook cannot diverge.
  const duplicateResult = detectDuplicateHotkeys(entries, {
    scopeOf: (entry) => getCommandSurfaceScopeId(entry.element),
  });
  return {
    rows,
    pendingPrefix: pending,
    disabled,
    empty: rows.length === 0 && mode === null && promptView === null,
    duplicate: duplicateResult.duplicate,
    duplicateKey: duplicateResult.key,
    mode,
    prompt: promptView,
  };
}
