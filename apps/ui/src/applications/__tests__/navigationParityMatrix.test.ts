/**
 * Spec #3121 (P7), ST-6 — the FIVE-surface parity matrix + the declaration gate (QA R-13 / R-01
 * / R-15, Architect §B.8).
 *
 * The harness is parameterised over `ParityRow[]` — one row per OUTCOME-BEARING verb of each of
 * the five migrated surfaces (every §B.5 verb whose `run` changes observable state or focus,
 * excluding the pure navigation / `app.map` verbs). For every row it proves that the three
 * user-facing channels —
 *
 *   keyboard  : the real stroke path where a grammar stroke exists, otherwise
 *               `runIntent({channel:'keyboard'})` (the Architect's named exception, D-3/B.8)
 *   pointer   : `host.runVerb(verbId, 'pointer', args)` (the rail's `onRunVerb` seam)
 *   launcher  : `host.runIntent({verbId, args, channel:'launcher', actor:'human'})`
 *
 * — produce the SAME `observe()` value and journal the SAME `verbId`; the journal entries differ
 * ONLY in `channel` (and `actor` where the companion relay is used). Each non-noop run appends
 * EXACTLY ONE journal entry and invokes its action handler EXACTLY ONCE.
 *
 * TERMINAL, WINDOW-SYSTEM and SQL STUDIO have NO grammar stroke by design:
 *   - terminal — every keystroke belongs to the PTY (Architect §B.6/§B.7);
 *   - window-system — the three modifier chords are kept platform globals that DELEGATE into
 *     `runIntent({channel:'keyboard'})` (D-3(a)); the grammar cannot express them (§4.4);
 *   - SQL Studio — `Ctrl/Cmd+Enter` stays on the editor and is not a grammar stroke (D-3(b)).
 * Those rows say so explicitly (`keyboard: 'intent'`); no assertion is weakened.
 *
 * The declaration half of this file is the R-01 gate: five DISTINCT declarations validate with
 * zero diagnostics, the five app ids / roots / verb-id sets equal the plan, and the negative
 * controls prove the gate is not vacuous. The distinctness check is the CORRECT five-surface
 * check (G-316/G-404 — re-derived, never the old seven).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { validateSurface, type ContextSnapshot, type JournalEntry, type Surface } from '@/shared/navigation';
import { createNavigationHost, resetNavigationAnnouncer, type NavigationHost } from '@/shared/navigation/ui';

import {
  TERMINAL_COPY_AUTH_COMMAND_VERB_ID,
  TERMINAL_SURFACE_APP_ID,
  TERMINAL_WINDOW_PLACE_ID,
  resetTerminalSurfaceForTests,
  setTerminalActionHandlers,
  terminalSurface,
} from '../terminal/terminalSurface';
import {
  MISSION_MONITOR_DELETE_VERB_ID,
  MISSION_MONITOR_DETAIL_CLOSE_VERB_ID,
  MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID,
  MISSION_MONITOR_SEARCH_VERB_ID,
  MISSION_MONITOR_SESSIONS_PLACE_ID,
  MISSION_MONITOR_SURFACE_APP_ID,
  resetMissionMonitorSurfaceForTests,
  setMissionMonitorActionHandlers,
  missionMonitorSurface,
} from '../mission-monitor/missionMonitorSurface';
import {
  DATABASE_CLIENT_SURFACE_APP_ID,
  SQL_STUDIO_WORKSPACE_PLACE_ID,
  databaseClientSurface,
  registerDatabaseClientActionHandlers,
  resetDatabaseClientActionHandlersForTests,
} from '../database-client/databaseClientSurface';
import {
  DEV_MODE_EVENTS_CLEAR_VERB_ID,
  DEV_MODE_EVENTS_PLACE_ID,
  DEV_MODE_SEARCH_FOCUS_VERB_ID,
  DEV_MODE_STATES_ALL_VERB_ID,
  DEV_MODE_SURFACE_APP_ID,
  DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
  DEV_MODE_VIEW_ROWS_VERB_ID,
  devModeSurface,
  resetDevModeSurfaceForTests,
  setDevModeActionHandlers,
} from '../dev-mode/devModeSurface';
import {
  WINDOW_FOCUS_NEXT_VERB_ID,
  WINDOW_FOCUS_PREVIOUS_VERB_ID,
  WINDOW_LAUNCHER_TOGGLE_VERB_ID,
  WINDOW_SYSTEM_APP_ID,
  WINDOW_SYSTEM_ROOT_PLACE_ID,
  windowSystemSurface,
} from '@/shared/window-system/windowSystemSurface';
import {
  resetWindowLauncherToggleForTests,
  setWindowLauncherToggle,
} from '@/shared/window-system/launcherToggleSeam';

/* ───────────────────────────── window traversal mock (kept-global outcome) ───────────────────────────── */

/**
 * The window verbs run the SHIPPED `focusNextWindow()` / `focusPreviousWindow()`; jsdom has no
 * rendered window frames, so this file replaces ONLY those two functions with a deterministic
 * focus model. Everything else (the declaration, the host, the funnel) is the real product code.
 */
