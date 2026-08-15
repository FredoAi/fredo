/**
 * handlers/session.ts — Session lifecycle handlers for the Fredo OpenCode plugin.
 *
 * Handles session.created, session.idle, session.error, and session.status events.
 * Creates session spans, emits log events, and manages session totals.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
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
} from "../telemetry-constants";
import {
  agentAttrs,
  errorSummary,
  getSessionAgentMeta,
  setBoundedMap,
  childCompletionAttrs,
  resolveSessionTraceContext,
} from "../util";
import {
  createParentSpanLink,
  genAiOpNameAttr,
  genAiConversationAttr,
  genAiAgentNameAttr,
  genAiExceptionAttrs,
  ATTR_OP_NAME,
  GEN_AI_AGENT_NAME,
  GEN_AI_ERROR_TYPE,
  GEN_AI_EVENT_EXCEPTION,
  EXCEPTION_MESSAGE,
  OP_NAME_SESSION,
} from "../genai-conventions";
import { MAX_CHILD_COMPLETIONS } from "../types";
import type { HandlerContext, PendingChildCompletion, SessionAgentType } from "../types";

/**
 * Resolves the parent span's SpanContext from maps, used for building span links
 * from child session spans to parent session spans (REQ-1).
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
      ...genAiOpNameAttr(OP_NAME_SESSION),
      // GA-4: gen_ai.conversation.id / gen_ai.agent.name (agent only when known).
      ...genAiConversationAttr(sessionID),
      ...genAiAgentNameAttr(agent),
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
        ...genAiOpNameAttr(OP_NAME_SESSION),
        // GA-4: gen_ai.conversation.id / gen_ai.agent.name (agent only when known).
        ...genAiConversationAttr(sessionID),
        ...genAiAgentNameAttr(agent),
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
  const { id: sessionID, time, parentID: eventParentID } = e.properties.info;
  const createdAt = time.created;

  // Fallback: opencode's session.created intermittently omits parentID (AC-4).
  // When missing, scan pending tool spans for a running 'task' tool — its
  // sessionID is the parent session that spawned this subagent session.
  let parentID: string | undefined = eventParentID;
  if (!parentID) {
    for (const [, pending] of ctx.pendingToolSpans) {
      if (pending.tool === "task" && pending.sessionID !== sessionID) {
        parentID = pending.sessionID;
        break;
      }
    }
    if (parentID) {
      ctx.log("debug", "otel: parentID resolved from pending task tool span", { sessionID, parentID });
    }
  }

  const isSubagent = !!parentID;
  const agentType: SessionAgentType = isSubagent ? "subagent" : "primary";

  ctx.instruments.sessionCounter.add(1, { [ATTR_SESSION_ID]: sessionID, [ATTR_IS_SUBAGENT]: isSubagent });

  const existingTotals = ctx.sessionTotals.get(sessionID);
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: createdAt,
    tokens: existingTotals?.tokens ?? 0,
    cost: existingTotals?.cost ?? 0,
    messages: existingTotals?.messages ?? 0,
    agent: existingTotals?.agent ?? "unknown",
    agentType,
    ...(parentID ? { parentId: parentID } : {}),
    // EARS-9 counters — carried through this field-by-field reconstruction so a
    // session.created after partial chat activity never silently resets them.
    inferenceCalls: existingTotals?.inferenceCalls ?? 0,
    toolCalls: existingTotals?.toolCalls ?? 0,
  });

  if (parentID) {
    // REQ-1: Resolve parent span context and create span link from child to parent
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
          // GA-4: gen_ai.conversation.id on session span creation. The subagent
          // agent name is unresolved here ("unknown") — gen_ai.agent.name is set
          // at session idle / error once the agent resolves.
          ...genAiConversationAttr(sessionID),
          [ATTR_SESSION_ID]: sessionID,
          [ATTR_PARENT_SESSION_ID]: parentID,
          agent: "unknown",
          [ATTR_AGENT_TYPE]: agentType,
          [ATTR_IS_SUBAGENT]: isSubagent,
        },
        ...(spanLink ? { links: [spanLink] } : {}),
      },
      resolveSessionTraceContext(parentID, ctx),
    );

    // Look up pending instruction for this subagent from message.part.updated
    // subtask events. We do NOT consume it here — startMessageSpan needs it to
    // set the prompt attribute on the LLM span, which the Rust adapter reads for
    // subagent instruction extraction into the delivery payload. Consuming it
    // here would leave startMessageSpan with nothing (Bug #633 cycle 2).
    // Instead, store it in sessionTotals.instruction so startMessageSpan can
    // reliably find it via the sessionID-keyed sessionTotals entry — pending-
    // SubagentInstructions is keyed by parent session ID, which startMessageSpan
    // may not be able to resolve if parentId isn't in sessionTotals yet.
    const instruction = ctx.pendingSubagentInstructions.get(parentID);
    if (instruction) {
      ctx.log("debug", "otel: subagent instruction found in pending store", {
        sessionID,
        parentID,
        instructionLength: instruction.length,
      });
      const totals = ctx.sessionTotals.get(sessionID);
      if (totals) {
        totals.instruction = instruction;
      }
      // AC-6 (Spec #633): Set instruction as a span attribute on the session span
      // so the adapter can extract it from OTLP attributes even when the fredo.llm
      // span is never created (non-streaming subagent messages skip startMessageSpan).
      sessionSpan.setAttribute('instruction', instruction);
    }

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
  for (const key of ctx.messageThinking.keys()) {
    if (key.startsWith(msgPrefix)) ctx.messageThinking.delete(key);
  }
  for (const key of ctx.messageMeta.keys()) {
    if (key.startsWith(msgPrefix)) ctx.messageMeta.delete(key);
  }
}

/** Collect all accumulated message outputs for a session and return concatenated text. */
function collectSessionOutput(sessionID: string, ctx: HandlerContext): string {
  const msgPrefix = `${sessionID}:`;
  let output = '';
  for (const [key, text] of ctx.messageOutputs) {
    if (key.startsWith(msgPrefix)) {
      output += text;
    }
  }
  return output;
}

