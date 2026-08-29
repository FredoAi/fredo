/**
 * handlers/message.ts — Chat/LLM message and tool handlers for the Fredo OpenCode plugin.
 *
 * Handles message.updated (completion) and message.part.updated (streaming) events.
 * Creates LLM spans for assistant messages, tool spans for tool executions, and emits
 * token/cost metrics and log events.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { SpanStatusCode, SpanKind } from "@opentelemetry/api";
import {
  ATTR_SESSION_ID,
  ATTR_AGENT_TYPE,
  ATTR_PARENT_SESSION_ID,
  ATTR_INPUT_TOKENS,
  ATTR_OUTPUT_TOKENS,
  ATTR_REASONING_TOKENS,
  ATTR_CACHE_READ_TOKENS,
  ATTR_CACHE_CREATION_TOKENS,
  ATTR_MODEL,
  ATTR_PROVIDER,
  ATTR_DURATION_MS,
  ATTR_SUCCESS,
  ATTR_TOOL_NAME,
  ATTR_TOOL_SUCCESS,
  ATTR_TOOL_ERROR,
  ATTR_TOOL_RESULT_SIZE,
  ATTR_COST_USD,
  LOG_API_REQUEST,
  LOG_API_ERROR,
  LOG_TOOL_RESULT,
  LOG_USER_PROMPT,
} from "../telemetry-constants";
import {
  agentAttrs,
  errorSummary,
  getSessionAgentMeta,
  setBoundedMap,
  childCompletionAttrs,
  accumulateSessionTotals,
  incrementSessionCounters,
  resolveSessionTraceContext,
} from "../util";
// Spec #2768 ST-1: seam-guarded parent resolution for self-carried routing.
import { routingParentSessionId } from "./session";
import {
  genAiOpNameAttr,
  genAiPromptAttr,
  genAiResponseBodyAttr,
  genAiUsageAttrs,
  genAiRequestAttrs,
  genAiConversationAttr,
  genAiResponseAttrs,
  genAiToolAttrs,
  genAiToolCallArgumentsAttr,
  genAiToolCallResultAttr,
  genAiAgentNameAttr,
  genAiInferenceDetailsAttrs,
  genAiExceptionAttrs,
  genAiExceptionEventAttrs,
  ATTR_OP_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_TOKEN_TYPE,
  GEN_AI_TOOL_NAME,
  GEN_AI_AGENT_NAME,
  GEN_AI_ERROR_TYPE,
  GEN_AI_EVENT_INFERENCE_DETAILS,
  GEN_AI_EVENT_EXCEPTION,
  OP_NAME_CHAT,
  OP_NAME_TOOL,
} from "../genai-conventions";
import type { HandlerContext } from "../types";

/**
 * Handles a completed assistant message: increments token and cost counters, emits
 * either an api_request or api_error log event, and ends the LLM span for this message.
 */
