/**
 * Companion manifest publisher (Spec #3099, ST-2).
 *
 * Publishes the PURE manifest projection ({@link buildCompanionManifest}) to the
 * host with `register_app_command_surfaces`. The host registry is the published
 * truth the dispatcher and the per-turn offer read (D12) — so this is the ONE
 * write path, and it runs at boot plus on every application registration.
 *
 * Timing rules (Spec #3099 ST-2):
 *   - publication is COALESCED to one invoke per task (`queueMicrotask`), so a
 *     burst of registrations cannot flood the host;
 *   - a webview that never imports `allApplications` (empty registry) publishes
 *     NOTHING — an empty publish would be a no-op host-side, but skipping it
 *     keeps the boot path free of pointless IPC;
 *   - an identical serialized manifest is not re-sent;
 *   - a failed invoke is swallowed (never thrown into a render path) and is
 *     retried by the next registration notification.
 *
 * `adapterBridge.invoke` ONLY — never a static `@tauri-apps/api` import
 * (engineering rule: dynamic imports live in `TauriAdapter.ts`).
 */

import {
  getApplications,
  subscribeApplications,
} from '../../applications/applicationRegistry';
import { adapterBridge } from '../utils/adapterBridge';
import {
  buildCompanionManifest,
  type CompanionManifest,
} from './manifest';

/** The Tauri command registered by the host (ST-4). */
export const REGISTER_APP_COMMAND_SURFACES_COMMAND = 'register_app_command_surfaces';

/** Serialized form of the last SUCCESSFULLY published manifest. */
let _lastPublished: string | undefined;

/** Number of live installs (idempotent by ref count). */
let _installCount = 0;

/** The single registration subscription, owned while `_installCount > 0`. */
let _unsubscribe: (() => void) | undefined;

/** True while a publish is queued for the current task. */
let _scheduled = false;

/**
 * Generation token: `resetAppCommandPublisherForTests` advances it so a queued
 * microtask from a previous test cannot publish into the next one.
 */
let _generation = 0;

/** Project the currently registered applications. */
export function collectCompanionManifest(): CompanionManifest {
  return buildCompanionManifest(getApplications());
}

/**
 * Publish the current manifest. Safe to call directly (tests / explicit boot);
 * never throws. Returns after the invoke settles.
 *
 * Wire shape: `{ manifest: { surfaces: [...] } }` — the host command's argument
 * name is `manifest` (ST-4).
 */
export async function publishAppCommandSurfaces(): Promise<void> {
  // A webview without `allApplications` must never publish an empty set.
  if (getApplications().length === 0) return;

  const manifest = collectCompanionManifest();
  const serialized = JSON.stringify(manifest);
  // Identical consecutive manifests are not re-sent.
  if (serialized === _lastPublished) return;

  try {
    await adapterBridge.invoke(REGISTER_APP_COMMAND_SURFACES_COMMAND, { manifest });
    // Only a successful publish updates the watermark, so a failed invoke is
    // retried by the next registration.
    _lastPublished = serialized;
  } catch {
    // Swallow: a publish failure must never throw into the render path.
  }
}

/** Coalesce up to one publish per task. */
function schedulePublish(): void {
  if (_scheduled) return;
  _scheduled = true;
  const generation = _generation;
  queueMicrotask(() => {
    if (generation !== _generation) return;
    _scheduled = false;
    void publishAppCommandSurfaces();
  });
}

/**
 * Install the boot + registration publisher. Idempotent by ref count: repeated
 * installs (e.g. a React remount) share ONE subscription and ONE boot publish.
 * Returns a release function; the last release unsubscribes.
 */
export function installAppCommandSurfacePublisher(): () => void {
  _installCount += 1;
  if (_installCount === 1) {
    _unsubscribe = subscribeApplications(() => schedulePublish());
    schedulePublish();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    _installCount -= 1;
    if (_installCount === 0) {
      _unsubscribe?.();
      _unsubscribe = undefined;
    }
  };
}

/** Test-only reset: drops installs, subscription, watermark and queued work. */
export function resetAppCommandPublisherForTests(): void {
  _generation += 1;
  _installCount = 0;
  _unsubscribe?.();
  _unsubscribe = undefined;
  _scheduled = false;
  _lastPublished = undefined;
}
