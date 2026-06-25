import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { LuFlag } from 'react-icons/lu';
import { OptimizelyFlagsPanel } from './components/OptimizelyFlagsPanel';

export class OptimizelyFeature extends FredoFeatureClass {
  readonly id = 'optimizely';
  readonly name = 'Feature Flags';
  readonly icon = LuFlag;
  readonly showable = true;

  readonly eventContracts = [
    {
      contractName: 'optimizely',
      streamFields: ['toolName', 'state'],
      deferredFields: ['payload'],
      key: ['sessionId', 'correlationId', 'toolName'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
    },
  ];

  readonly gridConfig = { closable: true, maximizable: true };

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
