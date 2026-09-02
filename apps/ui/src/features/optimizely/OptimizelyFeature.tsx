import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { LuFlag } from 'react-icons/lu';
import { OptimizelyFlagsPanel } from './components/OptimizelyFlagsPanel';

export class OptimizelyFeature extends FredoFeatureClass {
  readonly id = 'optimizely';
  readonly name = 'Feature Flags';
  readonly icon = LuFlag;
  readonly showable = false;

  readonly gridConfig = { closable: true, maximizable: true };

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
