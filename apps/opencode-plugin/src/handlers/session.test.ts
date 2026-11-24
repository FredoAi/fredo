/**
 * handlers/session.test.ts — ST-2 session lifecycle emission contract (Spec #3197).
 *
 * Pins, per event, what the Rust ingest classifier depends on:
 *   · `session.created` → `session.created` log body + `fredo.session.count`
 *     metric (+ a `fredo.session` span with the child→parent link for a child);
 *   · `session.inbox.enqueued` → `user_prompt` log body + the turn-root
 *     `fredo.session` span with the R-1.1 attribute set;
 *   · `session.execution.succeeded|failed|interrupted` → the closed session span
 *     (status + `status_message`), the session metrics, and the
 *     `session.idle` / `session.error` log bodies;
 *   · the `sweepSession` invariant: an interruption closes every open tool/LLM
 *     span of the session (R-4.2) and a span is `.end()`ed BEFORE its map entry
 *     is dropped.
 *
 * Every payload literal is typed against `V2EventOf<…>` (derived from the pinned
 * package typings), so a shape drift is a compile error here, not a silent miss.
 */

import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import type { Attributes, SpanOptions, Tracer } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import {
  handleSessionCreated,
  handleSessionInboxEnqueued,
  handleSessionIdle,
  handleExecutionFailed,
  handleExecutionInterrupted,
  handleExecutionSucceeded,
  resolveParentSessionId,
  routingParentSessionId,
} from "./session";
import { handleStepStarted, handleStepEnded } from "./message";
import { handleToolCalled, handleToolInputStarted } from "./tool";
import { handleV2Event } from "../index";
import {
  ATTR_SESSION_ID,
  ATTR_AGENT_TYPE,
  ATTR_IS_SUBAGENT,
  ATTR_PARENT_SESSION_ID,
  ATTR_TOTAL_TOKENS,
  ATTR_TOTAL_COST,
  ATTR_TOTAL_MESSAGES,
  ATTR_PROMPT_LENGTH,
  ATTR_MODEL,
  LOG_SESSION_CREATED,
  LOG_SESSION_IDLE,
  LOG_SESSION_ERROR,
  LOG_USER_PROMPT,
} from "../telemetry-constants";
import {
  ATTR_OP_NAME,
  EXCEPTION_MESSAGE,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_EVENT_EXCEPTION,
  GEN_AI_INPUT_MESSAGES,
  OP_NAME_SESSION,
  LINK_ATTR_PARENT_SESSION_ID,
  LINK_ATTR_RELATIONSHIP_TYPE,
  RELATIONSHIP_TYPE_PARENT_CHILD,
} from "../genai-conventions";
import type { HandlerContext, Instruments, V2EventOf } from "../types";

// ── Recording harness: every emission seam is captured, not mocked away ──────

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
  flushes: () => number;
} {
  const spans: RecordedSpan[] = [];
  const logs: LogRecord[] = [];
  const metrics: MetricRecord[] = [];
  const state = { flushes: 0 };

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
    onExporterFlush: () => {
      state.flushes += 1;
    },
  } as unknown as HandlerContext;

  return {
    ctx,
    spans,
    logs,
    metrics,
    flushes: () => state.flushes,
  };
}

// ── Typed event literals ────────────────────────────────────────────────────

const durable = { aggregateID: "agg", seq: 1, version: 1 } as const;
const SESSION = "ses_parent";
const CHILD = "ses_child";

function sessionCreated(
  sessionID: string,
  created: number,
  extra: { parentID?: string; agent?: string } = {},
): V2EventOf<"session.created"> {
  return {
    id: `evt-created-${sessionID}`,
    created,
    type: "session.created",
    durable,
    data: {
      sessionID,
      projectID: "prj",
      location: { directory: "/repo" },
      slug: sessionID,
      version: "2.4.1",
      model: { id: "claude-sonnet", providerID: "anthropic" },
      ...(extra.agent ? { agent: extra.agent } : {}),
      ...(extra.parentID ? { parentID: extra.parentID } : {}),
    },
  };
}

function inboxEnqueued(sessionID: string, created: number, text: string): V2EventOf<"session.inbox.enqueued"> {
  return {
    id: `evt-inbox-${sessionID}`,
    created,
    type: "session.inbox.enqueued",
    durable,
    data: {
      sessionID,
      inboxID: "msg_user",
      item: { type: "user", payload: { text }, delivery: "queue" },
    },
  };
}

