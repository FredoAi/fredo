/**
 * Mission Monitor Contract — Turn data and counter interfaces.
 *
 * All capsules in Spec #221 implement against these stubs.
 * Capsule B (Graph Builder) populates these shapes.
 * Capsule C (ChatNode) reads TurnPayload for rendering.
 * Capsule D (Session Counters) uses SessionCounters.
 *
 * Updated for Spec #295 (Event Contract Engine): SubagentContract now
 * extends EventContract from shared classes.
 */

import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { SubagentContract as SharedSubagentContract } from '../../../shared/classes/EventSubscription';

/** Re-export shared SubagentContract */
export type { SharedSubagentContract };

/** Turn data payload carried by ChatNode — 3-section layout */
export interface TurnPayload {
  /** User prompt text (from text part with user's messageID) */
  userPrompt: string;
  /** ISO timestamp of user message */
  userTimestamp: string;
  /** Thinking/reasoning text (may be empty string if no reasoning) */
  thinkingText: string;
  /** Final response text (may be empty string if turn incomplete) */
  responseText: string;
  /** Number of unique tool calls in this turn (deduped by part.id) */
  turnTools: number;
  /** Number of unique files edited in this turn (deduped by file path) */
  turnFiles: number;
  /** Model name (from message.updated info.modelID or info.providerID) */
  model?: string;
  /** Input tokens consumed for this turn (from assistant info.tokens.input) */
  turnInputTokens: number;
  /** Output tokens generated for this turn (from assistant info.tokens.output) */
  turnOutputTokens: number;
  /** Agent name (from user message.updated info.agent) */
  agent?: string;
}

/** Payload carried by SubagentNode */
export interface SubagentPayload {
  subagentName: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
}

/** SubagentContract — re-exported from shared classes for backward compat */
export type SubagentContract = SharedSubagentContract;

/** Session-level counters displayed in panel header badges */
export interface SessionCounters {
  tools: number;
  files: number;
  subagents: number;
  tokens: number;
}

/**
 * Compute session counters from a list of persisted FredoEvents.
 * 
 * REQ-9, REQ-10, REQ-11
 * 
 * @param events - All persisted events for a session (unsorted)
 * @returns SessionCounters with running totals
 */
export function computeSessionCounters(events: FredoEvent[]): SessionCounters {
  // Stub — Capsule D implements
  throw new Error('Not implemented: computeSessionCounters');
}

/**
 * Extract the usable payload from a FredoEvent regardless of transport.
 * 
 * For hook transport: returns ev.payload directly.
 * For OTLP transport: merges ev.metadata.attributes with ev.payload.
 * 
 * @param ev - FredoEvent
 * @returns Flat payload object with all accessible fields
 */
export function eventPayload(ev: FredoEvent): Record<string, any> {
  // Prefer ev.payload — the OpenCodeAdapter stores merged attributes there.
  const directPayload = (ev.payload ?? {}) as Record<string, any>;
  if (ev.transport === 'otlp_grpc' || ev.transport === 'otlp_http') {
    // OTLP events: also check metadata.attributes (legacy path from StreamEvent.otlp)
    const meta = ev.metadata as Record<string, any> | null;
    const metaAttrs = (meta?.attributes ?? {}) as Record<string, any>;
    // Merge — direct payload wins for overlapping keys
    return { ...metaAttrs, ...directPayload };
  }
  return directPayload;
}

/**
 * Extract fields from a SubscriptionDelivery for mission monitor consumption.
 * 
 * Given a SubscriptionDelivery with flat fields Record<string, unknown>,
 * extract the values needed for a TurnPayload or SubagentPayload.
 */
export function deliveryFields(delivery: { fields: Record<string, unknown> }): Record<string, unknown> {
  return delivery.fields;
}

/**
 * Returns true if the part is a final (non-delta) part that contributes to a turn.
 *
 * - Parts with `text` content are final (delivered text/reasoning).
 * - Parts with `type === 'tool'` are always final (tool calls have no text field).
 * - Delta-only parts (have `delta` field but no `text`) return false.
 */
/**
 * Format a token count for display in the ChatNode bottom bar.
 *
 * - < 1 000       → raw number (e.g., "420", "0")
 * - ≥ 1 000       → "X.Yk" with one decimal (e.g., 1840 → "1.8k", 1000 → "1k")
 * - ≥ 1 000 000   → "X.YM" with one decimal (e.g., 2500000 → "2.5M", 2000000 → "2M")
 * - Trailing ".0" is stripped (e.g., "1.0k" → "1k")
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    const formatted = val.toFixed(1);
    return `${parseFloat(formatted)}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    const formatted = val.toFixed(1);
    return `${parseFloat(formatted)}k`;
  }
  return String(n);
}

export function isFinalPart(part: Record<string, any>): boolean {
  // Text or reasoning parts with content
  if (typeof part.text === 'string' && part.text.length > 0) return true;
  // Tool parts contribute to counts even without text
  if (part.type === 'tool' && part.tool) return true;
  // Agent and subtask parts have NO text field — always final
  if (part.type === 'agent' || part.type === 'subtask') return true;
  return false;
}
