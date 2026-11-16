/**
 * Spec #2892 ST-3 — THE ONE pure dispatch contract for a launcher/companion send.
 *
 * Why this module exists (REQ-5/REQ-6/REQ-7): the launcher bar and the companion
 * entity must agree on what a send MEANS while a reply generation is in flight
 * (queue it, or interrupt), on what the FIFO queue guarantees (ordered,
 * exactly-once), and on the waiting copy/testid the bar renders. Encoding that as
 * a pure module lets the queue + resolver be unit-pinned without a React harness,
 * and gives both sides ONE acceptance vocabulary (`CompanionSendResult`).
 *
 * Pure by construction: no React, no DOM, no Tauri, no timers, no side effects —
 * mirroring the `launcherEnterAction.ts` discipline.
 *
 * `CompanionSendDisposition` is OWNED by `CompanionContext` (ST-1); the import is
 * type-only and erased at runtime, so this module stays free of React imports and
 * remains unit-testable in isolation.
 *
 * #3120 ST-3 — the companion grounding seam also lives here: `CompanionAskOptions`
 * carries the launcher's current `ContextEnvelope` into a turn, and
 * `buildCompanionTurnMessages` is the ONE pure place that decides whether exactly
 * one grounding `system` message is prepended. `CAPABILITY_LIMITS` is a frozen
 * value import from the navigation leaf types module (no React, no DOM) and the
 * `LlmMessage`/`ContextEnvelope` imports are type-only, so the module stays pure.
 */
import type { CompanionSendDisposition } from '../../contexts/CompanionContext';
import { CAPABILITY_LIMITS } from '../../navigation/types';
import type { ContextEnvelope } from '../../navigation/types';
import type { LlmMessage } from '../../../app/adapters/HostAdapter';

/** What actually happened to a send. `rejected` is the ONLY non-accepting outcome. */
export type CompanionSendOutcome = 'dispatched' | 'queued' | 'rejected';

export interface CompanionSendResult {
  outcome: CompanionSendOutcome;
  /** 1-based FIFO position at enqueue time; present iff `outcome === 'queued'`. */
  queuePosition?: number;
  /** `crypto.randomUUID()` exactly-once witness; present iff `outcome === 'queued'`. */
  queueId?: string;
}

/**
 * #3120 ST-3 — the optional grounding payload of a companion ask. The launcher
 * hands the focused app's current envelope so a plain query is grounded without
 * a transcript or any new prompt architecture. It is TURN-SCOPED: never persisted,
 * never stored as history, and only carried across a FIFO wait.
 */
export interface CompanionAskOptions {
  readonly context?: ContextEnvelope;
}

export interface QueuedCompanionSend {
  readonly id: string;
  readonly text: string;
  /**
   * #3120 ST-3 — the queued turn's grounding envelope. ABSENT KEY when the send
   * carried no context (never an explicit `undefined`), so the drained turn builds
   * the byte-identical legacy message pair.
   */
  readonly context?: ContextEnvelope;
}

export interface CompanionSendQueue {
  /** Append to the tail; ALWAYS accepts (never returns `rejected`). */
  enqueue(text: string, options?: CompanionAskOptions): CompanionSendResult;
  /** Synchronous remove-and-return of the oldest item; `undefined` when empty. */
  dequeue(): QueuedCompanionSend | undefined;
  size(): number;
  /** Unmount path only; returns the dropped items in FIFO order (caller decides). */
  drainAll(): QueuedCompanionSend[];
}

/** The exact waiting copy, count 1 (UI/UX §5 / QA-bound; em dash + ellipsis). */
export const QUEUED_WAITING_COPY = 'Queued — waiting for Fredo…';

/** The bound testid for the bar's waiting indicator (REQ-12). */
export const QUEUED_WAITING_TESTID = 'launcher-command-queued';

/**
 * The FIFO queue behind `CompanionSendQueue`. `enqueue` mints a fresh
 * `crypto.randomUUID()` id (the exactly-once witness) and reports the 1-based
 * position; `dequeue` removes synchronously so the caller dispatches the exact
 * item it removed and never the same item twice.
 */
