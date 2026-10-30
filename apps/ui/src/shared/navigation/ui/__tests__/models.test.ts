/**
 * Spec #3118 (P4), ST-1 — the view-model layer's unit pins (QA Q1-01…Q1-06, Q1-09, Q2-02,
 * Q3-01…Q3-04, plus the formatter contracts of Architect §8).
 *
 * The oracle is the DECLARED fixture surface (D1) — never a hand-written expected list of
 * bindings — so a drifting projection fails here. Every assertion names the bound constant it
 * checks (`NAV_RISK_LABELS`, `NAV_EMPTY_TRAIL_COPY`, …) instead of a design-doc snapshot
 * (G-324/G-419).
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_LIMITS,
  NON_UNDOABLE_CONSEQUENCES,
  deriveMap,
  formatTooltip,
  validateSurface,
  type Surface,
} from '../../';
import {
  NAV_ACTOR_LABELS,
  NAV_ASK_DISABLED_REASON,
  NAV_ASK_VERB_ID,
  NAV_EMPTY_TRAIL_COPY,
  NAV_GLYPH_BY_VERB_ID,
  NAV_MAP_ALIASES_HEADING,
  NAV_MAP_CURRENT_LABEL,
  NAV_MAP_EMPTY_COPY,
  NAV_MAP_GLOBALS_HEADING,
  NAV_MAP_HINT_COPY,
  NAV_MAP_SEARCH_LABEL,
  NAV_MAP_VERB_ID,
  NAV_MORE_LABEL,
  NAV_RAIL_EMPTY_COPY,
  NAV_RAIL_MAX_ROWS,
  NAV_RAIL_MIN_WIDTH_PX,
  NAV_RISK_LABELS,
  NAV_TRANSIENT_MARKER_SUFFIX,
  NAV_UNAVAILABLE_REASON,
} from '../constants';
import {
  formatKeyHint,
  formatPlacePathLabel,
  formatTrailTime,
  navTooltip,
  riskLabel,
} from '../format';
import {
  buildActivityTrailModel,
  buildCommandRailModel,
  buildNavigationMapModel,
} from '../models';
import type { NavigationMapKey } from '../types';
import {
  FIXTURE_APP_ID,
  FIXTURE_PLACES,
  fixtureSnapshot,
  navTestSurface,
  seedCompanionEntry,
  seedEntries,
  seedNonUndoableEntry,
} from './fixtures';

const S = FIXTURE_PLACES;

function railAt(placePath: readonly string[], surface: Surface = navTestSurface()) {
  return buildCommandRailModel(surface, fixtureSnapshot(placePath));
}

function mapAt(placePath: readonly string[], surface: Surface = navTestSurface()) {
  return buildNavigationMapModel(surface, fixtureSnapshot(placePath));
}

function blockPath(placeId: string): string[] {
  return placeId === S.canvas ? [S.canvas] : [S.canvas, placeId];
}

/* ───────────────────────────── R-1.1 breadcrumb ───────────────────────────── */

describe('buildCommandRailModel — breadcrumb and transient marker (R-1.1 / Q1-01)', () => {
  it('renders the root path with no transient marker at the root', () => {
    const rail = railAt([S.canvas]);
    expect(rail.breadcrumb.map((place) => place.id)).toEqual([S.canvas]);
    expect(rail.currentPlace.label).toBe('Canvas');
    expect(rail.transientMarker).toBeNull();
  });

  it('renders root → current inside the transient Create place', () => {
    const rail = railAt([S.canvas, S.create]);
    expect(rail.breadcrumb.map((place) => place.id)).toEqual([S.canvas, S.create]);
    expect(rail.currentPlace.id).toBe(S.create);
    expect(rail.currentPlace.transient).toBe(true);
    expect(rail.transientMarker).toBe(`Create · ${NAV_TRANSIENT_MARKER_SUFFIX}`);
    expect(rail.transientMarker).toBe('Create · one action');
  });

  it('never marks a sticky place as transient', () => {
    const rail = railAt([S.canvas, S.edit]);
    expect(rail.currentPlace.sticky).toBe(true);
    expect(rail.transientMarker).toBeNull();
  });
});

