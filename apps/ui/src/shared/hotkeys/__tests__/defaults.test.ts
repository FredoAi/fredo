import { describe, it, expect } from 'vitest';

import { ENGINE_OWNED_TRAVERSAL, MINIMAL_DEFAULT_BINDINGS, VIM_PRESET } from '../defaults';
import { keyStrokeEquals, normalizeKeyStroke, parseSequence } from '../keys';
import { matchSequence } from '../sequence';
import {
  isValidHotkeyActionId,
  tierForActionId,
  type HotkeyActionId,
  type KeyStroke,
  type RegisteredHotkeyAction,
  type ResolvedBinding,
} from '../types';

interface FakeKeyEvent {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** The minimal keyboard event shape `normalizeKeyStroke` reads (win32-primary). */
function keyEvent(overrides: FakeKeyEvent): KeyboardEvent {
  return {
    key: overrides.key,
    ctrlKey: overrides.ctrlKey ?? false,
    altKey: overrides.altKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    metaKey: overrides.metaKey ?? false,
    isComposing: false,
    getModifierState: () => false,
  } as unknown as KeyboardEvent;
}

function stroke(partial: Partial<KeyStroke> & { key: string }): KeyStroke {
  return { primary: false, ctrl: false, alt: false, shift: false, meta: false, ...partial };
}

/** A `ResolvedBinding` for a serialized default — the matcher's input unit. */
function resolvedBinding(actionId: HotkeyActionId, serialized: string): ResolvedBinding {
  const action: RegisteredHotkeyAction = {
    actionId,
    tier: 'fredo',
    title: actionId,
    defaultSequence: serialized,
    run: () => {},
  };
  return { actionId, tier: 'fredo', sequence: parseSequence(serialized), serialized, action };
}

/** Every shipped single-stroke default paired with the real keydown it must match. */
const MATCHABLE_DEFAULTS: readonly {
  readonly actionId: HotkeyActionId;
  readonly serialized: string;
  readonly event: FakeKeyEvent;
}[] = [
  {
    actionId: 'fredo.launcher.toggle',
    serialized: 'primary+space',
    event: { key: ' ', ctrlKey: true },
  },
  {
    actionId: 'fredo.palette.openActions',
    serialized: 'primary+P',
    event: { key: 'P', ctrlKey: true, shiftKey: true },
  },
  { actionId: 'fredo.help.cheatsheet', serialized: '?', event: { key: '?' } },
  {
    actionId: 'fredo.focus.nextWindow',
    serialized: 'primary+tab',
    event: { key: 'Tab', ctrlKey: true },
  },
  {
    actionId: 'fredo.focus.prevWindow',
    serialized: 'primary+shift+tab',
    event: { key: 'Tab', ctrlKey: true, shiftKey: true },
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    actionId: 'fredo.window.cycleNth',
    serialized: `primary+${n}`,
    event: { key: String(n), ctrlKey: true },
  })),
  {
    actionId: 'fredo.terminal.exitPassthrough',
    serialized: 'ctrl+shift+f10',
    event: { key: 'F10', ctrlKey: true, shiftKey: true },
  },
  {
    actionId: 'fredo.macro.recordToggle',
    serialized: 'ctrl+shift+f9',
    event: { key: 'F9', ctrlKey: true, shiftKey: true },
  },
];

