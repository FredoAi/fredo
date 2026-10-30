/**
 * Spec #3117 (P3) — ST-4 §10 validation proofs (AC8, REQ-08.1–08.5, REQ-02.11).
 *
 * Every `it()` title the #3117 QA Plan cites for this file is verbatim. The twelve failing
 * fixtures the plan's V-01…V-12 table names live HERE (local to this file) because
 * `__tests__/fixtures.ts` is ST-1's file and is not edited by ST-4; they are built from
 * ST-1's `makePlace` / `makeVerb` / `makeSurface` builders.
 *
 * Each failing fixture MUST produce exactly ONE diagnostic with the stated `rule` + `code`,
 * and `validWireframeSurface()` MUST stay green for all twelve (REQ-08.4).
 */

import { describe, expect, it } from 'vitest';

import { resolveStroke } from '../keyResolver';
import {
  DIAGNOSTIC_CODE_BY_RULE,
  MESSAGE_TEMPLATES,
  RULE_ORDER,
  validateSurface,
  type SurfaceDiagnostic,
} from '../validation';
import type {
  KeyBinding,
  Surface,
  SurfaceDiagnosticCode,
  SurfaceRule,
  VerbDescriptor,
} from '../types';
import { makePlace, makeSurface, makeVerb, validWireframeSurface } from './fixtures';

/* ───────────────────────────── local builders ───────────────────────────── */

const ROOT = 'p.root';

function verbBinding(verbId: string): KeyBinding {
  return { kind: 'verb', verbId };
}

function placeBinding(placeId: string): KeyBinding {
  return { kind: 'place', placeId };
}

function appliesTo(places: readonly string[]): VerbDescriptor['appliesTo'] {
  return { objects: ['element'], places };
}

/** A verb with a risk field REMOVED — the V-09 fixture shape (cast through `unknown`). */
function verbWithoutRisk(id: string): VerbDescriptor {
  const verb = makeVerb({ id });
  const withoutRisk: Record<string, unknown> = { ...verb };
  delete withoutRisk.risk;
  return withoutRisk as unknown as VerbDescriptor;
}

/** One root place with `keys`, plus the verbs the keys reference. */
function rootSurface(
  keys: Readonly<Record<string, KeyBinding>>,
  verbs: readonly VerbDescriptor[],
  directAliases: Readonly<Record<string, string>> = {},
): Surface {
  return makeSurface({
    root: ROOT,
    places: [makePlace({ id: ROOT, keys })],
    verbs,
    directAliases,
  });
}

/* ───────────────────── the twelve failing fixtures (V-01 … V-12) ───────────────────── */

/** V-01 — the same verb id declared twice. */
export function duplicateVerbIdSurface(): Surface {
  return rootSurface({}, [makeVerb({ id: 'place.rect' }), makeVerb({ id: 'place.rect' })]);
}

/** V-02 — two places with `parent: null`. */
export function twoRootsSurface(): Surface {
  return makeSurface({
    root: ROOT,
    places: [makePlace({ id: ROOT }), makePlace({ id: 'p.second' })],
    verbs: [makeVerb({ id: 'place.rect' })],
  });
}

/** V-03 — a parent that names no declared place. */
export function danglingParentSurface(): Surface {
  return makeSurface({
    root: ROOT,
    places: [makePlace({ id: ROOT }), makePlace({ id: 'p.child', parent: 'p.nope' })],
    verbs: [makeVerb({ id: 'place.rect' })],
  });
}

/** V-04 — a parent cycle (p.a ↔ p.b) alongside the real root. */
export function cyclicParentSurface(): Surface {
  return makeSurface({
    root: ROOT,
    places: [
      makePlace({ id: ROOT }),
      makePlace({ id: 'p.a', parent: 'p.b' }),
      makePlace({ id: 'p.b', parent: 'p.a' }),
    ],
    verbs: [makeVerb({ id: 'place.rect' })],
  });
}

/** V-05 — a key that enters a place that is not declared. */
export function unknownKeyTargetSurface(): Surface {
  return rootSurface({ x: placeBinding('place.nothing') }, [makeVerb({ id: 'place.rect' })]);
}

