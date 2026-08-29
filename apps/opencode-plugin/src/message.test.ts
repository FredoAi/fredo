/**
 * message.test.ts — Unit tests for the tool-part lifecycle handling in
 * handlers/message.ts (spec #2449 AC5 regression fix).
 *
 * The plugin's tool-span lifecycle is driven by `message.part.updated` events.
 * The opencode SDK nests the lifecycle timestamps under `state.time`
 * (`ToolStateRunning/Completed/Error` in types.gen.d.ts:415-458), while the
 * handler previously read them flat at `state.start`/`state.end` — so every real
 * completed/error tool part discarded the span (`end === undefined` → early
 * return) and orphaned it (removed from `pendingToolSpans` before `.end()`),
 * so BatchSpanProcessor never exported it. These tests lock in the SDK-schema
 * extraction (`toolPartTimes`) and the never-orphan completion path.
 */

import { describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span, Tracer } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import { handleMessagePartUpdated, handleMessageUpdated, toolPartTimes, type ToolPartState } from "./handlers/message";
import { handleSessionIdle, handleSessionError, recordChildCompletion, resolveParentSessionId } from "./handlers/session";
import { childCompletionAttrs } from "./util";
import {
  ATTR_PARENT_SESSION_ID,
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
import { MAX_CHILD_COMPLETIONS } from "./types";
import {
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_EVENT_INFERENCE_DETAILS,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_AGENT_NAME,
  GEN_AI_ERROR_TYPE,
  ATTR_OP_NAME,
  EXCEPTION_TYPE,
  EXCEPTION_MESSAGE,
  OP_NAME_CHAT,
  OP_NAME_TOOL,
} from "./genai-conventions";
import type { HandlerContext, PendingToolSpan, MessageMeta } from "./types";

/** Builds the event envelope `handleMessagePartUpdated` expects. */
function toolPartEvent(part: {
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  state: ToolPartState;
}): {
  properties: {
    part: {
      type: "tool";
      sessionID: string;
      messageID: string;
      callID: string;
      tool: string;
      state: ToolPartState;
    };
  };
} {
  return {
    properties: {
      part: {
        type: "tool",
        sessionID: part.sessionID,
        messageID: part.messageID,
        callID: part.callID,
        tool: part.tool,
        state: part.state,
      },
    },
  };
}

/** Builds the text-part envelope `handleMessagePartUpdated` expects. */
function textPartEvent(sessionID: string, messageID: string, text: string): {
  properties: {
    part: {
      type: "text";
      sessionID: string;
      messageID: string;
      text: string;
    };
  };
} {
  return {
    properties: {
      part: { type: "text", sessionID, messageID, text },
    },
  };
}

/** Builds a thinking-part envelope (SDK `reasoning` type or `thinking` type). */
function thinkingPartEvent(
  sessionID: string,
  messageID: string,
  text: string,
  type: "thinking" | "reasoning" = "thinking",
): {
  properties: {
    part: {
      type: string;
      sessionID: string;
      messageID: string;
      text: string;
    };
  };
} {
  return {
    properties: {
      part: { type, sessionID, messageID, text },
    },
  };
}

/** Recording fake span — captures the status, end call, attributes, and events. */
function makeFakeSpan() {
  const statuses: Array<{ code: SpanStatusCode; message?: string }> = [];
  const endCalls: Array<number | undefined> = [];
  const attributes: Record<string, unknown> = {};
  /** Captured span events (name + attributes + optional start time). */
  const events: Array<{
    name: string;
    attributes?: Record<string, unknown>;
    startTime?: number;
  }> = [];
  /** Ordered trace of lifecycle calls so tests can assert events fire before end. */
  const callOrder: string[] = [];
  const span = {
    setAttributes(attrs: Record<string, unknown>) {
      Object.assign(attributes, attrs);
      callOrder.push("setAttributes");
    },
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
      callOrder.push(`setAttribute:${key}`);
    },
    setStatus(status: { code: SpanStatusCode; message?: string }) {
      statuses.push(status);
    },
    addEvent(name: string, attributesOrStartTime?: Record<string, unknown> | number, startTime?: number) {
      if (typeof attributesOrStartTime === "number") {
        events.push({ name, startTime: attributesOrStartTime });
      } else {
        events.push({ name, attributes: attributesOrStartTime, ...(startTime !== undefined ? { startTime } : {}) });
      }
      callOrder.push(`event:${name}`);
      return span;
    },
    end(endTime?: number) {
      endCalls.push(endTime);
      callOrder.push("end");
    },
  };
  return { span: span as unknown as Span, statuses, endCalls, attributes, events, callOrder };
}

