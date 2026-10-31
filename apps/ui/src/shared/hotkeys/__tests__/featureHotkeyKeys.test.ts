/**
 * Spec #3121 (P7), ST-6 — the five-surface legacy sweep + the remaining inventory (QA R-14 /
 * F-14, AC7). Test-only rewrites are authorised by AC7 (E-1): NOTHING under `shared/hotkeys/`
 * is deleted or changed at runtime — `HotkeyBar`, `Keycap`, `commandSurfaceStore`, discovery
 * and the element-key engine must survive until #3122.
 *
 * WHAT THIS PIN NOW ASSERTS (the five-surface truth):
 *
 *   1. The FIVE migrated surface paths contain ZERO literal element-key attributes:
 *        applications/terminal/**, applications/mission-monitor/**,
 *        applications/database-client/**, applications/dev-mode/**,
 *        shared/hotkeys/traversal.ts, shared/window-system/**
 *      Source, comments AND tests are scanned (the AC counts comments, so the scan never
 *      strips them).
 *   2. The frozen deprecated apps are the ONLY remaining application inventory: the exact
 *      7 sites / 9 element keys of `diagram`, `optimizely` and `my-workitems` are enumerated
 *      here and deliberately NOT removed (D-7: #3122 deletes them with the legacy runtime).
 *      The count is RE-DERIVED from source (G-316/G-404): an earlier plan draft's "8 keys" was
 *      an arithmetic slip; the corrected inventory is 9 (the old 14-key union minus this spec's
 *      5 migrated keys).
 *   3. Every remaining literal under `src/` is on the explicit allowlist — the frozen apps,
 *      wireframe's P5 tests/comment (not migrated, not in #3122's deletion list), the
 *      `shared/hotkeys/**` legacy machinery/tests, and three comment-only mentions.
 *
 * NON-VACUITY: each scanned root exists and contains files; a `data-testid` scan proves the
 * app roots are real source; the scanner control matches a CONSTRUCTED attribute name; and the
 * legacy machinery is asserted still present. A scanner that silently reads nothing fails.
 *
 * `data-Hotkey` is outside the literal AC (the literal is case-sensitive) — stated, not assumed.
 *
 * Spec #3070/#3071's Wireframe command-table / first-step-budget pins are retained below as a
 * separate, still-valid invariant (the Wireframe toolbar is table-driven and out of P7 scope).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/* ───────────────────────────── scanner primitives ───────────────────────────── */

/** The legacy attribute literal, CONSTRUCTED so this scanner is not its own false positive. */
const LEGACY_ATTR = ['data', 'hotkey'].join('-');

/** The source root this suite runs against (`apps/ui` is vitest's cwd). */
const SRC_ROOT = resolve(process.cwd(), 'src');

/** Text extensions only — the five app trees contain no other textual source. */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.md']);

function normalise(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/');
}

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return TEXT_EXTENSIONS.has(extnameOf(path)) ? [path] : [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => walk(join(path, entry.name)))
    .filter((file) => TEXT_EXTENSIONS.has(extnameOf(file)));
}

