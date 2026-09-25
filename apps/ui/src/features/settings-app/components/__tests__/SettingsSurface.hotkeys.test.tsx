/**
 * Spec #2946 ST-6 — the Hotkeys pane is reachable from the LIVE Settings shell
 * as a STATIC sidebar NavItem (not the feature `hasSettings` discovery).
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
vi.mock('@/shared/components/companion/CompanionSettingsPanel', () => ({
  CompanionSettingsPanel: () => <div data-testid="companion-settings" />,
}));

import { SettingsSurface } from '../SettingsSurface';

afterEach(cleanup);

describe('#2946 ST-6 — Hotkeys static section wiring', () => {
  it('shows a Hotkeys nav item alongside the existing static sections and opens the pane', async () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    const nav = screen.getByText('Hotkeys').closest('button');
    expect(nav).not.toBeNull();
    // Existing static sections are untouched.
    expect(screen.getByText('Companion')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Fredo Setup')).toBeInTheDocument();
    expect(screen.getByText('Telemetry')).toBeInTheDocument();

    fireEvent.click(nav!);

    expect(await screen.findByTestId('hotkeys-search-input')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-settings')).toBeNull();
  });
});
