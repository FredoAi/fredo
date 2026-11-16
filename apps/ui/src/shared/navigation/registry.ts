/**
 * Spec #3117 (P3) — the read-only index of one `Surface` declaration.
 *
 * `createRegistry` is the ONE place the declaration is indexed. Every later module
 * (resolver, keyResolver, dispatch, journal, context, discover, manifest, validation)
 * consumes the indexes instead of re-walking `PlaceTree.keys` — one declaration, one
 * derivation (ADR-6).
 *
 * PURE: built inside the call, never mutated afterwards, no imports outside `./types`.
 */

import {
  BINDABLE_STROKE_PATTERN,
  ENGINE_RESERVED_STROKES,
  type KeyBinding,
  type PlaceNode,
  type Surface,
  type VerbDescriptor,
} from './types';

/** §4.1 — the complete read-only index of a surface. */
export interface SurfaceRegistry {
  readonly surface: Surface;
  readonly rootId: string;
  readonly placesById: ReadonlyMap<string, PlaceNode>;
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
  readonly verbsById: ReadonlyMap<string, VerbDescriptor>;
  /** placeId → normalized stroke → ALL bindings for that stroke (≥ 2 ⇒ ambiguous) */
  readonly bindingsByPlace: ReadonlyMap<string, ReadonlyMap<string, readonly KeyBinding[]>>;
  /** normalized stroke → ALL aliases for that stroke */
  readonly aliasByStroke: ReadonlyMap<string, readonly KeyBinding[]>;
  /** verbId → serialized strokes that bind it, tree order */
  readonly keysByVerb: ReadonlyMap<string, readonly string[]>;
}

/**
 * §4.4 — normalize one stroke token: engine-reserved strokes canonicalise to their
 * declared casing, every other token lowercases and MUST be exactly one `[a-z0-9]`.
 *
 * Kept private to the registry (the plan's import graph allows `registry.ts` only
 * `./types`); `resolver.ts` publishes the identical rule as `normalizeStroke`. A
 * resolver test cross-checks the two so the rules cannot drift.
 */
function normalizeToken(token: string): string | null {
  const reserved = ENGINE_RESERVED_STROKES.find(
    (stroke) => stroke.toLowerCase() === token.toLowerCase(),
  );
  if (reserved !== undefined) return reserved;
  const lower = token.toLowerCase();
  return BINDABLE_STROKE_PATTERN.test(lower) ? lower : null;
}

/** §4.4 — normalize a serialized sequence; `null` when any token is not bindable. */
function normalizeKey(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const normalized: string[] = [];
  for (const token of tokens) {
    const next = normalizeToken(token);
    if (next === null) return null;
    normalized.push(next);
  }
  return normalized.join(' ');
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/** Build the immutable index set for one surface declaration. */
export function createRegistry(surface: Surface): SurfaceRegistry {
  const placesById = new Map<string, PlaceNode>();
  for (const place of surface.tree.places) {
    // FIRST declaration wins for a duplicated id — deterministic and order-preserving.
    if (!placesById.has(place.id)) placesById.set(place.id, place);
  }

  const childLists = new Map<string, string[]>();
  for (const place of surface.tree.places) {
    if (place.parent === null) continue;
    const children = childLists.get(place.parent) ?? [];
    children.push(place.id);
    childLists.set(place.parent, children);
  }
  const childrenByParent = new Map<string, readonly string[]>();
  for (const [parent, children] of childLists) {
    childrenByParent.set(parent, Object.freeze([...children]));
  }

  const verbsById = new Map<string, VerbDescriptor>();
  for (const verb of surface.verbs) {
    if (!verbsById.has(verb.id)) verbsById.set(verb.id, verb);
  }

  const bindingsByPlace = new Map<string, ReadonlyMap<string, readonly KeyBinding[]>>();
  const keysByVerbLists = new Map<string, string[]>();
  for (const place of surface.tree.places) {
    if (bindingsByPlace.has(place.id)) continue;
    const perPlace = new Map<string, KeyBinding[]>();
    for (const [rawStroke, binding] of Object.entries(place.keys)) {
      const stroke = normalizeKey(rawStroke);
      if (stroke === null) continue;
      const bindings = perPlace.get(stroke) ?? [];
      bindings.push(binding);
      perPlace.set(stroke, bindings);
      if (binding.kind === 'verb') {
        const strokes = keysByVerbLists.get(binding.verbId) ?? [];
        pushUnique(strokes, stroke);
        keysByVerbLists.set(binding.verbId, strokes);
      }
    }
    const frozen = new Map<string, readonly KeyBinding[]>();
    for (const [stroke, bindings] of perPlace) {
      frozen.set(stroke, Object.freeze([...bindings]));
    }
    bindingsByPlace.set(place.id, frozen);
  }

  const aliasLists = new Map<string, KeyBinding[]>();
  for (const [rawStroke, verbId] of Object.entries(surface.tree.directAliases)) {
    const stroke = normalizeKey(rawStroke);
    if (stroke === null) continue;
    const aliases = aliasLists.get(stroke) ?? [];
    aliases.push({ kind: 'verb', verbId });
    aliasLists.set(stroke, aliases);
  }
  const aliasByStroke = new Map<string, readonly KeyBinding[]>();
  for (const [stroke, aliases] of aliasLists) {
    aliasByStroke.set(stroke, Object.freeze([...aliases]));
  }

  const keysByVerb = new Map<string, readonly string[]>();
  for (const [verbId, strokes] of keysByVerbLists) {
    keysByVerb.set(verbId, Object.freeze([...strokes]));
  }

  return Object.freeze({
    surface,
    rootId: surface.tree.root,
    placesById,
    childrenByParent,
    verbsById,
    bindingsByPlace,
    aliasByStroke,
    keysByVerb,
  });
}
