import { describe, it, expect } from 'vitest';

import { classifyBinding } from '../conflicts';
import type { HotkeyActionId, HotkeyTier, PersistedKeymap, RegisteredHotkeyAction } from '../types';

function action(actionId: HotkeyActionId, tier: HotkeyTier): RegisteredHotkeyAction {
  return { actionId, tier, title: actionId, defaultSequence: null, run: () => {} };
}

function keymap(bindings: Record<HotkeyActionId, string[]>): PersistedKeymap {
  return {
    schemaVersion: 1,
    leader: 'space',
    vimPresetEnabled: false,
    sequenceTimeoutMs: 1000,
    bindings,
    macros: [],
    rawMacros: [],
  };
}

describe('classifyBinding', () => {
  it('returns none for an empty (unbound) candidate', () => {
    const report = classifyBinding({
      candidate: '',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({}),
      actions: [],
    });
    expect(report.kind).toBe('none');
    expect(report.colliding).toEqual([]);
  });

  it('returns invalid with a reason for an unrepresentable candidate', () => {
    const report = classifyBinding({
      candidate: 'bogus+nope',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({}),
      actions: [],
    });
    expect(report.kind).toBe('invalid');
    expect(report.reason).toBeDefined();
  });

  it('returns reserved with a reason and commits nothing', () => {
    const report = classifyBinding({
      candidate: 'primary+c',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({}),
      actions: [],
    });
    expect(report.kind).toBe('reserved');
    expect(report.reason).toContain('Copy');
    expect(report.colliding).toEqual([]);
  });

  it('returns none when the candidate is free', () => {
    const report = classifyBinding({
      candidate: 'primary+shift+9',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({ 'fredo.other': ['primary+k'] }),
      actions: [action('fredo.other', 'fredo')],
    });
    expect(report.kind).toBe('none');
  });

  it('blocks a same-tier collision and names every colliding action', () => {
    const report = classifyBinding({
      candidate: 'primary+k',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({ 'fredo.other': ['primary+k'], 'fredo.third': ['primary+k'] }),
      actions: [action('fredo.other', 'fredo'), action('fredo.third', 'fredo')],
    });
    expect(report.kind).toBe('same-tier');
    expect(report.colliding.map((entry) => entry.actionId).sort()).toEqual([
      'fredo.other',
      'fredo.third',
    ]);
    expect(report.colliding.every((entry) => entry.tier === 'fredo')).toBe(true);
  });

  it('labels a cross-tier collision without blocking', () => {
    const report = classifyBinding({
      candidate: 'primary+k',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({ 'missionmonitor.focus': ['primary+k'] }),
      actions: [action('missionmonitor.focus', 'feature')],
    });
    expect(report.kind).toBe('cross-tier');
    expect(report.colliding).toEqual([
      { actionId: 'missionmonitor.focus', tier: 'feature', sequence: 'primary+k' },
    ]);
  });

  it('never treats the target action own binding as a collision', () => {
    const report = classifyBinding({
      candidate: 'primary+k',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({ 'fredo.target': ['primary+k'] }),
      actions: [action('fredo.target', 'fredo')],
    });
    expect(report.kind).toBe('none');
  });

  it('folds explicit ctrl and primary when detecting a collision on win32', () => {
    const report = classifyBinding({
      candidate: 'primary+shift+f10',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({ 'fredo.other': ['ctrl+shift+f10'] }),
      actions: [action('fredo.other', 'fredo')],
      platform: 'win32',
    });
    expect(report.kind).toBe('same-tier');

    const darwinReport = classifyBinding({
      candidate: 'primary+shift+f10',
      targetActionId: 'fredo.target',
      targetTier: 'fredo',
      keymap: keymap({ 'fredo.other': ['ctrl+shift+f10'] }),
      actions: [action('fredo.other', 'fredo')],
      platform: 'darwin',
    });
    expect(darwinReport.kind).toBe('none');
  });
});
