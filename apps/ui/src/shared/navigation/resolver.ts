/**
 * Spec #3117 (P3) — stroke grammar + pure tree lookups.
 *
 * The resolver owns the §4.4 stroke grammar (`[a-z0-9]` + the three engine-reserved
 * strokes) and the pure, total lookups every other module reads a `SurfaceRegistry`
 * through. It reads NO clock: time enters the engine only as the `nowMs` argument in
 * `keyResolver.resolveStroke` (REQ-01.3).
 *
 * PURE: no imports outside `./types` and `./registry`.
 */

import {
  BINDABLE_STROKE_PATTERN,
  ENGINE_RESERVED_STROKES,
  type PlaceNode,
  type VerbDescriptor,
} from './types';
import type { SurfaceRegistry } from './registry';

function normalizeToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  const reserved = ENGINE_RESERVED_STROKES.find(
    (stroke) => stroke.toLowerCase() === trimmed.toLowerCase(),
  );
  if (reserved !== undefined) return reserved;
  const lower = trimmed.toLowerCase();
  return BINDABLE_STROKE_PATTERN.test(lower) ? lower : null;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * §4.4 — normalize a stroke / sequence to lowercase tokens joined by ONE space.
 * Returns `null` when the sequence is empty or any token is not bindable.
 */
export function normalizeStroke(raw: string): string | null {
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

/**
 * §4.4 — is one token bindable? `[a-z0-9]` plus `Escape` / `Enter` / `Tab`;
 * `?` and `/` are display glyphs and are NEVER bindable.
 */
export function isBindableStroke(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length === 0) return false;
  if (/\s/.test(trimmed)) return false;
  return normalizeToken(trimmed) !== null;
}

/** §4.4 — split a serialized sequence into normalized tokens (`[]` when invalid). */
export function splitStrokes(sequence: string): readonly string[] {
  const normalized = normalizeStroke(sequence);
  return normalized === null ? [] : normalized.split(' ');
}

/** §4.4 — serialize tokens by joining them with exactly one space. */
export function serializeStrokes(tokens: readonly string[]): string {
  const normalized: string[] = [];
  for (const token of tokens) {
    const next = normalizeToken(token);
    if (next !== null) normalized.push(next);
  }
  return normalized.join(' ');
}

/** §10 V-11 — `shorter` is a STRICT token-boundary prefix of `longer`. */
export function isStrictStrokePrefix(shorter: string, longer: string): boolean {
  const prefix = normalizeStroke(shorter);
  const full = normalizeStroke(longer);
  if (prefix === null || full === null || prefix === full) return false;
  return full.startsWith(`${prefix} `);
}

/** §7 — the place path root → current. Unknown or dangling places stop the walk. */
export function resolvePlacePath(
  reg: SurfaceRegistry,
  currentPlaceId: string,
): readonly string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = currentPlaceId;
  while (current !== null && !seen.has(current)) {
    const place = reg.placesById.get(current);
    if (place === undefined) break;
    seen.add(current);
    path.push(place.id);
    current = place.parent;
  }
  return path.reverse();
}

/** §2 — one place by id, or `null`. */
export function getPlace(reg: SurfaceRegistry, placeId: string): PlaceNode | null {
  return reg.placesById.get(placeId) ?? null;
}

/** §3 — one verb by id, or `null`. */
export function getVerb(reg: SurfaceRegistry, verbId: string): VerbDescriptor | null {
  return reg.verbsById.get(verbId) ?? null;
}

/** §2.1 — the child place a `{kind:'place'}` binding at `stroke` enters, or `null`. */
export function childPlaceOf(
  reg: SurfaceRegistry,
  placeId: string,
  stroke: string,
): string | null {
  const normalized = normalizeStroke(stroke);
  if (normalized === null) return null;
  const bindings = reg.bindingsByPlace.get(placeId)?.get(normalized) ?? [];
  for (const binding of bindings) {
    if (binding.kind === 'place') return binding.placeId;
  }
  return null;
}

/**
 * §4.1 tier 3 — the next tokens of every binding in `placeId` that extends `prefix`.
 * Declaration order, de-duplicated, `[]` when the prefix has no continuation.
 */
export function continuationStrokes(
  reg: SurfaceRegistry,
  placeId: string,
  prefix: string,
): readonly string[] {
  const normalized = normalizeStroke(prefix);
  if (normalized === null) return [];
  const depth = normalized.split(' ').length;
  const perPlace = reg.bindingsByPlace.get(placeId);
  if (perPlace === undefined) return [];
  const next: string[] = [];
  for (const stroke of perPlace.keys()) {
    if (!isStrictStrokePrefix(normalized, stroke)) continue;
    const token = stroke.split(' ')[depth];
    if (token !== undefined) pushUnique(next, token);
  }
  return next;
}