describe('MINIMAL_DEFAULT_BINDINGS', () => {
  it('preserves the shipped launcher toggle and required platform bindings', () => {
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.launcher.toggle']).toEqual(['primary+space']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.palette.openActions']).toEqual(['primary+P']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.help.cheatsheet']).toEqual(['?']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.focus.nextWindow']).toEqual(['primary+tab']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.focus.prevWindow']).toEqual(['primary+shift+tab']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.terminal.exitPassthrough']).toEqual(['ctrl+shift+f10']);
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.macro.recordToggle']).toEqual(['ctrl+shift+f9']);
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

  it('ships the non-leader g g sequence for fredo.window.first (ST-16)', () => {
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.window.first']).toEqual(['g g']);
    const parsed = parseSequence('g g');
    expect(parsed).toEqual([stroke({ key: 'g' }), stroke({ key: 'g' })]);

    // The two-step default matches two real 'g' keydowns: the first is a PREFIX
    // (arms the pending sequence), the second completes it EXACTLY once.
    const first = normalizeKeyStroke(keyEvent({ key: 'g' }), 'win32') as KeyStroke;
    const second = normalizeKeyStroke(keyEvent({ key: 'g' }), 'win32') as KeyStroke;
    const bindings = [resolvedBinding('fredo.window.first', 'g g')];

    const armed = matchSequence([first], bindings, 'win32');
    expect(armed.kind).toBe('prefix');
    if (armed.kind === 'prefix') {
      expect(armed.bindings.map((b) => b.actionId)).toContain('fredo.window.first');
    }

    const completed = matchSequence([first, second], bindings, 'win32');
    expect(completed.kind).toBe('exact');
    if (completed.kind === 'exact') {
      expect(completed.binding.actionId).toBe('fredo.window.first');
    }
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

describe('shipped defaults match a real keydown (typed-character model)', () => {
  it('every shipped default parses to a non-empty sequence', () => {
    for (const [actionId, sequences] of Object.entries(MINIMAL_DEFAULT_BINDINGS)) {
      expect(sequences.length, actionId).toBeGreaterThan(0);
      for (const serialized of sequences) {
        expect(parseSequence(serialized), `${actionId}: ${serialized}`).not.toEqual([]);
      }
    }
    // The opt-in Vim preset's leader chord parses as two steps, the first being
    // the synthetic leader token.
    const leaderSeq = parseSequence(VIM_PRESET.bindings['fredo.help.cheatsheet'][0]);
    expect(leaderSeq.map((s) => s.key)).toEqual(['@leader', '?']);
  });

  it('matches every shipped single-stroke default through parseSequence + normalizeKeyStroke', () => {
    for (const { actionId, serialized, event } of MATCHABLE_DEFAULTS) {
      const parsed = parseSequence(serialized);
      const normalized = normalizeKeyStroke(keyEvent(event), 'win32');
      expect(normalized, `${actionId}: keydown did not normalize`).not.toBeNull();
      expect(
        keyStrokeEquals(parsed[0], normalized as KeyStroke, 'win32'),
        `${actionId}: ${serialized} != normalized keydown`,
      ).toBe(true);

      const match = matchSequence(
        [normalized as KeyStroke],
        [resolvedBinding(actionId, serialized)],
        'win32',
      );
      expect(match.kind, `${actionId}: matcher did not reach an exact match`).toBe('exact');
    }
  });

  it('openActions default primary+P matches Ctrl+Shift+P end-to-end', () => {
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.palette.openActions']).toEqual(['primary+P']);
    const parsed = parseSequence('primary+P');
    expect(parsed).toEqual([stroke({ key: 'P', primary: true })]);

    const normalized = normalizeKeyStroke(
      keyEvent({ key: 'P', ctrlKey: true, shiftKey: true }),
      'win32',
    );
    // Shift is folded into the produced character, so `shift` is false.
    expect(normalized).toEqual(stroke({ key: 'P', primary: true }));
    expect(keyStrokeEquals(parsed[0], normalized as KeyStroke, 'win32')).toBe(true);

    const match = matchSequence(
      [normalized as KeyStroke],
      [resolvedBinding('fredo.palette.openActions', 'primary+P')],
      'win32',
    );
    expect(match.kind).toBe('exact');
    if (match.kind === 'exact') {
      expect(match.binding.actionId).toBe('fredo.palette.openActions');
    }
  });

  it('macro.recordToggle default ctrl+shift+f9 matches Ctrl+Shift+F9 end-to-end', () => {
    expect(MINIMAL_DEFAULT_BINDINGS['fredo.macro.recordToggle']).toEqual(['ctrl+shift+f9']);
    const parsed = parseSequence('ctrl+shift+f9');
    expect(parsed).toEqual([stroke({ key: 'f9', ctrl: true, shift: true })]);

    const normalized = normalizeKeyStroke(
      keyEvent({ key: 'F9', ctrlKey: true, shiftKey: true }),
      'win32',
    );
    expect(normalized).toEqual(stroke({ key: 'f9', primary: true, shift: true }));
    expect(keyStrokeEquals(parsed[0], normalized as KeyStroke, 'win32')).toBe(true);

    const match = matchSequence(
      [normalized as KeyStroke],
      [resolvedBinding('fredo.macro.recordToggle', 'ctrl+shift+f9')],
      'win32',
    );
    expect(match.kind).toBe('exact');
    if (match.kind === 'exact') {
      expect(match.binding.actionId).toBe('fredo.macro.recordToggle');
    }
  });

  it('the previously-shipped forms can never match (documented regression)', () => {
    // Ctrl+Shift+P folds Shift into the 'P' character → key 'P', shift false.
    const ctrlShiftP = normalizeKeyStroke(
      keyEvent({ key: 'P', ctrlKey: true, shiftKey: true }),
      'win32',
    );
    const brokenPalette = parseSequence('primary+shift+p');
    expect(brokenPalette).toEqual([stroke({ key: 'p', primary: true, shift: true })]);
    expect(brokenPalette[0].key).not.toBe((ctrlShiftP as KeyStroke).key);
    expect(keyStrokeEquals(brokenPalette[0], ctrlShiftP as KeyStroke, 'win32')).toBe(false);
    expect(
      matchSequence(
        [ctrlShiftP as KeyStroke],
        [resolvedBinding('fredo.palette.openActions', 'primary+shift+p')],
        'win32',
      ).kind,
    ).toBe('none');

    // Ctrl+Shift+Alt+R folds Shift into the 'R' character → key 'R', shift false.
    const ctrlShiftAltR = normalizeKeyStroke(
      keyEvent({ key: 'R', ctrlKey: true, shiftKey: true, altKey: true }),
      'win32',
    );
    const brokenMacro = parseSequence('primary+shift+alt+r');
    expect(brokenMacro).toEqual([stroke({ key: 'r', primary: true, alt: true, shift: true })]);
    expect(brokenMacro[0].key).not.toBe((ctrlShiftAltR as KeyStroke).key);
    expect(keyStrokeEquals(brokenMacro[0], ctrlShiftAltR as KeyStroke, 'win32')).toBe(false);
    expect(
      matchSequence(
        [ctrlShiftAltR as KeyStroke],
        [resolvedBinding('fredo.macro.recordToggle', 'primary+shift+alt+r')],
        'win32',
      ).kind,
    ).toBe('none');
  });
});
