/**
 * Spec #2946 ST-6 — Vim preset enable/disable + collision surfacing
 * (`vimPreset.ts`, R-4.7 / R-4.8).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { registerFredoAction, resetRegistryForTests } from '../registry';
import { getBinding, getKeymap, resetKeymapStoreForTests, setBinding } from '../store';
import { VIM_PRESET } from '../defaults';
import {
  applyVimPreset,
  buildVimPresetPreview,
  readVimPresetSnapshot,
  VIM_PRESET_ACTION_IDS,
  VIM_PRESET_SNAPSHOT_KEY,
} from '../vimPreset';
import type { FeatureHotkeyAction } from '../types';

function fredo(actionId: string, defaultSequence: string | null): void {
  registerFredoAction({ actionId, title: actionId, defaultSequence, run: () => {} });
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
});

describe('buildVimPresetPreview — enable (R-4.7/R-4.8)', () => {
  it('previews the leader + every preset binding and applies cleanly when free', async () => {
    fredo('fredo.focus.left', null);
    fredo('fredo.help.cheatsheet', '?');

    const preview = await buildVimPresetPreview(true);

    expect(preview.enable).toBe(true);
    expect(preview.blocking).toBe(false);
    expect(preview.keymap.vimPresetEnabled).toBe(true);
    expect(preview.keymap.leader).toBe(VIM_PRESET.leader);
    expect(preview.changes).toHaveLength(VIM_PRESET_ACTION_IDS.length);
    expect(preview.keymap.bindings['fredo.focus.left']).toEqual(['h']);
    expect(preview.keymap.bindings['fredo.help.cheatsheet']).toEqual(['@leader ?']);
  });

  it('captures the pre-preset snapshot before applying', async () => {
    fredo('fredo.focus.left', null);
    await setBinding('fredo.focus.left', ['x']);

    const preview = await buildVimPresetPreview(true);

    expect(preview.snapshot?.bindings['fredo.focus.left']).toEqual(['x']);
    expect(preview.snapshot?.leader).toBeNull();
  });

  it('surfaces a same-tier collision and marks the preview blocking', async () => {
    fredo('fredo.focus.left', null);
    // An untouched Fredo action holding `h` (the preset does not change it).
    await setBinding('fredo.window.close', ['h']);

    const preview = await buildVimPresetPreview(true);

    expect(preview.blocking).toBe(true);
    const collision = preview.collisions.find((entry) => entry.actionId === 'fredo.focus.left');
    expect(collision?.report.kind).toBe('same-tier');
    expect(collision?.report.colliding[0]?.actionId).toBe('fredo.window.close');
  });

  it('labels a cross-tier collision without blocking', async () => {
    fredo('fredo.focus.left', null);
    await setBinding('demo-widget.focus', ['h']); // feature-tier binding

    const preview = await buildVimPresetPreview(true);

    expect(preview.blocking).toBe(false);
    const collision = preview.collisions.find((entry) => entry.actionId === 'fredo.focus.left');
    expect(collision?.report.kind).toBe('cross-tier');
  });
});

describe('applyVimPreset — enable then disable restores the pre-preset state', () => {
  it('persists the preset and the snapshot, then restores on disable', async () => {
    fredo('fredo.focus.left', null);
    await setBinding('fredo.focus.left', ['x']);

    await applyVimPreset(await buildVimPresetPreview(true));

    expect(getKeymap().vimPresetEnabled).toBe(true);
    expect(getBinding('fredo.focus.left')).toEqual(['h']);
    expect(localStorage.getItem(VIM_PRESET_SNAPSHOT_KEY)).not.toBeNull();
    expect((await readVimPresetSnapshot())?.bindings['fredo.focus.left']).toEqual(['x']);

    await applyVimPreset(await buildVimPresetPreview(false));

    expect(getKeymap().vimPresetEnabled).toBe(false);
    expect(getBinding('fredo.focus.left')).toEqual(['x']);
    expect(localStorage.getItem(VIM_PRESET_SNAPSHOT_KEY)).toBeNull();
    expect(await readVimPresetSnapshot()).toBeNull();
  });

  it('falls back to shipped defaults when no snapshot exists', async () => {
    fredo('fredo.help.cheatsheet', '?');
    // Simulate a preset enabled by an older build: flag on, no snapshot.
    await applyVimPreset({
      ...(await buildVimPresetPreview(true)),
      snapshot: null,
    });
    localStorage.removeItem(VIM_PRESET_SNAPSHOT_KEY);

    await applyVimPreset(await buildVimPresetPreview(false));

    expect(getBinding('fredo.help.cheatsheet')).toEqual(['?']);
  });
});
