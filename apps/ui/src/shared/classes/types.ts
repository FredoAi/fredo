/**
 * Supporting types for FredoApplicationClass
 */

import type { FredoApplicationClass } from './FredoApplicationClass';

/**
 * Grid item configuration
 * Defines how a feature appears in the grid
 */
export interface GridItemConfig {
  closable: boolean;
  maximizable: boolean;
}

/**
 * Grid item instance
 * Associates a feature with a unique ID for grid management
 */
export interface GridItem {
  id: string;
  feature: FredoApplicationClass;
}
