/**
 * Mission Monitor Graph — ECE Delivery-Driven Types.
 *
 * Shared types, empty-state jokes, delivery-verification helpers, and node
 * color palettes for the Mission Monitor graph. All capsules in Spec #318
 * implement against these types.
 *
 * Capsule A defines shared types + empty state.
 * Capsule B builds graph nodes/edges from deliveries.
 * Capsule C renders Agent + Subagent nodes.
 * Capsule D renders Tool + File nodes + edge styles.
 * Capsule E builds the session sidebar.
 * Capsule F builds the detail panel.
 */

import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import type { MonitorNodeData } from '../types';

/** Session-level counters displayed in panel header badges. */
export interface SessionCounters {
  tools: number;
  files: number;
  subagents: number;
  tokens: number;
}

/**
 * Format a token count for display.
 *
 * - < 1 000  → raw number (e.g., "420", "0")
 * - ≥ 1 000  → comma thousands separators, locale pinned to en-US
 *   (e.g., 1840 → "1,840", 2500000 → "2,500,000")
 *
 * 0 → "0"; 999 → "999"; 1_000 → "1,000"; 1_234 → "1,234"; 1_234_567 → "1,234,567"
 */
export function formatTokenCount(n: number): string {
  return n < 1_000 ? String(n) : n.toLocaleString('en-US');
}

/**
 * Zero/absent token guard (Spec #2717 R-3.3).
 *
 * A token category that is absent from a payload, or carries a non-finite or
 * negative figure, renders as `0` — never NaN, never negative, never a
 * mislabeled figure. The plugin skips usage attrs ≤ 0 on the wire, so "absent"
 * and "reported zero" are wire-indistinguishable; this guard converges both to 0.
 * `v + 0` also normalizes `-0` to `+0` (Object.is(-0, 0) is false — a `-0`
 * figure would otherwise render as "0" but compare unequal in tests).
 */
export function normalizeTokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v + 0 : 0;
}

/**
 * Zero/absent cost guard — mirrors `normalizeTokenCount` for dollar figures
 * (#2743 ST-1 / AC-12). A cost figure that is absent, non-finite, or negative
 * sums as 0 — never NaN, never negative. `v + 0` normalizes `-0` to `+0`.
 */
export function normalizeCost(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v + 0 : 0;
}

/**
 * Format a per-tool duration for display (#2743 ST-5 / AC-10).
 *
 * `duration_ms` first (the delivered telemetry attribute); falls back to the
 * `startTime`/`endTime` delta for restored/legacy deliveries; returns `—` when
 * neither is available (or the delta is unusable/negative). Sub-second → ms,
 * ≥1s → one-decimal seconds (`1.2s`, `450ms`), ≥1min → `M m S s`. Deterministic
 * — never `Date.now()` (a render-time clock would produce unstable output and
 * stale figures for in-progress calls; the in-progress state is communicated by
 * the AC-9 indicator instead).
 */
