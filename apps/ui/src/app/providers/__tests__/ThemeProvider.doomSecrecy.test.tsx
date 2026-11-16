/**
 * Spec #2971 ST-6 — Doom palette secrecy (R-5 / AC4 negative).
 *
 * The Doom palette must NEVER be offered in the appearance/theme settings. It
 * lives ONLY in `doomTheme.ts` and is deliberately absent from the built-in
 * `themePresets` (`theme.ts`) and the provider's merged `allPresets`
 * (`[...userPresets, ...themePresets]`, `ThemeProvider.tsx`) that
 * `ThemePresetSelector` enumerates (`ThemingSettings.tsx`).
 *
 * This pin covers the "not offered" half of R-5 at the enumeration layer; the
 * "no residue while disengaged" half is pinned in
 * `ThemeProvider.doom.test.tsx` and `fredoAvatarArmor.test.tsx`.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { ThemeProvider, useTheme } from '../ThemeProvider';
import { themePresets, type ThemePreset } from '../../types/theme';
import { DOOM_PALETTE } from '../../theme/doomTheme';

vi.mock('../../../applications/settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
  serializeValue: (v: unknown) => JSON.stringify(v),
}));

import { settingsService } from '../../../applications/settings';

const getMock = settingsService.get as ReturnType<typeof vi.fn>;

/**
 * A preset is "the Doom palette" when its token subset deep-equals the full
 * Doom record (a preset added AS `DOOM_PALETTE`), or when it advertises itself
 * as Doom by id/name.
 */
const isDoomPreset = (preset: ThemePreset): boolean =>
  preset.id.toLowerCase().includes('doom') ||
  preset.name.toLowerCase().includes('doom') ||
  JSON.stringify(preset.colors) === JSON.stringify(DOOM_PALETTE);

describe('ThemeProvider Doom secrecy (#2971 ST-6, R-5/AC4)', () => {
  it('never lists the Doom palette among the built-in themePresets', () => {
    expect(themePresets.length).toBeGreaterThan(0);
    for (const preset of themePresets) {
      expect(isDoomPreset(preset), `built-in preset "${preset.id}" looks like Doom`).toBe(false);
    }
    // The Doom ground is not any built-in preset's ground either.
    for (const preset of themePresets) {
      expect(preset.colors.bodyBg).not.toBe(DOOM_PALETTE.bodyBg);
    }
  });

  it('never lists the Doom palette among the provider-merged allPresets', async () => {
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.allPresets.length).toBeGreaterThan(0));

    for (const preset of result.current.allPresets) {
      expect(isDoomPreset(preset), `selectable preset "${preset.id}" looks like Doom`).toBe(false);
      expect(preset.colors.bodyBg).not.toBe(DOOM_PALETTE.bodyBg);
    }
  });
});
