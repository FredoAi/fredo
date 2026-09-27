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

import type { HotkeyActionId, HotkeyContextId } from './types';

// ── Spec #2958 — the shipped platform reference context (the reachable LIVE ────
//    host for AC2/AC3). `fredo.root.reference` is a platform top-level child of
//    `fredo.root`; the descend action is resolvable at the base context and the
//    deeper-only action resolves ONLY while the reference context is active.
//    The context itself is REGISTERED by the engine (`registerDefaultFredoActions`).

// ── Spec #2959 — the keyboard-mode entry/exit chord (ONE dedicated chord) ─────
//    A named (non-printable) key, so the chord round-trips layout-stably like the
//    shipped `ctrl+shift+f9`/`f10` family; f8 is NOT platform-reserved and is
//    disjoint from every other shipped default. The mode state + body hook are
//    owned by `keyboardMode.ts`.

/** The keyboard-mode toggle action id (Fredo tier). */
export const KEYBOARD_MODE_ACTION_ID = 'fredo.keyboardMode.toggle';
/** The canonical serialized keyboard-mode chord (named key, layout-stable). */
export const KEYBOARD_MODE_CHORD = 'ctrl+shift+f8';

/** The shipped reference interaction-context id (platform child of `fredo.root`). */
export const REFERENCE_CONTEXT_ID: HotkeyContextId = 'fredo.root.reference';
/** Enters `REFERENCE_CONTEXT_ID` (declares `opensContextId`; executable too). */
export const REFERENCE_DESCEND_ACTION_ID = 'fredo.context.descendReference';
/** Resolves ONLY while `REFERENCE_CONTEXT_ID` is on the active path. */
export const REFERENCE_ONLY_ACTION_ID = 'fredo.context.referenceAction';

/**
 * The DISTINCTIVE announcement the reference-only action speaks through the ONE
 * shared announcer when it runs (G-257 — the live demonstrating surface for the
 * deeper-only action). Deliberately unlike the context-change copy
 * (`Entered … / Back to …`), so the shared channel's identical-string de-dup
 * never swallows it.
 */
export const REFERENCE_ACTION_ANNOUNCEMENT = 'Reference action ran.';

/** The minimal shipped bindings (action id → ordered serialized sequences). */
export const MINIMAL_DEFAULT_BINDINGS: Readonly<Record<HotkeyActionId, readonly string[]>> = {
  // Preserves the shipped #2823 Ctrl+Space launcher toggle.
  'fredo.launcher.toggle': ['primary+space'],
  // Typed-character model (PO#6): Ctrl+Shift+P normalizes to key 'P' with
  // `shift:false` (Shift is folded into the character), so the shipped default
  // must be the uppercase Character token — NOT `primary+shift+p`.
  'fredo.palette.openActions': ['primary+P'],
  'fredo.help.cheatsheet': ['?'],
  'fredo.focus.nextWindow': ['primary+tab'],
  'fredo.focus.prevWindow': ['primary+shift+tab'],
  // ST-16: the shipped NON-leader multi-key sequence (the AC's `g g` form).
  // `g` is a typed character, so it is suppressed in text-entry and never arms
  // on a native consumer — same rule set as the engine's other bare keys.
  'fredo.window.first': ['g g'],
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
  // A named-key chord: Ctrl+Shift+Alt+R also folds Shift into the produced 'R'
  // character, so it is unmatchable as a character binding. F9 is a named key
  // (modifier flags preserved), so `ctrl+shift+f9` round-trips.
  'fredo.macro.recordToggle': ['ctrl+shift+f9'],
  // Spec #2958 — the shipped reference context's two ADDITIVE bindings. The
  // shipped #2946 defaults above are untouched; these are the only two new
  // entries. Ctrl+Shift+K folds Shift into the 'K' character → `primary+K`.
  [REFERENCE_DESCEND_ACTION_ID]: ['primary+K'],
  // Bound ONLY while `fredo.root.reference` is on the active path (scoped by the
  // action's `contextId`), so this bare `y` never leaks to another context.
  [REFERENCE_ONLY_ACTION_ID]: ['y'],
  // Spec #2959 — the keyboard-mode entry/exit chord. A modifier chord, so the
  // engine matches it in text-entry/modal and the native-consumer guard never
  // withholds it; `F8` is a named key (modifier flags preserved), so
  // `ctrl+shift+f8` round-trips. The ONLY shipped-default addition in this slice.
  [KEYBOARD_MODE_ACTION_ID]: [KEYBOARD_MODE_CHORD],
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
