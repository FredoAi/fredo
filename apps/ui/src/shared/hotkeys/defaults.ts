/**
 * Spec #2946 ST-1 — the shipped default tables (plan contract block 10).
 *
 * `MINIMAL_DEFAULT_BINDINGS` preserves the shipped #2823 Ctrl+Space behaviour
 * and the required engine traversal affordances; every other action ships
 * UNBOUND (`fredo.window.close`, `fredo.settings.open`, per-feature actions).
 * `VIM_PRESET` is opt-in; `ENGINE_OWNED_TRAVERSAL` is native DOM order and is
 * NOT rebindable.
 *
 * PURE: constants only.
 */

import type { HotkeyActionId } from './types';

/** The minimal shipped bindings (action id → ordered serialized sequences). */
export const MINIMAL_DEFAULT_BINDINGS: Readonly<Record<HotkeyActionId, readonly string[]>> = {
  // Preserves the shipped #2823 Ctrl+Space launcher toggle.
  'fredo.launcher.toggle': ['primary+space'],
  'fredo.palette.openActions': ['primary+shift+p'],
  'fredo.help.cheatsheet': ['?'],
  'fredo.focus.nextWindow': ['primary+tab'],
  'fredo.focus.prevWindow': ['primary+shift+tab'],
  'fredo.window.cycleNth': [
    'primary+1',
    'primary+2',
    'primary+3',
    'primary+4',
    'primary+5',
    'primary+6',
    'primary+7',
    'primary+8',
    'primary+9',
  ],
  // Named-key chord: the layout-stable exit hatch (NOT reserved).
  'fredo.terminal.exitPassthrough': ['ctrl+shift+f10'],
  'fredo.macro.recordToggle': ['primary+shift+alt+r'],
  // NOTE: fredo.window.close, fredo.settings.open and per-feature actions ship UNBOUND.
};

/** The opt-in Vim preset: leader = Space, `h j k l` focus movement. */
export const VIM_PRESET: {
  readonly leader: string;
  readonly bindings: Readonly<Record<HotkeyActionId, readonly string[]>>;
} = {
  leader: 'space',
  bindings: {
    'fredo.focus.left': ['h'],
    'fredo.focus.down': ['j'],
    'fredo.focus.up': ['k'],
    'fredo.focus.right': ['l'],
    'fredo.help.cheatsheet': ['@leader ?'],
  },
};

/** Native DOM-order traversal; engine-owned and NOT rebindable. */
export const ENGINE_OWNED_TRAVERSAL = { tab: 'Tab', shiftTab: 'Shift+Tab' } as const;
