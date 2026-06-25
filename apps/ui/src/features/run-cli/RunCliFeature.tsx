import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { RunCliPanel } from './components/RunCliPanel';
import { RunCliSettings } from './components/RunCliSettings';
import { LuTerminal } from 'react-icons/lu';
import type { IconType } from 'react-icons';

export class RunCliFeature extends FredoFeatureClass {
  readonly id = 'run-cli';
  readonly name = 'Run CLI';
  readonly icon: IconType = LuTerminal;
  readonly isMultiWindow = false;
  readonly showable = true;
  readonly hasSettings = true;

  render() {
    return <RunCliPanel />;
  }

  renderSettings() {
    return <RunCliSettings />;
  }
}
