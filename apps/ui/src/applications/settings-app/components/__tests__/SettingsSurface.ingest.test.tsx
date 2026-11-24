/**
 * Spec #3193 ST-2 — the Background capture pane is reachable from the LIVE
 * Settings shell as a STATIC sidebar NavItem (not the feature `hasSettings`
 * discovery), placed after Telemetry, and renders the login-item control.
 *
 * The nav TESTID is deliberately unchanged (`settings-nav-ingest`) so no QA row
 * or other surface churns; only the visible LABEL moved from `Ingest` to
 * `Background capture`, because the entry now starts the resident application at
 * sign-in rather than the retired `fredo ingest` daemon.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

const registryState = vi.hoisted(() => ({ features: [] as Array<{ id: string; name: string }> }));

vi.mock('@/applications/applicationRegistry', () => ({
  getApplications: () => registryState.features,
  dedupeByApplicationId: (features: Array<{ id: string }>) => features,
}));

vi.mock('@/applications/theming', () => ({
  ThemingSettings: () => <div data-testid="theming-settings" />,
}));
vi.mock('@/applications/setup', () => ({
  SetupWizard: () => <div data-testid="setup-wizard" />,
}));
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

import { SettingsSurface } from '../SettingsSurface';

afterEach(cleanup);

describe('#3193 ST-2 — Background capture static section wiring', () => {
  it('shows a Background capture nav item after Telemetry and opens the pane', async () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    const nav = screen.getByTestId('settings-nav-ingest');
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveTextContent('Background capture');
    // The retired label must not survive anywhere in the nav.
    expect(nav).not.toHaveTextContent('Ingest');

    // Placed AFTER Telemetry (the data/telemetry cluster) — DOM order.
    const telemetry = screen.getByText('Telemetry').closest('button');
    expect(telemetry).not.toBeNull();
    expect(
      telemetry!.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Existing static sections are untouched.
    expect(screen.getByText('Companion')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Fredo Setup')).toBeInTheDocument();

    fireEvent.click(nav);

    expect(await screen.findByTestId('ingest-autostart-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-settings')).toBeNull();
  });
});
