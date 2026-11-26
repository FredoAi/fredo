/**
 * Spec #3147 ST-6 — the installed-apps shelf is a SIBLING of the grid, in the
 * launcher column, gated on the same `engaged` flag.
 *
 * The render site is one line in `LauncherShell`; this test drives the real
 * shell to prove (a) it is ABSENT at rest, (b) it appears when the launcher is
 * engaged AND there is at least one installed app, and (c) it renders AFTER the
 * app grid in document order — never inside it, never as a gridcell.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { InstalledAppEntry } from '@/shared/installed-apps/types';
import { LauncherShell } from '../LauncherShell';

vi.mock('@/shared/contexts/StreamContext', () => ({
  useConnectionStatus: () => ({ isConnected: true }),
  useStreamHealth: () => ({ health: 'healthy', isConnected: true }),
}));

const companionMock = vi.hoisted(() => ({
  state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
  voiceEnabled: true,
  replyInFlight: false,
  queuedSendCount: 0,
}));
vi.mock('@/shared/contexts/CompanionContext', () => ({ useCompanion: () => companionMock }));

vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: () => null,
  askActiveCompanion: vi.fn(() => ({ outcome: 'dispatched' as const })),
  askActiveCompanionWithAudio: vi.fn(() => ({ outcome: 'dispatched' as const })),
}));

vi.mock('@/shared/window-system/useWindows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/window-system/useWindows')>();
  return { ...actual, useWindows: () => [] };
});

const installedMock = vi.hoisted(() => ({ entries: [] as InstalledAppEntry[] }));
vi.mock('@/shared/installed-apps/useInstalledApps', () => ({
  useInstalledApps: () => installedMock.entries,
}));
vi.mock('@/shared/installed-apps/store', () => ({
  refreshInstalledApps: vi.fn(async () => {}),
}));
vi.mock('@/shared/installed-apps/client', () => ({
  openInstalledApp: vi.fn(async () => {}),
  installedAppErrorFrom: (rejection: unknown) => rejection,
}));

function entry(over: Partial<InstalledAppEntry> = {}): InstalledAppEntry {
  return {
    id: 'dev.example.tools',
    displayName: 'Example Tools',
    version: '1.2.0',
    enginesFredo: '^0.1.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: 'installed-dev.example.tools',
    state: 'working',
    capabilities: { appId: 'dev.example.tools', declared: [], highRisk: [], consented: [] },
    ...over,
  };
}

const renderShell = () =>
  renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);

const engage = () => {
  const input = screen.getByRole('searchbox');
  act(() => {
    input.focus();
    fireEvent.focus(input);
  });
};

beforeEach(() => {
  installedMock.entries = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('#3147 ST-6 — LauncherShell render site', () => {
  it('is ABSENT at rest (launcher not engaged)', () => {
    installedMock.entries = [entry()];
    renderShell();
    expect(screen.queryByTestId('launcher-installed-apps-section')).toBeNull();
  });

  it('appears when engaged with an installed app, after the grid in document order', () => {
    installedMock.entries = [entry()];
    const { container } = renderShell();
    engage();

    const section = screen.getByTestId('launcher-installed-apps-section');
    const grid = container.querySelector('#fredo-launcher-grid');
    expect(grid).not.toBeNull();
    // The shelf follows the grid — a sibling, never inside it.
    expect(
      grid!.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(grid!.contains(section)).toBe(false);
    expect(section.getAttribute('role')).not.toBe('gridcell');
  });

  it('stays ABSENT when engaged with nothing installed (the grid still renders)', () => {
    installedMock.entries = [];
    const { container } = renderShell();
    engage();
    expect(screen.queryByTestId('launcher-installed-apps-section')).toBeNull();
    expect(container.querySelector('#fredo-launcher-grid')).not.toBeNull();
  });
});
