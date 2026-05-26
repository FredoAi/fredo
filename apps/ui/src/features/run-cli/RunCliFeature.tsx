import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
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
  readonly eventFilters: EventFilter[] = [];

  processEvent(_event: FredoEvent): void {}

  render() {
    return <RunCliPanel />;
  }

  renderSettings() {
    return <RunCliSettings />;
  }
}
