/**
 * Spec #3121 (P7), ST-5 — the Dev Mode surface declaration + provider.
 *
 * Covers the ST-5 slice of the QA plan (the plan's binding B.3/B.5/B.6 rows):
 *   - R-01 — `validateSurface(devModeSurface)` is `{valid:true, diagnostics:[]}`.
 *   - R-03 — `x` clears in BOTH views; `v` switches to Application Data AND moves the cursor
 *     into `dev-mode.applicationData` (a visible no-op there); `i` focuses the filter input
 *     (rows view only); `b` activates every state and unmounts the "All" chip.
 *   - R-04 — an absent control is at most a noop: no state change, no journal entry, no
 *     announcement.
 *   - R-08 / R-11 — the rail is the bound-verb projection over the app's OWN declaration
 *     (4 rows at `dev-mode.events`, 2 at `dev-mode.applicationData`; the child-place row is a
 *     live affordance via D-9).
 *   - R-15 / R-24 — zero forbidden hotkey attributes; Dev Mode stays retained.
 *
 * The harness renders the REAL `DevMode` (state + handlers) inside the real `StreamProvider`,
 * so every key drives the ONE element-scoped adapter and the ONE dispatch funnel.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The 3-D manifold is retained (ST-5 non-goal) but needs WebGL, which jsdom does not
// implement. Stub only the canvas component so the REAL Dev Mode tree + handlers render.
vi.mock('../components/SpatiotemporalManifold', () => ({
  SpatiotemporalManifold: () => null,
}));

import { validateSurface, type ContextSnapshot } from '@/shared/navigation';
import {
  NAV_MAP_PLACE_TESTID,
  NAV_MAP_TESTID,
  NAV_RAIL_MAP_TESTID,
  NAV_RAIL_MORE_TESTID,
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_ROW_TESTID,
  describeContext,
  getNavigationHost,
  resetNavigationAnnouncer,
} from '@/shared/navigation/ui';
import { resetNavigationAnnouncer } from '@/shared/navigation/ui';
import {
  StreamProvider,
  applyRowDelivery,
  resetRowStoreForTests,
} from '@/shared/contexts/StreamContext';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DevMode } from '../components/DevMode';
import {
  DEV_MODE_APPLICATION_DATA_PLACE_ID,
  DEV_MODE_EVENTS_CLEAR_VERB_ID,
  DEV_MODE_EVENTS_PLACE_ID,
  DEV_MODE_SEARCH_FOCUS_VERB_ID,
  DEV_MODE_STATES_ALL_VERB_ID,
  DEV_MODE_SURFACE_APP_ID,
  DEV_MODE_VERB_IDS,
  DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
  DEV_MODE_VIEW_ROWS_VERB_ID,
  devModeSurface,
  resetDevModeSurfaceForTests,
} from '../devModeSurface';

/* ───────────────────────────── harness ───────────────────────────── */

function renderDevMode() {
  return renderWithChakra(
    <StreamProvider>
      <DevMode />
    </StreamProvider>,
  );
}

function host() {
  const registered = getNavigationHost(DEV_MODE_SURFACE_APP_ID);
  if (registered === null) throw new Error('the Dev Mode navigation host is not registered');
  return registered;
}

function placePathIds(): string[] {
  const envelope = describeContext(DEV_MODE_SURFACE_APP_ID);
  if (envelope === null) throw new Error('describeContext(dev-mode) returned null');
  return envelope.placePath.map((place) => place.id);
}

function journalLength(): number {
  return host().getSnapshot().entries.length;
}

/** The view toggle is inside the app root, so a keydown on it bubbles to the ONE adapter. */
function keyTarget(): HTMLElement {
  return screen.getByTestId('dev-mode-view-toggle');
}

/** Fire one stroke through the real React `onKeyDown`; `false` ⇒ the adapter prevented it. */
async function press(key: string, target: HTMLElement = keyTarget()): Promise<boolean> {
  let notPrevented = false;
  await act(async () => {
    notPrevented = fireEvent.keyDown(target, { key });
    await Promise.resolve();
    await Promise.resolve();
  });
  return notPrevented;
}