export function handleMessageUpdated(
  e: {
    properties: {
      info: {
        sessionID: string;
        id: string;
        parentID: string;
        role: string;
        modelID?: string;
        providerID?: string;
        time: { created: number; completed?: number };
        tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
        cost: number;
        error?: { name: string; data?: unknown };
        finish?: string;
      };
    };
  },
  ctx: HandlerContext,
) {
  const msg = e.properties.info;
  if (msg.role !== "assistant") return;
  setBoundedMap(ctx.assistantRuns, msg.id, msg.parentID);
  if (!msg.time.completed) return;

  const { sessionID, modelID, providerID } = msg;
  const duration = msg.time.completed - msg.time.created;
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const agent = agentName;

  // EARS-9: each completed assistant message is one inference call for the
  // session — failed operations included (recorded at session idle/error as
  // gen_ai.invoke_agent.inference_calls). Incremented BEFORE accumulateSessionTotals
  // so that field-by-field reconstruction carries the count, not resets it.
  incrementSessionCounters(sessionID, { inferenceCalls: 1 }, ctx);

  const { tokenCounter } = ctx.instruments;
  tokenCounter.add(msg.tokens.input, { "session.id": sessionID, model: modelID, agent, type: "input" });
  tokenCounter.add(msg.tokens.output, { "session.id": sessionID, model: modelID, agent, type: "output" });
  tokenCounter.add(msg.tokens.reasoning, { "session.id": sessionID, model: modelID, agent, type: "reasoning" });
  tokenCounter.add(msg.tokens.cache.read, { "session.id": sessionID, model: modelID, agent, type: "cacheRead" });
  tokenCounter.add(msg.tokens.cache.write, { "session.id": sessionID, model: modelID, agent, type: "cacheCreation" });

  ctx.instruments.costCounter.add(msg.cost, { [ATTR_SESSION_ID]: sessionID, model: modelID, agent });

  accumulateSessionTotals(sessionID, msg.tokens, msg.cost, ctx);

  ctx.log("debug", "otel: token+cost counters incremented", {
    sessionID,
    model: modelID,
    agent,
    input: msg.tokens.input,
    output: msg.tokens.output,
    reasoning: msg.tokens.reasoning,
    cacheRead: msg.tokens.cache.read,
    cacheWrite: msg.tokens.cache.write,
    cost_usd: msg.cost,
  });

  // GA-7: gen_ai.* metric instruments (gen-ai-metrics.md). Durations are recorded
  // in SECONDS per the registry unit (s); gen_ai.client.token.usage MUST NOT be
  // reported when counts are unavailable — zero/absent counts are omitted (the
  // same contract genAiUsageAttrs applies to span attributes).
  const provider = providerID !== "unknown" ? providerID : undefined;
  const model = modelID !== "unknown" ? modelID : undefined;
  const genAiBaseLabels = {
    [ATTR_OP_NAME]: OP_NAME_CHAT,
    ...(provider ? { [GEN_AI_PROVIDER_NAME]: provider } : {}),
    ...(model ? { [GEN_AI_REQUEST_MODEL]: model } : {}),
  };
  ctx.instruments.genAiOperationDuration.record(duration / 1000, {
    ...genAiBaseLabels,
    ...(msg.error ? { [GEN_AI_ERROR_TYPE]: msg.error.name } : {}),
  });
  if (msg.tokens.input > 0) {
    ctx.instruments.genAiTokenUsage.record(msg.tokens.input, {
      ...genAiBaseLabels,
      [GEN_AI_TOKEN_TYPE]: "input",
    });
  }
  if (msg.tokens.output > 0) {
    ctx.instruments.genAiTokenUsage.record(msg.tokens.output, {
      ...genAiBaseLabels,
      [GEN_AI_TOKEN_TYPE]: "output",
    });
  }

  const msgKey = `${sessionID}:${msg.id}`;
  const msgSpan = ctx.messageSpans.get(msgKey);
  const outputText = ctx.messageOutputs.get(msgKey);
  const thinkingText = ctx.messageThinking.get(msgKey);
  if (msgSpan) {
    // Spec #2768 ST-1: resolve the parent for the self-carried
    // session.parent_id attribute — totals.parentId when known, else the
    // pending-task scan (the parent may resolve only at THIS message-
    // completion event when session.created omitted parentID). Seam-guarded:
    // returns undefined under FREDO_SUPPRESS_PARENT_ROUTING.
    const parentSessionId = routingParentSessionId(sessionID, ctx);
    msgSpan.setAttributes({
      agent: agentName,
      [ATTR_AGENT_TYPE]: agentType,
      [ATTR_INPUT_TOKENS]: msg.tokens.input,
      [ATTR_OUTPUT_TOKENS]: msg.tokens.output,
      [ATTR_REASONING_TOKENS]: msg.tokens.reasoning,
      [ATTR_CACHE_READ_TOKENS]: msg.tokens.cache.read,
      [ATTR_CACHE_CREATION_TOKENS]: msg.tokens.cache.write,
      [ATTR_DURATION_MS]: duration,
      [ATTR_COST_USD]: msg.cost,
      // Spec #627: Set both response_text AND output on the message/LLM span
      // (guaranteed export) so the adapter can map output into the delivery payload.
      // The session span sets both but may never be exported for short-lived subagents.
      ...(outputText ? { response_text: outputText, output: outputText } : {}),
      // Spec #2688 AC 4: capture reasoning/thinking text as a FLAT span attribute.
      // There is no gen_ai.* registry key for reasoning CONTENT (NFR-2) — the
      // key must match the Hook-path injection (opencode.rs:1514) and the
      // frontend read (useMissionMonitor.ts:42).
      ...(thinkingText ? { agentThinking: thinkingText } : {}),
      // Spec #633: Add gen_ai.* attributes alongside existing flat attributes
      // for OTel GenAI semantic convention compatibility (REQ-4, REQ-5).
      ...genAiResponseBodyAttr(outputText, msg.finish),
      // GA-2: Full gen_ai.usage.* family (reasoning + cache read/creation) and
      // gen_ai.response.model / gen_ai.response.finish_reasons on completion.
      ...genAiUsageAttrs({
        input: msg.tokens.input,
        output: msg.tokens.output,
        reasoning: msg.tokens.reasoning,
        cacheRead: msg.tokens.cache.read,
        cacheCreation: msg.tokens.cache.write,
      }),
      ...genAiResponseAttrs(modelID, msg.finish),
      ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
    });
    if (msg.error) {
      msgSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(msg.error) });
    } else {
      msgSpan.setStatus({ code: SpanStatusCode.OK });
    }

    // GA-5: gen_ai.client.inference.operation.details event (gen-ai-events.md,
    // Opt-In) as a SPAN EVENT on the operation's span — attached BEFORE
    // span.end() so the OTLP receiver persists it to telemetry_spans.events_json
    // (raw.rs:140-144). Input/output text stays on the span attributes as
    // gen_ai.input.messages / gen_ai.output.messages: events require the
    // structured form the JS SDK cannot produce (EARS-6, gen-ai-events.md
    // notes 25/26), so the details event carries operation attrs only.
    msgSpan.addEvent(
      GEN_AI_EVENT_INFERENCE_DETAILS,
      {
        [ATTR_SESSION_ID]: sessionID,
        ...genAiInferenceDetailsAttrs({
          providerID,
          modelID,
          sessionID,
          inputText: ctx.runInputs.get(msg.parentID),
          outputText,
          usage: {
            input: msg.tokens.input,
            output: msg.tokens.output,
            reasoning: msg.tokens.reasoning,
            cacheRead: msg.tokens.cache.read,
            cacheCreation: msg.tokens.cache.write,
          },
          finish: msg.finish,
          errorType: msg.error ? msg.error.name : undefined,
        }),
      },
      msg.time.completed,
    );

    // GA-6: gen_ai.client.operation.exception event (gen-ai-exceptions.md) as a
    // SPAN EVENT on the failing operation's span before span.end(). Attributes
    // stay identical to today (genAiExceptionAttrs — exception.stacktrace is
    // omitted when the payload carried no stack, never fabricated).
    if (msg.error) {
      msgSpan.addEvent(
        GEN_AI_EVENT_EXCEPTION,
        {
          [ATTR_SESSION_ID]: sessionID,
          ...genAiOpNameAttr(OP_NAME_CHAT),
          ...(provider ? { [GEN_AI_PROVIDER_NAME]: provider } : {}),
          ...genAiExceptionAttrs(msg.error),
        },
        msg.time.completed,
      );
    }

    msgSpan.end(msg.time.completed);
    ctx.messageSpans.delete(msgKey);
    ctx.messageOutputs.delete(msgKey);
    ctx.messageThinking.delete(msgKey);
    ctx.messageMeta.delete(msgKey);
  }

  if (msg.error) {
    ctx.emitLog({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      timestamp: msg.time.created,
      observedTimestamp: Date.now(),
      body: LOG_API_ERROR,
      attributes: {
        "event.name": LOG_API_ERROR,
        [ATTR_SESSION_ID]: sessionID,
        model: modelID ?? "",
        provider: providerID ?? "",
        ...agentAttrs(agentName, agentType),
        error: errorSummary(msg.error),
        [ATTR_DURATION_MS]: duration,
      },
    });
    return ctx.log("error", "otel: api_error", {
      sessionID,
      model: modelID,
      agent,
      error: errorSummary(msg.error),
      duration_ms: duration,
    });
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: msg.time.created,
    observedTimestamp: Date.now(),
    body: LOG_API_REQUEST,
    attributes: {
      "event.name": LOG_API_REQUEST,
      [ATTR_SESSION_ID]: sessionID,
      model: modelID ?? "",
      provider: providerID ?? "",
      ...agentAttrs(agentName, agentType),
      [ATTR_COST_USD]: msg.cost,
      [ATTR_DURATION_MS]: duration,
      [ATTR_INPUT_TOKENS]: msg.tokens.input,
      [ATTR_OUTPUT_TOKENS]: msg.tokens.output,
      [ATTR_REASONING_TOKENS]: msg.tokens.reasoning,
      [ATTR_CACHE_READ_TOKENS]: msg.tokens.cache.read,
      [ATTR_CACHE_CREATION_TOKENS]: msg.tokens.cache.write,
    },
  });
  return ctx.log("info", "otel: api_request", {
    sessionID,
    model: modelID,
    agent,
    cost_usd: msg.cost,
    duration_ms: duration,
    input_tokens: msg.tokens.input,
    output_tokens: msg.tokens.output,
  });
}

