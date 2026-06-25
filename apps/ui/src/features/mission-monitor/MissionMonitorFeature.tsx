import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { EventContractDeclaration, ChatNodeContract, SubscriptionDelivery } from "../../shared/classes/EventSubscription";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

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

  /**
   * Event contracts — declares interest in ChatNode and Subagent contracts.
   * These are registered with the Rust Contract Engine on mount.
   */
  readonly eventContracts: EventContractDeclaration[] = [
    {
      name: "chat-node",
      key: "correlationId",
      fields: [
        { name: "userMessage", path: "payload.properties.part.text", hint: "stream" },
        { name: "agentThinking", path: "payload.properties.part.reasoning", hint: "stream" },
        { name: "agentReply", path: "payload.properties.part.text", hint: "stream" },
        { name: "model", path: "payload.properties.info.modelID", hint: "stream" },
        { name: "turnTools", path: "payload.properties.part.tools.count", hint: "deferred" },
        { name: "turnFiles", path: "payload.properties.part.files.count", hint: "deferred" },
      ],
    },
  ];

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
