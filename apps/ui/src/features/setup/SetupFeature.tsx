import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { SetupWizard } from './components/SetupWizard';
import { LuSettings2 } from 'react-icons/lu';
import type { IconType } from 'react-icons';

export class SetupFeature extends FredoFeatureClass {
  readonly id = 'setup';
  readonly name = 'Fredo Setup';
  readonly icon: IconType = LuSettings2;
  readonly showable = false;
  readonly hasSettings = false;

  render() {
    return <SetupWizard onClose={() => this.onCloseRequested?.()} />;
  }
}