const windowFocus = vi.hoisted(() => ({ focused: 'a', nextCalls: 0, previousCalls: 0 }));

vi.mock('@/shared/hotkeys/traversal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/hotkeys/traversal')>();
  return {
    ...actual,
    focusNextWindow: () => {
      windowFocus.nextCalls += 1;
      windowFocus.focused = 'b';
      return true;
    },
    focusPreviousWindow: () => {
      windowFocus.previousCalls += 1;
      windowFocus.focused = 'a';
      return true;
    },
  };
});

/* ───────────────────────────── app fakes (the handler seams the verbs delegate to) ───────────────────────────── */

const terminalState = { outcome: null as string | null, calls: 0 };
const missionState = {
  drawerOpen: false,
  focused: null as string | null,
  deleted: null as string | null,
  detailOpen: true,
  calls: 0,
};
const sqlState = { outcome: null as string | null, calls: 0 };
const devState = {
  view: 'rows' as 'rows' | 'application-data',
  events: 2,
  filterFocused: false,
  allStates: false,
  noop: false,
  calls: 0,
};
const windowState = { launcherOpen: false, launcherCalls: 0 };

function registerAllHandlers(): void {
  setTerminalActionHandlers({
    newSession: () => recordTerminal('new'),
    closeSession: (id) => recordTerminal(`close:${id}`),
    openRename: (id) => recordTerminal(`rename:${id}`),
    renameSession: (id, name) => recordTerminal(`rename:${id}:${name}`),
    resumeSession: (id) => recordTerminal(`resume:${id}`),
    startFresh: (id) => recordTerminal(`startFresh:${id}`),
    retrySession: (id) => recordTerminal(`retry:${id}`),
    chooseDirectory: (id) => recordTerminal(`chooseDirectory:${id}`),
    deleteRecord: (id) => recordTerminal(`deleteRecord:${id}`),
    copyAuthCommand: () => recordTerminal('copyAuthCommand'),
  });

  setMissionMonitorActionHandlers({
    focusSearch: () => {
      missionState.calls += 1;
      missionState.focused = 'search';
      return true;
    },
    toggleDrawer: () => {
      missionState.calls += 1;
      missionState.drawerOpen = !missionState.drawerOpen;
      return true;
    },
    deleteSession: (sessionId) => {
      missionState.calls += 1;
      missionState.deleted = sessionId;
      return true;
    },
    closeDetail: () => {
      missionState.calls += 1;
      missionState.detailOpen = false;
      return true;
    },
  });

  registerDatabaseClientActionHandlers({
    connectionNew: () => recordSql('connection.new'),
    connectionEdit: (id) => recordSql(`connection.edit:${id}`),
    connectionDelete: (id) => recordSql(`connection.delete:${id}`),
    connectionDisconnect: () => recordSql('connection.disconnect'),
    connectionRetry: () => recordSql('connection.retry'),
    schemaViewColumns: () => recordSql('schema.viewColumns'),
    schemaOpenData: () => recordSql('schema.openData'),
    schemaNewQuery: () => recordSql('schema.newQuery'),
    queryRun: () => recordSql('query.run'),
    queryRunAll: () => recordSql('query.runAll'),
    tabNew: () => recordSql('tab.new'),
    tabClose: (id) => recordSql(`tab.close:${id}`),
    resultsLoadMore: () => recordSql('results.loadMore'),
    resultsExportCsv: () => recordSql('results.exportCsv'),
    resultsExportJson: () => recordSql('results.exportJson'),
    historyClear: () => recordSql('history.clear'),
  });

  setDevModeActionHandlers({
    clearEvents: () => {
      devState.calls += 1;
      if (devState.noop) return false;
      devState.events = 0;
      return true;
    },
    focusFilter: () => {
      devState.calls += 1;
      if (devState.noop) return false;
      devState.filterFocused = true;
      return true;
    },
    showAllStates: () => {
      devState.calls += 1;
      if (devState.noop) return false;
      devState.allStates = true;
      return true;
    },
    showApplicationData: () => {
      devState.calls += 1;
      if (devState.noop) return false;
      devState.view = 'application-data';
      return true;
    },
    showRows: () => {
      devState.calls += 1;
      if (devState.noop) return false;
      devState.view = 'rows';
      return true;
    },
  });

  setWindowLauncherToggle(() => {
    windowState.launcherCalls += 1;
    windowState.launcherOpen = true;
  });
}

function recordTerminal(outcome: string): boolean {
  terminalState.calls += 1;
  terminalState.outcome = outcome;
  return true;
}

function recordSql(outcome: string): boolean {
  sqlState.calls += 1;
  sqlState.outcome = outcome;
  return true;
}

/* ───────────────────────────── injected contexts (Architect §D.4) ───────────────────────────── */

function terminalContext(): ContextSnapshot {
  return {
    appId: TERMINAL_SURFACE_APP_ID,
    placePath: [TERMINAL_WINDOW_PLACE_ID],
    selection: { count: 1, kinds: ['session'], label: 'session', ids: ['sess-1'] },
    dirty: false,
  };
}

