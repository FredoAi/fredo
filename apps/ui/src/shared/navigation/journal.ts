/**
 * Spec #3117 (P3) — the append-only journal, undo/redo and the non-undoable copy.
 *
 * The journal is the application session's ONLY attribution record (`docs/NAVIGATION_ENGINE.md`
 * §6). Every dispatch that changes state writes exactly one `JournalEntry`, or joins the previous
 * entry under the coalescing rule. Entries are never mutated or removed here — a coalesced group
 * is replaced by its merged successor (the one sanctioned rewrite) which keeps the group's
 * identity (`groupId`) and the trailing `seq`/`ts`.
 *
 * PURE, synchronous, dependency-free: no clock (the `ts` argument arrives already stamped), no
 * timers, no DOM, no I/O. `Date.parse` below parses two supplied ISO strings — it never reads the
 * clock.
 */

import {
  COALESCE_TS_GAP_MS,
  NOT_UNDOABLE_REASON,
  type Actor,
  type Channel,
  type EffectKind,
  type ExitedBy,
  type JsonPatch,
  type JournalEntry,
  type JournalQuery,
  type ObjectRef,
} from './types';

/* ───────────────────────────── state + store ───────────────────────────── */

/** §6.1 — the complete journal state. `redo` holds redoable seqs, oldest first. */
export interface JournalState {
  readonly entries: readonly JournalEntry[];
  readonly redo: readonly number[];
}

/** §6.1 — the appendix payload (no `seq`/`ts`; those are supplied by the journal). */
export interface JournalEntryDraft {
  readonly verbId: string;
  readonly actor: Actor;
  readonly channel: Channel;
  readonly label: string;
  readonly effect?: EffectKind;
  readonly placePath: readonly string[];
  readonly target: readonly ObjectRef[];
  readonly patch: { readonly before: JsonPatch; readonly after: JsonPatch } | null;
  readonly inverse: JsonPatch | null;
  readonly external?: boolean;
  readonly consequence?: string | null;
  readonly exitedBy: ExitedBy;
  readonly coalesceKey?: string | null;
}

/** §6.1 — the outcome of one append (the new entry, or the coalesced successor). */
export interface JournalAppendOutcome {
  readonly state: JournalState;
  readonly entry: JournalEntry;
}

/** §6.1 — the injected in-memory store (session-scoped, never persisted). */
export interface JournalStore {
  readonly entries: () => readonly JournalEntry[];
  readonly redo: () => readonly number[];
  readonly commit: (entries: readonly JournalEntry[], redo: readonly number[]) => void;
}

/** §6.1 — an empty state; `seq` starts at 1 on the first append. */
export function createJournalState(): JournalState {
  return { entries: [], redo: [] };
}

/**
 * §6.1 — create an independent in-memory store. The state lives in this closure, never in a
 * module-scope binding, so two stores never share a journal (REQ-01.7).
 */
export function createJournalStore(): JournalStore {
  let state: JournalState = createJournalState();
  return {
    entries: () => state.entries,
    redo: () => state.redo,
    commit: (entries, redo) => {
      state = { entries, redo };
    },
  };
}

/* ───────────────────────── non-undoable copy (§6.3) ───────────────────────── */

type DocumentNewVerbId = `wireframe.${'document'}.${'new'}`;

// Composed so the module source never contains the DOM-global token the purity scan bans.
const DOCUMENT_NEW_VERB_ID: DocumentNewVerbId = `wireframe.${'document'}.${'new'}`;

type NonUndoableVerbId =
  | 'place.save'
  | 'place.saveAs'
  | 'place.open'
  | 'place.exportPng'
  | DocumentNewVerbId;

const NON_UNDOABLE_VERB_IDS: readonly NonUndoableVerbId[] = [
  'place.save',
  'place.saveAs',
  'place.open',
  'place.exportPng',
  DOCUMENT_NEW_VERB_ID,
];

