/**
 * Spec #3118 (P4), ST-5 — the NavigationHost pins (QA Q4-01…Q4-05, N-04, and the per-entry
 * undo leg of Q3-06).
 *
 * The host is the ONE stateful seam: it resolves strokes through the shipped `resolveStroke`,
 * dispatches through the shipped `dispatch`, rebuilds its snapshot ONLY on a mutation (one
 * epoch advance each) and emits AT MOST ONE announcement per call, always through the bound
 * composers. `undoEntry(seq)` is the per-entry undo the trail wires to — it reverts the
 * SELECTED entry (not the newest), mirroring `dispatchUndo` for exactly one entry.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import {
  NOTHING_TO_UNDO,
  createJournalStore,
  resolveStroke,
  type ContextSnapshot,
  type JsonPatch,
  type JournalStore,
  type KeyBinding,
  type Surface,
} from '../../';
import {
  getNavigationAnnouncement,
  navAmbiguousKeyMessage,
  navPlaceEnterMessage,
  navPlaceExitMessage,
  navPrefixMessage,
  navUnavailableKeyMessage,
  resetNavigationAnnouncer,
  subscribeNavigationAnnouncement,
} from '../announce';
import { createNavigationHost, useNavigationHostSnapshot, type NavigationHost } from '../host';
import {
  FIXTURE_PLACES,
  fixtureSelection,
  fixtureSnapshot,
  fixtureTimestamp,
  navTestSurface,
  seedEntries,
  seedNonUndoableEntry,
} from './fixtures';
import { publishedWireframeSurface } from '../../__tests__/fixtures';

/* ───────────────────────────── harness ───────────────────────────── */

interface Harness {
  readonly host: NavigationHost;
  readonly journal: JournalStore;
  readonly applied: JsonPatch[];
  readonly announcements: string[];
  failNextUndo: () => void;
}

const disposers: Array<() => void> = [];
const extraNodes: Element[] = [];

function createHarness(
  surface: Surface = navTestSurface(),
  journal: JournalStore = createJournalStore(),
): Harness {
  const applied: JsonPatch[] = [];
  const announcements: string[] = [];
  let failNext = false;

  disposers.push(
    subscribeNavigationAnnouncement(() => {
      announcements.push(getNavigationAnnouncement());
    }),
  );

  const host = createNavigationHost({
    surface,
    getContext: () => fixtureSnapshot([FIXTURE_PLACES.canvas]),
    journal,
    now: () => fixtureTimestamp(0),
    applyPatch: (patch) => {
      if (failNext) {
        failNext = false;
        throw new Error('applyPatch failed');
      }
      applied.push(patch);
    },
    confirm: () => true,
  });

  return {
    host,
    journal,
    applied,
    announcements,
    failNextUndo: () => {
      failNext = true;
    },
  };
}

function verb(value: string): KeyBinding {
  return { kind: 'verb', verbId: value };
}

/** Add strokes to one place's declared keys (immutably). */
function withKeys(
  surface: Surface,
  placeId: string,
  extra: Readonly<Record<string, KeyBinding>>,
): Surface {
  return {
    ...surface,
    tree: {
      ...surface.tree,
      places: surface.tree.places.map((place) =>
        place.id === placeId ? { ...place, keys: { ...place.keys, ...extra } } : place,
      ),
    },
  };
}

/** Q4-02 — a two-stroke prefix (`w n`, `w p`) on the root place. */
function withPrefixBindings(surface: Surface): Surface {
  return withKeys(surface, FIXTURE_PLACES.canvas, {
    'w n': verb('test.view'),
    'w p': verb('test.style'),
  });
}

/** Q4-03 — a second binding for the already-bound `x` stroke (normalizes to the same key). */
function withAmbiguity(surface: Surface): Surface {
  return withKeys(surface, FIXTURE_PLACES.edit, { 'x ': verb('test.duplicate') });
}

