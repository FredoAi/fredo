/**
 * Spec #3118 (P4), ST-4 — `ActivityTrail` render pins (AC3 / R-3.1…R-3.5; QA Q3-01…Q3-05).
 *
 * Every case renders the model produced by the ST-1 projection (`buildActivityTrailModel`)
 * from the declared fixture surface (D1) and the deterministic journal builders (D4) — never a
 * hand-written entry list — so the surface is proven to render what the projection decides and
 * nothing it does not. Expected copy and hooks come from the bound constants.
 *
 * The undo negative is the TRAP: a verb outside the five built-in non-undoable ids returns
 * `undoAffordance(verbId).disabled === false`, yet an entry with `inverse === null` MUST get no
 * control. Only `entry.undoable` may gate it (R-3.2).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import {
  NON_UNDOABLE_CONSEQUENCES,
  undoAffordance,
  type JournalEntry,
} from '../../';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ActivityTrail, type ActivityTrailProps } from '../ActivityTrail';
import {
  NAV_ACTOR_ATTR,
  NAV_ACTOR_LABELS,
  NAV_COMPACT_ATTR,
  NAV_EMPTY_TRAIL_COPY,
  NAV_SURFACE_ATTR,
  NAV_TRAIL_ACTOR_TESTID,
  NAV_TRAIL_ARIA_LABEL,
  NAV_TRAIL_EMPTY_TESTID,
  NAV_TRAIL_ENTRY_TESTID,
  NAV_TRAIL_PATH_TESTID,
  NAV_TRAIL_TESTID,
  NAV_TRAIL_TIME_TESTID,
  NAV_TRAIL_UNDO_TESTID,
} from '../constants';
import { buildActivityTrailModel } from '../models';
import type { ActivityTrailModel } from '../types';
import {
  FIXTURE_PLACES,
  fixtureTimestamp,
  navTestSurface,
  seedCompanionEntry,
  seedEntries,
  seedNonUndoableEntry,
} from './fixtures';

const S = FIXTURE_PLACES;

afterEach(cleanup);

/** The projection the surface renders, over the fixture declaration. */
function trailModel(entries: readonly JournalEntry[]): ActivityTrailModel {
  return buildActivityTrailModel(navTestSurface(), entries);
}

/** A well-formed journal entry for the edge cases the D4 builders do not cover. */
function journalEntry(overrides: Partial<JournalEntry> & { readonly seq: number }): JournalEntry {
  return {
    ts: fixtureTimestamp(0),
    verbId: 'test.rect',
    actor: 'human',
    channel: 'keyboard',
    label: 'Rectangle',
    effect: 'mutation',
    placePath: [S.canvas, S.create],
    target: [],
    patch: { before: {}, after: {} },
    inverse: null,
    undoable: false,
    external: false,
    consequence: null,
    exitedBy: 'none',
    coalesceKey: null,
    groupId: null,
    ...overrides,
    seq: overrides.seq,
  };
}

function renderTrail(
  entries: readonly JournalEntry[],
  props: Partial<Omit<ActivityTrailProps, 'model'>> = {},
) {
  return renderWithChakra(
    <ActivityTrail model={trailModel(entries)} onUndo={() => undefined} {...props} />,
  );
}

/* ───────────────────────── Q3-01 — order, cap and fields (R-3.1) ───────────────────────── */

