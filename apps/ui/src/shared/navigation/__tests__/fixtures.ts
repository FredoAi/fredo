/**
 * Spec #3117 (P3) — the ONE shared test-fixture module for the NavigationEngine.
 *
 * Owned by ST-1. ST-2…ST-5 import from here; do NOT move or rename an export.
 *
 * Contents:
 *   - `validWireframeSurface()` — the §4.2 published key map, place flags and the four
 *     `directAliases`, with `w` deliberately unbound (so `w n` / `w p` are reachable and
 *     V-11 stays satisfiable);
 *   - `TRACES` — the three §4.3 worked traces, all seven published columns;
 *   - `createSeededRandom(seed)` — mulberry32, no new dependency (REQ-10.1);
 *   - builders (`makePlace` / `makeVerb` / `makeEffect` / `makeSurface` / snapshots) and
 *     `RecordingDocument` for the journal/undo proofs (ST-2).
 */

import type {
  ContextSnapshot,
  EffectKind,
  ExitedBy,
  JsonPatch,
  KeyBinding,
  ObjectRef,
  PlaceNode,
  SelectionSnapshot,
  Surface,
  VerbDescriptor,
  VerbEffect,
} from '../types';

/* ───────────────────────────── builders ───────────────────────────── */

/** One place declaration; every field except `id` has a deterministic default. */
export interface PlaceSpec extends Partial<PlaceNode> {
  readonly id: string;
}

/** Build a `PlaceNode` from a partial spec. */
export function makePlace(spec: PlaceSpec): PlaceNode {
  return {
    id: spec.id,
    label: spec.label ?? spec.id,
    parent: spec.parent ?? null,
    transient: spec.transient ?? false,
    sticky: spec.sticky ?? false,
    cursor: spec.cursor ?? null,
    operator: spec.operator ?? null,
    keys: spec.keys ?? {},
    entryHooks: spec.entryHooks ?? ['observable'],
    exitHooks: spec.exitHooks ?? ['observable'],
  };
}

/** One verb declaration; every field except `id` has a deterministic default. */
export interface VerbSpec extends Partial<VerbDescriptor> {
  readonly id: string;
}

/** Build a `VerbDescriptor` from a partial spec. */
export function makeVerb(spec: VerbSpec): VerbDescriptor {
  const title = spec.title ?? spec.id;
  return {
    id: spec.id,
    title,
    description: spec.description ?? `${title} the current page.`,
    appliesTo: spec.appliesTo ?? { objects: ['element'], places: [] },
    args: spec.args ?? [],
    available: spec.available ?? (() => true),
    risk: spec.risk ?? 'safe',
    aliases: spec.aliases ?? [],
    run: spec.run ?? (() => makeEffect({ label: title })),
    ...(spec.undo === undefined ? {} : { undo: spec.undo }),
    ...(spec.consequence === undefined ? {} : { consequence: spec.consequence }),
    publish: spec.publish ?? true,
  };
}

/** Build a `VerbEffect` from a partial spec. */
export function makeEffect(spec: Partial<VerbEffect> = {}): VerbEffect {
  return {
    label: spec.label ?? 'change',
    patch: spec.patch ?? null,
    inverse: spec.inverse ?? null,
    target: spec.target ?? [],
    ...(spec.effect === undefined ? {} : { effect: spec.effect }),
    ...(spec.external === undefined ? {} : { external: spec.external }),
    ...(spec.consequence === undefined ? {} : { consequence: spec.consequence }),
    ...(spec.coalesceKey === undefined ? {} : { coalesceKey: spec.coalesceKey }),
  };
}

/** One surface declaration. */
export interface SurfaceSpec {
  readonly root: string;
  readonly places: readonly PlaceNode[];
  readonly verbs: readonly VerbDescriptor[];
  readonly appId?: string;
  readonly directAliases?: Readonly<Record<string, string>>;
  readonly companion?: Surface['companion'];
}

/** Build a `Surface` from a spec. */
export function makeSurface(spec: SurfaceSpec): Surface {
  return {
    tree: {
      appId: spec.appId ?? 'test',
      root: spec.root,
      places: spec.places,
      directAliases: spec.directAliases ?? {},
    },
    verbs: spec.verbs,
    companion: spec.companion ?? null,
  };
}

/** One empty selection summary. */
export function makeSelection(overrides: Partial<SelectionSnapshot> = {}): SelectionSnapshot {
  return {
    count: overrides.count ?? 0,
    kinds: overrides.kinds ?? [],
    label: overrides.label ?? null,
    ids: overrides.ids ?? [],
  };
}

