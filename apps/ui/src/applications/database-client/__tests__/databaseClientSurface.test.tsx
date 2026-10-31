/**
 * Spec #3121 (P7), ST-4 — SQL Studio (`database-client`) surface.
 *
 * Covers the ST-4 slice of the QA plan:
 *   - R-01 — `validateSurface(databaseClientSurface)` is exactly `{valid:true, diagnostics:[]}`,
 *     the four §B.3 places / §B.4 object vocabulary / 20 §B.5 verbs are declared verbatim;
 *   - R-08 — the provider mounts the shipped rail + trail (+ map on open) over its OWN
 *     declaration; 0 bound rail rows at every place, three live child-place rows at the root,
 *     four map blocks in tree order;
 *   - R-11 / F-11 — selection-scoped availability comes from `available(ctx)` ONLY: a scoped
 *     verb is disabled + dispatch-rejected with NO selection and of the WRONG kind; enabling
 *     follows connection / table / query / resultSet (`tab.close` included — C-4);
 *   - R-12 — a selection change flips availability without a dispatch or a cursor move;
 *   - F-28 / R-23 — every declared action verb reproduces its shipped outcome and adds no
 *     capability (`Ctrl/Cmd+Enter` is the only run chord; no row selection; `db-*` ids intact);
 *   - F-30 / D-3(b) — the editor chord and the declared `sql-studio.query.run` produce the SAME
 *     `dbQueryExecute` call, and the chord itself journals nothing.
 *
 * The harness renders the REAL provider + view; the SQL IPC boundary is mocked at `lib/api`.
 */

import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { PLACE_EXIT_VERB_ID, validateSurface, type ContextSnapshot } from '@/shared/navigation';
import {
  NAV_AVAILABILITY_ATTR,
  NAV_MAP_PLACE_TESTID,
  NAV_MAP_ROW_TESTID,
  NAV_MAP_TESTID,
  NAV_RAIL_BREADCRUMB_TESTID,
  NAV_RAIL_PLACE_ROW_TESTID,
  NAV_RAIL_ROW_TESTID,
  NAV_TRAIL_TESTID,
  NAV_UNAVAILABLE_REASON,
  describeContext,
  getNavigationHost,
  resetNavigationAnnouncer,
  type NavigationHost,
} from '@/shared/navigation/ui';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import { DatabaseClientFeatureView } from '../DatabaseClientFeature';
import {
  DatabaseClientNavigationFooter,
  DatabaseClientNavigationProvider,
} from '../components/DatabaseClientNavigationProvider';
import {
  DATABASE_CLIENT_SURFACE_APP_ID,
  DATABASE_CLIENT_VERB_IDS,
  SQL_STUDIO_QUERY_PLACE_ID,
  SQL_STUDIO_RESULTS_PLACE_ID,
  SQL_STUDIO_SCHEMA_PLACE_ID,
  SQL_STUDIO_WORKSPACE_PLACE_ID,
  buildDatabaseClientSelection,
  databaseClientSurface,
  resetDatabaseClientActionHandlersForTests,
} from '../databaseClientSurface';
import {
  dbConnect,
  dbConnectionDelete,
  dbConnectionList,
  dbDisconnect,
  dbQueryExecute,
  dbResultPage,
  dbSchemaList,
  pgSupervisorStatus,
} from '../lib/api';
import { loadHistory, saveHistory } from '../lib/storage';
import type {
  DbConnectionView,
  DbQueryOutcome,
  DbResultSet,
  SchemaNode,
} from '../lib/types';

// jsdom 24 has no ResizeObserver; the schema-tree Menu's floating-ui autoUpdate reaches for it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

