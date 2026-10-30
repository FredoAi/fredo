/**
 * Spec #3118 (P4), ST-1 — the controlled unit fixture every P4 surface suite imports.
 *
 * Owned by ST-1; ST-2…ST-6 import from here and do NOT redefine the surface. This exists so
 * the view-model suites never depend on ST-6's product demo declaration (no dependency
 * inversion, Architect C6 / QA GAP 9).
 *
 * Contents:
 *   - **D1** `navTestSurface()` — the declared tree: root `test.canvas` labelled `Canvas`
 *     binding `c/i/a/s/v/f` to the six place-entry verbs and `m`/`k` to the two declared
 *     globals; children `Create` (transient), `Edit`, `Arrange` (9 bound verbs), `Style`,
 *     `View` (no keys, no verbs), `File` (all sticky); `directAliases` `r/e/u/y`; verbs
 *     include a `destructive` (`test.delete`), an `external` non-undoable (`test.exportPng`)
 *     and one conditionally unavailable (`test.paste`).
 *   - **D3** the four PURE clone-mutators — `addPlace`, `renameVerbTitle`, `addDirectAlias`,
 *     `renamePlace` — each returns a new `Surface` and never mutates its input.
 *   - **D4** the journal builders — `seedEntries`, `seedCompanionEntry`,
 *     `seedNonUndoableEntry` — over the shipped `createJournalState` / `appendEntry`.
 *
 * The labels deliberately mirror the demo declaration so unit copy equals live copy. Every
 * builder is deterministic: no clock, no randomness, no shared mutable state.
 */

import {
  NON_UNDOABLE_CONSEQUENCES,
  appendEntry,
  createJournalState,
  type ContextSnapshot,
  type EffectKind,
  type JournalEntry,
  type JournalState,
  type KeyBinding,
  type PlaceNode,
  type SelectionSnapshot,
  type Surface,
  type VerbDescriptor,
  type VerbEffect,
} from '../../';

/* ───────────────────────────── declared ids ───────────────────────────── */

/** The fixture's place ids — the only ids the suites should reference. */
export const FIXTURE_PLACES = {
  canvas: 'test.canvas',
  create: 'test.create',
  edit: 'test.edit',
  arrange: 'test.arrange',
  style: 'test.style',
  view: 'test.view',
  file: 'test.file',
  archive: 'test.archive',
} as const;

/** The fixture's app id. */
export const FIXTURE_APP_ID = 'test';

/* ───────────────────────────── builders ───────────────────────────── */

type VerbKind = 'mutation' | 'navigation' | 'external';

interface VerbMeta {
  readonly kind: VerbKind;
  readonly consequence: string | null;
}

/** How a descriptor's `run` behaves, so `renameVerbTitle` can rebuild the SAME kind. */
const VERB_META = new WeakMap<VerbDescriptor, VerbMeta>();

/** The deterministic effect a fixture verb reports (never reads a clock or a document). */
function effectFor(
  kind: VerbKind,
  title: string,
  verbId: string,
  consequence: string | null,
): VerbEffect {
  if (kind === 'navigation') {
    return { label: title, effect: 'navigation', patch: null, inverse: null, target: [] };
  }
  if (kind === 'external') {
    return {
      label: title,
      effect: 'mutation',
      patch: { before: {}, after: {} },
      inverse: null,
      target: [],
      external: true,
      ...(consequence === null ? {} : { consequence }),
    };
  }
  return {
    label: title,
    effect: 'mutation',
    patch: { before: { [verbId]: 0 }, after: { [verbId]: 1 } },
    inverse: { [verbId]: 0 },
    target: [],
  };
}

interface VerbSpec {
  readonly id: string;
  readonly title: string;
  /** Places the verb declares in `appliesTo.places` (V-06 requires it covers every binding). */
  readonly places: readonly string[];
  readonly risk?: VerbDescriptor['risk'];
  readonly kind?: VerbKind;
  readonly consequence?: string;
  readonly available?: (ctx: ContextSnapshot) => boolean;
}

