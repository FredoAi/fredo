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
    // #2865 ST-3a: `bg`/`fg` are now declared in the NESTED shape that Chakra's
    // `defaultConfig` uses, so they emit DASH custom properties (the escaped-dot
    // form was unreachable and let the stock default win the resolution).
    expect(base['--chakra-colors-bg-hover']).toBe('var(--hover-bg)');
    expect(base['--chakra-colors-fg-subtle']).toBe('var(--text-subtle)');
    expect(base['--chakra-colors-fg-on-accent']).toBe('var(--accent-contrast)');
    expect(base['--chakra-colors-overlay\\.scrim']).toBe('var(--overlay-bg)');
    expect(base['--chakra-shadows-shadow\\.dialog']).toBe('var(--shadow-dialog)');
  });
});

// ── #2864 ST-5 — derived-token RESOLUTION assertions ──────────────────────────
// These resolve a `color-mix()` expression against the inline theme CSS vars
// without a CSS engine (jsdom does not compute color-mix()). That still proves
// the token is DERIVED, LIVE (re-resolves per preset), and non-transparent — the
// exact regression the pre-#2864 undefined `--hover-bg` collapsed into.

interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface MixStop {
  color: string;
  pct: number;
}

const parseHexColor = (value: string): RgbColor | null => {
  const match = /^#([0-9a-fA-F]{3,8})$/.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (hex.length === 6) hex += 'ff';
  if (hex.length !== 8) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: parseInt(hex.slice(6, 8), 16) / 255,
  };
};

const parseRgbFunction = (value: string): RgbColor | null => {
  const match = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((c) => !Number.isFinite(c))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 };
};