function windowContext(): ContextSnapshot {
  return {
    appId: WINDOW_SYSTEM_APP_ID,
    placePath: [WINDOW_SYSTEM_ROOT_PLACE_ID],
    selection: { count: 1, kinds: ['window'], label: 'window', ids: [windowFocus.focused] },
    dirty: false,
  };
}

function missionContext(): ContextSnapshot {
  return {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    placePath: [MISSION_MONITOR_SESSIONS_PLACE_ID],
    selection: { count: 1, kinds: ['session'], label: 'session', ids: ['sess-1'] },
    dirty: false,
  };
}

function sqlContext(): ContextSnapshot {
  return {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    placePath: [SQL_STUDIO_WORKSPACE_PLACE_ID],
    selection: {
      count: 4,
      kinds: ['connection', 'table', 'query', 'resultSet'],
      label: 'resultSet',
      ids: ['c1', 't1', 'q1', 'rs1'],
    },
    dirty: false,
  };
}

function devContext(): ContextSnapshot {
  return {
    appId: DEV_MODE_SURFACE_APP_ID,
    placePath: [DEV_MODE_EVENTS_PLACE_ID],
    selection: { count: 1, kinds: ['panel'], label: devState.view, ids: [devState.view] },
    dirty: false,
  };
}

/* ───────────────────────────── the parameterised matrix ───────────────────────────── */

interface ParityRow {
  readonly appId: string;
  readonly verbId: string;
  readonly args: Readonly<Record<string, string>>;
  /**
   * `stroke` drives the REAL resolver path; `intent` uses `runIntent({channel:'keyboard'})`
   * because the surface declares no grammar-expressible stroke (see the file header).
   */
  readonly keyboard: 'stroke' | 'intent';
  readonly keyStroke?: string;
  readonly prepare: () => void;
  readonly observe: () => unknown;
  readonly expected: unknown;
  readonly invocations: () => number;
}

function resetTerminal(): void {
  terminalState.outcome = null;
  terminalState.calls = 0;
}

function resetMission(): void {
  missionState.drawerOpen = false;
  missionState.focused = null;
  missionState.deleted = null;
  missionState.detailOpen = true;
  missionState.calls = 0;
}

function resetSql(): void {
  sqlState.outcome = null;
  sqlState.calls = 0;
}

function resetDev(view: 'rows' | 'application-data' = 'rows'): void {
  devState.view = view;
  devState.events = 2;
  devState.filterFocused = false;
  devState.allStates = false;
  devState.noop = false;
  devState.calls = 0;
}

function resetWindow(): void {
  windowFocus.focused = 'a';
  windowFocus.nextCalls = 0;
  windowFocus.previousCalls = 0;
  windowState.launcherOpen = false;
  windowState.launcherCalls = 0;
}

const TERMINAL_ROWS: readonly ParityRow[] = [
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.new',
    args: {},
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'new',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.close',
    args: { id: 'sess-1' },
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'close:sess-1',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.rename',
    args: { id: 'sess-1', name: 'Renamed' },
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'rename:sess-1:Renamed',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.resume',
    args: { id: 'sess-1' },
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'resume:sess-1',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.startFresh',
    args: { id: 'sess-1' },
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'startFresh:sess-1',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.retry',
    args: { id: 'sess-1' },
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'retry:sess-1',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.chooseDirectory',
    args: { id: 'sess-1' },
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'chooseDirectory:sess-1',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: 'terminal.session.deleteRecord',
    args: { id: 'sess-1' },
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'deleteRecord:sess-1',
    invocations: () => terminalState.calls,
  },
  {
    appId: TERMINAL_SURFACE_APP_ID,
    verbId: TERMINAL_COPY_AUTH_COMMAND_VERB_ID,
    args: {},
    keyboard: 'intent',
    prepare: resetTerminal,
    observe: () => terminalState.outcome,
    expected: 'copyAuthCommand',
    invocations: () => terminalState.calls,
  },
];

const WINDOW_ROWS: readonly ParityRow[] = [
  {
    appId: WINDOW_SYSTEM_APP_ID,
    verbId: WINDOW_FOCUS_NEXT_VERB_ID,
    args: {},
    keyboard: 'intent',
    prepare: () => {
      resetWindow();
      windowFocus.focused = 'a';
    },
    observe: () => windowFocus.focused,
    expected: 'b',
    invocations: () => windowFocus.nextCalls,
  },
  {
    appId: WINDOW_SYSTEM_APP_ID,
    verbId: WINDOW_FOCUS_PREVIOUS_VERB_ID,
    args: {},
    keyboard: 'intent',
    prepare: () => {
      resetWindow();
      windowFocus.focused = 'b';
    },
    observe: () => windowFocus.focused,
    expected: 'a',
    invocations: () => windowFocus.previousCalls,
  },
  {
    appId: WINDOW_SYSTEM_APP_ID,
    verbId: WINDOW_LAUNCHER_TOGGLE_VERB_ID,
    args: {},
    keyboard: 'intent',
    prepare: resetWindow,
    observe: () => windowState.launcherOpen,
    expected: true,
    invocations: () => windowState.launcherCalls,
  },
];

