/**
 * Spec 2934 ST-3 — the Terminal window UI (session navigation, add-session
 * prompt, per-session terminals, typed error states).
 *
 * Spec 2935 ST-4 extends the same suite: the persisted "Previous sessions" rows,
 * resume / start-fresh / delete, and the typed resume surfaces — plus the two
 * re-gated rules ("All sessions ended" must not mask resumable records; the
 * add-session prompt must not fire when records exist).
 *
 * Spec 2940 ST-3 reworked the composition into ONE 44 px `SessionBar` rail; Spec
 * 2942 ST-5 SUPERSEDES that rail with the compact VERTICAL
 * `terminal-session-sidebar` (its `This window` + `Previous` lists render inline
 * — no History popover, no tablist/tab roles). The suite asserts the current DOM
 * contract (`terminal-session-sidebar`, `terminal-session-row-<id>`,
 * `terminal-previous-session-row-<id>`, `terminal-pane` + `data-surface`/
 * `data-cols`/`data-rows`, `terminal-canvas-host-<id>`) alongside every preserved
 * testid, and asserts the superseded #2940 rail surfaces ABSENT so the rail
 * cannot silently return. Spec 2942 ST-3 adds the inline-rename rows (the name
 * is the only editable field; a blank name never writes).
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

const ghostty = vi.hoisted(() => ({
  constructed: 0,
  focused: 0,
  fit: 0,
  // Per-construction fit dims the mock Terminal reports (index = build order).
  dims: [] as Array<{ cols: number; rows: number }>,
}));

vi.mock('ghostty-web', () => {
  class FitAddon {
    fit() {
      ghostty.fit++;
    }
    observeResize() {}
    dispose() {}
  }
  class Terminal {
    cols: number;
    rows: number;
    constructor(_opts: unknown) {
      ghostty.constructed++;
      const dims = ghostty.dims[ghostty.constructed - 1] ?? { cols: 80, rows: 24 };
      this.cols = dims.cols;
      this.rows = dims.rows;
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

// jsdom 24 has no ResizeObserver, but the Chakra Popover's floating-ui autoUpdate
// reaches for it (Spec 2940 ST-3 History panel). A no-op stub keeps the popover
// mountable under test without changing the production component.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

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
    case 'rename_terminal_session_record': {
      // The backend's atomic `title` UPDATE: one row, same id (G-242).
      const sid = String(args?.sessionId);
      const name = String(args?.name);
      persisted = persisted.map((r) => (r.id === sid ? { ...r, title: name } : r));
      return undefined;
    }
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

/**
 * A live row's select affordance — its composed `sessionAriaLabel` accessible
 * name (`name, type label, status`).
 */
function rowButton(name: string, status: string, typeLabel: string = name) {
  return screen.getByRole('button', { name: `${name}, ${typeLabel}, ${status}` });
}