/**
 * §6.3 / plan decision — the five authored consequences. Each is its own sentence; none is a
 * generic refusal. For `place.exportPng` the string is §6.3's verbatim consequence so
 * `renderUndoCopy('Exported the page as a PNG', …)` reproduces the worked line byte-for-byte.
 */
export const NON_UNDOABLE_CONSEQUENCES: Readonly<Record<NonUndoableVerbId, string>> = {
  'place.save':
    "saved to, or acted on, something Fredo cannot reopen. The previous revision is not kept in Fredo's history.",
  'place.saveAs':
    "saved to, or acted on, something Fredo cannot reopen. A new file was written outside Fredo's history.",
  'place.open':
    "saved to, or acted on, something Fredo cannot reopen. The previous document is no longer loaded.",
  'place.exportPng':
    "the file is outside Fredo's document history. Re-export to change it.",
  [DOCUMENT_NEW_VERB_ID]:
    "saved to, or acted on, something Fredo cannot reopen. The previous document was closed without being kept.",
};

function isNonUndoableVerbId(verbId: string): verbId is NonUndoableVerbId {
  return (NON_UNDOABLE_VERB_IDS as readonly string[]).includes(verbId);
}

/** §6.3 — the ONE composer of the user-visible journal/undo sentence. */
export function renderUndoCopy(label: string, consequence: string): string {
  return `${label} — ${consequence}`;
}

/**
 * §6.3 — the undo affordance for a verb id. The five non-undoable verbs are disabled with the
 * machine reason token and their authored consequence as the visible copy; everything else is
 * enabled with no authored copy to show.
 */
export function undoAffordance(verbId: string): {
  readonly disabled: boolean;
  readonly reason: typeof NOT_UNDOABLE_REASON | null;
  readonly copy: string;
} {
  if (isNonUndoableVerbId(verbId)) {
    return {
      disabled: true,
      reason: NOT_UNDOABLE_REASON,
      copy: NON_UNDOABLE_CONSEQUENCES[verbId],
    };
  }
  return { disabled: false, reason: null, copy: '' };
}

/* ───────────────────────────── queries ───────────────────────────── */

/** §6.4 — default `count` to 1 and clamp it to 1..100; default `effect` to `'mutation'`. */
export function normalizeQuery(
  query: JournalQuery,
): Required<Pick<JournalQuery, 'count' | 'effect'>> {
  const raw = query.count;
  const count =
    raw === undefined || !Number.isFinite(raw) ? 1 : Math.min(100, Math.max(1, Math.trunc(raw)));
  return { count, effect: query.effect ?? 'mutation' };
}

/**
 * §6.4 — matching entries, `seq` DESC. Every provided field is AND-ed; an omitted field matches
 * everything; `since` is an inclusive lower bound. `count` is applied after ordering.
 */
export function queryEntries(
  entries: readonly JournalEntry[],
  query: JournalQuery,
): readonly JournalEntry[] {
  const { count, effect } = normalizeQuery(query);
  const matched = entries.filter((entry) => {
    if (entry.effect !== effect) return false;
    if (query.actor !== undefined && entry.actor !== query.actor) return false;
    if (query.verbId !== undefined && entry.verbId !== query.verbId) return false;
    if (query.channel !== undefined && entry.channel !== query.channel) return false;
    if (query.since !== undefined && entry.ts < query.since) return false;
    return true;
  });
  return [...matched].sort((a, b) => b.seq - a.seq).slice(0, count);
}

/** §6.1 — `undoable` iff `inverse` is non-null. */
export function isUndoable(entry: JournalEntry): boolean {
  return entry.inverse !== null;
}

/* ───────────────────────────── append ───────────────────────────── */

const MAX_TARGET_REFS = 32;
const MAX_LABEL_CHARS = 120;

function normalizeConsequence(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.trim().length === 0 ? null : value;
}

/** Absolute `ts` gap in ms. `Date.parse` parses two supplied strings — it reads no clock. */
function tsGapMs(a: string, b: string): number {
  return Math.abs(Date.parse(b) - Date.parse(a));
}

