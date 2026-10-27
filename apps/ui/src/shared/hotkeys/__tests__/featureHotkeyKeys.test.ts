/**
 * Spec #3009 (adjudication A7) — the migrated `data-hotkey` values are GLOBALLY
 * disjoint across the five features.
 *
 * #3009 aggregates every mounted `data-hotkey` element app-wide and treats a
 * duplicate binding as a build/dev error. This STATIC source pin reads the five
 * feature components, extracts each declared key (static attributes + the My
 * Work Items source-tab ternary), and proves:
 *   - every shipped feature declares EXACTLY its assigned keys, and
 *   - the union over all five shipped features is the 14-key set with NO duplicate.
 *
 * Mission Monitor `n`/`p` (no mounted control) and Diagram `f` (no fit control)
 * are intentionally absent — no UI is invented for them.
 *
 * Spec #3070 adds the Wireframe toolbar. Its bindings are declared in the ONE
 * command table (`actions/wireframeActions.ts`) and mounted as `data-hotkey` from
 * that table, so the table — not the component markup — is the authoritative
 * declaration.
 *
 * Spec #3071 ST-3 RELAXED the app-wide duplicate rule (see
 * `hotkeyElements.detectDuplicateHotkeys`): two bindings collide only when they
 * share a full serialization OR one's serialization is a STRICT PREFIX of
 * another's. A shared FIRST step is therefore legal — the 36-slot first-step
 * budget is saturated, so the arrangement namespace binds as `g+*` two-step
 * sequences. This pin therefore asserts the RELAXED invariant (no duplicate
 * serialization, no strict-prefix shadowing, every first step inside `[a-z0-9]`)
 * rather than a fixed key total: the Wireframe re-binding (`zoom.in` `g`→`g+i`,
 * `zoom.out` `m`→`g+o`) lands in a SIBLING sub-task (ST-4) on the same branch, so
 * the union is 36 distinct first steps before that change and 35 after (`m`
 * freed). BOTH states must pass here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** One grammar step: a single lowercase alphanumeric. */
const STEP = '[a-z0-9]';
/** A full `data-hotkey` value: one step, or a two-step `a+b` sequence. */
const VALUE = `${STEP}(?:\\+${STEP})?`;

/** Strip comments so doc prose cannot satisfy a key scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readSource(relativePath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
}

/**
 * Extract every declared key: static `data-hotkey="x"` + ternary blocks
 * `data-hotkey={…}`. A value is one step or a two-step `a+b` sequence.
 */
function extractKeys(source: string): string[] {
  const keys: string[] = [];

  for (const match of source.matchAll(new RegExp(`data-hotkey="(${VALUE})"`, 'g'))) {
    keys.push(match[1]);
  }

  // A dynamic attribute holds only key literals; multi-char branch values
  // (e.g. `'application-data'`) are never keys.
  for (const block of source.matchAll(/data-hotkey=\{([\s\S]*?)\}/g)) {
    for (const literal of block[1].matchAll(new RegExp(`'(${VALUE})'`, 'g'))) {
      keys.push(literal[1]);
    }
  }

  return keys;
}

/**
 * Extract the keys declared by the Wireframe command table (`hotkey: 'x'`).
 * A table-driven toolbar mounts these through `data-hotkey={hotkey}`, so the
 * literal lives in the table row, not in the component markup.
 */
function extractActionTableKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(new RegExp(`\\bhotkey:\\s*'(${VALUE})'`, 'g'))) {
    keys.push(match[1]);
  }
  return keys;
}

interface FeatureKeys {
  readonly file: string;
  /** Present for the five shipped features (their exact assignment). */
  readonly expected?: readonly string[];
  /** Optional extractor for a feature whose keys are declared in a table. */
  readonly extract?: (source: string) => string[];
}

/** The five shipped features (A7). */
const SHIPPED_FEATURES: readonly FeatureKeys[] = [
  {
    file: 'src/applications/mission-monitor/components/SessionHistoryDrawer.tsx',
    expected: ['s'],
  },
  {
    file: 'src/applications/diagram/components/ArchitectureDiagram.tsx',
    expected: ['d'],
  },
  {
    file: 'src/applications/my-workitems/components/MyWorkItemsContainer.tsx',
    expected: ['r', 'a', 'z', 'j'],
  },
  {
    file: 'src/applications/optimizely/components/OptimizelyFlagsPanel.tsx',
    expected: ['f', 'q', 'e', 'c'],
  },
  {
    file: 'src/applications/dev-mode/components/DevMode.tsx',
    expected: ['x', 'v', 'i', 'b'],
  },
];

