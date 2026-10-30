/**
 * Spec #3120 (P6), ST-5 — the launcher navigation palette projection.
 *
 * ONE tested projection from a `Surface` + the live `ContextSnapshot` + the journal's
 * recent verb ids to the grouped Place → Verb listbox the shell renders:
 *
 *   - **row order is the shipped P3 `derivePalette` order** (recents first, newest-first,
 *     deduped, stale ids dropped BEFORE the cap of `PALETTE_MAX_RECENTS`; then every verb
 *     grouped by place in tree order). The projection consumes `derivePalette` directly,
 *     so the two can never drift and a model that filtered unpublished/unavailable rows
 *     would fail the parity pin (QA R-2.1);
 *   - **row `section:'recent'`** rides the P3 row; the UI renders the `Recent` micro-label
 *     instead of inventing a second group id;
 *   - **`key`/`keyHint` come from the row's `primaryPlaceId`** (P3's `firstKeyInPlace`) —
 *     never a global key lookup, so a multi-binding verb shows its primary place's binding;
 *   - **`groups` is place-keyed** and ordered by the first row that belongs to the place,
 *     so recents render first and each place appears exactly once;
 *   - `available`/`reason` add the P6 fields the P3 row does not carry.
 *
 * `filterLauncherPaletteModel` is a thin pure projection over the BUILT model (the builder
 * signature stays unchanged): case-insensitive substring over `title + pathLabel + keyHint`,
 * empty groups dropped, order preserved, `rows` re-flattened so the selection index is
 * stable. Filtering never re-derives availability.
 *
 * `buildLauncherRowActions` is the ONE source of a row's level-2 actions (run / undo /
 * map). PURE: no React, no DOM, no clock, no I/O.
 */

import {
  derivePalette,
  type ContextSnapshot,
  type JournalEntry,
  type PlaceRef,
  type Risk,
  type Surface,
} from '../../../../shared/navigation';
import { NAV_UNAVAILABLE_REASON } from '../../../../shared/navigation/ui/constants';
import { formatKeyHint, formatPlacePathLabel, riskLabel } from '../../../../shared/navigation/ui/format';

/** One palette row (binding shape — §3.4). */
export interface LauncherPaletteRow {
  readonly kind: 'verb';
  readonly verbId: string;
  readonly title: string;
  readonly placePath: readonly { readonly id: string; readonly label: string }[];
  /** `'Canvas › Create'` — the ONE P4 formatter, never a second join. */
  readonly pathLabel: string;
  /** The first binding in the row's place (`firstKeyInPlace`), `null` when unbound. */
  readonly key: string | null;
  /** `formatKeyHint([key])` — `''` when unbound. */
  readonly keyHint: string;
  readonly risk: Risk;
  /** `null` iff `risk === 'safe'` (a safe row carries no risk chip). */
  readonly riskLabel: string | null;
  readonly section: 'recent' | 'place';
  readonly available: boolean;
  /** `NAV_UNAVAILABLE_REASON` iff `!available`. */
  readonly reason: string | null;
}

/** One place group (binding shape — §3.4). */
export interface LauncherPaletteGroup {
  readonly placeId: string;
  readonly pathLabel: string;
  readonly rows: readonly LauncherPaletteRow[];
}

/** The ONE view-model the list renders (binding shape — §3.4). */
export interface LauncherPaletteModel {
  readonly appId: string;
  /** Place-keyed groups in first-appearance order (recents-first). */
  readonly groups: readonly LauncherPaletteGroup[];
  /** Flattened selection order — the shipped `derivePalette` order. */
  readonly rows: readonly LauncherPaletteRow[];
  readonly recentsCount: number;
}

/** One level-2 action on a palette row (binding shape — §3.4). */
export type LauncherRowAction =
  | { readonly kind: 'run'; readonly label: string; readonly verbId: string }
  | { readonly kind: 'undo'; readonly label: string; readonly verbId: string }
  | { readonly kind: 'map'; readonly label: string; readonly placeId: string };

/** The engine verb a secondary `undo` action dispatches through (`journal.undo`). */
const JOURNAL_UNDO_VERB_ID = 'journal.undo';

/** The place id a projected row belongs to (its `placePath`'s deepest segment). */
function rowPlaceId(row: LauncherPaletteRow): string | null {
  return row.placePath[row.placePath.length - 1]?.id ?? null;
}

/**
 * Project the P3 palette into the grouped P6 model.
 *
 * `recents` is the journal's recent verb ids (`envelope.journal.last.map(e => e.verbId)`);
 * `derivePalette` owns the dedupe/stale-drop/cap rules, so the model only enriches.
 */
