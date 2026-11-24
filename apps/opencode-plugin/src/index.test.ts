/**
 * index.test.ts — the V2 entry point contract (Spec #3197 ST-1).
 *
 * Pins three things a later sub-task could silently break:
 *   1. the `FREDO_CAPTURE_EVENTS` lever writes one JSON line `{type, event}` per
 *      received event (default OFF, no other behaviour change);
 *   2. every handler skeleton emits NOTHING in ST-1 (no span, no log record, no
 *      metric, no diagnostic) — dispatch is wired, behaviour is not;
 *   3. the module shape is V2-ONLY: a plain `Plugin.define` object with
 *      `id`/`setup`, and no V1 hooks-object export (dual export is forbidden).
 *
 * Payload literals below are typed against `V2EventOf<…>`, which is derived from
 * the pinned package's shipped definitions — a payload-shape drift is a compile
 * error here, not a silent runtime miss.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONTEXT, type Counter, type Histogram, type Tracer } from "@opentelemetry/api";
import * as pluginModule from "./index";
import { handleV2Event } from "./index";
import { V2_EVENT_FIXTURES, fixtureOf } from "./fixtures/v2-events";
import type { HandlerContext, V2Event, V2EventOf } from "./types";

// ── A recording HandlerContext: every emission seam is a spy ──────────────────

function recordingContext(): { ctx: HandlerContext; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) =>
    (..._args: unknown[]): void => {
      calls.push(name);
    };
  const counter = { add: record("counter.add") } as unknown as Counter;
  const histogram = { record: record("histogram.record") } as unknown as Histogram;
  const fakeSpan = () => ({
    setAttributes: record("span.setAttributes"),
    setAttribute: record("span.setAttribute"),
    addEvent: record("span.addEvent"),
    setStatus: record("span.setStatus"),
    end: record("span.end"),
    spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 }),
  });
  const tracer = {
    startSpan: (..._args: unknown[]) => {
      calls.push("tracer.startSpan");
      return fakeSpan();
    },
    startActiveSpan: record("tracer.startActiveSpan"),
  } as unknown as Tracer;

  const ctx = {
    log: record("log"),
    emitLog: record("emitLog"),
    instruments: {
      sessionCounter: counter,
      tokenCounter: counter,
      costCounter: counter,
      toolDurationHistogram: histogram,
      genAiOperationDuration: histogram,
      genAiTokenUsage: histogram,
      genAiExecuteToolDuration: histogram,
      genAiInvokeAgentDuration: histogram,
      genAiTimeToFirstChunk: histogram,
      genAiTimePerOutputChunk: histogram,
      genAiInferenceCalls: histogram,
      genAiToolCalls: histogram,
    },
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
    onIdleFlush: record("otel.flush"),
  } as unknown as HandlerContext;

  return { ctx, calls };
}

// ── Typed event literals (shapes checked against the installed typings) ──────

const durable = { aggregateID: "agg-1", seq: 1, version: 1 } as const;
const durableV2 = { aggregateID: "agg-1", seq: 2, version: 2 } as const;
const sessionID = "ses_test";
const assistantMessageID = "msg_test";

const sessionCreated: V2EventOf<"session.created"> = {
  id: "evt-1",
  created: 1,
  type: "session.created",
  durable,
  data: {
    sessionID,
    projectID: "prj_test",
    location: { directory: "/repo" },
    slug: "ses_test",
    agent: "build",
    model: { id: "claude", providerID: "anthropic" },
    version: "2.4.1",
  },
};

const inboxEnqueued: V2EventOf<"session.inbox.enqueued"> = {
  id: "evt-1b",
  created: 1,
  type: "session.inbox.enqueued",
  durable,
  data: {
    sessionID,
    inboxID: "msg_user_1",
    item: { type: "user", payload: { text: "hello" }, delivery: "queue" },
  },
};

const executionStarted: V2EventOf<"session.execution.started"> = {
  id: "evt-2",
  created: 2,
  type: "session.execution.started",
  durable,
  data: { sessionID },
};

const executionSucceeded: V2EventOf<"session.execution.succeeded"> = {
  id: "evt-3",
  created: 3,
  type: "session.execution.succeeded",
  durable,
  data: { sessionID },
};

const executionFailed: V2EventOf<"session.execution.failed"> = {
  id: "evt-4",
  created: 4,
  type: "session.execution.failed",
  durable,
  data: { sessionID, error: { type: "APIError", message: "boom" } },
};

const executionInterrupted: V2EventOf<"session.execution.interrupted"> = {
  id: "evt-5",
  created: 5,
  type: "session.execution.interrupted",
  durable,
  data: { sessionID, reason: "user" },
};

const sessionIdle: V2EventOf<"session.idle"> = {
  id: "evt-6",
  created: 6,
  type: "session.idle",
  data: { sessionID },
};

const stepStarted: V2EventOf<"session.step.started"> = {
  id: "evt-7",
  created: 7,
  type: "session.step.started",
  durable,
  data: {
    sessionID,
    assistantMessageID,
    agent: "build",
    model: { id: "claude", providerID: "anthropic" },
    started: 7,
  },
};

const stepEnded: V2EventOf<"session.step.ended"> = {
  id: "evt-8",
  created: 8,
  type: "session.step.ended",
  durable,
  data: {
    sessionID,
    assistantMessageID,
    finish: "stop",
    cost: 0.01,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  },
};

const stepFailed: V2EventOf<"session.step.failed"> = {
  id: "evt-9",
  created: 9,
  type: "session.step.failed",
  durable,
  data: { sessionID, assistantMessageID, error: { type: "APIError", message: "boom" } },
};

const textDelta: V2EventOf<"session.text.delta"> = {
  id: "evt-10",
  created: 10,
  type: "session.text.delta",
  data: { sessionID, assistantMessageID, ordinal: 0, delta: "hi" },
};

const reasoningDelta: V2EventOf<"session.reasoning.delta"> = {
  id: "evt-11",
  created: 11,
  type: "session.reasoning.delta",
  data: { sessionID, assistantMessageID, ordinal: 0, delta: "thinking" },
};

const toolInputStarted: V2EventOf<"session.tool.input.started"> = {
  id: "evt-12",
  created: 12,
  type: "session.tool.input.started",
  durable,
  data: { sessionID, assistantMessageID, id: "call-1", name: "read" },
};

const toolInputDelta: V2EventOf<"session.tool.input.delta"> = {
  id: "evt-13",
  created: 13,
  type: "session.tool.input.delta",
  data: { sessionID, assistantMessageID, id: "call-1", delta: '{"path":' },
};

const toolInputEnded: V2EventOf<"session.tool.input.ended"> = {
  id: "evt-14",
  created: 14,
  type: "session.tool.input.ended",
  durable,
  data: { sessionID, assistantMessageID, id: "call-1", text: '{"path":"a.ts"}' },
};

const toolCalled: V2EventOf<"session.tool.called"> = {
  id: "evt-15",
  created: 15,
  type: "session.tool.called",
  durable,
  data: {
    sessionID,
    assistantMessageID,
    id: "call-1",
    input: { path: "a.ts" },
    executed: true,
  },
};

const toolProgress: V2EventOf<"session.tool.progress"> = {
  id: "evt-16",
  created: 16,
  type: "session.tool.progress",
  data: { sessionID, assistantMessageID, id: "call-1", metadata: {} },
};

const toolSuccess: V2EventOf<"session.tool.success"> = {
  id: "evt-17",
  created: 17,
  type: "session.tool.success",
  durable: durableV2,
  data: {
    sessionID,
    assistantMessageID,
    id: "call-1",
    content: [{ type: "text", text: "ok" }],
    executed: true,
  },
};

const toolFailed: V2EventOf<"session.tool.failed"> = {
  id: "evt-18",
  created: 18,
  type: "session.tool.failed",
  durable: durableV2,
  data: {
    sessionID,
    assistantMessageID,
    id: "call-1",
    error: { type: "NotFound", message: "no such file" },
    executed: true,
  },
};

const permissionAsked: V2EventOf<"permission.asked"> = {
  id: "evt-19",
  created: 19,
  type: "permission.asked",
  data: { id: "perm-1", sessionID, action: "tool.use", resources: ["read"] },
};

const permissionReplied: V2EventOf<"permission.replied"> = {
  id: "evt-20",
  created: 20,
  type: "permission.replied",
  data: { sessionID, requestID: "perm-1", reply: "once" },
};

/** A type we do NOT handle — the capture lever must still record it. */
const unhandledTextStarted: V2EventOf<"session.text.started"> = {
  id: "evt-21",
  created: 21,
  type: "session.text.started",
  durable,
  data: { sessionID, assistantMessageID, ordinal: 0 },
};

