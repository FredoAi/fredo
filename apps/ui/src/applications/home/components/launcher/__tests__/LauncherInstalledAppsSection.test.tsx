/**
 * Spec #3147 ST-6 — the launcher's installed-apps shelf (UI/UX §3.2).
 *
 * Pins: it renders nothing when empty; it carries the named region + the
 * decorative heading; entries are real buttons named by `displayName` with the
 * `own window` line; activation calls `openInstalledApp(id)`; a refused open
 * renders the launcher alert with `data-refusal-code` and clears on the next
 * attempt; and the query filters on `displayName` only.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { InstalledAppEntry } from '@/shared/installed-apps/types';

const storeMock = vi.hoisted(() => ({
  entries: [] as InstalledAppEntry[],
  refresh: vi.fn(),
}));
const clientMock = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@/shared/installed-apps/useInstalledApps', () => ({
  useInstalledApps: () => storeMock.entries,
}));
vi.mock('@/shared/installed-apps/store', () => ({
  refreshInstalledApps: () => storeMock.refresh(),
}));
vi.mock('@/shared/installed-apps/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/installed-apps/client')>();
  return { ...actual, openInstalledApp: (...args: unknown[]) => clientMock.open(...args) };
});

import {
  INSTALLED_APPS_HEADING,
  LauncherInstalledAppsSection,
  OWN_WINDOW_LABEL,
  filterInstalledApps,
} from '../LauncherInstalledAppsSection';
import { INSTALL_REFUSAL_COPY } from '@/shared/installed-apps/refusals';

function entry(over: Partial<InstalledAppEntry> = {}): InstalledAppEntry {
  return {
    id: 'dev.example.tools',
    displayName: 'Example Tools',
    version: '1.2.0',
    enginesFredo: '^0.1.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: 'installed-dev.example.tools',
    ...over,
  };
}

beforeEach(() => {
  storeMock.entries = [];
  storeMock.refresh = vi.fn(async () => {});
  clientMock.open = vi.fn(async () => {});
});

afterEach(cleanup);

describe('#3147 ST-6 — LauncherInstalledAppsSection', () => {
  it('renders NOTHING when there are no installed apps (no heading, no box)', () => {
    const { container } = renderWithChakra(<LauncherInstalledAppsSection query="" />);
    expect(screen.queryByTestId('launcher-installed-apps-section')).toBeNull();
    expect(container.textContent).not.toContain(INSTALLED_APPS_HEADING);
  });

  it('renders the named region and the decorative heading', () => {
    storeMock.entries = [entry()];
    renderWithChakra(<LauncherInstalledAppsSection query="" />);

    const section = screen.getByTestId('launcher-installed-apps-section');
    expect(section).toHaveAttribute('role', 'region');
    expect(section).toHaveAttribute('aria-label', 'Installed apps');
    expect(section).toHaveTextContent(INSTALLED_APPS_HEADING);
  });

  it('renders one button per entry, named by displayName, with the own-window line', () => {
    storeMock.entries = [entry({ id: 'a', displayName: 'Alpha' }), entry({ id: 'b', displayName: 'Beta' })];
    renderWithChakra(<LauncherInstalledAppsSection query="" />);

    const buttons = screen.getAllByTestId('launcher-installed-app');
    expect(buttons).toHaveLength(2);
    const alpha = screen.getByRole('button', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('data-app-id', 'a');
    expect(alpha).toHaveAttribute('type', 'button');
    expect(alpha.textContent).toContain(OWN_WINDOW_LABEL);
    expect(alpha.textContent).toContain('1.2.0');
  });

  it('activation calls openInstalledApp with the entry id', async () => {
    storeMock.entries = [entry({ id: 'dev.example.tools' })];
    renderWithChakra(<LauncherInstalledAppsSection query="" />);

    fireEvent.click(screen.getByTestId('launcher-installed-app'));
    await waitFor(() => expect(clientMock.open).toHaveBeenCalledWith('dev.example.tools'));
  });

  it('is disabled + aria-busy while the open is in flight, cleared when it settles', async () => {
    storeMock.entries = [entry()];
    let release: (() => void) | undefined;
    clientMock.open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    renderWithChakra(<LauncherInstalledAppsSection query="" />);
    const button = screen.getByTestId('launcher-installed-app');

    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute('aria-busy', 'true');
    // The label survives the busy state (no spinner replaces the name).
    expect(button).toHaveTextContent(entry().displayName);

    release?.();
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('a refused open renders launcher-installed-app-error with the code, and clears next attempt', async () => {
    storeMock.entries = [entry()];
    clientMock.open = vi
      .fn()
      .mockRejectedValueOnce({ code: 'integrity_mismatch', detail: 'main.js changed' })
      .mockResolvedValueOnce(undefined);

    renderWithChakra(<LauncherInstalledAppsSection query="" />);

    fireEvent.click(screen.getByTestId('launcher-installed-app'));

    const alert = await screen.findByTestId('launcher-installed-app-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveAttribute('data-refusal-code', 'integrity_mismatch');
    expect(alert).toHaveTextContent(INSTALL_REFUSAL_COPY.integrity_mismatch);

    // Not sticky: the next activation attempt clears it before its own call.
    fireEvent.click(screen.getByTestId('launcher-installed-app'));
    await waitFor(() =>
      expect(screen.queryByTestId('launcher-installed-app-error')).toBeNull(),
    );
  });

  it('filters on displayName only (case-insensitive substring); an empty result renders nothing', () => {
    const entries = [entry({ id: 'a', displayName: 'Alpha Tool' }), entry({ id: 'b', displayName: 'Beta' })];
    expect(filterInstalledApps(entries, 'alpha')).toHaveLength(1);
    expect(filterInstalledApps(entries, 'BETA')).toHaveLength(1);
    // Matching the ID does NOT match — displayName only. `zzz-id` appears in no
    // displayName, so the id is invisible to the filter.
    expect(filterInstalledApps([entry({ id: 'zzz-id', displayName: 'Readable Name' })], 'zzz-id')).toHaveLength(0);
    expect(filterInstalledApps(entries, '')).toHaveLength(2);

    storeMock.entries = entries;
    renderWithChakra(<LauncherInstalledAppsSection query="nothing-matches" />);
    expect(screen.queryByTestId('launcher-installed-apps-section')).toBeNull();
  });
});
