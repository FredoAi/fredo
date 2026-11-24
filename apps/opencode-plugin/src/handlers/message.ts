/**
 * handlers/message.ts — model-turn handlers (`fredo.llm` span family), Spec #3197 ST-3.
 *
 * Events: `session.step.started`, `session.step.first-token`, `session.step.streamed`,
 * `session.step.ended`, `session.step.failed`, `session.text.*`, `session.reasoning.*`.
 *
 * Ported from the V1 `message.updated` / `message.part.updated` handlers on `main`
 * (`handlers/message.ts`): the emitted contract is reproduced verbatim — span
 * name `fredo.llm`, the flat Fredo token/cost/content attributes, the
 * `gen_ai.*` registry keys, the `gen_ai.client.*` metrics and the `api_request` /
 * `api_error` log bodies. The Rust classifier reads these, so a rename is a
 * silent telemetry loss, not a compile error.
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionStepStarted      :2035  (data.sessionID, data.assistantMessageID,
 *                                       data.agent, data.model: ModelRef :615 = {id, providerID},
 *                                       data.started)
 *     · SessionStepFirstToken   :2057  / SessionStepStreamed :2075 (TTFC + cadence marks)
 *     · SessionStepEnded        :2093  (data.finish :2109, data.rawFinish, data.cost :83,
 *                                       data.tokens: TokenUsageInfo :84 → {input,output,
 *                                       reasoning,cache:{read,write}})
 *     · SessionStepFailed       :2118  (data.error: SessionStructuredError :160,
 *                                       optional cost/tokens)
 *     · SessionTextDelta        :2547  (data.delta, data.ordinal)
 *     · SessionReasoningDelta   :2562  (data.delta, data.ordinal)
 *
 * Invariants:
 *   · Each completed step counts tokens/cost ONCE (one `recordStepUsage` call per
 *     step event, which also increments the session's inference-call counter).
 *   · TTFC / chunk-cadence histograms record ONLY from a known step start
 *     (`messageMeta` seeded by `startLlmSpan`) — never a fabricated timestamp.
 *   · Content keys stay JSON STRINGS (`gen_ai.input.messages` /
 *     `gen_ai.output.messages`): the JS SDK attribute type has no object array.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
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
  ATTR_COST_USD,
  LOG_API_REQUEST,
  LOG_API_ERROR,
} from "../telemetry-constants";
import {
  accumulateSessionTotals,
  agentAttrs,
  getSessionAgentMeta,
  incrementSessionCounters,
  resolveSessionTraceContext,
  setBoundedMap,
  setSessionAgent,
} from "../util";
import { routingParentSessionId } from "./session";
import {
  ATTR_OP_NAME,
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_EVENT_INFERENCE_DETAILS,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_TOKEN_TYPE,
  GEN_AI_ERROR_TYPE,
  OP_NAME_CHAT,
  genAiConversationAttr,
  genAiExceptionEventAttrs,
  genAiInferenceDetailsAttrs,
  genAiOpNameAttr,
  genAiPromptAttr,
  genAiRequestAttrs,
  genAiResponseAttrs,
  genAiResponseBodyAttr,
  genAiUsageAttrs,
} from "../genai-conventions";
import type { GenAiUsageTokenCounts } from "../genai-conventions";
import type { HandlerContext, V2EventOf } from "../types";

/** The `messageSpans` / `messageOutputs` / `messageMeta` key for one model step. */
function stepKey(sessionID: string, assistantMessageID: string): string {
  return `${sessionID}:${assistantMessageID}`;
}

/** Human-readable text for a V2 `SessionStructuredError` (:160 — `{ type, message }`). */
function structuredErrorText(err: { type: string; message: string }): string {
  return err.message ? `${err.type}: ${err.message}` : err.type;
}

