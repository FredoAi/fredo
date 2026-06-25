// Auto-generated spec contract for Spec #295 — Event Contract Engine
// Do not edit manually. Coders implement against these types.
// Generated from: spec-295-body.md

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
export interface SubscriptionDelivery<C extends EventContract = EventContract> {
  contractName: string;
  lifecycle: Lifecycle;
  correlationKey: string;
  fields: Record<string, unknown>;
  timestamp: string;
  timedOut: boolean;
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

// ── Spec Contract Interface ──────────────────────────────────────────────
export interface SpecContract {
  req_1(): Promise<void>;  // register_event_contracts
  req_2(): Promise<void>;  // deregister_event_contracts
  req_3(): Promise<void>;  // event matching
  req_6(): Promise<void>;  // stream delivery
  req_7(): Promise<void>;  // deferred buffering
  req_8(): Promise<void>;  // completeWhen evaluation
  req_9(): Promise<void>;  // timeout sweep
  req_10(): Promise<void>; // lifecycle transitions
  req_12(): Promise<void>; // StreamContext refactor
  req_14(): Promise<void>; // old systems removed
  req_15(): Promise<void>; // feature migration
  req_16(): Promise<void>; // Mission Monitor integration
  req_17(): Promise<void>; // multi-provider
  req_18(): Promise<void>; // TauriAdapter IPC
}
