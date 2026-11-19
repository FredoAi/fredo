/**
 * The three surviving platform chords (Spec #3151 ST-4) — the re-homed home of the ONLY
 * keyboard behaviour that outlives the retired navigation engine.
 *
 * After the engine's removal exactly three chords remain:
 *
 *   primary+space        → toggle the launcher
 *   primary+tab          → focus the next window
 *   primary+shift+tab    → focus the previous window
 *
 * `primary` is Ctrl on win32/linux and Cmd on darwin (the ONE platform rule in
 * `platformModifier.ts`). These three are NOT expressible in any declaration grammar, and
 * they are deliberately NOT re-expressed as one: this module is a plain keydown matcher over
 * three fixed chords with a DIRECT call into the shipped seams. There is no place tree, no
 * journal, no dispatch funnel, no verb id, no registry and no host hop — re-introducing any
 * of those is the defect this module exists to avoid.
 *
 * Behaviour (preserved from the shipped engine path):
 *   1. ONE capture-phase `document` keydown listener per webview, reference counted so React
 *      StrictMode's double effect and repeated installs are safe.
 *   2. It matches ONLY these three chords — no bare key, no sequence, no element binding.
 *   3. It is SUPPRESSED (and never calls `preventDefault()`) while focus is `terminal`,
 *      `modal` or `text-entry` (`chordSuppression.ts` precedence:
 *      terminal > modal > text-entry > none). Suppression, not interception: a focused
 *      terminal still receives every keystroke, chord-shaped ones included.
 *   4. On a match it calls `preventDefault()` + `stopPropagation()`, then calls exactly one
 *      shipped seam DIRECTLY:
 *        - `runWindowLauncherToggle()`   (`./launcherToggleSeam`)
 *        - `focusNextWindow()`           (`./traversal`)
 *        - `focusPreviousWindow()`       (`./traversal`)
 *      All three are synchronous void/boolean calls. The dispatch path carries no `await`,
 *      no `async`, no promise and no continuation — the chords stay on the synchronous
 *      keydown path (NFR-1).
 *
 * PURE-ish: the module holds only the install count + listener handle; every decision comes
 * from the injected `KeyboardEvent` and the inspected document.
 */

import { resolvePrimaryModifier, type PrimaryPlatform } from './platformModifier';
import { isChordSuppressed } from './chordSuppression';
import { focusNextWindow, focusPreviousWindow } from './traversal';
import { runWindowLauncherToggle } from './launcherToggleSeam';

/* ───────────────────────────── contract ───────────────────────────── */

/** The three surviving chord identities. */
export type PlatformChordId = 'launcher.toggle' | 'window.focus.next' | 'window.focus.previous';

/** One platform chord: the platform-neutral primary modifier plus a fixed key/shift. */
export interface PlatformChord {
  readonly id: PlatformChordId;
  readonly key: 'space' | 'tab';
  readonly primary: true;
  readonly shift: boolean;
}

/** `primary+space` — toggle the launcher. */
export const PLATFORM_CHORD_LAUNCHER_TOGGLE: PlatformChord = Object.freeze({
  id: 'launcher.toggle',
  key: 'space',
  primary: true,
  shift: false,
});

/** `primary+tab` — focus the next window. */
export const PLATFORM_CHORD_WINDOW_FOCUS_NEXT: PlatformChord = Object.freeze({
  id: 'window.focus.next',
  key: 'tab',
  primary: true,
  shift: false,
});

/** `primary+shift+tab` — focus the previous window. */
export const PLATFORM_CHORD_WINDOW_FOCUS_PREVIOUS: PlatformChord = Object.freeze({
  id: 'window.focus.previous',
  key: 'tab',
  primary: true,
  shift: true,
});

/**
 * The three chords, in declaration order — EXACT sequences, frozen, no re-tuning.
 * The named constants above are the array members (identity, not copies).
 */
export const PLATFORM_CHORDS: readonly PlatformChord[] = Object.freeze([
  PLATFORM_CHORD_LAUNCHER_TOGGLE,
  PLATFORM_CHORD_WINDOW_FOCUS_NEXT,
  PLATFORM_CHORD_WINDOW_FOCUS_PREVIOUS,
]);

