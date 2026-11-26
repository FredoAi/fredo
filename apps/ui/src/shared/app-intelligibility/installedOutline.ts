/**
 * Spec #3244 ST-7 — the installed-tier outline fetch (the host correlation seam).
 *
 * # Why this exists
 *
 * An installed application renders in a SEPARATE `fredoapp://` webview this one
 * cannot read (`projectTargetScreenOutline` returns `null` for it). Its screen
 * outline reaches the host through the host's OWN scheme handler — the "beacon"
 * uplink (`apps/tauri/src-tauri/src/applications/installed_apps/beacon.rs`) — and
 * there is deliberately **NO command** to fetch it: the installed tier's ACL
 * surface is pinned, and the beacon adds no command and no capability (the human
 * approved Option A on 2026-11-26, "after reviewing the four-option table").
 *
 * So the webview asks the host over the EVENT channel, which is already granted
 * to the built-in windows (`core:event:allow-emit` / `core:event:allow-listen`):
 * it emits {@link OUTLINE_REQUEST_EVENT} with a correlation id and waits for the
 * host's {@link OUTLINE_REPLY_EVENT}, which carries this app's outline or a typed
 * reason. A `null` result is the typed "nothing to read" the caller surfaces
 * (R-2c) — never a blind turn, never an empty outline pretending to be a screen.
 *
 * Pure of React and of static `@tauri-apps/api`: the transport is `adapterBridge`.
 */

import { adapterBridge } from '../utils/adapterBridge';
import type { ScreenOutline } from './screenOutline';

/** The frontend→host request event (mirrors `beacon::BEACON_REQUEST_EVENT`). */
export const OUTLINE_REQUEST_EVENT = 'fredo:installed-outline:request';
/** The host→frontend correlated reply event (mirrors `beacon::BEACON_REPLY_EVENT`). */
export const OUTLINE_REPLY_EVENT = 'fredo:installed-outline:reply';

/** How long this seam waits for the host's reply before giving up (ms). */
export const OUTLINE_REQUEST_TIMEOUT_MS = 4000;

/** The host's correlated reply shape (mirrors `beacon::OutlineReply`). */
export interface OutlineReply {
  readonly requestId: string;
  readonly ok: boolean;
  readonly outline?: ScreenOutline;
  readonly reason?: string;
}

/**
 * Ask the host for `appId`'s current screen outline through the beacon uplink.
 *
 * Resolves the outline, or `null` when the app is not open, the reporter's beacon
 * did not arrive, or the reply timed out. Never throws for those cases — a failure
 * is a typed "nothing to read" the caller reports never a silent gap.
 */
export async function requestInstalledOutline(appId: string): Promise<ScreenOutline | null> {
  const requestId = crypto.randomUUID();

  return new Promise<ScreenOutline | null>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;

    const finish = (value: ScreenOutline | null): void => {
      if (settled) return;
      settled = true;
      if (unlisten) {
        unlisten();
      }
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), OUTLINE_REQUEST_TIMEOUT_MS);

    void adapterBridge
      .listen<OutlineReply>(OUTLINE_REPLY_EVENT, (payload) => {
        if (!payload || payload.requestId !== requestId) return;
        finish(payload.ok && payload.outline ? payload.outline : null);
      })
      .then((stop) => {
        unlisten = stop;
        if (settled) stop();
      });

    void adapterBridge.emit(OUTLINE_REQUEST_EVENT, { requestId, appId });
  });
}
