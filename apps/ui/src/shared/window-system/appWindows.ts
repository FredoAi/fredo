/**
 * appWindows — the native-window IPC seam + the ONE presentation-aware opener
 * for the per-app presentation choice (Spec #2955 ST-4).
 *
 * The presentation DECISION lives in `createAppOpener` (the ONE `openApp`): it
 * awaits the per-app presentation hydration, then either asks the Rust window
 * manager to open/focus the app's singleton native host (`new-window`) or calls
 * the shipped in-window opener (`same-window`). Only the Rust side sees every
 * webview, so singleton + focus-if-exists is enforced there by window label
 * (`terminal` / `doom` / `app-<id>`); this module never tries to enforce it from
 * the main webview.
 *
 * Tauri is reached through the `adapterBridge` (the app's dynamic-import seam) —
 * never a static `@tauri-apps/api` import — so the module stays host-agnostic
 * and unit-testable.
 */

import { adapterBridge } from '../utils/adapterBridge';
import { getAppPresentation, hydrateAppPresentation } from './appPresentationStore';
import type { FredoApplicationClass } from '../classes/FredoApplicationClass';

/** The shipped full-lifecycle in-window opener Home supplies to the ONE opener. */
export type InWindowOpener = (id: string, feature: FredoApplicationClass) => void;

/** The user-facing opener signature — `openApp(id, feature)`. */
export type AppOpener = (id: string, feature: FredoApplicationClass) => void;

/**
 * Open (or focus) an app's own native window. The backend opens the bespoke
 * `terminal` / `doom` host or the generic `app-<id>` window, focusing an
 * existing window rather than building a second one (AC3). The `title` is used
 * only for a fresh generic window; the bespoke hosts own their titles.
 *
 * Rejects only on a genuine backend failure (e.g. window creation failed).
 */
export async function openAppInOwnWindow(appId: string, title: string): Promise<void> {
  await adapterBridge.invoke('open_app_window', { appId, title });
}

/**
 * Close an app's native window if one is open, returning `true` only when a
 * native window actually existed (the honest close report the companion
 * `close_app` intent needs). A missing host is `false`, never an error — a
 * same-window app legitimately has no native window.
 */
export async function closeAppOwnWindow(appId: string): Promise<boolean> {
  const closed = await adapterBridge.invoke<boolean>('close_app_window', { appId });
  return closed === true;
}

/**
 * Build THE ONE presentation-aware opener, bound to the shipped in-window
 * opener. Every USER-initiated open (launcher grid, Open-apps row, `fredo
 * open-app`, companion `open_app`, `openSelf`) goes through the returned
 * `openApp(id, feature)`:
 *
 *   1. await `hydrateAppPresentation()` so the stored per-app map is resolved
 *      before the first open (no flash of the wrong host);
 *   2. `new-window` → `openAppInOwnWindow(id, feature.name)` — the Rust
 *      singleton/focus authority (AC3), NO in-window window is created;
 *   3. otherwise     → the in-window `openInWindow(id, feature)` (the shipped
 *      full-lifecycle kernel opener).
 *
 * A backend open failure is logged, never thrown into a render path (callers
 * are fire-and-forget). Internal transition callbacks and the #2980
 * `reopenZonedWindows` restore do NOT go through this opener — they stay on
 * the raw in-window opener, so they are never re-routed by the per-app choice.
 */
export function createAppOpener(openInWindow: InWindowOpener): AppOpener {
  return (id, feature) => {
    void (async () => {
      await hydrateAppPresentation();
      if (getAppPresentation(id) === 'new-window') {
        await openAppInOwnWindow(id, feature.name);
        return;
      }
      openInWindow(id, feature);
    })().catch((err) => {
      console.error('[appWindows] openApp failed:', id, err);
    });
  };
}
