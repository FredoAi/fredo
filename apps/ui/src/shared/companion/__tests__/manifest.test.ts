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
// Side effect: registers the Wireframe feature exactly as the eager barrel does.
import '@/applications/wireframe/index';
import type { FredoApplicationClass } from '@/shared/classes';
import type {
  ApplicationCommandArg,
  ApplicationCommandSpec,
  ApplicationCommandSurface,
} from '@/shared/hotkeys/commandSurface';
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

    // Nothing in the shipped app publishes a companion surface any more.
    expect(manifest.surfaces).toEqual([]);
    // The retained P6 fixture is therefore NOT the live manifest this slice.
    expect(manifest).not.toEqual(fixture.manifest);
    expect(fixture.manifest.surfaces[0]?.appId).toBe('wireframe');
  });
});

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