/** Seed the RTDB row-mutation log the Dev Mode viewer projects (two Chat rows). */
function seedEvents(count = 2): void {
  act(() => {
    for (let i = 1; i <= count; i += 1) {
      applyRowDelivery({
        queryId: 'q-devmode-surface-test',
        eventType: 'Chat',
        kind: 'insert',
        seq: i,
        key: { sessionId: 'ses_devmode', correlationId: `ses_devmode_${i}` },
        patch: {
          sessionId: 'ses_devmode',
          correlationId: `ses_devmode_${i}`,
          seq: i,
          startedAtNs: 1000,
          endedAtNs: null,
          updatedAt: '2026-09-01T00:00:00+00:00',
          state: 'Init',
          userMessage: `seed ${i}`,
          agentReply: null,
          promptTokens: 1,
          completionTokens: null,
          cacheReadTokens: null,
          costUsd: null,
          model: 'gpt-test',
          parentSessionId: null,
          compositedChildSessionId: null,
          rawJson: '{}',
        },
        timestamp: '2026-09-01T00:00:00+00:00',
      });
    }
  });
}

function contextFor(view: 'rows' | 'application-data'): ContextSnapshot {
  return {
    appId: DEV_MODE_SURFACE_APP_ID,
    placePath: [DEV_MODE_EVENTS_PLACE_ID],
    selection: { count: 1, kinds: ['panel'], label: view, ids: [view] },
    dirty: false,
  };
}

beforeEach(() => {
  resetRowStoreForTests();
  resetDevModeSurfaceForTests();
  resetNavigationAnnouncer();
  resetNavigationAnnouncer();
});

afterEach(() => {
  cleanup();
  resetRowStoreForTests();
  resetDevModeSurfaceForTests();
  resetNavigationAnnouncer();
  resetNavigationAnnouncer();
});

/* ───────────────────────────── R-01 — the declaration ───────────────────────────── */

