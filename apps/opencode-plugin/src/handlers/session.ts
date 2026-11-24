/**
 * handlers/session.ts — session lifecycle handlers (Spec #3197 ST-2).
 *
 * Events: `session.created`, `session.inbox.enqueued`, `session.execution.*`,
 * `session.idle`. Everything is a port of the V1 behaviour on `main`
 * (`handlers/session.ts`) onto the V2 event stream — the emitted contract
 * (span names, flat Fredo attributes, `gen_ai.*` registry keys, metric names,
 * log bodies) is reproduced verbatim, because the Rust ingest classifier is
 * attribute-driven and must not change.
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionCreated              :3333  (data.sessionID :3347, data.parentID :3351,
 *                                           data.agent :3354, data.model :3355, data.title :3353)
 *     · SessionInboxEnqueued        :3886  (data.sessionID, data.item: SessionInboxItem :3726
 *                                           → type "user" ⇒ payload.text :1575)
 *     · SessionExecutionStarted     :1860  (data.sessionID)
 *     · SessionExecutionSucceeded   :1877  (data.sessionID)
 *     · SessionExecutionFailed      :1894  (data.sessionID, data.error: SessionStructuredError :160)
 *     · SessionExecutionInterrupted :1912  (data.sessionID, data.reason:
 *                                           "user"|"shutdown"|"superseded"|"inactivity")
 *     · SessionIdle                 :2893  (data.sessionID)
 *
 * ONE SPAN PER SESSION. `sessionSpans` is keyed by `session.id` for BOTH roles:
 * a child opens its span at `session.created` (with the child→parent link), a
 * primary session opens it on its first user prompt and refreshes it per turn.
 * That is the difference from V1 (which keyed primary turn roots by user message
 * id and never closed the ones before the last), and it is what makes the
 * `sweepSession` invariant provable: exactly one open session span per session,
 * ended by exactly one close path, so an interruption can never orphan one.
 *
 * Bounded maps (NFR-5): every map written here goes through `setBoundedMap`
 * (oldest-first eviction at `MAX_PENDING` / `MAX_CHILD_COMPLETIONS`).
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span, SpanContext } from "@opentelemetry/api";
import {
  ATTR_SESSION_ID,
  ATTR_AGENT_TYPE,
  ATTR_IS_SUBAGENT,
  ATTR_PARENT_SESSION_ID,
  ATTR_TOTAL_TOKENS,
  ATTR_TOTAL_COST,
  ATTR_TOTAL_MESSAGES,
  ATTR_MODEL,
  ATTR_PROMPT_LENGTH,
  LOG_SESSION_CREATED,
  LOG_SESSION_IDLE,
  LOG_SESSION_ERROR,
  LOG_USER_PROMPT,
} from "../telemetry-constants";
import {
  agentAttrs,
  childCompletionAttrs,
  getSessionAgentMeta,
  resolveSessionTraceContext,
  setBoundedMap,
} from "../util";
import {
  ATTR_OP_NAME,
  EXCEPTION_MESSAGE,
  GEN_AI_AGENT_NAME,
  GEN_AI_ERROR_TYPE,
  GEN_AI_EVENT_EXCEPTION,
  OP_NAME_SESSION,
  createParentSpanLink,
  genAiAgentNameAttr,
  genAiConversationAttr,
  genAiExceptionEventAttrs,
  genAiOpNameAttr,
  genAiPromptAttr,
} from "../genai-conventions";
import { MAX_CHILD_COMPLETIONS } from "../types";
import type {
  HandlerContext,
  PendingChildCompletion,
  SessionAgentType,
  SessionTotals,
  V2EventOf,
} from "../types";

/** Message-part map keys are prefixed with the session id (mirrors `message.ts`). */
function messageKeyPrefix(sessionID: string): string {
  return `${sessionID}:`;
}

/**
 * Human-readable text for a V2 `SessionStructuredError` (:160 — `{ type, message }`).
 *
 * V1 received `{ name, data }` and summarised it as `${name}: ${message}`; the
 * V2 shape carries the message directly, so the same `type: message` form is
 * produced without inventing a `data` envelope.
 */
function structuredErrorText(err: { type: string; message: string }): string {
  return err.message ? `${err.type}: ${err.message}` : err.type;
}

