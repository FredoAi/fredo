/**
 * Spec #3118 (P4), ST-6 — the DEV-only prototype declaration.
 *
 * `NAVIGATION_DEMO_SURFACE` is a REAL, valid `Surface` over the shipped headless
 * NavigationEngine vocabulary: the Canvas tree (`Canvas → Create / Edit / Arrange / Style /
 * View / File`) that the P4 prototype route renders through `CommandRail`, `NavigationMap`
 * and `ActivityTrail`.
 *
 * It exercises every AC path the prototype must demonstrate:
 *   - place entry from the root (`c i a s v f`) and the two declared globals (`m` Map, `k` Ask);
 *   - a transient place (`Create`) and sticky places (all children);
 *   - a place that binds MORE than eight verbs (`Arrange`, nine) so the rail's `more…` and the
 *     map's filtered seed are reachable;
 *   - the two display glyphs (`?` / `/`) are NOT bindings — the module-local glyph map lives in
 *     `NavigationPreview.tsx`, mirroring `docs/NAVIGATION_ENGINE.md` §4;
 *   - a `destructive` verb (`place.delete`), an `external` non-undoable verb
 *     (`place.exportPng`, carrying the shipped `NON_UNDOABLE_CONSEQUENCES` copy) and a
 *     conditionally-unavailable verb (`place.paste`, available only with a selection);
 *   - direct aliases `r / e / u / y` (Rectangle, Ellipse, Undo, Redo).
 *
 * Non-goals: this module is NEVER imported by an application and NEVER root-exported. It is
 * reachable only through the DEV-gated dynamic route branch in `app/routes/Router.tsx`, so
 * `import.meta.env.DEV` + Rollup drop it from a production build (R-8.2).
 *
 * The declaration itself is a module-level constant; its `run` implementations close over the
 * module-scoped demo document so the verbs are self-contained (no React state, no storage, no
 * clock). `createNavigationDemoController()` starts a FRESH demo session and returns the five
 * injected dependencies the navigation host needs. The prototype is a single-session dev
 * surface, so a shared demo document is deliberate.
 */

import {
  NON_UNDOABLE_CONSEQUENCES,
  type ConfirmationRequest,
  type ContextSnapshot,
  type JsonPatch,
  type KeyBinding,
  type PlaceNode,
  type SelectionSnapshot,
  type Surface,
  type VerbDescriptor,
  type VerbEffect,
} from '../../shared/navigation';

/* ───────────────────────────── declared ids ───────────────────────────── */

/** The demo's place ids (also the place-entry verb ids — see `enterPlace`). */
export const DEMO_PLACES = {
  canvas: 'demo.canvas',
  create: 'demo.create',
  edit: 'demo.edit',
  arrange: 'demo.arrange',
  style: 'demo.style',
  view: 'demo.view',
  file: 'demo.file',
} as const;

/** The demo's application id. */
export const DEMO_APP_ID = 'demo';

/** The declaration's parent map (the only place hierarchy the demo declares). */
const DEMO_PARENT: Readonly<Record<string, string | null>> = {
  [DEMO_PLACES.canvas]: null,
  [DEMO_PLACES.create]: DEMO_PLACES.canvas,
  [DEMO_PLACES.edit]: DEMO_PLACES.canvas,
  [DEMO_PLACES.arrange]: DEMO_PLACES.canvas,
  [DEMO_PLACES.style]: DEMO_PLACES.canvas,
  [DEMO_PLACES.view]: DEMO_PLACES.canvas,
  [DEMO_PLACES.file]: DEMO_PLACES.canvas,
};

/** The initial demo document — one JSON patch the controller replaces on every apply. */
const INITIAL_DOC: JsonPatch = { revision: 0, shapes: 0, exports: 0 };

/* ───────────────────────────── demo document ───────────────────────────── */

interface DemoState {
  doc: JsonPatch;
  placePath: string[];
  selection: SelectionSnapshot;
}

function emptySelection(): SelectionSnapshot {
  return { count: 0, kinds: [], label: null, ids: [] };
}

/** The prototype's single-session document (deliberately module-scoped — one dev surface). */
const demoState: DemoState = {
  doc: INITIAL_DOC,
  placePath: [DEMO_PLACES.canvas],
  selection: emptySelection(),
};

