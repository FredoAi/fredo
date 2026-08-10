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
   * #593: Only chat-node contract is active. Tool-use-lifecycle and custom-event
   * contracts are deactivated.
   *
   * #2688 AC1/AC5: eventTypes restricted to ['chat'] — agent_session events are
   * Init-only in the OTLP adapter and can never satisfy completeWhen, so they
   * produce phantom (never-completing) buffers, and a late session-span Init can
   * reset a completed chat buffer (engine.rs:337-354) creating duplicate nodes.
   * Filtering them at the engine level eliminates both.
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
      transports: ['otlp_grpc'],
      eventTypes: ['chat'],
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
