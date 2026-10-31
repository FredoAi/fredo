/**
 * Companion manifest builder (Spec #3099, ST-2; navigation-only since Spec #3122 P8 ST-2).
 *
 * Pins:
 *   - purity (no DOM/IPC/clock in the builder source);
 *   - ONLY registered navigation surfaces publish (the legacy `commandSurface` projection
 *     is deleted);
 *   - declaration order, the `journal.undo` engine command before `listActions`;
 *   - a surface without a `companion` block publishes nothing;
 *   - duplicate registration is FIRST-WINS by appId;
 *   - every projected command carries all six fields (G-418);
 *   - the committed golden navigation projection deep-equals the builder.
 *
 * The fixture migration to `schemaVersion: 3` and the cross-app parity test are ST-3.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { wireframeSurface } from '@/applications/wireframe/wireframeSurface';
import { buildCompanionManifest as buildNavigationManifest } from '@/shared/navigation/manifest';
import type { Surface as NavigationSurface } from '@/shared/navigation/types';
import {
  COMPANION_LIST_ACTIONS_ID,
  buildCompanionManifest,
  companionActionIds,
  type CompanionManifest,
} from '../manifest';

const FIXTURE_PATH = resolve(
  process.cwd(),
  'src/shared/companion/fixtures/wireframe.companion.golden.json',
);

interface GoldenFixture {
  readonly schemaVersion: number;
  readonly staticOffer: readonly unknown[];
  /** Retained legacy surface: the cross-language Rust companion-offer contract. */
  readonly manifest: CompanionManifest;
  readonly offer: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: string;
      readonly properties: {
        readonly action: { readonly type: string; readonly enum: readonly string[] };
        readonly arguments: { readonly type: string };
      };
      readonly required: readonly string[];
    };
  };
  /** The navigation projection and its unified companion manifest. */
  readonly navigation: {
    readonly surface: ReturnType<typeof buildNavigationManifest>;
    readonly manifest: CompanionManifest;
  };
}

function readFixture(): GoldenFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;
}

/** Minimal navigation surface — one published verb + the caller's companion block. */
function navSurface(
  appId: string,
  companion: NavigationSurface['companion'] = {
    appName: 'Nav App',
    description: 'Nav directive.',
  },
): NavigationSurface {
  return {
    tree: { appId, root: `${appId}.root`, places: [], directAliases: {} },
    verbs: [
      {
        id: `${appId}.one`,
        title: 'One',
        description: `Do ${appId} one.`,
        appliesTo: { objects: [], places: [] },
        args: [],
        available: () => true,
        risk: 'safe',
        aliases: [`${appId} one`],
        run: () => ({ label: 'One', patch: null, inverse: null, target: [] }),
        publish: true,
      },
    ],
    companion,
  };
}