/** V-06 — a verb bound in a place it does not apply to. */
export function verbNotApplicableSurface(): Surface {
  return makeSurface({
    root: ROOT,
    places: [
      makePlace({ id: ROOT }),
      makePlace({ id: 'p.edit', parent: ROOT, keys: { x: verbBinding('place.rect') } }),
    ],
    verbs: [makeVerb({ id: 'place.rect', appliesTo: appliesTo([ROOT]) })],
  });
}

/** V-07 — two strokes that normalize to the same token (`'c'` / `'c '`). */
export function duplicateStrokeSurface(): Surface {
  return rootSurface(
    { c: verbBinding('place.rect'), 'c ': verbBinding('place.ellipse') },
    [
      makeVerb({ id: 'place.rect', appliesTo: appliesTo([ROOT]) }),
      makeVerb({ id: 'place.ellipse', appliesTo: appliesTo([ROOT]) }),
    ],
  );
}

/** V-08 — a direct alias that shadows a place key bound to a DIFFERENT verb. */
export function aliasShadowsPlaceKeySurface(): Surface {
  return rootSurface(
    { r: verbBinding('place.ellipse') },
    [
      makeVerb({ id: 'place.rect', appliesTo: appliesTo([ROOT]) }),
      makeVerb({ id: 'place.ellipse', appliesTo: appliesTo([ROOT]) }),
    ],
    { r: 'place.rect' },
  );
}

/** V-08 (negative case) — the same verb on both sides is NOT a shadow. */
export function sameVerbAliasSurface(): Surface {
  return rootSurface({ r: verbBinding('place.rect') }, [makeVerb({ id: 'place.rect', appliesTo: appliesTo([ROOT]) })], {
    r: 'place.rect',
  });
}

/** V-09 — a verb with no declared `risk` class. */
export function missingRiskSurface(): Surface {
  return rootSurface({}, [verbWithoutRisk('place.rect')]);
}

/** V-10 — `destructive` with neither `undo` nor a `consequence`. */
export function destructiveWithoutUndoSurface(): Surface {
  return rootSurface({}, [makeVerb({ id: 'place.purge', risk: 'destructive' })]);
}

/** V-11 — `g` is a complete binding AND a strict prefix of `g i`. */
export function prefixShadowSurface(): Surface {
  return rootSurface(
    { g: verbBinding('place.group'), 'g i': verbBinding('place.zoomIn') },
    [
      makeVerb({ id: 'place.group', appliesTo: appliesTo([ROOT]) }),
      makeVerb({ id: 'place.zoomIn', appliesTo: appliesTo([ROOT]) }),
    ],
  );
}

/** V-12 — a blank `description`. */
export function incompleteVerbSurface(): Surface {
  return rootSurface({}, [makeVerb({ id: 'place.rect', description: '   ' })]);
}

/** REQ-08.3 — violates V-01, V-02, V-09 and V-12 and nothing else. */
export function orderedViolationSurface(): Surface {
  return makeSurface({
    root: ROOT,
    places: [makePlace({ id: ROOT }), makePlace({ id: 'p.second' })],
    verbs: [
      makeVerb({ id: 'place.rect' }),
      makeVerb({ id: 'place.rect' }), // V-01
      verbWithoutRisk('place.norisk'), // V-09
      makeVerb({ id: 'place.blank', description: '   ' }), // V-12
    ],
  });
}

/** REQ-08.3 — two violations of ONE rule, in declaration order. */
export function twoDuplicateVerbIdsSurface(): Surface {
  return rootSurface({}, [
    makeVerb({ id: 'place.alpha' }),
    makeVerb({ id: 'place.alpha' }),
    makeVerb({ id: 'place.beta' }),
    makeVerb({ id: 'place.beta' }),
  ]);
}

