import React from 'react';
import { FredoApplicationClass } from '../../shared/classes';
import { SetupWizard } from './components/SetupWizard';
import { LuSettings2 } from 'react-icons/lu';
import type { IconType } from 'react-icons';

export class SetupFeature extends FredoApplicationClass {
  readonly id = 'setup';
  readonly name = 'Fredo Setup';
  readonly icon: IconType = LuSettings2;
  readonly showable = true;
  readonly hasSettings = false;

  render() {
    return <SetupWizard onClose={() => this.onCloseRequested?.()} />;
  }
}
