/**
 * Spec #2959 ST-1 — keyboard mode: the module-scoped, per-webview, TRANSIENT
 * home of the mode flag plus its `document.body` hook (EARS R-1.1…R-1.4).
 *
 * Keyboard mode is toggled by ONE dedicated chord (`ctrl+shift+f8`,
 * `fredo.keyboardMode.toggle`) registered through the shipped registry/engine;
 * this module owns ONLY the state transition + the observable hook. It adds NO
 * `keydown` listener (the ONE engine owns the single document listener) and it
 * NEVER moves focus — entry/exit are pure state writes, so
 * `document.activeElement` is unchanged across a toggle (R-1.4).
 *
 * Like `contextStack.ts:12-16` and `windowStore.ts`, the state is transient
 * module state: per webview, never persisted, no cross-window channel. It
 * deliberately SURVIVES component mount/unmount cycles (module scope, not a
 * `useRef`), so the mode is not lost when a consumer remounts.
 *
 * Observability (ONE owner — G-266): `document.body` carries
 * `data-fredo-keyboard-mode="true"` while ON and the attribute is ABSENT when
 * OFF. The mode-aware visual bar and its action-count hook are ST-3's surface.
 */

import { useSyncExternalStore } from 'react';

// The mode's action id + canonical chord live with the shipped tables
// (`defaults.ts`) and are re-exported here so the mode module is the ONE import
// site for every keyboard-mode name (G-255).
export { KEYBOARD_MODE_ACTION_ID, KEYBOARD_MODE_CHORD } from './defaults';

/** `document.body` — keyboard mode is ON (`"true"`); attribute ABSENT when OFF. */
export const BODY_KEYBOARD_MODE_ATTR = 'data-fredo-keyboard-mode';

// ── Module-scoped state (per webview; transient) ─────────────────────────────

let on = false;

/** `useSyncExternalStore` listeners. */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function setBodyAttr(name: string, value: string | null): void {
  if (typeof document === 'undefined' || !document.body) return;
  const body = document.body;
  if (value === null) {
    if (body.hasAttribute(name)) body.removeAttribute(name);
    return;
  }
  if (body.getAttribute(name) !== value) body.setAttribute(name, value);
}

/** Publish the mode hook; the attribute is ABSENT while OFF (R-1.3). */
function publishBodyHook(active: boolean): void {
  setBodyAttr(BODY_KEYBOARD_MODE_ATTR, active ? 'true' : null);
}

/** The mode's channel-2 signal (icon shape / bar presence are ST-3's surface). */
function publishBodyHookFromState(): void {
  publishBodyHook(on);
}

// ── State transitions (R-1.1 / R-1.2) ────────────────────────────────────────

/**
 * Turn keyboard mode ON for this webview. Idempotent: a second call while
 * already ON is a no-op (no notification, no re-announcement). Never moves focus.
 */
export function enterKeyboardMode(): void {
  if (on) return;
  on = true;
  publishBodyHook(true);
  notify();
}

/**
 * Turn keyboard mode OFF for this webview. Idempotent: a second call while
 * already OFF is a no-op. Never moves focus (R-1.4).
 */
export function exitKeyboardMode(): void {
  if (!on) return;
  on = false;
  publishBodyHook(false);
  notify();
}

/** The engine action's `run`: flip the mode (R-1.1 when OFF, R-1.2 when ON). */
export function toggleKeyboardMode(): void {
  if (on) exitKeyboardMode();
  else enterKeyboardMode();
}

// ── Reads + subscription + React binding ─────────────────────────────────────

/** True while keyboard mode is ON (a stable primitive — safe for deps). */
export function isKeyboardModeOn(): boolean {
  return on;
}

/** Subscribe to mode changes; returns the unsubscribe handle. */
export function subscribeKeyboardMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The live mode flag; re-renders only on a real change. */
export function useKeyboardMode(): boolean {
  return useSyncExternalStore(subscribeKeyboardMode, isKeyboardModeOn, isKeyboardModeOn);
}

// ── Test-only reset ──────────────────────────────────────────────────────────

/** Test-only: drop the module state + hook. Never call from app code. */
export function resetKeyboardModeForTests(): void {
  on = false;
  listeners.clear();
  publishBodyHookFromState();
}
