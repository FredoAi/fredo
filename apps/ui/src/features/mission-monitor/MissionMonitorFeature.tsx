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
   *
   * #2723 AC5 (Spec #523 reversal): excludePayload excludes subagent chat events
   * at the engine level — an event whose payload matches ANY rule is skipped for
   * this contract (no buffer, no delivery, never composited into a parent's
   * buffer). The OTLP adapter injects `is_subagent`/`agent.type` as flat payload
   * attributes on subagent session spans, so those two rules guarantee ZERO
   * subagent-derived deliveries reach Mission Monitor — the frontend graph
   * builder therefore has no subagent path (Contract-Trust Cleanup).
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
      excludePayload: [
        { path: 'is_subagent', equals: true },
        { path: 'agent.type', equals: 'subagent' },
      ],
    },
    // #2739 ST-1 (R-1 / Architect D-3): tool-use-lifecycle — makes the
    // already-flowing tool_use spans visible to the graph builder (one
    // ToolsNode per chat node whose exchange made tool calls). FRONTEND-ONLY:
    // a contract declaration, NOT new data collection (NFR-1) — the OTLP
    // adapter already emits a synthetic Init + Response per completed tool span
    // sharing one correlationId, so completeWhen fires on the Response (no
    // engine change). Same subagent excludePayload rules as the chat-node
    // contract (NFR-5) so subagent tool spans are dropped at the engine, never
    // reaching the builder. otlp_grpc only (Spec #615 — Hook tool events
    // excluded).
    {
      contractName: 'tool-use-lifecycle',
      streamFields: [
        'payload',
        'state',
      ],
      deferredFields: [],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      transports: ['otlp_grpc'],
      eventTypes: ['tool_use'],
      excludePayload: [
        { path: 'is_subagent', equals: true },
        { path: 'agent.type', equals: 'subagent' },
      ],
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
