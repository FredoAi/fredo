/**
 * Spec #3206 ST-3 — the Credits section is a STATIC section of the live Settings
 * shell, appended LAST in the static group (after `settings-nav-installed-apps`
 * and before the registry-driven `Applications` group header).
 *
 * QA row F-1a / U-9. The "last" assertion is the discriminating one: inserting
 * the item before `installed-apps` fails it, and the full ordered testid list is
 * printed in the failure message so two empty readings cannot pass (G-469).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LuFileText } from 'react-icons/lu';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

const registryState = vi.hoisted(() => ({
  features: [] as Array<{
    id: string;
    name: string;
    icon?: unknown;
    hasSettings: boolean;
    renderSettings: () => unknown;
  }>,
}));

vi.mock('@/applications/applicationRegistry', () => ({
  getApplications: () => registryState.features,
  dedupeByApplicationId: (features: Array<{ id: string }>) => features,
}));

vi.mock('@/applications/theming', () => ({ ThemingSettings: () => <div data-testid="theming-settings" /> }));
vi.mock('@/applications/setup', () => ({ SetupWizard: () => <div data-testid="setup-wizard" /> }));
vi.mock('@/applications/home', () => ({
  TelemetrySettings: () => <div data-testid="telemetry-settings" />,
  BackgroundSettings: () => <div data-testid="background-settings" />,
}));
vi.mock('@/applications/ingest/IngestAutostartSettings', () => ({
  IngestAutostartSettings: () => <div data-testid="ingest-autostart-settings" />,
}));
vi.mock('@/shared/components/companion/CompanionSettingsPanel', () => ({
  CompanionSettingsPanel: () => <div data-testid="companion-settings" />,
}));
vi.mock('@/shared/installed-apps/useInstalledApps', () => ({
  useInstalledAppsStatus: () => ({ entries: [], loading: false, settled: true, error: null }),
}));
vi.mock('@/shared/installed-apps/store', () => ({
  refreshInstalledApps: vi.fn(async () => {}),
  recordInstalledApp: vi.fn(),
}));
vi.mock('@/shared/utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: vi.fn(),
    listen: vi.fn().mockResolvedValue(() => {}),
  },
}));

import { SettingsSurface } from '../SettingsSurface';

afterEach(() => {
  cleanup();
  registryState.features = [];
});

function navTestIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="settings-nav-"]')).map(
    (node) => node.getAttribute('data-testid')!,
  );
}

describe('#3206 ST-3 — Credits is the last static Settings section', () => {
  it('is the LAST element matching [data-testid^="settings-nav-"]', () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    const ids = navTestIds();
    // Non-vacuity: the list itself is printed, so an empty/blocked read is visible.
    expect(ids.length, `ordered nav testids: ${ids.join(', ')}`).toBeGreaterThanOrEqual(5);
    expect(ids[ids.length - 1]).toBe('settings-nav-credits');
    expect(screen.getByTestId('settings-nav-credits')).toHaveTextContent('Credits');

    // ...and it follows the previously-last static item.
    const installed = screen.getByTestId('settings-nav-installed-apps');
    const credits = screen.getByTestId('settings-nav-credits');
    expect(
      installed.compareDocumentPosition(credits) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('still comes before the registry-driven `Applications` group header', () => {
    registryState.features = [
      {
        id: 'wireframe',
        name: 'Wireframe',
        icon: LuFileText,
        hasSettings: true,
        renderSettings: () => <div data-testid="wireframe-settings" />,
      },
    ];
    renderWithChakra(<SettingsSurface />);

    const credits = screen.getByTestId('settings-nav-credits');
    const applicationsHeader = screen.getByText('Applications');
    expect(
      credits.compareDocumentPosition(applicationsHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(navTestIds()[navTestIds().length - 1]).toBe('settings-nav-credits');
  });

  it('opens the pane synchronously on click and unmounts the previously active pane', () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    expect(screen.getByTestId('companion-settings')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('settings-nav-credits'));

    expect(screen.getByTestId('credits-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-settings')).toBeNull();
    // The section is NOT a registry tab and needs no async gate: the first
    // paint after the click already holds the whole document.
    expect(screen.getByRole('heading', { level: 2, name: 'Credits' })).toBeInTheDocument();
    expect(screen.getByTestId('credits-doom-trademark')).toBeInTheDocument();
  });

  it('keeps the heading structure intact inside the shell (h2 → h3 → h4, no skips)', () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);
    fireEvent.click(screen.getByTestId('settings-nav-credits'));

    const pane = screen.getByTestId('credits-settings');
    const levels = Array.from(pane.querySelectorAll('h2, h3, h4')).map((node) =>
      Number(node.tagName.slice(1)),
    );
    expect(levels.length).toBeGreaterThan(0);
    for (let index = 1; index < levels.length; index += 1) {
      // A step may go DOWN any amount (h4 → h3 back to the next group) but a
      // heading may never skip a level on the way in.
      expect(levels[index]! - levels[index - 1]!).toBeLessThanOrEqual(1);
    }
    expect(levels[0]).toBe(2);
  });

  it('re-entering the section always opens collapsed (state dies with the mount)', async () => {
    const user = userEvent.setup();
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    fireEvent.click(screen.getByTestId('settings-nav-credits'));
    const trigger = screen.getByTestId('credits-body-fredo-mit');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    // Leave and come back — the shell keys the section provider by section, so
    // the pane remounts and the accordion state is gone by construction.
    fireEvent.click(screen.getByTestId('settings-nav-installed-apps'));
    expect(screen.queryByTestId('credits-settings')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-nav-credits'));
    const reopened = within(screen.getByTestId('credits-settings')).getByTestId(
      'credits-body-fredo-mit',
    );
    expect(reopened.getAttribute('aria-expanded')).toBe('false');
  });
});
