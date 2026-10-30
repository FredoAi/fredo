/**
 * Spec #3117 (P3) — ST-3 §7 context-envelope proofs (AC6).
 *
 * Every `it()` title the #3117 QA Plan cites for REQ-06.* is verbatim. The envelope is
 * built ONLY from its arguments, is JSON-serialisable, and every list/string is bounded
 * before it leaves the function.
 */

import { describe, expect, it } from 'vitest';

import { buildContextEnvelope, envelopeByteLength } from '../context';
import {
  CAPABILITY_LIMITS,
  type ContextEnvelope,
  type JournalEntry,
  type PlaceNode,
  type Surface,
} from '../types';
import {
  makePlace,
  makeSelection,
  makeSnapshot,
  makeSurface,
  makeVerb,
  validWireframeSurface,
} from './fixtures';

/** One deterministic journal entry in append order. */
function makeEntry(seq: number, overrides: Partial<JournalEntry> = {}): JournalEntry {
  const seconds = String(seq).padStart(2, '0');
  return {
    seq,
    ts: `2026-01-01T00:00:${seconds}.000Z`,
    verbId: `v.${seq}`,
    actor: 'human',
    channel: 'keyboard',
    label: `Change ${seq}`,
    effect: 'mutation',
    placePath: ['p.root'],
    target: [],
    patch: null,
    inverse: null,
    undoable: false,
    external: false,
    consequence: null,
    exitedBy: 'none',
    coalesceKey: null,
    groupId: null,
    ...overrides,
  };
}

/** A root + `count - 1` child chain, `p0` → `p{count-1}`. */
function chainSurface(count: number): Surface {
  const places: PlaceNode[] = Array.from({ length: count }, (_, index) =>
    makePlace({
      id: `p${index}`,
      label: `Place ${index}`,
      parent: index === 0 ? null : `p${index - 1}`,
    }),
  );
  return makeSurface({ root: 'p0', places, verbs: [] });
}

/** A flat surface declaring `count` verbs on one root place (none bound). */
function verbSurface(count: number): Surface {
  return makeSurface({
    root: 'p.root',
    places: [makePlace({ id: 'p.root' })],
    verbs: Array.from({ length: count }, (_, index) =>
      makeVerb({ id: `v.${index}`, title: `Verb ${index}` }),
    ),
  });
}

/** Return the first non-JSON value kind found in a tree (`null` when fully JSON). */
function findNonJsonValue(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'function') return 'function';
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype &&
      prototype !== null
    ) {
      return 'class-instance';
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const found = findNonJsonValue((value as Record<string, unknown>)[key]);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Visit every string in a JSON-ish value. */
function forEachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    forEachString((value as Record<string, unknown>)[key], visit);
  }
}

