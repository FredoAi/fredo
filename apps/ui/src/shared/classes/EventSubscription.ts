/**
 * Spec #295 — Event Contract Engine (ECE)
 *
 * Types for the declarative contract query system. Features declare exactly
 * what fields they need with per-field delivery hints (stream vs deferred).
 * The engine lives in Rust, buffers partial events by correlation key, and
 * emits progressively assembled SubscriptionDelivery objects.
 *
 * Raw FredoEvent objects never cross the Tauri IPC bridge — only
 * SubscriptionDelivery objects reach the frontend.
 */

// ── REQ-6/REQ-7: Delivery Hints ──────────────────────────────────────────
export type DeliveryHint = 'stream' | 'deferred';

// ── REQ-5: Correlation Keying ────────────────────────────────────────────
export type ContractKey = string | string[];

// ── REQ-3/REQ-17: Contract Filters ───────────────────────────────────────
export interface ContractFilter {
  providers?: string[];
  toolNames?: string[];
}

// ── REQ-4: Contract Field Declaration ─────────────────────────────────────
export interface ContractField {
  name: string;
  path: string;
  hint?: DeliveryHint; // defaults to 'stream'
}

// ── REQ-1: EventContractDeclaration ──────────────────────────────────────
export interface EventContractDeclaration {
  name: string;
  key: ContractKey;
  timeoutMs?: number;
  completeWhen?: string;
  fields: ContractField[];
  filter?: ContractFilter;
}

// ── REQ-10: Lifecycle ────────────────────────────────────────────────────
export type Lifecycle = 'Init' | 'Update' | 'End';

// ── REQ-11/REQ-12: SubscriptionDelivery ──────────────────────────────────
/**
 * SubscriptionDelivery — carries fragments of an EventContract through its
 * Init → Update → End lifecycle. The Rust Contract Engine emits these via
 * the "fredo-stream-event" IPC channel.
 *
 * For backward compatibility with feature files that construct deliveries
 * locally (e.g. Mission Monitor's `onDelivery`), all new ECE fields
 * (`contractName`, `correlationKey`, `fields`, `timedOut`) are optional.
 * Production deliveries from the Rust engine always set them.
 *
 * The old `contract` and `correlationId` fields are provided as type-safe
 * extensions for the transition period.
 *
 * @template C The contract type (defaults to EventContract).
 */
export interface SubscriptionDelivery<C extends EventContract = EventContract> {
  lifecycle: Lifecycle;
  timestamp: string;

  // Contract — the accumulated contract state (backward compat, always set by Mission Monitor)
  contract: C;

  // Correlation identifier
  correlationId: string;

  // New ECE shape (from Rust Contract Engine — always set on IPC deliveries)
  contractName?: string;
  correlationKey?: string;
  fields?: Record<string, unknown>;
  timedOut?: boolean;
}

// ── REQ-14: EventContract base interface ─────────────────────────────────
export interface EventContract {
  readonly name: string;
}

// ── REQ-16: Existing contracts (updated for ECE) ─────────────────────────
export interface ChatNodeContract extends EventContract {
  readonly name: 'chat-node';
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

export interface SubagentContract extends EventContract {
  readonly name: 'subagent';
  subagentName: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
}

// ── REQ-19: Tauri Command Payloads ───────────────────────────────────────
export interface RegisterContractsPayload {
  featureId: string;
  contracts: EventContractDeclaration[];
}

export interface DeregisterContractsPayload {
  featureId: string;
}

// ── @deprecated: Legacy types kept for feature file backward compatibility ──
/** @deprecated Use Lifecycle instead */
export type LifecycleState = Lifecycle;
/** @deprecated Use SubscriptionDelivery instead */
export type FredoEventContract = ChatNodeContract;
/**
 * @deprecated Use EventContractDeclaration instead.
 * Kept for backward compatibility with feature files not yet migrated.
 */
export interface EventSubscription<C extends EventContract = EventContract> {
  readonly contractName: C["name"];
  readonly mapping: Record<string, string>;
  onDelivery: (delivery: SubscriptionDelivery<C>) => void;
}
