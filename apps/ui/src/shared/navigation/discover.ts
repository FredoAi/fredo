/**
 * Spec #3117 (P3) — §8 discovery derivations.
 *
 * Rail, map, palette, which-key/next-step hint and tooltip are ALL projections of the
 * same declaration (§2 `PlaceTree` + §3 `VerbDescriptor`) plus the injected snapshot.
 * Nothing here maintains a second list: a difference between a derived output and the
 * declaration is a defect (ADR-6, §8.2).
 *
 * The UI/UX semantic contract in the #3117 plan is normative for these outputs:
 *   - rail  = the current place's BOUND verbs in declaration order, never padded,
 *             capped at 8 with `overflow = boundRows − 8`;
 *   - palette = recents (newest-first, deduped, stale ids dropped BEFORE the cap of 5)
 *             then the remaining verbs grouped by place in tree order, no duplicate id;
 *   - map   = the whole tree in tree order (root first, declaration order within);
 *   - hint  = `'prefix'` rows with `PENDING_TIMEOUT_MS` for an armed prefix, or the next
 *             three available non-rail verbs after a verb (`[]` when all duplicate rail);
 *   - tooltip = `"<title> (<keys joined by ', '>)"` + `" — <risk>"` iff risk ≠ safe,
 *             parenthetical omitted when unbound, never `?` or `/`.
 *
 * PURE: derivations never mutate their inputs; no clock, no DOM, no I/O.
 */

import {
  PENDING_TIMEOUT_MS,
  type ContextSnapshot,
  type HintModel,
  type HintRow,
  type PlaceNode,
  type Risk,
  type Surface,
  type VerbDescriptor,
} from './types';
import { createRegistry, type SurfaceRegistry } from './registry';

/** §8.1 — the rail's hard cap. */
export const RAIL_MAX_ROWS = 8;

/** §8.1 — the rail's AUTHORING target, never a runtime floor (the rail never pads). */
export const RAIL_MIN_ROWS = 4;

/** §8.1 — the recents section cap (the place group is never truncated). */
export const PALETTE_MAX_RECENTS = 5;

/** §8.1 — the post-verb suggestion count. */
export const HINT_NEXT_COUNT = 3;

/** §8.1 — one rail row. */
export interface RailRow {
  verbId: string;
  title: string;
  risk: Risk;
  keys: string[];
  enabled: boolean;
  reason: string | null;
}

/** §8.1 — the rail projection (`overflow` is a count, never a list). */
export interface RailModel {
  readonly rows: readonly RailRow[];
  readonly overflow: number;
}

/** §8.1 — one map row. */
export interface MapRow {
  readonly placePath: readonly string[];
  readonly verbs: readonly string[];
  readonly keys: readonly string[];
}

/** §8.1 — one palette row. */
export interface PaletteRow {
  readonly verbId: string;
  readonly title: string;
  readonly placePath: readonly string[];
  readonly key: string | null;
  readonly risk: Risk;
  readonly section: 'recent' | 'place';
}

// ST-1 owns the hint vocabulary in the leaf module; re-export rather than duplicate it.
export type { HintModel, HintRow };

/* ───────────────────────────── internals ───────────────────────────── */

/** The current place: the snapshot's last id when it resolves, else the declared root. */
function currentPlaceId(reg: SurfaceRegistry, snapshot: ContextSnapshot): string {
  const last = snapshot.placePath[snapshot.placePath.length - 1];
  return last !== undefined && reg.placesById.has(last) ? last : reg.rootId;
}

/** §8.1 — tree order: root first, then declaration order of children, depth-first. */
function treeOrderPlaces(reg: SurfaceRegistry): PlaceNode[] {
  const ordered: PlaceNode[] = [];
  const seen = new Set<string>();

  const visit = (placeId: string): void => {
    if (seen.has(placeId)) return;
    const place = reg.placesById.get(placeId);
    if (place === undefined) return;
    seen.add(placeId);
    ordered.push(place);
    for (const childId of reg.childrenByParent.get(placeId) ?? []) visit(childId);
  };

  visit(reg.rootId);
  // Total for a malformed tree: any place not reachable from the root keeps its
  // declaration order after the root-reachable prefix.
  for (const declared of reg.surface.tree.places) {
    if (seen.has(declared.id)) continue;
    const place = reg.placesById.get(declared.id);
    if (place === undefined) continue;
    seen.add(place.id);
    ordered.push(place);
  }
  return ordered;
}

