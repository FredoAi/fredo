/**
 * TerminalEntry tests (Spec #2947 ST-3).
 *
 * The mode-aware entry: it holds a BOUNDED hydration gate (G-224/G-225) until
 * the module-scoped presentation store settles, then renders the same-window
 * workspace (`TerminalWindow`) or the new-window launcher (`TerminalLauncher`).
 * The children are mocked so the test proves the SELECTION, not their internals.
 *
 * settingsService is mocked (same seam as presentation.test.ts) so the entry is
 * host-agnostic.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

vi.mock('../../../settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../TerminalWindow', () => ({
  TerminalWindow: () => <div data-testid="mock-terminal-window" />,
}));

vi.mock('../TerminalLauncher', () => ({
  TerminalLauncher: () => <div data-testid="mock-terminal-launcher" />,
}));

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  closeWindow,
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import { settingsService } from '../../../settings';
import { TerminalEntry } from '../TerminalEntry';
import {
  DEFAULT_PRESENTATION,
  resetTerminalPresentationStoreForTests,
  setTerminalPresentation,
} from '../../presentation';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;

let invoke: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Open the in-window `terminal` entry so `closeWindow('terminal')` reaches the callback. */
function openTerminalWindow(): void {
  openWindow({ id: 'terminal', title: 'Terminal', icon: null, component: null });
}

function drains(): boolean {
  return invoke.mock.calls.some(([command]) => command === 'close_terminal_window');
}

describe('TerminalEntry (Spec #2947 ST-3 — mode-aware frontend entry)', () => {
  beforeEach(() => {
    resetTerminalPresentationStoreForTests();
    resetWindowStoreForTests();
    getMock.mockReset();
    getMock.mockResolvedValue(DEFAULT_PRESENTATION);
    invoke = vi.fn(async () => undefined);
    adapterBridge.setInvoke(invoke as never);
    openTerminalWindow();
  });

  afterEach(() => {
    cleanup();
    adapterBridge.setInvoke(undefined as never);
    resetWindowStoreForTests();
  });

  it('holds the bounded loading gate until hydration settles, then renders the same-window workspace (R-2.1)', async () => {
    const gate = deferred<string>();
    getMock.mockReturnValue(gate.promise);

    renderWithChakra(<TerminalEntry />);

    // Gate held: no host is committed while the mode is unknown.
    expect(screen.getByTestId('terminal-entry-root')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-entry-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-terminal-window')).toBeNull();
    expect(screen.queryByTestId('mock-terminal-launcher')).toBeNull();

    gate.resolve('same-window');

    // Gate resolves on hydration settling: the workspace commits, the
    // placeholder is gone, and no launcher mounts.
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-entry-loading')).toBeNull();
    expect(screen.queryByTestId('mock-terminal-launcher')).toBeNull();
  });

  it('renders the launcher in new-window mode — unchanged shipped behaviour (R-3.1)', async () => {
    getMock.mockResolvedValue('new-window');

    renderWithChakra(<TerminalEntry />);

    expect(await screen.findByTestId('mock-terminal-launcher')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-terminal-window')).toBeNull();
  });

  it('normalizes an absent/unrecognized stored value to new-window (R-4.1)', async () => {
    getMock.mockResolvedValue('sideways');

    renderWithChakra(<TerminalEntry />);

    expect(await screen.findByTestId('mock-terminal-launcher')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-terminal-window')).toBeNull();
  });

  it('settles the gate when the hydration read fails (bounded hold always resolves)', async () => {
    getMock.mockRejectedValue(new Error('no host'));

    renderWithChakra(<TerminalEntry />);

    expect(await screen.findByTestId('mock-terminal-launcher')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-entry-loading')).toBeNull();
  });

  it('does not let the gate outlive its component (cancelled by unmount)', async () => {
    const gate = deferred<string>();
    getMock.mockReturnValue(gate.promise);

    const first = renderWithChakra(<TerminalEntry />);
    expect(first.getByTestId('terminal-entry-loading')).toBeInTheDocument();
    first.unmount();

    // Hydration settles AFTER unmount — no state update on the dead tree.
    gate.resolve('same-window');
    await gate.promise;
    await Promise.resolve();

    // A fresh mount reads the now-settled store without re-holding the gate.
    renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();
  });

  // ── FS-1 (#2947 round 2): in-window close drains + tree-kills (R-5.2) ───────

  it('drains every live session through close_terminal_window when the in-window Terminal closes (FS-1, R-5.2)', async () => {
    getMock.mockResolvedValue('same-window');

    renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();
    expect(drains()).toBe(false);

    // A REAL user close (chrome X / dock close) routes through the store.
    act(() => {
      closeWindow('terminal');
    });

    expect(invoke).toHaveBeenCalledWith('close_terminal_window', undefined);
  });

  it('does NOT drain in new-window mode — the launcher trampoline owns the close (R-6/F-13)', async () => {
    getMock.mockResolvedValue('new-window');

    renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-launcher')).toBeInTheDocument();

    // TerminalLauncher calls closeWindow('terminal') on every new-window open;
    // an unguarded drain would kill the session it just opened.
    act(() => {
      closeWindow('terminal');
    });

    expect(drains()).toBe(false);
  });

  it('does not double-drain when the store already flipped to new-window before the close (mode-change teardown owns it)', async () => {
    getMock.mockResolvedValue('same-window');

    renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();

    // TerminalSettings.persistSettings: the store moves synchronously, THEN the
    // window closes in the same tick — before React runs the effect cleanup.
    act(() => {
      void setTerminalPresentation('new-window');
      closeWindow('terminal');
    });

    // The handler re-reads the mode at close time and declines; TerminalSettings
    // invokes close_terminal_window itself.
    expect(drains()).toBe(false);
  });

  it('unregisters on cleanup so a later close never drains a stale host (store callback, not a mount lifecycle)', async () => {
    getMock.mockResolvedValue('same-window');

    const view = renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();

    view.unmount();

    act(() => {
      closeWindow('terminal');
    });

    expect(drains()).toBe(false);
  });
});
