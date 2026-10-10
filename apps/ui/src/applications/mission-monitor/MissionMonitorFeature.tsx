import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoApplicationClass } from "../../shared/classes";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

export class MissionMonitorFeature extends FredoApplicationClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;

  /**
   * Spec #3009 ST-5: the feature's keys are declared by the mounted controls
   * themselves via `data-hotkey` (session search = `s`). The platform discovers
   * them through the ONE element registry — the feature supplies no declaration
   * code and no per-feature bridge.
   */

  /**
   * Spec #2788 P4.2/P5.1: fully on typed RTDB rows — the feature derives its
   * graph via the session-scoped activity watch. The v1 ECE contract machinery
   * was deleted in P5.1; the feature class carries no v1 surface.
   */

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
