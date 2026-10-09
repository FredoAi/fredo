/**
 * Spec #3009 CU-1 (ST-1) — the `data-hotkey` grammar (plan API Contracts / UI/UX
 * QA rows). Pins the binding regex, the accept/reject set, and the derived
 * `steps` / `serialized` / `key` / `sequential` projection (G-187 units).
 */

import { describe, expect, it } from 'vitest';

import { DATA_HOTKEY_PATTERN, parseDataHotkey } from '../hotkeyGrammar';

describe('DATA_HOTKEY_PATTERN — the binding grammar', () => {
  it('is anchored and lowercase-only', () => {
    expect(DATA_HOTKEY_PATTERN.source).toBe('^[a-z0-9](?:\\+[a-z0-9])?$');
    expect(DATA_HOTKEY_PATTERN.test('a')).toBe(true);
    expect(DATA_HOTKEY_PATTERN.test('a+b')).toBe(true);
    expect(DATA_HOTKEY_PATTERN.test('A')).toBe(false);
    expect(DATA_HOTKEY_PATTERN.test('a+b+c')).toBe(false);
  });
});

describe('parseDataHotkey — accepted values', () => {
  it.each(['a', 'z', '0', '9', 'a+b', 'z+0', '1+2'])('parses %j', (raw) => {
    const grammar = parseDataHotkey(raw);
    expect(grammar).not.toBeNull();
    const steps = raw.split('+');
    expect(grammar?.steps).toEqual(steps);
    expect(grammar?.serialized).toBe(steps.join(' '));
    expect(grammar?.key).toBe(steps[0]);
    expect(grammar?.sequential).toBe(steps.length === 2);
  });

  it('freezes the parsed grammar (immutable shared contract)', () => {
    const grammar = parseDataHotkey('a+b');
    expect(Object.isFrozen(grammar)).toBe(true);
    expect(Object.isFrozen(grammar?.steps)).toBe(true);
  });
});

describe('parseDataHotkey — rejected values', () => {
  it.each([
    'A',
    'Z',
    '!',
    '',
    ' ',
    'a b',
    'ab',
    'a+',
    '+a',
    'a++b',
    'a+b+c',
    'a+B',
    'A+b',
    'ctrl+a',
    'a+b+c+d',
  ])('rejects %j', (raw) => {
    expect(parseDataHotkey(raw)).toBeNull();
  });

  it('rejects null (a missing attribute)', () => {
    expect(parseDataHotkey(null)).toBeNull();
  });
});
