/**
 * Supporting types for FredoFeatureClass
 *
 * ── Backward Compat ────────────────────────────────────────────────────────
 * EventFilter is kept exported for non-migrating features (setup, run-cli,
 * query-viewer, model-storage) that still declare eventFilters. This will
 * be removed once all features migrate to the ECE.
 *
 * ── ECE Types ─────────────────────────────────────────────────────────────
 * EventContractDeclaration and ContractDelivery are re-exported from
 * EventSubscription.ts for convenience.
 */

import type { FredoFeatureClass } from './FredoFeatureClass';

/**
 * Event filter configuration
 * Determines which events a feature should process
 *
 * @deprecated Use EventContractDeclaration + handleDelivery on
 * FredoFeatureClass instead. eventFilters is removed from
 * migrating features. Kept for non-migrating features.
 */
export interface EventFilter {
  toolNames?: string[];
  /** @deprecated Use lifecycle on ContractDelivery instead */
  states?: string[];
  /** @deprecated Use custom matching in handleDelivery instead */
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

// Re-export ECE types for convenience
export type { EventContractDeclaration, ContractDelivery } from './EventSubscription';
