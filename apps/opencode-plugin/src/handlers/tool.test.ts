/**
 * handlers/tool.test.ts — ST-4 tool lifecycle emission contract (Spec #3197).
 *
 * Pins, per event:
 *   · `session.tool.input.started|delta|ended` → accumulation only (the tool
 *     name and the streamed JSON text are remembered per call id);
 *   · `session.tool.called` → the `fredo.tool.<name>` span with the R-1.3
 *     attribute set (`gen_ai.tool.call.arguments` as a JSON STRING);
 *   · `session.tool.success` → span OK + `tool.success`/`duration_ms`/
 *     `tool.result_size_bytes`/`gen_ai.tool.call.result` + metrics + `tool_result`;
 *   · `session.tool.failed` → span ERROR (R-4.1) + `tool.error` + the
 *     `gen_ai.client.operation.exception` span event;
 *   · `session.tool.progress` → NO emission;
 *   · the pending entry is dropped only AFTER the span has been `.end()`ed
 *     (the orphan regression), and the `task`-tool child completion is attached.
 */

import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import type { Attributes, SpanOptions, Tracer } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import {
  handleToolCalled,
  handleToolFailed,
  handleToolInputDelta,
  handleToolInputEnded,
  handleToolInputStarted,
  handleToolProgress,
  handleToolSuccess,
} from "./tool";
import { handleSessionCreated } from "./session";
import {
  ATTR_SESSION_ID,
  ATTR_AGENT_TYPE,
  ATTR_DURATION_MS,
  ATTR_TOOL_NAME,
  ATTR_TOOL_SUCCESS,
  ATTR_TOOL_ERROR,
  ATTR_TOOL_RESULT_SIZE,
  ATTR_CHILD_SESSION_ID,
  ATTR_CHILD_TOTAL_TOKENS,
  LOG_TOOL_RESULT,
} from "../telemetry-constants";
import {
  ATTR_OP_NAME,
  GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  OP_NAME_TOOL,
} from "../genai-conventions";
import type { HandlerContext, Instruments, PendingChildCompletion, V2EventOf } from "../types";

// ── Recording harness ───────────────────────────────────────────────────────

type RecordedSpan = {
  name: string;
  options: SpanOptions | undefined;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  events: { name: string; attributes: Record<string, unknown> }[];
  ended: boolean;
};

type MetricRecord = { name: string; value: number; attributes: Attributes };

function harness(): {
  ctx: HandlerContext;
  spans: RecordedSpan[];
  logs: LogRecord[];
  metrics: MetricRecord[];
} {
  const spans: RecordedSpan[] = [];
  const logs: LogRecord[] = [];
  const metrics: MetricRecord[] = [];

  const counter = (name: string) => ({
    add: (value: number, attributes?: Attributes) =>
      metrics.push({ name, value, attributes: attributes ?? {} }),
  });
  const histogram = (name: string) => ({
    record: (value: number, attributes?: Attributes) =>
      metrics.push({ name, value, attributes: attributes ?? {} }),
  });

  const tracer = {
    startSpan: (name: string, options?: SpanOptions) => {
      const rec: RecordedSpan = {
        name,
        options,
        attributes: { ...((options?.attributes ?? {}) as Record<string, unknown>) },
        events: [],
        ended: false,
      };
      spans.push(rec);
      return {
        setAttributes: (attrs: Attributes) => Object.assign(rec.attributes, attrs),
        setAttribute: (key: string, value: unknown) => {
          rec.attributes[key] = value;
        },
        addEvent: (eventName: string, attributes?: Attributes) =>
          rec.events.push({
            name: eventName,
            attributes: { ...((attributes ?? {}) as Record<string, unknown>) },
          }),
        setStatus: (status: { code: number; message?: string }) => {
          rec.status = status;
        },
        end: () => {
          rec.ended = true;
        },
        spanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      };
    },
  } as unknown as Tracer;

  const instruments = {
    sessionCounter: counter("fredo.session.count"),
    tokenCounter: counter("fredo.token.usage"),
    costCounter: counter("fredo.cost.usage"),
    toolDurationHistogram: histogram("fredo.tool.duration"),
    genAiOperationDuration: histogram("gen_ai.client.operation.duration"),
    genAiTokenUsage: histogram("gen_ai.client.token.usage"),
    genAiExecuteToolDuration: histogram("gen_ai.execute_tool.duration"),
    genAiInvokeAgentDuration: histogram("gen_ai.invoke_agent.duration"),
    genAiTimeToFirstChunk: histogram("gen_ai.client.operation.time_to_first_chunk"),
    genAiTimePerOutputChunk: histogram("gen_ai.client.operation.time_per_output_chunk"),
    genAiInferenceCalls: histogram("gen_ai.invoke_agent.inference_calls"),
    genAiToolCalls: histogram("gen_ai.invoke_agent.tool_calls"),
  } as unknown as Instruments;

  const ctx = {
    log: () => {},
    emitLog: (record: LogRecord) => {
      logs.push(record);
    },
    instruments,
    pendingToolSpans: new Map(),
    pendingToolInputs: new Map(),
    pendingPermissions: new Map(),
    sessionTotals: new Map(),
    sessionTurns: new Map(),
    tracer,
    tracePrefix: "fredo.",
    rootContext: () => ROOT_CONTEXT,
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
    messageMeta: new Map(),
    pendingChildCompletions: new Map(),
    suppressParentRouting: false,
    onIdleFlush: () => {},
  } as unknown as HandlerContext;

  return { ctx, spans, logs, metrics };
}

