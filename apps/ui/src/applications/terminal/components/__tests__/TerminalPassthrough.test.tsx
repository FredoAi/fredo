/**
 * Spec #3009 ST-4 — the terminal root anchor; Spec #3051 removed the chip.
 *
 * Spec #3051 removed the keyboard-mode passthrough indicator: the terminal
 * renders NO chip in any focus state, while focus-derived passthrough (the
 * `data-fredo-passthrough` body hook) is retained unchanged.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { BODY_PASSTHROUGH_ATTR, resetTerminalModeForTests } from '@/shared/hotkeys/terminalMode';
import { resetHotkeyStatusForTests } from '@/shared/hotkeys/store';
import { resetRegistryForTests } from '@/shared/hotkeys/registry';
import type { PersistedTerminalSession, TerminalSessionInfo } from '../../sessionModel';

vi.mock('ghostty-web', () => {
  class FitAddon {
    fit() {}
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
    onData() {
      return { dispose() {} };
    }
  }
  return { init: async () => {}, Terminal, FitAddon };
});

import { SessionTerminal } from '../SessionTerminal';
import { TerminalWindow } from '../TerminalWindow';

let sessions: TerminalSessionInfo[] = [];
let persisted: PersistedTerminalSession[] = [];

const invoke = vi.fn(async (command: string) => {
  switch (command) {
    case 'list_terminal_sessions':
      return sessions;
    case 'list_persisted_terminal_sessions':
      return persisted;
    case 'get_pty_buffer':
      return [];
    case 'get_setting':
      return null;
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

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetHotkeyStatusForTests();
  resetTerminalModeForTests();
  document.body.removeAttribute(BODY_PASSTHROUGH_ATTR);
  sessions = [];
  persisted = [];
  adapterBridge.setInvoke(invoke as never);
  adapterBridge.setListen((async () => () => {}) as never);
});

afterEach(() => {
  cleanup();
  resetTerminalModeForTests();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('terminal root anchor', () => {
  it('SessionTerminal carries data-fredo-terminal-root="true"', () => {
    renderWithChakra(<SessionTerminal sessionId="a" active />);

    const host = screen.getByTestId('terminal-canvas-host-a');
    expect(host).toHaveAttribute('data-fredo-terminal-root', 'true');
  });
});

describe('TerminalWindow — no keyboard-mode chip (Spec #3051)', () => {
  it('renders no passthrough chip in any focus state', async () => {
    sessions = [session({ id: 'a', status: 'running' })];
    renderWithChakra(<TerminalWindow />);

    const host = await screen.findByTestId('terminal-canvas-host-a');
    expect(host).toHaveAttribute('data-fredo-terminal-root', 'true');

    // Unfocused: no chip element and no "Passthrough" / "Hotkeys active" copy.
    expect(screen.queryByTestId('hotkeys-terminal-passthrough')).toBeNull();
    expect(screen.queryByText('Passthrough')).toBeNull();
    expect(screen.queryByText('Hotkeys active')).toBeNull();

    // Focusing the session still enters focus-derived passthrough (the body hook
    // flips) — but STILL renders no chip.
    act(() => {
      host.tabIndex = -1;
      host.focus();
    });
    await waitFor(() =>
      expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true'),
    );
    expect(screen.queryByTestId('hotkeys-terminal-passthrough')).toBeNull();
    expect(screen.queryByText('Passthrough')).toBeNull();
    expect(screen.queryByText('Hotkeys active')).toBeNull();
  });
});
