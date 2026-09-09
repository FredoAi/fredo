/**
 * `useWindows` — the open-window list (Spec #2807 ST-1).
 *
 * Subscribes to the module-scoped kernel store via `useSyncExternalStore`, so
 * the returned list is a stable reference until a real mutation (open/close/
 * update/focus) advances the store. Feeds the toolbar's multi-window id
 * counting (`DesktopToolbar`).
 */

import { useSyncExternalStore } from 'react';
import { subscribeWindows, getWindowSnapshot } from './windowStore';
import type { WindowEntry } from './windowTypes';

export function useWindows(): WindowEntry[] {
  return useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
}