/**
 * Records a child session's completion snapshot keyed by the PARENT session id
 * (Spec #2745 R-2) so the parent's `fredo.tool.task` span can carry the child's
 * identity + completion totals before it exports. No-op (returns undefined) for a
 * primary session (no parentId) or when the session has no totals — the parent's
 * task span then simply exports without child attrs (degrades silently). Gated on
 * the in-process `sessionTotals.parentId` (NOT the emitted `session.parent_id`
 * span attribute, which the Phase-0 live diagnostic observed ABSENT on child
 * `fredo.session` rows).
 */
export function recordChildCompletion(
  sessionID: string,
  ctx: HandlerContext,
): PendingChildCompletion | undefined {
  const totals = ctx.sessionTotals.get(sessionID);
  const parentId = totals?.parentId;
  if (!totals || !parentId) return undefined;
  const { agentName } = getSessionAgentMeta(sessionID, ctx);
  const snapshot: PendingChildCompletion = {
    childSessionId: sessionID,
    agent: agentName,
    tokens: totals.tokens,
    cost: totals.cost,
    messages: totals.messages,
    output: collectSessionOutput(sessionID, ctx),
  };
  setBoundedMap(ctx.pendingChildCompletions, parentId, snapshot, MAX_CHILD_COMPLETIONS);
  return snapshot;
}

/**
 * Direct attach-at-idle/error point (Spec #2745 R-2): when a child completes, if
 * the parent's `fredo.tool.task` span is still pending, attach the snapshot's
 * five flat attrs onto it right away. ST-1 confirmed the child completes BEFORE
 * the parent task span ends, so this fires before the tool-completed branch's
 * attach in message.ts — both are safe (idempotent, same five keys).
 */
