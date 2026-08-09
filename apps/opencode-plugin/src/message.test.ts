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
import { handleMessagePartUpdated, toolPartTimes, type ToolPartState } from "./handlers/message";
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

/** Recording fake span — captures the status, end call, and attributes. */
function makeFakeSpan() {
  const statuses: Array<{ code: SpanStatusCode; message?: string }> = [];
  const endCalls: Array<number | undefined> = [];
  const attributes: Record<string, unknown> = {};
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
    end(endTime?: number) {
      endCalls.push(endTime);
    },
  };
  return { span: span as unknown as Span, statuses, endCalls, attributes };
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
