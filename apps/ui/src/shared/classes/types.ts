/**
 * Supporting types for FredoFeatureClass
 */

import type { FredoEvent } from '../contexts/StreamContext';
import type { FredoFeatureClass } from './FredoFeatureClass';

/**
 * Event filter configuration
 * Determines which events a feature should process
 */
export interface EventFilter {
  /** Filter by FredoEvent.eventType (primary discriminator - REQ-3.3) */
  eventTypes?: FredoEvent['eventType'][];
  /** Filter by tool name (backward compat - REQ-3.8) */
  toolNames?: string[];
  /** Filter by state */
  states?: FredoEvent['state'][];
  /** Custom filter function */
  custom?: (event: FredoEvent) => boolean;
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
