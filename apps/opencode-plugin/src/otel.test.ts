/**
 * otel.test.ts — the provider-binding + local-export proof (Spec #3197 round 2,
 * F-1/F-2/F-4).
 *
 * WHY THIS FILE EXISTS
 * Round 1 shipped a plugin that loaded, ran its handlers and persisted LOG
 * records, yet exported ZERO spans: every handle was taken from the api's
 * process-global registries (`trace.getTracer`, `metrics.getMeter`,
 * `logs.getLogger`) after registering the plugin's provider there with
 * `setGlobal*Provider`. OpenTelemetry's global slot is first-wins and
 * version-exact, and the OpenCode host owns it before this plugin's `setup`
 * runs — so the plugin's `BatchSpanProcessor` never saw a span.
 *
 * These tests prove the mechanism is CHANGED, without an OpenCode host:
 *   (a) `createInstruments` binds to the MeterProvider it is GIVEN — a real
 *       in-memory exporter receives `fredo.session.count`, while a second
 *       provider's exporter receives nothing (non-vacuity control);
 *   (b) a span produced by the REAL handlers (`handleV2Event` → `fredo.session`,
 *       `fredo.llm`, `fredo.tool.*`) reaches a `SpanExporter` through the
 *       plugin's own tracer, in a process where no global provider was set;
 *   (c) the log half keeps working from the plugin's own LoggerProvider;
 *   (d) `setupOtel` registers nothing globally — its tracer provider is not the
 *       api's global one;
 *   (e) a SOURCE GUARD over every product module: no `setGlobal*Provider` and no
 *       handle taken from the api globals, with a non-vacuity control that
 *       catches the exact round-1 shape.
 *
 * What this does NOT prove: that a live OpenCode host delivers the export to
 * Fredo's receiver — that is the tester's live leg.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import { LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createInstruments, forceFlushOtel, setupOtel, type OtelProviders } from "./otel";
import { handleV2Event } from "./index";
import {
  ATTR_MODEL,
  ATTR_SESSION_ID,
  ATTR_TOTAL_TOKENS,
  DEFAULT_BSP_SCHEDULE_DELAY_MS,
  DEFAULT_METRIC_PREFIX,
  LOG_API_REQUEST,
  LOG_SESSION_CREATED,
  LOG_SESSION_IDLE,
  LOG_TOOL_RESULT,
  METRIC_SESSION_COUNT,
  SPAN_LLM,
  SPAN_SESSION,
  SPAN_TOOL_PREFIX,
} from "./telemetry-constants";
import { ATTR_OP_NAME, OP_NAME_CHAT, OP_NAME_SESSION, OP_NAME_TOOL } from "./genai-conventions";
import type { HandlerContext, V2Event, V2EventOf } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Providers backed by IN-MEMORY exporters (the "does it export" oracle) ────

type InMemoryProviders = OtelProviders & {
  spanExporter: InMemorySpanExporter;
  metricExporter: InMemoryMetricExporter;
  logExporter: InMemoryLogRecordExporter;
};

const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: "fredo-opencode-plugin" });

function inMemoryProviders(suffix: string): InMemoryProviders {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const logExporter = new InMemoryLogRecordExporter();

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        // Never fires on its own: the test drives `forceFlush`, and `afterAll`
        // shuts the reader down so no timer outlives the run.
        exportIntervalMillis: 60_000,
      }),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor(logExporter)],
  });
  void suffix;

  return {
    tracerProvider,
    meterProvider,
    loggerProvider,
    spanExporter,
    metricExporter,
    logExporter,
  };
}

/** Every provider built here is shut down at the end so no handle outlives the run. */
const live: OtelProviders[] = [];
function track<T extends OtelProviders>(providers: T): T {
  live.push(providers);
  return providers;
}

afterAll(async () => {
  for (const providers of live) {
    await Promise.allSettled([
      providers.meterProvider.shutdown(),
      providers.loggerProvider.shutdown(),
      providers.tracerProvider.shutdown(),
    ]);
  }
});

