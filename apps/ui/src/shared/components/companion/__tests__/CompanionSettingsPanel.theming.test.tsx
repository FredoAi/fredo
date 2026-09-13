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

  it('gives the Switch thumb ≥3:1 non-text contrast in BOTH states (R1 / REQ-5)', () => {
    // R1 FIX: the CHECKED thumb is the computed on-accent foreground (T5 —
    // white on classic purple, near-black on cyan/amber), not `--card-bg`
    // (card-bg on the accent track was ~1.9:1 light / ~2.5:1 dark — below AA).
    expect(panel).toMatch(
      /<Switch\.Thumb bg="var\(--card-bg\)" _checked=\{\{ bg: 'var\(--accent-contrast\)' \}\}/,
    );
    // The old checked thumb color must not return.
    expect(panel).not.toMatch(
      /<Switch\.Thumb[^\n]*_checked=\{\{ bg: 'var\(--card-bg\)' \}\}/,
    );
    // The unchecked thumb stays `--card-bg`, so the UNCHECKED track uses the
    // foreground token: card-bg vs `--border-color` is only ~1.3–1.7:1 (below
    // AA); card-bg vs `--text-primary` is ≥3:1 in every preset.
    expect(panel).toMatch(/<Switch\.Control\s+bg="var\(--text-primary\)"/);
    expect(panel).not.toMatch(/<Switch\.Control\s+bg="var\(--border-color\)"/);
    // The live-accent CHECKED track is unchanged.
    expect(panel).toMatch(/_checked=\{\{ bg: 'var\(--accent-primary\)' \}\}/);
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

  it('#2865 — removes the checking dim, honors reduced motion, and uses one radius vocabulary', () => {
    const cards: Array<[string, string]> = [
      ['SetupStepCard', setupCard],
      ['ModelFilesStepCard', modelCard],
      ['ServerLaunchStepCard', serverCard],
    ];
    for (const [name, source] of cards) {
      // The card-wide 0.6 checking dim was an AA failure (#2865 H2) — never return.
      expect(source, `${name}: checking must not be dimmed`).not.toMatch(
        /opacity=\{isChecking \? 0\.6/,
      );
      expect(source, `${name}: reduced motion must be honored`).toContain('_motionReduce');
      // Outer step cards adopt the sibling `lg` radius (#2865 H5).
      expect(source, `${name}: outer step card radius`).toContain('borderRadius="lg"');
    }
    // The recovery action is the accent-filled primary (#2865 H1), not outline-red.
    expect(setupCard).toMatch(
      /data-testid=\{`companion-step-\$\{step\.testId\}-retry`\}\s+bg="var\(--accent-primary\)"/,
    );
    expect(modelCard).toMatch(
      /data-testid=\{`companion-model-file-\$\{entry\.id\}-retry`\}\s+bg="var\(--accent-primary\)"/,
    );
    // The summary is a status banner tinted from the live status var — not the
    // off-brand `bg.subtle` box (#2865 V-B-01/H4).
    expect(wizard).not.toContain('bg="bg.subtle"');
    expect(wizard).toMatch(
      /data-testid="companion-setup-summary"[\s\S]{0,400}bg=\{tint\(summary\.statusVar, 10\)\}/,
    );
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
