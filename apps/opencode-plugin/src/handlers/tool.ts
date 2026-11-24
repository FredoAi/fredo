/**
 * handlers/tool.ts — tool lifecycle handlers (`fredo.tool.<name>` span family), Spec #3197 ST-4.
 *
 * ST-1 SCOPE: typed skeletons only. Every function below is a NO-OP — it emits
 * nothing. ST-4 fills these in (input accumulation, called/progress/success/
 * failed, arguments/result attributes, the failure path) so ST-5 (commit signal)
 * and ST-2 (child completion) can consume them without sharing a file.
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionToolInputStarted :2225  (data.id, data.name, data.assistantMessageID)
 *     · SessionToolInputDelta   :2577  (data.id, data.delta)
 *     · SessionToolInputEnded   :2245  (data.id, data.text — the full JSON input text)
 *     · SessionToolCalled       :2265  (data.id, data.input: Record<string, any>, data.executed)
 *     · SessionToolProgress     :2592  (data.id, data.metadata: Record<string, JsonValue>)
 *     · SessionToolSuccess      :3035  (data.id, data.content: [ToolContent1, ...],
 *                                       data.metadata, data.executed)
 *     · SessionToolFailed       :3060  (data.id, data.error: SessionStructuredError :160,
 *                                       optional content/metadata, data.executed)
 *   Note for ST-4: the tool NAME arrives on `session.tool.input.started`; the
 *   later events carry only `data.id`, so the name must be remembered per call.
 */

import type { HandlerContext, V2EventOf } from "../types";

/** `session.tool.input.started` — remembers the call id → tool name mapping. */
export function handleToolInputStarted(
  event: V2EventOf<"session.tool.input.started">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.tool.input.delta` — accumulates the streamed JSON argument text (no emission). */
export function handleToolInputDelta(
  event: V2EventOf<"session.tool.input.delta">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.tool.input.ended` — the complete argument text for the call. */
export function handleToolInputEnded(
  event: V2EventOf<"session.tool.input.ended">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.tool.called` — opens the `fredo.tool.<name>` span with the parsed arguments. */
export function handleToolCalled(
  event: V2EventOf<"session.tool.called">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.tool.progress` — diagnostic only; emits nothing (preserved V1 contract). */
export function handleToolProgress(
  event: V2EventOf<"session.tool.progress">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.tool.success` — closes the tool span OK with the result payload. */
export function handleToolSuccess(
  event: V2EventOf<"session.tool.success">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.tool.failed` — closes the tool span ERROR + the exception span event. */
export function handleToolFailed(
  event: V2EventOf<"session.tool.failed">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}
