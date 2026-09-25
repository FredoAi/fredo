/**
 * Spec #2946 ST-15 — Infrastructure Diagram feature-hotkey bridge
 * (AC2 H-4/H-5/H-6).
 *
 * Same contract as the Mission Monitor bridge: the feature class declares its
 * LOCAL actions via `FredoFeatureClass.hotkeys`, the engine calls `run` only
 * while the diagram window is focused, and each `run` dispatches a namespaced
 * `CustomEvent` on `window` which the mounted `ArchitectureDiagram` subscribes
 * to with ONE listener. The class, the component and the tests share these
 * constants so an action id can never drift.
 *
 * Namespaced per-feature (`lib/`) — no cross-feature imports.
 */

import type { HotkeyActionId } from '../../../shared/hotkeys/types';

/** Focus the diagram search input. */
export const DIAGRAM_SEARCH_ACTION_ID: HotkeyActionId = 'diagram.search';

/** Fit the whole diagram into the viewport. */
export const DIAGRAM_FIT_VIEW_ACTION_ID: HotkeyActionId = 'diagram.fitView';

/** The stable set of action ids this feature declares. */
export const DIAGRAM_HOTKEY_ACTION_IDS = [
  DIAGRAM_SEARCH_ACTION_ID,
  DIAGRAM_FIT_VIEW_ACTION_ID,
] as const;

export type DiagramHotkeyAction = (typeof DIAGRAM_HOTKEY_ACTION_IDS)[number];

/** The namespaced window event the declared `run`s dispatch. */
export const DIAGRAM_HOTKEY_EVENT = 'diagram-hotkey-action';

/**
 * Dispatch one diagram action. Safe to call when the feature is not mounted —
 * the event simply has no subscriber.
 */
export function dispatchDiagramAction(actionId: DiagramHotkeyAction): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DIAGRAM_HOTKEY_EVENT, { detail: { actionId } }));
}

/**
 * Subscribe to this feature's dispatched actions. Returns an unsubscribe
 * function so the component installs exactly ONE `window` listener.
 */
export function subscribeDiagramActions(handler: (actionId: DiagramHotkeyAction) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ actionId?: unknown }>).detail;
    if (!detail || typeof detail.actionId !== 'string') return;
    handler(detail.actionId as DiagramHotkeyAction);
  };
  window.addEventListener(DIAGRAM_HOTKEY_EVENT, listener);
  return () => window.removeEventListener(DIAGRAM_HOTKEY_EVENT, listener);
}
