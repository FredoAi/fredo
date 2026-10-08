/**
 * LayoutSettings DOM suite (Spec #2980 ST-2; EARS R-1.1, R-1.2 UI, R-1.3 UI,
 * R-2.2 list, R-2.3 assign; plan UI/UX §1 LayoutSettings).
 *
 * Integration through the live section: the enable toggle, active-layout picker,
 * gap field and chord select write through to the ST-1 store; the active picker
 * is disabled while management is off or no layout exists; a zero-zone layout
 * cannot be assigned (R-2.4); the defined-layout list carries the zone/template
 * summary, an `aria-current` active row + text "Active" pill; delete goes through
 * an inline `role="alertdialog"`; and `ZoneLayoutEditor` opens in place from
 * New and Edit. The Settings surface wiring is pinned as a STATIC nav item. A
 * source audit pins the token-first chrome (no hex/rgba, no `var(--x)NN`).
 *
 * `settingsService` is mocked at the same seam as the ST-1/ST-3 suites so the
 * store stays host-agnostic; the store is reset between tests. The Ark `Switch`
 * `onCheckedChange` lands after the synchronous click, so the toggle test awaits
 * the store effect (the Hotkeys/Ingest precedent).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { buildTemplateZones, type ZoneLayout } from '@/shared/window-system/zoneLayout';
import {
  getZoneLayoutSnapshot,
  resetZoneLayoutStoreForTests,
  saveZoneLayout,
  setActiveZoneLayout,
  setZoneLayoutEnabled,
} from '@/shared/window-system/zoneLayoutStore';

const registryState = vi.hoisted(() => ({
  features: [] as Array<{ id: string; name: string }>,
}));

vi.mock('@/applications/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/applications/settings')>();
  return {
    ...actual,
    settingsService: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
});

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

import { LayoutSettings } from '../LayoutSettings';
import { SettingsSurface } from '../SettingsSurface';

beforeEach(() => {
  vi.clearAllMocks();
  resetZoneLayoutStoreForTests();
  registryState.features = [];
  localStorage.clear();
});

afterEach(() => {
  resetZoneLayoutStoreForTests();
  cleanup();
  localStorage.clear();
});

/** Seed a columns layout into the ST-1 store. */
function seedLayout(id: string, name: string, columns = 2): ZoneLayout {
  return saveZoneLayout({
    id,
    name,
    template: 'columns',
    zones: buildTemplateZones('columns', { columns }),
  });
}

function renderSection() {
  return renderWithChakra(<LayoutSettings />);
}

// ── 1. First-open surface ─────────────────────────────────────────────────────

