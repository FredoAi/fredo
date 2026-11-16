/**
 * Spec #3122 (P8), ST-1 — terminal passthrough (focus-derived), relocated out of the retired
 * hotkey runtime into the navigation layer.
 *
 * WHILE a terminal session has keyboard focus EVERY keystroke reaches the PTY and dispatch
 * is suspended (the focus-context suppression in `globalKeys.ts`). The dedicated exit chord
 * and its release button are retired — the keyboard is released by click-away / focus change,
 * which re-derives passthrough from the ONE focus classifier (`navigation/focusContext.ts`).
 *
 * Scope discipline:
 *  - This module adds NO `document` keydown listener (the ONE navigation chord listener lives
 *    in `globalKeys.ts`).
 *  - It adds ONLY focus tracking (`focusin`/`focusout`), the `data-fredo-passthrough` body
 *    hook, and the one-time navigation announcement.
 */

import { announceNavigation } from './announce';
import { classifyFocusContext } from '../focusContext';
import type { FocusContext } from '../types';

/** The terminal root the focus classifier keys on. */
export const TERMINAL_ROOT_SELECTOR = '[data-fredo-terminal-root="true"]';

/** `document.body` — terminal passthrough is active. */
export const BODY_PASSTHROUGH_ATTR = 'data-fredo-passthrough';

/** The one-time announcement copy on entry. */
export const PASSTHROUGH_ANNOUNCEMENT_PREFIX =
  'Terminal passthrough active. Keys go to the shell; click away to return.';

// ── Module-scoped state ──────────────────────────────────────────────────────

let installed = false;
let passthroughActive = false;
let focusInListener: (() => void) | null = null;
let focusOutListener: (() => void) | null = null;
let syncScheduled = false;

/** True while terminal passthrough is active. */
export function isPassthroughActive(): boolean {
  return passthroughActive;
}

function setPassthrough(active: boolean): void {
  if (passthroughActive === active) return;
  passthroughActive = active;
  if (active) announceNavigation(PASSTHROUGH_ANNOUNCEMENT_PREFIX);
}

/** The classification of the current focus (identical to the shipped `computeFocusContext`). */
function currentFocusContext(): FocusContext {
  if (typeof document === 'undefined') return 'default';
  const active = document.activeElement;
  const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
  return classifyFocusContext(active, { modalOpen });
}

/** True when the focused element is inside a terminal root. */
export function isTerminalFocused(): boolean {
  return currentFocusContext() === 'terminal';
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
 * Re-derive passthrough from the focused element and publish it. Returns the resolved state.
 * Only a REAL transition announces — repeated focus moves inside the terminal are no-ops.
 */
export function syncTerminalPassthrough(): boolean {
  const active = isTerminalFocused();
  syncBodyHook(active);
  setPassthrough(active);
  return active;
}

// ── Install / uninstall ──────────────────────────────────────────────────────

/**
 * Coalesce a focus-driven recompute onto a microtask so an intra-terminal focus move
 * (focusout → focusin) never flaps passthrough false→true or re-announces.
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
 * Install terminal passthrough tracking for this webview. Idempotent and adds NO `keydown`
 * listener: the key path stays entirely owned by the ONE navigation chord dispatcher.
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
}
