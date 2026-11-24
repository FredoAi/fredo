/**
 * handlers/message.ts — model-turn handlers (`fredo.llm` span family), Spec #3197 ST-3.
 *
 * ST-1 SCOPE: typed skeletons only. Every function below is a NO-OP — it emits
 * nothing. ST-3 fills these in (step start/end/fail, streamed text and reasoning,
 * usage, metrics, logs) so no other sub-task ever has to share this file.
 *
 * Payload contract (verified against the installed typings, not guessed):
 *   node_modules/@opencode/client/dist/promise/generated/types.d.ts
 *     · SessionStepStarted   :2035  (data.sessionID, data.assistantMessageID,
 *                                    data.agent, data.model: ModelRef :615, data.started)
 *     · SessionStepEnded     :2093  (data.finish :2109, data.rawFinish, data.cost :83,
 *                                    data.tokens: TokenUsageInfo :84 → {input,output,
 *                                    reasoning,cache:{read,write}})
 *     · SessionStepFailed    :2118  (data.error: SessionStructuredError :160,
 *                                    optional cost/tokens)
 *     · SessionTextDelta     :2547  (data.delta, data.ordinal)
 *     · SessionReasoningDelta:2562  (data.delta, data.ordinal)
 *     · SessionStepFirstToken:2057 / SessionStepStreamed :2075 (TTFC + cadence marks)
 *   Note for ST-3: V2 `TokenUsageInfo` mirrors the V1 usage shape exactly, so
 *   `util.ts` → `accumulateSessionTotals` consumes it unchanged.
 */

import type { HandlerContext, V2EventOf } from "../types";

/** Starts the `fredo.llm` span for one model step. */
export function startLlmSpan(
  sessionID: string,
  assistantMessageID: string,
  agent: string,
  model: string,
  startedMs: number,
  ctx: HandlerContext,
): void {
  void sessionID;
  void assistantMessageID;
  void agent;
  void model;
  void startedMs;
  void ctx;
}

/** `session.step.started` — opens the step's `fredo.llm` span. */
export function handleStepStarted(
  event: V2EventOf<"session.step.started">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.step.ended` — closes the `fredo.llm` span OK with usage/cost/content. */
export function handleStepEnded(
  event: V2EventOf<"session.step.ended">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.step.failed` — closes the `fredo.llm` span ERROR + the exception span event. */
export function handleStepFailed(
  event: V2EventOf<"session.step.failed">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.text.delta` — accumulates assistant text (no emission per chunk). */
export function handleTextDelta(
  event: V2EventOf<"session.text.delta">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}

/** `session.reasoning.delta` — accumulates assistant reasoning (no emission per chunk). */
export function handleReasoningDelta(
  event: V2EventOf<"session.reasoning.delta">,
  ctx: HandlerContext,
): void {
  void event;
  void ctx;
}