/* ───────────────────────────── matching ───────────────────────────── */

/** Canonicalize an event key into one of the two chord keys, or `null`. */
function normalizeChordKey(rawKey: string): 'space' | 'tab' | null {
  if (rawKey === ' ' || rawKey === 'Spacebar') return 'space';
  if (rawKey.toLowerCase() === 'tab') return 'tab';
  return null;
}

/**
 * The chord whose fixed sequence equals this keydown, or `null`.
 *
 * PURE: no document read, no mutation, no side effect — the event is only inspected, so a
 * caller can decide whether to swallow it. `platform` is injectable for determinism.
 *
 * Match rule: `primary` held and the OTHER ctrl/meta modifier NOT held (so Ctrl+Tab and
 * Meta+Tab are distinct chords, never collapsed), no Alt, and the shift flag exactly as the
 * chord declares. Composition/AltGr events never match.
 */
export function matchPlatformChord(
  event: KeyboardEvent,
  platform?: PrimaryPlatform,
): PlatformChord | null {
  if (event.isComposing === true) return null;
  if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) {
    return null;
  }
  const rawKey: unknown = event.key;
  if (typeof rawKey !== 'string' || rawKey.length === 0) return null;
  const key = normalizeChordKey(rawKey);
  if (key === null) return null;
  if (event.altKey === true) return null;

  const primaryMod = resolvePrimaryModifier(platform);
  const primaryHeld = primaryMod === 'ctrl' ? event.ctrlKey === true : event.metaKey === true;
  const otherHeld = primaryMod === 'ctrl' ? event.metaKey === true : event.ctrlKey === true;
  if (!primaryHeld || otherHeld) return null;

  for (const chord of PLATFORM_CHORDS) {
    if (chord.key === key && chord.shift === (event.shiftKey === true)) return chord;
  }
  return null;
}

/* ───────────────────────────── dispatch ───────────────────────────── */

/**
 * Run the ONE outcome a matched chord stands for. A direct synchronous call into the shipped
 * seam — no host, no verb id, no registry hop, no promise.
 */
function dispatchChord(chord: PlatformChord): void {
  switch (chord.id) {
    case 'launcher.toggle':
      runWindowLauncherToggle();
      return;
    case 'window.focus.next':
      focusNextWindow();
      return;
    case 'window.focus.previous':
      focusPreviousWindow();
      return;
  }
}

/** The ONE listener body: suppress first, then match, then swallow + dispatch. */
function handlePlatformKeydown(event: KeyboardEvent): void {
  if (isChordSuppressed()) return;
  const chord = matchPlatformChord(event);
  if (chord === null) return;
  event.preventDefault();
  event.stopPropagation();
  dispatchChord(chord);
}

// ── Install / uninstall (idempotent, reference counted) ─────────────────────

type KeydownFn = (event: KeyboardEvent) => void;

let activeInstalls = 0;
let listener: KeydownFn | null = null;

/**
 * Arm the ONE capture-phase document keydown listener. Idempotent across installs: the first
 * install arms it, the last release removes it. Returns the release function (idempotent per
 * release).
 */
export function installPlatformChords(): () => void {
  if (typeof document === 'undefined') return () => {};
  activeInstalls += 1;
  if (activeInstalls === 1) {
    listener = handlePlatformKeydown;
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

/** Force-remove the listener and reset the reference count (idempotent). */
export function uninstallPlatformChords(): void {
  activeInstalls = 0;
  removeListener();
}

/** True while the ONE platform-chord listener is armed. */
export function isPlatformChordsInstalled(): boolean {
  return activeInstalls > 0;
}

/** Test-only: force-remove the listener and reset the reference count. */
export function resetPlatformChordsForTests(): void {
  uninstallPlatformChords();
}

function removeListener(): void {
  if (listener !== null && typeof document !== 'undefined') {
    document.removeEventListener('keydown', listener, true);
  }
  listener = null;
}
