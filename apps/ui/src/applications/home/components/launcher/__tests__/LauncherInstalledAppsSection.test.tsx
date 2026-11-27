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
  installedAppEntryAccessibleName,
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
    state: 'working',
    capabilities: { appId: 'dev.example.tools', declared: [], highRisk: [], consented: [] },
    mode: 'released',
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

  it('#3144 — drops a turned-off app, but keeps a FAILING app openable', () => {
    const disabled = entry({ id: 'off', displayName: 'Off App', state: 'disabled' });
    const failing = entry({ id: 'bad', displayName: 'Bad App', state: 'failing' });
    const working = entry({ id: 'ok', displayName: 'Ok App', state: 'working' });

    // The filter drops ONLY `disabled`.
    const filtered = filterInstalledApps([disabled, failing, working], '');
    expect(filtered.map((e) => e.id)).toEqual(['bad', 'ok']);

    // A boot where the ONLY app is turned off renders nothing at all.
    storeMock.entries = [disabled];
    renderWithChakra(<LauncherInstalledAppsSection query="" />);
    expect(screen.queryByTestId('launcher-installed-apps-section')).toBeNull();
  });

  // ── Spec #3241 — S4, the mode on the launcher entry (R-3.4) ───────────────

  it('marks a development entry on BOTH channels: the painted chip and the accessible name', () => {
    storeMock.entries = [
      entry({ id: 'dev', displayName: 'Example Tools', mode: 'development' }),
    ];
    renderWithChakra(<LauncherInstalledAppsSection query="" />);

    const button = screen.getByTestId('launcher-installed-app');
    expect(button).toHaveAttribute('data-app-mode', 'development');

    // The PAINTED channel — the shared badge renders the token for development.
    const chip = screen.getByTestId('launcher-installed-app-mode');
    expect(chip.textContent).toBe('Development');

    // The SPOKEN channel — the entry's `aria-label` MASKS the subtree, so without
    // the composition the painted word would never be announced.
    expect(button).toHaveAttribute('aria-label', 'Example Tools, development build');
    // And the composed name is what the role query resolves.
    expect(
      screen.getByRole('button', { name: 'Example Tools, development build' }),
    ).toBe(button);
  });

  it('leaves a RELEASED entry unmarked, with its accessible name BYTE-IDENTICAL', () => {
    storeMock.entries = [entry({ id: 'a', displayName: 'Alpha', mode: 'released' })];
    renderWithChakra(<LauncherInstalledAppsSection query="" />);

    // The surface exists and shows the entry — absence against an empty shelf
    // would be vacuous (G-469 / UI/UX D-9a).
    const button = screen.getByTestId('launcher-installed-app');
    expect(button).toHaveTextContent('Alpha');

    // No chip node and no token in the subtree's text.
    expect(screen.queryByTestId('launcher-installed-app-mode')).toBeNull();
    expect(button.textContent).not.toContain('Development');

    // The attribute is ALWAYS present, so a missing one can never be read as
    // `released`.
    expect(button).toHaveAttribute('data-app-mode', 'released');

    // Byte-identical accessible name: the shipped assertion still resolves, and
    // the name carries no qualifier.
    expect(button).toHaveAttribute('aria-label', 'Alpha');
    expect(screen.getByRole('button', { name: 'Alpha' })).toBe(button);
    expect(screen.queryByRole('button', { name: 'Alpha, development build' })).toBeNull();
  });

  it('installedAppEntryAccessibleName composes per mode — and the two forms differ', () => {
    // Development composes the qualifier (name first, qualifier second).
    expect(
      installedAppEntryAccessibleName(entry({ displayName: 'Example Tools', mode: 'development' })),
    ).toBe('Example Tools, development build');
    // Released is the BARE name, byte for byte.
    expect(installedAppEntryAccessibleName(entry({ displayName: 'Example Tools', mode: 'released' }))).toBe(
      'Example Tools',
    );

    // The case difference is DELIBERATE: painted `Development`, spoken
    // `development build` in lower case (an accessible name is a spoken sentence
    // where a mid-name capital can be spelled out). Do NOT "fix" it.
    const development = installedAppEntryAccessibleName(
      entry({ displayName: 'X', mode: 'development' }),
    );
    expect(development).toContain('development build');
    expect(development).not.toContain('Development build');
  });

  it('still marks a FAILING development build (broken and development are different facts)', () => {
    storeMock.entries = [
      entry({ id: 'bad', displayName: 'Bad App', state: 'failing', mode: 'development' }),
    ];
    renderWithChakra(<LauncherInstalledAppsSection query="" />);

    const button = screen.getByTestId('launcher-installed-app');
    expect(button).toHaveAttribute('data-app-mode', 'development');
    expect(screen.getByTestId('launcher-installed-app-mode')).toHaveTextContent('Development');
    expect(screen.getByRole('button', { name: 'Bad App, development build' })).toBe(button);
  });
});
