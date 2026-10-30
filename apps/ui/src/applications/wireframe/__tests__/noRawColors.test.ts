/**
 * Wireframe raw-colour regression pin (Spec #3081, ST-1, AC2).
 *
 * The shipped `contrast:gate` scanner (`rawColorScan.ts`) detects hex /
 * `rgb(`/`rgba(`/`hsl(`/`hsla(` / `var(--x)NN` literals — it does NOT detect
 * BARE NAMED colours such as `color="white"` (a legal CSS keyword, not a
 * functional/hex literal). This suite is the wireframe-scoped pin for that
 * blind spot: it scans the Wireframe SOURCE tree only and fails on any bare
 * named-colour JSX prop, so the `color="white"` regression the spec fixes
 * cannot silently return.
 *
 * The oracle is the real source tree (`import.meta.glob`), not a fixture:
 * assertion 1 reuses the canonical exported `scanRawColors` detector;
 * assertion 2 adds the named-colour seam with a synthetic negative self-test
 * proving the matcher is not vacuous.
 */

import { describe, expect, it } from 'vitest';

import { scanRawColors } from '@/app/theme/contrast/rawColorScan';

/**
 * Every Wireframe source file as raw text. The glob mirrors the shipped
 * scanner's tree-scan (`rawColorScan.defaultScanTargets`), scoped to the
 * Wireframe application.
 */
const RAW_MODULES = import.meta.glob('/src/applications/wireframe/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Test/spec and declaration files are not "feature components" (AC2). */
const NON_SOURCE = /(?:^|\/)(?:__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx)$/;

/** The Wireframe SOURCE tree (tests, mocks and `.d.ts` dropped). */
const SOURCE_TARGETS: Array<{ path: string; source: string }> = Object.entries(RAW_MODULES)
  .filter(([key]) => !NON_SOURCE.test(key) && !key.endsWith('.d.ts'))
  .map(([path, source]) => ({ path, source }));

/**
 * Strip block comments and line comments — the SAME rule as the shipped
 * scanner (`rawColorScan.ts`'s private `stripComments`): `//` preceded by `:`
 * is preserved so a URL inside a string is not mistaken for a comment. Inlined
 * here rather than exported, so the global scanner is not widened (out of
 * scope for this slice).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * A colour-bearing JSX prop assigned a BARE named colour. The value
 * char-class `[A-Za-z][\w-]*` cannot match a dotted token (`status.error`), a
 * `var(--x)`, a hex/rgb/hsl literal, or a `{…}` expression; the lookbehind
 * stops `data-color="…"`.
 */
const NAMED_COLOR_PROP =
  /(?<![\w-])(?:color|bg|backgroundColor|borderColor|borderTopColor|borderRightColor|borderBottomColor|borderLeftColor|fill|stroke)\s*=\s*["']([A-Za-z][\w-]*)["']/g;

/** The only allowed colour literals (`docs/ENGINEERING_RULES.md`). */
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

/** Every bare named-colour prop value in `source` that is NOT an allowed keyword. */
function namedColorViolations(source: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  for (const match of code.matchAll(NAMED_COLOR_PROP)) {
    const value = match[1];
    if (!ALLOWED_COLOR_KEYWORDS.has(value.toLowerCase())) violations.push(value);
  }
  return violations;
}

describe('Wireframe raw-colour sweep (AC2)', () => {
  it('scans a non-empty Wireframe source tree', () => {
    expect(SOURCE_TARGETS.length).toBeGreaterThan(0);
    expect(SOURCE_TARGETS.some((t) => t.path.endsWith('WireframeEditor.tsx'))).toBe(true);
  });

  it('has zero raw-colour literals via the canonical scanner (hex / rgb / hsl / var-alpha)', () => {
    expect(scanRawColors(SOURCE_TARGETS)).toEqual([]);
  });

  it('has zero bare named-colour JSX props across the Wireframe source tree', () => {
    const violations = SOURCE_TARGETS.flatMap(({ path, source }) =>
      namedColorViolations(source).map((value) => `${path}: ${value}`),
    );
    expect(violations).toEqual([]);
  });
});

describe('named-colour matcher is not vacuous (negative self-test)', () => {
  it('flags a bare named colour (`color="white"`) in a synthetic fixture', () => {
    expect(namedColorViolations('<Button color="white">Discard</Button>')).toEqual(['white']);
  });

  it('flags a named colour behind a non-prop attribute prefix', () => {
    expect(namedColorViolations('<Box bg="red" />')).toEqual(['red']);
  });

  it('does NOT flag tokens, vars, hex, functions, expressions, or allowed keywords', () => {
    const clean = [
      '<Button color="status.onSolids" bg="status.error" />',
      '<Box bg="var(--card-bg)" />',
      '<Box color="#fff" />',
      '<Box color="rgb(0, 0, 0)" />',
      '<Box color={token} />',
      '<Box color="transparent" />',
      '<Box fill="none" stroke="currentColor" />',
      '<Box data-color="white" />',
      '{/* a prose mention of color="white" in a comment must not trip the scan */}',
    ].join('\n');
    expect(namedColorViolations(clean)).toEqual([]);
  });
});