// ── Typed event literals ────────────────────────────────────────────────────

const durable = { aggregateID: "agg", seq: 1, version: 1 } as const;
const durableV2 = { aggregateID: "agg", seq: 2, version: 2 } as const;
const SESSION = "ses_tool";
const MESSAGE = "msg_assistant";
const CALL = "call-1";

const created: V2EventOf<"session.created"> = {
  id: "evt-created",
  created: 100,
  type: "session.created",
  durable,
  data: {
    sessionID: SESSION,
    projectID: "prj",
    location: { directory: "/repo" },
    slug: SESSION,
    version: "2.4.1",
    agent: "build",
    model: { id: "claude-sonnet", providerID: "anthropic" },
  },
};

const inputStarted: V2EventOf<"session.tool.input.started"> = {
  id: "evt-input-started",
  created: 110,
  type: "session.tool.input.started",
  durable,
  data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, name: "read" },
};

const inputDelta: V2EventOf<"session.tool.input.delta"> = {
  id: "evt-input-delta",
  created: 111,
  type: "session.tool.input.delta",
  data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, delta: '{"path":' },
};

const inputEnded: V2EventOf<"session.tool.input.ended"> = {
  id: "evt-input-ended",
  created: 112,
  type: "session.tool.input.ended",
  durable,
  data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, text: '{"path":"a.ts"}' },
};

const called: V2EventOf<"session.tool.called"> = {
  id: "evt-called",
  created: 113,
  type: "session.tool.called",
  durable,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    id: CALL,
    input: { path: "a.ts" },
    executed: true,
  },
};

const progress: V2EventOf<"session.tool.progress"> = {
  id: "evt-progress",
  created: 114,
  type: "session.tool.progress",
  data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, metadata: { pct: 50 } },
};

const success: V2EventOf<"session.tool.success"> = {
  id: "evt-success",
  created: 130,
  type: "session.tool.success",
  durable: durableV2,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    id: CALL,
    content: [{ type: "text", text: "file body" }],
    executed: true,
  },
};

const failed: V2EventOf<"session.tool.failed"> = {
  id: "evt-failed",
  created: 130,
  type: "session.tool.failed",
  durable: durableV2,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    id: CALL,
    error: { type: "NotFound", message: "no such file" },
    executed: true,
  },
};

function withSession(h: ReturnType<typeof harness>): void {
  handleSessionCreated(created, h.ctx);
}

function toolSpan(spans: RecordedSpan[]): RecordedSpan {
  const span = spans.find((s) => s.name.startsWith("fredo.tool."));
  if (!span) throw new Error("no fredo.tool.* span was started");
  return span;
}

// ── input accumulation ──────────────────────────────────────────────────────

