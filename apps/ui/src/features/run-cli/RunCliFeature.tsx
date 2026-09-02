import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
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

  /**
   * Toolbar desktop-item entry: the maomaolabs Toolbar opens this in a brief
   * in-desktop window on item click. RunCliLauncher fires `open_run_cli` (the
   * backend opens the `run-cli-terminal` Tauri window directly — window-first,
   * one-window guarantee) and closes the in-desktop window on success, so the
   * user only ever sees the single terminal window — no intermediate panel.
   */
  render() {
    return <RunCliLauncher />;
  }

  renderSettings() {
    return <RunCliSettings />;
  }
}
