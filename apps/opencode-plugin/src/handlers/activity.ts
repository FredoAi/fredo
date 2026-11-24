/**
 * handlers/activity.ts — activity signal handlers (the `commit` log body), Spec #3197 ST-5.
 *
 * WHY THIS FILE DERIVES INSTEAD OF LISTENING
 * V2 has **no `command.executed`** event (the V1 hook this file replaced), so the
 * git-commit signal is derived from the tool lifecycle: when the tool is the
 * shell tool and its input carries a `git commit` invocation, the `commit` log
 * record is emitted — exactly what the V1 handler produced on `main`
 * (`handlers/activity.ts:17-45`). The signal stays a LOG record
 * (`event.name=commit`, `session.id`, agent attrs): **never a span, never a
 * row** (the classifier projects spans into rows, so a span here would be a new
 * observable the consumer does not know).
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionToolCalled    :2265 — `data.name` does NOT exist; the tool name
 *                              arrives on `SessionToolInputStarted.data.name`
 *                              :2242 (`session.tool.input.started`) and is
 *                              remembered by `tool.ts`. `data.input` is
 *                              `{ [x: string]: any }` (:2282-2284) — an UNTYPED
 *                              bag: the shipped typings expose **no** per-tool
 *                              input schema (the tool registry's schema lives on
 *                              `Plugin.Context.tool.list()`, i.e. at runtime, not
 *                              in these `.d.ts` files), so there is no field name
 *                              to bind for the shell command.
 *     · SessionToolInputEnded :2245 — `data.text: string` (:2262) is the complete
 *                              argument text as a JSON string.
 *   Because no field name is shipped, `extractCommandText` is deliberately
 *   FIELD-AGNOSTIC: it walks the bag (string / array / nested object — the shape
 *   varies with the tool schema) and flattens its string leaves, so a
 *   `{command: "git commit …"}`, an argv array and a nested-argument object all
 *   resolve without guessing a key. The match itself stays the FROZEN V1 rule
 *   (`GIT_COMMIT_RE`, copied verbatim).
 *
 * STILL UNVERIFIED (declared, not papered over): the exact field carrying the
 * command inside `data.input` is the plan's Phase-0 item, and the shell tool's
 * NAME in V2 is only corroborated in-repo (`bash` — the permission/tool-key
 * vocabulary at `research/02-vendor-docs-agent-files.md:130` and the V1
 * handler's own `name !== "bash"` guard). The tester's `FREDO_CAPTURE_EVENTS`
 * JSONL from a real `git commit` session corroborates both; a name that differs
 * would be a one-constant correction here, never a silent guess.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR_SESSION_ID, LOG_COMMIT } from "../telemetry-constants";
import { agentAttrs, getSessionAgentMeta } from "../util";
import type { HandlerContext } from "../types";

/** The frozen git-commit detection rule (copied verbatim from the V1 handler). */
export const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/;

/**
 * The V2 shell tool's name. The permission/tool-key vocabulary lists `bash`
 * (`research/02-vendor-docs-agent-files.md:130`) and the V1 handler gated on the
 * same name (`handlers/activity.ts:23` on `main`) — see the file header for the
 * corroboration this still owes the tester's capture.
 */
const SHELL_TOOL_NAME = "bash";

/** Depth-first walk collecting the non-empty string leaves of an arbitrary value. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
}

/**
 * Flattens a V2 tool-call input into the text a commit match is tested against.
 *
 * The typings ship `data.input` as an untyped bag (`types.d.ts:2282-2284`), so
 * this never trusts a field name: a bare string, an argv/token array and a
 * nested argument object all contribute their string leaves, joined by a
 * newline. Non-string scalars (numbers, booleans, null) contribute nothing.
 */
export function extractCommandText(input: unknown): string {
  const parts: string[] = [];
  collectStrings(input, parts);
  return parts.join("\n");
}

/**
 * Emits the `commit` log record when a shell-tool call carries a `git commit`.
 *
 * A non-shell tool never matches (the name is checked first — a `read` of a file
 * whose name mentions a commit is not a commit), and an unmatched command emits
 * nothing at all.
 */
export function handleToolCommandForCommit(
  toolName: string,
  commandText: string,
  sessionID: string,
  ctx: HandlerContext,
): void {
  if (toolName !== SHELL_TOOL_NAME) return;
  if (!commandText) return;
  if (!GIT_COMMIT_RE.test(commandText)) {
    ctx.log("debug", "otel: shell command is not a commit", { sessionID });
    return;
  }

  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx);
  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: LOG_COMMIT,
    attributes: {
      "event.name": LOG_COMMIT,
      [ATTR_SESSION_ID]: sessionID,
      ...agentAttrs(agentName, agentType),
    },
  });
  ctx.log("debug", "otel: commit log event emitted", { sessionID });
}