const MISSION_ROWS: readonly ParityRow[] = [
  {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    verbId: MISSION_MONITOR_SEARCH_VERB_ID,
    args: {},
    keyboard: 'stroke',
    keyStroke: 's',
    prepare: resetMission,
    observe: () => missionState.focused,
    expected: 'search',
    invocations: () => missionState.calls,
  },
  {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    verbId: MISSION_MONITOR_DRAWER_TOGGLE_VERB_ID,
    args: {},
    keyboard: 'intent',
    prepare: resetMission,
    observe: () => missionState.drawerOpen,
    expected: true,
    invocations: () => missionState.calls,
  },
  {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    verbId: MISSION_MONITOR_DELETE_VERB_ID,
    args: { sessionId: 'sess-1' },
    keyboard: 'intent',
    prepare: resetMission,
    observe: () => missionState.deleted,
    expected: 'sess-1',
    invocations: () => missionState.calls,
  },
  {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    verbId: MISSION_MONITOR_DETAIL_CLOSE_VERB_ID,
    args: {},
    keyboard: 'intent',
    prepare: resetMission,
    observe: () => missionState.detailOpen,
    expected: false,
    invocations: () => missionState.calls,
  },
];

const SQL_ROWS: readonly ParityRow[] = [
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.connection.new',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'connection.new',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.connection.edit',
    args: { connectionId: 'c1' },
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'connection.edit:c1',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.connection.delete',
    args: { connectionId: 'c1' },
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'connection.delete:c1',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.connection.disconnect',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'connection.disconnect',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.connection.retry',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'connection.retry',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.schema.viewColumns',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'schema.viewColumns',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.schema.openData',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'schema.openData',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.schema.newQuery',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'schema.newQuery',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.query.run',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'query.run',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.query.runAll',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'query.runAll',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.tab.new',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'tab.new',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.tab.close',
    args: { tabId: 'q1' },
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'tab.close:q1',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.results.loadMore',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'results.loadMore',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.results.exportCsv',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'results.exportCsv',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.results.exportJson',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'results.exportJson',
    invocations: () => sqlState.calls,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.history.clear',
    args: {},
    keyboard: 'intent',
    prepare: resetSql,
    observe: () => sqlState.outcome,
    expected: 'history.clear',
    invocations: () => sqlState.calls,
  },
];

const DEV_ROWS: readonly ParityRow[] = [
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_EVENTS_CLEAR_VERB_ID,
    args: {},
    keyboard: 'stroke',
    keyStroke: 'x',
    prepare: () => resetDev('rows'),
    observe: () => devState.events,
    expected: 0,
    invocations: () => devState.calls,
  },
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_SEARCH_FOCUS_VERB_ID,
    args: {},
    keyboard: 'stroke',
    keyStroke: 'i',
    prepare: () => resetDev('rows'),
    observe: () => devState.filterFocused,
    expected: true,
    invocations: () => devState.calls,
  },
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_STATES_ALL_VERB_ID,
    args: {},
    keyboard: 'stroke',
    keyStroke: 'b',
    prepare: () => resetDev('rows'),
    observe: () => devState.allStates,
    expected: true,
    invocations: () => devState.calls,
  },
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
    args: {},
    keyboard: 'stroke',
    keyStroke: 'v',
    prepare: () => resetDev('rows'),
    observe: () => devState.view,
    expected: 'application-data',
    invocations: () => devState.calls,
  },
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_VIEW_ROWS_VERB_ID,
    args: {},
    // No grammar stroke enters the rows view — the same channel, through the intent seam.
    keyboard: 'intent',
    prepare: () => resetDev('application-data'),
    observe: () => devState.view,
    expected: 'rows',
    invocations: () => devState.calls,
  },
];

const ALL_ROWS: readonly ParityRow[] = [
  ...TERMINAL_ROWS,
  ...WINDOW_ROWS,
  ...MISSION_ROWS,
  ...SQL_ROWS,
  ...DEV_ROWS,
];

/* ───────────────────────────── hosts (the ONE funnel per surface) ───────────────────────────── */

interface Fixture {
  readonly surface: Surface;
  readonly host: NavigationHost;
}

const fixtures = new Map<string, Fixture>();

function buildFixtures(): void {
  fixtures.clear();
  fixtures.set(TERMINAL_SURFACE_APP_ID, {
    surface: terminalSurface,
    host: createNavigationHost({ surface: terminalSurface, getContext: terminalContext }),
  });
  fixtures.set(WINDOW_SYSTEM_APP_ID, {
    surface: windowSystemSurface,
    host: createNavigationHost({ surface: windowSystemSurface, getContext: windowContext }),
  });
  fixtures.set(MISSION_MONITOR_SURFACE_APP_ID, {
    surface: missionMonitorSurface,
    host: createNavigationHost({ surface: missionMonitorSurface, getContext: missionContext }),
  });
  fixtures.set(DATABASE_CLIENT_SURFACE_APP_ID, {
    surface: databaseClientSurface,
    host: createNavigationHost({ surface: databaseClientSurface, getContext: sqlContext }),
  });
  fixtures.set(DEV_MODE_SURFACE_APP_ID, {
    surface: devModeSurface,
    host: createNavigationHost({ surface: devModeSurface, getContext: devContext }),
  });
}

