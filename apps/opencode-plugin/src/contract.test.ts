/**
 * contract.test.ts — ST-6: the frozen emission-contract snapshot (Spec #3197).
 *
 * WHY THIS FILE EXISTS
 * The real risk of the V1 → V2 port is not a compile error — it is a silently
 * dropped or renamed attribute/span/log/metric that the Rust ingest classifier
 * (`rtdb/attrs.rs`, byte-identical to `main`) then classifies to nothing and
 * drops. This test drives full synthetic sessions through the REAL dispatcher
 * (`handleV2Event`) and freezes the emitted surface: every span NAME, every span
 * STATUS, the exact attribute KEY SET per span family, the `event.name` log
 * bodies, and the metric names. A port drift fails a unit test instead of a live
 * round.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   · it asserts KEYS and NAMES, never free-form values (a value pin would be a
 *     second, drifting source of truth);
 *   · it encodes NO retired V1 EVENT name anywhere — a committed guard at the
 *     bottom of this file proves that absence against this file's own RAW bytes
 *     (comments included), with a non-vacuity control. `session.error` is NOT
 *     retired: it survives as a preserved LOG BODY and is referenced only through
 *     `LOG_SESSION_ERROR`;
 *   · it never hand-types a parallel vocabulary: span names, attribute keys, log
 *     bodies and metric names come from `telemetry-constants.ts` /
 *     `genai-conventions.ts` wherever a constant exists (the handful of flat
 *     Fredo keys those modules do not export are declared once in `FLAT` below,
 *     with the reason).
 *
 * The three driven scenarios, one conversation each, through `handleV2Event`:
 *   A. a PRIMARY session with two model turns (one OK, one FAILED), a successful
 *      shell tool call carrying a `git commit`, a FAILED tool call, a permission
 *      accept, and a clean execution end;
 *   B. an INTERRUPTED run (interrupted mid-turn with an OPEN LLM span and an OPEN
 *      tool span) — the sweep path that must close everything with ERROR;
 *   C. the RUN-MODE shape this host actually delivers (round-1 capture
 *      `ac1-events-r1.jsonl`: 48 events, `session.created` and `session.idle`
 *      both ABSENT) — the session is bootstrapped from its first prompt and must
 *      still carry both preserved bodies and its close-time totals (F-2/F-3).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import type { Attributes, SpanOptions, Tracer } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import { handleV2Event } from "./index";
import {
  ATTR_AGENT_TYPE,
  ATTR_CACHE_CREATION_TOKENS,
  ATTR_CACHE_READ_TOKENS,
  ATTR_COST_USD,
  ATTR_DURATION_MS,
  ATTR_INPUT_TOKENS,
  ATTR_IS_SUBAGENT,
  ATTR_MODEL,
  ATTR_OUTPUT_TOKENS,
  ATTR_PROMPT_LENGTH,
  ATTR_PROVIDER,
  ATTR_REASONING_TOKENS,
  ATTR_SESSION_ID,
  ATTR_TOOL_ERROR,
  ATTR_TOOL_NAME,
  ATTR_TOOL_RESULT_SIZE,
  ATTR_TOOL_SUCCESS,
  ATTR_TOTAL_COST,
  ATTR_TOTAL_MESSAGES,
  ATTR_TOTAL_TOKENS,
  DEFAULT_METRIC_PREFIX,
  LOG_API_ERROR,
  LOG_API_REQUEST,
  LOG_COMMIT,
  LOG_SESSION_CREATED,
  LOG_SESSION_ERROR,
  LOG_SESSION_IDLE,
  LOG_TOOL_DECISION,
  LOG_TOOL_RESULT,
  LOG_USER_PROMPT,
  METRIC_COST_USAGE,
  METRIC_SESSION_COUNT,
  METRIC_TOKEN_USAGE,
  METRIC_TOOL_DURATION,
  SPAN_LLM,
  SPAN_PREFIX,
  SPAN_SESSION,
  SPAN_TOOL_PREFIX,
} from "./telemetry-constants";
import {
  ATTR_OP_NAME,
  GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_EVENT_INFERENCE_DETAILS,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  OP_NAME_CHAT,
  OP_NAME_SESSION,
  OP_NAME_TOOL,
} from "./genai-conventions";
import type { HandlerContext, Instruments, V2Event, V2EventOf } from "./types";

// ── Flat Fredo keys that telemetry-constants.ts does not export ─────────────
//
// These are V1 FLAT span-attribute keys the classifier and the adapter read
// (`docs/telemetry-reference.md`); `telemetry-constants.ts` exports only the
// subset the handlers import, so the remainder are named ONCE here instead of
// being repeated as bare strings inside the snapshot. They are deliberately NOT
// `gen_ai.*` and must never be "cleaned up" into the registry namespace.
const FLAT = {
  agent: "agent",
  prompt: "prompt",
  output: "output",
  responseText: "response_text",
  agentThinking: "agentThinking",
  toolInput: "tool_input",
  toolCallId: "tool_call_id",
  error: "error",
} as const;

// ── gen_ai.* metric names (declared in otel.ts:115-176; no constant exists) ──

const GEN_AI_METRICS = {
  operationDuration: "gen_ai.client.operation.duration",
  tokenUsage: "gen_ai.client.token.usage",
  executeToolDuration: "gen_ai.execute_tool.duration",
  invokeAgentDuration: "gen_ai.invoke_agent.duration",
  timeToFirstChunk: "gen_ai.client.operation.time_to_first_chunk",
  timePerOutputChunk: "gen_ai.client.operation.time_per_output_chunk",
  inferenceCalls: "gen_ai.invoke_agent.inference_calls",
  toolCalls: "gen_ai.invoke_agent.tool_calls",
} as const;

/** The `gen_ai.operation.name` value set the classifier accepts (R-3.1). */
const ACCEPTED_OP_NAMES: readonly string[] = [OP_NAME_SESSION, OP_NAME_CHAT, OP_NAME_TOOL];

