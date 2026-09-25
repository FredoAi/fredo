/**
 * Spec #2946 ST-8 — MacroEditor DOM suite (EARS R-3.7, R-3.8, R-3.9; plan
 * UI/UX §2 Macros testids).
 *
 * Integration through the live editor: named-macro creation (searchable picker,
 * reorderable steps, save → list → run), the explicit record-start confirmation
 * and cancel gate, the persistent recording indicator + app-wide banner, the
 * explicit save of a recording, the replay confirmation, trigger assignment
 * through the SAME classifyBinding/conflict flow, and the token/no-telemetry
 * source audits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { getHotkeyAction, registerFredoAction, resetRegistryForTests } from '@/shared/hotkeys/registry';
import { readRecordingLatch } from '@/shared/hotkeys/persistence';
import {
  resetKeymapStoreForTests,
  getKeymap,
  setMacros,
  setRawMacros,
} from '@/shared/hotkeys/store';
import { resetHotkeyEngineForTests } from '@/shared/hotkeys/engine';
import {
  getMacroTrigger,
  isRecordingActive,
  macroActionId,
  resetMacrosForTests,
} from '@/shared/hotkeys/macros';
import type { PersistedMacro } from '@/shared/hotkeys/types';

import { MacroEditor } from '../MacroEditor';

// ── Feature-registry stub (the shared registry reads it) ─────────────────────

const registryState = vi.hoisted(() => ({
  features: [] as Array<{ id: string; name: string; icon?: unknown; hotkeys?: unknown[] }>,
}));

vi.mock('@/features/featureRegistry', () => ({
  getFeatures: () => registryState.features,
  dedupeByFeatureId: (features: Array<{ id: string }>) => features,
}));

function fredo(actionId: string, title: string, defaultSequence: string | null, run = vi.fn()): void {
  registerFredoAction({ actionId, title, defaultSequence, run });
}

function named(overrides: Partial<PersistedMacro> = {}): PersistedMacro {
  return {
    id: 'm1',
    name: 'Macro one',
    steps: [],
    trigger: null,
    onStepError: 'abort',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetMacrosForTests();
  resetHotkeyEngineForTests();
  registryState.features = [];
  document.body.innerHTML = '';
});

afterEach(() => {
  resetMacrosForTests();
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function renderEditor() {
  const utils = renderWithChakra(<MacroEditor />);
  await waitFor(() => expect(screen.getByTestId('hotkeys-macro-list')).toBeInTheDocument());
  return utils;
}

function optionFor(actionId: string): HTMLElement {
  const option = screen
    .getAllByTestId('hotkeys-macro-action-option')
    .find((candidate) => candidate.getAttribute('data-hotkey-action') === actionId);
  if (!option) throw new Error(`action option not found: ${actionId}`);
  return option;
}

// ── 1. Surface + empty state ─────────────────────────────────────────────────

describe('Macros subsection surface', () => {
  it('renders the privacy note, create/record actions, list and empty state', async () => {
    await renderEditor();
    expect(screen.getByTestId('hotkeys-macro-privacy-note')).toHaveTextContent('never captured');
    expect(screen.getByTestId('hotkeys-macro-create')).toBeInTheDocument();
    expect(screen.getByTestId('hotkeys-macro-record-start')).toBeInTheDocument();
    expect(screen.getByTestId('hotkeys-macros-empty')).toHaveTextContent('No macros yet.');
  });
});

// ── 2. Named macro builder (R-3.7) ───────────────────────────────────────────

describe('named macro builder', () => {
  it('creates a macro from the searchable picker, reorders steps, saves and runs it', async () => {
    const runA = vi.fn();
    const runB = vi.fn();
    fredo('fredo.demo.a', 'Alpha action', null, runA);
    fredo('fredo.demo.b', 'Beta action', null, runB);
    await renderEditor();

    fireEvent.click(screen.getByTestId('hotkeys-macro-create'));
    const builder = await screen.findByTestId('hotkeys-macro-builder');

    fireEvent.change(within(builder).getByTestId('hotkeys-macro-name'), {
      target: { value: 'Greeting' },
    });

    // Searchable picker filters, then a click adds a step.
    fireEvent.change(within(builder).getByTestId('hotkeys-macro-action-picker'), {
      target: { value: 'Alpha' },
    });
    expect(screen.getAllByTestId('hotkeys-macro-action-option')).toHaveLength(1);
    fireEvent.click(optionFor('fredo.demo.a'));

    fireEvent.change(within(builder).getByTestId('hotkeys-macro-action-picker'), {
      target: { value: '' },
    });
    fireEvent.click(optionFor('fredo.demo.b'));

    let steps = screen.getAllByTestId('hotkeys-macro-step');
    expect(steps.map((step) => step.getAttribute('data-hotkey-action'))).toEqual([
      'fredo.demo.a',
      'fredo.demo.b',
    ]);

    // Reorder: move step 1 down.
    fireEvent.click(within(steps[0]).getByTestId('hotkeys-macro-step-down'));
    steps = screen.getAllByTestId('hotkeys-macro-step');
    expect(steps.map((step) => step.getAttribute('data-hotkey-action'))).toEqual([
      'fredo.demo.b',
      'fredo.demo.a',
    ]);

    fireEvent.click(within(builder).getByTestId('hotkeys-macro-builder-save'));

    await waitFor(() => expect(getKeymap().macros).toHaveLength(1));
    expect(getKeymap().macros[0].name).toBe('Greeting');
    expect(getKeymap().macros[0].steps).toEqual(['fredo.demo.b', 'fredo.demo.a']);

    const item = await screen.findByTestId('hotkeys-macro-item');
    expect(within(item).getByText('Greeting')).toBeInTheDocument();

    fireEvent.click(within(item).getByTestId('hotkeys-macro-run'));
    await waitFor(() => expect(runB).toHaveBeenCalledTimes(1));
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB.mock.invocationCallOrder[0]).toBeLessThan(runA.mock.invocationCallOrder[0]);
  });

  it('edits and deletes a saved macro', async () => {
    await setMacros([named({ id: 'm1', name: 'Macro one' })]);
    await renderEditor();

    fireEvent.click(screen.getByTestId('hotkeys-macro-edit'));
    const builder = await screen.findByTestId('hotkeys-macro-builder');
    fireEvent.change(within(builder).getByTestId('hotkeys-macro-name'), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(within(builder).getByTestId('hotkeys-macro-builder-save'));
    await waitFor(() => expect(getKeymap().macros[0].name).toBe('Renamed'));

    fireEvent.click(screen.getByTestId('hotkeys-macro-delete'));
    await waitFor(() => expect(getKeymap().macros).toHaveLength(0));
  });
});

// ── 3. Explicit record-start confirmation (R-3.8) ────────────────────────────

describe('record start requires explicit confirmation (R-3.8)', () => {
  it('shows the confirm dialog and starts nothing until confirmed', async () => {
    await renderEditor();

    fireEvent.click(screen.getByTestId('hotkeys-macro-record-start'));
    const confirm = await screen.findByTestId('hotkeys-macro-record-confirm');
    expect(confirm).toHaveTextContent('will NOT be captured');
    expect(isRecordingActive()).toBe(false);
    expect(screen.queryByTestId('hotkeys-macro-recording-indicator')).toBeNull();
  });

  it('cancel performs no capture and starts no recording', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('hotkeys-macro-record-start'));
    await screen.findByTestId('hotkeys-macro-record-confirm');

    fireEvent.click(screen.getByTestId('hotkeys-macro-record-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('hotkeys-macro-record-confirm')).toBeNull());
    expect(isRecordingActive()).toBe(false);
    expect(await readRecordingLatch()).toBeNull();
  });
});

// ── 4. Recording indicator, save and latch (R-3.8/R-3.9) ─────────────────────

describe('recording indicator + explicit persistence', () => {
  it('shows the persistent indicator and app-wide banner, then saves the recording', async () => {
    await renderEditor();

    fireEvent.click(screen.getByTestId('hotkeys-macro-record-start'));
    await screen.findByTestId('hotkeys-macro-record-confirm');
    fireEvent.click(screen.getByTestId('hotkeys-macro-record-confirm-accept'));

    const indicator = await screen.findByTestId('hotkeys-macro-recording-indicator');
    expect(indicator).toHaveTextContent('Recording keystrokes');
    expect(screen.getByTestId('hotkeys-recording-banner')).toBeInTheDocument();
    expect(await readRecordingLatch()).not.toBeNull();

    fireEvent.keyDown(document.body, { key: 'g' });

    fireEvent.click(screen.getByTestId('hotkeys-macro-record-stop'));
    const result = await screen.findByTestId('hotkeys-macro-recording-result');
    expect(result).toHaveTextContent('1 keystroke');

    fireEvent.change(screen.getByTestId('hotkeys-macro-recording-name'), {
      target: { value: 'My recording' },
    });
    fireEvent.click(screen.getByTestId('hotkeys-macro-save'));

    await waitFor(() => expect(getKeymap().rawMacros).toHaveLength(1));
    expect(getKeymap().rawMacros[0].name).toBe('My recording');
    expect(getKeymap().rawMacros[0].strokes).toEqual(['g']);
    await waitFor(async () => expect(await readRecordingLatch()).toBeNull());
  });
});

// ── 5. Replay requires confirmation (R-3.8) ──────────────────────────────────

describe('replay requires confirmation (R-3.8)', () => {
  it('does not replay on cancel, and replays on confirm', async () => {
    await setRawMacros([{ id: 'r1', name: 'Rec', strokes: ['g'], trigger: null }]);
    await renderEditor();

    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push((event as KeyboardEvent).key);
    };
    document.addEventListener('keydown', listener);

    fireEvent.click(screen.getByTestId('hotkeys-macro-replay'));
    await screen.findByTestId('hotkeys-macro-replay-confirm');
    fireEvent.click(screen.getByTestId('hotkeys-macro-replay-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('hotkeys-macro-replay-confirm')).toBeNull());
    expect(seen).toEqual([]);

    fireEvent.click(screen.getByTestId('hotkeys-macro-replay'));
    await screen.findByTestId('hotkeys-macro-replay-confirm');
    fireEvent.click(screen.getByTestId('hotkeys-macro-replay-confirm-accept'));

    await waitFor(() => expect(seen).toEqual(['g']));
    document.removeEventListener('keydown', listener);
  });
});

// ── 6. Trigger assignment via the same rebind/conflict flow ──────────────────

describe('trigger assignment uses the standard classifier', () => {
  it('assigns a clean chord and cancels on Escape', async () => {
    await setMacros([named({ id: 'm1', name: 'Macro one' })]);
    await renderEditor();
    expect(getHotkeyAction(macroActionId('m1'))).not.toBeNull();

    fireEvent.click(screen.getByTestId('hotkeys-macro-trigger'));
    expect(screen.getByTestId('hotkeys-macro-trigger-field')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('hotkeys-macro-trigger-field')).toBeNull());
    expect(getMacroTrigger('m1')).toBeNull();

    fireEvent.click(screen.getByTestId('hotkeys-macro-trigger'));
    fireEvent.keyDown(document, { key: 'm', ctrlKey: true, altKey: true });
    await waitFor(() => expect(getMacroTrigger('m1')).toBe('primary+alt+m'));
    expect(screen.getByTestId('hotkeys-macro-trigger-clear')).toBeInTheDocument();
  });

  it('rejects a reserved chord with the classifier reason', async () => {
    await setMacros([named({ id: 'm1', name: 'Macro one' })]);
    await renderEditor();

    fireEvent.click(screen.getByTestId('hotkeys-macro-trigger'));
    fireEvent.keyDown(document, { key: 'c', ctrlKey: true });

    expect(screen.getByTestId('hotkeys-macro-trigger-error')).toHaveTextContent('Copy');
    expect(getMacroTrigger('m1')).toBeNull();
  });

  it('surfaces a same-tier collision through the ST-7 conflict dialog and blocks', async () => {
    fredo('fredo.launcher.toggle', 'Open launcher', 'primary+space');
    await setMacros([named({ id: 'm1', name: 'Macro one' })]);
    await renderEditor();

    fireEvent.click(screen.getByTestId('hotkeys-macro-trigger'));
    fireEvent.keyDown(document, { key: ' ', ctrlKey: true });

    const dialog = await screen.findByTestId('hotkeys-conflict-dialog');
    expect(dialog).toHaveTextContent('Key already in use');

    fireEvent.click(within(dialog).getByTestId('hotkeys-conflict-cancel'));
    await waitFor(() => expect(screen.queryByTestId('hotkeys-conflict-dialog')).toBeNull());
    expect(getMacroTrigger('m1')).toBeNull();
  });
});

// ── 7. Source audits (token hygiene + no telemetry) ──────────────────────────

describe('MacroEditor source audit', () => {
  const SOURCE = readFileSync(
    resolve(process.cwd(), 'src/features/settings-app/components/MacroEditor.tsx'),
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
