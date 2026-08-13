import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
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

  /**
   * Null placeholder — Run CLI launches directly into its own Tauri window
   * (`run-cli-terminal`) via the `open_run_cli` IPC command (see DesktopToolbar).
   * The feature is never rendered in an in-desktop window.
   */
  render() {
    return <></>;
  }

  renderSettings() {
    return <RunCliSettings />;
  }
}
