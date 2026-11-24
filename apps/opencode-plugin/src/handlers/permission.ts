/**
 * handlers/permission.ts — permission handlers (`tool_decision` log body), Spec #3197 ST-5.
 *
 * ST-1 SCOPE: typed skeletons only. Every function below is a NO-OP — it emits
 * nothing. ST-5 fills these in (remember the ask, map the reply to
 * accept/reject, emit the `tool_decision` log record).
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · PermissionAsked   :2645  (data.id: PermissionID, data.sessionID, data.action,
 *                                 data.resources: string[], data.save?, data.metadata?,
 *                                 data.source?: PermissionSource :428, data.message?)
 *     · PermissionReplied :2666  (data.sessionID, data.requestID: PermissionID,
 *                                 data.reply: PermissionReply :441 =
 *                                 "once" | "always" | "reject")
 *   Note for ST-5: the V1 `allow`/`allowAlways` → `accept` mapping becomes
 *   `once`/`always` → `accept`, `reject` → `reject`; there is no V2
 *   `permission.updated` event — the ask is `permission.asked`.
 */

import type { HandlerContext, V2EventOf } from "../types";

/** `permission.asked` — remembers the pending request (no emission). */
export function handlePermissionAsked(
  event: V2EventOf<"permission.asked">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `permission.replied` — emits the `tool_decision` log record. */
export function handlePermissionReplied(
  event: V2EventOf<"permission.replied">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}
