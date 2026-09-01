/**
 * rowDerivation.ts — typed-RTDB-row → graph-builder-state derivation (P4.2).
 *
 * Spec #2788 R-5a: Mission Monitor's graph derivation operates on clean typed
 * rows (`useEventRows`) instead of v1 `ContractDelivery` streams. This module
 * is the SINGLE projection point row → builder state:
 *
 * - Chat rows become chat-node (`agent`) entries — one per (sessionId,
 *   correlationId) key, the row store's own last-wins-per-key merge semantics
 *   replacing the v1 init/update/end lifecycle branching (`processDelivery`).
 *   Subagent-session chat rows (`parentSessionId` set, or the #523
 *   `compositedChildSessionId` re-key stamp on parent-keyed copies) are
 *   EXCLUDED — the exact engine-level exclusion the v1 chat-node contract's
 *   `excludePayload` rules performed (Spec #2723 AC5 parity).
 * - ToolUse rows route by `isSubagent`: `false`/absent → the session's own
 *   tool calls (`toolCallsBySession`); `true` → child-session activity
 *   bucketed by the correlationId's session PREFIX (`ownerSessionIdFromCorrId`
 *   — the #2770 inner-owner rule: whatever parent key a re-keyed copy rides
 *   under, the corrId still names the session that emitted the span). A
 *   parent-keyed COPY of a child row never overrides the child-keyed
 *   ORIGINAL (first-match insert semantics; the original is authoritative —
 *   copies exist only so a parent-keyed query sees the child's activity).
 * - The child→parent attribution map (`collectorParentByChildSession`) is
 *   derived from TYPED data: the `compositedChildSessionId` stamp on
 *   parent-keyed chat-row copies, plus `parentSessionId` inside a child tool
 *   row's `rawJson` escape hatch (the long-tail fields the canonical ~40-field
 *   set deliberately leaves out).
 *
 * NO defensive join paths, NO lifecycle handling, NO fallback chains beyond
 * the documented per-field projection — the row store + merge rules are the
 * contract (contract-trust cleanup at the right layer).
 */

import type {
  ChatRow,
  RowState,
  ToolUseRow,
} from '../../../shared/classes/EventSubscription';
import {
  normalizeCost,
  normalizeTokenCount,
  type AgentNodePayload,
  type GraphNodeStatus,
  type SubagentNodePayload,
  type ToolCallSummary,
} from './graph';

// ── Graph-builder state (fed by the row derivation, consumed by the hook) ────

/** The full agent entry shape stored in GraphBuilderState (the narrow
 *  `{ payload, status }` views elsewhere are structural projections of it). */
export type AgentNodeEntry = {
  payload: AgentNodePayload;
  status: GraphNodeStatus;
  timestamp: string;
  prevCorrId?: string;
};

/** A SubagentNode entry in the graph-builder state — keyed by the task
 *  dispatch's correlationId (one SubagentNode per user-requested subagent
 *  dispatch). Built by associateToolCalls from the resolved task call;
 *  gated by the AC-4 internal-agent exclusion. */
export interface SubagentNodeEntry {
  payload: SubagentNodePayload;
  status: GraphNodeStatus;
  timestamp: string;
  /** Deterministic payload signature — the no-loop contract (an unchanged
   *  signature keeps the same payload reference, so the node is never
   *  re-emitted/re-rendered — Spec #275/#523 pattern). */
  signature: string;
}

/**
 * The builder state the association + emission passes operate on. The same
 * shape the v1 delivery pipeline filled incrementally — now derived in ONE
 * deterministic pass from the row maps (epoch-memoized upstream).
 */
export interface GraphBuilderState {
  agentNodes: Map<string, AgentNodeEntry>;
  /** Per-session tool-call summaries (tool correlationId → summary).
   *  Resolved non-task calls EMBED into the anchor chat node's payload.tools
   *  (association pass in the hook). */
  toolCallsBySession: Map<string, Map<string, ToolCallSummary>>;
  /** SubagentNode entries keyed by the task dispatch correlationId. */
  subagentNodes: Map<string, SubagentNodeEntry>;
  /** Per-owning-session non-task tool calls collected from child-session
   *  (isSubagent) rows — ownerSessionId → corrId → summary. */
  subagentToolCalls: Map<string, Map<string, ToolCallSummary>>;
  /** Per-owning-session `task` calls (the session's OWN dispatches → nested
   *  SubagentNodes). Same shape + bounded by the row store's own caps. */
  subagentDispatches: Map<string, Map<string, ToolCallSummary>>;
  /** Child session ids whose owning task dispatch named an INTERNAL
   *  tool-execution agent (build/plan) — knowingly ownerless, EXEMPT from the
   *  `⚠ N unattributed` chip count. */
  internalOrphanExempt: Set<string>;
  /** Child session id → parent session id (typed attribution — see module
   *  doc). Feeds the SCOPED orphan count. */
  collectorParentByChildSession: Map<string, string>;
  nodeOrder: string[];
  agentOrder: string[];
  /** Per-session previous chat-node correlationId (vertical chain link). */
  lastAgentBySession: Map<string, string>;
}

