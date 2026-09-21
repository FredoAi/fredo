import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { ThemeMode, Theme, ThemeOverrides, ThemePreset } from '../types/theme';
import { themes, themePresets, USER_PRESET_PREFIX } from '../types/theme';
import { usePersistedSetting } from '../../shared/hooks/usePersistedSetting';

export interface ThemeContextType {
  currentTheme: ThemeMode;
  theme: Theme;
  /** Active per-key overrides (on top of the base theme) */
  overrides: ThemeOverrides;
  /** Set or clear a single override. Pass an empty string to remove the key. */
  setOverride: (key: keyof ThemeOverrides, value: string) => void;
  /** Clear a batch of keys in ONE composed write, avoiding stale-closure drops. */
  clearOverrides: (keys: (keyof ThemeOverrides)[]) => void;
  /** Remove all overrides, reverting to the base theme values. */
  resetOverrides: () => void;
  /** Currently selected preset id, or '' for none. */
  selectedPreset: string;
  /** Apply a preset (its token values sit below per-token overrides). '' clears it. */
  setPreset: (presetId: string) => void;
  /** Clear the selected preset AND all per-token overrides → stock base theme. */
  resetTheme: () => void;
  /** User-created presets, persisted under 'Fredo_user_presets'. */
  userPresets: ThemePreset[];
  /** All selectable presets: user presets first, then the 18 built-ins. */
  allPresets: ThemePreset[];
  /** Resolve any preset by id (user first, then built-in); null when unmatched. */
  getPreset: (id: string) => ThemePreset | null;
  /**
   * Persist the CURRENT effective palette (override ?? preset ?? base, all 15
   * tokens) as a new user preset, select it, clear per-token overrides, and
   * return its id. Auto-titles 'Custom preset N'; id = 'user-<uuid>'.
   */
  createUserPresetFromCurrent: (name?: string) => void;
}

/**
 * Shared ThemeContext — used by ThemeProvider (localStorage).
 */
export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};

/**
 * #2864 ST-1 (T5) — on-accent foreground colors. `#ffffff` is
 * `ACCENT_CONTRAST_LIGHT`; `#0c1117` the near-black `ACCENT_CONTRAST_DARK`.
 */
const ACCENT_CONTRAST_LIGHT = '#ffffff';
const ACCENT_CONTRAST_DARK = '#0c1117';
const ACCENT_CONTRAST_DARK_RGB: [number, number, number] = [12, 17, 23];

/**
 * Parse a CSS color (hex or rgb/rgba) into 0-255 RGB channels. Returns null for
 * anything unparseable so the caller can fall back deterministically.
 */
function parseAccentRgb(color: string): [number, number, number] | null {
  const value = color.trim().toLowerCase();
  let r: number;
  let g: number;
  let b: number;
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const expanded = hex.length === 3 || hex.length === 4;
    const rrggbb = expanded
      ? hex.slice(0, 3).split('').map((c) => c + c).join('')
      : hex.slice(0, 6);
    if (rrggbb.length !== 6) return null;
    r = parseInt(rrggbb.slice(0, 2), 16);
    g = parseInt(rrggbb.slice(2, 4), 16);
    b = parseInt(rrggbb.slice(4, 6), 16);
  } else {
    const fn = value.match(/^rgba?\(([^)]+)\)$/);
    if (!fn) return null;
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length !== 3) return null;
    [r, g, b] = parts;
  }
  return [r, g, b].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)
    ? [r, g, b]
    : null;
}