function makeVerb(spec: VerbSpec): VerbDescriptor {
  const kind: VerbKind = spec.kind ?? 'mutation';
  const consequence = spec.consequence ?? null;
  const descriptor: VerbDescriptor = {
    id: spec.id,
    title: spec.title,
    description: `${spec.title} the current page.`,
    appliesTo: { objects: ['element'], places: [...spec.places] },
    args: [],
    available: spec.available ?? (() => true),
    risk: spec.risk ?? 'safe',
    aliases: [],
    run: () => effectFor(kind, spec.title, spec.id, consequence),
    ...(consequence === null ? {} : { consequence }),
    publish: true,
  };
  VERB_META.set(descriptor, { kind, consequence });
  return descriptor;
}

interface PlaceSpec {
  readonly id: string;
  readonly label: string;
  readonly parent?: string | null;
  readonly transient?: boolean;
  readonly sticky?: boolean;
  readonly keys?: Readonly<Record<string, KeyBinding>>;
}

function makePlace(spec: PlaceSpec): PlaceNode {
  return {
    id: spec.id,
    label: spec.label,
    parent: spec.parent ?? null,
    transient: spec.transient ?? false,
    sticky: spec.sticky ?? false,
    cursor: null,
    operator: null,
    keys: spec.keys ?? {},
    entryHooks: ['observable'],
    exitHooks: ['observable'],
  };
}

function verb(value: string): KeyBinding {
  return { kind: 'verb', verbId: value };
}

function place(value: string): KeyBinding {
  return { kind: 'place', placeId: value };
}

/* ───────────────────────────── D1 — navTestSurface ───────────────────────────── */

/** The six root-bound place-entry verbs, in declaration order (the rail's root rows). */
const ENTRY_VERBS: readonly { id: string; title: string; key: string }[] = [
  { id: 'test.create', title: 'Create', key: 'c' },
  { id: 'test.edit', title: 'Edit', key: 'i' },
  { id: 'test.arrange', title: 'Arrange', key: 'a' },
  { id: 'test.style', title: 'Style', key: 's' },
  { id: 'test.view', title: 'View', key: 'v' },
  { id: 'test.file', title: 'File', key: 'f' },
];

/** The nine Arrangement verbs (bound in `test.arrange`), in declaration order. */
const ARRANGE_VERBS: readonly { id: string; title: string; key: string }[] = [
  { id: 'test.alignLeft', title: 'Align left', key: 'l' },
  { id: 'test.alignCenter', title: 'Align center', key: 'c' },
  { id: 'test.alignRight', title: 'Align right', key: 'i' },
  { id: 'test.distribute', title: 'Distribute', key: 'd' },
  { id: 'test.group', title: 'Group', key: 'g' },
  { id: 'test.ungroup', title: 'Ungroup', key: 'n' },
  { id: 'test.bringForward', title: 'Bring forward', key: 'b' },
  { id: 'test.sendBackward', title: 'Send backward', key: 'w' },
  { id: 'test.lockSelection', title: 'Lock selection', key: 'o' },
];

/**
 * D1 — the declared fixture surface. A NEW object graph on every call (no shared mutable
 * state between tests); `validateSurface(navTestSurface())` returns `[]`.
 */
