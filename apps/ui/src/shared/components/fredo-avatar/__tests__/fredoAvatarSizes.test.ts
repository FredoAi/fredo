import { describe, expect, it } from 'vitest';

import { AVATAR_SM, AVATAR_SM_CSS, toCssPx } from '../fredoAvatarSizes';

/**
 * #2870 ST-3-R3 — the Chakra-prop size conversion.
 *
 * Chakra v3 resolves a BARE NUMBER in `width`/`height` to a theme `sizes`
 * token (`width={80}` → `sizes.80` = 320px), so the reserved seat must pass a
 * unit STRING. These pins lock BOTH halves of the contract:
 *   - `AVATAR_SM` stays numeric (SVG attrs / React inline styles / teleport
 *     math / speech-bubble consumers depend on numbers);
 *   - the shared conversion returns the unit-string pair Chakra needs.
 */
describe('fredoAvatarSizes — shared px-string conversion (#2870 ST-3-R3)', () => {
  it('keeps AVATAR_SM numeric (80 × 100) for the SVG/inline-style consumers', () => {
    expect(AVATAR_SM).toEqual({ width: 80, height: 100 });
    expect(typeof AVATAR_SM.width).toBe('number');
    expect(typeof AVATAR_SM.height).toBe('number');
  });

  it('toCssPx converts a numeric px length to its CSS unit string', () => {
    expect(toCssPx(80)).toBe('80px');
    expect(toCssPx(100)).toBe('100px');
  });

  it('AVATAR_SM_CSS is the unit-string pair derived from AVATAR_SM (never bare numbers)', () => {
    expect(AVATAR_SM_CSS).toEqual({ width: '80px', height: '100px' });
    expect(AVATAR_SM_CSS.width).toBe(toCssPx(AVATAR_SM.width));
    expect(AVATAR_SM_CSS.height).toBe(toCssPx(AVATAR_SM.height));
  });
});
