import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { EventFilter } from "../../shared/classes";
import type { FredoEvent } from "../../shared/contexts/StreamContext";
import type { EventSubscription, EventContract, ChatNodeContract, SubscriptionDelivery } from "../../shared/classes/EventSubscription";
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

/** Subscription state — shared between feature instance and UI hook */
export interface SubscriptionState {
  /** Accumulated subscription deliveries for the ChatNodeEvent */
  deliveries: SubscriptionDelivery<ChatNodeContract>[];
}

export const globalSubscriptionState: SubscriptionState = {
  deliveries: [],
};

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  readonly eventFilters: EventFilter[] = [{ custom: isTargetEvent }];

  /**
   * ChatNodeEvent subscription — declares interest in assembling ChatNode
   * contracts from raw message.updated / message.part.updated events.
   *
   * The subscription delivery lifecycle:
   *   message.updated (role=user, new messageID)       → Init   with empty contract
   *   message.part.updated (type=text, user messageID)  → Update appending to userMessage
   *   message.part.updated (type=reasoning)              → Update appending to agentThinking
   *   message.part.updated (type=text, assistant msgID)  → Update appending to agentReply
   *   message.updated (role=assistant, time.completed)   → End    with final contract
   */
  readonly eventSubscriptions: EventSubscription[] = [
    {
      contractName: "chat-node",
      mapping: {
        userMessage: "info.text",
        agentThinking: "part.reasoning",
        agentReply: "part.text",
        model: "info.modelID",
        turnTools: "tools.count",
        turnFiles: "files.count",
      },
      onDelivery: (delivery: SubscriptionDelivery<EventContract>) => {
        globalSubscriptionState.deliveries.push(delivery as SubscriptionDelivery<ChatNodeContract>);
        this.forceRerender?.();
      },
    },
  ];

  processEvent(event: FredoEvent): void {
    // Persistence is handled synchronously by AppProvider IPC handler —
    // decoupled from React render lifecycle. processEvent only triggers
    // live UI re-render when the feature window is open.
    this.forceRerender?.();
  }

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