describe('R-01 — the Dev Mode declaration validates with zero diagnostics', () => {
  it('validateSurface(devModeSurface) is exactly {valid:true, diagnostics:[]}', () => {
    expect(validateSurface(devModeSurface)).toStrictEqual({ valid: true, diagnostics: [] });
  });

  it('declares the two B.3 places (root + sticky Application Data child)', () => {
    const { tree } = devModeSurface;
    expect(tree.appId).toBe('dev-mode');
    expect(tree.root).toBe(DEV_MODE_EVENTS_PLACE_ID);
    expect(tree.places.map((place) => place.id)).toEqual([
      DEV_MODE_EVENTS_PLACE_ID,
      DEV_MODE_APPLICATION_DATA_PLACE_ID,
    ]);
    expect(tree.directAliases).toStrictEqual({});

    const root = tree.places.find((place) => place.id === DEV_MODE_EVENTS_PLACE_ID);
    const appData = tree.places.find(
      (place) => place.id === DEV_MODE_APPLICATION_DATA_PLACE_ID,
    );
    if (root === undefined || appData === undefined) throw new Error('Dev Mode places missing');

    // §2.1 — the root sets neither transient nor sticky; the child sets exactly one.
    expect(root.parent).toBeNull();
    expect(root.transient).toBe(false);
    expect(root.sticky).toBe(false);
    expect(appData.parent).toBe(DEV_MODE_EVENTS_PLACE_ID);
    expect(appData.transient).toBe(false);
    expect(appData.sticky).toBe(true);

    // B.3 — the four legacy keys at the root; `x` and `v` stay resolvable in the child.
    expect(root.keys).toStrictEqual({
      x: { kind: 'verb', verbId: DEV_MODE_EVENTS_CLEAR_VERB_ID },
      i: { kind: 'verb', verbId: DEV_MODE_SEARCH_FOCUS_VERB_ID },
      b: { kind: 'verb', verbId: DEV_MODE_STATES_ALL_VERB_ID },
      v: { kind: 'verb', verbId: DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID },
    });
    expect(appData.keys).toStrictEqual({
      x: { kind: 'verb', verbId: DEV_MODE_EVENTS_CLEAR_VERB_ID },
      v: { kind: 'verb', verbId: DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID },
    });
  });

  it('declares exactly the seven B.5 verbs and nothing invented', () => {
    expect(devModeSurface.verbs.map((verb) => verb.id)).toEqual([
      DEV_MODE_EVENTS_CLEAR_VERB_ID,
      DEV_MODE_SEARCH_FOCUS_VERB_ID,
      DEV_MODE_STATES_ALL_VERB_ID,
      DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
      DEV_MODE_VIEW_ROWS_VERB_ID,
      DEV_MODE_APPLICATION_DATA_PLACE_ID,
      'app.map',
    ]);
    expect(DEV_MODE_VERB_IDS).toHaveLength(7);

    // B.4 — the action verbs are panel-scoped; the surface map verb names `stream`.
    for (const verbId of [
      DEV_MODE_EVENTS_CLEAR_VERB_ID,
      DEV_MODE_SEARCH_FOCUS_VERB_ID,
      DEV_MODE_STATES_ALL_VERB_ID,
      DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
      DEV_MODE_VIEW_ROWS_VERB_ID,
    ]) {
      const verb = devModeSurface.verbs.find((candidate) => candidate.id === verbId);
      expect(verb?.appliesTo.objects, verbId).toStrictEqual(['panel']);
    }
    const mapVerb = devModeSurface.verbs.find((verb) => verb.id === 'app.map');
    expect(mapVerb?.appliesTo.objects).toStrictEqual(['stream']);

    // `app.map` is navigation-only, unpublished and unbound (B.3).
    expect(mapVerb?.publish).toBe(false);
    expect(
      devModeSurface.tree.places.some((place) =>
        Object.values(place.keys).some(
          (binding) => binding.kind === 'verb' && binding.verbId === 'app.map',
        ),
      ),
    ).toBe(false);

    // D-9 — the child-place id is a declared, unpublished navigation verb.
    const placeVerb = devModeSurface.verbs.find(
      (verb) => verb.id === DEV_MODE_APPLICATION_DATA_PLACE_ID,
    );
    expect(placeVerb?.publish).toBe(false);
    expect(placeVerb?.appliesTo.places).toStrictEqual([DEV_MODE_APPLICATION_DATA_PLACE_ID]);

    // No argument-requiring verb exists: every outcome is view-local.
    for (const verb of devModeSurface.verbs) expect(verb.args, verb.id).toStrictEqual([]);
  });

  it('B.5 availability reads ONLY the injected panel selection', () => {
    const rows = contextFor('rows');
    const appData = contextFor('application-data');
    const verb = (id: string) =>
      devModeSurface.verbs.find((candidate) => candidate.id === id)!;

    // `x` clears from both views; `v` is always available (a visible no-op in its own view).
    expect(verb(DEV_MODE_EVENTS_CLEAR_VERB_ID).available(rows)).toBe(true);
    expect(verb(DEV_MODE_EVENTS_CLEAR_VERB_ID).available(appData)).toBe(true);
    expect(verb(DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID).available(rows)).toBe(true);
    expect(verb(DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID).available(appData)).toBe(true);

    // The rows-only controls disable outside the rows view (AC5).
    expect(verb(DEV_MODE_SEARCH_FOCUS_VERB_ID).available(rows)).toBe(true);
    expect(verb(DEV_MODE_SEARCH_FOCUS_VERB_ID).available(appData)).toBe(false);
    expect(verb(DEV_MODE_STATES_ALL_VERB_ID).available(rows)).toBe(true);
    expect(verb(DEV_MODE_STATES_ALL_VERB_ID).available(appData)).toBe(false);

    // `view.rows` is only meaningful from the Application Data place.
    expect(verb(DEV_MODE_VIEW_ROWS_VERB_ID).available(appData)).toBe(true);
    expect(verb(DEV_MODE_VIEW_ROWS_VERB_ID).available(rows)).toBe(false);
  });
});

/* ───────────────────────────── R-08 / R-15 — projection + mount ───────────────────────────── */

// The scanner control uses a CONSTRUCTED attribute name so this file adds no literal hit to
// the per-surface AC7 scan (QA R-14) while still proving the mounted app emits none.
const FORBIDDEN_HOTKEY_ATTR = ['data', 'hotkey'].join('-');

