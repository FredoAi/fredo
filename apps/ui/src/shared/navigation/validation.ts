/**
 * Spec #3117 (P3) — §10 surface validation: twelve rules, one pre-dispatch gate.
 *
 * `validateSurface` is the ONLY place a declaration can be rejected before dispatch. It is
 * **total and pure** (REQ-08.2): it never throws and never mutates its input, including when
 * it is handed a malformed / untyped surface cast through `unknown`. Every rule is evaluated
 * in the fixed order `V-01` → `V-12` and diagnostics are appended in declaration order with
 * NO sorting (REQ-08.3); `valid` is true only when no diagnostic was produced (REQ-08.1).
 *
 * V-01…V-10 cover the nine §10 obligations (the parent obligation splits into V-03/V-04);
 * V-11 and V-12 are additive and equally binding (REQ-08.4). The stroke grouping used by
 * V-07 / V-08 / V-11 comes from the SAME normalized registry resolution reads (NFR-6), so a
 * stroke that duplicates after normalization is reported here AND rejected as
 * `ambiguous-key` at resolution time (AC10, proof (d)).
 *
 * PURE: no clock, no globals, no timers, no I/O; imports only `./types` and `./registry`.
 */

import {
  type KeyBinding,
  type PlaceNode,
  type Surface,
  type SurfaceDiagnosticCode,
  type SurfaceRule,
} from './types';
import { createRegistry, type SurfaceRegistry } from './registry';

/* ───────────────────────────── public shapes ───────────────────────────── */

/** §10 — one author-facing diagnostic. */
export interface SurfaceDiagnostic {
  readonly rule: SurfaceRule;
  /** The stable code for `rule` (`NAV-E001` … `NAV-E012`). */
  readonly code: SurfaceDiagnosticCode;
  /** §10.1 author-facing message class, rendered for the offending declaration. */
  readonly message: string;
  /** A pointer to the offending site: `place:<id>` | `verb:<id>` | `surface`. */
  readonly path: string;
}

/** §10 — the complete result of one validation pass. */
export interface SurfaceValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly SurfaceDiagnostic[];
}

/** §10.1 — the fixed evaluation order. Never sorted. */
export const RULE_ORDER: readonly SurfaceRule[] = Object.freeze([
  'V-01',
  'V-02',
  'V-03',
  'V-04',
  'V-05',
  'V-06',
  'V-07',
  'V-08',
  'V-09',
  'V-10',
  'V-11',
  'V-12',
]);

/** §10.1 — the stable code per rule. */
export const DIAGNOSTIC_CODE_BY_RULE: Readonly<Record<SurfaceRule, SurfaceDiagnosticCode>> =
  Object.freeze({
    'V-01': 'NAV-E001',
    'V-02': 'NAV-E002',
    'V-03': 'NAV-E003',
    'V-04': 'NAV-E004',
    'V-05': 'NAV-E005',
    'V-06': 'NAV-E006',
    'V-07': 'NAV-E007',
    'V-08': 'NAV-E008',
    'V-09': 'NAV-E009',
    'V-10': 'NAV-E010',
    'V-11': 'NAV-E011',
    'V-12': 'NAV-E012',
  });

/** §10.1 — the author-facing message classes, verbatim (`<…>` are the substitution slots). */
export const MESSAGE_TEMPLATES: Readonly<Record<SurfaceRule, string>> = Object.freeze({
  'V-01': 'duplicate verb id "<id>"',
  'V-02': 'surface must declare exactly one root place; found <n>',
  'V-03': 'place "<id>" declares parent "<p>", which is not a declared place',
  'V-04': 'place "<id>" parent chain does not terminate at the root place',
  'V-05': 'place "<id>" key "<stroke>" targets unknown verb or place "<target>"',
  'V-06': 'verb "<id>" is bound in place "<p>" but does not apply to it',
  'V-07': 'duplicate key "<stroke>" in place "<id>"',
  'V-08': 'direct alias "<stroke>" → "<verb>" shadows place "<p>" key → "<other verb>"',
  'V-09': 'verb "<id>" declares no risk class',
  'V-10': 'verb "<id>" is <risk> with no undo and no declared consequence',
  'V-11': 'key "<short>" shadows the longer sequence "<long>" in place "<id>"',
  'V-12': 'verb "<id>" is incomplete (missing <field>)',
});

/* ───────────────────────────── defensive reads ───────────────────────────── */

/** §10.1 — the four legal risk classes (V-09). */
const RISK_CLASSES: readonly string[] = Object.freeze([
  'safe',
  'mutating',
  'destructive',
  'external',
]);

