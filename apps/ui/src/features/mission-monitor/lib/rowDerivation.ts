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

// ── Spec #2795: the SINGLE shared renderability rule ──────────────────────────
// The graph's node-emission gates (below) and the session-list qualification
// predicate (`deriveRenderableSessions`) consume the SAME pure rule — so the
// sidebar and the canvas structurally cannot disagree about whether a session
// qualifies (AC3). The graph hook (`useMissionMonitor.ts`) imports these from
// HERE; the predicate lives here too.

/** #2745 R-4 (AC-4): internal opencode tool-execution agents. Their `task`
 *  dispatches are spawned internally to execute tool calls in sub-sessions and
 *  are NOT user-requested @-subagent dispatches — they create NO SubagentNode
 *  AND no embedded tool item. `build` is live-confirmed; `plan` is
 *  plan-specified. Keyed on the SAME parsed name field the node displays
 *  (`subagent_type`). */
export const INTERNAL_TOOL_EXECUTION_AGENTS = ['build', 'plan'];

/**
 * #2750 AC4 (ST-5): a "transitional turn" — a chat-node entry that reached
 * completion (complete/compacted) with an EMPTY agentReply. These are the
 * parent session's own dispatch turns (the LLM turn ended on tool-calls): they
 * carry thinking text but no real response, so the graph must NOT emit a chat
 * node for them — the following reply turn (same user message) is the visible
 * node. In-progress/active text-less turns are NOT transitional: they render
 * with the loading indicator (AC4-3). NFR-5: suppression is EMISSION-only —
 * the entry stays in agentNodes/nodeOrder so a later reply can surface it.
 */
export function isTransitionalTurn(entry: {
  status: GraphNodeStatus;
  payload: { agentReply?: string };
}): boolean {
  // AC4 ST-5: a "transitional turn" reached completion with an EMPTY agentReply
  // — the LLM turn ended on tool-calls, so the graph must NOT emit a chat node
  // for it. `agentReply` is treated as empty when it is absent OR whitespace-
  // only: opencode's dispatch turn emits a whitespace-only assistant message
  // (`"\n\n"`) before the tool call, which the ingest pipeline injects verbatim —
  // a real response is never pure whitespace, so trimming is safe (a text-less
  // turn is by definition not a visible reply).
  return (
    (entry.status === 'complete' || entry.status === 'compacted') &&
    !entry.payload.agentReply?.trim()
  );
}

/**
 * #2750 AC4 (ST-5): visible-anchor resolution — ONE O(N) pass over
 * `agentOrder` with Set/Map lookups (NFR-2). For every VISIBLE (selected-
 * session) chat node:
 * - `chainPredecessor[corrId]` = the nearest PRECEDING non-transitional
 *   visible agent ('' when none) — the chat-chain edge source for the node.
 * - `visibleNonTransitional` = the emitted (non-suppressed) agent corrIds.
 * Non-transitional entries are themselves the anchor their children
 * (SubagentNode edges + companion-column layout) attach to;
 * transitional entries' children attach to the same chain predecessor.
 *
 * #2750 round-6 (AC4-2): a suppressed transitional turn that is the session's
 * FIRST chat node has NO PRECEDING visible agent (chainPredecessor is '') —
 * e.g. the very common "Use a subagent to …" first message. Its children must
 * STILL render exactly one SubagentNode per dispatch (NFR-5: suppression is
 * chat-node emission only, never the SubagentNode). The second backward pass
 * re-anchors such anchorless transitional turns to the NEXT visible
 * non-transitional node of the session (the reply turn that completes the
 * exchange), so the SubagentNode emission gate sees a rendered anchor.
 */
