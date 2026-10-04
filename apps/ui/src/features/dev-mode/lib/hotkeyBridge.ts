/**
 * Spec #2961 ST-3 — Dev Mode feature-hotkey bridge (AC1/AC2/AC5).
 *
 * Same contract as the shipped Mission Monitor / Diagram bridges: the feature
 * declares its LOCAL actions once on the feature class
 * (`FredoFeatureClass.hotkeys`), the engine resolves them and calls `run` only
 * while this feature's window has focus, and each `run` dispatches a namespaced
 * `CustomEvent` on `window` which the mounted `DevMode` subscribes to with ONE
 * `useEffect`. The class, the component and the tests share these constants so
 * an action id can never drift.
 *
 * Availability is MODULE-SCOPED (survives component mount/unmount — never a
 * React ref), so a gated action's `enabled()` probe reads the latest state the
 * mounted component published, even across a close/reopen cycle.
 *
 * Namespaced per-feature (`lib/`) — no cross-feature imports.
 */

import type { HotkeyActionId } from '../../../shared/hotkeys/types';

/** Focus the event filter input. */
export const DEV_MODE_FOCUS_FILTER_ACTION_ID: HotkeyActionId = 'dev-mode.focusFilter';

/** Clear the captured event stream. */
export const DEV_MODE_CLEAR_EVENTS_ACTION_ID: HotkeyActionId = 'dev-mode.clearEvents';

/** Re-enable every event-state filter. */
export const DEV_MODE_SHOW_ALL_STATES_ACTION_ID: HotkeyActionId = 'dev-mode.showAllStates';

/** Switch between the rows view and the feature-data view. */
export const DEV_MODE_TOGGLE_VIEW_ACTION_ID: HotkeyActionId = 'dev-mode.toggleView';

/** The stable set of action ids this feature declares. */
export const DEV_MODE_HOTKEY_ACTION_IDS = [
  DEV_MODE_FOCUS_FILTER_ACTION_ID,
  DEV_MODE_CLEAR_EVENTS_ACTION_ID,
  DEV_MODE_SHOW_ALL_STATES_ACTION_ID,
  DEV_MODE_TOGGLE_VIEW_ACTION_ID,
] as const;

export type DevModeHotkeyAction = (typeof DEV_MODE_HOTKEY_ACTION_IDS)[number];

/** The namespaced window event the declared `run`s dispatch. */
export const DEV_MODE_HOTKEY_EVENT = 'dev-mode-hotkey-action';

/**
 * Module-scoped availability published by the mounted `DevMode` and read by the
 * feature class's `enabled()` probes. Survives mount/unmount; default `true`
 * (an action with no published gate is always available).
 */
const availability = new Map<DevModeHotkeyAction, boolean>();

/** Publish whether `actionId` is currently available. */
export function setDevModeActionAvailable(actionId: DevModeHotkeyAction, available: boolean): void {
  availability.set(actionId, available);
}

/** Read the latest published availability for `actionId` (default `true`). */
export function isDevModeActionAvailable(actionId: DevModeHotkeyAction): boolean {
  return availability.get(actionId) ?? true;
}

/**
 * Dispatch one Dev Mode action. Safe to call when the feature is not mounted —
 * the event simply has no subscriber (the declared `run` is a no-op outside the
 * feature).
 */
export function dispatchDevModeAction(actionId: DevModeHotkeyAction): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DEV_MODE_HOTKEY_EVENT, { detail: { actionId } }));
}

/**
 * Subscribe to this feature's dispatched actions. Returns an unsubscribe
 * function so the panel installs exactly ONE `window` listener and removes it
 * on unmount.
 */
export function subscribeDevModeActions(
  handler: (actionId: DevModeHotkeyAction) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ actionId?: unknown }>).detail;
    if (!detail || typeof detail.actionId !== 'string') return;
    handler(detail.actionId as DevModeHotkeyAction);
  };
  window.addEventListener(DEV_MODE_HOTKEY_EVENT, listener);
  return () => window.removeEventListener(DEV_MODE_HOTKEY_EVENT, listener);
}
