/**
 * Terminal presentation — thin delegating shim (Spec #2955 ST-2).
 *
 * #2947's Terminal-only presentation store is generalized into
 * `shared/window-system/appPresentationStore.ts` — the ONE per-app source of
 * truth. This module preserves the SAME public names its current importers use
 * (`TerminalEntry.tsx`, `TerminalSettings.tsx`, their tests) so the branch keeps
 * building until ST-3/ST-4 retire the shim.
 *
 * Every function DELEGATES to the generalized store. Do NOT add logic here —
 * the module is scheduled for removal once the Terminal consumers read the
 * store directly.
 *
 * Behavioural note: the Terminal default is now `same-window` (the platform
 * default for every app, Architect decision 1), replacing #2947's `new-window`.
 * The legacy `terminal_presentation_mode` key is honored by the store's one-way
 * first-hydrate migration; `PRESENTATION_MODE_KEY` remains the legacy key name
 * for importers that still reference it.
 */

import {
  DEFAULT_APP_PRESENTATION,
  LEGACY_TERMINAL_PRESENTATION_KEY,
  getAppPresentation,
  hydrateAppPresentation,
  isAppPresentationHydrated,
  normalizeAppPresentation,
  resetAppPresentationStoreForTests,
  setAppPresentation,
  subscribeAppPresentation,
  useAppPresentation,
  type AppPresentation,
} from '../../shared/window-system/appPresentationStore';

/** The Terminal feature id used as its key in the per-app presentation map. */
export const TERMINAL_APP_ID = 'terminal';

/** Terminal presentation mode (alias of the generalized `AppPresentation`). */
export type TerminalPresentation = AppPresentation;

/** Legacy #2947 key — preserved for importers; never written by this shim. */
export const PRESENTATION_MODE_KEY = LEGACY_TERMINAL_PRESENTATION_KEY;

/** Default mode (now the platform default: inside the main Fredo window). */
export const DEFAULT_PRESENTATION: TerminalPresentation = DEFAULT_APP_PRESENTATION;

/** Event name emitted to the active Terminal host to drain a CLI intent. */
export const TERMINAL_INTENT_AVAILABLE_EVENT = 'terminal-intent-available';

/** Normalize any persisted value to a valid mode (absent/unrecognized → default). */
export function normalizePresentationMode(raw: unknown): TerminalPresentation {
  return normalizeAppPresentation(raw);
}

/** Sync module read of the Terminal's effective mode. */
export function getTerminalPresentation(): TerminalPresentation {
  return getAppPresentation(TERMINAL_APP_ID);
}

/** Subscribe to mode changes (useSyncExternalStore listener contract). */
export function subscribeTerminalPresentation(listener: () => void): () => void {
  return subscribeAppPresentation(listener);
}

/** True once the persisted map has been read (the entry hydration gate). */
export function isTerminalPresentationHydrated(): boolean {
  return isAppPresentationHydrated();
}

/** Persist the Terminal's mode (delegates to the generalized store). */
export function setTerminalPresentation(p: TerminalPresentation): Promise<void> {
  return setAppPresentation(TERMINAL_APP_ID, p);
}

/** Hydrate the store from the persisted map (idempotent, once-only). */
export function hydrateTerminalPresentation(): Promise<void> {
  return hydrateAppPresentation();
}

/** React binding — re-renders the consumer when the Terminal's mode changes. */
export function useTerminalPresentation(): TerminalPresentation {
  return useAppPresentation(TERMINAL_APP_ID);
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetTerminalPresentationStoreForTests(): void {
  resetAppPresentationStoreForTests();
}
