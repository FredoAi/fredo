/**
 * Spec #2960 ST-1 — the PURE input-regime derivation (`inputRegime.ts`).
 *
 * Pins the frozen 5-valued → binary mapping (plan binding block):
 *   terminal            -> null
 *   textEntry === true  -> 'typing'     (top-level fields AND modal fields)
 *   otherwise           -> 'navigating'
 * plus the exact announcement copy.
 */

import { describe, expect, it } from 'vitest';

import {
  inputRegimeAnnouncement,
  regimeForFocusSnapshot,
  type InputRegime,
} from '../inputRegime';
import type { FocusContext } from '../types';

describe('regimeForFocusSnapshot', () => {
  it('returns null for the terminal context regardless of textEntry', () => {
    expect(regimeForFocusSnapshot({ context: 'terminal', textEntry: false })).toBeNull();
    expect(regimeForFocusSnapshot({ context: 'terminal', textEntry: true })).toBeNull();
  });

  it("returns 'typing' when textEntry is true (top-level and modal fields)", () => {
    expect(regimeForFocusSnapshot({ context: 'text-entry', textEntry: true })).toBe('typing');
    // A modal's TEXT field is honest typing (context alone would say 'modal').
    expect(regimeForFocusSnapshot({ context: 'modal', textEntry: true })).toBe('typing');
    // textEntry is the deciding input even on an otherwise-interactive element.
    expect(regimeForFocusSnapshot({ context: 'interactive', textEntry: true })).toBe('typing');
  });

  it("returns 'navigating' for every non-terminal, non-textEntry focus", () => {
    expect(regimeForFocusSnapshot({ context: 'default', textEntry: false })).toBe('navigating');
    expect(regimeForFocusSnapshot({ context: 'interactive', textEntry: false })).toBe('navigating');
    // A modal's NON-text focus is navigating.
    expect(regimeForFocusSnapshot({ context: 'modal', textEntry: false })).toBe('navigating');
  });

  it('is a total function over every FocusContext', () => {
    const contexts: readonly FocusContext[] = [
      'text-entry',
      'terminal',
      'modal',
      'interactive',
      'default',
    ];
    for (const context of contexts) {
      for (const textEntry of [false, true]) {
        const regime = regimeForFocusSnapshot({ context, textEntry });
        if (context === 'terminal') {
          expect(regime).toBeNull();
        } else {
          expect(regime).toBe(textEntry ? 'typing' : 'navigating');
        }
      }
    }
  });
});

describe('inputRegimeAnnouncement', () => {
  it('returns the exact frozen copy for each regime', () => {
    expect(inputRegimeAnnouncement('typing')).toBe(
      'Typing. Letters are text; navigation keys are inactive.',
    );
    expect(inputRegimeAnnouncement('navigating')).toBe('Navigating. Keyboard actions are active.');
  });

  it('covers the whole InputRegime domain', () => {
    const regimes: readonly InputRegime[] = ['typing', 'navigating'];
    const copy = regimes.map((regime) => inputRegimeAnnouncement(regime));
    expect(new Set(copy).size).toBe(2);
    for (const text of copy) expect(text.length).toBeGreaterThan(0);
  });
});
