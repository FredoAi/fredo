import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { LuPlus, LuX } from 'react-icons/lu';
import { dbQueryExecute, normalizeDbError } from '../lib/api';
import {
  DBCLIENT_LAYOUT_LIMITS,
  DEFAULT_DB_CLIENT_LAYOUT,
  RESULTS_MIN,
} from '../lib/storage';
import { DestructiveConfirm } from './DestructiveConfirm';
import { ResizableSplitter, RESIZE_HIT_AREA, clampSplitSize } from './ResizableSplitter';
import { ResultsGrid } from './ResultsGrid';
import { SqlEditor, type DbCompletion, type SqlRunRequest } from './SqlEditor';
import type {
  DbConfirmationRequired,
  DbQueryError,
  DbResultSet,
  DbTableDataRequest,
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
  /**
   * First-page row limit from the "Default row limit" preference (R-3.3, PO
   * decision 7) — default 100. Independent of the Load-more `pageSize`.
   */
  defaultRowLimit?: number;
  /**
   * Called when a query fails with a typed `connectionLost` (R-3.8) so the shell
   * can mark the connection disconnected.
   */
  onConnectionLost?: (connectionId: string) => void;
  /**
   * Load external SQL (history re-run / saved query open) into the active tab
   * when the nonce changes. Never auto-executes (R-4.2/R-4.3, ST-7 integration).
   */
  externalSql?: { sql: string; nonce: number } | null;
  /**
   * Open a NEW query tab (blank, or pre-filled with `sql`) when the nonce
   * changes and make it active; when `run && connectionId` execute it at once
   * with the whole-buffer scope (R-2a/R-2c, Spec #3050). This is deliberately
   * DISTINCT from `externalSql` (which loads the ACTIVE tab and never
   * auto-executes): `openRequest` always appends a fresh tab. `ST-D` produces
   * this request; `ST-C` consumes it.
   */
  openRequest?: DbTableDataRequest | null;
  /** Called after a query completes so the shell can append history (R-4.1). */
  onQueryComplete?: (entry: {
    sql: string;
    durationMs: number;
    rowCount: number;
    status: 'ok' | 'error';
  }) => void;
  /** Report the active tab's SQL upward (R-4.3 "save current query"). */
  onActiveSqlChange?: (sql: string) => void;
  /**
   * Render an export affordance beside the results grid (R-4.4, ST-7
   * integration). Receives the first result set (or `null`) and the running flag.
   */
  renderExport?: (activeSet: DbResultSet | null, running: boolean) => React.ReactNode;
  /**
   * Committed editor-row height in px (Spec #3049, ST-3). Defaults to the
   * shipped 220 so a bare `<QueryTabs>` (existing callers/tests) is unchanged.
   */
  editorHeight?: number;
  /**
   * Persist a new editor-row height; fired once per drag-end / key step. The
   * shell's `useDbClientLayout().commit` clamps + stores it.
   */
  onEditorHeightChange?: (px: number) => void;
}

