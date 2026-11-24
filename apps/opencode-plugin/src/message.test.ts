/**
 * message.test.ts — ST-3 model-turn emission contract (Spec #3197).
 *
 * Rewritten for the V2 shapes (the V1 file pinned handlers that no longer
 * exist). Pins, per event:
 *   · `session.step.started` → the `fredo.llm` span with `gen_ai.operation.name=chat`,
 *     provider/model, the prompt and its `gen_ai.input.messages` JSON-string form;
 *   · `session.text.delta` / `session.reasoning.delta` → accumulation only
 *     (no emission), plus the TTFC / chunk-cadence histograms measured from the
 *     KNOWN step start and never fabricated;
 *   · `session.step.ended` → the span closed OK with the full V1 attribute set,
 *     the inference-details span event, the usage metrics and `api_request`;
 *   · `session.step.failed` → the span closed ERROR with the exception event,
 *     metrics carrying `error.type` and `api_error`;
 *   · usage is counted exactly ONCE per step (a duplicated terminal is inert).
 *
 * Every payload literal is typed against `V2EventOf<…>`, so a shape drift is a
 * compile error here.
 */

import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import type { Attributes, SpanOptions, Tracer } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import {
  handleReasoningDelta,
  handleStepEnded,
  handleStepFailed,
  handleStepStarted,
  handleTextDelta,
} from "./handlers/message";
import { handleSessionCreated, handleSessionInboxEnqueued } from "./handlers/session";
import {
  ATTR_SESSION_ID,
  ATTR_AGENT_TYPE,
  ATTR_INPUT_TOKENS,
  ATTR_OUTPUT_TOKENS,
  ATTR_REASONING_TOKENS,
  ATTR_CACHE_READ_TOKENS,
  ATTR_CACHE_CREATION_TOKENS,
  ATTR_DURATION_MS,
  ATTR_COST_USD,
  ATTR_MODEL,
  ATTR_PROVIDER,
  LOG_API_REQUEST,
  LOG_API_ERROR,
} from "./telemetry-constants";
import {
  ATTR_OP_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_EVENT_INFERENCE_DETAILS,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  OP_NAME_CHAT,
} from "./genai-conventions";
import type { HandlerContext, Instruments, V2EventOf } from "./types";

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
    registeredSessions: new Set(),
    suppressParentRouting: false,
    onExporterFlush: () => {},
  } as unknown as HandlerContext;

  return { ctx, spans, logs, metrics };
}

// ── Typed event literals ────────────────────────────────────────────────────

const durable = { aggregateID: "agg", seq: 1, version: 1 } as const;
const durableV2 = { aggregateID: "agg", seq: 2, version: 2 } as const;
const SESSION = "ses_step";
const MESSAGE = "msg_assistant";

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

const prompt: V2EventOf<"session.inbox.enqueued"> = {
  id: "evt-inbox",
  created: 101,
  type: "session.inbox.enqueued",
  durable,
  data: {
    sessionID: SESSION,
    inboxID: "msg_user",
    item: { type: "user", payload: { text: "please read the file" }, delivery: "queue" },
  },
};

const stepStarted: V2EventOf<"session.step.started"> = {
  id: "evt-step",
  created: 110,
  type: "session.step.started",
  durable,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    agent: "build",
    model: { id: "claude-sonnet", providerID: "anthropic" },
    started: 110,
  },
};

const stepEnded: V2EventOf<"session.step.ended"> = {
  id: "evt-ended",
  created: 150,
  type: "session.step.ended",
  durable,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    finish: "stop",
    cost: 0.02,
    tokens: {
      input: 120,
      output: 40,
      reasoning: 7,
      cache: { read: 30, write: 11 },
    },
  },
};

const stepFailed: V2EventOf<"session.step.failed"> = {
  id: "evt-failed",
  created: 150,
  type: "session.step.failed",
  durable,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    error: { type: "APIError", message: "rate limited" },
  },
};

function textDelta(delta: string, created: number): V2EventOf<"session.text.delta"> {
  return {
    id: `evt-text-${created}`,
    created,
    type: "session.text.delta",
    data: { sessionID: SESSION, assistantMessageID: MESSAGE, ordinal: 0, delta },
  };
}

function reasoningDelta(delta: string, created: number): V2EventOf<"session.reasoning.delta"> {
  return {
    id: `evt-reason-${created}`,
    created,
    type: "session.reasoning.delta",
    data: { sessionID: SESSION, assistantMessageID: MESSAGE, ordinal: 0, delta },
  };
}

/** Registers the session + prompt so the LLM span has an agent and a prompt. */
function withSession(h: ReturnType<typeof harness>): void {
  handleSessionCreated(created, h.ctx);
  handleSessionInboxEnqueued(prompt, h.ctx);
}

function llmSpan(spans: RecordedSpan[]): RecordedSpan {
  const span = spans.find((s) => s.name === "fredo.llm");
  if (!span) throw new Error("no fredo.llm span was started");
  return span;
}