export function buildVisibleAnchors(
  agentOrder: string[],
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus }>,
  visibleAgentCorrs: Set<string>,
): { chainPredecessor: Map<string, string>; visibleNonTransitional: Set<string> } {
  const chainPredecessor = new Map<string, string>();
  const visibleNonTransitional = new Set<string>();
  let lastVisible: string | null = null;
  for (const corrId of agentOrder) {
    if (!visibleAgentCorrs.has(corrId)) continue;
    const entry = agentNodes.get(corrId);
    if (!entry) continue;
    chainPredecessor.set(corrId, lastVisible ?? '');
    if (isTransitionalTurn(entry)) continue;
    visibleNonTransitional.add(corrId);
    lastVisible = corrId;
  }

  // Backward pass: transitional (suppressed dispatch) turns re-anchor to the
  // NEXT visible non-transitional node of the session — the reply turn that
  // completes the exchange.
  let nextVisible: string | null = null;
  for (let i = agentOrder.length - 1; i >= 0; i--) {
    const corrId = agentOrder[i];
    if (!visibleAgentCorrs.has(corrId)) continue;
    const entry = agentNodes.get(corrId);
    if (!entry) continue;
    if (isTransitionalTurn(entry)) {
      const nextEntry = nextVisible ? agentNodes.get(nextVisible) : undefined;
      const sameExchangeReply = !!(
        nextEntry &&
        nextEntry.payload.userMessage &&
        entry.payload.userMessage &&
        nextEntry.payload.userMessage === entry.payload.userMessage
      );
      if (sameExchangeReply) {
        chainPredecessor.set(corrId, nextVisible!);
      } else if (!chainPredecessor.get(corrId) && nextVisible) {
        chainPredecessor.set(corrId, nextVisible);
      }
      continue;
    }
    nextVisible = corrId;
  }

  return { chainPredecessor, visibleNonTransitional };
}

/**
 * #2750 AC4 (ST-5): the visible node a parent's children (SubagentNode /
 * layout + companion columns, #2764: also embedded tools) attach to — the
 * parent itself when it is a non-transitional visible chat node, else its
 * chain predecessor. '' means "no anchor" (the parent is a suppressed
 * transitional turn with no preceding visible node — the child is not emitted).
 */
export function resolveChildAnchor(
  parentCorrId: string,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
): string {
  if (visibleNonTransitional.has(parentCorrId)) return parentCorrId;
  return chainPredecessor.get(parentCorrId) ?? '';
}

/**
 * UX (flash fix): companion-node (SubagentNode) emission + anchor resolution.
 * A live tool row often lands BEFORE its dispatch turn (the tool span ends
 * before the dispatch chat span closes) and before the dispatch's same-exchange
 * reply — so on early row batches the time-window parent resolution and the
 * anchor resolution are both PROVISIONAL. The node is emitted only when its
 * anchor is FINAL: the parent is a visible non-transitional chat node (anchor =
 * the parent), OR the anchor is the parent's SAME-EXCHANGE reply (both carry
 * the same non-empty userMessage). It is PROVISIONAL (node HELD) when the
 * parent is a suppressed transitional turn and the anchor is merely a preceding
 * visible node. `allowAnchorlessBelt` is true ONLY for the SubagentNode path:
 * when there is NO visible anchor at all (anchorless — every turn so far
 * suppressed) but the parent chat node exists in the selected session, the
 * dispatch is still emitted so a user-requested subagent is never dropped.
 */
export function resolveCompanionEmission(
  parentCorrId: string,
  allowAnchorlessBelt: boolean,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus }>,
): { emit: boolean; anchorCorrId: string } {
  const anchorCorrId = resolveChildAnchor(parentCorrId, chainPredecessor, visibleNonTransitional);
  if (visibleNonTransitional.has(parentCorrId)) return { emit: true, anchorCorrId };
  if (anchorCorrId) {
    const parentEntry = agentNodes.get(parentCorrId);
    const anchorEntry = agentNodes.get(anchorCorrId);
    const isSameExchangeReply = !!(
      parentEntry && anchorEntry &&
      parentEntry.payload.userMessage &&
      anchorEntry.payload.userMessage &&
      anchorEntry.payload.userMessage === parentEntry.payload.userMessage
    );
    return { emit: isSameExchangeReply, anchorCorrId };
  }
  return { emit: allowAnchorlessBelt, anchorCorrId };
}

