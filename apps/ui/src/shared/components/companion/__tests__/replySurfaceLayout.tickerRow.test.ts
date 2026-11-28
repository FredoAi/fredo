/**
 * Spec #3243 ST-8 — `replySurfaceLayout`'s ticker row geometry (G-253).
 *
 * The card's ceiling is DERIVED from its parts. The defect world this rejects is
 * the stale nominal: an assertion (or a component) written against `96` after a
 * ticker row exists is wrong by the row's whole height, and `96` is exactly what
 * the pre-ticker card was bounded at, so the stale number reads plausible.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPOSER_MAX_H,
  ORDER_TICKER_ROW_H,
  composerMaxHeight,
} from '../replySurfaceLayout';

describe('ORDER_TICKER_ROW_H — one named constant, one consumer', () => {
  it('is 24 px (the single-line row height)', () => {
    expect(ORDER_TICKER_ROW_H).toBe(24);
  });

  it('is NOT the composer ceiling — the two are distinct facts', () => {
    // A row that let these coincide would pass while the sum was wrong.
    expect(ORDER_TICKER_ROW_H).not.toBe(COMPOSER_MAX_H);
    expect(COMPOSER_MAX_H).toBe(96);
  });
});

describe('composerMaxHeight — derived, never a nominal sum', () => {
  it('is COMPOSER_MAX_H with no ticker', () => {
    expect(composerMaxHeight()).toBe(COMPOSER_MAX_H);
    expect(composerMaxHeight({})).toBe(COMPOSER_MAX_H);
    expect(composerMaxHeight({ withOrderTicker: false })).toBe(COMPOSER_MAX_H);
  });

  it('is COMPOSER_MAX_H + ORDER_TICKER_ROW_H with the ticker row', () => {
    expect(composerMaxHeight({ withOrderTicker: true })).toBe(COMPOSER_MAX_H + ORDER_TICKER_ROW_H);
    expect(composerMaxHeight({ withOrderTicker: true })).toBe(120);
  });

  it('the ticker case is strictly larger — a no-op sum would be the defect', () => {
    // The discriminating assertion: a `composerMaxHeight` that ignored its option
    // (returning COMPOSER_MAX_H in both cases) would satisfy the two rows above
    // separately but not this inequality.
    expect(composerMaxHeight({ withOrderTicker: true })).toBeGreaterThan(composerMaxHeight());
  });

  it('grows by EXACTLY the row height — not by a re-typed literal', () => {
    const delta = composerMaxHeight({ withOrderTicker: true }) - composerMaxHeight();
    expect(delta).toBe(ORDER_TICKER_ROW_H);
  });
});
