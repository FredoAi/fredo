/**
 * Spec #3120 (P6), ST-5 — the launcher palette projection (QA R-2.1 / R-3.2).
 *
 * The projection is pinned against the SHIPPED P3 `derivePalette` (row-id parity over the
 * real 55-verb Wireframe declaration), then the §3.4 fields are read on the projection:
 * path label, primary-place key hint, risk label, availability + reason, recents
 * dedupe/stale-drop/cap, grouping and the level-2 row actions.
 */

import { describe, expect, it } from 'vitest';

import {
  PALETTE_MAX_RECENTS,
  derivePalette,
  type ContextSnapshot,
  type JournalEntry,
} from '@/shared/navigation';
import { NAV_UNAVAILABLE_REASON } from '@/shared/navigation/ui/constants';
import { wireframeSurface } from '@/applications/wireframe/wireframeSurface';
import {
  buildLauncherPaletteModel,
  buildLauncherRowActions,
  filterLauncherPaletteModel,
} from '@/applications/home/components/launcher/launcherNavigationPalette';
import { launcherPaletteAnnouncement } from '@/applications/home/components/launcher/launcherConstants';

const CANVAS = 'wireframe.canvas';

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    appId: 'wireframe',
    placePath: [CANVAS],
    selection: { count: 0, kinds: [], label: null, ids: [] },
    dirty: false,
    ...overrides,
  };
}

function model(recents: readonly string[] = [], overrides: Partial<ContextSnapshot> = {}) {
  return buildLauncherPaletteModel(wireframeSurface, snapshot(overrides), recents);
}

function entry(
  fields: Pick<JournalEntry, 'seq' | 'verbId' | 'label'> & Partial<JournalEntry>,
): JournalEntry {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'companion',
    channel: 'agent',
    effect: 'mutation',
    placePath: [CANVAS],
    target: [],
    patch: { before: {}, after: {} },
    inverse: {},
    undoable: true,
    external: false,
    consequence: null,
    exitedBy: 'none',
    coalesceKey: null,
    groupId: null,
    ...fields,
  };
}

describe('buildLauncherPaletteModel — P3 order parity (R-2.1)', () => {
  it('emits every declared verb once, in the shipped derivePalette order', () => {
    const palette = model();
    const shipped = derivePalette(wireframeSurface, snapshot(), []);
    // The shipped surface: 6 unpublished place-entry verbs + 49 published verbs.
    expect(palette.rows).toHaveLength(55);
    expect(palette.rows.map((row) => row.verbId)).toEqual(shipped.map((row) => row.verbId));
    expect(new Set(palette.rows.map((row) => row.verbId)).size).toBe(55);
    expect(palette.appId).toBe('wireframe');
  });

  it('groups every place once, in first-appearance order, with the FULL path label', () => {
    const palette = model();
    const labels = palette.groups.map((group) => group.pathLabel);
    expect(labels).toEqual([
      'Canvas',
      'Canvas › Create',
      'Canvas › Edit',
      'Canvas › Arrange',
      'Canvas › Style',
      'Canvas › View',
      'Canvas › File',
    ]);
    expect(new Set(palette.groups.map((group) => group.placeId)).size).toBe(palette.groups.length);
    expect(palette.groups.flatMap((group) => group.rows)).toEqual(palette.rows);
  });

  it('reads the §3.4 fields on the projection (delete / zoom / toggleLock)', () => {
    const palette = model();
    const byId = new Map(palette.rows.map((row) => [row.verbId, row]));

    const del = byId.get('wireframe.element.delete')!;
    expect(del).toMatchObject({
      kind: 'verb',
      title: 'Delete',
      pathLabel: 'Canvas › Edit',
      key: 'x',
      keyHint: 'X',
      risk: 'destructive',
      riskLabel: 'Destructive',
      section: 'place',
      available: false,
      reason: NAV_UNAVAILABLE_REASON,
    });

    const zoom = byId.get('wireframe.zoom.in')!;
    expect(zoom.pathLabel).toBe('Canvas › View');
    expect(zoom.key).toBe('+');
    expect(zoom.keyHint).toBe('+');
    expect(zoom.riskLabel).toBeNull();

    const lock = byId.get('wireframe.element.toggleLock')!;
    expect(lock.riskLabel).toBe('Changes');
    expect(lock.reason).toBe(NAV_UNAVAILABLE_REASON);

    const map = byId.get('app.map')!;
    expect(map.available).toBe(true);
    expect(map.reason).toBeNull();
    expect(map.riskLabel).toBeNull();
  });

  it('follows availability from the live snapshot (a selection makes delete available)', () => {
    const withSelection = model([], {
      selection: { count: 1, kinds: ['element'], label: 'Rectangle', ids: ['el-1'] },
    });
    const del = withSelection.rows.find((row) => row.verbId === 'wireframe.element.delete')!;
    expect(del.available).toBe(true);
    expect(del.reason).toBeNull();
  });

  it('keeps unpublished entry verbs (no filtering)', () => {
    const palette = model();
    expect(palette.rows.some((row) => row.verbId === 'wireframe.create')).toBe(true);
    expect(palette.rows.some((row) => row.verbId === 'wireframe.file')).toBe(true);
  });
});