function EpochProbe(props: { readonly host: NavigationHost; readonly tick: number }) {
  const snapshot = useNavigationHostSnapshot(props.host);
  return React.createElement(
    'span',
    { 'data-testid': 'epoch-probe' },
    `${props.tick}:${snapshot.epoch}`,
  );
}

beforeEach(() => {
  resetNavigationAnnouncer();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  cleanup();
  for (const node of extraNodes.splice(0)) node.remove();
  resetNavigationAnnouncer();
});

/* ───────────────────────── N-04 — the epoch ───────────────────────── */

describe('N-04 — stable snapshot, one epoch advance per mutation, zero per render', () => {
  it('getSnapshot() returns the same object between mutations', () => {
    const harness = createHarness();
    expect(harness.host.getSnapshot()).toBe(harness.host.getSnapshot());
    expect(harness.host.getSnapshot().epoch).toBe(0);
  });

  it('one dispatch advances epoch by exactly 1; five re-renders advance it 0', async () => {
    const harness = createHarness();
    const view = render(
      React.createElement(EpochProbe, { host: harness.host, tick: 0 }),
    );
    expect(view.getByTestId('epoch-probe')).toHaveTextContent('0:0');

    await act(async () => {
      await harness.host.handleStroke('c', 1000);
    });
    expect(harness.host.getSnapshot().epoch).toBe(1);
    expect(view.getByTestId('epoch-probe')).toHaveTextContent('0:1');

    for (let tick = 1; tick <= 5; tick += 1) {
      view.rerender(React.createElement(EpochProbe, { host: harness.host, tick }));
    }
    expect(harness.host.getSnapshot().epoch).toBe(1);
    expect(view.getByTestId('epoch-probe')).toHaveTextContent('5:1');
  });
});

/* ───────────────────────── N-04b — context freshness (R-1.1 root leg) ───────────────────────── */

/**
 * Spec #3120 (P6), ST-1-R3 — the host seam that publishes a store-only context change. The
 * launcher memo keys on `epoch`; without this advance a root-place selection never reaches the
 * header or the companion grounding envelope (the round-3 defect). `describeContext()` was
 * already fresh — the missing piece was the notification.
 */
describe('N-04b — context freshness (R-1.1 root leg)', () => {
  function createContextHost(getContext: () => ContextSnapshot): NavigationHost {
    return createNavigationHost({
      surface: navTestSurface(),
      getContext,
      journal: createJournalStore(),
      now: () => fixtureTimestamp(0),
      applyPatch: () => undefined,
      confirm: () => true,
    });
  }

  it('refreshContext commits ONE epoch and rebuilds the snapshot when the injected context changed', () => {
    const announcements: string[] = [];
    disposers.push(
      subscribeNavigationAnnouncement(() => {
        announcements.push(getNavigationAnnouncement());
      }),
    );

    let current = fixtureSnapshot();
    const host = createContextHost(() => current);
    expect(host.getSnapshot().epoch).toBe(0);
    const before = host.getSnapshot();

    current = fixtureSnapshot([FIXTURE_PLACES.canvas], {
      selection: fixtureSelection({
        count: 1,
        ids: ['e1'],
        kinds: ['shape'],
        label: 'Rectangle',
      }),
    });
    host.refreshContext();

    expect(host.getSnapshot()).not.toBe(before);
    expect(host.getSnapshot().epoch).toBe(1);
    expect(host.getSnapshot().context.selection.count).toBe(1);
    expect(host.describeContext().selection.label).toBe('Rectangle');
    // The refresh is SILENT: no announcement is composed or emitted.
    expect(host.getSnapshot().announcement).toBe('');
    expect(announcements).toHaveLength(0);
  });

  it('refreshContext is a silent no-op for a value-equal context (fresh object each call)', () => {
    const host = createContextHost(() => fixtureSnapshot());
    const before = host.getSnapshot();

    host.refreshContext();
    host.refreshContext();

    // Value fingerprinting, not reference identity — every `getContext()` call is a new object.
    expect(host.getSnapshot()).toBe(before);
    expect(host.getSnapshot().epoch).toBe(0);
  });

  it('describeContext never advances the epoch', () => {
    let current = fixtureSnapshot();
    const host = createContextHost(() => current);
    const before = host.getSnapshot();

    current = fixtureSnapshot([FIXTURE_PLACES.canvas], {
      selection: fixtureSelection({ count: 1, ids: ['e1'], kinds: ['shape'], label: 'Rectangle' }),
    });
    host.describeContext();
    host.describeContext();

    expect(host.getSnapshot()).toBe(before);
    expect(host.getSnapshot().epoch).toBe(0);
    // The read itself is FRESH — only the notification was missing without refreshContext().
    expect(host.describeContext().selection.count).toBe(1);
  });
});

