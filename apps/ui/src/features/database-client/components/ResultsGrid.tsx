import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, HStack, Spinner, Text } from '@chakra-ui/react';
import { LuArrowDown, LuArrowUp, LuArrowUpDown } from 'react-icons/lu';
import { dbResultPage, normalizeDbError } from '../lib/api';
import type { DbResultSet } from '../lib/types';

/**
 * ResultsGrid — bounded, sortable, virtualized result grid (Spec #2950, ST-5).
 *
 * R-3.3: renders the first page (default 100 rows, backend-supplied) and a
 * "Load more" control that slices the next page from the **already-executed**
 * result set via `db_result_page` — it never re-runs the query.
 * R-3.6: multiple result sets render in statement order behind a result-set
 * selector; switching is local.
 * R-3.7 / G-273 / G-274: the grid scrolls on BOTH axes with a sticky header; the
 * data cell content is the ONE ellipsizing child per cell, while the row-number
 * gutter and the sort indicator are `flex-shrink: 0` and render in full.
 * R-3.4: a truncated set (hard-capped at 5,000 rows) is labelled.
 *
 * The grid is virtualized (PO decision 7): only the visible window (+overscan)
 * is mounted, so a large loaded page never blocks the main thread.
 */

const ROW_HEIGHT = 28;
const OVERSCAN = 6;
const DEFAULT_VIEWPORT_HEIGHT = 320;
const COLUMN_WIDTH = 180;
const GUTTER_WIDTH = 56;

type SortDir = 'asc' | 'desc';

interface SortState {
  column: number;
  dir: SortDir;
}

/** Render an arbitrary PostgreSQL value (already JSON-mapped by the backend). */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function compareValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull && bNull ? 0 : aNull ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b));
}

export interface ResultsGridProps {
  connectionId: string | null;
  resultSets: DbResultSet[];
  /** "Load more" page size — default 100 (PO decision 7). */
  pageSize?: number;
  running?: boolean;
  onResultSetUpdated?: (updated: DbResultSet) => void;
  onLoadMoreError?: (message: string) => void;
}

