/**
 * otel.ts — OpenTelemetry SDK setup and instrument creation for the Fredo OpenCode plugin.
 *
 * Initialises MeterProvider, LoggerProvider, and BasicTracerProvider backed by OTLP
 * gRPC exporters. HTTP/protobuf and HTTP/JSON are accepted by config but currently
 * only gRPC exporters are wired (future enhancement).
 *
 * NO PROCESS-GLOBAL REGISTRATION (Spec #3197 round 2, F-1). The plugin is a GUEST
 * in the OpenCode host process and must never claim the host's process-wide OTel
 * API — it builds its own provider instances and every tracer/meter/logger handle
 * is taken FROM those instances (`tracerProvider.getTracer`,
 * `meterProvider.getMeter`, `loggerProvider.getLogger`). The previous
 * `setGlobal*Provider` calls were the round-1 blocker: the api's global slot
 * (`globalThis[Symbol.for("opentelemetry.js.api.<major>")]`) is first-wins AND
 * version-exact, and the host owns it before this plugin's `setup` runs — the
 * host's api is 1.9.0 while this plugin's is 1.9.1, so BOTH gates refused the
 * registration and `trace.getTracer` resolved the HOST's provider (or a
 * delegate-less proxy). The plugin's `BatchSpanProcessor` then never saw a span
 * while the log half passed only by the `api-logs` duplicate-registration
 * coincidence (it returns the existing provider instead of failing). Removing the
 * globals removes that host side effect for all three signals.
 *
 * Stripped from the reference: no auth headers, no dynamic headers, no custom
 * resource/span attributes beyond service.name and version.
 */

import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { DEFAULT_BSP_SCHEDULE_DELAY_MS } from "./telemetry-constants";
import type { Instruments } from "./types";

/** Handles returned by `setupOtel`, used for graceful shutdown. */
export type OtelProviders = {
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
  tracerProvider: BasicTracerProvider;
};

/**
 * Upper bound on the process-exit flush (Spec #3197 round 2, F-2/NFR-1).
 *
 * The exit hook exists for the tail the terminal flush could not finish before
 * the CLI returned. It must never hold the HOST process open, so the wait is
 * bounded; a loopback export normally completes in a few milliseconds and the
 * timer is cleared as soon as it does.
 */
const EXIT_FLUSH_TIMEOUT_MS = 2_000;

export async function forceFlushOtel(providers: OtelProviders) {
  await Promise.allSettled([
    providers.meterProvider.forceFlush(),
    providers.loggerProvider.forceFlush(),
    providers.tracerProvider.forceFlush(),
  ]);
}

/** Flushes the plugin's providers, bounded by `EXIT_FLUSH_TIMEOUT_MS`. */
async function flushBounded(providers: OtelProviders): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS);
  });
  await Promise.race([forceFlushOtel(providers), bound]);
  if (timer) clearTimeout(timer);
}

/**
 * Registers a `beforeExit` flush and returns the function that removes it.
 *
 * `beforeExit` fires when the event loop would otherwise empty: the flush it
 * starts is asynchronous and re-arms the loop, so a pending export finishes
 * before the process goes away. Deliberately NOT `SIGINT`/`SIGTERM` — a signal
 * listener in a guest plugin suppresses the host's own default handling (an
 * operator's SIGTERM would stop terminating the process unless the plugin called
 * `process.exit()`, which would kill a host it does not own).
 */
export function registerExitFlush(providers: OtelProviders): () => void {
  const onBeforeExit = () => {
    void flushBounded(providers);
  };
  process.once("beforeExit", onBeforeExit);
  return () => {
    process.off("beforeExit", onBeforeExit);
  };
}

/**
 * Initialises the OTel SDK — creates a MeterProvider, LoggerProvider, and
 * BasicTracerProvider backed by OTLP gRPC exporters pointed at `endpoint`.
 *
 * The returned instances are the ONLY source of tracer/meter/logger handles:
 * nothing here is registered globally (see the file header).
 */
