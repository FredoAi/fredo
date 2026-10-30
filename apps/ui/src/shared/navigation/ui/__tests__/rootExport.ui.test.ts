/**
 * Spec #3118 (P4), ST-7 — the navigation UI public surface (QA Q9-01 / Q9-02, N-03).
 *
 * ST-1…ST-6 shipped the eleven UI modules; this suite proves they are importable by P5
 * through the ONE additive root line (`apps/ui/src/index.ts` →
 * `export * from './shared/navigation/ui';`) without widening the headless barrel and
 * without a name collision:
 *
 *   1. EVERY runtime symbol of EVERY UI module is reachable from `@/index` and resolves to
 *      the SAME binding as its direct module import — an ambiguous `export *` would make a
 *      name `undefined` (or tsconfig-ambiguous) and fail here;
 *   2. the type-only module (`types.ts`) is re-exported by the barrel source and every one of
 *      its names is imported `type`-only from `@/index` (a missing type fails `tsc`);
 *   3. `Keycap` still refers to the LEGACY shared component while the navigation keycap is
 *      `NavKeycap` — proven by identity AND by rendering each to its distinct test id;
 *   4. nothing from `app/dev/` is root-exported and the root/UI barrels never name the DEV
 *      route literal (R-8.2 / Q8-02).
 *
 * Shipped tooling only: vitest + jsdom + `@testing-library/react`. No new dependency (N-03).
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import * as rootSurface from '@/index';
import * as uiBarrel from '@/shared/navigation/ui';
import * as constants from '@/shared/navigation/ui/constants';
import * as format from '@/shared/navigation/ui/format';
import * as models from '@/shared/navigation/ui/models';
import * as useReducedMotion from '@/shared/navigation/ui/useReducedMotion';
import * as keycapModule from '@/shared/navigation/ui/Keycap';
import * as commandRailModule from '@/shared/navigation/ui/CommandRail';
import * as navigationMapModule from '@/shared/navigation/ui/NavigationMap';
import * as activityTrailModule from '@/shared/navigation/ui/ActivityTrail';
import * as announceModule from '@/shared/navigation/ui/announce';
import * as hostModule from '@/shared/navigation/ui/host';
import { Keycap as LegacyKeycap } from '@/shared/components/hotkeys/Keycap';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

// TYPE-only half of the surface — every name below MUST be exported by `@/index`. A missing
// export makes `tsc` fail on these annotations, so the type surface cannot silently shrink.
import type {
  ActivityTrailEntry,
  ActivityTrailModel,
  AnnouncementChannel,
  CommandRailModel,
  CommandRailRow,
  NavAffordance,
  NavigationHost,
  NavigationHostOptions,
  NavigationHostSnapshot,
  NavigationMapKey,
  NavigationMapModel,
  NavigationMapPlace,
  NavigationMapVerb,
  NavPlaceRef,
  NavRiskCue,
} from '@/index';

/** Compile-time reachability pin for the type-only exports (never executed). */
type UiTypeSurface = {
  readonly placeRef: NavPlaceRef;
  readonly riskCue: NavRiskCue;
  readonly row: CommandRailRow;
  readonly affordance: NavAffordance;
  readonly rail: CommandRailModel;
  readonly mapVerb: NavigationMapVerb;
  readonly mapKey: NavigationMapKey;
  readonly mapPlace: NavigationMapPlace;
  readonly map: NavigationMapModel;
  readonly trailEntry: ActivityTrailEntry;
  readonly trail: ActivityTrailModel;
  readonly channel: AnnouncementChannel;
  readonly hostOptions: NavigationHostOptions;
  readonly hostSnapshot: NavigationHostSnapshot;
  readonly host: NavigationHost;
};

/** Module → its exported namespace (used for the exhaustive reachability sweep). */
const UI_MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['constants', constants as unknown as Record<string, unknown>],
  ['format', format as unknown as Record<string, unknown>],
  ['models', models as unknown as Record<string, unknown>],
  ['useReducedMotion', useReducedMotion as unknown as Record<string, unknown>],
  ['Keycap', keycapModule as unknown as Record<string, unknown>],
  ['CommandRail', commandRailModule as unknown as Record<string, unknown>],
  ['NavigationMap', navigationMapModule as unknown as Record<string, unknown>],
  ['ActivityTrail', activityTrailModule as unknown as Record<string, unknown>],
  ['announce', announceModule as unknown as Record<string, unknown>],
  ['host', hostModule as unknown as Record<string, unknown>],
];

/** The eleven UI modules the barrel must re-export (source contract). */
const UI_MODULE_FILES = [
  'constants',
  'types',
  'format',
  'models',
  'useReducedMotion',
  'Keycap',
  'CommandRail',
  'NavigationMap',
  'ActivityTrail',
  'announce',
  'host',
] as const;

const UI_ROOT = process.cwd(); // vitest runs with cwd = apps/ui
const ROOT_INDEX_SOURCE = resolve(UI_ROOT, 'src/index.ts');
const UI_BARREL_SOURCE = resolve(UI_ROOT, 'src/shared/navigation/ui/index.ts');
const DEV_DIR = resolve(UI_ROOT, 'src/app/dev');

afterEach(() => {
  cleanup();
});

