import { describe, it, expect } from 'vitest';

import { ENGINE_OWNED_TRAVERSAL, MINIMAL_DEFAULT_BINDINGS, VIM_PRESET } from '../defaults';
import { isValidHotkeyActionId, tierForActionId } from '../types';

describe('MINIMAL_DEFAULT_BINDINGS', () => {
  it('preserves the shipped launcher toggle and required platform bindings', () => {
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.launcher.toggle']).toEqual(['primary+space']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.palette.openActions']).toEqual(['primary+shift+p']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.help.cheatsheet']).toEqual(['?']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.focus.nextWindow']).toEqual(['primary+tab']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.focus.prevWindow']).toEqual(['primary+shift+tab']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.terminal.exitPassthrough']).toEqual(['ctrl+shift+f10']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.macro.recordToggle']).toEqual(['primary+shift+alt+r']);
  });

  it('binds window.cycleNth to primary+1..primary+9', () => {
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.window.cycleNth']).toEqual([
      'primary+1',
      'primary+2',
      'primary+3',
      'primary+4',
      'primary+5',
      'primary+6',
      'primary+7',
      'primary+8',
      'primary+9',
    ]);
  });

  it('ships close/settings with no default sequence', () => {
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.window.close']).toBeUndefined();
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.settings.open']).toBeUndefined();
  });
});

describe('VIM_PRESET', () => {
  it('uses Space as the leader and h j k l for focus movement', () => {
    expect(VIM_PRESET.leader).toBe('space');
    expect(VIM_PRESET.bindings['fredo.focus.left']).toEqual(['h']);
    expect(VIM_PRESET.bindings['fredo.focus.down']).toEqual(['j']);
    expect(VIM_PRESET.bindings['fredo.focus.up']).toEqual(['k']);
    expect(VIM_PRESET.bindings['fredo.focus.right']).toEqual(['l']);
    expect(VIM_PRESET.bindings['fredo.help.cheatsheet']).toEqual(['@leader ?']);
  });
});

describe('ENGINE_OWNED_TRAVERSAL', () => {
  it('exposes native DOM-order labels', () => {
    expect(ENGINE_OWNED_TRAVERSAL).toEqual({ tab: 'Tab', shiftTab: 'Shift+Tab' });
  });
});

describe('hotkey action ids', () => {
  it('validates the declared pattern', () => {
    expect(isValidHotkeyActionId('fredo.launcher')).toBe(true);
    expect(isValidHotkeyActionId('missionmonitor.focus')).toBe(true);
    expect(isValidHotkeyActionId('MissionMonitor.focus')).toBe(false);
    expect(isValidHotkeyActionId('fredo')).toBe(false);
    expect(isValidHotkeyActionId('.focus')).toBe(false);
  });

  it('derives the tier from the namespace', () => {
    expect(tierForActionId('fredo.launcher')).toBe('fredo');
    expect(tierForActionId('missionmonitor.focus')).toBe('feature');
  });
});
