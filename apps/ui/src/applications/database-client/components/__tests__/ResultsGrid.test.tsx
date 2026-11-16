/**
 * ResultsGrid tests (Spec #2950, ST-5).
 *
 * Pins R-3.3 (default page + "Load more" from the already-executed set),
 * R-3.4 (truncation), R-3.6 (multiple result sets in order) and the
 * R-3.7/G-273/G-274 render contract: both-axis scroll with a sticky header,
 * the data cell is the ONE ellipsizing child, and the sort indicator +
 * row-number gutter are exempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ResultsGrid } from '../ResultsGrid';
import type { DbResultSet } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  dbResultPage: vi.fn(),
  normalizeDbError: (error: unknown) =>
    Array.isArray(error)
      ? error.map((item) => String(item)).join('; ')
      : error instanceof Error
        ? error.message
        : String(error),
}));

import { dbResultPage } from '../../lib/api';

const dbResultPageMock = vi.mocked(dbResultPage);

const columns = [
  { name: 'id', typeName: 'int4' },
  { name: 'name', typeName: 'text' },
];

function makeSet(overrides: Partial<DbResultSet> = {}): DbResultSet {
  return {
    resultSetId: 'rs-1',
    columns,
    rows: Array.from({ length: 100 }, (_, index) => [index + 1, `row-${index + 1}`]),
    rowCountLoaded: 100,
    hasMore: true,
    truncated: false,
    durationMs: 5,
    ...overrides,
  };
}

beforeEach(() => {
  dbResultPageMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ResultsGrid — render contract (R-3.7 / G-273 / G-274)', () => {
  it('scrolls both axes with a sticky header and ellipsizes only the cell content', () => {
    renderWithChakra(
      <ResultsGrid
        connectionId="c1"
        resultSets={[makeSet({ rows: [[1, 'a'], [2, 'b'], [3, 'c']], rowCountLoaded: 3, hasMore: false })]}
      />,
    );

    const scroll = screen.getByTestId('db-grid-scroll');
    expect(getComputedStyle(scroll).overflow).toBe('auto');

    const header = screen.getByTestId('db-grid-header');
    expect(getComputedStyle(header).position).toBe('sticky');
    expect(['0', '0px']).toContain(getComputedStyle(header).top);

    const row = screen.getAllByTestId('db-grid-row')[0];
    const ellipsizing = Array.from(row.querySelectorAll<HTMLElement>('*')).filter(
      (element) => getComputedStyle(element).textOverflow === 'ellipsis',
    );
    // Exactly the data cells ellipsize — one per column.
    expect(ellipsizing).toHaveLength(columns.length);
    expect(ellipsizing.every((element) => element.getAttribute('data-testid') === 'db-grid-cell')).toBe(
      true,
    );

    // The row-number gutter is EXEMPT (never ellipsized, never shrunk).
    const gutter = within(row).getByTestId('db-grid-gutter');
    expect(getComputedStyle(gutter).flexShrink).toBe('0');
    expect(getComputedStyle(gutter).textOverflow).not.toBe('ellipsis');

    // The sort indicator is EXEMPT (renders in full).
    const indicator = screen.getAllByTestId('db-grid-sort-indicator')[0];
    expect(getComputedStyle(indicator).flexShrink).toBe('0');
    expect(getComputedStyle(indicator).textOverflow).not.toBe('ellipsis');
  });
});

describe('ResultsGrid — bounded + virtualized (R-3.3/R-3.4)', () => {
  it('mounts only the visible window and re-windows on scroll', () => {
    renderWithChakra(<ResultsGrid connectionId="c1" resultSets={[makeSet()]} />);

    const mounted = screen.getAllByTestId('db-grid-row');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(100);

    const before = Number(mounted[0].getAttribute('data-row-index'));
    fireEvent.scroll(screen.getByTestId('db-grid-scroll'), { target: { scrollTop: 2800 } });

    const after = Number(screen.getAllByTestId('db-grid-row')[0].getAttribute('data-row-index'));
    expect(after).toBeGreaterThan(before);
  });

  it('Load more appends the next page via db_result_page without re-running', async () => {
    const onResultSetUpdated = vi.fn();
    dbResultPageMock.mockResolvedValue({
      resultSetId: 'rs-1',
      columns,
      rows: Array.from({ length: 100 }, (_, index) => [index + 101, `row-${index + 101}`]),
      rowCountLoaded: 200,
      hasMore: false,
      truncated: false,
      durationMs: 3,
    });

    renderWithChakra(
      <ResultsGrid connectionId="c1" resultSets={[makeSet()]} onResultSetUpdated={onResultSetUpdated} />,
    );

    expect(screen.getByTestId('db-grid-rowcount')).toHaveTextContent('Showing 100 rows');

    fireEvent.click(screen.getByTestId('db-result-load-more'));

    await waitFor(() => expect(onResultSetUpdated).toHaveBeenCalledTimes(1));
    expect(dbResultPageMock).toHaveBeenCalledWith({
      connectionId: 'c1',
      resultSetId: 'rs-1',
      offset: 100,
      limit: 100,
    });
    const updated = onResultSetUpdated.mock.calls[0][0] as DbResultSet;
    expect(updated.rows).toHaveLength(200);
    expect(updated.hasMore).toBe(false);
  });

  it('labels a hard-capped (truncated) result set', () => {
    renderWithChakra(
      <ResultsGrid
        connectionId="c1"
        resultSets={[makeSet({ hasMore: false, truncated: true, rows: [[1, 'a']], rowCountLoaded: 5000 })]}
      />,
    );
    expect(screen.getByTestId('db-grid-rowcount')).toHaveTextContent('capped at 5,000');
  });

  it('shows an explicit empty state for a zero-row result', () => {
    renderWithChakra(
      <ResultsGrid
        connectionId="c1"
        resultSets={[makeSet({ rows: [], rowCountLoaded: 0, hasMore: false })]}
      />,
    );
    expect(screen.getByTestId('db-results-empty')).toHaveTextContent('Query returned 0 rows');
  });
});

describe('ResultsGrid — multiple result sets in order (R-3.6)', () => {
  it('renders one grid per result set and switches locally', () => {
    const first = makeSet({
      resultSetId: 'rs-1',
      columns: [{ name: 'value', typeName: 'text' }],
      rows: [['one']],
      rowCountLoaded: 1,
      hasMore: false,
    });
    const second = makeSet({
      resultSetId: 'rs-2',
      columns: [{ name: 'value', typeName: 'text' }],
      rows: [['two']],
      rowCountLoaded: 1,
      hasMore: false,
    });

    renderWithChakra(<ResultsGrid connectionId="c1" resultSets={[first, second]} />);

    expect(screen.getByTestId('db-resultsets')).toBeDefined();
    expect(screen.getAllByTestId('db-resultset-tab')).toHaveLength(2);
    expect(screen.getByTestId('db-grid-cell')).toHaveTextContent('one');

    fireEvent.click(screen.getAllByTestId('db-resultset-tab')[1]);
    expect(screen.getByTestId('db-grid-cell')).toHaveTextContent('two');
  });
});

describe('ResultsGrid — sorting', () => {
  it('toggles aria-sort and reorders the loaded rows', () => {
    renderWithChakra(
      <ResultsGrid
        connectionId="c1"
        resultSets={[makeSet({ rows: [[3, 'c'], [1, 'a'], [2, 'b']], rowCountLoaded: 3, hasMore: false })]}
      />,
    );

    const headerCell = screen.getAllByTestId('db-grid-header-cell')[0];
    expect(headerCell.getAttribute('aria-sort')).toBe('none');

    fireEvent.click(screen.getAllByTestId('db-grid-sort')[0]);
    expect(screen.getAllByTestId('db-grid-header-cell')[0].getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(
      within(screen.getAllByTestId('db-grid-row')[0]).getAllByTestId('db-grid-cell')[0],
    ).toHaveTextContent('1');

    fireEvent.click(screen.getAllByTestId('db-grid-sort')[0]);
    expect(screen.getAllByTestId('db-grid-header-cell')[0].getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(
      within(screen.getAllByTestId('db-grid-row')[0]).getAllByTestId('db-grid-cell')[0],
    ).toHaveTextContent('3');
  });
});