/** A plain object, or `null` for anything else (never throws). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A string value, or `''` when the field is absent / not a string. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** §10 — the fields a rule needs from one verb, read defensively. */
interface VerbView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly places: readonly string[];
  readonly hasAppliesTo: boolean;
  readonly risk: string;
  readonly hasUndo: boolean;
  readonly consequence: string;
}

function readVerb(value: unknown): VerbView | null {
  const verb = asRecord(value);
  if (verb === null) return null;
  const id = asString(verb.id);
  if (id.length === 0) return null;

  const appliesTo = asRecord(verb.appliesTo);
  const places: string[] = [];
  let objectsCount = 0;
  if (appliesTo !== null) {
    const objects = appliesTo.objects;
    if (Array.isArray(objects)) {
      for (const entry of objects as readonly unknown[]) if (typeof entry === 'string') objectsCount += 1;
    }
    const declaredPlaces = appliesTo.places;
    if (Array.isArray(declaredPlaces)) {
      for (const entry of declaredPlaces as readonly unknown[]) {
        if (typeof entry === 'string') places.push(entry);
      }
    }
  }

  return {
    id,
    title: asString(verb.title),
    description: asString(verb.description),
    places,
    hasAppliesTo: appliesTo !== null && (objectsCount > 0 || places.length > 0),
    risk: asString(verb.risk),
    hasUndo: verb.undo !== undefined && verb.undo !== null,
    consequence: asString(verb.consequence),
  };
}

function readBinding(value: unknown): KeyBinding | null {
  const binding = asRecord(value);
  if (binding === null) return null;
  if (binding.kind === 'verb') {
    const verbId = asString(binding.verbId);
    return verbId.length === 0 ? null : { kind: 'verb', verbId };
  }
  if (binding.kind === 'place') {
    const placeId = asString(binding.placeId);
    return placeId.length === 0 ? null : { kind: 'place', placeId };
  }
  return null;
}

function readKeys(value: unknown): Readonly<Record<string, KeyBinding>> {
  const record = asRecord(value);
  if (record === null) return {};
  const keys: Record<string, KeyBinding> = {};
  for (const [stroke, entry] of Object.entries(record)) {
    const binding = readBinding(entry);
    if (binding !== null) keys[stroke] = binding;
  }
  return keys;
}

function readPlaces(value: unknown): readonly PlaceNode[] {
  if (!Array.isArray(value)) return [];
  const places: PlaceNode[] = [];
  for (const entry of value as readonly unknown[]) {
    const place = asRecord(entry);
    if (place === null) continue;
    const id = asString(place.id);
    if (id.length === 0) continue;
    places.push({
      id,
      label: asString(place.label),
      parent: typeof place.parent === 'string' ? place.parent : null,
      transient: place.transient === true,
      sticky: place.sticky === true,
      cursor: typeof place.cursor === 'string' ? place.cursor : null,
      operator: typeof place.operator === 'string' ? place.operator : null,
      keys: readKeys(place.keys),
      entryHooks: [],
      exitHooks: [],
    });
  }
  return places;
}

function readAliases(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value);
  if (record === null) return {};
  const aliases: Record<string, string> = {};
  for (const [stroke, verbId] of Object.entries(record)) {
    if (typeof verbId === 'string') aliases[stroke] = verbId;
  }
  return aliases;
}

/**
 * The stroke grouping V-07 / V-08 / V-11 read. It is built through the SAME registry
 * resolution uses, so normalization cannot drift between the gate and the resolver.
 */
function buildRegistry(
  places: readonly PlaceNode[],
  directAliases: Readonly<Record<string, string>>,
): SurfaceRegistry {
  return createRegistry({
    tree: { appId: '', root: '', places, directAliases },
    verbs: [],
    companion: null,
  });
}

/** §10.1 — render one message class. No field is invented; only the slots are filled. */
function format(template: string, values: Readonly<Record<string, string>>): string {
  let message = template;
  for (const [slot, value] of Object.entries(values)) {
    message = message.split(`<${slot}>`).join(value);
  }
  return message;
}

function diagnose(
  rule: SurfaceRule,
  values: Readonly<Record<string, string>>,
  path: string,
): SurfaceDiagnostic {
  return {
    rule,
    code: DIAGNOSTIC_CODE_BY_RULE[rule],
    message: format(MESSAGE_TEMPLATES[rule], values),
    path,
  };
}

/** §10.1 V-11 — `short` is a strict token-boundary prefix of `long`. */
function isStrictPrefix(short: string, long: string): boolean {
  if (short === long) return false;
  return long.startsWith(`${short} `);
}

/* ───────────────────────────── rules V-01 … V-12 ───────────────────────────── */

