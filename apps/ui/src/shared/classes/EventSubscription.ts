/**
 * Event Contract Engine — Spec #295
 *
 * Types for the declarative event contract system.
 * Features declare contracts (EventContractDeclaration[]) and receive
 * SubscriptionDelivery objects via the Init → Update → End lifecycle.
 *
 * Raw FredoEvent never crosses the IPC bridge — only SubscriptionDelivery objects do.
 */

// ── Delivery Hints ─────────────────────────────────────────────────────────
export type DeliveryHint = 'stream' | 'deferred';

// ── Correlation Keying ─────────────────────────────────────────────────────
export type ContractKey = string | string[];

// ── Contract Filters ───────────────────────────────────────────────────────
export interface ContractFilter {
  providers?: string[];
  toolNames?: string[];
}

// ── Contract Field Declaration ─────────────────────────────────────────────
export interface ContractField {
  name: string;
  path: string;
  hint?: DeliveryHint; // defaults to 'stream'
}

// ── EventContractDeclaration ───────────────────────────────────────────────
export interface EventContractDeclaration {
  name: string;
  key: ContractKey;
  timeoutMs?: number;
  completeWhen?: string;
  fields: ContractField[];
  filter?: ContractFilter;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
export type Lifecycle = 'Init' | 'Update' | 'End';

// ── SubscriptionDelivery ───────────────────────────────────────────────────
export interface SubscriptionDelivery<C extends EventContract = EventContract> {
  contractName: string;
  lifecycle: Lifecycle;
  correlationKey: string;
  fields: Record<string, unknown>;
  timestamp: string;
  timedOut: boolean;
}

// ── EventContract base interface ───────────────────────────────────────────
export interface EventContract {
  readonly name: string;
}

// ── ChatNodeContract — assembled progressively from message events ─────────
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

// ── SubagentContract — tracks agent/subtask part deliveries ────────────────
export interface SubagentContract extends EventContract {
  readonly name: 'subagent';
  subagentName: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
}

// ── Union of all known event contracts ──────────────────────────────────────
export type FredoEventContract = ChatNodeContract | SubagentContract;

// ── Tauri Command Payloads ─────────────────────────────────────────────────
export interface RegisterContractsPayload {
  featureId: string;
  contracts: EventContractDeclaration[];
}

export interface DeregisterContractsPayload {
  featureId: string;
}
