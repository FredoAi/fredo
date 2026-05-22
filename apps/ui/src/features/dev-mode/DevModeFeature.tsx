import React from 'react';
import type { ReactElement } from 'react';
import { LuBug } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes/FredoFeatureClass';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { DevMode } from './components/DevMode';

export class DevModeFeature extends FredoFeatureClass {
  readonly id = 'dev-mode';
  readonly name = 'Dev Mode';
  readonly icon = LuBug;
  readonly eventFilters = [];
  readonly showable = false;
  readonly isMultiWindow = false;
  readonly hasSettings = false;

  processEvent(_event: FredoEvent): void {}

  render(): ReactElement {
    return React.createElement(DevMode, null);
  }
}

export const devModeFeature = new DevModeFeature();