export async function setupOtel(
  endpoint: string,
  protocol: "grpc" | "http/protobuf" | "http/json",
  metricsInterval: number,
  logsInterval: number,
  version: string,
): Promise<OtelProviders> {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "fredo-opencode-plugin",
    "app.version": version,
    "os.type": process.platform,
  });

  // gRPC exporter (primary)
  const metricExporter = new OTLPMetricExporter({ url: endpoint });
  const logExporter = new OTLPLogExporter({ url: endpoint });
  const traceExporter = new OTLPTraceExporter({ url: endpoint });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: metricsInterval,
      }),
    ],
  });

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        scheduledDelayMillis: logsInterval,
      }),
    ],
  });

  const tracerProvider = new BasicTracerProvider({
    resource,
    // Explicit cadence — the SDK default (5 s) outlives a short `run`-mode
    // session, so the last span ended would never be due while the host lives.
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        scheduledDelayMillis: DEFAULT_BSP_SCHEDULE_DELAY_MS,
      }),
    ],
  });

  return { meterProvider, loggerProvider, tracerProvider };
}

/**
 * Creates all metric instruments from `meterProvider` — the plugin's OWN meter
 * provider (never the api's global meter). Metric names are prefixed with `prefix`.
 */
export function createInstruments(prefix: string, meterProvider: MeterProvider): Instruments {
  const meter = meterProvider.getMeter("com.fredo.opencode");
  return {
    sessionCounter: meter.createCounter(`${prefix}session.count`, {
      unit: "{session}",
      description: "Count of opencode sessions started",
    }),
    tokenCounter: meter.createCounter(`${prefix}token.usage`, {
      unit: "tokens",
      description: "Number of tokens used",
    }),
    costCounter: meter.createCounter(`${prefix}cost.usage`, {
      unit: "USD",
      description: "Cost of the opencode session in USD",
    }),
    toolDurationHistogram: meter.createHistogram(`${prefix}tool.duration`, {
      unit: "ms",
      description: "Duration of tool executions in milliseconds",
    }),
    // ── GA-7: OTel GenAI semantic convention metrics (gen-ai-metrics.md) ──────
    // Units follow the registry: durations are SECONDS (s), token usage is {token}.
    // ExplicitBucketBoundaries match the recommended values in gen-ai-metrics.md.
    genAiOperationDuration: meter.createHistogram(`gen_ai.client.operation.duration`, {
      unit: "s",
      description: "GenAI operation duration",
      advice: {
        explicitBucketBoundaries: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92],
      },
    }),
    genAiTokenUsage: meter.createHistogram(`gen_ai.client.token.usage`, {
      unit: "{token}",
      description: "Number of input and output tokens used",
      advice: {
        explicitBucketBoundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864],
      },
    }),
    genAiExecuteToolDuration: meter.createHistogram(`gen_ai.execute_tool.duration`, {
      unit: "s",
      description: "The duration of a single tool execution",
      advice: {
        explicitBucketBoundaries: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92],
      },
    }),
    genAiInvokeAgentDuration: meter.createHistogram(`gen_ai.invoke_agent.duration`, {
      unit: "s",
      description: "The end-to-end duration of a single in-process agent invocation",
      advice: {
        explicitBucketBoundaries: [0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6],
      },
    }),
    // ── Spec #2680 Sub-task 3: four registry metrics (gen-ai-metrics.md) ──────
    // time_to_first_chunk / time_per_output_chunk are SECONDS (s) histograms
    // with the same doubling boundaries as gen_ai.client.operation.duration;
    // invoke_agent counts use {inference_call}/{tool_call} units with count
    // boundaries [1..128] doubling. Recorded only when real values exist —
    // never placeholder rows (EARS-10).
    genAiTimeToFirstChunk: meter.createHistogram(`gen_ai.client.operation.time_to_first_chunk`, {
      unit: "s",
      description: "The duration between the start of the operation and the first chunk in the response stream",
      advice: {
        explicitBucketBoundaries: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92],
      },
    }),
    genAiTimePerOutputChunk: meter.createHistogram(`gen_ai.client.operation.time_per_output_chunk`, {
      unit: "s",
      description: "The duration between the reception of two consecutive chunks in the response stream",
      advice: {
        explicitBucketBoundaries: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92],
      },
    }),
    genAiInferenceCalls: meter.createHistogram(`gen_ai.invoke_agent.inference_calls`, {
      unit: "{inference_call}",
      description: "The number of inference calls performed during a single agent invocation",
      advice: {
        explicitBucketBoundaries: [1, 2, 4, 8, 16, 32, 64, 128],
      },
    }),
    genAiToolCalls: meter.createHistogram(`gen_ai.invoke_agent.tool_calls`, {
      unit: "{tool_call}",
      description: "The number of tool calls performed during a single agent invocation",
      advice: {
        explicitBucketBoundaries: [1, 2, 4, 8, 16, 32, 64, 128],
      },
    }),
  };
}
