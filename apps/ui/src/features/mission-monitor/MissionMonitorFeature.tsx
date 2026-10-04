import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { FeatureHotkeyAction } from "../../shared/hotkeys/types";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";
import {
  dispatchMissionMonitorAction,
  MISSION_MONITOR_DETAIL_CONTEXT_ID,
  MISSION_MONITOR_FOCUS_SESSION_SEARCH,
  MISSION_MONITOR_GRAPH_CONTEXT_ID,
  MISSION_MONITOR_NEXT_NODE,
  MISSION_MONITOR_NEXT_SECTION,
  MISSION_MONITOR_NEXT_SESSION,
  MISSION_MONITOR_OPEN_DETAIL,
  MISSION_MONITOR_OPEN_GRAPH,
  MISSION_MONITOR_PREVIOUS_NODE,
  MISSION_MONITOR_PREVIOUS_SECTION,
  MISSION_MONITOR_PREVIOUS_SESSION,
  MISSION_MONITOR_TOGGLE_SECTION,
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
    // ── L1 — base context `mission-monitor` (contextId omitted) ──────────────
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
    {
      actionId: MISSION_MONITOR_OPEN_GRAPH,
      title: "Open graph",
      description: "Descend into the graph level",
      defaultSequence: "o",
      opensContextId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_OPEN_GRAPH),
    },
    // ── L2 — graph context `mission-monitor.graph` ───────────────────────────
    {
      actionId: MISSION_MONITOR_NEXT_NODE,
      title: "Next node",
      description: "Move the graph cursor to the next node",
      defaultSequence: "n",
      contextId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_NEXT_NODE),
    },
    {
      actionId: MISSION_MONITOR_PREVIOUS_NODE,
      title: "Previous node",
      description: "Move the graph cursor to the previous node",
      defaultSequence: "p",
      contextId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_PREVIOUS_NODE),
    },
    {
      actionId: MISSION_MONITOR_OPEN_DETAIL,
      title: "Open node detail",
      description: "Descend into the node-detail level",
      defaultSequence: "o",
      contextId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
      opensContextId: MISSION_MONITOR_DETAIL_CONTEXT_ID,
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_OPEN_DETAIL),
    },
    // ── L3 — node-detail context `mission-monitor.detail` ────────────────────
    {
      actionId: MISSION_MONITOR_NEXT_SECTION,
      title: "Next section",
      description: "Move the active detail section to the next one",
      defaultSequence: "n",
      contextId: MISSION_MONITOR_DETAIL_CONTEXT_ID,
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_NEXT_SECTION),
    },
    {
      actionId: MISSION_MONITOR_PREVIOUS_SECTION,
      title: "Previous section",
      description: "Move the active detail section to the previous one",
      defaultSequence: "p",
      contextId: MISSION_MONITOR_DETAIL_CONTEXT_ID,
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_PREVIOUS_SECTION),
    },
    {
      actionId: MISSION_MONITOR_TOGGLE_SECTION,
      title: "Toggle section",
      description: "Toggle the active detail section",
      defaultSequence: "o",
      contextId: MISSION_MONITOR_DETAIL_CONTEXT_ID,
      run: () => dispatchMissionMonitorAction(MISSION_MONITOR_TOGGLE_SECTION),
    },
  ];

  /**
   * Spec #2962 ST-2: the declared nested interaction contexts for the
   * Mission Monitor flow. The L1 base context (`mission-monitor`) is
   * synthesized by the registry; only the two descents are declared here. The
   * graph level parents the base, and the node-detail level parents the graph,
   * so each descent is a direct-child push (`contextStack.ts`).
   */
  override readonly hotkeysContexts = [
    {
      contextId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
      parentId: "mission-monitor",
      title: "Graph",
    },
    {
      contextId: MISSION_MONITOR_DETAIL_CONTEXT_ID,
      parentId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
      title: "Node detail",
    },
  ] as const;

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
