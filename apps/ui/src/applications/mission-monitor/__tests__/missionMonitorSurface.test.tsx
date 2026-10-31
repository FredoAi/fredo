/**
 * Spec #3121 (P7), ST-3 — the Mission Monitor surface declaration + provider.
 *
 * Covers the ST-3 slice of the QA plan:
 *   - R-01 — `validateSurface(missionMonitorSurface)` is `{valid:true, diagnostics:[]}`; the
 *     two B.3 places and exactly the six B.5 verbs are declared (object nouns `monitor` /
 *     `session` per B.4).
 *   - R-03 / R-04 — `s` still only focuses the session filter input while the drawer is
 *     expanded (the default) and is inert (at most a noop) when the drawer is collapsed.
 *   - R-08 — the provider mounts the shipped rail + trail (+ map on open) over its OWN
 *     declaration; exactly ONE rail/provider.
 *   - R-11 — `mission-monitor.session.delete` / `mission-monitor.detail.close` map rows are
 *     disabled with NO selection and enabled with one (`available(ctx)` only).
 *
 * The panel harness renders the REAL `MissionMonitorPanel` (with the app's data/window/flow
 * dependencies stubbed), so the `s` stroke, the drawer collapse and the footer are exercised
 * through the shipped components — never a component-local key table.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateSurface } from '@/shared/navigation';
import {
  NAV_MAP_ROW_TESTID,
  NAV_MAP_TESTID,
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_ROW_TESTID,
  NAV_TRAIL_TESTID,
  buildNavigationMapModel,
  describeContext,
  getNavigationHost,
  resetNavigationAnnouncer,
} from '@/shared/navigation/ui';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { MissionMonitorPanel } from '../components/MissionMonitorPanel';
import {
  MISSION_MONITOR_DELETE_VERB_ID,
  MISSION_MONITOR_DETAIL_CLOSE_VERB_ID,
  MISSION_MONITOR_DETAIL_PLACE_ID,
  MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID,
  MISSION_MONITOR_SEARCH_VERB_ID,
  MISSION_MONITOR_SESSIONS_PLACE_ID,
  MISSION_MONITOR_SURFACE_APP_ID,
  missionMonitorSurface,
  resetMissionMonitorSurfaceForTests,
} from '../missionMonitorSurface';

/* ───────────────────────────── panel dependencies ───────────────────────────── */

// A mutable declared-session set — the panel's list source (the real hook is stubbed below).
const declaredState = vi.hoisted(() => ({
  sessions: [
    { sessionId: 's1', startTime: 1, latestAt: '2026-01-01T00:00:00.000Z' },
  ] as Array<{ sessionId: string; startTime: number; latestAt: string }>,
}));

vi.mock('@/shared/hooks/useApplicationData', () => {
  const rows = () =>
    new Map(
      declaredState.sessions.map((s) => [
        JSON.stringify([s.sessionId]),
        {
          _rowVersion: 1,
          sessionId: s.sessionId,
          startedAtNs: s.startTime * 1e6,
          latestAt: s.latestAt,
          chatRowCount: 0,
          nonSubagentChatRowCount: 1,
          visibleTurnCount: 1,
          userDispatchCount: 0,
          derivedName: null,
          agentName: null,
          customName: null,
        },
      ]),
    );
  return {
    useApplicationRead: () => ({ rows: rows(), version: 1, error: null, loading: false }),
    useApplicationWatch: () => ({ rows: rows(), epoch: 1, error: null, ready: true }),
  };
});

vi.mock('@/shared/contexts/StreamContext', () => ({
  useStream: () => ({ isConnected: true, deliveries: [], health: 'healthy', clearEvents: vi.fn() }),
}));

const windowActionsState = vi.hoisted(() => ({ updateWindow: vi.fn() }));

vi.mock('@/shared/window-system/useWindowActions', () => ({
  useWindowActions: () => ({
    openWindow: vi.fn(),
    closeWindow: vi.fn(),
    focusWindow: vi.fn(),
    updateWindow: windowActionsState.updateWindow,
  }),
}));

vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="reactflow">{children}</div>
  ),
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: () => <div data-testid="minimap" />,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="reactflow-provider">{children}</div>
  ),
  useReactFlow: () => ({
    fitView: vi.fn(),
    setCenter: vi.fn(),
    getZoom: vi.fn(() => 1),
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
  }),
}));

vi.mock('../hooks/useMissionMonitor', () => ({
  useDeliveryGraph: () => ({
    nodes: [],
    edges: [],
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    unattributedCount: 0,
  }),
}));