/**
 * Spec #2795 REQ-2/REQ-3/REQ-4: derive the set of sessionIds for which the
 * graph renders ≥1 node — the SINGLE list-qualification rule. The panel feeds
 * this to `useDeliverySessions` (list inclusion) and the graph consumes the
 * SAME emission helpers it is built from (chat-node `visibleNonTransitional`
 * gate via `isTransitionalTurn`, plus the round-6 subagent belt when a
 * user-requested dispatch's parent chat row exists in the session), so the
 * sidebar and canvas structurally cannot disagree (AC3).
 *
 * A session is RENDERABLE iff:
 *  - it owns ≥1 NON-transitional chat node (the exact `visibleNonTransitional`
 *    gate the graph applies per session), OR
 *  - it owns a user-requested (non-`build`/`plan`) subagent dispatch whose
 *    parent chat row exists in the session (the round-6 belt emits even when
 *    every chat turn is text-less/suppressed — a just-started or
 *    dispatch-only transient).
 *
 * Dispatches are read from the RAW builder state (`toolCallsBySession` — the
 * session's own `task` tool calls) because the association pass that turns a
 * dispatch into a `SubagentNode` runs only inside the graph hook; the panel's
 * derivation is the pure row projection.
 *
 * An in-progress/active text-less row is NOT transitional (`isTransitionalTurn`
 * only matches complete/compacted + empty reply), so a just-started real
 * session is renderable from its first own row (AC4). This must be recomputed
 * on the row-store epoch by the caller (never cached on a mount snapshot).
 */
export function deriveRenderableSessions(state: GraphBuilderState): Set<string> {
  const renderable = new Set<string>();
  const sessionsWithChatNodes = new Set<string>();

  // Pass 1: sessions owning ≥1 non-transitional chat node — the graph's
  // per-session `visibleNonTransitional` gate, applied directly. Also collects
  // every session that owns a chat node at all (the Pass-2 parent precondition).
  for (const entry of state.agentNodes.values()) {
    sessionsWithChatNodes.add(entry.payload.sessionId);
    if (isTransitionalTurn(entry)) continue;
    renderable.add(entry.payload.sessionId);
  }

  // Pass 2: sessions owning a user-requested (non-internal) subagent dispatch
  // whose parent chat row exists in the session. `toolCallsBySession[sid]`
  // holds the session's OWN `task` calls (a parent dispatch turn is a
  // non-subagent row); internal `build`/`plan` tool-execution dispatches create
  // no SubagentNode and are excluded.
  for (const [sid, calls] of state.toolCallsBySession) {
    if (renderable.has(sid)) continue;
    if (!sessionsWithChatNodes.has(sid)) continue;
    for (const call of calls.values()) {
      if (call.toolName !== 'task') continue;
      const name = taskDispatchName(call.input);
      if (INTERNAL_TOOL_EXECUTION_AGENTS.includes(name)) continue;
      renderable.add(sid);
      break;
    }
  }

  return renderable;
}

/** Convenience per-session form of `deriveRenderableSessions` (used by tests
 *  and any per-session gate). */
export function sessionEmitsNodes(state: GraphBuilderState, sessionId: string): boolean {
  return deriveRenderableSessions(state).has(sessionId);
}

/** #2745 ST-4: the subagent name key (`subagent_type`, falling back to `agent`)
 *  parsed from a task tool call's arguments JSON — the SAME name field the
 *  SubagentNode displays. Used by `deriveRenderableSessions` to exclude internal
 *  (`build`/`plan`) tool-execution dispatches. */
function taskDispatchName(input: string): string {
  if (!input) return 'Subagent';
  try {
    const parsed = JSON.parse(input) as unknown;
    const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, any>;
    return typeof record.subagent_type === 'string'
      ? record.subagent_type
      : typeof record.agent === 'string'
        ? record.agent
        : 'Subagent';
  } catch {
    return 'Subagent';
  }
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
