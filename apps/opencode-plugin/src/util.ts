/**
 * util.ts — Helper functions for the Fredo OpenCode plugin.
 *
 * Provides bounded map management, trace context resolution, and agent attribute helpers.
 * Mirror the reference architecture without openinference-semantic-conventions dependency.
 */

import { trace } from "@opentelemetry/api";
import { MAX_PENDING } from "./types";
import type { HandlerContext, PendingChildCompletion, SessionAgentType } from "./types";
import {
  ATTR_CHILD_SESSION_ID,
  ATTR_CHILD_AGENT,
  ATTR_CHILD_TOTAL_TOKENS,
  ATTR_CHILD_TOTAL_COST,
  ATTR_CHILD_TOTAL_MESSAGES,
  ATTR_CHILD_INPUT_TOKENS,
  ATTR_CHILD_CACHE_READ_TOKENS,
  ATTR_CHILD_REASONING_TOKENS,
  ATTR_CHILD_OUTPUT_TOKENS,
} from "./telemetry-constants";

/** Returns a human-readable summary string from an opencode error object. */
export function errorSummary(err: { name: string; data?: unknown } | undefined): string {
  if (!err) return "unknown";
  if (err.data && typeof err.data === "object" && "message" in err.data) {
    return `${err.name}: ${(err.data as { message: string }).message}`;
  }
  return err.name;
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached capacity to prevent unbounded memory growth. The capacity defaults to
 * `MAX_PENDING` and can be overridden per-map (e.g. `MAX_CHILD_COMPLETIONS`).
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number = MAX_PENDING) {
  if (!map.has(key) && map.size >= maxSize) {
    const [firstKey] = map.keys();
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
}

/**
 * Builds the fredo-native flat attributes carrying a child-completion snapshot
 * onto the parent's `fredo.tool.task` span (Spec #2745 R-2). Deliberately NOT
 * `gen_ai.*` keys — the OTel GenAI registry defines no child-completion aggregate
 * and new `gen_ai.*` keys are a spec violation.
 */
export function childCompletionAttrs(snapshot: PendingChildCompletion) {
  return {
    [ATTR_CHILD_SESSION_ID]: snapshot.childSessionId,
    [ATTR_CHILD_AGENT]: snapshot.agent,
    [ATTR_CHILD_TOTAL_TOKENS]: snapshot.tokens,
    [ATTR_CHILD_TOTAL_COST]: snapshot.cost,
    [ATTR_CHILD_TOTAL_MESSAGES]: snapshot.messages,
    [ATTR_CHILD_INPUT_TOKENS]: snapshot.inputTokens,
    [ATTR_CHILD_CACHE_READ_TOKENS]: snapshot.cacheReadTokens,
    [ATTR_CHILD_REASONING_TOKENS]: snapshot.reasoningTokens,
    [ATTR_CHILD_OUTPUT_TOKENS]: snapshot.outputTokens,
  } as const;
}

/** Resolves a root-run context from the live span first, then from the retained ended span context. */
export function resolveRunTraceContext(
  runID: string,
  ctx: Pick<HandlerContext, "rootContext" | "runSpans" | "runSpanContexts">,
) {
  const baseCtx = ctx.rootContext();
  const runSpan = ctx.runSpans.get(runID);
  if (runSpan) return trace.setSpan(baseCtx, runSpan);
  const runSpanContext = ctx.runSpanContexts.get(runID);
  return runSpanContext ? trace.setSpanContext(baseCtx, runSpanContext) : baseCtx;
}

/** Resolves the best available trace parent for a session event or message/tool child span. */
export function resolveSessionTraceContext(
  sessionID: string,
  ctx: HandlerContext,
  input?: { assistantMessageID?: string; runID?: string },
) {
  const baseCtx = ctx.rootContext();
  const sessionSpan = ctx.sessionSpans.get(sessionID);
  if (sessionSpan) return trace.setSpan(baseCtx, sessionSpan);
  const sessionSpanContext = ctx.sessionSpanContexts.get(sessionID);
  if (sessionSpanContext) return trace.setSpanContext(baseCtx, sessionSpanContext);
  if (input?.runID) return resolveRunTraceContext(input.runID, ctx);
  const assistantRunID = input?.assistantMessageID
    ? ctx.assistantRuns.get(input.assistantMessageID)
    : undefined;
  if (assistantRunID) return resolveRunTraceContext(assistantRunID, ctx);
  const activeRunID = ctx.activeRuns.get(sessionID);
  return activeRunID ? resolveRunTraceContext(activeRunID, ctx) : baseCtx;
}

/**
 * Accumulates token and cost totals for a session, and increments the message count.
 * Uses `setBoundedMap` to produce a new object rather than mutating in-place.
 * No-ops silently if the session was not previously registered via handleSessionCreated.
 *
 * The reconstruction is field-by-field: any SessionTotals field dropped here is
 * silently lost. The EARS-9 counters (inferenceCalls/toolCalls) MUST be carried
 * through or the per-session counts reset to zero at every message completion.
 * `parentId` and `instruction` MUST also be carried through (Spec #2745 R-3): a
 * child session's parent link — resolved late from a pending task span — was
 * silently wiped here on the FIRST completed chat message, leaving the ST-2
 * child-completion snapshot gate (`recordChildCompletion`) without a parent.
 */
export function accumulateSessionTotals(
  sessionID: string,
  usage: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  cost: number,
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(sessionID);
  if (!existing) return;
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens + (usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write),
    cost: existing.cost + cost,
    messages: existing.messages + 1,
    agent: existing.agent,
    agentType: existing.agentType,
    inferenceCalls: existing.inferenceCalls,
    toolCalls: existing.toolCalls,
    inputTokens: existing.inputTokens + usage.input,
    cacheReadTokens: existing.cacheReadTokens + usage.cache.read,
    cacheWriteTokens: existing.cacheWriteTokens + usage.cache.write,
    reasoningTokens: existing.reasoningTokens + usage.reasoning,
    outputTokens: existing.outputTokens + usage.output,
    ...(existing.parentId ? { parentId: existing.parentId } : {}),
    ...(existing.instruction ? { instruction: existing.instruction } : {}),
  });
}

