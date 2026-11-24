/**
 * handlers/activity.test.ts — ST-5 git-commit signal contract (Spec #3197).
 *
 * V2 has no `command.executed`, so R-3.3's commit signal is derived from the tool
 * lifecycle. Pins:
 *   · a shell-tool call whose input carries `git commit` emits EXACTLY ONE
 *     `commit` log record (`event.name=commit`, `session.id`, agent attrs);
 *   · a non-commit shell command emits none;
 *   · a NON-shell tool never matches, even when its input mentions a git commit;
 *   · the signal is a LOG record only — no span, no metric (there is no
 *     `fredo.commit` span and no row);
 *   · the derivation is wired at the real `session.tool.called` call site, not
 *     merely exported — a handler-local test alone would not prove that;
 *   · the field-agnostic input flattening handles a string, an argv array and a
 *     nested argument object (the typings ship `data.input` as an untyped bag).
 *
 * Payload literals are typed against `V2EventOf<…>`, so a shape drift fails the
 * build rather than silently killing the matcher.
 */

import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import {
  GIT_COMMIT_RE,
  extractCommandText,
  handleToolCommandForCommit,
} from "./activity";
import { handleToolCalled, handleToolInputStarted } from "./tool";
import { ATTR_SESSION_ID, LOG_COMMIT } from "../telemetry-constants";
import type { HandlerContext, SessionTotals, V2EventOf } from "../types";

// ── Recording harness ───────────────────────────────────────────────────────

type RecordedSpan = { name: string; attributes: Record<string, unknown> };

