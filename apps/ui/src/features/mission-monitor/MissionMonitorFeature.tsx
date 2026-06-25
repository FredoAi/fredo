import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { EventFilter } from "../../shared/classes";
import type { FredoEvent } from "../../shared/contexts/StreamContext";
import type { EventSubscription, EventContract, ChatNodeContract, SubscriptionDelivery } from "../../shared/classes/EventSubscription";
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
  // @deprecated — kept for base class compatibility; all event processing via eventContracts
  readonly eventFilters: EventFilter[] = [];

  /**
   * ChatNodeEvent contract — replaces eventSubscriptions.
   *
   * The contract engine buffers raw events by session+correlation key,
   * streaming message text fields as they arrive and delivering token
   * counts when the message completes.
   */
  readonly eventContracts = [
    {
      contractName: 'chat-node',
      streamFields: [
        'payload.info.text',
        'payload.part.reasoning',
        'payload.part.text',
        'payload.info.modelID',
        'payload.tools.count',
        'payload.files.count',
        'state',
      ],
      deferredFields: [
        'payload.info.turnInputTokens',
        'payload.info.turnOutputTokens',
      ],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
    },
  ];

  // @deprecated — kept for base class compatibility
  processEvent(_event: FredoEvent): void {
    // All event processing moved to handleDelivery
  }

  handleDelivery(delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    // Build a legacy-format SubscriptionDelivery from the ECE delivery
    // so the existing globalSubscriptionState + MissionMonitorPanel hook
    // continue to work without modification.
    const legacyDelivery: SubscriptionDelivery<ChatNodeContract> = {
      lifecycle: delivery.lifecycle === 'init' ? 'Init' : delivery.lifecycle === 'end' ? 'End' : 'Update',
      correlationId: (delivery as any).correlationId ?? '',
      timestamp: delivery.timestamp,
      contract: {
        name: 'chat-node',
        userMessage: (delivery.payload as any)?.['payload.info.text'] ?? '',
        agentThinking: (delivery.payload as any)?.['payload.part.reasoning'] ?? '',
        agentReply: (delivery.payload as any)?.['payload.part.text'] ?? '',
        model: (delivery.payload as any)?.['payload.info.modelID'] ?? undefined,
        turnTools: (delivery.payload as any)?.['payload.tools.count'] ?? undefined,
        turnFiles: (delivery.payload as any)?.['payload.files.count'] ?? undefined,
        turnInputTokens: (delivery.payload as any)?.['payload.info.turnInputTokens'] ?? undefined,
        turnOutputTokens: (delivery.payload as any)?.['payload.info.turnOutputTokens'] ?? undefined,
      },
    };

    globalSubscriptionState.deliveries.push(legacyDelivery);
    this.forceRerender?.();
  }

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