/**
 * Increments the per-session inference-call / tool-call counters (EARS-9).
 * Uses `setBoundedMap` to produce a new object rather than mutating in-place,
 * carrying every SessionTotals field (including parentId / instruction) through
 * the reconstruction so no field is silently lost. No-ops silently if the
 * session was not previously registered via handleSessionCreated.
 */
export function incrementSessionCounters(
  sessionID: string,
  delta: { inferenceCalls?: number; toolCalls?: number },
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(sessionID);
  if (!existing) return;
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens,
    cost: existing.cost,
    messages: existing.messages,
    agent: existing.agent,
    agentType: existing.agentType,
    inferenceCalls: existing.inferenceCalls + (delta.inferenceCalls ?? 0),
    toolCalls: existing.toolCalls + (delta.toolCalls ?? 0),
    inputTokens: existing.inputTokens,
    cacheReadTokens: existing.cacheReadTokens,
    cacheWriteTokens: existing.cacheWriteTokens,
    reasoningTokens: existing.reasoningTokens,
    outputTokens: existing.outputTokens,
    ...(existing.parentId ? { parentId: existing.parentId } : {}),
    ...(existing.instruction ? { instruction: existing.instruction } : {}),
  });
}

/** Returns the current session-scoped agent name/type, defaulting to `unknown` when unavailable. */
export function getSessionAgentMeta(
  sessionID: string,
  ctx: Pick<HandlerContext, "sessionTotals">,
): { agentName: string; agentType: SessionAgentType | "unknown" } {
  const totals = ctx.sessionTotals.get(sessionID);
  return {
    agentName: totals?.agent ?? "unknown",
    agentType: totals?.agentType ?? "unknown",
  };
}

/** Builds a consistent agent attribute set for OTLP logs, metrics, and spans. */
export function agentAttrs(agentName: string, agentType: SessionAgentType | "unknown") {
  return {
    agent: agentName,
    "agent.name": agentName,
    "agent.type": agentType,
  } as const;
}
