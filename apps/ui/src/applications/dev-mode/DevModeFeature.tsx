import React from 'react';
import type { ReactElement } from 'react';
import { LuBug } from 'react-icons/lu';
import { FredoApplicationClass } from '../../shared/classes/FredoApplicationClass';
import { DevMode } from './components/DevMode';

export class DevModeFeature extends FredoApplicationClass {
  readonly id = 'dev-mode';
  readonly name = 'Dev Mode';
  readonly icon = LuBug;
  readonly showable = false;
  readonly isMultiWindow = false;
  readonly hasSettings = false;

  render(): ReactElement {
    return React.createElement(DevMode, null);
  }
}

export const devModeFeature = new DevModeFeature();
