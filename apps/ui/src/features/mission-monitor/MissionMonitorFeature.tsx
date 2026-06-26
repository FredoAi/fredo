import React from "react";
import type { ReactElement } from "react";
import type { IconType } from "react-icons";
import { LuActivity } from "react-icons/lu";
import { FredoFeatureClass } from "../../shared/classes";
import type { EventFilter } from "../../shared/classes";
import type { FredoEvent } from "../../shared/contexts/StreamContext";
import type { ContractDelivery } from "../../shared/classes/EventSubscription";
import { MissionMonitorPanel } from "./components/MissionMonitorPanel";

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = "mission-monitor";
  readonly name = "Mission Monitor";
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  // @deprecated — kept for base class compatibility
  readonly eventFilters: EventFilter[] = [];

  /**
   * ChatNodeEvent contract — the ECE buffers raw events by session+correlation key
   * and delivers assembled payloads via handleDelivery.
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
    // All event processing moved to handleDelivery + StreamContext.deliveries
  }

  handleDelivery(_delivery: ContractDelivery): void {
    // Deliveries are consumed from StreamContext.deliveries by the panel
    // handleDelivery is called by the ECE pipeline to route deliveries to this feature
    this.forceRerender?.();
  }

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