/** One context snapshot rooted at `wireframe.canvas` by default. */
export function makeSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    appId: overrides.appId ?? 'wireframe',
    placePath: overrides.placePath ?? ['wireframe.canvas'],
    selection: overrides.selection ?? makeSelection(),
    dirty: overrides.dirty ?? false,
  };
}

/** One object reference. */
export function makeObjectRef(id: string, type = 'element'): ObjectRef {
  return { type, id, label: id };
}

/* ─────────────────────── §4.2 published key map ─────────────────────── */

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';
const EDIT = 'wireframe.edit';
const ARRANGE = 'wireframe.arrange';
const STYLE = 'wireframe.style';
const VIEW = 'wireframe.view';
const FILE = 'wireframe.file';

function verbBinding(verbId: string): KeyBinding {
  return { kind: 'verb', verbId };
}

const CANVAS_KEYS: Readonly<Record<string, KeyBinding>> = {
  c: verbBinding('place.create'),
  i: verbBinding('place.edit'),
  a: verbBinding('place.arrange'),
  s: verbBinding('place.style'),
  v: verbBinding('place.view'),
  f: verbBinding('place.file'),
  m: verbBinding('app.map'),
  k: verbBinding('app.ask'),
  p: verbBinding('app.palette'),
  'w n': verbBinding('window.focusNext'),
  'w p': verbBinding('window.focusPrevious'),
};

const CREATE_KEYS: Readonly<Record<string, KeyBinding>> = {
  r: verbBinding('place.rect'),
  e: verbBinding('place.ellipse'),
  t: verbBinding('place.text'),
  b: verbBinding('place.button'),
};

const EDIT_KEYS: Readonly<Record<string, KeyBinding>> = {
  a: verbBinding('place.selectAll'),
  d: verbBinding('place.duplicate'),
  x: verbBinding('place.delete'),
  l: verbBinding('place.toggleLock'),
};

const ARRANGE_KEYS: Readonly<Record<string, KeyBinding>> = {
  l: verbBinding('place.alignLeft'),
  c: verbBinding('place.alignCenter'),
  z: verbBinding('place.alignRight'),
  d: verbBinding('place.distribute'),
  g: verbBinding('place.group'),
  n: verbBinding('place.ungroup'),
  f: verbBinding('place.bringForward'),
  b: verbBinding('place.sendBackward'),
};

const STYLE_KEYS: Readonly<Record<string, KeyBinding>> = {
  f: verbBinding('place.setFill'),
  c: verbBinding('place.copyStyle'),
  x: verbBinding('place.resetStyle'),
};

const VIEW_KEYS: Readonly<Record<string, KeyBinding>> = {
  i: verbBinding('place.zoomIn'),
  o: verbBinding('place.zoomOut'),
  n: verbBinding('place.fitPage'),
  h: verbBinding('place.togglePan'),
};

const FILE_KEYS: Readonly<Record<string, KeyBinding>> = {
  s: verbBinding('place.save'),
  a: verbBinding('place.saveAs'),
  o: verbBinding('place.open'),
  x: verbBinding('place.exportPng'),
  n: verbBinding('wireframe.document.new'),
};

function wireframeVerb(
  id: string,
  title: string,
  place: string,
  risk: VerbDescriptor['risk'] = 'safe',
  objects: readonly string[] = ['element'],
  consequence?: string,
): VerbDescriptor {
  return makeVerb({
    id,
    title,
    risk,
    appliesTo: { objects, places: [place] },
    ...(consequence === undefined ? {} : { consequence }),
  });
}

/**
 * §4.2 — the published wireframe key map, place flags and direct aliases.
 *
 * `w` is deliberately NOT bound: that is what makes `w n` / `w p` reachable and keeps
 * V-11 satisfiable. All twelve V-rules pass on this surface.
 */
