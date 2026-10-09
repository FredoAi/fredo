/**
 * Spec #3009 ST-4 — terminal passthrough indicator + the terminal root anchor.
 *
 * The dedicated exit chord + release button are retired: the pill is
 * informational only and passthrough is released by click-away / focus change.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  BODY_PASSTHROUGH_ATTR,
  resetTerminalModeForTests,
  useTerminalPassthrough,
} from '@/shared/hotkeys/terminalMode';
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
import { TerminalPassthroughIndicator, TerminalWindow } from '../TerminalWindow';

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

describe('TerminalPassthroughIndicator', () => {
  it('conveys the state by icon + text (never colour alone)', () => {
    const { rerender } = renderWithChakra(<TerminalPassthroughIndicator active />);

    const pill = screen.getByTestId('hotkeys-terminal-passthrough');
    expect(pill).toHaveAttribute('data-passthrough', 'true');
    expect(pill).toHaveTextContent('Passthrough');

    rerender(<TerminalPassthroughIndicator active={false} />);
    const inactive = screen.getByTestId('hotkeys-terminal-passthrough');
    expect(inactive).toHaveAttribute('data-passthrough', 'false');
    expect(inactive).toHaveTextContent('Hotkeys active');
    expect(inactive).not.toHaveTextContent('Passthrough');
  });
});

describe('TerminalWindow — persistent indicator + passthrough state', () => {
  it('mounts the pill for a live session and reflects focus in/out of the terminal', async () => {
    sessions = [session({ id: 'a', status: 'running' })];
    renderWithChakra(<TerminalWindow />);

    const host = await screen.findByTestId('terminal-canvas-host-a');
    expect(host).toHaveAttribute('data-fredo-terminal-root', 'true');
    const pill = await screen.findByTestId('hotkeys-terminal-passthrough');
    expect(pill).toHaveAttribute('data-passthrough', 'false');

    // Focusing the session enters passthrough (indicator + body hook flip).
    act(() => {
      host.tabIndex = -1;
      host.focus();
    });
    await waitFor(() =>
      expect(screen.getByTestId('hotkeys-terminal-passthrough')).toHaveAttribute(
        'data-passthrough',
        'true',
      ),
    );
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');
  });
});

describe('terminalMode hook contract', () => {
  it('useTerminalPassthrough reports the live state', () => {
    function Probe() {
      const state = useTerminalPassthrough();
      return <span data-testid="probe" data-active={String(state.active)} />;
    }
    renderWithChakra(<Probe />);
    const probe = screen.getByTestId('probe');
    expect(probe).toHaveAttribute('data-active', 'false');
  });
});
