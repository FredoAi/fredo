/**
 * handlers/tool.ts — tool lifecycle handlers (`fredo.tool.<name>` span family), Spec #3197 ST-4.
 *
 * Events: `session.tool.input.started|delta|ended`, `session.tool.called|progress|success|failed`.
 *
 * Ported from the V1 tool-part branch of `message.part.updated` on `main`
 * (`handlers/message.ts:457-640`): the emitted contract is reproduced verbatim —
 * span name `fredo.tool.<tool>`, the flat Fredo tool attributes, the `gen_ai.*`
 * tool/exception keys, the tool-duration metrics and the `tool_result` log body.
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionToolInputStarted :2225  (data.id, data.name, data.assistantMessageID)
 *     · SessionToolInputDelta   :2577  (data.id, data.delta)
 *     · SessionToolInputEnded   :2245  (data.id, data.text — the full JSON input text)
 *     · SessionToolCalled       :2265  (data.id, data.input: Record<string, any>, data.executed)
 *     · SessionToolProgress     :2592  (data.id, data.metadata: Record<string, JsonValue>)
 *     · SessionToolSuccess      :3035  (data.id, data.content: [ToolContent1, ...],
 *                                       data.metadata, data.executed)
 *     · SessionToolFailed       :3060  (data.id, data.error: SessionStructuredError :160,
 *                                       optional content/metadata, data.executed)
 *   The tool NAME arrives ONLY on `session.tool.input.started`; every later event
 *   carries just `data.id`, so the name (and the streamed argument text) is
 *   remembered per call in `pendingToolInputs`.
 *
 * Invariants:
 *   · A pending span entry is deleted only AFTER `.end()` (an entry removed
 *     before the span ends is an orphan the BatchSpanProcessor never exports).
 *   · `session.tool.progress` emits NOTHING (diagnostic only — preserved V1
 *     contract).
 *   · The `task`-tool child-completion attributes are preserved (Spec #2745 R-2).
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  ATTR_SESSION_ID,
  ATTR_AGENT_TYPE,
  ATTR_PARENT_SESSION_ID,
  ATTR_DURATION_MS,
  ATTR_TOOL_NAME,
  ATTR_TOOL_SUCCESS,
  ATTR_TOOL_ERROR,
  ATTR_TOOL_RESULT_SIZE,
  LOG_TOOL_RESULT,
} from "../telemetry-constants";
import {
  agentAttrs,
  childCompletionAttrs,
  getSessionAgentMeta,
  incrementSessionCounters,
  resolveSessionTraceContext,
  setBoundedMap,
} from "../util";
import { routingParentSessionId } from "./session";
import {
  ATTR_OP_NAME,
  GEN_AI_AGENT_NAME,
  GEN_AI_ERROR_TYPE,
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_TOOL_NAME,
  OP_NAME_TOOL,
  genAiAgentNameAttr,
  genAiConversationAttr,
  genAiExceptionEventAttrs,
  genAiOpNameAttr,
  genAiToolAttrs,
  genAiToolCallArgumentsAttr,
  genAiToolCallResultAttr,
} from "../genai-conventions";
import type { HandlerContext, V2EventOf } from "../types";

/** `pendingToolSpans` / `pendingToolInputs` key for one tool call. */
function toolKey(sessionID: string, id: string): string {
  return `${sessionID}:${id}`;
}

/** Human-readable text for a V2 `SessionStructuredError` (:160 — `{ type, message }`). */
function structuredErrorText(err: { type: string; message: string }): string {
  return err.message ? `${err.type}: ${err.message}` : err.type;
}

/** The structural slice of `ToolContent1` this handler reads. */
type ToolContentLike = { type: string; text?: string; uri?: string; name?: string | null };

/**
 * Flattens a tool result into display/log text: the `text` parts joined by a
 * newline. File parts contribute nothing to the text (their identity is not a
 * result body) — a file-only result therefore yields an empty string, which is
 * honest rather than a fabricated representation.
 */