/* ───────────────────────── Q4-01 — place enter / exit ───────────────────────── */

describe('Q4-01 — place enter/exit announcements (R-4.1)', () => {
  it('entering a place announces once; popping a level announces the exit once', async () => {
    const harness = createHarness();

    const entered = await harness.host.handleStroke('c', 1000);
    expect(entered?.status).toBe('performed');
    expect(harness.host.getSnapshot().context.placePath).toEqual([
      FIXTURE_PLACES.canvas,
      FIXTURE_PLACES.create,
    ]);
    expect(harness.host.getSnapshot().announcement).toBe(navPlaceEnterMessage('Create', 2));
    expect(harness.announcements).toEqual(['Create — 2 actions']);

    await harness.host.handleStroke('Escape', 1000);
    expect(harness.host.getSnapshot().context.placePath).toEqual([FIXTURE_PLACES.canvas]);
    expect(harness.host.getSnapshot().announcement).toBe(
      navPlaceExitMessage('Create', 'Canvas', 6),
    );
    expect(harness.announcements).toEqual([
      'Create — 2 actions',
      'Left Create — Canvas — 6 actions',
    ]);
  });

  it('the announcement count is the rail model actionCount (bound verbs, not available)', async () => {
    const harness = createHarness();
    await harness.host.handleStroke('i', 1000);
    // Edit binds x/d/p; `test.paste` is unavailable in the default fixture snapshot.
    expect(harness.host.getSnapshot().announcement).toBe('Edit — 3 actions');
    expect(harness.announcements).toHaveLength(1);
  });
});

/* ───────────────────────── Q4-02 — the armed prefix ───────────────────────── */

describe('Q4-02 — prefix arm/timeout (R-4.2)', () => {
  it('arming announces the prefix + continuations; a timeout announces nothing', async () => {
    const harness = createHarness(withPrefixBindings(navTestSurface()));

    await harness.host.handleStroke('w', 0);
    expect(harness.host.getSnapshot().pending?.sequence).toBe('w');
    expect(harness.host.getSnapshot().announcement).toBe(
      navPrefixMessage('w', ['View', 'Style']),
    );
    expect(harness.announcements).toEqual(['w… View, Style']);

    // A stroke at/after PENDING_TIMEOUT_MS clears the prefix SILENTLY (Q4-02).
    await harness.host.handleStroke('w', 1000);
    expect(harness.host.getSnapshot().pending).toBeNull();
    expect(harness.announcements).toEqual(['w… View, Style']);

    // Re-arming the same prefix announces the identical text once (dedupe, not twice).
    await harness.host.handleStroke('w', 1000);
    expect(harness.host.getSnapshot().pending?.sequence).toBe('w');
    expect(harness.announcements).toEqual(['w… View, Style']);
  });

  it('Escape cancels an armed prefix without announcing', async () => {
    const harness = createHarness(withPrefixBindings(navTestSurface()));

    await harness.host.handleStroke('w', 0);
    await harness.host.handleStroke('Escape', 100);

    expect(harness.host.getSnapshot().pending).toBeNull();
    expect(harness.announcements).toEqual(['w… View, Style']);
  });
});

/* ───────────────────────── Q4-03 — no match / ambiguous ───────────────────────── */