/** Concatenated assistant text accumulated for a session (all completed+open steps). */
function collectSessionOutput(sessionID: string, ctx: HandlerContext): string {
  const prefix = messageKeyPrefix(sessionID);
  let output = "";
  for (const [key, text] of ctx.messageOutputs) {
    if (key.startsWith(prefix)) output += text;
  }
  return output;
}

/**
 * Resolves the parent session span's `SpanContext` for the child→parent span
 * link: the live parent session span, its retained context, then the parent's
 * run span (kept for parity with the V1 resolution order).
 */
function resolveParentSpanContext(
  parentSessionId: string,
  ctx: HandlerContext,
): SpanContext | undefined {
  const parentSpan = ctx.sessionSpans.get(parentSessionId);
  if (parentSpan) return parentSpan.spanContext();
  const parentSpanContext = ctx.sessionSpanContexts.get(parentSessionId);
  if (parentSpanContext) return parentSpanContext;
  const parentRunID = ctx.activeRuns.get(parentSessionId);
  if (parentRunID) {
    const runSpan = ctx.runSpans.get(parentRunID);
    if (runSpan) return runSpan.spanContext();
    return ctx.runSpanContexts.get(parentRunID);
  }
  return undefined;
}

/**
 * Seam-guarded parent routing for the self-carried `session.parent_id`
 * attribute (Spec #2768 ST-1, preserved by #3197).
 *
 * When `FREDO_SUPPRESS_PARENT_ROUTING=1` is set in the plugin host environment
 * the plugin NEVER stamps the routing attribute, so child spans arrive genuinely
 * legacy-shaped and the Rust adapter's attr→field mapping no-ops (the legacy
 * inference paths can then be verified in isolation). Test affordance only.
 */
export function routingParentSessionId(
  sessionID: string,
  ctx: HandlerContext,
): string | undefined {
  if (ctx.suppressParentRouting) return undefined;
  return resolveParentSessionId(sessionID, ctx);
}

/** Registers (or refreshes) the session span in the bounded span maps. */
function storeSessionSpan(sessionID: string, span: Span, ctx: HandlerContext): void {
  setBoundedMap(ctx.sessionSpans, sessionID, span);
  setBoundedMap(ctx.sessionSpanContexts, sessionID, span.spanContext());
}

/**
 * `session.created` — registers session identity and emits the session log +
 * counter. A CHILD session additionally opens its `fredo.session` span with the
 * child→parent link; a primary session's span opens at its first prompt.
 */
