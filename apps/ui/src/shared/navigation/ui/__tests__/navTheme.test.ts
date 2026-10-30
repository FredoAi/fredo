/**
 * Spec #3118 (P4), ST-1 — the AC5 / R-5.2 mirrored colour sweep (QA Q5-02).
 *
 * The shipped `contrast:gate` scanner's `defaultScanTargets()` globs `/src/applications/**`
 * plus `app/theme/system.ts` only — it does NOT scan `shared/` (widening it is a NAMED
 * follow-up, G-406, declined for this slice). This suite is therefore the binding proof: it
 * runs the CANONICAL `scanRawColors` detector over explicit `src/shared/navigation/ui/**`
 * targets, so a new raw colour in the navigation surfaces cannot ship undetected.
 *
 * Non-vacuity is asserted first (the glob finds real files, including the view-model layer).
 * The wave-2 components (`Keycap.tsx`, `CommandRail.tsx`, `NavigationMap.tsx`,
 * `ActivityTrail.tsx`) are picked up by the SAME glob as soon as they land — no test edit is
 * needed and none is permitted to widen or narrow the sweep.
 *
 * `app/theme/contract/tokens.ts` is deliberately NOT touched: this slice adds no token and no
 * `CONTRACT_PAIRS` row.
 */

import { describe, expect, it } from 'vitest';

import { scanRawColors } from '@/app/theme/contrast/rawColorScan';
import { tint } from '@/shared/utils/colorTint';

/** Every navigation-UI source file as raw text (the real tree, not a fixture). */
const RAW_MODULES = import.meta.glob('/src/shared/navigation/ui/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Test/spec and declaration files are not shipped surface sources. */
const NON_SOURCE = /(?:^|\/)(?:__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx)$/;

const SOURCE_TARGETS: Array<{ path: string; source: string }> = Object.entries(RAW_MODULES)
  .filter(([key]) => !NON_SOURCE.test(key) && !key.endsWith('.d.ts'))
  .map(([path, source]) => ({ path, source }));

/**
 * Strip comments exactly as the shipped scanner does (so prose cannot mask or satisfy a
 * colour scan). Inlined rather than importing a private helper.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * A colour-bearing JSX prop assigned a BARE named colour (the wireframe matcher,
 * `applications/wireframe/__tests__/noRawColors.test.ts:60-84`). The value char-class cannot
 * match a dotted token, a `var(--x)`, a hex/rgb/hsl literal or a `{…}` expression.
 */
const NAMED_COLOR_PROP =
  /(?<![\w-])(?:color|bg|backgroundColor|borderColor|borderTopColor|borderRightColor|borderBottomColor|borderLeftColor|fill|stroke)\s*=\s*["']([A-Za-z][\w-]*)["']/g;

const ALLOWED_COLOR_KEYWORDS = new Set([
  'transparent',
  'inherit',
  'currentcolor',
  'none',
  'unset',
  'initial',
  'revert',
  'revert-layer',
]);

function namedColorViolations(source: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  for (const match of code.matchAll(NAMED_COLOR_PROP)) {
    const value = match[1];
    if (!ALLOWED_COLOR_KEYWORDS.has(value.toLowerCase())) violations.push(value);
  }
  return violations;
}

/** `var(--x)NN` — an invalid CSS alpha-append (#2770). */
const VAR_ALPHA_APPEND = /var\(--[a-z0-9-]+\)[0-9]/;

describe('navigation UI tree is non-vacuous (Q5-02 pre-condition)', () => {
  it('scans real source files, never tests', () => {
    expect(SOURCE_TARGETS.length).toBeGreaterThan(0);
    const paths = SOURCE_TARGETS.map((target) => target.path);
    for (const required of [
      'constants.ts',
      'types.ts',
      'format.ts',
      'models.ts',
      'useReducedMotion.ts',
    ]) {
      expect(paths.some((path) => path.endsWith(required))).toBe(true);
    }
    expect(paths.some((path) => path.includes('__tests__'))).toBe(false);
  });
});

describe('navigation UI raw-colour sweep (R-5.2 / Q5-02)', () => {
  it('has zero raw-colour literals via the canonical scanner', () => {
    expect(scanRawColors(SOURCE_TARGETS)).toEqual([]);
  });

  it('has zero var(--x)NN alpha-appends', () => {
    const offenders = SOURCE_TARGETS.filter(({ source }) =>
      VAR_ALPHA_APPEND.test(stripComments(source)),
    ).map((target) => target.path);
    expect(offenders).toEqual([]);
  });

  it('has zero bare named-colour JSX props', () => {
    const violations = SOURCE_TARGETS.flatMap(({ path, source }) =>
      namedColorViolations(source).map((value) => `${path}: ${value}`),
    );
    expect(violations).toEqual([]);
  });
});

describe('the sweep is not vacuous (negative self-tests)', () => {
  it('the canonical scanner flags a raw colour and an alpha-append', () => {
    const hits = scanRawColors([
      { path: 'apps/ui/src/shared/navigation/ui/synthetic.tsx', source: 'const c = "#fff";' },
      {
        path: 'apps/ui/src/shared/navigation/ui/synthetic.tsx',
        source: 'const c = "var(--accent-primary)22";',
      },
    ]);
    expect(hits.map((hit) => hit.kind).sort()).toEqual(['hex', 'var-alpha-append']);
  });

  it('the named-colour matcher flags a bare colour and ignores tokens/vars/keywords', () => {
    expect(namedColorViolations('<Box color="white" />')).toEqual(['white']);
    const clean = [
      '<Box color="status.onSolids" bg="status.error" />',
      '<Box bg="var(--card-bg)" />',
      '<Box color="transparent" fill="none" stroke="currentColor" />',
      '<Box color={token} />',
    ].join('\n');
    expect(namedColorViolations(clean)).toEqual([]);
  });
});

describe('the sanctioned tint mechanism is available to the surfaces', () => {
  it('the shared tint helper composes color-mix from a var reference', () => {
    expect(tint('var(--accent-primary)', 22)).toBe(
      'color-mix(in srgb, var(--accent-primary) 22%, transparent)',
    );
  });
});
