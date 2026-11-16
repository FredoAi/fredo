/**
 * TerminalEntry tests (Spec #2947 ST-3; reworked by #2955 ST-4).
 *
 * The in-window Terminal host now ALWAYS renders the workspace
 * (`TerminalWindow`): the per-app presentation choice is owned by the ONE
 * presentation-aware opener (`Home.openApp`), which never routes a `new-window`
 * app through the in-window kernel. The old render-time trampoline
 * (`TerminalLauncher`) is retired. These pins prove the workspace is the only
 * host this component renders and that the FS-1 in-window close drain is
 * preserved.
 *
 * settingsService is mocked (same seam as the store tests) so the entry is
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

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  closeWindow,
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import {
  resetAppPresentationStoreForTests,
  setAppPresentation,
} from '@/shared/window-system/appPresentationStore';
import { settingsService } from '../../../settings';
import { TerminalEntry } from '../TerminalEntry';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;

let invoke: ReturnType<typeof vi.fn>;

/** Open the in-window `terminal` entry so `closeWindow('terminal')` reaches the callback. */
function openTerminalWindow(): void {
  openWindow({ id: 'terminal', title: 'Terminal', icon: null, component: null });
}

function drains(): boolean {
  return invoke.mock.calls.some(([command]) => command === 'close_terminal_window');
}

describe('TerminalEntry (Spec #2955 ST-4 — in-window host; the ONE opener owns the branch)', () => {
  beforeEach(() => {
    resetAppPresentationStoreForTests();
    resetWindowStoreForTests();
    getMock.mockReset();
    getMock.mockResolvedValue('same-window');
    invoke = vi.fn(async () => undefined);
    adapterBridge.setInvoke(invoke as never);
    openTerminalWindow();
  });

  afterEach(() => {
    cleanup();
    adapterBridge.setInvoke(undefined as never);
    resetWindowStoreForTests();
  });

  it('always renders the in-window workspace — no render-time host trampoline (ST-4)', async () => {
    renderWithChakra(<TerminalEntry />);

    expect(screen.getByTestId('terminal-entry-root')).toBeInTheDocument();
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();
    // The retired launcher/loading branch is gone: there is no second host
    // selector inside the entry.
    expect(screen.queryByTestId('terminal-entry-loading')).toBeNull();
  });

  it('renders the workspace regardless of the stored mode — the opener owns the choice', async () => {
    getMock.mockResolvedValue({ terminal: 'new-window' });

    renderWithChakra(<TerminalEntry />);

    // Even with `new-window` stored, a MOUNTED TerminalEntry is the in-window
    // workspace; the ONE opener is what keeps it from mounting at all.
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();
  });

  it('renders the workspace even when the hydration read fails (no gate to hold)', async () => {
    getMock.mockRejectedValue(new Error('no host'));

    renderWithChakra(<TerminalEntry />);

    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-entry-loading')).toBeNull();
  });

  // ── FS-1 (#2947 round 2): in-window close drains + tree-kills (R-5.2) ───────

  it('drains every live session through close_terminal_window when the in-window Terminal closes (FS-1, R-5.2)', async () => {
    renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();
    expect(drains()).toBe(false);

    // A REAL user close (chrome X / dock close) routes through the store.
    act(() => {
      closeWindow('terminal');
    });

    expect(invoke).toHaveBeenCalledWith('close_terminal_window', undefined);
  });

  it('does NOT double-drain when the store already flipped to new-window before the close (mode-change teardown owns it)', async () => {
    renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();

    // Settings → Apps mode change: the store moves synchronously, THEN the
    // window closes in the same tick — before React runs any cleanup.
    act(() => {
      void setAppPresentation('terminal', 'new-window');
      closeWindow('terminal');
    });

    // The handler re-reads the mode at close time and declines; the mode-change
    // teardown invokes close_terminal_window itself.
    expect(drains()).toBe(false);
  });

  it('unregisters on cleanup so a later close never drains a stale host (store callback, not a mount lifecycle)', async () => {
    const view = renderWithChakra(<TerminalEntry />);
    expect(await screen.findByTestId('mock-terminal-window')).toBeInTheDocument();

    view.unmount();

    act(() => {
      closeWindow('terminal');
    });

    expect(drains()).toBe(false);
  });
});
