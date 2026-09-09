/**
 * Own window-kernel store (Spec #2807 ST-1).
 *
 * Module-scoped, mirroring the RTDB row-store persistence rule from
 * AGENTS.md: the open-window list must survive React mount/unmount cycles
 * (Home re-mounts paths; `useWindows` feeds the toolbar's multi-window id
 * counting). The list + the per-window close-callback registry live at module
 * scope so a ref reset never wipes them.
 *
 * Close is idempotent + re-entrancy-guarded: `closeWindow(id)` removes the
 * entry from the list BEFORE invoking any registered close callback. Home's
 * close callback itself calls `closeWindow(id)` (see Home.tsx:86-90), so an
 * unguarded re-entry would loop; removing first makes a re-entrant
 * `closeWindow(id)` a guaranteed no-op.
 */

import type { OpenWindowParams, WindowEntry } from './windowTypes';

let entries: WindowEntry[] = [];
const closeCallbacks = new Map<string, () => void>();
const listeners = new Set<() => void>();
let nextZ = 1;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to window-list changes (useSyncExternalStore). */
export function subscribeWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot of the open-window list (stable ref until the next mutation). */
export function getWindowSnapshot(): WindowEntry[] {
  return entries;
}

/** Test-only: wipe the module-scoped window store. Never call from app code. */
export function resetWindowStoreForTests(): void {
  entries = [];
  closeCallbacks.clear();
  listeners.clear();
  nextZ = 1;
}

/**
 * Register a per-window close callback. Invoked by `closeWindow(id)` AFTER
 * the entry is removed (the re-entrancy guard). Home (ST-2) wires a feature's
 * `registerCloseCallback` here; that callback itself calls `closeWindow(id)`.
 */
export function registerWindowCloseCallback(id: string, callback: () => void): void {
  closeCallbacks.set(id, callback);
}

/** Remove a previously registered close callback (no-op if absent). */
export function unregisterWindowCloseCallback(id: string): void {
  closeCallbacks.delete(id);
}

/**
 * Open (or re-focus) a window. A new id spawns a fresh, focused entry; an
 * existing id re-applies the declared base fields, restores it from minimize,
 * and raises it to the top of the z-order (spawn semantics per the plan).
 */
export function openWindow(params: OpenWindowParams): void {
  const existing = entries.find((w) => w.id === params.id);
  if (existing) {
    const newZ = topZ() + 1;
    nextZ = Math.max(nextZ, newZ);
    entries = entries.map((w) => {
      if (w.id !== params.id) return { ...w, focused: false };
      return {
        ...w,
        title: params.title,
        icon: params.icon,
        component: params.component,
        canClose: params.canClose ?? w.canClose,
        canMaximize: params.canMaximize ?? w.canMaximize,
        canMinimize: params.canMinimize ?? w.canMinimize,
        isMaximized: params.isMaximized ?? w.isMaximized,
        isMinimized: false,
        focused: true,
        zIndex: newZ,
      };
    });
    notify();
    return;
  }

  const entry: WindowEntry = {
    id: params.id,
    title: params.title,
    icon: params.icon,
    component: params.component,
    canClose: params.canClose ?? true,
    canMaximize: params.canMaximize ?? true,
    canMinimize: params.canMinimize ?? true,
    isMaximized: params.isMaximized ?? false,
    isMinimized: false,
    focused: true,
    zIndex: nextZ,
  };
  nextZ += 1;
  entries = [...entries.map((w) => ({ ...w, focused: false })), entry];
  notify();
}

/**
 * Close a window by id. Idempotent: closing an absent id is a no-op.
 * Re-entrancy-guarded: the entry is removed from the list FIRST, then the
 * registered close callback runs (which may call `closeWindow(id)` again).
 */
export function closeWindow(id: string): void {
  const idx = entries.findIndex((w) => w.id === id);
  if (idx === -1) return; // already closed / never opened
  entries = entries.filter((w) => w.id !== id);
  notify();
  const callback = closeCallbacks.get(id);
  closeCallbacks.delete(id);
  callback?.();
}

/**
 * Spread-merge a partial patch into an existing entry (R-4) — never full
 * replacement. Control state (isMinimized/focused/zIndex) survives unless the
 * patch overrides it; only fields present in the patch change.
 */
export function updateWindow(id: string, patch: Partial<OpenWindowParams>): void {
  const idx = entries.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const prev = entries[idx];
  entries = entries.map((w, i) => {
    if (i !== idx) return w;
    return {
      ...prev,
      title: patch.title ?? prev.title,
      icon: patch.icon ?? prev.icon,
      component: patch.component ?? prev.component,
      canClose: patch.canClose ?? prev.canClose,
      canMaximize: patch.canMaximize ?? prev.canMaximize,
      canMinimize: patch.canMinimize ?? prev.canMinimize,
      isMaximized: patch.isMaximized ?? prev.isMaximized,
    };
  });
  notify();
}

/**
 * Bring a window to the top of the z-order (R-6) and apply the optional
 * minimize/maximize toggle. Focus clears minimize by default (restore);
 * `opts.minimize: true` keeps the window minimized, `opts.maximize` toggles
 * isMaximized. Unknown ids are a no-op.
 */
export function focusWindow(
  id: string,
  opts?: { minimize?: boolean; maximize?: boolean },
): void {
  const target = entries.find((w) => w.id === id);
  if (!target) return;
  const newZ = topZ() + 1;
  nextZ = Math.max(nextZ, newZ);
  entries = entries.map((w) => {
    if (w.id !== id) return { ...w, focused: false };
    return {
      ...w,
      focused: true,
      zIndex: newZ,
      isMinimized: opts?.minimize ?? false,
      isMaximized: opts?.maximize ?? w.isMaximized,
    };
  });
  notify();
}

/** Highest zIndex currently in the store (nextZ is only a monotonic base). */
function topZ(): number {
  return entries.reduce((m, w) => Math.max(m, w.zIndex), 0);
}
