import React, { useCallback, useMemo, useState } from 'react';
import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { LuPlus, LuX } from 'react-icons/lu';
import { dbQueryExecute, normalizeDbError } from '../lib/api';
import { DestructiveConfirm } from './DestructiveConfirm';
import { ResultsGrid } from './ResultsGrid';
import { SqlEditor, type DbCompletion, type SqlRunRequest } from './SqlEditor';
import type {
  DbConfirmationRequired,
  DbQueryError,
  DbResultSet,
  QueryMode,
  SchemaNode,
  TextRange,
} from '../lib/types';

/**
 * QueryTabs — the multi-tab query workspace (Spec #2950, ST-5).
 *
 * R-3.1: every tab holds independent SQL text and result state; the tab strip
 * scrolls horizontally on overflow and the tab LABEL is the ONE ellipsizing
 * child while the close control and dirty indicator are exempt (G-273/G-274).
 * R-3.2/R-3.6: the default Run sends `mode: 'single'` with the selection/caret
 * scope from `SqlEditor`; "Run all" sends `mode: 'all'`.
 * R-3.3/R-3.6: result sets (one per statement for "Run all") render in order via
 * `ResultsGrid`.
 * R-5.3 (UI): a `confirmationRequired` outcome opens `DestructiveConfirm`; the
 * statement hash is echoed back only after an explicit confirm, then the exact
 * same run is retried.
 * R-3.9: completions are derived from the loaded `db_schema_list` nodes (ST-3)
 * passed in by the shell.
 *
 * GitHub writes and credential handling live elsewhere — this component only
 * consumes the frozen `dbQueryExecute` wrapper.
 */

interface QueryTab {
  id: string;
  title: string;
  sql: string;
  dirty: boolean;
  running: boolean;
  resultSets: DbResultSet[];
  error: DbQueryError | null;
  confirmation: DbConfirmationRequired | null;
  confirmedHashes: string[];
  pendingRun: { mode: QueryMode; selection: TextRange | null } | null;
}

function newTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newTab(index: number, sql = ''): QueryTab {
  return {
    id: newTabId(),
    title: `Query ${index}`,
    sql,
    dirty: false,
    running: false,
    resultSets: [],
    error: null,
    confirmation: null,
    confirmedHashes: [],
    pendingRun: null,
  };
}

export interface QueryTabsProps {
  /** The active connection id, or `null` when disconnected. */
  connectionId: string | null;
  /** Loaded schema nodes from ST-3's `db_schema_list` (R-3.9 completion source). */
  schemaNodes?: SchemaNode[];
  /** "Load more" page size — default 100 (PO decision 7). */
  pageSize?: number;
}