/** Builds a minimal HandlerContext around a fake tracer and pending-tool map. */
function makeContext(opts: {
  pendingToolSpans?: Map<string, PendingToolSpan>;
  spans?: Array<ReturnType<typeof makeFakeSpan>>;
  messageMeta?: Map<string, MessageMeta>;
} = {}) {
  const pendingToolSpans = opts.pendingToolSpans ?? new Map<string, PendingToolSpan>();
  /** Captured histogram records (value + labels) keyed by instrument field name. */
  const records: Record<string, Array<{ value: number; attributes?: Record<string, unknown> }>> = {};
  const histogram = (name: string) => ({
    record: (value: number, attributes?: Record<string, unknown>) => {
      records[name] = records[name] ?? [];
      records[name].push({ value, attributes });
    },
  });
  const instruments = {
    sessionCounter: { add: () => {} },
    tokenCounter: { add: () => {} },
    costCounter: { add: () => {} },
    toolDurationHistogram: histogram("toolDurationHistogram"),
    genAiOperationDuration: histogram("genAiOperationDuration"),
    genAiTokenUsage: histogram("genAiTokenUsage"),
    genAiExecuteToolDuration: histogram("genAiExecuteToolDuration"),
    genAiInvokeAgentDuration: histogram("genAiInvokeAgentDuration"),
    genAiTimeToFirstChunk: histogram("genAiTimeToFirstChunk"),
    genAiTimePerOutputChunk: histogram("genAiTimePerOutputChunk"),
    genAiInferenceCalls: histogram("genAiInferenceCalls"),
    genAiToolCalls: histogram("genAiToolCalls"),
  } as unknown as HandlerContext["instruments"];
  const tracer = {
    startSpan: (_name: string, options?: { attributes?: Record<string, unknown> }) => {
      const fake = makeFakeSpan();
      // Spec #2768: capture the creation-time attributes on the fake span so
      // creation-time stamping is assertable (previously discarded).
      if (options?.attributes) Object.assign(fake.attributes, options.attributes);
      opts.spans?.push(fake);
      return fake.span;
    },
  } as unknown as Tracer;
  const ctx: HandlerContext = {
    log: async () => {},
    emitLog: (_record: LogRecord) => {},
    instruments,
    pendingToolSpans,
    pendingPermissions: new Map(),
    sessionTotals: new Map(),
    tracer,
    tracePrefix: "fredo.",
    rootContext: () => ({}) as never,
    runSpans: new Map(),
    runSpanContexts: new Map(),
    activeRuns: new Map(),
    assistantRuns: new Map(),
    pendingRuns: new Map(),
    runInputs: new Map(),
    sessionSpans: new Map(),
    sessionSpanContexts: new Map(),
    messageSpans: new Map(),
    messageOutputs: new Map(),
    messageThinking: new Map(),
    pendingSubagentInstructions: new Map(),
    messageMeta: opts.messageMeta ?? new Map<string, MessageMeta>(),
    pendingChildCompletions: new Map(),
    // Spec #2768 ST-1 TEST SEAM — default OFF in tests (stamping active).
    suppressParentRouting: false,
  };
  return { ctx, pendingToolSpans, records };
}

describe("toolPartTimes (SDK-schema timestamp extraction)", () => {
  test("reads start/end from the nested SDK `state.time` shape", () => {
    expect(toolPartTimes({ status: "completed", time: { start: 100, end: 250 } })).toEqual({
      start: 100,
      end: 250,
    });
  });

  test("running state has only a start under `state.time`", () => {
    expect(toolPartTimes({ status: "running", time: { start: 100 } })).toEqual({
      start: 100,
      end: undefined,
    });
  });

  test("falls back to the flat `state.start`/`state.end` legacy shape", () => {
    expect(toolPartTimes({ status: "completed", start: 100, end: 250 })).toEqual({
      start: 100,
      end: 250,
    });
  });

  test("prefers the nested `state.time` shape when both are present", () => {
    expect(
      toolPartTimes({ status: "completed", start: 1, end: 2, time: { start: 100, end: 250 } }),
    ).toEqual({ start: 100, end: 250 });
  });

  test("returns undefined start/end when neither shape is present", () => {
    expect(toolPartTimes({ status: "pending" })).toEqual({ start: undefined, end: undefined });
  });
});

describe("handleMessagePartUpdated tool completion path (never orphan)", () => {
  test("running then completed (SDK state.time) ends the tracer-created span with OK", () => {
    const spans: Array<ReturnType<typeof makeFakeSpan>> = [];
    const { ctx, pendingToolSpans } = makeContext({ spans });
    const key = "ses-1:call-1";

    // Running part creates the pending span (via the fake tracer).
    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "Bash",
        state: { status: "running", input: {}, time: { start: 1000 } },
      }),
      ctx,
    );
    expect(pendingToolSpans.has(key)).toBe(true);
    expect(spans.length).toBe(1);
    const span = spans[0];

    // Completed part (SDK schema: state.time.start/end) ends the span.
    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "Bash",
        state: {
          status: "completed",
          input: {},
          output: "ls output",
          time: { start: 1000, end: 2500 },
        },
      }),
      ctx,
    );

    // The span was ended (never orphaned) and the pending entry was removed.
    expect(pendingToolSpans.has(key)).toBe(false);
    expect(span.statuses).toEqual([{ code: SpanStatusCode.OK }]);
    expect(span.endCalls).toEqual([2500]);
    expect(span.attributes["tool.success"]).toBe(true);
    expect(span.attributes["tool.result_size_bytes"]).toBe(Buffer.byteLength("ls output", "utf8"));
  });

  test("completes with OK and ends at state.time.end when a pending span was started", () => {
    const { ctx, pendingToolSpans } = makeContext();
    const key = "ses-1:call-1";
    const span = makeFakeSpan();
    pendingToolSpans.set(key, {
      tool: "Bash",
      sessionID: "ses-1",
      startMs: 1000,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "Bash",
        state: {
          status: "completed",
          input: {},
          output: "result",
          time: { start: 1000, end: 2500 },
        },
      }),
      ctx,
    );

    expect(span.statuses).toEqual([{ code: SpanStatusCode.OK }]);
    expect(span.endCalls).toEqual([2500]);
    expect(span.attributes["tool.success"]).toBe(true);
    expect(span.attributes["tool.result_size_bytes"]).toBe(Buffer.byteLength("result", "utf8"));
    expect(pendingToolSpans.has(key)).toBe(false);
  });

  test("ends the span with ERROR status when the part state carries an error", () => {
    const { ctx, pendingToolSpans } = makeContext();
    const key = "ses-1:call-2";
    const span = makeFakeSpan();
    pendingToolSpans.set(key, {
      tool: "Read",
      sessionID: "ses-1",
      startMs: 100,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-2",
        tool: "Read",
        state: {
          status: "error",
          input: {},
          error: "file not found",
          time: { start: 100, end: 400 },
        },
      }),
      ctx,
    );

    expect(span.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: "file not found" }]);
    expect(span.endCalls).toEqual([400]);
    expect(span.attributes["tool.error"]).toBe("file not found");
    // Spec #2680 Sub-task 2: the exception is attached as a span EVENT on the
    // failing tool span BEFORE span.end() — not a log record.
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe(GEN_AI_EVENT_EXCEPTION);
    expect(span.events[0].attributes).toMatchObject({
      [ATTR_OP_NAME]: OP_NAME_TOOL,
      [GEN_AI_TOOL_NAME]: "Read",
      [EXCEPTION_TYPE]: "Read",
      [EXCEPTION_MESSAGE]: "file not found",
    });
    expect(span.events[0].startTime).toBe(400);
    expect(span.callOrder.indexOf(`event:${GEN_AI_EVENT_EXCEPTION}`)).toBeLessThan(
      span.callOrder.indexOf("end"),
    );
    expect(pendingToolSpans.has(key)).toBe(false);
  });

  test("never orphans: a completed part WITHOUT an end timestamp still ends the span (at now)", () => {
    const { ctx, pendingToolSpans } = makeContext();
    const key = "ses-1:call-3";
    const span = makeFakeSpan();
    pendingToolSpans.set(key, {
      tool: "Bash",
      sessionID: "ses-1",
      startMs: 100,
      span: span.span,
    });
    const before = Date.now();

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-3",
        tool: "Bash",
        state: { status: "completed", input: {}, output: "out" },
      }),
      ctx,
    );

    // The span MUST be ended even though the SDK timestamp is absent, and the
    // pending entry MUST be removed only after that end.
    expect(span.endCalls.length).toBe(1);
    expect(span.endCalls[0]).toBeGreaterThanOrEqual(before);
    expect(span.statuses).toEqual([{ code: SpanStatusCode.OK }]);
    expect(pendingToolSpans.has(key)).toBe(false);
  });

  test("ends the span with ERROR when status is error and no end timestamp exists", () => {
    const { ctx, pendingToolSpans } = makeContext();
    const key = "ses-1:call-4";
    const span = makeFakeSpan();
    pendingToolSpans.set(key, {
      tool: "Bash",
      sessionID: "ses-1",
      startMs: 100,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-4",
        tool: "Bash",
        state: { status: "error", input: {}, error: "boom" },
      }),
      ctx,
    );

    expect(span.endCalls.length).toBe(1);
    expect(span.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: "boom" }]);
    expect(pendingToolSpans.has(key)).toBe(false);
  });
});

