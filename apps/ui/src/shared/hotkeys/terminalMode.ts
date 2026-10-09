/**
 * Spec #3009 ST-4 — terminal passthrough (focus-derived).
 *
 * WHILE a terminal session has keyboard focus EVERY keystroke reaches the PTY and
 * dispatch is suspended (the engine's terminal branch). The dedicated exit chord
 * (`ctrl+shift+f10`) and its release button are REMOVED — the keyboard is
 * released by click-away / focus change, which re-derives passthrough from the
 * ONE focus classifier (`computeFocusContext`).
 *
 * Scope discipline:
 *  - This module adds NO `document` keydown listener (the engine owns the ONE).
 *  - It adds ONLY focus tracking (`focusin`/`focusout`), the `data-fredo-passthrough`
 *    body hook, the one-time announcement, and the React binding the passthrough
 *    indicator consumes.
 */

import { useSyncExternalStore } from 'react';

import { announce } from './announcer';
import { computeFocusContext } from './engine';

/** The terminal root the focus classifier keys on. */
export const TERMINAL_ROOT_SELECTOR = '[data-fredo-terminal-root="true"]';

/** `document.body` — terminal passthrough is active. */
export const BODY_PASSTHROUGH_ATTR = 'data-fredo-passthrough';

/** The persistent indicator's testid. */
export const TERMINAL_PASSTHROUGH_TESTID = 'hotkeys-terminal-passthrough';

/** The one-time announcement copy on entry. */
export const PASSTHROUGH_ANNOUNCEMENT_PREFIX =
  'Terminal passthrough active. Keys go to the shell; click away to return.';

// ── Module-scoped state ──────────────────────────────────────────────────────

let installed = false;
let passthroughActive = false;
let focusInListener: (() => void) | null = null;
let focusOutListener: (() => void) | null = null;
let syncScheduled = false;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribePassthrough(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while terminal passthrough is active. */
export function isPassthroughActive(): boolean {
  return passthroughActive;
}

function setPassthrough(active: boolean): void {
  if (passthroughActive === active) return;
  passthroughActive = active;
  notify();
  if (active) announce(PASSTHROUGH_ANNOUNCEMENT_PREFIX);
}

/** True when the focused element is inside a terminal root. */
export function isTerminalFocused(): boolean {
  if (typeof document === 'undefined') return false;
  return computeFocusContext() === 'terminal';
}

// ── The body hook ────────────────────────────────────────────────────────────

function syncBodyHook(active: boolean): void {
  if (typeof document === 'undefined' || !document.body) return;
  const body = document.body;
  if (active) {
    if (body.getAttribute(BODY_PASSTHROUGH_ATTR) !== 'true') {
      body.setAttribute(BODY_PASSTHROUGH_ATTR, 'true');
    }
    return;
  }
  if (body.hasAttribute(BODY_PASSTHROUGH_ATTR)) body.removeAttribute(BODY_PASSTHROUGH_ATTR);
}

/**
 * Re-derive passthrough from the focused element and publish it. Returns the
 * resolved state. Only a REAL transition notifies the store and (on entry)
 * announces — repeated focus moves inside the terminal are no-ops.
 */
export function syncTerminalPassthrough(): boolean {
  const active = isTerminalFocused();
  syncBodyHook(active);
  setPassthrough(active);
  return active;
}

// ── Install / uninstall ──────────────────────────────────────────────────────

/**
 * Coalesce a focus-driven recompute onto a microtask so an intra-terminal focus
 * move (focusout → focusin) never flaps passthrough false→true or re-announces.
 */
function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    if (!installed) return;
    syncTerminalPassthrough();
  });
}

/**
 * Install terminal passthrough tracking for this webview. Idempotent and adds NO
 * `keydown` listener: the key path stays entirely owned by the ONE engine.
 */
export function installTerminalPassthrough(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (installed) return uninstallTerminalPassthrough;
  installed = true;

  focusInListener = () => scheduleSync();
  focusOutListener = () => scheduleSync();
  document.addEventListener('focusin', focusInListener, true);
  document.addEventListener('focusout', focusOutListener, true);

  syncTerminalPassthrough();
  return uninstallTerminalPassthrough;
}

/** Remove the focus tracking + drop the passthrough state (idempotent). */
export function uninstallTerminalPassthrough(): void {
  if (!installed) return;
  installed = false;

  if (focusInListener) document.removeEventListener('focusin', focusInListener, true);
  if (focusOutListener) document.removeEventListener('focusout', focusOutListener, true);
  focusInListener = null;
  focusOutListener = null;

  setPassthrough(false);
  syncBodyHook(false);
}

/** True while terminal passthrough tracking is installed in this webview. */
export function isTerminalPassthroughInstalled(): boolean {
  return installed;
}

/** Test-only: uninstall + drop the passthrough state and body hook. */
export function resetTerminalModeForTests(): void {
  uninstallTerminalPassthrough();
  setPassthrough(false);
  syncBodyHook(false);
  listeners.clear();
}

// ── React binding for the persistent indicator ───────────────────────────────

/** The indicator's live state. */
export interface TerminalPassthroughState {
  readonly active: boolean;
}

/** Subscribe the persistent indicator to the passthrough state. */
export function useTerminalPassthrough(): TerminalPassthroughState {
  const active = useSyncExternalStore(subscribePassthrough, isPassthroughActive, isPassthroughActive);
  return { active };
}