export function handleSessionCreated(
  event: V2EventOf<"session.created">,
  ctx: HandlerContext,
): void {
  const data = event.data;
  const sessionID = data.sessionID;
  const createdAt = event.created;

  // R-1.4: V2 carries the parent DIRECTLY on the payload (types.d.ts:3351).
  // The V1 pending-`task` scan is only the fallback for a payload that omits it
  // (and is skipped entirely under the FREDO_SUPPRESS_PARENT_ROUTING seam).
  let parentID: string | undefined = data.parentID;
  if (!parentID) parentID = routingParentSessionId(sessionID, ctx);

  const isSubagent = !!parentID;
  const agentType: SessionAgentType = isSubagent ? "subagent" : "primary";
  const agent = data.agent ?? "unknown";

  ctx.instruments.sessionCounter.add(1, {
    [ATTR_SESSION_ID]: sessionID,
    [ATTR_IS_SUBAGENT]: isSubagent,
  });

  const existingTotals = ctx.sessionTotals.get(sessionID);
  const totals: SessionTotals = {
    startMs: existingTotals?.startMs ?? createdAt,
    tokens: existingTotals?.tokens ?? 0,
    cost: existingTotals?.cost ?? 0,
    messages: existingTotals?.messages ?? 0,
    agent: existingTotals?.agent ?? agent,
    agentType,
    inferenceCalls: existingTotals?.inferenceCalls ?? 0,
    toolCalls: existingTotals?.toolCalls ?? 0,
    inputTokens: existingTotals?.inputTokens ?? 0,
    cacheReadTokens: existingTotals?.cacheReadTokens ?? 0,
    cacheWriteTokens: existingTotals?.cacheWriteTokens ?? 0,
    reasoningTokens: existingTotals?.reasoningTokens ?? 0,
    outputTokens: existingTotals?.outputTokens ?? 0,
    ...(parentID ? { parentId: parentID } : {}),
    ...(existingTotals?.instruction ? { instruction: existingTotals.instruction } : {}),
  };
  setBoundedMap(ctx.sessionTotals, sessionID, totals);

  // `session.created` carries the session's model; remember it so the prompt log
  // and the turn-root span can name it before the first step resolves one.
  if (data.model) {
    const previousTurn = ctx.sessionTurns.get(sessionID);
    setBoundedMap(ctx.sessionTurns, sessionID, {
      ...(previousTurn?.prompt ? { prompt: previousTurn.prompt } : {}),
      model: `${data.model.providerID}/${data.model.id}`,
    });
  }

  if (parentID) {
    const parentSpanContext = resolveParentSpanContext(parentID, ctx);
    const spanLink = parentSpanContext
      ? createParentSpanLink(parentSpanContext, parentID)
      : undefined;

    const sessionSpan = ctx.tracer.startSpan(
      `${ctx.tracePrefix}session`,
      {
        startTime: createdAt,
        attributes: {
          ...genAiOpNameAttr(OP_NAME_SESSION),
          ...genAiConversationAttr(sessionID),
          ...genAiAgentNameAttr(agent),
          [ATTR_SESSION_ID]: sessionID,
          // Seam-guarded self-carried routing (FREDO_SUPPRESS_PARENT_ROUTING).
          ...(ctx.suppressParentRouting ? {} : { [ATTR_PARENT_SESSION_ID]: parentID }),
          agent,
          [ATTR_AGENT_TYPE]: agentType,
          [ATTR_IS_SUBAGENT]: isSubagent,
        },
        ...(spanLink ? { links: [spanLink] } : {}),
      },
      resolveSessionTraceContext(parentID, ctx),
    );
    storeSessionSpan(sessionID, sessionSpan, ctx);
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: createdAt,
    observedTimestamp: Date.now(),
    body: LOG_SESSION_CREATED,
    attributes: {
      "event.name": LOG_SESSION_CREATED,
      [ATTR_SESSION_ID]: sessionID,
      [ATTR_IS_SUBAGENT]: isSubagent,
      ...agentAttrs(agent, agentType),
    },
  });
  ctx.log("info", "otel: session.created", { sessionID, createdAt, isSubagent });
}

/**
 * `session.inbox.enqueued` — the user prompt (R-1.1).
 *
 * A `user` inbox item is the turn's prompt: it emits the `user_prompt` log record
 * and starts/refreshes the session's `fredo.session` span with the prompt text,
 * `gen_ai.input.messages`, the conversation id, the agent and the model.
 *
 * `synthetic` / `compaction` / `move` items are NOT user prompts — they emit
 * nothing (never fabricate a prompt from a system item).
 */
export function handleSessionInboxEnqueued(
  event: V2EventOf<"session.inbox.enqueued">,
  ctx: HandlerContext,
): void {
  const { sessionID, item } = event.data;
  if (item.type !== "user") return;
  const promptText = item.payload.text ?? "";
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const model = ctx.sessionTurns.get(sessionID)?.model ?? "unknown";

  setBoundedMap(ctx.sessionTurns, sessionID, { prompt: promptText, model });

  const existing = ctx.sessionSpans.get(sessionID);
  const promptAttrs = {
    ...genAiOpNameAttr(OP_NAME_SESSION),
    ...genAiConversationAttr(sessionID),
    ...genAiAgentNameAttr(agentName),
    ...genAiPromptAttr(promptText),
    [ATTR_SESSION_ID]: sessionID,
    agent: agentName,
    ...(promptText ? { prompt: promptText } : {}),
    [ATTR_MODEL]: model,
  };

  if (existing) {
    // Refresh the live session span (child sessions open theirs at creation; a
    // primary session refreshes its turn root on every prompt).
    const parentSessionId = routingParentSessionId(sessionID, ctx);
    existing.setAttributes({
      ...promptAttrs,
      [ATTR_AGENT_TYPE]: agentType,
      [ATTR_IS_SUBAGENT]: agentType === "subagent",
      ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
    });
  } else {
    // R-1.1 turn root: a primary session's first `fredo.session` span.
    const parentSessionId = routingParentSessionId(sessionID, ctx);
    const spanLink =
      parentSessionId && !ctx.suppressParentRouting
        ? (() => {
            const parentSpanContext = resolveParentSpanContext(parentSessionId, ctx);
            return parentSpanContext
              ? createParentSpanLink(parentSpanContext, parentSessionId)
              : undefined;
          })()
        : undefined;
    const sessionSpan = ctx.tracer.startSpan(
      `${ctx.tracePrefix}session`,
      {
        startTime: event.created,
        attributes: {
          ...promptAttrs,
          [ATTR_AGENT_TYPE]: agentType === "unknown" ? "primary" : agentType,
          [ATTR_IS_SUBAGENT]: agentType === "subagent",
          ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
        },
        ...(spanLink ? { links: [spanLink] } : {}),
      },
      resolveSessionTraceContext(sessionID, ctx),
    );
    storeSessionSpan(sessionID, sessionSpan, ctx);
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: event.created,
    observedTimestamp: Date.now(),
    body: LOG_USER_PROMPT,
    attributes: {
      "event.name": LOG_USER_PROMPT,
      [ATTR_SESSION_ID]: sessionID,
      ...agentAttrs(agentName, agentType),
      [ATTR_PROMPT_LENGTH]: promptText.length,
      [ATTR_MODEL]: model,
    },
  });
  ctx.log("debug", "otel: user_prompt", {
    sessionID,
    promptLength: promptText.length,
    model,
  });
}

