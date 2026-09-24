/**
 * #2934 ST-3 — the Terminal window UI (session sidebar, add-session prompt,
 * per-session terminals, typed error states).
 *
 * Drives the REAL `TerminalWindow` against a mocked Tauri command surface
 * (`adapterBridge`) and a mocked `ghostty-web` renderer, so the sidebar /
 * switch / add-session / error-state contracts are provable without a Tauri
 * host. The ghostty mock counts `new Terminal()` so the no-remount-on-switch
 * invariant (AC2 / NFR) is asserted as an instance count, not a visual read.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { TerminalSessionInfo } from '../../sessionModel';

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
let settings: Record<string, string> = {};
let spawnResult = 'real-1';
const listeners: Record<string, (payload: unknown) => void> = {};

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case 'list_terminal_sessions':
      return sessions;
    case 'spawn_terminal_session':
      return spawnResult;
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
  settings = {};
  spawnResult = 'real-1';
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

describe('#2934 ST-3 — Terminal window', () => {
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

    const list = await screen.findByRole('list', { name: 'Terminal sessions' });
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
    expect(ghostty.focused).toBeGreaterThan(0);
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
    // The old message-regex would have produced "OpenCode not found".
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
