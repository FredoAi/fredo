/**
 * Spec #3193 ST-2 — the Background capture pane is reachable from the LIVE
 * Settings shell as a STATIC sidebar NavItem (not the feature `hasSettings`
 * discovery), placed after Telemetry, and renders the login-item control.
 *
 * The nav TESTID is deliberately unchanged (`settings-nav-ingest`) so no QA row
 * or other surface churns; only the visible LABEL moved from `Ingest` to
 * `Background capture`, because the entry now starts the resident application at
 * sign-in rather than the retired `fredo ingest` daemon.
 *
 * Spec #3195 ST-3 — the item's ICON is proven by IDENTITY (AC5, UI-UX U-12 /
 * A-3): the rendered glyph must EQUAL a separately rendered `<LuMonitorDot />`
 * and DIFFER from `<LuDatabase />`. An "an svg is present" assertion passes with
 * the pre-#3195 database cylinder and is therefore explicitly NOT AC5 evidence.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LuDatabase, LuMonitorDot } from 'react-icons/lu';
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

/**
 * The glyph's PATH DATA, rendered in isolation.
 *
 * `react-icons/lu` emits static path data per icon, so the `<path d>` set is the
 * icon's identity. Comparing path data (never element attributes or a bare
 * "an svg exists") is what makes this a discriminating AC5 assertion: the old
 * and new icons are both bare `<svg>` elements.
 */
function glyphPathsOf(node: ReactElement): string[] {
  const markup = renderToStaticMarkup(node);
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  return Array.from(doc.querySelectorAll('path')).map((path) => path.getAttribute('d') ?? '');
}

/** The glyph's path data from an already-rendered `<svg>`. */
function glyphPathsIn(svg: Element): string[] {
  return Array.from(svg.querySelectorAll('path')).map((path) => path.getAttribute('d') ?? '');
}

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

describe('#3195 ST-3 — Background capture nav icon identity (AC5)', () => {
  it('paints the LuMonitorDot glyph and not the retired LuDatabase glyph', () => {
    registryState.features = [];
    renderWithChakra(<SettingsSurface />);

    const nav = screen.getByTestId('settings-nav-ingest');
    // The label/testid contract is unchanged by the icon swap.
    expect(nav).toHaveTextContent('Background capture');

    const navIcon = nav.querySelector('svg');
    expect(navIcon).not.toBeNull();

    const navGlyph = glyphPathsIn(navIcon!);
    const monitorDotGlyph = glyphPathsOf(<LuMonitorDot />);
    const databaseGlyph = glyphPathsOf(<LuDatabase />);

    // Non-vacuity controls: both references carry real path data and the two
    // icons are NOT the same glyph — so the equality/inequality pair below can
    // actually discriminate, and is not a tautology.
    expect(navGlyph.length).toBeGreaterThan(0);
    expect(monitorDotGlyph.length).toBeGreaterThan(0);
    expect(databaseGlyph.length).toBeGreaterThan(0);
    expect(databaseGlyph).not.toEqual(monitorDotGlyph);

    // AC5 identity: the item paints the LuMonitorDot glyph…
    expect(navGlyph).toEqual(monitorDotGlyph);
    // …and NOT the retired database cylinder — this is the assertion that fails
    // on the pre-#3195 icon, which "an svg is present" could never catch.
    expect(navGlyph).not.toEqual(databaseGlyph);
  });

  it('keeps the retired database glyph out of the nav source (AC5 source pin)', () => {
    // vitest runs with cwd = apps/ui (the established convention for
    // source-level guards in this package — see SettingsSurface.theming.test).
    const source = readFileSync(
      resolve(process.cwd(), 'src/applications/settings-app/components/SettingsSurface.tsx'),
      'utf8',
    );
    // The retired icon must be gone from BOTH the import list and the nav item,
    // so the build's unused-import check cannot be the only guard.
    expect(source).not.toContain('LuDatabase');
    expect(source).toContain('LuMonitorDot');
  });
});