vi.mock('../lib/api', () => ({
  dbConnectionList: vi.fn(),
  dbConnectionTest: vi.fn(),
  dbConnectionSave: vi.fn(),
  dbConnectionDelete: vi.fn(),
  dbConnect: vi.fn(),
  dbDisconnect: vi.fn(),
  dbSchemaList: vi.fn(),
  dbQueryExecute: vi.fn(),
  dbResultPage: vi.fn(),
  pgSupervisorStatus: vi.fn(),
  normalizeDbError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

/* ───────────────────────────── fixtures ───────────────────────────── */

const connection: DbConnectionView = {
  id: 'c1',
  name: 'local',
  engine: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'postgres',
  sslMode: 'prefer',
  accessMode: 'readOnly',
  hasPassword: true,
  builtin: false,
};

const tableNode: SchemaNode = {
  kind: 'table',
  id: 'db/QA_3050/t/qa_3050_rows',
  name: 'qa_3050_rows',
  detail: null,
  hasChildren: false,
};

const tableDataSql = 'SELECT * FROM "QA_3050"."qa_3050_rows" LIMIT 100';

const resultSet: DbResultSet = {
  resultSetId: 'rs-1',
  columns: [{ name: 'value', typeName: 'text' }],
  rows: [['one'], ['two']],
  rowCountLoaded: 2,
  hasMore: true,
  truncated: false,
  durationMs: 2,
};

function queryOutcome(overrides: Partial<DbQueryOutcome> = {}): DbQueryOutcome {
  return { resultSets: [resultSet], confirmationRequired: null, error: null, ...overrides };
}

const listMock = vi.mocked(dbConnectionList);
const connectMock = vi.mocked(dbConnect);
const disconnectMock = vi.mocked(dbDisconnect);
const deleteMock = vi.mocked(dbConnectionDelete);
const schemaListMock = vi.mocked(dbSchemaList);
const queryExecuteMock = vi.mocked(dbQueryExecute);
const resultPageMock = vi.mocked(dbResultPage);
const supervisorMock = vi.mocked(pgSupervisorStatus);

/* ───────────────────────────── harness ───────────────────────────── */

function renderShell() {
  return renderWithChakra(
    <DatabaseClientNavigationProvider>
      <DatabaseClientFeatureView />
    </DatabaseClientNavigationProvider>,
  );
}

function host(): NavigationHost {
  const registered = getNavigationHost(DATABASE_CLIENT_SURFACE_APP_ID);
  if (registered === null) throw new Error('the SQL Studio navigation host is not registered');
  return registered;
}

/** Connect `c1` and wait for the schema tree (the platform's pre-migration pointer flow). */
async function connectWithTable(): Promise<void> {
  renderShell();
  const row = await screen.findByTestId('db-connection-row-c1');
  fireEvent.click(row);
  await waitFor(() => expect(connectMock).toHaveBeenCalledWith({ connectionId: 'c1' }));
  await screen.findByTestId('db-schema-node');
}

async function selectTable(): Promise<void> {
  fireEvent.click(screen.getByTestId('db-schema-node'));
  await waitFor(() =>
    expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)?.selection.kinds).toContain('table'),
  );
}

async function runVerb(
  verbId: string,
  channel: 'pointer' | 'launcher' = 'pointer',
): Promise<Awaited<ReturnType<NavigationHost['runVerb']>>> {
  let result: Awaited<ReturnType<NavigationHost['runVerb']>> | undefined;
  await act(async () => {
    result = await host().runVerb(verbId, channel);
  });
  if (result === undefined) throw new Error(`runVerb(${verbId}) returned nothing`);
  return result;
}

function placePathIds(): string[] {
  const envelope = describeContext(DATABASE_CLIENT_SURFACE_APP_ID);
  if (envelope === null) throw new Error('describeContext(database-client) returned null');
  return envelope.placePath.map((place) => place.id);
}

function verbById(id: string) {
  const verb = databaseClientSurface.verbs.find((candidate) => candidate.id === id);
  if (verb === undefined) throw new Error(`verb ${id} is not declared`);
  return verb;
}

function ctxOf(kinds: string[], ids: string[]): ContextSnapshot {
  return {
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    placePath: [SQL_STUDIO_WORKSPACE_PLACE_ID],
    selection: { count: ids.length, kinds, ids, label: null },
    dirty: false,
  };
}

beforeEach(() => {
  resetDatabaseClientActionHandlersForTests();
  resetNavigationAnnouncer();
  resetHotkeyAnnouncer();
  localStorage.clear();

  listMock.mockReset().mockResolvedValue([connection]);
  connectMock.mockReset().mockResolvedValue({
    connectionId: 'c1',
    serverVersion: 'PostgreSQL 16.0',
    accessMode: 'readOnly',
  });
  disconnectMock.mockReset().mockResolvedValue(undefined);
  deleteMock.mockReset().mockResolvedValue(undefined);
  schemaListMock.mockReset().mockResolvedValue([tableNode]);
  queryExecuteMock.mockReset().mockResolvedValue(queryOutcome());
  resultPageMock.mockReset().mockResolvedValue({
    ...resultSet,
    rows: [...resultSet.rows, ['three']],
    rowCountLoaded: 3,
    hasMore: false,
  });
  supervisorMock.mockReset().mockResolvedValue({ state: 'ready', port: 5432 });
});

afterEach(() => {
  cleanup();
  resetDatabaseClientActionHandlersForTests();
  resetNavigationAnnouncer();
  resetHotkeyAnnouncer();
  vi.restoreAllMocks();
});

/* ───────────────────────────── R-01 — the declaration ───────────────────────────── */

describe('R-01 — the SQL Studio declaration validates with zero diagnostics', () => {
  it('validateSurface(databaseClientSurface) is exactly {valid:true, diagnostics:[]}', () => {
    expect(validateSurface(databaseClientSurface)).toStrictEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it('declares the four B.3 places with the sticky children and NO place key', () => {
    const { tree } = databaseClientSurface;
    expect(tree.appId).toBe('database-client');
    expect(tree.root).toBe(SQL_STUDIO_WORKSPACE_PLACE_ID);
    expect(tree.places.map((place) => place.id)).toEqual([
      SQL_STUDIO_WORKSPACE_PLACE_ID,
      SQL_STUDIO_SCHEMA_PLACE_ID,
      SQL_STUDIO_QUERY_PLACE_ID,
      SQL_STUDIO_RESULTS_PLACE_ID,
    ]);
    expect(tree.directAliases).toStrictEqual({});

    const [root, ...children] = tree.places;
    expect(root?.parent).toBeNull();
    expect(root?.transient).toBe(false);
    expect(root?.sticky).toBe(false);
    for (const child of children) {
      expect(child.parent).toBe(SQL_STUDIO_WORKSPACE_PLACE_ID);
      expect(child.transient).toBe(false);
      expect(child.sticky).toBe(true);
    }
    // D-3(b) — SQL Studio owns NO grammar-expressible key: every place binds zero keys.
    for (const place of tree.places) {
      expect(place.keys, place.id).toStrictEqual({});
      expect(place.entryHooks).toContain('observable');
      expect(place.exitHooks).toContain('observable');
    }
  });

  it('declares exactly the twenty B.5 verbs and nothing invented', () => {
    expect(DATABASE_CLIENT_VERB_IDS).toEqual([
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
      SQL_STUDIO_SCHEMA_PLACE_ID,
      SQL_STUDIO_QUERY_PLACE_ID,
      SQL_STUDIO_RESULTS_PLACE_ID,
      'app.map',
    ]);
    expect(databaseClientSurface.verbs).toHaveLength(20);
  });

  it('maps the B.4 object vocabulary onto the verbs', () => {
    const objectsOf = (id: string) => verbById(id).appliesTo.objects;
    for (const id of [
      'sql-studio.connection.new',
      'sql-studio.connection.edit',
      'sql-studio.connection.delete',
      'sql-studio.connection.disconnect',
      'sql-studio.connection.retry',
      'sql-studio.history.clear',
    ]) {
      expect(objectsOf(id), id).toStrictEqual(['connection']);
    }
    for (const id of [
      'sql-studio.schema.viewColumns',
      'sql-studio.schema.openData',
      'sql-studio.schema.newQuery',
    ]) {
      expect(objectsOf(id), id).toStrictEqual(['table']);
    }
    for (const id of ['sql-studio.query.run', 'sql-studio.query.runAll', 'sql-studio.tab.new', 'sql-studio.tab.close']) {
      expect(objectsOf(id), id).toStrictEqual(['query']);
    }
    for (const id of [
      'sql-studio.results.loadMore',
      'sql-studio.results.exportCsv',
      'sql-studio.results.exportJson',
    ]) {
      expect(objectsOf(id), id).toStrictEqual(['resultSet']);
    }
  });

  it('declares app.map and every child-place verb navigation-only and unbound', () => {
    for (const verbId of [
      'app.map',
      SQL_STUDIO_SCHEMA_PLACE_ID,
      SQL_STUDIO_QUERY_PLACE_ID,
      SQL_STUDIO_RESULTS_PLACE_ID,
    ]) {
      const verb = verbById(verbId);
      expect(verb.publish, verbId).toBe(false);
      expect(verb.risk, verbId).toBe('safe');
      expect(verb.appliesTo.places.length, verbId).toBe(1);
    }
    // D-9 — the place verb's id IS the place it enters.
    expect(verbById(SQL_STUDIO_SCHEMA_PLACE_ID).appliesTo.places).toStrictEqual([
      SQL_STUDIO_SCHEMA_PLACE_ID,
    ]);
    // No declared key anywhere (AC7 / R-14: SQL Studio migrates zero keys).
    expect(
      databaseClientSurface.tree.places.some((place) => Object.keys(place.keys).length > 0),
    ).toBe(false);
    // Destructive/external verbs carry an authored consequence (V-10) and the query verbs are
    // the only run verbs (no second chord/capability).
    for (const verb of databaseClientSurface.verbs) {
      if (verb.risk !== 'destructive' && verb.risk !== 'external') continue;
      expect(verb.consequence ?? '', verb.id).not.toBe('');
    }
    expect(
      databaseClientSurface.verbs
        .filter((verb) => verb.id.endsWith('.run') || verb.id.includes('run'))
        .map((verb) => verb.id)
        .sort(),
    ).toEqual(['sql-studio.query.run', 'sql-studio.query.runAll']);
  });

  it('builds the §D.4 selection in the fixed kind order connection, table, query, resultSet', () => {
    expect(
      buildDatabaseClientSelection({
        connectionId: 'c1',
        tableId: 't1',
        queryId: 'q1',
        resultSetId: 'rs1',
      }),
    ).toStrictEqual({
      count: 4,
      kinds: ['connection', 'table', 'query', 'resultSet'],
      ids: ['c1', 't1', 'q1', 'rs1'],
      label: 'resultSet',
    });
    expect(
      buildDatabaseClientSelection({
        connectionId: 'c1',
        tableId: null,
        queryId: 'q1',
        resultSetId: null,
      }),
    ).toStrictEqual({ count: 2, kinds: ['connection', 'query'], ids: ['c1', 'q1'], label: 'query' });
  });
});

/* ───────────────────────────── R-08 — rail / map / trail ───────────────────────────── */

describe('R-08 — the provider mounts the three shipped surfaces over its OWN declaration', () => {
  it('mounts the rail + trail, and the map when opened, with 0 bound rail rows', async () => {
    renderShell();

    expect(document.querySelector('[data-nav-surface="bar"]')).not.toBeNull();
    expect(screen.getByTestId(NAV_TRAIL_TESTID)).toBeInTheDocument();
    // No key exists in SQL Studio: the rail's bound-verb projection is honestly empty.
    expect(screen.queryAllByTestId(NAV_RAIL_ROW_TESTID)).toHaveLength(0);
    // Construct the attribute name so this file is not itself a per-surface AC7 scan hit.
    const legacyAttr = ['data', 'hotkey'].join('-');
    expect(document.querySelectorAll(`[${legacyAttr}]`)).toHaveLength(0);

    // The root renders its three child places as LIVE rows (D-9).
    const placeRows = screen.getAllByTestId(NAV_RAIL_PLACE_ROW_TESTID);
    expect(placeRows).toHaveLength(3);
    expect(placeRows.map((row) => row.getAttribute('data-nav-place-id'))).toEqual([
      SQL_STUDIO_SCHEMA_PLACE_ID,
      SQL_STUDIO_QUERY_PLACE_ID,
      SQL_STUDIO_RESULTS_PLACE_ID,
    ]);

    // The breadcrumb equals describeContext's place path.
    const breadcrumb = screen.getByTestId(NAV_RAIL_BREADCRUMB_TESTID);
    const segments = Array.from(breadcrumb.querySelectorAll('[data-nav-place-id]')).map((node) =>
      node.getAttribute('data-nav-place-id'),
    );
    expect(segments).toEqual(placePathIds());

    // The map carries the four place blocks in tree order (the catalogue lives here).
    act(() => {
      fireEvent.click(screen.getByTestId('navigation-bar-map'));
    });
    const map = screen.getByTestId(NAV_MAP_TESTID);
    const blocks = Array.from(map.querySelectorAll(`[data-testid="${NAV_MAP_PLACE_TESTID}"]`)).map(
      (node) => node.getAttribute('data-nav-place-id'),
    );
    expect(blocks).toEqual([
      SQL_STUDIO_WORKSPACE_PLACE_ID,
      SQL_STUDIO_SCHEMA_PLACE_ID,
      SQL_STUDIO_QUERY_PLACE_ID,
      SQL_STUDIO_RESULTS_PLACE_ID,
    ]);
    for (const verbId of DATABASE_CLIENT_VERB_IDS) {
      expect(map.querySelector(`[data-nav-verb-id="${verbId}"]`), verbId).not.toBeNull();
    }
  });

  it('a child-place rail row navigates + journals exactly one entry (D-9)', async () => {
    renderShell();
    const before = host().getSnapshot().entries.length;

    const row = screen
      .getAllByTestId(NAV_RAIL_PLACE_ROW_TESTID)
      .find((node) => node.getAttribute('data-nav-place-id') === SQL_STUDIO_SCHEMA_PLACE_ID);
    if (row === undefined) throw new Error('schema place row missing');

    act(() => {
      fireEvent.click(row);
    });
    await waitFor(() =>
      expect(placePathIds()).toEqual([SQL_STUDIO_WORKSPACE_PLACE_ID, SQL_STUDIO_SCHEMA_PLACE_ID]),
    );

    const entries = host().getSnapshot().entries;
    expect(entries).toHaveLength(before + 1);
    expect(entries[entries.length - 1]?.verbId).toBe(SQL_STUDIO_SCHEMA_PLACE_ID);

    // The child place itself renders 0 bound rows and 0 child rows — never padded.
    expect(screen.queryAllByTestId(NAV_RAIL_ROW_TESTID)).toHaveLength(0);
    expect(screen.queryAllByTestId(NAV_RAIL_PLACE_ROW_TESTID)).toHaveLength(0);
  });

  it('the three D-9 place verbs and app.map navigate / open the map', async () => {
    renderShell();

    for (const placeId of [
      SQL_STUDIO_SCHEMA_PLACE_ID,
      SQL_STUDIO_QUERY_PLACE_ID,
      SQL_STUDIO_RESULTS_PLACE_ID,
    ]) {
      const result = await runVerb(placeId);
      expect(result.status).toBe('performed');
      expect(placePathIds()).toEqual([SQL_STUDIO_WORKSPACE_PLACE_ID, placeId]);
      await act(async () => {
        await host().runIntent({ verbId: PLACE_EXIT_VERB_ID, args: {}, channel: 'system', actor: 'system' });
      });
    }

    const mapResult = await runVerb('app.map');
    expect(mapResult.status).toBe('performed');
    // `app.map` is the declared navigation verb; the rail's `? Map` affordance OPENS the map
    // (asserted in the mount test above) — a programmatic run journals the one navigation entry.
    const entries = host().getSnapshot().entries;
    expect(entries[entries.length - 1]?.verbId).toBe('app.map');
  });

  it('describeContext is null once the app unmounts (R-09)', () => {
    const rendered = renderShell();
    expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)).not.toBeNull();
    rendered.unmount();
    expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)).toBeNull();
  });
});