/** Reset the demo document to a clean session (the prototype's Reset control). */
export function resetNavigationDemoState(): void {
  demoState.doc = INITIAL_DOC;
  demoState.placePath = [DEMO_PLACES.canvas];
  demoState.selection = emptySelection();
}

/** The declaration chain of `placeId` (root → place), from the demo parent map. */
function ancestryOf(placeId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = placeId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = DEMO_PARENT[current] ?? null;
  }
  return chain.reverse();
}

/* ───────────────────────────── declaration helpers ───────────────────────────── */

function verbBinding(verbId: string): KeyBinding {
  return { kind: 'verb', verbId };
}

function placeBinding(placeId: string): KeyBinding {
  return { kind: 'place', placeId };
}

function makePlace(
  id: string,
  label: string,
  flags: { readonly transient?: boolean; readonly sticky?: boolean },
  keys: Readonly<Record<string, KeyBinding>> = {},
): PlaceNode {
  return {
    id,
    label,
    parent: DEMO_PARENT[id] ?? null,
    transient: flags.transient === true,
    sticky: flags.sticky === true,
    cursor: null,
    operator: null,
    keys,
    entryHooks: ['observable'],
    exitHooks: ['observable'],
  };
}

interface VerbSpec {
  readonly id: string;
  readonly title: string;
  readonly place: string;
  readonly risk?: VerbDescriptor['risk'];
  readonly available?: (ctx: ContextSnapshot) => boolean;
  readonly consequence?: string;
}

function makeDescriptor(
  spec: VerbSpec,
  run: (intent: { readonly args: Readonly<Record<string, string>> }) => VerbEffect,
  undo?: VerbDescriptor['undo'],
): VerbDescriptor {
  return {
    id: spec.id,
    title: spec.title,
    description: `${spec.title} in the DEV navigation prototype.`,
    appliesTo: { objects: ['element'], places: [spec.place] },
    args: [],
    available: spec.available ?? (() => true),
    risk: spec.risk ?? 'safe',
    aliases: [],
    run: () => run({ args: {} }),
    ...(undo === undefined ? {} : { undo }),
    ...(spec.consequence === undefined ? {} : { consequence: spec.consequence }),
    publish: true,
  };
}

/* ───────────────────────────── verb builders ───────────────────────────── */

/** A place-entry verb: the place id IS the verb id, so the host derives the cursor directly. */
function enterPlace(placeId: string, title: string): VerbDescriptor {
  return makeDescriptor({ id: placeId, title, place: DEMO_PLACES.canvas }, () => {
    demoState.placePath = ancestryOf(placeId);
    return { label: title, effect: 'navigation', patch: null, inverse: null, target: [] };
  });
}

/** The two declared globals. They are root-only and never move the place cursor sideways. */
function globalVerb(id: string, title: string): VerbDescriptor {
  return makeDescriptor({ id, title, place: DEMO_PLACES.canvas }, () => {
    demoState.placePath = [DEMO_PLACES.canvas];
    return { label: title, effect: 'navigation', patch: null, inverse: null, target: [] };
  });
}

/** A reversible mutation: the demo document is the `before`, the incremented copy the `after`. */
function mutationVerb(
  spec: VerbSpec,
  counterKey: string,
  label: string,
): VerbDescriptor {
  return makeDescriptor(spec, () => {
    const before = demoState.doc;
    const current = typeof before[counterKey] === 'number' ? (before[counterKey] as number) : 0;
    const after: JsonPatch = { ...before, revision: current + 1, [counterKey]: current + 1 };
    return {
      label,
      effect: 'mutation',
      patch: { before, after },
      inverse: before,
      target: [],
    };
  });
}

/** An external, NON-undoable mutation carrying its authored consequence (V-10). */
function externalVerb(spec: VerbSpec, counterKey: string, label: string): VerbDescriptor {
  return makeDescriptor(spec, () => {
    const before = demoState.doc;
    const current = typeof before[counterKey] === 'number' ? (before[counterKey] as number) : 0;
    const after: JsonPatch = { ...before, revision: current + 1, [counterKey]: current + 1 };
    return {
      label,
      effect: 'mutation',
      patch: { before, after },
      inverse: null,
      target: [],
      external: true,
      consequence: spec.consequence ?? null,
    };
  });
}

/* ───────────────────────────── the declaration ───────────────────────────── */

