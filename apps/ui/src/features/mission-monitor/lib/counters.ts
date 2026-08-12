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

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    outputTokens,
    totalTokens,
  };
}