/**
 * Starts the `fredo.llm` span for one model step and seeds its timing state.
 *
 * Attributes are the V1 LLM-span contract: `gen_ai.operation.name=chat`,
 * `session.id`, agent identity, model + provider, the prompt and its
 * `gen_ai.input.messages` JSON-string form, `gen_ai.conversation.id`,
 * `gen_ai.provider.name` / `gen_ai.request.model` and the self-carried
 * `session.parent_id` (seam-guarded by `FREDO_SUPPRESS_PARENT_ROUTING`).
 */
export function startLlmSpan(
  sessionID: string,
  assistantMessageID: string,
  agent: string,
  model: string,
  provider: string,
  startedMs: number,
  ctx: HandlerContext,
): void {
  const key = stepKey(sessionID, assistantMessageID);
  if (ctx.messageSpans.has(key)) return;

  setBoundedMap(ctx.messageMeta, key, {
    startedAtMs: startedMs,
    modelID: model,
    providerID: provider,
  });

  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const agentLabel = agentName !== "unknown" ? agentName : agent;
  const parentSessionId = routingParentSessionId(sessionID, ctx);
  const inputText = ctx.sessionTurns.get(sessionID)?.prompt;

  const llmSpan = ctx.tracer.startSpan(
    `${ctx.tracePrefix}llm`,
    {
      startTime: startedMs,
      kind: SpanKind.CLIENT,
      attributes: {
        ...genAiOpNameAttr(OP_NAME_CHAT),
        [ATTR_SESSION_ID]: sessionID,
        agent: agentLabel,
        [ATTR_AGENT_TYPE]: agentType,
        [ATTR_MODEL]: model,
        [ATTR_PROVIDER]: provider,
        ...(inputText ? { prompt: inputText } : {}),
        ...genAiPromptAttr(inputText),
        ...genAiRequestAttrs(model, provider),
        ...genAiConversationAttr(sessionID),
        ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
      },
    },
    resolveSessionTraceContext(sessionID, ctx, { assistantMessageID }),
  );
  setBoundedMap(ctx.messageSpans, key, llmSpan);
}

/** `session.step.started` — opens the step's `fredo.llm` span. */
export function handleStepStarted(
  event: V2EventOf<"session.step.started">,
  ctx: HandlerContext,
): void {
  const { sessionID, assistantMessageID, agent, model, started } = event.data;
  if (agent) {
    // `session.created.data.agent` is optional; the step carries it authoritatively.
    setSessionAgent(sessionID, agent, ctx);
    const previousTurn = ctx.sessionTurns.get(sessionID);
    setBoundedMap(ctx.sessionTurns, sessionID, {
      ...(previousTurn?.prompt ? { prompt: previousTurn.prompt } : {}),
      model: previousTurn?.model ?? (model ? `${model.providerID}/${model.id}` : undefined),
    });
  }
  const modelID = model?.id ?? "unknown";
  const providerID = model?.providerID ?? "unknown";
  startLlmSpan(sessionID, assistantMessageID, agent, modelID, providerID, started ?? event.created, ctx);
  ctx.log("debug", "otel: step started", { sessionID, assistantMessageID, modelID, providerID });
}

/**
 * `session.text.delta` — accumulates assistant text (no per-chunk emission) and
 * records the chunk-cadence histograms (R-4.3, EARS-7/8).
 *
 * TTFC is recorded on the FIRST chunk of a step, `time_per_output_chunk` on every
 * later one, both measured from the step start seeded by `startLlmSpan`. A chunk
 * with no known step start records NOTHING — absence is correct, never a
 * fabricated sample.
 */
export function handleTextDelta(
  event: V2EventOf<"session.text.delta">,
  ctx: HandlerContext,
): void {
  const { sessionID, assistantMessageID, delta } = event.data;
  const key = stepKey(sessionID, assistantMessageID);
  if (delta) setBoundedMap(ctx.messageOutputs, key, `${ctx.messageOutputs.get(key) ?? ""}${delta}`);

  const meta = ctx.messageMeta.get(key);
  if (!meta) return;

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
    return;
  }
  ctx.instruments.genAiTimePerOutputChunk.record(
    Math.max(0, arrival - (meta.lastChunkAtMs ?? meta.startedAtMs)) / 1000,
    chunkLabels,
  );
  meta.lastChunkAtMs = arrival;
}