export function validWireframeSurface(): Surface {
  const places: readonly PlaceNode[] = [
    makePlace({ id: CANVAS, label: 'Canvas', parent: null, keys: CANVAS_KEYS }),
    makePlace({
      id: CREATE,
      label: 'Create',
      parent: CANVAS,
      transient: true,
      sticky: false,
      keys: CREATE_KEYS,
    }),
    makePlace({
      id: EDIT,
      label: 'Edit',
      parent: CANVAS,
      transient: false,
      sticky: true,
      keys: EDIT_KEYS,
    }),
    makePlace({
      id: ARRANGE,
      label: 'Arrange',
      parent: CANVAS,
      transient: false,
      sticky: true,
      keys: ARRANGE_KEYS,
    }),
    makePlace({
      id: STYLE,
      label: 'Style',
      parent: CANVAS,
      transient: false,
      sticky: true,
      keys: STYLE_KEYS,
    }),
    makePlace({
      id: VIEW,
      label: 'View',
      parent: CANVAS,
      transient: false,
      sticky: true,
      keys: VIEW_KEYS,
    }),
    makePlace({
      id: FILE,
      label: 'File',
      parent: CANVAS,
      transient: false,
      sticky: true,
      keys: FILE_KEYS,
    }),
  ];

  const verbs: readonly VerbDescriptor[] = [
    // canvas navigation + application-level capabilities
    wireframeVerb('place.create', 'Create', CANVAS, 'safe', ['page']),
    wireframeVerb('place.edit', 'Edit', CANVAS, 'safe', ['page']),
    wireframeVerb('place.arrange', 'Arrange', CANVAS, 'safe', ['page']),
    wireframeVerb('place.style', 'Style', CANVAS, 'safe', ['page']),
    wireframeVerb('place.view', 'View', CANVAS, 'safe', ['page']),
    wireframeVerb('place.file', 'File', CANVAS, 'safe', ['page']),
    wireframeVerb('app.map', 'Map', CANVAS, 'safe', ['page']),
    wireframeVerb('app.ask', 'Ask', CANVAS, 'safe', ['page']),
    wireframeVerb('app.palette', 'Palette', CANVAS, 'safe', ['page']),
    wireframeVerb('window.focusNext', 'Focus next', CANVAS, 'safe', ['page']),
    wireframeVerb('window.focusPrevious', 'Focus previous', CANVAS, 'safe', ['page']),
    // create (transient)
    wireframeVerb('place.rect', 'Rectangle', CREATE),
    wireframeVerb('place.ellipse', 'Ellipse', CREATE),
    wireframeVerb('place.text', 'Text', CREATE),
    wireframeVerb('place.button', 'Button', CREATE),
    // edit (sticky)
    wireframeVerb('place.selectAll', 'Select all', EDIT),
    wireframeVerb('place.duplicate', 'Duplicate', EDIT),
    wireframeVerb('place.delete', 'Delete', EDIT, 'destructive', ['element'],
      'deleted elements are not kept in Fredo\'s history.'),
    wireframeVerb('place.toggleLock', 'Toggle lock', EDIT),
    // arrange (sticky)
    wireframeVerb('place.alignLeft', 'Align left', ARRANGE),
    wireframeVerb('place.alignCenter', 'Align center', ARRANGE),
    wireframeVerb('place.alignRight', 'Align right', ARRANGE),
    wireframeVerb('place.distribute', 'Distribute', ARRANGE),
    wireframeVerb('place.group', 'Group', ARRANGE),
    wireframeVerb('place.ungroup', 'Ungroup', ARRANGE),
    wireframeVerb('place.bringForward', 'Bring forward', ARRANGE),
    wireframeVerb('place.sendBackward', 'Send backward', ARRANGE),
    // style (sticky)
    wireframeVerb('place.setFill', 'Set fill', STYLE),
    wireframeVerb('place.copyStyle', 'Copy style', STYLE),
    wireframeVerb('place.resetStyle', 'Reset style', STYLE),
    // view (sticky)
    wireframeVerb('place.zoomIn', 'Zoom in', VIEW, 'safe', ['page']),
    wireframeVerb('place.zoomOut', 'Zoom out', VIEW, 'safe', ['page']),
    wireframeVerb('place.fitPage', 'Fit page', VIEW, 'safe', ['page']),
    wireframeVerb('place.togglePan', 'Toggle pan', VIEW, 'safe', ['page']),
    // file (sticky) — the five non-undoable verbs each carry their own consequence
    wireframeVerb('place.save', 'Save', FILE, 'external', ['document'],
      'saved to, or acted on, something Fredo cannot reopen. The previous revision is not kept in Fredo\'s history.'),
    wireframeVerb('place.saveAs', 'Save as', FILE, 'external', ['document'],
      'saved to, or acted on, something Fredo cannot reopen. A new file was written outside Fredo\'s history.'),
    wireframeVerb('place.open', 'Open', FILE, 'external', ['document'],
      'saved to, or acted on, something Fredo cannot reopen. The previous document is no longer loaded.'),
    wireframeVerb('place.exportPng', 'Export PNG', FILE, 'external', ['document'],
      'the file is outside Fredo\'s document history. Re-export to change it.'),
    wireframeVerb('wireframe.document.new', 'New document', FILE, 'destructive', ['document'],
      'saved to, or acted on, something Fredo cannot reopen. The previous document was closed without being kept.'),
    // journal (aliases only)
    wireframeVerb('journal.undo', 'Undo', CANVAS, 'safe', ['document']),
    wireframeVerb('journal.redo', 'Redo', CANVAS, 'safe', ['document']),
  ];

  return makeSurface({
    appId: 'wireframe',
    root: CANVAS,
    places,
    verbs,
    directAliases: {
      r: 'place.rect',
      e: 'place.ellipse',
      u: 'journal.undo',
      y: 'journal.redo',
    },
    companion: {
      appName: 'Wireframe',
      description: 'Draw and arrange wireframe pages.',
    },
  });
}

