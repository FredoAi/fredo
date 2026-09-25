/**
 * Spec #2946 ST-7 — resolve-before-save conflict dialog (AC5 complex scenario;
 * EARS R-5.1, R-5.2, R-5.4).
 *
 * Two layers:
 *   A. isolated DOM contract of `HotkeyConflictDialog` (title/tier copy, focus
 *      contract, Escape=cancel, backdrop not dismissible, three resolutions);
 *   B. integration through the Hotkeys pane — a same-tier collision BLOCKS the
 *      save until an explicit resolution, cancel changes nothing, override keeps
 *      the displaced binding recorded + labels BOTH rows, rebind-other clears the
 *      colliding binding, and a cross-tier collision is labelled but never blocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { registerFredoAction, resetRegistryForTests } from '@/shared/hotkeys/registry';
import {
  getBinding,
  resetKeymapStoreForTests,
} from '@/shared/hotkeys/store';
import type {
  ConflictReport,
  FeatureHotkeyAction,
  RegisteredHotkeyAction,
} from '@/shared/hotkeys/types';

import {
  HotkeyConflictDialog,
  type HotkeyConflictResolution,
} from '../HotkeyConflictDialog';
import { HotkeysSettings, resetHotkeyConflictDialogForTests } from '../HotkeysSettings';

// ── Feature-registry stub (the pane reads it) ─────────────────────────────────

const registryState = vi.hoisted(() => ({
  features: [] as Array<{ id: string; name: string; icon?: unknown; hotkeys?: unknown[] }>,
}));

vi.mock('@/features/featureRegistry', () => ({
  getFeatures: () => registryState.features,
  dedupeByFeatureId: (features: Array<{ id: string }>) => features,
}));

function feat(id: string, name: string, hotkeys: FeatureHotkeyAction[] = []) {
  return { id, name, hotkeys };
}

function fredo(actionId: string, title: string, defaultSequence: string | null): void {
  registerFredoAction({ actionId, title, defaultSequence, run: () => {} });
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetHotkeyConflictDialogForTests();
  registryState.features = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── A. Isolated dialog contract ───────────────────────────────────────────────

const targetAction: RegisteredHotkeyAction = {
  actionId: 'fredo.launcher.toggle',
  tier: 'fredo',
  title: 'Open launcher',
  defaultSequence: 'primary+space',
  run: () => {},
};

const sameTierReport: ConflictReport = {
  kind: 'same-tier',
  colliding: [{ actionId: 'fredo.help.cheatsheet', tier: 'fredo', sequence: '?' }],
};

function renderDialog(onResolve: (resolution: HotkeyConflictResolution) => void = () => {}) {
  return renderWithChakra(
    <HotkeyConflictDialog
      candidate="?"
      targetAction={targetAction}
      report={sameTierReport}
      onResolve={onResolve}
    />,
  );
}

describe('isolated — ARIA, copy and tiers (R-5.1)', () => {
  it('renders a labelled modal dialog titled "Key already in use" with the chord and every collision', () => {
    renderDialog();
    const dialog = screen.getByTestId('hotkeys-conflict-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(
      screen.getByText('Key already in use').id,
    );

    expect(screen.getByText('Key already in use')).toBeInTheDocument();
    expect(screen.getByTestId('hotkeys-conflict-chord')).toHaveTextContent('Open launcher');

    const entry = screen.getByTestId('hotkeys-conflict-entry');
    expect(entry).toHaveAttribute('data-hotkey-action', 'fredo.help.cheatsheet');
    expect(entry).toHaveTextContent('fredo.help.cheatsheet');
    expect(within(entry).getByTestId('hotkeys-conflict-tier')).toHaveTextContent('Global');

    // Precedence is stated in words, never colour-only.
    expect(screen.getByTestId('hotkeys-conflict-precedence')).toHaveTextContent(
      'While a feature is focused, its binding wins',
    );
  });

  it('offers exactly the three explicit resolutions', () => {
    renderDialog();
    expect(screen.getByTestId('hotkeys-conflict-rebind-other')).toBeInTheDocument();
    expect(screen.getByTestId('hotkeys-conflict-override')).toBeInTheDocument();
    expect(screen.getByTestId('hotkeys-conflict-cancel')).toBeInTheDocument();
  });
});

describe('isolated — focus contract', () => {
  it('puts initial focus on the least-destructive action (cancel)', async () => {
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId('hotkeys-conflict-cancel')).toHaveFocus(),
    );
  });

  it('resolves Escape as cancel and never commits', () => {
    const onResolve = vi.fn();
    renderDialog(onResolve);
    fireEvent.keyDown(screen.getByTestId('hotkeys-conflict-dialog'), { key: 'Escape' });
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith('cancel');
    expect(onResolve).not.toHaveBeenCalledWith('override');
  });

  it('does NOT dismiss on backdrop interaction (explicit decision required)', () => {
    const onResolve = vi.fn();
    renderDialog(onResolve);
    fireEvent.mouseDown(screen.getByTestId('hotkeys-conflict-backdrop'));
    fireEvent.pointerDown(screen.getByTestId('hotkeys-conflict-backdrop'));
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByTestId('hotkeys-conflict-dialog')).toBeInTheDocument();
  });
});

describe('isolated — resolutions', () => {
  it.each([
    ['hotkeys-conflict-rebind-other', 'rebind-other'],
    ['hotkeys-conflict-override', 'override'],
    ['hotkeys-conflict-cancel', 'cancel'],
  ] as const)('clicking %s resolves as %s', (testid, resolution) => {
    const onResolve = vi.fn();
    renderDialog(onResolve);
    fireEvent.click(screen.getByTestId(testid));
    expect(onResolve).toHaveBeenCalledWith(resolution);
  });
});

// ── B. Integration through the Hotkeys pane ───────────────────────────────────

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

async function openSameTierConflict(): Promise<HTMLElement> {
  const row = rowFor('fredo.launcher.toggle');
  fireEvent.click(within(row).getByTestId('hotkeys-rebind-button'));
  fireEvent.keyDown(document, { key: '?' });
  return screen.findByTestId('hotkeys-conflict-dialog');
}

describe('same-tier collision blocks the save (R-5.1)', () => {
  beforeEach(() => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    fredo('fredo.help.cheatsheet', 'Cheat sheet', '?');
  });

  it('surfaces the dialog, names the colliding binding + tier, and commits nothing', async () => {
    await renderPane();
    const dialog = await openSameTierConflict();

    expect(within(dialog).getByTestId('hotkeys-conflict-chord')).toHaveTextContent('Open launcher');
    const entry = within(dialog).getByTestId('hotkeys-conflict-entry');
    expect(entry).toHaveTextContent('fredo.help.cheatsheet');
    expect(within(entry).getByTestId('hotkeys-conflict-tier')).toHaveTextContent('Global');

    // The save is blocked: neither binding moved.
    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
  });

  it('cancel discards the capture and leaves BOTH bindings unchanged', async () => {
    await renderPane();
    const dialog = await openSameTierConflict();
    fireEvent.click(within(dialog).getByTestId('hotkeys-conflict-cancel'));

    await waitFor(() => expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull());
    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
  });

  it('Escape cancels without committing', async () => {
    await renderPane();
    const dialog = await openSameTierConflict();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull());
    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
  });

  it('override applies the new binding, keeps the displaced binding recorded, and labels BOTH rows', async () => {
    await renderPane();
    const dialog = await openSameTierConflict();
    fireEvent.click(within(dialog).getByTestId('hotkeys-conflict-override'));

    await waitFor(() => expect(getBinding('fredo.launcher.toggle')).toEqual(['?']));
    // R-5.2 — never silently discarded: the displaced binding is still recorded.
    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
    expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull();

    // Both rows carry the precedence badge; the displaced row says so.
    const overriding = within(rowFor('fredo.launcher.toggle')).getByTestId(
      'hotkeys-precedence-badge',
    );
    expect(overriding).toHaveTextContent('Overrides');
    const displaced = within(rowFor('fredo.help.cheatsheet')).getByTestId(
      'hotkeys-precedence-badge',
    );
    expect(displaced).toHaveTextContent('Displaced');
  });

  it('rebind-other clears the colliding binding and then saves this one', async () => {
    await renderPane();
    const dialog = await openSameTierConflict();
    fireEvent.click(within(dialog).getByTestId('hotkeys-conflict-rebind-other'));

    await waitFor(() => expect(getBinding('fredo.launcher.toggle')).toEqual(['?']));
    expect(getBinding('fredo.help.cheatsheet')).toEqual([]);
    expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull();
  });
});

describe('cross-tier collision is labelled, never blocking (R-5.4)', () => {
  it('applies the captured chord and labels both rows with the precedence', async () => {
    registryState.features = [
      feat('terminal', 'Terminal', [
        {
          actionId: 'terminal.newSession',
          title: 'New session',
          // `F8` is a named key and is NOT a shipped Fredo default, so Ctrl+Shift+F8
          // collides only ACROSS tiers — the case that must never block.
          defaultSequence: 'primary+shift+f8',
          run: () => {},
        },
      ]),
    ];
    fredo('fredo.help.cheatsheet', 'Cheat sheet', '?');

    await renderPane();

    const row = rowFor('fredo.help.cheatsheet');
    fireEvent.click(within(row).getByTestId('hotkeys-rebind-button'));
    fireEvent.keyDown(document, { key: 'F8', ctrlKey: true, shiftKey: true });

    await waitFor(() =>
      expect(getBinding('fredo.help.cheatsheet')).toEqual(['primary+shift+f8']),
    );
    // No dialog: a cross-tier collision is not a blocking conflict.
    expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull();

    expect(
      within(rowFor('fredo.help.cheatsheet')).getByTestId('hotkeys-precedence-badge'),
    ).toHaveTextContent('Global fallback');
    expect(
      within(rowFor('terminal.newSession')).getByTestId('hotkeys-precedence-badge'),
    ).toHaveTextContent('Feature wins here');
  });
});

describe('focus returns to the invoking rebind button (H-15/H-26)', () => {
  it('restores focus after cancel', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    fredo('fredo.help.cheatsheet', 'Cheat sheet', '?');
    await renderPane();

    const dialog = await openSameTierConflict();
    fireEvent.click(within(dialog).getByTestId('hotkeys-conflict-cancel'));

    const invoker = document.getElementById('hotkeys-rebind-fredo.launcher.toggle');
    expect(invoker).not.toBeNull();
    await waitFor(() => expect(invoker).toHaveFocus());
  });
});

describe('no saving path bypasses classifyBinding', () => {
  beforeEach(() => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
  });

  it('only classifies-clean or cross-tier candidates reach the save path without a dialog', async () => {
    await renderPane();
    const row = rowFor('fredo.launcher.toggle');

    // A reserved chord is rejected by the classifier and never opens the dialog.
    fireEvent.click(within(row).getByTestId('hotkeys-rebind-button'));
    fireEvent.keyDown(document, { key: 'c', ctrlKey: true });
    expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull();
    expect(within(row).getByTestId('hotkeys-capture-error')).toHaveTextContent('Copy');
    expect(getBinding('fredo.launcher.toggle')).toEqual(['primary+space']);
  });

  it('re-classifies the live keymap inside the conflict resolver (source guard)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings-app/components/HotkeysSettings.tsx'),
      'utf8',
    );
    expect(source).toMatch(/const verdict = classifyBinding\(/);
    expect(source).toMatch(/verdict\.kind === 'reserved' \|\| verdict\.kind === 'invalid'/);
  });
});

// ── C. Token hygiene (source-level) ───────────────────────────────────────────

describe('ST-7 source audit — token hygiene', () => {
  const SOURCE = readFileSync(
    resolve(process.cwd(), 'src/features/settings-app/components/HotkeyConflictDialog.tsx'),
    'utf8',
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('contains no hex / rgb() / hsl() colour literal', () => {
    expect([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0])).toEqual([]);
  });

  it('contains no var(--x)NN alpha-append', () => {
    expect([...code.matchAll(/var\(--[a-z0-9-]+\)[0-9]/g)].map((m) => m[0])).toEqual([]);
  });
});