// ── session.step.started ────────────────────────────────────────────────────

describe("session.step.started", () => {
  test("opens fredo.llm with the R-1.2 request attribute set", () => {
    const h = harness();
    withSession(h);
    handleStepStarted(stepStarted, h.ctx);

    const span = llmSpan(h.spans);
    expect(span.name).toBe("fredo.llm");
    expect(span.attributes[ATTR_OP_NAME]).toBe(OP_NAME_CHAT);
    expect(span.attributes[ATTR_SESSION_ID]).toBe(SESSION);
    expect(span.attributes[ATTR_AGENT_TYPE]).toBe("primary");
    expect(span.attributes["agent"]).toBe("build");
    expect(span.attributes[ATTR_MODEL]).toBe("claude-sonnet");
    expect(span.attributes[ATTR_PROVIDER]).toBe("anthropic");
    expect(span.attributes[GEN_AI_PROVIDER_NAME]).toBe("anthropic");
    expect(span.attributes[GEN_AI_REQUEST_MODEL]).toBe("claude-sonnet");
    expect(span.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION);
    expect(span.attributes["prompt"]).toBe("please read the file");
    // Content keys are JSON strings, never object arrays.
    expect(typeof span.attributes[GEN_AI_INPUT_MESSAGES]).toBe("string");
    expect(span.attributes[GEN_AI_INPUT_MESSAGES] as string).toContain("please read the file");
    expect(span.options?.startTime).toBe(110);
  });

  test("repairs an unknown agent from session.created with the step's agent", () => {
    const h = harness();
    handleSessionCreated({ ...created, data: { ...created.data, agent: undefined } }, h.ctx);
    handleStepStarted(stepStarted, h.ctx);
    expect(h.ctx.sessionTotals.get(SESSION)!.agent).toBe("build");
    expect(llmSpan(h.spans).attributes["agent"]).toBe("build");
  });
});

// ── streaming deltas ────────────────────────────────────────────────────────

describe("session.text.delta / session.reasoning.delta", () => {
  test("accumulate text and thinking without emitting anything", () => {
    const h = harness();
    withSession(h);
    const spanCountBefore = h.spans.length;
    const logCountBefore = h.logs.length;
    const metricCountBefore = h.metrics.filter(
      (m) => m.name.startsWith("gen_ai.client.operation.time"),
    ).length;

    // No step start ⇒ no timing sample may be recorded (never fabricated). the
    // TEXT itself still accumulates — it belongs to the step's message.
    handleTextDelta(textDelta("ignored", 120), h.ctx);
    expect(h.spans).toHaveLength(spanCountBefore);
    expect(h.logs).toHaveLength(logCountBefore);
    expect(
      h.metrics.filter((m) => m.name.startsWith("gen_ai.client.operation.time")),
    ).toHaveLength(metricCountBefore);

    handleStepStarted(stepStarted, h.ctx);
    handleTextDelta(textDelta("Hello", 130), h.ctx);
    handleTextDelta(textDelta(" world", 131), h.ctx);
    handleReasoningDelta(reasoningDelta("thinking...", 132), h.ctx);

    expect(h.ctx.messageOutputs.get(`${SESSION}:${MESSAGE}`)).toBe("ignoredHello world");
    expect(h.ctx.messageThinking.get(`${SESSION}:${MESSAGE}`)).toBe("thinking...");

    const ttfc = h.metrics.filter(
      (m) => m.name === "gen_ai.client.operation.time_to_first_chunk",
    );
    const cadence = h.metrics.filter(
      (m) => m.name === "gen_ai.client.operation.time_per_output_chunk",
    );
    // First chunk → TTFC once; second chunk → cadence once; nothing before the start.
    expect(ttfc).toHaveLength(1);
    expect(cadence).toHaveLength(1);
    expect(ttfc[0]!.attributes[GEN_AI_REQUEST_MODEL]).toBe("claude-sonnet");
    expect(ttfc[0]!.value).toBeGreaterThanOrEqual(0);
  });
});

// ── session.step.ended ──────────────────────────────────────────────────────

