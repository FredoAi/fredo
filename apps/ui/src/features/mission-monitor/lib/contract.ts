/**
 * Mission Monitor Contract — Turn data and counter interfaces.
 *
 * All capsules in Spec #221 implement against these stubs.
 * Capsule B (Graph Builder) populates these shapes.
 * Capsule C (ChatNode) reads TurnPayload for rendering.
 * Capsule D (Session Counters) uses SessionCounters.
 */

import type { FredoEvent } from '../../../shared/contexts/StreamContext';

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
}

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
  // Stub — Capsule B or D implements
  throw new Error('Not implemented: eventPayload');
}

/**
 * Check if a message.part is a final (non-delta) part with text content.
 * 
 * REQ-6 (Delta Filter): Deltas have `part.delta` but no `part.text`.
 * Final parts have `part.text`.
 * 
 * @param part - The part object from payload.properties.part
 * @returns true if part has text (final), false if delta-only
 */
export function isFinalPart(part: Record<string, any>): boolean {
  // Stub — Capsule B implements
  throw new Error('Not implemented: isFinalPart');
}
