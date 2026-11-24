/**
 * handlers/permission.test.ts — ST-5 permission emission contract (Spec #3197).
 *
 * Pins the V1 `tool_decision` log-body contract (R-3.2/R-4.4) on the V2 events:
 *   · `permission.asked` → remembered only (no emission at all);
 *   · `permission.replied` → ONE `tool_decision` log record carrying `event.name`,
 *     `session.id`, `tool_name`, `tool_type`, `decision`, `source` and the agent
 *     attrs — and nothing else (no span, no metric);
 *   · the decision mapping both ways (accept vs reject), with the V1
 *     `allow`/`allowAlways` vocabulary preserved alongside the V2 replies.
 *
 * Every payload literal is typed against `V2EventOf<…>` (derived from the pinned
 * package typings), so a shape drift is a compile error here, not a silent miss.
 */

import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import { handlePermissionAsked, handlePermissionReplied } from "./permission";
import {
  ATTR_SESSION_ID,
  ATTR_TOOL_NAME,
  LOG_TOOL_DECISION,
} from "../telemetry-constants";
import type { HandlerContext, Instruments, SessionTotals, V2EventOf } from "../types";

// ── Recording harness ───────────────────────────────────────────────────────

type MetricRecord = { name: string; value: number; attributes: Record<string, unknown> };

function harness(): { ctx: HandlerContext; logs: LogRecord[]; spans: string[]; metrics: MetricRecord[] } {
  const logs: LogRecord[] = [];
  const spans: string[] = [];
  const metrics: MetricRecord[] = [];

  const counter = (name: string) => ({
    add: (value: number, attributes?: Record<string, unknown>) =>
      metrics.push({ name, value, attributes: attributes ?? {} }),
  });
  const histogram = (name: string) => ({
    record: (value: number, attributes?: Record<string, unknown>) =>
      metrics.push({ name, value, attributes: attributes ?? {} }),
  });

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
    // A permission handler must never open a span: any call here is a defect.
    tracer: {
      startSpan: (name: string) => {
        spans.push(name);
        throw new Error("a permission handler must not start a span");
      },
    },
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

  return { ctx, logs, spans, metrics };
}

// ── Typed event literals ────────────────────────────────────────────────────

const SESSION = "ses_perm";

/** A session's registered identity is what supplies the agent attrs on the log. */
function withSession(ctx: HandlerContext): void {
  const totals: SessionTotals = {
    startMs: 1,
    tokens: 0,
    cost: 0,
    messages: 0,
    agent: "build",
    agentType: "primary",
    inferenceCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
  };
  ctx.sessionTotals.set(SESSION, totals);
}

const asked: V2EventOf<"permission.asked"> = {
  id: "evt-asked",
  created: 100,
  type: "permission.asked",
  data: {
    id: "perm-1",
    sessionID: SESSION,
    action: "bash",
    resources: ["git commit -m done"],
  },
};

function replied(reply: "once" | "always" | "reject"): V2EventOf<"permission.replied"> {
  return {
    id: `evt-replied-${reply}`,
    created: 200,
    type: "permission.replied",
    data: { sessionID: SESSION, requestID: "perm-1", reply },
  };
}

function decisionLog(logs: LogRecord[]): LogRecord {
  const record = logs.find((r) => r.body === LOG_TOOL_DECISION);
  if (!record) throw new Error("no tool_decision log record was emitted");
  return record;
}

// ── permission.asked ────────────────────────────────────────────────────────