function executionSucceeded(sessionID: string, created: number): V2EventOf<"session.execution.succeeded"> {
  return {
    id: `evt-ok-${sessionID}`,
    created,
    type: "session.execution.succeeded",
    durable,
    data: { sessionID },
  };
}

function executionFailed(sessionID: string, created: number): V2EventOf<"session.execution.failed"> {
  return {
    id: `evt-fail-${sessionID}`,
    created,
    type: "session.execution.failed",
    durable,
    data: { sessionID, error: { type: "APIError", message: "boom" } },
  };
}

function executionInterrupted(
  sessionID: string,
  created: number,
): V2EventOf<"session.execution.interrupted"> {
  return {
    id: `evt-int-${sessionID}`,
    created,
    type: "session.execution.interrupted",
    durable,
    data: { sessionID, reason: "user" },
  };
}

function idle(sessionID: string, created: number): V2EventOf<"session.idle"> {
  return { id: `evt-idle-${sessionID}`, created, type: "session.idle", data: { sessionID } };
}

/** A minimal completed step, used to attribute usage to the session totals. */
function stepStarted(sessionID: string, created: number): V2EventOf<"session.step.started"> {
  return {
    id: `evt-step-${sessionID}`,
    created,
    type: "session.step.started",
    durable,
    data: {
      sessionID,
      assistantMessageID: "msg_a",
      agent: "build",
      model: { id: "claude-sonnet", providerID: "anthropic" },
      started: created,
    },
  };
}

/** The step's terminal, carrying usage — the source of the session totals. */
function stepEnded(sessionID: string, created: number): V2EventOf<"session.step.ended"> {
  return {
    id: `evt-step-ended-${sessionID}`,
    created,
    type: "session.step.ended",
    durable,
    data: {
      sessionID,
      assistantMessageID: "msg_a",
      finish: "stop",
      cost: 0.01,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

function toolCalled(sessionID: string, created: number): V2EventOf<"session.tool.called"> {
  return {
    id: `evt-tool-${sessionID}`,
    created,
    type: "session.tool.called",
    durable,
    data: {
      sessionID,
      assistantMessageID: "msg_a",
      id: "call-1",
      input: { path: "a.ts" },
      executed: true,
    },
  };
}

/** The log body of a record (`event.name` mirror + body are both pinned). */
function bodies(logs: LogRecord[]): string[] {
  return logs.map((record) => String(record.body));
}

function logFor(logs: LogRecord[], body: string): LogRecord | undefined {
  return logs.find((record) => record.body === body);
}

// ── session.created ─────────────────────────────────────────────────────────

describe("session.created", () => {
  test("primary: logs session.created, counts the session, opens no span", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100, { agent: "build" }), h.ctx);

    expect(bodies(h.logs)).toEqual([LOG_SESSION_CREATED]);
    const record = logFor(h.logs, LOG_SESSION_CREATED)!;
    expect(record.attributes?.["event.name"]).toBe(LOG_SESSION_CREATED);
    expect(record.attributes?.[ATTR_SESSION_ID]).toBe(SESSION);
    expect(record.attributes?.[ATTR_IS_SUBAGENT]).toBe(false);
    expect(record.attributes?.["agent"]).toBe("build");
    expect(record.attributes?.["agent.type"]).toBe("primary");

    expect(h.metrics.map((m) => m.name)).toEqual(["fredo.session.count"]);
    expect(h.metrics[0]!.attributes[ATTR_SESSION_ID]).toBe(SESSION);
    expect(h.metrics[0]!.attributes[ATTR_IS_SUBAGENT]).toBe(false);

    expect(h.spans).toHaveLength(0);
    const totals = h.ctx.sessionTotals.get(SESSION)!;
    expect(totals.agentType).toBe("primary");
    expect(totals.parentId).toBeUndefined();
  });

  test("child: opens fredo.session with the R-1.4 attribute set and a child→parent link", () => {
    const h = harness();
    // The parent must have a live span for the LINK to resolve.
    handleSessionCreated(sessionCreated(SESSION, 100, { agent: "build" }), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "parent prompt"), h.ctx);
    expect(h.spans).toHaveLength(1);

    handleSessionCreated(sessionCreated(CHILD, 110, { parentID: SESSION }), h.ctx);

    const childSpan = h.spans[1]!;
    expect(childSpan.name).toBe("fredo.session");
    expect(childSpan.attributes[ATTR_OP_NAME]).toBe(OP_NAME_SESSION);
    expect(childSpan.attributes[GEN_AI_CONVERSATION_ID]).toBe(CHILD);
    expect(childSpan.attributes[ATTR_SESSION_ID]).toBe(CHILD);
    expect(childSpan.attributes[ATTR_PARENT_SESSION_ID]).toBe(SESSION);
    expect(childSpan.attributes[ATTR_AGENT_TYPE]).toBe("subagent");
    expect(childSpan.attributes[ATTR_IS_SUBAGENT]).toBe(true);

    const links = childSpan.options?.links ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]!.attributes?.[LINK_ATTR_PARENT_SESSION_ID]).toBe(SESSION);
    expect(links[0]!.attributes?.[LINK_ATTR_RELATIONSHIP_TYPE]).toBe(
      RELATIONSHIP_TYPE_PARENT_CHILD,
    );
  });

  test("child: FREDO_SUPPRESS_PARENT_ROUTING drops the parent attribute (legacy-shaped)", () => {
    const h = harness();
    h.ctx.suppressParentRouting = true;
    handleSessionCreated(sessionCreated(CHILD, 110, { parentID: SESSION }), h.ctx);
    const childSpan = h.spans[0]!;
    expect(childSpan.attributes[ATTR_PARENT_SESSION_ID]).toBeUndefined();
    // The role still says subagent — suppression only removes the self-carried
    // routing attribute; the event's own parentID is still recorded in totals.
    expect(childSpan.attributes[ATTR_IS_SUBAGENT]).toBe(true);
    expect(h.ctx.sessionTotals.get(CHILD)!.parentId).toBe(SESSION);
  });
});