/**
 * The handler context `index.ts` builds at runtime, with the SAME provider
 * instances feeding every seam (tracer, meter, logger, flush) — so a span that a
 * handler starts is a span the exporter can see.
 */
function contextFor(providers: InMemoryProviders): HandlerContext {
  const logger = providers.loggerProvider.getLogger("com.fredo.opencode");
  return {
    log: () => {},
    emitLog: (record: LogRecord) => {
      logger.emit(record);
    },
    instruments: createInstruments(DEFAULT_METRIC_PREFIX, providers.meterProvider),
    pendingToolSpans: new Map(),
    pendingToolInputs: new Map(),
    pendingPermissions: new Map(),
    sessionTotals: new Map(),
    sessionTurns: new Map(),
    tracer: providers.tracerProvider.getTracer("com.fredo.opencode"),
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
    registeredSessions: new Set(),
    suppressParentRouting: false,
    onExporterFlush: () => forceFlushOtel(providers),
  };
}

// ── A run-mode session: the shape this host actually delivers ────────────────

const durable = { aggregateID: "agg", seq: 1, version: 1 } as const;
const SESSION = "ses_otel_export";
const MESSAGE = "msg_otel_turn";
const CALL = "call_otel_read";

const inbox: V2EventOf<"session.inbox.enqueued"> = {
  id: "evt-otel-inbox",
  created: 1_010,
  type: "session.inbox.enqueued",
  durable,
  data: {
    sessionID: SESSION,
    inboxID: "msg_user",
    item: { type: "user", payload: { text: "read a file" }, delivery: "queue" },
  },
};

const stepStarted: V2EventOf<"session.step.started"> = {
  id: "evt-otel-step",
  created: 1_020,
  type: "session.step.started",
  durable,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    agent: "build",
    model: { id: "claude-sonnet", providerID: "anthropic" },
    started: 1_020,
  },
};

const stepEnded: V2EventOf<"session.step.ended"> = {
  id: "evt-otel-step-ended",
  created: 1_100,
  type: "session.step.ended",
  durable,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    finish: "tool-calls",
    cost: 0.002,
    tokens: { input: 20, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
  },
};

const toolInputStarted: V2EventOf<"session.tool.input.started"> = {
  id: "evt-otel-input",
  created: 1_110,
  type: "session.tool.input.started",
  durable,
  data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, name: "read" },
};

const toolCalled: V2EventOf<"session.tool.called"> = {
  id: "evt-otel-called",
  created: 1_120,
  type: "session.tool.called",
  durable,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    id: CALL,
    input: { path: "a.ts" },
    executed: true,
  },
};

const toolSuccess: V2EventOf<"session.tool.success"> = {
  id: "evt-otel-success",
  created: 1_140,
  type: "session.tool.success",
  durable: { aggregateID: "agg", seq: 2, version: 2 } as const,
  data: {
    sessionID: SESSION,
    assistantMessageID: MESSAGE,
    id: CALL,
    content: [{ type: "text", text: "ok" }],
    executed: true,
  },
};

const executionSucceeded: V2EventOf<"session.execution.succeeded"> = {
  id: "evt-otel-succeeded",
  created: 1_200,
  type: "session.execution.succeeded",
  durable,
  data: { sessionID: SESSION },
};

const RUN_MODE_SESSION: V2Event[] = [
  inbox,
  stepStarted,
  stepEnded,
  toolInputStarted,
  toolCalled,
  toolSuccess,
  executionSucceeded,
];

function driveRunMode(ctx: HandlerContext): void {
  for (const event of RUN_MODE_SESSION) handleV2Event(event, ctx);
}

// ── (b) a span reaches an exporter through the plugin's OWN tracer ───────────

