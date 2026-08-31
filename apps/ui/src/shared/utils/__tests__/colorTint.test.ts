import { describe, it, expect } from 'vitest';
import { tint } from '../colorTint';

/**
 * #2770 round 5 — the shared color-mix tint helper.
 *
 * `var(--x)NN` alpha-append is INVALID CSS: var() substitution splices tokens
 * without re-lexing, so the appended digits remain a separate token and the
 * browser drops the whole declaration at computed-value time. `tint()` emits
 * `color-mix(in srgb, …)` which computes live from the var at paint time.
 */
describe('tint (shared/utils/colorTint)', () => {
  it('emits color-mix(in srgb, …) with the given percentage', () => {
    expect(tint('var(--accent-primary)', 22)).toBe(
      'color-mix(in srgb, var(--accent-primary) 22%, transparent)',
    );
  });

  it('round-trips the #2770 round-5 sweep mapping (hex byte → % alpha)', () => {
    // #16/#25: 15 → 8% | #4/#9–#11: 18 → 9% | #20/#23: 22 → 13%
    // #3/#5: 28 → 16% | 33 → 20% | 55 → 33% | 66 → 40% | 88 → 53% | 99 → 60%
    expect(tint('var(--accent-primary)', 8)).toBe('color-mix(in srgb, var(--accent-primary) 8%, transparent)');
    expect(tint('var(--border-color)', 9)).toBe('color-mix(in srgb, var(--border-color) 9%, transparent)');
    expect(tint('var(--accent-primary)', 13)).toBe('color-mix(in srgb, var(--accent-primary) 13%, transparent)');
    expect(tint('var(--accent-subagent)', 16)).toBe('color-mix(in srgb, var(--accent-subagent) 16%, transparent)');
    expect(tint('var(--border-color)', 20)).toBe('color-mix(in srgb, var(--border-color) 20%, transparent)');
    expect(tint('var(--accent-primary)', 33)).toBe('color-mix(in srgb, var(--accent-primary) 33%, transparent)');
    expect(tint('var(--accent-primary)', 40)).toBe('color-mix(in srgb, var(--accent-primary) 40%, transparent)');
    expect(tint('var(--accent-primary)', 53)).toBe('color-mix(in srgb, var(--accent-primary) 53%, transparent)');
    expect(tint('var(--body-bg)', 60)).toBe('color-mix(in srgb, var(--body-bg) 60%, transparent)');
  });

  it('accepts any color-ish first argument (var() reference or literal)', () => {
    expect(tint('red', 50)).toBe('color-mix(in srgb, red 50%, transparent)');
    expect(tint('rgba(168, 85, 186, 1)', 25)).toBe('color-mix(in srgb, rgba(168, 85, 186, 1) 25%, transparent)');
  });

  it('never emits the invalid var() alpha-append signature', () => {
    for (const [color, pct] of [
      ['var(--accent-primary)', 22],
      ['var(--status-error)', 15],
      ['var(--border-color)', 20],
    ] as const) {
      expect(tint(color, pct)).not.toMatch(/var\(--[a-z-]+\)[0-9a-fA-F]/);
    }
  });
});
