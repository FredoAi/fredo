/**
 * Spec #252 — Event Subscription System
 *
 * Types for declaring typed event subscriptions that assemble raw stream events
 * into contract objects delivered via Init → Update → End lifecycle.
 *
 * Features declare subscriptions in the `eventSubscriptions` array on
 * FredoFeatureClass. The subscription engine processes raw FredoEvents through
 * each subscription's lifecycle logic and calls `onDelivery` with progressively
 * assembled contract objects.
 */

/** Lifecycle phase of a subscription delivery */
export type LifecycleState = "Init" | "Update" | "End";

/** Base contract — all contracts extend this */
export interface EventContract {
  readonly name: string;
}

/** ChatNode contract — assembled progressively from raw events */
export interface ChatNodeContract extends EventContract {
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

/** Subagent contract — assembled progressively from SubagentStart + part events */
export interface SubagentContract extends EventContract {
  readonly name: "subagent-node";
  subagentName: string;
  instruction: string;
  output: string;
  model?: string;
  parentCorrelationId: string;
  tokensIn?: number;
  tokensOut?: number;
  toolsUsed?: number;
}

/** Union of all known event contracts (extend when adding new contracts) */
export type FredoEventContract = ChatNodeContract | SubagentContract;

/** Delivery envelope — wraps a contract with lifecycle metadata */
export interface SubscriptionDelivery<C extends EventContract = EventContract> {
  contract: C;
  lifecycle: LifecycleState;
  correlationId: string;
  timestamp: string;
}

/**
 * EventSubscription — declares a feature's contract interest.
 *
 * Features declare one or more subscriptions. Each subscription:
 * - Targets a specific contract by `contractName`
 * - Maps raw event fields → contract properties via `mapping`
 * - Receives progressive deliveries via `onDelivery`
 */
export interface EventSubscription<C extends EventContract = EventContract> {
  readonly contractName: C["name"];
  /** Mapping from contract field names to raw event field paths (declarative, for documentation) */
  readonly mapping: Record<string, string>;
  onDelivery: (delivery: SubscriptionDelivery<C>) => void;
}
