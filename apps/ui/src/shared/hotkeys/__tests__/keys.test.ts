import { describe, it, expect } from 'vitest';

import {
  LEADER_TOKEN,
  accessibleSequence,
  detectPlatform,
  displaySequence,
  isModifierChord,
  keyStrokeEquals,
  normalizeKeyStroke,
  parseSequence,
  resolvePrimaryModifier,
  sequenceEquals,
  serializeSequence,
} from '../keys';
import type { KeyStroke } from '../types';

interface FakeKeyEvent {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  altGraph?: boolean;
}

function keyEvent(overrides: FakeKeyEvent): KeyboardEvent {
  const { key, altGraph = false, isComposing = false } = overrides;
  return {
    key,
    ctrlKey: overrides.ctrlKey ?? false,
    altKey: overrides.altKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    metaKey: overrides.metaKey ?? false,
    isComposing,
    getModifierState: (name: string) => (name === 'AltGraph' ? altGraph : false),
  } as unknown as KeyboardEvent;
}

function stroke(partial: Partial<KeyStroke> & { key: string }): KeyStroke {
  return { primary: false, ctrl: false, alt: false, shift: false, meta: false, ...partial };
}

describe('parseSequence / serializeSequence (typed-character model)', () => {
  it('round-trips every representative contract sequence', () => {
    const samples = ['primary+space', 'g g', '@leader g', 'ctrl+shift+f10', '?', 'primary+1', 'f5'];
    for (const sample of samples) {
      expect(serializeSequence(parseSequence(sample)), sample).toBe(sample);
    }
  });

  it('parses modifier tokens in any order and serializes them canonically', () => {
    expect(serializeSequence(parseSequence('alt+primary+g'))).toBe('primary+alt+g');
    expect(serializeSequence(parseSequence('shift+ctrl+f10'))).toBe('ctrl+shift+f10');
    expect(serializeSequence(parseSequence('meta+shift+alt+ctrl+primary+g'))).toBe(
      'primary+ctrl+alt+shift+meta+g',
    );
  });

  it('parses a single-character key verbatim and case-sensitively', () => {
    expect(parseSequence('g')).toEqual([stroke({ key: 'g' })]);
    expect(parseSequence('G')).toEqual([stroke({ key: 'G' })]);
    expect(parseSequence('g')).not.toEqual(parseSequence('G'));
    expect(parseSequence('~')).toEqual([stroke({ key: '~' })]);
    expect(parseSequence(',')).toEqual([stroke({ key: ',' })]);
  });

  it('parses named keys case-insensitively to a lowercase token', () => {
    expect(parseSequence('F10')).toEqual([stroke({ key: 'f10' })]);
    expect(parseSequence('ArrowUp')).toEqual([stroke({ key: 'arrowup' })]);
    expect(parseSequence('ESC')).toEqual([stroke({ key: 'escape' })]);
  });

  it('round-trips the "+" key itself (the ambiguous separator)', () => {
    expect(parseSequence('+')).toEqual([stroke({ key: '+' })]);
    expect(serializeSequence(parseSequence('+'))).toBe('+');
    expect(parseSequence('primary++')).toEqual([stroke({ key: '+', primary: true })]);
    expect(serializeSequence(parseSequence('primary++'))).toBe('primary++');
  });

  it('is TOTAL: unrepresentable input yields the [] invalid sentinel', () => {
    expect(parseSequence('bogus+nope')).toEqual([]);
    expect(parseSequence('primary')).toEqual([]);
    expect(parseSequence('ctrl+')).toEqual([]);
    expect(parseSequence('')).toEqual([]);
    expect(parseSequence('   ')).toEqual([]);
  });

  it('serializes an empty sequence to the empty string', () => {
    expect(serializeSequence([])).toBe('');
  });

  it('uses @leader for the leader stroke and keeps it in sequences', () => {
    expect(LEADER_TOKEN).toBe('@leader');
    expect(parseSequence('@leader ?')).toEqual([
      stroke({ key: '@leader' }),
      stroke({ key: '?' }),
    ]);
    expect(serializeSequence(parseSequence('@leader ?'))).toBe('@leader ?');
  });
});

describe('resolvePrimaryModifier / detectPlatform', () => {
  it('is ctrl on win32 and linux, meta on darwin', () => {
    expect(resolvePrimaryModifier('win32')).toBe('ctrl');
    expect(resolvePrimaryModifier('linux')).toBe('ctrl');
    expect(resolvePrimaryModifier('darwin')).toBe('meta');
  });

  it('detects a platform without throwing', () => {
    expect(['win32', 'linux', 'darwin']).toContain(detectPlatform());
  });
});