describe('buildContextEnvelope', () => {
  it('envelope v1 carries every field from its arguments', () => {
    const surface = validWireframeSurface();
    const snapshot = makeSnapshot({
      selection: makeSelection({
        count: 2,
        kinds: ['element'],
        label: 'Rectangle 3',
        ids: ['a', 'b'],
      }),
      dirty: true,
    });
    const entries: readonly JournalEntry[] = [makeEntry(1, { undoable: true, inverse: {} })];

    const envelope = buildContextEnvelope(surface, snapshot, entries);

    expect(envelope.version).toBe(1);
    expect(envelope.appId).toBe('wireframe');
    expect(envelope.placePath).toStrictEqual([
      { id: 'wireframe.canvas', label: 'Canvas', transient: false, sticky: false },
    ]);
    expect(envelope.selection).toStrictEqual({
      count: 2,
      kinds: ['element'],
      label: 'Rectangle 3',
      ids: ['a', 'b'],
    });
    expect(envelope.verbs).toHaveLength(surface.verbs.length);
    expect(envelope.verbs.map((verb) => verb.id)).toStrictEqual(
      surface.verbs.map((verb) => verb.id),
    );
    expect(envelope.journal).toStrictEqual({
      last: [
        {
          seq: 1,
          ts: '2026-01-01T00:00:01.000Z',
          verbId: 'v.1',
          actor: 'human',
          label: 'Change 1',
          undoable: true,
        },
      ],
      undoableCount: 1,
    });
    expect(envelope.dirty).toBe(true);
    expect(envelope.limits).toStrictEqual(CAPABILITY_LIMITS);

    // The empty selection / empty journal cases are explicit, not omissions.
    const empty = buildContextEnvelope(surface, makeSnapshot(), []);
    expect(empty.selection).toStrictEqual({ count: 0, kinds: [], label: null, ids: [] });
    expect(empty.journal).toStrictEqual({ last: [], undoableCount: 0 });
  });

  it('envelope is JSON-serialisable with no functions or cycles', () => {
    const envelope = buildContextEnvelope(
      validWireframeSurface(),
      makeSnapshot({ selection: makeSelection({ count: 1, kinds: ['element'], ids: ['a'] }) }),
      [
        makeEntry(1, { inverse: {} }),
        makeEntry(2, { undoable: true, inverse: {} }),
        makeEntry(3, { patch: { before: {}, after: { a: 1 } }, inverse: { a: 0 } }),
      ],
    );

    expect(JSON.parse(JSON.stringify(envelope))).toStrictEqual(envelope);
    expect(structuredClone(envelope)).toStrictEqual(envelope);
    expect(findNonJsonValue(envelope)).toBeNull();
  });

  it('place path lists root to current and truncates to eight', () => {
    const nine = chainSurface(9);
    const nineIds = Array.from({ length: 9 }, (_, index) => `p${index}`);
    const truncated = buildContextEnvelope(
      nine,
      makeSnapshot({ placePath: nineIds }),
      [],
    );

    expect(truncated.placePath).toHaveLength(8);
    expect(truncated.placePath.map((place) => place.id)).toStrictEqual([
      'p0',
      'p2',
      'p3',
      'p4',
      'p5',
      'p6',
      'p7',
      'p8',
    ]);
    expect(truncated.placePath[0]).toStrictEqual({
      id: 'p0',
      label: 'Place 0',
      transient: false,
      sticky: false,
    });
    expect(Object.keys(truncated.placePath[0]).sort()).toStrictEqual([
      'id',
      'label',
      'sticky',
      'transient',
    ]);

    const exactlyEight = buildContextEnvelope(
      chainSurface(8),
      makeSnapshot({ placePath: Array.from({ length: 8 }, (_, index) => `p${index}`) }),
      [],
    );
    expect(exactlyEight.placePath.map((place) => place.id)).toStrictEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
      'p6',
      'p7',
    ]);

    const rootOnly = buildContextEnvelope(
      nine,
      makeSnapshot({ placePath: ['p0'] }),
      [],
    );
    expect(rootOnly.placePath.map((place) => place.id)).toStrictEqual(['p0']);
  });

  it('selection dedupes kinds and truncates ids', () => {
    const ids = Array.from({ length: 33 }, (_, index) => `id-${index}`);
    const envelope = buildContextEnvelope(
      validWireframeSurface(),
      makeSnapshot({
        selection: makeSelection({
          count: 40,
          kinds: ['a', 'b', 'a', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
          label: null,
          ids,
        }),
      }),
      [],
    );

    expect(envelope.selection.count).toBe(40);
    expect(envelope.selection.kinds).toStrictEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
    ]);
    expect(envelope.selection.kinds).toHaveLength(8);
    expect(envelope.selection.ids).toStrictEqual(ids.slice(0, 32));
    expect(envelope.selection.ids).toHaveLength(32);
    expect(envelope.selection.label).toBeNull();
  });

  it('verbs follow declaration order and truncate to 64', () => {
    const envelope = buildContextEnvelope(
      verbSurface(65),
      makeSnapshot({ placePath: ['p.root'] }),
      [],
    );

    expect(envelope.verbs).toHaveLength(64);
    expect(envelope.verbs.map((verb) => verb.id)).toStrictEqual(
      Array.from({ length: 64 }, (_, index) => `v.${index}`),
    );
    expect(envelope.verbs.every((verb) => verb.keys.length === 0)).toBe(true);
    expect(envelope.verbs.every((verb) => verb.available)).toBe(true);
    expect(envelope.verbs.every((verb) => verb.unavailableReason === null)).toBe(true);

    // An unavailable verb keeps its row and reports the pair — never a fabricated reason.
    const unavailable = makeSurface({
      root: 'p.root',
      places: [
        makePlace({
          id: 'p.root',
          keys: { a: { kind: 'verb', verbId: 'v.x' } },
        }),
      ],
      verbs: [makeVerb({ id: 'v.x', title: 'Unavailable', available: () => false })],
    });
    const row = buildContextEnvelope(
      unavailable,
      makeSnapshot({ placePath: ['p.root'] }),
      [],
    ).verbs[0];
    expect(row.available).toBe(false);
    expect(row.unavailableReason).toBeNull();
    expect(row.keys).toStrictEqual(['a']);
  });

  it('journal last is newest first and capped at ten', () => {
    const entries = Array.from({ length: 11 }, (_, index) =>
      makeEntry(index + 1, { undoable: index % 2 === 0 }),
    );

    const envelope = buildContextEnvelope(validWireframeSurface(), makeSnapshot(), entries);

    expect(envelope.journal.last).toHaveLength(10);
    expect(envelope.journal.last.map((entry) => entry.seq)).toStrictEqual([
      11, 10, 9, 8, 7, 6, 5, 4, 3, 2,
    ]);
    expect(envelope.journal.undoableCount).toBe(6);

    const allNonUndoable = entries.map((entry) => makeEntry(entry.seq));
    expect(
      buildContextEnvelope(validWireframeSurface(), makeSnapshot(), allNonUndoable).journal
        .undoableCount,
    ).toBe(0);

    expect(
      buildContextEnvelope(validWireframeSurface(), makeSnapshot(), []).journal,
    ).toStrictEqual({ last: [], undoableCount: 0 });
  });

  it('dirty and frozen capability limits', () => {
    const envelope = buildContextEnvelope(
      validWireframeSurface(),
      makeSnapshot({ dirty: true }),
      [],
    );

    expect(Object.isFrozen(CAPABILITY_LIMITS)).toBe(true);
    expect({ ...CAPABILITY_LIMITS }).toStrictEqual({
      maxVerbs: 64,
      maxJournalEntries: 10,
      maxSelectionIds: 32,
      maxLabelChars: 120,
      maxPathDepth: 8,
      maxContextBytes: 16384,
    });
    expect(envelope.limits).toBe(CAPABILITY_LIMITS);
    expect(Object.isFrozen(envelope.limits)).toBe(true);
    // A mutation attempt on the frozen limits is refused, never silently applied.
    expect(Reflect.set(CAPABILITY_LIMITS, 'maxVerbs', 1)).toBe(false);
    expect(CAPABILITY_LIMITS.maxVerbs).toBe(64);

    expect(envelope.dirty).toBe(true);
    expect(
      buildContextEnvelope(validWireframeSurface(), makeSnapshot({ dirty: false }), []).dirty,
    ).toBe(false);
  });

  it('strings truncate at 120 and envelope is at most 16384 bytes', () => {
    const long = 'x'.repeat(1000);
    const places: PlaceNode[] = Array.from({ length: 8 }, (_, index) =>
      makePlace({
        id: `p${index}`,
        label: long,
        parent: index === 0 ? null : `p${index - 1}`,
      }),
    );
    const stressSurface = makeSurface({
      root: 'p0',
      places,
      verbs: Array.from({ length: 64 }, (_, index) =>
        makeVerb({ id: `${long}-${index}`, title: long, description: long }),
      ),
    });
    const stress = buildContextEnvelope(
      stressSurface,
      makeSnapshot({
        appId: long,
        placePath: places.map((place) => place.id),
        selection: makeSelection({
          count: 1,
          kinds: [long],
          label: long,
          ids: [long],
        }),
      }),
      Array.from({ length: 10 }, (_, index) =>
        makeEntry(index + 1, { ts: long, label: long, verbId: long }),
      ),
    );

    let longest = 0;
    forEachString(stress, (text) => {
      longest = Math.max(longest, text.length);
    });
    expect(longest).toBeLessThanOrEqual(120);

    // REQ-06.7's byte ceiling is asserted for the fixture surface.
    const fixture: ContextEnvelope = buildContextEnvelope(
      validWireframeSurface(),
      makeSnapshot({
        selection: makeSelection({
          count: 2,
          kinds: ['element', 'page'],
          label: 'Rectangle 3',
          ids: ['a', 'b'],
        }),
      }),
      [makeEntry(1, { undoable: true, inverse: {} })],
    );
    expect(envelopeByteLength(fixture)).toBeLessThanOrEqual(16384);
  });
});
