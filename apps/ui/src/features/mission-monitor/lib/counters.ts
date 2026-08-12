/**
 * counters.ts — Session counter computation for Mission Monitor (delivery-driven).
 *
 * REQ-9 through REQ-11: Pure function that computes running totals
 * for tools, files, subagents, and tokens from ContractDelivery[].
 */
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import type { SessionCounters } from './graph';
import { isChatNodeDelivery, extractDeliveryPayload } from './graph';

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
