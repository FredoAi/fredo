/**
 * #3151 ST-6 (AC3 / R-3.5, Q-22) — SQL Studio runs a query by POINTER alone.
 *
 * The navigation engine is gone: no command rail, no activity trail, no place
 * cursor and no stroke handler remain. The editor's primary control is still
 * reachable and still does the whole job: type SQL into `db-query-editor` and
 * click `db-query-run`; the results grid (`db-query-results`) then renders.
 *
 * No `shared/navigation` import may appear in this file (AC1's literal
 * predicate).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DatabaseClientFeatureView } from '../DatabaseClientFeature';
import { dbConnect, dbConnectionList, dbQueryExecute } from '../lib/api';
import type { DbConnectionView, DbResultSet } from '../lib/types';

// The schema-tree Menu's floating-ui autoUpdate reaches for ResizeObserver.
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
  normalizeDbError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const listMock = vi.mocked(dbConnectionList);
const connectMock = vi.mocked(dbConnect);
const queryMock = vi.mocked(dbQueryExecute);

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
};

const resultSet: DbResultSet = {
  resultSetId: 'rs-1',
  columns: [{ name: 'value', typeName: 'text' }],
  rows: [['one']],
  rowCountLoaded: 1,
  hasMore: false,
  truncated: false,
  durationMs: 2,
};

beforeEach(() => {
  localStorage.clear();
  listMock.mockReset().mockResolvedValue([connection]);
  connectMock.mockReset().mockResolvedValue({
    connectionId: 'c1',
    serverVersion: 'PostgreSQL 16.0',
    accessMode: 'readOnly',
  });
  queryMock.mockReset().mockResolvedValue({
    resultSets: [resultSet],
    confirmationRequired: null,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('#3151 R-3.5 — SQL Studio primary control, pointer only', () => {
  it('connects by pointer, types SQL and runs it, ending with a rendered result set', async () => {
    renderWithChakra(<DatabaseClientFeatureView />);

    // ── connect: click the saved connection row ─────────────────────────────
    const row = await screen.findByTestId('db-connection-row-c1');
    fireEvent.click(row);
    await waitFor(() => expect(connectMock).toHaveBeenCalledWith({ connectionId: 'c1' }));

    // ── type + run: the editor is the authoring surface, Run is the control ─
    const editor = (await screen.findByTestId('db-query-editor')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'SELECT 1' } });
    expect(editor.value).toBe('SELECT 1');

    const run = screen.getByTestId('db-query-run');
    expect(run).not.toBeDisabled();
    fireEvent.click(run);

    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1));
    expect(queryMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ connectionId: 'c1', sql: 'SELECT 1' }),
    );

    // ── the results grid renders the returned rows ──────────────────────────
    const results = await screen.findByTestId('db-query-results');
    expect(results).toBeInTheDocument();
    expect(screen.queryByTestId('db-query-error')).toBeNull();
  });
});
