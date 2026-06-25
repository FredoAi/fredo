import React from 'react';
import { FredoFeatureClass, type EventContractDeclaration } from '../../shared/classes';
import { LuFlag } from 'react-icons/lu';
import { OptimizelyFlagsPanel } from './components/OptimizelyFlagsPanel';

export class OptimizelyFeature extends FredoFeatureClass {
  readonly id = 'optimizely';
  readonly name = 'Feature Flags';
  readonly icon = LuFlag;
  readonly showable = true;

  readonly eventContracts: EventContractDeclaration[] = [
    {
      name: 'optimizely',
      key: 'correlationId',
      fields: [
        { name: 'toolName', path: 'toolName', hint: 'stream' },
      ],
      filter: { toolNames: ['optimizely_get_flags', 'optimizely_update_flag'] },
    },
  ];

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
