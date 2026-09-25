/**
 * Spec #2946 ST-12 — terminal passthrough mode, end-to-end (EARS R-5.7, R-5.8).
 *
 * WHILE a terminal session has keyboard focus EVERY keystroke (including modifier
 * chords) reaches the PTY and dispatch is suspended — EXCEPT the single
 * designated exit-passthrough binding (`ctrl+shift+f10`,
 * `fredo.terminal.exitPassthrough`), which leaves passthrough and MUST NOT reach
 * the PTY. WHILE passthrough is active a persistent, non-colour-only indicator
 * names the exit chord and the state is announced once to assistive technology
 * on entry.
 *
 * Scope discipline (capsule non-goals):
 *  - This module adds NO `document` keydown listener. The keydown decision lives
 *    in the ST-4 engine (`engine.ts` → `decideDispatch`, R-5.7); this module adds
 *    ONLY focus tracking (`focusin`/`focusout`), the exit-chord handler
 *    registration, the `data-fredo-passthrough` body hook, the one-time
 *    announcement, and the React binding the indicator consumes.
 *  - It never calls `preventDefault()` — the engine consumes the exit chord, and
 *    every other key is left native so the PTY path stays interception-free.
 *  - It does not touch `SessionTerminal`'s ghostty init / fit / `term.onData` →
 *    `write_pty_input` behaviour; the terminal root attribute added there is the
 *    only terminal-side anchor this module reads.
 *
 * The passthrough state itself lives in the ST-2 store's transient slot
 * (`setPassthrough`/`isPassthroughActive`) so the indicator is a single
 * `useSyncExternalStore` subscriber and the state is shared with the engine's
 * `data-fredo-passthrough` mirror. Detection is derived from the ONE focus
 * classifier (`computeFocusContext`), so the indicator can never disagree with
 * the engine about which context owns the keyboard.
 */

import { useSyncExternalStore } from 'react';

import { announce } from './announcer';
import { MINIMAL_DEFAULT_BINDINGS } from './defaults';
import { computeFocusContext } from './engine';
import { accessibleSequence, parseSequence } from './keys';
import { registerHotkeyHandler } from './registry';
import {
  getBinding,
  isPassthroughActive,
  setPassthrough,
  subscribeHotkeys,
  useHotkeyBinding,
} from './store';
import { TERMINAL_EXIT_ACTION_ID } from './types';

/** The terminal root the ST-4 classifier keys on (contract block 7). */
export const TERMINAL_ROOT_SELECTOR = '[data-fredo-terminal-root="true"]';

/** The real button an AT user can activate even mid-passthrough (UI/UX §6). */
export const TERMINAL_RELEASE_TESTID = 'hotkeys-terminal-passthrough-exit';

/** `document.body` — terminal passthrough is active (contract block 7). */
export const BODY_PASSTHROUGH_ATTR = 'data-fredo-passthrough';

/** The persistent indicator's testids (UI/UX §6 / contract block 7). */
export const TERMINAL_PASSTHROUGH_TESTID = 'hotkeys-terminal-passthrough';

