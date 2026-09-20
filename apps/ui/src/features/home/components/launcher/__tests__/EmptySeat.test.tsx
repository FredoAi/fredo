import { describe, expect, it } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import { EmptySeat } from '../EmptySeat';

/**
 * #2870 ST-3-R3 — the away placeholder must render at the exact sm footprint.
 *
 * Regression pin for the Chakra token-scale trap: `width={80}` resolves to the
 * `sizes.80` theme token (320px) instead of px. The placeholder therefore has
 * to pass unit strings ("80px"/"100px"), and the RESOLVED rendered size — not
 * the source prop — is what these assertions measure.
 */
describe('EmptySeat — rendered footprint (#2870 ST-3-R3)', () => {
  it('renders the away placeholder at exactly 80×100 px (unit strings, not a token scale)', () => {
    const { container } = renderWithChakra(<EmptySeat />);
    const seat = container.querySelector('[data-state="away"]');

    expect(seat).not.toBeNull();
    const style = getComputedStyle(seat as HTMLElement);

    // The unit-string contract: computed px, never the 320px `sizes.80` token.
    expect(style.width).toBe('80px');
    expect(style.height).toBe('100px');
    expect(style.width).not.toBe('320px');
  });

  it('is an inert, non-interactive visual marker with the documented hooks', () => {
    const { container } = renderWithChakra(<EmptySeat />);
    const seat = container.querySelector('[data-state="away"]') as HTMLElement;

    expect(seat.getAttribute('role')).toBe('img');
    expect(seat.getAttribute('aria-label')).toBe('Fredo is away');
    expect(getComputedStyle(seat).pointerEvents).toBe('none');
  });
});