// ── session.inbox.enqueued ──────────────────────────────────────────────────

describe("session.inbox.enqueued", () => {
  test("primary: user_prompt log + the R-1.1 turn-root span", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100, { agent: "build" }), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "hello marker"), h.ctx);

    const promptLog = logFor(h.logs, LOG_USER_PROMPT)!;
    expect(promptLog.attributes?.["event.name"]).toBe(LOG_USER_PROMPT);
    expect(promptLog.attributes?.[ATTR_SESSION_ID]).toBe(SESSION);
    expect(promptLog.attributes?.[ATTR_PROMPT_LENGTH]).toBe("hello marker".length);
    expect(promptLog.attributes?.[ATTR_MODEL]).toBe("anthropic/claude-sonnet");

    expect(h.spans).toHaveLength(1);
    const span = h.spans[0]!;
    expect(span.name).toBe("fredo.session");
    expect(span.attributes[ATTR_OP_NAME]).toBe(OP_NAME_SESSION);
    expect(span.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION);
    expect(span.attributes[ATTR_SESSION_ID]).toBe(SESSION);
    expect(span.attributes["agent"]).toBe("build");
    expect(span.attributes[ATTR_AGENT_TYPE]).toBe("primary");
    expect(span.attributes[ATTR_IS_SUBAGENT]).toBe(false);
    expect(span.attributes["prompt"]).toBe("hello marker");
    expect(span.attributes[ATTR_MODEL]).toBe("anthropic/claude-sonnet");
    // Content keys are JSON STRINGS, never object arrays.
    const inputMessages = span.attributes[GEN_AI_INPUT_MESSAGES];
    expect(typeof inputMessages).toBe("string");
    expect((JSON.parse(inputMessages as string) as { parts: { content: string }[] }[])[0]!.parts[0]!
      .content).toBe("hello marker");
  });

  test("a non-user inbox item emits nothing (never fabricate a prompt)", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    const before = h.logs.length;
    handleSessionInboxEnqueued(
      {
        id: "evt-compaction",
        created: 101,
        type: "session.inbox.enqueued",
        durable,
        data: {
          sessionID: SESSION,
          inboxID: "msg_c",
          item: { type: "compaction", payload: {}, delivery: "queue" },
        },
      },
      h.ctx,
    );
    expect(h.logs).toHaveLength(before);
    expect(h.spans).toHaveLength(0);
  });

  test("a second turn refreshes the SAME session span (one span per session)", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "first"), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 102, "second"), h.ctx);
    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]!.attributes["prompt"]).toBe("second");
  });
});

// ── session.execution.* ─────────────────────────────────────────────────────

