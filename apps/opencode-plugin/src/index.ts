/**
 * Fredo OpenCode Plugin — OTLP metrics, logs, and traces export.
 *
 * Exports full OTLP telemetry following the Claude Code monitoring schema.
 * Replaces the previous CLI-based event forwarding with direct OTLP export
 * via OpenTelemetry SDK providers.
 *
 * Plugin format: async function returning hooks object (OpenCode v1.15+).
 *
 * Hooks registered:
 *   - event: session.created, session.idle, session.error, message.updated,
 *            message.part.updated, permission.updated, permission.replied,
 *            command.executed
 *   - chat.message: user prompt capture
 *   - config: log level runtime updates
 *
 * NOT registered: experimental.compaction.autocontinue (REQ-16)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { ROOT_CONTEXT, trace, type Span, type SpanContext } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import pkg from "../package.json" with { type: "json" };
import {
  LOG_SESSION_CREATED,
  LOG_SESSION_IDLE,
  LOG_SESSION_ERROR,
  LOG_USER_PROMPT,
} from "./telemetry-constants";
import { loadConfig } from "./config";
import { probeEndpoint } from "./probe";
import { setupOtel, createInstruments, forceFlushOtel } from "./otel";
import { remoteParentContext } from "./trace-context";
import {
  handleSessionCreated,
  handleSessionIdle,
  handleSessionError,
  handleRunStarted,
} from "./handlers/session";
import {
  handleMessageUpdated,
  handleMessagePartUpdated,
  startMessageSpan,
} from "./handlers/message";
import { handlePermissionUpdated, handlePermissionReplied } from "./handlers/permission";
import { handleCommandExecuted } from "./handlers/activity";
import { setBoundedMap, getSessionAgentMeta, agentAttrs } from "./util";
import type { FredoPluginOptions } from "./telemetry-constants";
import { LEVELS } from "./types";
import type {
  SessionTotals,
  SessionAgentType,
  HandlerContext,
  Level,
  PendingToolSpan,
  PendingPermission,
  PendingRun,
  MessageMeta,
} from "./types";

const PLUGIN_VERSION: string = (pkg as { version?: string }).version ?? "unknown";

/**
 * OpenCode plugin that exports session telemetry via OpenTelemetry (OTLP over gRPC).
 * Instruments metrics (sessions, tokens, cost, tool durations) and structured log events.
 * All instrumentation is gated on OPENCODE_ENABLE_TELEMETRY or `enabled: true`.
 */
