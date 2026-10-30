/**
 * Spec #3118 (P4), ST-1 — R-6.1 / AC6: one declaration drives all three projections.
 *
 * The aggregate case is THE AC6 proof (Architect C3 / QA Q6-03): on a SINGLE cloned
 * declaration add a place, rename a verb title and add a direct alias, then resolve and
 * dispatch a stroke FROM the mutated place and assert the rail, the map and the trail all
 * reflect the mutation in one snapshot — with no other edit and no re-derivation of history.
 *
 * The per-cell matrix (Q6-01a…d) is supplementary; the two residual invariants (Q6-02) guard
 * against "passing" the aggregate by rebuilding history from the current declaration.
 *
 * Dispatch goes through the shipped P3 funnel (`resolveStroke` + `dispatch`) because
 * `host.ts` lands in ST-5; the models are the same ones the host snapshot will feed.
 */

import { describe, expect, it } from 'vitest';

import {
  createJournalStore,
  dispatch,
  resolveStroke,
  type EngineDeps,
  type Intent,
  type Surface,
} from '../../';
import { formatKeyHint } from '../format';
import {
  buildActivityTrailModel,
  buildCommandRailModel,
  buildNavigationMapModel,
} from '../models';
import {
  FIXTURE_PLACES,
  addDirectAlias,
  addPlace,
  fixtureSnapshot,
  fixtureTimestamp,
  navTestSurface,
  renamePlace,
  renameVerbTitle,
  seedEntries,
} from './fixtures';

const S = FIXTURE_PLACES;

function railAt(surface: Surface, placePath: readonly string[]) {
  return buildCommandRailModel(surface, fixtureSnapshot(placePath));
}

function mapAt(surface: Surface, placePath: readonly string[]) {
  return buildNavigationMapModel(surface, fixtureSnapshot(placePath));
}

/* ───────────────────────── Q6-01a … Q6-01d — the supplementary per-cell matrix ───────────────────────── */

describe('projection mutation — per-cell matrix (R-6.1 / Q6-01)', () => {
  it('Q6-01a add place: the map gains a block, the rail gains no row', () => {
    const base = navTestSurface();
    const mutated = addPlace(base);

    const beforeMap = mapAt(base, [S.canvas]);
    const afterMap = mapAt(mutated, [S.canvas]);
    expect(beforeMap.places.map((place) => place.placeId)).not.toContain(S.archive);
    const archive = afterMap.places.find((place) => place.placeId === S.archive);
    expect(archive?.pathLabel).toBe('Canvas › Archive');

    // A place-target key is not a verb row: exactly zero rail delta at the root.
    const beforeRail = railAt(base, [S.canvas]);
    const afterRail = railAt(mutated, [S.canvas]);
    expect(afterRail.rows).toEqual(beforeRail.rows);
    expect(afterRail.actionCount).toBe(beforeRail.actionCount);

    // No entry can reference a brand-new place: the trail is byte-identical.
    const entries = seedEntries(2);
    expect(buildActivityTrailModel(mutated, entries)).toEqual(
      buildActivityTrailModel(base, entries),
    );
  });

  it('Q6-01b rename verb: the rail and the map show the new title, history does not', () => {
    const base = navTestSurface();
    const mutated = renameVerbTitle(base, 'test.rect', 'Box');
    const entries = seedEntries(1);

    const rail = railAt(mutated, [S.canvas, S.create]);
    const rectRow = rail.rows.find((row) => row.verbId === 'test.rect');
    expect(rectRow?.title).toBe('Box');

    const createBlock = mapAt(mutated, [S.canvas, S.create]).places.find(
      (place) => place.placeId === S.create,
    );
    expect(
      createBlock?.verbs.find((verb) => verb.verbId === 'test.rect')?.title,
    ).toBe('Box');

    // Named residual: a historical entry's label is authored at dispatch and never rewritten.
    const trail = buildActivityTrailModel(mutated, entries);
    expect(trail.entries[0]?.label).toBe(entries[0]?.label);
    expect(trail.entries[0]?.label).toBe('Rectangle 1');
  });

  it('Q6-01c add alias: the map gains the alias row, the rail is untouched', () => {
    const base = navTestSurface();
    const mutated = addDirectAlias(base, 'q', 'test.rect');

    const map = mapAt(mutated, [S.canvas]);
    const alias = map.aliases.find((row) => row.stroke === 'q');
    expect(alias).toMatchObject({
      stroke: 'q',
      source: 'alias',
      target: 'verb',
      targetId: 'test.rect',
    });

    const beforeRail = railAt(base, [S.canvas]);
    const afterRail = railAt(mutated, [S.canvas]);
    expect(afterRail.rows).toEqual(beforeRail.rows);
    expect(afterRail.rows.map((row) => row.keyHint)).toEqual(
      beforeRail.rows.map((row) => row.keyHint),
    );

    const entries = seedEntries(2);
    expect(buildActivityTrailModel(mutated, entries)).toEqual(
      buildActivityTrailModel(base, entries),
    );
  });

  it('Q6-01d rename place: rail breadcrumb, map path and historical path all follow', () => {
    const base = navTestSurface();
    const mutated = renamePlace(base, S.create, 'Compose');
    const entries = seedEntries(2);

    const rail = railAt(mutated, [S.canvas, S.create]);
    expect(rail.breadcrumb[rail.breadcrumb.length - 1]?.label).toBe('Compose');
    expect(rail.currentPlace.label).toBe('Compose');

    const block = mapAt(mutated, [S.canvas, S.create]).places.find(
      (place) => place.placeId === S.create,
    );
    expect(block?.pathLabel).toBe('Canvas › Compose');

    // The declaration is the only label source, so the historical path label follows it.
    const trail = buildActivityTrailModel(mutated, entries);
    for (const entry of trail.entries) {
      expect(entry.pathLabel).toBe('Canvas › Compose');
    }
  });
});