function collectDuplicateVerbIds(verbs: readonly VerbView[], out: SurfaceDiagnostic[]): void {
  const seen = new Set<string>();
  for (const verb of verbs) {
    if (seen.has(verb.id)) {
      out.push(diagnose('V-01', { id: verb.id }, `verb:${verb.id}`));
      continue;
    }
    seen.add(verb.id);
  }
}

function collectRootCount(places: readonly PlaceNode[], out: SurfaceDiagnostic[]): void {
  let roots = 0;
  for (const place of places) if (place.parent === null) roots += 1;
  if (roots !== 1) out.push(diagnose('V-02', { n: String(roots) }, 'surface'));
}

function collectDanglingParents(
  places: readonly PlaceNode[],
  placesById: ReadonlyMap<string, PlaceNode>,
  out: SurfaceDiagnostic[],
): void {
  for (const place of places) {
    if (place.parent === null) continue;
    if (placesById.has(place.parent)) continue;
    out.push(diagnose('V-03', { id: place.id, p: place.parent }, `place:${place.id}`));
  }
}

/**
 * V-04 reports CYCLES only — a dangling parent is V-03's diagnostic, so one broken chain
 * yields exactly one finding. A cycle is reported once, for the first place (declaration
 * order) whose chain loops, and every place on that chain is skipped afterwards.
 */
function collectNonTerminatingChains(
  places: readonly PlaceNode[],
  placesById: ReadonlyMap<string, PlaceNode>,
  out: SurfaceDiagnostic[],
): void {
  const reported = new Set<string>();
  for (const place of places) {
    if (reported.has(place.id)) continue;
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: PlaceNode | undefined = place;
    let cyclic = false;
    while (current !== undefined) {
      if (seen.has(current.id)) {
        cyclic = true;
        break;
      }
      if (current.parent === null) break;
      seen.add(current.id);
      chain.push(current.id);
      current = placesById.get(current.parent);
    }
    if (!cyclic) continue;
    for (const id of chain) reported.add(id);
    out.push(diagnose('V-04', { id: place.id }, `place:${place.id}`));
  }
}

function collectUnknownKeyTargets(
  places: readonly PlaceNode[],
  placesById: ReadonlyMap<string, PlaceNode>,
  verbsById: ReadonlyMap<string, VerbView>,
  out: SurfaceDiagnostic[],
): void {
  for (const place of places) {
    for (const [stroke, binding] of Object.entries(place.keys)) {
      if (binding.kind === 'verb') {
        if (verbsById.has(binding.verbId)) continue;
        out.push(
          diagnose(
            'V-05',
            { id: place.id, stroke, target: binding.verbId },
            `place:${place.id}`,
          ),
        );
        continue;
      }
      const target = placesById.get(binding.placeId);
      if (target !== undefined && target.parent === place.id) continue;
      out.push(
        diagnose('V-05', { id: place.id, stroke, target: binding.placeId }, `place:${place.id}`),
      );
    }
  }
}

function collectNotApplicableVerbs(
  places: readonly PlaceNode[],
  verbsById: ReadonlyMap<string, VerbView>,
  out: SurfaceDiagnostic[],
): void {
  const reported = new Set<string>();
  for (const place of places) {
    for (const binding of Object.values(place.keys)) {
      if (binding.kind !== 'verb') continue;
      const verb = verbsById.get(binding.verbId);
      if (verb === undefined) continue; // V-05 owns an undeclared target
      if (verb.places.includes(place.id)) continue;
      const pair = `${verb.id}\u0000${place.id}`;
      if (reported.has(pair)) continue;
      reported.add(pair);
      out.push(diagnose('V-06', { id: verb.id, p: place.id }, `verb:${verb.id}`));
    }
  }
}

function collectDuplicateStrokes(
  places: readonly PlaceNode[],
  registry: SurfaceRegistry,
  out: SurfaceDiagnostic[],
): void {
  for (const place of places) {
    const perPlace = registry.bindingsByPlace.get(place.id);
    if (perPlace === undefined) continue;
    for (const [stroke, bindings] of perPlace) {
      if (bindings.length < 2) continue;
      out.push(diagnose('V-07', { stroke, id: place.id }, `place:${place.id}`));
    }
  }
}

