/**
 * handlers/activity.ts — Activity handlers (code diff, commits) for the Fredo OpenCode plugin.
 *
 * Handles command.executed events to detect git commits and increment the
 * commit counter. session.diff events are acknowledged but not instrumented
 * (no lines_of_code metrics in the stripped config).
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_SESSION_ID,
  LOG_COMMIT,
} from "../contract_601";
import { agentAttrs, getSessionAgentMeta } from "../util";
import type { HandlerContext } from "../types";

const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/;

/** Detects git commit invocations in bash tool calls and emits a commit log event. */
export function handleCommandExecuted(
  e: { properties: { sessionID: string; name: string; arguments: string } },
  ctx: HandlerContext,
) {
  if (e.properties.name !== "bash") return;
  ctx.log("debug", "otel: command.executed (bash)", {
    sessionID: e.properties.sessionID,
    argumentsLength: e.properties.arguments.length,
  });
  if (!GIT_COMMIT_RE.test(e.properties.arguments)) return;
  const { agentName, agentType } = getSessionAgentMeta(e.properties.sessionID, ctx);

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: LOG_COMMIT,
    attributes: {
      "event.name": LOG_COMMIT,
      [ATTR_SESSION_ID]: e.properties.sessionID,
      ...agentAttrs(agentName, agentType),
    },
  });
  ctx.log("debug", "otel: commit log event emitted", { sessionID: e.properties.sessionID });
}