/* ───────────────────────── Q6-02 — the two residual invariants ───────────────────────── */

describe('projection mutation — residual invariants (R-6.1 / Q6-02)', () => {
  it('a verb-title rename never rewrites a historical entry label', () => {
    const base = navTestSurface();
    const entries = seedEntries(3);
    const before = buildActivityTrailModel(base, entries);
    const after = buildActivityTrailModel(
      renameVerbTitle(base, 'test.rect', 'Box'),
      entries,
    );
    expect(after.entries.map((entry) => entry.label)).toEqual(
      before.entries.map((entry) => entry.label),
    );
  });

  it('a direct alias adds no rail row and changes no keyHint', () => {
    const base = navTestSurface();
    const before = buildCommandRailModel(base, fixtureSnapshot([S.canvas, S.create]));
    const after = buildCommandRailModel(
      addDirectAlias(base, 'q', 'test.rect'),
      fixtureSnapshot([S.canvas, S.create]),
    );
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.actionCount).toBe(before.actionCount);
    expect(after.rows.map((row) => row.keyHint)).toEqual(
      before.rows.map((row) => row.keyHint),
    );
    // The key hint of the aliased verb still comes from its PLACE binding ('r'), not 'q'.
    expect(before.rows.find((row) => row.verbId === 'test.rect')?.keyHint).toBe(
      formatKeyHint(['r']),
    );
  });
});

/* ───────────────────────── Q6-03 — THE AC6 aggregate proof ───────────────────────── */

describe('projection mutation — the one-declaration aggregate proof (R-6.1 / Q6-03)', () => {
  it('refreshes rail + map + trail from ONE cloned declaration after a dispatch', () => {
    const base = navTestSurface();
    // (a) add test.archive (key z, binding x → test.rect), (b) rename test.rect, (c) add alias q.
    const withPlace = addPlace(base);
    const withRename = renameVerbTitle(withPlace, 'test.rect', 'Box');
    const mutated = addDirectAlias(withRename, 'q', 'test.rect');

    const snapshot = fixtureSnapshot([S.canvas, S.archive]);
    const journal = createJournalStore();
    const appliedPatches: unknown[] = [];
    const deps: EngineDeps = {
      surface: mutated,
      getContext: () => snapshot,
      journal,
      now: () => fixtureTimestamp(0),
      applyPatch: (patch) => {
        appliedPatches.push(patch);
      },
      confirm: () => true,
    };

    // Navigate to the MUTATED place and dispatch its bound stroke.
    const resolution = resolveStroke({
      surface: mutated,
      placePath: snapshot.placePath,
      pending: null,
      stroke: 'x',
      nowMs: 0,
    });
    expect(resolution.status).toBe('dispatch');
    if (resolution.status !== 'dispatch') throw new Error('stroke x did not resolve');
    const intent: Intent = resolution.intent;
    expect(intent.verbId).toBe('test.rect');

    const result = dispatch(deps, intent);
    expect(result).toMatchObject({ status: 'performed' });
    expect(appliedPatches).toHaveLength(1);
    expect(journal.entries()).toHaveLength(1);

    // ── one snapshot: build all three models from the SAME mutated declaration ──
    const rail = buildCommandRailModel(mutated, snapshot);
    const map = buildNavigationMapModel(mutated, snapshot);
    const trail = buildActivityTrailModel(mutated, journal.entries());

    // (i) rail — the breadcrumb/current place include the added place; the row is renamed.
    expect(rail.breadcrumb.map((place) => place.id)).toEqual([S.canvas, S.archive]);
    expect(rail.currentPlace.label).toBe('Archive');
    const rectRow = rail.rows.find((row) => row.verbId === 'test.rect');
    expect(rectRow?.title).toBe('Box');

    // (ii) map — the new block, the renamed verb and the alias row are all present.
    const archive = map.places.find((place) => place.placeId === S.archive);
    expect(archive?.pathLabel).toBe('Canvas › Archive');
    expect(
      archive?.verbs.find((verb) => verb.verbId === 'test.rect')?.title,
    ).toBe('Box');
    expect(map.aliases.some((row) => row.stroke === 'q' && row.targetId === 'test.rect')).toBe(
      true,
    );

    // (iii) trail — the new entry carries the renamed label and the mutated place path.
    const newest = trail.entries[0];
    expect(newest?.label).toBe('Box');
    expect(newest?.placePath.map((place) => place.id)).toEqual([S.canvas, S.archive]);
    expect(newest?.pathLabel).toBe('Canvas › Archive');
  });
});