/**
 * `session.reasoning.delta` — accumulates assistant reasoning (no emission).
 *
 * There is NO `gen_ai.*` registry key for reasoning CONTENT (NFR-2): the
 * accumulated text is emitted as the flat `agentThinking` attribute on the
 * completed `fredo.llm` span, exactly as V1 did.
 */
export function handleReasoningDelta(
  event: V2EventOf<"session.reasoning.delta">,
  ctx: HandlerContext,
): void {
  const { sessionID, assistantMessageID, delta } = event.data;
  if (!delta) return;
  const key = stepKey(sessionID, assistantMessageID);
  setBoundedMap(
    ctx.messageThinking,
    key,
    `${ctx.messageThinking.get(key) ?? ""}${delta}`,
  );
}

/**
 * Records one step's usage exactly once: the per-session inference-call counter,
 * the `fredo.token.usage` / `fredo.cost.usage` counters, the session totals and
 * the `gen_ai.client.*` metrics. Called from BOTH step terminals, so a failed
 * step that reported usage is counted once — and only once.
 */
function recordStepUsage(
  sessionID: string,
  assistantMessageID: string,
  input: {
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    cost?: number;
    durationMs: number;
    errorType?: string;
  },
  ctx: HandlerContext,
): void {
  const { tokens, cost, durationMs, errorType } = input;
  const { agentName } = getSessionAgentMeta(sessionID, ctx);
  const meta = ctx.messageMeta.get(stepKey(sessionID, assistantMessageID));
  const modelID = meta?.modelID;
  const providerID = meta?.providerID;
  const model = modelID && modelID !== "unknown" ? modelID : undefined;
  const provider = providerID && providerID !== "unknown" ? providerID : undefined;

  incrementSessionCounters(sessionID, { inferenceCalls: 1 }, ctx);

  const baseLabels = {
    [ATTR_OP_NAME]: OP_NAME_CHAT,
    ...(provider ? { [GEN_AI_PROVIDER_NAME]: provider } : {}),
    ...(model ? { [GEN_AI_REQUEST_MODEL]: model } : {}),
  };
  ctx.instruments.genAiOperationDuration.record(durationMs / 1000, {
    ...baseLabels,
    ...(errorType ? { [GEN_AI_ERROR_TYPE]: errorType } : {}),
  });

  if (!tokens) return;

  ctx.instruments.tokenCounter.add(tokens.input, {
    [ATTR_SESSION_ID]: sessionID,
    model,
    agent: agentName,
    type: "input",
  });
  ctx.instruments.tokenCounter.add(tokens.output, {
    [ATTR_SESSION_ID]: sessionID,
    model,
    agent: agentName,
    type: "output",
  });
  ctx.instruments.tokenCounter.add(tokens.reasoning, {
    [ATTR_SESSION_ID]: sessionID,
    model,
    agent: agentName,
    type: "reasoning",
  });
  ctx.instruments.tokenCounter.add(tokens.cache.read, {
    [ATTR_SESSION_ID]: sessionID,
    model,
    agent: agentName,
    type: "cacheRead",
  });
  ctx.instruments.tokenCounter.add(tokens.cache.write, {
    [ATTR_SESSION_ID]: sessionID,
    model,
    agent: agentName,
    type: "cacheCreation",
  });
  ctx.instruments.costCounter.add(cost ?? 0, {
    [ATTR_SESSION_ID]: sessionID,
    model,
    agent: agentName,
  });

  accumulateSessionTotals(sessionID, tokens, cost ?? 0, ctx);

  // gen_ai.client.token.usage — only positive counts (never a zero row).
  if (tokens.input > 0) {
    ctx.instruments.genAiTokenUsage.record(tokens.input, {
      ...baseLabels,
      [GEN_AI_TOKEN_TYPE]: "input",
    });
  }
  if (tokens.output > 0) {
    ctx.instruments.genAiTokenUsage.record(tokens.output, {
      ...baseLabels,
      [GEN_AI_TOKEN_TYPE]: "output",
    });
  }
}