describe('R-08 / R-15 — the rail is the bound-verb projection; no legacy hotkey ships', () => {
  it('renders 4 bound rows at events and 1 live child-place row, with zero legacy hotkeys', () => {
    renderDevMode();

    expect(screen.getByTestId('navigation-bar')).toBeInTheDocument();
    expect(screen.getByTestId('navigation-trail')).toBeInTheDocument();
    expect(document.querySelectorAll(`[${FORBIDDEN_HOTKEY_ATTR}]`)).toHaveLength(0);

    const rows = screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
    expect(rows.map((row) => row.getAttribute('data-nav-verb-id'))).toEqual([
      DEV_MODE_EVENTS_CLEAR_VERB_ID,
      DEV_MODE_SEARCH_FOCUS_VERB_ID,
      DEV_MODE_STATES_ALL_VERB_ID,
      DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
    ]);
    for (const row of rows) {
      expect(row).toHaveAttribute('data-nav-availability', 'available');
    }

    const placeRows = screen.getAllByTestId(NAV_RAIL_PLACE_ROW_TESTID);
    expect(placeRows).toHaveLength(1);
    expect(placeRows[0]).toHaveAttribute('data-nav-place-id', DEV_MODE_APPLICATION_DATA_PLACE_ID);
    expect(placeRows[0]).toHaveAttribute('aria-label', 'Application Data — 2 actions');
    expect(screen.queryByTestId(NAV_RAIL_MORE_TESTID)).toBeNull();
  });

  it('renders 2 bound rows at dev-mode.applicationData after `v`', async () => {
    renderDevMode();

    await press('v');

    expect(placePathIds()).toEqual([
      DEV_MODE_EVENTS_PLACE_ID,
      DEV_MODE_APPLICATION_DATA_PLACE_ID,
    ]);
    const rows = screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
    expect(rows.map((row) => row.getAttribute('data-nav-verb-id'))).toEqual([
      DEV_MODE_EVENTS_CLEAR_VERB_ID,
      DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
    ]);
    expect(screen.queryAllByTestId(NAV_RAIL_PLACE_ROW_TESTID)).toHaveLength(0);
  });

  it('the map carries both places and all seven declared verbs (ST-8 DOM evidence)', async () => {
    renderDevMode();

    await act(async () => {
      fireEvent.click(screen.getByTestId(NAV_RAIL_MAP_TESTID));
      await Promise.resolve();
    });

    const map = await screen.findByTestId(NAV_MAP_TESTID);
    const blocks = Array.from(map.querySelectorAll(`[data-testid="${NAV_MAP_PLACE_TESTID}"]`)).map(
      (node) => node.getAttribute('data-nav-place-id'),
    );
    expect(blocks).toEqual([DEV_MODE_EVENTS_PLACE_ID, DEV_MODE_APPLICATION_DATA_PLACE_ID]);
    for (const verbId of DEV_MODE_VERB_IDS) {
      expect(map.querySelector(`[data-nav-verb-id="${verbId}"]`), verbId).not.toBeNull();
    }
  });
});

/* ───────────────────────────── R-03 — the four legacy keys ───────────────────────────── */

describe('R-03 — x clears the event buffer in BOTH views', () => {
  it('clears in the rows view', async () => {
    seedEvents(2);
    renderDevMode();
    expect(screen.getByTestId('dev-mode-clear-events')).toBeInTheDocument();

    const prevented = await press('x');

    expect(prevented).toBe(false); // the adapter handled (and prevented) the stroke
    expect(screen.queryByTestId('dev-mode-clear-events')).toBeNull();
    expect(journalLength()).toBe(1);
    expect(host().getSnapshot().entries[0]?.verbId).toBe(DEV_MODE_EVENTS_CLEAR_VERB_ID);
    expect(placePathIds()).toEqual([DEV_MODE_EVENTS_PLACE_ID]);
  });

  it('clears in the Application Data view too', async () => {
    seedEvents(2);
    renderDevMode();

    await press('v');
    expect(placePathIds()).toEqual([
      DEV_MODE_EVENTS_PLACE_ID,
      DEV_MODE_APPLICATION_DATA_PLACE_ID,
    ]);
    expect(screen.getByTestId('dev-mode-clear-events')).toBeInTheDocument();

    await press('x');

    expect(screen.queryByTestId('dev-mode-clear-events')).toBeNull();
    // v (navigation) + x (clear): the clear ran in the Application Data view.
    expect(journalLength()).toBe(2);
    expect(host().getSnapshot().entries[1]?.verbId).toBe(DEV_MODE_EVENTS_CLEAR_VERB_ID);
  });
});

