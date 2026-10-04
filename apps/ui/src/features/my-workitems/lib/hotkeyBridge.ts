/**
 * Spec #2961 ST-1 — My Work Items feature-hotkey bridge (S4).
 *
 * Same contract as the shipped Mission Monitor / Diagram bridges: the feature
 * declares its LOCAL actions once on `FredoFeatureClass.hotkeys`, the engine
 * resolves them and calls `run` only while this feature's window is focused.
 * Each `run` dispatches a namespaced `CustomEvent` on `window`; the mounted
 * `MyWorkItemsContainer` subscribes with ONE `useEffect` and maps the event onto
 * its EXISTING operations (refresh / source filter). `run` is a safe no-op while
 * the feature is unmounted (no subscriber).
 *
 * Availability is MODULE-SCOPED (not a React ref): the container publishes
 * whether an action is currently available and the declaration's `enabled()`
 * probe reads it back. Module scope means the state survives the component's
 * mount/unmount cycle.
 *
 * Namespaced per-feature (`lib/`) — no cross-feature imports.
 */

import type { HotkeyActionId } from '../../../shared/hotkeys/types';

/** Reload both sources and re-render the work-item list. */
export const MY_WORKITEMS_REFRESH_ACTION_ID: HotkeyActionId = 'my-workitems.refresh';

/** Clear the source filter so items from every source are shown. */
export const MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID: HotkeyActionId =
  'my-workitems.showAllSources';

/** Filter the list to Azure DevOps work items. */
export const MY_WORKITEMS_SHOW_AZDO_ACTION_ID: HotkeyActionId = 'my-workitems.showAzdo';

/** Filter the list to Jira issues. */
export const MY_WORKITEMS_SHOW_JIRA_ACTION_ID: HotkeyActionId = 'my-workitems.showJira';

/** The stable set of action ids this feature declares. */
export const MY_WORKITEMS_HOTKEY_ACTION_IDS = [
  MY_WORKITEMS_REFRESH_ACTION_ID,
  MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID,
  MY_WORKITEMS_SHOW_AZDO_ACTION_ID,
  MY_WORKITEMS_SHOW_JIRA_ACTION_ID,
] as const;

export type MyWorkItemsHotkeyAction = (typeof MY_WORKITEMS_HOTKEY_ACTION_IDS)[number];

/** The namespaced window event the declared `run`s dispatch. */
export const MY_WORKITEMS_HOTKEY_EVENT = 'my-workitems-hotkey-action';

/**
 * Module-scoped availability, published by the mounted container and read by
 * the declaration's `enabled()` probe. Defaults to available when unpublishished
 * (the shipped bridge default), so an unrendered/closed app never reports a
 * spurious unavailable state.
 */
const availability = new Map<MyWorkItemsHotkeyAction, boolean>();

/**
 * Dispatch one My Work Items action. Safe to call when the feature is not
 * mounted — the event simply has no subscriber (the declared `run` is a no-op
 * outside the feature).
 */
export function dispatchMyWorkItemsAction(actionId: MyWorkItemsHotkeyAction): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MY_WORKITEMS_HOTKEY_EVENT, { detail: { actionId } }));
}

/**
 * Subscribe to this feature's dispatched actions. Returns an unsubscribe
 * function so the container installs exactly ONE `window` listener and removes
 * it on unmount.
 */
export function subscribeMyWorkItemsActions(
  handler: (actionId: MyWorkItemsHotkeyAction) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ actionId?: unknown }>).detail;
    if (!detail || typeof detail.actionId !== 'string') return;
    handler(detail.actionId as MyWorkItemsHotkeyAction);
  };
  window.addEventListener(MY_WORKITEMS_HOTKEY_EVENT, listener);
  return () => window.removeEventListener(MY_WORKITEMS_HOTKEY_EVENT, listener);
}

/**
 * Publish the current availability of an action (module-scoped). Called by the
 * mounted container as the app's state changes; survives mount/unmount.
 */
export function setMyWorkItemsActionAvailable(
  actionId: MyWorkItemsHotkeyAction,
  available: boolean,
): void {
  availability.set(actionId, available);
}

/** Read an action's published availability. Defaults to available. */
export function isMyWorkItemsActionAvailable(actionId: MyWorkItemsHotkeyAction): boolean {
  return availability.get(actionId) ?? true;
}