describe("session.execution.succeeded", () => {
  test("closes the span OK with totals, records the session metrics once, logs session.idle", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100, { agent: "build" }), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "hi"), h.ctx);
    handleExecutionSucceeded(executionSucceeded(SESSION, 200), h.ctx);

    const span = h.spans[0]!;
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.OK);
    expect(span.attributes[ATTR_TOTAL_TOKENS]).toBe(0);
    expect(span.attributes[ATTR_TOTAL_COST]).toBe(0);
    expect(span.attributes[ATTR_TOTAL_MESSAGES]).toBe(0);

    const idleLog = logFor(h.logs, LOG_SESSION_IDLE)!;
    expect(idleLog.attributes?.["event.name"]).toBe(LOG_SESSION_IDLE);
    expect(idleLog.attributes?.[ATTR_SESSION_ID]).toBe(SESSION);

    expect(h.metrics.some((m) => m.name === "gen_ai.invoke_agent.duration")).toBe(true);
    expect(h.metrics.some((m) => m.name === "gen_ai.client.operation.duration")).toBe(true);
    // No zero placeholder rows: a session with no calls emits no count metrics.
    expect(h.metrics.some((m) => m.name === "gen_ai.invoke_agent.inference_calls")).toBe(false);
    expect(h.metrics.some((m) => m.name === "gen_ai.invoke_agent.tool_calls")).toBe(false);

    expect(h.ctx.sessionTotals.size).toBe(0);
    expect(h.ctx.sessionSpans.size).toBe(0);
  });

  test("a second close of the same session records nothing twice", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    handleExecutionSucceeded(executionSucceeded(SESSION, 200), h.ctx);
    const afterFirst = h.metrics.length;
    const logsAfterFirst = h.logs.length;
    handleExecutionSucceeded(executionSucceeded(SESSION, 201), h.ctx);
    handleSessionIdle(idle(SESSION, 202), h.ctx);
    expect(h.metrics).toHaveLength(afterFirst);
    expect(h.logs).toHaveLength(logsAfterFirst);
  });
});

describe("session.execution.failed", () => {
  test("closes the span ERROR with error/exception event and logs session.error", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100, { agent: "build" }), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "hi"), h.ctx);
    handleExecutionFailed(executionFailed(SESSION, 200), h.ctx);

    const span = h.spans[0]!;
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.ERROR);
    expect(span.status?.message).toContain("APIError");
    expect(span.attributes["error"]).toContain("APIError: boom");

    const exceptionEvent = span.events.find((e) => e.name === GEN_AI_EVENT_EXCEPTION);
    expect(exceptionEvent).toBeDefined();
    expect(exceptionEvent!.attributes["exception.type"]).toBe("APIError");
    expect(exceptionEvent!.attributes[EXCEPTION_MESSAGE]).toContain("boom");

    const errorLog = logFor(h.logs, LOG_SESSION_ERROR)!;
    expect(errorLog.attributes?.["event.name"]).toBe(LOG_SESSION_ERROR);
    expect(errorLog.attributes?.["error"]).toContain("boom");
    // The failed operation's duration carries error.type.
    const duration = h.metrics.find((m) => m.name === "gen_ai.invoke_agent.duration")!;
    expect(duration.attributes["error.type"]).toBe("APIError");
  });
});

describe("session.execution.interrupted (R-4.2)", () => {
  test("closes the session ERROR, sweeps every open tool/LLM span, logs the interruption", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100, { agent: "build" }), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "run it"), h.ctx);
    handleStepStarted(stepStarted(SESSION, 110), h.ctx);
    handleToolInputStarted(
      {
        id: "evt-tool-input",
        created: 115,
        type: "session.tool.input.started",
        durable,
        data: { sessionID: SESSION, assistantMessageID: "msg_a", id: "call-1", name: "read" },
      },
      h.ctx,
    );
    handleToolCalled(toolCalled(SESSION, 120), h.ctx);
    expect(h.ctx.messageSpans.size).toBe(1);
    expect(h.ctx.pendingToolSpans.size).toBe(1);

    handleExecutionInterrupted(executionInterrupted(SESSION, 200), h.ctx);

    const sessionSpan = h.spans.find((s) => s.name === "fredo.session")!;
    expect(sessionSpan.status?.code).toBe(SpanStatusCode.ERROR);
    expect(sessionSpan.status?.message).toContain("interrupted");
    expect(sessionSpan.status?.message).toContain("user");
    expect(sessionSpan.ended).toBe(true);

    const llmSpan = h.spans.find((s) => s.name === "fredo.llm")!;
    expect(llmSpan.ended).toBe(true);
    expect(llmSpan.status?.code).toBe(SpanStatusCode.ERROR);
    const toolSpan = h.spans.find((s) => s.name === "fredo.tool.read")!;
    expect(toolSpan.ended).toBe(true);
    expect(toolSpan.status?.code).toBe(SpanStatusCode.ERROR);

    // No orphan: every opened span is ended and no in-flight entry survives.
    expect(h.spans.every((s) => s.ended)).toBe(true);
    expect(h.ctx.messageSpans.size).toBe(0);
    expect(h.ctx.pendingToolSpans.size).toBe(0);
    expect(h.ctx.sessionSpans.size).toBe(0);

    const errorLog = logFor(h.logs, LOG_SESSION_ERROR)!;
    expect(errorLog.attributes?.["error"]).toContain("interrupted: user");
  });
});