const FredoPlugin: Plugin = async (
  { client, directory, worktree },
  options: unknown,
) => {
  const config = loadConfig(options as FredoPluginOptions);
  let minLevel: Level = "info";

  const log: HandlerContext["log"] = async (level, message, extra) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    await client.app.log({ body: { service: "fredo-opencode-plugin", level, message, extra } });
  };

  // Diagnostic: emit startup context to console (always visible in opencode CLI output)
  const enableTelemetryEnv = process.env["OPENCODE_ENABLE_TELEMETRY"] ?? "(not set)";
  const otlpEndpointEnv = process.env["OPENCODE_OTLP_ENDPOINT"] ?? "(not set)";
  const hasOptionsEnabled = typeof (options as any)?.enabled === "boolean";
  const optionsEnabledVal = hasOptionsEnabled ? String((options as any).enabled) : "(not provided)";

  console.error(`\n[fredo-opencode-plugin] v${PLUGIN_VERSION} starting`);
  console.error(`[fredo-opencode-plugin]   enabled (resolved): ${config.enabled}`);
  console.error(`[fredo-opencode-plugin]   enabled (options):  ${optionsEnabledVal}${hasOptionsEnabled ? "" : " — options tuple not provided (auto-discovered plugin)"}`);
  console.error(`[fredo-opencode-plugin]   OPENCODE_ENABLE_TELEMETRY: ${enableTelemetryEnv}`);
  console.error(`[fredo-opencode-plugin]   OPENCODE_OTLP_ENDPOINT:    ${otlpEndpointEnv}`);
  console.error(`[fredo-opencode-plugin]   directory: ${directory}\n`);

  if (!config.enabled) {
    console.error("[fredo-opencode-plugin] ❌ TELEMETRY DISABLED");
    console.error("[fredo-opencode-plugin]    OPENCODE_ENABLE_TELEMETRY env var not set to '1'");
    console.error("[fredo-opencode-plugin]    Plugin was loaded but all hooks are empty — no telemetry will be exported.");
    console.error("[fredo-opencode-plugin]    Fix: (1) set OPENCODE_ENABLE_TELEMETRY=1 in your shell, or");
    console.error("[fredo-opencode-plugin]         (2) run 'fredo setup --install-plugin' via the Fredo Setup Wizard.\n");
    await log("warn", "telemetry disabled — no hooks registered", {
      reason: "OPENCODE_ENABLE_TELEMETRY env var not set or not '1'",
      opencode_enable_telemetry: enableTelemetryEnv,
      options_enabled: hasOptionsEnabled ? optionsEnabledVal : "not provided",
      loaded_from: hasOptionsEnabled ? "opencode.json plugin array" : "auto-discovery (~/.config/opencode/plugins/fredo.js)",
      fix: "set OPENCODE_ENABLE_TELEMETRY=1 or run 'fredo setup --install-plugin'",
    });
    return {};
  }

  await log("info", "fredo-opencode-plugin starting", {
    version: PLUGIN_VERSION,
    endpoint: config.endpoint,
    protocol: config.protocol,
    metricsInterval: config.metricsInterval,
    logsInterval: config.logsInterval,
    metricPrefix: config.metricPrefix,
    loaded_from: hasOptionsEnabled ? "opencode.json plugin array" : "auto-discovery (~/.config/opencode/plugins/fredo.js)",
    opencode_enable_telemetry: enableTelemetryEnv,
  });
  console.error(`[fredo-opencode-plugin] ✅ Telemetry ENABLED — exporting to ${config.endpoint} (${config.protocol})\n`);

  const probe = await probeEndpoint(config.endpoint);
  if (probe.ok) {
    await log("info", "OTLP endpoint reachable", { endpoint: config.endpoint, ms: probe.ms });
  } else {
    await log("warn", "OTLP endpoint unreachable — exports may fail", {
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
  await log("info", "OTel SDK initialized");

  const instruments = createInstruments(config.metricPrefix);
  const logger = logs.getLogger("com.fredo.opencode");
  const emitLog: HandlerContext["emitLog"] = (record) => {
    logger.emit(record);
  };
  const tracer = trace.getTracer("com.fredo.opencode");
  const remoteContext = remoteParentContext(config.traceparent, config.tracestate);
  if (config.traceparent && !remoteContext) {
    await log("warn", "invalid traceparent ignored", { traceparentLength: config.traceparent.length });
  }
  const rootContext = remoteContext ? () => remoteContext : () => ROOT_CONTEXT;

  // ── In-Memory State Maps ──────────────────────────────────────────────
  const pendingToolSpans = new Map<string, PendingToolSpan>();
  const pendingPermissions = new Map<string, PendingPermission>();
  const sessionTotals = new Map<string, SessionTotals>();
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

  const ctx: HandlerContext = {
    log,
    emitLog,
    instruments,
    pendingToolSpans,
    pendingPermissions,
    sessionTotals,
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
  };

  let shuttingDown = false;

  async function flushTelemetry(reason: string) {
    if (shuttingDown) return;
    await forceFlushOtel(providers);
    await log("debug", "otel: telemetry flushed", { reason });
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await forceFlushOtel(providers);
    await Promise.allSettled([
      meterProvider.shutdown(),
      loggerProvider.shutdown(),
      tracerProvider.shutdown(),
    ]);
  }

  process.on("SIGTERM", () => {
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.on("beforeExit", () => { shutdown().catch(() => {}); });

  const safe = <T extends unknown[]>(
    name: string,
    fn: (...args: T) => Promise<void> | void,
  ): ((...args: T) => Promise<void>) =>
    async (...args: T) => {
      try {
        await fn(...args);
      } catch (err) {
        await log("error", `otel: unhandled error in ${name}`, {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    };

  return {
    config: async (cfg: { logLevel?: string }) => {
      if (cfg.logLevel) {
        const candidate = cfg.logLevel.toLowerCase();
        if (candidate in LEVELS) {
          const next = candidate as Level;
          if (next !== minLevel) {
            minLevel = next;
            await log("info", `log level set to "${minLevel}"`);
          }
        } else {
          await log("warn", `unknown log level "${cfg.logLevel}", keeping "${minLevel}"`);
        }
      }
    },

    "chat.message": safe("chat.message", async (input: any, output: any) => {
      const agent = input.agent ?? "unknown";
      const startTime = Date.now();
      const existingTotals = sessionTotals.get(input.sessionID);
      const nextTotals: SessionTotals = {
        startMs: existingTotals?.startMs ?? startTime,
        tokens: existingTotals?.tokens ?? 0,
        cost: existingTotals?.cost ?? 0,
        messages: existingTotals?.messages ?? 0,
        agent,
        agentType: existingTotals?.agentType ?? ("unknown" as SessionAgentType),
        parentId: existingTotals?.parentId,
        // EARS-9 counters — carried through this field-by-field reconstruction
        // so a chat.message never silently resets them to zero.
        inferenceCalls: existingTotals?.inferenceCalls ?? 0,
        toolCalls: existingTotals?.toolCalls ?? 0,
      };
      setBoundedMap(sessionTotals, input.sessionID, nextTotals);
      const { agentType } = getSessionAgentMeta(input.sessionID, ctx);
      const sessionSpan = sessionSpans.get(input.sessionID);
      if (sessionSpan) {
        sessionSpan.setAttributes({ agent, "agent.type": agentType });
      }

      const promptText = (output?.parts ?? [])
        .map((part: any) => {
          switch (part.type) {
            case "text": return part.text;
            case "file": return part.filename ?? part.url;
            case "agent": return part.name;
            case "subtask": return part.description;
            default: return "";
          }
        })
        .filter(Boolean)
        .join("\n");

      if (!sessionSpan) {
        const model = input.model
          ? `${input.model.providerID}/${input.model.modelID}`
          : "unknown";
        if (input.messageID) {
          handleRunStarted(
            input.messageID,
            input.sessionID,
            agent,
            promptText,
            model,
            startTime,
            ctx,
          );
        } else {
          setBoundedMap(pendingRuns, input.sessionID, {
            agent,
            promptText,
            model,
            startTime,
          });
        }
      }

      const promptLength = promptText.length;
      emitLog({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        timestamp: startTime,
        observedTimestamp: startTime,
        body: LOG_USER_PROMPT,
        attributes: {
          "event.name": LOG_USER_PROMPT,
          "session.id": input.sessionID,
          ...agentAttrs(agent, agentType),
          prompt_length: promptLength,
          model: input.model
            ? `${input.model.providerID}/${input.model.modelID}`
            : "unknown",
        },
      });
    }),

    event: safe("event", async ({ event }: { event: any }) => {
      switch (event.type) {
        case "session.created":
          await handleSessionCreated(event, ctx);
          break;
        case "session.idle":
          handleSessionIdle(event, ctx);
          await flushTelemetry("session.idle");
          break;
        case "session.error":
          handleSessionError(event, ctx);
          await flushTelemetry("session.error");
          break;
        case "message.updated": {
          const msgEvt = event;
          const info = msgEvt.properties.info;
          if (info.role === "user") {
            const pendingRun = pendingRuns.get(info.sessionID);
            if (!sessionSpans.has(info.sessionID) &&
                (pendingRun || activeRuns.get(info.sessionID) !== info.id)) {
              handleRunStarted(
                info.id,
                info.sessionID,
                pendingRun?.agent ?? info.agent,
                pendingRun?.promptText ?? "",
                pendingRun?.model ??
                  `${info.model?.providerID ?? "unknown"}/${info.model?.modelID ?? "unknown"}`,
                pendingRun?.startTime ?? info.time.created,
                ctx,
              );
            }
            break;
          }
          if (info.role === "assistant" && !info.time?.completed) {
            startMessageSpan(
              info.sessionID,
              info.id,
              info.parentID,
              info.modelID ?? "unknown",
              info.providerID ?? "unknown",
              info.time?.created ?? Date.now(),
              ctx,
            );
          }
          await handleMessageUpdated(msgEvt, ctx);
          if (info.role === "assistant" && info.time?.completed) {
            await flushTelemetry("message.completed");
          }
          break;
        }
        case "message.part.updated":
          await handleMessagePartUpdated(event, ctx);
          break;
        case "permission.updated":
          handlePermissionUpdated(event, ctx);
          break;
        case "permission.replied":
          handlePermissionReplied(event, ctx);
          break;
        case "command.executed":
          handleCommandExecuted(event, ctx);
          break;
      }
    }),
  };
};

export default FredoPlugin;
export { FredoPlugin };