describe('R-03 — v switches the view and moves the cursor into the place', () => {
  it('enters dev-mode.applicationData; a second press is the same visible no-op', async () => {
    renderDevMode();
    expect(screen.getByTestId('dev-mode-filter-input')).toBeInTheDocument();
    expect(placePathIds()).toEqual([DEV_MODE_EVENTS_PLACE_ID]);

    await press('v');

    expect(screen.queryByTestId('dev-mode-filter-input')).toBeNull();
    expect(placePathIds()).toEqual([
      DEV_MODE_EVENTS_PLACE_ID,
      DEV_MODE_APPLICATION_DATA_PLACE_ID,
    ]);
    const first = host().getSnapshot().entries;
    expect(first).toHaveLength(1);
    expect(first[0]?.verbId).toBe(DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID);
    expect(first[0]?.effect).toBe('navigation');

    // Same visible outcome (still Application Data, cursor unchanged), one more navigation
    // journal entry — the documented B.6 "visible no-op".
    await press('v');
    expect(screen.queryByTestId('dev-mode-filter-input')).toBeNull();
    expect(placePathIds()).toEqual([
      DEV_MODE_EVENTS_PLACE_ID,
      DEV_MODE_APPLICATION_DATA_PLACE_ID,
    ]);
    expect(journalLength()).toBe(2);
  });

  it('the pointer view toggle runs the SAME declared verb (rows → application-data)', async () => {
    renderDevMode();
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('dev-mode-view-toggle')).getByText('Application Data'),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(placePathIds()).toEqual([
      DEV_MODE_EVENTS_PLACE_ID,
      DEV_MODE_APPLICATION_DATA_PLACE_ID,
    ]);
    expect(host().getSnapshot().entries[0]?.verbId).toBe(
      DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
    );
    expect(host().getSnapshot().entries[0]?.channel).toBe('pointer');
  });
});

describe('R-03 — i focuses the filter input in the rows view only', () => {
  it('focuses [data-testid="dev-mode-filter-input"] from the rows view', async () => {
    renderDevMode();
    const input = screen.getByTestId('dev-mode-filter-input');
    expect(document.activeElement).not.toBe(input);

    await press('i');

    expect(document.activeElement).toBe(input);
    expect(host().getSnapshot().entries[0]?.verbId).toBe(DEV_MODE_SEARCH_FOCUS_VERB_ID);
  });

  it('is inert in the Application Data view (not bound there, no state/journal change)', async () => {
    renderDevMode();
    await press('v');
    const before = journalLength();
    const announcementBefore = host().getSnapshot().announcement;

    // Fired on the view toggle, never into a text control, so the adapter sees the stroke.
    const prevented = await press('i');

    expect(prevented).toBe(true); // not our stroke in this place → untouched
    expect(journalLength()).toBe(before);
    expect(screen.queryByTestId('dev-mode-filter-input')).toBeNull();
    expect(host().getSnapshot().announcement).toBe(announcementBefore);
  });
});

describe('R-03 — b activates every state and unmounts the All chip', () => {
  it('reactivates a deselected state, then no-ops when every state is active', async () => {
    renderDevMode();

    // Deselect one state so the "All" chip renders.
    fireEvent.click(screen.getByText('Init'));
    expect(screen.getByTestId('dev-mode-show-all-states')).toBeInTheDocument();
    expect(journalLength()).toBe(0);

    await press('b', screen.getByTestId('dev-mode-show-all-states'));

    expect(screen.queryByTestId('dev-mode-show-all-states')).toBeNull();
    expect(host().getSnapshot().entries[0]?.verbId).toBe(DEV_MODE_STATES_ALL_VERB_ID);

    // Already all active → the shipped control is absent → noop (no journal, no message).
    const after = journalLength();
    await press('b');
    expect(journalLength()).toBe(after);
    expect(host().getSnapshot().announcement).toBe('');
  });
});

/* ───────────────────────────── R-04 — noop paths ───────────────────────────── */

describe('R-04 — an absent control introduces no state, journal entry or message', () => {
  it('x with an empty event buffer is a noop', async () => {
    renderDevMode();

    await press('x');

    expect(journalLength()).toBe(0);
    expect(host().getSnapshot().announcement).toBe('');
    expect(host().getSnapshot().entries).toHaveLength(0);
    expect(placePathIds()).toEqual([DEV_MODE_EVENTS_PLACE_ID]);
  });

  it('b while every state is already active is a noop', async () => {
    renderDevMode();
    expect(screen.queryByTestId('dev-mode-show-all-states')).toBeNull();

    await press('b');

    expect(journalLength()).toBe(0);
    expect(host().getSnapshot().announcement).toBe('');
  });
});