function fixtureOf(appId: string): Fixture {
  const fixture = fixtures.get(appId);
  if (fixture === undefined) throw new Error(`no host fixture for ${appId}`);
  return fixture;
}

/** Run one row on one channel; `keyboard` honours the row's declared stroke path. */
async function runChannel(
  row: ParityRow,
  channel: 'keyboard' | 'pointer' | 'launcher' | 'agent',
): Promise<{ readonly entries: readonly JournalEntry[] }> {
  const { host } = fixtureOf(row.appId);
  row.prepare();
  host.reset();

  if (channel === 'keyboard' && row.keyboard === 'stroke') {
    if (row.keyStroke === undefined) throw new Error(`${row.verbId} declared no keyStroke`);
    const result = await host.handleStroke(row.keyStroke, 1_000);
    expect(result, `${row.verbId} keyboard stroke`).not.toBeNull();
    expect(result?.status, `${row.verbId} keyboard stroke`).toBe('performed');
  } else if (channel === 'pointer') {
    const result = await host.runVerb(row.verbId, 'pointer', row.args);
    expect(result.status, `${row.verbId} pointer`).toBe('performed');
  } else {
    const result = await host.runIntent({
      verbId: row.verbId,
      args: row.args,
      channel,
      actor: channel === 'agent' ? 'companion' : 'human',
    });
    expect(result.status, `${row.verbId} ${channel}`).toBe('performed');
  }

  return { entries: host.getSnapshot().entries };
}

/** A journal entry without the fields every channel is expected to differ in. */
function comparable(entry: JournalEntry): Omit<JournalEntry, 'seq' | 'ts' | 'channel' | 'actor'> {
  const { seq: _seq, ts: _ts, channel: _channel, actor: _actor, ...rest } = entry;
  return rest;
}

beforeEach(() => {
  resetTerminalSurfaceForTests();
  resetMissionMonitorSurfaceForTests();
  resetDatabaseClientActionHandlersForTests();
  resetDevModeSurfaceForTests();
  resetWindowLauncherToggleForTests();
  resetNavigationAnnouncer();
  registerAllHandlers();
  buildFixtures();
});

afterEach(() => {
  resetTerminalSurfaceForTests();
  resetMissionMonitorSurfaceForTests();
  resetDatabaseClientActionHandlersForTests();
  resetDevModeSurfaceForTests();
  resetWindowLauncherToggleForTests();
  resetNavigationAnnouncer();
});

/* ───────────────────────────── R-01 — the five-surface declaration gate ───────────────────────────── */

/**
 * The B.5 verb ids, written out (NOT read from the module constants) so this gate cannot pass
 * simply because the declaration and the assertion share one source of truth.
 */
const PLAN_VERB_IDS: Readonly<Record<string, readonly string[]>> = {
  terminal: [
    'terminal.session.new',
    'terminal.session.close',
    'terminal.session.rename',
    'terminal.session.resume',
    'terminal.session.startFresh',
    'terminal.session.retry',
    'terminal.session.chooseDirectory',
    'terminal.session.deleteRecord',
    'terminal.session.copyAuthCommand',
    'terminal.session.enter',
    'terminal.session',
    'app.map',
  ],
  'window-system': [
    'window.focus.next',
    'window.focus.previous',
    'window.launcher.toggle',
    'app.map',
  ],
  'mission-monitor': [
    'mission-monitor.session.search',
    'mission-monitor.drawer.toggle',
    'mission-monitor.session.delete',
    'mission-monitor.detail.close',
    'mission-monitor.detail',
    'app.map',
  ],
  'database-client': [
    'sql-studio.connection.new',
    'sql-studio.connection.edit',
    'sql-studio.connection.delete',
    'sql-studio.connection.disconnect',
    'sql-studio.connection.retry',
    'sql-studio.schema.viewColumns',
    'sql-studio.schema.openData',
    'sql-studio.schema.newQuery',
    'sql-studio.query.run',
    'sql-studio.query.runAll',
    'sql-studio.tab.new',
    'sql-studio.tab.close',
    'sql-studio.results.loadMore',
    'sql-studio.results.exportCsv',
    'sql-studio.results.exportJson',
    'sql-studio.history.clear',
    'sql-studio.schema',
    'sql-studio.query',
    'sql-studio.results',
    'app.map',
  ],
  'dev-mode': [
    'dev-mode.events.clear',
    'dev-mode.search.focus',
    'dev-mode.states.all',
    'dev-mode.view.applicationData',
    'dev-mode.view.rows',
    'dev-mode.applicationData',
    'app.map',
  ],
};

const PLAN_ROOTS: Readonly<Record<string, string>> = {
  terminal: 'terminal.window',
  'window-system': 'window-system.root',
  'mission-monitor': 'mission-monitor.sessions',
  'database-client': 'sql-studio.workspace',
  'dev-mode': 'dev-mode.events',
};

/** Spec #3122 ST-4 — the retained navigation surfaces are the only in-scope app ids. */
const SURFACE_APP_IDS = new Set<string>([
  TERMINAL_SURFACE_APP_ID,
  WINDOW_SYSTEM_APP_ID,
  MISSION_MONITOR_SURFACE_APP_ID,
  DATABASE_CLIENT_SURFACE_APP_ID,
  DEV_MODE_SURFACE_APP_ID,
]);