describe("session.tool.input.*", () => {
  test("accumulates the name + streamed argument text with no emission", () => {
    const h = harness();
    withSession(h);
    const logsBefore = h.logs.length;

    handleToolInputStarted(inputStarted, h.ctx);
    handleToolInputDelta(inputDelta, h.ctx);
    handleToolInputEnded(inputEnded, h.ctx);

    const entry = h.ctx.pendingToolInputs.get(`${SESSION}:${CALL}`)!;
    expect(entry.name).toBe("read");
    expect(entry.text).toBe('{"path":"a.ts"}');
    expect(entry.startMs).toBe(110);
    expect(h.spans).toHaveLength(0);
    expect(h.logs).toHaveLength(logsBefore);
    expect(h.metrics.filter((m) => m.name === "fredo.tool.duration")).toHaveLength(0);
  });

  test("input.ended is authoritative over the accumulated deltas", () => {
    const h = harness();
    withSession(h);
    handleToolInputStarted(inputStarted, h.ctx);
    handleToolInputDelta(inputDelta, h.ctx);
    handleToolInputEnded(inputEnded, h.ctx);
    expect(h.ctx.pendingToolInputs.get(`${SESSION}:${CALL}`)!.text).toBe('{"path":"a.ts"}');
  });
});

// ── session.tool.called ─────────────────────────────────────────────────────

describe("session.tool.called", () => {
  test("opens fredo.tool.<name> with the R-1.3 attribute set", () => {
    const h = harness();
    withSession(h);
    handleToolInputStarted(inputStarted, h.ctx);
    handleToolCalled(called, h.ctx);

    const span = toolSpan(h.spans);
    expect(span.name).toBe("fredo.tool.read");
    expect(span.attributes[ATTR_OP_NAME]).toBe(OP_NAME_TOOL);
    expect(span.attributes[GEN_AI_TOOL_NAME]).toBe("read");
    expect(span.attributes[GEN_AI_TOOL_CALL_ID]).toBe(CALL);
    expect(span.attributes[ATTR_TOOL_NAME]).toBe("read");
    expect(span.attributes["tool_call_id"]).toBe(CALL);
    expect(span.attributes["agent"]).toBe("build");
    expect(span.attributes[ATTR_AGENT_TYPE]).toBe("primary");
    expect(span.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION);
    expect(span.attributes[ATTR_SESSION_ID]).toBe(SESSION);
    // The arguments are a JSON STRING that parses back to the input object.
    expect(typeof span.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]).toBe("string");
    expect(JSON.parse(span.attributes[GEN_AI_TOOL_CALL_ARGUMENTS] as string)).toEqual({
      path: "a.ts",
    });
    expect(JSON.parse(span.attributes["tool_input"] as string)).toEqual({ path: "a.ts" });
    expect(span.options?.startTime).toBe(110);
    // Counted as an issued tool call for gen_ai.invoke_agent.tool_calls.
    expect(h.ctx.sessionTotals.get(SESSION)!.toolCalls).toBe(1);
  });

  test("a call whose input.started was missed still opens a span, named unknown", () => {
    const h = harness();
    withSession(h);
    handleToolCalled(called, h.ctx);
    const span = toolSpan(h.spans);
    expect(span.name).toBe("fredo.tool.unknown");
    expect(span.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]).toBe('{"path":"a.ts"}');
  });
});

// ── session.tool.progress ───────────────────────────────────────────────────

describe("session.tool.progress", () => {
  test("emits nothing (preserved V1 contract)", () => {
    const h = harness();
    withSession(h);
    const logsBefore = h.logs.length;
    handleToolProgress(progress, h.ctx);
    expect(h.spans).toHaveLength(0);
    expect(h.logs).toHaveLength(logsBefore);
    expect(h.metrics.filter((m) => m.name === "fredo.tool.duration")).toHaveLength(0);
  });
});

// ── session.tool.success ────────────────────────────────────────────────────