/** Drops every per-step map entry once the step's span has ended. */
function clearStepState(key: string, ctx: HandlerContext): void {
  ctx.messageSpans.delete(key);
  ctx.messageOutputs.delete(key);
  ctx.messageThinking.delete(key);
  ctx.messageMeta.delete(key);
}

/**
 * `session.step.ended` — closes the `fredo.llm` span OK with the full V1
 * attribute set, the `gen_ai.client.inference.operation.details` span event, the
 * usage metrics and the `api_request` log record.
 */
export function handleStepEnded(
  event: V2EventOf<"session.step.ended">,
  ctx: HandlerContext,
): void {
  const data = event.data;
  const { sessionID, assistantMessageID, cost, tokens } = data;
  const key = stepKey(sessionID, assistantMessageID);
  const meta = ctx.messageMeta.get(key);
  const llmSpan = ctx.messageSpans.get(key);
  // Exactly-once guard: a terminal for a step this process never opened (a
  // replayed durable event, or a session that began before the plugin attached)
  // must not count its usage a second time — and cannot be timed or assembled.
  if (!meta && !llmSpan) {
    ctx.log("debug", "otel: step.ended for an untracked step", { sessionID, assistantMessageID });
    return;
  }
  const startedAt = meta?.startedAtMs ?? event.created;
  const duration = Math.max(0, event.created - startedAt);
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const modelID = meta?.modelID ?? "unknown";
  const providerID = meta?.providerID ?? "unknown";
  const finish = data.rawFinish ?? (data.finish === "unknown" ? undefined : data.finish);

  recordStepUsage(sessionID, assistantMessageID, { tokens, cost, durationMs: duration }, ctx);

  const outputText = ctx.messageOutputs.get(key);
  const thinkingText = ctx.messageThinking.get(key);
  if (llmSpan) {
    const parentSessionId = routingParentSessionId(sessionID, ctx);
    llmSpan.setAttributes({
      agent: agentName,
      [ATTR_AGENT_TYPE]: agentType,
      [ATTR_INPUT_TOKENS]: tokens.input,
      [ATTR_OUTPUT_TOKENS]: tokens.output,
      [ATTR_REASONING_TOKENS]: tokens.reasoning,
      [ATTR_CACHE_READ_TOKENS]: tokens.cache.read,
      [ATTR_CACHE_CREATION_TOKENS]: tokens.cache.write,
      [ATTR_DURATION_MS]: duration,
      [ATTR_COST_USD]: cost,
      // Spec #627: BOTH keys, so the adapter can map the reply either way.
      ...(outputText ? { response_text: outputText, output: outputText } : {}),
      // Spec #2688 AC4: reasoning CONTENT lives only in this flat key.
      ...(thinkingText ? { agentThinking: thinkingText } : {}),
      ...genAiResponseBodyAttr(outputText, finish),
      ...genAiUsageAttrs({
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
        cacheCreation: tokens.cache.write,
      }),
      ...genAiResponseAttrs(modelID, finish),
      ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
    });
    llmSpan.setStatus({ code: SpanStatusCode.OK });

    const usage: GenAiUsageTokenCounts = {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cacheRead: tokens.cache.read,
      cacheCreation: tokens.cache.write,
    };
    llmSpan.addEvent(
      GEN_AI_EVENT_INFERENCE_DETAILS,
      {
        [ATTR_SESSION_ID]: sessionID,
        ...genAiInferenceDetailsAttrs({
          providerID,
          modelID,
          sessionID,
          inputText: ctx.sessionTurns.get(sessionID)?.prompt,
          outputText,
          usage,
          finish,
        }),
      },
      event.created,
    );
    llmSpan.end(event.created);
  }
  clearStepState(key, ctx);

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: event.created,
    observedTimestamp: Date.now(),
    body: LOG_API_REQUEST,
    attributes: {
      "event.name": LOG_API_REQUEST,
      [ATTR_SESSION_ID]: sessionID,
      model: modelID,
      provider: providerID,
      ...agentAttrs(agentName, agentType),
      [ATTR_COST_USD]: cost,
      [ATTR_DURATION_MS]: duration,
      [ATTR_INPUT_TOKENS]: tokens.input,
      [ATTR_OUTPUT_TOKENS]: tokens.output,
      [ATTR_REASONING_TOKENS]: tokens.reasoning,
      [ATTR_CACHE_READ_TOKENS]: tokens.cache.read,
      [ATTR_CACHE_CREATION_TOKENS]: tokens.cache.write,
    },
  });
  ctx.log("info", "otel: api_request", {
    sessionID,
    model: modelID,
    agent: agentName,
    cost_usd: cost,
    duration_ms: duration,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
  });
}

