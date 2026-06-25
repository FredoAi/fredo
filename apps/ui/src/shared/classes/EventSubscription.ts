/**
 * Event Contract Engine — TypeScript Contract Types
 *
 * The ECE (Rust backend) buffers raw FredoEvent objects, evaluates
 * completeWhen conditions, and delivers SubscriptionDelivery objects to the
 * frontend via the "fredo-stream-event" IPC channel.
 *
 * Features declare typed eventContracts on FredoFeatureClass. Non-feature
 * components use useContractDelivery to receive contract events.
 *
 * ── New Pipeline Types ─────────────────────────────────────────────────────
 * - EventContractDeclaration: Declares a feature's contract interest
 *   (mirrors Rust ContractDeclaration).
 * - ContractDelivery: Delivery envelope from the ECE (mirrors Rust
 *   SubscriptionDelivery). Full accumulated payload per REQ-13.
 * - registerEventContracts(): Registers contracts with ECE via Tauri IPC.
 * - EventContractConsumer: Interface for features consuming contract deliveries.
 *
 * ── Legacy Types (kept for outside-scope consumers) ───────────────────────
 * ChatNodeContract, EventContract, and SubscriptionDelivery are retained
 * because mission-monitor hooks and tests (outside this capsule's scope)
 * still import them. These will be removed once those consumers migrate.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Old types — kept for outside-scope consumers (hooks, tests)
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

// ═══════════════════════════════════════════════════════════════════════════
// ECE Pipeline Types
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
