/**
 * Companion application-skill reply copy (Spec #3099, ST-6).
 *
 * THE ONE generic copy source for every published application surface — it
 * replaces the Wireframe-only `wireframeReply.ts`. The four variant situations
 * are bound verbatim by the plan (UI/UX §4, QA Q-6/Q-10/Q-14/Q-15), so these
 * formatters — not ad-hoc strings in the hooks — are the authoritative
 * observables:
 *
 *   - list actions      — `<listLabel ?? `${appName} actions`>: <id> — <description>; …`
 *                          (U+2014 em dash, `; ` join, NO trailing period)
 *   - performed         — `Performed in <appName>: <descriptions joined by ", ">.`
 *                          (terminal period is BINDING; descriptions, never ids)
 *   - unknown action    — `I don't know the <appName> action "<action>". Nothing changed.`
 *                          (plain ASCII quotes)
 *   - nothing changed   — `I couldn't do that in <appName>. Nothing changed.`
 *
 * Pure text — no React, no store, no Tauri, no clock. Every surface value comes
 * from the manifest the caller already resolved (never a local rebuild).
 */

import { COMPANION_LIST_ACTIONS_ID, type CompanionSurfaceManifest } from './manifest';

/** U+2014 EM DASH — binding copy, never a hyphen or an en dash. */
const EM_DASH = '\u2014';
/** U+0022 ASCII double quote — binding copy, never curly. */
const REPLY_QUOTE = '"';

/**
 * The listing prefix: the surface's declared wording override, else
 * `<appName> actions`. A blank/whitespace-only override is treated as absent
 * (never a bare `: <id>` prefix).
 */
export function appCommandListLabel(surface: CompanionSurfaceManifest): string {
  const label = surface.listLabel;
  if (label !== undefined && label.trim() !== '') return label;
  return `${surface.appName} actions`;
}

/**
 * The full published list, one `id — description` entry per command in
 * declaration order, semicolon-joined. The reserved `listActions` id is never a
 * command and is never listed (it is answered by this formatter).
 */
export function appCommandListReply(surface: CompanionSurfaceManifest): string {
  const entries = surface.commands
    .filter((command) => command.id !== COMPANION_LIST_ACTIONS_ID)
    .map((command) => `${command.id} ${EM_DASH} ${command.description}`);
  return `${appCommandListLabel(surface)}: ${entries.join('; ')}`;
}

/**
 * The success reply for a performed command: the DESCRIPTION of every performed
 * command id, in `performed` order, comma-joined, with the binding terminal
 * period. Never an id (an id absent from the manifest contributes nothing — the
 * relay only ever reports ids the surface published).
 */
export function appCommandPerformedReply(
  surface: CompanionSurfaceManifest,
  performed: readonly string[],
): string {
  const descriptions = performed
    .map(
      (id) =>
        surface.commands.find((command) => command.id === id)?.description,
    )
    .filter((description): description is string => description !== undefined);
  return `Performed in ${surface.appName}: ${descriptions.join(', ')}.`;
}

/** The requested action id is not in the published manifest. */
export function appCommandUnknownActionReply(
  surface: CompanionSurfaceManifest,
  action: string,
): string {
  return `I don't know the ${surface.appName} action ${REPLY_QUOTE}${action}${REPLY_QUOTE}. Nothing changed.`;
}

/** A published action was asked for but performed nothing (or could not run). */
export function appCommandNothingChangedReply(
  surface: CompanionSurfaceManifest,
): string {
  return `I couldn't do that in ${surface.appName}. Nothing changed.`;
}