// ── session.idle ────────────────────────────────────────────────────────────

describe("session.idle", () => {
  test("flushes the exporters and closes anything still open", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "hi"), h.ctx);
    handleSessionIdle(idle(SESSION, 200), h.ctx);

    expect(h.flushes()).toBe(1);
    expect(h.spans[0]!.ended).toBe(true);
    expect(h.spans[0]!.status?.code).toBe(SpanStatusCode.OK);
    // The idle path does not emit a second `session.idle` body for a session it
    // merely swept (execution.succeeded owns that log).
    expect(bodies(h.logs)).not.toContain(LOG_SESSION_IDLE);
  });

  test("a throwing flush seam never surfaces (NFR-1)", () => {
    const h = harness();
    h.ctx.onExporterFlush = () => {
      throw new Error("flush exploded");
    };
    expect(() => handleSessionIdle(idle(SESSION, 200), h.ctx)).not.toThrow();
  });
});

// ── F-2: the batch tail flushes on the events this host DELIVERS ────────────
//
// `session.idle` appears in no real capture (round-1 evidence: three captures,
// zero occurrences), so binding the flush to it lost the tail. These pins make
// the flush a property of the TERMINAL CLOSE, whichever terminal produced it.

describe("F-2: every terminal close flushes the exporters", () => {
  test("session.execution.succeeded flushes", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    handleSessionInboxEnqueued(inboxEnqueued(SESSION, 101, "hi"), h.ctx);
    expect(h.flushes()).toBe(0);
    handleExecutionSucceeded(executionSucceeded(SESSION, 200), h.ctx);
    expect(h.flushes()).toBe(1);
  });

  test("session.execution.failed flushes", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    handleExecutionFailed(executionFailed(SESSION, 200), h.ctx);
    expect(h.flushes()).toBe(1);
  });

  test("session.execution.interrupted flushes", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    handleExecutionInterrupted(executionInterrupted(SESSION, 200), h.ctx);
    expect(h.flushes()).toBe(1);
  });
});

// ── F-3: the run-mode shape (no `session.created` ever delivered) ────────────
//
// Discrimination step: these pin that BOTH preserved bodies and the close-time
// totals are produced from the events this host actually emits. If a live round
// still shows them absent, the cause is wire loss, not a handler gap.