export function buildLauncherPaletteModel(
  surface: Surface,
  snapshot: ContextSnapshot,
  recents: readonly string[],
): LauncherPaletteModel {
  const placeById = new Map(surface.tree.places.map((place) => [place.id, place]));
  const verbById = new Map(surface.verbs.map((verb) => [verb.id, verb]));

  const rows: LauncherPaletteRow[] = [];
  for (const projected of derivePalette(surface, snapshot, recents)) {
    const verb = verbById.get(projected.verbId);
    // `derivePalette` only emits registered verbs; the guard keeps the projection total
    // without a non-null assertion.
    if (verb === undefined) continue;

    const placePath: PlaceRef[] = projected.placePath.map((id) => {
      const place = placeById.get(id);
      return place === undefined
        ? { id, label: id, transient: false, sticky: false }
        : { id, label: place.label, transient: place.transient, sticky: place.sticky };
    });
    const available = verb.available(snapshot);

    rows.push({
      kind: 'verb',
      verbId: verb.id,
      title: verb.title,
      placePath,
      pathLabel: formatPlacePathLabel(placePath),
      key: projected.key,
      keyHint: formatKeyHint(projected.key === null ? [] : [projected.key]),
      risk: verb.risk,
      riskLabel: riskLabel(verb.risk),
      section: projected.section,
      available,
      reason: available ? null : NAV_UNAVAILABLE_REASON,
    });
  }

  // Place-keyed groups, ordered by the first row that belongs to the place. Every row is
  // in exactly one group; recents therefore lead (P3 emits them first).
  const groupOrder: string[] = [];
  const groupRows = new Map<string, LauncherPaletteRow[]>();
  const groupLabels = new Map<string, string>();
  for (const row of rows) {
    const placeId = rowPlaceId(row);
    if (placeId === null) continue;
    let bucket = groupRows.get(placeId);
    if (bucket === undefined) {
      bucket = [];
      groupRows.set(placeId, bucket);
      groupOrder.push(placeId);
      groupLabels.set(placeId, row.pathLabel);
    }
    bucket.push(row);
  }

  const groups: LauncherPaletteGroup[] = groupOrder.map((placeId) => ({
    placeId,
    pathLabel: groupLabels.get(placeId) ?? placeId,
    rows: groupRows.get(placeId) ?? [],
  }));

  return {
    appId: surface.tree.appId,
    groups,
    rows,
    recentsCount: rows.reduce((count, row) => (row.section === 'recent' ? count + 1 : count), 0),
  };
}

/** True when `term` occurs (case-insensitively) in the row's searchable text. */
function rowMatches(row: LauncherPaletteRow, needle: string): boolean {
  return `${row.title} ${row.pathLabel} ${row.keyHint}`.toLowerCase().includes(needle);
}

/**
 * Pure client-side filter over the BUILT model. An empty/whitespace term returns the model
 * unchanged; group/row order is preserved; empty groups are dropped; `rows` is re-flattened
 * from the filtered groups so a selection index over `model.rows` stays meaningful.
 */
export function filterLauncherPaletteModel(
  model: LauncherPaletteModel,
  term: string,
): LauncherPaletteModel {
  const needle = term.trim().toLowerCase();
  if (needle === '') return model;

  const groups = model.groups
    .map((group) => ({ ...group, rows: group.rows.filter((row) => rowMatches(row, needle)) }))
    .filter((group) => group.rows.length > 0);
  const rows = groups.flatMap((group) => group.rows);

  return {
    appId: model.appId,
    groups,
    rows,
    recentsCount: rows.reduce((count, row) => (row.section === 'recent' ? count + 1 : count), 0),
  };
}

/** The newest undoable journal entry for `verbId`, or `null`. */
function newestUndoableEntry(
  entries: readonly JournalEntry[],
  verbId: string,
): JournalEntry | null {
  let newest: JournalEntry | null = null;
  for (const entry of entries) {
    if (entry.verbId !== verbId) continue;
    if (!entry.undoable || entry.inverse === null) continue;
    if (newest === null || entry.seq > newest.seq) newest = entry;
  }
  return newest;
}

/**
 * The row's level-2 actions in display order: run, undo (only when that verb has an
 * undoable journal entry), map. No synthetic "Run" row is added by the panel — this is the
 * ONE source.
 *
 * The `undo` action carries the DISPATCH verb (`journal.undo`), so a literal
 * `host.runIntent({ verbId: action.verbId, channel:'launcher', actor:'human' })` performs an
 * undo; its `label` names the entry being reversed (`Undo Delete`).
 */
export function buildLauncherRowActions(
  row: LauncherPaletteRow,
  entries: readonly JournalEntry[],
): readonly LauncherRowAction[] {
  const actions: LauncherRowAction[] = [
    { kind: 'run', label: `Run ${row.title}`, verbId: row.verbId },
  ];

  const undoable = newestUndoableEntry(entries, row.verbId);
  if (undoable !== null) {
    actions.push({ kind: 'undo', label: `Undo ${undoable.label}`, verbId: JOURNAL_UNDO_VERB_ID });
  }

  const placeId = rowPlaceId(row);
  if (placeId !== null) {
    actions.push({ kind: 'map', label: 'Show in map', placeId });
  }

  return actions;
}
