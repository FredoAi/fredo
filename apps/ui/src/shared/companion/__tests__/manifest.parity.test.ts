/**
 * Companion manifest parity (Spec #3122 P8, ST-3 / AC4).
 *
 * The declaration IS the published action set. For every shipped navigation
 * surface this suite pins, non-circularly:
 *
 *   1. the companion projection's command ids equal the surface's PUBLISHED verbs
 *      in declaration order, then the engine-owned `journal.undo` (never a second);
 *   2. every projected command carries all six fields (`id`, `label`,
 *      `description`, `risk`, `args`, `aliases`) — G-418 reads the PROJECTION,
 *      never the source verb;
 *   3. the committed golden fixture (`schemaVersion: 3`) is exactly the shipped
 *      Wireframe projection, with exactly three top-level keys, and its generated
 *      `offer.parameters.properties.action.enum` equals the manifest command ids in
 *      order followed by exactly ONE trailing `listActions`.
 *
 * A second manifest, a stale fixture, or a projection that silently drops a field
 * fails here.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { databaseClientSurface } from '@/applications/database-client/databaseClientSurface';
import { devModeSurface } from '@/applications/dev-mode/devModeSurface';
import { missionMonitorSurface } from '@/applications/mission-monitor/missionMonitorSurface';
import { terminalSurface } from '@/applications/terminal/terminalSurface';
import { wireframeSurface } from '@/applications/wireframe/wireframeSurface';
import type { Surface as NavigationSurface } from '@/shared/navigation/types';
import { windowSystemSurface } from '@/shared/window-system/windowSystemSurface';
import {
  COMPANION_LIST_ACTIONS_ID,
  buildCompanionManifest,
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

/** The engine-owned command appended to every navigation projection. */
const ENGINE_UNDO_ID = 'journal.undo';

/** Every shipped navigation surface that declares a companion block. */
const SHIPPED_SURFACES: ReadonlyArray<readonly [string, NavigationSurface]> = [
  ['wireframe', wireframeSurface],
  ['terminal', terminalSurface],
  ['mission-monitor', missionMonitorSurface],
  ['database-client', databaseClientSurface],
  ['dev-mode', devModeSurface],
  ['window-system', windowSystemSurface],
];

/** Published verb ids in declaration order, then the engine undo (if absent). */
function declaredActionIds(surface: NavigationSurface): readonly string[] {
  const published = surface.verbs
    .filter((verb) => verb.publish === true)
    .map((verb) => verb.id);
  return published.includes(ENGINE_UNDO_ID) ? published : [...published, ENGINE_UNDO_ID];
}

describe('companion manifest parity — the declaration is the published action set', () => {
  for (const [label, surface] of SHIPPED_SURFACES) {
    it(`${label}: the projection ids equal the declaration in order`, () => {
      const manifest = buildCompanionManifest([surface]);
      expect(manifest.surfaces).toHaveLength(1);
      const projection = manifest.surfaces[0];

      const declared = declaredActionIds(surface);
      expect(projection.commands.map((command) => command.id)).toStrictEqual(declared);
      expect(projection.commands.filter((command) => command.id === ENGINE_UNDO_ID)).toHaveLength(
        1,
      );
    });

    it(`${label}: every projected command carries all six fields (G-418)`, () => {
      const projection = buildCompanionManifest([surface]).surfaces[0];
      expect(projection.commands.length).toBeGreaterThan(0);
      for (const command of projection.commands) {
        expect(Object.keys(command)).toStrictEqual([
          'id',
          'label',
          'description',
          'risk',
          'args',
          'aliases',
        ]);
        expect(command.risk).toBeDefined();
        expect(Array.isArray(command.aliases)).toBe(true);
      }
    });
  }

  it('the golden fixture is exactly the shipped Wireframe projection', () => {
    const fixture = readFixture();
    expect(fixture.schemaVersion).toBe(3);
    expect(Object.keys(fixture)).toStrictEqual(['schemaVersion', 'staticOffer', 'manifest', 'offer']);
    expect(fixture.manifest).toStrictEqual(buildCompanionManifest([wireframeSurface]));
  });

  it('the offer enum equals the manifest ids in order, then ONE listActions', () => {
    const fixture = readFixture();
    const manifest = fixture.manifest;
    expect(manifest.surfaces).toHaveLength(1);

    const commandIds = manifest.surfaces[0].commands.map((command) => command.id);
    const enumeration = fixture.offer.parameters.properties.action.enum as readonly string[];

    // The committed enum: declaration order, then the single reserved id.
    expect(enumeration).toStrictEqual([...commandIds, COMPANION_LIST_ACTIONS_ID]);
    expect(enumeration.filter((id) => id === COMPANION_LIST_ACTIONS_ID)).toHaveLength(1);
    expect(enumeration[enumeration.length - 1]).toBe(COMPANION_LIST_ACTIONS_ID);

    // And the projection built from the declaration agrees with the committed file.
    const built = buildCompanionManifest([wireframeSurface]);
    expect(enumeration.slice(0, -1)).toStrictEqual(
      built.surfaces[0].commands.map((command) => command.id),
    );
  });
});