/* ───────────────────────────── helpers ───────────────────────────── */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Assert a fixture yields exactly one diagnostic carrying the stated rule + code. */
function expectSingleDiagnostic(
  surface: Surface,
  rule: SurfaceRule,
  code: SurfaceDiagnosticCode,
): SurfaceDiagnostic {
  const result = validateSurface(surface);
  expect(result.valid).toBe(false);
  expect(result.diagnostics).toHaveLength(1);
  const [only] = result.diagnostics;
  expect(only.rule).toBe(rule);
  expect(only.code).toBe(code);
  // The rendered message fills every placeholder of the §10.1 class.
  expect(only.message).not.toContain('<');
  expect(only.message).not.toContain('>');
  expect(only.path === 'surface' || only.path.startsWith('place:') || only.path.startsWith('verb:')).toBe(true);
  // …and the passing fixture stays green for this rule.
  expect(validateSurface(validWireframeSurface()).diagnostics).toHaveLength(0);
  return only;
}

/** A consumer gate: an invalid surface is never resolved, so no intent can be produced. */
function gateOutcome(surface: Surface, stroke: string): string {
  const validation = validateSurface(surface);
  if (!validation.valid) return 'blocked';
  const resolution = resolveStroke({
    surface,
    placePath: [surface.tree.root],
    pending: null,
    stroke,
    nowMs: 0,
    keyboardOwner: 'engine',
  });
  return resolution.status === 'dispatch' ? resolution.intent.verbId : resolution.status;
}

/* ───────────────────────────── proofs ───────────────────────────── */

describe('validateSurface', () => {
  it('successful surface produces zero diagnostics', () => {
    const result = validateSurface(validWireframeSurface());
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toStrictEqual([]);

    // A single diagnostic flips `valid` (REQ-08.1).
    expect(validateSurface(duplicateVerbIdSurface()).valid).toBe(false);
  });

  it('validateSurface never throws on a malformed surface', () => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      {},
      { tree: null },
      { tree: { places: 'nope', directAliases: [] }, verbs: 'nope' },
      { tree: { places: [null, 42, { id: 7 }] }, verbs: [null, {}] },
      { tree: { places: [{ id: ROOT, parent: null, keys: { c: null } }] }, verbs: [{ id: 'v' }] },
    ];

    for (const entry of malformed) {
      const result = validateSurface(entry as unknown as Surface);
      expect(typeof result.valid).toBe('boolean');
      expect(Array.isArray(result.diagnostics)).toBe(true);
      expect(result.valid).toBe(result.diagnostics.length === 0);
    }

    // A deep-frozen malformed surface is equally safe.
    const frozen = deepFreeze({ tree: { places: [{ id: ROOT }] } } as unknown as Surface);
    expect(() => validateSurface(frozen)).not.toThrow();
  });

  it('validateSurface does not mutate its input', () => {
    const surface = deepFreeze(validWireframeSurface());
    const treeBefore = structuredClone(surface.tree);
    const verbShapeBefore = surface.verbs.map((verb) => ({
      id: verb.id,
      title: verb.title,
      description: verb.description,
      risk: verb.risk,
      appliesTo: structuredClone(verb.appliesTo),
    }));

    const first = validateSurface(surface);
    const second = validateSurface(surface);

    expect(first.diagnostics).toStrictEqual([]);
    expect(second).toStrictEqual(first);
    expect(structuredClone(surface.tree)).toStrictEqual(treeBefore);
    expect(
      surface.verbs.map((verb) => ({
        id: verb.id,
        title: verb.title,
        description: verb.description,
        risk: verb.risk,
        appliesTo: structuredClone(verb.appliesTo),
      })),
    ).toStrictEqual(verbShapeBefore);

    // The same holds for a surface that DOES produce diagnostics.
    const violating = deepFreeze(aliasShadowsPlaceKeySurface());
    const violatingBefore = structuredClone(violating.tree);
    expect(validateSurface(violating).diagnostics).toHaveLength(1);
    expect(structuredClone(violating.tree)).toStrictEqual(violatingBefore);
  });

  it('diagnostics follow V-01 to V-12 order', () => {
    const ordered = validateSurface(orderedViolationSurface());
    expect(ordered.valid).toBe(false);
    expect(ordered.diagnostics.map((diagnostic) => diagnostic.rule)).toStrictEqual([
      'V-01',
      'V-02',
      'V-09',
      'V-12',
    ]);
    for (const diagnostic of ordered.diagnostics) {
      expect(diagnostic.code).toBe(DIAGNOSTIC_CODE_BY_RULE[diagnostic.rule]);
      expect(diagnostic.message.length).toBeGreaterThan(0);
      expect(
        diagnostic.path === 'surface' ||
          diagnostic.path.startsWith('place:') ||
          diagnostic.path.startsWith('verb:'),
      ).toBe(true);
    }

    // Declaration order is preserved inside one rule (no sorting).
    const sameRule = validateSurface(twoDuplicateVerbIdsSurface()).diagnostics.filter(
      (diagnostic) => diagnostic.rule === 'V-01',
    );
    expect(sameRule).toHaveLength(2);
    expect(sameRule.map((diagnostic) => diagnostic.path)).toStrictEqual([
      'verb:place.alpha',
      'verb:place.beta',
    ]);
  });
});

