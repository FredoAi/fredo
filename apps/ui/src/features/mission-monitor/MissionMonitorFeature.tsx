import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { EventFilter } from "../../shared/classes";
import type { FredoEvent } from "../../shared/contexts/StreamContext";
import { persistEvent } from "./lib/sessionStorage";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

const seenMsgIds = new Set<string>();

/** Reset the internal dedup set. Used in tests to ensure clean state between runs. */
export function resetSeenMsgIds(): void {
  seenMsgIds.clear();
}

export function isTargetEvent(event: FredoEvent): boolean {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const name = (typeof payload.event_type === "string" ? payload.event_type : undefined) ?? event.toolName ?? "";

  // Match message.updated for both user and assistant roles
  if (name === "message.updated") {
    const props = payload.properties as Record<string, unknown> | undefined;
    const info = (props?.info ?? payload.info ?? {}) as Record<string, unknown>;
    const role = info.role ?? payload.role ?? '';
    if (role !== "user" && role !== "assistant") return false;
    const msgId = info.id ?? (payload.id as string) ?? event.id;
    if (!msgId || seenMsgIds.has(String(msgId))) return false;
    seenMsgIds.add(String(msgId));
    return true;
  }

  // Match complete message.part.updated (those with part.time.end set)
  // Streaming deltas (without time.end) are rejected
  if (name === "message.part.updated") {
    const props = payload.properties as Record<string, unknown> | undefined;
    const part = (props?.part ?? payload.part ?? {}) as Record<string, unknown>;
    const partTime = part.time as Record<string, unknown> | undefined;
    if (!partTime?.end) return false;
    const partId = String(part.id ?? '');
    if (!partId || seenMsgIds.has(`part:${partId}`)) return false;
    seenMsgIds.add(`part:${partId}`);
    return true;
  }

  return false;
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
