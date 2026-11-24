/**
 * index.ts — the Fredo OpenCode plugin, OpenCode **V2** entry point (Spec #3197).
 *
 * SURFACE (verified against the pinned package, not guessed):
 *   `node_modules/@opencode/plugin/dist/promise/index.d.ts`
 *     · `export * as Plugin` → `dist/promise/plugin.d.ts`
 *         `interface Plugin { id: string; setup(context: Context): Cleanup | void }`
 *         `define(plugin): Plugin`
 *     · `dist/promise/plugin.d.ts:26-61` → `Context` = `{ app, location, options,
 *       event, session, tool, … }`;  `:62` → `Cleanup = () => Promise<void> | void`
 *     · `dist/promise/event.d.ts:4-6` → `event.subscribe({ types?, signal? })`
 *       returns `AsyncIterable<SelectedEvent<…>>`; `server.connected` is never
 *       delivered.
 *   The event union + every per-event payload shape ships in
 *   `node_modules/@opencode/client/dist/promise/generated/types.d.ts`
 *   (`EventSubscribeOutput = V2Event` :5575, `V2Event` :3973).
 *
 * WHAT THIS FILE DOES IN ST-1
 *   · defines the V2 plugin (`Plugin.define({ id: "fredo", setup })`),
 *   · resolves config with capture DEFAULT-ON and the `FREDO_TELEMETRY` opt-out,
 *   · sets the OTel SDK up exactly as before (`otel.ts` untouched),
 *   · runs ONE detached subscription loop with an `AbortController` cleanup,
 *   · hands every event to the typed handler skeletons (which emit NOTHING yet),
 *   · honours `FREDO_CAPTURE_EVENTS` (one JSON line `{type, event}` per event).
 *
 * There is deliberately NO V1 (hooks-object) export and no `--external` bundle
 * split: the module default-exports the V2 definition and nothing else. Dual
 * export is forbidden by the backlog even though OpenCode ≥1.18.29 supports it.
 *
 * No `client.app.log` call exists anywhere in this plugin — the V2 context has
 * no logging API behind it. Diagnostics go through `log.ts` → `pluginLog`.
 */

import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
import { ROOT_CONTEXT, trace, type Span, type SpanContext } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config";
import { pluginLog } from "./log";
import { probeEndpoint } from "./probe";
import { setupOtel, createInstruments, forceFlushOtel } from "./otel";
import { remoteParentContext } from "./trace-context";
import {
  handleSessionCreated,
  handleSessionInboxEnqueued,
  handleExecutionStarted,
  handleExecutionSucceeded,
  handleExecutionFailed,
  handleExecutionInterrupted,
  handleSessionIdle,
} from "./handlers/session";
import {
  handleStepStarted,
  handleStepEnded,
  handleStepFailed,
  handleTextDelta,
  handleReasoningDelta,
} from "./handlers/message";
import {
  handleToolInputStarted,
  handleToolInputDelta,
  handleToolInputEnded,
  handleToolCalled,
  handleToolProgress,
  handleToolSuccess,
  handleToolFailed,
} from "./handlers/tool";
import { handlePermissionAsked, handlePermissionReplied } from "./handlers/permission";
import type {
  HandlerContext,
  MessageMeta,
  PendingChildCompletion,
  PendingPermission,
  PendingRun,
  PendingToolInput,
  PendingToolSpan,
  PluginContext,
  SessionTotals,
  SessionTurn,
  V2Event,
} from "./types";

const PLUGIN_VERSION: string = (pkg as { version?: string }).version ?? "unknown";

/** The plugin id registered with the V2 host. */
export const PLUGIN_ID = "fredo";

/**
 * Spec #2768 ST-1 TEST SEAM — read ONCE at plugin init, default OFF.
 *
 * When FREDO_SUPPRESS_PARENT_ROUTING=1 in the plugin host (opencode) process
 * environment, the plugin never stamps the self-carried `session.parent_id`
 * routing attribute on child-session spans and never runs the parent backfill —
 * child spans arrive genuinely LEGACY-SHAPED so the Rust adapter's
 * `session.parent_id` → `parent_session_id` mapping no-ops naturally. Test
 * affordance only — no settings UI, no docs entry.
 */
