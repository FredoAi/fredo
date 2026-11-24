/**
 * handlers/permission.ts — permission handlers (`tool_decision` log body), Spec #3197 ST-5.
 *
 * V1 listened to `permission.updated` + `permission.replied`; V2 has
 * `permission.asked` + `permission.replied` and no `updated`. The emitted
 * contract is the V1 one (`handlers/permission.ts:34-70` on `main`): a single
 * `tool_decision` log record carrying `event.name`, `session.id`, `tool_name`,
 * `tool_type`, `decision`, `source` and the agent attrs. Nothing else — no span,
 * no metric, no row. The ask itself emits nothing (V1 stored it and emitted on
 * the reply).
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · PermissionAsked   :2645  (data.id: PermissionID :427, data.sessionID,
 *                                 data.action: string, data.resources: string[],
 *                                 data.save?, data.metadata?, data.source?:
 *                                 PermissionSource :428 = {type:"tool", messageID, id},
 *                                 data.message?)
 *     · PermissionReplied :2666  (data.sessionID, data.requestID: PermissionID,
 *                                 data.reply: PermissionReply :441 =
 *                                 "once" | "always" | "reject")
 *   The V2 ask carries NO `title`/`type` (V1's fields). `action` is the
 *   permission/tool key (`bash`, `edit`, …) — the `tool_type` analogue — and
 *   `resources` is the human-readable subject, which is what V1 put in
 *   `tool_name` via `permission.title`. Neither value is invented: both come
 *   straight off the payload.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_SESSION_ID,
  ATTR_TOOL_NAME,
  LOG_TOOL_DECISION,
} from "../telemetry-constants";
import { agentAttrs, getSessionAgentMeta, setBoundedMap } from "../util";
import type { HandlerContext, V2EventOf } from "../types";

/**
 * Replies that mean the request was ACCEPTED.
 *
 * `allow`/`allowAlways` are the V1 vocabulary and are preserved verbatim; the V2
 * replies are `once`/`always` (`PermissionReply`, types.d.ts:441). Everything
 * else (`reject`) is a rejection — the same default-to-reject rule V1 used, so
 * an unrecognised reply can never be recorded as an acceptance.
 */
const ACCEPT_REPLIES: ReadonlySet<string> = new Set(["allow", "allowAlways", "once", "always"]);

/** `permission.asked` — remembers the pending request (no emission). */
export function handlePermissionAsked(
  event: V2EventOf<"permission.asked">,
  ctx: HandlerContext,
): void {
  const { id, sessionID, action, resources, message } = event.data;
  // V2 has no `title`: the resource list is the request's human-readable subject
  // (V1's `permission.title`), with the request's own message as the fallback
  // and the action as the last resort — never a fabricated placeholder.
  const title = resources.length > 0 ? resources.join(", ") : (message ?? action);
  setBoundedMap(ctx.pendingPermissions, id, { type: action, title, sessionID });
  ctx.log("debug", "otel: permission stored", {
    permissionID: id,
    sessionID,
    action,
    resourceCount: resources.length,
  });
}

/** `permission.replied` — emits the `tool_decision` log record. */
export function handlePermissionReplied(
  event: V2EventOf<"permission.replied">,
  ctx: HandlerContext,
): void {
  const { sessionID, requestID, reply } = event.data;
  const pending = ctx.pendingPermissions.get(requestID);
  ctx.pendingPermissions.delete(requestID);
  const decision = ACCEPT_REPLIES.has(reply) ? "accept" : "reject";
  const toolName = pending?.title ?? "unknown";
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: event.created,
    observedTimestamp: Date.now(),
    body: LOG_TOOL_DECISION,
    attributes: {
      "event.name": LOG_TOOL_DECISION,
      [ATTR_SESSION_ID]: sessionID,
      [ATTR_TOOL_NAME]: toolName,
      tool_type: pending?.type ?? "unknown",
      decision,
      source: reply,
      ...agentAttrs(agentName, agentType),
    },
  });
  ctx.log("debug", "otel: tool_decision emitted", {
    requestID,
    sessionID,
    decision,
    source: reply,
    tool_name: toolName,
  });
}
