/**
 * Wireframe Companion reply copy (Spec #3070, ST-7, C9 / UI/UX §6).
 *
 * THE ONE copy source for the `wireframe` skill. The four variant situations are
 * bound verbatim by C9; the tester asserts them char-for-char, so these
 * formatters (not ad-hoc strings in the hooks) are the authoritative
 * observables:
 *
 *   - draft / execute success — `Started a new wireframe for <app>: <performed list>.`
 *   - unknown action          — `I don't know the Wireframe action "<action>". Nothing changed.`
 *   - known, nothing done     — `I couldn't do that in Wireframe. Nothing changed.`
 *   - list actions            — `Wireframe actions: <id> — <description>; …`
 *
 * The `performed` list in the success reply uses the HUMAN catalog descriptions
 * (never ids); ids appear only in the listActions reply (UI/UX §6 binding).
 *
 * Pure text — no React, no store, no Tauri.
 */

import {
  WIREFRAME_ACTIONS,
  findWireframeAction,
  type WireframeActionDefinition,
} from './wireframeActions';

/** The ASCII double quote is binding copy; never use curly quotes here. */
const REPLY_QUOTE = '"';

/**
 * R-6.1 — the full catalog, one `id — description` entry per action, in catalog
 * order. Semicolon-joined so a narrow bubble can scroll without truncation.
 */
export function wireframeListReply(
  actions: readonly WireframeActionDefinition[] = WIREFRAME_ACTIONS,
): string {
  const entries = actions.map((action) => `${action.id} — ${action.description}`);
  return `Wireframe actions: ${entries.join('; ')}`;
}

/**
 * R-6.3 — the success reply for a draft or an executed action. `performed` is
 * the exact executed subset, in execution order; ids resolve to their catalog
 * descriptions (an unknown id falls back to the id itself, never invented copy).
 */
export function wireframePerformedReply(
  appName: string,
  performed: readonly string[],
): string {
  const descriptions = performed.map(
    (id) => findWireframeAction(id)?.description ?? id,
  );
  return `Started a new wireframe for ${appName}: ${descriptions.join(', ')}.`;
}

/** R-6.4 — the requested action id is not in the catalog. */
export function wireframeUnknownActionReply(action: string): string {
  return `I don't know the Wireframe action ${REPLY_QUOTE}${action}${REPLY_QUOTE}. Nothing changed.`;
}

/** R-6.3/R-6.4 — a known action performed nothing (no selection, empty stack, …). */
export function wireframeNothingChangedReply(): string {
  return "I couldn't do that in Wireframe. Nothing changed.";
}