describe("session.tool.success", () => {
  test("closes the span OK with the result payload + metrics + tool_result", () => {
    const h = harness();
    withSession(h);
    handleToolInputStarted(inputStarted, h.ctx);
    handleToolCalled(called, h.ctx);
    handleToolSuccess(success, h.ctx);

    const span = toolSpan(h.spans);
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.OK);
    expect(span.attributes[ATTR_TOOL_SUCCESS]).toBe(true);
    expect(span.attributes[ATTR_DURATION_MS]).toBe(20);
    expect(span.attributes[ATTR_TOOL_RESULT_SIZE]).toBe("file body".length);
    expect(span.attributes[GEN_AI_TOOL_CALL_RESULT]).toBe("file body");

    expect(h.metrics.some((m) => m.name === "fredo.tool.duration")).toBe(true);
    expect(h.metrics.some((m) => m.name === "gen_ai.execute_tool.duration")).toBe(true);
    expect(h.metrics.some((m) => m.name === "gen_ai.client.operation.duration")).toBe(true);

    const record = h.logs.find((r) => r.body === LOG_TOOL_RESULT)!;
    expect(record.attributes?.["event.name"]).toBe(LOG_TOOL_RESULT);
    expect(record.attributes?.[ATTR_TOOL_NAME]).toBe("read");
    expect(record.attributes?.["success"]).toBe(true);

    expect(h.ctx.pendingToolSpans.size).toBe(0);
    expect(h.ctx.pendingToolInputs.size).toBe(0);
  });

  test("the pending entry is dropped only AFTER the span ended (orphan regression)", () => {
    const h = harness();
    withSession(h);
    handleToolInputStarted(inputStarted, h.ctx);
    handleToolCalled(called, h.ctx);

    // Probe the map AT `.end()` time: the entry must still be present, because a
    // span removed from the map before it ends is never exported.
    const pending = h.ctx.pendingToolSpans.get(`${SESSION}:${CALL}`)!;
    const liveSpan = pending.span as unknown as { end: () => void };
    const originalEnd = liveSpan.end.bind(liveSpan);
    let presentAtEnd: boolean | undefined;
    liveSpan.end = () => {
      presentAtEnd = h.ctx.pendingToolSpans.has(`${SESSION}:${CALL}`);
      originalEnd();
    };

    handleToolSuccess(success, h.ctx);
    expect(presentAtEnd).toBe(true);
    expect(h.ctx.pendingToolSpans.size).toBe(0);
  });

  test("the task tool carries the child-completion attributes", () => {
    const h = harness();
    withSession(h);
    const snapshot: PendingChildCompletion = {
      childSessionId: "ses_child",
      agent: "explore",
      tokens: 42,
      cost: 0.01,
      messages: 3,
      output: "done",
      inputTokens: 20,
      cacheReadTokens: 5,
      reasoningTokens: 2,
      outputTokens: 15,
    };
    h.ctx.pendingChildCompletions.set(SESSION, snapshot);

    handleToolInputStarted({ ...inputStarted, data: { ...inputStarted.data, name: "task" } }, h.ctx);
    handleToolCalled(called, h.ctx);
    handleToolSuccess(success, h.ctx);

    const span = toolSpan(h.spans);
    expect(span.attributes[ATTR_CHILD_SESSION_ID]).toBe("ses_child");
    expect(span.attributes[ATTR_CHILD_TOTAL_TOKENS]).toBe(42);
  });
});

// ── session.tool.failed ─────────────────────────────────────────────────────

describe("session.tool.failed (R-4.1)", () => {
  test("closes the span ERROR with tool.error + the exception event + metrics + tool_result", () => {
    const h = harness();
    withSession(h);
    handleToolInputStarted(inputStarted, h.ctx);
    handleToolCalled(called, h.ctx);
    handleToolFailed(failed, h.ctx);

    const span = toolSpan(h.spans);
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.ERROR);
    expect(span.status?.message).toContain("no such file");
    expect(span.attributes[ATTR_TOOL_SUCCESS]).toBe(false);
    expect(span.attributes[ATTR_TOOL_ERROR]).toContain("no such file");

    const exceptionEvent = span.events.find((e) => e.name === GEN_AI_EVENT_EXCEPTION)!;
    expect(exceptionEvent).toBeDefined();
    expect(exceptionEvent.attributes["exception.type"]).toBe("read");
    expect(exceptionEvent.attributes["exception.message"]).toContain("no such file");
    expect(exceptionEvent.attributes[GEN_AI_AGENT_NAME]).toBe("build");

    const duration = h.metrics.find((m) => m.name === "fredo.tool.duration")!;
    expect(duration.attributes["success"]).toBe(false);
    const genAiDuration = h.metrics.find((m) => m.name === "gen_ai.execute_tool.duration")!;
    expect(genAiDuration.attributes["error.type"]).toBe("NotFound");

    const record = h.logs.find((r) => r.body === LOG_TOOL_RESULT)!;
    expect(record.attributes?.["success"]).toBe(false);
    expect(record.attributes?.["error"]).toContain("no such file");
    expect(record.severityText).toBe("ERROR");

    expect(h.ctx.pendingToolSpans.size).toBe(0);
    expect(h.ctx.pendingToolInputs.size).toBe(0);
  });
});
