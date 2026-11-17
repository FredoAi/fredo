/**
 * #3151 ST-6 (AC3 / R-3.5, Q-20) — Terminal works by POINTER alone.
 *
 * The navigation engine is gone: no command rail, no activity trail, no place
 * cursor and no stroke handler remain. The window's primary control is still
 * reachable and still does the whole job:
 *
 *   spawn a shell   → click `terminal-session-sidebar-add`, confirm the dialog
 *   type            → keystrokes reach the PTY through the xterm data callback
 *   close           → click `terminal-session-kill-<id>`
 *
 * No `shared/navigation` import may appear in this file (AC1's literal
 * predicate): the flow is pointer + PTY only.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { PersistedTerminalSession, TerminalSessionInfo } from '../sessionModel';

/** Captured xterm callbacks — the PTY input path is `onData` → `write_pty_input`. */
const ghostty = vi.hoisted(() => ({
  dataHandlers: [] as Array<(data: string) => void>,
}));

vi.mock('ghostty-web', () => {
  class FitAddon {
    fit() {}
    observeResize() {}
    dispose() {}
  }
  class Terminal {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
    onResize() {
      return { dispose() {} };
    }
    onData(handler: (data: string) => void) {
      ghostty.dataHandlers.push(handler);
      return { dispose() {} };
    }
  }
  return { init: async () => {}, Terminal, FitAddon };
});

import { TerminalWindow } from '../components/TerminalWindow';

let sessions: TerminalSessionInfo[] = [];
let persisted: PersistedTerminalSession[] = [];

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case 'list_terminal_sessions':
      return sessions;
    case 'list_persisted_terminal_sessions':
      return persisted;
    case 'spawn_terminal_session': {
      // The backend's `spawn_terminal_session`: create the live session the next
      // list returns, so the sidebar row + pane mount exactly as in the product.
      const created = session({ id: 'a', cli: String(args?.cli ?? 'shell') });
      sessions = [created];
      return 'a';
    }
    case 'close_terminal_session':
      sessions = sessions.filter((s) => s.id !== args?.sessionId);
      return undefined;
    case 'get_pty_buffer':
      return [];
    case 'get_setting':
      return null;
    default:
      return undefined;
  }
});

function session(overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    id: 'a',
    cli: 'shell',
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

beforeEach(() => {
  ghostty.dataHandlers.length = 0;
  sessions = [];
  persisted = [];
  localStorage.clear();
  adapterBridge.setInvoke(invoke as never);
  adapterBridge.setListen((async () => () => {}) as never);
});

afterEach(() => {
  cleanup();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
  vi.clearAllMocks();
  localStorage.clear();
});

describe('#3151 R-3.5 — Terminal primary control, pointer only', () => {
  it('spawns, types into and closes a session without any navigation surface', async () => {
    renderWithChakra(<TerminalWindow />);

    // ── spawn: the sidebar add control opens the New session dialog ──────────
    const add = await screen.findByTestId('terminal-session-sidebar-add');
    expect(add).toHaveAttribute('aria-label', 'Add session');
    fireEvent.click(add);

    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    // The plain-shell type is preselected (DEFAULT_KIND === 'shell') — confirm.
    fireEvent.click(within2(dialog, 'button', 'Add session'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'spawn_terminal_session',
        expect.objectContaining({ cli: 'shell' }),
      ),
    );

    // The spawned session becomes the live row; its pane mounts.
    const row = await screen.findByTestId('terminal-session-row-a');
    // `aria-current="true"` is the shipped selected-row marker (`TerminalSidebar`
    // renders it from `selectedId`), but the auto-select that sets `selectedId`
    // lands in a LATER effect tick than the row's mount. Await the state — a
    // synchronous read here passes only when the machine's timing happens to
    // flush that effect first (it did locally, not on CI).
    await waitFor(() =>
      expect(withinRow(row, 'button')).toHaveAttribute('aria-current', 'true'),
    );
    const host = await screen.findByTestId('terminal-canvas-host-a');
    expect(host).toHaveAttribute('data-fredo-terminal-root', 'true');

    // ── type: the xterm data callback is the PTY input path ─────────────────
    await waitFor(() => expect(ghostty.dataHandlers.length).toBeGreaterThan(0));
    ghostty.dataHandlers[0]('ls\r');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('write_pty_input', { sessionId: 'a', data: 'ls\r' }),
    );

    // ── close: the per-row kill control ends the session ────────────────────
    fireEvent.click(screen.getByTestId('terminal-session-kill-a'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('close_terminal_session', { sessionId: 'a' }),
    );
    await waitFor(() => expect(screen.queryByTestId('terminal-session-row-a')).toBeNull());
  });
});

/** Find a button by its visible text inside `scope` (the dialog's footer control). */
function within2(scope: HTMLElement, tag: 'button', text: string): HTMLElement {
  const matches = Array.from(scope.querySelectorAll<HTMLElement>(tag)).filter(
    (el) => el.textContent?.trim() === text,
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one <${tag}> "${text}", found ${matches.length}`);
  }
  return matches[0];
}

/** The row's clickable button (the row wrapper carries the testid). */
function withinRow(row: HTMLElement, tag: 'button'): HTMLElement {
  const match = row.querySelector<HTMLElement>(tag) ?? (row.tagName === 'BUTTON' ? row : null);
  if (match === null) throw new Error('the row has no button');
  return match;
}
