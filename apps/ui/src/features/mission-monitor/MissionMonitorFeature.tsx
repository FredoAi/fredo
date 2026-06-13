import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { EventFilter } from "../../shared/classes";
import type { FredoEvent } from "../../shared/contexts/StreamContext";
import { persistEvent } from "./lib/sessionStorage";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

function resolveEventName(event: FredoEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return (typeof payload.event_type === "string" ? payload.event_type : undefined) ?? event.toolName ?? "";
}

export function isTargetEvent(event: FredoEvent): boolean {
  const name = resolveEventName(event);
  return name === "UserPromptSubmit" || name === "UserPromptSubmitted";
}

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  readonly eventFilters: EventFilter[] = [{ custom: isTargetEvent }];

  processEvent(event: FredoEvent): void {
    persistEvent(event);
    this.forceRerender?.();
  }

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
