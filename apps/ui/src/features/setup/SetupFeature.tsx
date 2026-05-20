import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { SetupWizard } from './components/SetupWizard';
import { LuSettings2 } from 'react-icons/lu';
import type { IconType } from 'react-icons';

export class SetupFeature extends FredoFeatureClass {
  readonly id = 'setup';
  readonly name = 'Fredo Setup';
  readonly icon: IconType = LuSettings2;
  readonly showable = false;
  readonly hasSettings = false;
  readonly eventFilters: EventFilter[] = [];

  processEvent(_event: StreamEvent): void {}

  render() {
    return <SetupWizard onClose={() => this.onCloseRequested?.()} />;
  }
}