/** The registry's CURRENT provider key — the legacy `gen_ai.system` is emitted never. */
const RETIRED_SYSTEM_KEY = "gen_ai.system";

// ── Recording harness: every emission seam is captured, nothing is mocked away ──

type RecordedSpan = {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  events: string[];
  ended: boolean;
};

type MetricRecord = { name: string; value: number; attributes: Attributes };

type Harness = {
  ctx: HandlerContext;
  spans: RecordedSpan[];
  logs: LogRecord[];
  metrics: MetricRecord[];
};

function harness(): Harness {
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
        addEvent: (eventName: string) => rec.events.push(eventName),
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
    sessionCounter: counter(`${DEFAULT_METRIC_PREFIX}${METRIC_SESSION_COUNT}`),
    tokenCounter: counter(`${DEFAULT_METRIC_PREFIX}${METRIC_TOKEN_USAGE}`),
    costCounter: counter(`${DEFAULT_METRIC_PREFIX}${METRIC_COST_USAGE}`),
    toolDurationHistogram: histogram(`${DEFAULT_METRIC_PREFIX}${METRIC_TOOL_DURATION}`),
    genAiOperationDuration: histogram(GEN_AI_METRICS.operationDuration),
    genAiTokenUsage: histogram(GEN_AI_METRICS.tokenUsage),
    genAiExecuteToolDuration: histogram(GEN_AI_METRICS.executeToolDuration),
    genAiInvokeAgentDuration: histogram(GEN_AI_METRICS.invokeAgentDuration),
    genAiTimeToFirstChunk: histogram(GEN_AI_METRICS.timeToFirstChunk),
    genAiTimePerOutputChunk: histogram(GEN_AI_METRICS.timePerOutputChunk),
    genAiInferenceCalls: histogram(GEN_AI_METRICS.inferenceCalls),
    genAiToolCalls: histogram(GEN_AI_METRICS.toolCalls),
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

// ── Typed event literals (shapes checked against the installed typings) ──────
//
// Every literal is typed through `V2EventOf<…>`, i.e. the V2 union the pinned
// package ships — a payload-shape drift is a compile error, never a silent miss.
// These are the AUTHORS' payload builders for this scenario, not a captured
// fixture: the committed capture corpus (`fixtures/v2-events.ts`) is empty until
// the tester's live external session lands, and this test must not depend on it.

const durable = { aggregateID: "agg", seq: 1, version: 1 } as const;
const durable2 = { aggregateID: "agg", seq: 2, version: 1 } as const;
/** Tool terminals are durable v2 in the V2 union (`SessionToolSuccess/Failed`). */
const durableToolTerminal = { aggregateID: "agg", seq: 3, version: 2 } as const;
const SESSION = "ses_contract";
const MESSAGE_1 = "msg_turn_1";
const MESSAGE_2 = "msg_turn_2";
const CALL_SHELL = "call-shell";
const CALL_FAILED = "call-failed";

const created: V2EventOf<"session.created"> = {
  id: "evt-created",
  created: 1_000,
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

const inboxEnqueued: V2EventOf<"session.inbox.enqueued"> = {
  id: "evt-inbox",
  created: 1_010,
  type: "session.inbox.enqueued",
  durable,
  data: {
    sessionID: SESSION,
    inboxID: "msg_user",
    item: { type: "user", payload: { text: "make a commit" }, delivery: "queue" },
  },
};

function stepStarted(messageID: string, created: number): V2EventOf<"session.step.started"> {
  return {
    id: `evt-step-started-${messageID}`,
    created,
    type: "session.step.started",
    durable,
    data: {
      sessionID: SESSION,
      assistantMessageID: messageID,
      agent: "build",
      model: { id: "claude-sonnet", providerID: "anthropic" },
      started: created,
    },
  };
}

const textDelta: V2EventOf<"session.text.delta"> = {
  id: "evt-text-delta",
  created: 1_030,
  type: "session.text.delta",
  data: { sessionID: SESSION, assistantMessageID: MESSAGE_1, ordinal: 0, delta: "committed" },
};

const stepEnded: V2EventOf<"session.step.ended"> = {
  id: "evt-step-ended",
  created: 1_100,
  type: "session.step.ended",
  durable: durable2,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE_1,
    finish: "stop",
    cost: 0.01,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  },
};

const stepFailed: V2EventOf<"session.step.failed"> = {
  id: "evt-step-failed",
  created: 1_200,
  type: "session.step.failed",
  durable: durable2,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE_2,
    error: { type: "APIError", message: "upstream boom" },
  },
};

