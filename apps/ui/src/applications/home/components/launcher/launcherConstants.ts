/**
 * Spec #3120 (P6), ST-5 — the launcher navigation names block.
 *
 * Every test id, data-attribute hook, accessible name and copy string below is the
 * **binding contract** of the #3120 plan (`## Software Architect` §3.11, plus the
 * adjudicated D2 additions). The ST-5 pure modules/components, the ST-6 shell and the
 * QA suites all read these names from here, so a launcher surface can never invent a
 * parallel literal.
 *
 * The D2 additions are ADDITIVE ONLY — nothing in the §3.11 block is renamed or
 * renumbered. `LAUNCHER_SECONDARY_SEQUENCE` is the display-only sibling of the bound
 * `LAUNCHER_SECONDARY_CHORD` (a `Keycap` takes a serialized sequence, not a chord).
 *
 * PURE: constants + two pure formatters. No imports at runtime (the palette row type is
 * type-only, so this module stays the leaf of the launcher group).
 */

import type { ContextEnvelope } from '../../../../shared/navigation';
import type { LauncherPaletteRow } from './launcherNavigationPalette';

/* ───────────────────────────── DOM hooks ───────────────────────────── */

export const LAUNCHER_CONTEXT_TESTID = 'launcher-context';
export const LAUNCHER_CONTEXT_PATH_TESTID = 'launcher-context-path';
export const LAUNCHER_CONTEXT_SELECTION_TESTID = 'launcher-context-selection';
export const LAUNCHER_CONTEXT_VERBS_TESTID = 'launcher-context-verbs';
export const LAUNCHER_CONTEXT_VERB_TESTID = 'launcher-context-verb';
export const LAUNCHER_PALETTE_LIST_TESTID = 'launcher-palette-list';
export const LAUNCHER_PALETTE_GROUP_TESTID = 'launcher-palette-group';
export const LAUNCHER_PALETTE_GROUP_PATH_TESTID = 'launcher-palette-group-path';
export const LAUNCHER_PALETTE_ROW_TESTID = 'launcher-palette-row';
export const LAUNCHER_PALETTE_ROW_KEY_TESTID = 'launcher-palette-row-key';
export const LAUNCHER_PALETTE_ROW_RISK_TESTID = 'launcher-palette-row-risk';
export const LAUNCHER_PALETTE_SECONDARY_TESTID = 'launcher-palette-secondary';
export const LAUNCHER_PALETTE_SECONDARY_ITEM_TESTID = 'launcher-palette-secondary-item';
export const LAUNCHER_CONFIRMATION_TESTID = 'launcher-confirmation';
export const LAUNCHER_CONFIRMATION_VERB_TESTID = 'launcher-confirmation-verb';
export const LAUNCHER_CONFIRMATION_TARGET_TESTID = 'launcher-confirmation-target';
export const LAUNCHER_CONFIRMATION_CONSEQUENCE_TESTID = 'launcher-confirmation-consequence';
export const LAUNCHER_CONFIRMATION_UNDO_TESTID = 'launcher-confirmation-undo';
export const LAUNCHER_CONFIRMATION_ACCEPT_TESTID = 'launcher-confirmation-accept';
export const LAUNCHER_CONFIRMATION_CANCEL_TESTID = 'launcher-confirmation-cancel';
export const LAUNCHER_PALETTE_ANNOUNCER_TESTID = 'launcher-palette-announcer';

/* ───────────────────── additive hooks / copy (D2 — ST-5/ST-6) ───────────────────── */

