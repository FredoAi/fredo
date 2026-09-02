import React from 'react';
import type { ReactElement } from 'react';
import { FredoFeatureClass } from '../../shared/classes';
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

  render(): ReactElement {
    return React.createElement(React.Fragment, null);
  }

  renderSettings(): ReactElement {
    return React.createElement(ModelStorageSettings, null);
  }
}
