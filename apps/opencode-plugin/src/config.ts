/**
 * config.ts — Configuration loading for the Fredo OpenCode plugin.
 *
 * Loads configuration from plugin options tuple, OPENCODE_* environment variables,
 * and built-in defaults, in that order of precedence.
 *
 * Stripped from the reference: no disabledMetrics, disabledTraces, disabledLogs,
 * otlpHeaders, otlpHeadersHelper, resourceAttributes, spanAttributes, metricsTemporality.
 */

import type { FredoPluginOptions, FredoPluginConfig } from "./contract_601";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_PROTOCOL,
  DEFAULT_METRIC_PREFIX,
  DEFAULT_METRICS_INTERVAL_MS,
  DEFAULT_LOGS_INTERVAL_MS,
} from "./contract_601";

/**
 * Valid protocols accepted by the plugin.
 */
const VALID_PROTOCOLS = new Set<FredoPluginConfig["protocol"]>(["grpc", "http/protobuf", "http/json"]);

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function pickPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function pickProtocol(value: unknown): FredoPluginConfig["protocol"] | undefined {
  return typeof value === "string" && VALID_PROTOCOLS.has(value as FredoPluginConfig["protocol"])
    ? (value as FredoPluginConfig["protocol"])
    : undefined;
}

/** Parses a positive integer from an environment variable, returning `fallback` if absent or invalid. */
export function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** Returns `true` when the environment variable is present and non-empty. */
function hasNonEmptyEnv(key: string): boolean {
  return !!process.env[key];
}

/**
 * Resolves the plugin config from plugin `options` and `OPENCODE_*` environment
 * variables. For every field a provided option wins over the environment
 * variable, which in turn wins over the built-in default.
 */
export function loadConfig(options: FredoPluginOptions = {}): FredoPluginConfig {
  const resolvedOptions = typeof options === "object" && options !== null ? options : {};

  const traceparent = pickString(resolvedOptions.traceparent) ?? process.env["OPENCODE_TRACEPARENT"];
  const tracestate = pickString(resolvedOptions.tracestate) ?? process.env["OPENCODE_TRACESTATE"];
  const protocol = pickProtocol(resolvedOptions.protocol)
    ?? pickProtocol(process.env["OPENCODE_OTLP_PROTOCOL"])
    ?? DEFAULT_PROTOCOL;

  return {
    enabled: pickBoolean(resolvedOptions.enabled) ?? hasNonEmptyEnv("OPENCODE_ENABLE_TELEMETRY"),
    endpoint: pickString(resolvedOptions.endpoint) ?? process.env["OPENCODE_OTLP_ENDPOINT"] ?? DEFAULT_ENDPOINT,
    protocol,
    metricPrefix: pickString(resolvedOptions.metricPrefix) ?? process.env["OPENCODE_METRIC_PREFIX"] ?? DEFAULT_METRIC_PREFIX,
    metricsInterval: pickPositiveInt(resolvedOptions.metricsInterval) ?? parseEnvInt("OPENCODE_OTLP_METRICS_INTERVAL", DEFAULT_METRICS_INTERVAL_MS),
    logsInterval: pickPositiveInt(resolvedOptions.logsInterval) ?? parseEnvInt("OPENCODE_OTLP_LOGS_INTERVAL", DEFAULT_LOGS_INTERVAL_MS),
    traceparent,
    tracestate,
  };
}
