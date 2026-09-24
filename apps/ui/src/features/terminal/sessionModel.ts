import type { IconType } from 'react-icons';
import { LuFolderOpen, LuTerminal, LuTriangleAlert } from 'react-icons/lu';

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