function extnameOf(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** True when the text carries the literal legacy attribute name (case-sensitive). */
function containsLegacyAttribute(text: string): boolean {
  return text.includes(LEGACY_ATTR);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The complete text-file set under a path (file or directory). */
function filesUnder(relativePath: string): string[] {
  return walk(resolve(process.cwd(), relativePath));
}

/* ───────────────────────────── the five in-scope paths (R-14 / E-2) ───────────────────────────── */

const FIVE_SCOPE_PATHS = [
  'src/applications/terminal',
  'src/applications/mission-monitor',
  'src/applications/database-client',
  'src/applications/dev-mode',
  'src/shared/hotkeys/traversal.ts',
  'src/shared/window-system',
] as const;

/** The four application roots + the window-system root (the traversal file is a file). */
const SCANNED_ROOTS = [
  'src/applications/terminal',
  'src/applications/mission-monitor',
  'src/applications/database-client',
  'src/applications/dev-mode',
  'src/shared/window-system',
] as const;

const FIVE_SCOPE_FILES = FIVE_SCOPE_PATHS.flatMap((path) => filesUnder(path));

/* ───────────────────────────── the frozen inventory (D-7 — untouched by P7) ───────────────────────────── */

/**
 * The exact remaining `data-hotkey` inventory in the FROZEN deprecated apps. `sites` counts
 * attribute declarations; `keys` are the element keys those sites bind. Kept for #3122.
 *
 * RE-DERIVED (G-316/G-404 — not inherited): an earlier plan draft said "7 sites / 8 keys",
 * corrected to 9, and the source confirms `diagram 1/1 + optimizely 4/4 + my-workitems 2/4 =
 * 7 sites / 9 keys`. The old pin's 14-key union minus this spec's 5 migrated keys is exactly 9;
 * this test asserts the source truth (7 sites / 9 element keys).
 */
const FROZEN_INVENTORY: readonly {
  readonly file: string;
  readonly sites: number;
  readonly keys: readonly string[];
}[] = [
  {
    file: 'src/applications/diagram/components/ArchitectureDiagram.tsx',
    sites: 1,
    keys: ['d'],
  },
  {
    file: 'src/applications/optimizely/components/OptimizelyFlagsPanel.tsx',
    sites: 4,
    keys: ['f', 'e', 'c', 'q'],
  },
  {
    file: 'src/applications/my-workitems/components/MyWorkItemsContainer.tsx',
    sites: 2,
    keys: ['r', 'a', 'z', 'j'],
  },
];

/**
 * Every remaining `src/` hit must be on this explicit allowlist (R-14 / E-2). The frozen apps
 * are enumerated above; wireframe keeps P5's own test/comment literals; `shared/hotkeys/**` is
 * the P8-owned legacy runtime; the three remainder hits are comments only.
 */
const ALLOWLISTED_PATHS: readonly string[] = [
  'src/index.ts',
  'src/applications/diagram/',
  'src/applications/optimizely/',
  'src/applications/my-workitems/',
  'src/applications/wireframe/__tests__/wireframeLegacySurface.test.ts',
  'src/applications/wireframe/__tests__/wireframeRailParity.test.tsx',
  'src/applications/wireframe/components/WireframePropertyPanel.tsx',
  'src/shared/hotkeys/',
  'src/shared/navigation/context.ts',
  'src/shared/classes/FredoApplicationClass.ts',
];

const FIVE_SCOPE_RELATIVE = new Set(FIVE_SCOPE_FILES.map(normalise));

function isAllowlisted(path: string): boolean {
  return ALLOWLISTED_PATHS.some((allowed) =>
    allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed,
  );
}

/* ───────────────────────────── element-key extraction (frozen inventory) ───────────────────────────── */

/** One grammar step or a two-step `a+b` value. */
const VALUE = '[a-z0-9](?:\\+[a-z0-9])?';

/** The element keys a source file declares (static attributes + ternary blocks). */
function extractKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(new RegExp(`${LEGACY_ATTR}="(${VALUE})"`, 'g'))) {
    keys.push(match[1]);
  }
  for (const block of source.matchAll(new RegExp(`${LEGACY_ATTR}=\\{([\\s\\S]*?)\\}`, 'g'))) {
    for (const literal of block[1].matchAll(new RegExp(`'(${VALUE})'`, 'g'))) {
      keys.push(literal[1]);
    }
  }
  return keys;
}

/* ───────────────────────────── R-14 — the five-surface zero-hit scan ───────────────────────────── */

describe('R-14 — the five migrated surfaces carry zero legacy element-key attributes', () => {
  it('scans a non-empty source set (each root exists and contains files)', () => {
    for (const root of SCANNED_ROOTS) {
      expect(filesUnder(root).length, root).toBeGreaterThan(0);
    }
    expect(FIVE_SCOPE_FILES.length).toBeGreaterThan(20);
  });

  it('finds ZERO literal hits in the five in-scope paths (source, comments and tests)', () => {
    const hits = FIVE_SCOPE_FILES.filter((file) => containsLegacyAttribute(readText(file)));
    expect(hits.map(normalise)).toEqual([]);
  });

  it('the scanned app roots are real source (a data-testid scan returns > 0)', () => {
    for (const root of SCANNED_ROOTS) {
      const filesWithTestids = filesUnder(root).filter((file) =>
        readText(file).includes('data-testid'),
      );
      expect(filesWithTestids.length, root).toBeGreaterThan(0);
    }
  });

  it('the scanner control fires on a constructed attribute name (non-vacuous)', () => {
    expect(containsLegacyAttribute(`<button ${LEGACY_ATTR}="x" />`)).toBe(true);
    expect(containsLegacyAttribute('<button data-testid="x" />')).toBe(false);
  });
});

