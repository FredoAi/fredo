/**
 * Spec #3206 ST-3 — the ONE external-link seam.
 *
 * The Credits pane offers exactly one activatable control per entry, and that
 * control hands its URL to the OS default browser through the backend command
 * `open_external_link` (ST-4). This module is the whole client half.
 *
 * # No client-side validation, deliberately
 *
 * The backend is the single authority on what may be opened (https-only, a pure
 * pre-I/O refusal with five pinned codes — see
 * `docs/SECURITY.md`, "Opening an external link"). A second validator here would
 * be the dual-system pattern the engineering rules forbid: two authorities, and
 * no way to say which one is true. The pane therefore *renders* whatever the
 * generated artifact says and *reports* whatever the backend refuses.
 *
 * # No static Tauri import
 *
 * `adapterBridge.invoke()` is the established transport (`TauriAdapter.ts` owns
 * the single dynamic `@tauri-apps/api` import), so this module stays safe to
 * import in a browser-only test render.
 */

import { adapterBridge } from '../../../shared/utils/adapterBridge';

/** The IPC command name — the exact `generate_handler![]` registration. */
export const OPEN_EXTERNAL_LINK_COMMAND = 'open_external_link';

/**
 * Ask the backend to hand `url` to the OS default browser.
 *
 * Resolves when the hand-off was accepted. Rejects with the backend's pinned
 * wire string (`external link refused: <code>` / `external link failed: <os
 * error>`), which the pane renders verbatim — never paraphrased.
 */
export async function openExternalLink(url: string): Promise<void> {
  await adapterBridge.invoke<void>(OPEN_EXTERNAL_LINK_COMMAND, { url });
}
