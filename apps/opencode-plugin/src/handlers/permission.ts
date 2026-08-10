/**
 * handlers/permission.ts — Permission prompt handlers for the Fredo OpenCode plugin.
 *
 * Handles permission.updated and permission.replied events.
 * Stores pending permissions and emits tool_decision log events.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_SESSION_ID,
  ATTR_TOOL_NAME,
  LOG_TOOL_DECISION,
} from "../telemetry-constants";
import { agentAttrs, getSessionAgentMeta, setBoundedMap } from "../util";
import type { HandlerContext } from "../types";

/** Stores a pending permission prompt for correlation with its reply. */
export function handlePermissionUpdated(
  e: { properties: { id: string; type: string; title: string; sessionID: string } },
  ctx: HandlerContext,
) {
  const perm = e.properties;
  setBoundedMap(ctx.pendingPermissions, perm.id, {
    type: perm.type,
    title: perm.title,
    sessionID: perm.sessionID,
  });
  ctx.log("debug", "otel: permission stored", {
    permissionID: perm.id,
    sessionID: perm.sessionID,
    type: perm.type,
    title: perm.title,
  });
}

/** Emits a tool_decision log event recording whether the permission was accepted or rejected. */
export function handlePermissionReplied(
  e: { properties: { permissionID: string; sessionID: string; response: string } },
  ctx: HandlerContext,
) {
  const { permissionID, sessionID, response } = e.properties;
  const pending = ctx.pendingPermissions.get(permissionID);
  ctx.pendingPermissions.delete(permissionID);
  const decision = response === "allow" || response === "allowAlways" ? "accept" : "reject";
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: LOG_TOOL_DECISION,
    attributes: {
      "event.name": LOG_TOOL_DECISION,
      [ATTR_SESSION_ID]: sessionID,
      [ATTR_TOOL_NAME]: pending?.title ?? "unknown",
      tool_type: pending?.type ?? "unknown",
      decision,
      source: response,
      ...agentAttrs(agentName, agentType),
    },
  });
  ctx.log("debug", "otel: tool_decision emitted", {
    permissionID,
    sessionID,
    decision,
    source: response,
    tool_name: pending?.title ?? "unknown",
  });
}