function toolResultText(content: readonly ToolContentLike[] | undefined): string {
  if (!content) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Byte length of a UTF-8 string (`tool.result_size_bytes`). */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** `session.tool.input.started` — remembers the call id → tool name (+ start time). */
export function handleToolInputStarted(
  event: V2EventOf<"session.tool.input.started">,
  ctx: HandlerContext,
): void {
  const { sessionID, assistantMessageID, id, name } = event.data;
  setBoundedMap(ctx.pendingToolInputs, toolKey(sessionID, id), {
    sessionID,
    assistantMessageID,
    name,
    text: "",
    startMs: event.created,
  });
}

/** `session.tool.input.delta` — accumulates the streamed JSON argument text (no emission). */
export function handleToolInputDelta(
  event: V2EventOf<"session.tool.input.delta">,
  ctx: HandlerContext,
): void {
  const { sessionID, id, delta } = event.data;
  const key = toolKey(sessionID, id);
  const existing = ctx.pendingToolInputs.get(key);
  // Without `input.started` the tool name is unknown; creating an entry here
  // would only carry a nameless text. The `called` event still carries the
  // parsed input, so nothing is lost that matters for emission.
  if (!existing || !delta) return;
  setBoundedMap(ctx.pendingToolInputs, key, { ...existing, text: `${existing.text}${delta}` });
}

/** `session.tool.input.ended` — the complete argument text for the call. */
export function handleToolInputEnded(
  event: V2EventOf<"session.tool.input.ended">,
  ctx: HandlerContext,
): void {
  const { sessionID, assistantMessageID, id, text } = event.data;
  const key = toolKey(sessionID, id);
  const existing = ctx.pendingToolInputs.get(key);
  if (existing) {
    setBoundedMap(ctx.pendingToolInputs, key, { ...existing, text });
    return;
  }
  // Defensive: `input.started` was missed. Remember the text with an explicit
  // "unknown" name — never a fabricated tool name.
  setBoundedMap(ctx.pendingToolInputs, key, {
    sessionID,
    assistantMessageID,
    name: "unknown",
    text,
    startMs: event.created,
  });
}

/**
 * `session.tool.called` — opens the `fredo.tool.<name>` span (R-1.3).
 *
 * `data.input` is the PARSED argument object in V2, recorded both as the
 * `gen_ai.tool.call.arguments` JSON STRING (the SDK attribute type has no object
 * form) and as the flat `tool_input` JSON string.
 */
export function handleToolCalled(
  event: V2EventOf<"session.tool.called">,
  ctx: HandlerContext,
): void {
  const { sessionID, assistantMessageID, id, input } = event.data;
  const key = toolKey(sessionID, id);
  const pendingInput = ctx.pendingToolInputs.get(key);
  const tool = pendingInput?.name ?? "unknown";
  const startMs = pendingInput?.startMs ?? event.created;
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const parentSessionId = routingParentSessionId(sessionID, ctx);

  const toolSpan = ctx.tracer.startSpan(
    `${ctx.tracePrefix}tool.${tool}`,
    {
      startTime: startMs,
      kind: SpanKind.INTERNAL,
      attributes: {
        ...genAiOpNameAttr(OP_NAME_TOOL),
        ...genAiToolAttrs(tool, id),
        ...genAiToolCallArgumentsAttr(input),
        ...genAiAgentNameAttr(agentName),
        ...genAiConversationAttr(sessionID),
        [ATTR_SESSION_ID]: sessionID,
        ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
        [ATTR_TOOL_NAME]: tool,
        tool_call_id: id,
        agent: agentName,
        [ATTR_AGENT_TYPE]: agentType,
        ...(input ? { tool_input: JSON.stringify(input) } : {}),
      },
    },
    resolveSessionTraceContext(sessionID, ctx, { assistantMessageID }),
  );
  setBoundedMap(ctx.pendingToolSpans, key, { tool, sessionID, startMs, span: toolSpan });
  // EARS-9: every ISSUED call counts once, failed/interrupted included; the
  // count is recorded at session close as gen_ai.invoke_agent.tool_calls.
  incrementSessionCounters(sessionID, { toolCalls: 1 }, ctx);
  ctx.log("debug", "otel: tool span started", { sessionID, tool, key });
}

/** `session.tool.progress` — diagnostic only; emits nothing (preserved V1 contract). */
export function handleToolProgress(
  event: V2EventOf<"session.tool.progress">,
  ctx: HandlerContext,
): void {
  ctx.log("debug", "otel: tool progress (no emission)", {
    sessionID: event.data.sessionID,
    toolCallID: event.data.id,
  });
}

/**
 * `session.tool.success` — closes the tool span OK with the result payload.
 *
 * Records `fredo.tool.duration`, `gen_ai.execute_tool.duration` and
 * `gen_ai.client.operation.duration`, the flat `tool.success` /
 * `tool.result_size_bytes` / `duration_ms` attributes and
 * `gen_ai.tool.call.result`, logs `tool_result`, and preserves the `task`-tool
 * child-completion attributes.
 */
export function handleToolSuccess(
  event: V2EventOf<"session.tool.success">,
  ctx: HandlerContext,
): void {
  const { sessionID, id, content } = event.data;
  const key = toolKey(sessionID, id);
  // Look the entry up WITHOUT deleting it: the entry survives until the span has
  // actually been ended (deleting first would orphan it).
  const pending = ctx.pendingToolSpans.get(key);
  const pendingInput = ctx.pendingToolInputs.get(key);
  const tool = pending?.tool ?? pendingInput?.name ?? "unknown";
  const start = pending?.startMs ?? event.created;
  const end = event.created;
  const duration_ms = Math.max(0, end - start);
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const agent = agentName !== "unknown" ? agentName : undefined;
  const resultText = toolResultText(content);
  const resultBytes = byteLength(resultText);

  ctx.instruments.toolDurationHistogram.record(duration_ms, {
    [ATTR_SESSION_ID]: sessionID,
    tool_name: tool,
    success: true,
  });
  ctx.instruments.genAiExecuteToolDuration.record(duration_ms / 1000, {
    [GEN_AI_TOOL_NAME]: tool,
    ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
  });
  ctx.instruments.genAiOperationDuration.record(duration_ms / 1000, {
    [ATTR_OP_NAME]: OP_NAME_TOOL,
  });

  const toolSpan = pending?.span;
  if (toolSpan) {
    const parentSessionId = routingParentSessionId(sessionID, ctx);
    toolSpan.setAttributes({
      agent: agentName,
      [ATTR_AGENT_TYPE]: agentType,
      [ATTR_TOOL_SUCCESS]: true,
      [ATTR_DURATION_MS]: duration_ms,
      [ATTR_TOOL_RESULT_SIZE]: resultBytes,
      ...genAiToolCallResultAttr(resultText),
      ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
    });
    toolSpan.setStatus({ code: SpanStatusCode.OK });
    // Spec #2745 R-2: the child-completion snapshot recorded at the child's
    // close is attached to the parent's `fredo.tool.task` span before it exports.
    if (tool === "task") {
      const childCompletion = ctx.pendingChildCompletions.get(sessionID);
      if (childCompletion) toolSpan.setAttributes(childCompletionAttrs(childCompletion));
    }
    toolSpan.end(end);
  }
  // The span has now been ended (or there was none to end) — only now is it
  // safe to drop the pending entries.
  ctx.pendingToolSpans.delete(key);
  ctx.pendingToolInputs.delete(key);

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: start,
    observedTimestamp: Date.now(),
    body: LOG_TOOL_RESULT,
    attributes: {
      "event.name": LOG_TOOL_RESULT,
      [ATTR_SESSION_ID]: sessionID,
      tool_name: tool,
      ...agentAttrs(agentName, agentType),
      success: true,
      [ATTR_DURATION_MS]: duration_ms,
      [ATTR_TOOL_RESULT_SIZE]: resultBytes,
    },
  });
  ctx.log("info", "otel: tool_result", { sessionID, tool_name: tool, success: true, duration_ms });
}

