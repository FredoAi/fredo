import React, { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { ThemeMode, Theme, ThemeOverrides } from '../types/theme';
import { themes } from '../types/theme';
import { usePersistedSetting } from '../../shared/hooks/usePersistedSetting';

export interface ThemeContextType {
  currentTheme: ThemeMode;
  theme: Theme;
  setTheme: (theme: ThemeMode) => void;
  availableThemes: Theme[];
  /** Active per-key overrides (on top of the base theme) */
  overrides: ThemeOverrides;
  /** Set or clear a single override. Pass an empty string to remove the key. */
  setOverride: (key: keyof ThemeOverrides, value: string) => void;
  /** Remove all overrides, reverting to the base theme values. */
  resetOverrides: () => void;
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

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * ThemeProvider — localStorage-backed theme provider.
 * Applies base theme CSS variables, then user overrides as a second pass.
 */
export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const [currentTheme, setThemeStorage] = usePersistedSetting<ThemeMode>('Fredo_theme', 'classic');
  const [overrides, setOverridesStorage] = usePersistedSetting<ThemeOverrides>(
    'Fredo_theme_overrides',
    {},
    JSON.stringify,
    (raw) => { try { return JSON.parse(raw); } catch { return {}; } },
  );

  // #2758 — Clamp the persisted mode to a literal that exists in `themes`.
  // A stale/unexpected 'Fredo_theme' storage value would otherwise flow into
  // `themes[currentTheme]` → undefined, crashing every consumer that reads
  // `theme.colors`. Validated once here; all downstream reads use this.
  const activeTheme: ThemeMode = themes[currentTheme] ? currentTheme : 'classic';

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
    document.body.style.background = theme.colors.bodyBg;
    document.body.style.color = theme.colors.textPrimary;
    document.body.style.fontFamily = theme.colors.fontFamily;
    document.body.className = `theme-${activeTheme}`;

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
  }, [activeTheme, overrides]);

  const setTheme = (theme: ThemeMode) => {
    setThemeStorage(theme);
  };

  const setOverride = (key: keyof ThemeOverrides, value: string) => {
    const next = { ...overrides };
    if (!value) {
      delete next[key];
    } else {
      next[key] = value;
    }
    setOverridesStorage(next);
  };

  const resetOverrides = () => {
    setOverridesStorage({});
  };

  return (
    <ThemeContext.Provider
      value={{
        currentTheme: activeTheme,
        theme: themes[activeTheme],
        setTheme,
        availableThemes: Object.values(themes),
        overrides,
        setOverride,
        resetOverrides,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};