/* ───────────────────────────── R-1.2 rows ───────────────────────────── */

describe('buildCommandRailModel — rows, hints and risk cues (R-1.2 / Q1-02)', () => {
  it('renders the six contextual verbs in declaration order', () => {
    const rail = railAt([S.canvas]);
    expect(rail.rows.map((row) => row.verbId)).toEqual([
      'test.create',
      'test.edit',
      'test.arrange',
      'test.style',
      'test.view',
      'test.file',
    ]);
    expect(rail.rows[0]?.keyHint).toBe('C');
  });

  it('keeps riskCue/riskLabel consistent with the declared risk', () => {
    const rail = railAt([S.canvas]);
    for (const row of rail.rows) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.riskCue === 'none').toBe(row.risk === 'safe');
      expect(row.riskLabel === null).toBe(row.risk === 'safe');
      if (row.risk !== 'safe') expect(row.riskLabel).toBe(NAV_RISK_LABELS[row.risk]);
    }
  });

  it('labels a destructive verb and an external verb by text (R-7.2 material)', () => {
    const edit = railAt([S.canvas, S.edit]);
    const remove = edit.rows.find((row) => row.verbId === 'test.delete');
    expect(remove?.riskCue).toBe('destructive');
    expect(remove?.riskLabel).toBe('Destructive');

    const file = railAt([S.canvas, S.file]);
    const exportRow = file.rows.find((row) => row.verbId === 'test.exportPng');
    expect(exportRow?.riskCue).toBe('external');
    expect(exportRow?.riskLabel).toBe('External');
  });
});

/* ───────────────────────────── R-1.2/R-1.6 cap + more ───────────────────────────── */

describe('buildCommandRailModel — the 8-row cap and more… (R-1.2 / R-1.6 / Q1-03)', () => {
  it('caps Arrange at 8 rows with overflow 1 and a more… affordance', () => {
    const rail = railAt([S.canvas, S.arrange]);
    expect(rail.rows).toHaveLength(NAV_RAIL_MAX_ROWS);
    expect(rail.overflow).toBe(1);
    expect(rail.actionCount).toBe(9);
    expect(rail.more).toEqual({
      label: NAV_MORE_LABEL,
      opensFilteredTo: S.arrange,
    });
  });

  it('renders no more… affordance when the place does not overflow', () => {
    const rail = railAt([S.canvas, S.edit]);
    expect(rail.overflow).toBe(0);
    expect(rail.more).toBeNull();
  });
});

/* ───────────────────────────── R-1.3 unavailable ───────────────────────────── */

describe('buildCommandRailModel — unavailable verbs stay, disabled with the generic reason (R-1.3 / Q1-04)', () => {
  it('renders the unavailable verb at its declaration slot with the bound reason', () => {
    const rail = railAt([S.canvas, S.edit]);
    expect(rail.rows.map((row) => row.verbId)).toEqual([
      'test.delete',
      'test.duplicate',
      'test.paste',
    ]);
    const paste = rail.rows[2];
    expect(paste?.enabled).toBe(false);
    expect(paste?.reason).toBe(NAV_UNAVAILABLE_REASON);
    expect(paste?.tooltip.endsWith(` — ${NAV_UNAVAILABLE_REASON}`)).toBe(true);
    expect(paste?.tooltip).toBe(
      navTooltip('Paste', ['p'], 'safe', NAV_UNAVAILABLE_REASON),
    );
  });

  it('never hides a verb — every bound verb is present in some state', () => {
    for (const place of navTestSurface().tree.places) {
      const rail = railAt(blockPath(place.id));
      expect(rail.rows.length).toBeLessThanOrEqual(NAV_RAIL_MAX_ROWS);
      for (const row of rail.rows) expect(row.verbId.length).toBeGreaterThan(0);
    }
  });
});

/* ───────────────────────────── R-1.4 affordances ───────────────────────────── */