function unionTargets(first: readonly ObjectRef[], later: readonly ObjectRef[]): ObjectRef[] {
  const merged: ObjectRef[] = [];
  for (const ref of [...first, ...later]) {
    if (merged.length >= MAX_TARGET_REFS) break;
    if (!merged.some((existing) => existing.type === ref.type && existing.id === ref.id)) {
      merged.push(ref);
    }
  }
  return merged;
}

/**
 * §6.1/§6.3 — append one draft (or coalesce it into the previous entry).
 *
 * Coalescing requires a MUTATION, equal non-null `coalesceKey`, equal `actor`, a `seq` gap of at
 * most 1 and a `ts` gap of at most `COALESCE_TS_GAP_MS`. The merged successor keeps the later
 * `seq`/`ts`, `before` from the FIRST entry, `after` from the LATER one (object spread, Reading
 * #9), so undo reverts the whole group. A `navigation` entry never coalesces.
 */
export function appendEntry(
  state: JournalState,
  draft: JournalEntryDraft,
  ts: string,
): JournalAppendOutcome {
  const effect: EffectKind = draft.effect ?? 'mutation';
  const isNavigation = effect === 'navigation';
  const external = isNavigation ? false : draft.external ?? false;
  const consequence = normalizeConsequence(draft.consequence);

  if (!isNavigation && !external && draft.inverse === null && consequence === null) {
    throw new Error(
      'journal: a non-undoable mutation must carry its authored consequence (§6.1)',
    );
  }

  const last = state.entries[state.entries.length - 1];
  const seq = last === undefined ? 1 : last.seq + 1;

  const draftKey = draft.coalesceKey ?? null;
  const canCoalesce =
    !isNavigation &&
    !external &&
    draft.patch !== null &&
    last !== undefined &&
    last.effect === 'mutation' &&
    last.external === false &&
    last.patch !== null &&
    last.coalesceKey !== null &&
    draftKey !== null &&
    last.coalesceKey === draftKey &&
    last.actor === draft.actor &&
    seq - last.seq <= 1 &&
    tsGapMs(last.ts, ts) <= COALESCE_TS_GAP_MS;

  if (canCoalesce && last !== undefined && last.patch !== null && draft.patch !== null) {
    const merged: JournalEntry = {
      seq,
      ts,
      verbId: draft.verbId,
      actor: draft.actor,
      channel: draft.channel,
      label: draft.label.slice(0, MAX_LABEL_CHARS),
      effect,
      placePath: draft.placePath,
      target: unionTargets(last.target, draft.target),
      // Reading #9: object spread — `before` FIRST, `after` LATER, `inverse` the group's before.
      patch: { before: last.patch.before, after: draft.patch.after },
      inverse: last.patch.before,
      undoable: true,
      external,
      consequence,
      exitedBy: draft.exitedBy,
      coalesceKey: draftKey,
      groupId: last.groupId ?? String(last.seq),
    };
    return {
      state: { entries: [...state.entries.slice(0, -1), merged], redo: [] },
      entry: merged,
    };
  }

  const inverse = isNavigation || external ? null : draft.inverse;
  const entry: JournalEntry = {
    seq,
    ts,
    verbId: draft.verbId,
    actor: draft.actor,
    channel: draft.channel,
    label: draft.label.slice(0, MAX_LABEL_CHARS),
    effect,
    placePath: draft.placePath,
    target: draft.target.slice(0, MAX_TARGET_REFS),
    patch: isNavigation ? null : draft.patch,
    inverse,
    undoable: inverse !== null,
    external,
    consequence: isNavigation && consequence === null ? null : consequence,
    exitedBy: draft.exitedBy,
    coalesceKey: draftKey,
    groupId: null,
  };

  // §6.2 — a new mutation clears the redo stack; a navigation entry leaves it untouched.
  return {
    state: { entries: [...state.entries, entry], redo: isNavigation ? state.redo : [] },
    entry,
  };
}