export const QueryTabs: React.FC<QueryTabsProps> = ({
  connectionId,
  schemaNodes = [],
  pageSize = 100,
}) => {
  const [tabs, setTabs] = useState<QueryTab[]>(() => [newTab(1)]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;

  const updateTab = useCallback(
    (id: string, patch: Partial<QueryTab> | ((tab: QueryTab) => Partial<QueryTab>)) => {
      setTabs((previous) =>
        previous.map((tab) =>
          tab.id === id ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab,
        ),
      );
    },
    [],
  );

  const execute = useCallback(
    async (
      tabId: string,
      sql: string,
      mode: QueryMode,
      selection: TextRange | null,
      confirmedHashes: string[],
    ) => {
      if (!connectionId) return;
      updateTab(tabId, {
        running: true,
        error: null,
        confirmation: null,
        pendingRun: { mode, selection },
      });
      try {
        const outcome = await dbQueryExecute({
          connectionId,
          sql,
          mode,
          selection,
          confirmedStatementHashes: confirmedHashes,
        });
        if (outcome.confirmationRequired) {
          updateTab(tabId, { running: false, confirmation: outcome.confirmationRequired });
          return;
        }
        updateTab(tabId, {
          running: false,
          resultSets: outcome.resultSets,
          error: outcome.error,
          confirmation: null,
        });
      } catch (error) {
        updateTab(tabId, {
          running: false,
          error: { kind: 'other', message: normalizeDbError(error) },
        });
      }
    },
    [connectionId, updateTab],
  );

  const handleRun = useCallback(
    (request: SqlRunRequest) => {
      if (!activeTab || activeTab.running || !connectionId) return;
      void execute(activeTab.id, activeTab.sql, request.mode, request.selection, activeTab.confirmedHashes);
    },
    [activeTab, connectionId, execute],
  );

  const handleChangeSql = useCallback(
    (value: string) => {
      if (!activeTab) return;
      updateTab(activeTab.id, { sql: value, dirty: true });
    },
    [activeTab, updateTab],
  );

  const handleResultSetUpdated = useCallback(
    (updated: DbResultSet) => {
      if (!activeTab) return;
      updateTab(activeTab.id, (tab) => ({
        resultSets: tab.resultSets.map((set) =>
          set.resultSetId === updated.resultSetId ? updated : set,
        ),
      }));
    },
    [activeTab, updateTab],
  );

  const handleLoadMoreError = useCallback(
    (message: string) => {
      if (!activeTab) return;
      updateTab(activeTab.id, { error: { kind: 'other', message } });
    },
    [activeTab, updateTab],
  );

  const handleConfirm = useCallback(() => {
    if (!activeTab?.confirmation || !activeTab.pendingRun) return;
    const { mode, selection } = activeTab.pendingRun;
    const hashes = [...activeTab.confirmedHashes, activeTab.confirmation.statementHash];
    updateTab(activeTab.id, { confirmation: null, confirmedHashes: hashes });
    void execute(activeTab.id, activeTab.sql, mode, selection, hashes);
  }, [activeTab, execute, updateTab]);

  const handleCancelConfirm = useCallback(() => {
    if (!activeTab) return;
    updateTab(activeTab.id, { confirmation: null });
  }, [activeTab, updateTab]);

  const addTab = useCallback(() => {
    const tab = newTab(tabs.length + 1);
    setTabs((previous) => [...previous, tab]);
    setActiveId(tab.id);
  }, [tabs.length]);

  const closeTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return;
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const next = tabs.filter((tab) => tab.id !== id);
      if ((activeId ?? tabs[0].id) === id) {
        setActiveId(next[Math.min(index, next.length - 1)].id);
      }
      setTabs(next);
    },
    [tabs, activeId],
  );

  const completions = useMemo<DbCompletion[]>(
    () => schemaNodes.map((node) => ({ label: node.name, kind: node.kind })),
    [schemaNodes],
  );

  return (
    <Flex
      data-testid="db-query-workspace"
      direction="column"
      height="100%"
      minHeight={0}
      bg="bg.canvas"
    >
      <Flex
        data-testid="db-query-tabs"
        role="tablist"
        aria-label="Query tabs"
        align="center"
        gap={1}
        px={2}
        py={1}
        overflowX="auto"
        overflowY="hidden"
        flexShrink={0}
        bg="bg.subtle"
        borderBottomWidth="1px"
        borderColor="border.default"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab?.id;
          return (
            <Flex
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              data-testid="db-query-tab"
              data-tab-id={tab.id}
              align="center"
              gap={1}
              px={2}
              py="3px"
              flexShrink={0}
              cursor="pointer"
              borderBottomWidth="2px"
              borderColor={isActive ? 'accent.default' : 'transparent'}
              bg={isActive ? 'bg.surface' : undefined}
              _hover={{ bg: 'bg.hover' }}
              onClick={() => setActiveId(tab.id)}
            >
              <Text
                data-testid="db-query-tab-label"
                maxWidth="160px"
                minWidth={0}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                fontSize="xs"
                color={isActive ? 'fg.default' : 'fg.muted'}
                title={tab.title}
              >
                {tab.title}
              </Text>
              {tab.dirty ? (
                <Box
                  data-testid="db-query-tab-dirty"
                  flexShrink={0}
                  boxSize="6px"
                  borderRadius="full"
                  bg="accent.default"
                  title="Unsaved changes"
                />
              ) : null}
              <Box
                data-testid="db-query-tab-close"
                flexShrink={0}
                color="fg.muted"
                display="flex"
                alignItems="center"
                title="Close tab"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <LuX size={12} />
              </Box>
            </Flex>
          );
        })}
        <Button
          data-testid="db-query-tab-new"
          size="xs"
          variant="ghost"
          flexShrink={0}
          aria-label="New query tab"
          onClick={addTab}
        >
          <LuPlus size={12} />
        </Button>
      </Flex>

      <Box flex="1" minHeight={0} display="flex" flexDirection="column" p={2} gap={2}>
        {activeTab ? (
          <>
            <Box flexShrink={0}>
              <SqlEditor
                value={activeTab.sql}
                onChange={handleChangeSql}
                onRun={handleRun}
                running={activeTab.running}
                disabled={!connectionId}
                error={activeTab.error}
                completions={completions}
              />
            </Box>
            <Box flex="1" minHeight={0}>
              <ResultsGrid
                connectionId={connectionId}
                resultSets={activeTab.resultSets}
                pageSize={pageSize}
                running={activeTab.running}
                onResultSetUpdated={handleResultSetUpdated}
                onLoadMoreError={handleLoadMoreError}
              />
            </Box>
          </>
        ) : null}
      </Box>

      <DestructiveConfirm
        confirmation={activeTab?.confirmation ?? null}
        onConfirm={handleConfirm}
        onCancel={handleCancelConfirm}
      />
    </Flex>
  );
};