/**
 * `session.execution.started` — no emission.
 *
 * V1 had no equivalent event (a run began at `chat.message`); everything the
 * session needs at this point was already recorded at `session.created` /
 * `session.inbox.enqueued`. Kept as a named handler so the dispatch table is
 * complete and a future signal has a home.
 */
export function handleExecutionStarted(
  event: V2EventOf<"session.execution.started">,
  ctx: HandlerContext,
): void {
  ctx.log("debug", "otel: session.execution.started", { sessionID: event.data.sessionID });
}

/** `session.execution.succeeded` — closes the session span OK + totals/metrics + `session.idle` log. */
export function handleExecutionSucceeded(
  event: V2EventOf<"session.execution.succeeded">,
  ctx: HandlerContext,
): void {
  closeSession(event.data.sessionID, ctx, {
    status: "ok",
    timestamp: event.created,
    emitIdleLog: true,
    sweepMessage: "session ended before tool/message completed",
  });
}

/** `session.execution.failed` — closes the session span ERROR with the exception event + `session.error` log. */
export function handleExecutionFailed(
  event: V2EventOf<"session.execution.failed">,
  ctx: HandlerContext,
): void {
  const errorText = structuredErrorText(event.data.error);
  closeSession(event.data.sessionID, ctx, {
    status: "error",
    timestamp: event.created,
    errorText,
    error: event.data.error,
    metricErrorType: event.data.error.type,
    sweepMessage: "session failed before tool/message completed",
  });
}

/**
 * `session.execution.interrupted` — R-4.2.
 *
 * Closes the session span ERROR with a `status_message` naming the interruption
 * and SWEEPS every still-open tool/LLM span of the session to ERROR (the
 * `sweepSession` invariant: an interruption never leaves an open span behind).
 */
export function handleExecutionInterrupted(
  event: V2EventOf<"session.execution.interrupted">,
  ctx: HandlerContext,
): void {
  const interruption = `interrupted: ${event.data.reason}`;
  closeSession(event.data.sessionID, ctx, {
    status: "error",
    timestamp: event.created,
    errorText: interruption,
    sweepMessage: interruption,
  });
}

/** `session.idle` — flush point: closes anything still open, then flushes the exporters. */
export function handleSessionIdle(
  event: V2EventOf<"session.idle">,
  ctx: HandlerContext,
): void {
  // A session that already closed at execution.* has no totals/span left, so
  // this is a no-op for it; a session whose execution event was missed (or a
  // stream that just went idle) is closed here without emitting a second
  // `session.idle` log.
  closeSession(event.data.sessionID, ctx, {
    status: "ok",
    timestamp: event.created,
    emitIdleLog: false,
    sweepMessage: "session idled before tool/message completed",
  });

  try {
    const flushed = ctx.onIdleFlush?.();
    if (flushed && typeof (flushed as Promise<void>).catch === "function") {
      (flushed as Promise<void>).catch(() => {
        // A failing flush must never surface (NFR-1).
      });
    }
  } catch {
    // Never let the flush seam break the event loop (NFR-1).
  }
  ctx.log("debug", "otel: session.idle", { sessionID: event.data.sessionID });
}

