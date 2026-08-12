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
    // Spec #2711 (round 2) semantic change: the OTLP adapter now injects
    // promptTokens as the PER-MESSAGE prompt — style-robust per session
    // (latched at turn 2):
    //  - Cumulative style: the per-turn DELTA of `gen_ai.usage.input_tokens`
    //    (Δinput, e.g. 2,731 / 27 / 32 / 30 / 409). The deltas telescope:
    //    Σ promptTokens = input(n), so the badge total = input(n) + Σ output.
    //  - PerMessage style: the DIRECT per-message input (e.g. 27,693 / 2,394 /
    //    2,439 — a drop is a real smaller message, NEVER clamped), so the badge
    //    total = Σ per-message inputs + Σ outputs.
    // Under BOTH styles each chat delivery contributes its own per-message
    // consumption exactly once, so the session badge is a correct
    // (previously-inflated) session-level total: the old badge summed the
    // per-turn cumulative inputs, each of which re-counted the whole
    // conversation. No behavioral change needed: the badge keeps summing
    // promptTokens + completionTokens per chat delivery.
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
