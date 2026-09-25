import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { FeatureHotkeyAction } from "../../shared/hotkeys/types";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";
import {
  dispatchMissionMonitorAction,
  MISSION_MONITOR_FOCUS_SESSION_SEARCH,
  MISSION_MONITOR_NEXT_SESSION,
  MISSION_MONITOR_PREVIOUS_SESSION,
} from "./lib/hotkeyBridge";

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;

  /**
   * Spec #2946 ST-15 (AC2 H-4/H-5/H-6): the feature's LOCAL hotkeys, declared
   * through the platform contract. They are discovered, listed, rebound and
   * persisted by the platform automatically — the feature supplies no listing
   * code. Each `run` dispatches a namespaced event that the mounted panel maps
   * onto its existing session operations, so `run` is a safe no-op while the
   * feature is closed (the engine only dispatches while this feature is the
   * focused window anyway — R-2.5).
   */
  readonly hotkeys: readonly FeatureHotkeyAction[] = [
    {
      actionId: MISSION_MONITOR_FOCUS_SESSION_SEARCH,
      title: "Focus session search",
      description: "Open the session drawer and focus the filter input",
      defaultSequence: "s",
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_FOCUS_SESSION_SEARCH),
    },
    {
      actionId: MISSION_MONITOR_NEXT_SESSION,
      title: "Next session",
      description: "Select the next session in the session list",
      defaultSequence: "n",
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_NEXT_SESSION),
    },
    {
      actionId: MISSION_MONITOR_PREVIOUS_SESSION,
      title: "Previous session",
      description: "Select the previous session in the session list",
      defaultSequence: "p",
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_PREVIOUS_SESSION),
    },
  ];

  /**
   * Spec #2788 P4.2/P5.1: fully on typed RTDB rows — the feature derives its
   * graph via `useEventRows('Chat' | 'ToolUse', { replay: true })`
   * (MissionMonitorPanel → useDeliveryGraph → lib/rowDerivation.ts). The v1
   * ECE contract machinery was deleted in P5.1; the feature class carries no
   * v1 surface at all.
   */

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
