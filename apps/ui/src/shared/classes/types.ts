/**
 * Supporting types for FredoFeatureClass
 */

import type { FredoFeatureClass } from './FredoFeatureClass';

/**
 * @deprecated Event-driven feature routing has been replaced by the
 * Event Contract Engine (ECE). Features now declare eventContracts
 * instead of eventFilters. This type is kept for backward compatibility
 * with feature files not yet migrated.
 */
export interface EventFilter {
  toolNames?: string[];
  states?: Array<'Init' | 'Update' | 'Response' | 'Error'>;
  custom?: (event: any) => boolean;
}

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
  feature: FredoFeatureClass;
}
