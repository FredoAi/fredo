/**
 * Spec #3009 — the shared hotkey STATUS store.
 *
 * After #3009 there is no persisted keymap to hydrate and no macros/pending
 * candidates to project. The only shared React-facing state is whether element
 * hotkeys are SUPPRESSED right now (focus in a text-entry control or a terminal
 * session) — surfaced by the always-on bar's disabled rows.
 *
 * The engine publishes it (`setHotkeysDisabled`) from the ONE focus derivation;
 * the bar/palette read it through `useHotkeysDisabled` / `useHotkeyRevision`.
 *
 * `getKeymap` remains only as the launcher palette's compatibility view (the
 * palette asks for "configured bindings" per action). With the config model
 * gone it always reports no overrides, so the palette falls back to each
 * action's declared `defaultSequence`.
 *
 * Module-scoped store (mirrors `dockPositionStore.ts`): module `let`, listener
 * `Set`, `useSyncExternalStore`, `reset…ForTests`.
 */

import { useSyncExternalStore } from 'react';

let disabled = false;
let revision = 0;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe to any hotkey-status change. */
export function subscribeHotkeyStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Back-compat alias for the single status subscription. */
export const subscribeHotkeys = subscribeHotkeyStatus;

/** The monotonic status revision — advances only on a real change. */
export function getHotkeyRevision(): number {
  return revision;
}

/** True while element hotkeys are suppressed (text-entry / terminal focus). */
export function getHotkeysDisabled(): boolean {
  return disabled;
}

/** Publish the suppressed state (idempotent — a same-value write is a no-op). */
export function setHotkeysDisabled(next: boolean): void {
  if (disabled === next) return;
  disabled = next;
  revision += 1;
  notify();
}

// ── Launcher-palette compatibility view ──────────────────────────────────────

/** The launcher palette's keymap view (`bindings` overrides; empty after #3009). */
export interface HotkeyKeymapView {
  readonly bindings: Readonly<Record<string, readonly string[]>>;
}

const EMPTY_BINDINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({});
const EMPTY_KEYMAP: HotkeyKeymapView = Object.freeze({ bindings: EMPTY_BINDINGS });

/**
 * The launcher palette's read of "configured bindings". #3009 retired every
 * override, so this is always the empty map — the palette falls back to each
 * action's declared default sequence (see `buildLauncherActionEntries`).
 */
export function getKeymap(): HotkeyKeymapView {
  return EMPTY_KEYMAP;
}

// ── React bindings ───────────────────────────────────────────────────────────

/** Re-renders only when the suppressed state actually changes. */
export function useHotkeysDisabled(): boolean {
  return useSyncExternalStore(subscribeHotkeyStatus, getHotkeysDisabled, getHotkeysDisabled);
}

/** Re-renders only when the status revision changes. */
export function useHotkeyRevision(): number {
  return useSyncExternalStore(subscribeHotkeyStatus, getHotkeyRevision, getHotkeyRevision);
}

/** Test-only: wipe the module-scoped status store. */
export function resetHotkeyStatusForTests(): void {
  disabled = false;
  revision = 0;
  listeners.clear();
}

/** Test-only alias kept for callers that still name the old store. */
export const resetKeymapStoreForTests = resetHotkeyStatusForTests;