describe("session.step.ended", () => {
  test("closes the span OK with the full V1 attribute set + details event + metrics + api_request", () => {
    const h = harness();
    withSession(h);
    handleStepStarted(stepStarted, h.ctx);
    handleTextDelta(textDelta("the answer", 130), h.ctx);
    handleReasoningDelta(reasoningDelta("because", 131), h.ctx);
    handleStepEnded(stepEnded, h.ctx);

    const span = llmSpan(h.spans);
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.OK);

    expect(span.attributes[ATTR_INPUT_TOKENS]).toBe(120);
    expect(span.attributes[ATTR_OUTPUT_TOKENS]).toBe(40);
    expect(span.attributes[ATTR_REASONING_TOKENS]).toBe(7);
    expect(span.attributes[ATTR_CACHE_READ_TOKENS]).toBe(30);
    expect(span.attributes[ATTR_CACHE_CREATION_TOKENS]).toBe(11);
    expect(span.attributes[ATTR_DURATION_MS]).toBe(40);
    expect(span.attributes[ATTR_COST_USD]).toBe(0.02);
    expect(span.attributes["response_text"]).toBe("the answer");
    expect(span.attributes["output"]).toBe("the answer");
    expect(span.attributes["agentThinking"]).toBe("because");
    expect(span.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(120);
    expect(span.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(40);
    expect(span.attributes[GEN_AI_RESPONSE_MODEL]).toBe("claude-sonnet");
    expect(span.attributes[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
    expect(typeof span.attributes[GEN_AI_OUTPUT_MESSAGES]).toBe("string");
    expect(span.attributes[GEN_AI_OUTPUT_MESSAGES] as string).toContain("the answer");

    expect(span.events.map((e) => e.name)).toEqual([GEN_AI_EVENT_INFERENCE_DETAILS]);

    expect(h.metrics.some((m) => m.name === "gen_ai.client.operation.duration")).toBe(true);
    expect(h.metrics.some((m) => m.name === "gen_ai.client.token.usage")).toBe(true);
    expect(h.metrics.some((m) => m.name === "fredo.token.usage")).toBe(true);
    expect(h.metrics.some((m) => m.name === "fredo.cost.usage")).toBe(true);

    const record = h.logs.find((r) => r.body === LOG_API_REQUEST)!;
    expect(record.attributes?.["event.name"]).toBe(LOG_API_REQUEST);
    expect(record.attributes?.[ATTR_SESSION_ID]).toBe(SESSION);
    expect(record.attributes?.[ATTR_INPUT_TOKENS]).toBe(120);

    // Totals accumulated once, and the step's in-flight state is gone.
    const totals = h.ctx.sessionTotals.get(SESSION)!;
    expect(totals.tokens).toBe(120 + 40 + 7 + 30 + 11);
    expect(totals.cost).toBeCloseTo(0.02, 10);
    expect(totals.messages).toBe(1);
    expect(totals.inferenceCalls).toBe(1);
    expect(h.ctx.messageSpans.size).toBe(0);
    expect(h.ctx.messageMeta.size).toBe(0);
  });

  test("counts a step exactly once — a duplicated terminal is inert", () => {
    const h = harness();
    withSession(h);
    handleStepStarted(stepStarted, h.ctx);
    handleStepEnded(stepEnded, h.ctx);
    const metricsAfterFirst = h.metrics.length;
    const logsAfterFirst = h.logs.length;
    const totalsAfterFirst = h.ctx.sessionTotals.get(SESSION)!.tokens;

    handleStepEnded(stepEnded, h.ctx);
    handleStepFailed(stepFailed, h.ctx);

    expect(h.metrics).toHaveLength(metricsAfterFirst);
    expect(h.logs).toHaveLength(logsAfterFirst);
    expect(h.ctx.sessionTotals.get(SESSION)!.tokens).toBe(totalsAfterFirst);
  });
});

// ── session.step.failed ─────────────────────────────────────────────────────

describe("session.step.failed", () => {
  test("closes the span ERROR with the exception event, error.type metrics and api_error", () => {
    const h = harness();
    withSession(h);
    handleStepStarted(stepStarted, h.ctx);
    handleTextDelta(textDelta("partial", 130), h.ctx);
    handleStepFailed(stepFailed, h.ctx);

    const span = llmSpan(h.spans);
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.ERROR);
    expect(span.status?.message).toContain("rate limited");
    expect(span.attributes["response_text"]).toBe("partial");

    const exceptionEvent = span.events.find((e) => e.name === GEN_AI_EVENT_EXCEPTION)!;
    expect(exceptionEvent).toBeDefined();
    expect(exceptionEvent.attributes["exception.type"]).toBe("APIError");
    expect(exceptionEvent.attributes["exception.message"]).toBe("rate limited");

    const duration = h.metrics.find((m) => m.name === "gen_ai.client.operation.duration")!;
    expect(duration.attributes["error.type"]).toBe("APIError");

    const record = h.logs.find((r) => r.body === LOG_API_ERROR)!;
    expect(record.attributes?.["event.name"]).toBe(LOG_API_ERROR);
    expect(record.attributes?.["error"]).toContain("rate limited");

    // A failed step still counts as one inference call (EARS-9).
    expect(h.ctx.sessionTotals.get(SESSION)!.inferenceCalls).toBe(1);
    expect(h.ctx.messageSpans.size).toBe(0);
  });

  test("a failed step that reports usage counts it exactly once", () => {
    const h = harness();
    withSession(h);
    handleStepStarted(stepStarted, h.ctx);
    handleStepFailed(
      {
        ...stepFailed,
        data: {
          ...stepFailed.data,
          cost: 0.01,
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
      h.ctx,
    );
    const totals = h.ctx.sessionTotals.get(SESSION)!;
    expect(totals.tokens).toBe(15);
    expect(totals.messages).toBe(1);
  });
});