interface SurfaceEntry {
  readonly appId: string;
  readonly surface: Surface;
}

const FIVE_SURFACES: readonly SurfaceEntry[] = [
  { appId: TERMINAL_SURFACE_APP_ID, surface: terminalSurface },
  { appId: WINDOW_SYSTEM_APP_ID, surface: windowSystemSurface },
  { appId: MISSION_MONITOR_SURFACE_APP_ID, surface: missionMonitorSurface },
  { appId: DATABASE_CLIENT_SURFACE_APP_ID, surface: databaseClientSurface },
  { appId: DEV_MODE_SURFACE_APP_ID, surface: devModeSurface },
];

/** The corrected FIVE-surface scope predicate (G-316/G-404 — re-derived, never seven). */
function scopeIsFive(surfaces: readonly SurfaceEntry[]): boolean {
  if (surfaces.length !== 5) return false;
  const ids = surfaces.map((entry) => entry.appId);
  if (new Set(ids).size !== 5) return false;
  return ids.every((id) => SURFACE_APP_IDS.has(id));
}

/** `app.map` is declared keyless in every place and alias table. */
function mapVerbUnbound(surface: Surface): boolean {
  for (const place of surface.tree.places) {
    for (const binding of Object.values(place.keys)) {
      if (binding.kind === 'verb' && binding.verbId === 'app.map') return false;
    }
  }
  return !Object.values(surface.tree.directAliases).includes('app.map');
}

function cloneSurface(surface: Surface): Surface {
  return {
    tree: {
      ...surface.tree,
      places: surface.tree.places.map((place) => ({ ...place, keys: { ...place.keys } })),
      directAliases: { ...surface.tree.directAliases },
    },
    verbs: surface.verbs,
    companion: surface.companion,
  };
}