export function navTestSurface(): Surface {
  const { canvas, create, edit, arrange, style, view, file } = FIXTURE_PLACES;

  const entryBindings: Record<string, KeyBinding> = {};
  for (const entry of ENTRY_VERBS) entryBindings[entry.key] = verb(entry.id);
  entryBindings.m = verb('app.map');
  entryBindings.k = verb('app.ask');

  const arrangeBindings: Record<string, KeyBinding> = {};
  for (const arrangeVerb of ARRANGE_VERBS) arrangeBindings[arrangeVerb.key] = verb(arrangeVerb.id);

  const places: PlaceNode[] = [
    makePlace({ id: canvas, label: 'Canvas', keys: entryBindings }),
    makePlace({
      id: create,
      label: 'Create',
      parent: canvas,
      transient: true,
      keys: { r: verb('test.rect'), e: verb('test.ellipse') },
    }),
    makePlace({
      id: edit,
      label: 'Edit',
      parent: canvas,
      sticky: true,
      keys: { x: verb('test.delete'), d: verb('test.duplicate'), p: verb('test.paste') },
    }),
    makePlace({
      id: arrange,
      label: 'Arrange',
      parent: canvas,
      sticky: true,
      keys: arrangeBindings,
    }),
    makePlace({
      id: style,
      label: 'Style',
      parent: canvas,
      sticky: true,
      keys: { f: verb('test.setFill') },
    }),
    // Deliberately declares NO keys and NO verbs: the rail never pads (QA Q1-06).
    makePlace({ id: view, label: 'View', parent: canvas, sticky: true }),
    makePlace({
      id: file,
      label: 'File',
      parent: canvas,
      sticky: true,
      keys: { x: verb('test.exportPng'), s: verb('test.save') },
    }),
  ];

  const verbs: VerbDescriptor[] = [
    ...ENTRY_VERBS.map((entry) =>
      makeVerb({
        id: entry.id,
        title: entry.title,
        places: [canvas],
        kind: 'navigation',
      }),
    ),
    // Declared so the two globals are legal verb targets (V-05); both are bound at the root.
    makeVerb({ id: 'app.map', title: 'Map', places: [canvas], kind: 'navigation' }),
    makeVerb({ id: 'app.ask', title: 'Ask', places: [canvas], kind: 'navigation' }),
    makeVerb({ id: 'test.rect', title: 'Rectangle', places: [create] }),
    makeVerb({ id: 'test.ellipse', title: 'Ellipse', places: [create] }),
    makeVerb({
      id: 'test.delete',
      title: 'Delete',
      places: [edit],
      risk: 'destructive',
      consequence: 'the selection is removed and is not kept in history.',
    }),
    makeVerb({ id: 'test.duplicate', title: 'Duplicate', places: [edit] }),
    makeVerb({
      id: 'test.paste',
      title: 'Paste',
      places: [edit],
      // Conditionally unavailable: the default snapshot has an empty selection.
      available: (ctx) => ctx.selection.count > 0,
    }),
    ...ARRANGE_VERBS.map((arrangeVerb) =>
      makeVerb({ id: arrangeVerb.id, title: arrangeVerb.title, places: [arrange] }),
    ),
    makeVerb({ id: 'test.setFill', title: 'Fill', places: [style] }),
    makeVerb({
      id: 'test.exportPng',
      title: 'Export PNG',
      places: [file],
      risk: 'external',
      kind: 'external',
      consequence: NON_UNDOABLE_CONSEQUENCES['place.exportPng'],
    }),
    makeVerb({ id: 'test.save', title: 'Save', places: [file] }),
  ];

  return {
    tree: {
      appId: FIXTURE_APP_ID,
      root: canvas,
      places,
      directAliases: {
        r: 'test.rect',
        e: 'test.ellipse',
        u: 'journal.undo',
        y: 'journal.redo',
      },
    },
    verbs,
    companion: { appName: 'Test', description: 'The P4 unit fixture surface.' },
  };
}

/** The fixture's default selection (empty — so `test.paste` is unavailable). */
export function fixtureSelection(
  overrides: Partial<SelectionSnapshot> = {},
): SelectionSnapshot {
  return {
    count: overrides.count ?? 0,
    kinds: overrides.kinds ?? [],
    label: overrides.label ?? null,
    ids: overrides.ids ?? [],
  };
}

/** A deterministic snapshot for the fixture: `placePath` defaults to the declared root. */
export function fixtureSnapshot(
  placePath: readonly string[] = [FIXTURE_PLACES.canvas],
  overrides: Partial<ContextSnapshot> = {},
): ContextSnapshot {
  return {
    appId: FIXTURE_APP_ID,
    placePath,
    selection: overrides.selection ?? fixtureSelection(),
    dirty: overrides.dirty ?? false,
    ...overrides,
  };
}

