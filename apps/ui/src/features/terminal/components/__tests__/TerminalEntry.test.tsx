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
import { cleanup, screen } from '@testing-library/react';

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
import { settingsService } from '../../../settings';
import { TerminalEntry } from '../TerminalEntry';
import {
  DEFAULT_PRESENTATION,
  resetTerminalPresentationStoreForTests,
} from '../../presentation';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('TerminalEntry (Spec #2947 ST-3 — mode-aware frontend entry)', () => {
  beforeEach(() => {
    resetTerminalPresentationStoreForTests();
    getMock.mockReset();
    getMock.mockResolvedValue(DEFAULT_PRESENTATION);
  });

  afterEach(() => {
    cleanup();
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
});
