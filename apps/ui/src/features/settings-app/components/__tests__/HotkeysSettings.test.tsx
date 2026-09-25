/**
 * Spec #2946 ST-6 — Hotkeys settings surface DOM suite (R-2.1/R-2.2/R-2.4,
 * R-4.1/R-4.2/R-4.4/R-4.7/R-4.8, R-5.3 listing).
 *
 * The registry is driven through the mocked feature registry so the pane's
 * tier sections + zero-contribution rule are exercised without the app shell.
 * `listHotkeyActions()` reads the SAME registry the pane renders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { registerFredoAction, resetRegistryForTests } from '@/shared/hotkeys/registry';
import {
  getBinding,
  getKeymap,
  resetKeymapStoreForTests,
  setBinding,
  setMacros,
} from '@/shared/hotkeys/store';
import type { FeatureHotkeyAction } from '@/shared/hotkeys/types';

import { HotkeysSettings } from '../HotkeysSettings';

// ── Feature-registry stub (the pane + shared registry both read it) ──────────

const registryState = vi.hoisted(() => ({
  features: [] as Array<{
    id: string;
    name: string;
    icon?: unknown;
    hotkeys?: unknown[];
  }>,
}));

vi.mock('@/features/featureRegistry', () => ({
  getFeatures: () => registryState.features,
  dedupeByFeatureId: (features: Array<{ id: string }>) => features,
}));

function feat(
  id: string,
  name: string,
  hotkeys: FeatureHotkeyAction[] = [],
): (typeof registryState.features)[number] {
  return { id, name, hotkeys };
}

function fredo(actionId: string, title: string, defaultSequence: string | null): void {
  registerFredoAction({ actionId, title, defaultSequence, run: () => {} });
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  registryState.features = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderPane() {
  const utils = renderWithChakra(<HotkeysSettings />);
  await waitFor(() => expect(screen.queryByTestId('hotkeys-loading')).toBeNull());
  return utils;
}

function rowFor(actionId: string): HTMLElement {
  const row = screen
    .getAllByTestId('hotkeys-row')
    .find((candidate) => candidate.getAttribute('data-hotkey-action') === actionId);
  if (!row) throw new Error(`row not found: ${actionId}`);
  return row;
}

function rowOrder(): (string | null)[] {
  return screen.getAllByTestId('hotkeys-row').map((row) => row.getAttribute('data-hotkey-action'));
}

// ── Listing ───────────────────────────────────────────────────────────────────

describe('listing — both tiers + zero-contribution feature (R-2.1/R-2.2)', () => {
  it('groups Fredo first, then an auto-discovered feature, and adds no section for a feature with none', async () => {
    registryState.features = [
      feat('terminal', 'Terminal', [
        {
          actionId: 'terminal.newSession',
          title: 'New session',
          defaultSequence: 'primary+shift+t',
          run: () => {},
        },
      ]),
      feat('empty-feature', 'Empty Feature'),
    ];
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');

    await renderPane();

    // The Fredo section renders first; the zero-contribution feature adds none.
    expect(screen.getByText('Fredo (global)')).toBeInTheDocument();
    expect(
      screen.getAllByTestId('hotkeys-tier-section').map((s) => s.getAttribute('data-hotkey-section')),
    ).toEqual(['fredo', 'terminal']);
    // R-2.2: a zero-contribution feature contributes no rows and no section.
    expect(screen.queryByText('Empty Feature')).toBeNull();

    const rows = screen.getAllByTestId('hotkeys-row');
    expect(rows).toHaveLength(2);
    expect(rowFor('fredo.launcher.toggle')).toHaveAttribute('data-hotkey-tier', 'global');
    expect(rowFor('terminal.newSession')).toHaveAttribute('data-hotkey-tier', 'feature:terminal');
  });

  it('labels a cross-tier binding with a precedence badge (R-2.4)', async () => {
    registryState.features = [
      feat('terminal', 'Terminal', [
        {
          actionId: 'terminal.newSession',
          title: 'New session',
          defaultSequence: 'primary+space',
          run: () => {},
        },
      ]),
    ];
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');

    await renderPane();

    const fredoRow = rowFor('fredo.launcher.toggle');
    expect(within(fredoRow).getByTestId('hotkeys-precedence-badge')).toHaveTextContent(
      'Global fallback',
    );
    const featureRow = rowFor('terminal.newSession');
    expect(within(featureRow).getByTestId('hotkeys-precedence-badge')).toHaveTextContent(
      'Feature wins here',
    );
    // Both rows survive — a cross-tier overlap never removes a binding.
    expect(screen.getAllByTestId('hotkeys-row')).toHaveLength(2);
  });
});

// ── Search ────────────────────────────────────────────────────────────────────

describe('search — filter, never reorder (R-4.2)', () => {
  beforeEach(() => {
    registryState.features = [
      feat('terminal', 'Terminal', [
        {
          actionId: 'terminal.newSession',
          title: 'New session',
          defaultSequence: 'primary+shift+t',
          run: () => {},
        },
      ]),
    ];
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
  });

  it('filters on title, feature name, displayed key text, and stored token; case-insensitive', async () => {
    await renderPane();
    const input = screen.getByTestId('hotkeys-search-input');

    fireEvent.change(input, { target: { value: 'LAUNCHER' } });
    expect(rowOrder()).toEqual(['fredo.launcher.toggle']);

    fireEvent.change(input, { target: { value: 'Terminal' } });
    expect(rowOrder()).toEqual(['terminal.newSession']);

    fireEvent.change(input, { target: { value: 'primary+shift+t' } });
    expect(rowOrder()).toEqual(['terminal.newSession']);

    fireEvent.change(input, { target: { value: 'Ctrl + Space' } });
    expect(rowOrder()).toEqual(['fredo.launcher.toggle']);

    fireEvent.change(input, { target: { value: 'e' } });
    // both match — the shipped order (Fredo first) is preserved, never reordered
    expect(rowOrder()).toEqual(['fredo.launcher.toggle', 'terminal.newSession']);

    fireEvent.change(input, { target: { value: 'no-such-thing' } });
    expect(screen.getByTestId('hotkeys-list-empty')).toHaveTextContent('no-such-thing');
  });

  it('clears the query with the clear button', async () => {
    await renderPane();
    fireEvent.change(screen.getByTestId('hotkeys-search-input'), {
      target: { value: 'launcher' },
    });
    fireEvent.click(screen.getByTestId('hotkeys-search-clear'));
    expect(screen.getAllByTestId('hotkeys-row')).toHaveLength(2);
  });

  it('never loops while typing (stable state, no effect on derived length)', async () => {
    await renderPane();
    const input = screen.getByTestId('hotkeys-search-input');
    for (const value of ['l', 'la', 'lau', 'laun', 'launc', 'launch', 'launche', 'launcher', 'launcherx']) {
      fireEvent.change(input, { target: { value } });
    }
    expect(input).toHaveValue('launcherx');
    expect(screen.getByTestId('hotkeys-list-empty')).toBeInTheDocument();
  });
});

// ── Rebind capture ────────────────────────────────────────────────────────────

describe('rebind capture — keyboard-only (R-4.3 + R-5.3)', () => {
  it('rejects a reserved chord with the classifier reason and stays in capture', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await renderPane();

    const row = rowFor('fredo.launcher.toggle');
    fireEvent.click(within(row).getByTestId('hotkeys-rebind-button'));
    expect(within(row).getByTestId('hotkeys-capture-field')).toHaveAttribute(
      'data-capture',
      'active',
    );

    fireEvent.keyDown(document, { key: 'c', ctrlKey: true });

    expect(within(row).getByTestId('hotkeys-capture-error')).toHaveTextContent('Copy');
    // stays in capture so the user can retry
    expect(within(row).getByTestId('hotkeys-capture-field')).toBeInTheDocument();
    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
  });

  it('blocks a same-tier conflict through classifyBinding and applies nothing', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    fredo('fredo.help.cheatsheet', 'Cheat sheet', '?');
    await renderPane();

    const row = rowFor('fredo.launcher.toggle');
    fireEvent.click(within(row).getByTestId('hotkeys-rebind-button'));
    fireEvent.keyDown(document, { key: '?' });

    const dialog = await screen.findByTestId('hotkeys-conflict-dialog');
    expect(within(dialog).getByTestId('hotkeys-conflict-entry')).toHaveTextContent(
      'fredo.help.cheatsheet',
    );

    fireEvent.click(within(dialog).getByTestId('hotkeys-conflict-cancel'));
    expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull();
    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
  });

  it('applies a clean chord optimistically and persists it', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await renderPane();

    const row = rowFor('fredo.launcher.toggle');
    fireEvent.click(within(row).getByTestId('hotkeys-rebind-button'));
    fireEvent.keyDown(document, { key: 'F8', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+shift+f8']));
    expect(screen.getByTestId('hotkeys-save-status')).toHaveTextContent('Ctrl + Shift + F8');
    expect(JSON.parse(localStorage.getItem('fredo.hotkeys.keymap') ?? '{}')).toMatchObject({
      bindings: { 'fredo.launcher.toggle': ['primary+shift+f8'] },
    });
  });

  it('cancels capture on Escape without changing the binding', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await renderPane();

    const row = rowFor('fredo.launcher.toggle');
    fireEvent.click(within(row).getByTestId('hotkeys-rebind-button'));
    expect(within(row).getByTestId('hotkeys-capture-field')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
    expect(within(row).queryByTestId('hotkeys-capture-field')).toBeNull();
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

describe('reset one vs reset all (R-4.4)', () => {
  it('reset-one restores only that binding; reset-all restores all and keeps macros (unbinding triggers)', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    fredo('fredo.help.cheatsheet', 'Cheat sheet', '?');
    await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    await setBinding('fredo.help.cheatsheet', ['primary+shift+h']);
    await setMacros([
      {
        id: 'm1',
        name: 'Macro one',
        steps: ['fredo.launcher.toggle'],
        trigger: 'primary+alt+m',
        onStepError: 'abort',
      },
    ]);

    await renderPane();

    fireEvent.click(within(rowFor('fredo.launcher.toggle')).getByTestId('hotkeys-reset-button'));
    await waitFor(() => expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']));
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['primary+shift+h']);

    // Restore an override so reset-all has something to undo.
    await act(async () => {
      await setBinding('fredo.launcher.toggle', ['primary+shift+l']);
    });

    fireEvent.click(screen.getByTestId('hotkeys-reset-all-button'));
    expect(screen.getByTestId('hotkeys-reset-all-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('hotkeys-reset-all-confirm'));

    await waitFor(() => expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']));
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
    expect(getKeymap().macros).toHaveLength(1);
    expect(getKeymap().macros[0].trigger).toBeNull();
  });

  it('disables reset when a binding is already at its default, with an adjacent reason', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await renderPane();

    const row = rowFor('fredo.launcher.toggle');
    const reset = within(row).getByTestId('hotkeys-reset-button');
    expect(reset).toHaveAttribute('aria-disabled', 'true');
    expect(within(row).getByTestId('hotkeys-reset-reason')).toHaveTextContent('Already default');
  });
});

// ── Reserved list ─────────────────────────────────────────────────────────────

describe('reserved list — aria-disabled with adjacent reason (R-5.3)', () => {
  it('renders every reserved combo as disabled with its reason as text', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await renderPane();

    const list = screen.getByTestId('hotkeys-reserved-list');
    const rows = within(list).getAllByTestId('hotkeys-reserved-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveAttribute('aria-disabled', 'true');
    }
    expect(within(rows[0]).getByTestId('hotkeys-reserved-reason')).toHaveTextContent('Copy');
  });
});

// ── Vim preset ────────────────────────────────────────────────────────────────

describe('Vim preset — opt-in + collision surfacing (R-4.7/R-4.8)', () => {
  it('previews, enables, and restores the pre-preset bindings on disable', async () => {
    fredo('fredo.focus.left', 'Focus left', null);
    fredo('fredo.help.cheatsheet', 'Cheat sheet', '?');
    await setBinding('fredo.focus.left', ['x']);

    await renderPane();

    fireEvent.click(screen.getByTestId('hotkeys-vim-preset-toggle'));
    const preview = await screen.findByTestId('hotkeys-vim-preset-preview');
    expect(within(preview).getAllByTestId('hotkeys-vim-preset-change').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('hotkeys-vim-preset-confirm'));
    await waitFor(() => expect(getKeymap().vimPresetEnabled).toBe(true));
    expect(getKeymap().leader).toBe('space');
    expect(getBinding('fredo.focus.left')).toEqual(['h']);

    fireEvent.click(screen.getByTestId('hotkeys-vim-preset-toggle'));
    await screen.findByTestId('hotkeys-vim-preset-preview');
    fireEvent.click(screen.getByTestId('hotkeys-vim-preset-confirm'));
    await waitFor(() => expect(getKeymap().vimPresetEnabled).toBe(false));
    expect(getBinding('fredo.focus.left')).toEqual(['x']);
  });

  it('blocks enabling when a same-tier collision exists and surfaces it', async () => {
    fredo('fredo.focus.left', 'Focus left', null);
    // `fredo.window.close` is not touched by the preset, so its `h` survives.
    await setBinding('fredo.window.close', ['h']);

    await renderPane();
    fireEvent.click(screen.getByTestId('hotkeys-vim-preset-toggle'));
    await screen.findByTestId('hotkeys-vim-preset-preview');

    expect(screen.getByTestId('hotkeys-vim-preset-collision')).toHaveTextContent('same-tier');
    expect(screen.getByTestId('hotkeys-vim-preset-confirm')).toBeDisabled();
    expect(screen.getByTestId('hotkeys-vim-preset-blocked-reason')).toBeInTheDocument();
  });
});

// ── Loading / empty / macro mount ─────────────────────────────────────────────

describe('surface states', () => {
  it('renders the macros mount point for ST-8', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await renderPane();
    expect(screen.getByTestId('hotkeys-macros-section')).toBeInTheDocument();
  });

  it('opens the cheat sheet with its search + entries', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await renderPane();

    fireEvent.click(screen.getByTestId('hotkeys-cheatsheet-open'));
    const cheat = screen.getByTestId('hotkeys-cheatsheet-dialog');
    expect(within(cheat).getByTestId('hotkeys-cheatsheet-search')).toBeInTheDocument();
    expect(within(cheat).getAllByTestId('hotkeys-cheatsheet-entry').length).toBeGreaterThan(0);

    fireEvent.change(within(cheat).getByTestId('hotkeys-cheatsheet-search'), {
      target: { value: 'zzz' },
    });
    expect(within(cheat).getByTestId('hotkeys-cheatsheet-empty')).toBeInTheDocument();
  });
});
