/**
 * Companion manifest builder (Spec #3099, ST-2).
 *
 * Pins:
 *   - purity (no DOM/IPC/clock in the builder source);
 *   - only `commandSurface.companion` applications are published;
 *   - declaration order, arg projection, `listLabel` omission;
 *   - description-less commands are EXCLUDED (R-1c) and zero-command surfaces
 *     are still returned (Rust skips them);
 *   - duplicate registration is FIRST-WINS by appId;
 *   - the retired Wireframe surface (Spec #3119 ST-4 / Q-1) is NOT republished
 *     (companion parity is a P6 follow-up — fail closed, never a silent drop).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getApplications,
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import { wireframeFeature } from '@/applications/wireframe/WireframeFeature';
import { wireframeSurface } from '@/applications/wireframe/wireframeSurface';
// Side effect: registers the Wireframe feature exactly as the eager barrel does.
import '@/applications/wireframe/index';
import type { FredoApplicationClass } from '@/shared/classes';
import type {
  ApplicationCommandArg,
  ApplicationCommandSpec,
  ApplicationCommandSurface,
} from '@/shared/hotkeys/commandSurface';
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
  /** Spec #3120 ST-2 — the navigation projection and its unified companion manifest. */
  readonly navigation: {
    readonly surface: ReturnType<typeof buildNavigationManifest>;
    readonly manifest: CompanionManifest;
  };
}

function readFixture(): GoldenFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;
}

function command(
  id: string,
  title: string,
  description?: string,
  args?: readonly ApplicationCommandArg[],
): ApplicationCommandSpec {
  return { id, title, description, args, run: () => true };
}

function surface(
  commands: readonly ApplicationCommandSpec[],
  companion?: ApplicationCommandSurface['companion'],
): ApplicationCommandSurface {
  return { modes: [], commands, ...(companion === undefined ? {} : { companion }) };
}