/** Builds a minimal `message.updated` event envelope for `handleMessageUpdated`. */
function messageUpdatedEvent(overrides: {
  sessionID?: string;
  id?: string;
  parentID?: string;
  modelID?: string;
  providerID?: string;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  cost?: number;
  error?: { name: string; data?: unknown };
  finish?: string;
} = {}): {
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
} {
  return {
    properties: {
      info: {
        sessionID: overrides.sessionID ?? "ses-1",
        id: overrides.id ?? "msg-1",
        parentID: overrides.parentID ?? "run-1",
        role: "assistant",
        modelID: overrides.modelID ?? "gpt-4o",
        providerID: overrides.providerID ?? "openai",
        time: { created: 1000, completed: 5000 },
        tokens: overrides.tokens ?? { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: overrides.cost ?? 0.01,
        ...(overrides.error ? { error: overrides.error } : {}),
        ...(overrides.finish ? { finish: overrides.finish } : {}),
      },
    },
  };
}

describe("handleMessageUpdated span events (Spec #2680 Sub-task 2)", () => {
  test("attaches the inference.operation.details event on the LLM span before end", () => {
    const { ctx } = makeContext();
    const span = makeFakeSpan();
    const key = "ses-1:msg-1";
    ctx.messageSpans.set(key, span.span);
    ctx.messageOutputs.set(key, "the agent reply");
    ctx.runInputs.set("run-1", "the user prompt");
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessageUpdated(messageUpdatedEvent(), ctx);

    const details = span.events.find((ev) => ev.name === GEN_AI_EVENT_INFERENCE_DETAILS);
    expect(details).toBeDefined();
    expect(details!.attributes).toMatchObject({
      [ATTR_OP_NAME]: OP_NAME_CHAT,
      [GEN_AI_PROVIDER_NAME]: "openai",
      [GEN_AI_CONVERSATION_ID]: "ses-1",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.response.model": "gpt-4o",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 20,
    });
    // The details event MUST NOT carry the input/output message content arrays.
    expect(details!.attributes).not.toHaveProperty("gen_ai.input.messages");
    expect(details!.attributes).not.toHaveProperty("gen_ai.output.messages");
    expect(details!.startTime).toBe(5000);
    expect(span.callOrder.indexOf(`event:${GEN_AI_EVENT_INFERENCE_DETAILS}`)).toBeLessThan(
      span.callOrder.indexOf("end"),
    );
    // The span is still ended (never orphaned) after the events.
    expect(span.endCalls).toEqual([5000]);
  });

  test("attaches the operation.exception event on the LLM span when the chat operation fails", () => {
    const { ctx } = makeContext();
    const span = makeFakeSpan();
    const key = "ses-1:msg-1";
    ctx.messageSpans.set(key, span.span);
    ctx.messageOutputs.set(key, "partial reply");
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessageUpdated(
      messageUpdatedEvent({
        error: { name: "ModelError", data: { message: "rate limited", stack: "at fn (line 3)" } },
      }),
      ctx,
    );

    const details = span.events.find((ev) => ev.name === GEN_AI_EVENT_INFERENCE_DETAILS);
    expect(details).toBeDefined();
    expect(details!.attributes).toMatchObject({
      [GEN_AI_ERROR_TYPE]: "ModelError",
      [GEN_AI_PROVIDER_NAME]: "openai",
    });
    const exception = span.events.find((ev) => ev.name === GEN_AI_EVENT_EXCEPTION);
    expect(exception).toBeDefined();
    expect(exception!.attributes).toMatchObject({
      [ATTR_OP_NAME]: OP_NAME_CHAT,
      [GEN_AI_PROVIDER_NAME]: "openai",
      [EXCEPTION_TYPE]: "ModelError",
      [EXCEPTION_MESSAGE]: "ModelError: rate limited",
      "exception.stacktrace": "at fn (line 3)",
    });
    expect(span.callOrder.indexOf(`event:${GEN_AI_EVENT_EXCEPTION}`)).toBeLessThan(
      span.callOrder.indexOf("end"),
    );
    expect(span.endCalls).toEqual([5000]);
  });

  test("omits the exception event when the message span is already gone (EARS-5)", () => {
    const { ctx } = makeContext();
    const span = makeFakeSpan();
    const key = "ses-1:msg-1";
    // No span in ctx.messageSpans — the failing operation has no live span.
    ctx.messageSpans.delete(key);

    handleMessageUpdated(
      messageUpdatedEvent({
        error: { name: "ModelError", data: { message: "boom" } },
      }),
      ctx,
    );

    // No events attached anywhere; nothing fabricated on an unrelated span.
    expect(span.events).toHaveLength(0);
    expect(span.endCalls).toHaveLength(0);
  });
});

describe("Spec #2680 Sub-task 3 metrics (EARS-7/8/9/10)", () => {
  test("records time_to_first_chunk on the first text chunk and time_per_output_chunk thereafter", () => {
    const { ctx, records } = makeContext();
    ctx.messageMeta.set("ses-1:msg-1", {
      startedAtMs: 1000,
      providerID: "openai",
      modelID: "gpt-4o",
    });

    const before = Date.now();
    handleMessagePartUpdated(textPartEvent("ses-1", "msg-1", "Hello "), ctx);
    handleMessagePartUpdated(textPartEvent("ses-1", "msg-1", "world"), ctx);
    const after = Date.now();

    const ttfc = records["genAiTimeToFirstChunk"];
    expect(ttfc).toHaveLength(1);
    expect(ttfc[0].value).toBeGreaterThanOrEqual((before - 1000) / 1000);
    expect(ttfc[0].value).toBeLessThanOrEqual((after - 1000) / 1000);
    expect(ttfc[0].attributes).toMatchObject({
      [ATTR_OP_NAME]: OP_NAME_CHAT,
      [GEN_AI_PROVIDER_NAME]: "openai",
      [GEN_AI_REQUEST_MODEL]: "gpt-4o",
    });

    const cadence = records["genAiTimePerOutputChunk"];
    expect(cadence).toHaveLength(1);
    expect(cadence[0].value).toBeGreaterThanOrEqual(0);
    expect(cadence[0].attributes).toMatchObject({
      [ATTR_OP_NAME]: OP_NAME_CHAT,
      [GEN_AI_PROVIDER_NAME]: "openai",
      [GEN_AI_REQUEST_MODEL]: "gpt-4o",
    });
  });

  test("omits provider/model chunk labels when unknown (EARS-7 registry labels)", () => {
    const { ctx, records } = makeContext();
    ctx.messageMeta.set("ses-1:msg-1", { startedAtMs: 1000 });

    handleMessagePartUpdated(textPartEvent("ses-1", "msg-1", "Hello"), ctx);

    const ttfc = records["genAiTimeToFirstChunk"];
    expect(ttfc).toHaveLength(1);
    expect(ttfc[0].attributes).toEqual({ [ATTR_OP_NAME]: OP_NAME_CHAT });
  });

  test("records no TTFC/cadence when no per-message start time is known (EARS-10)", () => {
    const { ctx, records } = makeContext();
    handleMessagePartUpdated(textPartEvent("ses-1", "msg-1", "Hello"), ctx);
    expect(records["genAiTimeToFirstChunk"]).toBeUndefined();
    expect(records["genAiTimePerOutputChunk"]).toBeUndefined();
  });

  test("increments the per-session inference-call counter on completed AND failed chat messages", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessageUpdated(messageUpdatedEvent(), ctx);
    handleMessageUpdated(
      messageUpdatedEvent({ error: { name: "ModelError", data: { message: "boom" } } }),
      ctx,
    );

    const totals = ctx.sessionTotals.get("ses-1")!;
    expect(totals.inferenceCalls).toBe(2);
    expect(totals.toolCalls).toBe(0);
  });

  test("increments the per-session tool-call counter on completed AND failed tool parts", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "Bash",
        state: { status: "completed", input: {}, output: "out", time: { start: 1000, end: 2000 } },
      }),
      ctx,
    );
    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-1",
        messageID: "msg-1",
        callID: "call-2",
        tool: "Read",
        state: { status: "error", input: {}, error: "boom", time: { start: 1000, end: 2000 } },
      }),
      ctx,
    );

    const totals = ctx.sessionTotals.get("ses-1")!;
    expect(totals.toolCalls).toBe(2);
    expect(totals.inferenceCalls).toBe(0);
  });

  test("records invoke_agent inference/tool call counts at session idle (EARS-9)", () => {
    const { ctx, records } = makeContext();
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 1,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 3,
      toolCalls: 2,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleSessionIdle({ properties: { sessionID: "ses-1" } }, ctx);

    const inference = records["genAiInferenceCalls"];
    expect(inference).toHaveLength(1);
    expect(inference[0].value).toBe(3);
    expect(inference[0].attributes).toMatchObject({ [GEN_AI_AGENT_NAME]: "coder" });
    const tool = records["genAiToolCalls"];
    expect(tool).toHaveLength(1);
    expect(tool[0].value).toBe(2);
    expect(tool[0].attributes).toMatchObject({ [GEN_AI_AGENT_NAME]: "coder" });
  });

  test("records invoke_agent inference/tool call counts at session error (EARS-9)", () => {
    const { ctx, records } = makeContext();
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 1,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 2,
      toolCalls: 1,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleSessionError(
      { properties: { sessionID: "ses-1", error: { name: "ModelError", data: { message: "boom" } } } },
      ctx,
    );

    const inference = records["genAiInferenceCalls"];
    expect(inference).toHaveLength(1);
    expect(inference[0].value).toBe(2);
    expect(inference[0].attributes).toMatchObject({ [GEN_AI_AGENT_NAME]: "coder" });
    const tool = records["genAiToolCalls"];
    expect(tool).toHaveLength(1);
    expect(tool[0].value).toBe(1);
  });

  test("records no invoke_agent counts for a session with zero inference/tool calls (EARS-10)", () => {
    const { ctx, records } = makeContext();
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleSessionIdle({ properties: { sessionID: "ses-1" } }, ctx);

    expect(records["genAiInferenceCalls"]).toBeUndefined();
    expect(records["genAiToolCalls"]).toBeUndefined();
  });

  test("deletes the messageMeta entry when the message completes", () => {
    const { ctx } = makeContext();
    const span = makeFakeSpan();
    const key = "ses-1:msg-1";
    ctx.messageSpans.set(key, span.span);
    ctx.messageOutputs.set(key, "the agent reply");
    ctx.messageMeta.set(key, { startedAtMs: 1000, providerID: "openai", modelID: "gpt-4o" });

    handleMessageUpdated(messageUpdatedEvent(), ctx);

    expect(ctx.messageMeta.has(key)).toBe(false);
  });
});

