/**
 * Spec #3243 ST-6 — the order undo registry (AC-8's undoable half).
 *
 * ## This registry STORES a closure; it never re-implements an inverse
 *
 * Each record carries the application's OWN undo, already closed over the
 * mechanism that produced the change (for Wireframe: the shipped
 * `getWireframeHistory()` entry, verified by entry identity). This module adds
 * ordering, bounding and outcomes — never a second history, never a
 * re-implemented delta (G-522).
 *
 * ## STALE-SAFETY is the whole point of this module's shape
 *
 * The single worst outcome this affordance can produce is reverting a change the
 * user did not ask to undo. Wireframe's own Undo control sits on the SAME
 * history, and the user may make their own edit after confirming an order. A
 * registry that simply called "one step back" would revert THAT edit.
 *
 * Two independent guards, and neither is sufficient alone:
 *
 *  1. The RECORD's `undo()` is stale-safe at the source: it verifies its own
 *     history entry is still the newest applied one and returns `false`
 *     otherwise (`wireframeOrderSurface.ts`).
 *  2. This registry applies ONLY the one record it selects — it never walks the
 *     history, never pops more than one record, and never retries against a
 *     DIFFERENT record to produce a success.
 *
 * An `undo()` that returns `false` is reported as `failed` with its label, never
 * as a silent no-op and never as `nothing` (which would read as "there was
 * never anything to undo" — a different, false statement). The record is then
 * dropped, because a superseded record can never become valid again.
 *
 * ## Bounded (NFR-5)
 *
 * At most `ORDER_UNDO_DEPTH` records are retained; a push past the limit drops
 * the OLDEST. A long session cannot grow it without limit.
 *
 * Pure data: no React, no timers, no I/O.
 */

/** Bounded registry depth. */
export const ORDER_UNDO_DEPTH = 20;

/** One undoable order outcome, closed over the app's own inverse. */
export interface OrderUndoRecord {
  /** The invocation fingerprint that produced the change (the order's identity). */
  readonly fingerprint: string;
  /** The action's label, used by the reply formatters — never re-typed by a surface. */
  readonly label: string;
  /**
   * Apply the app's OWN inverse for THIS change. `true` iff the change was
   * reverted; `false` iff it can no longer be applied (superseded, already
   * undone, or the app's history moved).
   */
  undo(): boolean;
}

/**
 * What an undo request did.
 *
 * `label` is present on all three variants (`''` for `nothing`) so a caller can
 * project one field without narrowing first, and so the outcome is a total
 * value rather than a partial one.
 */
export type OrderUndoOutcome =
  | { readonly status: 'undone'; readonly label: string }
  | { readonly status: 'nothing'; readonly label: string }
  | { readonly status: 'failed'; readonly label: string };

/** Module-scoped: retained records, OLDEST first (the last entry is the newest). */
let records: OrderUndoRecord[] = [];

/**
 * Register ONE undo record. Bounded at `ORDER_UNDO_DEPTH`, dropping the OLDEST.
 *
 * A non-undoable action must register NO record — the caller's contract (its
 * declaration's `undoable === false` means there is nothing to store). This
 * function does not guess: registering is an explicit act.
 */
export function registerOrderUndo(record: OrderUndoRecord): void {
  records.push(record);
  if (records.length > ORDER_UNDO_DEPTH) {
    records = records.slice(records.length - ORDER_UNDO_DEPTH);
  }
}

/** The retained records, oldest first — diagnostics/tests only. */
export function readOrderUndoRecords(): readonly OrderUndoRecord[] {
  return [...records];
}

/** True iff a record is available (the affordance's "should the control exist?" read). */
export function hasOrderUndo(): boolean {
  return records.length > 0;
}

/** The newest record's label, or `null` (the control's own name is bound to this). */
export function peekOrderUndoLabel(): string | null {
  const newest = records[records.length - 1];
  return newest === undefined ? null : newest.label;
}

/**
 * Undo the NEWEST order — and only that one.
 *
 *  - an EMPTY registry ⇒ `nothing` (never throws, never claims an undo);
 *  - a record whose `undo()` returns `true` ⇒ `undone` + the label, and the
 *    record is removed (a second press then reads `nothing`);
 *  - a record whose `undo()` returns `false` ⇒ `failed` + the label, and the
 *    record is removed. This is the STALE case: the app's history moved (the
 *    user edited, or pressed the app's own Undo), so the order's change can no
 *    longer be reverted safely. Reporting `failed` — never silence, never
 *    `nothing`, never a retry against an older record — is what keeps the
 *    affordance honest.
 *
 * The registry deliberately does NOT fall through to an older record on a
 * failure: an older order's change is necessarily at least as stale, and a
 * successful "undo" that reverted something other than what the control names
 * would be the exact defect F-34 exists to catch.
 */
export function undoLastOrder(): OrderUndoOutcome {
  const record = records[records.length - 1];
  if (record === undefined) return { status: 'nothing', label: '' };

  // Pop FIRST, so a throwing `undo()` cannot leave a record that will be
  // retried on every press (and so a failure cannot shadow the queue forever).
  records = records.slice(0, -1);

  let applied = false;
  try {
    applied = record.undo();
  } catch {
    // Fail closed: a throwing inverse is a failure with a label, never a crash
    // and never a silent success.
    applied = false;
  }
  return applied
    ? { status: 'undone', label: record.label }
    : { status: 'failed', label: record.label };
}

/** Test-only: drop every record and reset the module state. */
export function resetOrderUndoForTests(): void {
  records = [];
}