/* ───────────────────────────── the frozen inventory is enumerated, not deleted ───────────────────────────── */

describe('the frozen deprecated inventory (7 sites / 9 keys) remains until #3122', () => {
  it('enumerates each frozen file with its exact site and key count', () => {
    for (const entry of FROZEN_INVENTORY) {
      const source = readText(resolve(process.cwd(), entry.file));
      expect(occurrences(source, `${LEGACY_ATTR}=`), entry.file).toBe(entry.sites);
      expect([...extractKeys(source)].sort(), entry.file).toEqual([...entry.keys].sort());
    }
  });

  it('the frozen union is exactly 7 sites / 9 distinct keys (re-derived)', () => {
    const sources = FROZEN_INVENTORY.map((entry) => readText(resolve(process.cwd(), entry.file)));
    const sites = sources.reduce((count, source) => count + occurrences(source, `${LEGACY_ATTR}=`), 0);
    const keys = FROZEN_INVENTORY.flatMap((entry) => entry.keys);

    expect(sites).toBe(7);
    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(9);
    expect([...keys].sort()).toEqual(['a', 'c', 'd', 'e', 'f', 'j', 'q', 'r', 'z'].sort());
  });

  it('the extractor control fires on a constructed ternary block (non-vacuous)', () => {
    const sample = `<button ${LEGACY_ATTR}={ tab === 'all' ? 'a' : 'z' } />`;
    expect(extractKeys(sample).sort()).toEqual(['a', 'z']);
  });

  it('every remaining src/ hit is on the explicit allowlist (no unlisted path)', () => {
    const outsideFive = walk(SRC_ROOT).filter((file) => !FIVE_SCOPE_RELATIVE.has(normalise(file)));
    const hits = outsideFive
      .filter((file) => containsLegacyAttribute(readText(file)))
      .map(normalise);
    const unlisted = hits.filter((path) => !isAllowlisted(path));

    expect(unlisted).toEqual([]);
    // Non-vacuity: the legacy machinery and the frozen apps are still the remaining hits.
    expect(hits).toContain('src/shared/hotkeys/hotkeyElements.ts');
    expect(hits).toContain('src/applications/diagram/components/ArchitectureDiagram.tsx');
    expect(hits).toContain('src/applications/optimizely/components/OptimizelyFlagsPanel.tsx');
    expect(hits).toContain('src/applications/my-workitems/components/MyWorkItemsContainer.tsx');
  });

  it('leaves the P8-owned legacy runtime in place (no silent deletion)', () => {
    for (const file of [
      'src/shared/hotkeys/hotkeyElements.ts',
      'src/shared/hotkeys/HotkeyBar.tsx',
      'src/shared/hotkeys/commandSurfaceStore.ts',
      'src/shared/hotkeys/engine.ts',
    ]) {
      expect(existsSync(resolve(process.cwd(), file)), file).toBe(true);
    }
  });
});

/* ───────────────────────────── retained Wireframe coverage (non-vacuous) ───────────────────────────── */

/**
 * Spec #3070/#3071's old assertion pinned the Wireframe command table's `hotkey:` fields. P5
 * (#3119) retired those fields — keyboard resolution is now owned by the Wireframe navigation
 * surface — so pinning a key table here would be vacuous. This replacement keeps a REAL,
 * non-vacuous assertion: the command table still exists (>20 actions), carries NO element-key
 * declaration, and the scanner control proves an element key would be detected.
 */
const WIREFRAME_ACTION_TABLE = 'src/applications/wireframe/actions/wireframeActions.ts';

function extractActionTableKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(new RegExp(`\\bhotkey:\\s*'(${VALUE})'`, 'g'))) {
    keys.push(match[1]);
  }
  return keys;
}

describe('Wireframe command table — no element-key declaration (P5 retired the key table)', () => {
  it('has a real action table and declares zero element-key fields', () => {
    const source = readText(resolve(process.cwd(), WIREFRAME_ACTION_TABLE));

    // Non-vacuity: the table is real.
    expect((source.match(/\bid:\s*'/g) ?? []).length).toBeGreaterThan(20);
    expect(extractActionTableKeys(source)).toEqual([]);
    expect(source.includes(LEGACY_ATTR)).toBe(false);

    // Scanner control: a constructed table row with an element key IS detected.
    expect(extractActionTableKeys(`{ id: 'x.y', hotkey: 'q' }`)).toEqual(['q']);
  });
});
