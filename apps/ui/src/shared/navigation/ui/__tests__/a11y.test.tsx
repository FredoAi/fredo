/**
 * Spec #3118 (P4), ST-6 — the CROSS-SURFACE accessibility composite (AC7 / R-7.1 … R-7.3,
 * QA Q7-01 … Q7-03) plus the committed §11.4 announcement log (Q7-04).
 *
 * One tree mounts the shipped rail, map, trail, keycaps and the single navigation announcer so
 * the accessibility contract is proven across the four surfaces together, not only per
 * component (the per-component focus/name legs stay in ST-2/ST-3/ST-4):
 *
 *   - every interactive element is reachable by role and carries a non-empty name;
 *   - a keyboard focus walk lands on each control and never on `body`;
 *   - the map traps Tab and restores the invoker on close;
 *   - every non-`safe` risk is conveyed as TEXT, not colour alone;
 *   - every `NavKeycap` group exposes a non-empty accessible name;
 *   - the eight announcement classes are captured from the REAL live region and must equal the
 *     bound `nav*Message` composers verbatim (the copy committed in `docs/NAVIGATION_ENGINE.md`
 *     §11.4 must contain the same strings).
 *
 * Shipped tooling only: vitest + jsdom + `@testing-library/react` + `jest-dom`. No axe, no new
 * dependency.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { getFocusableElements } from '@/shared/hotkeys/traversal';
import { type KeyBinding, type Surface } from '@/shared/navigation';
import {
  countActiveLiveRegions,
  getNavigationAnnouncement,
  navAmbiguousKeyMessage,
  navPlaceEnterMessage,
  navPlaceExitMessage,
  navPrefixMessage,
  navUnavailableKeyMessage,
  NavigationAnnouncer,
  navUndoFailedMessage,
  navUndoMessage,
  navUndoNothingMessage,
  resetNavigationAnnouncer,
} from '@/shared/navigation/ui/announce';
import {
  NAV_ANNOUNCER_TESTID,
  NAV_MAP_ROW_TESTID,
  NAV_MAP_SEARCH_LABEL,
  NAV_MAP_TESTID,
  NAV_MORE_LABEL,
  NAV_RAIL_ARIA_LABEL,
  NAV_RAIL_ASK_TESTID,
  NAV_RAIL_MAP_TESTID,
  NAV_RAIL_ROW_TESTID,
  NAV_RAIL_TESTID,
  NAV_TRAIL_TESTID,
  NAV_TRAIL_UNDO_TESTID,
} from '@/shared/navigation/ui/constants';
import { ActivityTrail } from '@/shared/navigation/ui/ActivityTrail';
import { CommandRail } from '@/shared/navigation/ui/CommandRail';
import { createNavigationHost, type NavigationHost } from '@/shared/navigation/ui/host';
import {
  buildActivityTrailModel,
  buildCommandRailModel,
  buildNavigationMapModel,
} from '@/shared/navigation/ui/models';
import { NavigationMap } from '@/shared/navigation/ui/NavigationMap';
import {
  FIXTURE_PLACES,
  fixtureSnapshot,
  fixtureTimestamp,
  navTestSurface,
  seedEntries,
} from './fixtures';

const ROOT_PATH = [FIXTURE_PLACES.canvas];
const ARRANGE_PATH = [FIXTURE_PLACES.canvas, FIXTURE_PLACES.arrange];

/** A valid, ordered place-path root for the composite. */
function buildRail(path: readonly string[]) {
  return buildCommandRailModel(navTestSurface(), fixtureSnapshot(path));
}

function buildMap(path: readonly string[]) {
  return buildNavigationMapModel(navTestSurface(), fixtureSnapshot(path), { filteredTo: null });
}

function buildTrail() {
  return buildActivityTrailModel(navTestSurface(), seedEntries(3));
}

/**
 * The composite tree: one navigation announcer, the rail, the trail and a map owned by a
 * local `open` flip with a focusable invoker (so the trap/restore legs are real).
 */
function CompositeHarness({ placePath }: { readonly placePath: readonly string[] }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rail = React.useMemo(() => buildRail(placePath), [placePath]);
  const map = React.useMemo(() => buildMap(placePath), [placePath]);
  const trail = React.useMemo(() => buildTrail(), []);
  return (
    <>
      <NavigationAnnouncer />
      <button type="button" data-testid="nav-invoker" onClick={() => setOpen(true)}>
        Open navigation map
      </button>
      <CommandRail
        model={rail}
        platform="windows"
        reducedMotion
        onRunVerb={() => undefined}
        onOpenMap={(filterPlaceId) => {
          if (filterPlaceId !== undefined && filterPlaceId !== null) setOpen(true);
        }}
      />
      <ActivityTrail model={trail} onUndo={() => undefined} />
      <NavigationMap
        model={map}
        open={open}
        onClose={() => setOpen(false)}
        onRunVerb={() => undefined}
        platform="windows"
        reducedMotion
      />
    </>
  );
}

