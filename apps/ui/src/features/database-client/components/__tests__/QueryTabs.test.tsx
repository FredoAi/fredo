/**
 * QueryTabs tests (Spec #2950, ST-5).
 *
 * Pins R-3.1 (independent per-tab SQL + results; tab strip scrolls and only the
 * label ellipsizes), R-3.2/R-3.6 (default Run is mode:single; Run all is
 * explicit), R-3.5 (error surface) and R-5.3 UI (destructive confirmation echoes
 * the statement hash only after an explicit confirm).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { QueryTabs } from '../QueryTabs';
import type { DbQueryOutcome, DbResultSet } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  dbQueryExecute: vi.fn(),
  dbResultPage: vi.fn(),
  normalizeDbError: (error: unknown) =>
    Array.isArray(error)
      ? error.map((item) => String(item)).join('; ')
      : error instanceof Error
        ? error.message
        : String(error),
}));

import { dbQueryExecute } from '../../lib/api';

const dbQueryExecuteMock = vi.mocked(dbQueryExecute);

const set: DbResultSet = {
  resultSetId: 'rs-1',
  columns: [{ name: 'value', typeName: 'text' }],
  rows: [['one']],
  rowCountLoaded: 1,
  hasMore: false,
  truncated: false,
  durationMs: 2,
};

function outcome(overrides: Partial<DbQueryOutcome> = {}): DbQueryOutcome {
  return { resultSets: [], confirmationRequired: null, error: null, ...overrides };
}

const editor = (): HTMLTextAreaElement =>
  screen.getByTestId('db-query-editor') as HTMLTextAreaElement;

beforeEach(() => {
  dbQueryExecuteMock.mockReset();
  dbQueryExecuteMock.mockResolvedValue(outcome());
});

afterEach(() => {
  cleanup();
});

describe('QueryTabs — tab strip (R-3.1 / G-273 / G-274)', () => {
  it('scrolls horizontally and ellipsizes only the tab label (close + dirty exempt)', () => {
    renderWithChakra(<QueryTabs connectionId="c1" />);

    const strip = screen.getByTestId('db-query-tabs');
    expect(getComputedStyle(strip).overflowX).toBe('auto');
    expect(getComputedStyle(strip).overflowY).toBe('hidden');

    const tab = screen.getAllByTestId('db-query-tab')[0];
    const label = within(tab).getByTestId('db-query-tab-label');
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(label).overflow).toBe('hidden');
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap');

    const close = within(tab).getByTestId('db-query-tab-close');
    expect(getComputedStyle(close).flexShrink).toBe('0');
    expect(getComputedStyle(close).textOverflow).not.toBe('ellipsis');

    // Editing marks the tab dirty; the dirty indicator is exempt from the clamp.
    fireEvent.change(editor(), { target: { value: 'SELECT 1' } });
    const dirty = within(screen.getAllByTestId('db-query-tab')[0]).getByTestId('db-query-tab-dirty');
    expect(getComputedStyle(dirty).flexShrink).toBe('0');
    expect(getComputedStyle(dirty).textOverflow).not.toBe('ellipsis');
  });

  it('keeps SQL and results independent per tab', () => {
    renderWithChakra(<QueryTabs connectionId="c1" />);

    fireEvent.change(editor(), { target: { value: 'SELECT 1' } });
    expect(editor().value).toBe('SELECT 1');

    fireEvent.click(screen.getByTestId('db-query-tab-new'));
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2);
    expect(editor().value).toBe('');

    fireEvent.change(editor(), { target: { value: 'SELECT 2' } });
    expect(editor().value).toBe('SELECT 2');

    fireEvent.click(screen.getAllByTestId('db-query-tab')[0]);
    expect(editor().value).toBe('SELECT 1');
  });

  it('adds and closes tabs, never closing the last one', () => {
    renderWithChakra(<QueryTabs connectionId="c1" />);

    fireEvent.click(screen.getByTestId('db-query-tab-new'));
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(2);

    fireEvent.click(within(screen.getAllByTestId('db-query-tab')[1]).getByTestId('db-query-tab-close'));
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(1);

    fireEvent.click(within(screen.getAllByTestId('db-query-tab')[0]).getByTestId('db-query-tab-close'));
    expect(screen.getAllByTestId('db-query-tab')).toHaveLength(1);
  });
});

describe('QueryTabs — run scope (R-3.2/R-3.6)', () => {
  it('defaults Run to mode:single with the caret statement scope', async () => {
    renderWithChakra(<QueryTabs connectionId="c1" />);
    fireEvent.change(editor(), { target: { value: 'SELECT 1; SELECT 2;' } });

    fireEvent.click(screen.getByTestId('db-query-run'));

    await waitFor(() => expect(dbQueryExecuteMock).toHaveBeenCalledTimes(1));
    expect(dbQueryExecuteMock).toHaveBeenCalledWith({
      connectionId: 'c1',
      sql: 'SELECT 1; SELECT 2;',
      mode: 'single',
      selection: { start: 10, end: 18 },
      confirmedStatementHashes: [],
    });
  });

  it('sends mode:all only from the explicit Run all action', async () => {
    renderWithChakra(<QueryTabs connectionId="c1" />);
    fireEvent.change(editor(), { target: { value: 'SELECT 1; SELECT 2;' } });

    fireEvent.click(screen.getByTestId('db-query-run-all'));

    await waitFor(() => expect(dbQueryExecuteMock).toHaveBeenCalledTimes(1));
    expect(dbQueryExecuteMock).toHaveBeenCalledWith({
      connectionId: 'c1',
      sql: 'SELECT 1; SELECT 2;',
      mode: 'all',
      selection: null,
      confirmedStatementHashes: [],
    });
  });

  it('renders every result set from a Run all outcome in order', async () => {
    dbQueryExecuteMock.mockResolvedValue(
      outcome({
        resultSets: [
          { ...set, resultSetId: 'rs-1', rows: [['one']] },
          { ...set, resultSetId: 'rs-2', rows: [['two']] },
        ],
      }),
    );
    renderWithChakra(<QueryTabs connectionId="c1" />);
    fireEvent.change(editor(), { target: { value: 'SELECT 1; SELECT 2;' } });

    fireEvent.click(screen.getByTestId('db-query-run-all'));

    await waitFor(() => expect(screen.getByTestId('db-resultsets')).toBeDefined());
    expect(screen.getAllByTestId('db-resultset-tab')).toHaveLength(2);
  });

  it('renders a typed query error with its position (R-3.5)', async () => {
    dbQueryExecuteMock.mockResolvedValue(
      outcome({ error: { kind: 'query', message: 'boom', line: 1, column: 3, position: 3 } }),
    );
    renderWithChakra(<QueryTabs connectionId="c1" />);
    fireEvent.change(editor(), { target: { value: 'SELEC 1' } });

    fireEvent.click(screen.getByTestId('db-query-run'));

    await waitFor(() => expect(screen.getByTestId('db-query-error')).toBeDefined());
    expect(screen.getByTestId('db-query-error')).toHaveTextContent('boom');
    expect(screen.getByTestId('db-query-error-position')).toHaveTextContent('line 1, column 3');
  });
});

describe('QueryTabs — destructive confirmation (R-5.3 UI)', () => {
  it('opens the confirm dialog and echoes the hash only after an explicit confirm', async () => {
    dbQueryExecuteMock
      .mockResolvedValueOnce(
        outcome({
          confirmationRequired: {
            statementClass: 'destructive',
            statementHash: 'h1',
            preview: 'DELETE FROM users',
          },
        }),
      )
      .mockResolvedValueOnce(outcome({ resultSets: [set] }));

    renderWithChakra(<QueryTabs connectionId="c1" />);
    fireEvent.change(editor(), { target: { value: 'DELETE FROM users' } });

    fireEvent.click(screen.getByTestId('db-query-run'));

    await waitFor(() => expect(screen.getByTestId('db-destructive-confirm')).toBeDefined());
    expect(screen.getByTestId('db-destructive-class')).toHaveTextContent('destructive');
    expect(screen.getByTestId('db-destructive-preview')).toHaveTextContent('DELETE FROM users');
    // Nothing was executed on the first call beyond the refusal.
    expect(dbQueryExecuteMock).toHaveBeenCalledTimes(1);
    expect(dbQueryExecuteMock.mock.calls[0][0].confirmedStatementHashes).toEqual([]);

    fireEvent.click(screen.getByTestId('db-destructive-run'));

    await waitFor(() => expect(dbQueryExecuteMock).toHaveBeenCalledTimes(2));
    expect(dbQueryExecuteMock.mock.calls[1][0].confirmedStatementHashes).toEqual(['h1']);
    expect(screen.queryByTestId('db-destructive-confirm')).toBeNull();
  });

  it('cancelling closes the dialog and executes nothing further', async () => {
    dbQueryExecuteMock.mockResolvedValue(
      outcome({
        confirmationRequired: {
          statementClass: 'unknown',
          statementHash: 'h2',
          preview: 'VACUUM',
        },
      }),
    );
    renderWithChakra(<QueryTabs connectionId="c1" />);
    fireEvent.change(editor(), { target: { value: 'VACUUM' } });

    fireEvent.click(screen.getByTestId('db-query-run'));
    await waitFor(() => expect(screen.getByTestId('db-destructive-confirm')).toBeDefined());

    fireEvent.click(screen.getByTestId('db-destructive-cancel'));
    await waitFor(() => expect(screen.queryByTestId('db-destructive-confirm')).toBeNull());
    expect(dbQueryExecuteMock).toHaveBeenCalledTimes(1);
  });
});