describe("F-3: a session whose session.created never arrives", () => {
  test("registers exactly once, however many session events follow", () => {
    const h = harness();
    handleV2Event(stepStarted(SESSION, 110), h.ctx);
    handleV2Event(stepStarted(SESSION, 120), h.ctx);
    handleV2Event(inboxEnqueued(SESSION, 130, "later prompt"), h.ctx);

    expect(h.logs.filter((record) => record.body === LOG_SESSION_CREATED)).toHaveLength(1);
    expect(h.metrics.filter((m) => m.name === "fredo.session.count")).toHaveLength(1);
    expect(h.ctx.sessionTotals.get(SESSION)!.agent).toBe("build");
  });

  test("a session that already closed is not registered a second time", () => {
    const h = harness();
    handleV2Event(inboxEnqueued(SESSION, 101, "first"), h.ctx);
    handleV2Event(executionSucceeded(SESSION, 200), h.ctx);
    // A later turn of the SAME session (the interactive shape): the close
    // deleted the totals, so the registration guard is what keeps this to one
    // `session.created` body and one `fredo.session.count`.
    handleV2Event(inboxEnqueued(SESSION, 300, "second"), h.ctx);

    expect(h.logs.filter((record) => record.body === LOG_SESSION_CREATED)).toHaveLength(1);
    expect(h.metrics.filter((m) => m.name === "fredo.session.count")).toHaveLength(1);
    expect(h.flushes()).toBe(1);
  });

  test("inbox-first: the turn root carries the real model and the close totals", () => {
    const h = harness();
    // The live run-mode order: the prompt arrives BEFORE the first step.
    handleV2Event(inboxEnqueued(SESSION, 101, "hi"), h.ctx);
    handleV2Event(stepStarted(SESSION, 110), h.ctx);
    handleV2Event(stepEnded(SESSION, 160), h.ctx);
    handleV2Event(executionSucceeded(SESSION, 200), h.ctx);

    const span = h.spans.find((s) => s.name === "fredo.session")!;
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.OK);
    // `model` is unknown at creation (no `session.created`), repaired by the step.
    expect(span.attributes[ATTR_MODEL]).toBe("anthropic/claude-sonnet");
    expect(span.attributes[ATTR_TOTAL_TOKENS]).toBe(15);
    expect(span.attributes[ATTR_TOTAL_COST]).toBe(0.01);
    expect(span.attributes[ATTR_TOTAL_MESSAGES]).toBe(1);
    // Both preserved bodies the round-1 store was missing, from the events that
    // DO arrive — and exactly one of each.
    expect(bodies(h.logs).filter((body) => body === LOG_SESSION_CREATED)).toHaveLength(1);
    expect(bodies(h.logs).filter((body) => body === LOG_SESSION_IDLE)).toHaveLength(1);
    expect(bodies(h.logs)).not.toContain(LOG_SESSION_ERROR);
    // The tail is flushed at the terminal close, not by a `session.idle` event.
    expect(h.flushes()).toBe(1);
  });
});

// ── Parent resolution ───────────────────────────────────────────────────────
describe("resolveParentSessionId", () => {
  test("returns the direct V2 parentID (no scan needed)", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(CHILD, 110, { parentID: SESSION }), h.ctx);
    expect(resolveParentSessionId(CHILD, h.ctx)).toBe(SESSION);
  });

  test("falls back to the pending task scan with the temporal-origin guard", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    // A task dispatch that started BEFORE the child was created: valid parent.
    h.ctx.pendingToolSpans.set(`${SESSION}:call-task`, {
      tool: "task",
      sessionID: SESSION,
      startMs: 105,
    });
    handleSessionCreated(sessionCreated(CHILD, 110), h.ctx);

    expect(resolveParentSessionId(CHILD, h.ctx)).toBe(SESSION);
    // The role is promoted so the classifier sees a subagent (R-1.4).
    expect(h.ctx.sessionTotals.get(CHILD)!.agentType).toBe("subagent");
  });

  test("a dispatch that started AFTER the child's creation is not its parent", () => {
    const h = harness();
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    handleSessionCreated(sessionCreated(CHILD, 110), h.ctx);
    h.ctx.pendingToolSpans.set(`${SESSION}:call-task`, {
      tool: "task",
      sessionID: SESSION,
      startMs: 120,
    });
    expect(resolveParentSessionId(CHILD, h.ctx)).toBeUndefined();
  });

  test("never guesses for a session with no known creation time", () => {
    const h = harness();
    expect(resolveParentSessionId("ses_unknown", h.ctx)).toBeUndefined();
  });

  test("FREDO_SUPPRESS_PARENT_ROUTING disables the pending-task scan fallback", () => {
    const h = harness();
    h.ctx.suppressParentRouting = true;
    handleSessionCreated(sessionCreated(SESSION, 100), h.ctx);
    h.ctx.pendingToolSpans.set(`${SESSION}:call-task`, {
      tool: "task",
      sessionID: SESSION,
      startMs: 105,
    });
    // No `parentID` on the payload: the only parent source would be the scan,
    // which the seam suppresses at the origin (legacy-shaped child spans).
    handleSessionCreated(sessionCreated(CHILD, 110), h.ctx);
    expect(h.ctx.sessionTotals.get(CHILD)!.parentId).toBeUndefined();
    expect(routingParentSessionId(CHILD, h.ctx)).toBeUndefined();
  });
});
