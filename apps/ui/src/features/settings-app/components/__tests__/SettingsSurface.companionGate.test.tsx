/**
 * #2868 ST-5 (G-123, R-4a / R-4b) — companion readiness gate through the NEW
 * Settings app shell.
 *
 * The shipped gate lives in the Companion section component, which the new
 * `SettingsSurface` composes UNCHANGED. This suite renders the REAL shell + the
 * REAL `CompanionSettingsPanel` (no section stub) and drives the section's
 * `useCompanionReadiness` hook directly so both edges of the continuous gate are
 * provable without a Tauri host:
 *
 *   - R-4a: WHILE the first readiness probe is in flight (`checking`) OR the
 *     companion is not ready → ONLY the setup wizard renders
 *     (`companion-setup-wizard` / `companion-step-*`); the normal controls
 *     (`companion-controls`) and the enable toggle are ABSENT.
 *   - R-4b: WHEN readiness reports `ready: true` → the normal controls render and
 *     no wizard remains.
 *
 * The shell nav/static chrome is asserted in every case so the gate is proven to
 * flow THROUGH the new container, not around it. The sibling section components
 * (theming/setup/home) are stubbed — they are owned by their own suites and are
 * irrelevant to this gate.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider } from '@/shared/contexts/CompanionContext';
import type { UseCompanionReadinessResult } from '@/shared/components/companion/useCompanionReadiness';
import type { CompanionReadiness } from '@/shared/components/companion/companionReadiness';

// ── Readiness hook stub — the ONE seam driving the gate (mutable per test). ──
// Mocking the resolved module id intercepts CompanionSettingsPanel's relative
// `./useCompanionReadiness` import as well as the alias path.
const readinessState = vi.hoisted(() => ({
  value: null as unknown as UseCompanionReadinessResult,
}));

vi.mock('@/shared/components/companion/useCompanionReadiness', () => ({
  useCompanionReadiness: () => readinessState.value,
  // The module's test seam is re-exported so any transitive consumer still
  // resolves; this suite drives the gate through `readinessState`.
  resetCompanionAutoLaunchGuard: () => {},
}));

// ── Sibling sections stubbed — not under test here ──
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

import { SettingsSurface } from '../SettingsSurface';

const noopAsync = async () => {};

const notReadyReadiness: CompanionReadiness = {
  ready: false,
  prerequisites: [
    { id: 'llamaServer', state: 'missing', detail: 'llama-server not found.', resolvedPath: null },
    { id: 'modelFiles', state: 'missing', detail: '0 of 3 model files present.', resolvedPath: null },
    { id: 'serverLaunch', state: 'missing', detail: 'Server not started.', resolvedPath: null },
  ],
};

const readyReadiness: CompanionReadiness = {
  ready: true,
  prerequisites: [
    { id: 'llamaServer', state: 'installed', detail: 'llama-server found.', resolvedPath: 'C:\\llama-server.exe' },
    { id: 'modelFiles', state: 'installed', detail: 'All required model files present.', resolvedPath: 'C:\\models' },
    { id: 'serverLaunch', state: 'installed', detail: 'Companion server healthy.', resolvedPath: null },
  ],
};

function hookValue(
  overrides: Partial<UseCompanionReadinessResult>,
): UseCompanionReadinessResult {
  return {
    readiness: null,
    checking: false,
    error: null,
    refresh: noopAsync,
    runAction: noopAsync,
    runningActionId: null,
    actionError: {},
    modelFiles: null,
    serverLaunch: null,
    ...overrides,
  };
}

function renderShell() {
  return renderWithChakra(
    <CompanionProvider>
      <SettingsSurface />
    </CompanionProvider>,
  );
}

/** The shell chrome proves the Companion section rendered inside the container. */
function expectShellChrome() {
  expect(screen.getByText('Settings')).toBeInTheDocument(); // sidebar heading
  expect(screen.getByText('Appearance')).toBeInTheDocument(); // static nav item
}

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  readinessState.value = hookValue({ checking: true, readiness: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('#2868 ST-5 — companion readiness gate through SettingsSurface (R-4a / R-4b)', () => {
  it('R-4a: while the first probe is in flight, renders ONLY the wizard (checking steps), never the controls', () => {
    readinessState.value = hookValue({ checking: true, readiness: null });

    renderShell();

    expectShellChrome();

    // Wizard only — the normal controls and the enable toggle are ABSENT.
    expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-controls')).toBeNull();
    expect(screen.queryByText('Show Fredo Companion')).toBeNull();

    // Every step is honestly in its checking state (no fabricated readiness).
    expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute('data-state', 'checking');
    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute('data-state', 'checking');
    expect(screen.getByTestId('companion-step-server-launch')).toHaveAttribute('data-state', 'checking');
  });

  it('R-4a: when the companion is not ready, renders ONLY the wizard, never the controls', () => {
    readinessState.value = hookValue({ checking: false, readiness: notReadyReadiness });

    renderShell();

    expectShellChrome();

    expect(screen.getByTestId('companion-setup-wizard')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-controls')).toBeNull();
    expect(screen.queryByText('Show Fredo Companion')).toBeNull();

    expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute('data-state', 'missing');
    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute('data-state', 'missing');
    expect(screen.getByTestId('companion-step-server-launch')).toHaveAttribute('data-state', 'missing');
    expect(screen.getByTestId('companion-setup-summary')).not.toHaveTextContent('complete');
  });

  it('R-4b: when the companion is ready, renders the normal controls and no wizard', () => {
    readinessState.value = hookValue({ checking: false, readiness: readyReadiness });

    renderShell();

    expectShellChrome();

    expect(screen.getByTestId('companion-controls')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-setup-wizard')).toBeNull();
    expect(screen.queryByTestId('companion-step-llama-server')).toBeNull();
    expect(screen.getByText('Show Fredo Companion')).toBeInTheDocument();
  });
});
