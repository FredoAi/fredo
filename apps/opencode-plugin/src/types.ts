/**
 * types.ts — TypeScript type definitions for the Fredo OpenCode plugin.
 *
 * Mirrors the reference architecture (DEVtheOPS/opencode-plugin-otel) with a
 * stripped config surface: no disabledMetrics, disabledTraces, otlpHeaders,
 * resourceAttributes, spanAttributes, headersHelper, or metricsTemporality.
 */

import type { Context, Counter, Histogram, Span, SpanContext, Tracer } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";

/** Numeric priority map for log levels; higher value = higher severity. */
export const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
/** Union of supported log level names. */
export type Level = keyof typeof LEVELS;

/** Maximum number of entries kept in bounded maps (LRU eviction). */
export const MAX_PENDING = 500;

/** Structured logger forwarded to the opencode `client.app.log` API. */
export type PluginLogger = (
  level: Level,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>;

/** In-flight tool execution tracked between `running` and `completed`/`error` part updates. */
export type PendingToolSpan = {
  tool: string;
  sessionID: string;
  startMs: number;
  span?: Span;
};

/** Permission prompt tracked between `permission.updated` and `permission.replied`. */
export type PendingPermission = {
  type: string;
  title: string;
  sessionID: string;
};

/** OTel metric instruments created once at plugin startup. */
export type Instruments = {
  sessionCounter: Counter;
  tokenCounter: Counter;
  costCounter: Counter;
  toolDurationHistogram: Histogram;
};

/** Session role emitted by opencode: either the primary/root agent or a spawned subagent. */
export type SessionAgentType = "primary" | "subagent";

/** Accumulated per-session totals for gauge snapshots on session.idle. */
export type SessionTotals = {
  startMs: number;
  tokens: number;
  cost: number;
  messages: number;
  agent: string;
  agentType: SessionAgentType;
};

/** Pending root-run metadata captured from `chat.message` until the user message ID is known. */
export type PendingRun = {
  agent: string;
  promptText: string;
  model: string;
  startTime: number;
};

/** Shared context threaded through every event handler. */
export type HandlerContext = {
  log: PluginLogger;
  emitLog: (record: LogRecord) => void;
  instruments: Instruments;
  pendingToolSpans: Map<string, PendingToolSpan>;
  pendingPermissions: Map<string, PendingPermission>;
  sessionTotals: Map<string, SessionTotals>;
  tracer: Tracer;
  tracePrefix: string;
  rootContext: () => Context;
  runSpans: Map<string, Span>;
  runSpanContexts: Map<string, SpanContext>;
  activeRuns: Map<string, string>;
  assistantRuns: Map<string, string>;
  pendingRuns: Map<string, PendingRun>;
  runInputs: Map<string, string>;
  sessionSpans: Map<string, Span>;
  sessionSpanContexts: Map<string, SpanContext>;
  messageSpans: Map<string, Span>;
  messageOutputs: Map<string, string>;
};
