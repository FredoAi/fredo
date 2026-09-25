/**
 * Spec #2946 ST-15 — Mission Monitor feature-hotkey bridge (AC2 H-4/H-5/H-6).
 *
 * A feature declares its LOCAL hotkey actions once, on the feature class
 * (`FredoFeatureClass.hotkeys`). The engine resolves them and calls `run` only
 * while this feature's window has focus (R-2.5). The `run` bodies must not live
 * on the class as component state, so — exactly like the established
 * `diagram-focus-node` precedent in `DiagramFeature.tsx` — each `run` dispatches
 * a namespaced `CustomEvent` on `window`; the mounted panel subscribes with ONE
 * `useEffect` and maps the event onto its existing state operations.
 *
 * The class, the panel and the tests all read the SAME constants from here so
 * an action id can never drift between the declaration and the handler.
 *
 * Namespaces are per-feature (`lib/`) — no cross-feature imports.
 */

import type { HotkeyActionId } from '../../../shared/hotkeys/types';

/** Open the session drawer and focus the session filter input. */
export const MISSION_MONITOR_FOCUS_SESSION_SEARCH: HotkeyActionId =
  'mission-monitor.focusSessionSearch';

/** Select the next session in the filtered list (wrap-around). */
export const MISSION_MONITOR_NEXT_SESSION: HotkeyActionId = 'mission-monitor.nextSession';

/** Select the previous session in the filtered list (wrap-around). */
export const MISSION_MONITOR_PREVIOUS_SESSION: HotkeyActionId = 'mission-monitor.previousSession';

/** The stable set of action ids this feature declares. */
export const MISSION_MONITOR_HOTKEY_ACTION_IDS = [
  MISSION_MONITOR_FOCUS_SESSION_SEARCH,
  MISSION_MONITOR_NEXT_SESSION,
  MISSION_MONITOR_PREVIOUS_SESSION,
] as const;

export type MissionMonitorHotkeyAction = (typeof MISSION_MONITOR_HOTKEY_ACTION_IDS)[number];

/** The namespaced window event the declared `run`s dispatch. */
export const MISSION_MONITOR_HOTKEY_EVENT = 'mission-monitor-hotkey-action';

/**
 * Dispatch one Mission Monitor action. Safe to call when the feature is not
 * mounted — the event simply has no subscriber (the declared `run` is a no-op
 * outside the feature, per ST-15).
 */
export function dispatchMissionMonitorAction(actionId: MissionMonitorHotkeyAction): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(MISSION_MONITOR_HOTKEY_EVENT, { detail: { actionId } }),
  );
}

/**
 * Subscribe to this feature's dispatched actions. Returns an unsubscribe
 * function so the panel can install exactly ONE `window` listener and remove it
 * on unmount.
 */
export function subscribeMissionMonitorActions(
  handler: (actionId: MissionMonitorHotkeyAction) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ actionId?: unknown }>).detail;
    if (!detail || typeof detail.actionId !== 'string') return;
    handler(detail.actionId as MissionMonitorHotkeyAction);
  };
  window.addEventListener(MISSION_MONITOR_HOTKEY_EVENT, listener);
  return () => window.removeEventListener(MISSION_MONITOR_HOTKEY_EVENT, listener);
}
