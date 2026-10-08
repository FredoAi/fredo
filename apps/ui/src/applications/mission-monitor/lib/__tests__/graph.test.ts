/**
 * Tests for the surviving graph helpers.
 *
 * Spec #2788 P4.2/P5.1: the delivery-shaping helpers (isChatNodeDelivery,
 * deliverySessionId, deliveryCorrelationId, extractDeliveryPayload) were
 * deleted with the v1 pipeline. The token/cost guards remain in `../graph`
 * (the row derivation consumes them).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeTokenCount,
  normalizeCost,
} from '../graph';

// ── normalizeTokenCount (Spec #2717 R-3.3) ───────────────────────────────────

describe('normalizeTokenCount (#2717 R-3.3)', () => {
  it('passes non-negative numbers through unchanged', () => {
    expect(normalizeTokenCount(0)).toBe(0);
    expect(normalizeTokenCount(420)).toBe(420);
    expect(normalizeTokenCount(1_234)).toBe(1_234);
    expect(normalizeTokenCount(2_500_000)).toBe(2_500_000);
  });

  it('maps absent, non-number, negative, and NaN figures to 0', () => {
    expect(normalizeTokenCount(undefined)).toBe(0);
    expect(normalizeTokenCount(null)).toBe(0);
    expect(normalizeTokenCount('100')).toBe(0);
    expect(normalizeTokenCount(NaN)).toBe(0);
    expect(normalizeTokenCount(-1)).toBe(0);
    expect(normalizeTokenCount(-0)).toBe(0);
    expect(normalizeTokenCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ── normalizeCost (#2743 ST-1 / AC-12) ────────────────────────────────────────

describe('normalizeCost (#2743 ST-1 / AC-12)', () => {
  it('passes non-negative dollar figures through unchanged (including $0.00)', () => {
    expect(normalizeCost(0)).toBe(0);
    expect(normalizeCost(0.0234)).toBe(0.0234);
    expect(normalizeCost(1.25)).toBe(1.25);
  });

  it('maps absent, non-number, negative, and NaN figures to 0 — never NaN', () => {
    expect(normalizeCost(undefined)).toBe(0);
    expect(normalizeCost(null)).toBe(0);
    expect(normalizeCost('0.02')).toBe(0);
    expect(normalizeCost(NaN)).toBe(0);
    expect(normalizeCost(-0.5)).toBe(0);
    expect(normalizeCost(-0)).toBe(0);
    expect(normalizeCost(Number.POSITIVE_INFINITY)).toBe(0);
    expect(Number.isNaN(normalizeCost(Number.NaN))).toBe(false);
  });
});
