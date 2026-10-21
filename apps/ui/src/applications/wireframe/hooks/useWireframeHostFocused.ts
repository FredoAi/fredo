/**
 * `useWireframeHostFocused` (Spec #3070, ST-1, R-5.4).
 *
 * Tells the toolbar (ST-3) whether the Wireframe host currently owns focus.
 * The always-on hotkey bar lists every mounted `data-hotkey` element, and an
 * OPEN but unfocused window stays mounted (D2), so the attributes must be
 * withheld unless this hook says the host is focused.
 *
 * Two shipped surfaces are combined:
 * - same-window host: the module-scoped window kernel (`useWindows`) says
 *   whether the `wireframe` window is the focused one;
 * - standalone app webview: the kernel store is empty in that webview, so the
 *   host IS the document — `document.hasFocus()` is the truth.
 */

import { useSyncExternalStore } from 'react';

import { WIREFRAME_APP_ID } from '../model/document';
import { useWindows } from '../../../shared/window-system/useWindows';

function subscribeDocumentFocus(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('focus', listener);
  window.addEventListener('blur', listener);
  document.addEventListener('visibilitychange', listener);
  return () => {
    window.removeEventListener('focus', listener);
    window.removeEventListener('blur', listener);
    document.removeEventListener('visibilitychange', listener);
  };
}

function getDocumentFocused(): boolean {
  if (typeof document === 'undefined') return true;
  if (typeof document.hasFocus !== 'function') return true;
  return document.hasFocus();
}

function getServerDocumentFocused(): boolean {
  return true;
}

/** True while the Wireframe host (window or standalone webview) is focused. */
export function useWireframeHostFocused(): boolean {
  const windows = useWindows();
  const documentFocused = useSyncExternalStore(
    subscribeDocumentFocus,
    getDocumentFocused,
    getServerDocumentFocused,
  );

  const host = windows.find((window) => window.id === WIREFRAME_APP_ID);
  if (host) return host.focused;
  return documentFocused;
}
