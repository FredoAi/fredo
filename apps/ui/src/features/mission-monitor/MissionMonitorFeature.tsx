import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;

  /**
   * Spec #2788 P4.2: the three persistent v1 ECE contracts (chat-node,
   * tool-use-lifecycle, subagent-tool-activity) are REMOVED — the feature's
   * graph derivation now runs entirely on typed RTDB rows via
   * `useEventRows('Chat' | 'ToolUse', { replay: true })`
   * (MissionMonitorPanel → useDeliveryGraph → lib/rowDerivation.ts). The
   * declarations are inherited empty from FredoFeatureClass, so the feature
   * contributes nothing to the ECE registration and no v1 deliveries are
   * double-delivered into the row-driven graph.
   *
   * `handleDelivery` is likewise no longer overridden — with no contracts
   * registered, no v1 deliveries route to this feature class (the base-class
   * no-op applies). See the P4.2 report for the row-wiring diagram.
   */

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