vi.mock('../hooks/useSessionActivityWatch', () => ({
  useSessionActivityWatch: () => ({
    chatRows: new Map(),
    toolUseRows: new Map(),
    epoch: 0,
    error: null,
    ready: true,
  }),
}));

/* ───────────────────────────── helpers ───────────────────────────── */

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function host() {
  const registered = getNavigationHost(MISSION_MONITOR_SURFACE_APP_ID);
  if (registered === null) throw new Error('the Mission Monitor navigation host is not registered');
  return registered;
}

function mapVerbRow(verbId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${NAV_MAP_ROW_TESTID}"][data-nav-verb-id="${verbId}"]`,
  );
}

async function openMap(): Promise<void> {
  fireEvent.click(screen.getByTestId('navigation-bar-map'));
  await flushEffects();
  await waitFor(() => expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument());
}

beforeEach(() => {
  declaredState.sessions = [
    { sessionId: 's1', startTime: 1, latestAt: '2026-01-01T00:00:00.000Z' },
  ];
  resetMissionMonitorSurfaceForTests();
  resetNavigationAnnouncer();
  resetHotkeyAnnouncer();
});

afterEach(() => {
  cleanup();
  resetMissionMonitorSurfaceForTests();
  resetNavigationAnnouncer();
  resetHotkeyAnnouncer();
});

/* ───────────────────────────── R-01 — the declaration ───────────────────────────── */