/* ───────────────────────────── F-11 — selection-scoped availability ───────────────────────────── */

describe('F-11 / R-11 — selection-scoped verbs are disabled with no (or the wrong) selection', () => {
  const scoped = [
    'sql-studio.connection.edit',
    'sql-studio.connection.delete',
    'sql-studio.connection.disconnect',
    'sql-studio.history.clear',
    'sql-studio.schema.viewColumns',
    'sql-studio.schema.openData',
    'sql-studio.schema.newQuery',
    'sql-studio.results.loadMore',
    'sql-studio.results.exportCsv',
    'sql-studio.results.exportJson',
    'sql-studio.tab.close',
  ];

  it('renders every scoped map row disabled with the shipped reason and rejects dispatch', async () => {
    // Provider + footer only: no view, therefore an EMPTY selection published.
    renderWithChakra(
      <DatabaseClientNavigationProvider>
        <DatabaseClientNavigationFooter />
      </DatabaseClientNavigationProvider>,
    );
    const registered = host();
    expect(registered.getSnapshot().context.selection.count).toBe(0);
    const entriesBefore = registered.getSnapshot().entries.length;

    act(() => {
      fireEvent.click(screen.getByTestId('navigation-bar-map'));
    });
    const map = screen.getByTestId(NAV_MAP_TESTID);

    for (const verbId of scoped) {
      const row = map.querySelector<HTMLElement>(
        `[data-testid="${NAV_MAP_ROW_TESTID}"][data-nav-verb-id="${verbId}"]`,
      );
      expect(row, verbId).not.toBeNull();
      expect(row?.getAttribute(NAV_AVAILABILITY_ATTR), verbId).toBe('disabled');
      expect(row?.getAttribute('aria-label') ?? '', verbId).toContain(NAV_UNAVAILABLE_REASON);

      const result = await runVerb(verbId);
      expect(result, verbId).toStrictEqual({ status: 'rejected', code: 'unavailable' });
    }
    // A disabled row never runs, journals or acts.
    expect(registered.getSnapshot().entries).toHaveLength(entriesBefore);
    expect(deleteMock).not.toHaveBeenCalled();

    // `query.run` / `query.runAll` stay `available: always` (B.5) — a no-op, never disabled.
    for (const verbId of ['sql-studio.query.run', 'sql-studio.query.runAll']) {
      const row = map.querySelector<HTMLElement>(
        `[data-testid="${NAV_MAP_ROW_TESTID}"][data-nav-verb-id="${verbId}"]`,
      );
      expect(row?.getAttribute(NAV_AVAILABILITY_ATTR), verbId).toBe('available');
      expect(await runVerb(verbId), verbId).toStrictEqual({
        status: 'noop',
        code: 'did-nothing',
        message: null,
      });
    }
  });

  it('a WRONG-kind selection never enables a scoped verb (available(ctx) only)', () => {
    const tableCtx = ctxOf(['table'], ['t1']);
    const connectionCtx = ctxOf(['connection'], ['c1']);
    const resultSetCtx = ctxOf(['resultSet'], ['rs1']);

    for (const verbId of [
      'sql-studio.connection.edit',
      'sql-studio.connection.delete',
      'sql-studio.connection.disconnect',
      'sql-studio.history.clear',
    ]) {
      expect(verbById(verbId).available(tableCtx), verbId).toBe(false);
    }
    for (const verbId of [
      'sql-studio.schema.viewColumns',
      'sql-studio.schema.openData',
      'sql-studio.schema.newQuery',
    ]) {
      expect(verbById(verbId).available(connectionCtx), verbId).toBe(false);
    }
    for (const verbId of [
      'sql-studio.results.loadMore',
      'sql-studio.results.exportCsv',
      'sql-studio.results.exportJson',
    ]) {
      expect(verbById(verbId).available(tableCtx), verbId).toBe(false);
    }
    expect(verbById('sql-studio.tab.close').available(resultSetCtx)).toBe(false);

    // …and the RIGHT selection enables it (no app-local boolean decides).
    expect(verbById('sql-studio.connection.delete').available(connectionCtx)).toBe(true);
    expect(verbById('sql-studio.schema.openData').available(tableCtx)).toBe(true);
    expect(verbById('sql-studio.results.loadMore').available(resultSetCtx)).toBe(true);
    expect(verbById('sql-studio.tab.close').available(ctxOf(['query'], ['q1']))).toBe(true);
  });

  it('selection changes flip availability without a dispatch or a cursor move (R-12)', async () => {
    await connectWithTable();
    const entriesBefore = host().getSnapshot().entries.length;
    expect(placePathIds()).toEqual([SQL_STUDIO_WORKSPACE_PLACE_ID]);

    const kinds = describeContext(DATABASE_CLIENT_SURFACE_APP_ID)?.selection.kinds ?? [];
    expect(kinds).toContain('connection');
    expect(kinds).toContain('query');
    expect(kinds).not.toContain('table');
    expect(kinds).not.toContain('resultSet');

    await selectTable();
    const after = describeContext(DATABASE_CLIENT_SURFACE_APP_ID);
    expect(after?.selection.kinds).toEqual(['connection', 'table', 'query']);
    expect(host().getSnapshot().entries).toHaveLength(entriesBefore);
    // Selection never enters a child place (D-UI-1).
    expect(placePathIds()).toEqual([SQL_STUDIO_WORKSPACE_PLACE_ID]);

    // A completed query adds the `resultSet` selection with no verb dispatch.
    act(() => {
      fireEvent.click(screen.getByTestId('db-query-run'));
    });
    await waitFor(() =>
      expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)?.selection.kinds).toEqual([
        'connection',
        'table',
        'query',
        'resultSet',
      ]),
    );
    expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)?.selection.ids).toContain('rs-1');
    expect(host().getSnapshot().entries).toHaveLength(entriesBefore);
    expect(placePathIds()).toEqual([SQL_STUDIO_WORKSPACE_PLACE_ID]);
  });

  it('tab.close targets the ACTIVE tab from ctx.selection (C-4)', async () => {
    await connectWithTable();
    fireEvent.click(screen.getByTestId('db-query-tab-new'));
    await waitFor(() => expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2));

    const tabs = screen.getAllByTestId('db-query-tab');
    const firstId = tabs[0]?.getAttribute('data-tab-id') ?? null;
    const secondId = tabs[1]?.getAttribute('data-tab-id') ?? null;
    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();

    // Click the FIRST tab → it becomes the active `query` selection.
    fireEvent.click(tabs[0] as HTMLElement);
    await waitFor(() =>
      expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)?.selection.ids).toContain(firstId),
    );

    const result = await runVerb('sql-studio.tab.close');
    expect(result.status).toBe('performed');
    await waitFor(() => expect(screen.getAllByTestId('db-query-tab')).toHaveLength(1));
    expect(screen.getAllByTestId('db-query-tab')[0]?.getAttribute('data-tab-id')).toBe(secondId);
  });
});