describe('the twelve rule fixtures', () => {
  it('V-01 duplicate verb id', () => {
    const only = expectSingleDiagnostic(duplicateVerbIdSurface(), 'V-01', 'NAV-E001');
    expect(only.path).toBe('verb:place.rect');
    expect(only.message).toBe('duplicate verb id "place.rect"');
  });

  it('V-02 exactly one root', () => {
    const only = expectSingleDiagnostic(twoRootsSurface(), 'V-02', 'NAV-E002');
    expect(only.path).toBe('surface');
    expect(only.message).toBe('surface must declare exactly one root place; found 2');
  });

  it('V-03 parent resolves', () => {
    const only = expectSingleDiagnostic(danglingParentSurface(), 'V-03', 'NAV-E003');
    expect(only.path).toBe('place:p.child');
    expect(only.message).toBe(
      'place "p.child" declares parent "p.nope", which is not a declared place',
    );
  });

  it('V-04 chain terminates at root', () => {
    const only = expectSingleDiagnostic(cyclicParentSurface(), 'V-04', 'NAV-E004');
    expect(only.path).toBe('place:p.a');
    expect(only.message).toBe('place "p.a" parent chain does not terminate at the root place');
  });

  it('V-05 key target declared', () => {
    const only = expectSingleDiagnostic(unknownKeyTargetSurface(), 'V-05', 'NAV-E005');
    expect(only.path).toBe(`place:${ROOT}`);
    expect(only.message).toBe(
      'place "p.root" key "x" targets unknown verb or place "place.nothing"',
    );
  });

  it('V-06 bound verb applies to that place', () => {
    const only = expectSingleDiagnostic(verbNotApplicableSurface(), 'V-06', 'NAV-E006');
    expect(only.path).toBe('verb:place.rect');
    expect(only.message).toBe(
      'verb "place.rect" is bound in place "p.edit" but does not apply to it',
    );
  });

  it('V-07 no duplicate stroke within a place', () => {
    const only = expectSingleDiagnostic(duplicateStrokeSurface(), 'V-07', 'NAV-E007');
    expect(only.path).toBe(`place:${ROOT}`);
    expect(only.message).toBe('duplicate key "c" in place "p.root"');
  });

  it('V-08 alias shadows a different-verb place key', () => {
    const only = expectSingleDiagnostic(aliasShadowsPlaceKeySurface(), 'V-08', 'NAV-E008');
    expect(only.path).toBe(`place:${ROOT}`);
    expect(only.message).toBe(
      'direct alias "r" → "place.rect" shadows place "p.root" key → "place.ellipse"',
    );

    // Same verb on both sides is NOT a shadow (REQ-02.11).
    expect(validateSurface(sameVerbAliasSurface()).diagnostics).toStrictEqual([]);

    // The gate fails BEFORE resolution, so no intent is ever produced.
    expect(gateOutcome(aliasShadowsPlaceKeySurface(), 'r')).toBe('blocked');
  });

  it('V-09 every verb declares a risk', () => {
    const only = expectSingleDiagnostic(missingRiskSurface(), 'V-09', 'NAV-E009');
    expect(only.path).toBe('verb:place.rect');
    expect(only.message).toBe('verb "place.rect" declares no risk class');
  });

  it('V-10 destructive or external has undo or consequence', () => {
    const only = expectSingleDiagnostic(destructiveWithoutUndoSurface(), 'V-10', 'NAV-E010');
    expect(only.path).toBe('verb:place.purge');
    expect(only.message).toBe(
      'verb "place.purge" is destructive with no undo and no declared consequence',
    );
  });

  it('V-11 complete binding shadows a longer sequence', () => {
    const only = expectSingleDiagnostic(prefixShadowSurface(), 'V-11', 'NAV-E011');
    expect(only.path).toBe(`place:${ROOT}`);
    expect(only.message).toBe(
      'key "g" shadows the longer sequence "g i" in place "p.root"',
    );

    // Two non-prefix sequences, a lone binding, and the same pair in different places pass.
    const nonPrefix = rootSurface(
      { 'g i': verbBinding('place.zoomIn'), 'g p': verbBinding('place.zoomOut') },
      [
        makeVerb({ id: 'place.zoomIn', appliesTo: appliesTo([ROOT]) }),
        makeVerb({ id: 'place.zoomOut', appliesTo: appliesTo([ROOT]) }),
      ],
    );
    expect(validateSurface(nonPrefix).diagnostics).toStrictEqual([]);

    const alone = rootSurface({ g: verbBinding('place.group') }, [
      makeVerb({ id: 'place.group', appliesTo: appliesTo([ROOT]) }),
    ]);
    expect(validateSurface(alone).diagnostics).toStrictEqual([]);

    const differentPlaces = makeSurface({
      root: ROOT,
      places: [
        makePlace({ id: ROOT, keys: { g: verbBinding('place.group') } }),
        makePlace({ id: 'p.child', parent: ROOT, keys: { 'g i': verbBinding('place.zoomIn') } }),
      ],
      verbs: [
        makeVerb({ id: 'place.group', appliesTo: appliesTo([ROOT]) }),
        makeVerb({ id: 'place.zoomIn', appliesTo: appliesTo(['p.child']) }),
      ],
    });
    expect(validateSurface(differentPlaces).diagnostics).toStrictEqual([]);
  });

  it('V-12 incomplete verb', () => {
    const only = expectSingleDiagnostic(incompleteVerbSurface(), 'V-12', 'NAV-E012');
    expect(only.path).toBe('verb:place.rect');
    expect(only.message).toBe('verb "place.rect" is incomplete (missing description)');
  });
});

