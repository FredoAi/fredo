import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

/**
 * Legacy ChatNode contract shape — kept for backward compatibility
 * with the existing hook infrastructure.
 */
interface LegacyChatNodeContract {
  readonly name: "chat-node";
  userMessage: string;
  agentThinking: string;
  agentReply: string;
  model?: string;
  turnTools?: number;
  turnFiles?: number;
  turnInputTokens?: number;
  turnOutputTokens?: number;
  agent?: string;
}

/**
 * Legacy SubscriptionDelivery envelope — kept for backward compatibility
 * with the existing hook infrastructure.
 */
interface LegacySubscriptionDelivery {
  contract: LegacyChatNodeContract;
  lifecycle: "Init" | "Update" | "End";
  correlationId: string;
  timestamp: string;
}

/** Subscription state — shared between feature instance and UI hook */
export interface SubscriptionState {
  /** Accumulated subscription deliveries for the ChatNodeEvent */
  deliveries: LegacySubscriptionDelivery[];
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

  handleDelivery(delivery: { lifecycle: string; timestamp: string; payload: Record<string, unknown> }): void {
    // Build a legacy-format SubscriptionDelivery from the ECE delivery
    // so the existing globalSubscriptionState + MissionMonitorPanel hook
    // continue to work without modification.
    const legacyDelivery: LegacySubscriptionDelivery = {
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
