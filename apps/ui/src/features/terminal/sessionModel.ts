import type { IconType } from 'react-icons';
import { LuFolderOpen, LuRotateCcw, LuTerminal, LuTriangleAlert } from 'react-icons/lu';

/**
 * Canonical wire types for the Terminal multi-session model (Spec 2934 ST-3).
 *
 * These mirror the ST-2 backend contract byte-for-byte — `TerminalSessionInfo`
 * is `#[serde(rename_all = "camelCase")]` and the enums are lowercase /
 * kebab-case. The UI reads a session's typed `errorKind` to pick its distinct
 * in-window state; it NEVER parses the free-form `error` string (the pre-ST-3
 * regex over the message text is deleted).
 */

export type TerminalCli = 'opencode' | 'copilot';

export type TerminalSessionStatus = 'starting' | 'running' | 'error' | 'exited';

/** Typed launch-failure kind (wire: kebab-case). Drives the distinct states. */
export type TerminalErrorKind =
  | 'missing-binary'
  | 'prereq'
  | 'invalid-cwd'
  | 'auth'
  // Spec 2935 R-4.1 — an unknown CLI name was refused before any process started.
  // Renders through the EXISTING `SessionErrorState` (UI/UX §2), not a new surface.
  | 'invalid-cli'
  // Spec 2940 ST-4 (R-3.4) — the exit watcher sets this when a RESUMED session's
  // CLI exits non-zero before it reconnects (`state.rs` `ResumeFailed`, wire
  // `"resume-failed"`, `commands.rs` `finalize_resume_failed`). It is a typed
  // wire kind, so the UI union carries it and `errorStateMeta` renders distinct
  // copy (never the generic "Could not start session" fallback). Additive only.
  | 'resume-failed'
  | 'launch'
  | 'generic';

/** One session's wire record (`list_terminal_sessions` / `terminal-sessions-changed`). */
export interface TerminalSessionInfo {
  id: string;
  cli: TerminalCli;
  status: TerminalSessionStatus;
  error: string | null;
  errorKind: TerminalErrorKind | null;
  workDir: string;
  cols: number;
  rows: number;
  pid: number | null;
  startedAt: number;
}

// ── Persisted records + resume contract (Spec 2935) ───────────────────────────
//
// A persisted record is NOT a live session: it has no process and no PTY. It is
// the durable identity of a session across a window close / app restart, read
// from `list_persisted_terminal_sessions` (ordered `lastActiveAt` DESC). Resume
// REUSES the source record — the live session created on `resumed` carries the
// SAME `id` (SI adjudication, `## Discussion`), so a record "moves" from the
// Previous group to This window without ever appearing in both.

export type PersistedSessionState = 'resumable' | 'unresumable';

/** Why a record's resume is blocked. `transcript-missing` is deliberately NOT
 *  renderable (SI adjudication: the CLI's own session store is out-of-repo). */
export type ResumeBlockedReason = 'cli-missing' | 'invalid-cwd' | 'resume-failed';

/** Display state of a Previous-sessions row (client-derived). */
export type PreviousSessionState = 'resumable' | 'resuming' | 'unresumable' | 'resume-failed';

export const PREVIOUS_STATE_LABEL: Record<PreviousSessionState, string> = {
  resumable: 'not running',
  resuming: 'resuming…',
  unresumable: "can't resume",
  'resume-failed': 'resume failed',
};

/** Status dot colours — always paired with the text label (never colour alone). */
export const PREVIOUS_STATE_DOT_COLOR: Record<PreviousSessionState, string> = {
  resumable: 'var(--text-secondary)',
  resuming: 'var(--status-warning)',
  unresumable: 'var(--status-warning)',
  'resume-failed': 'var(--status-error)',
};

/** One persisted session record (`list_persisted_terminal_sessions`), camelCase. */
export interface PersistedTerminalSession {
  id: string;
  cli: TerminalCli;
  workDir: string;
  /** STABLE identity minted once ("OpenCode", "OpenCode 2") — never re-derived. */
  title: string;
  createdAt: number;
  lastActiveAt: number;
  cliSessionId?: string | null;
}

/** `resume_terminal_session` outcome (wire: kebab-case). */
export type ResumeOutcome =
  | 'resumed'
  | 'unresumable'
  | 'missing-binary'
  | 'invalid-cwd'
  | 'launch-failed';

