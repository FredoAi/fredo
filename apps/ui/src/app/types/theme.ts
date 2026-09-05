export type ThemeMode = 'turbo' | 'classic';

/**
 * Per-color and per-font overrides that sit on top of the active base theme.
 * Stored in localStorage as `Fredo_theme_overrides`.
 * Values use the same keys as Theme.colors so ThemeProvider can apply them
 * as a second CSS-variable pass after the base theme is applied.
 */
export interface ThemeOverrides {
  // Accent
  accentPrimary?: string;
  accentSecondary?: string;
  borderColor?: string;
  // Backgrounds
  bodyBg?: string;
  cardBg?: string;
  headerBg?: string;
  // Text
  textPrimary?: string;
  textSecondary?: string;
  // Status
  statusSuccess?: string;
  statusWarning?: string;
  statusError?: string;
  statusInfo?: string;
  // Fonts
  fontPrimary?: string;
  fontSecondary?: string;
  fontBase?: string;
}

export interface Theme {
  id: ThemeMode;
  name: string;
  description: string;
  colors: {
    // Background colors
    bodyBg: string;
    headerBg: string;
    footerBg: string;
    cardBg: string;
    cardHoverBg: string;
    
    // Text colors
    textPrimary: string;
    textSecondary: string;
    
    // Border colors
    borderColor: string;
    
    // Accent colors
    accentPrimary: string;
    accentSecondary: string;
    // #2745 ST-5 (AC-1): the subagent identity accent (`--accent-subagent`).
    // Dark (turbo + classic): #6366f1 (the established subagent indigo);
    // light (future theme): #4f46e5 (indigo-700 — ≥3:1 on a light surface).
    accentSubagent: string;
    // #2770 (AC-1/AC-2): the NESTED-subagent identity accent
    // (`--accent-nested-subagent`). Depth ≥ 2 cards carry this instead of
    // accentSubagent so the nesting tier is color-distinguishable from
    // level-1 at a glance. Dark (turbo + classic): #f59e0b (amber —
    // hue-distinct from the indigo #6366f1 level-1 accent; ≥6:1 on both
    // themes' card surfaces).
    accentNestedSubagent: string;
    
    // Status colors
    statusSuccess: string;
    statusWarning: string;
    statusError: string;
    statusInfo: string;
    
    // Gradients
    gradientText: string;
    gradientButton: string;
    
    // Node specific
    nodeBg: string;
    nodeBoxShadow: string;
    edgeGradient: string;
    
    // Fonts
    fontFamily: string;
    fontPrimary: string;  // For h1, main headings
    fontSecondary: string; // For h2, subheadings
    fontBase: string;      // For body text, paragraphs
  };
}

export const themes: Record<ThemeMode, Theme> = {
  'turbo': {
    id: 'turbo',
    name: 'Turbo',
    description: 'Modern theme with vibrant purple/blue gradients',
    colors: {
      bodyBg: 'rgb(17, 17, 17)',
      headerBg: 'rgb(17, 17, 17)',
      footerBg: 'rgb(17, 17, 17)',
      cardBg: 'rgba(0, 0, 0, 0.3)',
      cardHoverBg: 'rgba(168, 85, 186, 0.2)',
      
      textPrimary: 'rgb(243, 244, 246)',
      textSecondary: '#888',
      
      borderColor: 'rgba(168, 85, 186, 0.3)',
      
      accentPrimary: '#ae53ba',
      accentSecondary: '#2a8af6',
      accentSubagent: '#6366f1',
      accentNestedSubagent: '#f59e0b',
      
      statusSuccess: '#10b981',
      statusWarning: '#f59e0b',
      statusError: '#ef4444',
      statusInfo: '#2a8af6',
      
      gradientText: 'linear(to-r, #ae53ba, #2a8af6)',
      gradientButton: 'linear-gradient(135deg, #ae53ba 0%, #2a8af6 100%)',
      
      nodeBg: 'rgb(17, 17, 17)',
      nodeBoxShadow: '10px 0 15px rgba(42, 138, 246, 0.3), -10px 0 15px rgba(233, 42, 103, 0.3)',
      edgeGradient: 'url(#edge-gradient)',
      
      fontFamily: "'Fira Mono', 'Courier New', monospace",
      fontPrimary: "'Fira Mono', 'Courier New', monospace",
      fontSecondary: "'Fira Mono', 'Courier New', monospace",
      fontBase: "'Fira Mono', 'Courier New', monospace",
    },
  },
  'classic': {
    id: 'classic',
    name: 'Classic',
    description: 'Clean, professional dark theme',
    colors: {
      bodyBg: 'rgb(17, 24, 39)',
      headerBg: '#2a2a2a',
      footerBg: '#2a2a2a',
      cardBg: '#2d2d2d',
      cardHoverBg: '#3a3a3a',
      
      textPrimary: '#cccccc',
      textSecondary: '#888888',
      
      borderColor: '#454545',
      
      accentPrimary: 'rgb(147, 51, 234)',
      accentSecondary: '#7a6daa',
      accentSubagent: '#6366f1',
      accentNestedSubagent: '#f59e0b',
      
      statusSuccess: '#10b981',
      statusWarning: '#f59e0b',
      statusError: '#ef4444',
      statusInfo: 'rgb(147, 51, 234)',
      
      gradientText: 'linear(to-r, rgb(147, 51, 234), #7a6daa)',
      gradientButton: 'linear-gradient(135deg, rgb(147, 51, 234) 0%, #7a6daa 100%)',
      
      nodeBg: '#2d2d2d',
      nodeBoxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
      edgeGradient: 'rgb(147, 51, 234)',
      
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontPrimary: "'Lexend', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSecondary: "'Orbitron', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontBase: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    },
  },
};