describe('layout settings surface', () => {
  it('renders the pane, header and first-open empty state', () => {
    renderSection();

    expect(screen.getByTestId('layout-settings')).toBeInTheDocument();
    expect(
      screen.getByText('Arrange windows into zones by dragging them with an activation chord.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('layout-enabled-toggle')).toHaveAttribute(
      'aria-label',
      'Enable layout management',
    );
    expect(screen.getByTestId('layout-enabled-toggle')).not.toBeChecked();
    // Management off → the dependent controls are disabled and dimmed.
    expect(screen.getByTestId('layout-gap-input')).toBeDisabled();
    expect(screen.getByTestId('layout-chord-select')).toBeDisabled();
    expect(screen.getByTestId('layout-gap-input')).toHaveValue(8);
    expect(screen.getByTestId('layout-chord-select')).toHaveValue('alt');
    expect(screen.getByTestId('layout-list-empty')).toHaveTextContent(
      'No layouts yet — create one to get started.',
    );
    // Empty list → active picker disabled with the caption.
    expect(screen.getByTestId('layout-active-select')).toBeDisabled();
    expect(screen.getByText('Define a layout first')).toBeInTheDocument();
  });
});

// ── 2. Write-through controls ─────────────────────────────────────────────────

describe('immediate write-through (R-1.2)', () => {
  it('writes the enable toggle through and un-dims the dependent controls', async () => {
    renderSection();

    fireEvent.click(screen.getByTestId('layout-enabled-toggle'));

    await waitFor(() => expect(getZoneLayoutSnapshot().enabled).toBe(true));
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent(
      'Layout management enabled.',
    );
    await waitFor(() => expect(screen.getByTestId('layout-gap-input')).toBeEnabled());
    expect(screen.getByTestId('layout-chord-select')).toBeEnabled();
  });

  it('writes the gap through and clamps out-of-range input on blur', () => {
    setZoneLayoutEnabled(true);
    renderSection();

    const gap = screen.getByTestId('layout-gap-input');
    expect(gap).toBeEnabled();

    fireEvent.change(gap, { target: { value: '16' } });
    expect(getZoneLayoutSnapshot().gap).toBe(16);

    fireEvent.change(gap, { target: { value: '99' } });
    // The store clamps immediately to MAX_ZONE_GAP.
    expect(getZoneLayoutSnapshot().gap).toBe(32);

    fireEvent.blur(gap);
    // The out-of-range field reverts to the last committed (clamped) value.
    expect(gap).toHaveValue(32);
  });

  it('writes the activation chord through to the store', () => {
    setZoneLayoutEnabled(true);
    renderSection();

    fireEvent.change(screen.getByTestId('layout-chord-select'), {
      target: { value: 'primary+alt' },
    });

    expect(getZoneLayoutSnapshot().chord).toBe('primary+alt');
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent(
      'Activation chord: Ctrl+Alt.',
    );
  });

  it('spells each chord option and keeps the visible modifier label', () => {
    renderSection();
    const select = screen.getByTestId('layout-chord-select');

    const option = select.querySelector('option[value="primary+alt"]');
    expect(option).not.toBeNull();
    expect(option).toHaveTextContent('Ctrl+Alt');
    expect(option).toHaveAttribute('aria-label', 'Control plus Alt');
    expect(select.querySelector('option[value="alt+shift"]')).toHaveAttribute(
      'aria-label',
      'Alt plus Shift',
    );
    expect(select.querySelectorAll('option')).toHaveLength(5);
  });
});

// ── 3. Active-layout picker ───────────────────────────────────────────────────

describe('active-layout picker', () => {
  it('stays disabled while management is off even with layouts defined, then enables', async () => {
    seedLayout('l1', 'Work');
    renderSection();

    expect(screen.getByTestId('layout-active-select')).toBeDisabled();

    fireEvent.click(screen.getByTestId('layout-enabled-toggle'));
    await waitFor(() => expect(screen.getByTestId('layout-active-select')).toBeEnabled());
  });

  it('assigns the active layout from the picker (R-2.3)', () => {
    seedLayout('l1', 'Work');
    setZoneLayoutEnabled(true);
    renderSection();

    fireEvent.change(screen.getByTestId('layout-active-select'), {
      target: { value: 'l1' },
    });

    expect(getZoneLayoutSnapshot().activeLayoutId).toBe('l1');
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent('Active layout: Work.');
  });
});

// ── 4. Defined-layout list (R-2.2 / R-2.3 / R-2.4) ───────────────────────────

describe('defined-layout list', () => {
  it('lists a defined layout with its zone/template summary', () => {
    seedLayout('l1', 'Work', 3);
    renderSection();

    const row = screen.getByTestId('layout-list-item-l1');
    expect(row).toHaveTextContent('Work');
    expect(row).toHaveTextContent('3 zones · columns');
    expect(screen.queryByTestId('layout-list-empty')).toBeNull();
  });

  it('marks the active row with aria-current + a text "Active" pill', () => {
    seedLayout('l1', 'Work');
    setZoneLayoutEnabled(true);
    setActiveZoneLayout('l1');
    renderSection();

    const row = screen.getByTestId('layout-list-item-l1');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('layout-active-pill-l1')).toHaveTextContent('Active');
    expect(screen.getByTestId('layout-assign-l1')).toHaveAttribute('aria-disabled', 'true');
  });

  it('assigns a layout through the row "Use" button (R-2.3)', () => {
    seedLayout('l1', 'Work');
    setZoneLayoutEnabled(true);
    renderSection();

    fireEvent.click(screen.getByTestId('layout-assign-l1'));

    expect(getZoneLayoutSnapshot().activeLayoutId).toBe('l1');
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent('Active layout: Work.');
  });

  it('disables assign for a zero-zone layout and writes nothing (R-2.4)', () => {
    saveZoneLayout({ id: 'z1', name: 'Empty', template: 'custom', zones: [] });
    setZoneLayoutEnabled(true);
    renderSection();

    const assign = screen.getByTestId('layout-assign-z1');
    expect(assign).toBeDisabled();
    expect(assign).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(assign);
    expect(getZoneLayoutSnapshot().activeLayoutId).toBeNull();
  });

  it('confirms deletion through an inline alertdialog', () => {
    seedLayout('l1', 'Work');
    setZoneLayoutEnabled(true);
    setActiveZoneLayout('l1');
    renderSection();

    fireEvent.click(screen.getByTestId('layout-delete-l1'));
    const dialog = screen.getByTestId('layout-delete-dialog');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveTextContent(
      'Delete Work? Windows assigned to it return to free float.',
    );

    // Cancel mutates nothing.
    fireEvent.click(screen.getByTestId('layout-delete-cancel'));
    expect(screen.queryByTestId('layout-delete-dialog')).toBeNull();
    expect(getZoneLayoutSnapshot().layouts).toHaveLength(1);

    // Confirm removes the layout and clears the active pointer.
    fireEvent.click(screen.getByTestId('layout-delete-l1'));
    fireEvent.click(screen.getByTestId('layout-delete-confirm'));
    expect(getZoneLayoutSnapshot().layouts).toHaveLength(0);
    expect(getZoneLayoutSnapshot().activeLayoutId).toBeNull();
  });
});