beforeEach(() => {
  ghostty.constructed = 0;
  ghostty.focused = 0;
  ghostty.fit = 0;
  ghostty.dims = [];
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
    expect(await screen.findByRole('dialog', { name: 'New session' })).toBeInTheDocument();
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('renders the vertical sidebar with one compact row per session, composed aria-labels and status text', async () => {
    sessions = [
      session({ id: 'a', cli: 'opencode', status: 'running' }),
      session({ id: 'b', cli: 'copilot', status: 'starting' }),
    ];
    renderWindow();

    const sidebar = await screen.findByTestId('terminal-session-sidebar');
    expect(sidebar).toHaveAttribute('aria-label', 'Terminal sessions');
    expect(within(sidebar).getByTestId('terminal-session-sidebar-live-section')).toHaveTextContent(
      'This window (2)',
    );
    // The superseded #2940 rail contract is gone (no rail, no tablist/tab roles).
    expect(screen.queryByTestId('terminal-session-bar')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();

    // One live row per session; the PRESERVED row testid still wraps a `button`.
    expect(within(sidebar).getAllByTestId(/^terminal-session-row-/)).toHaveLength(2);
    expect(
      screen.getByTestId('terminal-session-row-a').querySelector('button'),
    ).toBeInTheDocument();

    // Status is a dot PLUS a visible text label for the NON-NOMINAL states only
    // (the compact-row concession, UI/UX §7). The accessible name always carries
    // the status, so a running row is never colour-alone.
    expect(screen.getByText('starting')).toBeInTheDocument();
    expect(screen.queryByText('running')).toBeNull();

    // The active row carries aria-current="true"; the peer does not.
    await waitFor(() => expect(rowButton('OpenCode', 'running')).toHaveAttribute('aria-current', 'true'));
    expect(rowButton('GitHub Copilot', 'starting')).not.toHaveAttribute('aria-current');
  });

  it('pins the section headers below the REAL add-header stack (ST-5a / F-80)', async () => {
    sessions = [session({ id: 'a', cli: 'opencode', status: 'running' })];
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    // The pinned add header's REAL outer height is 37 px (36 px button + 1 px
    // borderBottom). The live header pins there; the Previous header pins below
    // the live header's 24 px (37 + 24 = 61). The prior 60 px literal painted
    // the Previous header 23 px over its first row in the reopen state.
    const sidebar = await screen.findByTestId('terminal-session-sidebar');
    expect(
      getComputedStyle(within(sidebar).getByTestId('terminal-session-sidebar-live-section')).top,
    ).toBe('37px');
    expect(
      getComputedStyle(within(sidebar).getByTestId('terminal-session-sidebar-previous-section')).top,
    ).toBe('61px');

    cleanup();
    // Reopen state (persisted records, ZERO live sessions): the Previous header
    // is the FIRST pinned section and sticks directly below the add header.
    sessions = [];
    renderWindow();
    const reopened = await screen.findByTestId('terminal-session-sidebar');
    expect(
      getComputedStyle(within(reopened).getByTestId('terminal-session-sidebar-previous-section')).top,
    ).toBe('37px');
  });

  it('exposes the C-3 pane hooks: region label, data-surface and the canvas host', async () => {
    sessions = [session({ id: 'a', cli: 'opencode', status: 'running' })];
    renderWindow();

    const pane = await screen.findByTestId('terminal-pane');
    expect(pane).toHaveAttribute('role', 'region');
    // The pane label tracks the selection (the selection effect runs post-mount).
    await waitFor(() => expect(pane).toHaveAttribute('aria-label', 'OpenCode terminal'));
    // A `running` session before its first byte still paints the starting overlay.
    await waitFor(() => expect(pane).toHaveAttribute('data-surface', 'starting'));
    // First byte → the overlay clears and the terminal surface is painted.
    listeners['terminal-output']?.({ sessionId: 'a', data: [65] });
    await waitFor(() => expect(pane).toHaveAttribute('data-surface', 'terminal'));
    expect(await screen.findByTestId('terminal-canvas-host-a')).toBeInTheDocument();
  });

  it('paints the deterministic data-surface for each state', async () => {
    sessions = [session({ id: 'e', cli: 'opencode', status: 'error', errorKind: 'prereq', error: 'x' })];
    renderWindow();
    await waitFor(() => expect(screen.getByTestId('terminal-pane')).toHaveAttribute('data-surface', 'error'));

    cleanup();
    sessions = [session({ id: 'x', status: 'exited' })];
    renderWindow();
    await waitFor(() =>
      expect(screen.getByTestId('terminal-pane')).toHaveAttribute('data-surface', 'all-ended'),
    );

    cleanup();
    sessions = [session({ id: 's', status: 'starting' })];
    renderWindow();
    await waitFor(() =>
      expect(screen.getByTestId('terminal-pane')).toHaveAttribute('data-surface', 'starting'),
    );
  });

  it('reacts to terminal-sessions-changed by adding a sidebar row', async () => {
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

  it('supports roving-tabindex keyboard navigation across the sidebar rows', async () => {
    sessions = [
      session({ id: 'a', cli: 'opencode' }),
      session({ id: 'b', cli: 'copilot' }),
    ];
    renderWindow();

    const rowA = await screen.findByTestId('terminal-session-row-a');
    await waitFor(() =>
      expect(screen.getByTestId('terminal-surface-a')).toHaveAttribute('data-active', 'true'),
    );

    fireEvent.keyDown(rowA.querySelector('button')!, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getByTestId('terminal-surface-b')).toHaveAttribute('data-active', 'true'),
    );

    fireEvent.keyDown(screen.getByTestId('terminal-session-row-b').querySelector('button')!, {
      key: 'Home',
    });
    await waitFor(() =>
      expect(screen.getByTestId('terminal-surface-a')).toHaveAttribute('data-active', 'true'),
    );

    fireEvent.keyDown(screen.getByTestId('terminal-session-row-a').querySelector('button')!, {
      key: 'End',
    });
    await waitFor(() =>
      expect(screen.getByTestId('terminal-surface-b')).toHaveAttribute('data-active', 'true'),
    );
  });

  it('adds a session: the prompt preselects the default CLI and prefills the migrated work dir', async () => {
    settings = { terminal_default_cli: 'copilot', terminal_work_dir: 'C:\\repo' };
    renderWindow();

    const dialog = await screen.findByRole('dialog', { name: 'New session' });
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
    fireEvent.click(screen.getByTestId('terminal-session-row-a').querySelector('button')!);

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
  it('lists persisted records inline in the sidebar and auto-selects the newest with zero clicks', async () => {
    persisted = [
      record({ id: 'p-old', title: 'OpenCode', lastActiveAt: 1_000 }),
      record({ id: 'p-new', title: 'OpenCode 2', lastActiveAt: 9_000_000_000_000 }),
    ];
    renderWindow();

    // The records render IN the sidebar's Previous section — no History popover.
    const sidebar = await screen.findByTestId('terminal-session-sidebar');
    expect(screen.queryByText('No sessions yet')).toBeNull();
    expect(within(sidebar).getByTestId('terminal-session-sidebar-previous-section')).toHaveTextContent(
      'Previous (2)',
    );
    expect(within(sidebar).getByTestId('terminal-previous-session-row-p-old')).toBeInTheDocument();

    // The newest record is the default selection → the Resume card is immediate.
    expect(await screen.findByTestId('terminal-resume-state')).toBeInTheDocument();
    expect(
      screen.getByTestId('terminal-previous-session-row-p-new'),
    ).toHaveAttribute('aria-current', 'true');

    // A record with no process must NOT auto-open the add-session prompt.
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('renders the Previous rows inside the sidebar, with the retired History popover gone', async () => {
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    const sidebar = await screen.findByTestId('terminal-session-sidebar');
    const row = await screen.findByTestId('terminal-previous-session-row-p1');
    expect(sidebar.contains(row)).toBe(true);

    // The superseded #2940 History surfaces no longer exist anywhere.
    expect(screen.queryByTestId('terminal-previous-toggle')).toBeNull();
    expect(screen.queryByTestId('terminal-previous-panel')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Previous sessions' })).toBeNull();

    // The sidebar is an in-flow `nav`, not a modal dialog → no focus trap.
    expect(sidebar.tagName).toBe('NAV');
    expect(sidebar).not.toHaveAttribute('aria-modal');
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
    // And the Previous record stays present/actionable in the sidebar.
    expect(screen.getByTestId('terminal-session-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-previous-session-row-p1')).toBeInTheDocument();
  });

  it('renders the compact previous row (title, relative last-active, state in the aria-label)', async () => {
    persisted = [record({ id: 'p1', title: 'OpenCode', workDir: 'C:\\Code\\fredo' })];
    renderWindow();

    const row = await screen.findByTestId('terminal-previous-session-row-p1');
    expect(row).toHaveTextContent('OpenCode');
    expect(row).toHaveTextContent('3h ago');
    // The compact #2942 row drops the visible work-dir line and the "not running"
    // word — both stay in the accessible name (the pane surfaces the directory).
    expect(row).not.toHaveTextContent('fredo');
    expect(row.getAttribute('aria-label')).toContain('not running');
    expect(row.getAttribute('aria-label')).toContain('last active 3h ago');
  });

  it('resumes a record: the live session reuses the record id and leaves the Previous section', async () => {
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

    const dialog = await screen.findByRole('dialog', { name: 'New session' });
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
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });
});

/**
 * Spec 2935 ST-5 — the `fredo open-terminal` transport contract as the webview
 * sees it. The backend validates and resolves `--cli`/`--dir` defaults BEFORE it
 * emits (single spawner), so the UI-side pins are: a missing CLI falls back to
 * OpenCode, a missing/blank dir falls back to the home default, and neither path
 * opens a dialog. The typed error states the CLI path can surface are pinned
 * alongside (R-4.2 `invalid-cwd`; R-4.1 `invalid-cli` is pinned above).
 */
describe('Spec 2935 ST-5 — open-terminal launch-intent defaults + error states', () => {
  it('falls back to the default kind (plain shell) when the launch intent carries no CLI (--dir only)', async () => {
    // Spec #2942 R-3.1/R-3.2 — the shipped default kind is `shell`, so a
    // defensive no-CLI intent resolves to a plain Terminal (not OpenCode).
    renderWindow();
    await waitFor(() => expect(listeners['terminal-open-request']).toBeTypeOf('function'));

    listeners['terminal-open-request']?.({ cli: undefined, workDir: 'C:\\repo' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('spawn_terminal_session', {
        cli: 'shell',
        workDir: 'C:\\repo',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('spawns with no explicit dir when the launch intent carries a blank work dir (--cli only)', async () => {
    renderWindow();
    await waitFor(() => expect(listeners['terminal-open-request']).toBeTypeOf('function'));

    listeners['terminal-open-request']?.({ cli: 'copilot', workDir: '' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('spawn_terminal_session', {
        cli: 'copilot',
        workDir: undefined,
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('renders the invalid-cwd error state the CLI path can surface (never a partial session)', async () => {
    sessions = [
      session({
        id: 'bad-dir',
        cli: 'opencode',
        status: 'error',
        errorKind: 'invalid-cwd',
        error: 'Working directory not found: C:\\no-such-dir',
        workDir: 'C:\\no-such-dir',
      }),
    ];
    renderWindow();

    const state = await screen.findByTestId('terminal-error-state');
    expect(state).toHaveAttribute('data-error-kind', 'invalid-cwd');
    expect(screen.getByText('Working directory not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose directory/ })).toBeInTheDocument();
  });
});

/**
 * Spec 2940 ST-3 — the C-2 canvas-host ↔ pane fit receipt. The pane stamps
 * `data-cols`/`data-rows` from the ACTIVE session's last applied fit, and the
 * values follow the active session when the selection switches. jsdom reports a
 * 0×0 box, so the two geometry reads the fit path guards on are stubbed for this
 * test only (the real fit path is exercised in SessionTerminal.resize.test.tsx).
 */
describe('Spec 2940 ST-3 — pane fit receipt (C-2)', () => {
  it('stamps data-cols/data-rows from the ACTIVE session and follows a switch', async () => {
    const origWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    const origHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    try {
      sessions = [
        session({ id: 'a', cli: 'opencode' }),
        session({ id: 'b', cli: 'copilot', pid: 202 }),
      ];
      // Build order = mount order: a → 100×30, b → 140×40.
      ghostty.dims = [
        { cols: 100, rows: 30 },
        { cols: 140, rows: 40 },
      ];
      renderWindow();

      // Switch to session b → the pane receipt must be b's fit, not a's.
      fireEvent.click((await screen.findByTestId('terminal-session-row-b')).querySelector('button')!);

      const pane = screen.getByTestId('terminal-pane');
      await waitFor(() => expect(pane).toHaveAttribute('data-cols', '140'));
      expect(pane).toHaveAttribute('data-rows', '40');

      // Switch back to a → the receipt follows the newly ACTIVE session.
      fireEvent.click(screen.getByTestId('terminal-session-row-a').querySelector('button')!);
      await waitFor(() => expect(pane).toHaveAttribute('data-cols', '100'));
      expect(pane).toHaveAttribute('data-rows', '30');
    } finally {
      if (origWidth) Object.defineProperty(Element.prototype, 'clientWidth', origWidth);
      if (origHeight) Object.defineProperty(Element.prototype, 'clientHeight', origHeight);
    }
  });
});

/**
 * Spec 2942 ST-3 — inline session rename (R-2.1–R-2.5). The name is the
 * session's ONLY editable field and the persisted record's `title` is its single
 * source of truth, so ONE atomic write renames the live row AND the
 * previous-session row (they share the record `id`). A blank / whitespace-only
 * name is a NO-WRITE that reverts to the prior name and shows an inline error.
 */
describe('Spec 2942 ST-3 — inline session rename', () => {
  it('shows the record title on the LIVE row and renames it onto the previous row', async () => {
    // The record's title is deliberately NOT the derived `sessionTitle` — the
    // record map is the source of truth for a live row's name (SA §4).
    sessions = [session({ id: 'p1', cli: 'opencode' })];
    persisted = [record({ id: 'p1', title: 'Build agent' })];
    renderWindow();

    await waitFor(() =>
      expect(rowButton('Build agent', 'running', 'OpenCode')).toBeInTheDocument(),
    );

    fireEvent.click(await screen.findByTestId('terminal-session-rename-p1'));
    const input = await screen.findByTestId('terminal-session-rename-input-p1');
    expect(input).toHaveValue('Build agent');

    // Enter commits the TRIMMED name.
    fireEvent.change(input, { target: { value: '  My build agent  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('rename_terminal_session_record', {
        sessionId: 'p1',
        name: 'My build agent',
      }),
    );
    expect(screen.queryByTestId('terminal-session-rename-input-p1')).toBeNull();
    // The DOM aria-label carries the new name too (one identity, one name).
    await waitFor(() =>
      expect(rowButton('My build agent', 'running', 'OpenCode')).toBeInTheDocument(),
    );

    // Close the live session: the SAME record moves to the Previous section
    // carrying the renamed name.
    fireEvent.click(screen.getByTestId('terminal-session-kill-p1'));
    const previousRow = await screen.findByTestId('terminal-previous-session-row-p1');
    expect(previousRow).toHaveTextContent('My build agent');
    expect(previousRow.getAttribute('aria-label')).toContain('My build agent');
  });

  it('renames a previous-session record from its own row', async () => {
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    fireEvent.click(await screen.findByTestId('terminal-session-rename-p1'));
    const input = await screen.findByTestId('terminal-session-rename-input-p1');
    expect(input).toHaveValue('OpenCode');

    fireEvent.change(input, { target: { value: 'Old work' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('rename_terminal_session_record', {
        sessionId: 'p1',
        name: 'Old work',
      }),
    );
    const row = await screen.findByTestId('terminal-previous-session-row-p1');
    expect(row).toHaveTextContent('Old work');
    expect(row.getAttribute('aria-label')).toContain('Old work');
  });

  it('refuses a blank name: no write, revert to the prior name, inline error announced', async () => {
    sessions = [session({ id: 'p1', cli: 'opencode' })];
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    fireEvent.click(await screen.findByTestId('terminal-session-rename-p1'));
    const input = await screen.findByTestId('terminal-session-rename-input-p1');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // R-2.3 — NO write for a blank/whitespace-only name.
    expect(invoke).not.toHaveBeenCalledWith('rename_terminal_session_record', expect.anything());
    // The row reverts to the prior name (never an empty row)…
    await waitFor(() => expect(rowButton('OpenCode', 'running')).toBeInTheDocument());
    expect(screen.queryByTestId('terminal-session-rename-input-p1')).toBeNull();
    // …shows the inline muted error, and the live region announces it.
    expect(await screen.findByTestId('terminal-session-rename-error-p1')).toHaveTextContent(
      "Name can't be empty",
    );
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Name can't be empty");
  });

  it('cancels with Esc: no write, the prior name survives', async () => {
    sessions = [session({ id: 'p1', cli: 'opencode' })];
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    fireEvent.click(await screen.findByTestId('terminal-session-rename-p1'));
    const input = await screen.findByTestId('terminal-session-rename-input-p1');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('terminal-session-rename-input-p1')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('rename_terminal_session_record', expect.anything());
    expect(rowButton('OpenCode', 'running')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-session-row-p1')).not.toHaveTextContent('Discarded');
  });

  it('renames without ending the session, re-spawning, or remounting its terminal (R-2.4)', async () => {
    sessions = [session({ id: 'p1', cli: 'opencode' })];
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    await waitFor(() => expect(ghostty.constructed).toBe(1));
    const terminalsBefore = ghostty.constructed;
    invoke.mockClear();

    fireEvent.click(await screen.findByTestId('terminal-session-rename-p1'));
    const input = await screen.findByTestId('terminal-session-rename-input-p1');
    fireEvent.change(input, { target: { value: 'Deploy bot' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('rename_terminal_session_record', {
        sessionId: 'p1',
        name: 'Deploy bot',
      }),
    );
    // Metadata-only: the session is never closed or re-spawned, and the same
    // terminal instance stays mounted (no scrollback loss).
    expect(invoke).not.toHaveBeenCalledWith('close_terminal_session', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('spawn_terminal_session', expect.anything());
    expect(ghostty.constructed).toBe(terminalsBefore);
    expect(screen.getByTestId('terminal-surface-p1')).toBeInTheDocument();
    expect(
      screen.getByTestId('terminal-session-row-p1').querySelector('button'),
    ).toHaveAttribute('aria-current', 'true');
  });

  it('opens the inline editor with F2 on a focused row', async () => {
    sessions = [session({ id: 'p1', cli: 'opencode' })];
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();

    const row = await screen.findByTestId('terminal-session-row-p1');
    fireEvent.keyDown(row.querySelector('button')!, { key: 'F2' });

    expect(await screen.findByTestId('terminal-session-rename-input-p1')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('rename_terminal_session_record', expect.anything());
  });

  it('reconciles a rename from the terminal-persisted-sessions-changed event', async () => {
    sessions = [session({ id: 'p1', cli: 'opencode' })];
    persisted = [record({ id: 'p1', title: 'OpenCode' })];
    renderWindow();
    await waitFor(() => expect(rowButton('OpenCode', 'running')).toBeInTheDocument());

    listeners['terminal-persisted-sessions-changed']?.({
      sessions: [record({ id: 'p1', title: 'Renamed elsewhere' })],
    });

    await waitFor(() =>
      expect(rowButton('Renamed elsewhere', 'running', 'OpenCode')).toBeInTheDocument(),
    );
  });
});
