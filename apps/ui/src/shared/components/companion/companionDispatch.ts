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
 */
import type { CompanionSendDisposition } from '../../contexts/CompanionContext';

/** What actually happened to a send. `rejected` is the ONLY non-accepting outcome. */
export type CompanionSendOutcome = 'dispatched' | 'queued' | 'rejected';

export interface CompanionSendResult {
  outcome: CompanionSendOutcome;
  /** 1-based FIFO position at enqueue time; present iff `outcome === 'queued'`. */
  queuePosition?: number;
  /** `crypto.randomUUID()` exactly-once witness; present iff `outcome === 'queued'`. */
  queueId?: string;
}

export interface QueuedCompanionSend {
  id: string;
  text: string;
}

export interface CompanionSendQueue {
  /** Append to the tail; ALWAYS accepts (never returns `rejected`). */
  enqueue(text: string): CompanionSendResult;
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
    enqueue(text: string): CompanionSendResult {
      const id = crypto.randomUUID();
      items.push({ id, text });
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
 * The bar's waiting copy (REQ-5, UI/UX §5): count 1 → the base sentence;
 * count ≥ 2 → the counted form. `count <= 0` is defensive only — the bar never
 * renders the indicator below 1 — and falls back to the base sentence.
 */
export function queuedWaitingCopy(count: number): string {
  if (count >= 2) return `${count} queued — waiting for Fredo…`;
  return QUEUED_WAITING_COPY;
}