// ── 5. Editor entry ───────────────────────────────────────────────────────────

describe('editor entry', () => {
  it('opens the editor for a new layout and saves it into the list', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('layout-new-button'));

    expect(screen.getByTestId('layout-editor')).toBeInTheDocument();
    expect(screen.getByTestId('layout-editor-name')).toHaveValue('Untitled 1');

    fireEvent.click(screen.getByTestId('layout-template-columns'));
    fireEvent.change(screen.getByTestId('layout-editor-name'), { target: { value: 'Work' } });
    fireEvent.click(screen.getByTestId('layout-editor-confirm'));

    expect(screen.queryByTestId('layout-editor')).toBeNull();
    expect(getZoneLayoutSnapshot().layouts).toHaveLength(1);
    expect(getZoneLayoutSnapshot().layouts[0].name).toBe('Work');
    expect(screen.getByTestId(/^layout-list-item-/)).toBeInTheDocument();
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent('Saved layout Work.');
  });

  it('opens the editor preloaded from an existing layout row', () => {
    seedLayout('l1', 'Work', 3);
    renderSection();

    fireEvent.click(screen.getByTestId('layout-edit-l1'));

    expect(screen.getByTestId('layout-editor-name')).toHaveValue('Work');
    expect(screen.queryAllByTestId(/^layout-editor-zone-/)).toHaveLength(3);

    fireEvent.click(screen.getByTestId('layout-editor-cancel'));
    expect(screen.queryByTestId('layout-editor')).toBeNull();
  });
});

// ── 6. Settings surface wiring (R-1.1) ────────────────────────────────────────

describe('Settings surface wiring', () => {
  it('is reachable as a static Layout nav item and opens the pane', () => {
    renderWithChakra(<SettingsSurface />);

    const nav = screen.getByTestId('settings-nav-layout');
    expect(nav).toHaveTextContent('Layout');
    // Existing static sections are untouched.
    expect(screen.getByText('Hotkeys')).toBeInTheDocument();
    expect(screen.getByText('Companion')).toBeInTheDocument();

    fireEvent.click(nav);

    expect(screen.getByTestId('layout-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-settings')).toBeNull();
  });
});

// ── 7. Source audit — token-first chrome ──────────────────────────────────────

describe('LayoutSettings source audit', () => {
  const SOURCE = readFileSync(
    resolve(process.cwd(), 'src/applications/settings-app/components/LayoutSettings.tsx'),
    'utf8',
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('contains no hex / rgb() / hsl() colour literal', () => {
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0])).toEqual([]);
  });

  it('contains no var(--x)NN alpha-append and uses the tint helper', () => {
    expect([...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0])).toEqual([]);
    expect(code).toContain("tint('var(--accent-primary)'");
  });
});
