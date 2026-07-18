/**
 * handlers/session.ts — Session lifecycle handlers for the Fredo OpenCode plugin.
 *
 * Handles session.created, session.idle, session.error, and session.status events.
 * Creates session spans, emits log events, and manages session totals.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  ATTR_SESSION_ID,
  ATTR_AGENT_TYPE,
  ATTR_IS_SUBAGENT,
  ATTR_PARENT_SESSION_ID,
  ATTR_TOTAL_TOKENS,
  ATTR_TOTAL_COST,
  ATTR_TOTAL_MESSAGES,
  ATTR_DURATION_MS,
  LOG_SESSION_CREATED,
  LOG_SESSION_IDLE,
  LOG_SESSION_ERROR,
} from "../contract_601";
import {
  agentAttrs,
  errorSummary,
  getSessionAgentMeta,
  setBoundedMap,
  resolveSessionTraceContext,
} from "../util";
import type { HandlerContext, SessionAgentType } from "../types";

/** Starts or refreshes the root run span for a single user turn, keyed by the user message ID. */
export function handleRunStarted(
  runID: string,
  sessionID: string,
  agent: string,
  promptText: string,
  model: string,
  startTime: number,
  ctx: HandlerContext,
) {
  ctx.activeRuns.set(sessionID, runID);
  ctx.pendingRuns.delete(sessionID);
  if (promptText) setBoundedMap(ctx.runInputs, runID, promptText);
  const existing = ctx.runSpans.get(runID);
  if (existing) {
    existing.setAttributes({
      agent,
      ...(promptText ? { prompt: promptText } : {}),
      model,
    });
    return;
  }

  const runSpan = ctx.tracer.startSpan(
    `${ctx.tracePrefix}session`,
    {
      startTime,
      attributes: {
        [ATTR_SESSION_ID]: sessionID,
        agent,
        [ATTR_AGENT_TYPE]: "primary",
        [ATTR_IS_SUBAGENT]: false,
        ...(promptText ? { prompt: promptText } : {}),
        model,
      },
    },
    ctx.rootContext(),
  );
  ctx.runSpans.set(runID, runSpan);
  setBoundedMap(ctx.runSpanContexts, runID, runSpan.spanContext());
}

/** Increments the session counter, starts the root session span, and emits a session.created log event. */
export function handleSessionCreated(
  e: { properties: { info: { id: string; time: { created: number }; parentID?: string } } },
  ctx: HandlerContext,
) {
  const { id: sessionID, time, parentID } = e.properties.info;
  const createdAt = time.created;
  const isSubagent = !!parentID;
  const agentType: SessionAgentType = isSubagent ? "subagent" : "primary";

  ctx.instruments.sessionCounter.add(1, { [ATTR_SESSION_ID]: sessionID, [ATTR_IS_SUBAGENT]: isSubagent });

  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: createdAt,
    tokens: 0,
    cost: 0,
    messages: 0,
    agent: "unknown",
    agentType,
  });

  if (parentID) {
    const sessionSpan = ctx.tracer.startSpan(
      `${ctx.tracePrefix}session`,
      {
        startTime: createdAt,
        attributes: {
          [ATTR_SESSION_ID]: sessionID,
          [ATTR_PARENT_SESSION_ID]: parentID,
          agent: "unknown",
          [ATTR_AGENT_TYPE]: agentType,
          [ATTR_IS_SUBAGENT]: isSubagent,
        },
      },
      resolveSessionTraceContext(parentID, ctx),
    );
    ctx.sessionSpans.set(sessionID, sessionSpan);
    setBoundedMap(ctx.sessionSpanContexts, sessionID, sessionSpan.spanContext());
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
      ...agentAttrs("unknown", agentType),
    },
  });
  return ctx.log("info", "otel: session.created", { sessionID, createdAt, isSubagent });
}

function sweepSession(sessionID: string, ctx: HandlerContext) {
  for (const [id, perm] of ctx.pendingPermissions) {
    if (perm.sessionID === sessionID) ctx.pendingPermissions.delete(id);
  }
  for (const [key, span] of ctx.pendingToolSpans) {
    if (span.sessionID === sessionID) {
      span.span?.setStatus({ code: SpanStatusCode.ERROR, message: "session ended before tool completed" });
      span.span?.end();
      ctx.pendingToolSpans.delete(key);
    }
  }
  ctx.pendingRuns.delete(sessionID);
  const msgPrefix = `${sessionID}:`;
  for (const [key, span] of ctx.messageSpans) {
    if (key.startsWith(msgPrefix)) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session ended before message completed" });
      span.end();
      ctx.messageSpans.delete(key);
    }
  }
  for (const key of ctx.messageOutputs.keys()) {
    if (key.startsWith(msgPrefix)) ctx.messageOutputs.delete(key);
  }
}