function attachChildCompletionToPendingTaskSpan(
  parentSessionId: string,
  snapshot: PendingChildCompletion,
  ctx: HandlerContext,
) {
  for (const [, pending] of ctx.pendingToolSpans) {
    if (pending.tool === "task" && pending.sessionID === parentSessionId && pending.span) {
      pending.span.setAttributes(childCompletionAttrs(snapshot));
    }
  }
}

/** Emits a session.idle log event, ends the session span, and clears pending state. */
export function handleSessionIdle(
  e: { properties: { sessionID: string } },
  ctx: HandlerContext,
) {
  const sessionID = e.properties.sessionID;

  // Collect message outputs BEFORE sweepSession deletes them
  const sessionOutput = collectSessionOutput(sessionID, ctx);

  const totals = ctx.sessionTotals.get(sessionID);
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  // Spec #2745 R-2: record the child-completion snapshot (keyed by the PARENT
  // session id) BEFORE the totals delete, and attach it directly to the parent's
  // still-pending task span when present (attach-at-idle point). Both degrade
  // silently when this session has no parent / no pending task span.
  const childCompletion = recordChildCompletion(sessionID, ctx);
  if (childCompletion && totals?.parentId) {
    attachChildCompletionToPendingTaskSpan(totals.parentId, childCompletion, ctx);
  }
  ctx.sessionTotals.delete(sessionID);
  sweepSession(sessionID, ctx);

  let duration_ms: number | undefined;
  if (totals) {
    duration_ms = Date.now() - totals.startMs;
    ctx.instruments.toolDurationHistogram.record(duration_ms, {
      [ATTR_SESSION_ID]: sessionID,
    });
    // GA-7: gen_ai.invoke_agent.duration + gen_ai.client.operation.duration
    // (gen-ai-metrics.md; values in SECONDS per the registry unit).
    const agent = totals.agent !== "unknown" ? totals.agent : undefined;
    ctx.instruments.genAiInvokeAgentDuration.record(duration_ms / 1000, {
      ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
    });
    ctx.instruments.genAiOperationDuration.record(duration_ms / 1000, {
      [ATTR_OP_NAME]: OP_NAME_SESSION,
      ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
    });
    // GA-7 / Spec #2680 Sub-task 3: gen_ai.invoke_agent.inference_calls /
    // tool_calls (gen-ai-metrics.md; units {inference_call}/{tool_call}) at
    // session idle — EARS-9. Recorded only when the count is > 0: a session
    // that issued no inference/tool calls emits no invoke_agent count rows
    // (EARS-10, no zero-value placeholder rows).
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

  const sessionSpan = ctx.sessionSpans.get(sessionID);
  if (sessionSpan) {
    if (totals) {
      sessionSpan.setAttributes({
        // GA-4: gen_ai.agent.name on the session span once the agent resolves
        // (session idle / chat.message — totals.agent carries the resolution).
        ...genAiAgentNameAttr(totals.agent),
        agent: totals.agent,
        [ATTR_AGENT_TYPE]: totals.agentType,
        [ATTR_TOTAL_TOKENS]: totals.tokens,
        [ATTR_TOTAL_COST]: totals.cost,
        [ATTR_TOTAL_MESSAGES]: totals.messages,
      });
    }
    // Set accumulated output text on the session span so the adapter includes
    // it in the OTLP payload (for SubagentNode output display in Mission Monitor).
    // The adapter's otlp_attrs_to_payload preserves ALL span attributes, so
    // 'output' and 'response_text' will be in the delivery payload.
    if (sessionOutput) {
      sessionSpan.setAttribute('output', sessionOutput);
      sessionSpan.setAttribute('response_text', sessionOutput);
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

  // Collect message outputs BEFORE sweepSession deletes them
  const sessionOutput = rawID ? collectSessionOutput(rawID, ctx) : '';

  const error = errorSummary(e.properties.error);
  const { agentName, agentType } = rawID
    ? getSessionAgentMeta(rawID, ctx)
    : { agentName: "unknown", agentType: "unknown" as const };
  const totals = rawID ? ctx.sessionTotals.get(rawID) : undefined;
  if (rawID) {
    // Spec #2745 R-2: record the child-completion snapshot (keyed by the PARENT
    // session id) BEFORE the totals delete, and attach it directly to the
    // parent's still-pending task span when present. Degrades silently when this
    // session has no parent / no pending task span.
    const childCompletion = recordChildCompletion(rawID, ctx);
    if (childCompletion && totals?.parentId) {
      attachChildCompletionToPendingTaskSpan(totals.parentId, childCompletion, ctx);
    }
    ctx.sessionTotals.delete(rawID);
  }
  sweepSession(sessionID, ctx);

  const agent = agentName !== "unknown" ? agentName : undefined;
  const duration_ms = totals ? Date.now() - totals.startMs : undefined;
  if (duration_ms !== undefined) {
    // GA-7: gen_ai.invoke_agent.duration + gen_ai.client.operation.duration for
    // the failed agent dispatch (gen-ai-metrics.md; values in SECONDS, error.type
    // attached since the operation ended in an error).
    const errorType = e.properties.error?.name ?? "session.error";
    ctx.instruments.genAiInvokeAgentDuration.record(duration_ms / 1000, {
      ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      [GEN_AI_ERROR_TYPE]: errorType,
    });
    ctx.instruments.genAiOperationDuration.record(duration_ms / 1000, {
      [ATTR_OP_NAME]: OP_NAME_SESSION,
      ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      [GEN_AI_ERROR_TYPE]: errorType,
    });
    // GA-7 / Spec #2680 Sub-task 3: gen_ai.invoke_agent.inference_calls /
    // tool_calls (gen-ai-metrics.md; units {inference_call}/{tool_call}) at
    // session error — EARS-9 (failed sessions included). Recorded only when the
    // count is > 0 (EARS-10, no zero-value placeholder rows).
    const inferenceCalls = totals?.inferenceCalls ?? 0;
    const toolCalls = totals?.toolCalls ?? 0;
    if (inferenceCalls > 0) {
      ctx.instruments.genAiInferenceCalls.record(inferenceCalls, {
        ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      });
    }
    if (toolCalls > 0) {
      ctx.instruments.genAiToolCalls.record(toolCalls, {
        ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      });
    }
  }

  if (rawID) {
    const sessionSpan = ctx.sessionSpans.get(rawID);
    if (sessionSpan) {
      if (totals) {
        sessionSpan.setAttributes({
          // GA-4: gen_ai.agent.name on the session span when the agent resolved.
          ...genAiAgentNameAttr(totals.agent),
          agent: totals.agent,
          [ATTR_AGENT_TYPE]: totals.agentType,
        });
      }
      if (sessionOutput) {
        sessionSpan.setAttribute('output', sessionOutput);
        sessionSpan.setAttribute('response_text', sessionOutput);
      }
      // GA-6: gen_ai.client.operation.exception as a SPAN EVENT on the session
      // span (gen-ai-exceptions.md), attached BEFORE sessionSpan.end() so the
      // receiver persists it to telemetry_spans.events_json. exception.message
      // is set unconditionally (errorSummary always yields a string) so at least
      // one of the Conditionally Required exception.type / exception.message is
      // present. EARS-5: no live session span → the event is skipped (it only
      // fires here, inside the live-span branch).
      sessionSpan.addEvent(
        GEN_AI_EVENT_EXCEPTION,
        {
          [ATTR_SESSION_ID]: sessionID,
          ...genAiOpNameAttr(OP_NAME_SESSION),
          ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
          ...genAiExceptionAttrs(e.properties.error),
          [EXCEPTION_MESSAGE]: error,
        },
        Date.now(),
      );
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
