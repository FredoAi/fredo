/**
 * Event Contract Engine — TypeScript Contract Types
 *
 * Replaces the old Spec #252 EventSubscription system with a contract-based
 * pipeline. The ECE (Rust backend) buffers raw FredoEvent objects, evaluates
 * completeWhen conditions, and delivers SubscriptionDelivery objects to the
 * frontend via the "fredo-stream-event" IPC channel.
 *
 * Features declare typed eventContracts on FredoFeatureClass. Non-feature
 * components use useDeliveryFilter to receive contract events.
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
  /**
   * NEW (Spec #2723, req 5): payload-path exclusion rules. An event is SKIPPED
   * for this contract (no buffer, no delivery) when ANY rule matches:
   * extract_field(input.payload, path) equals `equals`. Mirrors the Spec #382
   * transports/eventTypes filter architecture. Evaluated BEFORE key
   * extraction/buffering in process_for_contract. Backward compatible —
   * omitting this field means "no payload exclusions."
   */
  excludePayload?: Array<{ path: string; equals: string | boolean | number }>;
  /**
   * Spec #2768 (ST-3): persistent contracts are registered once at app
   * bootstrap (Home.tsx registers every feature's contracts at mount) and are
   * SKIPPED by unmount-time deregistration — the ECE keeps buffering and the
   * delivery layer persists their deliveries via ContractEventStore while the
   * feature is closed. Hydrate on mount via hydrateContractEvents() to replay
   * what streamed while closed. Backward compatible — omitting means false
   * (non-persistent, byte-identical behavior).
   */
  persistent?: boolean;
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

