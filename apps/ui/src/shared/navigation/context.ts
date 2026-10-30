/**
 * Spec #3117 (P3) — §7 context envelope: the ONE read model P4 consumes.
 *
 * `buildContextEnvelope` projects the declaration + the injected snapshot + the journal
 * into a plain, JSON-serialisable v1 envelope. Every value comes from its arguments — it
 * reads no application store, no command surface, no `data-hotkey` listing and no
 * journal-global (REQ-06.8). Every string is truncated to `maxLabelChars` and every list
 * is capped before it leaves the function, so the envelope is bounded by construction.
 *
 * PURE: no clock, no DOM, no I/O; imports only the leaf vocabulary and the shared index.
 */

import {
  CAPABILITY_LIMITS,
  CONTEXT_VERSION,
  type ContextEnvelope,
  type ContextSnapshot,
  type JournalEntry,
  type JournalSummary,
  type PlaceRef,
  type Surface,
  type VerbSummary,
} from './types';
import { createRegistry } from './registry';

/** §7.1 — truncate one string to `maxLabelChars` code units. */
function truncate(value: string): string {
  return value.length > CAPABILITY_LIMITS.maxLabelChars
    ? value.slice(0, CAPABILITY_LIMITS.maxLabelChars)
    : value;
}

/** Preserve first occurrence order while removing duplicates. */
function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

/**
 * §7.1 — `placePath` root → current, truncated to `maxPathDepth` by KEEPING the root
 * plus the deepest seven. Unknown place ids are dropped (never invented).
 */
function buildPlacePath(surface: Surface, snapshot: ContextSnapshot): PlaceRef[] {
  const reg = createRegistry(surface);
  const refs: PlaceRef[] = [];
  for (const placeId of snapshot.placePath) {
    const place = reg.placesById.get(placeId);
    if (place === undefined) continue;
    refs.push({
      id: truncate(place.id),
      label: truncate(place.label),
      transient: place.transient,
      sticky: place.sticky,
    });
  }
  const max = CAPABILITY_LIMITS.maxPathDepth;
  if (refs.length <= max) return refs;
  return [refs[0], ...refs.slice(refs.length - (max - 1))];
}

/** §7.1 — selection summary: true count, deduped kinds, optional label, capped ids. */
function buildSelection(snapshot: ContextSnapshot): ContextEnvelope['selection'] {
  const kinds = uniqueStrings(
    snapshot.selection.kinds.map((kind) => truncate(kind)),
  ).slice(0, 8);
  const label =
    snapshot.selection.label === null ? null : truncate(snapshot.selection.label);
  const ids = snapshot.selection.ids
    .slice(0, CAPABILITY_LIMITS.maxSelectionIds)
    .map((id) => truncate(id));
  return {
    count: snapshot.selection.count,
    kinds,
    label,
    ids,
  };
}

/** §7.1 — verb summary rows in declaration order, capped at `maxVerbs`. */
function buildVerbSummaries(
  surface: Surface,
  snapshot: ContextSnapshot,
): VerbSummary[] {
  const reg = createRegistry(surface);
  const verbs: VerbSummary[] = [];
  for (const verb of surface.verbs) {
    if (verbs.length >= CAPABILITY_LIMITS.maxVerbs) break;
    const keys = (reg.keysByVerb.get(verb.id) ?? []).map((stroke) => truncate(stroke));
    verbs.push({
      id: truncate(verb.id),
      title: truncate(verb.title),
      risk: verb.risk,
      keys,
      available: verb.available(snapshot),
      // Pin #2: no declaration field carries an authored reason, so never fabricate one.
      unavailableReason: null,
    });
  }
  return verbs;
}

/** §7.1 — newest-first journal summary, capped at `maxJournalEntries`. */
function buildJournal(entries: readonly JournalEntry[]): ContextEnvelope['journal'] {
  const newestFirst = [...entries].sort((left, right) => right.seq - left.seq);
  const last: JournalSummary[] = newestFirst
    .slice(0, CAPABILITY_LIMITS.maxJournalEntries)
    .map((entry) => ({
      seq: entry.seq,
      ts: truncate(entry.ts),
      verbId: truncate(entry.verbId),
      actor: entry.actor,
      label: truncate(entry.label),
      undoable: entry.undoable,
    }));
  let undoableCount = 0;
  for (const entry of entries) {
    if (entry.undoable) undoableCount += 1;
  }
  return { last, undoableCount };
}

/**
 * §7.1 — build the envelope v1.
 *
 * Deterministic and total for a well-typed surface + snapshot + entries: the same
 * arguments always produce a deep-equal (and byte-identical) envelope.
 */
export function buildContextEnvelope(
  surface: Surface,
  snapshot: ContextSnapshot,
  entries: readonly JournalEntry[],
): ContextEnvelope {
  return {
    version: CONTEXT_VERSION,
    appId: truncate(snapshot.appId),
    placePath: buildPlacePath(surface, snapshot),
    selection: buildSelection(snapshot),
    verbs: buildVerbSummaries(surface, snapshot),
    journal: buildJournal(entries),
    dirty: snapshot.dirty,
    limits: CAPABILITY_LIMITS,
  };
}

/**
 * §7.1 — the serialized envelope's UTF-8 byte length (≤ `maxContextBytes`).
 *
 * Counted directly from the JSON string so the helper stays free of globals and works in
 * any host (a surrogate pair is one four-byte code point, never two three-byte units).
 */
export function envelopeByteLength(envelope: ContextEnvelope): number {
  const json = JSON.stringify(envelope);
  let bytes = 0;
  for (let index = 0; index < json.length; ) {
    const codePoint = json.codePointAt(index) ?? 0;
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
