/**
 * Spec #3009 (adjudication A7) — the migrated `data-hotkey` values are GLOBALLY
 * disjoint across the five features.
 *
 * #3009 aggregates every mounted `data-hotkey` element app-wide and treats a
 * duplicate key as a build/dev error. This STATIC source pin reads the five
 * feature components, extracts each declared key (static attributes + the My
 * Work Items source-tab ternary), and proves:
 *   - every feature declares EXACTLY its assigned keys, and
 *   - the union over all five features is the 14-key set with NO duplicate.
 *
 * Mission Monitor `n`/`p` (no mounted control) and Diagram `f` (no fit control)
 * are intentionally absent — no UI is invented for them.
 *
 * Spec #3070 (ST-3) adds the Wireframe toolbar. Its 22 bindings are declared in
 * the ONE command table (`actions/wireframeActions.ts`) and mounted as
 * `data-hotkey` from that table, so the table — not the component markup — is
 * the authoritative declaration. The 14 shipped keys plus the Wireframe 22
 * exhaust the 36 lowercase alphanumerics with no duplicate.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Strip comments so doc prose cannot satisfy a key scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readSource(relativePath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
}

/** Extract every declared key: static `data-hotkey="x"` + ternary blocks `data-hotkey={…}`. */
function extractKeys(source: string): string[] {
  const keys: string[] = [];

  for (const match of source.matchAll(/data-hotkey="([a-z0-9])"/g)) {
    keys.push(match[1]);
  }

  // A dynamic attribute holds only single-char literals as keys; multi-char
  // literals (e.g. `'application-data'`) are branch values, never keys.
  for (const block of source.matchAll(/data-hotkey=\{([\s\S]*?)\}/g)) {
    for (const literal of block[1].matchAll(/'([a-z0-9])'/g)) {
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
  for (const match of source.matchAll(/\bhotkey:\s*'([a-z0-9])'/g)) {
    keys.push(match[1]);
  }
  return keys;
}

interface FeatureKeys {
  readonly file: string;
  readonly expected: readonly string[];
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

/** Wireframe (Spec #3070) — the 22 bindings declared by the command table. */
const WIREFRAME_FEATURE: FeatureKeys = {
  file: 'src/applications/wireframe/actions/wireframeActions.ts',
  expected: [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'p',
    'k',
    'l',
    'u',
    'y',
    'g',
    'm',
    'n',
    '0',
    'h',
    'w',
    'o',
    't',
  ],
  extract: extractActionTableKeys,
};

const FEATURES: readonly FeatureKeys[] = [...SHIPPED_FEATURES, WIREFRAME_FEATURE];

/** The A7 assignment: 14 controls, 14 distinct keys. */
const ALL_KEYS = ['s', 'd', 'r', 'a', 'z', 'j', 'f', 'q', 'e', 'c', 'i', 'x', 'b', 'v'];

/** Wireframe's 22 keys (single-step `[a-z0-9]`). */
const WIREFRAME_KEYS = WIREFRAME_FEATURE.expected;

function keysOf(feature: FeatureKeys): string[] {
  const source = readSource(feature.file);
  return (feature.extract ?? extractKeys)(source);
}

describe('A7 — globally disjoint data-hotkey assignment', () => {
  it('every feature declares exactly its assigned keys', () => {
    for (const feature of FEATURES) {
      expect([...keysOf(feature)].sort(), feature.file).toEqual([...feature.expected].sort());
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

  it('the Wireframe command table declares 22 single-step keys, disjoint from the shipped 14', () => {
    const keys = keysOf(WIREFRAME_FEATURE);

    expect([...keys].sort(), WIREFRAME_FEATURE.file).toEqual([...WIREFRAME_KEYS].sort());
    // Single-step `[a-z0-9]` only (no modifier chords, no sequences).
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]$/);
    // No duplicate inside the feature.
    expect(new Set(keys).size).toBe(keys.length);
    // Disjoint from the 14 shipped keys.
    for (const key of keys) expect(ALL_KEYS).not.toContain(key);
  });

  it('the union across every feature is 36 distinct alphanumerics with no duplicate', () => {
    const all: string[] = [];
    for (const feature of FEATURES) all.push(...keysOf(feature));

    expect(all).toHaveLength(36);
    expect(new Set(all).size).toBe(36);
    expect([...all].sort()).toEqual([...ALL_KEYS, ...WIREFRAME_KEYS].sort());
  });
});
