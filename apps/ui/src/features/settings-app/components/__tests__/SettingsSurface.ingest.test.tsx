/**
 * Spec #2992 ST-7 — the Ingest pane is reachable from the LIVE Settings shell as
 * a STATIC sidebar NavItem (not the feature `hasSettings` discovery), placed
 * after Telemetry, and renders the auto-start control.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

const registryState = vi.hoisted(() => ({ features: [] as Array<{ id: string; name: string }> }));

vi.mock('@/features/featureRegistry', () => ({
  getFeatures: () => registryState.features,
  dedupeByFeatureId: (features: Array<{ id: string }>) => features,
}));

vi.mock('@/features/theming', () => ({
  ThemingSettings: () => <div data-testid="theming-settings" />,
}));
vi.mock('@/features/setup', () => ({
  SetupWizard: () => <div data-testid="setup-wizard" />,
}));
vi.mock('@/features/home', () => ({
  TelemetrySettings: () => <div data-testid="telemetry-settings" />,
  DockPositionSettings: () => <div data-testid="dock-position-settings" />,
  BackgroundSettings: () => <div data-testid="background-settings" />,
}));
vi.mock('@/features/ingest/IngestAutostartSettings', () => ({
  IngestAutostartSettings: () => <div data-testid="ingest-autostart-settings" />,
}));
vi.mock('@/shared/components/companion/CompanionSettingsPanel', () => ({
  CompanionSettingsPanel: () => <div data-testid="companion-settings" />,
}));

import { SettingsSurface } from '../SettingsSurface';

afterEach(cleanup);

describe('#2992 ST-7 — Ingest static section wiring', () => {
  it('shows an Ingest nav item after Telemetry and opens the auto-start pane', async () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    const nav = screen.getByTestId('settings-nav-ingest');
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveTextContent('Ingest');

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
    expect(screen.getByText('Hotkeys')).toBeInTheDocument();

    fireEvent.click(nav);

    expect(await screen.findByTestId('ingest-autostart-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-settings')).toBeNull();
  });
});
