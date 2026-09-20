/**
 * Spec #2893 ST-6 — THE ONE companion app-open reply-copy source (UI/UX §1).
 *
 * R-1..R-4 bind the user-visible reply to EXACT deterministic strings (never
 * freeform model prose): the tester asserts them char-for-char, so these
 * formatters are the authoritative observables. #2903 ST-3 adds the two close
 * formatters (`Closing <name>` / `<name> isn't open`) to this SAME module — the
 * ONE copy source, never a second. The Rust backend SHALL NOT author reply copy
 * — every caller (the companion skill-call path and the CLI
 * `app-open-request` confirmation message) composes text through here.
 *
 * Copy rules (binding):
 *   - Quotes are plain ASCII `"` (U+0022), never curly.
 *   - `spokenName` is echoed verbatim (case preserved, already trimmed by
 *     `normalizeAppQuery`); the unknown reply MUST name the unresolved identity.
 *   - The open-failed reply MUST contain the display name + a next step.
 *   - The reply is the WHOLE bubble text — no prefix/suffix.
 *
 * Pure text — no React, no theme values, no state.
 */

/** Which settle/hold the companion applies to a pushed reply (UI/UX §2). */
export type AppOpenReplyKind = 'success' | 'unknown' | 'ambiguous' | 'failed';

/** A composed deterministic reply: the whole bubble text + its outcome. */
export interface AppOpenReply {
  kind: AppOpenReplyKind;
  text: string;
}

/** S2 success — `Opening Mission Monitor`. */
export function appOpenSuccessReply(displayName: string): string {
  return `Opening ${displayName}`;
}

/** S3 unknown — `I couldn't find "Narnia"` (unresolved name verbatim). */
export function appOpenUnknownReply(spokenName: string): string {
  return `I couldn't find "${spokenName}"`;
}

/**
 * S4 ambiguous — `I found more than one app matching "<spoken>". Which one did
 * you mean: A or B?` with the UI/UX join rule (2 -> `A or B`; 3 -> `A, B, or C`;
 * >3 -> first 3 as `A, B, or C` suffixed ` (and N more)`).
 */
export function appOpenAmbiguousReply(
  spokenName: string,
  candidateNames: readonly string[],
): string {
  return `I found more than one app matching "${spokenName}". Which one did you mean: ${joinCandidateNames(candidateNames)}?`;
}

/**
 * S5 open failed — `I couldn't open Mission Monitor. Try again from the launcher grid.`
 */
export function appOpenFailedReply(displayName: string): string {
  return `I couldn't open ${displayName}. Try again from the launcher grid.`;
}

/**
 * #2903 ST-3 close success — `Closing Mission Monitor`. Mirrors
 * `appOpenSuccessReply` exactly (same pattern/tone, ASCII, no trailing period);
 * kind `success`, so the shipped happy beat applies.
 */
export function appCloseSuccessReply(displayName: string): string {
  return `Closing ${displayName}`;
}

/**
 * #2903 ST-3 close requested but the target window is NOT open — truthful
 * no-action copy `Mission Monitor isn't open` (plain ASCII apostrophe U+0027,
 * no trailing period); kind `failed`, so the shipped idle hold applies and the
 * reply never claims a close that did not happen.
 *
 * There is deliberately NO `appCloseFailedReply`: `windowStore.closeWindow` is
 * synchronous, idempotent and re-entrancy-guarded with no failure channel
 * (`windowStore.ts:116-124`), so a user-reachable "close failed" state does not
 * exist (G-198).
 */
export function appCloseNotOpenReply(displayName: string): string {
  return `${displayName} isn't open`;
}

/**
 * UI/UX §1 join rule. Exported for direct pinning; the ambiguous formatter is
 * the only production consumer.
 */
export function joinCandidateNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  const firstThree = `${names[0]}, ${names[1]}, or ${names[2]}`;
  if (names.length === 3) return firstThree;
  return `${firstThree} (and ${names.length - 3} more)`;
}