/** Close options for `closeSession`. */
type CloseOptions = {
  status: "ok" | "error";
  timestamp: number;
  errorText?: string;
  error?: { type: string; message: string };
  metricErrorType?: string;
  emitIdleLog?: boolean;
  sweepMessage?: string;
};

/**
 * THE single close path for a session (succeeded / failed / interrupted / idle).
 *
 * Order matters and is load-bearing:
 *   1. read the accumulated output + record the child-completion snapshot BEFORE
 *      the maps/totals are cleared (a child's snapshot is keyed by its parent);
 *   2. sweep still-open tool/message spans (never orphan one);
 *   3. record the session metrics exactly once (guarded by the totals delete);
 *   4. stamp the final attribute set, status, exception event, then `.end()`;
 *   5. emit the terminal log record.
 */
function closeSession(sessionID: string, ctx: HandlerContext, options: CloseOptions): void {
  const totals = ctx.sessionTotals.get(sessionID);
  const liveSessionSpan = ctx.sessionSpans.get(sessionID);
  const sessionOutput = collectSessionOutput(sessionID, ctx);

  // Child completion FIRST (needs totals + accumulated output). It may resolve a
  // parent late and PROMOTE this session to `subagent`, so every value read below
  // comes from the totals AFTER this call.
  const childCompletion = recordChildCompletion(sessionID, ctx);
  if (childCompletion) {
    const parentId = resolveParentSessionId(sessionID, ctx);
    if (parentId) attachChildCompletionToPendingTaskSpan(parentId, childCompletion, ctx);
  }

  const latest = ctx.sessionTotals.get(sessionID) ?? totals;
  const agentName = latest?.agent ?? "unknown";
  const agentType = latest?.agentType ?? "unknown";
  // Only a session that knows its parent stamps the self-carried routing
  // attribute — a root session never guesses one (seam-guarded).
  const stampedParentId = latest?.parentId;
  ctx.sessionTotals.delete(sessionID);
  sweepSession(sessionID, ctx, options.sweepMessage);

  // Already closed (e.g. a duplicated durable terminal event, or an idle after
  // `session.execution.succeeded`): nothing live is left, so nothing may be
  // emitted a second time. The sweep above still ran (defensive).
  if (!totals && !liveSessionSpan) {
    ctx.log("debug", "otel: session close with nothing open", { sessionID });
    return;
  }

  if (totals) {
    const duration_ms = Math.max(0, options.timestamp - totals.startMs);
    const agent = totals.agent !== "unknown" ? totals.agent : undefined;
    ctx.instruments.toolDurationHistogram.record(duration_ms, {
      [ATTR_SESSION_ID]: sessionID,
    });
    // gen_ai registry metrics, values in SECONDS (gen-ai-metrics.md).
    ctx.instruments.genAiInvokeAgentDuration.record(duration_ms / 1000, {
      ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      ...(options.metricErrorType ? { [GEN_AI_ERROR_TYPE]: options.metricErrorType } : {}),
    });
    ctx.instruments.genAiOperationDuration.record(duration_ms / 1000, {
      [ATTR_OP_NAME]: OP_NAME_SESSION,
      ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      ...(options.metricErrorType ? { [GEN_AI_ERROR_TYPE]: options.metricErrorType } : {}),
    });
    // Only positive counts are recorded — never a zero placeholder row.
    if (totals.inferenceCalls > 0) {
      ctx.instruments.genAiInferenceCalls.record(totals.inferenceCalls, {
        ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      });
    }
    if (totals.toolCalls > 0) {
      ctx.instruments.genAiToolCalls.record(totals.toolCalls, {
        ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      });
    }
  }

  const sessionSpan = liveSessionSpan;
  if (sessionSpan) {
    if (totals) {
      sessionSpan.setAttributes({
        ...genAiAgentNameAttr(totals.agent),
        agent: totals.agent,
        [ATTR_AGENT_TYPE]: totals.agentType,
        [ATTR_TOTAL_TOKENS]: totals.tokens,
        [ATTR_TOTAL_COST]: totals.cost,
        [ATTR_TOTAL_MESSAGES]: totals.messages,
        ...(stampedParentId ? { [ATTR_PARENT_SESSION_ID]: stampedParentId } : {}),
      });
    }
    if (sessionOutput) {
      sessionSpan.setAttributes({ output: sessionOutput, response_text: sessionOutput });
    }
    if (options.status === "error") {
      const message = options.errorText ?? "session error";
      if (options.error) {
        sessionSpan.addEvent(
          GEN_AI_EVENT_EXCEPTION,
          {
            [ATTR_SESSION_ID]: sessionID,
            ...genAiOpNameAttr(OP_NAME_SESSION),
            ...genAiExceptionEventAttrs({
              type: options.error.type,
              message: options.error.message,
            }),
            [EXCEPTION_MESSAGE]: message,
          },
          options.timestamp,
        );
      }
      sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      sessionSpan.setAttribute("error", message);
    } else {
      sessionSpan.setStatus({ code: SpanStatusCode.OK });
    }
    sessionSpan.end(options.timestamp);
    ctx.sessionSpans.delete(sessionID);
    ctx.sessionSpanContexts.delete(sessionID);
  }

  if (options.emitIdleLog) {
    ctx.emitLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      timestamp: options.timestamp,
      observedTimestamp: Date.now(),
      body: LOG_SESSION_IDLE,
      attributes: {
        "event.name": LOG_SESSION_IDLE,
        [ATTR_SESSION_ID]: sessionID,
        [ATTR_TOTAL_TOKENS]: totals?.tokens ?? 0,
        [ATTR_TOTAL_COST]: totals?.cost ?? 0,
        [ATTR_TOTAL_MESSAGES]: totals?.messages ?? 0,
        ...agentAttrs(agentName, agentType),
      },
    });
  }

  if (options.status === "error") {
    const errorText = options.errorText ?? "session error";
    ctx.emitLog({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      timestamp: options.timestamp,
      observedTimestamp: Date.now(),
      body: LOG_SESSION_ERROR,
      attributes: {
        "event.name": LOG_SESSION_ERROR,
        [ATTR_SESSION_ID]: sessionID,
        error: errorText,
        ...agentAttrs(agentName, agentType),
      },
    });
    ctx.log("error", "otel: session.error", { sessionID, error: errorText });
    return;
  }

  ctx.log("debug", "otel: session closed", {
    sessionID,
    duration_ms: totals ? Math.max(0, options.timestamp - totals.startMs) : undefined,
    total_tokens: totals?.tokens,
    total_cost_usd: totals?.cost,
    total_messages: totals?.messages,
  });
}

