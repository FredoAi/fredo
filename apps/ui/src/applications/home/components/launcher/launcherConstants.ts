/**
 * Spec #3120 (P6) — the launcher confirmation names block.
 *
 * Every test id, accessible name and copy string below is the **binding contract**
 * for the launcher's ONLY await (`LauncherConfirmation`, UI/UX §2.4). The dialog
 * component and the QA suites read these names from here, so the surface can never
 * invent a parallel literal.
 *
 * Spec #3120 (P6) ST-7 (R-2/R-8) removed the app-scoped launcher navigation names
 * (context header, `>` action palette, grouped place palette, S6 response line and
 * the launcher announce region) with the palette and the app-scoped conversation
 * seam. The confirmation contract is unchanged.
 *
 * PURE: constants + the three pure title/accept/external formatters. No imports.
 */

/* ───────────────────────────── DOM hooks ───────────────────────────── */

export const LAUNCHER_CONFIRMATION_TESTID = 'launcher-confirmation';
export const LAUNCHER_CONFIRMATION_VERB_TESTID = 'launcher-confirmation-verb';
export const LAUNCHER_CONFIRMATION_TARGET_TESTID = 'launcher-confirmation-target';
export const LAUNCHER_CONFIRMATION_CONSEQUENCE_TESTID = 'launcher-confirmation-consequence';
export const LAUNCHER_CONFIRMATION_UNDO_TESTID = 'launcher-confirmation-undo';
export const LAUNCHER_CONFIRMATION_ACCEPT_TESTID = 'launcher-confirmation-accept';
export const LAUNCHER_CONFIRMATION_CANCEL_TESTID = 'launcher-confirmation-cancel';

/* ───────────────────────────── accessible names ───────────────────────────── */

export const LAUNCHER_CONFIRM_VERB_LABEL = 'Action';
export const LAUNCHER_CONFIRM_TARGET_LABEL = 'Target';
export const LAUNCHER_CONFIRM_CONSEQUENCE_LABEL = 'Consequence';

export const launcherConfirmTitle = (title: string): string => `Run ${title}?`;
export const launcherConfirmAccept = (title: string): string => `Apply ${title}`;
export const LAUNCHER_CONFIRM_CANCEL = 'Cancel';
export const LAUNCHER_CONFIRM_UNDOABLE = 'Undo available';
export const LAUNCHER_CONFIRM_NOT_UNDOABLE = 'Not undoable';
export const launcherConfirmExternal = (party: string): string => `Outside Fredo: ${party}`;