/** sRGB gamma-decoded channel (WCAG 2.x definition). */
function srgbToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relativeLuminance(rgb: [number, number, number]): number {
  return (
    0.2126 * srgbToLinear(rgb[0]) +
    0.7152 * srgbToLinear(rgb[1]) +
    0.0722 * srgbToLinear(rgb[2])
  );
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * #2864 ST-1 (T5) — pick the on-accent foreground (`#ffffff` vs `#0c1117`) that
 * yields the higher WCAG contrast against `accent`. A tie resolves to `#ffffff`.
 * An unparseable accent falls back to `#ffffff` (the safe classic-accent choice).
 */
export function resolveAccentContrast(accent: string): string {
  const rgb = parseAccentRgb(accent);
  if (!rgb) return ACCENT_CONTRAST_LIGHT;
  const accentLuminance = relativeLuminance(rgb);
  const againstWhite = contrastRatio(1, accentLuminance);
  const againstDark = contrastRatio(relativeLuminance(ACCENT_CONTRAST_DARK_RGB), accentLuminance);
  return againstWhite >= againstDark ? ACCENT_CONTRAST_LIGHT : ACCENT_CONTRAST_DARK;
}

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * ThemeProvider — localStorage-backed theme provider.
 * Applies base theme CSS variables, then user overrides as a second pass.
 */
export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  // #2817 — The base theme is LOCKED to the single stock `classic` base. The
  // persisted 'Fredo_theme' read is dropped entirely so a stale persisted value
  // (e.g. 'turbo' from before the base-theme selector was removed) is NEVER read,
  // keeping the shell stable. The theme-preset + per-token override layers
  // (`override ?? preset ?? base`) still apply on top of this locked base.
  const activeTheme: ThemeMode = 'classic';

  const [overrides, setOverridesStorage] = usePersistedSetting<ThemeOverrides>(
    'Fredo_theme_overrides',
    {},
    JSON.stringify,
    (raw) => { try { return JSON.parse(raw); } catch { return {}; } },
  );
  // #2811 — Curated preset applied as a MIDDLE layer between the base theme and
  // per-token overrides. Persisted under its own key; '' = none (stock base).
  const [selectedPreset, setSelectedPreset] = usePersistedSetting<string>('Fredo_theme_preset', '');

  // #2845 — user presets persist alongside the built-ins under their own key.
  // A stale/unmatched preset id simply resolves to null → base theme (no crash),
  // mirroring the #2758 clamp behavior for the preset layer.
  const [userPresets, setUserPresets] = usePersistedSetting<ThemePreset[]>(
    'Fredo_user_presets',
    [],
    JSON.stringify,
    (raw) => { try { return JSON.parse(raw); } catch { return []; } },
  );

  // Resolve any preset by id — user presets (higher priority) then built-ins.
  // A stale/unmatched id resolves to null → base theme (no crash).
  const getPreset = (id: string): ThemePreset | null =>
    userPresets.find((p) => p.id === id) ?? themePresets.find((p) => p.id === id) ?? null;

  const activePreset = getPreset(selectedPreset);

  // All selectable presets: user presets first, then the 18 built-ins.
  const allPresets = useMemo(() => [...userPresets, ...themePresets], [userPresets]);

  // All 15 user-overridable tokens (12 colors + 3 fonts) used to capture the
  // effective palette when persisting a new user preset.
  const USER_PRESET_TOKEN_KEYS: (keyof ThemeOverrides)[] = [
    'accentPrimary', 'accentSecondary', 'borderColor',
    'bodyBg', 'cardBg', 'headerBg',
    'textPrimary', 'textSecondary',
    'statusSuccess', 'statusWarning', 'statusError', 'statusInfo',
    'fontPrimary', 'fontSecondary', 'fontBase',
  ];

  // Capture the effective `override ?? preset ?? base` palette for all 15
  // tokens, persist it as a new user preset, select it, and clear per-token
  // overrides so the applied palette is byte-preserved.
  const createUserPresetFromCurrent = (name?: string) => {
    const base = themes[activeTheme].colors as Record<keyof ThemeOverrides, string>;
    const palette: Partial<ThemeOverrides> = {};
    for (const key of USER_PRESET_TOKEN_KEYS) {
      const value = overrides[key]
        ?? (activePreset && (activePreset.colors as Partial<ThemeOverrides>)[key])
        ?? base[key];
      if (value) palette[key] = value;
    }
    const id = `${USER_PRESET_PREFIX}${crypto.randomUUID()}`;
    setUserPresets([
      ...userPresets,
      { id, name: name ?? `Custom preset ${userPresets.length + 1}`, colors: palette },
    ]);
    setPreset(id);
    resetOverrides();
  };

  // Apply CSS variables whenever theme or overrides change
  useEffect(() => {
    const theme = themes[activeTheme];
    const root = document.documentElement;

    // --- Base theme ---
    root.style.setProperty('--body-bg', theme.colors.bodyBg);
    root.style.setProperty('--header-bg', theme.colors.headerBg);
    root.style.setProperty('--footer-bg', theme.colors.footerBg);
    root.style.setProperty('--card-bg', theme.colors.cardBg);
    root.style.setProperty('--card-hover-bg', theme.colors.cardHoverBg);
    root.style.setProperty('--text-primary', theme.colors.textPrimary);
    root.style.setProperty('--text-secondary', theme.colors.textSecondary);
    root.style.setProperty('--border-color', theme.colors.borderColor);
    root.style.setProperty('--accent-primary', theme.colors.accentPrimary);
    root.style.setProperty('--accent-secondary', theme.colors.accentSecondary);
    // #2745 ST-5 (AC-1): the subagent identity accent — set from the theme
    // record like every other CSS var, so the theming feature can restyle all
    // subagent surfaces (the revived rich SubagentNode + DetailPanel chip).
    root.style.setProperty('--accent-subagent', theme.colors.accentSubagent);
    // #2770 (AC-1/AC-2): the nested-subagent identity accent — set from the
    // theme record like every other CSS var, so a theme switch re-applies it
    // in the same one-pass effect (no stale color without remount).
    root.style.setProperty('--accent-nested-subagent', theme.colors.accentNestedSubagent);
    root.style.setProperty('--status-success', theme.colors.statusSuccess);
    root.style.setProperty('--status-warning', theme.colors.statusWarning);
    root.style.setProperty('--status-error', theme.colors.statusError);
    root.style.setProperty('--status-info', theme.colors.statusInfo);
    root.style.setProperty('--gradient-text', theme.colors.gradientText);
    root.style.setProperty('--gradient-button', theme.colors.gradientButton);
    root.style.setProperty('--node-bg', theme.colors.nodeBg);
    root.style.setProperty('--node-box-shadow', theme.colors.nodeBoxShadow);
    root.style.setProperty('--edge-gradient', theme.colors.edgeGradient);
    root.style.setProperty('--font-family', theme.colors.fontFamily);
    root.style.setProperty('--font-primary', theme.colors.fontPrimary);
    root.style.setProperty('--font-secondary', theme.colors.fontSecondary);
    root.style.setProperty('--font-base', theme.colors.fontBase);

    // --- #2864 ST-1 derived presentation vars (set ONCE in the base pass) ---
    // These are `color-mix()` expressions over the live theme vars, so they resolve
    // against whatever the preset/override passes put on --text-primary /
    // --text-secondary / --accent-primary later — no per-preset values needed.
    root.style.setProperty('--hover-bg', 'color-mix(in srgb, var(--text-primary) 6%, transparent)'); // T1
    root.style.setProperty('--text-subtle', 'color-mix(in srgb, var(--text-secondary) 65%, var(--text-primary) 35%)'); // T2
    root.style.setProperty('--scrollbar-thumb', 'color-mix(in srgb, var(--text-secondary) 45%, transparent)'); // T3
    root.style.setProperty('--scrollbar-thumb-hover', 'color-mix(in srgb, var(--text-secondary) 70%, transparent)'); // T4
    root.style.setProperty('--accent-strong', 'color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary) 45%)'); // T6
    // #2917 ST-1 (T9): the FREDO avatar interior fill — accent mixed into the
    // OPAQUE body surface (NOT --card-bg, which is rgba(0,0,0,0.3) in the classic
    // dark preset and would re-open the hollow-figure defect). Opaque in every
    // preset; re-resolves live on any preset/accent change with no remount.
    root.style.setProperty('--fredo-avatar-interior', 'color-mix(in srgb, var(--accent-primary) 20%, var(--body-bg))');
    // T7/T8 — base-record-only presentation values (never part of the override contract).
    root.style.setProperty('--overlay-bg', theme.colors.overlayBg);
    root.style.setProperty('--shadow-dialog', theme.colors.shadowDialog);

    document.body.style.background = theme.colors.bodyBg;
    document.body.style.color = theme.colors.textPrimary;
    document.body.style.fontFamily = theme.colors.fontFamily;
    document.body.className = `theme-${activeTheme}`;

    // --- Preset (middle layer: base < preset < override) ---
    // #2811 — a curated preset's token values sit between the base theme and the
    // per-token override pass, so an individual override still wins over a preset
    // (override ?? preset ?? base). The special side-effects (body bg/text/font,
    // header→footer) mirror the override pass' behavior exactly so a light/dark
    // palette renders correctly. If a preset leaves a token out it falls through
    // to the base theme, so a preset never leaves a bare/undefined CSS var.
    if (activePreset) {
      const p = activePreset.colors;
      if (p.accentPrimary) root.style.setProperty('--accent-primary', p.accentPrimary);
      if (p.accentSecondary) root.style.setProperty('--accent-secondary', p.accentSecondary);
      if (p.borderColor) root.style.setProperty('--border-color', p.borderColor);
      if (p.bodyBg) {
        root.style.setProperty('--body-bg', p.bodyBg);
        document.body.style.background = p.bodyBg;
      }
      if (p.cardBg) root.style.setProperty('--card-bg', p.cardBg);
      if (p.headerBg) {
        root.style.setProperty('--header-bg', p.headerBg);
        root.style.setProperty('--footer-bg', p.headerBg);
      }
      if (p.textPrimary) {
        root.style.setProperty('--text-primary', p.textPrimary);
        document.body.style.color = p.textPrimary;
      }
      if (p.textSecondary) root.style.setProperty('--text-secondary', p.textSecondary);
      if (p.statusSuccess) root.style.setProperty('--status-success', p.statusSuccess);
      if (p.statusWarning) root.style.setProperty('--status-warning', p.statusWarning);
      if (p.statusError) root.style.setProperty('--status-error', p.statusError);
      if (p.statusInfo) root.style.setProperty('--status-info', p.statusInfo);
      if (p.fontPrimary) root.style.setProperty('--font-primary', p.fontPrimary);
      if (p.fontSecondary) root.style.setProperty('--font-secondary', p.fontSecondary);
      if (p.fontBase) {
        root.style.setProperty('--font-base', p.fontBase);
        root.style.setProperty('--font-family', p.fontBase);
        document.body.style.fontFamily = p.fontBase;
      }
    }

    // --- Overrides (applied as a second pass) ---
    if (overrides.accentPrimary) root.style.setProperty('--accent-primary', overrides.accentPrimary);
    if (overrides.accentSecondary) root.style.setProperty('--accent-secondary', overrides.accentSecondary);
    if (overrides.borderColor) root.style.setProperty('--border-color', overrides.borderColor);
    if (overrides.bodyBg) {
      root.style.setProperty('--body-bg', overrides.bodyBg);
      document.body.style.background = overrides.bodyBg;
    }
    if (overrides.cardBg) root.style.setProperty('--card-bg', overrides.cardBg);
    if (overrides.headerBg) {
      root.style.setProperty('--header-bg', overrides.headerBg);
      root.style.setProperty('--footer-bg', overrides.headerBg);
    }
    if (overrides.textPrimary) {
      root.style.setProperty('--text-primary', overrides.textPrimary);
      document.body.style.color = overrides.textPrimary;
    }
    if (overrides.textSecondary) root.style.setProperty('--text-secondary', overrides.textSecondary);
    if (overrides.statusSuccess) root.style.setProperty('--status-success', overrides.statusSuccess);
    if (overrides.statusWarning) root.style.setProperty('--status-warning', overrides.statusWarning);
    if (overrides.statusError) root.style.setProperty('--status-error', overrides.statusError);
    if (overrides.statusInfo) root.style.setProperty('--status-info', overrides.statusInfo);
    if (overrides.fontPrimary) root.style.setProperty('--font-primary', overrides.fontPrimary);
    if (overrides.fontSecondary) root.style.setProperty('--font-secondary', overrides.fontSecondary);
    if (overrides.fontBase) {
      root.style.setProperty('--font-base', overrides.fontBase);
      root.style.setProperty('--font-family', overrides.fontBase);
      document.body.style.fontFamily = overrides.fontBase;
    }

    // --- #2864 ST-1 (T5): on-accent foreground ---
    // Computed in JS from the RESOLVED accent (base → preset → override) — WCAG
    // relative luminance has no sufficient CSS equivalent. Reading the applied
    // inline value guarantees arbitrary user accentPrimary overrides are covered.
    const resolvedAccent = root.style.getPropertyValue('--accent-primary') || theme.colors.accentPrimary;
    root.style.setProperty('--accent-contrast', resolveAccentContrast(resolvedAccent));
  }, [activeTheme, overrides, activePreset]);

  const setOverride = (key: keyof ThemeOverrides, value: string) => {
    const next = { ...overrides };
    if (!value) {
      delete next[key];
    } else {
      next[key] = value;
    }
    setOverridesStorage(next);
  };

  // Clear a batch of keys in ONE composed write. Without this, a multi-token
  // Discard loops `setOverride` over the SAME stale `overrides` render closure,
  // so under React batching only the last key's deletion survives (N-1 dirty
  // tokens remain). Deleting every key from a single copy and writing once keeps
  // the batch atomic (F-9 multi-edit).
  const clearOverrides = (keys: (keyof ThemeOverrides)[]) => {
    const next = { ...overrides };
    for (const key of keys) delete next[key];
    setOverridesStorage(next);
  };

  const resetOverrides = () => {
    setOverridesStorage({});
  };

  const setPreset = (presetId: string) => {
    setSelectedPreset(presetId);
  };

  const resetTheme = () => {
    setSelectedPreset('');
    setOverridesStorage({});
  };

  return (
    <ThemeContext.Provider
      value={{
        currentTheme: activeTheme,
        theme: themes[activeTheme],
        overrides,
        setOverride,
        clearOverrides,
        resetOverrides,
        selectedPreset,
        setPreset,
        resetTheme,
        userPresets,
        allPresets,
        getPreset,
        createUserPresetFromCurrent,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};
