/**
 * RTDB Row Types — TypeScript wire contracts (Spec #2788, P4.1)
 *
 * Mirrors the Rust RTDB row structs (`infrastructure/rtdb/rows.rs`, camelCase
 * serde wire shape) and the delivery envelopes emitted by the backend flush
 * loop on the "fredo-stream-event" IPC channel (the ONLY event channel — the
 * v1 contract-engine pipeline was deleted in Spec #2788 P5.1).
 *
 * Field names are STABLE — the backend projects patch keys straight from this
 * serde shape, never re-keyed.
 */

/**
 * @deprecated v1 ECE delivery envelope — the contract engine was deleted in
 * Spec #2788 P5.1. RETAINED ONLY because the historical test fixtures
 * (`mission-monitor/hooks/__tests__/fixtures/*`) still use it as their
 * input shape before converting to RTDB rows. Never import from production
 * code — the wire carries RowDelivery/RowDeliveryBatch only.
 */
export interface ContractDelivery {
  id: string;
  contractName: string;
  lifecycle: 'init' | 'update' | 'end';
  key: Record<string, string>;
  payload: Record<string, unknown>;
  timestamp: string;
  provider?: string;
  timedOut?: boolean;
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

/** A completed chat turn (one per-turn composite key). */
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
  /** #523 re-key stamp — original child session id on composited rows. */
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
 * RTDB patch envelope — arrives on the "fredo-stream-event" IPC channel,
 * either as a single delivery or inside a batch envelope.
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
 * `rowBatch` field discriminates it from single-delivery envelopes.
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
 * RowDelivery. Single extraction path — no heuristic fallbacks: the envelope
 * MUST carry the full pinned field set.
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
