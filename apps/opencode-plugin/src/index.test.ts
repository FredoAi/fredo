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
import { MAX_SESSION_CLAIMS, SESSION_OWNER_KEY, claimSession } from "./util";
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
    registeredSessions: new Set(),
    suppressParentRouting: false,
    onExporterFlush: record("otel.flush"),
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

// ── Dispatch wiring (ST-1 skeleton invariant, superseded by ST-2 … ST-5) ────
//
// ST-1 pinned "every handler skeleton emits nothing". ST-2/ST-3/ST-4/ST-5
// implement the session, model-turn, tool, permission and activity handlers, so
// that pin now asserts the INVERSE for every family — a handler that is wired but
// inert (or a stub that silently starts emitting) fails here.

describe("dispatch wiring (ST-2 … ST-5 implemented)", () => {
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

  test("the ST-5 permission path is live: the ask is remembered, the reply emits", () => {
    const { ctx, calls } = recordingContext();
    handleV2Event(permissionAsked, ctx);
    expect(ctx.pendingPermissions.size).toBe(1);
    handleV2Event(permissionReplied, ctx);
    // The pending ask is consumed and the `tool_decision` log record is emitted.
    expect(calls).toContain("emitLog");
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

// ── ST-9: ONE emitting plugin instance per session (round-3 duplication fix) ──
//
// Round 2 measured the defect: the shared `opencode serve --service` host loaded
// `fredo.js` FIVE times in one run, and a three-turn session produced 55 spans /
// 15 traces with `chat_rows=25`, because every instance subscribed to the whole
// event stream and derived its own copy of every span. Round 2 made each instance
// own its providers (F-1) — which is right — so the duplication can only be
// stopped at the dispatch seam.
//
// These pins drive the REAL dispatch path (`handleV2Event`) TWICE against the one
// `globalThis`-anchored claim registry, which is exactly the shape the host
// produces: two module evaluations, one process. Every session id below is unique
// to this block so no pin depends on another's claims (suite-order independent).

const CLAIM_DUP_SESSION = "ses_claim_dup_3197";
const CLAIM_OTHER_SESSION = "ses_claim_other_3197";
const CLAIM_PAIR_SESSION = "ses_claim_pair_3197";
const CLAIM_CAPTURE_SESSION = "ses_claim_capture_3197";

function claimInputStarted(
  sessionID: string,
  callID: string,
): V2EventOf<"session.tool.input.started"> {
  return {
    id: `evt-claim-input-${sessionID}-${callID}`,
    created: 500,
    type: "session.tool.input.started",
    durable,
    data: { sessionID, assistantMessageID: `msg-${callID}`, id: callID, name: "read" },
  };
}

function claimToolCalled(sessionID: string, callID: string): V2EventOf<"session.tool.called"> {
  return {
    id: `evt-claim-called-${sessionID}-${callID}`,
    created: 510,
    type: "session.tool.called",
    durable,
    data: {
      sessionID,
      assistantMessageID: `msg-${callID}`,
      id: callID,
      input: { path: "a.ts" },
      executed: true,
    },
  };
}

function claimToolSuccess(sessionID: string, callID: string): V2EventOf<"session.tool.success"> {
  return {
    id: `evt-claim-success-${sessionID}-${callID}`,
    created: 520,
    type: "session.tool.success",
    durable: durableV2,
    data: {
      sessionID,
      assistantMessageID: `msg-${callID}`,
      id: callID,
      content: [{ type: "text", text: "ok" }],
      executed: true,
    },
  };
}

/** One logical tool call — start, call, terminal — for `sessionID`. */
function claimSessionEvents(sessionID: string, callID: string): V2Event[] {
  return [
    claimInputStarted(sessionID, callID),
    claimToolCalled(sessionID, callID),
    claimToolSuccess(sessionID, callID),
  ];
}

/** How many spans this recording context saw opened. */
function spansStarted(calls: readonly string[]): number {
  return calls.filter((call) => call === "tracer.startSpan").length;
}

describe("per-session emission claim (ST-9)", () => {
  test("the FIRST instance to observe a session emits; a second sharing the process emits NOTHING", () => {
    const first = recordingContext();
    const second = recordingContext();

    for (const event of claimSessionEvents(CLAIM_DUP_SESSION, "call-dup")) {
      handleV2Event(event, first.ctx, "instance-A");
    }
    for (const event of claimSessionEvents(CLAIM_DUP_SESSION, "call-dup")) {
      handleV2Event(event, second.ctx, "instance-B");
    }

    // A: exactly ONE span for the one logical tool call, closed, with its bodies.
    expect(spansStarted(first.calls)).toBe(1);
    expect(first.calls.filter((call) => call === "span.end")).toHaveLength(1);
    expect(first.calls).toContain("emitLog");
    // B: NO handler ran at all — no span, no log, no metric, not even a diagnostic.
    // (Round 2: this was a second full copy of every span.)
    expect(second.calls).toEqual([]);
  });

  test("non-vacuity: a DIFFERENT session first observed by the second instance IS emitted by it", () => {
    const second = recordingContext();

    for (const event of claimSessionEvents(CLAIM_OTHER_SESSION, "call-other")) {
      handleV2Event(event, second.ctx, "instance-B");
    }

    // The guard suppresses DUPLICATES, not clients: an unclaimed session is the
    // second instance's to emit.
    expect(spansStarted(second.calls)).toBe(1);
    expect(second.calls).toContain("span.end");
    expect(second.calls).toContain("emitLog");
  });

  test("a session's start/end PAIRING stays on one instance (the span closes, never an orphan)", () => {
    const first = recordingContext();
    const second = recordingContext();

    for (const event of claimSessionEvents(CLAIM_PAIR_SESSION, "call-pair")) {
      handleV2Event(event, first.ctx, "instance-A");
      // The same durable event broadcast to the second instance must not touch
      // the pair — a copy would open its own span and could never close it.
      handleV2Event(event, second.ctx, "instance-B");
    }

    expect(spansStarted(first.calls)).toBe(1);
    expect(first.calls.filter((call) => call === "span.end")).toHaveLength(1);
    expect(second.calls).toEqual([]);
  });

  test("a non-owner instance writes no capture line either — it is fully inert", () => {
    const dir = mkdtempSync(join(tmpdir(), "fredo-claim-capture-"));
    const target = join(dir, "events.jsonl");
    const originalCapture = process.env["FREDO_CAPTURE_EVENTS"];
    process.env["FREDO_CAPTURE_EVENTS"] = target;
    try {
      const first = recordingContext();
      const second = recordingContext();
      for (const event of claimSessionEvents(CLAIM_CAPTURE_SESSION, "call-capture")) {
        handleV2Event(event, first.ctx, "instance-A");
      }
      for (const event of claimSessionEvents(CLAIM_CAPTURE_SESSION, "call-capture")) {
        handleV2Event(event, second.ctx, "instance-B");
      }

      const lines = readFileSync(target, "utf8").trimEnd().split("\n");
      // Three events, three lines — NOT six. Round 2's shape would be 5N lines.
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        const parsed = JSON.parse(line) as { event: { data?: { sessionID?: string } } };
        expect(parsed.event.data?.sessionID).toBe(CLAIM_CAPTURE_SESSION);
      }
    } finally {
      if (originalCapture === undefined) delete process.env["FREDO_CAPTURE_EVENTS"];
      else process.env["FREDO_CAPTURE_EVENTS"] = originalCapture;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claim registry: bounded, globalThis-anchored (NFR-5)", () => {
  test("the anchor is `Symbol.for(\"fredo.plugin.sessionOwner\")` on globalThis, not module scope", () => {
    // Module scope is re-evaluated per client — which is WHY five instances
    // existed. The registry must therefore live on the process-wide global.
    expect(SESSION_OWNER_KEY).toBe(Symbol.for("fredo.plugin.sessionOwner"));

    const probe = "ses_claim_anchor_3197";
    expect(claimSession(probe, "instance-A")).toBe(true);

    const holder = globalThis as unknown as Record<
      symbol,
      { owners: Map<string, string> } | undefined
    >;
    const registry = holder[SESSION_OWNER_KEY]?.owners;
    expect(registry).toBeInstanceOf(Map);
    expect(registry?.get(probe)).toBe("instance-A");
    // A second instance reading the SAME anchor sees the first one's claim.
    expect(claimSession(probe, "instance-B")).toBe(false);
    expect(claimSession(probe, "instance-A")).toBe(true);
  });

  test("oldest-first eviction, LRU refresh, and an evicted key is re-claimable", () => {
    const registry = new Map<string, string>();

    for (let i = 0; i < 5; i += 1) expect(claimSession(`key-${i}`, "instance-A", registry, 3)).toBe(true);
    expect(registry.size).toBe(3);
    expect(registry.has("key-0")).toBe(false);
    expect(registry.has("key-1")).toBe(false);
    expect(registry.has("key-4")).toBe(true);

    // An evicted session is re-claimable by whoever observes it next.
    expect(claimSession("key-0", "instance-B", registry, 3)).toBe(true);

    // A still-active session refreshes its recency, so it is not the first out.
    const lru = new Map<string, string>();
    claimSession("active", "instance-A", lru, 2);
    claimSession("idle", "instance-A", lru, 2);
    claimSession("active", "instance-A", lru, 2); // refresh
    claimSession("fresh", "instance-A", lru, 2); // evicts "idle", not "active"
    expect(lru.has("active")).toBe(true);
    expect(lru.has("idle")).toBe(false);
    expect(lru.size).toBe(2);

    // A foreign instance never takes an existing claim.
    expect(claimSession("active", "instance-B", lru, 2)).toBe(false);
    expect(lru.get("active")).toBe("instance-A");
  });

  test("the DEFAULT cap is MAX_SESSION_CLAIMS — a long-lived host cannot grow it without bound", () => {
    expect(MAX_SESSION_CLAIMS).toBe(10_000);

    const registry = new Map<string, string>();
    for (let i = 0; i < MAX_SESSION_CLAIMS; i += 1) claimSession(`s-${i}`, "instance-A", registry);
    expect(registry.size).toBe(MAX_SESSION_CLAIMS);

    claimSession("s-overflow", "instance-A", registry);
    expect(registry.size).toBe(MAX_SESSION_CLAIMS);
    expect(registry.has("s-0")).toBe(false);
    expect(registry.has("s-overflow")).toBe(true);
  });
});