describe('Q4-03 — unresolvable and ambiguous strokes (R-4.3)', () => {
  it('a tier-4 no-match announces the unavailable key exactly once', async () => {
    const harness = createHarness();

    await harness.host.handleStroke('z', 1000);
    expect(harness.host.getSnapshot().announcement).toBe(navUnavailableKeyMessage('z'));
    expect(harness.announcements).toEqual(["z isn't available here"]);
  });

  it('normalizes an uppercase stroke before composing the message', async () => {
    const harness = createHarness();

    await harness.host.handleStroke('Q', 1000);
    expect(harness.announcements).toEqual(["q isn't available here"]);
  });

  it('an ambiguous binding announces the ambiguous message and never the no-match one', async () => {
    const harness = createHarness(withAmbiguity(navTestSurface()));

    await harness.host.handleStroke('i', 1000); // enter Edit
    await harness.host.handleStroke('x', 1000); // x → Delete AND Duplicate

    expect(harness.announcements).toEqual([
      navPlaceEnterMessage('Edit', 3),
      navAmbiguousKeyMessage('x'),
    ]);
    expect(harness.announcements).not.toContain(navUnavailableKeyMessage('x'));
  });

  it('root Escape and a passthrough owner announce nothing', async () => {
    const harness = createHarness();

    const result = await harness.host.handleStroke('Escape', 1000);
    expect(result).toBeNull();
    expect(harness.host.getSnapshot().epoch).toBe(0);
    expect(harness.announcements).toHaveLength(0);

    // §5 fixes `keyboardOwner: 'engine'`, so a non-engine owner (passthrough) can never reach
    // the host's dispatch branch — the total-function guard emits nothing.
    expect(
      resolveStroke({
        surface: navTestSurface(),
        placePath: [FIXTURE_PLACES.canvas],
        pending: null,
        stroke: 'c',
        nowMs: 0,
        keyboardOwner: 'terminal',
      }),
    ).toEqual({ status: 'passthrough' });
  });
});

/* ───────────────────────── Q4-04 — undo outcomes ───────────────────────── */

describe('Q4-04 — undo success / nothing / failure (R-4.4)', () => {
  it('a successful undo announces the undone label exactly once', async () => {
    const harness = createHarness();

    await harness.host.runVerb('test.rect');
    expect(harness.announcements).toHaveLength(0); // a plain mutation announces nothing

    const result = await harness.host.undoLast();
    expect(result.status).toBe('performed');
    expect(harness.host.getSnapshot().announcement).toBe('Undid Rectangle');
    expect(harness.announcements).toEqual(['Undid Rectangle']);
  });

  it('an empty journal announces the shipped nothing-to-undo sentence once', async () => {
    const harness = createHarness();

    const result = await harness.host.undoLast();
    expect(result).toEqual({ status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO });
    expect(harness.announcements).toEqual(['Nothing to undo.']);
  });

  it('a failed inverse announces the failure once (partial, nothing applied)', async () => {
    const harness = createHarness();
    await harness.host.runVerb('test.rect');

    harness.failNextUndo();
    const result = await harness.host.undoLast();

    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.code).toBe('undo-failed');
      expect(result.applied).toBe(0);
    }
    expect(harness.announcements).toEqual(["Couldn't undo Rectangle"]);
  });
});

/* ───────────────────────── Q4-05 — text-entry silence ───────────────────────── */

