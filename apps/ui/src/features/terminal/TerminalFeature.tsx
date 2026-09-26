import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { TerminalSettings } from './components/TerminalSettings';
import { TerminalEntry } from './components/TerminalEntry';
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
   * Mode-aware entry (Spec #2947 ST-3): `TerminalEntry` resolves the persisted
   * presentation mode and renders the in-window workspace (`TerminalWindow`) for
   * `same-window`, or the shipped `TerminalLauncher` (which fires
   * `open_terminal_window` and closes this in-window entry) for `new-window`.
   * Every in-window entry point — the launcher tile, the dock/toolbar desktop
   * item, `open-app`/`openSelf` — flows through the ONE shipped
   * `openFeatureWindow`, so the mode is honoured everywhere with no second
   * spawner and no event-target change.
   */
  render() {
    return <TerminalEntry />;
  }

  renderSettings() {
    return <TerminalSettings />;
  }
}
