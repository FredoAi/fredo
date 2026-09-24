/**
 * Spec 2934 ST-3 — the Terminal window UI (session sidebar, add-session prompt,
 * per-session terminals, typed error states).
 *
 * Spec 2935 ST-4 extends the same suite: the two labelled groups, the persisted
 * "Previous sessions" rows, resume / start-fresh / delete, and the typed resume
 * surfaces — plus the two re-gated rules ("All sessions ended" must not mask
 * resumable records; the add-session prompt must not fire when records exist).
 *
 * Drives the REAL `TerminalWindow` against a mocked Tauri command surface
 * (`adapterBridge`) and a mocked `ghostty-web` renderer, so the contracts are
 * provable without a Tauri host. The ghostty mock counts `new Terminal()` so the
 * no-remount-on-switch invariant (AC2 / NFR) is asserted as an instance count.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type {
  PersistedTerminalSession,
  ResumeResult,
  TerminalSessionInfo,
} from '../../sessionModel';

const ghostty = vi.hoisted(() => ({ constructed: 0, focused: 0, fit: 0 }));

vi.mock('ghostty-web', () => {
  class FitAddon {
    fit() {
      ghostty.fit++;
    }
    observeResize() {}
    dispose() {}
  }
  class Terminal {
    constructor(_opts: unknown) {
      ghostty.constructed++;
    }
    loadAddon() {}
    open() {}
    write() {}
    writeln() {}
    focus() {
      ghostty.focused++;
    }
    dispose() {}
    onResize() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
  }
  return { init: async () => {}, Terminal, FitAddon };
});

import { TerminalWindow } from '../TerminalWindow';

let sessions: TerminalSessionInfo[] = [];
let persisted: PersistedTerminalSession[] = [];
let settings: Record<string, string> = {};
let spawnResult = 'real-1';
let resumeResult: ResumeResult = { outcome: 'resumed', sessionId: null };
const listeners: Record<string, (payload: unknown) => void> = {};

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case 'list_terminal_sessions':
      return sessions;
    case 'list_persisted_terminal_sessions':
      return persisted;
    case 'spawn_terminal_session':
      return spawnResult;
    case 'resume_terminal_session':
      return resumeResult;
    case 'delete_terminal_session_record':
      persisted = persisted.filter((r) => r.id !== args?.sessionId);
      return undefined;
    case 'get_pty_buffer':
      return [];
    case 'get_setting':
      return settings[String(args?.key)] ?? null;
    case 'save_setting':
      return undefined;
    case 'open_terminal_window':
      return undefined;
    case 'close_terminal_session':
      return undefined;
    default:
      return undefined;
  }
});

function session(overrides: Partial<TerminalSessionInfo>): TerminalSessionInfo {
  return {
    id: 'a',
    cli: 'opencode',
    status: 'running',
    error: null,
    errorKind: null,
    workDir: 'C:\\Code\\fredo',
    cols: 80,
    rows: 24,
    pid: 101,
    startedAt: 1,
    ...overrides,
  };
}

function record(overrides: Partial<PersistedTerminalSession>): PersistedTerminalSession {
  return {
    id: 'p1',
    cli: 'opencode',
    workDir: 'C:\\Code\\fredo',
    title: 'OpenCode',
    createdAt: 1,
    lastActiveAt: Date.now() - 3 * 60 * 60 * 1000,
    cliSessionId: null,
    ...overrides,
  };
}

function renderWindow() {
  return renderWithChakra(<TerminalWindow />);
}

function rowButton(title: string, status: string) {
  return screen.getByRole('button', { name: `${title}, ${title}, ${status}` });
}

beforeEach(() => {
  ghostty.constructed = 0;
  ghostty.focused = 0;
  ghostty.fit = 0;
  sessions = [];
  persisted = [];
  settings = {};
  spawnResult = 'real-1';
  resumeResult = { outcome: 'resumed', sessionId: null };
  for (const key of Object.keys(listeners)) delete listeners[key];
  localStorage.clear();
  adapterBridge.setInvoke(invoke as never);
  adapterBridge.setListen((async (event: string, handler: (payload: unknown) => void) => {
    listeners[event] = handler;
    return () => {
      delete listeners[event];
    };
  }) as never);
});

afterEach(() => {
  cleanup();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Spec 2934 ST-3 — Terminal window', () => {
  it('empty window renders the empty state and auto-opens the add-session prompt', async () => {
    renderWindow();

    expect(await screen.findByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByText('Add a session to run OpenCode or GitHub Copilot.')).toBeInTheDocument();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('renders the sidebar list with a row per session, composed aria-labels and status text', async () => {
    sessions = [
      session({ id: 'a', cli: 'opencode', status: 'running' }),
      session({ id: 'b', cli: 'copilot', status: 'starting' }),
    ];
    renderWindow();

    const nav = await screen.findByRole('navigation', { name: 'Terminal sessions' });
    const list = within(nav).getByRole('list', { name: 'Active sessions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    // Status is a dot PLUS a text label (never colour alone).
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('starting')).toBeInTheDocument();

    // The selected row carries aria-current="true".
    await waitFor(() =>
      expect(rowButton('OpenCode', 'running')).toHaveAttribute('aria-current', 'true'),
    );
    expect(rowButton('GitHub Copilot', 'starting')).not.toHaveAttribute('aria-current');
  });

  it('reacts to terminal-sessions-changed by adding rows', async () => {
    renderWindow();
    await screen.findByText('No sessions yet');

    listeners['terminal-sessions-changed']?.({ sessions: [session({ id: 'z', cli: 'copilot' })] });

    expect(await screen.findByText('GitHub Copilot')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('No sessions yet')).toBeNull());
  });

  it('switches sessions without re-spawning or remounting a terminal', async () => {
    sessions = [
      session({ id: 'a', cli: 'opencode' }),
      session({ id: 'b', cli: 'copilot', pid: 202 }),
    ];
    renderWindow();

    await waitFor(() => expect(screen.getByTestId('terminal-surface-a')).toHaveAttribute('data-active', 'true'));
    await waitFor(() => expect(ghostty.constructed).toBe(2));
    const before = ghostty.constructed;

    fireEvent.click(rowButton('GitHub Copilot', 'running'));

    await waitFor(() =>
      expect(screen.getByTestId('terminal-surface-b')).toHaveAttribute('data-active', 'true'),
    );
    expect(screen.getByTestId('terminal-surface-a')).toHaveAttribute('data-active', 'false');
    // No new terminal instance, no re-spawn, and the switch focused the new PTY.
    expect(ghostty.constructed).toBe(before);
    await waitFor(() => expect(ghostty.focused).toBeGreaterThan(0), { timeout: 2000 });
  });

  it('adds a session: the prompt preselects the default CLI and prefills the migrated work dir', async () => {
    settings = { terminal_default_cli: 'copilot', terminal_work_dir: 'C:\\repo' };
    renderWindow();

    const dialog = await screen.findByRole('dialog');
    const copilotRadio = dialog.querySelector<HTMLInputElement>('input[type="radio"][value="copilot"]');
    const opencodeRadio = dialog.querySelector<HTMLInputElement>('input[type="radio"][value="opencode"]');
    expect(copilotRadio).not.toBeNull();
    await waitFor(() => expect(copilotRadio).toHaveAttribute('aria-checked', 'true'));
    expect(opencodeRadio).toHaveAttribute('aria-checked', 'false');

    const workDirInput = screen.getByLabelText('Working directory') as HTMLInputElement;
    expect(workDirInput.value).toBe('C:\\repo');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add session' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('spawn_terminal_session', {
        cli: 'copilot',
        workDir: 'C:\\repo',
      }),
    );
  });

  it('renders the typed error state for each cause (no message parsing)', async () => {
    sessions = [
      session({
        id: 'e',
        cli: 'copilot',
        status: 'error',
        errorKind: 'prereq',
        error: 'GitHub Copilot requires PowerShell 6 or newer (pwsh).',
      }),
    ];
    const { unmount } = renderWindow();

    const state = await screen.findByTestId('terminal-error-state');
    expect(state).toHaveAttribute('data-error-kind', 'prereq');
    expect(screen.getByText('PowerShell 6 or newer required')).toBeInTheDocument();

    unmount();
    cleanup();

    sessions = [
      session({
        id: 'm',
        cli: 'copilot',
        status: 'error',
        errorKind: 'missing-binary',
        error: '`copilot` not found in PATH.',
      }),
    ];
    renderWindow();

    await screen.findByTestId('terminal-error-state');
    expect(screen.getByText('GitHub Copilot not found')).toBeInTheDocument();
  });

  it('falls back to the generic launch error for an untyped message (the old regex is gone)', async () => {
    sessions = [
      session({
        id: 'g',
        cli: 'opencode',
        status: 'error',
        errorKind: null,
        error: 'opencode not found in PATH',
      }),
    ];
    renderWindow();

    await screen.findByTestId('terminal-error-state');
    expect(screen.getByText('Could not start session')).toBeInTheDocument();
    expect(screen.queryByText('OpenCode not found')).toBeNull();
  });

  it('shows the explicit "All sessions ended" state when every session exited (window stays open)', async () => {
    sessions = [
      session({ id: 'a', status: 'exited' }),
      session({ id: 'b', cli: 'copilot', status: 'exited' }),
    ];
    renderWindow();

    expect(await screen.findByText('All sessions ended')).toBeInTheDocument();
    expect(screen.getByText('Every session in this window has exited.')).toBeInTheDocument();
    expect(screen.queryByText('This session has ended')).toBeNull();
  });

  it('shows the per-session ended banner (with Restart) while other sessions live', async () => {
    sessions = [
      session({ id: 'a', status: 'exited' }),
      session({ id: 'b', cli: 'copilot', status: 'running' }),
    ];
    renderWindow();

    await screen.findByTestId('terminal-surface-b');
    fireEvent.click(rowButton('OpenCode', 'exited'));

    expect(await screen.findByText('This session has ended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart session' })).toBeInTheDocument();
  });

  it('renders no leftover legacy CLI copy anywhere', async () => {
    sessions = [session({ id: 'a' }), session({ id: 'b', cli: 'copilot' })];
    renderWindow();
    await screen.findByTestId('terminal-surface-a');

    expect(document.body.textContent ?? '').not.toMatch(/run[\s-]?cli/i);
  });
});

describe('Spec 2935 ST-4 — reopened window: persisted records + resume', () => {
  it('lists persisted records in "Previous sessions" and auto-selects the newest with zero clicks', async () => {
    persisted = [
      record({ id: 'p-old', title: 'OpenCode', lastActiveAt: 1_000 }),
      record({ id: 'p-new', title: 'OpenCode 2', lastActiveAt: 9_000_000_000_000 }),
    ];
    renderWindow();

    // Both groups labelled; no empty state (records exist).
    await screen.findByRole('group', { name: 'Previous sessions' });
    expect(screen.queryByText('No sessions yet')).toBeNull();

    // The newest record is the default selection → the Resume card is immediate.
    expect(await screen.findByTestId('terminal-resume-state')).toBeInTheDocument();
    expect(
      screen.getByTestId('terminal-previous-session-row-p-new'),
    ).toHaveAttribute('aria-current', 'true');

    // A record with no process must NOT auto-open the add-session prompt.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not let "All sessions ended" mask resumable records (live exited + previous record)', async () => {
    sessions = [session({ id: 'live-1', status: 'exited' })];
    persisted = [record({ id: 'p1' })];
    renderWindow();

    await screen.findByTestId('terminal-previous-session-row-p1');
    // The window-level all-ended surface is suppressed while a record is resumable.
    expect(screen.queryByText('All sessions ended')).toBeNull();
    // The live exited session shows its per-session banner instead.
    fireEvent.click(screen.getByTestId('terminal-session-row-live-1').querySelector('button')!);
    expect(await screen.findByText('This session has ended')).toBeInTheDocument();
    // And the Previous group stays present/actionable.
    expect(screen.getByRole('group', { name: 'Previous sessions' })).toBeInTheDocument();
  });

  it('renders a previous row with title, state label, relative last-active and work-dir basename', async () => {
    persisted = [record({ id: 'p1', title: 'OpenCode', workDir: 'C:\\Code\\fredo' })];
    renderWindow();

    const row = await screen.findByTestId('terminal-previous-session-row-p1');
    expect(row).toHaveTextContent('OpenCode');
    expect(row).toHaveTextContent('not running');
    expect(row).toHaveTextContent('3h ago');
    expect(row).toHaveTextContent('fredo');
    expect(row.getAttribute('aria-label')).toContain('last active 3h ago');
  });

  it('resumes a record: the live session reuses the record id and leaves the Previous group', async () => {
    persisted = [record({ id: 'p1', cli: 'opencode' })];
    renderWindow();

    await screen.findByTestId('terminal-resume-state');
    // The backend reuses the source record: the live session carries the same id.
    sessions = [session({ id: 'p1', cli: 'opencode', status: 'running' })];
    resumeResult = { outcome: 'resumed', sessionId: 'p1' };

    fireEvent.click(within(screen.getByTestId('terminal-resume-state')).getByRole('button', { name: 'Resume' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('resume_terminal_session', { sessionId: 'p1' }),
    );
    await waitFor(() => expect(screen.queryByTestId('terminal-previous-session-row-p1')).toBeNull());
    expect(await screen.findByTestId('terminal-surface-p1')).toBeInTheDocument();
  });

  it('surfaces a missing CLI as the cli-missing blocked state (never a fresh session)', async () => {
    persisted = [record({ id: 'p1', cli: 'copilot' })];
    resumeResult = { outcome: 'missing-binary', message: 'copilot not found' };
    renderWindow();

    await screen.findByTestId('terminal-resume-state');
    fireEvent.click(within(screen.getByTestId('terminal-resume-state')).getByRole('button', { name: 'Resume' }));

    const blocked = await screen.findByTestId('terminal-resume-blocked-state');
    expect(blocked).toHaveAttribute('data-reason', 'cli-missing');
    expect(screen.getByText("GitHub Copilot isn't installed")).toBeInTheDocument();
    // No fresh/partial session was started.
    expect(screen.queryByTestId('terminal-surface-p1')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('spawn_terminal_session', expect.anything());
  });

  it('surfaces a failed resume with Retry, and Retry succeeds once the cause clears', async () => {
    persisted = [record({ id: 'p1' })];
    resumeResult = { outcome: 'unresumable', message: 'the CLI could not restore that session' };
    renderWindow();

    await screen.findByTestId('terminal-resume-state');
    fireEvent.click(within(screen.getByTestId('terminal-resume-state')).getByRole('button', { name: 'Resume' }));

    const blocked = await screen.findByTestId('terminal-resume-blocked-state');
    expect(blocked).toHaveAttribute('data-reason', 'resume-failed');
    expect(screen.getByText(/Nothing was started\. The session record is unchanged\./)).toBeInTheDocument();

    sessions = [session({ id: 'p1', status: 'running' })];
    resumeResult = { outcome: 'resumed', sessionId: 'p1' };
    fireEvent.click(within(blocked).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByTestId('terminal-previous-session-row-p1')).toBeNull());
    expect(await screen.findByTestId('terminal-surface-p1')).toBeInTheDocument();
  });

  it('deletes a record only after the confirm dialog, which says the transcript survives', async () => {
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    await screen.findByTestId('terminal-resume-state');
    fireEvent.click(within(screen.getByTestId('terminal-resume-state')).getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByTestId('terminal-delete-session-dialog');
    expect(within(dialog).getByText('Delete this session?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/CLI's own conversation transcript is not deleted/),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('delete_terminal_session_record', { sessionId: 'p1' }),
    );
    await waitFor(() => expect(screen.queryByTestId('terminal-previous-session-row-p1')).toBeNull());
    expect(await screen.findByText('No sessions yet')).toBeInTheDocument();
  });

  it('starts fresh: the unchanged dialog is prefilled and the record is replaced on confirm', async () => {
    persisted = [record({ id: 'p1', cli: 'copilot', workDir: 'C:\\repo' })];
    renderWindow();

    await screen.findByTestId('terminal-resume-state');
    fireEvent.click(within(screen.getByTestId('terminal-resume-state')).getByRole('button', { name: 'Start fresh' }));

    const dialog = await screen.findByRole('dialog');
    const workDirInput = screen.getByLabelText('Working directory') as HTMLInputElement;
    await waitFor(() => expect(workDirInput.value).toBe('C:\\repo'));
    const copilotRadio = dialog.querySelector<HTMLInputElement>('input[type="radio"][value="copilot"]');
    await waitFor(() => expect(copilotRadio).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add session' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('spawn_terminal_session', {
        cli: 'copilot',
        workDir: 'C:\\repo',
      }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('delete_terminal_session_record', { sessionId: 'p1' }),
    );
  });

  it('renders the new invalid-cli error state for an unknown CLI (AC4)', async () => {
    sessions = [
      session({
        id: 'bad',
        cli: 'opencode',
        status: 'error',
        errorKind: 'invalid-cli',
        error: "'bogus' is not a known CLI.",
      }),
    ];
    renderWindow();

    const state = await screen.findByTestId('terminal-error-state');
    expect(state).toHaveAttribute('data-error-kind', 'invalid-cli');
    expect(screen.getByText('Unknown CLI')).toBeInTheDocument();
    expect(screen.getByText("'bogus' is not a known CLI.")).toBeInTheDocument();
  });

  it('opens the requested CLI + folder directly from a launch intent (no dialog)', async () => {
    renderWindow();
    await waitFor(() => expect(listeners['terminal-open-request']).toBeTypeOf('function'));

    listeners['terminal-open-request']?.({ cli: 'copilot', workDir: 'C:\\repo' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('spawn_terminal_session', {
        cli: 'copilot',
        workDir: 'C:\\repo',
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
