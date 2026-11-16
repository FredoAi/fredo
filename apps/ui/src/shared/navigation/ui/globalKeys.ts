/**
 * Spec #3122 (P8), ST-1 — the ONE navigation-owned global chord dispatcher.
 *
 * After P8 exactly three platform chords survive (`primary+space`, `primary+tab`,
 * `primary+shift+tab`). They are NOT expressible in the §4.4 declaration grammar, so they
 * stay platform globals — but they are now owned by the navigation layer, not the retired
 * hotkey engine.
 *
 * Semantics (behaviour-preserving; traced from the shipped engine):
 *   1. ONE capture-phase `document` keydown listener per webview, idempotent (reference
 *      counted so React StrictMode's double effect and repeated installs are safe).
 *   2. It matches ONLY these three chords — no bare key, no sequence, no element binding.
 *   3. It suppresses when the focus context is `terminal`, `modal` or `text-entry`
 *      (`classifyFocusContext`), matching the shipped "no hotkey fires while typing / in a
 *      PTY / under an open modal" rule.
 *   4. On match it calls `preventDefault()` + `stopPropagation()`, then dispatches the
 *      declared window-system verb through `getNavigationHost('window-system')` with
 *      `channel:'keyboard'`, `actor:'human'`. With no host mounted (bare frame harness) it
 *      falls back to the shipped `focusNextWindow()` / `focusPreviousWindow()` /
 *      `runWindowLauncherToggle()`.
 *   5. It adds NO second dispatch path: application keys stay on their element-scoped
 *      `onKeyDown` adapters.
 *
 * PURE-ish: the module holds only the install state; all behaviour comes from the injected
 * DOM + the shipped primitives.
 */

import { keyStrokeEquals, normalizeKeyStroke } from '../keys';
import { classifyFocusContext } from '../focusContext';
import type { Actor, Channel, FocusContext, KeyStroke } from '../types';
import { focusNextWindow, focusPreviousWindow } from '../../window-system/traversal';
import { runWindowLauncherToggle } from '../../window-system/launcherToggleSeam';
import { getNavigationHost } from './hostRegistry';

/* ───────────────────────────── contract ───────────────────────────── */

/** The three kept chord identities (binding names block). */
export interface NavigationGlobalChord {
  readonly id: 'launcher.toggle' | 'window.focus.next' | 'window.focus.previous';
  readonly verbId: 'window.launcher.toggle' | 'window.focus.next' | 'window.focus.previous';
  readonly primary: true;
  readonly shift: boolean;
  readonly key: 'space' | 'tab';
}

/**
 * The three kept platform chords, in declaration order — EXACT sequences, no re-tuning.
 * `primary` is Ctrl on win32/linux and Cmd on darwin (the ONE platform rule in `keys.ts`).
 */
export const NAVIGATION_GLOBAL_CHORDS: readonly NavigationGlobalChord[] = Object.freeze([
  {
    id: 'launcher.toggle',
    verbId: 'window.launcher.toggle',
    primary: true,
    shift: false,
    key: 'space',
  },
  {
    id: 'window.focus.next',
    verbId: 'window.focus.next',
    primary: true,
    shift: false,
    key: 'tab',
  },
  {
    id: 'window.focus.previous',
    verbId: 'window.focus.previous',
    primary: true,
    shift: true,
    key: 'tab',
  },
]);

/** §B.2 — the declared window-system surface app id (the ONE host the chords dispatch to). */
const WINDOW_SYSTEM_SURFACE_APP_ID = 'window-system';

/** The keyboard channel/actor every global chord is attributed to. */
const CHORD_CHANNEL: Channel = 'keyboard';
const CHORD_ACTOR: Actor = 'human';

/** The declared stroke for a chord (the declaration is the single source of the sequence). */
function chordStroke(chord: NavigationGlobalChord): KeyStroke {
  return {
    key: chord.key,
    primary: chord.primary,
    ctrl: false,
    alt: false,
    shift: chord.shift,
    meta: false,
  };
}

/** The focus classification of the live document (incl. the global open-modal fact). */
function currentFocusContext(): FocusContext {
  if (typeof document === 'undefined') return 'default';
  const active = document.activeElement;
  const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
  return classifyFocusContext(active, { modalOpen });
}

/** True when the focus owner consumes the keyboard — the chord must not fire. */
function isSuppressed(context: FocusContext): boolean {
  return context === 'terminal' || context === 'modal' || context === 'text-entry';
}

/** The chord whose declared stroke equals the event's normalized stroke, or `null`. */
function matchChord(event: KeyboardEvent): NavigationGlobalChord | null {
  const stroke = normalizeKeyStroke(event);
  if (stroke === null) return null;
  for (const chord of NAVIGATION_GLOBAL_CHORDS) {
    if (keyStrokeEquals(stroke, chordStroke(chord))) return chord;
  }
  return null;
}

/**
 * Dispatch one matched chord: the declared host verb when a window system is mounted,
 * otherwise the shipped outcome functions (bare harness).
 */
function dispatchChord(chord: NavigationGlobalChord): void {
  const host = getNavigationHost(WINDOW_SYSTEM_SURFACE_APP_ID);
  if (host !== null) {
    void host.runIntent({
      verbId: chord.verbId,
      args: {},
      channel: CHORD_CHANNEL,
      actor: CHORD_ACTOR,
    });
    return;
  }

  switch (chord.id) {
    case 'launcher.toggle':
      runWindowLauncherToggle();
      return;
    case 'window.focus.next':
      focusNextWindow();
      return;
    case 'window.focus.previous':
      focusPreviousWindow();
  }
}

/** The ONE listener body: suppress first, then match, then swallow + dispatch. */
function handleNavigationKeydown(event: KeyboardEvent): void {
  if (isSuppressed(currentFocusContext())) return;
  const chord = matchChord(event);
  if (chord === null) return;
  event.preventDefault();
  event.stopPropagation();
  dispatchChord(chord);
}

// ── Install / uninstall (idempotent, reference counted) ─────────────────────

type KeydownFn = (event: KeyboardEvent) => void;

let activeInstalls = 0;
let listener: KeydownFn | null = null;

/** Arm the ONE capture-phase document keydown listener; idempotent across installs. */
export function installNavigationKeyDispatch(): () => void {
  if (typeof document === 'undefined') return () => {};
  activeInstalls += 1;
  if (activeInstalls === 1) {
    listener = handleNavigationKeydown;
    document.addEventListener('keydown', listener, true);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeInstalls = Math.max(0, activeInstalls - 1);
    if (activeInstalls === 0) removeListener();
  };
}

/** Force-remove the listener (idempotent). */
export function uninstallNavigationKeyDispatch(): void {
  activeInstalls = 0;
  removeListener();
}

function removeListener(): void {
  if (listener !== null && typeof document !== 'undefined') {
    document.removeEventListener('keydown', listener, true);
  }
  listener = null;
}

/** True while the ONE chord listener is armed. */
export function isNavigationKeyDispatchInstalled(): boolean {
  return activeInstalls > 0;
}

/** Test-only: force-remove the listener and reset the reference count. */
export function resetNavigationKeyDispatchForTests(): void {
  uninstallNavigationKeyDispatch();
}