/**
 * The tool part's `state` as carried by `message.part.updated` events.
 *
 * The opencode SDK nests the lifecycle timestamps under `state.time`
 * (types.gen.d.ts:415-458 — ToolStateRunning/Completed/Error), while some
 * legacy/mock payloads carried them flat at `state.start`/`state.end`.
 * `toolPartTimes` reads the SDK shape first and falls back to the flat shape.
 */
export type ToolPartState = {
  status: string;
  start?: number;
  end?: number;
  time?: { start?: number; end?: number };
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
};

/**
 * Extracts the start/end timestamps from a tool part's state, reading the SDK's
 * nested `state.time` first and falling back to the flat `state.start`/`state.end`
 * carried by legacy payloads. Pure — unit-testable without a tracer.
 */
export function toolPartTimes(state: ToolPartState): { start?: number; end?: number } {
  return {
    start: state.time?.start ?? state.start,
    end: state.time?.end ?? state.end,
  };
}

/**
 * Tracks tool execution time between running and completed/error part updates,
 * records a tool.duration histogram measurement, manages the tool child span, and
 * emits a tool_result log event.
 */
export function handleMessagePartUpdated(
  e: {
    properties: {
      part: {
        type: string;
        sessionID: string;
        messageID: string;
        callID?: string;
        tool?: string;
        text?: string;
        reasoning?: string;
        state?: ToolPartState;
      };
    };
  },
  ctx: HandlerContext,
) {
  const part = e.properties.part;

  // Text parts accumulate streaming output
  if (part.type === "text") {
    const key = `${part.sessionID}:${part.messageID}`;
    ctx.messageOutputs.set(key, `${ctx.messageOutputs.get(key) ?? ""}${part.text}`);
    // GA-7 / Spec #2680 Sub-task 3: TTFC + chunk cadence (gen-ai-metrics.md,
    // EARS-7/8). Measured at part arrival with Date.now() vs the per-message
    // start time seeded by startMessageSpan. A text chunk with no known start
    // time (non-streaming or otherwise unmeasured message) records NOTHING —
    // absence is correct, never a fabricated timestamp (EARS-10).
    const meta = ctx.messageMeta.get(key);
    if (meta) {
      const arrival = Date.now();
      const chunkLabels = {
        [ATTR_OP_NAME]: OP_NAME_CHAT,
        ...(meta.providerID && meta.providerID !== "unknown"
          ? { [GEN_AI_PROVIDER_NAME]: meta.providerID }
          : {}),
        ...(meta.modelID && meta.modelID !== "unknown"
          ? { [GEN_AI_REQUEST_MODEL]: meta.modelID }
          : {}),
      };
      if (!meta.firstChunkRecorded) {
        ctx.instruments.genAiTimeToFirstChunk.record(
          Math.max(0, arrival - meta.startedAtMs) / 1000,
          chunkLabels,
        );
        meta.firstChunkRecorded = true;
        meta.lastChunkAtMs = arrival;
      } else {
        ctx.instruments.genAiTimePerOutputChunk.record(
          Math.max(0, arrival - (meta.lastChunkAtMs ?? meta.startedAtMs)) / 1000,
          chunkLabels,
        );
        meta.lastChunkAtMs = arrival;
      }
    }
    return;
  }

  // Reasoning/thinking parts accumulate agent thinking text (Spec #2688 AC 4).
  // The SDK schema names these parts `reasoning` with `text` (types.gen.d.ts:
  // ReasoningPart), while some hook payloads carry `thinking` with a `reasoning`
  // field — both shapes are accepted. The concatenated text is emitted as the
  // FLAT `agentThinking` span attribute on message completion (there is no
  // gen_ai.* registry key for reasoning CONTENT, NFR-2).
  if (part.type === "thinking" || part.type === "reasoning") {
    const key = `${part.sessionID}:${part.messageID}`;
    const thinkingChunk = part.text ?? part.reasoning ?? "";
    if (thinkingChunk) {
      ctx.messageThinking.set(key, `${ctx.messageThinking.get(key) ?? ""}${thinkingChunk}`);
      ctx.log("debug", "otel: thinking part accumulated", {
        sessionID: part.sessionID,
        messageID: part.messageID,
        chunkLength: thinkingChunk.length,
      });
    }
    return;
  }

  // Subagent instruction parts — store description keyed by parent session ID
  // so handleSessionCreated can set it as the subagent span's prompt attribute.
  if (part.type === "subtask") {
    const desc = (part as any).description as string | undefined;
    if (desc) {
      setBoundedMap(ctx.pendingSubagentInstructions, part.sessionID, desc);
      ctx.log("debug", "otel: subtask instruction stored", {
        sessionID: part.sessionID,
        descriptionLength: desc.length,
      });
    }
    return;
  }

  // Tool parts
  if (part.type === "tool" && part.callID && part.tool && part.state) {
    const key = `${part.sessionID}:${part.callID}`;

    if (part.state.status === "running") {
      const { agentName, agentType } = getSessionAgentMeta(part.sessionID, ctx);
      const startMs = toolPartTimes(part.state).start;
      const toolSpan = ctx.tracer.startSpan(
        `${ctx.tracePrefix}tool.${part.tool}`,
        {
          startTime: startMs,
          kind: SpanKind.INTERNAL,
          attributes: {
            ...genAiOpNameAttr(OP_NAME_TOOL),
            // GA-3: gen_ai.tool.* convention attrs alongside the existing flat keys.
            ...genAiToolAttrs(part.tool, part.callID),
            ...genAiToolCallArgumentsAttr(part.state.input),
            ...genAiAgentNameAttr(agentName),
            ...genAiConversationAttr(part.sessionID),
            [ATTR_SESSION_ID]: part.sessionID,
            [ATTR_TOOL_NAME]: part.tool,
            tool_call_id: part.callID,
            agent: agentName,
            [ATTR_AGENT_TYPE]: agentType,
            ...(part.state.input ? { tool_input: JSON.stringify(part.state.input) } : {}),
          },
        },
        resolveSessionTraceContext(part.sessionID, ctx, {
          assistantMessageID: part.messageID,
        }),
      );
      setBoundedMap(ctx.pendingToolSpans, key, {
        tool: part.tool,
        sessionID: part.sessionID,
        startMs: startMs ?? Date.now(),
        span: toolSpan,
      });
      ctx.log("debug", "otel: tool span started", { sessionID: part.sessionID, tool: part.tool, key });
      return;
    }

    if (part.state.status !== "completed" && part.state.status !== "error") return;

    // EARS-9: every completed/error tool part is a client-side tool call for the
    // session — failed ones included — counted here regardless of whether a
    // pending span exists, and recorded at session idle/error as
    // gen_ai.invoke_agent.tool_calls.
    incrementSessionCounters(part.sessionID, { toolCalls: 1 }, ctx);

    // Look up the pending span WITHOUT deleting it — the map entry must survive
    // until the span is actually ended so a failure here can still be caught by
    // sweepSession. Once a completed/error status is observed the span MUST be
    // ended: end at the SDK-schema timestamp (`state.time.end`) or, when absent,
    // now. An orphaned span (removed from the map but never .end()ed) is never
    // exported by the BatchSpanProcessor, which is why tool spans silently
    // vanished from telemetry_spans (spec #2449 AC5).
    const pending = ctx.pendingToolSpans.get(key);
    const times = toolPartTimes(part.state);
    const start = pending?.startMs ?? times.start ?? Date.now();
    const end = times.end ?? Date.now();
    const duration_ms = end - start;
    const success = part.state.status === "completed";
    const { agentName, agentType } = getSessionAgentMeta(part.sessionID, ctx);

    ctx.instruments.toolDurationHistogram.record(duration_ms, {
      [ATTR_SESSION_ID]: part.sessionID,
      tool_name: part.tool,
      success,
    });

    // GA-7: gen_ai.execute_tool.duration + gen_ai.client.operation.duration
    // (gen-ai-metrics.md). Durations are recorded in SECONDS per the registry
    // unit (s); error.type is attached when the tool call failed.
    const agent = agentName !== "unknown" ? agentName : undefined;
    ctx.instruments.genAiExecuteToolDuration.record(duration_ms / 1000, {
      [GEN_AI_TOOL_NAME]: part.tool,
      ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
      ...(success ? {} : { [GEN_AI_ERROR_TYPE]: part.state.error ?? "unknown" }),
    });
    ctx.instruments.genAiOperationDuration.record(duration_ms / 1000, {
      [ATTR_OP_NAME]: OP_NAME_TOOL,
      ...(success ? {} : { [GEN_AI_ERROR_TYPE]: part.state.error ?? "unknown" }),
    });

    const toolSpan = pending?.span;
    if (toolSpan) {
      toolSpan.setAttributes({
        agent: agentName,
        [ATTR_AGENT_TYPE]: agentType,
        [ATTR_TOOL_SUCCESS]: success,
        [ATTR_DURATION_MS]: duration_ms,
      });
      if (success) {
        const output = part.state.output ?? "";
        toolSpan.setAttribute(ATTR_TOOL_RESULT_SIZE, Buffer.byteLength(output, "utf8"));
        // GA-3: gen_ai.tool.call.result on successful tool completion.
        toolSpan.setAttributes(genAiToolCallResultAttr(output));
        toolSpan.setStatus({ code: SpanStatusCode.OK });
      } else {
        const err = part.state.error ?? "unknown error";
        toolSpan.setAttribute(ATTR_TOOL_ERROR, err);
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: err });
        // GA-6: gen_ai.client.operation.exception as a SPAN EVENT on the failed
        // tool's span (gen-ai-exceptions.md), attached BEFORE toolSpan.end() so
        // the receiver persists it to telemetry_spans.events_json. Attributes
        // stay identical to today (exception.type = tool name, exception.message
        // = error text via genAiExceptionEventAttrs).
        toolSpan.addEvent(
          GEN_AI_EVENT_EXCEPTION,
          {
            [ATTR_SESSION_ID]: part.sessionID,
            ...genAiOpNameAttr(OP_NAME_TOOL),
            [GEN_AI_TOOL_NAME]: part.tool,
            ...(agent ? { [GEN_AI_AGENT_NAME]: agent } : {}),
            ...genAiExceptionEventAttrs({ type: part.tool, message: err }),
          },
          end,
        );
      }

      // Spec #2745 R-2: attach the child-completion snapshot (recorded at the
      // child's session.idle/error in handlers/session.ts) onto the parent's
      // `fredo.tool.task` span BEFORE it exports. The tool span's
      // `gen_ai.tool.name` is set from part.tool (genAiToolAttrs), so the
      // `task` identity check is `part.tool === "task"`. A child with no
      // snapshot (e.g. the task span already exported) degrades silently — the
      // span exports unchanged, never a crash.
      if (part.tool === "task") {
        const childCompletion = ctx.pendingChildCompletions.get(part.sessionID);
        if (childCompletion) {
          toolSpan.setAttributes(childCompletionAttrs(childCompletion));
        }
      }
      toolSpan.end(end);
    }
    // The span has now been ended (or there was no span to end) — only now is it
    // safe to drop the pending entry. Deleting earlier would orphan the span.
    ctx.pendingToolSpans.delete(key);

    ctx.emitLog({
      severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
      severityText: success ? "INFO" : "ERROR",
      timestamp: start,
      observedTimestamp: Date.now(),
      body: LOG_TOOL_RESULT,
      attributes: {
        "event.name": LOG_TOOL_RESULT,
        [ATTR_SESSION_ID]: part.sessionID,
        tool_name: part.tool,
        ...agentAttrs(agentName, agentType),
        success,
        [ATTR_DURATION_MS]: duration_ms,
        ...(success
          ? { [ATTR_TOOL_RESULT_SIZE]: Buffer.byteLength(part.state.output ?? "", "utf8") }
          : { error: part.state.error ?? "unknown" }),
      },
    });
    ctx.log("debug", "otel: tool.duration histogram recorded", {
      sessionID: part.sessionID,
      tool_name: part.tool,
      duration_ms,
      success,
    });
    return ctx.log(success ? "info" : "error", "otel: tool_result", {
      sessionID: part.sessionID,
      tool_name: part.tool,
      success,
      duration_ms,
    });
  }
}