/**
 * Closes every still-open child span of a session with ERROR and clears its
 * in-flight state. Port of the V1 `sweepSession` (handlers/session.ts:280-309).
 *
 * A span is `.end()`ed BEFORE its map entry is deleted — deleting first would
 * orphan the span and the BatchSpanProcessor would never export it.
 */
function sweepSession(sessionID: string, ctx: HandlerContext, message?: string): void {
  const statusMessage = message ?? "session ended before completion";

  for (const [id, perm] of ctx.pendingPermissions) {
    if (perm.sessionID === sessionID) ctx.pendingPermissions.delete(id);
  }
  for (const [key, pending] of ctx.pendingToolSpans) {
    if (pending.sessionID === sessionID) {
      pending.span?.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage });
      pending.span?.end();
      ctx.pendingToolSpans.delete(key);
    }
  }
  for (const key of ctx.pendingToolInputs.keys()) {
    if (key.startsWith(messageKeyPrefix(sessionID))) ctx.pendingToolInputs.delete(key);
  }
  ctx.pendingRuns.delete(sessionID);

  const prefix = messageKeyPrefix(sessionID);
  for (const [key, span] of ctx.messageSpans) {
    if (key.startsWith(prefix)) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage });
      span.end();
      ctx.messageSpans.delete(key);
    }
  }
  for (const map of [ctx.messageOutputs, ctx.messageThinking, ctx.messageMeta] as const) {
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }
}

/**
 * Resolves the PARENT session id for a (possibly subagent) session.
 *
 * V2 carries `data.parentID` on `session.created` (types.d.ts:3351) and that is
 * written into `sessionTotals.parentId` at creation, so the in-process value is
 * the primary source here. The V1 pending-`task` scan is retained as the
 * fallback for a payload that omitted the parent (and for a session whose
 * creation event arrived before this process subscribed) with both V1 guards:
 *   1. no totals ⇒ no known creation time ⇒ never guess;
 *   2. a candidate dispatch is accepted only when it started at or before this
 *      session's creation (`pending.startMs <= totals.startMs`).
 * A resolved parent is persisted back into `sessionTotals` so every later read
 * agrees (all other fields carried through).
 */
