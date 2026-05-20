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
