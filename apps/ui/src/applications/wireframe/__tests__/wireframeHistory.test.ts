/**
 * Wireframe app-local bounded undo/redo history (Spec #3151, ST-3 / AC4, NFR-5).
 *
 * The unit contract for `store/wireframeHistory.ts` — the container that
 * replaces the retired shared navigation journal as the document's ONE undo
 * authority. Pure, no DOM, no engine: a cursor over one field-scoped
 * `before`/`after` delta pair per entry.
 */

import { describe, expect, it } from 'vitest';

import type { WireframeDocumentDelta } from '../model/documentDelta';
import {
  WIREFRAME_HISTORY_LIMIT,
  createWireframeHistory,
  type WireframeHistoryEntry,
} from '../store/wireframeHistory';

/** A minimal entry; the deltas are opaque to the container. */
function draft(index: number): Omit<WireframeHistoryEntry, 'seq'> {
  return {
    verbId: 'elements.update',
    label: `Edit ${index}`,
    before: { page: { set: { width: index } } } as WireframeDocumentDelta,
    after: { page: { set: { width: index + 1 } } } as WireframeDocumentDelta,
  };
}

describe('bounded depth (AC4 / NFR-5)', () => {
  it('exports the shipped UNDO_DEPTH value of 100', () => {
    expect(WIREFRAME_HISTORY_LIMIT).toBe(100);
  });

  it('retains exactly 100 of 105 pushes and evicts the OLDEST', () => {
    const history = createWireframeHistory();
    for (let index = 0; index < 105; index += 1) history.push(draft(index));

    const entries = history.entries();
    expect(entries).toHaveLength(WIREFRAME_HISTORY_LIMIT);
    // The five oldest (labels Edit 0..Edit 4) were evicted; Edit 5 is the head.
    expect(entries[0]?.label).toBe('Edit 5');
    expect(entries[entries.length - 1]?.label).toBe('Edit 104');
    // Seqs stay monotonic even across eviction (never rewound).
    expect(entries[0]?.seq).toBe(6);
    expect(entries[entries.length - 1]?.seq).toBe(105);
  });

  it('honours a custom limit', () => {
    const history = createWireframeHistory(5);
    for (let index = 0; index < 8; index += 1) history.push(draft(index));

    expect(history.entries()).toHaveLength(5);
    expect(history.entries()[0]?.label).toBe('Edit 3');
    expect(history.entries()[4]?.label).toBe('Edit 7');
  });

  it('normalises a non-positive or fractional limit to at least one entry', () => {
    const zero = createWireframeHistory(0);
    zero.push(draft(0));
    zero.push(draft(1));
    expect(zero.entries()).toHaveLength(1);

    const fractional = createWireframeHistory(2.9);
    fractional.push(draft(0));
    fractional.push(draft(1));
    fractional.push(draft(2));
    expect(fractional.entries()).toHaveLength(2);
  });
});

describe('undo / redo ordering (AC4 R-4.1 / R-4.2)', () => {
  it('undo walks back newest-first and redo re-applies oldest-first', () => {
    const history = createWireframeHistory();
    history.push(draft(1));
    history.push(draft(2));
    history.push(draft(3));

    expect(history.undo()?.label).toBe('Edit 3');
    expect(history.undo()?.label).toBe('Edit 2');
    // Redo re-applies the OLDEST undone entry first (chronological restore).
    expect(history.redo()?.label).toBe('Edit 2');
    expect(history.redo()?.label).toBe('Edit 3');
    expect(history.redo()).toBeNull();
  });

  it('a push clears the redo tail', () => {
    const history = createWireframeHistory();
    history.push(draft(1));
    history.push(draft(2));
    history.undo();
    expect(history.canRedo()).toBe(true);

    history.push(draft(3));

    expect(history.canRedo()).toBe(false);
    expect(history.entries().map((entry) => entry.label)).toEqual(['Edit 1', 'Edit 3']);
    expect(history.undo()?.label).toBe('Edit 3');
  });

  it('does not step past either end', () => {
    const history = createWireframeHistory();
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();

    history.push(draft(1));
    expect(history.undo()?.label).toBe('Edit 1');
    expect(history.undo()).toBeNull();
    expect(history.redo()?.label).toBe('Edit 1');
    expect(history.redo()).toBeNull();
  });
});

describe('empty-history flags', () => {
  it('reports both flags false on a fresh history', () => {
    const history = createWireframeHistory();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.entries()).toHaveLength(0);
  });

  it('flips canUndo on the first push and canRedo on the first undo', () => {
    const history = createWireframeHistory();
    history.push(draft(1));
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);

    history.undo();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });
});

describe('seq monotonicity', () => {
  it('starts at 1 and increments per push', () => {
    const history = createWireframeHistory();
    const first = history.push(draft(1));
    const second = history.push(draft(2));
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('keeps advancing after eviction and across clear', () => {
    const history = createWireframeHistory(2);
    history.push(draft(1));
    history.push(draft(2));
    history.push(draft(3));
    expect(history.entries().map((entry) => entry.seq)).toEqual([2, 3]);

    history.clear();
    // `clear` resets the stack but never rewinds the seq source.
    expect(history.push(draft(4)).seq).toBe(4);
  });
});

describe('revision() — a monotonic change token', () => {
  it('advances on push, undo, redo and clear', () => {
    const history = createWireframeHistory();
    const start = history.revision();

    history.push(draft(1));
    const afterPush = history.revision();
    expect(afterPush).toBeGreaterThan(start);

    history.undo();
    const afterUndo = history.revision();
    expect(afterUndo).toBeGreaterThan(afterPush);

    history.redo();
    const afterRedo = history.revision();
    expect(afterRedo).toBeGreaterThan(afterUndo);

    history.clear();
    expect(history.revision()).toBeGreaterThan(afterRedo);
  });

  it('does not advance on a no-op undo/redo at a boundary', () => {
    const history = createWireframeHistory();
    const start = history.revision();
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    expect(history.revision()).toBe(start);
  });
});

describe('clear() resets IN PLACE (AC4 R-4.4)', () => {
  it('empties the stack but preserves instance identity and the API', () => {
    const history = createWireframeHistory();
    history.push(draft(1));
    history.push(draft(2));
    history.undo();
    expect(history.canRedo()).toBe(true);

    const identity = history;
    history.clear();

    // Same instance — a held reference stays valid (New/Open must not swap it).
    expect(history).toBe(identity);
    expect(history.entries()).toHaveLength(0);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it('escapes a custom limit into deallocation on push after clear', () => {
    const history = createWireframeHistory(3);
    history.push(draft(1));
    history.clear();
    history.push(draft(2));
    expect(history.entries()).toHaveLength(1);
    expect(history.entries()[0]?.label).toBe('Edit 2');
  });
});