/* ───────────────────────────── D3 — pure clone-mutators ───────────────────────────── */

/** Append `value` to `list` when absent, preserving order. */
function withValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? [...list] : [...list, value];
}

/** Replace one place (immutably) in a declaration. */
function mapPlace(surface: Surface, placeId: string, update: (place: PlaceNode) => PlaceNode): Surface {
  return {
    ...surface,
    tree: {
      ...surface.tree,
      places: surface.tree.places.map((place) =>
        place.id === placeId ? update(place) : place,
      ),
    },
  };
}

export interface AddPlaceOptions {
  readonly placeId?: string;
  readonly label?: string;
  readonly parentId?: string;
  /** The parent's stroke that enters the new place (a PLACE binding — never a rail row). */
  readonly keyStroke?: string;
  /** The verb bound INSIDE the new place (also added to that verb's `appliesTo.places`). */
  readonly bindVerbId?: string;
  readonly verbStroke?: string;
}

/**
 * Add `test.archive` under `test.canvas` (key `z`), binding `x → test.rect` inside it.
 *
 * The new place is appended in declaration order; the parent gains a PLACE-target key (so
 * `deriveRail` gains no row — Q6-01a), and `test.rect` declares the new place in
 * `appliesTo.places` so V-06 holds and `deriveMap` lists the verb in the Archive block.
 */
export function addPlace(surface: Surface, options: AddPlaceOptions = {}): Surface {
  const placeId = options.placeId ?? FIXTURE_PLACES.archive;
  const parentId = options.parentId ?? FIXTURE_PLACES.canvas;
  const label = options.label ?? 'Archive';
  const keyStroke = options.keyStroke ?? 'z';
  const bindVerbId = options.bindVerbId ?? 'test.rect';
  const verbStroke = options.verbStroke ?? 'x';

  const withKey = mapPlace(surface, parentId, (parent) => ({
    ...parent,
    keys: { ...parent.keys, [keyStroke]: place(placeId) },
  }));

  const verbs = surface.verbs.map((candidate) =>
    candidate.id === bindVerbId
      ? {
          ...candidate,
          appliesTo: {
            ...candidate.appliesTo,
            places: withValue(candidate.appliesTo.places, placeId),
          },
        }
      : candidate,
  );

  const newPlace = makePlace({
    id: placeId,
    label,
    parent: parentId,
    sticky: true,
    keys: { [verbStroke]: verb(bindVerbId) },
  });

  return {
    ...withKey,
    verbs,
    tree: { ...withKey.tree, places: [...withKey.tree.places, newPlace] },
  };
}

/** Rename one verb's TITLE (its `run` reports the new title, so a dispatch label follows). */
export function renameVerbTitle(surface: Surface, verbId: string, title: string): Surface {
  return {
    ...surface,
    verbs: surface.verbs.map((candidate) => {
      if (candidate.id !== verbId) return candidate;
      const meta = VERB_META.get(candidate) ?? { kind: 'mutation' as VerbKind, consequence: null };
      const renamed: VerbDescriptor = {
        ...candidate,
        title,
        run: () => effectFor(meta.kind, title, candidate.id, meta.consequence),
      };
      VERB_META.set(renamed, meta);
      return renamed;
    }),
  };
}

/** Add one application-level direct alias (tier 2 — never a place binding). */
export function addDirectAlias(surface: Surface, stroke: string, verbId: string): Surface {
  return {
    ...surface,
    tree: {
      ...surface.tree,
      directAliases: { ...surface.tree.directAliases, [stroke]: verbId },
    },
  };
}

/** Rename one place's label (the declaration stays the only label source). */
export function renamePlace(surface: Surface, placeId: string, label: string): Surface {
  return mapPlace(surface, placeId, (place) => ({ ...place, label }));
}