describe('normalizeKeyStroke', () => {
  it('folds Ctrl into primary on win32', () => {
    expect(normalizeKeyStroke(keyEvent({ key: ' ', ctrlKey: true }), 'win32')).toEqual(
      stroke({ key: 'space', primary: true }),
    );
  });

  it('stores a named key with all four modifier flags as pressed', () => {
    expect(normalizeKeyStroke(keyEvent({ key: 'F10', ctrlKey: true, shiftKey: true }), 'win32')).toEqual(
      stroke({ key: 'f10', primary: true, shift: true }),
    );
    expect(normalizeKeyStroke(keyEvent({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'win32')).toEqual(
      stroke({ key: 'tab', primary: true, shift: true }),
    );
  });

  it('stores a single character verbatim with shift folded in', () => {
    expect(normalizeKeyStroke(keyEvent({ key: '?', shiftKey: true }), 'win32')).toEqual(
      stroke({ key: '?' }),
    );
    expect(normalizeKeyStroke(keyEvent({ key: 'G', shiftKey: true }), 'win32')).toEqual(
      stroke({ key: 'G' }),
    );
    expect(normalizeKeyStroke(keyEvent({ key: 'g' }), 'win32')).toEqual(stroke({ key: 'g' }));
  });

  it('uses meta as the primary modifier on darwin and keeps ctrl explicit', () => {
    expect(normalizeKeyStroke(keyEvent({ key: 'g', metaKey: true }), 'darwin')).toEqual(
      stroke({ key: 'g', primary: true }),
    );
    expect(normalizeKeyStroke(keyEvent({ key: 'g', ctrlKey: true }), 'darwin')).toEqual(
      stroke({ key: 'g', ctrl: true }),
    );
    expect(normalizeKeyStroke(keyEvent({ key: 'g', ctrlKey: true }), 'win32')).toEqual(
      stroke({ key: 'g', primary: true }),
    );
  });

  it('returns null for an IME composition', () => {
    expect(normalizeKeyStroke(keyEvent({ key: 'a', isComposing: true }), 'win32')).toBeNull();
  });

  it('returns null for an AltGraph (AltGr) chord', () => {
    expect(normalizeKeyStroke(keyEvent({ key: 'a', altGraph: true }), 'win32')).toBeNull();
    expect(normalizeKeyStroke(keyEvent({ key: '~', altGraph: true }), 'win32')).toBeNull();
  });

  it('returns null for dead keys and pure modifiers', () => {
    expect(normalizeKeyStroke(keyEvent({ key: 'Dead' }), 'win32')).toBeNull();
    expect(normalizeKeyStroke(keyEvent({ key: 'Control' }), 'win32')).toBeNull();
    expect(normalizeKeyStroke(keyEvent({ key: 'Shift' }), 'win32')).toBeNull();
    expect(normalizeKeyStroke(keyEvent({ key: 'Unidentified' }), 'win32')).toBeNull();
  });
});

describe('keyStrokeEquals / sequenceEquals (platform-fold matching)', () => {
  it('treats explicit ctrl and primary as the same chord on a ctrl-primary platform', () => {
    const primary = stroke({ key: 'f10', shift: true, primary: true });
    const explicitCtrl = stroke({ key: 'f10', shift: true, ctrl: true });
    expect(keyStrokeEquals(primary, explicitCtrl, 'win32')).toBe(true);
    expect(keyStrokeEquals(primary, explicitCtrl, 'linux')).toBe(true);
    expect(keyStrokeEquals(primary, explicitCtrl, 'darwin')).toBe(false);
  });

  it('treats explicit meta and primary as the same chord on darwin', () => {
    const primary = stroke({ key: 'g', primary: true });
    const explicitMeta = stroke({ key: 'g', meta: true });
    expect(keyStrokeEquals(primary, explicitMeta, 'darwin')).toBe(true);
    expect(keyStrokeEquals(primary, explicitMeta, 'win32')).toBe(false);
  });

  it('requires the key token to match exactly (case-sensitive)', () => {
    expect(keyStrokeEquals(stroke({ key: 'g' }), stroke({ key: 'G' }), 'win32')).toBe(false);
  });

  it('compares sequences step-wise', () => {
    expect(sequenceEquals(parseSequence('g g'), parseSequence('g g'), 'win32')).toBe(true);
    expect(sequenceEquals(parseSequence('g g'), parseSequence('g G'), 'win32')).toBe(false);
    expect(
      sequenceEquals(parseSequence('primary+shift+f10'), parseSequence('ctrl+shift+f10'), 'win32'),
    ).toBe(true);
  });
});

describe('isModifierChord', () => {
  it('is true only when a modifier flag is set', () => {
    expect(isModifierChord(stroke({ key: 'g' }))).toBe(false);
    expect(isModifierChord(stroke({ key: 'g', shift: true }))).toBe(false);
    expect(isModifierChord(stroke({ key: 'g', primary: true }))).toBe(true);
    expect(isModifierChord(stroke({ key: 'g', alt: true }))).toBe(true);
    expect(isModifierChord(stroke({ key: 'g', meta: true }))).toBe(true);
  });
});

describe('displaySequence / accessibleSequence', () => {
  it('renders a layout-resolved label', () => {
    expect(displaySequence(parseSequence('primary+g'), 'win32')).toBe('Ctrl + G');
    expect(displaySequence(parseSequence('primary+space'), 'win32')).toBe('Ctrl + Space');
    expect(displaySequence(parseSequence('ctrl+shift+f10'), 'win32')).toBe('Ctrl + Shift + F10');
    expect(displaySequence(parseSequence('g g'), 'win32')).toBe('G then G');
    expect(displaySequence(parseSequence('@leader g'), 'win32')).toBe('Leader then G');
    expect(displaySequence(parseSequence('primary+g'), 'darwin')).toBe('Cmd + G');
  });

  it('renders a spoken form for assistive tech', () => {
    expect(accessibleSequence(parseSequence('primary+g'), 'win32')).toBe('Control plus G');
    expect(accessibleSequence(parseSequence('primary+space'), 'win32')).toBe('Control plus Space');
    expect(accessibleSequence(parseSequence('?'), 'win32')).toBe('Question mark');
    expect(accessibleSequence(parseSequence('@leader g'), 'win32')).toBe('Leader then G');
  });
});