// ═══════════════════════════════════════════════════════════════════════════
// RTDB ROW TYPES — Spec #2788 (P4.1)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Typed row structs mirroring the Rust RTDB rows (`infrastructure/rtdb/
 * rows.rs`, camelCase serde wire shape). Field names are STABLE — the backend
 * projects patch keys straight from this serde shape, never re-keyed.
 *
 * `state` is PascalCase per the Rust RowState enum (`"Init" | "Update" |
 * "Response" | "Timeout" | "Error"`).
 */
export type RowState = 'Init' | 'Update' | 'Response' | 'Timeout' | 'Error';

/** Root event type of an RTDB subscription (Rust `EventTypeArg`, PascalCase serde). */
export type RowEventType = 'Chat' | 'ToolUse' | 'AgentSession';

/** Composite row identity — one row per (sessionId, correlationId). */
export interface RowKey {
  sessionId: string;
  correlationId: string;
}

/** A completed chat turn (one per-turn ECE composite key). */
export interface ChatRow {
  sessionId: string;
  correlationId: string;
  /** Per-key monotonic sequence — durable, seeded from MAX(seq) on backfill. */
  seq: number;
  /** Span start, epoch nanoseconds. */
  startedAtNs: number | null;
  /** Span end, epoch nanoseconds (`null` while the turn streams). */
  endedAtNs: number | null;
  /** RFC3339 last-write stamp. */
  updatedAt: string;
  state: RowState;
  /** User prompt text (init-time data — survives every later patch). */
  userMessage: string | null;
  /** Assistant reply text (latest non-empty wins). */
  agentReply: string | null;
  /** Per-turn prompt delta. */
  promptTokens: number | null;
  /** Per-turn completion output. */
  completionTokens: number | null;
  /** Per-turn cache-read delta. */
  cacheReadTokens: number | null;
  /** Per-turn cost in USD. */
  costUsd: number | null;
  /** Model id (`gen_ai.response.model`). */
  model: string | null;
  /** Parent session attribution join. */
  parentSessionId: string | null;
  /** #523 ECE re-key stamp — original child session id on composited rows. */
  compositedChildSessionId: string | null;
  /** Escape hatch — the latest raw delivery payload as JSON. */
  rawJson: string;
}

/** One tool execution (`execute_tool` span). */
export interface ToolUseRow {
  sessionId: string;
  correlationId: string;
  seq: number;
  startedAtNs: number | null;
  endedAtNs: number | null;
  updatedAt: string;
  state: RowState;
  /** Tool name (`gen_ai.tool.name`). */
  toolName: string | null;
  /** Outcome flag (`tool.success` — `false` is a meaningful outcome). */
  toolSuccess: boolean | null;
  /** Failure text (`tool.error`). */
  toolError: string | null;
  /** Execution duration in milliseconds. */
  durationMs: number | null;
  /** Call arguments JSON (fixed at call time). */
  toolInputJson: string | null;
  /** Result JSON. */
  toolOutputJson: string | null;
  /** Subagent dispatch marker. */
  isSubagent: boolean | null;
  rawJson: string;
}

/** Session-level aggregate (`run_agent` span). */
export interface AgentSessionRow {
  sessionId: string;
  correlationId: string;
  seq: number;
  startedAtNs: number | null;
  endedAtNs: number | null;
  updatedAt: string;
  state: RowState;
  /** Session-cumulative tokens. */
  totalTokens: number | null;
  /** Session-cumulative message count. */
  totalMessages: number | null;
  /** Session-cumulative cost in USD. */
  totalCostUsd: number | null;
  /** Agent display name (`gen_ai.agent.name`). */
  agentName: string | null;
  rawJson: string;
}

export type RtdbRow = ChatRow | ToolUseRow | AgentSessionRow;

/** Canonical per-row-type selection fields — mirrors rows.rs field tables verbatim. */
export const CHAT_ROW_FIELDS: readonly string[] = [
  'sessionId',
  'correlationId',
  'seq',
  'startedAtNs',
  'endedAtNs',
  'updatedAt',
  'state',
  'userMessage',
  'agentReply',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'costUsd',
  'model',
  'parentSessionId',
  'compositedChildSessionId',
  'rawJson',
];

export const TOOL_USE_ROW_FIELDS: readonly string[] = [
  'sessionId',
  'correlationId',
  'seq',
  'startedAtNs',
  'endedAtNs',
  'updatedAt',
  'state',
  'toolName',
  'toolSuccess',
  'toolError',
  'durationMs',
  'toolInputJson',
  'toolOutputJson',
  'isSubagent',
  'rawJson',
];

export const AGENT_SESSION_ROW_FIELDS: readonly string[] = [
  'sessionId',
  'correlationId',
  'seq',
  'startedAtNs',
  'endedAtNs',
  'updatedAt',
  'state',
  'totalTokens',
  'totalMessages',
  'totalCostUsd',
  'agentName',
  'rawJson',
];

/** What happened to a key in a query's result set. */
export type RowChangeKind = 'insert' | 'update' | 'remove';

/**
 * RTDB patch envelope — arrives on the existing "fredo-stream-event" IPC
 * channel DURING COEXISTENCE with the v1 `ContractDelivery` envelopes.
 * Discriminate by field presence via `isRowDelivery` (RowDelivery carries
 * `queryId` + `kind`; ContractDelivery carries `contractName` + `lifecycle`).
 */
export interface RowDelivery {
  queryId: string;
  eventType: RowEventType;
  kind: RowChangeKind;
  /** The row's durable per-key monotonic sequence at this mutation. */
  seq: number;
  key: RowKey;
  /** Full row on insert; changed+selected fields only on update; `null` on remove. */
  patch: Partial<RtdbRow> | null;
  /** RFC3339 emission time. */
  timestamp: string;
}

const ROW_CHANGE_KINDS: readonly string[] = ['insert', 'update', 'remove'];
const ROW_EVENT_TYPES: readonly string[] = ['Chat', 'ToolUse', 'AgentSession'];

/**
 * RTDB BATCH envelope — the backend flush loop emits ONE "fredo-stream-event"
 * IPC event per drained flush chunk carrying up to RTDB_MAX_EMISSION_BATCH
 * (512) RowDelivery envelopes (Spec #2788 F-33 fix, W-1). The camelCase
 * `rowBatch` field discriminates it from single-delivery envelopes; v1
 * ContractDelivery consumers are unaffected.
 *
 * `replayCompleteQueryId` (round-3 F-33 fix) rides ONLY the terminal
 * emission of one query's replay drain — the final ≤512 chunk of the
 * snapshot, or an empty terminal envelope when nothing remained pending.
 * It is the frontend's deterministic settle signal (`useEventRows.ready`
 * resolves on it, never on subscribe resolution alone). Absent on every
 * live emission.
 */
export interface RowDeliveryBatch {
  rowBatch: RowDelivery[];
  replayCompleteQueryId?: string;
}

/**
 * Typed accessor for the replay-completion marker (round-3 F-33 fix).
 * Single extraction path — an absent/empty marker reads as `undefined`
 * (a live envelope never carries the field; the backend omits it on the
 * wire via `skip_serializing_if`).
 */
export function replayCompleteQueryIdOf(batch: RowDeliveryBatch): string | undefined {
  return typeof batch.replayCompleteQueryId === 'string' && batch.replayCompleteQueryId.length > 0
    ? batch.replayCompleteQueryId
    : undefined;
}

/**
 * Discriminate an incoming "fredo-stream-event" payload as an RTDB batch
 * envelope. Single extraction path — every element MUST pass the production
 * `isRowDelivery` validator; a batch with any malformed element is rejected
 * whole (never partially applied).
 */
export function isRowDeliveryBatch(msg: unknown): msg is RowDeliveryBatch {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  if (!Array.isArray(m.rowBatch)) return false;
  return m.rowBatch.every((element) => isRowDelivery(element));
}

/**
 * Discriminate an incoming "fredo-stream-event" payload as an RTDB
 * RowDelivery (vs the v1 ContractDelivery). Single extraction path — no
 * heuristic fallbacks: the envelope MUST carry the full pinned field set.
 */
export function isRowDelivery(msg: unknown): msg is RowDelivery {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.queryId !== 'string' || m.queryId.length === 0) return false;
  if (typeof m.kind !== 'string' || !ROW_CHANGE_KINDS.includes(m.kind)) return false;
  if (typeof m.seq !== 'number' || !Number.isFinite(m.seq)) return false;
  if (typeof m.eventType !== 'string' || !ROW_EVENT_TYPES.includes(m.eventType)) return false;
  const key = m.key;
  if (!key || typeof key !== 'object' || Array.isArray(key)) return false;
  const k = key as Record<string, unknown>;
  return typeof k.sessionId === 'string' && typeof k.correlationId === 'string';
}

/**
 * Stable composite key for a RowKey — the Map key used by the row store and
 * returned by useEventRows (`sessionId` + NUL separator + `correlationId`).
 */
export function rowKeyString(key: RowKey): string {
  return `${key.sessionId}\u0000${key.correlationId}`;
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
