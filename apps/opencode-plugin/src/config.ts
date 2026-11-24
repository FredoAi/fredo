/**
 * config.ts — Configuration loading for the Fredo OpenCode plugin (V2).
 *
 * Loads configuration from the V2 plugin `ctx.options` object, `OPENCODE_*` /
 * `FREDO_*` environment variables, and built-in defaults, in that order of
 * precedence.
 *
 * Shared global plugin file, per-process env (Spec #2944 ST-11):
 * The plugin is installed ONCE at a global path (e.g.
 * `~/.config/opencode/plugins/fredo.js`) and is shared by every OpenCode process
 * on the machine. There is deliberately NO endpoint written into that global
 * file. Endpoint/protocol resolution reads the *process* environment at plugin
 * init, so each OpenCode process streams to the receiver named by its own
 * `OPENCODE_OTLP_ENDPOINT`. Endpoint precedence is:
 *   plugin-option `endpoint`  →  OPENCODE_OTLP_ENDPOINT  →  DEFAULT_ENDPOINT
 * (protocol: plugin-option → OPENCODE_OTLP_PROTOCOL → DEFAULT_PROTOCOL).
 *
 * Enablement (Spec #3197 ST-1) is INVERTED relative to V1: capture is
 * DEFAULT-ON. Opt-outs, highest precedence first:
 *   1. plugin option `enabled: false`  → capture OFF
 *      (plugin option `enabled: true` is an explicit opt-in → capture ON)
 *   2. `FREDO_TELEMETRY` = `0` | `false` | `off` (case-insensitive) → OFF
 *   3. `OPENCODE_ENABLE_TELEMETRY` = `0` | `false` (case-insensitive) → OFF;
 *      its ABSENCE no longer disables anything (the V1 gate is inverted).
 * Any other value — including unset — leaves capture ON.
 *
 * Stripped from the reference: no disabledMetrics, disabledTraces, disabledLogs,
 * otlpHeaders, otlpHeadersHelper, resourceAttributes, spanAttributes, metricsTemporality.
 */

import type { FredoPluginOptions, FredoPluginConfig } from "./telemetry-constants";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_PROTOCOL,
  DEFAULT_METRIC_PREFIX,
  DEFAULT_METRICS_INTERVAL_MS,
  DEFAULT_LOGS_INTERVAL_MS,
} from "./telemetry-constants";

/**
 * Valid protocols accepted by the plugin.
 */
const VALID_PROTOCOLS = new Set<FredoPluginConfig["protocol"]>(["grpc", "http/protobuf", "http/json"]);

/** The environment shape the resolvers read. Injected by the unit tests for determinism. */
export type PluginEnv = Readonly<Record<string, string | undefined>>;

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
export function parseEnvInt(key: string, fallback: number, env: PluginEnv = process.env): number {
  const raw = env[key];
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

/**
 * True when `raw` is an opt-out token. `0`/`false` always disable; `off` is only
 * accepted for the Fredo-native switch (`FREDO_TELEMETRY`), which is the
 * documented three-value opt-out. Case-insensitive, surrounding whitespace
 * ignored — an operator's `Off` must not silently re-enable capture.
 */
function isOptOut(raw: string | undefined, allowOff: boolean): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "false") return true;
  return allowOff && value === "off";
}

/**
 * Resolves whether capture is enabled for this plugin host process.
 *
 * Default-ON: capture happens unless one of the documented opt-outs is present.
 * Precedence is plugin option → `FREDO_TELEMETRY` → `OPENCODE_ENABLE_TELEMETRY`,
 * matching the option-over-env precedence used for every other field.
 */
export function isTelemetryEnabled(
  options: FredoPluginOptions = {},
  env: PluginEnv = process.env,
): boolean {
  const resolvedOptions = typeof options === "object" && options !== null ? options : {};
  const optionEnabled = pickBoolean((resolvedOptions as { enabled?: unknown }).enabled);
  if (optionEnabled === false) return false;
  if (optionEnabled === true) return true;
  if (isOptOut(env["FREDO_TELEMETRY"], true)) return false;
  if (isOptOut(env["OPENCODE_ENABLE_TELEMETRY"], false)) return false;
  return true;
}

/**
 * Resolves the plugin config from the V2 plugin `ctx.options` object and the
 * plugin host process environment. For every field a provided option wins over
 * the environment variable, which in turn wins over the built-in default.
 *
 * `endpoint` is the effective OTLP target consumed by `otel.ts`; it is resolved
 * per-process from `OPENCODE_OTLP_ENDPOINT` (see the per-process env model in the
 * file header). The default stays `http://localhost:4317` when neither the option
 * nor the env var is set — the legacy single-env path is unchanged.
 */
export function loadConfig(options: FredoPluginOptions = {}, env: PluginEnv = process.env): FredoPluginConfig {
  const resolvedOptions = typeof options === "object" && options !== null ? options : {};

  const traceparent = pickString(resolvedOptions.traceparent) ?? env["OPENCODE_TRACEPARENT"];
  const tracestate = pickString(resolvedOptions.tracestate) ?? env["OPENCODE_TRACESTATE"];
  const protocol = pickProtocol(resolvedOptions.protocol)
    ?? pickProtocol(env["OPENCODE_OTLP_PROTOCOL"])
    ?? DEFAULT_PROTOCOL;

  return {
    enabled: isTelemetryEnabled(resolvedOptions, env),
    endpoint: pickString(resolvedOptions.endpoint) ?? env["OPENCODE_OTLP_ENDPOINT"] ?? DEFAULT_ENDPOINT,
    protocol,
    metricPrefix: pickString(resolvedOptions.metricPrefix) ?? env["OPENCODE_METRIC_PREFIX"] ?? DEFAULT_METRIC_PREFIX,
    metricsInterval: pickPositiveInt(resolvedOptions.metricsInterval) ?? parseEnvInt("OPENCODE_OTLP_METRICS_INTERVAL", DEFAULT_METRICS_INTERVAL_MS, env),
    logsInterval: pickPositiveInt(resolvedOptions.logsInterval) ?? parseEnvInt("OPENCODE_OTLP_LOGS_INTERVAL", DEFAULT_LOGS_INTERVAL_MS, env),
    traceparent,
    tracestate,
  };
}
