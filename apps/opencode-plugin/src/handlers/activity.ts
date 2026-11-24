/**
 * handlers/activity.ts — activity signal handlers (the `commit` log body), Spec #3197 ST-5.
 *
 * ST-1 SCOPE: typed skeleton only. `handleToolCommandForCommit` is a NO-OP — it
 * emits nothing. The regex it consumes is REAL and unchanged: it is the frozen
 * detection rule the V1 `command.executed` handler used
 * (handlers/activity.ts:17 on `main`), and ST-5 re-points it at the V2 tool
 * lifecycle (there is no V2 command event).
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionToolCalled  :2265  (data.input: Record<string, any> — the shell
 *                                  tool's command text lives inside this object)
 *     · SessionToolSuccess :3035  / SessionToolFailed :3060
 *   Note for ST-5: the exact field carrying the command inside `data.input` is
 *   still UNVERIFIED (it is the plan's Phase-0 item). Take it from the tester's
 *   `FREDO_CAPTURE_EVENTS` JSONL — never guess a field name in the emitted path.
 *   The signal stays a LOG record (`event.name=commit`, `session.id`, agent
 *   attrs): never a span, never a row.
 */

import type { HandlerContext } from "../types";

/** The frozen git-commit detection rule (copied verbatim from the V1 handler). */
export const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/;

/** Emits the `commit` log record when a shell tool call is a `git commit`. */
export function handleToolCommandForCommit(
  toolName: string,
  commandText: string,
  sessionID: string,
  ctx: HandlerContext,
): void {
  void toolName;
  void commandText;
  void sessionID;
  void ctx;
}