export function createCompanionSendQueue(): CompanionSendQueue {
  const items: QueuedCompanionSend[] = [];

  return {
    enqueue(text: string, options?: CompanionAskOptions): CompanionSendResult {
      const id = crypto.randomUUID();
      const context = options?.context;
      // #3120 ST-3 — carry the grounding context across the wait. The key is
      // OMITTED (not `undefined`) for a legacy send so the drained turn rebuilds
      // the byte-identical legacy message pair.
      if (context !== undefined) {
        items.push({ id, text, context });
      } else {
        items.push({ id, text });
      }
      return { outcome: 'queued', queuePosition: items.length, queueId: id };
    },
    dequeue(): QueuedCompanionSend | undefined {
      return items.shift();
    },
    size(): number {
      return items.length;
    },
    drainAll(): QueuedCompanionSend[] {
      return items.splice(0, items.length);
    },
  };
}

/**
 * The pure decision (REQ-5/REQ-6): what does a send mean right now?
 *
 *   not generating            → `dispatch` (start immediately; the mode is irrelevant)
 *   generating + `queue`      → `queue`     (accept; dispatch when the reply settles)
 *   generating + `interrupt`  → `interrupt` (supersede the in-flight reply)
 */
export function resolveSendOutcome(
  mode: CompanionSendDisposition,
  isGenerating: boolean,
): 'dispatch' | 'queue' | 'interrupt' {
  if (!isGenerating) return 'dispatch';
  return mode === 'interrupt' ? 'interrupt' : 'queue';
}

/**
 * #3120 ST-3 — the UTF-8 byte length of a string (the unit
 * `CAPABILITY_LIMITS.maxContextBytes` is expressed in). A surrogate pair counts
 * as ONE four-byte code point, never two three-byte units. Mirrors
 * `envelopeByteLength`'s counting without importing the envelope builder.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

/**
 * #3120 ST-3 — the ONE grounding decision (R-2.2): the `system` message content
 * for an ask, or `null` when there is nothing to inject.
 *
 *   no `context` supplied            → `null` (legacy message array, untouched)
 *   `JSON.stringify(context)` fits    → the exact JSON string
 *   larger than `maxContextBytes`     → `null` (never send an over-cap or a
 *                                       truncated — therefore unparseable — envelope)
 *
 * The envelope builder already caps its output; this is the seam's defensive
 * guarantee that the message actually handed to the model is bounded too.
 */
export function companionGroundingContent(options?: CompanionAskOptions): string | null {
  const context = options?.context;
  if (context === undefined) return null;
  const json = JSON.stringify(context);
  if (utf8ByteLength(json) > CAPABILITY_LIMITS.maxContextBytes) return null;
  return json;
}

/**
 * #3120 ST-3 — build the ONE fresh turn a companion ask sends. When a bounded
 * `context` is present, exactly ONE grounding `system` message carrying
 * `JSON.stringify(context)` is PREPENDED before the existing `FREDO_CHAT_PERSONA`
 * system message and the user turn. Nothing else is added: no transcript, no
 * history, no assistant turns. Without a context the result is byte-identical to
 * the shipped `[persona, user]` pair.
 *
 * `text` is `''` for an audio turn — the captured clip (attached by the backend
 * renderer) remains the turn's input; the seam never fabricates a transcript.
 */
export function buildCompanionTurnMessages(
  text: string,
  persona: string,
  options?: CompanionAskOptions,
): LlmMessage[] {
  const messages: LlmMessage[] = [];
  const grounding = companionGroundingContent(options);
  if (grounding !== null) messages.push({ role: 'system', content: grounding });
  messages.push({ role: 'system', content: persona });
  messages.push({ role: 'user', content: text });
  return messages;
}

/**
 * The bar's waiting copy (REQ-5, UI/UX §5): count 1 → the base sentence;
 * count ≥ 2 → the counted form. `count <= 0` is defensive only — the bar never
 * renders the indicator below 1 — and falls back to the base sentence.
 */
export function queuedWaitingCopy(count: number): string {
  if (count >= 2) return `${count} queued — waiting for Fredo…`;
  return QUEUED_WAITING_COPY;
}