/**
 * `session.step.failed` — closes the `fredo.llm` span ERROR, attaches the
 * `gen_ai.client.operation.exception` span event, records the metrics with
 * `error.type` and emits the `api_error` log record.
 */
export function handleStepFailed(
  event: V2EventOf<"session.step.failed">,
  ctx: HandlerContext,
): void {
  const data = event.data;
  const { sessionID, assistantMessageID, error, tokens, cost } = data;
  const key = stepKey(sessionID, assistantMessageID);
  const meta = ctx.messageMeta.get(key);
  const llmSpan = ctx.messageSpans.get(key);
  // Exactly-once guard (mirrors handleStepEnded): never count a step twice.
  if (!meta && !llmSpan) {
    ctx.log("debug", "otel: step.failed for an untracked step", {
      sessionID,
      assistantMessageID,
    });
    return;
  }
  const startedAt = meta?.startedAtMs ?? event.created;
  const duration = Math.max(0, event.created - startedAt);
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  const modelID = meta?.modelID ?? "unknown";
  const providerID = meta?.providerID ?? "unknown";
  const provider = providerID !== "unknown" ? providerID : undefined;
  const errorText = structuredErrorText(error);

  recordStepUsage(
    sessionID,
    assistantMessageID,
    { tokens, cost, durationMs: duration, errorType: error.type },
    ctx,
  );

  const outputText = ctx.messageOutputs.get(key);
  const thinkingText = ctx.messageThinking.get(key);
  if (llmSpan) {
    const parentSessionId = routingParentSessionId(sessionID, ctx);
    llmSpan.setAttributes({
      agent: agentName,
      [ATTR_AGENT_TYPE]: agentType,
      [ATTR_DURATION_MS]: duration,
      ...(cost !== undefined ? { [ATTR_COST_USD]: cost } : {}),
      ...(outputText ? { response_text: outputText, output: outputText } : {}),
      ...(thinkingText ? { agentThinking: thinkingText } : {}),
      ...(parentSessionId ? { [ATTR_PARENT_SESSION_ID]: parentSessionId } : {}),
    });
    llmSpan.addEvent(
      GEN_AI_EVENT_EXCEPTION,
      {
        [ATTR_SESSION_ID]: sessionID,
        ...genAiOpNameAttr(OP_NAME_CHAT),
        ...(provider ? { [GEN_AI_PROVIDER_NAME]: provider } : {}),
        ...genAiExceptionEventAttrs({ type: error.type, message: error.message }),
      },
      event.created,
    );
    llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorText });
    llmSpan.end(event.created);
  }
  clearStepState(key, ctx);

  ctx.emitLog({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: event.created,
    observedTimestamp: Date.now(),
    body: LOG_API_ERROR,
    attributes: {
      "event.name": LOG_API_ERROR,
      [ATTR_SESSION_ID]: sessionID,
      model: modelID,
      provider: providerID,
      ...agentAttrs(agentName, agentType),
      error: errorText,
      [ATTR_DURATION_MS]: duration,
    },
  });
  ctx.log("error", "otel: api_error", {
    sessionID,
    model: modelID,
    agent: agentName,
    error: errorText,
    duration_ms: duration,
  });
}
