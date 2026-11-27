/**
 * Spec #3244 ST-1 — the resolved application description + the typed
 * "no description" failure.
 *
 * # Why this module exists
 *
 * An Fredo application declares what it is for in exactly one of two places:
 *
 *   - a **built-in** feature class declares `FredoApplicationClass.description`
 *     (`shared/classes/FredoApplicationClass.ts`) — a REQUIRED member since
 *     #3244, so `tsc` refuses a built-in without one; or
 *   - an **installed** application declares `description` in its `fredo-app.json`
 *     manifest — structurally OPTIONAL (the `manifestVersion: 1` schema stays
 *     closed, and the field stays an absent key when unset; G-413).
 *
 * The companion must not care which tier it is talking to, so this module is the
 * ONE seam that collapses both declaration sites into a single resolved view —
 * `AppDescription` — and turns a genuinely absent (or blank) description into the
 * typed `noDescription` failure instead of a silent turn (AC-1, R-1b).
 *
 * # The absent-key boundary (G-413)
 *
 * An installed entry's `description` arrives as an ABSENT KEY when the manifest
 * omitted one — never `null`, never `undefined`. The resolver treats an absent
 * key AND a blank (whitespace-only) string identically: both are `noDescription`.
 * It never manufactures a placeholder string; the typed failure is the contract.
 *
 * Pure module state reads only — no React, no IPC, no side effects.
 */

import { getApplications } from '../../applications/applicationRegistry';
import type { FredoApplicationClass } from '../classes/FredoApplicationClass';
import { getInstalledApps } from '../installed-apps/store';
import type { InstalledAppEntry } from '../installed-apps/types';
import type { AppOpenReplyKind } from '../components/companion/appOpenReply';

/**
 * The ONE resolved view the companion consumes: an application's identity plus
 * the description it declared. `description` is REQUIRED and non-empty here — a
 * caller that holds an `AppDescription` holds proof the app is intelligible.
 */
export interface AppDescription {
  readonly appId: string;
  readonly name: string;
  readonly description: string;
}

/**
 * The typed failure for an application with no resolvable description
 * (R-1b / AC-1). It is NOT a new install-refusal code (the frozen 22 stay
 * frozen) and NOT the app-open "couldn't open it" case (G-505): the app may have
 * opened; the fault is intelligibility.
 *
 * `kind` is bound to the companion reply vocabulary so the reply carrier and the
 * failure can never drift apart.
 */
export interface AppIntelligibilityFailure {
  readonly kind: Extract<AppOpenReplyKind, 'noDescription'>;
  readonly appId: string;
}

/** Which of the two declaration sites a description came from. */
export type AppDescriptionOrigin = 'built-in' | 'installed';

/**
 * The source-of-truth union over the two declaration sites — a built-in feature
 * class OR an installed-app entry. A resolver reads from exactly one of these;
 * nothing else declares an application description.
 */
export type AppDescriptionSource =
  | { readonly origin: 'built-in'; readonly feature: FredoApplicationClass }
  | { readonly origin: 'installed'; readonly entry: InstalledAppEntry };

/**
 * Either a resolved description (with the tier it came from) or the typed
 * `noDescription` failure. Discriminated on `kind`, so a caller must narrow.
 */
export type AppDescriptionResolution =
  | {
      readonly kind: 'resolved';
      readonly origin: AppDescriptionOrigin;
      readonly description: AppDescription;
    }
  | AppIntelligibilityFailure;

/**
 * Locate the declaration site for `appId`: the built-in registry first, then the
 * installed-app registry. Returns `null` when NO tier knows the id.
 *
 * The built-in registry is checked first because a built-in id can never also be
 * an installed id (installed packages may not claim a reserved built-in id).
 */
export function locateAppDescriptionSource(appId: string): AppDescriptionSource | null {
  const feature = getApplications().find((candidate) => candidate.id === appId);
  if (feature !== undefined) return { origin: 'built-in', feature };
  const entry = getInstalledApps().find((candidate) => candidate.id === appId);
  if (entry !== undefined) return { origin: 'installed', entry };
  return null;
}

/** The display name + declared description behind a source (description may be unset). */
function readSource(source: AppDescriptionSource): {
  readonly name: string;
  readonly description: string | undefined;
} {
  if (source.origin === 'built-in') {
    return { name: source.feature.name, description: source.feature.description };
  }
  return { name: source.entry.displayName, description: source.entry.description };
}

/**
 * Resolve `appId` to a single `AppDescription`, or the typed `noDescription`
 * failure (R-1a/R-1b/R-2a).
 *
 * A blank description counts as MISSING — an empty or whitespace-only string is
 * never accepted as intelligible.
 */
export function resolveAppDescription(appId: string): AppDescriptionResolution {
  const source = locateAppDescriptionSource(appId);
  if (source === null) return { kind: 'noDescription', appId };

  const { name, description } = readSource(source);
  const declared = description ?? '';
  if (declared.trim() === '') return { kind: 'noDescription', appId };

  return {
    kind: 'resolved',
    origin: source.origin,
    description: { appId, name, description: declared },
  };
}
