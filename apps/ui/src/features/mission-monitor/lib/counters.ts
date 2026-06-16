/**
 * counters.ts — Session counter computation for Mission Monitor.
 *
 * REQ-9, REQ-10, REQ-11: Pure function that computes running totals
 * for tools, files, subagents, and tokens from persisted FredoEvents.
 */
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { SessionCounters } from './contract';

/**
 * Compute session-level counters from all persisted events for a session.
 *
 * Tools:   unique part.id where part.type === "tool" (from message.part.updated)
 * Files:   unique file paths (from file.edited events)
 * Subagents: unique part.id where part.type === "agent" or "subtask"
 * Tokens:  sum of tokens from assistant message.updated events
 *          — Hook path (payload.properties.info.tokens.input + .output) takes precedence
 *          — OTLP path (payload.gen_ai.usage.input_tokens + .output_tokens) fallback
 *
 * @param events - All persisted events for a session (unsorted)
 * @returns SessionCounters with running totals across all turns
 */
export function computeSessionCounters(events: FredoEvent[]): SessionCounters {
  const toolIds = new Set<string>();
  const filePaths = new Set<string>();
  const subagentIds = new Set<string>();
  let totalTokens = 0;

  for (const ev of events) {
    const payload = ev.payload as Record<string, unknown> | null;
    if (!payload) continue;

    if (ev.toolName === 'message.part.updated') {
      // The adapter UNWRAPS properties for message.part.updated events:
      //   hook:   payload = { part: {...} }  (properties inner, no wrapper)
      //   legacy: payload = { properties: { part: {...} } }
      // Try the adapter-unwrapped shape first, then the legacy wrapper.
      const props = payload.properties as Record<string, unknown> | undefined;
      const part = (payload.part ?? props?.part) as Record<string, unknown> | undefined;
      if (!part) continue;

      const partType = part.type as string | undefined;
      const partId = part.id as string | undefined;

      if (partType === 'tool' && partId) {
        toolIds.add(partId);
      } else if ((partType === 'agent' || partType === 'subtask') && partId) {
        subagentIds.add(partId);
      }
    } else if (ev.toolName === 'file.edited') {
      const props = payload.properties as Record<string, unknown> | undefined;
      const filePath = (props?.file as string) ?? (payload.file_path as string);
      if (filePath) {
        filePaths.add(filePath);
      }
    } else if (ev.toolName === 'message.updated') {
      // The adapter UNWRAPS properties for message.updated events:
      //   hook:   payload = { info: {...} }  (properties inner, no wrapper)
      //   legacy: payload = { properties: { info: {...} } }
      // Try the adapter-unwrapped shape first, then the legacy wrapper.
      const props = payload.properties as Record<string, unknown> | undefined;
      const info = (payload.info ?? props?.info) as Record<string, unknown> | undefined;
      const role = info?.role as string | undefined;

      let useHook = false;
      if (role === 'assistant') {
        const tokens = info?.tokens as Record<string, unknown> | undefined;
        if (tokens) {
          const input = typeof tokens.input === 'number' ? tokens.input : 0;
          const output = typeof tokens.output === 'number' ? tokens.output : 0;
          if (input > 0 || output > 0) {
            totalTokens += input + output;
            useHook = true;
          }
        }
      }

      // — OTLP path: payload.gen_ai.usage (fallback — only if hook path didn't apply or had no tokens) —
      if (!useHook) {
        const genAi = payload.gen_ai as Record<string, unknown> | undefined;
        const usage = genAi?.usage as Record<string, unknown> | undefined;
        if (usage) {
          totalTokens +=
            (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
            (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
        }
      }
    }
  }

  return {
    tools: toolIds.size,
    files: filePaths.size,
    subagents: subagentIds.size,
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