/** Minimal feature stand-in — the builder only reads id/name/commandSurface. */
function feature(
  id: string,
  name: string,
  commandSurface?: ApplicationCommandSurface,
): FredoApplicationClass {
  return { id, name, commandSurface } as unknown as FredoApplicationClass;
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

beforeEach(() => {
  resetApplicationRegistryForTests();
  // Deterministic registry: exactly one Wireframe (module load may have
  // registered it already, hence the reset first).
  registerApplication(wireframeFeature);
});

describe('buildCompanionManifest', () => {
  it('publishes only applications with a companion block, in declaration order', () => {
    const manifest = buildCompanionManifest([
      feature('alpha', 'Alpha', surface([command('alpha.one', 'One', 'Do one thing')], {
        description: 'Alpha directive.',
      })),
      feature('beta', 'Beta', surface([command('beta.one', 'One', 'Do beta one')])),
      feature('gamma', 'Gamma', surface([command('gamma.one', 'One', 'Do gamma one')], {
        description: 'Gamma directive.',
        listLabel: 'Gamma moves',
      })),
    ]);

    expect(manifest.surfaces.map((entry) => entry.appId)).toEqual(['alpha', 'gamma']);
    expect(manifest.surfaces[0]).toEqual({
      appId: 'alpha',
      appName: 'Alpha',
      skillName: 'alpha',
      description: 'Alpha directive.',
      commands: [{ id: 'alpha.one', label: 'One', description: 'Do one thing', args: [] }],
    });
    // listLabel is forwarded only when declared (absent => key omitted).
    expect('listLabel' in manifest.surfaces[0]).toBe(false);
    expect(manifest.surfaces[1].listLabel).toBe('Gamma moves');
  });

  it('excludes commands with an absent or blank description (R-1c)', () => {
    const manifest = buildCompanionManifest([
      feature(
        'alpha',
        'Alpha',
        surface(
          [
            command('alpha.absent', 'Absent'),
            command('alpha.blank', 'Blank', '   '),
            command('alpha.real', 'Real', 'A real sentence'),
          ],
          { description: 'Alpha directive.' },
        ),
      ),
    ]);

    expect(manifest.surfaces[0].commands.map((entry) => entry.id)).toEqual(['alpha.real']);
  });

  it('keeps a surface whose commands are all unpublished (empty commands)', () => {
    const manifest = buildCompanionManifest([
      feature('alpha', 'Alpha', surface([command('alpha.absent', 'Absent')], {
        description: 'Alpha directive.',
      })),
    ]);

    expect(manifest.surfaces).toHaveLength(1);
    expect(manifest.surfaces[0].commands).toEqual([]);
  });

  it('projects declared args with required defaulting to false and description omitted', () => {
    const manifest = buildCompanionManifest([
      feature(
        'alpha',
        'Alpha',
        surface(
          [
            command('alpha.go', 'Go', 'Go somewhere', [
              { name: 'target', required: true, description: 'Where to go' },
              { name: 'note' },
            ]),
          ],
          { description: 'Alpha directive.' },
        ),
      ),
    ]);

    expect(manifest.surfaces[0].commands[0].args).toEqual([
      { name: 'target', required: true, description: 'Where to go' },
      { name: 'note', required: false },
    ]);
  });

  it('de-duplicates features by appId, first-wins', () => {
    const manifest = buildCompanionManifest([
      feature('alpha', 'First Alpha', surface([command('alpha.one', 'One', 'First')], {
        description: 'First directive.',
      })),
      feature('alpha', 'Second Alpha', surface([command('alpha.two', 'Two', 'Second')], {
        description: 'Second directive.',
      })),
    ]);

    expect(manifest.surfaces).toHaveLength(1);
    expect(manifest.surfaces[0].appName).toBe('First Alpha');
    expect(manifest.surfaces[0].commands.map((entry) => entry.id)).toEqual(['alpha.one']);
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

  /**
   * Spec #3119 ST-4 / Orchestrator Q-1 — the legacy Wireframe command surface is
   * RETIRED (AC7). `WireframeFeature.commandSurface` is gone, so the app no
   * longer publishes a companion surface; a companion call now fails closed
   * (`Invalid`) until the P6 launcher/companion slice re-homes the capability.
   *
   * The shared golden fixture below is UNCHANGED on purpose: it is a
   * cross-language artifact also read by the Rust companion tests, and the plan
   * names its reconciliation (with `infrastructure/companion/wireframe_catalog.rs`)
   * as a P6 follow-up, not a P5 change.
   */
  it('no longer publishes the retired Wireframe command surface (P6 fail-closed)', () => {
    const manifest = buildCompanionManifest([wireframeFeature]);

    expect(manifest.surfaces).toEqual([]);
  });

  it('does not republish the retired surface from the shared golden fixture', () => {
    const fixture = readFixture();
    const manifest = buildCompanionManifest(getApplications());

    // No navigation host is registered in this unit process, so the shipped
    // Wireframe app still publishes nothing.
    expect(manifest.surfaces).toEqual([]);
    // The retained legacy fixture stays the Rust cross-language contract.
    expect(manifest).not.toEqual(fixture.manifest);
    expect(fixture.manifest.surfaces[0]?.appId).toBe('wireframe');
  });
});

describe('buildCompanionManifest — navigation source (Spec #3120 ST-2)', () => {
  it('publishes the shipped Wireframe navigation surface with journal.undo before listActions', () => {
    const manifest = buildCompanionManifest([wireframeFeature], [wireframeSurface]);
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

  it('navigation wins over a legacy commandSurface for the same appId', () => {
    const legacy = feature(
      'alpha',
      'Alpha Legacy',
      surface([command('alpha.legacy', 'Legacy', 'A legacy command.')], {
        description: 'Legacy directive.',
      }),
    );
    const manifest = buildCompanionManifest([legacy], [navSurface('alpha')]);

    expect(manifest.surfaces).toHaveLength(1);
    const projected = manifest.surfaces[0];
    expect(projected.appName).toBe('Nav App');
    expect(projected.description).toBe('Nav directive.');
    expect(projected.commands.map((entry) => entry.id)).toStrictEqual([
      'alpha.one',
      'journal.undo',
    ]);
    // The legacy command did not leak through.
    expect(projected.commands.some((entry) => entry.id === 'alpha.legacy')).toBe(false);
  });

  it('still publishes a legacy app when no navigation surface is registered', () => {
    const manifest = buildCompanionManifest([
      feature('alpha', 'Alpha', surface([command('alpha.one', 'One', 'Do one thing')], {
        description: 'Alpha directive.',
      })),
    ]);

    expect(manifest.surfaces.map((entry) => entry.appId)).toEqual(['alpha']);
    expect(manifest.surfaces[0].commands).toEqual([
      { id: 'alpha.one', label: 'One', description: 'Do one thing', args: [] },
    ]);
    // A legacy command carries no risk/aliases keys at all (absent, never null).
    expect('risk' in manifest.surfaces[0].commands[0]).toBe(false);
    expect('aliases' in manifest.surfaces[0].commands[0]).toBe(false);
  });

  it('publishes a navigation surface whose appId has no registered feature', () => {
    const manifest = buildCompanionManifest([], [navSurface('orphan')]);
    expect(manifest.surfaces.map((entry) => entry.appId)).toEqual(['orphan']);
  });

  it('de-duplicates navigation surfaces by appId, first-wins', () => {
    const first = navSurface('alpha', { appName: 'First Nav', description: 'First.' });
    const second = navSurface('alpha', { appName: 'Second Nav', description: 'Second.' });
    const manifest = buildCompanionManifest([], [first, second]);

    expect(manifest.surfaces).toHaveLength(1);
    expect(manifest.surfaces[0].appName).toBe('First Nav');
  });

  it('a navigation surface without a companion block publishes nothing and suppresses the legacy projection', () => {
    const legacy = feature(
      'alpha',
      'Alpha',
      surface([command('alpha.one', 'One', 'Do one thing')], {
        description: 'Legacy directive.',
      }),
    );
    const manifest = buildCompanionManifest([legacy], [navSurface('alpha', null)]);
    expect(manifest.surfaces).toEqual([]);
  });

  it('the golden navigation projection deep-equals the builder', () => {
    const fixture = readFixture();
    expectAllSixKeys(fixture.navigation.surface);

    expect(fixture.navigation.surface).toStrictEqual(buildNavigationManifest(wireframeSurface));
    expect(fixture.navigation.manifest).toStrictEqual(
      buildCompanionManifest([wireframeFeature], [wireframeSurface]),
    );
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
    const manifest = buildCompanionManifest([
      feature(
        'alpha',
        'Alpha',
        surface([command('alpha.one', 'One', 'One'), command('alpha.two', 'Two', 'Two')], {
          description: 'Alpha directive.',
        }),
      ),
    ]);

    expect(companionActionIds(manifest.surfaces[0])).toEqual([
      'alpha.one',
      'alpha.two',
      COMPANION_LIST_ACTIONS_ID,
    ]);
    expect(COMPANION_LIST_ACTIONS_ID).toBe('listActions');
  });
});