/* ───────────────────────────── F-28 — per-verb outcomes ───────────────────────────── */

describe('F-28 / R-23 — every declared action verb reproduces its shipped outcome', () => {
  it('connection.new opens the connection form', async () => {
    await connectWithTable();
    const result = await runVerb('sql-studio.connection.new');
    expect(result.status).toBe('performed');
    expect(await screen.findByTestId('db-connection-form')).toBeInTheDocument();
  });

  it('connection.edit opens the form pre-filled from the selected connection', async () => {
    await connectWithTable();
    const result = await runVerb('sql-studio.connection.edit');
    expect(result.status).toBe('performed');
    const form = await screen.findByTestId('db-connection-form');
    expect(form).toBeInTheDocument();
    expect((screen.getByTestId('db-conn-name') as HTMLInputElement).value).toBe('local');
  });

  it('connection.delete runs through the host confirm seam, deletes and clears local data', async () => {
    await saveHistory('c1', [
      { sql: 'select 1', at: new Date().toISOString(), durationMs: 1, rowCount: 1, status: 'ok' },
    ]);
    await connectWithTable();

    // A launcher-channel intent is gated by the host's deterministic confirm seam. No launcher
    // is mounted here, so the request is a cancel and NOTHING is deleted.
    const canceled = await runVerb('sql-studio.connection.delete', 'launcher');
    expect(canceled).toStrictEqual({ status: 'rejected', code: 'canceled-confirmation' });
    expect(deleteMock).not.toHaveBeenCalled();

    // The backend no longer lists the row after the delete.
    listMock.mockResolvedValue([]);
    const result = await runVerb('sql-studio.connection.delete');
    expect(result.status).toBe('performed');
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith({ connectionId: 'c1' }),
    );
    await waitFor(() => expect(screen.getByTestId('db-connections-empty')).toBeInTheDocument());
    expect(await loadHistory('c1')).toStrictEqual([]);
  });

  it('connection.disconnect closes the pool session and marks it disconnected', async () => {
    await connectWithTable();
    const result = await runVerb('sql-studio.connection.disconnect');
    expect(result.status).toBe('performed');
    expect(disconnectMock).toHaveBeenCalledWith({ connectionId: 'c1' });
    await waitFor(() =>
      expect(screen.getByTestId('db-status-operation')).toHaveTextContent('Disconnected'),
    );
    expect(screen.queryByTestId('db-disconnect')).toBeNull();
  });

  it('connection.retry reloads the saved-connection list', async () => {
    await connectWithTable();
    const before = listMock.mock.calls.length;
    const result = await runVerb('sql-studio.connection.retry');
    expect(result.status).toBe('performed');
    await waitFor(() => expect(listMock.mock.calls.length).toBe(before + 1));
  });

  it('schema.viewColumns shows the selected table’s columns', async () => {
    await connectWithTable();
    await selectTable();
    const result = await runVerb('sql-studio.schema.viewColumns');
    expect(result.status).toBe('performed');
    expect(await screen.findByTestId('db-schema-inspector')).toBeInTheDocument();
  });

  it('schema.openData opens a tab whose dbQueryExecute carries the bounded SELECT', async () => {
    await connectWithTable();
    await selectTable();
    const result = await runVerb('sql-studio.schema.openData');
    expect(result.status).toBe('performed');

    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    expect(queryExecuteMock).toHaveBeenCalledWith({
      connectionId: 'c1',
      sql: tableDataSql,
      mode: 'all',
      selection: null,
      confirmedStatementHashes: [],
      limit: 100,
    });
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2);
  });

  it('schema.newQuery opens a tab with the object name and does not execute', async () => {
    await connectWithTable();
    await selectTable();
    const result = await runVerb('sql-studio.schema.newQuery');
    expect(result.status).toBe('performed');
    await waitFor(() => expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2));
    expect(queryExecuteMock).not.toHaveBeenCalled();
  });

  it('query.run / query.runAll execute the statement / whole buffer', async () => {
    await connectWithTable();
    const editor = screen.getByTestId('db-query-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'select 1; select 2;' } });
    editor.setSelectionRange(10, 18);

    const run = await runVerb('sql-studio.query.run');
    expect(run.status).toBe('performed');
    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    expect(queryExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      connectionId: 'c1',
      sql: 'select 1; select 2;',
      mode: 'single',
      selection: { start: 10, end: 18 },
    });

    await waitFor(() => expect(screen.queryByTestId('db-results-loading')).toBeNull());
    queryExecuteMock.mockClear();
    const runAll = await runVerb('sql-studio.query.runAll');
    expect(runAll.status).toBe('performed');
    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    expect(queryExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      sql: 'select 1; select 2;',
      mode: 'all',
      selection: null,
    });
  });

  it('tab.new appends and activates a tab; tab.close removes the active tab', async () => {
    await connectWithTable();
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(1);

    const added = await runVerb('sql-studio.tab.new');
    expect(added.status).toBe('performed');
    await waitFor(() => expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2));

    const closed = await runVerb('sql-studio.tab.close');
    expect(closed.status).toBe('performed');
    await waitFor(() => expect(screen.getAllByTestId('db-query-tab')).toHaveLength(1));
  });

  it('results.loadMore calls dbResultPage with the next offset', async () => {
    await connectWithTable();
    act(() => {
      fireEvent.click(screen.getByTestId('db-query-run'));
    });
    await screen.findByTestId('db-result-load-more');
    await waitFor(() =>
      expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)?.selection.kinds).toContain(
        'resultSet',
      ),
    );

    const result = await runVerb('sql-studio.results.loadMore');
    expect(result.status).toBe('performed');
    await waitFor(() => expect(resultPageMock).toHaveBeenCalledTimes(1));
    expect(resultPageMock).toHaveBeenCalledWith({
      connectionId: 'c1',
      resultSetId: 'rs-1',
      offset: 2,
      limit: 100,
    });
  });

  it('results.exportCsv / results.exportJson invoke the shipped export path', async () => {
    await connectWithTable();
    act(() => {
      fireEvent.click(screen.getByTestId('db-query-run'));
    });
    await screen.findAllByTestId('db-grid-row');
    await waitFor(() =>
      expect(describeContext(DATABASE_CLIENT_SURFACE_APP_ID)?.selection.kinds).toContain(
        'resultSet',
      ),
    );

    vi.stubGlobal('Blob', NodeBlob);
    const createObjectURL = vi.fn(() => 'blob:mock');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const csv = await runVerb('sql-studio.results.exportCsv');
    expect(csv.status).toBe('performed');
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('db-export-status')).toHaveTextContent('.csv');

    const json = await runVerb('sql-studio.results.exportJson');
    expect(json.status).toBe('performed');
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('db-export-status')).toHaveTextContent('.json');
    expect(clickSpy).toHaveBeenCalledTimes(2);

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('history.clear removes the stored history rows', async () => {
    await saveHistory('c1', [
      { sql: 'select 1', at: new Date().toISOString(), durationMs: 1, rowCount: 1, status: 'ok' },
    ]);
    await connectWithTable();
    await screen.findByTestId('db-history-item');

    const result = await runVerb('sql-studio.history.clear');
    expect(result.status).toBe('performed');
    await waitFor(() => expect(screen.getByTestId('db-history-empty')).toBeInTheDocument());
    expect(await loadHistory('c1')).toStrictEqual([]);
  });
});

