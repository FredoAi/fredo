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
  };
}
