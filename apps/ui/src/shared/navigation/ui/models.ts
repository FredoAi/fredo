/**
 * Spec #3118 (P4), ST-1 — the ONE pure projection layer behind the rail, the map and the trail.
 *
 * `buildCommandRailModel`, `buildNavigationMapModel` and `buildActivityTrailModel` are total,
 * pure functions over the SAME declaration (`Surface`) and the SAME headless projections the
 * P3 engine ships. There is no second key table and no second binding derivation: the rail
 * composes `deriveRail`, the map composes `deriveMap` + `createRegistry(...).verbsById` +
 * `verb.available(...)` + the shipped `formatTooltip`, and both read the place path from
 * `buildContextEnvelope`. A projection that disagrees with the declaration is a defect (R-6.1).
 *
 * The rail's two globals are affordances, never rows: `app.map` and `app.ask` MUST be declared
 * verbs (V-05 rejects a place key targeting an unknown verb), so `deriveRail` would otherwise
 * return them as ordinary rows. They are filtered out BEFORE the projection runs, so the 8-row
 * cap and `overflow` count only contextual verbs (Architect C4 / QA Q1-09).
 *
 * PURE: no clock read, no DOM, no I/O; every value comes from the arguments.
 */

import {
  CAPABILITY_LIMITS,
  buildContextEnvelope,
  createRegistry,
  deriveMap,
  deriveRail,
  isUndoable,
  undoAffordance,
  type ContextSnapshot,
  type JournalEntry,
  type KeyBinding,
  type PlaceRef,
  type Surface,
  type SurfaceRegistry,
  type VerbDescriptor,
} from '../';
import {
  NAV_ACTOR_LABELS,
  NAV_ASK_DISABLED_REASON,
  NAV_ASK_VERB_ID,
  NAV_EMPTY_TRAIL_COPY,
  NAV_GLYPH_BY_VERB_ID,
  NAV_GLOBAL_BINDINGS,
  NAV_MAP_VERB_ID,
  NAV_MORE_LABEL,
  NAV_TRANSIENT_MARKER_SUFFIX,
  NAV_UNAVAILABLE_REASON,
} from './constants';
import {
  formatKeyHint,
  formatPlacePathLabel,
  formatTrailTime,
  navTooltip,
  riskLabel,
} from './format';
import type {
  ActivityTrailEntry,
  ActivityTrailModel,
  CommandRailModel,
  CommandRailPlaceRow,
  CommandRailRow,
  NavAffordance,
  NavPlaceRef,
  NavigationMapKey,
  NavigationMapModel,
  NavigationMapPlace,
  NavigationMapVerb,
} from './types';

/* ───────────────────────────── shared helpers ───────────────────────────── */

/** A shared empty binding map, so an unbound place iterates without a per-call allocation. */
const NO_BINDINGS: ReadonlyMap<string, readonly KeyBinding[]> = new Map();

/** A place-path record from the declaration (id + label + flags); same shape as `PlaceRef`. */
function toNavPlaceRef(ref: PlaceRef): NavPlaceRef {
  return {
    id: ref.id,
    label: ref.label,
    transient: ref.transient,
    sticky: ref.sticky,
  };
}

/** The declaration's place, or `null` when the id is unknown (never invented). */
function placeRef(reg: SurfaceRegistry, placeId: string): NavPlaceRef | null {
  const place = reg.placesById.get(placeId);
  return place === undefined ? null : toNavPlaceRef(place);
}

/** Ids → place-path records, dropping unknown ids in declaration order. */
function placePathRefs(reg: SurfaceRegistry, ids: readonly string[]): NavPlaceRef[] {
  const refs: NavPlaceRef[] = [];
  for (const id of ids) {
    const ref = placeRef(reg, id);
    if (ref !== null) refs.push(ref);
  }
  return refs;
}

/** The current place path root → current; falls back to the declared root (P3 rail rule). */
function currentPath(surface: Surface, snapshot: ContextSnapshot): NavPlaceRef[] {
  const envelope = buildContextEnvelope(surface, snapshot, []);
  if (envelope.placePath.length > 0) return envelope.placePath.map(toNavPlaceRef);
  const reg = createRegistry(surface);
  const root = placeRef(reg, reg.rootId);
  return root === null ? [] : [root];
}

/** The current place id (last valid path segment, else the declared root), `null` if none. */
function currentPlaceId(surface: Surface, snapshot: ContextSnapshot): string | null {
  const path = currentPath(surface, snapshot);
  const last = path[path.length - 1];
  return last === undefined ? null : last.id;
}

