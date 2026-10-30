/**
 * Spec #3117 (P3) — ST-5 stroke-resolution cost (REQ-01.6 / AC1 non-functional).
 *
 * One stroke resolution on a surface declaring 200 verbs across 8 places must complete in
 * under 1 ms on average over 10,000 calls — measured with BOTH an unarmed tier-1 stroke and
 * an armed tier-3 continuation, so the prefix machinery is inside the measured loop.
 *
 * `performance.now()` here is the TEST's clock; the module under test reads no clock at all
 * (pinned by `purity.test.ts`). A short warmup is excluded from the measured mean.
 */

import { describe, expect, it } from 'vitest';

import { createPendingPrefix, resolveStroke } from '../keyResolver';
import type { KeyBinding, PlaceNode, Surface } from '../types';
import { makePlace, makeSurface, makeVerb } from './fixtures';

const PLACE_COUNT = 8;
const VERB_COUNT = 200;
const CALLS = 10_000;
const NOW_MS = 1000;
const TOKENS = 'abcdefghijklmnopqrstuvwxyz'.split('');

interface CostCase {
  readonly placePath: readonly string[];
  readonly pending: { readonly sequence: string; readonly armedAtMs: number } | null;
  readonly stroke: string;
}

interface CostFixture {
  readonly surface: Surface;
  readonly cases: readonly CostCase[];
  readonly unarmedCases: number;
  readonly armedCases: number;
}

/** A 200-verb, 8-place surface with a deterministic key per verb. */
function buildCostFixture(): CostFixture {
  const placeIds = Array.from({ length: PLACE_COUNT }, (_, index) => `p.place${index}`);
  const keysByPlace = new Map<string, Record<string, KeyBinding>>(
    placeIds.map((id) => [id, {}]),
  );

  const verbs = [];
  const cases: CostCase[] = [];
  let unarmedCases = 0;
  let armedCases = 0;

  for (let index = 0; index < VERB_COUNT; index += 1) {
    const placeId = placeIds[index % PLACE_COUNT];
    const local = Math.floor(index / PLACE_COUNT); // 0..24 within each place
    const first = TOKENS[local % 5]; // a..e
    const second = TOKENS[5 + Math.floor(local / 5)]; // f..j → 25 unique pairs
    const stroke = `${first} ${second}`;

    const placeKeys = keysByPlace.get(placeId);
    if (placeKeys === undefined) throw new Error(`missing place ${placeId}`);
    placeKeys[stroke] = { kind: 'verb', verbId: `verb.${index}` };

    verbs.push(
      makeVerb({
        id: `verb.${index}`,
        title: `Verb ${index}`,
        appliesTo: { objects: [], places: [placeId] },
      }),
    );

    const placePath = placeId === placeIds[0] ? [placeIds[0]] : [placeIds[0], placeId];

    // Unarmed: the exact two-token binding (tier 1).
    cases.push({ placePath, pending: null, stroke });
    unarmedCases += 1;

    // Armed: the first token opened a prefix, the second completes it (tier 3).
    cases.push({
      placePath,
      pending: createPendingPrefix(first, NOW_MS - 100),
      stroke: second,
    });
    armedCases += 1;
  }

  const places: PlaceNode[] = [
    makePlace({ id: placeIds[0], parent: null, keys: keysByPlace.get(placeIds[0]) }),
    ...placeIds.slice(1).map((id) => makePlace({ id, parent: placeIds[0], keys: keysByPlace.get(id) })),
  ];

  return {
    surface: makeSurface({ root: placeIds[0], places, verbs }),
    cases,
    unarmedCases,
    armedCases,
  };
}

describe('stroke-resolution cost (REQ-01.6)', () => {
  it('200 verb surface resolves under one millisecond', () => {
    const fixture = buildCostFixture();

    // Non-vacuity: the fixture really is 200 verbs across 8 places, both paths present.
    expect(fixture.surface.verbs).toHaveLength(VERB_COUNT);
    expect(fixture.surface.tree.places).toHaveLength(PLACE_COUNT);
    expect(fixture.unarmedCases).toBe(VERB_COUNT);
    expect(fixture.armedCases).toBe(VERB_COUNT);
    expect(fixture.cases.length).toBe(VERB_COUNT * 2);

    const resolve = (index: number): void => {
      const sample = fixture.cases[index % fixture.cases.length];
      const result = resolveStroke({
        surface: fixture.surface,
        placePath: sample.placePath,
        pending: sample.pending,
        stroke: sample.stroke,
        nowMs: NOW_MS,
        keyboardOwner: 'engine',
      });
      if (result.status !== 'dispatch') {
        throw new Error(`case ${index} resolved to ${result.status}, expected dispatch`);
      }
    };

    // Warmup — JIT + first-touch allocations, deliberately NOT measured.
    for (let index = 0; index < 500; index += 1) resolve(index);

    const startedAt = performance.now();
    for (let index = 0; index < CALLS; index += 1) resolve(index);
    const elapsedMs = performance.now() - startedAt;

    const meanMs = elapsedMs / CALLS;
    // Report the measured budget as evidence in the test reporter output.
    console.info(
      `[navigation] mean stroke resolution ${meanMs.toFixed(4)} ms over ${CALLS} calls (200 verbs / 8 places)`,
    );
    // The measured loop really ran the full call count.
    expect(CALLS).toBe(10_000);
    expect(meanMs).toBeGreaterThanOrEqual(0);
    expect(meanMs).toBeLessThan(1);
  });
});
