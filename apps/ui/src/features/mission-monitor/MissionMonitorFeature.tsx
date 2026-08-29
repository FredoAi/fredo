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
        // #2743 ST-1 (AC-12): the cost / session-total declarations per the
        // acceptance criterion's letter. `payload.cost_usd` is a per-turn LLM
        // span flat attr (message.ts:185) and extracts on chat deliveries;
        // total_tokens / total_messages / total_cost_usd only ever ride
        // agent_session spans (session.ts:335-338) — extracted when present,
        // never relied upon: the Total Top Bar derives them frontend-side from
        // the chat-node deliveries it already consumes (computeSessionMetrics,
        // counters.ts). All paths are 2-level dotted (field.rs:21-46) — safe.
        'payload.cost_usd',
        'payload.total_tokens',
        'payload.total_messages',
        'payload.total_cost_usd',
      ],
      deferredFields: [],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      transports: ['otlp_grpc'],
      eventTypes: ['chat'],
      // Spec #2768 (ST-5): the chat-node contract is PERSISTENT — the backend
      // ContractEventStore records its deliveries while the panel is closed
      // (registration skips persistent contracts at unmount), and mount-time
      // hydration (useSessionHistory → hydrateContractEvents) replays them
      // under their original delivery ids so a panel opened after (or mid-) a
      // session renders the complete graph with no gap (AC2/AC3).
      persistent: true,
      excludePayload: [
        { path: 'is_subagent', equals: true },
        { path: 'agent.type', equals: 'subagent' },
      ],
    },
    // #2739 ST-1 (R-1 / Architect D-3): tool-use-lifecycle — makes the
    // already-flowing tool_use spans visible to the graph builder (#2764: the
    // resolved non-task calls embed inside their anchor chat node's
    // payload.tools). FRONTEND-ONLY:
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
        // #2743 ST-1: the whole `payload` stream field delivers tool.success /
        // tool.error / duration_ms as flat payload keys — read in
        // upsertToolCallSummary. `tool.success`/`tool.error` are NEVER declared
        // as dotted ECE paths (the literal dot in the key would mis-split into
        // a 3-level path and silently strip — the repo's 2-level rule).
        // `payload.duration_ms` is a safe 2-level dotted declaration (AC-10).
        'payload',
        'state',
        'payload.duration_ms',
      ],
      deferredFields: [],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      transports: ['otlp_grpc'],
      eventTypes: ['tool_use'],
      // Spec #2768 (ST-5): persistent — closed-window tool activity is
      // captured by the backend store and replayed on mount-time hydration
      // (AC2/AC3 partial-window coverage). Mirrors the chat-node contract.
      persistent: true,
      excludePayload: [
        { path: 'is_subagent', equals: true },
        { path: 'agent.type', equals: 'subagent' },
      ],
    },
    // #2762 ST-1 (R-1/R-2): subagent tool activity — the child-session tool_use
    // spans the two contracts above deliberately EXCLUDE. Deliberately NO
    // excludePayload: the is_subagent/agent.type rules would drop exactly the
    // subagent-session events this contract needs (Spec #2723 excluded them
    // pre-buffer, which is why nested activity was invisible). Keyed by the
    // child session's OWN sessionId (no compositing) — the frontend joins
    // SubagentNodePayload.childSessionId ↔ deliverySessionId to attach nested
    // tools/dispatches to the owning SubagentNode, recursively, at ANY depth.
    // The engine cannot express "deliver ONLY subagent events" (payload_rule
    // treats an absent path as non-matching — equals:false never matches), so
    // primary-session tool spans arrive here too; the graph builder's R-2
    // guard (payload.is_subagent !== true → ignore) drops them, keeping root
    // tool rendering byte-identical via tool-use-lifecycle. otlp_grpc only
    // (Spec #615), tool_use only — mirrors the tool-use-lifecycle filters.
    {
      contractName: 'subagent-tool-activity',
      streamFields: ['payload', 'state', 'payload.duration_ms'],
      deferredFields: [],
      key: ['sessionId', 'correlationId'],
      completeWhen: "state === 'Response'",
      timeout: 300000,
      transports: ['otlp_grpc'],
      eventTypes: ['tool_use'],
      // Spec #2768 (ST-5): persistent — child-session activity streamed while
      // the panel is closed is captured by the backend store and replayed on
      // mount-time hydration so the delegation tree survives reopen (AC3).
      persistent: true,
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
