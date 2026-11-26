/**
 * Spec #3244 ST-5 — the companion's target-ref list over BOTH registries.
 *
 * # Why this module exists
 *
 * The companion's named-app matcher (`resolveNamedAppMention`) works over a
 * narrow `FredoAppRef[]`. Before #3244 that list came from `getApplications()`
 * ONLY, so an installed application was INVISIBLE to companion target
 * resolution — the gap AC-2's "no per-app enablement" must close. This module is
 * the ONE place the two registries are projected into that narrow view, so
 * neither consumer re-derives it:
 *
 *   - `getApplications()` — the built-in registry (8 pinned ids); and
 *   - `getInstalledApps()` — the SEPARATE installed registry
 *     (`shared/installed-apps/store.ts:17`), which never calls
 *     `registerApplication` and never joins the pinned set.
 *
 * # Invariants held
 *
 * - The installed registry stays a SEPARATE store: this module only READS it. It
 *   never calls `registerApplication`, so `getApplications()` can never observe
 *   an installed application.
 * - No per-app conditional branch: the projection is a uniform map over each
 *   registry, keyed by nothing. An installed app is a companion target for the
 *   SAME reason a built-in is.
 * - `FredoAppRef` stays the narrow view it always was (`{id, name, showable}`);
 *   an installed application supplies `id = entry.id`, `name = entry.displayName`.
 *
 * # The `showable` mapping
 *
 * A built-in's `showable` is the app's own static declaration. For an installed
 * application the equivalent fact is "may it be the subject of a companion
 * turn?" — and a `disabled` application cannot be opened at all (the launcher's
 * own rule: `LauncherInstalledAppsSection.tsx:57-65`, "A `disabled` application
 * cannot be opened, so offering it here would be a…"), so offering it as a turn
 * target would be a lie. A `working` or `failing` application IS targetable — a
 * `failing` record is a claim about the host's record, not a claim the app is
 * unusable (G-475).
 */

import { getApplications } from '../../applications/applicationRegistry';
import type { FredoAppRef } from '../companion/composerTarget';
import { getInstalledApps } from './store';
import type { InstalledAppEntry } from './types';

/**
 * May an installed application be the subject of a companion turn?
 *
 * Mirrors the launcher's own openability rule (`state !== 'disabled'`): a
 * `disabled` application is deliberately off, so it is not a target; a
 * `working`/`failing` one is.
 */
export function isInstalledAppTargetable(entry: InstalledAppEntry): boolean {
  return entry.state !== 'disabled';
}

/**
 * Project BOTH registries into the matcher's narrow view: the built-in features
 * first (their pinned order), then every installed application.
 *
 * The order is stable and the two sets are disjoint by construction — an
 * installed package may not claim a reserved built-in id — so the built-in list
 * is a deterministic prefix.
 */
export function readCompanionAppRefs(): FredoAppRef[] {
  const builtIns: FredoAppRef[] = getApplications().map((application) => ({
    id: application.id,
    name: application.name,
    showable: application.showable,
  }));
  const installed: FredoAppRef[] = getInstalledApps().map((entry) => ({
    id: entry.id,
    name: entry.displayName,
    showable: isInstalledAppTargetable(entry),
  }));
  return [...builtIns, ...installed];
}
