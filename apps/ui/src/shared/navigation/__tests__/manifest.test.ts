/**
 * Spec #3117 (P3) — ST-3/ST-6 §8.1 companion-manifest proofs (AC9 / REQ-10.3).
 *
 * Every `it()` title the #3117 QA Plan cites for REQ-10.3 is verbatim. The golden file is
 * COMMITTED and read from disk with `readFileSync` + `JSON.parse` — never re-derived at
 * test time, so it is evidence rather than a tautology.
 *
 * AC9 evidence is PROJECTION-level (G-418): every assertion below reads the projected
 * `CompanionCommand`, never the source `VerbDescriptor` alone.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildCompanionManifest,
  type CompanionManifest,
} from '../manifest';
import { LIST_ACTIONS_ID, type Surface, type VerbArg } from '../types';
import {
  makePlace,
  makeSurface,
  makeVerb,
  validWireframeSurface,
} from './fixtures';

const FIXTURE_PATH = resolve(
  process.cwd(),
  'src/shared/navigation/__tests__/fixtures/wireframe.navigation.golden.json',
);

interface GoldenFixture {
  readonly schemaVersion: number;
  readonly manifest: CompanionManifest;
}

function readGolden(): GoldenFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;
}

/** `VerbArg` may carry an authored description the interface does not declare. */
interface AuthoredVerbArg extends VerbArg {
  readonly description?: string;
}

/** The expected projected arg: name/required plus an authored description (key omitted if none). */
function expectedArg(arg: VerbArg): {
  name: string;
  required: boolean;
  description?: string;
} {
  const source = arg as AuthoredVerbArg;
  return {
    name: source.name,
    required: source.required === true,
    ...(source.description === undefined ? {} : { description: source.description }),
  };
}

describe('buildCompanionManifest', () => {
  it('manifest equals the committed golden file', () => {
    const golden = readGolden();
    const manifest = buildCompanionManifest(validWireframeSurface());

    expect(golden.schemaVersion).toBe(1);
    expect(manifest.commands.length).toBeGreaterThan(0);
    expect(manifest).toStrictEqual(golden.manifest);

    // Set equality with every `publish === true` verb, in declaration order.
    const published = validWireframeSurface()
      .verbs.filter((verb) => verb.publish === true)
      .map((verb) => verb.id);
    expect(manifest.commands.map((command) => command.id)).toStrictEqual(published);

    // Exactly ONE reserved `listActions`, appended last.
    expect(manifest.actionIds.slice(-1)).toStrictEqual([LIST_ACTIONS_ID]);
    expect(manifest.actionIds.filter((id) => id === LIST_ACTIONS_ID)).toHaveLength(1);
    expect(manifest.actionIds).toHaveLength(published.length + 1);
  });

  it('manifest projection is byte-identical across runs', () => {
    const surface = validWireframeSurface();
    const first = JSON.stringify(buildCompanionManifest(surface));
    const second = JSON.stringify(buildCompanionManifest(validWireframeSurface()));

    expect(second).toBe(first);
    // Same declaration, new surface object: identical bytes.
    const cloned: Surface = { ...surface };
    expect(JSON.stringify(buildCompanionManifest(cloned))).toBe(first);

    // An unpublished verb is excluded and leaves the projection byte-identical.
    const withHidden: Surface = {
      ...surface,
      verbs: [
        ...surface.verbs,
        makeVerb({ id: 'v.hidden', title: 'Hidden', publish: false }),
      ],
    };
    const hidden = buildCompanionManifest(withHidden);
    expect(hidden.commands.some((command) => command.id === 'v.hidden')).toBe(false);
    expect(JSON.stringify(hidden)).toBe(first);
  });

  it('every published verb carries id title description risk args and aliases', () => {
    const surface = validWireframeSurface();
    const manifest = buildCompanionManifest(surface);
    const commandsById = new Map(
      manifest.commands.map((command) => [command.id, command]),
    );
    const published = surface.verbs.filter((verb) => verb.publish === true);

    // Command ids == every published verb, in declaration order.
    expect(manifest.commands.map((command) => command.id)).toStrictEqual(
      published.map((verb) => verb.id),
    );

    for (const verb of published) {
      const command = commandsById.get(verb.id);
      expect(command).toBeDefined();
      if (command === undefined) continue;

      // The assertion SUBJECT is the projected command (G-418), not the descriptor.
      expect(command.id).toBe(verb.id);
      expect(command.label).toBe(verb.title);
      expect(command.description).toBe(verb.description);
      expect(command.risk).toBe(verb.risk);
      expect(command.args).toStrictEqual(verb.args.map(expectedArg));
      expect(command.aliases).toStrictEqual(verb.aliases);
    }

    // Exactly ONE reserved `listActions`, appended last.
    expect(manifest.actionIds.slice(-1)).toStrictEqual([LIST_ACTIONS_ID]);
    expect(manifest.actionIds.filter((id) => id === LIST_ACTIONS_ID)).toHaveLength(1);

    // A local surface proves the projection itself: a NON-EMPTY alias array survives
    // verbatim, an authored `[]` stays `[]`, and an authored arg description round-trips
    // (a constant `aliases: []` or a dropped arg description MUST fail).
    const localSurface = makeSurface({
      root: 'p.local',
      places: [makePlace({ id: 'p.local' })],
      verbs: [
        makeVerb({
          id: 'v.rect',
          title: 'Add rectangle',
          description: 'Adds a rectangle.',
          risk: 'mutating',
          aliases: ['add a rectangle', 'new rect'],
          args: [
            { name: 'size', type: 'string', required: true, description: 'Rectangle size.' },
            { name: 'label', type: 'string', required: false },
          ],
        }),
        makeVerb({
          id: 'v.noAliases',
          title: 'No aliases',
          description: 'Declares no aliases.',
          aliases: [],
        }),
      ],
    });
    const projectedLocal = buildCompanionManifest(localSurface);
    const rect = projectedLocal.commands[0];
    const noAliases = projectedLocal.commands[1];

    expect(rect.id).toBe('v.rect');
    expect(rect.label).toBe('Add rectangle');
    expect(rect.risk).toBe('mutating');
    expect(rect.aliases).toStrictEqual(['add a rectangle', 'new rect']);
    expect(rect.args).toStrictEqual([
      { name: 'size', required: true, description: 'Rectangle size.' },
      { name: 'label', required: false },
    ]);
    expect(noAliases.aliases).toStrictEqual([]);
  });

  it('golden command rows carry all six projection keys', () => {
    const golden = readGolden();
    const rows = golden.manifest.commands;

    // Non-vacuity guard: a renamed or emptied fixture fails loudly.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(
      validWireframeSurface().verbs.filter((verb) => verb.publish === true).length,
    );

    for (const row of rows) {
      // No missing key, no extra key, no reordering — the round-1 defect was `risk`/`aliases` absent.
      expect(Object.keys(row)).toStrictEqual([
        'id',
        'label',
        'description',
        'risk',
        'args',
        'aliases',
      ]);
    }
  });
});