/** §7/§8 — the place path root → current as place IDS (pin #5: ids, not labels). */
function placePathIds(reg: SurfaceRegistry, placeId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = placeId;
  while (current !== null && !seen.has(current)) {
    const place = reg.placesById.get(current);
    if (place === undefined) break;
    seen.add(current);
    path.push(place.id);
    current = place.parent;
  }
  return path.reverse();
}

/** The verb bindings of one place, in the place's declared stroke order. */
interface PlaceBindings {
  readonly keysByVerb: ReadonlyMap<string, readonly string[]>;
  /** Every bindable stroke of the place (verb OR place binding), declaration order. */
  readonly strokes: readonly string[];
}

function collectPlaceBindings(reg: SurfaceRegistry, placeId: string): PlaceBindings {
  const perPlace = reg.bindingsByPlace.get(placeId);
  const keysByVerb = new Map<string, string[]>();
  const strokes: string[] = [];
  if (perPlace === undefined) return { keysByVerb, strokes };
  for (const [stroke, bindings] of perPlace) {
    strokes.push(stroke);
    for (const binding of bindings) {
      if (binding.kind !== 'verb') continue;
      const keys = keysByVerb.get(binding.verbId) ?? [];
      if (!keys.includes(stroke)) keys.push(stroke);
      keysByVerb.set(binding.verbId, keys);
    }
  }
  return { keysByVerb, strokes };
}

/** True when the verb declares the place in `appliesTo.places`. */
function appliesTo(verb: VerbDescriptor, placeId: string): boolean {
  return verb.appliesTo?.places?.includes(placeId) === true;
}

/** The first stroke bound to `verbId` in `placeId`, or `null` when unbound there. */
function firstKeyInPlace(
  reg: SurfaceRegistry,
  placeId: string,
  verbId: string,
): string | null {
  return collectPlaceBindings(reg, placeId).keysByVerb.get(verbId)?.[0] ?? null;
}

/**
 * The verb's one palette place: the first tree-order place it applies to, else the first
 * place that binds it, else the root.
 */
function primaryPlaceId(reg: SurfaceRegistry, verb: VerbDescriptor): string {
  const places = treeOrderPlaces(reg);
  for (const place of places) {
    if (appliesTo(verb, place.id)) return place.id;
  }
  for (const place of places) {
    if (collectPlaceBindings(reg, place.id).keysByVerb.has(verb.id)) return place.id;
  }
  return reg.rootId;
}

/* ───────────────────────────── rail ───────────────────────────── */

/** §8.1 — the current place's bound verbs, declaration order, capped with overflow. */
export function deriveRail(
  surface: Surface,
  snapshot: ContextSnapshot,
): RailModel {
  const reg = createRegistry(surface);
  const placeId = currentPlaceId(reg, snapshot);
  const { keysByVerb } = collectPlaceBindings(reg, placeId);

  const bound: VerbDescriptor[] = [];
  for (const verb of surface.verbs) {
    if (keysByVerb.has(verb.id)) bound.push(verb);
  }

  const rows: RailRow[] = bound.slice(0, RAIL_MAX_ROWS).map((verb) => ({
    verbId: verb.id,
    title: verb.title,
    risk: verb.risk,
    keys: [...(keysByVerb.get(verb.id) ?? [])],
    enabled: verb.available(snapshot),
    // Pin #2: only an authored reason may be emitted; no field carries one, so null.
    reason: null,
  }));

  return {
    rows,
    overflow: Math.max(0, bound.length - RAIL_MAX_ROWS),
  };
}

/* ───────────────────────────── map ───────────────────────────── */

/** §8.1 — the whole tree in tree order as `{placePath, verbs, keys}` rows. */
export function deriveMap(surface: Surface): readonly MapRow[] {
  const reg = createRegistry(surface);
  return treeOrderPlaces(reg).map((place) => {
    const { strokes } = collectPlaceBindings(reg, place.id);
    const verbs = surface.verbs
      .filter((verb) => appliesTo(verb, place.id))
      .map((verb) => verb.id);
    return {
      placePath: placePathIds(reg, place.id),
      verbs,
      keys: [...strokes],
    };
  });
}

/* ───────────────────────────── palette ───────────────────────────── */

