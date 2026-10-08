import React from 'react';
import type { ReactElement } from 'react';
import { LuBug } from 'react-icons/lu';
import { FredoApplicationClass } from '../../shared/classes/FredoApplicationClass';
import type { ApplicationHotkeyAction } from '../../shared/hotkeys/types';
import { DevMode } from './components/DevMode';
import {
  DEV_MODE_CLEAR_EVENTS_ACTION_ID,
  DEV_MODE_FOCUS_FILTER_ACTION_ID,
  DEV_MODE_SHOW_ALL_STATES_ACTION_ID,
  DEV_MODE_TOGGLE_VIEW_ACTION_ID,
  dispatchDevModeAction,
  isDevModeActionAvailable,
} from './lib/hotkeyBridge';

export class DevModeFeature extends FredoApplicationClass {
  readonly id = 'dev-mode';
  readonly name = 'Dev Mode';
  readonly icon = LuBug;
  readonly showable = false;
  readonly isMultiWindow = false;
  readonly hasSettings = false;

  /**
   * Spec #2961 ST-3 (AC1/AC2/AC5): the Dev Mode base-context actions, declared
   * through the platform contract. Each `run` dispatches a namespaced event the
   * mounted panel maps onto its existing filter/clear/state/view operations, so
   * `run` is a safe no-op while the feature is closed (the engine only
   * dispatches while this feature is the focused window anyway).
   *
   * The two gated actions read the panel's MODULE-SCOPED availability (published
   * by the mounted `DevMode`), with the static `unavailableReason` copy shown by
   * the key bar when the gate is closed.
   */
  readonly hotkeys: readonly ApplicationHotkeyAction[] = [
    {
      actionId: DEV_MODE_FOCUS_FILTER_ACTION_ID,
      title: 'Focus event filter',
      description: 'Focus the event filter input',
      defaultSequence: 's',
      run: () => dispatchDevModeAction(DEV_MODE_FOCUS_FILTER_ACTION_ID),
    },
    {
      actionId: DEV_MODE_CLEAR_EVENTS_ACTION_ID,
      title: 'Clear captured events',
      description: 'Clear the captured event stream',
      defaultSequence: 'c',
      run: () => dispatchDevModeAction(DEV_MODE_CLEAR_EVENTS_ACTION_ID),
      enabled: () => isDevModeActionAvailable(DEV_MODE_CLEAR_EVENTS_ACTION_ID),
      unavailableReason: 'No events to clear',
    },
    {
      actionId: DEV_MODE_SHOW_ALL_STATES_ACTION_ID,
      title: 'Show all event states',
      description: 'Re-enable every event-state filter',
      defaultSequence: 'a',
      run: () => dispatchDevModeAction(DEV_MODE_SHOW_ALL_STATES_ACTION_ID),
      enabled: () => isDevModeActionAvailable(DEV_MODE_SHOW_ALL_STATES_ACTION_ID),
      unavailableReason: 'All states are already shown',
    },
    {
      actionId: DEV_MODE_TOGGLE_VIEW_ACTION_ID,
      title: 'Switch rows / feature data',
      description: 'Switch between the rows view and the application-data view',
      defaultSequence: 'v',
      run: () => dispatchDevModeAction(DEV_MODE_TOGGLE_VIEW_ACTION_ID),
    },
  ];

  render(): ReactElement {
    return React.createElement(DevMode, null);
  }
}

export const devModeFeature = new DevModeFeature();