const CANVAS_KEYS: Readonly<Record<string, KeyBinding>> = {
  c: verbBinding(DEMO_PLACES.create),
  i: verbBinding(DEMO_PLACES.edit),
  a: verbBinding(DEMO_PLACES.arrange),
  s: verbBinding(DEMO_PLACES.style),
  v: verbBinding(DEMO_PLACES.view),
  f: verbBinding(DEMO_PLACES.file),
  m: verbBinding('app.map'),
  k: verbBinding('app.ask'),
};

const CREATE_KEYS: Readonly<Record<string, KeyBinding>> = {
  r: verbBinding('place.rect'),
  e: verbBinding('place.ellipse'),
};

const EDIT_KEYS: Readonly<Record<string, KeyBinding>> = {
  x: verbBinding('place.delete'),
  d: verbBinding('place.duplicate'),
  p: verbBinding('place.paste'),
};

const ARRANGE_KEYS: Readonly<Record<string, KeyBinding>> = {
  l: verbBinding('place.alignLeft'),
  c: verbBinding('place.alignCenter'),
  i: verbBinding('place.alignRight'),
  d: verbBinding('place.distribute'),
  g: verbBinding('place.group'),
  n: verbBinding('place.ungroup'),
  b: verbBinding('place.bringForward'),
  w: verbBinding('place.sendBackward'),
  o: verbBinding('place.lockSelection'),
};

const STYLE_KEYS: Readonly<Record<string, KeyBinding>> = {
  f: verbBinding('place.setFill'),
};

const FILE_KEYS: Readonly<Record<string, KeyBinding>> = {
  g: verbBinding('place.exportPng'),
};

const PLACES: readonly PlaceNode[] = [
  makePlace(DEMO_PLACES.canvas, 'Canvas', {}, CANVAS_KEYS),
  makePlace(DEMO_PLACES.create, 'Create', { transient: true }, CREATE_KEYS),
  makePlace(DEMO_PLACES.edit, 'Edit', { sticky: true }, EDIT_KEYS),
  makePlace(DEMO_PLACES.arrange, 'Arrange', { sticky: true }, ARRANGE_KEYS),
  makePlace(DEMO_PLACES.style, 'Style', { sticky: true }, STYLE_KEYS),
  makePlace(DEMO_PLACES.view, 'View', { sticky: true }),
  makePlace(DEMO_PLACES.file, 'File', { sticky: true }, FILE_KEYS),
];