describe('buildLauncherPaletteModel — recents (R-2.1)', () => {
  it('dedupes + stale-drops before the cap and puts recents first', () => {
    const palette = model([
      'wireframe.element.toggleLock',
      'wireframe.element.toggleLock',
      'stale.verb',
    ]);
    expect(palette.rows).toHaveLength(55);
    expect(palette.rows[0].verbId).toBe('wireframe.element.toggleLock');
    expect(palette.rows[0].section).toBe('recent');
    expect(palette.rows.filter((row) => row.section === 'recent')).toHaveLength(1);
    expect(palette.recentsCount).toBe(1);
    // The recent row keeps its primary place group heading.
    const firstGroup = palette.groups[0];
    expect(firstGroup.placeId).toBe('wireframe.edit');
    expect(firstGroup.pathLabel).toBe('Canvas › Edit');
    expect(firstGroup.rows[0]).toBe(palette.rows[0]);
  });

  it('caps the recent section at PALETTE_MAX_RECENTS', () => {
    const recents = [
      'wireframe.element.toggleLock',
      'wireframe.element.toggleVisible',
      'wireframe.element.duplicate',
      'wireframe.create.rect',
      'wireframe.add.text',
      'wireframe.add.button',
    ];
    const palette = model(recents);
    expect(palette.recentsCount).toBe(PALETTE_MAX_RECENTS);
    expect(palette.rows).toHaveLength(55);
    expect(palette.groups.flatMap((group) => group.rows)).toHaveLength(55);
  });
});

describe('filterLauncherPaletteModel', () => {
  it('matches title/path/key hint case-insensitively and preserves order', () => {
    const palette = model();
    const byPath = filterLauncherPaletteModel(palette, 'EDIT');
    expect(byPath.rows.length).toBeGreaterThan(0);
    expect(byPath.rows.every((row) => `${row.title} ${row.pathLabel} ${row.keyHint}`.toLowerCase().includes('edit'))).toBe(true);
    expect(byPath.groups.map((group) => group.pathLabel)).toContain('Canvas › Edit');
    // No empty groups survive.
    expect(byPath.groups.every((group) => group.rows.length > 0)).toBe(true);

    const shippedIds = palette.rows.map((row) => row.verbId);
    const filteredIds = byPath.rows.map((row) => row.verbId);
    expect(filteredIds).toEqual(shippedIds.filter((id) => filteredIds.includes(id)));
  });

  it('matches a key hint (`x` finds the delete row)', () => {
    const byKey = filterLauncherPaletteModel(model(), 'x');
    expect(byKey.rows.map((row) => row.verbId)).toContain('wireframe.element.delete');
  });

  it('returns the model unchanged for an empty term and an empty result for no match', () => {
    const palette = model();
    expect(filterLauncherPaletteModel(palette, '   ')).toBe(palette);

    const none = filterLauncherPaletteModel(palette, 'zzzz-no-such-verb');
    expect(none.rows).toHaveLength(0);
    expect(none.groups).toHaveLength(0);
    expect(none.recentsCount).toBe(0);
  });

  it('re-flattens filtered recents so the selection index stays stable', () => {
    const palette = model(['wireframe.element.toggleLock', 'wireframe.add.text']);
    const filtered = filterLauncherPaletteModel(palette, 'lock');
    expect(filtered.rows[0].verbId).toBe('wireframe.element.toggleLock');
    expect(filtered.rows[0].section).toBe('recent');
    expect(filtered.recentsCount).toBe(1);
  });
});

describe('buildLauncherRowActions (R-3.2)', () => {
  const deleteRow = () => model().rows.find((row) => row.verbId === 'wireframe.element.delete')!;

  it('offers run + map with no journal entries (no synthetic extra row)', () => {
    const actions = buildLauncherRowActions(deleteRow(), []);
    expect(actions.map((action) => action.kind)).toEqual(['run', 'map']);
    expect(actions[0]).toEqual({ kind: 'run', label: 'Run Delete', verbId: 'wireframe.element.delete' });
    expect(actions[1]).toEqual({ kind: 'map', label: 'Show in map', placeId: 'wireframe.edit' });
  });

  it('adds an undo action only when that verb has an undoable entry', () => {
    const withUndo = buildLauncherRowActions(deleteRow(), [
      entry({ seq: 4, verbId: 'wireframe.element.delete', label: 'Delete' }),
    ]);
    expect(withUndo.map((action) => action.kind)).toEqual(['run', 'undo', 'map']);
    expect(withUndo[1]).toEqual({ kind: 'undo', label: 'Undo Delete', verbId: 'journal.undo' });
  });

  it('ignores non-undoable entries and entries for other verbs', () => {
    const actions = buildLauncherRowActions(deleteRow(), [
      entry({ seq: 1, verbId: 'wireframe.element.delete', label: 'Delete', undoable: false, inverse: null }),
      entry({ seq: 2, verbId: 'wireframe.element.toggleLock', label: 'Toggle lock' }),
    ]);
    expect(actions.map((action) => action.kind)).toEqual(['run', 'map']);
  });

  it('picks the NEWEST undoable entry for the row verb', () => {
    const actions = buildLauncherRowActions(deleteRow(), [
      entry({ seq: 2, verbId: 'wireframe.element.delete', label: 'Delete' }),
      entry({ seq: 7, verbId: 'wireframe.element.delete', label: 'Delete' }),
      entry({ seq: 5, verbId: 'wireframe.element.delete', label: 'Delete' }),
    ]);
    expect(actions[1]).toEqual({ kind: 'undo', label: 'Undo Delete', verbId: 'journal.undo' });
  });
});

describe('launcherPaletteAnnouncement', () => {
  it('formats title — path — risk — key, with Safe for safe rows', () => {
    const byId = new Map(model().rows.map((row) => [row.verbId, row]));
    expect(launcherPaletteAnnouncement(byId.get('wireframe.element.delete')!)).toBe(
      'Delete — Canvas › Edit — Destructive — X',
    );
    expect(launcherPaletteAnnouncement(byId.get('wireframe.zoom.in')!)).toBe(
      'Zoom in — Canvas › View — Safe — +',
    );
  });
});
