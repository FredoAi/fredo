/**
 * telemetry-constants.ts — Shared telemetry contract for the Fredo OpenCode plugin.
 *
 * Span naming conventions, flat span-attribute keys, the plugin config interface,
 * log event names, metric names, and ECE transport filter values.
 *
 * READ-ONLY: Only the Software Architect edits this file. Developers implement against it.
 */

// ── OTLP Span Naming Convention ────────────────────────────────────────────────

/** Prefix applied to all OTLP span names emitted by the fredo plugin. */
export const SPAN_PREFIX = "fredo." as const;

/** Span name for session lifecycle spans (session.created, session.idle, session.error). */
export const SPAN_SESSION = `${SPAN_PREFIX}session` as const;

/** Span name for LLM request spans (assistant messages). */
export const SPAN_LLM = `${SPAN_PREFIX}llm` as const;

/** Span name prefix for tool execution spans (e.g., fredo.tool.Bash). */
export const SPAN_TOOL_PREFIX = `${SPAN_PREFIX}tool.` as const;

// ── Span Attribute Keys ────────────────────────────────────────────────────────

/** Standard attributes emitted on all spans. */
export const ATTR_SESSION_ID = "session.id" as const;
export const ATTR_AGENT_TYPE = "agent.type" as const;
export const ATTR_IS_SUBAGENT = "is_subagent" as const;
export const ATTR_PARENT_SESSION_ID = "session.parent_id" as const;

/** LLM span attributes. */
export const ATTR_INPUT_TOKENS = "input_tokens" as const;
export const ATTR_OUTPUT_TOKENS = "output_tokens" as const;
export const ATTR_REASONING_TOKENS = "reasoning_tokens" as const;
export const ATTR_CACHE_READ_TOKENS = "cache_read_tokens" as const;
export const ATTR_CACHE_CREATION_TOKENS = "cache_creation_tokens" as const;
export const ATTR_MODEL = "model" as const;
export const ATTR_PROVIDER = "provider" as const;
export const ATTR_DURATION_MS = "duration_ms" as const;
export const ATTR_SUCCESS = "success" as const;
export const ATTR_COST_USD = "cost_usd" as const;
export const ATTR_PROMPT_LENGTH = "prompt_length" as const;

/** Tool span attributes. */
export const ATTR_TOOL_NAME = "tool_name" as const;
export const ATTR_TOOL_SUCCESS = "tool.success" as const;
export const ATTR_TOOL_ERROR = "tool.error" as const;
export const ATTR_TOOL_RESULT_SIZE = "tool.result_size_bytes" as const;

/** Session-level summary attributes (emitted on idle spans). */
export const ATTR_TOTAL_TOKENS = "total_tokens" as const;
export const ATTR_TOTAL_COST = "total_cost_usd" as const;
export const ATTR_TOTAL_MESSAGES = "total_messages" as const;

// ── Plugin Config Interface ────────────────────────────────────────────────────

/** Configuration accepted via plugin options tuple in opencode.json. */
export interface FredoPluginOptions {
  /** Enable telemetry export. Default: false (requires env var). */
  enabled?: boolean;
  /** OTLP collector endpoint URL. Default: "http://localhost:4317". */
  endpoint?: string;
  /** OTLP transport protocol. Default: "grpc". */
  protocol?: "grpc" | "http/protobuf" | "http/json";
  /** Prefix for all metric names. Default: "fredo.". */
  metricPrefix?: string;
  /** Metrics export interval in milliseconds. Default: 5000. */
  metricsInterval?: number;
  /** Logs export interval in milliseconds. Default: 1000. */
  logsInterval?: number;
  /** W3C traceparent header for remote trace context. */
  traceparent?: string;
  /** W3C tracestate header (paired with traceparent). */
  tracestate?: string;
}

/** Resolved plugin configuration after merging options, env vars, and defaults. */
export interface FredoPluginConfig {
  enabled: boolean;
  endpoint: string;
  protocol: "grpc" | "http/protobuf" | "http/json";
  metricPrefix: string;
  metricsInterval: number;
  logsInterval: number;
  traceparent: string | undefined;
  tracestate: string | undefined;
}

// ── Log Event Names ────────────────────────────────────────────────────────────

/** Log event body values emitted by the plugin. */
export const LOG_SESSION_CREATED = "session.created" as const;
export const LOG_SESSION_IDLE = "session.idle" as const;
export const LOG_SESSION_ERROR = "session.error" as const;
export const LOG_USER_PROMPT = "user_prompt" as const;
export const LOG_API_REQUEST = "api_request" as const;
export const LOG_API_ERROR = "api_error" as const;
export const LOG_TOOL_RESULT = "tool_result" as const;
export const LOG_TOOL_DECISION = "tool_decision" as const;
export const LOG_COMMIT = "commit" as const;

// ── Metric Names (suffixes after metricPrefix) ─────────────────────────────────

export const METRIC_SESSION_COUNT = "session.count" as const;
export const METRIC_TOKEN_USAGE = "token.usage" as const;
export const METRIC_COST_USAGE = "cost.usage" as const;
export const METRIC_TOOL_DURATION = "tool.duration" as const;

// ── ECE Transport Filter Values ────────────────────────────────────────────────

/**
 * Transport values used in Mission Monitor ECE contract declarations.
 * After CLI removal, the plugin emits via OTLP only — contracts must accept these.
 */
export const ECE_TRANSPORT_OTLP_GRPC = "otlp_grpc" as const;
export const ECE_TRANSPORT_OTLP_HTTP = "otlp_http" as const;

/** Legacy Hook transport — may be removed from contracts after migration is verified. */
export const ECE_TRANSPORT_HOOK = "hook" as const;

// ── Default Configuration ──────────────────────────────────────────────────────

export const DEFAULT_ENDPOINT = "http://localhost:4317";
export const DEFAULT_PROTOCOL: "grpc" = "grpc";
export const DEFAULT_METRIC_PREFIX = "fredo.";
export const DEFAULT_METRICS_INTERVAL_MS = 5000;
export const DEFAULT_LOGS_INTERVAL_MS = 1000;

/**
 * Contract stub: every plugin module that creates spans MUST use these names.
 * Every adapter module that processes spans MUST handle these names.
 */
export function validateSpanName(name: string): boolean {
  return (
    name === SPAN_SESSION ||
    name === SPAN_LLM ||
    name.startsWith(SPAN_TOOL_PREFIX)
  );
}