describe('Q4-05 — text-entry focus resolves nothing and announces nothing (R-4.5)', () => {
  it('the active text control silences the stroke entirely', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    extraNodes.push(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const harness = createHarness();
    const result = await harness.host.handleStroke('c', 1000);

    expect(result).toBeNull();
    expect(harness.journal.entries()).toHaveLength(0);
    expect(harness.host.getSnapshot().pending).toBeNull();
    expect(harness.host.getSnapshot().epoch).toBe(0);
    expect(harness.announcements).toHaveLength(0);
  });

  it('contenteditable and role="textbox" targets are text controls too', async () => {
    const harness = createHarness();

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    extraNodes.push(editable);

    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    document.body.appendChild(textbox);
    extraNodes.push(textbox);

    expect(await harness.host.handleStroke('c', 1000, { target: editable })).toBeNull();
    expect(await harness.host.handleStroke('c', 1000, { target: textbox })).toBeNull();
    expect(harness.journal.entries()).toHaveLength(0);
    expect(harness.announcements).toHaveLength(0);
  });

  it('a focused non-text control still resolves strokes', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    extraNodes.push(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const harness = createHarness();
    const result = await harness.host.handleStroke('c', 1000);

    expect(result?.status).toBe('performed');
    expect(harness.announcements).toEqual([navPlaceEnterMessage('Create', 2)]);
  });
});

/* ───────────────────────── per-entry undo (Q3-06 unit leg) ───────────────────────── */

describe('undoEntry(seq) — reverts THAT entry, never the newest', () => {
  it('reverts the oldest undoable entry while the newest is untouched', async () => {
    const entries = seedEntries(3); // seq 1, 2, 3 (ascending)
    const journal = createJournalStore();
    journal.commit(entries, []);

    const harness = createHarness(navTestSurface(), journal);
    const oldest = entries[0];
    const newest = entries[2];
    expect(oldest?.seq).toBe(1);
    expect(newest?.seq).toBe(3);
    if (oldest === undefined || newest === undefined) throw new Error('fixture missing entries');

    const result = await harness.host.undoEntry(oldest.seq);

    expect(result.status).toBe('performed');
    if (result.status === 'performed') {
      expect(result.entry.seq).toBe(4);
      // Spec #3120 §3.10 — the trail button's undo is the human's, on the pointer channel.
      expect(result.entry.actor).toBe('human');
      expect(result.entry.channel).toBe('pointer');
      expect(result.entry.label).toBe('Undo Rectangle 1');
      expect(result.entry.inverse).toEqual(oldest.patch?.after ?? null);
    }

    // The OLDEST inverse was applied — the newest entry's inverse never was.
    expect(harness.applied).toEqual([oldest.inverse]);
    expect(harness.applied).not.toContainEqual(newest.inverse);

    // Exactly ONE requester-attributed entry appended; the earlier entries survive byte-identical.
    const after = journal.entries();
    expect(after).toHaveLength(4);
    expect(after[2]).toEqual(newest);
    expect(journal.redo()).toEqual([1]);

    expect(harness.announcements).toEqual(['Undid Rectangle 1']);
    expect(harness.announcements).toHaveLength(1);
  });

  it('a missing seq is the shipped no-matches outcome with nothing-to-undo', async () => {
    const entries = seedEntries(2);
    const journal = createJournalStore();
    journal.commit(entries, []);
    const harness = createHarness(navTestSurface(), journal);

    const result = await harness.host.undoEntry(999);

    expect(result).toEqual({ status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO });
    expect(harness.announcements).toEqual(['Nothing to undo.']);
    expect(harness.applied).toHaveLength(0);
    expect(journal.entries()).toHaveLength(2);
  });

  it('a non-undoable entry (inverse === null) is refused the same way', async () => {
    const entries = seedEntries(1);
    const nonUndoable = seedNonUndoableEntry(entries);
    const journal = createJournalStore();
    journal.commit([...entries, nonUndoable], []);
    const harness = createHarness(navTestSurface(), journal);

    expect(nonUndoable.seq).toBe(2);
    expect(nonUndoable.inverse).toBeNull();

    const result = await harness.host.undoEntry(nonUndoable.seq);

    expect(result).toEqual({ status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO });
    expect(harness.announcements).toEqual(['Nothing to undo.']);
    expect(harness.applied).toHaveLength(0);
    expect(journal.entries()).toHaveLength(2);
  });
});

/* ─────────────── P5 — transient auto-exit + pinned action counts ─────────────── */