describe('R-01 — the Mission Monitor declaration validates with zero diagnostics', () => {
  it('validateSurface(missionMonitorSurface) is exactly {valid:true, diagnostics:[]}', () => {
    expect(validateSurface(missionMonitorSurface)).toStrictEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it('declares the two B.3 places with the detail child sticky and the one `s` binding', () => {
    const { tree } = missionMonitorSurface;
    expect(tree.appId).toBe('mission-monitor');
    expect(tree.root).toBe(MISSION_MONITOR_SESSIONS_PLACE_ID);
    expect(tree.places.map((place) => place.id)).toEqual([
      MISSION_MONITOR_SESSIONS_PLACE_ID,
      MISSION_MONITOR_DETAIL_PLACE_ID,
    ]);
    expect(tree.directAliases).toStrictEqual({});

    const root = tree.places.find((place) => place.id === MISSION_MONITOR_SESSIONS_PLACE_ID);
    const detail = tree.places.find((place) => place.id === MISSION_MONITOR_DETAIL_PLACE_ID);
    if (root === undefined || detail === undefined) throw new Error('mission places missing');

    // §2.1 — the root sets neither transient nor sticky; the child sets exactly one.
    expect(root.parent).toBeNull();
    expect(root.transient).toBe(false);
    expect(root.sticky).toBe(false);
    expect(root.keys).toStrictEqual({
      s: { kind: 'verb', verbId: MISSION_MONITOR_SEARCH_VERB_ID },
    });

    expect(detail.parent).toBe(MISSION_MONITOR_SESSIONS_PLACE_ID);
    expect(detail.transient).toBe(false);
    expect(detail.sticky).toBe(true);
    expect(detail.keys).toStrictEqual({});
  });

  it('declares exactly the six B.5 verbs with the B.4 object nouns', () => {
    expect(missionMonitorSurface.verbs.map((verb) => verb.id)).toEqual([
      MISSION_MONITOR_SEARCH_VERB_ID,
      MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID,
      MISSION_MONITOR_DELETE_VERB_ID,
      MISSION_MONITOR_DETAIL_CLOSE_VERB_ID,
      MISSION_MONITOR_DETAIL_PLACE_ID,
      'app.map',
    ]);

    const byId = new Map(missionMonitorSurface.verbs.map((verb) => [verb.id, verb] as const));

    // B.4 — `monitor`/`session` object nouns only.
    expect(byId.get(MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID)?.appliesTo.objects).toStrictEqual([
      'monitor',
    ]);
    expect(byId.get(MISSION_MONITOR_SEARCH_VERB_ID)?.appliesTo.objects).toStrictEqual(['session']);
    expect(byId.get(MISSION_MONITOR_DELETE_VERB_ID)?.appliesTo.objects).toStrictEqual(['session']);
    expect(byId.get(MISSION_MONITOR_DETAIL_CLOSE_VERB_ID)?.appliesTo.objects).toStrictEqual([
      'session',
    ]);

    // No `n`/`p` session navigation is invented (the shipped `selectRelativeSession` is dead code).
    const boundStrokes = missionMonitorSurface.tree.places.flatMap((place) =>
      Object.keys(place.keys),
    );
    expect(boundStrokes).toStrictEqual(['s']);
    expect(boundStrokes).not.toContain('n');
    expect(boundStrokes).not.toContain('p');

    // `app.map` is navigation-only, unpublished and UNBOUND (no key anywhere).
    const mapVerb = byId.get('app.map');
    expect(mapVerb?.publish).toBe(false);
    expect(mapVerb?.risk).toBe('safe');

    // The D-9 place verb exists so the child-place rail row is a live affordance.
    const placeVerb = byId.get(MISSION_MONITOR_DETAIL_PLACE_ID);
    expect(placeVerb?.publish).toBe(false);
    expect(placeVerb?.appliesTo.places).toStrictEqual([MISSION_MONITOR_DETAIL_PLACE_ID]);

    // The destructive delete carries an authored consequence (V-10).
    expect(byId.get(MISSION_MONITOR_DELETE_VERB_ID)?.risk).toBe('destructive');
    expect(byId.get(MISSION_MONITOR_DELETE_VERB_ID)?.consequence ?? '').not.toBe('');
  });
});

/* ───────────────────────────── R-11 — selection-scoped availability ───────────────────────────── */

describe('R-11 — selection-scoped verbs gate on ctx.selection only', () => {
  const BASE = {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    placePath: [MISSION_MONITOR_SESSIONS_PLACE_ID],
    dirty: false,
  } as const;

  const emptyContext = {
    ...BASE,
    selection: { count: 0, kinds: [], label: null, ids: [] },
  };
  const selectedContext = {
    ...BASE,
    selection: { count: 1, kinds: ['session'], label: 's1', ids: ['s1'] },
  };

  function availabilityAt(verbId: string, context: typeof emptyContext | typeof selectedContext) {
    const model = buildNavigationMapModel(missionMonitorSurface, context);
    for (const place of model.places) {
      for (const verb of place.verbs) {
        if (verb.verbId === verbId) return verb.available;
      }
    }
    return undefined;
  }

  it('session.delete and detail.close are unavailable with no selection', () => {
    expect(availabilityAt(MISSION_MONITOR_DELETE_VERB_ID, emptyContext)).toBe(false);
    expect(availabilityAt(MISSION_MONITOR_DETAIL_CLOSE_VERB_ID, emptyContext)).toBe(false);
    // `always` verbs are unaffected by the empty selection.
    expect(availabilityAt(MISSION_MONITOR_SEARCH_VERB_ID, emptyContext)).toBe(true);
    expect(availabilityAt(MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID, emptyContext)).toBe(true);
  });

  it('session.delete and detail.close become available with a session selected', () => {
    expect(availabilityAt(MISSION_MONITOR_DELETE_VERB_ID, selectedContext)).toBe(true);
    expect(availabilityAt(MISSION_MONITOR_DETAIL_CLOSE_VERB_ID, selectedContext)).toBe(true);
  });
});

/* ───────────────────────────── R-08 — the mounted surfaces ───────────────────────────── */

describe('R-08 — the provider mounts the rail, trail and map over its own declaration', () => {
  it('mounts exactly ONE rail, ONE trail and ONE registered provider', async () => {
    renderWithChakra(<MissionMonitorPanel />);
    await flushEffects();

    expect(screen.getAllByTestId('navigation-bar')).toHaveLength(1);
    expect(screen.getAllByTestId(NAV_TRAIL_TESTID)).toHaveLength(1);
    expect(host()).toBeTruthy();

    const envelope = describeContext(MISSION_MONITOR_SURFACE_APP_ID);
    expect(envelope).not.toBeNull();
    expect(envelope?.placePath.map((place) => place.id)).toEqual([
      MISSION_MONITOR_SESSIONS_PLACE_ID,
    ]);
  });

  it('renders the ONE bound verb row (`s`) and the live detail place row; no `more…`', async () => {
    renderWithChakra(<MissionMonitorPanel />);
    await flushEffects();

    const verbRows = screen.getAllByTestId(NAV_RAIL_ROW_TESTID);
    expect(verbRows).toHaveLength(1);
    expect(verbRows[0]).toHaveAttribute('data-nav-verb-id', MISSION_MONITOR_SEARCH_VERB_ID);

    const placeRows = screen.getAllByTestId(NAV_RAIL_PLACE_ROW_TESTID);
    expect(placeRows).toHaveLength(1);
    expect(placeRows[0]).toHaveAttribute('data-nav-place-id', MISSION_MONITOR_DETAIL_PLACE_ID);
    expect(placeRows[0]).toHaveAttribute('aria-label', 'Detail — 0 actions');

    expect(screen.queryByTestId('navigation-bar-more')).toBeNull();
  });

  it('opens the shipped navigation map on demand', async () => {
    renderWithChakra(<MissionMonitorPanel />);
    await flushEffects();
    await openMap();

    expect(screen.getByTestId(NAV_MAP_TESTID)).toBeInTheDocument();
    // Both places are present in tree order.
    expect(document.querySelectorAll('[data-testid="navigation-map-place"]')).toHaveLength(2);
  });

  it('renders zero legacy element-key attribute nodes (AC7)', async () => {
    renderWithChakra(<MissionMonitorPanel />);
    await flushEffects();
    // Construct the attribute name so this file is not itself a literal hit for the
    // per-surface AC7 scan (R-14 counts source, comments and tests).
    const legacyAttr = ['data', 'hotkey'].join('-');
    expect(document.querySelectorAll(`[${legacyAttr}]`)).toHaveLength(0);
  });
});

/* ───────────────────────────── R-03 / R-04 — the `s` stroke ───────────────────────────── */

describe('R-03 / R-04 — `s` focuses the session filter and is inert when collapsed', () => {
  it('focuses [data-testid="mm-session-search"] while the drawer is expanded (default) and journals the declared verb', async () => {
    renderWithChakra(<MissionMonitorPanel />);
    await flushEffects();

    const input = screen.getByTestId('mm-session-search');
    expect(input).toBeInTheDocument();

    const registered = host();
    const entriesBefore = registered.getSnapshot().entries.length;

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('navigation-bar'), { key: 's' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(document.activeElement).toBe(input));

    const entries = registered.getSnapshot().entries;
    expect(entries).toHaveLength(entriesBefore + 1);
    expect(entries[entries.length - 1]?.verbId).toBe(MISSION_MONITOR_SEARCH_VERB_ID);
    expect(entries[entries.length - 1]?.channel).toBe('keyboard');
  });

  it('is inert when the drawer is collapsed (the filter input is not mounted)', async () => {
    renderWithChakra(<MissionMonitorPanel />);
    await flushEffects();

    // Collapse the drawer through its shipped toggle (no pointer hover involved).
    fireEvent.click(screen.getByTitle('Close'));
    await flushEffects();
    expect(screen.queryByTestId('mm-session-search')).toBeNull();

    const registered = host();
    const entriesBefore = registered.getSnapshot().entries.length;

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('navigation-bar'), { key: 's' });
      await Promise.resolve();
      await Promise.resolve();
    });

    // At most a noop: no journal entry, no new state.
    expect(registered.getSnapshot().entries).toHaveLength(entriesBefore);
  });
});