function toolInputStarted(
  id: string,
  name: string,
  sessionID = SESSION,
): V2EventOf<"session.tool.input.started"> {
  return {
    id: `evt-input-started-${id}`,
    created: 1_120,
    type: "session.tool.input.started",
    durable,
    data: { sessionID, assistantMessageID: MESSAGE_1, id, name },
  };
}

function toolCalled(
  id: string,
  input: Record<string, any>,
  created = 1_130,
  sessionID = SESSION,
): V2EventOf<"session.tool.called"> {
  return {
    id: `evt-called-${id}`,
    created,
    type: "session.tool.called",
    durable,
    data: { sessionID, assistantMessageID: MESSAGE_1, id, input, executed: true },
  };
}

const toolSuccess: V2EventOf<"session.tool.success"> = {
  id: "evt-success",
  created: 1_150,
  type: "session.tool.success",
  durable: durableToolTerminal,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE_1,
    id: CALL_SHELL,
    content: [{ type: "text", text: "committed" }],
    executed: true,
  },
};

const toolFailed: V2EventOf<"session.tool.failed"> = {
  id: "evt-tool-failed",
  created: 1_250,
  type: "session.tool.failed",
  durable: durableToolTerminal,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE_1,
    id: CALL_FAILED,
    error: { type: "NotFound", message: "no such file" },
    executed: true,
  },
};

const permissionAsked: V2EventOf<"permission.asked"> = {
  id: "evt-perm-asked",
  created: 1_160,
  type: "permission.asked",
  data: { id: "perm-1", sessionID: SESSION, action: "bash", resources: ["git commit -m done"] },
};

const permissionReplied: V2EventOf<"permission.replied"> = {
  id: "evt-perm-replied",
  created: 1_180,
  type: "permission.replied",
  data: { sessionID: SESSION, requestID: "perm-1", reply: "always" },
};

const executionSucceeded: V2EventOf<"session.execution.succeeded"> = {
  id: "evt-exec-succeeded",
  created: 1_300,
  type: "session.execution.succeeded",
  durable: durable2,
  data: { sessionID: SESSION },
};

/** Scenario A — the full primary session, in delivery order. */
const PRIMARY_SESSION: V2Event[] = [
  created,
  inboxEnqueued,
  stepStarted(MESSAGE_1, 1_020),
  textDelta,
  stepEnded,
  toolInputStarted(CALL_SHELL, "bash"),
  toolCalled(CALL_SHELL, { command: "git add . && git commit -m done" }),
  toolSuccess,
  stepStarted(MESSAGE_2, 1_190),
  stepFailed,
  toolInputStarted(CALL_FAILED, "read"),
  toolCalled(CALL_FAILED, { path: "missing.txt" }, 1_240),
  toolFailed,
  permissionAsked,
  permissionReplied,
  executionSucceeded,
];

// ── Scenario B — the interrupted run ────────────────────────────────────────

const INTERRUPTED = "ses_interrupted";

const interruptedCreated: V2EventOf<"session.created"> = {
  ...created,
  id: "evt-int-created",
  created: 2_000,
  data: { ...created.data, sessionID: INTERRUPTED, slug: INTERRUPTED },
};

const interruptedInbox: V2EventOf<"session.inbox.enqueued"> = {
  ...inboxEnqueued,
  id: "evt-int-inbox",
  created: 2_010,
  data: {
    ...inboxEnqueued.data,
    sessionID: INTERRUPTED,
    inboxID: "msg_user_int",
    item: { type: "user", payload: { text: "wait for it" }, delivery: "queue" },
  },
};

const interruptedStep: V2EventOf<"session.step.started"> = {
  ...stepStarted(MESSAGE_1, 2_020),
  id: "evt-int-step",
  data: { ...stepStarted(MESSAGE_1, 2_020).data, sessionID: INTERRUPTED },
};

const interruptedToolCalled: V2EventOf<"session.tool.called"> = {
  ...toolCalled(CALL_SHELL, { command: "sleep 120" }, 2_030, INTERRUPTED),
  id: "evt-int-called",
};