/** The S6 response line (`clarify` / `rejected` / `undo-nothing` / `undo-failed`). */
export const LAUNCHER_RESPONSE_TESTID = 'launcher-response';
/** `data-launcher-response={clarify|rejected|undo-nothing|undo-failed}` on the S6 line. */
export const LAUNCHER_RESPONSE_ATTR = 'data-launcher-response';
/** `data-launcher-code={DispatchResult.code}` — only on a rejected/failed S6 line. */
export const LAUNCHER_RESPONSE_CODE_ATTR = 'data-launcher-code';
/** `data-launcher-section={recent|place}` on a palette row. */
export const LAUNCHER_SECTION_ATTR = 'data-launcher-section';
/** `data-launcher-action-kind={run|undo|map}` on a secondary item. */
export const LAUNCHER_ACTION_KIND_ATTR = 'data-launcher-action-kind';

/** DOM id of the palette row at `index` (the shell's `aria-activedescendant`). */
export const launcherNavigationRowId = (index: number): string => `fredo-launcher-nav-row-${index}`;
/** DOM id of the secondary action at `index`. */
export const launcherNavigationSecondaryId = (index: number): string =>
  `fredo-launcher-nav-secondary-${index}`;

/* ───────────────────────────── accessible names ───────────────────────────── */

export const LAUNCHER_CONTEXT_ARIA_LABEL = 'Current context';
export const LAUNCHER_CONTEXT_SELECTION_LABEL = 'Selection'; // D2 (ST-5)
export const LAUNCHER_CONTEXT_VERBS_LABEL = 'Actions'; // D2 (ST-5)
export const LAUNCHER_RECENT_LABEL = 'Recent'; // D2 (ST-5)
export const LAUNCHER_CONFIRM_VERB_LABEL = 'Action'; // D2 (ST-5)
export const LAUNCHER_CONFIRM_TARGET_LABEL = 'Target'; // D2 (ST-5)
export const LAUNCHER_CONFIRM_CONSEQUENCE_LABEL = 'Consequence'; // D2 (ST-5)
export const LAUNCHER_PALETTE_ARIA_LABEL = 'Places and actions';
export const LAUNCHER_SECONDARY_ARIA_LABEL = 'Row actions';
export const LAUNCHER_ANNOUNCER_LABEL = 'Launcher announcements';

export const launcherConfirmTitle = (title: string): string => `Run ${title}?`;
export const launcherConfirmAccept = (title: string): string => `Apply ${title}`;
export const LAUNCHER_CONFIRM_CANCEL = 'Cancel';
export const LAUNCHER_CONFIRM_UNDOABLE = 'Undo available';
export const LAUNCHER_CONFIRM_NOT_UNDOABLE = 'Not undoable';
export const launcherConfirmExternal = (party: string): string => `Outside Fredo: ${party}`;

/* ───────────────────────────── copy ───────────────────────────── */

export const LAUNCHER_PALETTE_EMPTY_COPY = 'No places or actions match';
export const LAUNCHER_CONTEXT_EMPTY_COPY = 'No context';
export const LAUNCHER_REJECTED_COPY = "That action couldn't run. Nothing changed."; // D2 (ST-6)

/** The context header's selection segment: the label, else `<n> selected`, else `''`. */
export function launcherSelectionSummary(selection: ContextEnvelope['selection']): string {
  if (selection.count === 0) return '';
  return selection.label ?? `${selection.count} selected`;
}

/* ───────────────────────────── announcement ───────────────────────────── */

/** The binding row announcement: `Title — Canvas › Edit — Destructive — X`. */
export function launcherPaletteAnnouncement(row: LauncherPaletteRow): string {
  const keySegment = row.keyHint === '' ? '' : ` — ${row.keyHint}`;
  return `${row.title} — ${row.pathLabel} — ${row.riskLabel ?? 'Safe'}${keySegment}`;
}

/* ───────────────────────────── chords ───────────────────────────── */

/** The bound Cmd/Ctrl+K chord (the shell listens; never a second document listener). */
export const LAUNCHER_SECONDARY_CHORD = { key: 'k', ctrlOrMeta: true } as const;
/** Display-only sibling of the chord (a `Keycap` takes a serialized sequence). */
export const LAUNCHER_SECONDARY_SEQUENCE = 'primary+k';