/** Emits a session.idle log event, ends the session span, and clears pending state. */
export function handleSessionIdle(
  e: { properties: { sessionID: string } },
  ctx: HandlerContext,
) {
  const sessionID = e.properties.sessionID;
  const totals = ctx.sessionTotals.get(sessionID);
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  ctx.sessionTotals.delete(sessionID);
  sweepSession(sessionID, ctx);

  let duration_ms: number | undefined;
  if (totals) {
    duration_ms = Date.now() - totals.startMs;
    ctx.instruments.toolDurationHistogram.record(duration_ms, {
      [ATTR_SESSION_ID]: sessionID,
    });
  }

  const sessionSpan = ctx.sessionSpans.get(sessionID);
  if (sessionSpan) {
    if (totals) {
      sessionSpan.setAttributes({
        agent: totals.agent,
        [ATTR_AGENT_TYPE]: totals.agentType,
        [ATTR_TOTAL_TOKENS]: totals.tokens,
        [ATTR_TOTAL_COST]: totals.cost,
        [ATTR_TOTAL_MESSAGES]: totals.messages,
      });
    }
    sessionSpan.setStatus({ code: SpanStatusCode.OK });
    sessionSpan.end();
    ctx.sessionSpans.delete(sessionID);
  }
  const runID = ctx.activeRuns.get(sessionID);
  if (runID) ctx.activeRuns.delete(sessionID);
  const runSpan = runID ? ctx.runSpans.get(runID) : undefined;
  if (runSpan) {
    if (totals) {
      runSpan.setAttributes({
        agent: totals.agent,
        [ATTR_AGENT_TYPE]: totals.agentType,
        [ATTR_TOTAL_TOKENS]: totals.tokens,
        [ATTR_TOTAL_COST]: totals.cost,
        [ATTR_TOTAL_MESSAGES]: totals.messages,
      });
    }
    runSpan.setStatus({ code: SpanStatusCode.OK });
    runSpan.end();
    ctx.runSpans.delete(runID!);
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
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
  ctx.log("debug", "otel: session.idle", {
    sessionID,
    ...(totals
      ? { duration_ms, total_tokens: totals.tokens, total_cost_usd: totals.cost, total_messages: totals.messages }
      : {}),
  });
}

/** Emits a session.error log event, ends the session span with error status, and clears pending state. */
export function handleSessionError(
  e: { properties: { sessionID: string; error?: { name: string; data?: unknown } } },
  ctx: HandlerContext,
) {
  const rawID = e.properties.sessionID;
  const sessionID = rawID ?? "unknown";
  const error = errorSummary(e.properties.error);
  const { agentName, agentType } = rawID
    ? getSessionAgentMeta(rawID, ctx)
    : { agentName: "unknown", agentType: "unknown" as const };
  const totals = rawID ? ctx.sessionTotals.get(rawID) : undefined;
  if (rawID) {
    ctx.sessionTotals.delete(rawID);
  }
  sweepSession(sessionID, ctx);

  if (rawID) {
    const sessionSpan = ctx.sessionSpans.get(rawID);
    if (sessionSpan) {
      if (totals) sessionSpan.setAttributes({ agent: totals.agent, [ATTR_AGENT_TYPE]: totals.agentType });
      sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message: error });
      sessionSpan.setAttribute("error", error);
      sessionSpan.end();
      ctx.sessionSpans.delete(rawID);
    }
    const runID = ctx.activeRuns.get(rawID);
    if (runID) ctx.activeRuns.delete(rawID);
    const runSpan = runID ? ctx.runSpans.get(runID) : undefined;
    if (runSpan) {
      if (totals) runSpan.setAttributes({ agent: totals.agent, [ATTR_AGENT_TYPE]: totals.agentType });
      runSpan.setStatus({ code: SpanStatusCode.ERROR, message: error });
      runSpan.setAttribute("error", error);
      runSpan.end();
      ctx.runSpans.delete(runID!);
    }
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: LOG_SESSION_ERROR,
    attributes: {
      "event.name": LOG_SESSION_ERROR,
      [ATTR_SESSION_ID]: sessionID,
      error,
      ...agentAttrs(agentName, agentType),
    },
  });
  ctx.log("error", "otel: session.error", { sessionID, error });
}
