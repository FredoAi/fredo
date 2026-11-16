/**
 * counters.ts — Session counter computation for Mission Monitor.
 *
 * Spec #2788 P4.2: the session bottom-bar aggregation derives from typed
 * RTDB chat rows (`useEventRows('Chat')`) instead of v1 ContractDelivery
 * streams. The row store's own per-key last-wins merge makes the v1
 * "last lifecycle delivery per composite key" dedupe redundant — there is
 * exactly ONE row per (sessionId, correlationId) — and the
 * `compositedChildSessionId` column replaces the v1 outer-payload stamp
 * exclusion (child/subagent rows never leak into the parent total).
 */
import { rawPayload } from './rowDerivation';
import type { SessionCounters } from './graph';
import { normalizeTokenCount, normalizeCost } from './graph';
import type { ChatRow } from '../../../shared/classes/EventSubscription';

/**
 * Shared session-scoped chat-row collection — the single definition of the
 * aggregation rule all session-total functions reuse:
 * rows keyed under `sessionId` whose `compositedChildSessionId` column is
 * `null` (the #523 re-key stamp marks child contributions — excluded, the
 * same signal the graph builder uses to keep child tokens out of the parent
 * node set).
 */
function collectSessionChatRows(chatRows: ChatRow[], sessionId: string): ChatRow[] {
  return chatRows.filter(
    (row) => row.sessionId === sessionId && row.compositedChildSessionId === null,
  );
}

/**
 * Session metrics for the Total Top Bar (#2743 ST-1 / AC-12) — the token
 * totals plus the session's estimated cost and message count, derived from
 * the chat rows the bar already consumes.
 *
 * Token families (BILLED semantics — DeepSeek platform reconciliation, the
 * same rule the v1 delivery path applied): each family prefers the RAW
 * per-request value the provider reported per inference call (preserved
 * verbatim in the row's `rawJson` escape hatch), falling back to the typed
 * per-turn delta when the raw key is absent:
 *   INPUT     ← rawJson.input_tokens ?? promptTokens
 *   CACHE     ← rawJson.cache_read_tokens ?? cacheReadTokens
 *   REASONING ← rawJson.reasoning_tokens ?? rawJson.reasoningTokens
 *   OUTPUT    ← rawJson.output_tokens ?? completionTokens
 * `cacheWriteTokens` (rawJson.cache_creation_tokens) is carried but NEVER
 * summed (Architect binding G-023).
 *
 * @param chatRows  - The live chat row map values (any order).
 * @param sessionId - The selected session id ('' → empty metrics).
 */
export function computeSessionTokenTotals(
  chatRows: ChatRow[],
  sessionId: string,
): SessionTokenTotals {
  const rows = collectSessionChatRows(chatRows, sessionId);

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let outputTokens = 0;
  let cacheFallbackCount = 0;

  for (const row of rows) {
    const raw = rawPayload(row);
    // Billed semantics: prefer the raw per-request flat attr (preserved in
    // rawJson by the ingest projector), fall back to the typed per-turn delta.
    const rawCacheRead = raw['cache_read_tokens'];
    if (rawCacheRead === undefined && row.cacheReadTokens !== null && row.cacheReadTokens !== 0) {
      cacheFallbackCount++;
    }
    // Zero-guard — the same normalizeTokenCount the node path uses, so an
    // absent or non-numeric category sums as 0 on every surface.
    inputTokens += normalizeTokenCount(raw['input_tokens'] ?? row.promptTokens);
    cacheReadTokens += normalizeTokenCount(rawCacheRead ?? row.cacheReadTokens);
    cacheWriteTokens += normalizeTokenCount(raw['cache_creation_tokens'] ?? raw.cacheWriteTokens);
    reasoningTokens += normalizeTokenCount(raw['reasoning_tokens'] ?? raw.reasoningTokens);
    outputTokens += normalizeTokenCount(raw['output_tokens'] ?? row.completionTokens);
  }

  // R-3.1: Total = Input + Cache + Reasoning + Output exactly. cacheWrite is
  // carried in the struct but NEVER summed into any displayed figure (G-023).
  const totalTokens = inputTokens + cacheReadTokens + reasoningTokens + outputTokens;

  // ── ST-3 (#2734): reconciliation guard (diagnostic, warn-only) ─────────────
  // A cache-bearing row that lacks the raw per-request cache_read_tokens key
  // falls back to its per-turn delta, under-stating the billed figure. Warn
  // so an ingest regression surfaces before the live tester does. NEVER a
  // silent correction.
  if (cacheReadTokens > 0 && cacheFallbackCount > 0) {
    console.warn(
      `[mission-monitor] cache reconciliation fallback (session ${sessionId}): ` +
        `${cacheFallbackCount} chat row(s) carried the derived per-turn cache ` +
        `delta WITHOUT the raw per-request cache_read_tokens flat key — the session ` +
        `CACHE total (${cacheReadTokens}) may under-state the provider's billed ` +
        `cache-hit figure. This likely indicates an ingest regression.`,
    );
  }

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    outputTokens,
    totalTokens,
  };
}

/**
 * Compute the session's Total Top Bar metrics (#2743 ST-1 / AC-12): the
 * five-way token totals PLUS the estimated cost and total message count.
 *
 * Aggregation reuses the EXACT session-scoped, non-composited row set as
 * `computeSessionTokenTotals`, so the cost/message figures share the same
 * node-set semantics as the token figures: Σ per-row `costUsd` (the typed
 * per-turn cost column) telescopes to the session cost exactly as Σ per-turn
 * token deltas do; TOTAL MESSAGES = the number of qualifying rows (one per
 * distinct chat key — the row store's PK guarantees the dedupe).
 */
export function computeSessionMetrics(
  chatRows: ChatRow[],
  sessionId: string,
): SessionMetrics {
  const tokenTotals = computeSessionTokenTotals(chatRows, sessionId);
  const rows = collectSessionChatRows(chatRows, sessionId);

  let totalCostUsd = 0;
  for (const row of rows) {
    // normalizeCost: absent/NaN/negative → 0 (a delivered $0.00 counts as 0
    // but the row still counts toward totalMessages — never a hardcoded figure).
    totalCostUsd += normalizeCost(row.costUsd);
  }

  return {
    ...tokenTotals,
    totalCostUsd,
    totalMessages: rows.length,
  };
}

/**
 * Bottom-bar data model — per-category session totals (Spec #2717 R-1).
 *
 * `cacheWriteTokens` is carried in the struct but NEVER summed into any
 * displayed figure or Total (Architect binding G-023): the "Cache" category
 * = `cacheReadTokens` only.
 */
export interface SessionTokenTotals {
  inputTokens: number;      // Σ per-row promptTokens (per-turn Δinput)
  cacheReadTokens: number;  // Σ per-row cacheReadTokens ("Cache" category)
  cacheWriteTokens: number; // Σ per-row cacheWriteTokens (carried, not in the five-way)
  reasoningTokens: number;  // Σ per-row reasoningTokens
  outputTokens: number;     // Σ per-row completionTokens
  totalTokens: number;      // input + cacheRead + reasoning + output (R-3.1)
}

/**
 * Session metrics for the Total Top Bar (#2743 ST-1 / AC-12) — the token
 * totals plus the session's estimated cost and message count.
 */
export interface SessionMetrics extends SessionTokenTotals {
  totalCostUsd: number;   // Σ normalizeCost(row.costUsd) over session chat rows
  totalMessages: number;  // count of session-scoped, non-composited chat rows
}
