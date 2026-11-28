/**
 * Spec #3243 ST-6 — the undo registry's pins.
 *
 * The decisive cases are the STALE-SAFE ones (F-34). A registry that reports
 * `undone` while reverting nothing, or that walks back to an older record to
 * manufacture a success, passes a naive test — so each pin here names the defect
 * world it rejects:
 *
 *  - the LIFO pin proves the NEWEST record is the one applied (an older record's
 *    closure must not fire);
 *  - the failure pin proves a superseded record reports `failed` with its label
 *    and is NOT retried, and does NOT fall through to the record beneath it;
 *  - the empty pin proves `nothing` — never a throw, never a success claim;
 *  - the bound pin proves the registry cannot grow without limit.
 *
 * The undo is verified through an EFFECT the caller can see (a counter the
 * closure mutates), not through the registry's own report, so a store-only
 * assertion cannot pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_UNDO_DEPTH,
  hasOrderUndo,
  peekOrderUndoLabel,
  readOrderUndoRecords,
  registerOrderUndo,
  resetOrderUndoForTests,
  undoLastOrder,
  type OrderUndoRecord,
} from '../orderUndo';

beforeEach(() => {
  resetOrderUndoForTests();
});

afterEach(() => {
  resetOrderUndoForTests();
});

/** A record whose `undo()` records that it ran and returns the given verdict. */
function record(
  fingerprint: string,
  label: string,
  calls: string[],
  verdict = true,
): OrderUndoRecord {
  return {
    fingerprint,
    label,
    undo: () => {
      calls.push(fingerprint);
      return verdict;
    },
  };
}

describe('orderUndo — an EMPTY registry returns nothing (R-8c)', () => {
  it('returns `nothing`, never throws, and never claims an undo', () => {
    expect(undoLastOrder()).toEqual({ status: 'nothing', label: '' });
    // Repeated presses stay `nothing` (no state is created by asking).
    expect(undoLastOrder().status).toBe('nothing');
    expect(hasOrderUndo()).toBe(false);
  });

  it('hasOrderUndo / peekOrderUndoLabel are empty before any registration', () => {
    expect(hasOrderUndo()).toBe(false);
    expect(peekOrderUndoLabel()).toBeNull();
    expect(readOrderUndoRecords()).toEqual([]);
  });
});

describe('orderUndo — LIFO: ONLY the newest record is applied', () => {
  it('applies the newest record and NOT the one beneath it', () => {
    const calls: string[] = [];
    registerOrderUndo(record('fp-older', 'Older action', calls));
    registerOrderUndo(record('fp-newer', 'Newer action', calls));

    const outcome = undoLastOrder();
    expect(outcome).toEqual({ status: 'undone', label: 'Newer action' });
    // The EFFECT is the oracle: only the newest closure ran.
    expect(calls).toEqual(['fp-newer']);
    // The older record is still available (one press = one undo).
    expect(readOrderUndoRecords().map((entry) => entry.fingerprint)).toEqual(['fp-older']);
  });

  it('a second press applies the next record (one step per press)', () => {
    const calls: string[] = [];
    registerOrderUndo(record('fp-1', 'First', calls));
    registerOrderUndo(record('fp-2', 'Second', calls));
    expect(undoLastOrder().status).toBe('undone');
    expect(undoLastOrder().status).toBe('undone');
    expect(calls).toEqual(['fp-2', 'fp-1']);
    // And then there is nothing left.
    expect(undoLastOrder().status).toBe('nothing');
  });

  it('the removed record is gone: a repeat press cannot re-apply it', () => {
    const calls: string[] = [];
    registerOrderUndo(record('fp-once', 'Once', calls));
    expect(undoLastOrder().status).toBe('undone');
    expect(undoLastOrder().status).toBe('nothing');
    expect(calls).toEqual(['fp-once']);
  });
});