export const QueryTabs: React.FC<QueryTabsProps> = ({
  connectionId,
  schemaNodes = [],
  pageSize = 100,
  defaultRowLimit = 100,
  onConnectionLost,
  externalSql = null,
  openRequest = null,
  onQueryComplete,
  onActiveSqlChange,
  renderExport,
  editorHeight = DEFAULT_DB_CLIENT_LAYOUT.editorResultsHeight,
  onEditorHeightChange,
}) => {
  const [tabs, setTabs] = useState<QueryTab[]>(() => [newTab(1)]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // ── Editor ↔ results split (Spec #3049, ST-3) ──────────────────────────────
  // The committed height is a prop (persisted by the shell); the in-flight drag
  // value is local and transient so the editor reflows live while a single
  // `onEditorHeightChange` on release remains the only persistence write.
  const [liveEditorHeight, setLiveEditorHeight] = useState<number | null>(null);
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyHeight, setBodyHeight] = useState(0);

  useEffect(() => {
    const el = workspaceBodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setBodyHeight(entry.contentRect.height);
    });
    observer.observe(el);
    setBodyHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Tier-2 (container-aware) max: the editor can never grow so far that the
  // results region loses its floor. Applied to the RENDERED height on every
  // render (window shrink / restore included) — not just the drag handle — so a
  // vertical shrink with no divider touched still reflows. Static limits still
  // bound persistence; the clamped value is never written back. Unmeasured
  // container (jsdom / first paint) → static max → derived equals persisted.
  const editorHeightLimits = DBCLIENT_LAYOUT_LIMITS.editorResultsHeight;
  const effectiveEditorMax =
    bodyHeight > 0
      ? Math.max(
          Math.min(
            editorHeightLimits.max,
            bodyHeight - RESULTS_MIN - Number.parseInt(RESIZE_HIT_AREA, 10),
          ),
          editorHeightLimits.min,
        )
      : editorHeightLimits.max;

  const handleEditorHeightChange = useCallback(
    (px: number) => {
      setLiveEditorHeight(null);
      onEditorHeightChange?.(px);
    },
    [onEditorHeightChange],
  );

  const renderedEditorHeight =
    liveEditorHeight ?? clampSplitSize(editorHeight, editorHeightLimits.min, effectiveEditorMax);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;
  const activeTabIdRef = useRef<string | null>(activeTab?.id ?? null);
  const onActiveSqlChangeRef = useRef(onActiveSqlChange);
  // Last consumed `openRequest.nonce` — guards the append+run effect against a
  // re-render replay (including StrictMode's double effect invocation).
  const openRequestNonceRef = useRef<number | null>(null);

  useEffect(() => {
    activeTabIdRef.current = activeTab?.id ?? null;
  }, [activeTab?.id]);

  useEffect(() => {
    onActiveSqlChangeRef.current = onActiveSqlChange;
  }, [onActiveSqlChange]);

  // Report the active tab's SQL for the "save current query" flow (R-4.3).
  useEffect(() => {
    onActiveSqlChangeRef.current?.(activeTab?.sql ?? '');
  }, [activeTab?.sql]);

  // Load external SQL into the active tab (no auto-execute — R-4.2/R-4.3).
  useEffect(() => {
    if (!externalSql) return;
    const id = activeTabIdRef.current;
    if (!id) return;
    setTabs((previous) =>
      previous.map((tab) =>
        tab.id === id ? { ...tab, sql: externalSql.sql, dirty: true } : tab,
      ),
    );
  }, [externalSql]);

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
          limit: defaultRowLimit,
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
        // R-3.8: a dropped connection notifies the shell so the session is
        // marked disconnected (the backend has already removed the dead pool).
        if (outcome.error?.kind === 'connectionLost') {
          onConnectionLost?.(connectionId);
        }
        // R-4.1: report the completed execution so the shell can append history.
        onQueryComplete?.({
          sql,
          durationMs: outcome.resultSets[0]?.durationMs ?? 0,
          rowCount: outcome.resultSets.reduce((sum, set) => sum + set.rows.length, 0),
          status: outcome.error ? 'error' : 'ok',
        });
      } catch (error) {
        updateTab(tabId, {
          running: false,
          error: { kind: 'other', message: normalizeDbError(error) },
        });
        onQueryComplete?.({ sql, durationMs: 0, rowCount: 0, status: 'error' });
      }
    },
    [connectionId, defaultRowLimit, updateTab, onQueryComplete, onConnectionLost],
  );

  // Open a NEW tab from the schema-explorer actions (R-2a/R-2c/R-3, Spec #3050)
  // when the request nonce changes. Always appends a fresh tab (never reuses the
  // active one) and activates it; only when `run` is set AND a connection is
  // live does it execute — with the whole-buffer scope (`mode: 'all'`,
  // `selection: null`, no pre-confirmed hashes). `connectionId === null` never
  // executes (R-4): the tab is still created (a blank "New query" needs no
  // session).
  useEffect(() => {
    if (!openRequest) return;
    if (openRequestNonceRef.current === openRequest.nonce) return;
    openRequestNonceRef.current = openRequest.nonce;
    const tab = newTab(tabs.length + 1, openRequest.sql);
    setTabs((previous) => [...previous, tab]);
    setActiveId(tab.id);
    if (openRequest.run && connectionId) {
      void execute(tab.id, openRequest.sql, 'all', null, []);
    }
  }, [openRequest, connectionId, execute, tabs.length]);

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

      <Box
        ref={workspaceBodyRef}
        flex="1"
        minHeight={0}
        display="flex"
        flexDirection="column"
        p={2}
        gap={2}
      >
        {activeTab ? (
          <>
            <Box flexShrink={0} height={`${renderedEditorHeight}px`} minHeight={0}>
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
            <ResizableSplitter
              orientation="horizontal"
              direction="start"
              value={renderedEditorHeight}
              min={editorHeightLimits.min}
              max={effectiveEditorMax}
              onChange={handleEditorHeightChange}
              onDragChange={setLiveEditorHeight}
              ariaLabel="Resize editor and results"
              testId="db-resize-handle-editor-results"
            />
            <Flex flex="1" minHeight={0} direction="column" gap={1}>
              {renderExport ? (
                <Box data-testid="db-results-export" flexShrink={0} px={1}>
                  {renderExport(activeTab.resultSets[0] ?? null, activeTab.running)}
                </Box>
              ) : null}
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
            </Flex>
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