export function formatToolDuration(durationMs?: number, startTime?: string, endTime?: string): string {
  let ms: number;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    ms = durationMs;
  } else if (startTime && endTime) {
    ms = Date.parse(endTime) - Date.parse(startTime);
  } else {
    return '—';
  }
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Formats a subagent's raw final output (`gen_ai.tool.call.result`) for
 * display: strips the angle-bracket CONTROL tags opencode embeds (e.g.
 * `<SystemReminder>`, `<prefix>`, `<copilotReadonly>`…) while PRESERVING their
 * inner text, normalizes `<br>` variants to line breaks, and collapses
 * whitespace noise. The content is the signal; the tag chrome is not
 * user-friendly. NOTE: this is a pragmatic formatter — the UI/UX design pass
 * owns the final visual treatment (per the human's routing).
 */
export function formatSubagentOutput(raw: string): string {
  return (raw ?? '')
    .replace(/<\s*br[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Derive a tool call's outcome for display (#2743 ST-5/ST-6 — AC-9/AC-8).
 *
 * The single shared definition both the ToolsNode accordion indicator (ST-5)
 * and the DetailPanel scoped status row (ST-6) consume, so the two surfaces
 * can never drift:
 * - `error` — `error` text present or `success === false` (the tool failed).
 * - `in-progress` — no outcome yet AND the span has not ended (no `endTime`).
 * - `success` — otherwise. A tool without an error marker renders as
 *   succeeded (the AC-9 letter / UI-UI default).
 */
export function getToolCallOutcome(call: ToolCallSummary): 'error' | 'in-progress' | 'success' {
  const hasError = (typeof call.error === 'string' && call.error !== '') || call.success === false;
  if (hasError) return 'error';
  if (call.success !== true && !call.endTime) return 'in-progress';
  return 'success';
}

/**
 * Compact token count for single-line node display (Spec #2723 R-2 / AC2).
 *
 * Display-only abbreviation used by the ChatNode compact token row so the five
 * categories fit on one line at 280px node widths:
 * - < 1,000     → raw ("0", "340")
 * - 1,000–9,999 → "1.2k" (one decimal; a trailing ".0" drops → "1k")
 * - ≥ 10,000    → "85k" (no decimal, rounded)
 *
 * This is NEVER used in an aria-label — every figure's aria-label must carry
 * the full comma-formatted number from `formatTokenCount()` (QA Q-2.1).
 */
export function formatCompactTokenCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1_000) + 'k';
}

// ═══════════════════════════════════════════════════════════════════════════
// ECE DELIVERY-DRIVEN TYPES — Canonical contract for Spec #318
// ═══════════════════════════════════════════════════════════════════════════

/** A session extracted from deliveries — no localStorage. */
export interface MissionMonitorSession {
  sessionId: string;
  label: string;
  startTime: number;
  latestTimestamp: string;
  deliveryCount: number;
  /** #2748 ST-2 (R-1): first user chat message captured at persist time (restart survival). */
  derivedName?: string;
  /** #2748 ST-2 (R-2): user-renamed label — authoritative over derivedName. */
  customName?: string;
}

/** Node types for the ReactFlow graph. #2745 ST-4 (AC-5): the dead `tool`/`file`
 *  variants are removed (their builder paths + components were never live). */
export type GraphNodeType = 'agent' | 'subagent' | 'tools';

/** Node status — derived from ContractDelivery lifecycle. */
export type GraphNodeStatus = 'in-progress' | 'active' | 'complete' | 'error' | 'compacted';

/** Payload carried by AgentNode — extracted from ContractDelivery payload. */
export interface AgentNodePayload {
  agent?: string;
  model?: string;
  userMessage: string;
  agentThinking: string;
  agentReply: string;
  promptTokens: number;      // per-turn Δinput (delta of cumulative input_tokens)
  completionTokens: number;  // per-turn output
  reasoningTokens: number;   // per-turn gen_ai.usage.reasoning.output_tokens (default 0)
  // Spec #2723 ST-3 (H1): per-turn Δcache_read (delta of the session-cumulative
  // gen_ai.usage.cache_read.input_tokens) — "Cache" category (default 0). Never
  // the raw cumulative total (raw would make node N's Cache = Σ cache turns
  // 1..N — literal cross-node contamination).
  cacheReadTokens: number;   // per-turn Δcache_read — "Cache" category (default 0)
  cacheWriteTokens: number;  // per-turn gen_ai.usage.cache_creation.input_tokens — carried, NEVER summed (default 0)
  totalTokens: number;       // promptTokens + cacheReadTokens + reasoningTokens + completionTokens
  // #2743 ST-1 (AC-12): the exchange's estimated cost from the LLM span's
  // `cost_usd` flat attr (message.ts:185). Optional — restored/legacy
  // deliveries degrade to absent; consumers render their absent-state.
  costUsd?: number;          // normalizeCost(p.cost_usd) — per-turn, from the llm span
  startTime?: string;
  endTime?: string;
  correlationId: string;
  sessionId: string;
}

/** Payload carried by SubagentNode. #2745 ST-4 (R-1): the RICH node payload —
 *  the parent's `task` dispatch intent (name/instruction/output from the parsed
 *  args + the child's final output) plus the AC-2 child-completion fields
 *  (childSessionId/childAgent/childTokens/childCost/childMessages — projected
 *  by the ST-3 adapter from the plugin's fredo-native flat attrs onto canonical
 *  payload keys). Every child field is OPTIONAL: absent until the child
 *  completes (and until ST-3 lands); absent stays absent so consumers render
 *  their documented absent-state, never a phantom zero. */
export interface SubagentNodePayload {
  /** Parsed task-args name key: `subagent_type` ?? `agent` (ST-1-pinned) —
   *  fallback 'Subagent'. */
  name: string;
  /** Parsed task-args instruction key: `prompt` ?? `description` ?? `task` ??
   *  `instruction` (ST-1-pinned). */
  instruction: string;
  /** payload['output'] = gen_ai.tool.call.result — the child's final output. */
  output: string;
  /** payload['duration_ms'] — the task span duration (fallback for ST-5:
   *  Date.parse(endTime) − Date.parse(startTime) via formatToolDuration). */
  durationMs?: number;
  /** payload['startTime'] — the task span start (RFC3339). */
  startTime?: string;
  /** payload['endTime'] — the task span end (RFC3339). */
  endTime?: string;
  /** AC-2 — payload['childSessionId'] (ST-3 projection of child_session_id). */
  childSessionId?: string;
  /** AC-2 — payload['childAgent'] (child_agent). */
  childAgent?: string;
  /** AC-2 — payload['childTokens'] (child_total_tokens; normalizeTokenCount-
   *  guarded in the builder, absent stays absent). */
  childTokens?: number;
  /** AC-2 — payload['childCost'] (child_total_cost_usd; normalizeCost-guarded,
   *  absent stays absent). */
  childCost?: number;
  /** AC-2 — payload['childMessages'] (child_total_messages; count-guarded). */
  childMessages?: number;
  /** AC-2 follow-up — per-family token breakdown (child_input_/child_cache_read_/
   *  child_reasoning_/child_output_tokens → childInputTokens/… camelCase). The
   *  SubagentNode five-way row; cache WRITE is carried by the plugin but never
   *  displayed (ChatNode cacheWrite contract). */
  childInputTokens?: number;
  childCacheReadTokens?: number;
  childReasoningTokens?: number;
  childOutputTokens?: number;
  parentCorrelationId: string;
  /** The task dispatch's own correlationId. */
  correlationId: string;
  /** The PARENT session. */
  sessionId: string;
}

/**
 * One tool call of a chat exchange — one accordion item in the ToolsNode.
 * #2739 API contract 3 (ST-1).
 */
export interface ToolCallSummary {
  toolName: string;            // payload['gen_ai.tool.name'] ?? payload['tool_name'] ?? 'unknown'
  input: string;               // payload['input']  (arguments JSON string)
  output: string;              // payload['output'] (result text)
  // per-call tokens — zero-guarded (NFR-1 / Architect D-1); opencode tool spans
  // carry no gen_ai.usage.* → these render 0, byte-equal to telemetry absence.
  inputTokens: number;         // normalizeTokenCount(payload.promptTokens)
  reasoningTokens: number;     // normalizeTokenCount(payload.reasoningTokens)
  outputTokens: number;        // normalizeTokenCount(payload.completionTokens)
  totalTokens: number;         // input + reasoning + output (cache excluded — session-scoped, G-023)
  correlationId: string;       // deliveryCorrelationId(d) — the tool span's own id
  startTime?: string;          // payload['startTime'] (RFC3339; delivery-timestamp fallback)
  endTime?: string;            // payload['endTime']
  // #2743 ST-1 (AC-9/AC-10): per-tool outcome + duration from the tool span's
  // flat attrs. `tool.success` / `tool.error` are LITERAL-dot payload keys (the
  // dot in the name makes them un-declarable as ECE streamFields — read from
  // the whole payload in upsertToolCallSummary). All optional: restored/legacy
  // deliveries degrade to neutral (a call with no error renders as succeeded;
  // no duration renders '—').
  success?: boolean;           // p['tool.success'] — bool from the tool span (message.ts:545)
  error?: string;              // p['tool.error'] — failure text ONLY (message.ts:556); undefined ⇒ no failure
  durationMs?: number;         // p['duration_ms'] — span ms (message.ts:546); fallback: Date.parse(endTime)-Date.parse(startTime)
  // #2745 ST-4 (R-2): child-completion fields carried on the `task` tool call
  // from the delivery's canonical payload keys (ST-3 adapter projection of the
  // plugin's fredo-native flat child_* attrs). Optional + last-wins like
  // input/output — absent until the child completes (and until ST-3 lands).
  childSessionId?: string;     // p['childSessionId']
  childAgent?: string;         // p['childAgent']
  childTokens?: number;        // p['childTokens']  (normalizeTokenCount-guarded)
  childCost?: number;          // p['childCost']    (normalizeCost-guarded)
  childMessages?: number;      // p['childMessages'] (count-guarded)
  // Per-family token breakdown (childInputTokens/childCacheReadTokens/
  // childReasoningTokens/childOutputTokens) — the SubagentNode five-way row.
  childInputTokens?: number;
  childCacheReadTokens?: number;
  childReasoningTokens?: number;
  childOutputTokens?: number;
}

/**
 * Payload carried by the ToolsNode (one per chat node, lazily created on the
 * first resolved tool call — R-5). #2739 API contract 3 (ST-1).
 */
export interface ToolsNodePayload {
  toolCalls: ToolCallSummary[];        // arrival-ordered (by startTime), one per call
  parentCorrelationId: string;         // the chat node's correlationId
  correlationId: string;               // synthetic: `tools-<parentCorrelationId>`
  sessionId: string;
}

/** Union type for all node payloads. */
export type GraphNodePayload = AgentNodePayload | SubagentNodePayload | ToolsNodePayload;

/** Edge types for the ReactFlow graph. */
export type GraphEdgeType = 'parent' | 'calls' | 'reads' | 'writes' | 'chat' | 'tools';

/** ReactFlow-compatible graph node. */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  status: GraphNodeStatus;
  payload: GraphNodePayload;
  label: string;
  timestamp: string;
}

/** ReactFlow-compatible graph edge. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
}

/**
 * #2743 ST-6 (AC-7/AC-8): the detail-panel open-target union.
 *
 * - `{ kind: 'node'; data }` — the existing node detail view. Opened by
 *   ReactFlow's `onNodeDoubleClick` only (AC-7: single-click NEVER opens).
 * - `{ kind: 'tool-call'; call; sessionId }` — the scoped per-tool detail
 *   (AC-8). Opened by double-clicking a ToolsNode accordion item (with
 *   stopPropagation so the node detail is never also opened). Renders THAT
 *   call's own input/output/outcome/duration — never a generic all-tools view.
 */
export type DetailOpenTarget =
  | { kind: 'node'; data: MonitorNodeData }
  | { kind: 'tool-call'; call: ToolCallSummary; sessionId: string };

// ═══════════════════════════════════════════════════════════════════════════
// EMPTY STATE JOKES
// ═══════════════════════════════════════════════════════════════════════════

export const EMPTY_STATE_JOKES = [
  "I asked my AI to organize my desktop. It created 47 folders named 'Stuff' and called it a day.",
  "My agent said it had 'one small question' — 847 messages later, we're still debugging a semicolon.",
  "The AI promised to refactor my codebase. It replaced every function with a comment that says '// TODO: implement' — truly, an artist.",
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY VERIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Verify a ContractDelivery matches the chat-node contract. */
export function isChatNodeDelivery(d: ContractDelivery): boolean {
  return d.contractName === 'chat-node';
}

/** Extract session ID from a ContractDelivery. */
export function deliverySessionId(d: ContractDelivery): string {
  return d.key?.sessionId ?? 'unknown';
}

/** Extract correlation ID from a ContractDelivery. */
export function deliveryCorrelationId(d: ContractDelivery): string {

  return d.key?.correlationId ?? d.id;
}

/**
 * Extract the inner payload from a ContractDelivery.
 * The ECE payload has 2-level nesting — delivery.payload['payload'] gets the inner data.
 *
 * Spec #555 (Compaction AC-7): Diagnostic logging to surface when the 'payload'
 * stream field is missing from the ECE delivery's outer payload. The inner
 * payload (delivery.payload['payload']) should contain the event's raw payload
 * object (e.g. `{compacted: true}`). When it's absent, log the available keys
 * and fall back to the full outer payload.
 */
export function extractDeliveryPayload(d: ContractDelivery): Record<string, unknown> {
  const inner = d.payload?.['payload'] as Record<string, unknown> | undefined;

  // Spec #555: Diagnostic — log when the inner payload is missing or empty
  // to help debug AC-7 compaction delivery issues.
  if (d.contractName === 'chat-node' && d.lifecycle === 'end') {
    const outerKeys = d.payload ? Object.keys(d.payload) : [];
    const hasInner = inner !== undefined && inner !== null && typeof inner === 'object' && Object.keys(inner).length > 0;
    if (!hasInner) {
      console.debug(
        '[extractDeliveryPayload] ECE delivery missing inner payload',
        `contractName=${d.contractName}`,
        `lifecycle=${d.lifecycle}`,
        `outerKeys=[${outerKeys.join(',')}]`,
        `inner=${inner === undefined ? 'undefined' : inner === null ? 'null' : JSON.stringify(inner)}`,
        `correlationId=${d.key?.correlationId ?? 'N/A'}`,
        `sessionId=${d.key?.sessionId ?? 'N/A'}`,
      );
    }
  }

  return inner ?? d.payload ?? {};
}

// -- Status colors ------------------------------------------------------------

export const GRAPH_STATUS_COLORS: Record<GraphNodeStatus, string> = {
  'in-progress': '#a855f7', // purple
  'active':       '#6366f1', // indigo
  'complete':     '#334155', // muted
  'error':        '#ef4444', // red
  'compacted':    '#475569', // slate
};

export const GRAPH_NODE_BORDER_COLORS: Record<GraphNodeType, string> = {
  agent:    '#a855f7', // purple
  subagent: '#6366f1', // indigo
  tools:    '#f97316', // orange — the #2739 tool-summary accent
};