const executionInterrupted: V2EventOf<"session.execution.interrupted"> = {
  id: "evt-int-interrupted",
  created: 2_100,
  type: "session.execution.interrupted",
  durable: durable2,
  data: { sessionID: INTERRUPTED, reason: "user" },
};

const INTERRUPTED_RUN: V2Event[] = [
  interruptedCreated,
  interruptedInbox,
  interruptedStep,
  toolInputStarted(CALL_SHELL, "bash", INTERRUPTED),
  interruptedToolCalled,
  executionInterrupted,
];

// ── Shape extraction ────────────────────────────────────────────────────────

function drive(events: readonly V2Event[]): Harness {
  const h = harness();
  for (const event of events) handleV2Event(event, h.ctx);
  return h;
}

/** Sorted attribute KEY list of a span — the frozen unit of the snapshot. */
function keysOf(span: RecordedSpan): string[] {
  return Object.keys(span.attributes).sort();
}

function bodyNames(logs: LogRecord[]): string[] {
  return logs
    .map((record) => record.attributes?.["event.name"])
    .filter((name): name is string => typeof name === "string")
    .sort();
}

function metricNames(metrics: MetricRecord[]): string[] {
  return [...new Set(metrics.map((m) => m.name))].sort();
}

function spanNamed(h: Harness, name: string): RecordedSpan {
  const match = h.spans.filter((span) => span.name === name);
  if (match.length !== 1) {
    throw new Error(`expected exactly one ${name} span, found ${match.length}`);
  }
  return match[0]!;
}

// ── Scenario A — the frozen snapshot ────────────────────────────────────────