export interface ResumeResult {
  outcome: ResumeOutcome;
  /** The (reused) live session id on `resumed`. */
  sessionId?: string | null;
  /** Clear human message on any non-`resumed` outcome. */
  message?: string | null;
}

/**
 * Map a resume outcome onto the renderable blocked reason. `null` means the
 * resume is not blocked (only `resumed` maps to `null`).
 */
export function resumeBlockedReason(outcome: ResumeOutcome): ResumeBlockedReason | null {
  switch (outcome) {
    case 'missing-binary':
      return 'cli-missing';
    case 'invalid-cwd':
      return 'invalid-cwd';
    case 'unresumable':
    case 'launch-failed':
      return 'resume-failed';
    default:
      return null;
  }
}

/** Relative "last active" cell (UI/UX §2); the absolute time is exposed via `title`. */
export function lastActiveLabel(epochMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

/** Absolute timestamp for a row/meta `title` attribute. */
export function lastActiveAbsolute(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  return new Date(epochMs).toLocaleString();
}

/** Composed accessible name for a Previous-sessions row. */
export function persistedAriaLabel(
  record: PersistedTerminalSession,
  state: PreviousSessionState,
  now?: number,
): string {
  return `${record.title}, ${CLI_LABEL[record.cli]}, ${PREVIOUS_STATE_LABEL[state]}, last active ${lastActiveLabel(record.lastActiveAt, now)}`;
}

/** Newest-first ordering of persisted records (backend orders; this is the guarantee). */
export function sortPersistedSessions(
  records: readonly PersistedTerminalSession[],
): PersistedTerminalSession[] {
  return [...records].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

// ── Identity maps ─────────────────────────────────────────────────────────────

export const CLI_LABEL: Record<TerminalCli, string> = {
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
};

export const CLI_DESCRIPTION: Record<TerminalCli, string> = {
  opencode: 'Local agent CLI',
  copilot: "GitHub's agent CLI",
};

export const STATUS_LABEL: Record<TerminalSessionStatus, string> = {
  running: 'running',
  starting: 'starting',
  error: 'error',
  exited: 'exited',
};

/** Status dot colours — always paired with the text label (never colour alone). */
export const STATUS_DOT_COLOR: Record<TerminalSessionStatus, string> = {
  running: 'var(--status-success)',
  starting: 'var(--status-warning)',
  error: 'var(--status-error)',
  exited: 'var(--text-secondary)',
};

export const DEFAULT_CLI: TerminalCli = 'opencode';

/** Safe fallback for a corrupt/absent stored default (never guesses a new value). */
export function normalizeCli(value: unknown): TerminalCli {
  return value === 'copilot' ? 'copilot' : 'opencode';
}

// ── Derived display helpers ───────────────────────────────────────────────────

/**
 * `"OpenCode"` / `"GitHub Copilot"`, with an ordinal (`"OpenCode 2"`) only when
 * more than one session of that CLI exists in the window.
 */
export function sessionTitle(
  session: TerminalSessionInfo,
  sessions: readonly TerminalSessionInfo[],
): string {
  const sameCli = sessions.filter((s) => s.cli === session.cli);
  if (sameCli.length <= 1) return CLI_LABEL[session.cli];
  const ordinal = sameCli.findIndex((s) => s.id === session.id) + 1;
  return `${CLI_LABEL[session.cli]} ${ordinal}`;
}

/**
 * The name rendered for a session row (Spec 2942 ST-3, R-2.1/R-2.2).
 *
 * The persisted record's `title` is the SINGLE source of truth for a session's
 * name: a rename writes that one column, and BOTH the live row and its
 * previous-session row resolve through the same record map — one session
 * identity, one name (`resume` reuses the record's `id`, so the maps agree by
 * construction). Only a record-less row falls back to the derived ordinal title
 * (`sessionTitle`); a failed spawn never persists a record, so it cannot carry a
 * user-set name. `TerminalSessionInfo` deliberately keeps NO title field.
 */
export function sessionDisplayTitle(
  session: TerminalSessionInfo,
  sessions: readonly TerminalSessionInfo[],
  persistedById: ReadonlyMap<string, PersistedTerminalSession>,
): string {
  return persistedById.get(session.id)?.title ?? sessionTitle(session, sessions);
}

/**
 * Basename of a session's working directory for the sidebar's secondary line.
 * Blank / `.` / `~` render as `~` (the backend's home fallback).
 */
export function displayWorkDir(workDir: string | null | undefined): string {
  const path = (workDir ?? '').trim();
  if (!path || path === '.' || path === '~') return '~';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** Composed accessible name for a sidebar row's select affordance. */
export function sessionAriaLabel(
  session: TerminalSessionInfo,
  sessions: readonly TerminalSessionInfo[],
): string {
  return `${sessionTitle(session, sessions)}, ${CLI_LABEL[session.cli]}, ${STATUS_LABEL[session.status]}`;
}

// ── Error-state contract (typed, never regex) ─────────────────────────────────

export type ErrorAction = 'retry' | 'close' | 'choose-directory' | 'copy-command';

export interface ErrorStateMeta {
  icon: IconType;
  title: string;
  body: string;
  /** Render the raw backend message in addition to the static copy. */
  showRawMessage: boolean;
  actions: ErrorAction[];
}

/**
 * Map a session's typed `errorKind` onto its distinct in-window state. The
 * free-form `error` string is used ONLY as the raw message for the generic
 * launch/generic states — never parsed.
 */
export function errorStateMeta(session: TerminalSessionInfo): ErrorStateMeta {
  switch (session.errorKind) {
    case 'missing-binary':
      return session.cli === 'copilot'
        ? {
            icon: LuTerminal,
            title: 'GitHub Copilot not found',
            body: "`copilot` isn't on your PATH. Install the GitHub Copilot CLI, then retry.",
            showRawMessage: false,
            actions: ['retry', 'close'],
          }
        : {
            icon: LuTerminal,
            title: 'OpenCode not found',
            body: "`opencode` isn't on your PATH. Install OpenCode, then retry.",
            showRawMessage: false,
            actions: ['retry', 'close'],
          };
    case 'prereq':
      return {
        icon: LuTriangleAlert,
        title: 'PowerShell 6 or newer required',
        body: 'GitHub Copilot needs PowerShell 6+ (pwsh). Install PowerShell 7, then retry.',
        showRawMessage: false,
        actions: ['retry', 'close'],
      };
    case 'invalid-cwd':
      return {
        icon: LuFolderOpen,
        title: 'Working directory not found',
        body: `${session.workDir || 'The chosen directory'} doesn't exist. Pick another directory, or clear the field to use your home folder.`,
        showRawMessage: false,
        actions: ['choose-directory', 'close'],
      };
    case 'auth':
      return {
        icon: LuTriangleAlert,
        title: 'Not signed in to GitHub Copilot',
        body: 'GitHub Copilot needs you to sign in. Run `copilot auth login` in a terminal, then retry.',
        showRawMessage: false,
        actions: ['copy-command', 'retry', 'close'],
      };
    case 'invalid-cli':
      // AC4 R-4.1 — an unknown CLI name never starts a session. The backend's raw
      // message names the offending value; it is shown verbatim (never parsed).
      return {
        icon: LuTerminal,
        title: 'Unknown CLI',
        body: "That isn't a supported CLI. Choose OpenCode or GitHub Copilot.",
        showRawMessage: true,
        actions: ['close'],
      };
    case 'resume-failed':
      // Spec 2940 ST-4 — a RESUMED session died before it could settle. Distinct
      // from the generic launch copy so the typed wire kind is never mislabelled.
      // The backend's own message (`RESUME_FAILED_MESSAGE`, "Nothing was started;
      // the saved session is unchanged") is the readable cause copy.
      return {
        icon: LuRotateCcw,
        title: 'Could not resume session',
        body:
          session.error ??
          'The resumed session exited before it could reconnect. Nothing was started; the saved session is unchanged.',
        showRawMessage: false,
        actions: ['retry', 'close'],
      };
    case 'launch':
    case 'generic':
    default:
      return {
        icon: LuTriangleAlert,
        title: 'Could not start session',
        body: session.error ?? '',
        showRawMessage: !!session.error,
        actions: ['retry', 'close'],
      };
  }
}

/** The exact command the auth state tells a user to run (Copy command action). */
export const COPILOT_AUTH_COMMAND = 'copilot auth login';
