/**
 * Spec #2961 ST-2 — Feature Flags (Optimizely) feature-hotkey bridge
 * (AC1/AC2/AC5).
 *
 * Same contract as the shipped Mission Monitor / Infrastructure Diagram
 * bridges: the feature declares its LOCAL actions once on the feature class
 * (`FredoApplicationClass.hotkeys`), the engine calls `run` only while the
 * optimizely window is focused, and each `run` dispatches a namespaced
 * `CustomEvent` on `window` which the mounted `OptimizelyFlagsPanel` subscribes
 * to with ONE listener. The class, the panel and the tests all read the SAME
 * constants from here so an action id can never drift.
 *
 * Availability is MODULE-scoped (never a React ref): the panel publishes the
 * live `collapseAll` gate here and the class's `enabled()` probe reads it, so
 * the gate survives panel mount/unmount (AGENTS.md persistence rule).
 * `isOptimizelyActionAvailable` defaults to `true` for always-on actions.
 *
 * Namespaced per-feature (`lib/`) — no cross-feature imports.
 */

import type { HotkeyActionId } from '../../../shared/hotkeys/types';

/** Refetch the feature flag list. */
export const OPTIMIZELY_REFRESH_ACTION_ID: HotkeyActionId = 'optimizely.refresh';

/** Focus the flag search input. */
export const OPTIMIZELY_FOCUS_SEARCH_ACTION_ID: HotkeyActionId = 'optimizely.focusSearch';

/** Expand every flag group. */
export const OPTIMIZELY_EXPAND_ALL_ACTION_ID: HotkeyActionId = 'optimizely.expandAll';

/** Collapse every flag group. */
export const OPTIMIZELY_COLLAPSE_ALL_ACTION_ID: HotkeyActionId = 'optimizely.collapseAll';

/** The stable set of action ids this feature declares. */
export const OPTIMIZELY_HOTKEY_ACTION_IDS = [
  OPTIMIZELY_REFRESH_ACTION_ID,
  OPTIMIZELY_FOCUS_SEARCH_ACTION_ID,
  OPTIMIZELY_EXPAND_ALL_ACTION_ID,
  OPTIMIZELY_COLLAPSE_ALL_ACTION_ID,
] as const;

export type OptimizelyHotkeyAction = (typeof OPTIMIZELY_HOTKEY_ACTION_IDS)[number];

/** The namespaced window event the declared `run`s dispatch. */
export const OPTIMIZELY_HOTKEY_EVENT = 'optimizely-hotkey-action';

/**
 * Module-scoped availability, keyed by action id. Deliberately NOT a React ref
 * so it survives the panel unmounting and reopening; unset ⇒ `true`.
 */
const availability = new Map<OptimizelyHotkeyAction, boolean>();

/**
 * Publish whether one declared action can run right now. Called by the mounted
 * panel as its own state changes (e.g. `collapseAll` while nothing is expanded).
 */
export function setOptimizelyActionAvailable(
  actionId: OptimizelyHotkeyAction,
  available: boolean,
): void {
  availability.set(actionId, available);
}

/** Whether `actionId` can run right now; unset defaults to `true`. */
export function isOptimizelyActionAvailable(actionId: OptimizelyHotkeyAction): boolean {
  return availability.get(actionId) ?? true;
}

/** Test-only reset of the module-scoped availability map (deterministic pins). */
export function resetOptimizelyActionAvailabilityForTests(): void {
  availability.clear();
}

/**
 * Dispatch one Feature Flags action. Safe to call when the feature is not
 * mounted — the event simply has no subscriber (the declared `run` is a no-op
 * outside the feature, per R-5.4).
 */
export function dispatchOptimizelyAction(actionId: OptimizelyHotkeyAction): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(OPTIMIZELY_HOTKEY_EVENT, { detail: { actionId } }),
  );
}

/**
 * Subscribe to this feature's dispatched actions. Returns an unsubscribe
 * function so the panel installs exactly ONE `window` listener and removes it
 * on unmount.
 */
export function subscribeOptimizelyActions(
  handler: (actionId: OptimizelyHotkeyAction) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ actionId?: unknown }>).detail;
    if (!detail || typeof detail.actionId !== 'string') return;
    handler(detail.actionId as OptimizelyHotkeyAction);
  };
  window.addEventListener(OPTIMIZELY_HOTKEY_EVENT, listener);
  return () => window.removeEventListener(OPTIMIZELY_HOTKEY_EVENT, listener);
}