describe('ActivityTrail — newest first with actor, label, path and time (Q3-01)', () => {
  it('renders 11 journal entries as the newest 10 in seq DESC order', () => {
    const model = trailModel(seedEntries(11));
    expect(model.entries).toHaveLength(10);
    expect(model.entries.map((entry) => entry.seq)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);

    renderTrail(seedEntries(11));
    const rows = screen.getAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(rows).toHaveLength(10);
    // Newest-first: the newest label leads and the oldest (seq 1) is capped away.
    expect(rows[0]).toHaveTextContent('Rectangle 11');
    expect(rows[9]).toHaveTextContent('Rectangle 2');
    expect(screen.queryByText('Rectangle 1')).toBeNull();
  });

  it('exposes actor, label, place path and time on every entry', () => {
    renderTrail(seedEntries(2));
    const row = screen.getAllByTestId(NAV_TRAIL_ENTRY_TESTID)[0] as HTMLElement;

    expect(within(row).getByTestId(NAV_TRAIL_ACTOR_TESTID).textContent).toBe(
      NAV_ACTOR_LABELS.human,
    );
    expect(row).toHaveTextContent('Rectangle 2');

    const path = within(row).getByTestId(NAV_TRAIL_PATH_TESTID);
    expect(path.textContent).toBe('Canvas › Create');
    expect(path.textContent).toContain(' › ');

    expect(within(row).getByTestId(NAV_TRAIL_TIME_TESTID).textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  it('orders by seq DESC when every timestamp is equal (seq wins over ts)', () => {
    const equalTimestamps = seedEntries(3).map((entry) => ({
      ...entry,
      ts: fixtureTimestamp(5),
    }));
    const model = trailModel(equalTimestamps);
    expect(model.entries.map((entry) => entry.seq)).toEqual([3, 2, 1]);
    expect(model.entries.map((entry) => entry.label)).toEqual([
      'Rectangle 3',
      'Rectangle 2',
      'Rectangle 1',
    ]);

    renderTrail(equalTimestamps);
    const rows = screen.getAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(rows.map((row) => row.textContent?.includes('Rectangle 3'))).toContain(true);
    expect(rows[0]).toHaveTextContent('Rectangle 3');
  });
});

/* ───────────────────────── Q3-02 — honest undo gating (R-3.2) ───────────────────────── */

describe('ActivityTrail — undo is gated by the entry (Q3-02)', () => {
  it('renders an undo control with the bound label for an undoable entry', () => {
    const onUndo = vi.fn();
    const model = trailModel(seedEntries(3));
    expect(model.entries[0]?.undoable).toBe(true);
    expect(model.entries[0]?.undoLabel).toBe('Undo');

    renderTrail(seedEntries(3), { onUndo });
    const undoButtons = screen.getAllByTestId(NAV_TRAIL_UNDO_TESTID);
    expect(undoButtons).toHaveLength(3);
    expect(undoButtons[0]).toHaveTextContent('Undo');

    fireEvent.click(undoButtons[0] as HTMLElement);
    // The per-entry control reports ITS seq (the newest, 3) — never a generic "last" marker.
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith(3);
  });

  it('NEGATIVE: a non-built-in verb with inverse === null still gets no control', () => {
    const model = trailModel([seedNonUndoableEntry()]);
    const entry = model.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    // The trap: the verb-keyed affordance would allow undo…
    expect(undoAffordance(entry.verbId).disabled).toBe(false);
    // …but the entry has no inverse, so the entry is the authority.
    expect(entry.undoable).toBe(false);
    expect(entry.undoLabel).toBeNull();

    renderTrail([seedNonUndoableEntry()]);
    expect(screen.queryByTestId(NAV_TRAIL_UNDO_TESTID)).toBeNull();
  });

  it('a non-undoable verb renders its authored consequence text and no control', () => {
    // The fixture's external verb authors the shipped consequence at dispatch (D1/D4).
    const entries = [
      journalEntry({
        seq: 1,
        verbId: 'test.exportPng',
        label: 'Export PNG',
        external: true,
        consequence: NON_UNDOABLE_CONSEQUENCES['place.exportPng'],
      }),
    ];
    const model = trailModel(entries);
    const entry = model.entries[0];
    expect(entry?.undoable).toBe(false);
    expect(entry?.undoReason).toBe(NON_UNDOABLE_CONSEQUENCES['place.exportPng']);

    renderTrail(entries);
    const row = screen.getByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(screen.queryByTestId(NAV_TRAIL_UNDO_TESTID)).toBeNull();
    expect(
      within(row).getByText(NON_UNDOABLE_CONSEQUENCES['place.exportPng']),
    ).toBeInTheDocument();
  });

  it('falls back to the shipped built-in consequence when the entry authors none', () => {
    const entries = [journalEntry({ seq: 1, verbId: 'place.exportPng', label: 'Export PNG' })];
    const model = trailModel(entries);
    expect(model.entries[0]?.undoable).toBe(false);
    expect(model.entries[0]?.undoReason).toBe(NON_UNDOABLE_CONSEQUENCES['place.exportPng']);

    renderTrail(entries);
    expect(screen.queryByTestId(NAV_TRAIL_UNDO_TESTID)).toBeNull();
    expect(
      screen.getByText(NON_UNDOABLE_CONSEQUENCES['place.exportPng']),
    ).toBeInTheDocument();
  });

  it('renders nothing extra when the non-undoable explanation is empty', () => {
    const entries = [
      journalEntry({ seq: 1, verbId: 'test.rect', inverse: null, consequence: '   ' }),
    ];
    const model = trailModel(entries);
    expect(model.entries[0]?.undoable).toBe(false);
    expect(model.entries[0]?.undoReason).toBeNull();

    const { container } = renderTrail(entries);
    expect(screen.queryByTestId(NAV_TRAIL_UNDO_TESTID)).toBeNull();
    // No consequence icon and no empty text: the human row carries no SVG at all.
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('a mixed journal renders exactly one control — on the undoable entry', () => {
    const base = seedEntries(1);
    const entries = [...base, seedNonUndoableEntry(base)];
    const model = trailModel(entries);
    expect(model.entries).toHaveLength(2);
    expect(model.undoableCount).toBe(1);

    renderTrail(entries);
    const undoButtons = screen.getAllByTestId(NAV_TRAIL_UNDO_TESTID);
    expect(undoButtons).toHaveLength(1);
    const rows = screen.getAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    // Newest first: the non-undoable row leads, the undoable one follows.
    expect(within(rows[0] as HTMLElement).queryByTestId(NAV_TRAIL_UNDO_TESTID)).toBeNull();
    expect(
      within(rows[1] as HTMLElement).getByTestId(NAV_TRAIL_UNDO_TESTID),
    ).toBeInTheDocument();
  });
});

/* ───────────────────────── Q3-03 — the empty journal (R-3.3) ───────────────────────── */

describe('ActivityTrail — empty state (Q3-03)', () => {
  it('renders exactly the bound empty copy and no entries', () => {
    const model = trailModel([]);
    expect(model.empty).toBe(true);
    expect(model.emptyCopy).toBe(NAV_EMPTY_TRAIL_COPY);

    renderTrail([]);
    expect(screen.getByTestId(NAV_TRAIL_EMPTY_TESTID).textContent).toBe(NAV_EMPTY_TRAIL_COPY);
    expect(screen.queryAllByTestId(NAV_TRAIL_ENTRY_TESTID)).toHaveLength(0);
  });

  it('a journal holding only navigation entries is not empty', () => {
    const entries = [
      journalEntry({ seq: 1, effect: 'navigation', label: 'Opened Arrange' }),
    ];
    const model = trailModel(entries);
    expect(model.empty).toBe(false);

    renderTrail(entries);
    expect(screen.queryByTestId(NAV_TRAIL_EMPTY_TESTID)).toBeNull();
    expect(screen.getAllByTestId(NAV_TRAIL_ENTRY_TESTID)).toHaveLength(1);
    expect(screen.getByTestId(NAV_TRAIL_ENTRY_TESTID)).toHaveTextContent('Opened Arrange');
  });
});

/* ───────────────────────── Q3-04 — textual attribution (R-3.4) ───────────────────────── */

describe('ActivityTrail — attribution is text AND attribute, never colour (Q3-04)', () => {
  it('attributes a companion entry as Companion via label text and data-nav-actor', () => {
    const entries = [seedCompanionEntry()];
    const model = trailModel(entries);
    expect(model.entries[0]?.actor).toBe('companion');
    expect(model.entries[0]?.actorLabel).toBe(NAV_ACTOR_LABELS.companion);

    renderTrail(entries);
    const row = screen.getByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(row).toHaveAttribute(NAV_ACTOR_ATTR, 'companion');
    expect(within(row).getByTestId(NAV_TRAIL_ACTOR_TESTID).textContent).toBe('Companion');
  });

  it('attributes a human entry as You and a system entry as System', () => {
    renderTrail(seedEntries(1));
    const humanRow = screen.getByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(humanRow).toHaveAttribute(NAV_ACTOR_ATTR, 'human');
    expect(within(humanRow).getByTestId(NAV_TRAIL_ACTOR_TESTID).textContent).toBe('You');
    cleanup();

    const systemEntry = journalEntry({
      seq: 1,
      actor: 'system',
      label: 'Undo Rectangle',
    });
    expect(trailModel([systemEntry]).entries[0]?.actorLabel).toBe(NAV_ACTOR_LABELS.system);

    renderTrail([systemEntry]);
    const systemRow = screen.getByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(systemRow).toHaveAttribute(NAV_ACTOR_ATTR, 'system');
    expect(within(systemRow).getByTestId(NAV_TRAIL_ACTOR_TESTID).textContent).toBe('System');
  });

  it('attributes two companion entries independently of position', () => {
    const first = seedCompanionEntry();
    const second = seedCompanionEntry([first]);
    const entries = [first, second];

    renderTrail(entries);
    const rows = screen.getAllByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toHaveAttribute(NAV_ACTOR_ATTR, 'companion');
      expect(within(row).getByTestId(NAV_TRAIL_ACTOR_TESTID).textContent).toBe('Companion');
    }
  });
});

/* ───────────────────────── Q3-05 — compact mode (R-3.5) ───────────────────────── */

describe('ActivityTrail — compact mode (Q3-05)', () => {
  it('flags the root and omits path + time while keeping actor, label and undo', () => {
    renderTrail(seedEntries(1), { compact: true });
    const root = screen.getByTestId(NAV_TRAIL_TESTID);
    expect(root).toHaveAttribute(NAV_COMPACT_ATTR, 'true');
    expect(screen.queryByTestId(NAV_TRAIL_PATH_TESTID)).toBeNull();
    expect(screen.queryByTestId(NAV_TRAIL_TIME_TESTID)).toBeNull();

    const row = screen.getByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(within(row).getByTestId(NAV_TRAIL_ACTOR_TESTID).textContent).toBe('You');
    expect(row).toHaveTextContent('Rectangle 1');
    expect(within(row).getByTestId(NAV_TRAIL_UNDO_TESTID)).toBeInTheDocument();
  });

  it('renders path + time and no compact marker when compact is false', () => {
    renderTrail(seedEntries(1), { compact: false });
    const root = screen.getByTestId(NAV_TRAIL_TESTID);
    expect(root).not.toHaveAttribute(NAV_COMPACT_ATTR);
    expect(screen.getByTestId(NAV_TRAIL_PATH_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(NAV_TRAIL_TIME_TESTID)).toBeInTheDocument();
  });

  it('keeps the empty copy and no entries in compact mode', () => {
    renderTrail([], { compact: true });
    expect(screen.getByTestId(NAV_TRAIL_TESTID)).toHaveAttribute(NAV_COMPACT_ATTR, 'true');
    expect(screen.getByTestId(NAV_TRAIL_EMPTY_TESTID).textContent).toBe(NAV_EMPTY_TRAIL_COPY);
    expect(screen.queryAllByTestId(NAV_TRAIL_ENTRY_TESTID)).toHaveLength(0);
  });

  it('keeps the actor and label but no control for a compact non-undoable entry', () => {
    renderTrail([seedNonUndoableEntry()], { compact: true });
    const row = screen.getByTestId(NAV_TRAIL_ENTRY_TESTID);
    expect(within(row).getByTestId(NAV_TRAIL_ACTOR_TESTID).textContent).toBe('You');
    expect(row).toHaveTextContent('Rectangle');
    expect(screen.queryByTestId(NAV_TRAIL_UNDO_TESTID)).toBeNull();
    expect(screen.queryByTestId(NAV_TRAIL_PATH_TESTID)).toBeNull();
    expect(screen.queryByTestId(NAV_TRAIL_TIME_TESTID)).toBeNull();
  });
});

/* ───────────────────────── structural invariants (R-3 / composition) ───────────────────────── */

describe('ActivityTrail — labelled region root', () => {
  it('is one labelled region on the trail surface with a non-empty journal', () => {
    renderTrail(seedEntries(1));
    const root = screen.getByRole('region', { name: NAV_TRAIL_ARIA_LABEL });
    expect(root).toBe(screen.getByTestId(NAV_TRAIL_TESTID));
    expect(root).toHaveAttribute(NAV_SURFACE_ATTR, 'trail');
  });

  it('advertises no live region of its own', () => {
    renderTrail(seedEntries(1));
    expect(screen.getByTestId(NAV_TRAIL_TESTID).querySelector('[aria-live]')).toBeNull();
  });
});
