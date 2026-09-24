import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { TerminalSettings } from './components/TerminalSettings';
import { TerminalLauncher } from './components/TerminalLauncher';
import { LuTerminal } from 'react-icons/lu';
import type { IconType } from 'react-icons';

export class TerminalFeature extends FredoFeatureClass {
  readonly id = 'terminal';
  readonly name = 'Terminal';
  readonly icon: IconType = LuTerminal;
  readonly isMultiWindow = false;
  readonly showable = true;
  readonly hasSettings = true;

  /**
   * Toolbar desktop-item entry: the maomaolabs Toolbar opens this in a brief
   * in-desktop window on item click. TerminalLauncher fires
   * `open_terminal_window` (the backend opens the `terminal` Tauri window
   * directly — window-first, one-window guarantee) and closes the in-desktop
   * window on success, so the user only ever sees the single terminal window —
   * no intermediate panel.
   */
  render() {
    return <TerminalLauncher />;
  }

  renderSettings() {
    return <TerminalSettings />;
  }
}
