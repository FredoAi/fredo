/**
 * Spec #2946 ST-12 — terminal passthrough indicator + the terminal root anchor
 * (EARS R-5.7/R-5.8).
 *
 * Pins:
 *  - `SessionTerminal`'s container carries `data-fredo-terminal-root="true"` —
 *    the anchor the ST-4 classifier and ST-12 detection both key on;
 *  - the persistent `hotkeys-terminal-passthrough` pill names the exit chord via
 *    the shared `Keycap`, carries a real `hotkeys-terminal-passthrough-exit`
 *    button, and swaps copy state (`Passthrough` ↔ `Hotkeys active`) by icon +
 *    text (never colour alone);
 *  - the REAL `TerminalWindow` mounts that pill for a live session, and focusing
 *    the terminal session flips `data-passthrough="true"` (and the body hook),
 *    while activating the release button leaves passthrough.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  BODY_PASSTHROUGH_ATTR,
  resetTerminalModeForTests,
  useTerminalPassthrough,
} from '@/shared/hotkeys/terminalMode';
import { resetKeymapStoreForTests } from '@/shared/hotkeys/store';
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
  resetKeymapStoreForTests();
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

describe('terminal root anchor (R-5.7)', () => {
  it('SessionTerminal carries data-fredo-terminal-root="true"', () => {
    renderWithChakra(<SessionTerminal sessionId="a" active />);

    const host = screen.getByTestId('terminal-canvas-host-a');
    expect(host).toHaveAttribute('data-fredo-terminal-root', 'true');
  });
});

describe('TerminalPassthroughIndicator (R-5.8)', () => {
  it('names the exit chord and offers a real release button', () => {
    renderWithChakra(
      <TerminalPassthroughIndicator active exitChord="ctrl+shift+f10" />,
    );

    const pill = screen.getByTestId('hotkeys-terminal-passthrough');
    expect(pill).toHaveAttribute('data-passthrough', 'true');
    expect(pill).toHaveTextContent('Passthrough');

    const keycaps = screen.getAllByTestId('hotkeys-keycap');
    expect(keycaps).toHaveLength(1);
    expect(keycaps[0]).toHaveAttribute('data-chord-token', 'ctrl+shift+f10');

    const release = screen.getByTestId('hotkeys-terminal-passthrough-exit');
    expect(release.tagName).toBe('BUTTON');
    expect(release).toHaveTextContent('Release keyboard');
  });

  it('swaps state copy by icon + text (never colour alone)', () => {
    const { rerender } = renderWithChakra(
      <TerminalPassthroughIndicator active exitChord="ctrl+shift+f10" />,
    );
    expect(screen.getByTestId('hotkeys-terminal-passthrough')).toHaveTextContent('Passthrough');

    rerender(<TerminalPassthroughIndicator active={false} exitChord="ctrl+shift+f10" />);
    const pill = screen.getByTestId('hotkeys-terminal-passthrough');
    expect(pill).toHaveAttribute('data-passthrough', 'false');
    expect(pill).toHaveTextContent('Hotkeys active');
    expect(pill).not.toHaveTextContent('Passthrough');
  });

  it('renders no keycap when the exit binding is unbound', () => {
    renderWithChakra(<TerminalPassthroughIndicator active exitChord={null} />);
    expect(screen.queryAllByTestId('hotkeys-keycap')).toHaveLength(0);
    expect(screen.getByTestId('hotkeys-terminal-passthrough-exit')).toBeInTheDocument();
  });
});

describe('TerminalWindow — persistent indicator + passthrough state (R-5.7/R-5.8)', () => {
  it('mounts the pill for a live session and reflects focus in/out of the terminal', async () => {
    sessions = [session({ id: 'a', status: 'running' })];
    renderWithChakra(<TerminalWindow />);

    // The session root anchor + the persistent indicator are both present.
    const host = await screen.findByTestId('terminal-canvas-host-a');
    expect(host).toHaveAttribute('data-fredo-terminal-root', 'true');
    const pill = await screen.findByTestId('hotkeys-terminal-passthrough');
    expect(pill).toHaveAttribute('data-passthrough', 'false');
    expect(screen.getByTestId('hotkeys-terminal-passthrough-exit')).toBeInTheDocument();

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

    // Activating the real release button leaves passthrough (dispatch resumes).
    act(() => {
      fireEvent.click(screen.getByTestId('hotkeys-terminal-passthrough-exit'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('hotkeys-terminal-passthrough')).toHaveAttribute(
        'data-passthrough',
        'false',
      ),
    );
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });
});

describe('terminalMode hook contract', () => {
  it('useTerminalPassthrough reports the live state + exit chord', () => {
    function Probe() {
      const state = useTerminalPassthrough();
      return (
        <span data-testid="probe" data-active={String(state.active)}>
          {state.exitChord}
        </span>
      );
    }
    renderWithChakra(<Probe />);
    const probe = screen.getByTestId('probe');
    expect(probe).toHaveAttribute('data-active', 'false');
    expect(probe).toHaveTextContent('ctrl+shift+f10');
  });
});
