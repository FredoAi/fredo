/**
 * Spec #2946 ST-2 — the module-scoped keymap store (contract block 6).
 *
 * Mirrors the established `dockPositionStore.ts` pattern (module `let`, listener
 * `Set`, `useSyncExternalStore`, idempotent + dirty-guarded hydrate,
 * `reset…ForTests`), but the state is the FULL keymap document plus the transient
 * engine state (pending sequence + candidates, macro recording, passthrough).
 *
 * Rendering contract: `revision` is a monotonic counter that advances ONLY on a
 * real keymap mutation — it is the single render-affecting primitive. Transient
 * changes notify subscribers WITHOUT bumping the revision, so:
 *   - `useHotkeyRevision()` re-renders only on a real keymap change (stable number
 *     equality on transient notifications is a React no-op),
 *   - `useHotkeyCandidates()` re-renders only when the candidate array identity
 *     actually changes (the array is a frozen singleton when idle).
 * No `.length`/fresh-object dependencies, hence no re-render loop (#523).
 *
 * Writes are OPTIMISTIC then persisted: the in-memory document moves + notifies
 * immediately, the document is written via `persistence.saveKeymap`, and a write
 * failure reverts the in-memory change and rethrows so the caller can surface a
 * `role="alert"` (R-4.3, reliability prose).
 *
 * The backend `AppStore` KV is the single writer; each webview holds this read
 * snapshot (hydrated on mount / re-hydrated on window focus by the app shell).
 */

import { useSyncExternalStore } from 'react';
import { createDefaultBindingMap, createDefaultKeymap, getDefaultBinding, loadKeymap, saveKeymap } from './persistence';
import {
  type HotkeyActionId,
  type HotkeyCandidate,
  type HotkeyEvent,
  type HotkeyResetReason,
  type PersistedKeymap,
  type PersistedMacro,
  type PersistedRawMacro,
} from './types';

const EMPTY_BINDINGS: readonly string[] = Object.freeze([]);
const EMPTY_CANDIDATES: readonly HotkeyCandidate[] = Object.freeze([]);

let keymap: PersistedKeymap = createDefaultKeymap();
let revision = 0;
let dirty = false;
let hydrationStarted = false;

/** `useSyncExternalStore` listeners (revision + transient state changes). */
const listeners = new Set<() => void>();
const eventListeners = new Set<(event: HotkeyEvent) => void>();

// ── Transient engine state (per-webview; never persisted) ─────────────────────
let candidates: readonly HotkeyCandidate[] = EMPTY_CANDIDATES;
let pendingPrefix: string | null = null;
let recordingActive = false;
let recordingMacroId: string | null = null;
let recordingStartedAt: number | null = null;
let passthroughActive = false;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function bumpRevision(): void {
  revision += 1;
  notify();
}

function emitHotkeyEvent(event: HotkeyEvent): void {
  for (const listener of [...eventListeners]) listener(event);
}

