import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoApplicationClass } from "../../shared/classes";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

export class MissionMonitorFeature extends FredoApplicationClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly description =
    "Watch live AI agent activity as a graph of sessions, subagents and tool calls.";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;

  /**
   * #3151 ST-6: Mission Monitor is pointer-only. The deleted navigation engine's
   * session-search key and its declared surface went with it; the session list,
   * selection and detail panel are reached through the drawer + canvas by pointer.
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