/**
 * `session.tool.failed` — closes the tool span ERROR (R-4.1) with `tool.error`,
 * the `gen_ai.client.operation.exception` span event (`exception.type` = tool
 * name, `exception.message` = error text), the same metrics with `error.type`
 * and the `tool_result` log record at ERROR severity.
 */
export function handleToolFailed(
  event: V2EventOf<"session.tool.failed">,
  ctx: HandlerContext,
): void {
  const { sessionID, id, error } = event.data;
  const key = toolKey(sessionID, id);
  const pending = ctx.pendingToolSpans.get(key);
  const pendingInput = ctx.pendingToolInputs.get(key);
  const tool = pending?.tool ?? pendingInput?.name ?? "unknown";
  const start = pending?.startMs ?? event.created;
  const end = event.created;
  const duration_ms = Math.max(0, end - start);
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const agent = agentName !== "unknown" ? agentName : undefined;
  const errorText = structuredErrorText(error);

  ctx.instruments.toolDurationHistogram.record(duration_ms, {
    [ATTR_SESSION_ID]: sessionID,
    tool_name: tool,
    success: false,
  });
  ctx.instruments.genAiExecuteToolDuration.record(duration_ms / 1000, {
    [GEN_AI_TOOL_NAME]: tool,
    ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
    [GEN_AI_ERROR_TYPE]: error.type,
  });
  ctx.instruments.genAiOperationDuration.record(duration_ms / 1000, {
    [ATTR_OP_NAME]: OP_NAME_TOOL,
    [GEN_AI_ERROR_TYPE]: error.type,
  });

  const toolSpan = pending?.span;
  if (toolSpan) {
    const parentSessionId = routingParentSessionId(sessionID, ctx);
    toolSpan.setAttributes({
      agent: agentName,
      [ATTR_AGENT_TYPE]: agentType,
      [ATTR_TOOL_SUCCESS]: false,
      [ATTR_TOOL_ERROR]: errorText,
      [ATTR_DURATION_MS]: duration_ms,
      ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
    });
    toolSpan.addEvent(
      GEN_AI_EVENT_EXCEPTION,
      {
        [ATTR_SESSION_ID]: sessionID,
        ...genAiOpNameAttr(OP_NAME_TOOL),
        [GEN_AI_TOOL_NAME]: tool,
        ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
        ...genAiExceptionEventAttrs({ type: tool, message: errorText }),
      },
      end,
    );
    toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorText });
    toolSpan.end(end);
  }
  ctx.pendingToolSpans.delete(key);
  ctx.pendingToolInputs.delete(key);

  ctx.emitLog({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: start,
    observedTimestamp: Date.now(),
    body: LOG_TOOL_RESULT,
    attributes: {
      "event.name": LOG_TOOL_RESULT,
      [ATTR_SESSION_ID]: sessionID,
      tool_name: tool,
      ...agentAttrs(agentName, agentType),
      success: false,
      [ATTR_DURATION_MS]: duration_ms,
      error: errorText,
    },
  });
  ctx.log("error", "otel: tool_result", {
    sessionID,
    tool_name: tool,
    success: false,
    duration_ms,
  });
}
