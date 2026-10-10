/**
 * Spec #3009 — the shipped KEPT platform globals.
 *
 * The configurable default table (Vim preset, `g g`, `primary+1..9`, `?`,
 * `primary+P`, `Ctrl+Shift+F8/F9/F10`) is retired. Only THREE platform globals
 * survive, because they dispatch through a path that predates the element model
 * (launcher toggle + window focus cycling):
 *
 *   - `fredo.launcher.toggle`      → `primary+space`
 *   - `fredo.focus.nextWindow`     → `primary+tab`
 *   - `fredo.focus.prevWindow`     → `primary+shift+tab`
 *
 * Every other hotkey is declared by a mounted element carrying `data-hotkey`.
 *
 * PURE: constants only.
 */

import type { HotkeyActionId } from './types';

/** The launcher toggle action id (re-homed from the old LauncherShell listener). */
export const LAUNCHER_TOGGLE_ACTION_ID: HotkeyActionId = 'fredo.launcher.toggle';
/** Window focus cycling action ids (traversal completes their run). */
export const FOCUS_NEXT_ACTION_ID: HotkeyActionId = 'fredo.focus.nextWindow';
export const FOCUS_PREVIOUS_ACTION_ID: HotkeyActionId = 'fredo.focus.prevWindow';

/** One kept platform global: its action id + its single serialized chord. */
export interface KeptGlobalBinding {
  readonly actionId: HotkeyActionId;
  readonly title: string;
  readonly description: string;
  readonly sequence: string;
}

/**
 * The shipped kept globals, in declaration order. `resolveActiveBindings` merges
 * these (as registry actions) with every mounted element hotkey.
 */
export const KEPT_GLOBAL_BINDINGS: readonly KeptGlobalBinding[] = Object.freeze([
  {
    actionId: LAUNCHER_TOGGLE_ACTION_ID,
    title: 'Toggle launcher',
    description: 'Show or focus the launcher command bar',
    sequence: 'primary+space',
  },
  {
    actionId: FOCUS_NEXT_ACTION_ID,
    title: 'Focus next window',
    description: 'Move focus to the next open window',
    sequence: 'primary+tab',
  },
  {
    actionId: FOCUS_PREVIOUS_ACTION_ID,
    title: 'Focus previous window',
    description: 'Move focus to the previous open window',
    sequence: 'primary+shift+tab',
  },
]);
