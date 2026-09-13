/**
 * #2868 ST-1 (G-138) — zero-section affordance for the Settings feature shell.
 *
 * AC-3 / R-3c: the "Features" grouping header must render ONLY when at least one
 * registered feature exposes a settings section (`hasSettings` + `renderSettings`).
 * The shipped app always has ≥1 discovered section live (G-138), so this
 * unreachable empty state is exercised here by stubbing the registry: no feature
 * exposes settings → the four static sections still render and NO "Features"
 * label appears.
 *
 * The section children are stubbed so the assertion targets the shell's grouping
 * logic (not section internals). This does NOT weaken any section contract —
 * those are owned by their own suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { LuActivity } from 'react-icons/lu';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

// ── Registry stub (vi.hoisted so the factory can read mutable per-test state) ──
const registryState = vi.hoisted(() => ({
  features: [] as Array<{ id: string; name: string; icon?: unknown; hasSettings?: boolean; renderSettings?: () => unknown }>,
}));

vi.mock('@/features/featureRegistry', () => ({
  getFeatures: () => registryState.features,
  dedupeByFeatureId: (features: Array<{ id: string }>) => {
    const seen = new Set<string>();
    const out: Array<{ id: string }> = [];
    for (const feature of features) {
      if (seen.has(feature.id)) continue;
      seen.add(feature.id);
      out.push(feature);
    }
    return out;
  },
}));

// ── Section stubs — the shell must compile the composition, not the sections ──
vi.mock('@/features/theming', () => ({
  ThemingSettings: () => <div data-testid="theming-settings" />,
}));
vi.mock('@/features/setup', () => ({
  SetupWizard: () => <div data-testid="setup-wizard" />,
}));
vi.mock('@/features/home', () => ({
  TelemetrySettings: () => <div data-testid="telemetry-settings" />,
  DockPositionSettings: () => <div data-testid="dock-position-settings" />,
}));
vi.mock('@/shared/components/companion/CompanionSettingsPanel', () => ({
  CompanionSettingsPanel: () => <div data-testid="companion-settings" />,
}));

import { SettingsSurface } from '../SettingsSurface';

afterEach(cleanup);

beforeEach(() => {
  registryState.features = [];
});

describe('#2868 ST-1 — SettingsSurface zero-section affordance (AC-3 / R-3c)', () => {
  it('renders the four static sections and NO "Features" grouping when no feature exposes settings', () => {
    registryState.features = [
      // showable feature WITHOUT settings — must never create a nav item.
      { id: 'mission-monitor', name: 'Mission Monitor' },
      // hasSettings but no renderSettings — must never create a nav item.
      { id: 'broken', name: 'Broken', hasSettings: true },
    ];

    renderWithChakra(<SettingsSurface />);

    // The grouping header is ABSENT (no empty "Features" group).
    expect(screen.queryByText('Features')).toBeNull();

    // The four static sections render regardless.
    expect(screen.getByText('Companion')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Fredo Setup')).toBeInTheDocument();
    expect(screen.getByText('Telemetry')).toBeInTheDocument();

    // Default section is Companion.
    expect(screen.getByTestId('companion-settings')).toBeInTheDocument();
  });

  it('renders the "Features" grouping + one nav item per settings-exposing feature (positive control)', () => {
    registryState.features = [
      {
        id: 'diagram',
        name: 'Infrastructure Diagram',
        icon: LuActivity,
        hasSettings: true,
        renderSettings: () => <div data-testid="diagram-settings" />,
      },
    ];

    renderWithChakra(<SettingsSurface />);

    expect(screen.getByText('Features')).toBeInTheDocument();
    const navItem = screen.getByText('Infrastructure Diagram');
    const navButton = navItem.closest('button');
    expect(navButton).not.toBeNull();

    fireEvent.click(navButton!);
    expect(screen.getByTestId('diagram-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-settings')).toBeNull();
  });
});
