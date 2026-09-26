/**
 * TerminalPresentationStore — the single module-scoped source of truth for the
 * Terminal presentation mode (Spec #2947 ST-1).
 *
 * The mode is shared across separately-mounted consumers: the Settings →
 * Terminal "Presentation" control (Settings app shell) and the Terminal entry /
 * workspace (Home grid tree). A per-instance state hook would diverge across
 * those trees, so — per the AGENTS module-scoped-state rule — the mode lives at
 * MODULE scope (mirroring `dockPositionStore.ts` / `windowStore.ts`) and every
 * consumer reaches it through `useSyncExternalStore`.
 *
 * Persistence: the raw string `'same-window' | 'new-window'` under the
 * `terminal_presentation_mode` key via `settingsService` (Tauri
 * `save_setting`/`get_setting` → AppStore SQLite KV, with a localStorage mirror
 * for the Vite dev server). The value is stored as the raw string (NOT
 * JSON-quoted) — `settingsService.set` passes strings through `serializeValue`
 * unquoted (`features/settings/index.tsx`).
 *
 * Hydration is IDEMPOTENT (once) and DIRTY-GUARDED: `settingsService.get` may
 * resolve after the user has already chosen, so once the store is dirty a
 * late-arriving persisted value can never clobber the user's selection (R-1.2 /
 * R-4.1). An absent/unrecognized value normalizes to `new-window` (R-4.1).
 */

import { useSyncExternalStore } from 'react';
import { settingsService } from '../settings';

/** Terminal presentation: inside the main Fredo window or its own native window. */
export type TerminalPresentation = 'same-window' | 'new-window';
/** AppSettings key (backend AppStore SQLite KV + localStorage mirror). */
export const PRESENTATION_MODE_KEY = 'terminal_presentation_mode';
/** Default mode for existing installs / never-saved / unrecognized state (R-4.1). */
export const DEFAULT_PRESENTATION: TerminalPresentation = 'new-window';
/** Event name emitted to the active Terminal host to drain a CLI intent. */
export const TERMINAL_INTENT_AVAILABLE_EVENT = 'terminal-intent-available';

let presentation: TerminalPresentation = DEFAULT_PRESENTATION;
/** True once hydration has settled (success or failure) — the bounded hold flag. */
let hydrated = false;
/** Guards against a second concurrent hydration read (module-scope once-only). */
let hydrationStarted = false;
/** True once the user (or hydration) has written the store — user writes win. */
let dirty = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Normalize any persisted value to a valid mode. Absent / unrecognized values
 * fall back to `new-window` (R-4.1) — never throws, never fails.
 *
 * FS-2 (#2947 round 2): a STRING input is trimmed before the exact compare,
 * mirroring `TerminalPresentation::parse` in
 * `apps/tauri/src-tauri/src/features/terminal/state.rs` (`raw.trim()`, unit-pinned
 * by `presentation_parse_trims_surrounding_whitespace`). Both sides must resolve
 * the same wire value: `" same-window "` is recognized as `same-window` on
 * BOTH the frontend and the backend (R-4.1 consistency). Non-string inputs are
 * never coerced.
 */
export function normalizePresentationMode(raw: unknown): TerminalPresentation {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  return value === 'same-window'
    ? 'same-window'
    : value === 'new-window'
      ? 'new-window'
      : DEFAULT_PRESENTATION;
}

/** Sync module read of the current mode. */
export function getTerminalPresentation(): TerminalPresentation {
  return presentation;
}

/** Subscribe to mode changes (useSyncExternalStore listener contract). */
export function subscribeTerminalPresentation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True once the persisted mode has been read (the entry hydration gate). */
export function isTerminalPresentationHydrated(): boolean {
  return hydrated;
}

/**
 * Update the mode synchronously (notify subscribers immediately so a mounted
 * consumer re-renders on the same tick), then persist via `settingsService`.
 * The store write is synchronous + optimistic; persistence is best-effort and
 * failures are swallowed (the Vite dev server has no Tauri host — the
 * localStorage mirror is the fallback).
 */
export async function setTerminalPresentation(p: TerminalPresentation): Promise<void> {
  dirty = true;
  if (presentation !== p) {
    presentation = p;
    notify();
  }
  try {
    await settingsService.set(PRESENTATION_MODE_KEY, p);
  } catch {
    // Persistence is best-effort — the module store already moved.
  }
}

/**
 * Hydrate the store from the persisted setting. Idempotent + runs ONCE (module
 * scope, not per-consumer-mount): a second call is a no-op after the first
 * starts. It never overwrites an in-flight user selection — once the store is
 * dirty (a `setTerminalPresentation` happened), hydration is skipped. The
 * `hydrated` flag is always set in `finally`, so the entry hydration gate is
 * bounded even when the read fails.
 */
export async function hydrateTerminalPresentation(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const stored = await settingsService.get<string>(
      PRESENTATION_MODE_KEY,
      DEFAULT_PRESENTATION,
    );
    if (!dirty) {
      const next = normalizePresentationMode(stored);
      if (next !== presentation) {
        presentation = next;
        notify();
      }
    }
  } catch {
    // Tauri absent / read failure → stay on the default.
  } finally {
    hydrated = true;
    notify();
  }
}

/** React binding — re-renders the consumer when the mode changes. */
export function useTerminalPresentation(): TerminalPresentation {
  return useSyncExternalStore(
    subscribeTerminalPresentation,
    getTerminalPresentation,
    getTerminalPresentation,
  );
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetTerminalPresentationStoreForTests(): void {
  presentation = DEFAULT_PRESENTATION;
  hydrated = false;
  hydrationStarted = false;
  dirty = false;
  listeners.clear();
}