/** The announcement prefix (R-5.8) — exported so tests pin the exact copy. */
export const PASSTHROUGH_ANNOUNCEMENT_PREFIX = 'Terminal passthrough active.';

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** The effective serialized exit chord (the user's rebind, else the shipped default). */
export function getTerminalExitChord(): string | null {
  const configured = getBinding(TERMINAL_EXIT_ACTION_ID);
  if (configured.length > 0) return configured[0] ?? null;
  const shipped = MINIMAL_DEFAULT_BINDINGS[TERMINAL_EXIT_ACTION_ID];
  return shipped && shipped.length > 0 ? (shipped[0] ?? null) : null;
}

/** True when the focused element is inside a terminal root (R-5.7). */
export function isTerminalFocused(): boolean {
  if (typeof document === 'undefined') return false;
  return computeFocusContext() === 'terminal';
}

/** The one-time entry announcement copy (R-5.8), e.g. `…Press Control plus Shift plus F 10…`. */
export function passthroughAnnouncementText(chord: string | null): string {
  if (!chord) {
    return `${PASSTHROUGH_ANNOUNCEMENT_PREFIX} Press the release chord to release the keyboard.`;
  }
  const spoken = accessibleSequence(parseSequence(chord));
  return `${PASSTHROUGH_ANNOUNCEMENT_PREFIX} Press ${spoken} to release the keyboard.`;
}

/** The real release `<button>` when the indicator is mounted. */
export function getReleaseButton(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-testid="${TERMINAL_RELEASE_TESTID}"]`);
}

// ── The body hook (shared with the engine's keydown mirror) ──────────────────

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

// ── State transitions ────────────────────────────────────────────────────────

/**
 * Re-derive passthrough from the focused element and publish it. Returns the
 * resolved state. Only a REAL transition notifies the store and (on entry)
 * announces — repeated focus moves inside the terminal are no-ops.
 */
export function syncTerminalPassthrough(): boolean {
  const active = isTerminalFocused();
  syncBodyHook(active);
  if (active !== isPassthroughActive()) {
    setPassthrough(active);
    if (active) announce(passthroughAnnouncementText(getTerminalExitChord()));
  }
  return active;
}

/**
 * Leave passthrough (R-5.7). Moves focus to the persistent release button — a
 * predictable place still inside the terminal WINDOW but OUTSIDE the terminal
 * SESSION root — so the classifier immediately stops reporting `terminal` and
 * dispatch resumes. The exit chord is consumed by the engine before its handler
 * runs, so it never reaches the PTY.
 */
export function exitTerminalPassthrough(): void {
  const button = getReleaseButton();
  if (button) {
    button.focus();
  } else if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    // No indicator mounted: blur the terminal so focus leaves the root.
    document.activeElement.blur();
  }
  syncTerminalPassthrough();
}

// ── Install / uninstall ──────────────────────────────────────────────────────

let installed = false;
let focusInListener: (() => void) | null = null;
let focusOutListener: (() => void) | null = null;
let syncScheduled = false;

/**
 * Coalesce a focus-driven recompute onto a microtask. A focus move between two
 * elements INSIDE the terminal root fires `focusout` (whose `activeElement`
 * reads as `body`) and then `focusin`; recomputing synchronously would flap
 * passthrough false→true and re-announce. Deferring lets focus settle, so an
 * intra-terminal move is a no-op and only a real entry/exit announces.
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
 * Install terminal passthrough tracking for this webview. Idempotent (React
 * StrictMode's double effect is safe) and adds NO `keydown` listener: the key
 * path stays entirely owned by the ONE ST-4 engine.
 *
 * The registered `fredo.terminal.exitPassthrough` handler overrides the engine's
 * no-op default run with the real release behaviour.
 */
export function installTerminalPassthrough(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (installed) return uninstallTerminalPassthrough;
  installed = true;

  registerHotkeyHandler(TERMINAL_EXIT_ACTION_ID, () => exitTerminalPassthrough());

  focusInListener = () => {
    scheduleSync();
  };
  focusOutListener = () => {
    scheduleSync();
  };
  document.addEventListener('focusin', focusInListener, true);
  document.addEventListener('focusout', focusOutListener, true);

  // Seed the current state — a terminal focused before install still announces.
  syncTerminalPassthrough();
  return uninstallTerminalPassthrough;
}

/** Remove the focus tracking + restore the exit action's declared run (idempotent). */
export function uninstallTerminalPassthrough(): void {
  if (!installed) return;
  installed = false;

  if (focusInListener) document.removeEventListener('focusin', focusInListener, true);
  if (focusOutListener) document.removeEventListener('focusout', focusOutListener, true);
  focusInListener = null;
  focusOutListener = null;

  registerHotkeyHandler(TERMINAL_EXIT_ACTION_ID, null);

  if (isPassthroughActive()) setPassthrough(false);
  syncBodyHook(false);
}

/** True while terminal passthrough tracking is installed in this webview. */
export function isTerminalPassthroughInstalled(): boolean {
  return installed;
}

/** Test-only: uninstall + drop the passthrough state and body hook. */
export function resetTerminalModeForTests(): void {
  uninstallTerminalPassthrough();
  if (isPassthroughActive()) setPassthrough(false);
  syncBodyHook(false);
}

// ── React binding for the persistent indicator ───────────────────────────────

/** The indicator's live state: `active` + the exit chord it must name (R-5.8). */
export interface TerminalPassthroughState {
  readonly active: boolean;
  readonly exitChord: string | null;
}

/** Subscribe the persistent indicator to the shared passthrough state. */
export function useTerminalPassthrough(): TerminalPassthroughState {
  const active = useSyncExternalStore(subscribeHotkeys, isPassthroughActive, isPassthroughActive);
  const binding = useHotkeyBinding(TERMINAL_EXIT_ACTION_ID);
  const exitChord =
    binding.length > 0
      ? (binding[0] ?? null)
      : (MINIMAL_DEFAULT_BINDINGS[TERMINAL_EXIT_ACTION_ID]?.[0] ?? null);
  return { active, exitChord };
}