const SUPPRESS_PARENT_ROUTING = process.env["FREDO_SUPPRESS_PARENT_ROUTING"] === "1";

/**
 * Spec #3197 ST-1 capture lever: `FREDO_CAPTURE_EVENTS=<path>`.
 *
 * When set, every received V2 event is appended to `<path>` as one JSON line
 * `{ type, event }` — the only in-repo way to obtain REAL V2 payload shapes and
 * the AC4 failure/interruption evidence path. Default OFF; no other behaviour
 * change. The lever is read per event so a test (or the tester) can arm it
 * without reloading the plugin.
 */
function captureEventTo(path: string, event: V2Event): void {
  try {
    appendFileSync(path, `${JSON.stringify({ type: event.type, event })}\n`);
  } catch (err) {
    pluginLog("warn", "FREDO_CAPTURE_EVENTS append failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Routes one V2 event: capture (when the lever is armed), then dispatch to the
 * typed handler for its type. Unhandled types are ignored deliberately — the
 * subscription is unfiltered, so the host may deliver events this plugin has no
 * opinion about.
 *
 * ST-1 invariant: every branch below lands in a NO-OP skeleton, so this
 * function emits nothing.
 */
export function handleV2Event(event: V2Event, ctx: HandlerContext): void {
  const capturePath = process.env["FREDO_CAPTURE_EVENTS"];
  if (capturePath) captureEventTo(capturePath, event);

  switch (event.type) {
    case "session.created":
      handleSessionCreated(event, ctx);
      break;
    case "session.inbox.enqueued":
      handleSessionInboxEnqueued(event, ctx);
      break;
    case "session.execution.started":
      handleExecutionStarted(event, ctx);
      break;
    case "session.execution.succeeded":
      handleExecutionSucceeded(event, ctx);
      break;
    case "session.execution.failed":
      handleExecutionFailed(event, ctx);
      break;
    case "session.execution.interrupted":
      handleExecutionInterrupted(event, ctx);
      break;
    case "session.idle":
      handleSessionIdle(event, ctx);
      break;
    case "session.step.started":
      handleStepStarted(event, ctx);
      break;
    case "session.step.ended":
      handleStepEnded(event, ctx);
      break;
    case "session.step.failed":
      handleStepFailed(event, ctx);
      break;
    case "session.text.delta":
      handleTextDelta(event, ctx);
      break;
    case "session.reasoning.delta":
      handleReasoningDelta(event, ctx);
      break;
    case "session.tool.input.started":
      handleToolInputStarted(event, ctx);
      break;
    case "session.tool.input.delta":
      handleToolInputDelta(event, ctx);
      break;
    case "session.tool.input.ended":
      handleToolInputEnded(event, ctx);
      break;
    case "session.tool.called":
      handleToolCalled(event, ctx);
      break;
    case "session.tool.progress":
      handleToolProgress(event, ctx);
      break;
    case "session.tool.success":
      handleToolSuccess(event, ctx);
      break;
    case "session.tool.failed":
      handleToolFailed(event, ctx);
      break;
    case "permission.asked":
      handlePermissionAsked(event, ctx);
      break;
    case "permission.replied":
      handlePermissionReplied(event, ctx);
      break;
    default:
      break;
  }
}

/**
 * The V2 plugin definition. `setup` runs once per plugin host process; the
 * returned cleanup aborts the event loop and shuts the OTel providers down.
 */
export const fredoPluginDefinition = Plugin.define({
  id: PLUGIN_ID,
  async setup(context: PluginContext) {
    const config = loadConfig(context.options);

    // Opt-out path: SILENT (R-5). No spans, no metrics, no log records, no
    // diagnostics — and no OTel provider is registered, so nothing can flush.
    if (!config.enabled) return;

    // Exactly ONE startup diagnostic on the enabled path, at `info`: the default
    // floor is `warn`, so a healthy session prints nothing (NFR-3).
    pluginLog("info", "starting", {
      version: PLUGIN_VERSION,
      endpoint: config.endpoint,
      protocol: config.protocol,
      pluginID: PLUGIN_ID,
      opencode: context.app?.version,
    });

    // Best-effort reachability probe. Kept (probe.ts semantics unchanged) but
    // reported at `debug` so an unreachable receiver never becomes user-visible
    // noise (NFR-1/NFR-3).
    const probe = await probeEndpoint(config.endpoint);
    if (!probe.ok) {
      pluginLog("debug", "OTLP endpoint unreachable at startup", {
        endpoint: config.endpoint,
        error: probe.error,
      });
    }

    const providers = await setupOtel(
      config.endpoint,
      config.protocol,
      config.metricsInterval,
      config.logsInterval,
      PLUGIN_VERSION,
    );
    const { meterProvider, loggerProvider, tracerProvider } = providers;

    const instruments = createInstruments(config.metricPrefix);
    const otelLogger = logs.getLogger("com.fredo.opencode");
    const tracer = trace.getTracer("com.fredo.opencode");
    const remoteContext = remoteParentContext(config.traceparent, config.tracestate);
    if (config.traceparent && !remoteContext) {
      pluginLog("warn", "invalid traceparent ignored", {
        traceparentLength: config.traceparent.length,
      });
    }
    const rootContext = remoteContext ? () => remoteContext : () => ROOT_CONTEXT;

    // ── In-Memory State Maps (bounded via util.setBoundedMap) ────────────
    const pendingToolSpans = new Map<string, PendingToolSpan>();
    const pendingToolInputs = new Map<string, PendingToolInput>();
    const pendingPermissions = new Map<string, PendingPermission>();
    const sessionTotals = new Map<string, SessionTotals>();
    const sessionTurns = new Map<string, SessionTurn>();
    const runSpans = new Map<string, Span>();
    const runSpanContexts = new Map<string, SpanContext>();
    const activeRuns = new Map<string, string>();
    const assistantRuns = new Map<string, string>();
    const pendingRuns = new Map<string, PendingRun>();
    const runInputs = new Map<string, string>();
    const sessionSpans = new Map<string, Span>();
    const sessionSpanContexts = new Map<string, SpanContext>();
    const messageSpans = new Map<string, Span>();
    const messageOutputs = new Map<string, string>();
    const messageThinking = new Map<string, string>();
    const pendingSubagentInstructions = new Map<string, string>();
    const messageMeta = new Map<string, MessageMeta>();
    const pendingChildCompletions = new Map<string, PendingChildCompletion>();

    const ctx: HandlerContext = {
      log: pluginLog,
      emitLog: (record) => {
        otelLogger.emit(record);
      },
      instruments,
      pendingToolSpans,
      pendingToolInputs,
      pendingPermissions,
      sessionTotals,
      sessionTurns,
      tracer,
      tracePrefix: "fredo.",
      rootContext,
      runSpans,
      runSpanContexts,
      activeRuns,
      assistantRuns,
      pendingRuns,
      runInputs,
      sessionSpans,
      sessionSpanContexts,
      messageSpans,
      messageOutputs,
      messageThinking,
      pendingSubagentInstructions,
      messageMeta,
      pendingChildCompletions,
      suppressParentRouting: SUPPRESS_PARENT_ROUTING,
      // `session.idle` flush seam (ST-2) — the exporter flush point V1 performed
      // inline at `session.idle`/`session.error`.
      onIdleFlush: () => forceFlushOtel(providers),
    };

    // ── Detached event loop ──────────────────────────────────────────────
    // The loop must never block setup (prompt admission): it is started and
    // intentionally NOT awaited, and every event/frame error is contained
    // (NFR-1) so a failing handler or a dropped transport cannot break the
    // session.
    const controller = new AbortController();

    const runEventLoop = async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          try {
            handleV2Event(event, ctx);
          } catch (err) {
            pluginLog("warn", "handler failed", {
              type: event.type,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          pluginLog("warn", "event subscription ended", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    void runEventLoop();

    let cleanedUp = false;
    return async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      controller.abort();
      await forceFlushOtel(providers);
      await Promise.allSettled([
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
        tracerProvider.shutdown(),
      ]);
    };
  },
});

export default fredoPluginDefinition;