async function openTheMap(): Promise<HTMLElement> {
  const invoker = screen.getByTestId('nav-invoker');
  invoker.focus();
  expect(invoker).toHaveFocus();
  fireEvent.click(invoker);
  await waitFor(() => expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument());
  return invoker;
}

beforeEach(() => {
  resetNavigationAnnouncer();
});

afterEach(() => {
  cleanup();
  resetNavigationAnnouncer();
});

/* ───────────────────────────── Q7-01 — reachability ───────────────────────────── */

describe('Cross-surface a11y — role/name reachability (Q7-01 / R-7.1)', () => {
  it('exposes the rail controls, `more…`, the globals and every trail undo by role', () => {
    renderWithChakra(<CompositeHarness placePath={ARRANGE_PATH} />);

    const rail = screen.getByRole('region', { name: NAV_RAIL_ARIA_LABEL });
    const rows = screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect((row.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    }

    expect(screen.getByRole('button', { name: NAV_MORE_LABEL })).toBeTruthy();
    expect(within(rail).getByRole('button', { name: 'Question mark Map' })).toBe(
      screen.getByTestId(NAV_RAIL_MAP_TESTID),
    );
    expect(within(rail).getByRole('button', { name: 'Slash Ask' })).toBe(
      screen.getByTestId(NAV_RAIL_ASK_TESTID),
    );

    const undoButtons = screen.getAllByTestId(NAV_TRAIL_UNDO_TESTID);
    expect(undoButtons).toHaveLength(3);
    for (const undo of undoButtons) {
      expect(undo.tagName).toBe('BUTTON');
      expect((undo.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    }

    // Exactly one polite live region across the composite (the announcer).
    expect(countActiveLiveRegions()).toBe(1);
  });

  it('exposes the map search, every verb row and the close trigger by role', async () => {
    renderWithChakra(<CompositeHarness placePath={ARRANGE_PATH} />);
    await openTheMap();

    expect(screen.getByRole('textbox', { name: NAV_MAP_SEARCH_LABEL })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    const rows = screen.getAllByTestId(NAV_MAP_ROW_TESTID);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect((row.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    }
  });

  it('walks every focusable control with `toHaveFocus()`, never stopping on `body`', () => {
    renderWithChakra(<CompositeHarness placePath={ARRANGE_PATH} />);

    const railRoot = screen.getByTestId(NAV_RAIL_TESTID);
    const trailRoot = screen.getByTestId(NAV_TRAIL_TESTID);
    const stops = [...getFocusableElements(railRoot), ...getFocusableElements(trailRoot)];

    expect(stops.length).toBeGreaterThan(5);
    for (const stop of stops) {
      stop.focus();
      expect(stop).toHaveFocus();
      expect(document.activeElement).not.toBe(document.body);
    }
  });
});

/* ───────────────────────────── Q7-01 — trap + restore ───────────────────────────── */

describe('Cross-surface a11y — the map trap and focus restore (Q7-01 / R-2.4, R-2.5)', () => {
  it('traps Tab inside the dialog and restores the invoker on Escape', async () => {
    renderWithChakra(<CompositeHarness placePath={ARRANGE_PATH} />);
    const invoker = await openTheMap();

    const dialog = screen.getByTestId(NAV_MAP_TESTID);
    const focusables = getFocusableElements(dialog);
    expect(focusables.length).toBeGreaterThan(2);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last?.focus();
    expect(last).toHaveFocus();
    fireEvent.keyDown(last as HTMLElement, { key: 'Tab' });
    expect(first).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId(NAV_MAP_TESTID)).toBeNull());
    expect(invoker).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });
});

/* ───────────────────────────── Q7-02 — risk text + keycap names ───────────────────────────── */

describe('Cross-surface a11y — risk words and keycap names (Q7-02 / R-7.2)', () => {
  it('renders every non-safe risk classification as text in the map rows', async () => {
    renderWithChakra(<CompositeHarness placePath={ARRANGE_PATH} />);
    await openTheMap();

    const model = buildMap(ARRANGE_PATH);
    const seen = new Set<string>();
    for (const place of model.places) {
      for (const verb of place.verbs) {
        if (verb.riskLabel === null) continue;
        seen.add(verb.risk);
        const row = screen
          .getAllByTestId(NAV_MAP_ROW_TESTID)
          .find((candidate) => candidate.getAttribute('data-nav-verb-id') === verb.verbId);
        expect(row, `map row for ${verb.verbId}`).toBeDefined();
        expect(row?.textContent).toContain(verb.riskLabel);
      }
    }

    // Non-vacuity: the fixture really carries both non-safe classes.
    expect(seen.has('destructive')).toBe(true);
    expect(seen.has('external')).toBe(true);
  });

  it('renders the destructive risk word as text in the rail', () => {
    renderWithChakra(<CompositeHarness placePath={[FIXTURE_PLACES.canvas, FIXTURE_PLACES.edit]} />);

    const deleteRow = screen
      .getAllByTestId(NAV_RAIL_ROW_TESTID)
      .find((row) => row.getAttribute('data-nav-verb-id') === 'test.delete');
    expect(deleteRow).toBeDefined();
    expect(deleteRow?.textContent).toContain('Destructive');
  });

  it('gives every NavKeycap group a non-empty accessible name', () => {
    renderWithChakra(<CompositeHarness placePath={ARRANGE_PATH} />);

    const keycaps = Array.from(document.querySelectorAll('[data-nav-keycap="true"]'));
    expect(keycaps.length).toBeGreaterThan(3);
    for (const keycap of keycaps) {
      expect(keycap.getAttribute('role')).toBe('img');
      expect((keycap.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    }
  });
});

/* ───────────────────────────── Q7-04 — §11.4 announcement log ───────────────────────────── */

/** Clone one place's declared keys (a test-local mutator; the fixture itself is untouched). */
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

function verbBinding(verbId: string): KeyBinding {
  return { kind: 'verb', verbId };
}

interface HostOptions {
  readonly surface?: Surface;
  readonly applyPatch?: () => void;
}

function makeHost(options: HostOptions = {}): NavigationHost {
  return createNavigationHost({
    surface: options.surface ?? navTestSurface(),
    getContext: () => fixtureSnapshot(ROOT_PATH),
    now: () => fixtureTimestamp(0),
    applyPatch: options.applyPatch ?? (() => undefined),
    confirm: () => true,
  });
}

async function drive(host: NavigationHost, stroke: string): Promise<string> {
  await act(async () => {
    await host.handleStroke(stroke, 1000);
  });
  return screen.getByTestId(NAV_ANNOUNCER_TESTID).textContent ?? '';
}

describe('Recorded announcement log — committed docs §11.4 (Q7-04 / R-7.3)', () => {
  it('captures the eight classes from the real live region and matches the bound composers', async () => {
    renderWithChakra(<NavigationAnnouncer />);
    expect(countActiveLiveRegions()).toBe(1);

    const log: string[] = [];

    // 1–2 place enter / place exit.
    const placeHost = makeHost();
    log.push(await drive(placeHost, 'a'));
    log.push(await drive(placeHost, 'Escape'));

    // 3 prefix armed (a two-stroke prefix added to the fixture for this class only).
    const prefixHost = makeHost({
      surface: withKeys(navTestSurface(), FIXTURE_PLACES.canvas, {
        'w n': verbBinding('test.view'),
        'w p': verbBinding('test.style'),
      }),
    });
    log.push(await drive(prefixHost, 'w'));

    // 4 unresolvable key.
    const unavailableHost = makeHost();
    log.push(await drive(unavailableHost, 'z'));

    // 5 ambiguous key (a duplicate normalized binding in Edit).
    const ambiguousHost = makeHost({
      surface: withKeys(navTestSurface(), FIXTURE_PLACES.edit, {
        'x ': verbBinding('test.duplicate'),
      }),
    });
    await drive(ambiguousHost, 'i');
    log.push(await drive(ambiguousHost, 'x'));

    // 6 undo.
    const undoHost = makeHost();
    await drive(undoHost, 'c');
    await drive(undoHost, 'r');
    log.push(await drive(undoHost, 'u'));

    // 7 nothing to undo (a fresh host).
    const emptyHost = makeHost();
    log.push(await drive(emptyHost, 'u'));

    // 8 undo failed (a throwing applyPatch during the unde).
    let failNextPatch = false;
    const failingHost = makeHost({
      applyPatch: () => {
        if (failNextPatch) throw new Error('applyPatch failed');
      },
    });
    await drive(failingHost, 'c');
    await drive(failingHost, 'r');
    const undoable = failingHost.getSnapshot().entries.find((entry) => entry.inverse !== null);
    expect(undoable).toBeDefined();
    failNextPatch = true;
    await act(async () => {
      await failingHost.undoEntry(undoable!.seq);
    });
    log.push(screen.getByTestId(NAV_ANNOUNCER_TESTID).textContent ?? '');

    // Every captured string is the composer's output — verbatim.
    expect(log).toEqual([
      navPlaceEnterMessage('Arrange', 9),
      navPlaceExitMessage('Arrange', 'Canvas', 6),
      navPrefixMessage('w', ['View', 'Style']),
      navUnavailableKeyMessage('z'),
      navAmbiguousKeyMessage('x'),
      navUndoMessage('Rectangle'),
      navUndoNothingMessage(),
      navUndoFailedMessage('Rectangle'),
    ]);
    expect(log).toEqual([
      'Arrange — 9 actions',
      'Left Arrange — Canvas — 6 actions',
      'w… View, Style',
      "z isn't available here",
      'x matches more than one action',
      'Undid Rectangle',
      'Nothing to undo.',
      "Couldn't undo Rectangle",
    ]);

    // The committed record carries the SAME strings (verbatim equality, not a paraphrase).
    const doc = readFileSync(resolve(process.cwd(), '../../docs/NAVIGATION_ENGINE.md'), 'utf8');
    expect(doc).toContain('### 11.4 Recorded manual screen-reader pass (P4)');
    for (const message of log) expect(doc).toContain(message);
    expect(getNavigationAnnouncement()).toBe(navUndoFailedMessage('Rectangle'));
  });
});