export function createEmptyGraphBuilderState(): GraphBuilderState {
  return {
    agentNodes: new Map(),
    toolCallsBySession: new Map(),
    subagentNodes: new Map(),
    subagentToolCalls: new Map(),
    subagentDispatches: new Map(),
    internalOrphanExempt: new Set(),
    collectorParentByChildSession: new Map(),
    nodeOrder: [],
    agentOrder: [],
    lastAgentBySession: new Map(),
  };
}

// ── Field projection helpers ────────────────────────────────────────────────

/** Epoch-nanoseconds → RFC3339 UTC (`Date.toISOString`). Deterministic — the
 *  consumers parse it back with `Date.parse`, so the render output is
 *  identical to the v1 span-derived RFC3339 strings. */
export function nsToIso(ns: number | null): string | undefined {
  if (ns === null || !Number.isFinite(ns)) return undefined;
  return new Date(Math.round(ns / 1e6)).toISOString();
}

/** Parse a row's `rawJson` escape hatch (the latest raw delivery payload).
 *  A parse failure degrades to `{}` — the rawJson is written by the ingest
 *  classifier from a serde-serialized payload, so this never fires on
 *  backend-written rows. */
export function rawPayload(row: { rawJson: string }): Record<string, any> {
  try {
    const parsed = JSON.parse(row.rawJson) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/**
 * Row-state → GraphNodeStatus. The row store has no lifecycle envelope — the
 * `state` column IS the lifecycle (R-1d):
 * Init → in-progress; Update → active; Response → complete; Timeout →
 * complete (the v1 sweep emitted a timedOut END, which completed the node);
 * Error → error. A `compacted: true` payload attr upgrades to `compacted`.
 */
export function chatRowStatus(row: ChatRow): GraphNodeStatus {
  const compacted = rawPayload(row).compacted === true;
  switch (row.state as RowState) {
    case 'Response':
    case 'Timeout':
      return compacted ? 'compacted' : 'complete';
    case 'Error':
      return 'error';
    case 'Update':
      return compacted ? 'compacted' : 'active';
    case 'Init':
    default:
      return 'in-progress';
  }
}

/** True when the chat row belongs to a SUBAGENT session's turn — either the
 *  child-keyed original (`parentSessionId` attribution join) or the
 *  parent-keyed re-key copy (`compositedChildSessionId` stamp). The v1
 *  chat-node contract engine-excluded exactly these rows (excludePayload
 *  is_subagent / agent.type); the row derivation excludes them by column. */
export function isSubagentChatRow(row: ChatRow): boolean {
  return row.parentSessionId !== null || row.compositedChildSessionId !== null;
}

/** Project a ChatRow onto the chat-node payload (AgentNodePayload). The typed
 *  columns carry the canonical fields; `rawJson` carries the v1 long-tail
 *  (agent name, thinking text, reasoning/cacheWrite tokens). */
export function agentPayloadFromChatRow(row: ChatRow): AgentNodePayload {
  const raw = rawPayload(row);
  const promptTokens = normalizeTokenCount(row.promptTokens);
  const completionTokens = normalizeTokenCount(row.completionTokens);
  const reasoningTokens = normalizeTokenCount(raw.reasoningTokens);
  const cacheReadTokens = normalizeTokenCount(row.cacheReadTokens);
  const cacheWriteTokens = normalizeTokenCount(raw.cacheWriteTokens);

  const payload: AgentNodePayload = {
    agent: typeof raw.agent === 'string' ? raw.agent : undefined,
    model: row.model ?? undefined,
    userMessage: row.userMessage ?? '',
    agentThinking: typeof raw.agentThinking === 'string' ? raw.agentThinking : '',
    agentReply: row.agentReply ?? '',
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // R-3.1: Total = Input + Cache + Reasoning + Output exactly. cacheWrite
    // is carried in the payload but NEVER summed (Architect binding G-023).
    totalTokens: promptTokens + cacheReadTokens + reasoningTokens + completionTokens,
    correlationId: row.correlationId,
    sessionId: row.sessionId,
  };
  const startTime = nsToIso(row.startedAtNs);
  if (startTime !== undefined) payload.startTime = startTime;
  // v1 parity (Spec #2723 R-6): a completed turn whose span never carried an
  // end (streaming span) falls back to the row's last-write timestamp for the
  // End row — the row-store analog of the v1 end-delivery timestamp fallback.
  const endTime = nsToIso(row.endedAtNs)
    ?? ((row.state === 'Response' || row.state === 'Timeout') ? row.updatedAt : undefined);
  if (endTime !== undefined) payload.endTime = endTime;
  if (row.costUsd !== null) payload.costUsd = normalizeCost(row.costUsd);
  return payload;
}

/**
 * #2770 round 6 (R-1/R-2/R-5): the owning session of a child tool span —
 * the correlationId's SESSION-PREFIX (every real OTLP corrId is
 * `<sessionId>_<counter>`), NOT any re-key copy's parent key. Multi-hop
 * re-key cascades stamp copies under several ancestor keys; the prefix is
 * arrival/copy-independent, so every copy merges into ONE owner bucket.
 * The guarded fallback covers corrIds that carry no session prefix
 * (legacy/mock shapes) — the single fallback the contract-trust rule allows.
 */
export function ownerSessionIdFromCorrId(corrId: string): string | undefined {
  const sep = corrId.lastIndexOf('_');
  if (sep <= 0) return undefined;
  const prefix = corrId.slice(0, sep);
  return prefix.startsWith('ses_') && prefix.length > 4 ? prefix : undefined;
}

/** Project a ToolUseRow onto a ToolCallSummary (one accordion item). Typed
 *  columns carry the span fields; `rawJson` carries the task-dispatch
 *  child-completion long-tail (childSessionId/childTokens/…). */
export function toolSummaryFromToolRow(row: ToolUseRow): ToolCallSummary {
  const raw = rawPayload(row);
  const startTime = nsToIso(row.startedAtNs) ?? row.updatedAt;
  const inputTokens = normalizeTokenCount(raw.promptTokens);
  const reasoningTokens = normalizeTokenCount(raw.reasoningTokens);
  const outputTokens = normalizeTokenCount(raw.completionTokens);

  const summary: ToolCallSummary = {
    toolName: row.toolName ?? 'unknown',
    input: row.toolInputJson ?? '',
    output: row.toolOutputJson ?? '',
    inputTokens,
    reasoningTokens,
    outputTokens,
    totalTokens: inputTokens + reasoningTokens + outputTokens,
    correlationId: row.correlationId,
    startTime,
  };
  const endTime = nsToIso(row.endedAtNs);
  if (endTime !== undefined) summary.endTime = endTime;
  if (row.toolSuccess !== null) summary.success = row.toolSuccess;
  if (row.toolError !== null) summary.error = row.toolError;
  if (row.durationMs !== null) summary.durationMs = row.durationMs;

  // Task-dispatch child-completion fields (optional — absent stays absent so
  // the SubagentNode renders its documented working state until completion).
  if (typeof raw.childSessionId === 'string' && raw.childSessionId) summary.childSessionId = raw.childSessionId;
  if (typeof raw.childAgent === 'string' && raw.childAgent) summary.childAgent = raw.childAgent;
  if (typeof raw.childTokens === 'number') summary.childTokens = normalizeTokenCount(raw.childTokens);
  if (typeof raw.childCost === 'number') summary.childCost = normalizeCost(raw.childCost);
  if (typeof raw.childMessages === 'number') summary.childMessages = normalizeTokenCount(raw.childMessages);
  if (typeof raw.childInputTokens === 'number') summary.childInputTokens = normalizeTokenCount(raw.childInputTokens);
  if (typeof raw.childCacheReadTokens === 'number') summary.childCacheReadTokens = normalizeTokenCount(raw.childCacheReadTokens);
  if (typeof raw.childReasoningTokens === 'number') summary.childReasoningTokens = normalizeTokenCount(raw.childReasoningTokens);
  if (typeof raw.childOutputTokens === 'number') summary.childOutputTokens = normalizeTokenCount(raw.childOutputTokens);
  return summary;
}

// ── The derivation pass ─────────────────────────────────────────────────────

/** Deterministic iteration order for chat rows: span start ascending
 *  (missing → +Infinity, unresolved last), ties by correlationId. The chat
 *  chain + anchors are driven by this chronological order — never by map
 *  insertion order (the row store's Map is keyed, not ordered). */
function chronologicalChatRows(rows: ChatRow[]): ChatRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.startedAtNs ?? Number.POSITIVE_INFINITY;
    const tb = b.startedAtNs ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.correlationId < b.correlationId ? -1 : a.correlationId > b.correlationId ? 1 : 0;
  });
}

