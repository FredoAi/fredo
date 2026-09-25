/**
 * Spec #2946 ST-3 — `describe.ts` unit pins (R-1.3).
 *
 * The ONE binding→display/accessible formatter must compose ST-1's canonical
 * helpers (never re-implement a key rule). These pins use explicit platforms so
 * they are deterministic regardless of the host OS.
 */

import { describe, it, expect } from 'vitest';

import { describeBinding, describeSequence } from '../describe';
import { parseSequence } from '../keys';

describe('describeSequence — serialized input', () => {
  it('describes a single modifier chord on win32', () => {
    expect(describeSequence('primary+space', 'win32')).toEqual({
      serialized: 'primary+space',
      display: 'Ctrl + Space',
      accessible: 'Control plus Space',
      stepCount: 1,
      valid: true,
    });
  });

  it('describes a multi-key sequence step-by-step', () => {
    expect(describeSequence('g g', 'win32')).toEqual({
      serialized: 'g g',
      display: 'G then G',
      accessible: 'G then G',
      stepCount: 2,
      valid: true,
    });
  });

  it('keeps @leader as a readable step', () => {
    const description = describeSequence('@leader g', 'win32');
    expect(description.serialized).toBe('@leader g');
    expect(description.display).toBe('Leader then G');
    expect(description.accessible).toBe('Leader then G');
    expect(description.stepCount).toBe(2);
  });

  it('spells named keys for assistive tech (the R-3.2 speech source)', () => {
    const description = describeSequence('ctrl+shift+f10', 'win32');
    expect(description.display).toBe('Ctrl + Shift + F10');
    expect(description.accessible).toBe('Control plus Shift plus F 10');
  });

  it('honours the platform override (darwin primary = Command)', () => {
    const description = describeSequence('primary+space', 'darwin');
    expect(description.display).toBe('Cmd + Space');
    expect(description.accessible).toBe('Command plus Space');
  });

  it('is total: an unrepresentable input yields the invalid sentinel', () => {
    expect(describeSequence('bogus+nope', 'win32')).toEqual({
      serialized: '',
      display: '',
      accessible: '',
      stepCount: 0,
      valid: false,
    });
    expect(describeSequence('', 'win32').valid).toBe(false);
  });
});

describe('describeSequence — parsed KeySequence input', () => {
  it('accepts a parsed sequence without re-parsing', () => {
    const parsed = parseSequence('primary+1');
    expect(describeSequence(parsed, 'win32')).toEqual({
      serialized: 'primary+1',
      display: 'Ctrl + 1',
      accessible: 'Control plus 1',
      stepCount: 1,
      valid: true,
    });
  });
});

describe('describeBinding', () => {
  it('re-derives the serialized form when the binding omits it', () => {
    const description = describeBinding({ sequence: parseSequence('@leader ?') }, 'win32');
    expect(description.serialized).toBe('@leader ?');
    expect(description.display).toBe('Leader then ?');
    expect(description.accessible).toBe('Leader then Question mark');
  });

  it('keeps the stored serialized form when the binding supplies it', () => {
    const description = describeBinding(
      { sequence: parseSequence('primary+space'), serialized: 'primary+space' },
      'win32',
    );
    expect(description.serialized).toBe('primary+space');
    expect(description.valid).toBe(true);
  });
});