describe('the rule table and the nine §10 obligations', () => {
  it('maps the nine obligations across V-01 to V-10', () => {
    expect(RULE_ORDER).toStrictEqual([
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

    // Nine obligations inside V-01…V-10 — the parent obligation splits into V-03/V-04.
    const obligations: Readonly<Record<string, readonly SurfaceRule[]>> = {
      O1: ['V-01'],
      O2: ['V-02'],
      O3: ['V-03', 'V-04'],
      O4: ['V-05'],
      O5: ['V-06'],
      O6: ['V-07'],
      O7: ['V-08'],
      O8: ['V-09'],
      O9: ['V-10'],
    };
    expect(Object.keys(obligations)).toHaveLength(9);
    for (const rules of Object.values(obligations)) {
      for (const rule of rules) expect(RULE_ORDER).toContain(rule);
    }
    // V-11 / V-12 are additive and equally binding — the rule set is twelve, never nine.
    expect(RULE_ORDER.slice(10)).toStrictEqual(['V-11', 'V-12']);

    const expectedCodes: Readonly<Record<string, SurfaceDiagnosticCode>> = {
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
    };
    expect(DIAGNOSTIC_CODE_BY_RULE).toStrictEqual(expectedCodes);

    // §10.1 message classes, verbatim.
    expect(MESSAGE_TEMPLATES).toStrictEqual({
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
  });
});