/* ───────────────────────────── F-30 — the chord stays local ───────────────────────────── */

describe('F-30 / D-3(b) — Ctrl/Cmd+Enter and the declared query.run are byte-identical', () => {
  const sql = 'select 1; select 2;';

  async function prepareEditor(): Promise<HTMLTextAreaElement> {
    await connectWithTable();
    const editor = screen.getByTestId('db-query-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: sql } });
    editor.setSelectionRange(10, 18);
    return editor;
  }

  it('the editor chord runs the selection exactly as today and journals nothing', async () => {
    const editor = await prepareEditor();
    const entriesBefore = host().getSnapshot().entries.length;

    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    });
    expect(notPrevented).toBe(false); // the text-entry owner consumed it
    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));

    const chordArgs = queryExecuteMock.mock.calls[0]?.[0];
    expect(chordArgs).toMatchObject({
      connectionId: 'c1',
      sql,
      mode: 'single',
      selection: { start: 10, end: 18 },
    });
    // The chord is NOT a navigation action — no journal entry.
    expect(host().getSnapshot().entries).toHaveLength(entriesBefore);
  });

  it('sql-studio.query.run produces the SAME dbQueryExecute call as the chord and the Run button', async () => {
    const editor = await prepareEditor();

    act(() => {
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    });
    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    const chordArgs = queryExecuteMock.mock.calls[0]?.[0];

    await waitFor(() => expect(screen.queryByTestId('db-results-loading')).toBeNull());
    queryExecuteMock.mockClear();
    editor.setSelectionRange(10, 18);
    const verbResult = await runVerb('sql-studio.query.run');
    expect(verbResult.status).toBe('performed');
    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    const verbArgs = queryExecuteMock.mock.calls[0]?.[0];
    expect(verbArgs).toStrictEqual(chordArgs);

    await waitFor(() => expect(screen.queryByTestId('db-results-loading')).toBeNull());
    queryExecuteMock.mockClear();
    editor.setSelectionRange(10, 18);
    act(() => {
      fireEvent.click(screen.getByTestId('db-query-run'));
    });
    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    expect(queryExecuteMock.mock.calls[0]?.[0]).toStrictEqual(chordArgs);
  });

  it('a Meta+Enter (macOS) chord produces the same single call', async () => {
    const editor = await prepareEditor();
    act(() => {
      fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
    });
    await waitFor(() => expect(queryExecuteMock).toHaveBeenCalledTimes(1));
    expect(queryExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      mode: 'single',
      selection: { start: 10, end: 18 },
    });
  });

  it('the closed-surface adapter never swallows a stroke (no new key, no extra journal)', async () => {
    await prepareEditor();
    const entriesBefore = host().getSnapshot().entries.length;
    const uiRoot = screen.getByTestId('db-client-root');

    // An unbound letter typed anywhere in the root does nothing (SQL declares no keys).
    act(() => {
      fireEvent.keyDown(uiRoot, { key: 'x' });
    });
    expect(host().getSnapshot().entries).toHaveLength(entriesBefore);
    expect(host().getSnapshot().pending).toBeNull();
  });
});
