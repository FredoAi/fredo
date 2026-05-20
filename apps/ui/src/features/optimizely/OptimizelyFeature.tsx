import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { LuFlag } from 'react-icons/lu';
import { OptimizelyFlagsPanel } from './components/OptimizelyFlagsPanel';

export class OptimizelyFeature extends FredoFeatureClass {
  readonly id = 'optimizely';
  readonly name = 'Feature Flags';
  readonly icon = LuFlag;
  readonly showable = true;

  readonly eventFilters: EventFilter[] = [
    { toolNames: ['optimizely_get_flags', 'optimizely_update_flag'] },
  ];

  readonly gridConfig = { closable: true, maximizable: true };

  processEvent(_event: StreamEvent): void {
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
