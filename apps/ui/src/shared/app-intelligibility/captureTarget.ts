/**
 * Spec #3244 ST-3 — the frontend capture call: resolve a target app's physical
 * screen rectangle and capture it FRESH through the host seams.
 *
 * # What this owns
 *
 * The rect, not a recipe: an application can be rendered in ONE of two places,
 * and each needs its rectangle resolved differently:
 *
 *   - a **built-in** app renders INSIDE the main webview, so its rectangle is
 *     derived from the DOM using the shipped recipe — `getBoundingClientRect()`
 *     scaled by `devicePixelRatio`, offset by the window's `screenX/Y`
 *     (`TicTacToe.tsx:62-74`); and
 *   - an **installed** app renders in a SEPARATE webview, whose on-screen
 *     position the main webview cannot read — so the HOST resolves it
 *     (`installed_app_screen_rect`, spec ST-3) in physical pixels.
 *
 * Both branches converge on ONE capture call (`capture_target_region`), which
 * delegates to the shipped `capture_screen_region`. The branch is on the app's
 * ORIGIN (built-in vs installed), never on the app's id — there is no per-app
 * conditional anywhere on this path (the impossibility that keeps AC-2 honest).
 *
 * # Freshness (R-3a)
 *
 * The rectangle is resolved and the screen is captured on EVERY call — nothing
 * is cached, memoised or reused between calls, so a capture always reflects the
 * app's current screen.
 *
 * # Typed "nothing to capture"
 *
 * A `null` result is a typed, non-silent answer: the id is unknown, the installed
 * app is not open, or the in-window root is not mounted. The caller surfaces it
 * (R-2c); it is never a blind capture of the wrong rectangle.
 *
 * # The pair
 *
 * `CapturedPair` here carries the SCREENSHOT leg only. The DOM-outline leg of the
 * per-turn pair is ST-4's projector (`ScreenOutline` / `ScreenPair`); ST-4
 * composes the two into the injected pair. This file must not declare the
 * outline type — that would make two owners for one contract.
 */

import { adapterBridge } from '../utils/adapterBridge';
import { locateAppDescriptionSource } from './description';

/**
 * A physical-pixel rectangle on the desktop — the wire shape the host's
 * `capture_target_region` command consumes (mirrors the Rust `TargetRect`).
 */
export interface TargetRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The host capture seam's result (R-2b / R-3a). ST-3 owns the screenshot leg;
 * the `outline` leg is ST-4's and is composed into the turn's `ScreenPair`.
 */
export interface CapturedPair {
  /** A base64-encoded PNG of the target's current screen. */
  readonly screenshotPngBase64: string;
}

/**
 * Resolve `appId`'s physical screen rectangle and capture it FRESH.
 *
 * Returns `null` — a typed "nothing to capture" — when the id is unknown to both
 * registries, when the installed app is not open, or when the in-window app root
 * is not mounted. Never throws for those cases and never captures a wrong region.
 */
export async function captureTargetRegion(appId: string): Promise<CapturedPair | null> {
  const source = locateAppDescriptionSource(appId);
  if (source === null) return null;

  const rect =
    source.origin === 'installed'
      ? await resolveInstalledWindowRect(appId)
      : resolveInWindowRect(appId);
  if (rect === null) return null;

  const screenshotPngBase64 = await adapterBridge.invoke<string>('capture_target_region', { rect });
  if (!screenshotPngBase64) return null;

  return { screenshotPngBase64 };
}

/**
 * An installed app's physical rectangle, resolved by the HOST: the main webview
 * cannot read a separate window's position, so the backend reports its client
 * area in physical pixels. `null` when the app is not open.
 */
async function resolveInstalledWindowRect(appId: string): Promise<TargetRect | null> {
  const rect = await adapterBridge.invoke<TargetRect | null>('installed_app_screen_rect', {
    appId,
  });
  return rect ?? null;
}

/**
 * A built-in app's physical rectangle, derived from the DOM with the shipped
 * recipe (CSS pixels scaled by DPR, offset by the window origin). `null` when the
 * app's in-window root ([`data-fredo-app-id`]) is not mounted — e.g. the app is
 * shown in its own window, which ST-3 does not resolve.
 */
function resolveInWindowRect(appId: string): TargetRect | null {
  const root = findInWindowAppRoot(appId);
  if (root === null) return null;

  const rect = root.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round((window.screenX + rect.left) * dpr),
    y: Math.round((window.screenY + rect.top) * dpr),
    width: Math.round(rect.width * dpr),
    height: Math.round(rect.height * dpr),
  };
}

/**
 * The mounted element carrying [`data-fredo-app-id`] for `appId`, matched by
 * ATTRIBUTE VALUE (never a selector built from the id), so an id can never inject
 * into a query.
 */
function findInWindowAppRoot(appId: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[data-fredo-app-id]');
  for (const candidate of candidates) {
    if (candidate.getAttribute('data-fredo-app-id') === appId) return candidate;
  }
  return null;
}