describe('orderUndo — STALE-SAFETY (F-34): a superseded record FAILS, never falls through', () => {
  it('a record whose undo() returns false reports `failed` WITH its label', () => {
    const calls: string[] = [];
    registerOrderUndo(record('fp-stale', 'Superseded action', calls, false));
    const outcome = undoLastOrder();
    expect(outcome).toEqual({ status: 'failed', label: 'Superseded action' });
    // `failed` and not `nothing`: "there WAS something to undo and it could no
    // longer be applied" is a different statement from "there was never
    // anything", and the reply copy differs.
    expect(outcome.status).not.toBe('nothing');
    // Never a success claim.
    expect(outcome.status).not.toBe('undone');
  });

  it('a failed record does NOT fall through to the older record beneath it', () => {
    const calls: string[] = [];
    registerOrderUndo(record('fp-older', 'Older action', calls, true));
    registerOrderUndo(record('fp-newer', 'Superseded action', calls, false));

    const outcome = undoLastOrder();
    expect(outcome.status).toBe('failed');
    // The older record's closure MUST NOT have run: reverting it would revert a
    // change the user did not ask about (the single worst outcome).
    expect(calls).toEqual(['fp-newer']);
    // The older record survives — a subsequent press may still offer it.
    expect(readOrderUndoRecords().map((entry) => entry.fingerprint)).toEqual(['fp-older']);
  });

  it('a superseded record is DROPPED, so it never shadows the queue forever', () => {
    const calls: string[] = [];
    registerOrderUndo(record('fp-stale', 'Superseded', calls, false));
    undoLastOrder();
    expect(readOrderUndoRecords()).toEqual([]);
    // A second press reads `nothing` rather than retrying the dead record.
    expect(undoLastOrder().status).toBe('nothing');
    expect(calls).toEqual(['fp-stale']);
  });

  it('a THROWING undo() is a typed failure, never a crash and never a success', () => {
    registerOrderUndo({
      fingerprint: 'fp-throws',
      label: 'Exploding action',
      undo: () => {
        throw new Error('the app history is gone');
      },
    });
    const outcome = undoLastOrder();
    expect(outcome).toEqual({ status: 'failed', label: 'Exploding action' });
    expect(readOrderUndoRecords()).toEqual([]);
  });

  it('the registry never invokes more than ONE closure per press', () => {
    const spies = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)];
    spies.forEach((spy, index) => {
      registerOrderUndo({ fingerprint: `fp-${index}`, label: `Action ${index}`, undo: spy });
    });
    undoLastOrder();
    expect(spies[0]).not.toHaveBeenCalled();
    expect(spies[1]).not.toHaveBeenCalled();
    expect(spies[2]).toHaveBeenCalledTimes(1);
  });
});

describe('orderUndo — bounded at ORDER_UNDO_DEPTH (NFR-5)', () => {
  it('ORDER_UNDO_DEPTH is the plan default (20)', () => {
    expect(ORDER_UNDO_DEPTH).toBe(20);
  });

  it('never holds more than ORDER_UNDO_DEPTH records, dropping the OLDEST', () => {
    const calls: string[] = [];
    for (let index = 0; index < ORDER_UNDO_DEPTH + 5; index += 1) {
      registerOrderUndo(record(`fp-${index}`, `Action ${index}`, calls));
    }
    const retained = readOrderUndoRecords();
    expect(retained).toHaveLength(ORDER_UNDO_DEPTH);
    expect(retained.map((entry) => entry.fingerprint)).not.toContain('fp-0');
    expect(retained[retained.length - 1].fingerprint).toBe(`fp-${ORDER_UNDO_DEPTH + 4}`);
  });

  it('an over-depth registry still undoes cleanly (the bound does not break the path)', () => {
    const calls: string[] = [];
    for (let index = 0; index < ORDER_UNDO_DEPTH + 3; index += 1) {
      registerOrderUndo(record(`fp-${index}`, `Action ${index}`, calls));
    }
    expect(undoLastOrder().status).toBe('undone');
    expect(calls).toEqual([`fp-${ORDER_UNDO_DEPTH + 2}`]);
  });
});

describe('orderUndo — the label is bound to the record (the control names its datum)', () => {
  it('peekOrderUndoLabel reads the NEWEST record label', () => {
    registerOrderUndo(record('fp-a', 'Fill element', []));
    registerOrderUndo(record('fp-b', 'Delete element', []));
    expect(peekOrderUndoLabel()).toBe('Delete element');
    undoLastOrder();
    expect(peekOrderUndoLabel()).toBe('Fill element');
    undoLastOrder();
    expect(peekOrderUndoLabel()).toBeNull();
  });

  it('the outcome label EQUALS the record label (no surface re-types it)', () => {
    const label = 'Create a new document';
    registerOrderUndo({ fingerprint: 'fp-x', label, undo: () => true });
    expect(undoLastOrder().label).toBe(label);
    registerOrderUndo({ fingerprint: 'fp-y', label, undo: () => false });
    expect(undoLastOrder().label).toBe(label);
  });
});