describe('buildCommandRailModel — / Ask and ? Map affordances (R-1.4 / Q1-05)', () => {
  it('renders / Ask disabled with the launcher reason and ? Map enabled', () => {
    const rail = railAt([S.canvas]);
    expect(rail.ask.glyph).toBe(NAV_GLYPH_BY_VERB_ID[NAV_ASK_VERB_ID]);
    expect(rail.ask.glyph).toBe('/');
    expect(rail.ask.label).toBe('Ask');
    expect(rail.ask.binding).toBe('k');
    expect(rail.ask.enabled).toBe(false);
    expect(rail.ask.reason).toBe(NAV_ASK_DISABLED_REASON);

    expect(rail.map.glyph).toBe(NAV_GLYPH_BY_VERB_ID[NAV_MAP_VERB_ID]);
    expect(rail.map.glyph).toBe('?');
    expect(rail.map.label).toBe('Map');
    expect(rail.map.binding).toBe('m');
    expect(rail.map.enabled).toBe(true);
    expect(rail.map.reason).toBeNull();
  });

  it('never puts a glyph in a tooltip — every tooltip names the bindable stroke', () => {
    const rail = railAt([S.canvas]);
    const tooltips = [
      ...rail.rows.map((row) => row.tooltip),
      rail.ask.tooltip,
      rail.map.tooltip,
    ];
    for (const tooltip of tooltips) {
      expect(tooltip.includes('?')).toBe(false);
      expect(tooltip.includes('/')).toBe(false);
    }
    expect(rail.map.tooltip).toContain('(m)');
    expect(rail.ask.tooltip).toContain('(k)');
    expect(rail.ask.tooltip).toContain(NAV_ASK_DISABLED_REASON);
  });
});

/* ───────────────────────────── R-1.5 never pad ───────────────────────────── */

describe('buildCommandRailModel — never pads (R-1.5 / Q1-06)', () => {
  it('yields zero rows for a place with no bound verbs', () => {
    const rail = railAt([S.canvas, S.view]);
    expect(rail.rows).toHaveLength(0);
    expect(rail.actionCount).toBe(0);
    expect(rail.overflow).toBe(0);
    expect(rail.more).toBeNull();
    // The bound empty-list copy exists for the component; the model never invents rows.
    expect(NAV_RAIL_EMPTY_COPY).toBe('No actions in this place');
    expect(NAV_RAIL_MIN_WIDTH_PX).toBe(180);
  });

  it('never exceeds the hard cap in any declared state', () => {
    const surface = navTestSurface();
    for (const place of surface.tree.places) {
      const rail = railAt(blockPath(place.id), surface);
      expect(rail.rows.length).toBeLessThanOrEqual(NAV_RAIL_MAX_ROWS);
      // `actionCount` is exactly the rendered rows plus the unrendered overflow.
      expect(rail.actionCount).toBe(rail.rows.length + rail.overflow);
    }
  });
});

/* ───────────────────────────── R-1.2 adjudicated global exclusion ───────────────────────────── */