describe('P5 — transient auto-exit and the unavailable-key announcement', () => {
  it('a mutation in a transient place pops exactly one level', async () => {
    const harness = createHarness();

    await harness.host.handleStroke('c', 1000);
    expect(harness.host.getSnapshot().context.placePath).toEqual([
      FIXTURE_PLACES.canvas,
      FIXTURE_PLACES.create,
    ]);

    const result = await harness.host.handleStroke('r', 1000); // test.rect — a real mutation
    expect(result?.status).toBe('performed');
    expect(harness.host.getSnapshot().context.placePath).toEqual([FIXTURE_PLACES.canvas]);
  });

  it('a transient mutation announces the exit once', async () => {
    const harness = createHarness();

    await harness.host.handleStroke('c', 1000);
    await harness.host.handleStroke('r', 1000);

    // The entry message, then EXACTLY ONE exit message through the same composer.
    expect(harness.announcements).toEqual([
      navPlaceEnterMessage('Create', 2),
      navPlaceExitMessage('Create', 'Canvas', 6),
    ]);
    expect(harness.announcements).toHaveLength(2);
  });

  it('a sticky place mutation keeps the cursor', async () => {
    const harness = createHarness();

    await harness.host.handleStroke('i', 1000); // enter Edit (sticky)
    const result = await harness.host.handleStroke('d', 1000); // test.duplicate — a mutation
    expect(result?.status).toBe('performed');

    expect(harness.host.getSnapshot().context.placePath).toEqual([
      FIXTURE_PLACES.canvas,
      FIXTURE_PLACES.edit,
    ]);
    // Only the entry message — no exit for a sticky place.
    expect(harness.announcements).toEqual([navPlaceEnterMessage('Edit', 3)]);
  });

  it('a bound but unavailable key announces the unavailable message once', async () => {
    const harness = createHarness();

    await harness.host.handleStroke('i', 1000); // enter Edit
    const entriesBefore = harness.journal.entries().length;

    // `test.paste` is bound to `p` and unavailable with the default (empty) selection.
    const result = await harness.host.handleStroke('p', 1000);

    expect(result?.status).toBe('rejected');
    if (result?.status === 'rejected') expect(result.code).toBe('unavailable');
    expect(harness.host.getSnapshot().announcement).toBe(navUnavailableKeyMessage('p'));
    expect(harness.announcements).toEqual([
      navPlaceEnterMessage('Edit', 3),
      "p isn't available here",
    ]);
    // Nothing performed, nothing journaled, the cursor is unchanged.
    expect(harness.journal.entries()).toHaveLength(entriesBefore);
    expect(harness.host.getSnapshot().context.placePath).toEqual([
      FIXTURE_PLACES.canvas,
      FIXTURE_PLACES.edit,
    ]);
  });

  it('the rail action counts are pinned to the declared verbs', async () => {
    const harness = createHarness(publishedWireframeSurface());
    const cases: ReadonlyArray<{ stroke: string; label: string; count: number }> = [
      { stroke: 'c', label: 'Create', count: 9 },
      { stroke: 'e', label: 'Edit', count: 5 },
      { stroke: 'a', label: 'Arrange', count: 8 },
      { stroke: 's', label: 'Style', count: 5 },
      { stroke: 'v', label: 'View', count: 5 },
      { stroke: 'f', label: 'File', count: 4 },
    ];

    for (const expected of cases) {
      await harness.host.handleStroke(expected.stroke, 1000);
      expect(harness.host.getSnapshot().announcement, expected.label).toBe(
        navPlaceEnterMessage(expected.label, expected.count),
      );
      await harness.host.handleStroke('Escape', 1000);
      // Canvas = 2 (the two selection verbs; the six entry keys are PLACE bindings and the
      // two globals are filtered out), and place rows never inflate the count.
      expect(harness.host.getSnapshot().announcement, expected.label).toBe(
        navPlaceExitMessage(expected.label, 'Canvas', 2),
      );
    }
  });
});

/* ───────────────────────── presentation state (no polling, no persistence) ───────────────────────── */

