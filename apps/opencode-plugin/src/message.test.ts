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
import {
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_EVENT_INFERENCE_DETAILS,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_ERROR_TYPE,
  ATTR_OP_NAME,
  EXCEPTION_TYPE,
  EXCEPTION_MESSAGE,
  OP_NAME_CHAT,
  OP_NAME_TOOL,
} from "./contract_633";
import type { HandlerContext, PendingToolSpan } from "./types";

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
    },
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
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
} = {}) {
  const pendingToolSpans = opts.pendingToolSpans ?? new Map<string, PendingToolSpan>();
  const instruments = {
    sessionCounter: { add: () => {} },
    tokenCounter: { add: () => {} },
    costCounter: { add: () => {} },
    toolDurationHistogram: { record: () => {} },
    genAiOperationDuration: { record: () => {} },
    genAiTokenUsage: { record: () => {} },
    genAiExecuteToolDuration: { record: () => {} },
    genAiInvokeAgentDuration: { record: () => {} },
  } as unknown as HandlerContext["instruments"];
  const tracer = {
    startSpan: () => {
      const fake = makeFakeSpan();
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
    pendingSubagentInstructions: new Map(),
  };
  return { ctx, pendingToolSpans };
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