describe('R-01 — the five-surface declaration gate', () => {
  it('declares exactly five DISTINCT surfaces with five distinct app ids', () => {
    expect(scopeIsFive(FIVE_SURFACES)).toBe(true);
    expect(new Set(FIVE_SURFACES.map((entry) => entry.surface)).size).toBe(5);
    expect(new Set(FIVE_SURFACES.map((entry) => entry.surface.tree.appId)).size).toBe(5);
    expect(FIVE_SURFACES.map((entry) => entry.appId).sort()).toEqual(
      ['database-client', 'dev-mode', 'mission-monitor', 'terminal', 'window-system'],
    );
  });

  it('validates each surface with exactly {valid:true, diagnostics:[]}', () => {
    for (const entry of FIVE_SURFACES) {
      expect(validateSurface(entry.surface), entry.appId).toStrictEqual({
        valid: true,
        diagnostics: [],
      });
    }
  });

  it('declares the B.3 roots and the exact B.5 verb-id sets (12/4/6/20/7)', () => {
    for (const entry of FIVE_SURFACES) {
      expect(entry.surface.tree.appId, entry.appId).toBe(entry.appId);
      expect(entry.surface.tree.root, entry.appId).toBe(PLAN_ROOTS[entry.appId]);
      expect(entry.surface.verbs.map((verb) => verb.id), entry.appId).toEqual(
        PLAN_VERB_IDS[entry.appId],
      );
    }
    expect(FIVE_SURFACES.map((entry) => entry.surface.verbs.length)).toEqual([12, 4, 6, 20, 7]);
  });

  it('marks every non-root place with exactly one of transient/sticky', () => {
    for (const entry of FIVE_SURFACES) {
      for (const place of entry.surface.tree.places) {
        if (place.parent === null) {
          expect(place.transient, `${entry.appId}:${place.id}`).toBe(false);
          expect(place.sticky, `${entry.appId}:${place.id}`).toBe(false);
          continue;
        }
        expect(place.transient !== place.sticky, `${entry.appId}:${place.id}`).toBe(true);
      }
    }
  });

  it('declares app.map publish:false and keyless in all five', () => {
    for (const entry of FIVE_SURFACES) {
      const map = entry.surface.verbs.find((verb) => verb.id === 'app.map');
      expect(map, entry.appId).toBeDefined();
      expect(map?.publish, entry.appId).toBe(false);
      expect(mapVerbUnbound(entry.surface), entry.appId).toBe(true);
    }
  });

  it('negative control — a duplicated normalized stroke yields exactly one V-07/NAV-E007', () => {
    const clone = cloneSurface(devModeSurface);
    const root = clone.tree.places[0];
    if (root === undefined) throw new Error('dev-mode root place missing');
    const existing = root.keys.x;
    if (existing === undefined) throw new Error('dev-mode root `x` binding missing');
    // `X` and `x` are distinct object keys but normalize to the SAME stroke (registry rule).
    const places = clone.tree.places.map((place) =>
      place.id === root.id ? { ...place, keys: { ...place.keys, X: existing } } : place,
    );

    const result = validateSurface({
      ...clone,
      tree: { ...clone.tree, places },
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['NAV-E007']);
    expect(result.diagnostics[0]?.rule).toBe('V-07');
  });

  it('negative control — a surface without a root reports V-02/NAV-E002', () => {
    const clone = cloneSurface(terminalSurface);
    const result = validateSurface({
      ...clone,
      tree: {
        ...clone.tree,
        places: clone.tree.places.filter((place) => place.id !== clone.tree.root),
      },
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('NAV-E002');
  });

  it('negative control — a sixth (removed-app) id fails the FIVE-surface scope check', () => {
    expect(
      scopeIsFive([...FIVE_SURFACES, { appId: 'removed-app', surface: terminalSurface }]),
    ).toBe(false);
  });

  it('negative control — a key bound to app.map is rejected', () => {
    const clone = cloneSurface(devModeSurface);
    const root = clone.tree.places[0];
    if (root === undefined) throw new Error('dev-mode root place missing');
    const places = clone.tree.places.map((place) =>
      place.id === root.id
        ? { ...place, keys: { ...place.keys, m: { kind: 'verb' as const, verbId: 'app.map' } } }
        : place,
    );
    expect(mapVerbUnbound({ ...clone, tree: { ...clone.tree, places } })).toBe(false);
  });
});

/* ───────────────────────────── R-15 — no app-owned g+* sequence (declaration side) ───────────────────────────── */

/** App-owned two-step sequences are forbidden for the migrated surfaces (AC7). */
function hasAppOwnedSequence(surface: Surface): boolean {
  const strokes = [
    ...surface.tree.places.flatMap((place) => Object.keys(place.keys)),
    ...Object.keys(surface.tree.directAliases),
  ];
  return strokes.some((stroke) => stroke.startsWith('g+'));
}

describe('R-15 — the five surfaces own no g+* sequence', () => {
  it('declares zero app-owned g+* strokes in any of the five', () => {
    for (const entry of FIVE_SURFACES) {
      expect(hasAppOwnedSequence(entry.surface), entry.appId).toBe(false);
    }
  });

  it('the scanner control fires on a constructed g+i sequence (non-vacuous)', () => {
    const clone = cloneSurface(devModeSurface);
    const root = clone.tree.places[0];
    if (root === undefined) throw new Error('dev-mode root place missing');
    const places = clone.tree.places.map((place) =>
      place.id === root.id
        ? {
            ...place,
            keys: {
              ...place.keys,
              [['g', 'i'].join('+')]: { kind: 'verb' as const, verbId: DEV_MODE_EVENTS_CLEAR_VERB_ID },
            },
          }
        : place,
    );
    expect(
      hasAppOwnedSequence({ ...clone, tree: { ...clone.tree, places } }),
    ).toBe(true);
  });
});

/* ───────────────────────────── R-13 — the parameterised parity matrix ───────────────────────────── */

describe('R-13 — keyboard / pointer / launcher parity', () => {
  it('covers every outcome-bearing verb of the five surfaces (a superset of the 11 legacy bindings)', () => {
    expect(ALL_ROWS.length).toBe(37);
    const perApp = new Map<string, number>();
    for (const row of ALL_ROWS) perApp.set(row.appId, (perApp.get(row.appId) ?? 0) + 1);
    expect(Object.fromEntries(perApp)).toStrictEqual({
      terminal: 9,
      'window-system': 3,
      'mission-monitor': 4,
      'database-client': 16,
      'dev-mode': 5,
    });
    // Every row cites a verb the surface actually declares (no invented row).
    for (const row of ALL_ROWS) {
      const { surface } = fixtureOf(row.appId);
      expect(
        surface.verbs.some((verb) => verb.id === row.verbId),
        `${row.appId}:${row.verbId}`,
      ).toBe(true);
    }
  });

  it.each(ALL_ROWS.map((row) => [`${row.appId} :: ${row.verbId}`, row] as const))(
    '%s — all channels reproduce the same outcome, verb id and one journal entry',
    async (_name, row) => {
      const keyboard = await runChannel(row, 'keyboard');
      const pointer = await runChannel(row, 'pointer');
      const launcher = await runChannel(row, 'launcher');

      for (const [channel, run] of [
        ['keyboard', keyboard],
        ['pointer', pointer],
        ['launcher', launcher],
      ] as const) {
        expect(run.entries, `${row.verbId} ${channel}`).toHaveLength(1);
        const entry = run.entries[0];
        expect(entry?.verbId, `${row.verbId} ${channel}`).toBe(row.verbId);
        expect(entry?.channel, `${row.verbId} ${channel}`).toBe(channel);
        expect(entry?.actor, `${row.verbId} ${channel}`).toBe('human');
      }

      // The three journal entries differ ONLY in `channel` (and seq/ts bookkeeping).
      expect(comparable(pointer.entries[0] as JournalEntry)).toStrictEqual(
        comparable(keyboard.entries[0] as JournalEntry),
      );
      expect(comparable(launcher.entries[0] as JournalEntry)).toStrictEqual(
        comparable(keyboard.entries[0] as JournalEntry),
      );

      // The companion relay journals the SAME verb (only channel + actor differ).
      const companion = await runChannel(row, 'agent');
      expect(companion.entries).toHaveLength(1);
      expect(companion.entries[0]?.verbId).toBe(row.verbId);
      expect(companion.entries[0]?.channel).toBe('agent');
      expect(companion.entries[0]?.actor).toBe('companion');
      expect(comparable(companion.entries[0] as JournalEntry)).toStrictEqual(
        comparable(keyboard.entries[0] as JournalEntry),
      );
    },
  );

  it.each(ALL_ROWS.map((row) => [`${row.appId} :: ${row.verbId}`, row] as const))(
    '%s — the action handler runs exactly once per channel',
    async (_name, row) => {
      await runChannel(row, 'keyboard');
      expect(row.invocations(), `${row.verbId} keyboard`).toBe(1);
      await runChannel(row, 'pointer');
      expect(row.invocations(), `${row.verbId} pointer`).toBe(1);
      await runChannel(row, 'launcher');
      expect(row.invocations(), `${row.verbId} launcher`).toBe(1);
      await runChannel(row, 'agent');
      expect(row.invocations(), `${row.verbId} agent`).toBe(1);
    },
  );

  it('three consecutive non-noop runs grow the journal by exactly three', async () => {
    const row = DEV_ROWS.find(
      (candidate) => candidate.verbId === DEV_MODE_VIEW_APPLICATION_DATA_VERB_ID,
    );
    if (row === undefined) throw new Error('dev-mode view row missing');
    const { host } = fixtureOf(row.appId);
    host.reset();

    for (let run = 0; run < 3; run += 1) {
      row.prepare();
      const result = await host.runVerb(row.verbId, 'pointer', row.args);
      expect(result.status).toBe('performed');
    }
    expect(host.getSnapshot().entries).toHaveLength(3);
  });
});

/* ───────────────────────────── R-13 edge — noop rows journal nothing on EVERY channel ───────────────────────────── */

interface NoopRow {
  readonly appId: string;
  readonly verbId: string;
  readonly keyboard: 'stroke' | 'intent';
  readonly keyStroke?: string;
  readonly prepare: () => void;
  readonly observe: () => unknown;
  readonly expected: unknown;
}

const NOOP_ROWS: readonly NoopRow[] = [
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_EVENTS_CLEAR_VERB_ID,
    keyboard: 'stroke',
    keyStroke: 'x',
    prepare: () => {
      resetDev('rows');
      devState.events = 0;
      devState.noop = true;
    },
    observe: () => devState.events,
    expected: 0,
  },
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_STATES_ALL_VERB_ID,
    keyboard: 'stroke',
    keyStroke: 'b',
    prepare: () => {
      resetDev('rows');
      devState.allStates = true;
      devState.noop = true;
    },
    observe: () => devState.allStates,
    expected: true,
  },
  {
    appId: DEV_MODE_SURFACE_APP_ID,
    verbId: DEV_MODE_VIEW_ROWS_VERB_ID,
    keyboard: 'intent',
    prepare: () => {
      resetDev('rows');
      devState.noop = true;
    },
    observe: () => devState.view,
    expected: 'rows',
  },
  {
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    verbId: MISSION_MONITOR_SEARCH_VERB_ID,
    keyboard: 'stroke',
    keyStroke: 's',
    prepare: () => {
      resetMission();
      // Drawer collapsed ⇒ no filter input ⇒ the handler reports noop.
      missionState.calls = 0;
      setMissionMonitorActionHandlers({
        focusSearch: () => false,
        toggleDrawer: () => false,
        deleteSession: () => false,
        closeDetail: () => false,
      });
    },
    observe: () => missionState.focused,
    expected: null,
  },
  {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    verbId: 'sql-studio.results.loadMore',
    keyboard: 'intent',
    prepare: () => {
      resetSql();
      registerDatabaseClientActionHandlers({
        resultsLoadMore: () => false,
      });
    },
    observe: () => sqlState.outcome,
    expected: null,
  },
];

describe('R-13 — noop rows journal nothing on every channel', () => {
  it.each(NOOP_ROWS.map((row) => [`${row.appId} :: ${row.verbId}`, row] as const))(
    '%s — no state change, no journal entry on keyboard/pointer/launcher/agent',
    async (_name, row) => {
      const { host } = fixtureOf(row.appId);

      for (const channel of ['keyboard', 'pointer', 'launcher', 'agent'] as const) {
        row.prepare();
        host.reset();
        if (channel === 'keyboard' && row.keyboard === 'stroke') {
          if (row.keyStroke === undefined) throw new Error(`${row.verbId} declared no keyStroke`);
          await host.handleStroke(row.keyStroke, 1_000);
        } else if (channel === 'pointer') {
          await host.runVerb(row.verbId, 'pointer', {});
        } else {
          await host.runIntent({
            verbId: row.verbId,
            args: {},
            channel,
            actor: channel === 'agent' ? 'companion' : 'human',
          });
        }
        expect(host.getSnapshot().entries, `${row.verbId} ${channel}`).toHaveLength(0);
        expect(row.observe(), `${row.verbId} ${channel}`).toBe(row.expected);
      }

      // Restore the full handler sets for the remaining parameterised cases.
      registerAllHandlers();
    },
  );
});