function harness(): { ctx: HandlerContext; logs: LogRecord[]; spans: RecordedSpan[] } {
  const logs: LogRecord[] = [];
  const spans: RecordedSpan[] = [];

  const ctx = {
    log: () => {},
    emitLog: (record: LogRecord) => {
      logs.push(record);
    },
    instruments: {},
    pendingToolSpans: new Map(),
    pendingToolInputs: new Map(),
    pendingPermissions: new Map(),
    sessionTotals: new Map(),
    sessionTurns: new Map(),
    tracer: {
      startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => {
        const rec: RecordedSpan = { name, attributes: { ...(options?.attributes ?? {}) } };
        spans.push(rec);
        return {
          setAttributes: (attrs: Record<string, unknown>) => Object.assign(rec.attributes, attrs),
          setAttribute: (key: string, value: unknown) => {
            rec.attributes[key] = value;
          },
          addEvent: () => {},
          setStatus: () => {},
          end: () => {},
          spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
        };
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

  return { ctx, logs, spans };
}

const SESSION = "ses_activity";

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

function commitLogs(logs: LogRecord[]): LogRecord[] {
  return logs.filter((r) => r.body === LOG_COMMIT);
}

// ── Typed event literals (the real call site) ───────────────────────────────

const durable = { aggregateID: "agg", seq: 1, version: 1 } as const;
const MESSAGE = "msg_assistant";
const CALL = "call-1";

function inputStarted(name: string): V2EventOf<"session.tool.input.started"> {
  return {
    id: "evt-input-started",
    created: 100,
    type: "session.tool.input.started",
    durable,
    data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, name },
  };
}

function toolCalled(input: Record<string, any>): V2EventOf<"session.tool.called"> {
  return {
    id: "evt-called",
    created: 110,
    type: "session.tool.called",
    durable,
    data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, input, executed: true },
  };
}

/** Re-keys an event for a second tool call in the same session. */
function withCallID<T extends V2EventOf<"session.tool.input.started"> | V2EventOf<"session.tool.called">>(
  event: T,
  id: string,
): T {
  return { ...event, data: { ...event.data, id } };
}

// ── The frozen rule ─────────────────────────────────────────────────────────

describe("GIT_COMMIT_RE", () => {
  test("matches a git commit invocation and not its neighbours", () => {
    expect(GIT_COMMIT_RE.test("git commit -m done")).toBe(true);
    expect(GIT_COMMIT_RE.test("git add . && git   commit")).toBe(true);
    expect(GIT_COMMIT_RE.test("cd /repo && git commit --amend --no-edit")).toBe(true);
    // Not a commit subcommand — the `(?![-\w])` guard is the reason.
    expect(GIT_COMMIT_RE.test("git commit-tree abc123")).toBe(false);
    expect(GIT_COMMIT_RE.test("git commitx")).toBe(false);
    expect(GIT_COMMIT_RE.test("npm test")).toBe(false);
  });
});

// ── Field-agnostic input flattening ─────────────────────────────────────────

describe("extractCommandText", () => {
  test("reads a bare string, an argv array and a nested argument object", () => {
    expect(extractCommandText("git commit -m done")).toBe("git commit -m done");
    expect(extractCommandText(["git", "commit", "-m", "done"])).toBe("git\ncommit\n-m\ndone");
    expect(extractCommandText({ command: "git commit -m done" })).toBe("git commit -m done");
    expect(
      extractCommandText({ args: { command: "git commit -m done", timeout: 5000, tty: false } }),
    ).toBe("git commit -m done");
  });

  test("contributes nothing for a non-string scalar, null or an empty value", () => {
    expect(extractCommandText(undefined)).toBe("");
    expect(extractCommandText(null)).toBe("");
    expect(extractCommandText(42)).toBe("");
    expect(extractCommandText({ timeout: 5000 })).toBe("");
    expect(extractCommandText({ command: "" })).toBe("");
  });
});

// ── Emission ────────────────────────────────────────────────────────────────

describe("handleToolCommandForCommit", () => {
  test("emits ONE commit log record with the V1 attribute set", () => {
    const h = harness();
    withSession(h.ctx);

    handleToolCommandForCommit("bash", "git commit -m done", SESSION, h.ctx);

    const records = commitLogs(h.logs);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.attributes?.["event.name"]).toBe(LOG_COMMIT);
    expect(record.attributes?.[ATTR_SESSION_ID]).toBe(SESSION);
    expect(record.attributes?.["agent"]).toBe("build");
    expect(record.attributes?.["agent.name"]).toBe("build");
    expect(record.attributes?.["agent.type"]).toBe("primary");
    expect(record.severityText).toBe("INFO");
    // A log record ONLY — never a span (there is no `fredo.commit` span).
    expect(h.spans).toHaveLength(0);
  });

  test("a non-commit shell command emits none", () => {
    const h = harness();
    withSession(h.ctx);
    handleToolCommandForCommit("bash", "npm test", SESSION, h.ctx);
    handleToolCommandForCommit("bash", "git status", SESSION, h.ctx);
    expect(commitLogs(h.logs)).toHaveLength(0);
    expect(h.spans).toHaveLength(0);
  });

  test("a NON-shell tool never matches, even when its input mentions a commit", () => {
    const h = harness();
    withSession(h.ctx);
    handleToolCommandForCommit("read", "git commit -m done", SESSION, h.ctx);
    handleToolCommandForCommit("edit", "git commit", SESSION, h.ctx);
    expect(commitLogs(h.logs)).toHaveLength(0);
  });
});

// ── Wired at the real call site (session.tool.called) ───────────────────────

describe("session.tool.called wiring", () => {
  test("a git-commit shell call emits exactly one commit log (not one per event)", () => {
    const h = harness();
    withSession(h.ctx);

    handleToolInputStarted(inputStarted("bash"), h.ctx);
    // `.called` is the single wiring point; `.success`/`.failed` never re-derive.
    handleToolCalled(toolCalled({ command: "git add . && git commit -m done" }), h.ctx);

    expect(commitLogs(h.logs)).toHaveLength(1);
    // The tool span itself is the only span — the commit added none.
    expect(h.spans.map((s) => s.name)).toEqual(["fredo.tool.bash"]);
  });

  test("a non-commit shell call and a non-shell call emit none through the call site", () => {
    const h = harness();
    withSession(h.ctx);

    handleToolInputStarted(inputStarted("bash"), h.ctx);
    handleToolCalled(toolCalled({ command: "ls -la" }), h.ctx);

    handleToolInputStarted(withCallID(inputStarted("read"), "call-2"), h.ctx);
    handleToolCalled(withCallID(toolCalled({ path: "git commit.txt" }), "call-2"), h.ctx);

    expect(commitLogs(h.logs)).toHaveLength(0);
    expect(h.spans.map((s) => s.name)).toEqual(["fredo.tool.bash", "fredo.tool.read"]);
  });
});