describe("export: a span produced by the real handlers reaches a SpanExporter", () => {
  test("fredo.session / fredo.llm / fredo.tool.read are exported, with their attributes", async () => {
    const providers = track(inMemoryProviders("traces"));
    const ctx = contextFor(providers);

    driveRunMode(ctx);
    await providers.tracerProvider.forceFlush();

    const finished = providers.spanExporter.getFinishedSpans();
    const names = finished.map((span) => span.name).sort();
    expect(names).toEqual([SPAN_SESSION, SPAN_LLM, `${SPAN_TOOL_PREFIX}read`].sort());

    const session = finished.find((span) => span.name === SPAN_SESSION)!;
    // The classifier's discriminators survive the export path.
    expect(session.attributes[ATTR_OP_NAME]).toBe(OP_NAME_SESSION);
    expect(session.attributes[ATTR_SESSION_ID]).toBe(SESSION);
    expect(session.attributes[ATTR_MODEL]).toBe("anthropic/claude-sonnet");
    expect(session.attributes[ATTR_TOTAL_TOKENS]).toBe(27);
    expect(session.endTime[0] > 0).toBe(true);

    expect(finished.find((span) => span.name === SPAN_LLM)!.attributes[ATTR_OP_NAME]).toBe(
      OP_NAME_CHAT,
    );
    expect(
      finished.find((span) => span.name === `${SPAN_TOOL_PREFIX}read`)!.attributes[ATTR_OP_NAME],
    ).toBe(OP_NAME_TOOL);
  });

  test("the terminal close flushes the batch tail (F-2), not a session.idle event", () => {
    const providers = track(inMemoryProviders("tail"));
    const ctx = contextFor(providers);
    let flushes = 0;
    const flush = ctx.onExporterFlush!;
    ctx.onExporterFlush = () => {
      flushes += 1;
      return flush();
    };

    driveRunMode(ctx);
    // `session.idle` never arrives in this shape (7 events, none of them idle).
    expect(flushes).toBe(1);
  });
});

// ── (a) instruments bind to the GIVEN meter provider ─────────────────────────

function collectedMetricNames(exporter: InMemoryMetricExporter): string[] {
  return exporter
    .getMetrics()
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .map((metric) => metric.descriptor.name);
}

describe("export: createInstruments binds to the provider it is given", () => {
  test("the given provider's exporter collects fredo.session.count", async () => {
    const providers = track(inMemoryProviders("metrics"));
    const ctx = contextFor(providers);

    driveRunMode(ctx);
    await providers.meterProvider.forceFlush();

    const names = collectedMetricNames(providers.metricExporter);
    expect(names).toContain(`${DEFAULT_METRIC_PREFIX}${METRIC_SESSION_COUNT}`);
    expect(names).toContain("gen_ai.invoke_agent.duration");
  });

  test("non-vacuity control: a DIFFERENT provider collects nothing", async () => {
    const used = track(inMemoryProviders("used"));
    const bystander = track(inMemoryProviders("bystander"));
    const ctx = contextFor(used);

    driveRunMode(ctx);
    await bystander.meterProvider.forceFlush();

    expect(collectedMetricNames(bystander.metricExporter)).toEqual([]);
  });
});

// ── (c) the log half still exports from the plugin's own provider ────────────

describe("export: log records reach the plugin's own LoggerProvider", () => {
  test("the preserved bodies are exported", async () => {
    const providers = track(inMemoryProviders("logs"));
    const ctx = contextFor(providers);

    driveRunMode(ctx);
    await providers.loggerProvider.forceFlush();

    const bodies = providers.logExporter.getFinishedLogRecords().map((record) => String(record.body));
    expect(bodies).toContain(LOG_SESSION_CREATED);
    expect(bodies).toContain(LOG_SESSION_IDLE);
    expect(bodies).toContain(LOG_API_REQUEST);
    expect(bodies).toContain(LOG_TOOL_RESULT);
  });
});

// ── (d) setupOtel registers NO global provider ───────────────────────────────

