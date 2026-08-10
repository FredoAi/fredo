/**
 * otel.ts — OpenTelemetry SDK setup and instrument creation for the Fredo OpenCode plugin.
 *
 * Initialises MeterProvider, LoggerProvider, and BasicTracerProvider backed by OTLP
 * gRPC exporters. HTTP/protobuf and HTTP/JSON are accepted by config but currently
 * only gRPC exporters are wired (future enhancement).
 *
 * Stripped from the reference: no auth headers, no dynamic headers, no custom
 * resource/span attributes beyond service.name and version.
 */

import { logs } from "@opentelemetry/api-logs";
import { metrics, trace } from "@opentelemetry/api";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { Instruments } from "./types";

/** Handles returned by `setupOtel`, used for graceful shutdown. */
export type OtelProviders = {
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
  tracerProvider: BasicTracerProvider;
};

export async function forceFlushOtel(providers: OtelProviders) {
  await Promise.allSettled([
    providers.meterProvider.forceFlush(),
    providers.loggerProvider.forceFlush(),
    providers.tracerProvider.forceFlush(),
  ]);
}

/**
 * Initialises the OTel SDK — creates a MeterProvider, LoggerProvider, and
 * BasicTracerProvider backed by OTLP gRPC exporters pointed at `endpoint`,
 * and registers them as the global providers.
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
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        scheduledDelayMillis: logsInterval,
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  return { meterProvider, loggerProvider, tracerProvider };
}

/** Creates all metric instruments using the global MeterProvider. Metric names are prefixed with `prefix`. */
export function createInstruments(prefix: string): Instruments {
  const meter = metrics.getMeter("com.fredo.opencode");
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