describe("contract A: full primary session", () => {
  const h = drive(PRIMARY_SESSION);

  test("the span NAME sequence is frozen (and honest about the tool suffix)", () => {
    expect(h.spans.map((span) => span.name)).toEqual([
      SPAN_SESSION,
      SPAN_LLM,
      `${SPAN_TOOL_PREFIX}bash`,
      SPAN_LLM,
      `${SPAN_TOOL_PREFIX}read`,
    ]);
    // Every span name is one the contract stub validates.
    expect(h.spans.every((span) => span.name.startsWith(SPAN_PREFIX))).toBe(true);
    // No `fredo.commit` span exists — the commit signal is a LOG body only.
    expect(h.spans.some((span) => span.name === `${SPAN_PREFIX}${LOG_COMMIT}`)).toBe(false);
  });

  test("every span carries its V1 STATUS", () => {
    expect(h.spans.map((span) => span.status?.code)).toEqual([
      SpanStatusCode.OK, // fredo.session — closed OK
      SpanStatusCode.OK, // fredo.llm — completed step
      SpanStatusCode.OK, // fredo.tool.bash — success
      SpanStatusCode.ERROR, // fredo.llm — failed step
      SpanStatusCode.ERROR, // fredo.tool.read — failed call
    ]);
    expect(h.spans.every((span) => span.ended)).toBe(true);
  });

  test("fredo.session carries the exact frozen attribute KEY set", () => {
    expect(keysOf(spanNamed(h, SPAN_SESSION))).toEqual(
      [
        FLAT.agent,
        ATTR_AGENT_TYPE,
        GEN_AI_AGENT_NAME,
        GEN_AI_CONVERSATION_ID,
        GEN_AI_INPUT_MESSAGES,
        ATTR_OP_NAME,
        ATTR_IS_SUBAGENT,
        ATTR_MODEL,
        FLAT.prompt,
        ATTR_SESSION_ID,
        ATTR_TOTAL_COST,
        ATTR_TOTAL_MESSAGES,
        ATTR_TOTAL_TOKENS,
      ].sort(),
    );
  });

  test("the completed fredo.llm span carries the exact frozen attribute KEY set", () => {
    const completed = h.spans.filter((span) => span.name === SPAN_LLM)[0]!;
    expect(keysOf(completed)).toEqual(
      [
        FLAT.agent,
        ATTR_AGENT_TYPE,
        ATTR_CACHE_CREATION_TOKENS,
        ATTR_CACHE_READ_TOKENS,
        ATTR_COST_USD,
        ATTR_DURATION_MS,
        GEN_AI_CONVERSATION_ID,
        GEN_AI_INPUT_MESSAGES,
        ATTR_OP_NAME,
        GEN_AI_OUTPUT_MESSAGES,
        GEN_AI_PROVIDER_NAME,
        GEN_AI_REQUEST_MODEL,
        GEN_AI_RESPONSE_FINISH_REASONS,
        GEN_AI_RESPONSE_MODEL,
        GEN_AI_USAGE_INPUT_TOKENS,
        GEN_AI_USAGE_OUTPUT_TOKENS,
        ATTR_INPUT_TOKENS,
        ATTR_MODEL,
        FLAT.output,
        ATTR_OUTPUT_TOKENS,
        FLAT.prompt,
        ATTR_PROVIDER,
        ATTR_REASONING_TOKENS,
        FLAT.responseText,
        ATTR_SESSION_ID,
      ].sort(),
    );
    // Zero token counts are OMITTED, never emitted as a placeholder.
    expect(keysOf(completed)).not.toContain(GEN_AI_USAGE_REASONING_OUTPUT_TOKENS);
    expect(keysOf(completed)).not.toContain(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS);
    expect(keysOf(completed)).not.toContain(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS);
  });

  test("the failed fredo.llm span carries the exact frozen attribute KEY set", () => {
    const failed = h.spans.filter((span) => span.name === SPAN_LLM)[1]!;
    expect(keysOf(failed)).toEqual(
      [
        FLAT.agent,
        ATTR_AGENT_TYPE,
        ATTR_DURATION_MS,
        GEN_AI_CONVERSATION_ID,
        GEN_AI_INPUT_MESSAGES,
        ATTR_OP_NAME,
        GEN_AI_PROVIDER_NAME,
        GEN_AI_REQUEST_MODEL,
        ATTR_MODEL,
        FLAT.prompt,
        ATTR_PROVIDER,
        ATTR_SESSION_ID,
      ].sort(),
    );
  });

  test("the successful tool span carries the exact frozen attribute KEY set", () => {
    expect(keysOf(spanNamed(h, `${SPAN_TOOL_PREFIX}bash`))).toEqual(
      [
        FLAT.agent,
        ATTR_AGENT_TYPE,
        ATTR_DURATION_MS,
        GEN_AI_AGENT_NAME,
        GEN_AI_CONVERSATION_ID,
        ATTR_OP_NAME,
        GEN_AI_TOOL_CALL_ARGUMENTS,
        GEN_AI_TOOL_CALL_ID,
        GEN_AI_TOOL_CALL_RESULT,
        GEN_AI_TOOL_NAME,
        ATTR_SESSION_ID,
        ATTR_TOOL_RESULT_SIZE,
        ATTR_TOOL_SUCCESS,
        FLAT.toolCallId,
        FLAT.toolInput,
        ATTR_TOOL_NAME,
      ].sort(),
    );
  });

  test("the failed tool span carries the exact frozen attribute KEY set", () => {
    expect(keysOf(spanNamed(h, `${SPAN_TOOL_PREFIX}read`))).toEqual(
      [
        FLAT.agent,
        ATTR_AGENT_TYPE,
        ATTR_DURATION_MS,
        GEN_AI_AGENT_NAME,
        GEN_AI_CONVERSATION_ID,
        ATTR_OP_NAME,
        GEN_AI_TOOL_CALL_ARGUMENTS,
        GEN_AI_TOOL_CALL_ID,
        GEN_AI_TOOL_NAME,
        ATTR_SESSION_ID,
        ATTR_TOOL_ERROR,
        ATTR_TOOL_SUCCESS,
        FLAT.toolCallId,
        FLAT.toolInput,
        ATTR_TOOL_NAME,
      ].sort(),
    );
    // A failed call has no result attribute — the absence is part of the contract.
    expect(keysOf(spanNamed(h, `${SPAN_TOOL_PREFIX}read`))).not.toContain(GEN_AI_TOOL_CALL_RESULT);
  });

  test("the preserved LOG BODIES are exactly the V1 set", () => {
    expect(bodyNames(h.logs)).toEqual(
      [
        LOG_API_ERROR,
        LOG_API_REQUEST,
        LOG_COMMIT,
        LOG_SESSION_CREATED,
        LOG_SESSION_IDLE,
        LOG_TOOL_DECISION,
        LOG_TOOL_RESULT,
        LOG_TOOL_RESULT,
        LOG_USER_PROMPT,
      ].sort(),
    );
  });

  test("every log record names its body in `event.name` (never only in `body`)", () => {
    for (const record of h.logs) {
      expect(typeof record.attributes?.["event.name"]).toBe("string");
      expect(record.attributes?.["event.name"]).toBe(record.body);
    }
  });

  test("the METRIC names are exactly the frozen set", () => {
    expect(metricNames(h.metrics)).toEqual(
      [
        `${DEFAULT_METRIC_PREFIX}${METRIC_COST_USAGE}`,
        `${DEFAULT_METRIC_PREFIX}${METRIC_SESSION_COUNT}`,
        `${DEFAULT_METRIC_PREFIX}${METRIC_TOKEN_USAGE}`,
        `${DEFAULT_METRIC_PREFIX}${METRIC_TOOL_DURATION}`,
        GEN_AI_METRICS.operationDuration,
        GEN_AI_METRICS.timeToFirstChunk,
        GEN_AI_METRICS.tokenUsage,
        GEN_AI_METRICS.executeToolDuration,
        GEN_AI_METRICS.invokeAgentDuration,
        GEN_AI_METRICS.inferenceCalls,
        GEN_AI_METRICS.toolCalls,
      ].sort(),
    );
  });

  test("the registry span EVENTS are attached to the right spans", () => {
    const completed = h.spans.filter((span) => span.name === SPAN_LLM)[0]!;
    expect(completed.events).toContain(GEN_AI_EVENT_INFERENCE_DETAILS);
    expect(h.spans.filter((span) => span.name === SPAN_LLM)[1]!.events).toContain(
      GEN_AI_EVENT_EXCEPTION,
    );
    expect(spanNamed(h, `${SPAN_TOOL_PREFIX}read`).events).toContain(GEN_AI_EVENT_EXCEPTION);
    expect(spanNamed(h, `${SPAN_TOOL_PREFIX}bash`).events).toEqual([]);
  });

  test("the log-record attribute keys are the frozen V1 set per body", () => {
    const apiRequest = h.logs.find((record) => record.body === LOG_API_REQUEST)!;
    expect(Object.keys(apiRequest.attributes ?? {}).sort()).toEqual(
      [
        "event.name",
        ATTR_SESSION_ID,
        ATTR_MODEL,
        ATTR_PROVIDER,
        FLAT.agent,
        "agent.name",
        ATTR_AGENT_TYPE,
        ATTR_COST_USD,
        ATTR_DURATION_MS,
        ATTR_INPUT_TOKENS,
        ATTR_OUTPUT_TOKENS,
        ATTR_REASONING_TOKENS,
        ATTR_CACHE_READ_TOKENS,
        ATTR_CACHE_CREATION_TOKENS,
      ].sort(),
    );

    const commit = h.logs.find((record) => record.body === LOG_COMMIT)!;
    expect(Object.keys(commit.attributes ?? {}).sort()).toEqual(
      ["event.name", ATTR_SESSION_ID, FLAT.agent, "agent.name", ATTR_AGENT_TYPE].sort(),
    );

    const decision = h.logs.find((record) => record.body === LOG_TOOL_DECISION)!;
    expect(Object.keys(decision.attributes ?? {}).sort()).toEqual(
      [
        "event.name",
        ATTR_SESSION_ID,
        ATTR_TOOL_NAME,
        "tool_type",
        "decision",
        "source",
        FLAT.agent,
        "agent.name",
        ATTR_AGENT_TYPE,
      ].sort(),
    );

    const prompt = h.logs.find((record) => record.body === LOG_USER_PROMPT)!;
    expect(Object.keys(prompt.attributes ?? {}).sort()).toEqual(
      [
        "event.name",
        ATTR_SESSION_ID,
        FLAT.agent,
        "agent.name",
        ATTR_AGENT_TYPE,
        ATTR_PROMPT_LENGTH,
        ATTR_MODEL,
      ].sort(),
    );
  });
});