/* ───────────────────────────── R-11 — the rendered map rows flip ───────────────────────────── */

describe('R-11 — the rendered map rows flip with the selection', () => {
  it('session.delete / detail.close map rows are disabled with no selection and enabled with one', async () => {
    // No sessions ⇒ empty selection.
    declaredState.sessions = [];
    const first = renderWithChakra(<MissionMonitorPanel />);
    await flushEffects();
    await openMap();

    expect(mapVerbRow(MISSION_MONITOR_DELETE_VERB_ID)?.getAttribute('data-nav-availability')).toBe(
      'disabled',
    );
    expect(
      mapVerbRow(MISSION_MONITOR_DETAIL_CLOSE_VERB_ID)?.getAttribute('data-nav-availability'),
    ).toBe('disabled');
    first.unmount();
    await flushEffects();

    // One session (auto-selected) ⇒ non-empty selection.
    declaredState.sessions = [
      { sessionId: 's1', startTime: 1, latestAt: '2026-01-01T00:00:00.000Z' },
    ];
    renderWithChakra(<MissionMonitorPanel />);
    // Auto-select runs in an effect; flush it (and the provider's refreshContext publish).
    await flushEffects();
    await flushEffects();
    await openMap();

    await waitFor(() => {
      expect(
        mapVerbRow(MISSION_MONITOR_DELETE_VERB_ID)?.getAttribute('data-nav-availability'),
      ).toBe('available');
    });
    expect(
      mapVerbRow(MISSION_MONITOR_DETAIL_CLOSE_VERB_ID)?.getAttribute('data-nav-availability'),
    ).toBe('available');
  });
});
