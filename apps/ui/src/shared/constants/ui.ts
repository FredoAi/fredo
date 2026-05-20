/**
 * UI-related constants
 */

/**
 * Z-Index Layers
 */
export const Z_INDEX = {
  BACKGROUND: -1,
  NORMAL: 0,
  ELEVATED: 10,
  MODAL: 100,
  TOAST: 1000,
  TOOLTIP: 2000,
} as const;

/**
 * Grid Layout Settings
 */
export const GRID_LAYOUT = {
  COLUMNS: { base: 1, md: 2, lg: 3 },
  GAP: 4,
} as const;

/**
 * Card Sizes
 */
export const CARD_SIZES = {
  SMALL: 'sm',
  MEDIUM: 'md',
  LARGE: 'lg',
} as const;

/**
 * Border Radius
 */
export const BORDER_RADIUS = {
  SMALL: 'md',
  MEDIUM: 'lg',
  LARGE: 'xl',
} as const;

/**
 * Padding/Spacing
 */
export const SPACING = {
  SMALL: 2,
  MEDIUM: 4,
  LARGE: 6,
} as const;

/**
 * Background Animation Types
 */
export const BACKGROUND_ANIMATIONS = {
  HYPERSPEED: 'hyperspeed',
  MAGNET_LINES: 'magnetLines',
  CUBES: 'cubes',
  NONE: 'none',
} as const;