const handledEvents: V2Event[] = [
  sessionCreated,
  inboxEnqueued,
  executionStarted,
  executionSucceeded,
  executionFailed,
  executionInterrupted,
  sessionIdle,
  stepStarted,
  stepEnded,
  stepFailed,
  textDelta,
  reasoningDelta,
  toolInputStarted,
  toolInputDelta,
  toolInputEnded,
  toolCalled,
  toolProgress,
  toolSuccess,
  toolFailed,
  permissionAsked,
  permissionReplied,
];

// ── Capture lever ────────────────────────────────────────────────────────────

describe("FREDO_CAPTURE_EVENTS lever", () => {
  let dir: string;
  const original = process.env["FREDO_CAPTURE_EVENTS"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fredo-capture-"));
    delete process.env["FREDO_CAPTURE_EVENTS"];
  });

  afterEach(() => {
    if (original === undefined) delete process.env["FREDO_CAPTURE_EVENTS"];
    else process.env["FREDO_CAPTURE_EVENTS"] = original;
    rmSync(dir, { recursive: true, force: true });
  });

  test("is OFF by default: no file is created and dispatch still runs", () => {
    const { ctx, calls } = recordingContext();
    handleV2Event(sessionIdle, ctx);
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
    // Dispatch reached the handler: the idle path flushes and logs (ST-2).
    expect(calls).toContain("otel.flush");
  });

  test("writes one JSON line {type, event} per received event", () => {
    const target = join(dir, "events.jsonl");
    process.env["FREDO_CAPTURE_EVENTS"] = target;

    const { ctx } = recordingContext();
    handleV2Event(sessionCreated, ctx);
    handleV2Event(sessionIdle, ctx);

    const lines = readFileSync(target, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { type: string; event: V2Event };
    expect(first.type).toBe("session.created");
    expect(first.event).toEqual(sessionCreated as unknown as V2Event);
    const second = JSON.parse(lines[1]!) as { type: string; event: V2Event };
    expect(second.type).toBe("session.idle");
    expect(second.event).toEqual(sessionIdle as unknown as V2Event);
  });

  test("captures UNHANDLED event types too (the Phase-0 payload corpus)", () => {
    const target = join(dir, "events.jsonl");
    process.env["FREDO_CAPTURE_EVENTS"] = target;

    const { ctx } = recordingContext();
    handleV2Event(unhandledTextStarted, ctx);

    const lines = readFileSync(target, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { type: string }).type).toBe("session.text.started");
  });

  test("appends across calls rather than truncating the capture", () => {
    const target = join(dir, "events.jsonl");
    process.env["FREDO_CAPTURE_EVENTS"] = target;

    const { ctx } = recordingContext();
    handleV2Event(sessionIdle, ctx);
    handleV2Event(unhandledTextStarted, ctx);
    handleV2Event(sessionIdle, ctx);

    expect(readFileSync(target, "utf8").trimEnd().split("\n")).toHaveLength(3);
  });
});

