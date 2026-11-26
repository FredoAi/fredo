/**
 * Spec #3147 ST-6 — the Installed applications pane is a STATIC section of the
 * live Settings shell, appended after `settings-nav-layout` and BEFORE the
 * registry-driven `Applications` group header.
 *
 * Static (not a `featureSettingsTab`) is the point: the feature-tab memo is
 * built from the built-in registry, and an installed app must never join it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

const registryState = vi.hoisted(() => ({
  features: [] as Array<{ id: string; name: string; hasSettings: boolean; renderSettings: () => unknown }>,
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
  replaceInstalledApp: vi.fn(),
  forgetInstalledApp: vi.fn(),
}));

import { SettingsSurface } from '../SettingsSurface';

afterEach(cleanup);

describe('#3147 ST-6 — Installed applications static section wiring', () => {
  it('appends settings-nav-installed-apps after settings-nav-layout and opens the pane', () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    const nav = screen.getByTestId('settings-nav-installed-apps');
    expect(nav).toHaveTextContent('Installed applications');

    // Placed AFTER Layout in DOM order.
    const layout = screen.getByTestId('settings-nav-layout');
    expect(layout.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(nav);
    expect(screen.getByTestId('installed-apps-pane')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-settings')).toBeNull();
  });

  it('is NOT a registry feature tab — it renders even with zero registered features', () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);
    // The `Applications` header only renders when a feature has settings; the
    // installed-apps nav item is present regardless.
    expect(screen.queryByText('Applications')).toBeNull();
    expect(screen.getByTestId('settings-nav-installed-apps')).toBeInTheDocument();
  });
});
