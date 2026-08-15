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
 *    This is the same last-wins rule the graph builder applies per node, so
 *    Σ per-node equals the session figure (R-3.2 reconciliation contract).
 */
function collectSessionChatDeliveries(
  deliveries: ContractDelivery[],
  sessionId: string,
): { lastByKey: Map<string, ContractDelivery>; latestChatDelivery: ContractDelivery | undefined } {
  const lastByKey = new Map<string, ContractDelivery>();
  let latestChatDelivery: ContractDelivery | undefined;
  let latestTimestamp = -1;

  for (const d of deliveries) {
    if (!isChatNodeDelivery(d)) continue;
    if (deliverySessionId(d) !== sessionId) continue;
    // Spec #523: composited child-session deliveries become SubagentNodes, never
    // AgentNodes — exclude them so child/subagent tokens never leak into the
    // parent session total (same exclusion as the graph builder's node set).
    if (d.payload?.['compositedChildSessionId'] !== undefined) continue;

    const key = `${deliverySessionId(d)}:${deliveryCorrelationId(d)}`;
    lastByKey.set(key, d);

    const ts = Date.parse(d.timestamp);
    if (!Number.isNaN(ts) && ts >= latestTimestamp) {
      latestTimestamp = ts;
      latestChatDelivery = d;
    }
  }

  return { lastByKey, latestChatDelivery };
}

/**
 * Compute the selected session's token totals for the bottom bar (R-1).
 *
 * Aggregation rule (the reconciliation contract, R-3.2):
 * 1. Chat-node deliveries only, scoped to `deliverySessionId(d) === sessionId`;
 *    deliveries carrying `compositedChildSessionId` are skipped (same signal the
 *    graph builder uses to route them to SubagentNodes — useMissionMonitor.ts:294),
 *    so child/subagent tokens never leak into the parent session total and the
 *    bar's figure set matches the node set.
 * 2. Dedupe by composite key `(sessionId, correlationId)` — the LAST lifecycle
 *    delivery per key wins (end beats init/update; the OTLP adapter emits a
 *    synthetic Init + Response per turn with identical payloads, otlp.rs:548-551,
 *    so figures are identical per turn by construction). This is the same
 *    last-wins rule the graph builder applies per node, so Σ per-node equals the
 *    session figure (R-3.2).
 * 3. Sum the four canonical fields with the shared zero/absent guard
 *    (`normalizeTokenCount`, graph.ts — R-3.3): absent/zero/NaN/negative → 0.
 * 4. `totalTokens = inputTokens + cacheReadTokens + reasoningTokens +
 *    outputTokens` (R-3.1); `cacheWriteTokens` is carried but never summed.
 * 5. ST-3 (#2734) reconciliation guard: after summing, compare Σ per-node
 *    `cacheReadTokens` against the last chat delivery's preserved raw cumulative
 *    `gen_ai.usage.cache_read.input_tokens` flat attr (R-3 telescoping
 *    invariant). Warn-only via `console.warn` on mismatch — NEVER a silent
 *    correction (the adapter owns correctness; the guard surfaces adapter
 *    regressions and delta-baseline resets). O(N) — reuses the aggregation pass.
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
  // The shared pass also returns the reconciliation guard's "last chat
  // delivery" — the most recent qualifying chat delivery by timestamp. Its
  // preserved raw cumulative `gen_ai.usage.cache_read.input_tokens` (a flat
  // attr cloned verbatim from the span attrs into every delivery payload,
  // otlp.rs:998) is the telescoping target for Σ per-node cacheReadTokens
  // (R-3). Same node-set filters as the aggregation (chat-node,
  // session-scoped, non-composited).
  const { lastByKey, latestChatDelivery } = collectSessionChatDeliveries(deliveries, sessionId);

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let outputTokens = 0;

  for (const d of lastByKey.values()) {
    const p = extractDeliveryPayload(d);
    // R-3.3 guard — the same normalizeTokenCount the node path uses, so a
    // category that is absent or non-numeric sums as 0 on both surfaces.
    inputTokens += normalizeTokenCount(p.promptTokens);
    cacheReadTokens += normalizeTokenCount(p.cacheReadTokens);
    cacheWriteTokens += normalizeTokenCount(p.cacheWriteTokens);
    reasoningTokens += normalizeTokenCount(p.reasoningTokens);
    outputTokens += normalizeTokenCount(p.completionTokens);
  }

  // R-3.1: Total = Input + Cache + Reasoning + Output exactly. cacheWrite is
  // carried in the struct but NEVER summed into any displayed figure (G-023).
  const totalTokens = inputTokens + cacheReadTokens + reasoningTokens + outputTokens;

  // ── ST-3 (#2734): reconciliation guard (diagnostic, warn-only) ─────────────
  // R-3 telescoping invariant: Σ per-node cacheReadTokens == the LAST chat
  // delivery's preserved raw cumulative `gen_ai.usage.cache_read.input_tokens`
  // (session-CUMULATIVE and strictly non-decreasing in live telemetry; cloned
  // verbatim as a flat attr into every delivery payload, otlp.rs:998). The
  // adapter owns correctness (it derives per-turn cache deltas, otlp.rs:1322-1335);
  // the guard NEVER corrects a mismatch — it warns so an adapter regression
  // (the raw-cumulative fallback at otlp.rs:1105-1108 placing the session total
  // on every node, or a delta-baseline reset from eviction/restart) surfaces in
  // the console before the live tester does (Bug #586 full-chain lesson).
  // Silent when the session's last chat delivery carries no cache family
  // (R-4 / AC4) or when the invariant holds. O(N) — reuses the single delivery
  // pass already taken to build lastByKey; no per-node re-scans.
  if (latestChatDelivery) {
    const p = extractDeliveryPayload(latestChatDelivery);
    const cumulativeCacheRead = normalizeTokenCount(p['gen_ai.usage.cache_read.input_tokens']);
    if (cumulativeCacheRead > 0 && cumulativeCacheRead !== cacheReadTokens) {
      console.warn(
        `[mission-monitor] cache reconciliation mismatch (session ${sessionId}): ` +
          `Σ per-node cacheReadTokens (${cacheReadTokens}) != last cumulative ` +
          `gen_ai.usage.cache_read.input_tokens (${cumulativeCacheRead}). Per-node ` +
          `values are displayed as delivered — no silent correction. This likely ` +
          `indicates an adapter regression (session-cumulative cache placed on ` +
          `nodes) or a delta-baseline reset (otlp.rs eviction/restart).`,
      );
    }
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
