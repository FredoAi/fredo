/**
 * Spec #2893 ST-6 — THE ONE app-identity resolution rule (R-2.7, R-1.1/1.2/1.3).
 *
 * Why this module exists: the same `"<spoken name>" -> a single showable feature`
 * decision is needed on two paths — the CLI's `app-open-request` round trip and
 * the companion skill's execution. Two independent copies would drift; one
 * exported pure function cannot. Both call sites MUST consume
 * `resolveAppIdentity` and never re-derive the rule.
 *
 * Rule (frozen, contract §6 / R-2.7):
 *   1. `normalizeAppQuery` — trim, drop surrounding quotes, drop ONE leading
 *      command verb (`open`/`launch`/`show`/`start`).
 *   2. normalized case-insensitive EXACT `id` match (stable kebab ids like
 *      `mission-monitor`) — these cannot be reached through the display-name
 *      matcher because the id is hyphenated while names are spaced.
 *   3. ELSE the launcher's whole-query display-name matcher `appNameMatches`
 *      (imported, never duplicated — `appNameMatches` is untouched).
 *   4. exactly one candidate -> `resolved`; more than one -> `ambiguous`;
 *      none -> `unknown`. No other alias matches.
 *
 * Addressable set mirrors `Home.tsx:26`:
 *   `dedupeByFeatureId(features.filter(f => f.showable))`
 * so the resolver agrees with the launcher grid by construction, is robust to
 * double-registration, and can never resolve a non-showable feature (Q-6 edge).
 *
 * Pure by construction: no React, no DOM, no Tauri, no timers, no state — so
 * every branch is unit-pinned without a rendering harness (QA-8 mocked registry).
 */
import { appNameMatches } from '../components/launcher/launcherEnterAction';
import { dedupeByFeatureId } from '../../featureRegistry';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';

/** The resolution outcome for one spoken/query identity. */
export type AppIdentityResolution =
  | { kind: 'resolved'; feature: FredoFeatureClass; displayName: string }
  | { kind: 'unknown'; spokenName: string }
  | { kind: 'ambiguous'; spokenName: string; candidates: FredoFeatureClass[] };

/**
 * R-2.7 — one leading command verb, case-insensitive, requiring whitespace and
 * a non-empty remainder. `open` alone is NOT stripped (there is no name to
 * open), so it resolves as an ordinary unknown identity instead of an empty
 * string that could accidentally match something.
 */
const LEADING_COMMAND_VERB = /^(?:open|launch|show|start)\s+(.+)$/i;

/** Drop ONE matching pair of surrounding quotes (`"` or `'`), then trim. */
function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/**
 * R-2.7 — normalize a user/CLI identity: `trim` -> strip surrounding quotes ->
 * strip ONE leading `open|launch|show|start` -> `trim`. Case is preserved (the
 * reply echoes the user's own words); matching lowercases separately.
 *
 * Quote stripping runs again after the verb so `open "Mission Monitor"` (verb
 * outside the quotes) normalizes too. Idempotent on already-normalized input.
 */
export function normalizeAppQuery(raw: string): string {
  if (typeof raw !== 'string') return '';
  let query = stripSurroundingQuotes(raw);
  const verb = LEADING_COMMAND_VERB.exec(query);
  if (verb) query = verb[1];
  return stripSurroundingQuotes(query);
}

/**
 * R-2.7 — resolve one identity against an EXPLICIT feature list (the parameter
 * exists so QA-8 can pin the ambiguity branch with a mocked >=2-entry registry;
 * production passes the launcher's `SHOWABLE_FEATURES`).
 *
 * The addressable set is re-derived here (`showable` + by-id dedupe) so the
 * resolver is correct regardless of what the caller was given and can never
 * disagree with the launcher grid.
 */
export function resolveAppIdentity(
  raw: string,
  features: readonly FredoFeatureClass[],
): AppIdentityResolution {
  const spokenName = normalizeAppQuery(raw);
  const addressable = dedupeByFeatureId(features.filter((feature) => feature.showable));

  if (spokenName !== '') {
    const lowered = spokenName.toLowerCase();
    const exact = addressable.find((feature) => feature.id.toLowerCase() === lowered);
    if (exact) return { kind: 'resolved', feature: exact, displayName: exact.name };

    const candidates = addressable.filter((feature) => appNameMatches(spokenName, feature.name));
    if (candidates.length === 1) {
      return { kind: 'resolved', feature: candidates[0], displayName: candidates[0].name };
    }
    if (candidates.length > 1) {
      return { kind: 'ambiguous', spokenName, candidates };
    }
  }

  return { kind: 'unknown', spokenName };
}