/* ─────────────────────────── §4.3 worked traces ─────────────────────────── */

/** One §4.3 trace row — every published column, in one record. */
export interface TraceCase {
  readonly strokes: readonly string[];
  readonly tiers: readonly (1 | 2 | 3)[];
  readonly intents: readonly string[];
  readonly args: readonly Readonly<Record<string, string>>[];
  readonly effects: readonly EffectKind[];
  /** dispatch-time journal `placePath` (§6.1) — NOT the cursor. */
  readonly placePath: readonly string[];
  /** the cursor AFTER the dispatch. */
  readonly cursorPath: readonly string[];
  readonly exitedBy: readonly ExitedBy[];
}

/** §4.3 — `c`, `c r`, `r`, all starting at `wireframe.canvas` with an empty selection. */
export const TRACES: readonly TraceCase[] = [
  {
    strokes: ['c'],
    tiers: [1],
    intents: ['place.create'],
    args: [{}],
    effects: ['navigation'],
    placePath: ['wireframe.canvas'],
    cursorPath: ['wireframe.canvas', 'wireframe.create'],
    exitedBy: ['none'],
  },
  {
    strokes: ['c', 'r'],
    tiers: [1, 1],
    intents: ['place.create', 'place.rect'],
    args: [{}, {}],
    effects: ['navigation', 'mutation'],
    placePath: ['wireframe.canvas', 'wireframe.create'],
    cursorPath: ['wireframe.canvas'],
    exitedBy: ['none', 'verb'],
  },
  {
    strokes: ['r'],
    tiers: [2],
    intents: ['place.rect'],
    args: [{}],
    effects: ['mutation'],
    placePath: ['wireframe.canvas'],
    cursorPath: ['wireframe.canvas'],
    exitedBy: ['none'],
  },
];

/* ───────────────────── seeded PRNG (REQ-10.1) ───────────────────── */

/** REQ-10.1 — the fixed seeds. 3 × 1,000 = 3,000 generated cases per run. */
export const PROPERTY_SEEDS: readonly number[] = [1, 42, 2026];

/** REQ-10.1 — cases generated per seed. */
export const PROPERTY_CASES_PER_SEED = 1000;

/**
 * mulberry32 — a tiny, deterministic PRNG. Written here so the property suite needs no
 * new devDependency (`fast-check` is not permitted).
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic integer in `[0, maxExclusive)`. */
export function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/** A deterministic element of `items`. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[randomInt(rng, items.length)];
}

/* ─────────────────── RecordingDocument (REQ-10.2, ST-2) ─────────────────── */

/**
 * A whole-document recorder: `applyPatch` REPLACES the document (`doc = patch`), and
 * `run` returns `{ before, after, inverse: before }` so `undo(run(x)) ≡ before` is a
 * literal deep-equal (REQ-10.2).
 */
export class RecordingDocument {
  private state: JsonPatch;

  constructor(initial: JsonPatch = {}) {
    this.state = initial;
  }

  /** The current document state. */
  get doc(): JsonPatch {
    return this.state;
  }

  /** Whole-document replacement — the only mutation. */
  readonly applyPatch = (patch: JsonPatch): void => {
    this.state = patch;
  };

  /** Advance the document to `after` and return the matching effect. */
  run(after: JsonPatch, label = 'change'): VerbEffect {
    const before = this.state;
    this.state = after;
    return { label, patch: { before, after }, inverse: before, target: [] };
  }
}
