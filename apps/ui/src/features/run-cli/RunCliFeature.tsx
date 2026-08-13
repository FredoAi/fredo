import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { RunCliSettings } from './components/RunCliSettings';
import { RunCliLauncher } from './components/RunCliLauncher';
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

  /**
   * Toolbar desktop-item entry: the maomaolabs Toolbar opens this in a brief
   * in-desktop window on click; RunCliLauncher fires `open_run_cli` (backend opens
   * the `run-cli-terminal` Tauri window directly) and immediately closes the
   * in-desktop window — the user only ever sees the terminal window.
   */
  render() {
    return <RunCliLauncher />;
  }

  renderSettings() {
    return <RunCliSettings />;
  }
}