/**
 * Starts an LLM span for an assistant message when it first appears.
 * The span is parented to the active run or session and carries model/provider attributes.
 * It is ended in handleMessageUpdated once the message completes.
 */
export function startMessageSpan(
  sessionID: string,
  messageID: string,
  parentID: string,
  modelID: string,
  providerID: string,
  startTime: number,
  ctx: HandlerContext,
) {
  const msgKey = `${sessionID}:${messageID}`;
  if (ctx.messageSpans.has(msgKey)) return;
  setBoundedMap(ctx.assistantRuns, messageID, parentID);
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);

  // Seed per-message timing state for the TTFC / chunk-cadence metrics
  // (EARS-7/8): the operation start is the LLM span start time, and the
  // provider/model labels ride along so the text-part handler can label the
  // histograms without re-resolving them.
  setBoundedMap(ctx.messageMeta, msgKey, { startedAtMs: startTime, modelID, providerID });

  // --- Subagent instruction resolution ---
  // Priority 1: sessionTotals.instruction — stored by handleSessionCreated, keyed
  //   by sessionID so it reliably survives the timing gap between session creation
  //   and the first LLM span. Consume immediately to avoid stale reuse.
  // Priority 2: pendingSubagentInstructions — keyed by parent session ID (the
  //   subtask part belongs to the parent session's message). May not be available
  //   if handleSessionCreated hasn't fired yet or parentSessionId isn't resolved.
  // Priority 3: runInputs — the primary session's user prompt text.
  const totals = ctx.sessionTotals.get(sessionID);
  // Spec #2768 ST-1: resolve the parent for the self-carried session.parent_id
  // attribute — totals.parentId when known, else the pending-task scan (the
  // parent may resolve only at THIS LLM-span-start event when session.created
  // omitted parentID). Seam-guarded: undefined under
  // FREDO_SUPPRESS_PARENT_ROUTING.
  const parentSessionId = routingParentSessionId(sessionID, ctx);

  let subagentInstruction = totals?.instruction;
  if (subagentInstruction && totals) {
    delete totals.instruction; // consume to prevent stale reuse on next turn
  }

  if (!subagentInstruction) {
    // Fallback: try pendingSubagentInstructions (keyed by parent session ID)
    subagentInstruction =
      ctx.pendingSubagentInstructions.get(sessionID) ??
      (parentSessionId ? ctx.pendingSubagentInstructions.get(parentSessionId) : undefined);
    if (subagentInstruction) {
      ctx.pendingSubagentInstructions.delete(sessionID);
      if (parentSessionId && parentSessionId !== sessionID) {
        ctx.pendingSubagentInstructions.delete(parentSessionId);
      }
    }
  }

  const inputText = subagentInstruction ?? ctx.runInputs.get(parentID);

  const msgSpan = ctx.tracer.startSpan(
    `${ctx.tracePrefix}llm`,
    {
      startTime,
      kind: SpanKind.CLIENT,
      attributes: {
        ...genAiOpNameAttr(OP_NAME_CHAT),
        [ATTR_SESSION_ID]: sessionID,
        agent: agentName,
        [ATTR_AGENT_TYPE]: agentType,
        [ATTR_MODEL]: modelID,
        [ATTR_PROVIDER]: providerID,
        ...(inputText ? { prompt: inputText } : {}),
        // Spec #633: Add gen_ai.input.messages alongside existing prompt for
        // OTel GenAI semantic convention compatibility (REQ-3).
        ...genAiPromptAttr(inputText),
        // GA-1: gen_ai.provider.name / gen_ai.request.model / gen_ai.conversation.id
        // on LLM span creation (provider/model omitted when the payload lacks them).
        ...genAiRequestAttrs(modelID, providerID),
        ...genAiConversationAttr(sessionID),
        ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
      },
    },
    resolveSessionTraceContext(sessionID, ctx, { runID: parentID, assistantMessageID: messageID }),
  );
  setBoundedMap(ctx.messageSpans, msgKey, msgSpan);
}