/** A total stand-in for a surface that declares no place at all (never throws). */
function fallbackPlace(surface: Surface): NavPlaceRef {
  return {
    id: surface.tree.root,
    label: surface.tree.root,
    transient: false,
    sticky: false,
  };
}

/* ───────────────────────────── rail ───────────────────────────── */

/** `/ Ask` — focusable, disabled in P4 with its bound reason. */
function buildAskAffordance(): NavAffordance {
  const binding = NAV_GLOBAL_BINDINGS[NAV_ASK_VERB_ID];
  return {
    glyph: NAV_GLYPH_BY_VERB_ID[NAV_ASK_VERB_ID],
    label: 'Ask',
    binding,
    enabled: false,
    reason: NAV_ASK_DISABLED_REASON,
    tooltip: navTooltip('Ask', [binding], 'safe', NAV_ASK_DISABLED_REASON),
  };
}

/** `? Map` — always enabled; its tooltip names the declared stroke, never the glyph. */
function buildMapAffordance(): NavAffordance {
  const binding = NAV_GLOBAL_BINDINGS[NAV_MAP_VERB_ID];
  return {
    glyph: NAV_GLYPH_BY_VERB_ID[NAV_MAP_VERB_ID],
    label: 'Map',
    binding,
    enabled: true,
    reason: null,
    tooltip: navTooltip('Map', [binding], 'safe', null),
  };
}

/** The strokes in `placeId` that enter `childId` (a place binding, or a verb whose id IS the place). */
function entryStrokes(reg: SurfaceRegistry, placeId: string, childId: string): string[] {
  const strokes: string[] = [];
  for (const [stroke, bindings] of reg.bindingsByPlace.get(placeId) ?? NO_BINDINGS) {
    for (const binding of bindings) {
      const target = binding.kind === 'verb' ? binding.verbId : binding.placeId;
      if (target !== childId) continue;
      if (!strokes.includes(stroke)) strokes.push(stroke);
    }
  }
  return strokes;
}

/** The announced action count of a child place (globals excluded, exactly as the rail counts). */
function childActionCount(
  contextual: Surface,
  snapshot: ContextSnapshot,
  pathIds: readonly string[],
  childId: string,
): number {
  const rail = deriveRail(contextual, { ...snapshot, placePath: [...pathIds, childId] });
  return rail.rows.length + rail.overflow;
}

/**
 * The child-place rows of the current place, declaration order. They answer "where can I go?"
 * and are rendered ABOVE the verb rows; they never contribute to `rows`, `overflow` or
 * `actionCount` (those count the current place's bound verbs only).
 */
function buildPlaceRows(
  surface: Surface,
  contextual: Surface,
  reg: SurfaceRegistry,
  snapshot: ContextSnapshot,
  breadcrumb: readonly NavPlaceRef[],
): CommandRailPlaceRow[] {
  const currentId = breadcrumb[breadcrumb.length - 1]?.id ?? reg.rootId;
  const pathIds = breadcrumb.map((place) => place.id);
  const childIds = reg.childrenByParent.get(currentId) ?? [];

  return childIds.map((childId) => {
    const node = reg.placesById.get(childId);
    const label = node?.label ?? childId;
    const keys = entryStrokes(reg, currentId, childId);
    const keyHint = formatKeyHint(keys);
    const transient = node?.transient === true;
    const count = childActionCount(contextual, snapshot, pathIds, childId);
    const base = `${label} — ${count} action${count === 1 ? '' : 's'}`;
    const withKey = keyHint === '' ? base : `${base} (${keyHint})`;
    return {
      placeId: childId,
      label,
      key: keys[0] ?? '',
      keys,
      keyHint,
      transient,
      tooltip: transient ? `${withKey} — ${NAV_TRANSIENT_MARKER_SUFFIX}` : withKey,
    };
  });
}