// ── Scenario B — the interrupted run ────────────────────────────────────────

describe("contract B: interrupted run", () => {
  const h = drive(INTERRUPTED_RUN);

  test("the interruption closes every span of the session with ERROR (R-4.2)", () => {
    expect(h.spans.map((span) => span.name)).toEqual([
      SPAN_SESSION,
      SPAN_LLM,
      `${SPAN_TOOL_PREFIX}bash`,
    ]);
    expect(h.spans.map((span) => span.status?.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
    // Nothing may be left open or pending — an orphaned span never exports.
    expect(h.spans.every((span) => span.ended)).toBe(true);
    expect(h.ctx.sessionSpans.size).toBe(0);
    expect(h.ctx.messageSpans.size).toBe(0);
    expect(h.ctx.pendingToolSpans.size).toBe(0);
    expect(h.ctx.pendingToolInputs.size).toBe(0);
  });

  test("the session span's status_message names the interruption", () => {
    expect(spanNamed(h, SPAN_SESSION).status?.message).toContain("interrupted: user");
  });

  test("an interruption emits the session.error log body and never session.idle", () => {
    expect(bodyNames(h.logs)).toEqual(
      [LOG_SESSION_CREATED, LOG_USER_PROMPT, LOG_SESSION_ERROR].sort(),
    );
    expect(h.logs.some((record) => record.body === LOG_SESSION_IDLE)).toBe(false);
    // The shell command was `sleep 120`, never a commit.
    expect(h.logs.some((record) => record.body === LOG_COMMIT)).toBe(false);
  });

  test("the interrupted run's span attribute keys are the frozen A sets", () => {
    // Same emitters, same key sets: only the status differs on the open spans.
    expect(keysOf(spanNamed(h, SPAN_SESSION))).toEqual(
      [
        FLAT.agent,
        ATTR_AGENT_TYPE,
        GEN_AI_AGENT_NAME,
        GEN_AI_CONVERSATION_ID,
        GEN_AI_INPUT_MESSAGES,
        ATTR_OP_NAME,
        ATTR_IS_SUBAGENT,
        ATTR_MODEL,
        FLAT.prompt,
        ATTR_SESSION_ID,
        ATTR_TOTAL_COST,
        ATTR_TOTAL_MESSAGES,
        ATTR_TOTAL_TOKENS,
        FLAT.error,
      ].sort(),
    );
  });
});

// ── Scenario C — the run-mode shape (no `session.created`, no `session.idle`) ──
//
// Scenario C is the shape the V2 host really delivers: `ac1-events-r1.jsonl`
// holds 48 events and contains NO `session.created` and NO `session.idle`. The
// session is therefore registered by its first PROMPT and closed by
// `session.execution.succeeded`. This is the discrimination pin for F-2/F-3: if a
// later live round shows `session.created` / `session.idle` absent again, the
// cause is wire loss, not a handler gap.

const RUN = "ses_run_mode";
const RUN_MESSAGE = "msg_run_turn";
const RUN_CALL = "call-run-read";

const runInbox: V2EventOf<"session.inbox.enqueued"> = {
  id: "evt-run-inbox",
  created: 3_010,
  type: "session.inbox.enqueued",
  durable,
  data: {
    sessionID: RUN,
    inboxID: "msg_run_user",
    item: { type: "user", payload: { text: "read the file" }, delivery: "queue" },
  },
};

const runStepStarted: V2EventOf<"session.step.started"> = {
  id: "evt-run-step-started",
  created: 3_020,
  type: "session.step.started",
  durable,
  data: {
    sessionID: RUN,
    assistantMessageID: RUN_MESSAGE,
    agent: "build",
    model: { id: "claude-sonnet", providerID: "anthropic" },
    started: 3_020,
  },
};

const runStepEnded: V2EventOf<"session.step.ended"> = {
  id: "evt-run-step-ended",
  created: 3_100,
  type: "session.step.ended",
  durable: durable2,
  data: {
    sessionID: RUN,
    assistantMessageID: RUN_MESSAGE,
    finish: "tool-calls",
    cost: 0.01,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  },
};

const runToolInputStarted: V2EventOf<"session.tool.input.started"> = {
  id: "evt-run-input-started",
  created: 3_110,
  type: "session.tool.input.started",
  durable,
  data: { sessionID: RUN, assistantMessageID: RUN_MESSAGE, id: RUN_CALL, name: "read" },
};

const runToolCalled: V2EventOf<"session.tool.called"> = {
  id: "evt-run-called",
  created: 3_120,
  type: "session.tool.called",
  durable,
  data: {
    sessionID: RUN,
    assistantMessageID: RUN_MESSAGE,
    id: RUN_CALL,
    input: { path: "a.ts" },
    executed: true,
  },
};

const runToolSuccess: V2EventOf<"session.tool.success"> = {
  id: "evt-run-success",
  created: 3_140,
  type: "session.tool.success",
  durable: durableToolTerminal,
  data: {
    sessionID: RUN,
    assistantMessageID: RUN_MESSAGE,
    id: RUN_CALL,
    content: [{ type: "text", text: "ok" }],
    executed: true,
  },
};

const runExecutionSucceeded: V2EventOf<"session.execution.succeeded"> = {
  id: "evt-run-succeeded",
  created: 3_200,
  type: "session.execution.succeeded",
  durable: durable2,
  data: { sessionID: RUN },
};

/** Scenario C — the run-mode delivery order (`session.created` never arrives). */
const RUN_MODE_SESSION: V2Event[] = [
  runInbox,
  runStepStarted,
  runStepEnded,
  runToolInputStarted,
  runToolCalled,
  runToolSuccess,
  runExecutionSucceeded,
];

describe("contract C: run-mode session (no session.created, no session.idle)", () => {
  const h = drive(RUN_MODE_SESSION);

  test("both preserved bodies the store was missing are emitted exactly once", () => {
    expect(bodyNames(h.logs)).toEqual(
      [
        LOG_SESSION_CREATED,
        LOG_USER_PROMPT,
        LOG_API_REQUEST,
        LOG_TOOL_RESULT,
        LOG_SESSION_IDLE,
      ].sort(),
    );
  });

  test("the bootstrap registers the session exactly once (one body, one count)", () => {
    // 7 events, 6 of them `session.*`: the registration must not repeat.
    expect(h.logs.filter((record) => record.body === LOG_SESSION_CREATED)).toHaveLength(1);
    expect(
      h.metrics.filter((m) => m.name === `${DEFAULT_METRIC_PREFIX}${METRIC_SESSION_COUNT}`),
    ).toHaveLength(1);
  });

  test("the session span keeps the frozen A key set and carries the close-time totals", () => {
    const session = spanNamed(h, SPAN_SESSION);
    expect(keysOf(session)).toEqual(
      [
        FLAT.agent,
        ATTR_AGENT_TYPE,
        GEN_AI_AGENT_NAME,
        GEN_AI_CONVERSATION_ID,
        GEN_AI_INPUT_MESSAGES,
        ATTR_OP_NAME,
        ATTR_IS_SUBAGENT,
        ATTR_MODEL,
        FLAT.prompt,
        ATTR_SESSION_ID,
        ATTR_TOTAL_COST,
        ATTR_TOTAL_MESSAGES,
        ATTR_TOTAL_TOKENS,
      ].sort(),
    );
    // The values the round-1 store could not produce for a run-mode session.
    expect(session.attributes[ATTR_MODEL]).toBe("anthropic/claude-sonnet");
    expect(session.attributes[ATTR_TOTAL_TOKENS]).toBe(15);
    expect(session.attributes[ATTR_TOTAL_COST]).toBe(0.01);
    expect(session.attributes[ATTR_TOTAL_MESSAGES]).toBe(1);
    expect(session.attributes[ATTR_OP_NAME]).toBe(OP_NAME_SESSION);
    expect(session.status?.code).toBe(SpanStatusCode.OK);
    expect(session.ended).toBe(true);
  });

  test("one span per session, and every span of the run is closed", () => {
    expect(h.spans.map((span) => span.name)).toEqual([
      SPAN_SESSION,
      SPAN_LLM,
      `${SPAN_TOOL_PREFIX}read`,
    ]);
    expect(h.spans.every((span) => span.ended)).toBe(true);
    expect(h.ctx.sessionSpans.size).toBe(0);
    expect(h.ctx.sessionTotals.size).toBe(0);
  });
});

// ── The classification contract (R-3.1) ────────────────────────────────────
describe("classification contract", () => {
  const h = drive(PRIMARY_SESSION);

  test("every emitted span carries an accepted gen_ai.operation.name", () => {
    for (const span of h.spans) {
      const op = span.attributes[ATTR_OP_NAME];
      expect(typeof op).toBe("string");
      expect(ACCEPTED_OP_NAMES).toContain(op as string);
    }
    // …and the family-to-op mapping is exact, not merely "accepted".
    expect(spanNamed(h, SPAN_SESSION).attributes[ATTR_OP_NAME]).toBe(OP_NAME_SESSION);
    for (const span of h.spans.filter((s) => s.name === SPAN_LLM)) {
      expect(span.attributes[ATTR_OP_NAME]).toBe(OP_NAME_CHAT);
    }
    for (const span of h.spans.filter((s) => s.name.startsWith(SPAN_TOOL_PREFIX))) {
      expect(span.attributes[ATTR_OP_NAME]).toBe(OP_NAME_TOOL);
    }
  });

  test("no emitted record ever carries the retired gen_ai.system key", () => {
    const carriers: { where: string; attributes: Record<string, unknown> }[] = [
      ...h.spans.map((span) => ({ where: `span ${span.name}`, attributes: span.attributes })),
      ...h.logs.map((record) => ({
        where: `log ${String(record.body)}`,
        attributes: (record.attributes ?? {}) as Record<string, unknown>,
      })),
      ...h.metrics.map((metric) => ({
        where: `metric ${metric.name}`,
        attributes: metric.attributes as Record<string, unknown>,
      })),
    ];
    for (const carrier of carriers) {
      expect(Object.keys(carrier.attributes)).not.toContain(RETIRED_SYSTEM_KEY);
    }
    // Non-vacuity: the scan would see the key if it were there.
    expect(Object.keys({ [RETIRED_SYSTEM_KEY]: "anthropic" })).toContain(RETIRED_SYSTEM_KEY);
  });
});

// ── The committed absence guard: this file encodes no retired V1 event name ──

const RETIRED_V1_EVENTS: readonly string[] = [
  ["chat", "message"].join("."),
  ["message", "updated"].join("."),
  ["message", "part", "updated"].join("."),
  ["command", "executed"].join("."),
  ["permission", "updated"].join("."),
];

function retiredHits(text: string): string[] {
  return RETIRED_V1_EVENTS.filter((token) => text.includes(token));
}

describe("no retired V1 event name is encoded in this snapshot", () => {
  test("this file's own RAW bytes (comments included) contain zero retired tokens", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(source.length).toBeGreaterThan(0);
    expect(retiredHits(source)).toEqual([]);
  });

  test("the guard is not vacuous: a seeded hit is caught, a clean string is not", () => {
    const seeded = ["const e = { type: ", JSON.stringify(["chat", "message"].join(".")), " };"].join(
      "",
    );
    expect(retiredHits(seeded)).toEqual([["chat", "message"].join(".")]);
    expect(retiredHits(LOG_SESSION_CREATED)).toEqual([]);
    // `session.error` survives as a preserved LOG BODY — it is NOT in the ban list.
    expect(retiredHits(LOG_SESSION_ERROR)).toEqual([]);
  });
});
