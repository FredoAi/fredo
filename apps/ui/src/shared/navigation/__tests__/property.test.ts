/**
 * Spec #3117 (P3) — ST-5 seeded property run (AC3 / REQ-01.5, REQ-10.1).
 *
 * 3 seeds × 1,000 cases = 3,000 generated surface/stroke pairs per run. The PRNG is
 * mulberry32 from `fixtures.ts` (`createSeededRandom`) — NO `fast-check`, NO `Math.random`,
 * NO skipped cases. Each generated case asserts:
 *   - resolution never throws;
 *   - the outcome is exactly one of the seven typed variants;
 *   - a `dispatch` outcome carries exactly ONE intent whose `verbId` resolves in the
 *     generated surface (only verb bindings are generated, so a dispatch target is always
 *     a declared verb);
 *   - calling resolution twice with the same (surface, placePath, pending, stroke, nowMs)
 *     yields a deep-equal outcome.
 *
 * The case count is pinned by the second `it()` (≥ 1,000 floor, exactly 3,000 planned).
 */

import { describe, expect, it } from 'vitest';

import { createPendingPrefix, resolveStroke, type KeyResolution } from '../keyResolver';
import type {
  KeyBinding,
  PlaceNode,
  Surface,
  VerbDescriptor,
} from '../types';
import {
  PROPERTY_CASES_PER_SEED,
  PROPERTY_SEEDS,
  createSeededRandom,
  makePlace,
  makeSurface,
  makeVerb,
  pick,
  randomInt,
} from './fixtures';

/** §4.4 bindable bare tokens only — `Escape` is excluded so every dispatch target is a verb. */
const TOKENS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'w', 'x', 'y', 'z'] as const;

const RISKS: readonly VerbDescriptor['risk'][] = ['safe', 'mutating', 'destructive', 'external'];

/** Non-bindable inputs: they MUST resolve to a quiet hint, never throw. */
const INVALID_STROKES = ['?', '/', '', 'A'] as const;

const NOW_MS = 1000;

/** REQ-10.1 — the seven typed outcome variants. */
const OUTCOME_STATUSES: readonly KeyResolution['status'][] = [
  'dispatch',
  'armed',
  'pending',
  'passthrough',
  'hint',
  'rejected',
  'timeout',
];

interface GeneratedCase {
  readonly surface: Surface;
  readonly placePath: readonly string[];
  readonly pending: { readonly sequence: string; readonly armedAtMs: number } | null;
  readonly stroke: string;
  readonly nowMs: number;
  readonly verbIds: readonly string[];
}

/** Generate a random verb binding map for one place (vertex/id pairs only). */
function generateKeys(rng: () => number, verbIds: readonly string[]): Record<string, KeyBinding> {
  const keys: Record<string, KeyBinding> = {};
  const count = randomInt(rng, 5);
  for (let index = 0; index < count; index += 1) {
    const stroke =
      rng() < 0.35
        ? `${pick(rng, TOKENS)} ${pick(rng, TOKENS)}`
        : pick(rng, TOKENS);
    keys[stroke] = { kind: 'verb', verbId: pick(rng, verbIds) };
  }
  // Sometimes declare the SAME normalized stroke twice — resolution must reject `ambiguous-key`.
  if (rng() < 0.15) {
    const token = pick(rng, TOKENS);
    keys[token] = { kind: 'verb', verbId: verbIds[0] };
    keys[`${token} `] = { kind: 'verb', verbId: verbIds[verbIds.length - 1] };
  }
  return keys;
}

/** One generated (surface, place path, pending prefix, stroke, nowMs) case. */
function generateCase(rng: () => number): GeneratedCase {
  const verbCount = 1 + randomInt(rng, 6);
  const verbIds = Array.from({ length: verbCount }, (_, index) => `verb.${index}`);
  const verbs: VerbDescriptor[] = verbIds.map((id) =>
    makeVerb({ id, title: id, risk: pick(rng, RISKS) }),
  );

  const rootId = 'p.root';
  const childCount = randomInt(rng, 3);
  const childIds = Array.from({ length: childCount }, (_, index) => `p.child${index}`);

  const places: PlaceNode[] = [
    makePlace({ id: rootId, parent: null, keys: generateKeys(rng, verbIds) }),
    ...childIds.map((id) =>
      makePlace({ id, parent: rootId, keys: generateKeys(rng, verbIds) }),
    ),
  ];

  const aliasCount = randomInt(rng, 4);
  const directAliases: Record<string, string> = {};
  for (let index = 0; index < aliasCount; index += 1) {
    directAliases[pick(rng, TOKENS)] = pick(rng, verbIds);
  }

  const surface = makeSurface({ root: rootId, places, verbs, directAliases });

  // Place path: root, or root + one generated child (all declared ids, so total behaviour).
  const placePath =
    childIds.length > 0 && rng() < 0.5 ? [rootId, pick(rng, childIds)] : [rootId];

  // Pending prefix: often armed, with an armedAtMs that straddles the 250 ms timeout.
  let pending: GeneratedCase['pending'] = null;
  if (rng() < 0.25) {
    const sequence = rng() < 0.3 ? `${pick(rng, TOKENS)} ${pick(rng, TOKENS)}` : pick(rng, TOKENS);
    pending = createPendingPrefix(sequence, NOW_MS - randomInt(rng, 300));
  }

  // Stroke: a bindable token/sequence, or one of the deliberately invalid inputs.
  const stroke =
    rng() < 0.1
      ? pick(rng, INVALID_STROKES)
      : rng() < 0.25
        ? `${pick(rng, TOKENS)} ${pick(rng, TOKENS)}`
        : pick(rng, TOKENS);

  return { surface, placePath, pending, stroke, nowMs: NOW_MS, verbIds };
}

