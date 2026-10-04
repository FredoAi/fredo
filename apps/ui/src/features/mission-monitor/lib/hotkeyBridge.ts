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
 *
 * Spec #2962 ST-2 extends the same bridge with the three-level nested flow:
 * two declared interaction contexts (graph → node detail) and one action per
 * level for each reused key, each `run` dispatching its own namespaced event.
 */

import type { HotkeyActionId, HotkeyContextId } from '../../../shared/hotkeys/types';

// ── Interaction contexts (Spec #2962 ST-2) ───────────────────────────────────
//
// The nested flow is three levels deep: the synthesized base `mission-monitor`
// (L1), then two declared descents. Each declared id is `<featureId>.`-prefixed
// and names a resolvable parent (the base, then the graph), per the #2958
// context registry contract.

/** L2 — the graph navigation level (parent: the synthesized base `mission-monitor`). */
export const MISSION_MONITOR_GRAPH_CONTEXT_ID: HotkeyContextId = 'mission-monitor.graph';

/** L3 — the node-detail level (parent: the graph level). */
export const MISSION_MONITOR_DETAIL_CONTEXT_ID: HotkeyContextId = 'mission-monitor.detail';

// ── L1 actions (base context `mission-monitor`) ──────────────────────────────

/** Open the session drawer and focus the session filter input. */
export const MISSION_MONITOR_FOCUS_SESSION_SEARCH: HotkeyActionId =
  'mission-monitor.focusSessionSearch';

/** Select the next session in the filtered list (wrap-around). */
export const MISSION_MONITOR_NEXT_SESSION: HotkeyActionId = 'mission-monitor.nextSession';

/** Select the previous session in the filtered list (wrap-around). */
export const MISSION_MONITOR_PREVIOUS_SESSION: HotkeyActionId = 'mission-monitor.previousSession';

/** Descend from L1 into the graph context. */
export const MISSION_MONITOR_OPEN_GRAPH: HotkeyActionId = 'mission-monitor.openGraph';

// ── L2 actions (graph context `mission-monitor.graph`) ───────────────────────

/** Move the graph cursor to the next node. */
export const MISSION_MONITOR_NEXT_NODE: HotkeyActionId = 'mission-monitor.nextNode';

/** Move the graph cursor to the previous node. */
export const MISSION_MONITOR_PREVIOUS_NODE: HotkeyActionId = 'mission-monitor.previousNode';

/** Descend from L2 into the node-detail context. */
export const MISSION_MONITOR_OPEN_DETAIL: HotkeyActionId = 'mission-monitor.openDetail';

// ── L3 actions (node-detail context `mission-monitor.detail`) ────────────────

/** Move the active detail section to the next one. */
export const MISSION_MONITOR_NEXT_SECTION: HotkeyActionId = 'mission-monitor.nextSection';

/** Move the active detail section to the previous one. */
export const MISSION_MONITOR_PREVIOUS_SECTION: HotkeyActionId = 'mission-monitor.previousSection';

/** Toggle (expand/collapse) the active detail section. */
export const MISSION_MONITOR_TOGGLE_SECTION: HotkeyActionId = 'mission-monitor.toggleSection';

/** The stable set of action ids this feature declares (L1 → L2 → L3 order). */
export const MISSION_MONITOR_HOTKEY_ACTION_IDS = [
  MISSION_MONITOR_FOCUS_SESSION_SEARCH,
  MISSION_MONITOR_NEXT_SESSION,
  MISSION_MONITOR_PREVIOUS_SESSION,
  MISSION_MONITOR_OPEN_GRAPH,
  MISSION_MONITOR_NEXT_NODE,
  MISSION_MONITOR_PREVIOUS_NODE,
  MISSION_MONITOR_OPEN_DETAIL,
  MISSION_MONITOR_NEXT_SECTION,
  MISSION_MONITOR_PREVIOUS_SECTION,
  MISSION_MONITOR_TOGGLE_SECTION,
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