// ── Dispatch wiring (ST-1 skeleton invariant, superseded by ST-2/ST-3/ST-4) ──
//
// ST-1 pinned "every handler skeleton emits nothing". ST-2/ST-3/ST-4 implement
// the session, model-turn and tool handlers, so that pin now asserts the INVERSE
// for those families — while the ST-5 skeletons (permissions, git-commit
// activity) must still emit nothing. Both directions are pinned so a handler
// that is wired but inert (or a stub that silently starts emitting) fails here.

describe("dispatch wiring (ST-2/ST-3/ST-4 implemented, ST-5 still stubs)", () => {
  test("a full session lifecycle leaves no in-flight state behind", () => {
    const { ctx } = recordingContext();
    for (const event of handledEvents) {
      handleV2Event(event, ctx);
    }
    // A real session settles with an idle; the sweep must clear everything.
    handleV2Event(sessionIdle, ctx);

    expect(ctx.pendingToolSpans.size).toBe(0);
    expect(ctx.pendingToolInputs.size).toBe(0);
    expect(ctx.sessionSpans.size).toBe(0);
    expect(ctx.messageSpans.size).toBe(0);
    expect(ctx.messageMeta.size).toBe(0);
    expect(ctx.messageOutputs.size).toBe(0);
    expect(ctx.messageThinking.size).toBe(0);
    expect(ctx.sessionTotals.size).toBe(0);
    expect(ctx.pendingPermissions.size).toBe(0);
  });

  test("ST-5 handler skeletons still emit nothing", () => {
    const { ctx, calls } = recordingContext();
    handleV2Event(permissionAsked, ctx);
    handleV2Event(permissionReplied, ctx);
    expect(calls).toEqual([]);
    expect(ctx.pendingPermissions.size).toBe(0);
  });

  test("the implemented families do emit — the wiring is live, not inert", () => {
    const { ctx, calls } = recordingContext();
    handleV2Event(sessionCreated, ctx);
    handleV2Event(sessionIdle, ctx);
    expect(calls).toContain("emitLog");
    expect(calls).toContain("counter.add");
  });
});