function collectAliasShadowing(
  places: readonly PlaceNode[],
  registry: SurfaceRegistry,
  out: SurfaceDiagnostic[],
): void {
  for (const [stroke, aliases] of registry.aliasByStroke) {
    for (const alias of aliases) {
      if (alias.kind !== 'verb') continue;
      for (const place of places) {
        const bindings = registry.bindingsByPlace.get(place.id)?.get(stroke) ?? [];
        for (const binding of bindings) {
          if (binding.kind !== 'verb') continue;
          if (binding.verbId === alias.verbId) continue; // same verb is NOT a shadow
          out.push(
            diagnose(
              'V-08',
              { stroke, verb: alias.verbId, p: place.id, 'other verb': binding.verbId },
              `place:${place.id}`,
            ),
          );
        }
      }
    }
  }
}

function collectMissingRisk(verbs: readonly VerbView[], out: SurfaceDiagnostic[]): void {
  for (const verb of verbs) {
    if (RISK_CLASSES.includes(verb.risk)) continue;
    out.push(diagnose('V-09', { id: verb.id }, `verb:${verb.id}`));
  }
}

function collectMissingConsequence(verbs: readonly VerbView[], out: SurfaceDiagnostic[]): void {
  for (const verb of verbs) {
    if (verb.risk !== 'destructive' && verb.risk !== 'external') continue;
    if (verb.hasUndo) continue;
    if (verb.consequence.trim().length > 0) continue;
    out.push(diagnose('V-10', { id: verb.id, risk: verb.risk }, `verb:${verb.id}`));
  }
}

function collectPrefixShadowing(
  places: readonly PlaceNode[],
  registry: SurfaceRegistry,
  out: SurfaceDiagnostic[],
): void {
  for (const place of places) {
    const perPlace = registry.bindingsByPlace.get(place.id);
    if (perPlace === undefined) continue;
    const strokes = [...perPlace.keys()];
    for (const short of strokes) {
      for (const long of strokes) {
        if (!isStrictPrefix(short, long)) continue;
        out.push(diagnose('V-11', { short, long, id: place.id }, `place:${place.id}`));
      }
    }
  }
}

function collectIncompleteVerbs(verbs: readonly VerbView[], out: SurfaceDiagnostic[]): void {
  for (const verb of verbs) {
    let missing: string | null = null;
    if (verb.title.trim().length === 0) missing = 'title';
    else if (verb.description.trim().length === 0) missing = 'description';
    else if (!verb.hasAppliesTo) missing = 'appliesTo';
    if (missing === null) continue;
    out.push(diagnose('V-12', { id: verb.id, field: missing }, `verb:${verb.id}`));
  }
}

/* ───────────────────────────── the gate ───────────────────────────── */

/**
 * §10 — validate one surface declaration.
 *
 * Total and pure: a malformed input (including `null` / `undefined` / a missing `verbs`
 * array) is read defensively and produces diagnostics instead of a throw. Rules run in
 * `RULE_ORDER`; the returned array is in evaluation order, never sorted.
 */
export function validateSurface(surface: Surface): SurfaceValidation {
  const root = asRecord(surface);
  const tree = root === null ? null : asRecord(root.tree);
  const places = readPlaces(tree === null ? null : tree.places);
  const aliases = readAliases(tree === null ? null : tree.directAliases);
  const rawVerbs = root === null ? null : root.verbs;
  const verbs: VerbView[] = [];
  if (Array.isArray(rawVerbs)) {
    for (const entry of rawVerbs as readonly unknown[]) {
      const verb = readVerb(entry);
      if (verb !== null) verbs.push(verb);
    }
  }

  const placesById = new Map<string, PlaceNode>();
  for (const place of places) {
    if (!placesById.has(place.id)) placesById.set(place.id, place);
  }
  const verbsById = new Map<string, VerbView>();
  for (const verb of verbs) {
    if (!verbsById.has(verb.id)) verbsById.set(verb.id, verb);
  }

  const registry = buildRegistry(places, aliases);
  const diagnostics: SurfaceDiagnostic[] = [];

  collectDuplicateVerbIds(verbs, diagnostics); // V-01
  collectRootCount(places, diagnostics); // V-02
  collectDanglingParents(places, placesById, diagnostics); // V-03
  collectNonTerminatingChains(places, placesById, diagnostics); // V-04
  collectUnknownKeyTargets(places, placesById, verbsById, diagnostics); // V-05
  collectNotApplicableVerbs(places, verbsById, diagnostics); // V-06
  collectDuplicateStrokes(places, registry, diagnostics); // V-07
  collectAliasShadowing(places, registry, diagnostics); // V-08
  collectMissingRisk(verbs, diagnostics); // V-09
  collectMissingConsequence(verbs, diagnostics); // V-10
  collectPrefixShadowing(places, registry, diagnostics); // V-11
  collectIncompleteVerbs(verbs, diagnostics); // V-12

  return { valid: diagnostics.length === 0, diagnostics };
}
