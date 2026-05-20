/**
 * Supporting types for FredoFeatureClass
 */

import type { StreamEvent } from '../contexts/StreamContext';
import type { FredoFeatureClass } from './FredoFeatureClass';

/**
 * Event filter configuration
 * Determines which events a feature should process
 */
export interface EventFilter {
  toolNames?: string[];
  states?: StreamEvent['state'][];
  custom?: (event: StreamEvent) => boolean;
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