export const ResultsGrid: React.FC<ResultsGridProps> = ({
  connectionId,
  resultSets,
  pageSize = 100,
  running = false,
  onResultSetUpdated,
  onLoadMoreError,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [sort, setSort] = useState<SortState | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const activeSet = resultSets[activeIndex] ?? resultSets[0] ?? null;
  const firstId = resultSets[0]?.resultSetId ?? null;

  // A new execution replaces the result sets: reset local view state.
  useEffect(() => {
    setActiveIndex(0);
    setSort(null);
    setScrollTop(0);
  }, [firstId]);

  // Measure the real viewport when the browser provides one (jsdom reports 0).
  useEffect(() => {
    const element = scrollRef.current;
    if (element && element.clientHeight > 0) setViewportHeight(element.clientHeight);
  }, [activeSet]);

  const rows = useMemo(() => {
    if (!activeSet) return [] as { row: unknown[]; index: number }[];
    const indexed = activeSet.rows.map((row, index) => ({ row, index }));
    if (!sort) return indexed;
    const sorted = [...indexed];
    sorted.sort((a, b) => {
      const comparison = compareValues(a.row[sort.column], b.row[sort.column]);
      return sort.dir === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [activeSet, sort]);

  const total = rows.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);
  const visibleRows = rows.slice(startIndex, endIndex);
  const topPad = startIndex * ROW_HEIGHT;
  const bottomPad = Math.max(0, (total - endIndex) * ROW_HEIGHT);

  const toggleSort = useCallback((column: number) => {
    setSort((previous) => {
      if (previous?.column === column) {
        return { column, dir: previous.dir === 'asc' ? 'desc' : 'asc' };
      }
      return { column, dir: 'asc' };
    });
  }, []);

  const loadMore = useCallback(async () => {
    if (!connectionId || !activeSet || !activeSet.hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await dbResultPage({
        connectionId,
        resultSetId: activeSet.resultSetId,
        offset: activeSet.rowCountLoaded,
        limit: pageSize,
      });
      onResultSetUpdated?.({
        ...activeSet,
        rows: [...activeSet.rows, ...page.rows],
        rowCountLoaded: page.rowCountLoaded,
        hasMore: page.hasMore,
        truncated: page.truncated,
      });
    } catch (error) {
      onLoadMoreError?.(normalizeDbError(error));
    } finally {
      setLoadingMore(false);
    }
  }, [connectionId, activeSet, loadingMore, pageSize, onResultSetUpdated, onLoadMoreError]);

  if (running) {
    return (
      <Flex
        data-testid="db-query-results"
        direction="column"
        gap={2}
        height="100%"
        minHeight={0}
        bg="bg.surface"
        borderWidth="1px"
        borderColor="border.default"
        borderRadius="sm"
        p={3}
      >
        <HStack data-testid="db-results-loading" gap={2}>
          <Spinner size="xs" color="accent.default" />
          <Text fontSize="xs" color="fg.muted">
            Running query…
          </Text>
        </HStack>
      </Flex>
    );
  }

  if (!activeSet) {
    return (
      <Flex
        data-testid="db-query-results"
        direction="column"
        align="center"
        justify="center"
        gap={2}
        height="100%"
        minHeight={0}
        bg="bg.surface"
        borderWidth="1px"
        borderColor="border.default"
        borderRadius="sm"
        p={4}
      >
        <Text data-testid="db-results-empty" fontSize="xs" color="fg.muted">
          Run a query to see results
        </Text>
      </Flex>
    );
  }

  const columns = activeSet.columns;

  return (
    <Flex
      data-testid="db-query-results"
      direction="column"
      height="100%"
      minHeight={0}
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="sm"
      overflow="hidden"
    >
      {resultSets.length > 1 ? (
        <HStack
          data-testid="db-resultsets"
          role="tablist"
          aria-label="Result sets"
          gap={1}
          px={2}
          py={1}
          flexShrink={0}
          bg="bg.subtle"
          borderBottomWidth="1px"
          borderColor="border.default"
          overflowX="auto"
        >
          {resultSets.map((set, index) => (
            <Button
              key={set.resultSetId}
              role="tab"
              aria-selected={index === activeIndex}
              data-testid="db-resultset-tab"
              data-index={index}
              size="xs"
              variant={index === activeIndex ? 'solid' : 'ghost'}
              flexShrink={0}
              onClick={() => setActiveIndex(index)}
            >
              Result {index + 1} ({set.rows.length})
            </Button>
          ))}
        </HStack>
      ) : null}

      {columns.length === 0 || total === 0 ? (
        <Flex
          data-testid="db-results-empty"
          direction="column"
          align="center"
          justify="center"
          gap={1}
          flex="1"
          minHeight={0}
          p={4}
        >
          <Text fontSize="sm" color="fg.muted">
            Query returned 0 rows
          </Text>
        </Flex>
      ) : (
        <>
          <Box
            ref={scrollRef}
            data-testid="db-grid-scroll"
            role="grid"
            aria-label="Query results"
            aria-rowcount={total + 1}
            aria-colcount={columns.length + 1}
            overflow="auto"
            flex="1"
            minHeight={0}
            position="relative"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <Box
              data-testid="db-grid-header"
              role="row"
              position="sticky"
              top="0"
              zIndex={1}
              display="flex"
              width="max-content"
              minWidth="100%"
              bg="bg.surface"
              borderBottomWidth="1px"
              borderColor="border.default"
            >
              <Box
                data-testid="db-grid-gutter-header"
                role="columnheader"
                aria-label="Row"
                width={`${GUTTER_WIDTH}px`}
                flexShrink={0}
                borderRightWidth="1px"
                borderColor="border.default"
              />
              {columns.map((column, index) => {
                const ariaSort =
                  sort?.column === index ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
                return (
                  <Box
                    key={`${column.name}-${index}`}
                    role="columnheader"
                    aria-sort={ariaSort}
                    data-testid="db-grid-header-cell"
                    data-column={column.name}
                    width={`${COLUMN_WIDTH}px`}
                    flexShrink={0}
                    borderRightWidth="1px"
                    borderColor="border.default"
                  >
                    <Button
                      data-testid="db-grid-sort"
                      variant="ghost"
                      size="xs"
                      width="100%"
                      minHeight="32px"
                      justifyContent="flex-start"
                      gap={1}
                      px={2}
                      onClick={() => toggleSort(index)}
                      title={`Sort by ${column.name}`}
                    >
                      <Text
                        data-testid="db-grid-header-label"
                        flex="1"
                        minWidth={0}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                        textAlign="left"
                        fontSize="xs"
                        fontWeight="600"
                        color="fg.default"
                      >
                        {column.name}
                      </Text>
                      <Box
                        data-testid="db-grid-sort-indicator"
                        flexShrink={0}
                        display="flex"
                        alignItems="center"
                        color={sort?.column === index ? 'accent.default' : 'fg.muted'}
                      >
                        {sort?.column === index ? (
                          sort.dir === 'asc' ? (
                            <LuArrowUp size={12} />
                          ) : (
                            <LuArrowDown size={12} />
                          )
                        ) : (
                          <LuArrowUpDown size={12} />
                        )}
                      </Box>
                    </Button>
                  </Box>
                );
              })}
            </Box>

            <Box data-testid="db-grid-body" role="rowgroup" width="max-content" minWidth="100%">
              <Box height={`${topPad}px`} />
              {visibleRows.map(({ row, index }) => (
                <Flex
                  key={index}
                  data-testid="db-grid-row"
                  data-row-index={index}
                  role="row"
                  height={`${ROW_HEIGHT}px`}
                  borderBottomWidth="1px"
                  borderColor="border.subtle"
                  _hover={{ bg: 'bg.hover' }}
                >
                  <Box
                    data-testid="db-grid-gutter"
                    role="gridcell"
                    aria-label={`Row ${index + 1}`}
                    width={`${GUTTER_WIDTH}px`}
                    flexShrink={0}
                    borderRightWidth="1px"
                    borderColor="border.default"
                    display="flex"
                    alignItems="center"
                    justifyContent="flex-end"
                    pr={2}
                    fontSize="xs"
                    color="fg.muted"
                    fontFamily="mono"
                  >
                    {index + 1}
                  </Box>
                  {columns.map((column, columnIndex) => (
                    <Box
                      key={`${column.name}-${columnIndex}`}
                      role="gridcell"
                      data-testid="db-grid-cell-container"
                      width={`${COLUMN_WIDTH}px`}
                      flexShrink={0}
                      borderRightWidth="1px"
                      borderColor="border.subtle"
                      display="flex"
                      alignItems="center"
                      px={2}
                    >
                      <Text
                        data-testid="db-grid-cell"
                        width="100%"
                        minWidth={0}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                        fontSize="xs"
                        color="fg.default"
                        title={formatCell(row[columnIndex])}
                      >
                        {formatCell(row[columnIndex])}
                      </Text>
                    </Box>
                  ))}
                </Flex>
              ))}
              <Box height={`${bottomPad}px`} />
            </Box>
          </Box>

          <Flex
            data-testid="db-grid-footer"
            align="center"
            gap={2}
            px={2}
            py={1}
            flexShrink={0}
            borderTopWidth="1px"
            borderColor="border.default"
            bg="bg.subtle"
          >
            <Text data-testid="db-grid-rowcount" fontSize="xs" color="fg.muted">
              Showing {activeSet.rows.length} row{activeSet.rows.length === 1 ? '' : 's'}
              {activeSet.truncated ? ' (capped at 5,000)' : ''}
            </Text>
            {activeSet.hasMore ? (
              <Button
                data-testid="db-result-load-more"
                size="xs"
                variant="outline"
                loading={loadingMore}
                onClick={loadMore}
                ml="auto"
              >
                Load more
              </Button>
            ) : null}
          </Flex>
        </>
      )}
    </Flex>
  );
};
