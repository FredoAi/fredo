import React from 'react';
import { FredoApplicationClass } from '../../shared/classes';
import { TerminalSettings } from './components/TerminalSettings';
import { TerminalEntry } from './components/TerminalEntry';
import { LuTerminal } from 'react-icons/lu';
import type { IconType } from 'react-icons';

export class TerminalFeature extends FredoApplicationClass {
  readonly id = 'terminal';
  readonly name = 'Terminal';
  readonly icon: IconType = LuTerminal;
  readonly isMultiWindow = false;
  readonly showable = true;
  readonly hasSettings = true;

  /**
   * In-window Terminal host (Spec #2947 ST-3, reworked by #2955 ST-4): the
   * render-time trampoline (`new-window` → `TerminalLauncher`) is RETIRED.
   * `TerminalEntry` always renders the real workspace (`TerminalWindow`); the
   * per-app presentation choice is owned by the ONE presentation-aware opener
   * (`Home.openApp`), which routes a `new-window` app to its native host before
   * this in-window entry is ever created. Every in-window entry point — the
   * launcher tile, the dock/toolbar desktop item, `open-app`/`openSelf` — flows
   * through that ONE opener, so the mode is honoured everywhere with no second
   * spawner and no event-target change.
   */
  render() {
    return <TerminalEntry />;
  }

  renderSettings() {
    return <TerminalSettings />;
  }
}