describe("Spec #2688 thinking capture (flat agentThinking)", () => {
  test("accumulates thinking parts and emits agentThinking on the completed LLM span", () => {
    const { ctx } = makeContext();
    const span = makeFakeSpan();
    const key = "ses-1:msg-1";
    ctx.messageSpans.set(key, span.span);
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessagePartUpdated(thinkingPartEvent("ses-1", "msg-1", "First thought"), ctx);
    handleMessagePartUpdated(thinkingPartEvent("ses-1", "msg-1", "Second thought"), ctx);
    expect(ctx.messageThinking.get(key)).toBe("First thoughtSecond thought");

    handleMessageUpdated(messageUpdatedEvent(), ctx);

    expect(span.attributes["agentThinking"]).toBe("First thoughtSecond thought");
    // The flat agentThinking attribute is NOT a gen_ai.* registry key (NFR-2).
    expect(span.attributes["agentThinking"]).not.toMatch(/^gen_ai\./);
    // The map entry is consumed and deleted on completion.
    expect(ctx.messageThinking.has(key)).toBe(false);
  });

  test("accepts the SDK `reasoning` part type as well as `thinking`", () => {
    const { ctx } = makeContext();
    const span = makeFakeSpan();
    const key = "ses-1:msg-1";
    ctx.messageSpans.set(key, span.span);
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessagePartUpdated(thinkingPartEvent("ses-1", "msg-1", "SDK reasoning text", "reasoning"), ctx);

    handleMessageUpdated(messageUpdatedEvent(), ctx);

    expect(span.attributes["agentThinking"]).toBe("SDK reasoning text");
    expect(ctx.messageThinking.has(key)).toBe(false);
  });

  test("omits agentThinking when no thinking parts were captured", () => {
    const { ctx } = makeContext();
    const span = makeFakeSpan();
    const key = "ses-1:msg-1";
    ctx.messageSpans.set(key, span.span);
    ctx.messageOutputs.set(key, "the agent reply");
    ctx.sessionTotals.set("ses-1", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessageUpdated(messageUpdatedEvent(), ctx);

    expect(span.attributes["agentThinking"]).toBeUndefined();
  });

  test("sweepSession clears thinking entries for the session", () => {
    const { ctx } = makeContext();
    ctx.messageThinking.set("ses-1:msg-1", "thoughts");
    ctx.messageThinking.set("ses-2:msg-1", "keep me");

    handleSessionIdle({ properties: { sessionID: "ses-1" } }, ctx);

    expect(ctx.messageThinking.has("ses-1:msg-1")).toBe(false);
    expect(ctx.messageThinking.has("ses-2:msg-1")).toBe(true);
  });
});

describe("Spec #2745 R-2 child-completion enrichment (ST-2 plugin emission)", () => {
  const CHILD_SNAPSHOT = {
    childSessionId: "ses-child",
    agent: "explore",
    tokens: 1234,
    cost: 0.0456,
    messages: 7,
    output: "child final output",
    inputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
  };

  test("childCompletionAttrs builds the fredo-native flat keys (no gen_ai.*) — totals + per-family breakdown", () => {
    const attrs = childCompletionAttrs(CHILD_SNAPSHOT);
    expect(attrs).toEqual({
      [ATTR_CHILD_SESSION_ID]: "ses-child",
      [ATTR_CHILD_AGENT]: "explore",
      [ATTR_CHILD_TOTAL_TOKENS]: 1234,
      [ATTR_CHILD_TOTAL_COST]: 0.0456,
      [ATTR_CHILD_TOTAL_MESSAGES]: 7,
      [ATTR_CHILD_INPUT_TOKENS]: 0,
      [ATTR_CHILD_CACHE_READ_TOKENS]: 0,
      [ATTR_CHILD_REASONING_TOKENS]: 0,
      [ATTR_CHILD_OUTPUT_TOKENS]: 0,
    });
    // Deliberately fredo-native: no key under the gen_ai.* registry namespace.
    for (const key of Object.keys(attrs)) {
      expect(key.startsWith("gen_ai.")).toBe(false);
    }
  });

  test("child session.idle records the completion snapshot keyed by the PARENT session id", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-child", {
      startMs: 1000,
      tokens: 1234,
      cost: 0.0456,
      messages: 7,
      agent: "explore",
      agentType: "subagent",
      parentId: "ses-parent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    ctx.messageOutputs.set("ses-child:msg-1", "child final output");

    handleSessionIdle({ properties: { sessionID: "ses-child" } }, ctx);

    expect(ctx.pendingChildCompletions.get("ses-parent")).toEqual(CHILD_SNAPSHOT);
    // The snapshot is keyed by the parent, never the child's own id.
    expect(ctx.pendingChildCompletions.has("ses-child")).toBe(false);
  });

  test("child session.error records the completion snapshot keyed by the PARENT session id", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-child", {
      startMs: 1000,
      tokens: 200,
      cost: 0.01,
      messages: 3,
      agent: "explore",
      agentType: "subagent",
      parentId: "ses-parent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    ctx.messageOutputs.set("ses-child:msg-1", "partial output");

    handleSessionError(
      { properties: { sessionID: "ses-child", error: { name: "ModelError", data: { message: "boom" } } } },
      ctx,
    );

    expect(ctx.pendingChildCompletions.get("ses-parent")).toEqual({
      childSessionId: "ses-child",
      agent: "explore",
      tokens: 200,
      cost: 0.01,
      messages: 3,
      output: "partial output",
      inputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
  });

  test("primary session (no parentId) records no snapshot — degrades silently", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-primary", {
      startMs: 1000,
      tokens: 10,
      cost: 0,
      messages: 1,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleSessionIdle({ properties: { sessionID: "ses-primary" } }, ctx);

    expect(ctx.pendingChildCompletions.size).toBe(0);
  });

  test("attach-at-idle: child idle attaches the five flat attrs onto the parent's pending task span", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-child", {
      startMs: 1000,
      tokens: 1234,
      cost: 0.0456,
      messages: 7,
      agent: "explore",
      agentType: "subagent",
      parentId: "ses-parent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    ctx.messageOutputs.set("ses-child:msg-1", "child final output");
    const taskSpan = makeFakeSpan();
    ctx.pendingToolSpans.set("ses-parent:call-task", {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
      span: taskSpan.span,
    });

    handleSessionIdle({ properties: { sessionID: "ses-child" } }, ctx);

    expect(taskSpan.attributes).toMatchObject({
      [ATTR_CHILD_SESSION_ID]: "ses-child",
      [ATTR_CHILD_AGENT]: "explore",
      [ATTR_CHILD_TOTAL_TOKENS]: 1234,
      [ATTR_CHILD_TOTAL_COST]: 0.0456,
      [ATTR_CHILD_TOTAL_MESSAGES]: 7,
    });
    // The parent's task span is NOT ended by the child's idle handler.
    expect(taskSpan.endCalls).toHaveLength(0);
    expect(ctx.pendingToolSpans.has("ses-parent:call-task")).toBe(true);
  });

  test("tool-completed branch attaches the snapshot onto the task span BEFORE it ends", () => {
    const { ctx, pendingToolSpans } = makeContext();
    ctx.pendingChildCompletions.set("ses-parent", CHILD_SNAPSHOT);
    const key = "ses-parent:call-task";
    const span = makeFakeSpan();
    pendingToolSpans.set(key, {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-parent",
        messageID: "msg-1",
        callID: "call-task",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "explore", prompt: "Investigate" },
          output: "<task ...>",
          time: { start: 1000, end: 2500 },
        },
      }),
      ctx,
    );

    expect(span.attributes).toMatchObject({
      [ATTR_CHILD_SESSION_ID]: "ses-child",
      [ATTR_CHILD_AGENT]: "explore",
      [ATTR_CHILD_TOTAL_TOKENS]: 1234,
      [ATTR_CHILD_TOTAL_COST]: 0.0456,
      [ATTR_CHILD_TOTAL_MESSAGES]: 7,
    });
    // The five attrs arrive before the span ends.
    expect(span.callOrder.indexOf("setAttributes")).toBeGreaterThan(-1);
    expect(span.callOrder.indexOf("setAttributes")).toBeLessThan(span.callOrder.indexOf("end"));
    expect(span.endCalls).toEqual([2500]);
    expect(pendingToolSpans.has(key)).toBe(false);
  });

  test("a non-task tool span does NOT receive child-completion attrs", () => {
    const { ctx, pendingToolSpans } = makeContext();
    ctx.pendingChildCompletions.set("ses-parent", CHILD_SNAPSHOT);
    const span = makeFakeSpan();
    pendingToolSpans.set("ses-parent:call-bash", {
      tool: "Bash",
      sessionID: "ses-parent",
      startMs: 1000,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-parent",
        messageID: "msg-1",
        callID: "call-bash",
        tool: "Bash",
        state: { status: "completed", input: {}, output: "ls", time: { start: 1000, end: 2000 } },
      }),
      ctx,
    );

    expect(span.attributes[ATTR_CHILD_SESSION_ID]).toBeUndefined();
    expect(span.attributes[ATTR_CHILD_TOTAL_TOKENS]).toBeUndefined();
    expect(span.endCalls).toEqual([2000]);
  });

  test("task span completes with no snapshot — degrades silently, no crash", () => {
    const { ctx, pendingToolSpans } = makeContext();
    const span = makeFakeSpan();
    pendingToolSpans.set("ses-parent:call-task", {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-parent",
        messageID: "msg-1",
        callID: "call-task",
        tool: "task",
        state: { status: "completed", input: {}, output: "no child", time: { start: 1000, end: 2000 } },
      }),
      ctx,
    );

    expect(span.attributes[ATTR_CHILD_SESSION_ID]).toBeUndefined();
    expect(span.endCalls).toEqual([2000]);
    expect(span.statuses).toEqual([{ code: SpanStatusCode.OK }]);
  });

  test("pendingChildCompletions is bounded: oldest-first eviction at MAX_CHILD_COMPLETIONS", () => {
    const { ctx } = makeContext();
    // Fill to capacity + 1 with distinct parent ids; the oldest (first) evicts.
    for (let i = 0; i <= MAX_CHILD_COMPLETIONS; i++) {
      const childId = `ses-child-${i}`;
      const parentId = `ses-parent-${i}`;
      ctx.sessionTotals.set(childId, {
        startMs: 1000,
        tokens: i,
        cost: 0,
        messages: 1,
        agent: "explore",
        agentType: "subagent",
        parentId,
        inferenceCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        outputTokens: 0,
      });
      recordChildCompletion(childId, ctx);
    }
    expect(ctx.pendingChildCompletions.size).toBe(MAX_CHILD_COMPLETIONS);
    // Oldest evicted, newest retained.
    expect(ctx.pendingChildCompletions.has("ses-parent-0")).toBe(false);
    expect(ctx.pendingChildCompletions.has(`ses-parent-${MAX_CHILD_COMPLETIONS}`)).toBe(true);
  });

  test("R-3 live defect regression: child idle records the snapshot via pending-task resolution when sessionTotals.parentId is absent", () => {
    const { ctx } = makeContext();
    // Live defect shape (Phase-0 diagnostic + round-2 evidence): this opencode
    // version's `session.created` for the child carries no `info.parentID` and
    // the session.created-time fallback runs before the parent's task `running`
    // part update reaches the plugin — so sessionTotals.parentId is never set
    // for the whole child lifecycle. The five child_* attrs were NULL on the
    // parent task span because recordChildCompletion no-oped at idle.
    ctx.sessionTotals.set("ses-child", {
      startMs: 1000,
      tokens: 1234,
      cost: 0.0456,
      messages: 7,
      agent: "explore",
      agentType: "subagent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    ctx.messageOutputs.set("ses-child:msg-1", "child final output");
    // The parent's task tool is still executing (awaiting the child) — its span
    // is pending, exactly as in the live flow at child idle.
    const taskSpan = makeFakeSpan();
    ctx.pendingToolSpans.set("ses-parent:call-task", {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
      span: taskSpan.span,
    });

    handleSessionIdle({ properties: { sessionID: "ses-child" } }, ctx);

    // The snapshot is recorded keyed by the parent even though the in-process
    // parentId was never set at session.created.
    expect(ctx.pendingChildCompletions.get("ses-parent")).toEqual({
      childSessionId: "ses-child",
      agent: "explore",
      tokens: 1234,
      cost: 0.0456,
      messages: 7,
      output: "child final output",
      inputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    // Attach-at-idle also fires: the five flat attrs land on the pending task span.
    expect(taskSpan.attributes).toMatchObject({
      [ATTR_CHILD_SESSION_ID]: "ses-child",
      [ATTR_CHILD_AGENT]: "explore",
      [ATTR_CHILD_TOTAL_TOKENS]: 1234,
      [ATTR_CHILD_TOTAL_COST]: 0.0456,
      [ATTR_CHILD_TOTAL_MESSAGES]: 7,
    });
    // The resolved parentId is persisted back into sessionTotals (before delete).
    expect(ctx.sessionTotals.has("ses-child")).toBe(false); // deleted at idle
  });

  test("R-3 live defect regression: child error records the snapshot via pending-task resolution when parentId is absent", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-child", {
      startMs: 1000,
      tokens: 200,
      cost: 0.01,
      messages: 3,
      agent: "explore",
      agentType: "subagent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    ctx.messageOutputs.set("ses-child:msg-1", "partial output");
    const taskSpan = makeFakeSpan();
    ctx.pendingToolSpans.set("ses-parent:call-task", {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
      span: taskSpan.span,
    });

    handleSessionError(
      { properties: { sessionID: "ses-child", error: { name: "ModelError", data: { message: "boom" } } } },
      ctx,
    );

    expect(ctx.pendingChildCompletions.get("ses-parent")).toEqual({
      childSessionId: "ses-child",
      agent: "explore",
      tokens: 200,
      cost: 0.01,
      messages: 3,
      output: "partial output",
      inputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    expect(taskSpan.attributes[ATTR_CHILD_SESSION_ID]).toBe("ses-child");
  });

  test("resolveParentSessionId persists the resolved parentId into sessionTotals", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-child", {
      startMs: 1000,
      tokens: 10,
      cost: 0,
      messages: 1,
      agent: "explore",
      agentType: "subagent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    ctx.pendingToolSpans.set("ses-parent:call-task", {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
    });

    const parentId = resolveParentSessionId("ses-child", ctx);

    expect(parentId).toBe("ses-parent");
    expect(ctx.sessionTotals.get("ses-child")!.parentId).toBe("ses-parent");
    // Existing fields survive the reconstruction.
    expect(ctx.sessionTotals.get("ses-child")!.tokens).toBe(10);
  });

  test("pending-task resolution prefers the most recent (innermost) task dispatch for nested subagents", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-grandchild", {
      startMs: 1000,
      tokens: 10,
      cost: 0,
      messages: 1,
      agent: "explore",
      agentType: "subagent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });
    const outer = makeFakeSpan();
    const inner = makeFakeSpan();
    // Outer dispatch (parent → child) created first; inner (child → grandchild) second.
    ctx.pendingToolSpans.set("ses-parent:call-1", {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
      span: outer.span,
    });
    ctx.pendingToolSpans.set("ses-child:call-2", {
      tool: "task",
      sessionID: "ses-child",
      startMs: 2000,
      span: inner.span,
    });

    recordChildCompletion("ses-grandchild", ctx);

    // The snapshot is keyed by the innermost dispatch (the direct parent).
    expect(ctx.pendingChildCompletions.get("ses-child")).toMatchObject({
      childSessionId: "ses-grandchild",
    });
    expect(ctx.pendingChildCompletions.has("ses-parent")).toBe(false);
  });

  test("accumulateSessionTotals preserves the resolved parentId across the first completed message", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-child", {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "explore",
      agentType: "subagent",
      parentId: "ses-parent",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleMessageUpdated(
      messageUpdatedEvent({ sessionID: "ses-child", id: "msg-1", parentID: "run-1" }),
      ctx,
    );

    // R-3 fix: the reconstruction previously dropped parentId, so the ST-2
    // snapshot gate found no parent at the child's idle.
    const totals = ctx.sessionTotals.get("ses-child")!;
    expect(totals.parentId).toBe("ses-parent");
    expect(totals.tokens).toBe(30); // 10 input + 20 output accumulated
    expect(totals.messages).toBe(1);
  });

  test("no parent and no pending task span records no snapshot — degrades silently", () => {
    const { ctx } = makeContext();
    ctx.sessionTotals.set("ses-standalone", {
      startMs: 1000,
      tokens: 10,
      cost: 0,
      messages: 1,
      agent: "coder",
      agentType: "primary",
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    });

    handleSessionIdle({ properties: { sessionID: "ses-standalone" } }, ctx);

    expect(ctx.pendingChildCompletions.size).toBe(0);
  });
});

