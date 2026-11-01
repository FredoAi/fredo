/**
 * Spec #3122 (P8), ST-5 — the U-3 successor to the deleted `themeHygiene.test.ts`.
 *
 * The retired suite was the ONLY automated guard that the keycap source obeys the theming
 * rule and that the polite live region exists only on the announcer. This suite carries the
 * same four checks over the SURVIVING navigation surface tree (`shared/navigation/ui/**`):
 *
 *   1. zero raw colour literals (hex / `rgb()` / `hsl()`) via the canonical scanner;
 *   2. zero `var(--x)NN` alpha-appends (the invalid CSS form from #2770);
 *   3. the `NavKeycap` chip still uses `tint()` + the semantic tokens of the UI/UX §2 recipe;
 *   4. `aria-live` appears in exactly ONE ship source (`announce.tsx`) — the ONE navigation
 *      live region, never a second one on a surface.
 *
 * Test-only source scan: no product hook, no new dependency, no DOM (G-324 does not apply).
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
  .map(([path, source]) => ({ path, source }))
  .sort((a, b) => a.path.localeCompare(b.path));

/** Strip comments exactly as the canonical scanner does (prose cannot mask/satisfy a scan). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const KEYCAP = SOURCE_TARGETS.find((target) => target.path.endsWith('/Keycap.tsx'));

/** The UI/UX §2 keycap recipe that must stay token-driven. */
const KEYCAP_RECIPE = [
  'tint(',
  'bg.subtle',
  'fg.default',
  'border.subtle',
  'fontFamily="mono"',
  'borderRadius="sm"',
] as const;

describe('keycapTokenHygiene — the navigation surface tree is non-vacuous', () => {
  it('scans real ship sources, never tests, and finds the keycap', () => {
    expect(SOURCE_TARGETS.length).toBeGreaterThan(0);
    expect(SOURCE_TARGETS.some((target) => target.path.includes('__tests__'))).toBe(false);
    expect(KEYCAP).toBeDefined();
    for (const required of ['Keycap.tsx', 'announce.tsx', 'CommandRail.tsx', 'NavigationMap.tsx']) {
      expect(
        SOURCE_TARGETS.some((target) => target.path.endsWith(`/${required}`)),
        required,
      ).toBe(true);
    }
  });
});

describe('keycapTokenHygiene — the theming rule (ENGINEERING_RULES / #2770)', () => {
  it('has zero raw colour literals (hex / rgb / hsl)', () => {
    expect(scanRawColors(SOURCE_TARGETS)).toEqual([]);
  });

  it('has zero var(--x)NN alpha-appends', () => {
    const offenders = SOURCE_TARGETS.filter(({ source }) =>
      /var\(--[a-z0-9-]+\)[0-9]/.test(stripComments(source)),
    ).map((target) => target.path);
    expect(offenders).toEqual([]);
  });

  it('the keycap chip uses tint() and the semantic tokens (UI/UX §2 recipe)', () => {
    expect(KEYCAP).toBeDefined();
    const code = stripComments(KEYCAP?.source ?? '');
    for (const token of KEYCAP_RECIPE) {
      expect(code, token).toContain(token);
    }
  });

  it('the canonical tint helper composes a live color-mix from a var reference', () => {
    expect(tint('var(--text-primary)', 22)).toBe(
      'color-mix(in srgb, var(--text-primary) 22%, transparent)',
    );
  });
});

describe('keycapTokenHygiene — aria-live only on the ONE announcer', () => {
  it('names exactly one ship source for the polite region: announce.tsx', () => {
    const withRegion = SOURCE_TARGETS.filter(({ source }) =>
      stripComments(source).includes('aria-live'),
    ).map((target) => target.path);
    expect(withRegion).toHaveLength(1);
    expect(withRegion[0]?.endsWith('/announce.tsx')).toBe(true);
  });

  it('no surface component declares its own live region', () => {
    const surfaces = SOURCE_TARGETS.filter(
      ({ path }) =>
        path.endsWith('/CommandRail.tsx') ||
        path.endsWith('/NavigationMap.tsx') ||
        path.endsWith('/ActivityTrail.tsx') ||
        path.endsWith('/Keycap.tsx'),
    );
    expect(surfaces.length).toBeGreaterThan(0);
    for (const surface of surfaces) {
      expect(stripComments(surface.source).includes('aria-live'), surface.path).toBe(false);
    }
  });
});

describe('keycapTokenHygiene — negative controls (the scan is real)', () => {
  it('flags a synthetic raw colour and a synthetic alpha-append', () => {
    const hits = scanRawColors([
      { path: 'apps/ui/src/shared/navigation/ui/synthetic.tsx', source: 'const c = "#fff";' },
      {
        path: 'apps/ui/src/shared/navigation/ui/synthetic.tsx',
        source: 'const c = "var(--accent-primary)22";',
      },
    ]);
    expect(hits.map((hit) => hit.kind).sort()).toEqual(['hex', 'var-alpha-append']);
  });

  it('the aria-live detector sees a real region and ignores a comment mention', () => {
    const file = (source: string) => ({ path: 'apps/ui/src/shared/navigation/ui/synthetic.tsx', source });
    expect(stripComments(file('<span aria-live="polite" />').source)).toContain('aria-live');
    expect(stripComments(file('// no aria-live here\nconst x = 1;').source)).not.toContain(
      'aria-live',
    );
  });
});
