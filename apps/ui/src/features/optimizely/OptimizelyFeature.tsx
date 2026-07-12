import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { LuFlag } from 'react-icons/lu';
import { OptimizelyFlagsPanel } from './components/OptimizelyFlagsPanel';

export class OptimizelyFeature extends FredoFeatureClass {
  readonly id = 'optimizely';
  readonly name = 'Feature Flags';
  readonly icon = LuFlag;
  readonly showable = false;

  // @deprecated — kept for base class compatibility; all event processing via eventContracts
  readonly eventFilters: EventFilter[] = [];

  readonly gridConfig = { closable: true, maximizable: true };

  // @deprecated — kept for base class compatibility
  processEvent(_event: FredoEvent): void {
    // All event processing moved to handleDelivery
  }

  handleDelivery(_delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    // Refresh is handled inside the component via useOptimizelyFlags
  }

  render() {
    return <OptimizelyFlagsPanel />;
  }

  onMount() {
    console.log('[OptimizelyFeature] Mounted');
  }

  onUnmount() {
    console.log('[OptimizelyFeature] Unmounted');
  }
}

export const optimizelyFeature = new OptimizelyFeature();
