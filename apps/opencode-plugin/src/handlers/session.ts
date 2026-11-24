/**
 * handlers/session.ts — session lifecycle handlers (Spec #3197 ST-2).
 *
 * ST-1 SCOPE: typed skeletons only. Every function below is a NO-OP — it emits
 * nothing, mutates nothing and returns a neutral value. ST-2 fills these in
 * (`session.created`, `session.inbox.enqueued`, `session.execution.*`,
 * `session.idle`) so no other sub-task ever has to share this file.
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionCreated              :3333  (data.sessionID :3347, data.parentID :3351,
 *                                           data.agent :3354, data.model :3355, data.title :3353)
 *     · SessionExecutionStarted     :1860  (data.sessionID)
 *     · SessionExecutionSucceeded   :1877  (data.sessionID)
 *     · SessionExecutionFailed      :1894  (data.sessionID, data.error: SessionStructuredError :160)
 *     · SessionExecutionInterrupted :1912  (data.sessionID, data.reason:
 *                                           "user"|"shutdown"|"superseded"|"inactivity")
 *     · SessionIdle                 :2893  (data.sessionID)
 *   Note for ST-2: R-1.4's parent identity is DIRECT in V2 — `data.parentID` on
 *   `session.created` — so the V1 pending-`task` scan is only a fallback for a
 *   payload that omits it.
 */

import type { HandlerContext, V2EventOf } from "../types";

/** `session.created` — registers session identity; child sessions additionally open the session span. */
export function handleSessionCreated(
  event: V2EventOf<"session.created">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.execution.started` — marks a run in flight for the session. */
export function handleExecutionStarted(
  event: V2EventOf<"session.execution.started">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.execution.succeeded` — closes the session span OK and emits the session totals. */
export function handleExecutionSucceeded(
  event: V2EventOf<"session.execution.succeeded">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.execution.failed` — closes the session span with ERROR + the structured error. */
export function handleExecutionFailed(
  event: V2EventOf<"session.execution.failed">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.execution.interrupted` — closes the session span ERROR and sweeps open child spans. */
export function handleExecutionInterrupted(
  event: V2EventOf<"session.execution.interrupted">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.idle` — flush point for anything still open on the session. */
export function handleSessionIdle(
  event: V2EventOf<"session.idle">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/**
 * Resolves a child session's parent from the V2 event stream (fallback path for
 * a `session.created` payload that carries no `data.parentID`).
 */
export function resolveParentSessionId(
  sessionID: string,
  ctx: HandlerContext,
): string | undefined {
  void sessionID;
  void ctx;
  return undefined;
}

/** Records a child-session completion snapshot for the parent's `fredo.tool.task` span. */
export function recordChildCompletion(
  childSessionID: string,
  ctx: HandlerContext,
): void {
  void childSessionID;
  void ctx;
}