/**
 * A named curated palette. `colors` is exactly the user-overridable token subset
 * (the same shape as `ThemeOverrides`), so a preset is precisely the layer between
 * the base theme and per-token overrides. Token-only: the values here flow to CSS
 * custom properties in ThemeProvider, never directly into a component.
 */
export interface ThemePreset {
  /** Stable machine id, e.g. 'light-default'. */
  id: string;
  /** Human display name, e.g. 'Light Default'. */
  name: string;
  /** The token subset the preset sets; a partial ThemeOverrides so per-token overrides still win. */
  colors: Partial<ThemeOverrides>;
}

// ── Shared font stacks (token DATA only — applied via ThemeProvider CSS vars) ──
const SANS_STACK: Pick<ThemeOverrides, 'fontPrimary' | 'fontSecondary' | 'fontBase'> = {
  fontPrimary: "'Lexend', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontSecondary: "'Orbitron', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontBase: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const MONO_STACK: Pick<ThemeOverrides, 'fontPrimary' | 'fontSecondary' | 'fontBase'> = {
  fontPrimary: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace",
  fontSecondary: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace",
  fontBase: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace",
};

/**
 * The 18 curated built-in theme presets — array order is the selector's display order.
 * Values are the single source of truth (token data) sourced from the reference boards
 * (`.opencode/wireframes/themes-1.png`, `themes-2.png`, `brand-guidelines.png` — brand
 * primary cyan #00D1D1) and, for named canonical palettes, their established hex values.
 */
export const themePresets: ThemePreset[] = [
  {
    id: 'light-default',
    name: 'Light Default',
    colors: {
      accentPrimary: '#00d1d1',
      accentSecondary: '#00a8a8',
      borderColor: '#d5dadd',
      bodyBg: '#ffffff',
      cardBg: '#f7f8fa',
      headerBg: '#eeeeee',
      textPrimary: '#0c1117',
      textSecondary: '#5f6b7a',
      statusSuccess: '#10b981',
      statusWarning: '#f59e0b',
      statusError: '#ef4444',
      statusInfo: '#3b82f6',
      ...SANS_STACK,
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    colors: {
      accentPrimary: '#00d1d1',
      accentSecondary: '#00a8a8',
      borderColor: '#2b3440',
      bodyBg: '#0c1117',
      cardBg: '#151a21',
      headerBg: '#0c1117',
      textPrimary: '#e5e7eb',
      textSecondary: '#9ca3af',
      statusSuccess: '#10b981',
      statusWarning: '#f59e0b',
      statusError: '#ef4444',
      statusInfo: '#3b82f6',
      ...SANS_STACK,
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    colors: {
      accentPrimary: '#7aa2f7',
      accentSecondary: '#bb9af7',
      borderColor: '#3b4261',
      bodyBg: '#1a1b26',
      cardBg: '#24283b',
      headerBg: '#1a1b26',
      textPrimary: '#c0caf5',
      textSecondary: '#565f89',
      statusSuccess: '#9ece6a',
      statusWarning: '#e0af68',
      statusError: '#f7768e',
      statusInfo: '#7aa2f7',
      ...SANS_STACK,
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    colors: {
      accentPrimary: '#2aa198',
      accentSecondary: '#268bd2',
      borderColor: '#d9d2bc',
      bodyBg: '#fdf6e3',
      cardBg: '#eee8d5',
      headerBg: '#f5efdc',
      textPrimary: '#586e75',
      textSecondary: '#93a1a1',
      statusSuccess: '#859900',
      statusWarning: '#b58900',
      statusError: '#dc322f',
      statusInfo: '#268bd2',
      ...SANS_STACK,
    },
  },
  {
    id: 'monochrome',
    name: 'Monochrome',
    colors: {
      accentPrimary: '#ffffff',
      accentSecondary: '#9e9e9e',
      borderColor: '#2e2e2e',
      bodyBg: '#000000',
      cardBg: '#0a0a0a',
      headerBg: '#000000',
      textPrimary: '#ffffff',
      textSecondary: '#9e9e9e',
      statusSuccess: '#b0b0b0',
      statusWarning: '#8f8f8f',
      statusError: '#ffffff',
      statusInfo: '#5f5f5f',
      ...SANS_STACK,
    },
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    colors: {
      accentPrimary: '#ff2bc2',
      accentSecondary: '#05d5fa',
      borderColor: '#3a1e5e',
      bodyBg: '#0d0221',
      cardBg: '#180b33',
      headerBg: '#0d0221',
      textPrimary: '#f5e6ff',
      textSecondary: '#a78cbf',
      statusSuccess: '#00ffa3',
      statusWarning: '#ffd60a',
      statusError: '#ff3b5c',
      statusInfo: '#05d5fa',
      ...SANS_STACK,
    },
  },
  {
    id: 'arctic',
    name: 'Arctic',
    colors: {
      accentPrimary: '#2ba8c9',
      accentSecondary: '#4f8fd0',
      borderColor: '#c3d8e8',
      bodyBg: '#eef4f8',
      cardBg: '#f8fbfd',
      headerBg: '#e2eef5',
      textPrimary: '#1e3a4c',
      textSecondary: '#5d7789',
      statusSuccess: '#3fbf7f',
      statusWarning: '#e5a83b',
      statusError: '#e86a5e',
      statusInfo: '#3b82f6',
      ...SANS_STACK,
    },
  },
  {
    id: 'deep-space',
    name: 'Deep Space',
    colors: {
      accentPrimary: '#5b8def',
      accentSecondary: '#8b5cf6',
      borderColor: '#1e2c4a',
      bodyBg: '#0a0e1a',
      cardBg: '#10182b',
      headerBg: '#0a0e1a',
      textPrimary: '#dce6f5',
      textSecondary: '#7a8bb0',
      statusSuccess: '#34d399',
      statusWarning: '#fbbf24',
      statusError: '#f87171',
      statusInfo: '#60a5fa',
      ...SANS_STACK,
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    colors: {
      accentPrimary: '#bd93f9',
      accentSecondary: '#ff79c6',
      borderColor: '#44475a',
      bodyBg: '#282a36',
      cardBg: '#21222c',
      headerBg: '#282a36',
      textPrimary: '#f8f8f2',
      textSecondary: '#6272a4',
      statusSuccess: '#50fa7b',
      statusWarning: '#f1fa8c',
      statusError: '#ff5555',
      statusInfo: '#8be9fd',
      ...SANS_STACK,
    },
  },
  {
    id: 'matrix',
    name: 'Matrix',
    colors: {
      accentPrimary: '#00ff41',
      accentSecondary: '#22cc5e',
      borderColor: '#123a12',
      bodyBg: '#000000',
      cardBg: '#0a0a0a',
      headerBg: '#000000',
      textPrimary: '#c8ffc8',
      textSecondary: '#4f9f4f',
      statusSuccess: '#00ff41',
      statusWarning: '#ffb000',
      statusError: '#ff0033',
      statusInfo: '#33ccff',
      ...MONO_STACK,
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    colors: {
      accentPrimary: '#ff6b4a',
      accentSecondary: '#ff8fa3',
      borderColor: '#ecc9b8',
      bodyBg: '#fdf0e9',
      cardBg: '#fff7f2',
      headerBg: '#fbe0d2',
      textPrimary: '#4a2c26',
      textSecondary: '#8a6a5f',
      statusSuccess: '#4caf7d',
      statusWarning: '#e0a83b',
      statusError: '#e0554f',
      statusInfo: '#5a9fd6',
      ...SANS_STACK,
    },
  },
  {
    id: 'coffee',
    name: 'Coffee',
    colors: {
      accentPrimary: '#c69c6d',
      accentSecondary: '#a67c52',
      borderColor: '#4a3425',
      bodyBg: '#1f140e',
      cardBg: '#2e1d15',
      headerBg: '#1f140e',
      textPrimary: '#f2e7db',
      textSecondary: '#a98f78',
      statusSuccess: '#8fa86b',
      statusWarning: '#d9a845',
      statusError: '#e07b5f',
      statusInfo: '#7d9bc1',
      ...SANS_STACK,
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    colors: {
      accentPrimary: '#88c0d0',
      accentSecondary: '#81a1c1',
      borderColor: '#4c566a',
      bodyBg: '#2e3440',
      cardBg: '#3b4252',
      headerBg: '#2e3440',
      textPrimary: '#d8dee9',
      textSecondary: '#7b88a1',
      statusSuccess: '#a3be8c',
      statusWarning: '#ebcb8b',
      statusError: '#bf616a',
      statusInfo: '#81a1c1',
      ...SANS_STACK,
    },
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    colors: {
      accentPrimary: '#ff6ac1',
      accentSecondary: '#00fff9',
      borderColor: '#442a72',
      bodyBg: '#1a0b2e',
      cardBg: '#2b1245',
      headerBg: '#1a0b2e',
      textPrimary: '#e8d5ff',
      textSecondary: '#9b7bc4',
      statusSuccess: '#00e0a3',
      statusWarning: '#ffd166',
      statusError: '#ff4d6d',
      statusInfo: '#00cfff',
      ...SANS_STACK,
    },
  },
  {
    id: 'terminal-green',
    name: 'Terminal Green',
    colors: {
      accentPrimary: '#3fbf7f',
      accentSecondary: '#7fbf9f',
      borderColor: '#1f3c1f',
      bodyBg: '#0a0a0a',
      cardBg: '#141414',
      headerBg: '#0a0a0a',
      textPrimary: '#c8e6c9',
      textSecondary: '#5a8a5a',
      statusSuccess: '#4caf50',
      statusWarning: '#e0c040',
      statusError: '#e55c5c',
      statusInfo: '#6fbfbf',
      ...MONO_STACK,
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    colors: {
      accentPrimary: '#b08968',
      accentSecondary: '#9c6b4a',
      borderColor: '#d8cdb8',
      bodyBg: '#f5f1e8',
      cardBg: '#fbf8f1',
      headerBg: '#ece5d8',
      textPrimary: '#3a3226',
      textSecondary: '#8c7f6b',
      statusSuccess: '#6a9955',
      statusWarning: '#c9a227',
      statusError: '#c05f4a',
      statusInfo: '#5a7d9a',
      ...SANS_STACK,
    },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    colors: {
      accentPrimary: '#ffff00',
      accentSecondary: '#ffffff',
      borderColor: '#ffffff',
      bodyBg: '#000000',
      cardBg: '#000000',
      headerBg: '#000000',
      textPrimary: '#ffffff',
      textSecondary: '#e0e0e0',
      statusSuccess: '#00ff00',
      statusWarning: '#ffff00',
      statusError: '#ff0000',
      statusInfo: '#00ffff',
      ...SANS_STACK,
    },
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    colors: {
      accentPrimary: '#ffffff',
      accentSecondary: '#ffd166',
      borderColor: '#1e5a99',
      bodyBg: '#0b2d5c',
      cardBg: '#0e3a6b',
      headerBg: '#0b2d5c',
      textPrimary: '#e6f0ff',
      textSecondary: '#9fb8dc',
      statusSuccess: '#2ecc71',
      statusWarning: '#f4d03f',
      statusError: '#e74c3c',
      statusInfo: '#5dade2',
      ...SANS_STACK,
    },
  },
];
