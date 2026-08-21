/**
 * counters.ts — Session counter computation for Mission Monitor (delivery-driven).
 *
 * REQ-9 through REQ-11: Pure function that computes running totals
 * for tools, files, subagents, and tokens from ContractDelivery[].
 * Spec #2717: `computeSessionTokenTotals` — the five-way session bottom-bar
 * aggregation (R-3.1 / R-3.2 / R-3.3).
 */
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import type { SessionCounters } from './graph';
import {
  isChatNodeDelivery,
  extractDeliveryPayload,
  deliverySessionId,
  deliveryCorrelationId,
  normalizeTokenCount,
  normalizeCost,
} from './graph';

/**
 * Compute session-level counters from all deliveries for a session.
 *
 * Tools:   count of tool entries in payload.tools array
 * Files:   count of file entries in payload.tools[].files array
 * Subagents: count of subagent entries in payload.subagents array
 * Tokens:  sum of promptTokens + completionTokens from AgentNodePayload
 *
 * @param deliveries - All deliveries for a session (unsorted)
 * @returns SessionCounters with running totals
 */
export function computeSessionCounters(deliveries: ContractDelivery[]): SessionCounters {
  const toolNames = new Set<string>();
  const filePaths = new Set<string>();
  const subagentNames = new Set<string>();
  let totalTokens = 0;

  for (const d of deliveries) {
    if (!isChatNodeDelivery(d)) continue;
    const p = extractDeliveryPayload(d);

    // Subagents — single canonical path: sa.name
    const subagents = (p.subagents as any[]) ?? [];
    for (const sa of subagents) {
      const name = sa.name;
      if (name) subagentNames.add(name);
    }

    // Tools — single canonical path: t.name
    const tools = (p.tools as any[]) ?? [];
    for (const t of tools) {
      const name = t.name;
      if (name) toolNames.add(name);
    }

    // Files (nested under tools) — single canonical path: f.path
    for (const t of tools) {
      const files = (t.files as any[]) ?? [];
      for (const f of files) {
        const path = f.path;
        if (path) filePaths.add(path);
      }
    }

    // Tokens — single canonical paths: p.promptTokens / p.completionTokens
    //
    // Spec #2711 semantic change: the OTLP adapter now injects promptTokens as
    // the per-message DELTA of the cumulative `gen_ai.usage.input_tokens`
    // (Δinput per turn) and completionTokens as that turn's own output, so the
    // session badge below sums Σ(Δinput + output). The deltas telescope:
    // Σ promptTokens = input(n) (the last cumulative input), making the badge
    // total exactly input(n) + Σ output — a correct, previously-inflated
    // session total (the old badge summed the per-turn cumulative inputs, each
    // of which re-counted the whole conversation). No behavioral change needed:
    // the badge keeps summing promptTokens + completionTokens per chat delivery.
    totalTokens +=
      (typeof p.promptTokens === 'number' ? (p.promptTokens as number) : 0) +
      (typeof p.completionTokens === 'number' ? (p.completionTokens as number) : 0);
  }

  return {
    tools: toolNames.size,
    files: filePaths.size,
    subagents: subagentNames.size,
    tokens: totalTokens,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Spec #2717 — Session-total aggregation (the session bottom bar data model)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bottom-bar data model — per-category session totals (Spec #2717 R-1).
 *
 * `cacheWriteTokens` is carried in the struct but NEVER summed into any
 * displayed figure or Total (Architect binding G-023): the "Cache" category
 * = `cacheReadTokens` only.
 */
export interface SessionTokenTotals {
  inputTokens: number;      // Σ per-key promptTokens (per-turn Δinput)
  cacheReadTokens: number;  // Σ per-key cacheReadTokens ("Cache" category)
  cacheWriteTokens: number; // Σ per-key cacheWriteTokens (carried, not in the five-way)
  reasoningTokens: number;  // Σ per-key reasoningTokens
  outputTokens: number;     // Σ per-key completionTokens
  totalTokens: number;      // input + cacheRead + reasoning + output (R-3.1)
}

/**
 * Session metrics for the Total Top Bar (#2743 ST-1 / AC-12) — the token
 * totals plus the session's estimated cost and message count, derived
 * frontend-side from the chat-node deliveries the bar already consumes under
 * the identical last-wins-per-composite-key + composited-child-exclusion rules
 * (the session-totals delivery decision: agent_session spans always emit
 * EventState::Init, so a session-level contract can never complete — #2688).
 */
export interface SessionMetrics extends SessionTokenTotals {
  totalCostUsd: number;   // Σ normalizeCost(p.cost_usd) over last-wins chat keys
  totalMessages: number;  // count of distinct last-wins chat keys (session-scoped, non-composited)
}

/**
 * Shared last-wins collection pass (#2743 ST-1) — the single definition of the
 * aggregation rule both `computeSessionTokenTotals` and `computeSessionMetrics`
 * reuse:
 * 1. Chat-node deliveries only, scoped to `deliverySessionId(d) === sessionId`;
 *    deliveries carrying `compositedChildSessionId` are skipped (same signal the
 *    graph builder uses to route them to SubagentNodes), so child/subagent
 *    tokens never leak into the parent session total.
 * 2. Dedupe by composite key `(sessionId, correlationId)` — the LAST lifecycle
 *    delivery per key wins (end beats init/update; the OTLP adapter emits a
 *    synthetic Init + Response per turn with identical payloads, otlp.rs:548-551).
 *    This is the same last-wins rule the graph builder applies per node.
 */
function collectSessionChatDeliveries(
  deliveries: ContractDelivery[],
  sessionId: string,
): { lastByKey: Map<string, ContractDelivery> } {
  const lastByKey = new Map<string, ContractDelivery>();

  for (const d of deliveries) {
    if (!isChatNodeDelivery(d)) continue;
    if (deliverySessionId(d) !== sessionId) continue;
    // Spec #523: composited child-session deliveries become SubagentNodes, never
    // AgentNodes — exclude them so child/subagent tokens never leak into the
    // parent session total (same exclusion as the graph builder's node set).
    if (d.payload?.['compositedChildSessionId'] !== undefined) continue;

    const key = `${deliverySessionId(d)}:${deliveryCorrelationId(d)}`;
    lastByKey.set(key, d);
  }

  return { lastByKey };
}

/**
 * Compute the selected session's token totals for the bottom bar (R-1).
 *
 * Aggregation rule (BILLED semantics — DeepSeek platform reconciliation):
 * 1. Chat-node deliveries only, scoped to `deliverySessionId(d) === sessionId`;
 *    deliveries carrying `compositedChildSessionId` are skipped (same signal the
 *    graph builder uses to route them to SubagentNodes — useMissionMonitor.ts:294),
 *    so child/subagent tokens never leak into the parent session total and the
 *    bar's figure set matches the node set.
 * 2. Dedupe by composite key `(sessionId, correlationId)` — the LAST lifecycle
 *    delivery per key wins (end beats init/update; the OTLP adapter emits a
 *    synthetic Init + Response per turn with identical payloads, otlp.rs:548-551,
 *    so figures are identical per turn by construction).
 * 3. Each family sums the RAW PER-REQUEST value the provider reports per
 *    inference call, falling back to the derived per-turn delta when the raw
 *    key is absent (legacy / Hook deliveries):
 *      - INPUT      ← `input_tokens` (per-request cache-MISS)  ?? `promptTokens`
 *      - CACHE      ← `cache_read_tokens` (per-request cache-HIT) ?? `cacheReadTokens`
 *      - REASONING  ← `reasoning_tokens` ?? `reasoningTokens`
 *      - OUTPUT     ← `output_tokens` ?? `completionTokens`
 *    `cache_read_tokens` is SESSION-CUMULATIVE and re-reported on EVERY request
 *    (each request re-reads the whole cached prefix), so summing it across turns
 *    is the figure DeepSeek bills as "Input (Cache hit)" — the live session's
 *    Σ cache_read_tokens = 1,541,504 ≈ platform 1,542,016. The derived per-turn
 *    DELTA (which telescopes to the last cumulative, 85,632) is the per-NODE
 *    graph figure and is NOT the session total.
 * 4. `totalTokens = inputTokens + cacheReadTokens + reasoningTokens +
 *    outputTokens` (R-3.1); `cacheWriteTokens` is carried but never summed.
 * 5. ST-3 (#2734) reconciliation guard: warn-only when a cache-bearing chat
 *    delivery carries the derived per-turn cache delta WITHOUT the raw
 *    per-request `cache_read_tokens` flat key — the session CACHE total then
 *    under-states the provider's billed cache-hit figure. NEVER a silent
 *    correction (the adapter owns correctness; the guard surfaces adapter
 *    regressions). O(N) — reuses the aggregation pass.
 *
 * @param deliveries - All deliveries (live + restored, unsorted).
 * @param sessionId  - The selected session id ('' → empty totals).
 * @returns SessionTokenTotals with per-category sums.
 */
export function computeSessionTokenTotals(
  deliveries: ContractDelivery[],
  sessionId: string,
): SessionTokenTotals {
  // Per-composite-key last-wins map: key = `${sessionId}:${correlationId}`.
  const { lastByKey } = collectSessionChatDeliveries(deliveries, sessionId);

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let outputTokens = 0;
  let cacheFallbackCount = 0;

  for (const d of lastByKey.values()) {
    const p = extractDeliveryPayload(d);
    // Billed semantics: prefer the raw per-request flat attr (cloned verbatim
    // into every delivery payload by the adapter), fall back to the derived
    // per-turn delta for legacy / Hook deliveries that carry only the delta.
    const rawCacheRead = p['cache_read_tokens'];
    if (rawCacheRead === undefined && p.cacheReadTokens !== undefined) cacheFallbackCount++;
    // R-3.3 guard — the same normalizeTokenCount the node path uses, so a
    // category that is absent or non-numeric sums as 0 on both surfaces.
    inputTokens += normalizeTokenCount(p['input_tokens'] ?? p.promptTokens);
    cacheReadTokens += normalizeTokenCount(rawCacheRead ?? p.cacheReadTokens);
    cacheWriteTokens += normalizeTokenCount(p['cache_creation_tokens'] ?? p.cacheWriteTokens);
    reasoningTokens += normalizeTokenCount(p['reasoning_tokens'] ?? p.reasoningTokens);
    outputTokens += normalizeTokenCount(p['output_tokens'] ?? p.completionTokens);
  }

  // R-3.1: Total = Input + Cache + Reasoning + Output exactly. cacheWrite is
  // carried in the struct but NEVER summed into any displayed figure (G-023).
  const totalTokens = inputTokens + cacheReadTokens + reasoningTokens + outputTokens;

  // ── ST-3 (#2734): reconciliation guard (diagnostic, warn-only) ─────────────
  // The session CACHE total sums the RAW per-request `cache_read_tokens` (each
  // request re-reports the cumulative cached-prefix size; DeepSeek bills the sum
  // — the live session's Σ 1,541,504 ≈ platform 1,542,016). A cache-bearing
  // delivery that lacks the raw flat key falls back to its per-turn DELTA,
  // under-stating the billed figure. Warn when that happens so an adapter
  // regression (raw key dropped) surfaces in the console before the live tester
  // does (Bug #586 full-chain lesson). Silent when every cache-bearing delivery
  // carried its raw per-request value, or when the session has no cache at all
  // (R-4 / AC4). NEVER a silent correction.
  if (cacheReadTokens > 0 && cacheFallbackCount > 0) {
    console.warn(
      `[mission-monitor] cache reconciliation fallback (session ${sessionId}): ` +
        `${cacheFallbackCount} chat delivery/ies carried the derived per-turn cache ` +
        `delta WITHOUT the raw per-request cache_read_tokens flat key — the session ` +
        `CACHE total (${cacheReadTokens}) may under-state the provider's billed ` +
        `cache-hit figure. This likely indicates an adapter regression.`,
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
 * Compute the session's Total Top Bar metrics (#2743 ST-1 / AC-12): the five-way
 * token totals PLUS the estimated cost and total message count, all derived
 * frontend-side from the chat-node deliveries the bar already consumes.
 *
 * Aggregation reuses the EXACT last-wins-per-composite-key + composited-child
 * exclusion pass as `computeSessionTokenTotals` (the session-totals delivery
 * decision — see the SessionMetrics doc), so the cost/message figures share the
 * same node-set semantics as the token figures: Σ per-turn `cost_usd` over
 * last-wins chat keys telescopes to the session cost exactly as Σ per-turn
 * token deltas do (#2717/#2723 reconciliation contract); TOTAL MESSAGES = the
 * number of distinct chat composite keys.
 *
 * @param deliveries - All deliveries (live + restored, unsorted).
 * @param sessionId  - The selected session id ('' → empty metrics).
 * @returns SessionMetrics — the token totals plus totalCostUsd / totalMessages.
 */
export function computeSessionMetrics(
  deliveries: ContractDelivery[],
  sessionId: string,
): SessionMetrics {
  // Reuse the exact token-totals pass (last-wins, session-scoped,
  // non-composited, zero-guarded — including the R-3 reconciliation guard) so
  // the token families stay byte-identical between the two surfaces.
  const tokenTotals = computeSessionTokenTotals(deliveries, sessionId);
  // Same shared collection pass → the cost/messages use the identical node-set
  // (a second O(K) pass over the per-key map, K = distinct chat keys).
  const { lastByKey } = collectSessionChatDeliveries(deliveries, sessionId);

  let totalCostUsd = 0;
  for (const d of lastByKey.values()) {
    const p = extractDeliveryPayload(d);
    // normalizeCost: absent/NaN/negative → 0 (a delivered $0.00 counts as 0
    // but the per-key last-wins map still carries the delivery — never a
    // hardcoded figure).
    totalCostUsd += normalizeCost(p.cost_usd);
  }

  return {
    ...tokenTotals,
    totalCostUsd,
    totalMessages: lastByKey.size,
  };
}