export function resolveParentSessionId(
  sessionID: string,
  ctx: HandlerContext,
): string | undefined {
  const totals = ctx.sessionTotals.get(sessionID);
  if (totals?.parentId) return totals.parentId;
  if (!totals) return undefined;
  for (const [, pending] of [...ctx.pendingToolSpans].reverse()) {
    if (
      pending.tool === "task" &&
      pending.sessionID !== sessionID &&
      pending.startMs <= totals.startMs
    ) {
      setBoundedMap(ctx.sessionTotals, sessionID, {
        startMs: totals.startMs,
        tokens: totals.tokens,
        cost: totals.cost,
        messages: totals.messages,
        agent: totals.agent,
        // A session whose parent resolves only here IS a subagent: promote the
        // role so the classifier's subagent detection (is_subagent/agent.type)
        // and the self-carried parent attribute agree (R-1.4).
        agentType: "subagent",
        parentId: pending.sessionID,
        inferenceCalls: totals.inferenceCalls,
        toolCalls: totals.toolCalls,
        inputTokens: totals.inputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        reasoningTokens: totals.reasoningTokens,
        outputTokens: totals.outputTokens,
        ...(totals.instruction ? { instruction: totals.instruction } : {}),
      });
      const liveSpan = ctx.sessionSpans.get(sessionID);
      if (liveSpan) {
        liveSpan.setAttributes({
          [ATTR_AGENT_TYPE]: "subagent",
          [ATTR_IS_SUBAGENT]: true,
          ...(ctx.suppressParentRouting ? {} : { [ATTR_PARENT_SESSION_ID]: pending.sessionID }),
        });
      }
      ctx.log("debug", "otel: child parent resolved from pending task span", {
        sessionID,
        parentID: pending.sessionID,
      });
      return pending.sessionID;
    }
  }
  return undefined;
}

/**
 * Records a child session's completion snapshot keyed by the PARENT session id
 * (Spec #2745 R-2) so the parent's `fredo.tool.task` span can carry the child's
 * identity + completion totals before it exports. Returns undefined for a
 * primary session or when no parent resolves — the parent's task span then
 * exports unchanged (degrades silently, never crashes).
 */
export function recordChildCompletion(
  sessionID: string,
  ctx: HandlerContext,
): PendingChildCompletion | undefined {
  const totals = ctx.sessionTotals.get(sessionID);
  if (!totals) return undefined;
  const parentId = resolveParentSessionId(sessionID, ctx);
  if (!parentId) {
    if ([...ctx.pendingToolSpans.values()].some((p) => p.tool === "task")) {
      ctx.log("debug", "otel: child completion not recorded — no parent resolved", {
        sessionID,
        pendingTaskSpans: [...ctx.pendingToolSpans.values()].filter((p) => p.tool === "task")
          .length,
      });
    }
    return undefined;
  }
  const { agentName } = getSessionAgentMeta(sessionID, ctx);
  const snapshot: PendingChildCompletion = {
    childSessionId: sessionID,
    agent: agentName,
    tokens: totals.tokens,
    cost: totals.cost,
    messages: totals.messages,
    output: collectSessionOutput(sessionID, ctx),
    inputTokens: totals.inputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    reasoningTokens: totals.reasoningTokens,
    outputTokens: totals.outputTokens,
  };
  setBoundedMap(ctx.pendingChildCompletions, parentId, snapshot, MAX_CHILD_COMPLETIONS);
  return snapshot;
}

/**
 * Attach-at-close point: when a child completes while the parent's
 * `fredo.tool.task` span is still pending, attach the child-completion attributes
 * onto it right away (idempotent with the tool handler's own attach).
 */
function attachChildCompletionToPendingTaskSpan(
  parentSessionId: string,
  snapshot: PendingChildCompletion,
  ctx: HandlerContext,
): void {
  for (const [, pending] of ctx.pendingToolSpans) {
    if (pending.tool === "task" && pending.sessionID === parentSessionId && pending.span) {
      pending.span.setAttributes(childCompletionAttrs(snapshot));
    }
  }
}