describe("setupOtel: no process-global registration (F-1)", () => {
  test("the returned tracer provider is not the api's global one", async () => {
    const providers = await setupOtel(
      "http://127.0.0.1:1",
      "grpc",
      60_000,
      60_000,
      "test",
    );
    try {
      // `trace.getTracerProvider()` answers the api's global registry (a
      // delegate-less proxy here). A registration would make it the plugin's.
      expect(trace.getTracerProvider()).not.toBe(providers.tracerProvider);
    } finally {
      await Promise.allSettled([
        providers.meterProvider.shutdown(),
        providers.loggerProvider.shutdown(),
        providers.tracerProvider.shutdown(),
      ]);
    }
  });

  test("the span processor's cadence is the explicit constant, not the 5 s default", () => {
    // A short `run`-mode session lives well under the SDK's 5000 ms default; the
    // constant is what bounds the window when the terminal flush cannot run.
    expect(DEFAULT_BSP_SCHEDULE_DELAY_MS).toBe(1_000);
  });
});

// ── (e) the source guard: no handle comes from the api globals ───────────────

/**
 * The retired call shapes, assembled from parts so THIS file's own raw bytes do
 * not contain them (the guard scans itself too — no product-source allowlist).
 */
const BANNED_CALL_SHAPES: readonly string[] = [
  ["setGlobal", "TracerProvider"].join(""),
  ["setGlobal", "MeterProvider"].join(""),
  ["setGlobal", "LoggerProvider"].join(""),
  [`${["trace", "getTracer"].join(".")}(`].join(""),
  [`${["metrics", "getMeter"].join(".")}(`].join(""),
  [`${["logs", "getLogger"].join(".")}(`].join(""),
];

function bannedHits(source: string): string[] {
  return BANNED_CALL_SHAPES.filter((token) => source.includes(token));
}

/** Every product module under `src/`, recursively — the guard's whole universe. */
function sourceFiles(directory: string = HERE): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("source guard: no plugin module resolves a handle from the api globals", () => {
  const files = sourceFiles();
  const scanned = files.map((path) => ({ path, source: readFileSync(path, "utf8") }));

  test("the scan universe is the real source tree (not an empty or pruned list)", () => {
    const names = files.map((path) => relative(HERE, path).replace(/\\/g, "/"));
    // Both modules the round-1 defect lived in are in the universe.
    expect(names).toContain("otel.ts");
    expect(names).toContain("index.ts");
    // …and the handler modules every tracer/meter/logger flows through.
    expect(names).toContain("handlers/session.ts");
    expect(names).toContain("handlers/message.ts");
    expect(names).toContain("handlers/tool.ts");
    expect(names.length).toBeGreaterThan(15);
  });

  test("zero banned shapes across every module (test files included)", () => {
    const offenders = scanned
      .map(({ path, source }) => ({ path: relative(HERE, path), hits: bannedHits(source) }))
      .filter((entry) => entry.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  test("non-vacuity: the exact round-1 shape is caught, a clean module is not", () => {
    // The pre-fix lines reduced to their call shapes, assembled from the SAME
    // parts the ban list uses so this file's own bytes stay clean. Every banned
    // token is present exactly once here — so a scanner that failed to see a
    // token would report a short list.
    const roundOne = BANNED_CALL_SHAPES.map((token) => `  ${token}providersExporter);`).join("\n");
    expect(bannedHits(roundOne)).toEqual([...BANNED_CALL_SHAPES]);

    // The post-fix shape passes: handles come from the instances, not the globals.
    const fixed = [
      "const tracer = tracerProvider.getTracer(\"com.fredo.opencode\");",
      "const meter = meterProvider.getMeter(\"com.fredo.opencode\");",
      "const otelLogger = loggerProvider.getLogger(\"com.fredo.opencode\");",
    ].join("\n");
    expect(bannedHits(fixed)).toEqual([]);
  });
});
