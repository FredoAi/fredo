import { describe, it, expect } from 'vitest';

import { parseSequence } from '../keys';
import { PLATFORM_RESERVED_COMBOS, reservedReason } from '../reserved';

const REQUIRED_COMBOS = [
  'primary+c',
  'primary+v',
  'primary+shift+v',
  'primary+x',
  'primary+a',
  'primary+z',
  'primary+y',
  'primary+w',
  'primary+n',
  'primary+r',
  'primary+shift+r',
  'primary+shift+i',
  'primary+shift+j',
  'primary+shift+c',
  'f5',
  'f11',
  'f12',
  'ctrl+alt+delete',
  'ctrl+shift+escape',
  'alt+f4',
  'alt+space',
];

const BINDABLE = [
  'ctrl+shift+f10',
  'primary+space',
  'primary+shift+p',
  'primary+shift+tab',
  'primary+tab',
  'primary+1',
  'primary+shift+alt+r',
  '?',
  'g',
  '@leader ?',
];

describe('PLATFORM_RESERVED_COMBOS', () => {
  it('contains every required combination with a non-empty reason', () => {
    for (const serialized of REQUIRED_COMBOS) {
      const combo = PLATFORM_RESERVED_COMBOS.find((entry) => entry.serialized === serialized);
      expect(combo, serialized).toBeDefined();
      expect(combo?.reason.length ?? 0, serialized).toBeGreaterThan(0);
    }
  });

  it('has no duplicate serialized combinations', () => {
    const seen = new Set<string>();
    for (const combo of PLATFORM_RESERVED_COMBOS) {
      expect(seen.has(combo.serialized), combo.serialized).toBe(false);
      seen.add(combo.serialized);
    }
  });
});

describe('reservedReason', () => {
  it('reports a human-readable reason for a reserved combination', () => {
    expect(reservedReason(parseSequence('primary+c'))).toContain('Copy');
    expect(reservedReason(parseSequence('f11'))).toContain('Fullscreen');
    expect(reservedReason(parseSequence('f12'))).toContain('DevTools');
    expect(reservedReason(parseSequence('alt+f4'))).toContain('Windows');
    expect(reservedReason(parseSequence('ctrl+alt+delete'))).toContain('Windows');
    expect(reservedReason(parseSequence('ctrl+shift+escape'))).toContain('Windows');
  });

  it('does NOT reserve the terminal exit chord ctrl+shift+f10', () => {
    expect(reservedReason(parseSequence('ctrl+shift+f10'))).toBeNull();
    expect(reservedReason(parseSequence('primary+shift+f10'), 'win32')).toBeNull();
  });

  it('does not reserve any shipped default binding', () => {
    for (const serialized of BINDABLE) {
      expect(reservedReason(parseSequence(serialized)), serialized).toBeNull();
    }
  });

  it('is TOTAL: empty and invalid sequences are never reserved', () => {
    expect(reservedReason([])).toBeNull();
    expect(reservedReason(parseSequence('bogus+nope'))).toBeNull();
  });

  it('folds explicit ctrl and primary on a ctrl-primary platform', () => {
    expect(reservedReason(parseSequence('primary+alt+delete'), 'win32')).toContain('Windows');
    expect(reservedReason(parseSequence('primary+v'))).toContain('Paste');
  });
});
