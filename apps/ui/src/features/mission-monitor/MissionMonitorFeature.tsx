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
   * ECE contracts — the engine buffers raw events by composite key and delivers
   * assembled payloads via handleDelivery. Contracts are auto-registered by Home.tsx.
   *
   * - chat-node: Agent lifecycle (session turns)
   * - tool-use-lifecycle: Tool lifecycle (toolName + state + payload)
   * - subagent-lifecycle: Subagent lifecycle (toolName as name + state + payload)
   */
  readonly eventContracts = [
    {
      contractName: 'chat-node',
      streamFields: [
        'payload',
        'state',
      ],
      deferredFields: [],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      transports: ['hook', 'otlp_grpc', 'otlp_http'],
      eventTypes: ['chat', 'agent_session'],
    },
    {
      contractName: 'tool-use-lifecycle',
      streamFields: [
        'toolName',
        'state',
        'payload',
      ],
      deferredFields: [],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      transports: ['hook'],
      eventTypes: ['tool_use'],
    },
    {
      contractName: 'subagent-lifecycle',
      streamFields: [
        'toolName',
        'state',
        'payload',
      ],
      deferredFields: [],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      transports: ['hook'],
      eventTypes: ['tool_use'],
    },
  ];

  // @deprecated — kept for base class compatibility
  processEvent(_event: FredoEvent): void {
    // All event processing moved to handleDelivery + StreamContext.deliveries
  }

  private _selfOpened = false;

  handleDelivery(_delivery: ContractDelivery): void {
    if (!this._selfOpened && _delivery.lifecycle === 'init') {
      this._selfOpened = true;
      this.openSelf();
    }
    this.forceRerender?.();
  }

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