/** §8.1 — recents first, then the remaining verbs grouped by place in tree order. */
export function derivePalette(
  surface: Surface,
  _snapshot: ContextSnapshot,
  recents: readonly string[],
): readonly PaletteRow[] {
  const reg = createRegistry(surface);
  const rows: PaletteRow[] = [];
  const emitted = new Set<string>();

  // Recents: stale ids dropped, duplicates removed, and ONLY THEN the list is capped —
  // so a stale/duplicate id never costs a real recent its slot.
  const recentIds: string[] = [];
  for (const id of recents) {
    if (recentIds.length >= PALETTE_MAX_RECENTS) break;
    if (reg.verbsById.get(id) === undefined) continue;
    if (recentIds.includes(id)) continue;
    recentIds.push(id);
  }
  for (const id of recentIds) {
    const verb = reg.verbsById.get(id);
    if (verb === undefined) continue;
    const placeId = primaryPlaceId(reg, verb);
    emitted.add(id);
    rows.push({
      verbId: verb.id,
      title: verb.title,
      placePath: placePathIds(reg, placeId),
      key: firstKeyInPlace(reg, placeId, verb.id),
      risk: verb.risk,
      section: 'recent',
    });
  }

  // Place group: flattened tree order, each verb exactly once (its one placePath).
  for (const place of treeOrderPlaces(reg)) {
    const path = placePathIds(reg, place.id);
    for (const verb of surface.verbs) {
      if (emitted.has(verb.id)) continue;
      if (!appliesTo(verb, place.id)) continue;
      emitted.add(verb.id);
      rows.push({
        verbId: verb.id,
        title: verb.title,
        placePath: path,
        key: firstKeyInPlace(reg, place.id, verb.id),
        risk: verb.risk,
        section: 'place',
      });
    }
  }

  return rows;
}

/* ───────────────────────────── hint ───────────────────────────── */

/** §8.1 — which-key rows for an armed prefix; ALWAYS ≥ 1 row for a real prefix. */
function derivePrefixHint(
  reg: SurfaceRegistry,
  placeId: string,
  sequence: string,
): HintModel {
  const tokens = sequence.trim().split(/\s+/).filter((token) => token.length > 0);
  const prefix = tokens.join(' ');
  const depth = tokens.length;
  const perPlace = reg.bindingsByPlace.get(placeId);
  const rows: HintRow[] = [];
  const seenKeys = new Set<string>();

  for (const [stroke, bindings] of perPlace ?? new Map()) {
    if (prefix.length === 0 || !stroke.startsWith(`${prefix} `)) continue;
    const token = stroke.split(' ')[depth];
    if (token === undefined || seenKeys.has(token)) continue;
    const binding = bindings[0];
    if (binding === undefined) continue;
    seenKeys.add(token);
    if (binding.kind === 'verb') {
      const verb = reg.verbsById.get(binding.verbId);
      rows.push({
        key: token,
        label: verb?.title ?? binding.verbId,
        verbId: binding.verbId,
      });
    } else {
      const place = reg.placesById.get(binding.placeId);
      rows.push({
        key: token,
        label: place?.label ?? binding.placeId,
        verbId: binding.placeId,
      });
    }
  }

  return { kind: 'prefix', rows, readyAfterMs: PENDING_TIMEOUT_MS };
}

/** §8.1 — the next ≤ 3 available, non-rail verbs of the current place. */
function deriveNextHint(
  reg: SurfaceRegistry,
  surface: Surface,
  snapshot: ContextSnapshot,
  placeId: string,
): HintModel {
  const { keysByVerb } = collectPlaceBindings(reg, placeId);
  const rows: HintRow[] = [];

  for (const verb of surface.verbs) {
    if (rows.length >= HINT_NEXT_COUNT) break;
    if (keysByVerb.has(verb.id)) continue; // already shown in the rail
    if (!appliesTo(verb, placeId)) continue;
    if (!verb.available(snapshot)) continue;
    rows.push({
      key: firstKeyInPlace(reg, placeId, verb.id) ?? '',
      label: verb.title,
      verbId: verb.id,
    });
  }

  return { kind: 'next', rows, readyAfterMs: 0 };
}

/** §8.1 — one model, two kinds: prefix when armed, next-step otherwise. */
export function deriveHint(
  surface: Surface,
  snapshot: ContextSnapshot,
  pending: { readonly sequence: string; readonly armedAtMs: number } | null,
): HintModel {
  const reg = createRegistry(surface);
  const placeId = currentPlaceId(reg, snapshot);
  if (pending !== null) return derivePrefixHint(reg, placeId, pending.sequence);
  return deriveNextHint(reg, surface, snapshot, placeId);
}

/* ───────────────────────────── tooltip ───────────────────────────── */

/**
 * §8.1 — `"<title> (<keys joined by ', '>)"` plus `" — <risk>"` iff risk ≠ safe.
 * The parenthetical is omitted when unbound; `?` and `/` are never key names.
 */
export function formatTooltip(verb: VerbDescriptor, keys: readonly string[]): string {
  let text = verb.title;
  if (keys.length > 0) text += ` (${keys.join(', ')})`;
  if (verb.risk !== 'safe') text += ` — ${verb.risk}`;
  return text;
}