describe('UI barrel + root export — every public symbol is reachable (Q9-01 / Q9-02)', () => {
  it('re-exports EVERY runtime symbol of EVERY UI module from @/index (same binding)', () => {
    // Non-vacuity first: the sweep must actually see the constants block and all components.
    expect(Object.keys(constants).length).toBeGreaterThanOrEqual(60);
    expect(Object.keys(keycapModule)).toContain('NavKeycap');
    expect(Object.keys(commandRailModule)).toContain('CommandRail');
    expect(Object.keys(navigationMapModule)).toContain('NavigationMap');
    expect(Object.keys(activityTrailModule)).toContain('ActivityTrail');
    expect(Object.keys(announceModule)).toContain('NavigationAnnouncer');
    expect(Object.keys(hostModule)).toContain('createNavigationHost');

    let checked = 0;
    for (const [label, namespace] of UI_MODULES) {
      const names = Object.keys(namespace);
      expect(names.length, `${label} must export at least one runtime symbol`).toBeGreaterThan(0);
      for (const name of names) {
        const value = namespace[name];
        expect(rootSurface, `@/index is missing ${label}.${name}`).toHaveProperty(name);
        expect(
          (rootSurface as unknown as Record<string, unknown>)[name],
          `@/index.${name} must be the SAME binding as ${label}.${name}`,
        ).toBe(value);
        checked += 1;
      }
    }

    // The whole value surface was walked (constants alone are 70+; all modules total far more).
    expect(checked).toBeGreaterThan(80);
  });

  it('has no undefined binding on the UI barrel (no ambiguous star export dropped a name)', () => {
    const barrel = uiBarrel as unknown as Record<string, unknown>;
    const names = Object.keys(barrel);
    expect(names.length).toBeGreaterThan(80);
    for (const name of names) {
      expect(barrel[name], `ui barrel export "${name}" is undefined`).toBeDefined();
    }
  });

  it('re-exports the type-only module from the barrel source (source contract)', () => {
    // Comments are stripped: the barrel's doc comment legitimately names the boundaries it
    // keeps OUT of the surface (`__tests__`, `app/dev`) — prose is not an export.
    const barrel = stripComments(readFileSync(UI_BARREL_SOURCE, 'utf8'));
    for (const file of UI_MODULE_FILES) {
      expect(barrel, `barrel must re-export ./${file}`).toContain(`from './${file}'`);
    }
    expect(barrel).not.toContain('__tests__');
    expect(barrel).not.toContain('app/dev');
  });

  it('keeps the root export additive — the headless barrel line is untouched', () => {
    const rootSource = readFileSync(ROOT_INDEX_SOURCE, 'utf8');
    expect(rootSource).toContain("export * from './shared/navigation';");
    expect(rootSource).toContain("export * from './shared/navigation/ui';");
  });
});

describe('Keycap vs NavKeycap — no collision with the legacy primitive', () => {
  it('keeps `Keycap` on the legacy component and `NavKeycap` on the navigation one', () => {
    expect(rootSurface.Keycap).toBe(LegacyKeycap);
    expect(rootSurface.NavKeycap).toBe(keycapModule.NavKeycap);
    expect(rootSurface.Keycap).not.toBe(rootSurface.NavKeycap);
    // The navigation UI barrel must NOT re-export the colliding legacy name.
    expect(uiBarrel).not.toHaveProperty('Keycap');
  });

  it('renders each keycap to its OWN test id (identity proven behaviourally)', () => {
    const legacy = renderWithChakra(
      React.createElement(LegacyKeycap, { sequence: 'primary+space' }),
    );
    expect(screen.getByTestId('hotkeys-keycap-group')).toBeInTheDocument();
    expect(screen.queryByTestId(constants.NAV_KEYCAP_GROUP_TESTID)).toBeNull();
    legacy.unmount();

    renderWithChakra(
      React.createElement(rootSurface.NavKeycap, { keys: ['c'] }),
    );
    expect(screen.getByTestId(constants.NAV_KEYCAP_GROUP_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(constants.NAV_KEYCAP_GROUP_TESTID)).toHaveAttribute(
      'data-nav-keycap',
      'true',
    );
    expect(screen.queryByTestId('hotkeys-keycap-group')).toBeNull();
  });
});

describe('root export — nothing from the DEV route leaks (R-8.2 / Q8-02)', () => {
  it('never names the DEV route in the root or UI barrel sources', () => {
    const sources = [ROOT_INDEX_SOURCE, UI_BARREL_SOURCE].map((file) =>
      stripComments(readFileSync(file, 'utf8')),
    );
    for (const source of sources) {
      expect(source).not.toContain('app/dev');
      expect(source).not.toContain('NavigationPreview');
      expect(source).not.toContain('navigationDemoSurface');
      expect(source).not.toContain('navigation-preview');
    }
  });

  it('does not expose any name exported by the DEV prototype modules', () => {
    const devNames = devExportedNames();
    // Non-vacuity: the dev modules DO export names (the sweep is not scanning an empty set).
    expect(devNames.length).toBeGreaterThanOrEqual(6);
    expect(devNames).toContain('NavigationPreview');
    expect(devNames).toContain('NAVIGATION_DEMO_SURFACE');

    for (const name of devNames) {
      expect(rootSurface, `@/index must not export the dev-only "${name}"`).not.toHaveProperty(name);
    }
  });
});

/** Strip comments so prose in a dev module cannot seed a false export name. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every exported identifier of the two DEV prototype modules (read from source). */
function devExportedNames(): string[] {
  const files = ['NavigationPreview.tsx', 'navigationDemoSurface.ts'];
  const found: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(resolve(DEV_DIR, file), 'utf8'));
    const matches = source.matchAll(
      /\bexport\s+(?:default\s+)?(?:const|function|interface|type|class)\s+([A-Za-z0-9_$]+)/g,
    );
    for (const match of matches) {
      const name = match[1];
      if (name !== undefined && !found.includes(name)) found.push(name);
    }
  }
  return found;
}