describe("permission.asked", () => {
  test("remembers the pending ask and emits nothing", () => {
    const h = harness();
    withSession(h.ctx);

    handlePermissionAsked(asked, h.ctx);

    // Remembered with the V2 mapping: `action` → type, `resources` → title.
    expect(h.ctx.pendingPermissions.get("perm-1")).toEqual({
      type: "bash",
      title: "git commit -m done",
      sessionID: SESSION,
    });
    expect(h.logs).toHaveLength(0);
    expect(h.spans).toHaveLength(0);
    expect(h.metrics).toHaveLength(0);
  });

  test("falls back to the request message, then the action, never a placeholder", () => {
    const h = harness();
    withSession(h.ctx);
    handlePermissionAsked(
      { ...asked, data: { ...asked.data, id: "perm-2", resources: [], message: "Allow edit?" } },
      h.ctx,
    );
    expect(h.ctx.pendingPermissions.get("perm-2")?.title).toBe("Allow edit?");

    handlePermissionAsked(
      { ...asked, data: { ...asked.data, id: "perm-3", resources: [] } },
      h.ctx,
    );
    expect(h.ctx.pendingPermissions.get("perm-3")?.title).toBe("bash");
  });
});

// ── permission.replied ──────────────────────────────────────────────────────

describe("permission.replied", () => {
  test("emits ONE tool_decision record with the V1 attribute set", () => {
    const h = harness();
    withSession(h.ctx);
    handlePermissionAsked(asked, h.ctx);
    handlePermissionReplied(replied("once"), h.ctx);

    const record = decisionLog(h.logs);
    expect(h.logs).toHaveLength(1);
    expect(record.attributes?.["event.name"]).toBe(LOG_TOOL_DECISION);
    expect(record.attributes?.[ATTR_SESSION_ID]).toBe(SESSION);
    expect(record.attributes?.[ATTR_TOOL_NAME]).toBe("git commit -m done");
    expect(record.attributes?.["tool_type"]).toBe("bash");
    expect(record.attributes?.["decision"]).toBe("accept");
    expect(record.attributes?.["source"]).toBe("once");
    // Agent attrs (agentAttrs) — the same triple every other log body carries.
    expect(record.attributes?.["agent"]).toBe("build");
    expect(record.attributes?.["agent.name"]).toBe("build");
    expect(record.attributes?.["agent.type"]).toBe("primary");
    expect(record.severityText).toBe("INFO");

    // The pending ask is consumed, and nothing else was emitted.
    expect(h.ctx.pendingPermissions.size).toBe(0);
    expect(h.spans).toHaveLength(0);
    expect(h.metrics).toHaveLength(0);
  });

  test("maps the V2 replies once/always → accept and reject → reject", () => {
    for (const [reply, decision] of [
      ["once", "accept"],
      ["always", "accept"],
      ["reject", "reject"],
    ] as const) {
      const h = harness();
      withSession(h.ctx);
      handlePermissionAsked(asked, h.ctx);
      handlePermissionReplied(replied(reply), h.ctx);
      const record = decisionLog(h.logs);
      expect(record.attributes?.["decision"]).toBe(decision);
      // `source` is the raw reply verbatim — never normalised.
      expect(record.attributes?.["source"]).toBe(reply);
    }
  });

  test("preserves the V1 allow/allowAlways → accept mapping", () => {
    for (const [reply, decision] of [
      ["allow", "accept"],
      ["allowAlways", "accept"],
      ["reject", "reject"],
      ["somethingElse", "reject"],
    ] as const) {
      const h = harness();
      withSession(h.ctx);
      handlePermissionAsked(asked, h.ctx);
      handlePermissionReplied(
        { ...replied("once"), data: { sessionID: SESSION, requestID: "perm-1", reply: reply as "once" } },
        h.ctx,
      );
      expect(decisionLog(h.logs).attributes?.["decision"]).toBe(decision);
    }
  });

  test("a reply for an unknown ask still records the decision, never a fabricated tool", () => {
    const h = harness();
    withSession(h.ctx);
    handlePermissionReplied(replied("once"), h.ctx);

    const record = decisionLog(h.logs);
    expect(record.attributes?.[ATTR_TOOL_NAME]).toBe("unknown");
    expect(record.attributes?.["tool_type"]).toBe("unknown");
    expect(record.attributes?.["decision"]).toBe("accept");
  });
});
