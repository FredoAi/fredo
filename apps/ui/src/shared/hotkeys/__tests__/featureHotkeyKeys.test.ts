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

interface FeatureKeys {
  readonly file: string;
  readonly expected: readonly string[];
}

const FEATURES: readonly FeatureKeys[] = [
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

/** The A7 assignment: 14 controls, 14 distinct keys. */
const ALL_KEYS = ['s', 'd', 'r', 'a', 'z', 'j', 'f', 'q', 'e', 'c', 'i', 'x', 'b', 'v'];

describe('A7 — globally disjoint data-hotkey assignment', () => {
  it('every feature declares exactly its assigned keys', () => {
    for (const feature of FEATURES) {
      const keys = extractKeys(readSource(feature.file));
      expect([...keys].sort(), feature.file).toEqual([...feature.expected].sort());
    }
  });

  it('the union over all five features is the 14-key set with no duplicate', () => {
    const all: string[] = [];
    for (const feature of FEATURES) all.push(...extractKeys(readSource(feature.file)));

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
});
