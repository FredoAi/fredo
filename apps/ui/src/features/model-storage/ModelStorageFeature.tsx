import React from 'react';
import type { ReactElement } from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { ModelStorageSettings } from './components/ModelStorageSettings';
import { LuFolder } from 'react-icons/lu';
import type { IconType } from 'react-icons';

export class ModelStorageFeature extends FredoFeatureClass {
  readonly id = 'model-storage';
  readonly name = 'Model Storage';
  readonly icon: IconType = LuFolder;
  readonly isMultiWindow = false;
  readonly showable = false;
  readonly hasSettings = true;
  readonly eventFilters: EventFilter[] = [];

  processEvent(_event: FredoEvent): void {}

  render(): ReactElement {
    return React.createElement(React.Fragment, null);
  }

  renderSettings(): ReactElement {
    return React.createElement(ModelStorageSettings, null);
  }
}
