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

/**
 * Format a token count for display in the header badge.
 *
 * - < 10 000   → raw number (e.g., "1234")
 * - >= 10 000  → rounded "NK" (e.g., "42K")
 * - >= 1 000 000 → "N.M" (e.g., "1.2M")
 */
export function formatTokenCount(count: number): string {
  if (count < 10_000) return String(count);
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${Math.floor(count / 1_000)}K`;
}