/** Resolve a hex / rgb(a) / `var(--x)` reference against the root inline vars. */
const resolveColor = (value: string): RgbColor | null => {
  const token = value.trim();
  if (token === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (token.startsWith('#')) return parseHexColor(token);
  if (/^rgba?\(/.test(token)) return parseRgbFunction(token);
  const varMatch = /^var\((--[a-z0-9-]+)\)$/.exec(token);
  if (varMatch) {
    const resolved = document.documentElement.style.getPropertyValue(varMatch[1]).trim();
    if (!resolved || resolved === token) return null;
    return resolveColor(resolved);
  }
  return null;
};

const parseMixStop = (value: string): MixStop => {
  const match = /^(.+?)\s+(\d+(?:\.\d+)?)%$/.exec(value.trim());
  return match
    ? { color: match[1].trim(), pct: Number(match[2]) }
    : { color: value.trim(), pct: 100 };
};

/** Parse the exact `color-mix(in srgb, A, B)` form the provider emits. */
const parseColorMixValue = (value: string): { a: MixStop; b: MixStop } | null => {
  const match = /^color-mix\(in srgb,\s*(.+?),\s*(.+)\)$/.exec(value.trim());
  if (!match) return null;
  return { a: parseMixStop(match[1]), b: parseMixStop(match[2]) };
};

/** Resulting alpha of a two-stop `color-mix` (0 = fully transparent). */
const mixAlpha = (mix: { a: MixStop; b: MixStop }): number => {
  const a = resolveColor(mix.a.color);
  const b = resolveColor(mix.b.color);
  if (!a || !b) throw new Error(`unresolvable color-mix stop: ${JSON.stringify(mix)}`);
  return (a.a * mix.a.pct + b.a * mix.b.pct) / 100;
};

describe('ThemeProvider ST-5 derived-token resolution (#2864)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
  });

  const flush = async () => {
    await act(async () => {});
  };

  const readVar = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('T1 — --hover-bg resolves to a non-transparent derived tint in light AND dark', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // The pre-#2864 failure was an UNDEFINED var → declaration collapse to
    // `transparent`. The token must exist and never be the bare keyword.
    const darkValue = readVar('--hover-bg');
    expect(darkValue).toBeTruthy();
    expect(darkValue).not.toBe('transparent');

    const darkMix = parseColorMixValue(darkValue);
    expect(darkMix).not.toBeNull();
    // The dark (base classic) source is an opaque color, mixed at 6% over
    // transparent → alpha 0.06 — visible, not a no-op transparent fill.
    const darkSource = resolveColor(darkMix!.a.color);
    expect(darkSource).not.toBeNull();
    expect(darkSource!.a).toBe(1);
    const darkAlpha = mixAlpha(darkMix!);
    expect(darkAlpha).toBeGreaterThan(0);
    expect(darkAlpha).toBeLessThan(1);

    // Same single derived expression under the light preset …
    act(() => result.current.setPreset('light-default'));
    await flush();
    const lightValue = readVar('--hover-bg');
    expect(lightValue).toBe(darkValue);
    const lightMix = parseColorMixValue(lightValue)!;
    const lightSource = resolveColor(lightMix.a.color);
    expect(lightSource).not.toBeNull();
    expect(lightSource!.a).toBe(1);
    expect(mixAlpha(lightMix)).toBeCloseTo(darkAlpha, 5);
    // … and the source color really did re-resolve for the theme (live, not frozen).
    expect(resolveColor('var(--text-primary)')).not.toEqual(darkSource);
  });

  it('T2/T3/T4/T6 — --text-subtle, --scrollbar-thumb(-hover) and --accent-strong are registered and stay theme-derived', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    const cases: Array<{ name: string; sources: string[]; opaque: boolean }> = [
      { name: '--text-subtle', sources: ['--text-secondary', '--text-primary'], opaque: true },
      { name: '--scrollbar-thumb', sources: ['--text-secondary'], opaque: false },
      { name: '--scrollbar-thumb-hover', sources: ['--text-secondary'], opaque: false },
      { name: '--accent-strong', sources: ['--accent-primary', '--text-primary'], opaque: true },
    ];

    const assertDerived = (phase: string) => {
      for (const { name, sources, opaque } of cases) {
        const value = readVar(name);
        expect(value, `${name} must be registered (${phase})`).toBeTruthy();
        const mix = parseColorMixValue(value);
        expect(mix, `${name} must be a derived color-mix (${phase})`).not.toBeNull();
        for (const source of sources) {
          expect(value, `${name} must reference ${source} (${phase})`).toContain(`var(${source})`);
          expect(resolveColor(`var(${source})`), `${source} must resolve (${phase})`).not.toBeNull();
        }
        const alpha = mixAlpha(mix!);
        if (opaque) {
          // Fully opaque: text stays legible (never a translucent text token).
          expect(alpha, `${name} must be opaque (${phase})`).toBeCloseTo(1, 5);
        } else {
          // A real, visible thumb — not a fully transparent one.
          expect(alpha, `${name} must be visible (${phase})`).toBeGreaterThan(0);
          expect(alpha, `${name} must be a tint (${phase})`).toBeLessThan(1);
        }
      }
    };

    assertDerived('dark');
    act(() => result.current.setPreset('light-default'));
    await flush();
    assertDerived('light');
  });

  it('T5 — --accent-contrast is computed for every preset AND an arbitrary user accent override', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (_key: string, defaultValue: unknown) => defaultValue);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    // Base classic purple rgb(147,51,234) is dark → white on-accent (≈5.4:1).
    expect(readVar('--accent-contrast')).toBe('#ffffff');

    // Concrete oracles for pale/light accents (the H7 failures the literal
    // `white` produced): cyan #00d1d1, monochrome #ffffff, tokyo-night #7aa2f7.
    const presetOracles: Record<string, string> = {
      'light-default': '#0c1117',
      monochrome: '#0c1117',
      'tokyo-night': '#0c1117',
    };
    for (const [id, expected] of Object.entries(presetOracles)) {
      act(() => result.current.setPreset(id));
      await flush();
      expect(readVar('--accent-contrast'), id).toBe(expected);
    }

    // Every built-in preset that declares an accent resolves to exactly one of
    // the two sanctioned foregrounds, and matches the WCAG luminance helper.
    for (const preset of themePresets) {
      const accent = preset.colors.accentPrimary;
      if (!accent) continue;
      act(() => result.current.setPreset(preset.id));
      await flush();
      expect(readVar('--accent-primary'), preset.id).toBe(accent);
      const contrast = readVar('--accent-contrast');
      expect(['#ffffff', '#0c1117'], preset.id).toContain(contrast);
      expect(resolveAccentContrast(accent), preset.id).toBe(contrast);
    }

    // An arbitrary user accent override (no preset supplies its contrast).
    act(() => result.current.resetTheme());
    await flush();
    act(() => result.current.setOverride('accentPrimary', '#eab308'));
    await flush();
    expect(readVar('--accent-contrast')).toBe('#0c1117');
    act(() => result.current.setOverride('accentPrimary', '#123456'));
    await flush();
    expect(readVar('--accent-contrast')).toBe('#ffffff');
  });
});