function resolveCase(generated: GeneratedCase): KeyResolution {
  return resolveStroke({
    surface: generated.surface,
    placePath: generated.placePath,
    pending: generated.pending,
    stroke: generated.stroke,
    nowMs: generated.nowMs,
    keyboardOwner: 'engine',
  });
}

interface PropertyRunSummary {
  readonly cases: number;
  readonly dispatched: number;
  readonly statuses: Readonly<Record<string, number>>;
}

let cachedSummary: PropertyRunSummary | null = null;

/** Run (once) every generated case and validate it. */
function runPropertySuite(): PropertyRunSummary {
  if (cachedSummary !== null) return cachedSummary;

  let cases = 0;
  let dispatched = 0;
  const statuses: Record<string, number> = {};

  for (const seed of PROPERTY_SEEDS) {
    const rng = createSeededRandom(seed);
    for (let index = 0; index < PROPERTY_CASES_PER_SEED; index += 1) {
      const generated = generateCase(rng);
      cases += 1;

      let outcome: KeyResolution;
      try {
        outcome = resolveCase(generated);
      } catch (error) {
        throw new Error(
          `seed ${seed} case ${index} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // One typed outcome, never a throw.
      expect(OUTCOME_STATUSES, `seed ${seed} case ${index}`).toContain(outcome.status);
      statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1;

      // Determinism pair: the same inputs twice ⇒ deep-equal.
      expect(resolveCase(generated), `seed ${seed} case ${index} determinism`).toStrictEqual(
        outcome,
      );

      if (outcome.status === 'dispatch') {
        dispatched += 1;
        // Exactly ONE intent, carrying a verb declared in the generated surface.
        expect(Object.keys(outcome).sort()).toStrictEqual(['intent', 'status', 'tier']);
        expect(Array.isArray(outcome.intent)).toBe(false);
        expect(generated.verbIds).toContain(outcome.intent.verbId);
        expect([1, 2, 3]).toContain(outcome.tier);
        expect(outcome.intent.args).toStrictEqual({});
      }
    }
  }

  cachedSummary = { cases, dispatched, statuses };
  return cachedSummary;
}

describe('seeded property run (REQ-10.1)', () => {
  it('seeded resolution never throws and yields one typed outcome', () => {
    const summary = runPropertySuite();
    // Non-vacuity: the run really executed every seeded case.
    expect(summary.cases).toBe(PROPERTY_SEEDS.length * PROPERTY_CASES_PER_SEED);
    expect(summary.dispatched).toBeGreaterThan(0);
    // Every generated variant appeared at least once (dispatch/hint are guaranteed by shape).
    expect(summary.statuses.dispatch).toBeGreaterThan(0);
    expect(summary.statuses.hint).toBeGreaterThan(0);
  });

  it('property run generates 3000 cases', () => {
    expect(PROPERTY_SEEDS).toStrictEqual([1, 42, 2026]);
    expect(PROPERTY_CASES_PER_SEED).toBe(1000);

    const summary = runPropertySuite();
    expect(summary.cases).toBe(3000);
    // REQ-10.1 floor: at least 1,000 generated cases per CI run.
    expect(summary.cases).toBeGreaterThanOrEqual(1000);

    // Two independent seeded runs are byte-identical (no hidden global state, no clock).
    for (const seed of PROPERTY_SEEDS) {
      const forward = createSeededRandom(seed);
      const replay = createSeededRandom(seed);
      for (let index = 0; index < 25; index += 1) {
        const first = generateCase(forward);
        const second = generateCase(replay);
        expect(JSON.stringify(second.surface)).toBe(JSON.stringify(first.surface));
        expect(resolveCase(second)).toStrictEqual(resolveCase(first));
      }
    }
  });
});