describe('buildCompanionManifest — the ONE navigation source', () => {
  it('publishes the shipped Wireframe navigation surface with journal.undo before listActions', () => {
    const manifest = buildCompanionManifest([wireframeSurface]);
    expect(manifest.surfaces).toHaveLength(1);

    const surface = manifest.surfaces[0];
    const published = wireframeSurface.verbs.filter((verb) => verb.publish === true);
    expect(surface.appId).toBe('wireframe');
    expect(surface.appName).toBe('Wireframe');
    expect(surface.skillName).toBe('wireframe');

    // The shipped declaration has 58 verbs; the 6 place-entry verbs are publish:false.
    expect(wireframeSurface.verbs).toHaveLength(58);
    expect(published).toHaveLength(52);
    expect(surface.commands).toHaveLength(53);
    expect(companionActionIds(surface)).toHaveLength(54);

    // Declaration order, then the engine undo, then listActions in the enum only.
    expect(surface.commands.map((command) => command.id)).toStrictEqual([
      ...published.map((verb) => verb.id),
      'journal.undo',
    ]);
    expect(companionActionIds(surface).slice(-2)).toStrictEqual(['journal.undo', 'listActions']);
    expect(companionActionIds(surface).filter((id) => id === 'journal.undo')).toHaveLength(1);

    // Every navigation command carries all six fields ON THE PROJECTION (G-418).
    for (const command of surface.commands) {
      expect(Object.keys(command)).toStrictEqual([
        'id',
        'label',
        'description',
        'risk',
        'args',
        'aliases',
      ]);
    }

    // Spot-check the projected values against the declaration (not the other way round).
    const byId = new Map(surface.commands.map((command) => [command.id, command]));
    for (const verb of published) {
      const command = byId.get(verb.id);
      expect(command).toBeDefined();
      if (command === undefined) continue;
      expect(command.label).toBe(verb.title);
      expect(command.description).toBe(verb.description);
      expect(command.risk).toBe(verb.risk);
      expect(command.aliases).toStrictEqual(verb.aliases);
    }
    expect(byId.get('journal.undo')).toStrictEqual({
      id: 'journal.undo',
      label: 'Undo',
      description:
        'Undo the newest change; optionally filter by verb (verbId), actor (human, companion or system) and count (1..100).',
      risk: 'mutating',
      args: [
        { name: 'actor', required: false },
        { name: 'count', required: false },
        // Spec #3120 (P6), ST-8 — undo by description.
        { name: 'verbId', required: false },
      ],
      aliases: ['undo', 'revert'],
    });
  });

  it('publishes a navigation surface whose appId has no registered feature', () => {
    const manifest = buildCompanionManifest([navSurface('orphan')]);
    expect(manifest.surfaces.map((entry) => entry.appId)).toEqual(['orphan']);
  });

  it('de-duplicates navigation surfaces by appId, first-wins', () => {
    const first = navSurface('alpha', { appName: 'First Nav', description: 'First.' });
    const second = navSurface('alpha', { appName: 'Second Nav', description: 'Second.' });
    const manifest = buildCompanionManifest([first, second]);

    expect(manifest.surfaces).toHaveLength(1);
    expect(manifest.surfaces[0].appName).toBe('First Nav');
  });

  it('a surface without a companion block publishes nothing', () => {
    expect(buildCompanionManifest([navSurface('alpha', null)])).toEqual({ surfaces: [] });
  });

  it('an empty registration list publishes an empty manifest', () => {
    expect(buildCompanionManifest([])).toEqual({ surfaces: [] });
  });

  it('is PURE — the source imports no DOM/IPC/clock', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/companion/manifest.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\bwindow\./);
    expect(source).not.toMatch(/\bdocument\./);
    expect(source).not.toMatch(/\badapterBridge\b/);
    expect(source).not.toMatch(/\bDate\.now\b/);
    expect(source).not.toMatch(/\bMath\.random\b/);
    expect(source).not.toMatch(/@tauri-apps\/api/);
  });

  it('the golden navigation projection deep-equals the builder', () => {
    const fixture = readFixture();
    expectAllSixKeys(fixture.navigation.surface);

    expect(fixture.navigation.surface).toStrictEqual(buildNavigationManifest(wireframeSurface));
    expect(fixture.navigation.manifest).toStrictEqual(buildCompanionManifest([wireframeSurface]));
    expect(fixture.navigation.surface.commands).toHaveLength(53);
    expect(fixture.navigation.surface.actionIds).toHaveLength(54);
    expect(fixture.navigation.manifest.surfaces[0].commands).toHaveLength(53);
  });
});

/** G-418 guard: every projected navigation command carries all six fields. */
function expectAllSixKeys(manifest: ReturnType<typeof buildNavigationManifest>): void {
  for (const command of manifest.commands) {
    expect(Object.keys(command)).toStrictEqual([
      'id',
      'label',
      'description',
      'risk',
      'args',
      'aliases',
    ]);
  }
}

describe('companionActionIds', () => {
  it('appends the reserved listActions id after every published command id', () => {
    const manifest = buildCompanionManifest([navSurface('alpha')]);

    expect(companionActionIds(manifest.surfaces[0])).toEqual([
      'alpha.one',
      'journal.undo',
      COMPANION_LIST_ACTIONS_ID,
    ]);
    expect(COMPANION_LIST_ACTIONS_ID).toBe('listActions');
  });
});