/* ───────────────────────────── D4 — journal builders ───────────────────────────── */

/** A deterministic ISO timestamp: 2026-01-01T09:mm:00.000Z (minute = `minute`). */
export function fixtureTimestamp(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 9, minute, 0, 0)).toISOString();
}

function journalStateOf(entries: readonly JournalEntry[]): JournalState {
  return { entries, redo: [] };
}

interface SeedDraft {
  readonly verbId: string;
  readonly label: string;
  readonly actor: JournalEntry['actor'];
  readonly channel: JournalEntry['channel'];
  readonly placePath: readonly string[];
  readonly effect?: EffectKind;
  readonly patch: JournalEntry['patch'];
  readonly inverse: JournalEntry['inverse'];
  readonly consequence?: string | null;
  readonly external?: boolean;
}

/** Append one deterministic entry onto `prior`, returning BOTH the new list and the entry. */
function appendSeed(
  prior: readonly JournalEntry[],
  draft: SeedDraft,
  ts: string,
): { entries: JournalEntry[]; entry: JournalEntry } {
  const outcome = appendEntry(
    journalStateOf(prior),
    {
      verbId: draft.verbId,
      actor: draft.actor,
      channel: draft.channel,
      label: draft.label,
      ...(draft.effect === undefined ? {} : { effect: draft.effect }),
      placePath: draft.placePath,
      target: [],
      patch: draft.patch,
      inverse: draft.inverse,
      ...(draft.external === undefined ? {} : { external: draft.external }),
      ...(draft.consequence === undefined ? {} : { consequence: draft.consequence }),
      exitedBy: 'none',
      // A null coalesce key guarantees one entry per append (no group merging in fixtures).
      coalesceKey: null,
    },
    ts,
  );
  return { entries: [...outcome.state.entries], entry: outcome.entry };
}

/**
 * D4 — `count` undoable human entries in `test.create`, `seq` 1…count, ascending time.
 * The newest entry is the LAST array element (the trail sorts it first).
 */
export function seedEntries(count: number): JournalEntry[] {
  let entries: JournalEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const step = index + 1;
    entries = appendSeed(
      entries,
      {
        verbId: 'test.rect',
        label: `Rectangle ${step}`,
        actor: 'human',
        channel: 'keyboard',
        placePath: [FIXTURE_PLACES.canvas, FIXTURE_PLACES.create],
        patch: { before: { step: index }, after: { step } },
        inverse: { step: index },
      },
      fixtureTimestamp(index),
    ).entries;
  }
  return entries;
}

/** D4 — one undoable COMPANION entry (agent channel) appended onto `prior`. */
export function seedCompanionEntry(prior: readonly JournalEntry[] = []): JournalEntry {
  return appendSeed(
    prior,
    {
      verbId: 'test.rect',
      label: 'Box',
      actor: 'companion',
      channel: 'agent',
      placePath: [FIXTURE_PLACES.canvas, FIXTURE_PLACES.create],
      patch: { before: { box: false }, after: { box: true } },
      inverse: { box: false },
    },
    fixtureTimestamp(30),
  ).entry;
}

/**
 * D4 — one NON-UNDOABLE entry (`inverse === null`) on a verb that is NOT one of the five
 * built-in non-undoable ids, carrying its authored consequence. Appended onto `prior`.
 */
export function seedNonUndoableEntry(prior: readonly JournalEntry[] = []): JournalEntry {
  return appendSeed(
    prior,
    {
      verbId: 'test.rect',
      label: 'Rectangle',
      actor: 'human',
      channel: 'keyboard',
      placePath: [FIXTURE_PLACES.canvas, FIXTURE_PLACES.create],
      patch: { before: { rect: false }, after: { rect: true } },
      inverse: null,
      consequence: NON_UNDOABLE_CONSEQUENCES['place.exportPng'],
    },
    fixtureTimestamp(45),
  ).entry;
}