/** Wireframe (Spec #3070/#3071) — the bindings declared by the command table. */
const WIREFRAME_FEATURE: FeatureKeys = {
  file: 'src/applications/wireframe/actions/wireframeActions.ts',
  extract: extractActionTableKeys,
};

const FEATURES: readonly FeatureKeys[] = [...SHIPPED_FEATURES, WIREFRAME_FEATURE];

/** The A7 assignment: 14 controls, 14 distinct keys. */
const ALL_KEYS = ['s', 'd', 'r', 'a', 'z', 'j', 'f', 'q', 'e', 'c', 'i', 'x', 'b', 'v'];

function keysOf(feature: FeatureKeys): string[] {
  const source = readSource(feature.file);
  return (feature.extract ?? extractKeys)(source);
}

/** The first (namespace) step of a declared key. */
function firstStepOf(key: string): string {
  return key.split('+')[0];
}

/** Every pair where `shorter` is a strict `+`-prefix of `longer`. */
function strictPrefixPairs(keys: readonly string[]): string[] {
  const pairs: string[] = [];
  for (const shorter of keys) {
    for (const longer of keys) {
      if (shorter === longer) continue;
      if (longer.startsWith(`${shorter}+`)) pairs.push(`${shorter} < ${longer}`);
    }
  }
  return pairs;
}

describe('A7 — globally disjoint data-hotkey assignment', () => {
  it('every shipped feature declares exactly its assigned keys', () => {
    for (const feature of SHIPPED_FEATURES) {
      expect([...keysOf(feature)].sort(), feature.file).toEqual(
        [...(feature.expected ?? [])].sort(),
      );
    }
  });

  it('the union over all five shipped features is the 14-key set with no duplicate', () => {
    const all: string[] = [];
    for (const feature of SHIPPED_FEATURES) all.push(...keysOf(feature));

    expect([...all].sort()).toEqual([...ALL_KEYS].sort());
    // No key is declared by more than one feature (app-wide aggregation rule).
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not declare the unmigrated Mission Monitor n/p or Diagram f', () => {
    const monitor = extractKeys(
      readSource('src/applications/mission-monitor/components/SessionHistoryDrawer.tsx'),
    );
    const diagram = extractKeys(
      readSource('src/applications/diagram/components/ArchitectureDiagram.tsx'),
    );
    expect(monitor).not.toContain('n');
    expect(monitor).not.toContain('p');
    expect(diagram).not.toContain('f');
  });

  it('the Wireframe command table declares only grammar-valid keys, disjoint from the shipped 14', () => {
    const keys = keysOf(WIREFRAME_FEATURE);

    // Every value is inside the grammar: one step, or a two-step `a+b`.
    for (const key of keys) expect(key).toMatch(new RegExp(`^${VALUE}$`));
    // No duplicate full serialization inside the feature (relaxed rule, part 1).
    expect(new Set(keys).size).toBe(keys.length);
    // No strict-prefix shadowing inside the feature (relaxed rule, part 2) — a
    // bare binding may never shadow a sequence on its key.
    expect(strictPrefixPairs(keys)).toEqual([]);
    // The feature's FIRST steps are disjoint from the 14 shipped keys.
    for (const key of keys) expect(ALL_KEYS).not.toContain(firstStepOf(key));
  });

  it('the union across every feature obeys the relaxed duplicate rule and stays inside the 36-slot budget', () => {
    const all: string[] = [];
    for (const feature of FEATURES) all.push(...keysOf(feature));

    // Relaxed rule, part 1: no two bindings share a full serialization.
    expect(new Set(all).size).toBe(all.length);
    // Relaxed rule, part 2: no binding's serialization is a strict prefix of another's.
    expect(strictPrefixPairs(all)).toEqual([]);
    // The first-step budget is `[a-z0-9]` = 36 slots. A shared first step is
    // legal, but the number of DISTINCT first steps never exceeds the budget,
    // and every first step is a valid lowercase alphanumeric.
    const firstSteps = new Set(all.map(firstStepOf));
    expect(firstSteps.size).toBeLessThanOrEqual(36);
    for (const step of firstSteps) expect(step).toMatch(/^[a-z0-9]$/);
  });
});
