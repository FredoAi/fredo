/**
 * Spec #3117 (P3) — ST-3 §8.1 companion-manifest proofs (AC9 / REQ-10.3).
 *
 * Every `it()` title the #3117 QA Plan cites for REQ-10.3 is verbatim. The golden file is
 * COMMITTED and read from disk with `readFileSync` + `JSON.parse` — never re-derived at
 * test time, so it is evidence rather than a tautology.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildCompanionManifest,
  type CompanionManifest,
} from '../manifest';
import { LIST_ACTIONS_ID, type Surface } from '../types';
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

describe('buildCompanionManifest', () => {
  it('manifest equals the committed golden file', () => {
    const golden = readGolden();
    const manifest = buildCompanionManifest(validWireframeSurface());

    expect(golden.schemaVersion).toBe(1);
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

    for (const verb of surface.verbs) {
      if (verb.publish !== true) continue;
      const command = commandsById.get(verb.id);
      expect(command).toBeDefined();
      expect(command?.id).toBe(verb.id);
      expect(command?.label).toBe(verb.title);
      expect(command?.description).toBe(verb.description);
      expect(command?.description.trim().length).toBeGreaterThan(0);
      expect(command?.args).toStrictEqual(
        verb.args.map((arg) => ({ name: arg.name, required: arg.required === true })),
      );
      expect(['safe', 'mutating', 'destructive', 'external']).toContain(verb.risk);
      expect(Array.isArray(verb.aliases)).toBe(true);
    }

    // A verb with no aliases is valid (`[]`), and args project required/description.
    const argSurface = makeSurface({
      root: 'p.root',
      places: [makePlace({ id: 'p.root' })],
      verbs: [
        makeVerb({
          id: 'v.go',
          title: 'Go',
          aliases: [],
          args: [
            { name: 'target', type: 'string', required: true },
            { name: 'note', type: 'string', required: false },
          ],
        }),
      ],
    });
    const projected = buildCompanionManifest(argSurface);
    expect(projected.commands[0].args).toStrictEqual([
      { name: 'target', required: true },
      { name: 'note', required: false },
    ]);
    expect(projected.actionIds).toStrictEqual(['v.go', LIST_ACTIONS_ID]);
  });
});
