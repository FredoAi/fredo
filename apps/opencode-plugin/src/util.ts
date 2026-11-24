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
 * Inserts `value` into `set`, evicting the OLDEST entry first when the set has
 * reached capacity — the Set counterpart of `setBoundedMap` (Spec #3197 round 2,
 * F-3). `registeredSessions` uses it so the exactly-once registration guard stays
 * bounded in a long-lived plugin host.
 */
export function setBoundedSet<T>(set: Set<T>, value: T, maxSize: number = MAX_PENDING) {
  if (!set.has(value) && set.size >= maxSize) {
    const first = set.values().next();
    if (!first.done) set.delete(first.value);
  }
  set.add(value);
}

/**
 * The `globalThis` anchor key for the per-session emission claim (Spec #3197
 * round 3, ST-9).
 *
 * `Symbol.for` — NOT `Symbol()` — because OpenCode V2 evaluates this plugin's
 * module once PER CONNECTED CLIENT in a shared `opencode serve` host (round 2:
 * five `loading plugin` lines in one run, 55 spans / 15 traces for a three-turn
 * session). A module-scoped registry is re-created per instance and therefore
 * deduplicates nothing; only a `globalThis` property survives module
 * re-evaluation. The `fredo.plugin.` namespace keeps it clearly outside the OTel
 * global registries F-1/F-4 forbid.
 */
export const SESSION_OWNER_KEY: symbol = Symbol.for("fredo.plugin.sessionOwner");

/**
 * Cap on the per-session claim map. Oldest-first eviction, the same discipline as
 * every other plugin map (NFR-5) — a long-lived host that sees many sessions must
 * not grow this without bound. Sized like `MAX_CHILD_COMPLETIONS`: one entry per
 * session is tiny, and the claim only has to outlive a session's event stream.
 */
export const MAX_SESSION_CLAIMS = 10_000;

/** The process-wide claim state parked on `globalThis`. */
interface SessionOwnerRegistry {
  readonly owners: Map<string, string>;
}

/** Reads (or lazily creates) the ONE claim registry shared by every plugin instance. */
function sessionOwnerRegistry(): Map<string, string> {
  const holder = globalThis as unknown as { [key: symbol]: SessionOwnerRegistry | undefined };
  const existing = holder[SESSION_OWNER_KEY];
  if (existing && existing.owners instanceof Map) return existing.owners;
  const owners = new Map<string, string>();
  holder[SESSION_OWNER_KEY] = { owners };
  return owners;
}

/**
 * Claims emission for `key` on behalf of `instanceId` (Spec #3197 round 3, ST-9).
 *
 * Returns `true` when this instance may emit: the key is unclaimed (this
 * instance takes it) or it is already owned by `instanceId` (the session's later
 * events belong to the same owner). Returns `false` when ANOTHER instance holds
 * the claim — that instance already emitted this logical event, so this one must
 * emit nothing.
 *
 * A hit refreshes recency (delete + re-set) so a still-active session is not the
 * first evicted once the map reaches `maxEntries`; a new claim on a full map
 * evicts oldest-first, mirroring `setBoundedMap`. `registry`/`maxEntries` are
 * injectable so a test can exercise the bounds without disturbing the shared
 * process registry.
 */
export function claimSession(
  key: string,
  instanceId: string,
  registry: Map<string, string> = sessionOwnerRegistry(),
  maxEntries: number = MAX_SESSION_CLAIMS,
): boolean {
  const owner = registry.get(key);
  if (owner !== undefined) {
    if (owner !== instanceId) return false;
    // LRU refresh: an active session must not age out of the claim map.
    registry.delete(key);
    registry.set(key, instanceId);
    return true;
  }
  if (registry.size >= maxEntries) {
    const first = registry.keys().next();
    if (!first.done) registry.delete(first.value);
  }
  registry.set(key, instanceId);
  return true;
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

/**
 * Records the resolved agent name on a session's totals (Spec #3197 ST-3).
 *
 * V2 carries the authoritative agent on `session.step.started.data.agent`
 * (`SessionCreated.data.agent` is optional), so the first model turn repairs the
 * `unknown` placeholder written at `session.created`. The reconstruction is
 * field-by-field and carries EVERY field (parentId / instruction included) —
 * dropping one here silently loses it for the rest of the session.
 * No-ops for a session that was never registered.
 */
export function setSessionAgent(sessionID: string, agent: string, ctx: HandlerContext): void {
  const existing = ctx.sessionTotals.get(sessionID);
  if (!existing || existing.agent === agent) return;
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens,
    cost: existing.cost,
    messages: existing.messages,
    agent,
    agentType: existing.agentType,
    inferenceCalls: existing.inferenceCalls,
    toolCalls: existing.toolCalls,
    inputTokens: existing.inputTokens,
    cacheReadTokens: existing.cacheReadTokens,
    cacheWriteTokens: existing.cacheWriteTokens,
    reasoningTokens: existing.reasoningTokens,
    outputTokens: existing.outputTokens,
    ...(existing.parentId ? { parentId: existing.parentId } : {}),
    ...(existing.instruction ? { instruction: existing.instruction } : {}),
  });
}

/** Builds a consistent agent attribute set for OTLP logs, metrics, and spans. */
export function agentAttrs(agentName: string, agentType: SessionAgentType | "unknown") {
  return {
    agent: agentName,
    "agent.name": agentName,
    "agent.type": agentType,
  } as const;
}