describe('map state + reset — presentation only', () => {
  it('openMap/closeMap advance the snapshot once per real transition', () => {
    const harness = createHarness();

    harness.host.openMap();
    expect(harness.host.getSnapshot().mapOpen).toBe(true);
    expect(harness.host.getSnapshot().mapFilterPlaceId).toBeNull();
    const afterOpen = harness.host.getSnapshot().epoch;

    harness.host.openMap(); // idempotent: no second mutation
    expect(harness.host.getSnapshot().epoch).toBe(afterOpen);

    harness.host.openMap(FIXTURE_PLACES.arrange);
    expect(harness.host.getSnapshot().mapFilterPlaceId).toBe(FIXTURE_PLACES.arrange);

    harness.host.closeMap();
    expect(harness.host.getSnapshot().mapOpen).toBe(false);
    expect(harness.host.getSnapshot().mapFilterPlaceId).toBeNull();
    expect(harness.host.getSnapshot().epoch).toBe(afterOpen + 2);
  });

  it('reset() returns the cursor to the injected path and clears the announcement', async () => {
    const harness = createHarness();
    await harness.host.handleStroke('c', 1000);
    harness.host.openMap(FIXTURE_PLACES.create);
    expect(harness.host.getSnapshot().announcement).toBe('Create — 2 actions');

    harness.host.reset();

    const snapshot = harness.host.getSnapshot();
    expect(snapshot.context.placePath).toEqual([FIXTURE_PLACES.canvas]);
    expect(snapshot.pending).toBeNull();
    expect(snapshot.mapOpen).toBe(false);
    expect(snapshot.mapFilterPlaceId).toBeNull();
    expect(snapshot.announcement).toBe('');
  });
});

/* ───────────────────────── N-04 — the source half ───────────────────────── */

const UI_DIR = resolve(process.cwd(), 'src/shared/navigation/ui');

/** Every non-test `.ts`/`.tsx` file under the P4 UI directory. */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Comments removed; string literals kept (so a `//` inside a string cannot desync). */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += current;
        index += 1;
        if (current === quote) break;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The top-level arguments of the call whose `(` sits at `openIndex`. */
function callArguments(source: string, openIndex: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      depth += 1;
      if (depth === 1) continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
    }
    if (char === ',' && depth === 1) {
      args.push(current);
      current = '';
      continue;
    }
    if (depth >= 1) current += char;
  }
  return args;
}

function dependencyArrays(source: string): string[] {
  const arrays: string[] = [];
  const pattern = /\buse(?:Effect|LayoutEffect|Memo|Callback)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const openIndex = match.index + match[0].length - 1;
    const args = callArguments(source, openIndex);
    const deps = args[args.length - 1]?.trim() ?? '';
    if (deps.startsWith('[')) arrays.push(deps);
  }
  return arrays;
}

describe('N-04 — no `.length` / fresh-array effect dependencies in ui/**', () => {
  it('scans the real UI sources and finds no unstable dependency array', () => {
    // Non-vacuity first: the actual P4 sources must be read.
    const files = sourceFiles(UI_DIR);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((file) => file.endsWith('host.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('announce.tsx'))).toBe(true);

    let scannedArrays = 0;
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source.trim().length, `${file} must be non-empty`).toBeGreaterThan(0);

      for (const deps of dependencyArrays(source)) {
        scannedArrays += 1;
        expect(deps, `${file}: dep array reads .length`).not.toContain('.length');
        expect(deps, `${file}: fresh call in a dep array`).not.toMatch(/\(/);
        expect(deps, `${file}: object literal in a dep array`).not.toMatch(/[{}]/);
      }

      // N-05 — the only timer in the P4 layer is the one-shot PENDING_TIMEOUT_MS.
      expect(source, `${file}: interval polling`).not.toMatch(/\bsetInterval\s*\(/);
    }

    // `announce.tsx` installs the channel with one effect, so the scan is not vacuous.
    expect(scannedArrays).toBeGreaterThan(0);
  });
});
