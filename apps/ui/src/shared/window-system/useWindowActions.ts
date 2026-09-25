/**
 * `useWindowActions` — drop-in for the third-party hook (Spec #2807 ST-1).
 *
 * Reads the window actions from the `WindowSystemProvider` context. Must be
 * used within a provider (matching the prior engine's requirement). The
 * returned object is a stable reference (the store functions are module-level
 * and never change identity).
 */

import { useContext, useEffect } from 'react';
import { installWindowTraversal } from '../hotkeys/traversal';
import { WindowSystemContext } from './WindowSystemProvider';
import type { WindowActions } from './windowTypes';

export type { WindowActions } from './windowTypes';

export function useWindowActions(): WindowActions {
  const context = useContext(WindowSystemContext);
  if (context === undefined) {
    throw new Error('useWindowActions must be used within a WindowSystemProvider');
  }
  return context;
}

/**
 * Spec #2946 ST-10 — arm the keyboard window traversal (AC1).
 *
 * Mounted by `WindowFrame`, because traversal is only meaningful while at least
 * one window is rendered. Idempotent + reference-counted inside
 * `installWindowTraversal`, so N open windows (and React StrictMode's double
 * effect) still yield exactly ONE Tab-boundary listener; the last unmount
 * releases it. The engine's single hotkey dispatch listener is untouched.
 */
export function useWindowTraversal(): void {
  useEffect(() => installWindowTraversal(), []);
}

// The keyboard raise API (ST-10) — exposed here alongside the window actions so
// window-system consumers reach traversal through the same surface.
export {
  focusFirstInWindow,
  focusLastInWindow,
  focusNextWindow,
  focusPreviousWindow,
  focusWindowByIndex,
  focusWindowWithKeyboard,
  getFocusedWindowId,
  getWindowIds,
  handleWindowBoundaryTab,
  restoreTransientFocus,
  scrollIntoViewIfNeeded,
} from '../hotkeys/traversal';
