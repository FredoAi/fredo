/**
 * BackgroundStore — the single module-scoped source of truth for the user's
 * desktop background selection (Spec #2899 ST-2).
 *
 * The selection must be shared across separately-mounted consumers: the
 * shell-level `DesktopBackdrop` layer and the Settings → Appearance chooser
 * (`BackgroundSettings`), which live in different React trees. A per-instance
 * `useState`/`useRef` would diverge across those trees (and a ref resets on
 * every unmount — AGENTS persistence rule), so the selection lives at MODULE
 * scope and both consumers reach it through `useSyncExternalStore`, mirroring
 * `dockPositionStore.ts:26-118` and the `windowStore.ts` pattern.
 *
 * Persistence: the descriptor id **string only** (colors are never persisted —
 * they are re-derived from the live theme CSS vars at render time) under the
 * `Fredo_desktop_background` key via `settingsService` (Tauri
 * `save_setting`/`get_setting` → AppStore SQLite KV, with a localStorage mirror
 * for the Vite dev server). The value is stored as the raw string (NOT
 * JSON-quoted) — `settingsService.set` passes strings through `serializeValue`
 * unquoted (`features/settings/index.tsx:90-95`).
 *
 * Normalization is LENIENT: any unknown/stale/malformed stored value is coerced
 * to `'none'` (the safe, shipped default) via the registry guard — never throw,
 * never render an unstyled desktop (AC3).
 *
 * Hydration is IDEMPOTENT (once) and DIRTY-GUARDED: `settingsService.get`
 * resolves a stored value only before the first user write; after the first
 * `selectBackground` the store is dirty and hydration becomes a no-op, so an
 * in-flight async read can never overwrite an in-flight user selection.
 */

import { useSyncExternalStore } from 'react';
import { settingsService } from '../../../settings';
import { isBackgroundId, type BackgroundId } from './backgroundRegistry';

/** AppSettings key (backend AppStore SQLite KV + localStorage mirror). */
export const BACKGROUND_SETTING_KEY = 'Fredo_desktop_background';
/** Default for existing installs / never-saved state — today's clean desktop. */
export const DEFAULT_BACKGROUND_ID: BackgroundId = 'none';

let backgroundId: BackgroundId = DEFAULT_BACKGROUND_ID;
const listeners = new Set<() => void>();
/** True once the user has written the store — `selectBackground` wins over a
 *  still-in-flight async hydration read. */
let dirty = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Coerce any persisted/selected value to a known `BackgroundId`. Any unknown,
 * stale, empty, or malformed value degrades to the safe default (`'none'`) —
 * never throws, never leaves the desktop unstyled.
 */
function normalizeBackgroundId(raw: unknown): BackgroundId {
  return typeof raw === 'string' && isBackgroundId(raw) ? raw : DEFAULT_BACKGROUND_ID;
}

/** Sync module read of the current background id. */
export function getBackgroundId(): BackgroundId {
  return backgroundId;
}

/** Subscribe to selection changes (useSyncExternalStore listener contract). */
export function subscribeBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Update the selection synchronously (notify subscribers immediately so a
 * mounted backdrop repaints on the same tick), then persist the normalized id
 * via `settingsService`. The store write is synchronous + optimistic; the
 * persistence is awaited by the caller and failures are swallowed (dev server
 * has no Tauri host — the localStorage mirror is the fallback).
 */
export async function selectBackground(raw: string): Promise<void> {
  dirty = true;
  const next = normalizeBackgroundId(raw);
  if (backgroundId !== next) {
    backgroundId = next;
    notify();
  }
  try {
    await settingsService.set(BACKGROUND_SETTING_KEY, next);
  } catch {
    // Persistence is best-effort — the module store already moved (dev server
    // has no Tauri host; the localStorage mirror is the fallback).
  }
}

/**
 * Hydrate the store from the persisted setting. Idempotent + runs ONCE (module
 * scope, not per-consumer-mount): a second call is a no-op after the first
 * completion. It never overwrites an in-flight user selection — once the store
 * is dirty (a `selectBackground` happened), hydration is skipped.
 */
let hydrationStarted = false;
export async function hydrateBackground(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const stored = await settingsService.get<string>(
      BACKGROUND_SETTING_KEY,
      DEFAULT_BACKGROUND_ID,
    );
    if (dirty) return; // user already chose — never clobber
    const next = normalizeBackgroundId(stored);
    if (next !== backgroundId) {
      backgroundId = next;
      notify();
    }
  } catch {
    // Tauri absent / read failure → stay on the default (jsdom: localStorage
    // fallback yields nothing → 'none').
  }
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetBackgroundStoreForTests(): void {
  backgroundId = DEFAULT_BACKGROUND_ID;
  dirty = false;
  hydrationStarted = false;
  listeners.clear();
}

/** React binding — re-renders the consumer when the selection changes. */
export function useBackgroundId(): BackgroundId {
  return useSyncExternalStore(subscribeBackground, getBackgroundId, getBackgroundId);
}