/** R-1.1 … R-1.7 — the rail's one model, built from the declaration + snapshot. */
export function buildCommandRailModel(
  surface: Surface,
  snapshot: ContextSnapshot,
): CommandRailModel {
  const breadcrumb = currentPath(surface, snapshot);
  const currentPlace = breadcrumb[breadcrumb.length - 1] ?? fallbackPlace(surface);

  // C4 — drop the two globals BEFORE the 8-row cap so they can neither occupy a row nor
  // inflate `overflow`/`actionCount`. The remaining projection is the shipped `deriveRail`.
  const contextual: Surface = {
    ...surface,
    verbs: surface.verbs.filter(
      (verb) => verb.id !== NAV_MAP_VERB_ID && verb.id !== NAV_ASK_VERB_ID,
    ),
  };
  const rail = deriveRail(contextual, snapshot);
  const placeRows = buildPlaceRows(
    surface,
    contextual,
    createRegistry(surface),
    snapshot,
    breadcrumb,
  );

  const rows: CommandRailRow[] = rail.rows.map((row) => {
    const reason = row.enabled ? null : NAV_UNAVAILABLE_REASON;
    return {
      verbId: row.verbId,
      title: row.title,
      keys: row.keys,
      keyHint: formatKeyHint(row.keys),
      risk: row.risk,
      riskCue: row.risk === 'safe' ? 'none' : row.risk,
      riskLabel: riskLabel(row.risk),
      enabled: row.enabled,
      reason,
      tooltip: navTooltip(row.title, row.keys, row.risk, reason),
    };
  });

  return {
    breadcrumb,
    currentPlace,
    transientMarker: currentPlace.transient
      ? `${currentPlace.label} · ${NAV_TRANSIENT_MARKER_SUFFIX}`
      : null,
    placeRows,
    rows,
    overflow: rail.overflow,
    actionCount: rows.length + rail.overflow,
    more:
      rail.overflow > 0
        ? { label: NAV_MORE_LABEL, opensFilteredTo: currentPlace.id }
        : null,
    ask: buildAskAffordance(),
    map: buildMapAffordance(),
  };
}

/* ───────────────────────────── map ───────────────────────────── */

/** One place-key row (a verb or child-place binding declared on the place). */
function keyRow(
  reg: SurfaceRegistry,
  stroke: string,
  binding: KeyBinding,
  source: NavigationMapKey['source'],
): NavigationMapKey {
  if (binding.kind === 'verb') {
    const verb = reg.verbsById.get(binding.verbId);
    return {
      stroke,
      keyHint: formatKeyHint([stroke]),
      glyph: null,
      target: 'verb',
      targetId: binding.verbId,
      targetLabel: verb?.title ?? binding.verbId,
      source,
    };
  }
  const place = reg.placesById.get(binding.placeId);
  return {
    stroke,
    keyHint: formatKeyHint([stroke]),
    glyph: null,
    target: 'place',
    targetId: binding.placeId,
    targetLabel: place?.label ?? binding.placeId,
    source,
  };
}

/** True when the binding targets one of the two globals (rendered in their own section). */
function isGlobalBinding(binding: KeyBinding): boolean {
  return (
    binding.kind === 'verb' &&
    (binding.verbId === NAV_MAP_VERB_ID || binding.verbId === NAV_ASK_VERB_ID)
  );
}

/** The strokes bound to `verbId` inside `placeId`, in declaration order. */
function strokesForVerb(reg: SurfaceRegistry, placeId: string, verbId: string): string[] {
  const strokes: string[] = [];
  for (const [stroke, bindings] of reg.bindingsByPlace.get(placeId) ?? NO_BINDINGS) {
    if (bindings.some((binding) => binding.kind === 'verb' && binding.verbId === verbId)) {
      strokes.push(stroke);
    }
  }
  return strokes;
}

/** One place block: the shipped `deriveMap` row, enriched from the same declaration. */
function buildPlace(
  reg: SurfaceRegistry,
  snapshot: ContextSnapshot,
  row: { readonly placePath: readonly string[]; readonly verbs: readonly string[] },
  currentId: string | null,
): NavigationMapPlace {
  const placeId = row.placePath[row.placePath.length - 1] ?? reg.rootId;
  const node = reg.placesById.get(placeId);
  const path = placePathRefs(reg, row.placePath);

  const verbs: NavigationMapVerb[] = [];
  for (const verbId of row.verbs) {
    const verb: VerbDescriptor | undefined = reg.verbsById.get(verbId);
    if (verb === undefined) continue;
    const keys = strokesForVerb(reg, placeId, verbId);
    const available = verb.available(snapshot);
    const reason = available ? null : NAV_UNAVAILABLE_REASON;
    verbs.push({
      verbId: verb.id,
      title: verb.title,
      risk: verb.risk,
      riskLabel: riskLabel(verb.risk),
      keys,
      keyHint: formatKeyHint(keys),
      available,
      reason,
      tooltip: navTooltip(verb.title, keys, verb.risk, reason),
    });
  }

  const keys: NavigationMapKey[] = [];
  for (const [stroke, bindings] of reg.bindingsByPlace.get(placeId) ?? NO_BINDINGS) {
    const binding = bindings[0];
    if (binding === undefined) continue;
    // The two globals are a distinct region (their own glyph rows), never a place key.
    if (isGlobalBinding(binding)) continue;
    keys.push(keyRow(reg, stroke, binding, 'place'));
  }

  return {
    placeId,
    label: node?.label ?? placeId,
    depth: Math.max(0, row.placePath.length - 1),
    placePath: path,
    pathLabel: formatPlacePathLabel(path),
    current: currentId !== null && placeId === currentId,
    transient: node?.transient === true,
    sticky: node?.sticky === true,
    verbs,
    keys,
  };
}

