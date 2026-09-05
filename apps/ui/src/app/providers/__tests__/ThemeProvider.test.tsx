/**
 * #2758 — Invalid persisted theme fallback.
 * A stale/non-literal 'Fredo_theme' storage value must NOT make
 * useTheme().theme undefined (the crash behind the
 * "Cannot read properties of undefined (reading 'colors')" TypeError);
 * ThemeProvider clamps it to the 'classic' record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../ThemeProvider';
import { themes, themePresets } from '../../types/theme';

// Mock settingsService (same pattern as usePersistedSetting.test.ts)
vi.mock('../../../features/settings', () => ({
  settingsService: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
  },
  serializeValue: (v: unknown) => JSON.stringify(v),
}));

import { settingsService } from '../../../features/settings';

describe('ThemeProvider invalid persisted theme fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the classic record when persisted Fredo_theme is outside the literal set', async () => {
    let loaded = false;
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async () => {
      loaded = true;
      return 'stale-nonliteral-mode';
    });

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    // Ensure the async persisted load actually delivered the invalid value
    await waitFor(() => expect(loaded).toBe(true));
    // Flush the resulting setState before asserting on the clamped output
    await act(async () => {});

    expect(result.current.currentTheme).toBe('classic');
    expect(result.current.theme).toBeDefined();
    expect(result.current.theme).toBe(themes.classic);
  });
});

describe('ThemeProvider preset layer (#2811)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
  });

  const flush = async () => {
    await act(async () => {});
  };

  const readVar = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('applies a preset as a middle layer with override > preset > base precedence', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    // Simulate "never saved" — every setting resolves to its typed default, so the
    // provider starts from a clean stock base (overrides {} / preset '' / theme classic).
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    const baseAccent = themes.classic.colors.accentPrimary;

    // Select a preset → its token values apply immediately.
    act(() => result.current.setPreset('matrix'));
    await flush();

    const matrix = themePresets.find((p) => p.id === 'matrix')!;
    expect(result.current.selectedPreset).toBe('matrix');
    expect(readVar('--accent-primary')).toBe(matrix.colors.accentPrimary);
    expect(readVar('--body-bg')).toBe(matrix.colors.bodyBg);
    expect(readVar('--text-primary')).toBe(matrix.colors.textPrimary);
    // A token the preset leaves unchanged falls through to the base theme (never undefined).
    expect(readVar('--accent-subagent')).toBe(themes.classic.colors.accentSubagent);

    // Override a single token → it wins over the preset value.
    act(() => result.current.setOverride('accentPrimary', '#123456'));
    await flush();
    expect(readVar('--accent-primary')).toBe('#123456');
    // Every OTHER token still equals the preset value.
    expect(readVar('--body-bg')).toBe(matrix.colors.bodyBg);

    // Reset → clears the preset AND the override → stock base theme.
    act(() => result.current.resetTheme());
    await flush();
    expect(result.current.selectedPreset).toBe('');
    expect(result.current.overrides).toEqual({});
    expect(readVar('--accent-primary')).toBe(baseAccent);
    expect(readVar('--body-bg')).toBe(themes.classic.colors.bodyBg);
  });

  it('resetTheme clears BOTH the selected preset and all per-token overrides', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    act(() => result.current.setPreset('synthwave'));
    await flush();
    act(() => result.current.setOverride('bodyBg', '#0a0a0a'));
    act(() => result.current.setOverride('statusSuccess', '#00ff00'));
    await flush();

    expect(result.current.selectedPreset).toBe('synthwave');
    expect(result.current.overrides).toEqual({ bodyBg: '#0a0a0a', statusSuccess: '#00ff00' });

    act(() => result.current.resetTheme());
    await flush();

    expect(result.current.selectedPreset).toBe('');
    expect(result.current.overrides).toEqual({});
    // Stock base theme wins — no residual preset/override values.
    expect(readVar('--body-bg')).toBe(themes.classic.colors.bodyBg);
    expect(readVar('--status-success')).toBe(themes.classic.colors.statusSuccess);
    expect(readVar('--accent-primary')).toBe(themes.classic.colors.accentPrimary);
  });

  it('a stale/unmatched preset id resolves to the base theme (no crash)', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockResolvedValue('removed-preset-id');

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // Unmatched id → activePreset null → stock base theme applies.
    expect(result.current.selectedPreset).toBe('removed-preset-id');
    expect(readVar('--accent-primary')).toBe(themes.classic.colors.accentPrimary);
    expect(result.current.theme).toBe(themes.classic);
  });
});