// ── Module shape: V2 only, no dual export ────────────────────────────────────

describe("module shape (R-2.1)", () => {
  test("PLUGIN_ID is the registered plugin id", () => {
    expect(pluginModule.PLUGIN_ID).toBe("fredo");
  });

  test("the default export is the Plugin.define result (id + setup)", () => {
    const definition = pluginModule.default as unknown as {
      id?: string;
      setup?: unknown;
    };
    expect(typeof definition).toBe("object");
    expect(definition.id).toBe("fredo");
    expect(typeof definition.setup).toBe("function");
    expect(pluginModule.default).toBe(pluginModule.fredoPluginDefinition);
  });

  test("exactly the V2 surface is exported — no V1 hooks object", () => {
    expect(Object.keys(pluginModule).sort()).toEqual([
      "PLUGIN_ID",
      "default",
      "fredoPluginDefinition",
      "handleV2Event",
    ]);
    const definition = pluginModule.default as unknown as Record<string, unknown>;
    expect(definition["hooks"]).toBeUndefined();
    expect(definition["event"]).toBeUndefined();
    expect(definition["server"]).toBeUndefined();
    expect(definition["chat.message"]).toBeUndefined();
    expect(typeof pluginModule.default).not.toBe("function");
  });
});

// ── Fixture model ────────────────────────────────────────────────────────────

describe("fixtures/v2-events model", () => {
  test("the committed fixture set is a typed array (may legitimately be empty)", () => {
    expect(Array.isArray(V2_EVENT_FIXTURES)).toBe(true);
  });

  test("fixtureOf throws for an absent fixture — never a silent skip", () => {
    expect(() => fixtureOf("session.idle")).toThrow(/No V2 event fixture for "session\.idle"/);
  });
});