function keymapEquals(a: PersistedKeymap, b: PersistedKeymap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Subscription API ──────────────────────────────────────────────────────────

/** Subscribe to any store change (revision or transient). `useSyncExternalStore` source. */
export function subscribeHotkeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to the in-process `HotkeyEvent` stream (NOT Tauri IPC). */
export function subscribeHotkeyEvents(listener: (event: HotkeyEvent) => void): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/** The monotonic keymap revision — advances only on a real mutation. */
export function getHotkeyRevision(): number {
  return revision;
}

// ── Synchronous reads ─────────────────────────────────────────────────────────

/** The current keymap document (read snapshot; treat as immutable). */
export function getKeymap(): PersistedKeymap {
  return keymap;
}

/** The effective sequences for one action (`[]` when unbound / unknown). */
export function getBinding(actionId: HotkeyActionId): readonly string[] {
  return keymap.bindings[actionId] ?? EMPTY_BINDINGS;
}

/** The pending which-key candidates (`[]` when idle — a stable frozen singleton). */
export function getHotkeyCandidates(): readonly HotkeyCandidate[] {
  return candidates;
}

/** The serialized pending prefix, or `null` when idle. */
export function getPendingSequence(): string | null {
  return pendingPrefix;
}

export interface MacroRecordingState {
  readonly recording: boolean;
  readonly macroId: string | null;
  readonly startedAt: number | null;
}

/** The current raw-recording state (per-webview view). */
export function getMacroRecordingState(): MacroRecordingState {
  return { recording: recordingActive, macroId: recordingMacroId, startedAt: recordingStartedAt };
}

export function isMacroRecording(): boolean {
  return recordingActive;
}

export function isPassthroughActive(): boolean {
  return passthroughActive;
}

// ── Optimistic write-through ──────────────────────────────────────────────────

/**
 * Apply a candidate keymap optimistically (R-4.3): move the in-memory document,
 * bump the revision and notify immediately, then persist. A persistence failure
 * reverts to the previous document, notifies, and rethrows.
 *
 * A no-op (deep-equal) document neither advances the revision nor writes.
 */
export async function applyKeymap(next: PersistedKeymap): Promise<void> {
  if (keymapEquals(keymap, next)) return;
  const previous = keymap;
  keymap = next;
  dirty = true;
  bumpRevision();
  emitHotkeyEvent({ type: 'keymap:changed', revision });
  try {
    await saveKeymap(next);
  } catch (error) {
    keymap = previous;
    bumpRevision();
    emitHotkeyEvent({ type: 'keymap:changed', revision });
    throw error;
  }
}

/** Rebind one action (optimistic; `[]` unbinds). */
export async function setBinding(
  actionId: HotkeyActionId,
  sequences: readonly string[],
): Promise<void> {
  await applyKeymap({
    ...keymap,
    bindings: { ...keymap.bindings, [actionId]: [...sequences] },
  });
}

/** Unbind one action. */
export async function clearBinding(actionId: HotkeyActionId): Promise<void> {
  await setBinding(actionId, []);
}

/** Reset one action to its shipped default (R-4.4). */
export async function resetBinding(actionId: HotkeyActionId): Promise<void> {
  await setBinding(actionId, getDefaultBinding(actionId));
}

/**
 * Reset every binding to the shipped defaults (R-4.4). User-defined macros are
 * KEPT — only their triggers become unbound.
 */
export async function resetAllBindings(): Promise<void> {
  await applyKeymap({
    ...keymap,
    bindings: createDefaultBindingMap(),
    macros: keymap.macros.map((macro) => (macro.trigger === null ? macro : { ...macro, trigger: null })),
    rawMacros: keymap.rawMacros.map((macro) =>
      macro.trigger === null ? macro : { ...macro, trigger: null },
    ),
  });
}

export async function setLeader(leader: string | null): Promise<void> {
  await applyKeymap({ ...keymap, leader });
}

export async function setVimPresetEnabled(enabled: boolean): Promise<void> {
  await applyKeymap({ ...keymap, vimPresetEnabled: enabled });
}

export async function setSequenceTimeoutMs(timeoutMs: number): Promise<void> {
  await applyKeymap({ ...keymap, sequenceTimeoutMs: timeoutMs });
}

/** Replace the named macros (R-3.7; ST-8 owns the editor). */
export async function setMacros(macros: readonly PersistedMacro[]): Promise<void> {
  await applyKeymap({ ...keymap, macros: macros.map((macro) => ({ ...macro, steps: [...macro.steps] })) });
}

/** Replace the raw recorded macros (R-3.8; ST-8 owns the recorder). */
export async function setRawMacros(rawMacros: readonly PersistedRawMacro[]): Promise<void> {
  await applyKeymap({
    ...keymap,
    rawMacros: rawMacros.map((macro) => ({ ...macro, strokes: [...macro.strokes] })),
  });
}

// ── Transient engine state setters (ST-4/ST-8) ────────────────────────────────

/** Enter / update the pending which-key state (R-3.2). */
export function setPendingSequence(
  prefix: string,
  nextCandidates: readonly HotkeyCandidate[],
): void {
  pendingPrefix = prefix;
  candidates = nextCandidates.length > 0 ? [...nextCandidates] : EMPTY_CANDIDATES;
  notify();
  emitHotkeyEvent({ type: 'sequence:pending', prefix, candidates });
}

/** Clear the pending state and announce why (R-3.5/R-3.6). */
export function clearPendingSequence(reason: HotkeyResetReason): void {
  if (pendingPrefix === null && candidates === EMPTY_CANDIDATES) return;
  pendingPrefix = null;
  candidates = EMPTY_CANDIDATES;
  notify();
  emitHotkeyEvent({ type: 'sequence:reset', reason });
}

/** Publish the raw-recording state (R-3.9; the persistent indicator reads this). */
export function setMacroRecording(
  recording: boolean,
  macroId: string | null = null,
  startedAt: number | null = null,
): void {
  const nextMacroId = recording ? macroId : null;
  const nextStartedAt = recording ? startedAt : null;
  if (
    recordingActive === recording &&
    recordingMacroId === nextMacroId &&
    recordingStartedAt === nextStartedAt
  ) {
    return;
  }
  recordingActive = recording;
  recordingMacroId = nextMacroId;
  recordingStartedAt = nextStartedAt;
  notify();
  emitHotkeyEvent({
    type: 'macro:recording',
    recording,
    macroId: nextMacroId,
    startedAt: nextStartedAt,
  });
}

/** Publish the terminal passthrough state (R-5.7). */
export function setPassthrough(active: boolean): void {
  if (passthroughActive === active) return;
  passthroughActive = active;
  notify();
  emitHotkeyEvent({ type: 'passthrough:changed', active });
}

// ── Hydration ─────────────────────────────────────────────────────────────────

/**
 * Hydrate from the persisted keymap — idempotent and dirty-guarded (mirrors
 * `dockPositionStore.hydrateDockPosition`). Runs ONCE: a second call is a no-op.
 * A user mutation during the async read sets `dirty`, so a late read can never
 * clobber an in-flight selection. An unreadable document degrades to defaults.
 */
export async function hydrateKeymap(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const stored = await loadKeymap();
    if (dirty) return;
    if (keymapEquals(keymap, stored)) return;
    keymap = stored;
    bumpRevision();
    emitHotkeyEvent({ type: 'keymap:changed', revision });
  } catch {
    // Tauri absent / read failure → stay on the shipped defaults.
  }
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetKeymapStoreForTests(): void {
  keymap = createDefaultKeymap();
  revision = 0;
  dirty = false;
  hydrationStarted = false;
  listeners.clear();
  eventListeners.clear();
  candidates = EMPTY_CANDIDATES;
  pendingPrefix = null;
  recordingActive = false;
  recordingMacroId = null;
  recordingStartedAt = null;
  passthroughActive = false;
}

// ── React bindings ────────────────────────────────────────────────────────────

/** Re-renders only when the keymap actually mutates (monotonic revision). */
export function useHotkeyRevision(): number {
  return useSyncExternalStore(subscribeHotkeys, getHotkeyRevision, getHotkeyRevision);
}

/** Re-renders only when the pending candidate set changes. */
export function useHotkeyCandidates(): readonly HotkeyCandidate[] {
  return useSyncExternalStore(subscribeHotkeys, getHotkeyCandidates, getHotkeyCandidates);
}

/** The effective sequences for one action, stable between mutations. */
export function useHotkeyBinding(actionId: HotkeyActionId): readonly string[] {
  return useSyncExternalStore(
    subscribeHotkeys,
    () => getBinding(actionId),
    () => getBinding(actionId),
  );
}
