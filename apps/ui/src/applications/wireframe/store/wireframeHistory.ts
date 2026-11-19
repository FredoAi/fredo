/**
 * Wireframe app-local bounded undo/redo history (Spec #3151, ST-3 / AC4).
 *
 * The Wireframe document store was the shared navigation journal's biggest
 * consumer: every document mutation was committed as a `JournalEntry` and
 * `undo()`/`redo()` were journal shims. The navigation engine is being removed,
 * so Wireframe owns its own bounded history BEFORE the journal disappears — a
 * removal must never ship a zero-undo editor.
 *
 * This module is deliberately tiny and engine-free: one field-scoped
 * `before`/`after` delta pair per entry, a cursor (not two stacks), and a
 * monotonic revision token the store uses for cheap snapshot-change detection.
 * It knows nothing about places, verbs, actors, channels, timestamps, targets
 * or patches — those were journal concerns.
 *
 * BOUNDED (NFR-5): at most `WIREFRAME_HISTORY_LIMIT` entries are retained; a
 * push past the limit drops the OLDEST entry. No unbounded array grows here.
 *
 * The two deltas are the SAME field-scoped shape `model/documentDelta.ts`
 * diffs and applies, so one entry's inverse still reverts only what that entry
 * changed (the Spec #3120 round-2 property) — never a whole-document snapshot.
 */

import type { WireframeDocumentDelta } from '../model/documentDelta';

/** Bounded depth — the shipped `UNDO_DEPTH` value (`wireframeDocumentStore.ts`). */
export const WIREFRAME_HISTORY_LIMIT = 100;

/** One undoable document change, expressed as field-scoped deltas. */
export interface WireframeHistoryEntry {
  /** Monotonic, 1-based, per history instance. */
  readonly seq: number;
  /** The store action id, e.g. `'elements.update'`. */
  readonly verbId: string;
  /** Human label, e.g. `'Move'`, `'Delete Rectangle'`. */
  readonly label: string;
  /** The delta that REVERTS this change (applied by `undo`). */
  readonly before: WireframeDocumentDelta;
  /** The delta that RE-APPLIES this change (applied by `redo`); carries the selection. */
  readonly after: WireframeDocumentDelta;
}

export interface WireframeHistory {
  /** Append one entry; drops the OLDEST past the limit and clears redo. */
  push(entry: Omit<WireframeHistoryEntry, 'seq'>): WireframeHistoryEntry;
  /** Step back one entry (null when none) — the caller applies `before`. */
  undo(): WireframeHistoryEntry | null;
  /** Step forward one undone entry (null when none) — the caller applies `after`. */
  redo(): WireframeHistoryEntry | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Reset IN PLACE (New / Open / test reset) — the instance identity never changes. */
  clear(): void;
  /** Newest-last, at most the limit. */
  entries(): readonly WireframeHistoryEntry[];
  /** Monotonic revision token (cheap snapshot-change detection). */
  revision(): number;
}

/**
 * Create an independent bounded history. `limit` defaults to
 * `WIREFRAME_HISTORY_LIMIT`; a non-positive or fractional limit is normalised
 * to a whole number of at least one entry, so the depth is always bounded.
 */
export function createWireframeHistory(limit: number = WIREFRAME_HISTORY_LIMIT): WireframeHistory {
  const depth = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : WIREFRAME_HISTORY_LIMIT;

  /** Retained entries, oldest first. */
  let entries: WireframeHistoryEntry[] = [];
  /** How many retained entries are currently applied (undo/redo cursor). */
  let cursor = 0;
  /** Monotonic seq source — never rewound, so seqs stay strictly increasing. */
  let nextSeq = 1;
  /** Monotonic change token. */
  let revision = 0;

  return {
    push(entry) {
      // A new edit invalidates the redo tail (the undone entries can no longer
      // be re-applied without losing this one).
      if (cursor < entries.length) entries = entries.slice(0, cursor);
      const complete: WireframeHistoryEntry = { ...entry, seq: nextSeq };
      nextSeq += 1;
      entries.push(complete);
      if (entries.length > depth) {
        entries = entries.slice(entries.length - depth);
      }
      cursor = entries.length;
      revision += 1;
      return complete;
    },

    undo() {
      if (cursor <= 0) return null;
      cursor -= 1;
      revision += 1;
      return entries[cursor];
    },

    redo() {
      if (cursor >= entries.length) return null;
      const entry = entries[cursor];
      cursor += 1;
      revision += 1;
      return entry;
    },

    canUndo() {
      return cursor > 0;
    },

    canRedo() {
      return cursor < entries.length;
    },

    clear() {
      entries = [];
      cursor = 0;
      revision += 1;
    },

    entries() {
      return entries;
    },

    revision() {
      return revision;
    },
  };
}
