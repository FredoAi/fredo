/**
 * #2758 — Invalid persisted theme fallback.
 * A stale/non-literal 'Fredo_theme' storage value must NOT make
 * useTheme().theme undefined (the crash behind the
 * "Cannot read properties of undefined (reading 'colors')" TypeError);
 * ThemeProvider clamps it to the 'classic' record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ThemeProvider, useTheme, resolveAccentContrast } from '../ThemeProvider';
import { themes, themePresets } from '../../types/theme';
import { system } from '../../theme/system';

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
    getMock.mockImplementation(async (key: string, defaultValue: unknown) => {
      loaded = true;
      // The new array-typed user-preset key must resolve to its `[]` default,
      // never a string (the persisted-theme mock above is theme-key only).
      if (key === 'Fredo_user_presets') return [];
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

  it('locks the base to classic even when a stale persisted Fredo_theme value (turbo) is present — AC5', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    // Simulate a leftover persisted 'turbo' base-theme value from before the
    // base-theme selector was removed (#2817). The provider no longer reads
    // 'Fredo_theme', so it must never surface the stale value. The array-typed
    // user-preset key resolves to its `[]` default (never a string).
    getMock.mockImplementation(async (key: string, defaultValue: unknown) =>
      key === 'Fredo_user_presets' ? [] : defaultValue ?? 'turbo',
    );

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await act(async () => {});

    expect(result.current.currentTheme).toBe('classic');
    expect(result.current.theme).toBe(themes.classic);
    expect(result.current.theme).toBeDefined();
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
    // 'removed-preset-id' is a stale persisted preset; the new array-typed
    // user-preset key resolves to its `[]` default (never a string).
    getMock.mockImplementation(async (key: string, defaultValue: unknown) =>
      key === 'Fredo_user_presets' ? [] : 'removed-preset-id',
    );

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // Unmatched id → activePreset null → stock base theme applies.
    expect(result.current.selectedPreset).toBe('removed-preset-id');
    expect(readVar('--accent-primary')).toBe(themes.classic.colors.accentPrimary);
    expect(result.current.theme).toBe(themes.classic);
  });
});

describe('ThemeProvider user presets (#2845)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
  });

  const flush = async () => {
    await act(async () => {});
  };

  const readVar = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('exposes getPreset/allPresets empty by default and resolves a built-in through getPreset', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    expect(result.current.userPresets).toEqual([]);
    expect(result.current.allPresets).toEqual(themePresets);
    // getPreset resolves a built-in id (un-prefixed, never a user preset).
    const builtin = themePresets[0];
    expect(result.current.getPreset(builtin.id)).toBe(builtin);
    // Unmatched id → null (never collides, never crashes).
    expect(result.current.getPreset('does-not-exist')).toBeNull();
  });

  it('createUserPresetFromCurrent persists a user- namespaced preset, selects it, and clears overrides', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // Seed an active preset + a diverging override so the capture is meaningful.
    act(() => result.current.setPreset('tokyo-night'));
    await flush();
    act(() => result.current.setOverride('accentPrimary', '#123456'));
    await flush();

    act(() => result.current.createUserPresetFromCurrent('My custom'));
    await flush();

    expect(result.current.userPresets).toHaveLength(1);
    const saved = result.current.userPresets[0];
    // Distinct user- namespace, never colliding with a built-in id.
    expect(saved.id).toMatch(/^user-[0-9a-f-]{36}$/i);
    expect(saved.name).toBe('My custom');
    // Effective palette captured: the override wins for the edited token.
    expect(saved.colors.accentPrimary).toBe('#123456');
    expect(saved.colors.bodyBg).toBe(themePresets.find((p) => p.id === 'tokyo-night')!.colors.bodyBg);
    // The new preset is auto-selected and resolves through getPreset ✓ allPresets ✓.
    expect(result.current.selectedPreset).toBe(saved.id);
    expect(result.current.getPreset(saved.id)).toBe(saved);
    expect(result.current.allPresets[0]).toBe(saved);
    // Overrides cleared → applied palette is byte-preserved by the new preset.
    expect(result.current.overrides).toEqual({});
    expect(readVar('--accent-primary')).toBe('#123456');
    // Switching back to Default / None still falls back to base (no crash).
    act(() => result.current.setPreset(''));
    await flush();
    expect(readVar('--accent-primary')).toBe(themes.classic.colors.accentPrimary);
  });

  it('createUserPresetFromCurrent auto-titles Custom preset N when no name is passed', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    act(() => result.current.setPreset('dark'));
    await flush();
    act(() => result.current.createUserPresetFromCurrent());
    await flush();

    expect(result.current.userPresets).toHaveLength(1);
    expect(result.current.userPresets[0].name).toBe('Custom preset 1');
  });

  it('clearOverrides removes a batch of keys atomically in ONE write (F-9 multi-edit)', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);
    const setMock = settingsService.set as ReturnType<typeof vi.fn>;

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    act(() => result.current.setOverride('accentPrimary', '#111111'));
    act(() => result.current.setOverride('bodyBg', '#222222'));
    act(() => result.current.setOverride('statusSuccess', '#333333'));
    await flush();
    expect(Object.keys(result.current.overrides)).toHaveLength(3);

    // Batch-clear two of the three in a single call.
    const setCallsBefore = setMock.mock.calls.length;
    act(() => result.current.clearOverrides(['accentPrimary', 'bodyBg']));
    await flush();

    // Only the two requested keys are removed; the untouched one survives.
    expect(result.current.overrides).toEqual({ statusSuccess: '#333333' });
    // Exactly ONE persisted write for the batch (atomic, not one per key).
    expect(setMock.mock.calls.length - setCallsBefore).toBe(1);
    // The CSS vars revert to (preset ?? base) for the cleared tokens.
    expect(readVar('--accent-primary')).toBe(themes.classic.colors.accentPrimary);
    expect(readVar('--body-bg')).toBe(themes.classic.colors.bodyBg);
    // The untouched override survives — its CSS var is still the override value.
    expect(readVar('--status-success')).toBe('#333333');
  });
});

describe('ThemeProvider ST-1 token foundation (#2864)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
  });

  const flush = async () => {
    await act(async () => {});
  };

  const readVar = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('registers the derived hover/subtle/scrollbar/accent-strong/overlay/shadow vars', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // T1–T4/T6: single derived `color-mix` vars that resolve live per preset/override.
    expect(readVar('--hover-bg')).toBe('color-mix(in srgb, var(--text-primary) 6%, transparent)');
    expect(readVar('--text-subtle')).toBe('color-mix(in srgb, var(--text-secondary) 65%, var(--text-primary) 35%)');
    expect(readVar('--scrollbar-thumb')).toBe('color-mix(in srgb, var(--text-secondary) 45%, transparent)');
    expect(readVar('--scrollbar-thumb-hover')).toBe('color-mix(in srgb, var(--text-secondary) 70%, transparent)');
    expect(readVar('--accent-strong')).toBe('color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary) 45%)');
    // T7/T8: base-record-only presentation values.
    expect(readVar('--overlay-bg')).toBe('rgba(0, 0, 0, 0.6)');
    expect(readVar('--shadow-dialog')).toBe('0 24px 80px rgba(0, 0, 0, 0.4)');
    // Non-vacuous: the provider still renders the locked classic base.
    expect(result.current.currentTheme).toBe('classic');
  });

  it('computes --accent-contrast from the resolved accent (white on dark, near-black on pale)', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // Classic accent rgb(147,51,234) is dark → white on-accent (≈5.4:1).
    expect(readVar('--accent-primary')).toBe(themes.classic.colors.accentPrimary);
    expect(readVar('--accent-contrast')).toBe('#ffffff');

    // Pale cyan preset → near-black on-accent.
    act(() => result.current.setPreset('light-default'));
    await flush();
    expect(readVar('--accent-primary')).toBe('#00d1d1');
    expect(readVar('--accent-contrast')).toBe('#0c1117');

    // Arbitrary user override wins: black → white, amber → near-black.
    act(() => result.current.setOverride('accentPrimary', '#000000'));
    await flush();
    expect(readVar('--accent-contrast')).toBe('#ffffff');
    act(() => result.current.setOverride('accentPrimary', '#eab308'));
    await flush();
    expect(readVar('--accent-contrast')).toBe('#0c1117');

    // Clearing the override returns to (preset ?? base); here the preset is cleared.
    act(() => result.current.resetTheme());
    await flush();
    expect(readVar('--accent-contrast')).toBe('#ffffff');
  });

  it('resolveAccentContrast parses hex shorthand, alpha-hex, rgb()/rgba(), and falls back to white', () => {
    expect(resolveAccentContrast('#000')).toBe('#ffffff');
    expect(resolveAccentContrast('#ffffffff')).toBe('#0c1117');
    expect(resolveAccentContrast('rgb(0, 0, 0)')).toBe('#ffffff');
    expect(resolveAccentContrast('rgba(0, 0, 0, 0.5)')).toBe('#ffffff');
    // Unparseable input → deterministic white fallback (never crashes).
    expect(resolveAccentContrast('not-a-color')).toBe('#ffffff');
  });

  it('exposes the live-accent Chakra colorPalette so colorPalette="accent" resolves to the accent vars', () => {
    // A `colorPalette="accent"` control (ST-3) reads these Chakra semantic tokens.
    // Registration: the provider's semantic-token query lists the full palette …
    const registered = system.query.semanticTokens.search('colors', 'accent');
    expect(registered).toContain('accent.solid');
    expect(registered).toContain('accent.contrast');
    expect(registered).toContain('accent.focusRing');
    // … and `colorPalette="accent".solid` resolves to the registered token var.
    expect(system.token('colors.accent.solid')).toBeDefined();

    // The emitted base-layer token CSS proves each token aliases the accent vars
    // (never a stock Chakra hue). Dotted token paths are emitted with escaped dots.
    const tokenCss = system.getTokenCss() as Record<string, unknown>;
    const layer = tokenCss['@layer tokens'] as
      | Record<string, Record<string, string>>
      | Array<Record<string, Record<string, string>>>;
    const layerEntry = Array.isArray(layer) ? layer[0] : layer;
    const base = layerEntry['&:where(html, .chakra-theme)'];

    expect(base['--chakra-colors-accent\\.solid']).toBe('var(--accent-primary)');
    expect(base['--chakra-colors-accent\\.contrast']).toBe('var(--accent-contrast)');
    expect(base['--chakra-colors-accent\\.focus-ring']).toBe('var(--accent-primary)');
    expect(base['--chakra-colors-accent\\.fg']).toBe('var(--accent-primary)');
    expect(base['--chakra-colors-accent\\.strong']).toBe('var(--accent-strong)');
    // The other new audited-surface tokens emit their CSS-var aliases too.
    expect(base['--chakra-colors-bg\\.hover']).toBe('var(--hover-bg)');
    expect(base['--chakra-colors-fg\\.subtle']).toBe('var(--text-subtle)');
    expect(base['--chakra-colors-fg\\.on-accent']).toBe('var(--accent-contrast)');
    expect(base['--chakra-colors-overlay\\.scrim']).toBe('var(--overlay-bg)');
    expect(base['--chakra-shadows-shadow\\.dialog']).toBe('var(--shadow-dialog)');
  });
});
