/**
 * Event Contract Engine — TypeScript Contract Types
 *
 * Replaces the old Spec #252 EventSubscription system with a contract-based
 * pipeline. The ECE (Rust backend) buffers raw FredoEvent objects, evaluates
 * completeWhen conditions, and delivers SubscriptionDelivery objects to the
 * frontend via the "fredo-stream-event" IPC channel.
 *
 * Features declare typed eventContracts on FredoFeatureClass. Non-feature
 * components use useContractDelivery to receive contract events.
 *
 * ── Backward Compatibility ─────────────────────────────────────────────────
 * Old types (LifecycleState, EventContract, ChatNodeContract,
 * FredoEventContract, SubscriptionDelivery<C>, EventSubscription) are kept
 * for features not yet migrated to eventContracts. New code should use
 * EventContractDeclaration and ContractDelivery.
 *
 * ── New Pipeline Types ─────────────────────────────────────────────────────
 * - EventContractDeclaration: Declares a feature's contract interest
 *   (mirrors Rust ContractDeclaration).
 * - ContractDelivery: Delivery envelope from the ECE (mirrors Rust
 *   SubscriptionDelivery). Full accumulated payload per REQ-13.
 * - registerEventContracts(): Registers contracts with ECE via Tauri IPC.
 */

// ═══════════════════════════════════════════════════════════════════════════
// OLD TYPES — kept for backward compat (pre-migration features)
// ═══════════════════════════════════════════════════════════════════════════

/** @deprecated Use ContractDelivery.lifecycle ("init"|"update"|"end") instead */
export type LifecycleState = "Init" | "Update" | "End";

/** @deprecated Base contract — all contracts extend this */
export interface EventContract {
  readonly name: string;
}

/** @deprecated ChatNode contract — assembled progressively from raw events */
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

/** @deprecated Union of all known event contracts (extend when adding new contracts) */
export type FredoEventContract = ChatNodeContract;

/**
 * @deprecated Use ContractDelivery instead.
 * Delivery envelope wrapping a contract with lifecycle metadata.
 */
export interface SubscriptionDelivery<C extends EventContract = EventContract> {
  contract: C;
  lifecycle: LifecycleState;
  correlationId: string;
  timestamp: string;
}

/**
 * @deprecated Use eventContracts + handleDelivery on FredoFeatureClass instead.
 * EventSubscription — declares a feature's contract interest.
 */
export interface EventSubscription<C extends EventContract = EventContract> {
  readonly contractName: C["name"];
  readonly mapping: Record<string, string>;
  onDelivery: (delivery: SubscriptionDelivery<C>) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW TYPES — Event Contract Engine (ECE) Pipeline
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Contract declaration — mirrors Rust ContractDeclaration.
 * Features declare these in the `eventContracts` array.
 */
export interface EventContractDeclaration {
  contractName: string;
  streamFields: string[];
  deferredFields: string[];
  key: string[];
  completeWhen: string;
  timeout: number;
  providers?: string[];
  transports?: string[];
  eventTypes?: string[];
}

/**
 * Delivery envelope received from the Rust ECE via the "fredo-stream-event"
 * IPC channel. Mirrors Rust SubscriptionDelivery.
 *
 * Per REQ-13, `payload` is the full accumulated state — features never need
 * to merge partial results.
 */
export interface ContractDelivery {
  id: string;
  contractName: string;
  lifecycle: "init" | "update" | "end";
  key: Record<string, string>;
  payload: Record<string, unknown>;
  timestamp: string;
  provider?: string;
  timedOut?: boolean;
}

/**
 * Interface that FredoFeatureClass must implement for eventContracts.
 * Replaces the old eventFilters + eventSubscriptions approach.
 */
export interface EventContractConsumer {
  /** Event contracts this feature declares. */
  readonly eventContracts: EventContractDeclaration[];

  /**
   * Handle a ContractDelivery from the ECE.
   * Called by the engine for every delivery matching this feature's contracts.
   */
  handleDelivery(delivery: ContractDelivery): void;
}

/**
 * Register feature contracts with the ECE via Tauri IPC.
 * Called at feature mount. Returns a function to deregister at unmount.
 *
 * The Rust ECE validates contracts (rejects timeout > 300000ms), stores
 * them in the active contract registry, and begins buffering matching events.
 */
export async function registerEventContracts(
  contracts: EventContractDeclaration[]
): Promise<() => Promise<void>> {
  const { TauriAdapter } = await import('../../app/adapters/TauriAdapter');
  const adapter = new TauriAdapter();

  await adapter.invoke('register_event_contracts', { contracts });

  return async () => {
    const names = contracts.map((c) => c.contractName);
    await adapter.invoke('deregister_event_contracts', { contractNames: names });
  };
}