/**
 * Derive the graph-builder state from typed rows — ONE pass, deterministic
 * in row content only (never in delivery/patch arrival order). See the
 * module doc for the routing + stamp semantics.
 */
export function deriveRowGraphState(chatRows: ChatRow[], toolRows: ToolUseRow[]): GraphBuilderState {
  const state = createEmptyGraphBuilderState();

  // ── Chat rows → chat-node entries ──
  for (const row of chronologicalChatRows(chatRows)) {
    if (isSubagentChatRow(row)) continue; // v1 excludePayload parity

    const payload = agentPayloadFromChatRow(row);
    const prevCorrId = state.lastAgentBySession.get(row.sessionId) ?? '';
    state.lastAgentBySession.set(row.sessionId, row.correlationId);

    state.agentNodes.set(row.correlationId, {
      payload,
      status: chatRowStatus(row),
      timestamp: row.updatedAt,
      prevCorrId,
    });
    state.agentOrder.push(row.correlationId);
    state.nodeOrder.push(`agent:${row.correlationId}`);
  }

  // ── Tool rows → per-session call collectors ──
  // Deterministic order: copies (row.sessionId ≠ corrId prefix) FIRST so the
  // child-keyed ORIGINAL overwrites them (original beats copy — the copy was
  // frozen at re-key time; the original keeps receiving live patches).
  const sortedToolRows = [...toolRows].sort((a, b) => {
    const ca = a.sessionId.localeCompare(b.sessionId);
    if (ca !== 0) return ca;
    return a.correlationId < b.correlationId ? -1 : a.correlationId > b.correlationId ? 1 : 0;
  });

  /** Insert/merge one child-activity row into its owner bucket with the
   *  original-beats-copy rule (first-match insert semantics — a re-key copy
   *  never replaces the original, and mis-stamped ancestor copies collapse
   *  into the single prefix-owned entry). Copy-ness is tracked in a
   *  derivation-local flag map — never on the summaries themselves (the
   *  payload signatures must stay primitive-clean). */
  const copyFlags = new Map<string, boolean>();
  const upsertChildActivity = (row: ToolUseRow, isTask: boolean): void => {
    const owner = ownerSessionIdFromCorrId(row.correlationId) ?? row.sessionId;
    const outer = isTask ? state.subagentDispatches : state.subagentToolCalls;
    let sessionCalls = outer.get(owner);
    if (!sessionCalls) {
      sessionCalls = new Map();
      outer.set(owner, sessionCalls);
    }
    const bucketKey = `${owner}\u0000${row.correlationId}`;
    const existing = sessionCalls.get(row.correlationId);
    const newIsCopy = row.sessionId !== owner;
    if (existing) {
      if (copyFlags.get(bucketKey) === true && !newIsCopy) {
        sessionCalls.set(row.correlationId, toolSummaryFromToolRow(row));
        copyFlags.set(bucketKey, false);
      }
      return;
    }
    sessionCalls.set(row.correlationId, toolSummaryFromToolRow(row));
    copyFlags.set(bucketKey, newIsCopy);
  };

  for (const row of sortedToolRows) {
    const summary = toolSummaryFromToolRow(row);
    if (row.isSubagent === true) {
      // Child-session activity — task dispatches and the child's own tools
      // split at collection time (the tool name rides the row).
      upsertChildActivity(row, summary.toolName === 'task');
    } else {
      // The session's own tool call (v1 tool-use-lifecycle path — the engine
      // excluded is_subagent spans; the row's flag column does it now).
      let sessionCalls = state.toolCallsBySession.get(row.sessionId);
      if (!sessionCalls) {
        sessionCalls = new Map();
        state.toolCallsBySession.set(row.sessionId, sessionCalls);
      }
      sessionCalls.set(row.correlationId, summary);
    }

    // Child→parent attribution (typed where possible):
    if (row.isSubagent === true) {
      const parent = rawPayload(row).parentSessionId;
      const child = ownerSessionIdFromCorrId(row.correlationId) ?? row.sessionId;
      if (typeof parent === 'string' && parent && parent !== child) {
        state.collectorParentByChildSession.set(child, parent);
      }
    }
  }

  // Parent-keyed chat-row COPIES carry the authoritative #523 stamp pair —
  // record the child→parent edge from the typed columns (KeepFirst merge
  // preserves the stamp through every later patch).
  for (const row of chatRows) {
    if (row.compositedChildSessionId !== null) {
      const parent = row.parentSessionId ?? row.sessionId;
      if (parent !== row.compositedChildSessionId) {
        state.collectorParentByChildSession.set(row.compositedChildSessionId, parent);
      }
    }
  }

  return state;
}
