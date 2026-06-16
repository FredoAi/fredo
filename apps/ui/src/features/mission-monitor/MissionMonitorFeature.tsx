import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { EventFilter } from "../../shared/classes";
import type { FredoEvent } from "../../shared/contexts/StreamContext";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

function resolveEventName(event: FredoEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return (typeof payload.event_type === "string" ? payload.event_type : undefined) ?? event.toolName ?? "";
}

export function isTargetEvent(event: FredoEvent): boolean {
  const name = resolveEventName(event);
  return name === "UserPromptSubmit" || name === "UserPromptSubmitted";
}

/**
 * Capture filter — accepts ALL events with a sessionId.
 * Used by the capture hook for persistence (much broader than isTargetEvent).
 * The feature's eventFilters remain isTargetEvent for window activation only.
 */
export function captureFilter(event: FredoEvent): boolean {
  return !!event.sessionId;
}

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  readonly eventFilters: EventFilter[] = [{ custom: isTargetEvent }];

  processEvent(event: FredoEvent): void {
    // Persistence is handled by the capture hook (useMissionMonitorCapture).
    // processEvent only triggers re-render for live mode updates.
    this.forceRerender?.();
  }

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