/** The application-level direct aliases, declaration order (tier-2, never a place key). */
function buildAliases(reg: SurfaceRegistry): NavigationMapKey[] {
  const aliases: NavigationMapKey[] = [];
  for (const [stroke, bindings] of reg.aliasByStroke) {
    const binding = bindings[0];
    if (binding === undefined || binding.kind !== 'verb') continue;
    aliases.push(keyRow(reg, stroke, binding, 'alias'));
  }
  return aliases;
}

/** The two global entries (`app.map` / `app.ask`) with their display glyphs. */
function buildGlobals(reg: SurfaceRegistry): NavigationMapKey[] {
  const globals: NavigationMapKey[] = [];
  for (const verbId of [NAV_MAP_VERB_ID, NAV_ASK_VERB_ID] as const) {
    const bound = reg.keysByVerb.get(verbId);
    // Only a surface that actually binds the global gets a row (never invent a binding).
    if (bound === undefined || bound.length === 0) continue;
    const stroke = bound[0] ?? NAV_GLOBAL_BINDINGS[verbId];
    const verb = reg.verbsById.get(verbId);
    globals.push({
      stroke,
      keyHint: formatKeyHint([stroke]),
      glyph: NAV_GLYPH_BY_VERB_ID[verbId],
      target: 'verb',
      targetId: verbId,
      targetLabel: verb?.title ?? (verbId === NAV_MAP_VERB_ID ? 'Map' : 'Ask'),
      source: 'place',
    });
  }
  return globals;
}

/** R-2.1 … R-2.6 — the map's one model. `filteredTo` is a seeded filter, not a sub-list. */
export function buildNavigationMapModel(
  surface: Surface,
  snapshot: ContextSnapshot,
  options: { readonly filteredTo?: string | null } = {},
): NavigationMapModel {
  const reg = createRegistry(surface);
  const currentId = currentPlaceId(surface, snapshot);

  const places = deriveMap(surface).map((row) => buildPlace(reg, snapshot, row, currentId));

  return {
    appId: surface.tree.appId,
    currentPlaceId: currentId,
    places,
    aliases: buildAliases(reg),
    globals: buildGlobals(reg),
    filteredTo: options.filteredTo ?? null,
  };
}

/* ───────────────────────────── trail ───────────────────────────── */

/**
 * The honest non-undoable explanation: the entry's authored consequence first (it is the
 * record of what happened), then the shipped verb-keyed copy. `null` when neither exists —
 * a surface renders no empty tooltip.
 */
function nonUndoableReason(entry: JournalEntry): string | null {
  const authored = entry.consequence;
  if (authored !== null && authored.trim().length > 0) return authored;
  const copy = undoAffordance(entry.verbId).copy;
  return copy.trim().length > 0 ? copy : null;
}

/** R-3.1 … R-3.5 — the trail's one model over the append-only journal. */
export function buildActivityTrailModel(
  surface: Surface,
  entries: readonly JournalEntry[],
): ActivityTrailModel {
  const reg = createRegistry(surface);
  const newestFirst = [...entries]
    .sort((left, right) => right.seq - left.seq)
    .slice(0, CAPABILITY_LIMITS.maxJournalEntries);

  const mapped: ActivityTrailEntry[] = newestFirst.map((entry) => {
    const placePath = placePathRefs(reg, entry.placePath);
    // The ENTRY is the undo authority (`entry.inverse !== null`); the verb-keyed affordance is
    // consulted only for the non-undoable explanation text (R-3.2 / §6.3).
    const undoable = isUndoable(entry);
    return {
      seq: entry.seq,
      ts: entry.ts,
      timeLabel: formatTrailTime(entry.ts),
      actor: entry.actor,
      actorLabel: NAV_ACTOR_LABELS[entry.actor],
      verbId: entry.verbId,
      // Authored at dispatch — never re-derived from the current declaration (history is fixed).
      label: entry.label,
      placePath,
      pathLabel: formatPlacePathLabel(placePath),
      undoable,
      undoLabel: undoable ? 'Undo' : null,
      undoReason: undoable ? null : nonUndoableReason(entry),
    };
  });

  let undoableCount = 0;
  for (const entry of mapped) {
    if (entry.undoable) undoableCount += 1;
  }

  return {
    entries: mapped,
    empty: mapped.length === 0,
    emptyCopy: NAV_EMPTY_TRAIL_COPY,
    undoableCount,
  };
}