describe("Spec #2768 ST-1 tool-span parent routing stamps (session.parent_id)", () => {
  /** Subagent totals seed with an optional parentId for the ST-1 resolution. */
  function subagentTotals(parentId?: string) {
    return {
      startMs: 1000,
      tokens: 0,
      cost: 0,
      messages: 0,
      agent: "explore",
      agentType: "subagent" as const,
      ...(parentId ? { parentId } : {}),
      inferenceCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    };
  }

  test("child tool-part running event stamps session.parent_id at span creation (totals.parentId)", () => {
    const spans: Array<ReturnType<typeof makeFakeSpan>> = [];
    const { ctx } = makeContext({ spans });
    ctx.sessionTotals.set("ses-child", subagentTotals("ses-parent"));

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-child",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: { status: "running", input: {}, time: { start: 1000 } },
      }),
      ctx,
    );

    expect(spans.length).toBe(1);
    expect(spans[0].attributes[ATTR_PARENT_SESSION_ID]).toBe("ses-parent");
  });

  test("child tool-part running event resolves the parent from the pending task span (scan fallback)", () => {
    const spans: Array<ReturnType<typeof makeFakeSpan>> = [];
    const { ctx } = makeContext({ spans });
    // No totals entry — the parent resolves via the pending-task scan (the live
    // R-3 shape where session.created carried no parentID for the child).
    ctx.pendingToolSpans.set("ses-parent:call-task", {
      tool: "task",
      sessionID: "ses-parent",
      startMs: 1000,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-child",
        messageID: "msg-1",
        callID: "call-1",
        tool: "glob",
        state: { status: "running", input: {}, time: { start: 1000 } },
      }),
      ctx,
    );

    expect(spans.length).toBe(1);
    expect(spans[0].attributes[ATTR_PARENT_SESSION_ID]).toBe("ses-parent");
  });

  test("primary session with nothing resolvable stamps nothing (self-parent guard included)", () => {
    const spans: Array<ReturnType<typeof makeFakeSpan>> = [];
    const { ctx } = makeContext({ spans });
    // The parent's own pending task span is visible but belongs to THIS session —
    // the scan's self-parent guard excludes it, so nothing resolves.
    ctx.pendingToolSpans.set("ses-primary:call-task", {
      tool: "task",
      sessionID: "ses-primary",
      startMs: 1000,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-primary",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: { status: "running", input: {}, time: { start: 1000 } },
      }),
      ctx,
    );

    expect(spans.length).toBe(1);
    expect(spans[0].attributes[ATTR_PARENT_SESSION_ID]).toBeUndefined();
  });

  test("suppressParentRouting stamps nothing at span creation (seam parity)", () => {
    const spans: Array<ReturnType<typeof makeFakeSpan>> = [];
    const { ctx } = makeContext({ spans });
    ctx.sessionTotals.set("ses-child", subagentTotals("ses-parent"));
    ctx.suppressParentRouting = true;

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-child",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: { status: "running", input: {}, time: { start: 1000 } },
      }),
      ctx,
    );

    expect(spans.length).toBe(1);
    expect(spans[0].attributes[ATTR_PARENT_SESSION_ID]).toBeUndefined();
  });

  test("suppressParentRouting stamps nothing at the completed final set (seam parity)", () => {
    const { ctx, pendingToolSpans } = makeContext();
    ctx.sessionTotals.set("ses-child", subagentTotals("ses-parent"));
    ctx.suppressParentRouting = true;
    const span = makeFakeSpan();
    pendingToolSpans.set("ses-child:call-1", {
      tool: "bash",
      sessionID: "ses-child",
      startMs: 1000,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-child",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: { status: "completed", input: {}, output: "out", time: { start: 1000, end: 2000 } },
      }),
      ctx,
    );

    expect(span.attributes[ATTR_PARENT_SESSION_ID]).toBeUndefined();
    expect(span.endCalls).toEqual([2000]);
  });

  test("completed tool part stamps session.parent_id via the completion-branch final set", () => {
    const { ctx, pendingToolSpans } = makeContext();
    ctx.sessionTotals.set("ses-child", subagentTotals("ses-parent"));
    const span = makeFakeSpan();
    pendingToolSpans.set("ses-child:call-1", {
      tool: "bash",
      sessionID: "ses-child",
      startMs: 1000,
      span: span.span,
    });

    handleMessagePartUpdated(
      toolPartEvent({
        sessionID: "ses-child",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: { status: "completed", input: {}, output: "out", time: { start: 1000, end: 2000 } },
      }),
      ctx,
    );

    expect(span.attributes[ATTR_PARENT_SESSION_ID]).toBe("ses-parent");
    expect(span.endCalls).toEqual([2000]);
  });
});
