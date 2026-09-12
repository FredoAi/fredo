/**
 * #2864 ST-5 — Companion settings surface theming regression (REQ-4/5/6/7, ST-3/ST-4).
 *
 * Two layers of enforcement:
 *  1. SOURCE assertions — the ready controls, the setup wizard and every step
 *     card route accent / on-accent / hover / subtle-text through registered
 *     theme tokens (`var(--accent-contrast)`, `var(--hover-bg)`,
 *     `var(--text-subtle)`, the live `accent` colorPalette), and never through a
 *     literal or a `var(--x)NN` alpha-append. This pins the H6 fix (no opacity
 *     dimming of instructional text) and the H7 fix (`colorPalette="purple"` →
 *     live accent) so neither can silently regress.
 *  2. DOM regression — the ready panel renders the UNIFIED section header
 *     (`Heading as="h2"` + `aria-labelledby`) and the accessible switch, and no
 *     setup wizard (the ready/not-ready gate is unchanged).
 *
 * Assertions are ADDED only — no existing test is weakened, disabled or deleted.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { CompanionProvider } from '@/shared/contexts/CompanionContext';
import { CompanionSettingsPanel } from '@/shared/components/companion/CompanionSettingsPanel';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { CompanionReadiness } from '@/shared/components/companion/companionReadiness';

const PANEL_PATH = 'src/shared/components/companion/CompanionSettingsPanel.tsx';
const WIZARD_PATH = 'src/shared/components/companion/CompanionSetupWizard.tsx';
const SETUP_CARD_PATH = 'src/shared/components/companion/SetupStepCard.tsx';
const MODEL_CARD_PATH = 'src/shared/components/companion/ModelFilesStepCard.tsx';
const SERVER_CARD_PATH = 'src/shared/components/companion/ServerLaunchStepCard.tsx';

/** vitest runs with cwd = apps/ui (the package root). */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

const bothInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    { id: 'llamaServer', state: 'installed', detail: 'llama-server found.', resolvedPath: 'C:\\llama-server.exe' },
    { id: 'modelFiles', state: 'installed', detail: 'All required model files present.', resolvedPath: 'C:\\models' },
  ],
};

describe('#2864 ST-5 — Companion surface consumes registered tokens (ST-3/ST-4)', () => {
  const panel = readSource(PANEL_PATH);
  const wizard = readSource(WIZARD_PATH);
  const setupCard = readSource(SETUP_CARD_PATH);
  const modelCard = readSource(MODEL_CARD_PATH);
  const serverCard = readSource(SERVER_CARD_PATH);

  it('uses the live accent colorPalette (never the stock purple) and the unified h2 header', () => {
    expect(panel).toContain('colorPalette="accent"');
    expect(panel).not.toContain('colorPalette="purple"');
    expect(panel).toContain('as="h2"');
    expect(panel).toContain('aria-labelledby={COMPANION_SETTINGS_HEADING_ID}');
  });

  it('routes the ready view through accent / hover / subtle tokens', () => {
    expect(panel).toContain('var(--accent-primary)');
    expect(panel).toContain('var(--text-subtle)');
    expect(panel).toContain('var(--hover-bg)');
  });

  it('removes the Teleport-tip dimming entirely (H6 — never dim instructional text)', () => {
    expect(panel).not.toMatch(/opacity=\{isVisible/);
    expect(panel).not.toContain('pointerEvents');
  });

  it('routes the wizard + every step card through accent / on-accent / hover tokens', () => {
    expect(wizard).toContain('var(--accent-primary)');
    expect(wizard).toContain('var(--text-subtle)');

    const cards: Array<[string, string]> = [
      ['SetupStepCard', setupCard],
      ['ModelFilesStepCard', modelCard],
      ['ServerLaunchStepCard', serverCard],
    ];
    for (const [name, source] of cards) {
      expect(source, `${name} must use the on-accent foreground`).toContain('var(--accent-contrast)');
      expect(source, `${name} must use the derived hover token`).toContain('var(--hover-bg)');
    }
  });

  it('never alpha-appends onto a var() — only the shared tint() helper (or a flat token)', () => {
    for (const source of [panel, wizard, setupCard, modelCard, serverCard]) {
      expect(source).not.toMatch(/var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/);
    }
  });
});

describe('#2864 ST-5 — Companion ready view DOM regression', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    adapterBridge.setInvoke(undefined as never);
  });

  it('renders the unified section header (h2 + accessible name) and the named switch, with no wizard', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      return undefined;
    });

    const { container } = renderWithChakra(
      <CompanionProvider>
        <CompanionSettingsPanel />
      </CompanionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('companion-controls')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('companion-setup-wizard')).toBeNull();

    // The section is labelled by the h2 (REQ-7: one header, semantically bound).
    const section = screen.getByTestId('companion-controls');
    expect(section.tagName).toBe('SECTION');
    expect(section).toHaveAttribute('aria-labelledby', 'companion-settings-heading');

    const heading = screen.getByRole('heading', { level: 2, name: 'Companion' });
    expect(heading).toHaveAttribute('id', 'companion-settings-heading');

    // The toggle still carries an accessible name (not color/position alone).
    expect(container.querySelector('[aria-label="Show Fredo Companion"]')).not.toBeNull();
  });
});