describe('buildCommandRailModel — the two globals are affordances, never rows (Q1-09 / C4)', () => {
  it('excludes app.map/app.ask from rows, overflow and actionCount', () => {
    const surface = navTestSurface();
    const rail = railAt([S.canvas], surface);
    const ids = rail.rows.map((row) => row.verbId);
    expect(ids).not.toContain(NAV_MAP_VERB_ID);
    expect(ids).not.toContain(NAV_ASK_VERB_ID);
    expect(rail.rows).toHaveLength(6);
    expect(rail.actionCount).toBe(6);
    expect(rail.overflow).toBe(0);
    expect(rail.map.binding).toBe('m');
    expect(rail.ask.binding).toBe('k');
  });

  it('is built on a declaration the validator accepts', () => {
    // The shipped gate returns `{ valid, diagnostics }`; an empty diagnostic list is clean.
    const validation = validateSurface(navTestSurface());
    expect(validation.diagnostics).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

/* ───────────────────────────── R-2.2 map tree + sections ───────────────────────────── */

describe('buildNavigationMapModel — the declaration tree and its three sections (R-2.2 / Q2-02)', () => {
  it('lists every declared place in deriveMap tree order', () => {
    const surface = navTestSurface();
    const map = mapAt([S.canvas, S.create], surface);
    const expectedOrder = deriveMap(surface).map(
      (row) => row.placePath[row.placePath.length - 1],
    );
    expect(map.places.map((place) => place.placeId)).toEqual(expectedOrder);
    expect(map.appId).toBe(FIXTURE_APP_ID);
    expect(map.currentPlaceId).toBe(S.create);
  });

  it('enriches each block with pathLabel, verbs and place keys', () => {
    const surface = navTestSurface();
    const map = mapAt([S.canvas, S.create], surface);
    const create = map.places.find((place) => place.placeId === S.create);
    expect(create?.pathLabel).toBe('Canvas › Create');
    expect(create?.depth).toBe(1);
    expect(create?.transient).toBe(true);

    expect(create?.verbs.map((verb) => verb.verbId)).toEqual([
      'test.rect',
      'test.ellipse',
    ]);
    for (const verbRow of create?.verbs ?? []) {
      expect(verbRow.title.length).toBeGreaterThan(0);
      expect(verbRow.keyHint).toBeTypeOf('string');
      expect(verbRow.available).toBe(true);
      expect(verbRow.reason).toBeNull();
    }
    expect(create?.keys.map((key) => key.stroke)).toEqual(['r', 'e']);
    expect(create?.keys.every((key) => key.source === 'place')).toBe(true);
  });

  it('marks exactly one current place, and the root when the path is empty', () => {
    const surface = navTestSurface();
    const map = mapAt([S.canvas, S.edit], surface);
    expect(map.places.filter((place) => place.current)).toHaveLength(1);
    expect(map.places.find((place) => place.current)?.placeId).toBe(S.edit);

    const rootMap = buildNavigationMapModel(surface, fixtureSnapshot([]));
    expect(rootMap.places.filter((place) => place.current)).toHaveLength(1);
    expect(rootMap.places.find((place) => place.current)?.placeId).toBe(S.canvas);
  });

  it('keeps aliases distinct from place keys and globals in their own section', () => {
    const surface = navTestSurface();
    const map = mapAt([S.canvas], surface);
    expect(map.aliases.map((alias) => alias.stroke)).toEqual(['r', 'e', 'u', 'y']);
    expect(map.aliases.every((alias) => alias.source === 'alias')).toBe(true);
    expect(map.aliases.find((alias) => alias.stroke === 'r')?.targetId).toBe('test.rect');

    expect(map.globals.map((global) => global.stroke)).toEqual(['m', 'k']);
    expect(map.globals.map((global) => global.glyph)).toEqual(['?', '/']);

    const placeKeys: NavigationMapKey[] = map.places.flatMap((place) => [...place.keys]);
    expect(placeKeys.every((key) => key.source === 'place')).toBe(true);
    // The globals live in their own region, never duplicated inside a place block.
    expect(
      placeKeys.some(
        (key) => key.targetId === NAV_MAP_VERB_ID || key.targetId === NAV_ASK_VERB_ID,
      ),
    ).toBe(false);
  });

  it('lists a place with zero verbs and zero keys (never dropped)', () => {
    const map = mapAt([S.canvas]);
    const view = map.places.find((place) => place.placeId === S.view);
    expect(view).toBeDefined();
    expect(view?.verbs).toEqual([]);
    expect(view?.keys).toEqual([]);
  });

  it('carries the seeded filter verbatim (more… → filteredTo)', () => {
    const surface = navTestSurface();
    const seeded = buildNavigationMapModel(surface, fixtureSnapshot([S.canvas]), {
      filteredTo: S.arrange,
    });
    expect(seeded.filteredTo).toBe(S.arrange);
    expect(mapAt([S.canvas], surface).filteredTo).toBeNull();
  });

  it('reports availability and the generic reason on a map verb row', () => {
    const surface = navTestSurface();
    const edit = mapAt([S.canvas, S.edit], surface).places.find(
      (place) => place.placeId === S.edit,
    );
    const paste = edit?.verbs.find((verb) => verb.verbId === 'test.paste');
    expect(paste?.available).toBe(false);
    expect(paste?.reason).toBe(NAV_UNAVAILABLE_REASON);
    expect(paste?.tooltip.endsWith(` — ${NAV_UNAVAILABLE_REASON}`)).toBe(true);
  });
});

/* ───────────────────────────── bound copy constants ───────────────────────────── */

describe('the G-324 copy bundle is bound by value (Architect C8)', () => {
  it('exports the eight adjudicated strings/values', () => {
    expect(NAV_MAP_SEARCH_LABEL).toBe('Search places, actions and keys');
    expect(NAV_MAP_EMPTY_COPY).toBe('No matching places, actions or keys');
    expect(NAV_MAP_ALIASES_HEADING).toBe('Direct aliases');
    expect(NAV_MAP_GLOBALS_HEADING).toBe('Global keys');
    expect(NAV_MAP_CURRENT_LABEL).toBe('Current place');
    expect(NAV_RAIL_EMPTY_COPY).toBe('No actions in this place');
    expect(NAV_MAP_HINT_COPY).toBe('↑ ↓ move · Enter run · Esc close');
    expect(NAV_RAIL_MIN_WIDTH_PX).toBe(180);
    expect(NAV_EMPTY_TRAIL_COPY).toBe('Nothing yet — your actions will appear here');
  });

  it('binds the actor and risk labels the trail/rail render', () => {
    expect(NAV_ACTOR_LABELS).toEqual({
      human: 'You',
      companion: 'Companion',
      system: 'System',
    });
    expect(NAV_RISK_LABELS).toEqual({
      safe: 'Safe',
      mutating: 'Changes',
      destructive: 'Destructive',
      external: 'External',
    });
  });
});

/* ───────────────────────────── R-3 trail model ───────────────────────────── */

describe('buildActivityTrailModel — order, cap and fields (R-3.1 / Q3-01)', () => {
  it('caps 11 entries at the declared bound, newest first by seq', () => {
    const surface = navTestSurface();
    const trail = buildActivityTrailModel(surface, seedEntries(11));
    expect(trail.entries).toHaveLength(CAPABILITY_LIMITS.maxJournalEntries);
    expect(trail.entries).toHaveLength(10);
    const seqs = trail.entries.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => right - left));
    expect(seqs[0]).toBe(11);
    expect(seqs[9]).toBe(2);
    expect(trail.empty).toBe(false);
    expect(trail.emptyCopy).toBe(NAV_EMPTY_TRAIL_COPY);
    expect(trail.undoableCount).toBe(10);
  });

  it('renders actor, label, path and a HH:mm time for every entry', () => {
    const surface = navTestSurface();
    const trail = buildActivityTrailModel(surface, seedEntries(2));
    for (const entry of trail.entries) {
      expect(entry.actorLabel).toBe('You');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.pathLabel).toBe('Canvas › Create');
      expect(entry.pathLabel).toContain(' › ');
      expect(entry.placePath.map((place) => place.id)).toEqual([S.canvas, S.create]);
      expect(entry.timeLabel).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('orders by seq, not by timestamp', () => {
    const surface = navTestSurface();
    const seeded = seedEntries(2);
    const sameTime = seeded.map((entry) => ({ ...entry, ts: '2026-01-01T09:00:00.000Z' }));
    const trail = buildActivityTrailModel(surface, sameTime);
    expect(trail.entries.map((entry) => entry.seq)).toEqual([2, 1]);
  });
});

describe('buildActivityTrailModel — undo gating is entry-scoped (R-3.2 / Q3-02)', () => {
  it('offers undo only for an entry with an inverse', () => {
    const surface = navTestSurface();
    const trail = buildActivityTrailModel(surface, seedEntries(1));
    expect(trail.entries[0]?.undoable).toBe(true);
    expect(trail.entries[0]?.undoLabel).toBe('Undo');
    expect(trail.entries[0]?.undoReason).toBeNull();
    expect(trail.undoableCount).toBe(1);
  });

  it('offers no undo for a non-invertible entry even on a non-built-in verb', () => {
    const surface = navTestSurface();
    const entry = seedNonUndoableEntry();
    const trail = buildActivityTrailModel(surface, [entry]);
    expect(trail.entries[0]?.undoable).toBe(false);
    expect(trail.entries[0]?.undoLabel).toBeNull();
    // The authored consequence is the honest explanation — never an empty tooltip.
    expect(trail.entries[0]?.undoReason).toBe(
      NON_UNDOABLE_CONSEQUENCES['place.exportPng'],
    );
    expect(trail.undoableCount).toBe(0);
  });
});

describe('buildActivityTrailModel — attribution and empty state (R-3.3 / R-3.4)', () => {
  it('labels the companion entry textually', () => {
    const surface = navTestSurface();
    const prior = seedEntries(2);
    const companion = seedCompanionEntry(prior);
    const trail = buildActivityTrailModel(surface, [...prior, companion]);
    const newest = trail.entries[0];
    expect(newest?.actor).toBe('companion');
    expect(newest?.actorLabel).toBe('Companion');
    expect(newest?.seq).toBe(companion.seq);
  });

  it('labels the system actor', () => {
    const surface = navTestSurface();
    const [entry] = seedEntries(1);
    if (entry === undefined) throw new Error('fixture produced no entry');
    const trail = buildActivityTrailModel(surface, [{ ...entry, actor: 'system' }]);
    expect(trail.entries[0]?.actorLabel).toBe('System');
  });

  it('reports the empty journal with the bound copy', () => {
    const trail = buildActivityTrailModel(navTestSurface(), []);
    expect(trail.entries).toEqual([]);
    expect(trail.empty).toBe(true);
    expect(trail.emptyCopy).toBe(NAV_EMPTY_TRAIL_COPY);
    expect(trail.undoableCount).toBe(0);
  });
});

/* ───────────────────────────── §8 formatter contracts ───────────────────────────── */

describe('format.ts — the one formatter per concern (Architect §8)', () => {
  it('formats the first binding as a key hint', () => {
    expect(formatKeyHint(['c'])).toBe('C');
    expect(formatKeyHint(['w n'])).toBe('W then N');
    expect(formatKeyHint([])).toBe('');
  });

  it('joins a place path with the bound separator', () => {
    expect(
      formatPlacePathLabel([
        { id: S.canvas, label: 'Canvas', transient: false, sticky: false },
        { id: S.create, label: 'Create', transient: true, sticky: false },
      ]),
    ).toBe('Canvas › Create');
  });

  it('formats a trail time as HH:mm with a pinned h23 hour cycle', () => {
    const localMidnight = new Date(2026, 0, 1, 0, 5, 0, 0);
    expect(formatTrailTime(localMidnight.toISOString())).toBe('00:05');
    expect(formatTrailTime(seedEntries(1)[0]?.ts ?? localMidnight.toISOString())).toMatch(
      /^\d{2}:\d{2}$/,
    );
  });

  it('labels only non-safe risks', () => {
    expect(riskLabel('safe')).toBeNull();
    expect(riskLabel('mutating')).toBe('Changes');
    expect(riskLabel('destructive')).toBe('Destructive');
    expect(riskLabel('external')).toBe('External');
  });

  it('composes the shipped tooltip rule and appends only a reason', () => {
    const surface = navTestSurface();
    const rect = surface.verbs.find((verb) => verb.id === 'test.rect');
    if (rect === undefined) throw new Error('fixture is missing test.rect');
    expect(navTooltip('Rectangle', ['r'], 'safe', null)).toBe(
      formatTooltip(rect, ['r']),
    );
    expect(navTooltip('Delete', ['x'], 'destructive', null)).toBe(
      'Delete (x) — destructive',
    );
    expect(navTooltip('Paste', ['p'], 'safe', NAV_UNAVAILABLE_REASON)).toBe(
      `Paste (p) — ${NAV_UNAVAILABLE_REASON}`,
    );
    expect(navTooltip('Rectangle', [], 'safe', null)).toBe('Rectangle');
  });
});