const VERBS: readonly VerbDescriptor[] = [
  // Root place entries (the verb id equals the place id so the host derives the cursor).
  enterPlace(DEMO_PLACES.create, 'Create'),
  enterPlace(DEMO_PLACES.edit, 'Edit'),
  enterPlace(DEMO_PLACES.arrange, 'Arrange'),
  enterPlace(DEMO_PLACES.style, 'Style'),
  enterPlace(DEMO_PLACES.view, 'View'),
  enterPlace(DEMO_PLACES.file, 'File'),
  // The two declared globals (V-05 requires a declared verb for a place key target).
  globalVerb('app.map', 'Map'),
  globalVerb('app.ask', 'Ask'),
  // Canvas / Create shapes (also the `r` / `e` direct aliases).
  mutationVerb(
    { id: 'place.rect', title: 'Rectangle', place: DEMO_PLACES.create, risk: 'mutating' },
    'shapes',
    'Rectangle',
  ),
  mutationVerb(
    { id: 'place.ellipse', title: 'Ellipse', place: DEMO_PLACES.create, risk: 'mutating' },
    'shapes',
    'Ellipse',
  ),
  // Edit place — a destructive verb and a conditionally unavailable one.
  mutationVerb(
    {
      id: 'place.delete',
      title: 'Delete',
      place: DEMO_PLACES.edit,
      risk: 'destructive',
      consequence: 'the selection is removed from this document and is not kept in history.',
    },
    'deleted',
    'Delete',
  ),
  mutationVerb(
    { id: 'place.duplicate', title: 'Duplicate', place: DEMO_PLACES.edit, risk: 'mutating' },
    'shapes',
    'Duplicate',
  ),
  makeDescriptor(
    {
      id: 'place.paste',
      title: 'Paste',
      place: DEMO_PLACES.edit,
      risk: 'mutating',
      available: (ctx) => ctx.selection.count > 0,
    },
    () => {
      const before = demoState.doc;
      const after: JsonPatch = { ...before, revision: 1, shapes: 1 };
      return {
        label: 'Paste',
        effect: 'mutation',
        patch: { before, after },
        inverse: before,
        target: [],
      };
    },
  ),
  // The nine Arrange verbs (forces the rail's `more…`).
  mutationVerb(
    { id: 'place.alignLeft', title: 'Align left', place: DEMO_PLACES.arrange, risk: 'mutating' },
    'alignments',
    'Align left',
  ),
  mutationVerb(
    { id: 'place.alignCenter', title: 'Align center', place: DEMO_PLACES.arrange, risk: 'mutating' },
    'alignments',
    'Align center',
  ),
  mutationVerb(
    { id: 'place.alignRight', title: 'Align right', place: DEMO_PLACES.arrange, risk: 'mutating' },
    'alignments',
    'Align right',
  ),
  mutationVerb(
    { id: 'place.distribute', title: 'Distribute', place: DEMO_PLACES.arrange, risk: 'mutating' },
    'alignments',
    'Distribute',
  ),
  mutationVerb({ id: 'place.group', title: 'Group', place: DEMO_PLACES.arrange }, 'groups', 'Group'),
  mutationVerb(
    { id: 'place.ungroup', title: 'Ungroup', place: DEMO_PLACES.arrange },
    'groups',
    'Ungroup',
  ),
  mutationVerb(
    {
      id: 'place.bringForward',
      title: 'Bring forward',
      place: DEMO_PLACES.arrange,
      risk: 'mutating',
    },
    'order',
    'Bring forward',
  ),
  mutationVerb(
    {
      id: 'place.sendBackward',
      title: 'Send backward',
      place: DEMO_PLACES.arrange,
      risk: 'mutating',
    },
    'order',
    'Send backward',
  ),
  mutationVerb(
    { id: 'place.lockSelection', title: 'Lock selection', place: DEMO_PLACES.arrange },
    'locked',
    'Lock selection',
  ),
  // Style / File.
  mutationVerb(
    { id: 'place.setFill', title: 'Fill', place: DEMO_PLACES.style, risk: 'mutating' },
    'fills',
    'Fill',
  ),
  externalVerb(
    {
      id: 'place.exportPng',
      title: 'Export PNG',
      place: DEMO_PLACES.file,
      risk: 'external',
      consequence: NON_UNDOABLE_CONSEQUENCES['place.exportPng'],
    },
    'exports',
    'Export PNG',
  ),
];

/**
 * The DEV prototype declaration. Valid under `validateSurface` (no diagnostics) and consumed
 * only by `NavigationPreview` through the DEV-gated route branch.
 */
export const NAVIGATION_DEMO_SURFACE: Surface = {
  tree: {
    appId: DEMO_APP_ID,
    root: DEMO_PLACES.canvas,
    places: PLACES,
    // Display aliases only: `u` / `y` target engine-owned journal verbs (no descriptor).
    directAliases: {
      r: 'place.rect',
      e: 'place.ellipse',
      u: 'journal.undo',
      y: 'journal.redo',
    },
  },
  verbs: VERBS,
  companion: {
    appName: 'Navigation prototype',
    description: 'The DEV-only Canvas declaration of the P4 navigation surfaces.',
  },
};

/* ───────────────────────────── controller ───────────────────────────── */

export interface NavigationDemoController {
  readonly surface: Surface;
  getContext(): ContextSnapshot;
  state(): {
    readonly doc: JsonPatch;
    readonly placePath: readonly string[];
    readonly selection: ContextSnapshot['selection'];
  };
  applyPatch(patch: JsonPatch): void;
  confirm(request: ConfirmationRequest): boolean;
}

/**
 * Start a fresh demo session and return the dependencies the navigation host injects.
 *
 * `confirm` always accepts: the prototype must let a `destructive` / `external` verb complete
 * so the risk cue, the confirmation path and the non-undoable consequence are all observable.
 */
export function createNavigationDemoController(): NavigationDemoController {
  resetNavigationDemoState();

  return {
    surface: NAVIGATION_DEMO_SURFACE,
    getContext: () => ({
      appId: DEMO_APP_ID,
      placePath: [...demoState.placePath],
      selection: demoState.selection,
      dirty: demoState.doc.revision !== INITIAL_DOC.revision,
    }),
    state: () => ({
      doc: demoState.doc,
      placePath: [...demoState.placePath],
      selection: demoState.selection,
    }),
    applyPatch: (patch) => {
      demoState.doc = patch;
    },
    confirm: () => true,
  };
}
