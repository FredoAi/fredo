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

/**
 * Maximum number of child-completion snapshots kept in `pendingChildCompletions`
 * (Spec #2745 R-2). Capped with oldest-first eviction like every other plugin
 * map; a dedicated (larger) bound because one parent session can dispatch many
 * subagents across a long run and the snapshot must survive until the parent's
 * `fredo.tool.task` span exports.
 */
export const MAX_CHILD_COMPLETIONS = 10_000;

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

/**
 * Per-message timing state for the TTFC / chunk-cadence metrics (EARS-7/8).
 * Seeded when the message span starts (startMessageSpan); consumed by the
 * text-part handler at part arrival. Bounded via setBoundedMap (MAX_PENDING)
 * and deleted when the message completes or its session is swept.
 */
export type MessageMeta = {
  /** Message/LLM span start time (ms epoch) — the operation start for TTFC. */
  startedAtMs: number;
  /** Model ID for the gen_ai.request.model label (omitted when unknown). */
  modelID?: string;
  /** Provider ID for the gen_ai.provider.name label (omitted when unknown). */
  providerID?: string;
  /** Arrival time of the most recent text chunk (ms epoch) for cadence. */
  lastChunkAtMs?: number;
  /** Whether the first chunk has been recorded (TTFC already emitted). */
  firstChunkRecorded?: boolean;
};

/** OTel metric instruments created once at plugin startup. */
export type Instruments = {
  sessionCounter: Counter;
  tokenCounter: Counter;
  costCounter: Counter;
  toolDurationHistogram: Histogram;
  /** gen_ai.client.operation.duration (OTel GenAI spec, unit s). */
  genAiOperationDuration: Histogram;
  /** gen_ai.client.token.usage (OTel GenAI spec, unit {token}). */
  genAiTokenUsage: Histogram;
  /** gen_ai.execute_tool.duration (OTel GenAI spec, unit s). */
  genAiExecuteToolDuration: Histogram;
  /** gen_ai.invoke_agent.duration (OTel GenAI spec, unit s). */
  genAiInvokeAgentDuration: Histogram;
  /** gen_ai.client.operation.time_to_first_chunk (OTel GenAI spec, unit s). */
  genAiTimeToFirstChunk: Histogram;
  /** gen_ai.client.operation.time_per_output_chunk (OTel GenAI spec, unit s). */
  genAiTimePerOutputChunk: Histogram;
  /** gen_ai.invoke_agent.inference_calls (OTel GenAI spec, unit {inference_call}). */
  genAiInferenceCalls: Histogram;
  /** gen_ai.invoke_agent.tool_calls (OTel GenAI spec, unit {tool_call}). */
  genAiToolCalls: Histogram;
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
  parentId?: string;
  /** Subagent instruction text propagated from handleSessionCreated for startMessageSpan. */
  instruction?: string;
  /** Inference calls this session issued (failed ones included) — EARS-9. */
  inferenceCalls: number;
  /** Client-side tool calls this session issued (failed ones included) — EARS-9. */
  toolCalls: number;
};

/** Pending root-run metadata captured from `chat.message` until the user message ID is known. */
export type PendingRun = {
  agent: string;
  promptText: string;
  model: string;
  startTime: number;
};

/**
 * Child-session completion snapshot (Spec #2745 R-2) recorded at the child's
 * `session.idle`/`session.error` and attached to the PARENT's `fredo.tool.task`
 * span before it exports. Keyed by the PARENT session id in
 * `HandlerContext.pendingChildCompletions`.
 */
export type PendingChildCompletion = {
  /** The completed child session id (`session.id`). */
  childSessionId: string;
  /** Resolved child agent name (getSessionAgentMeta — totals.agent). */
  agent: string;
  /** Child total tokens (totals.tokens). */
  tokens: number;
  /** Child total cost USD (totals.cost). */
  cost: number;
  /** Child total messages (totals.messages). */
  messages: number;
  /** Child accumulated final output (collectSessionOutput). */
  output: string;
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
  messageThinking: Map<string, string>;
  pendingSubagentInstructions: Map<string, string>;
  messageMeta: Map<string, MessageMeta>;
  /** Child-completion snapshots keyed by PARENT session id (Spec #2745 R-2). */
  pendingChildCompletions: Map<string, PendingChildCompletion>;
};
