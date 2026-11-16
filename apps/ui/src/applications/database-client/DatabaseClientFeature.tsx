import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, VStack } from '@chakra-ui/react';
import { LuDatabase, LuUnplug } from 'react-icons/lu';
import { FredoApplicationClass } from '../../shared/classes';
import { ConnectionForm } from './components/ConnectionForm';
import {
  DatabaseClientNavigationFooter,
  DatabaseClientNavigationProvider,
  handleDatabaseClientKeyDown,
  useOptionalDatabaseClientNavigation,
} from './components/DatabaseClientNavigationProvider';
import {
  ConnectionsPanel,
  type ConnectionStatus,
} from './components/ConnectionsPanel';
import { DatabaseClientSettings } from './components/DatabaseClientSettings';
import { ExportMenu } from './components/ExportMenu';
import { HistoryPanel } from './components/HistoryPanel';
import { QueryTabs } from './components/QueryTabs';
import {
  ResizableSplitter,
  RESIZE_HIT_AREA,
  clampSplitSize,
} from './components/ResizableSplitter';
import { SavedQueriesPanel } from './components/SavedQueriesPanel';
import { SchemaInspector } from './components/SchemaInspector';
import { SchemaTree } from './components/SchemaTree';
import {
  dbConnect,
  dbConnectionDelete,
  dbConnectionList,
  dbDisconnect,
  normalizeDbError,
} from './lib/api';
import { buildTableDataSql } from './lib/schemaRef';
import {
  DBCLIENT_LAYOUT_LIMITS,
  EDITOR_MIN,
  WORKSPACE_MIN,
  appendHistory,
  clearConnectionData,
  loadPrefs,
} from './lib/storage';
import { useDbClientLayout } from './lib/useDbClientLayout';
import {
  buildDatabaseClientSelection,
  registerDatabaseClientActionHandlers,
} from './databaseClientSurface';
import type {
  DbConnectionView,
  DbSchemaNodeAction,
  DbTableDataRequest,
  SchemaNode,
} from './lib/types';

/**
 * DatabaseClientFeature — the built-in PostgreSQL client shell
 * (Spec #2950, ST-7).
 *
 * Composes the sub-task surfaces into one reachable feature:
 * * connection management with test-before-save + first-run empty state
 *   (R-1.1/R-1.4, G-265) — connections are read from the backend `db_*`
 *   commands (authoritative for metadata/credentials);
 * * the lazy schema tree + inspector, whose loaded nodes feed the editor's
 *   completion (R-3.9);
 * * the multi-tab query workspace, with history append (R-4.1), history/
 *   saved-query hand-off (R-4.2/R-4.3) and CSV/JSON export beside the grid
 *   (R-4.4);
 * * per-connection history / saved queries through `storage.ts` (the frontend
 *   authority for history, saved queries and preferences).
 *
 * Token-first: semantic tokens only, no hex/rgba literal.
 */

interface ExternalSql {
  sql: string;
  nonce: number;
}

export const DatabaseClientFeatureView: React.FC = () => {
  // Spec #3121 (P7), ST-4 — the optional provider handle (the surface is also rendered bare by
  // the pre-migration suites; the product path mounts it through `render()`).
  const navigation = useOptionalDatabaseClientNavigation();
  const [connections, setConnections] = useState<DbConnectionView[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});

  const [activeId, setActiveId] = useState<string | null>(null);
  const [connectedId, setConnectedId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnectionView | null>(null);

  const [selectedNode, setSelectedNode] = useState<SchemaNode | null>(null);
  const [schemaNodes, setSchemaNodes] = useState<SchemaNode[]>([]);

  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [externalSql, setExternalSql] = useState<ExternalSql | null>(null);
  // Spec #3050: the schema-explorer "open a new tab" request (ST-C consumes it).
  const [openRequest, setOpenRequest] = useState<DbTableDataRequest | null>(null);
  const [activeSql, setActiveSql] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [defaultRowLimit, setDefaultRowLimit] = useState(100);
  const [statusMessage, setStatusMessage] = useState('');

  // §D.4 / C-4 — the view does not own the active tab (QueryTabs state) nor the active result
  // set (ResultsGrid state); they report upward through the shipped `onActiveSqlChange` seam
  // shape so `ctx.selection` can carry connection + table + query + resultSet.
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeResultSetId, setActiveResultSetId] = useState<string | null>(null);

  // ── Resizable split layout (Spec #3049, ST-3) ──────────────────────────────
  // ONE `useDbClientLayout()` instance for the whole shell (never instantiate it
  // twice on the same key); the centre workspace gets the editor height threaded
  // down as props. Layout values are primitives; the live drag values below are
  // transient (`null` = fall back to the persisted value) so a drag reflows live
  // while a single `commit` on release persists.
  const { layout, commit } = useDbClientLayout();
  const [liveLeft, setLiveLeft] = useState<number | null>(null);
  const [liveRight, setLiveRight] = useState<number | null>(null);
  const [liveConnHeight, setLiveConnHeight] = useState<number | null>(null);

  // Container measurement for the tier-2 (container-aware) clamp so a split can
  // never hide the workspace. Only fires on a real container resize — a drag does
  // not change the pane-row's own size, so this never becomes a drag-loop source.
  const splitRowRef = useRef<HTMLDivElement | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);
  // Monotonic nonce for the schema-explorer open-request channel (Spec #3050) —
  // guarantees a fresh value per action so a repeat "Open table data" on the
  // same node still retriggers the tab-append effect (never a same-ms collision).
  const openRequestNonceRef = useRef(0);

  useEffect(() => {
    const el = splitRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setRowWidth(entry.contentRect.width);
      setRowHeight(entry.contentRect.height);
    });
    observer.observe(el);
    setRowWidth(el.clientWidth);
    setRowHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const handleLeftChange = useCallback(
    (px: number) => {
      setLiveLeft(null);
      commit('leftSidebarWidth', px);
    },
    [commit],
  );
  const handleRightChange = useCallback(
    (px: number) => {
      setLiveRight(null);
      commit('rightSidebarWidth', px);
    },
    [commit],
  );
  const handleConnChange = useCallback(
    (px: number) => {
      setLiveConnHeight(null);
      commit('connectionsSchemaHeight', px);
    },
    [commit],
  );
  const handleEditorHeightChange = useCallback(
    (px: number) => {
      commit('editorResultsHeight', px);
    },
    [commit],
  );

  // Effective (container-aware) tier-2 bounds, applied to the RENDERED value on
  // every render — not just the drag handle. So a window shrink (or a restore at
  // a smaller window) with NO divider touched still reflows the panes under the
  // live container size and keeps the workspace floor. The static
  // `DBCLIENT_LAYOUT_LIMITS` still bounds what is PERSISTED (ST-1's `commit`);
  // these bounds are never written back. When the container is unmeasured
  // (jsdom / first paint) the static max applies, so the derived value equals
  // the persisted value.
  const leftLimits = DBCLIENT_LAYOUT_LIMITS.leftSidebarWidth;
  const rightLimits = DBCLIENT_LAYOUT_LIMITS.rightSidebarWidth;
  const connLimits = DBCLIENT_LAYOUT_LIMITS.connectionsSchemaHeight;
  const handleBand = Number.parseInt(RESIZE_HIT_AREA, 10);

  // Left first: its bound reserves the right sidebar's min + the workspace floor.
  const effectiveLeftMax =
    rowWidth > 0
      ? Math.max(
          leftLimits.min,
          Math.min(leftLimits.max, rowWidth - rightLimits.min - WORKSPACE_MIN - 2 * handleBand),
        )
      : leftLimits.max;
  const leftWidth =
    liveLeft ?? clampSplitSize(layout.leftSidebarWidth, leftLimits.min, effectiveLeftMax);

  // The right bound is derived from the RENDERED left width so the JOINT floor
  // holds: leftWidth + rightWidth + 2*band + WORKSPACE_MIN ≤ rowWidth.
  const effectiveRightMax =
    rowWidth > 0
      ? Math.max(
          rightLimits.min,
          Math.min(rightLimits.max, rowWidth - leftWidth - WORKSPACE_MIN - 2 * handleBand),
        )
      : rightLimits.max;
  const rightWidth =
    liveRight ?? clampSplitSize(layout.rightSidebarWidth, rightLimits.min, effectiveRightMax);

  const effectiveConnMax =
    rowHeight > 0
      ? Math.max(Math.min(connLimits.max, rowHeight - EDITOR_MIN - handleBand), connLimits.min)
      : connLimits.max;
  const connHeight =
    liveConnHeight ??
    clampSplitSize(layout.connectionsSchemaHeight, connLimits.min, effectiveConnMax);

  const reload = useCallback(async () => {
    setLoadingConnections(true);
    setConnectionsError(null);
    try {
      const list = await dbConnectionList();
      setConnections(list);
    } catch (error) {
      setConnectionsError(normalizeDbError(error));
    } finally {
      setLoadingConnections(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    loadPrefs()
      .then((prefs) => {
        // R-3.3 / QA-12: the first page honours the stored default row limit;
        // the Load-more page size is independent.
        setPageSize(prefs.pageSize);
        setDefaultRowLimit(prefs.defaultRowLimit);
      })
      .catch(() => {
        /* tolerant (R-4.5) — keep the default page size */
      });
  }, [reload]);

  const connectTo = useCallback(async (view: DbConnectionView) => {
    setActiveId(view.id);
    setStatuses((current) => ({ ...current, [view.id]: 'connecting' }));
    setStatusMessage(`Connecting to ${view.name}…`);
    try {
      const info = await dbConnect({ connectionId: view.id });
      setConnectedId(view.id);
      setStatuses((current) => ({ ...current, [view.id]: 'connected' }));
      setStatusMessage(`Connected · ${info.serverVersion}`);
    } catch (error) {
      setConnectedId(null);
      setStatuses((current) => ({ ...current, [view.id]: 'error' }));
      setStatusMessage(normalizeDbError(error));
    }
  }, []);

  const handleSelect = useCallback(
    (view: DbConnectionView) => {
      void connectTo(view);
    },
    [connectTo],
  );

  const handleDisconnect = useCallback(async () => {
    if (!activeId) return;
    try {
      await dbDisconnect({ connectionId: activeId });
    } catch {
      /* best-effort — the session is marked disconnected locally regardless */
    }
    setConnectedId(null);
    setStatuses((current) => ({ ...current, [activeId]: 'idle' }));
    setStatusMessage('Disconnected');
  }, [activeId]);

  const handleConnectionLost = useCallback((connectionId: string) => {
    // R-3.8 UI leg: the backend has already removed the dead pool; mirror the
    // loss so the session is marked disconnected rather than left "connected".
    setConnectedId((current) => (current === connectionId ? null : current));
    setStatuses((current) => ({ ...current, [connectionId]: 'error' }));
    setStatusMessage('Connection lost — reconnect to continue');
  }, []);

  const handleSaved = useCallback(
    async (view: DbConnectionView) => {
      setFormOpen(false);
      setEditing(null);
      await reload();
      await connectTo(view);
    },
    [reload, connectTo],
  );

  const handleDelete = useCallback(
    async (view: DbConnectionView) => {
      try {
        if (connectedId === view.id) {
          await dbDisconnect({ connectionId: view.id }).catch(() => undefined);
        }
        await dbConnectionDelete({ connectionId: view.id });
        // R-1.7 frontend leg: drop the settingsService history/saved documents.
        await clearConnectionData(view.id);
        if (activeId === view.id) {
          setActiveId(null);
          setConnectedId(null);
          setSelectedNode(null);
          setSchemaNodes([]);
        }
        setStatuses((current) => {
          const next = { ...current };
          delete next[view.id];
          return next;
        });
        setStatusMessage('Connection deleted');
        await reload();
      } catch (error) {
        setConnectionsError(normalizeDbError(error));
      }
    },
    [connectedId, activeId, reload],
  );

  const handleQueryComplete = useCallback(
    (entry: { sql: string; durationMs: number; rowCount: number; status: 'ok' | 'error' }) => {
      if (!activeId) return;
      void appendHistory(activeId, { ...entry, at: new Date().toISOString() })
        .then(() => setHistoryRefresh((value) => value + 1))
        .catch(() => {
          /* R-4.5: a persistence failure never fails the connection view */
        });
    },
    [activeId],
  );

  const loadSqlIntoEditor = useCallback((sql: string) => {
    setExternalSql({ sql, nonce: Date.now() });
  }, []);

  // Spec #3050 (ST-D): map a schema-tree node action onto a concrete outcome.
  // Every path is guarded on an active connection (R-4) — when no session is
  // live the tree renders no nodes, but the guard keeps the contract explicit.
  // `openData` builds the bounded, read-only statement (R-2b/R-2d) and asks
  // QueryTabs to append + run a NEW tab; `viewColumns` re-selects the node so
  // the existing inspector shows its columns (R-3); `newQuery` opens a blank tab
  // (R-3). `defaultRowLimit` is the single pref source — never hardcoded.
  const handleNodeAction = useCallback(
    (action: DbSchemaNodeAction, node: SchemaNode) => {
      if (connectedId === null) return;
      if (action === 'viewColumns') {
        setSelectedNode(node);
        return;
      }
      openRequestNonceRef.current += 1;
      if (action === 'openData') {
        setOpenRequest({
          sql: buildTableDataSql(node, defaultRowLimit),
          run: true,
          nonce: openRequestNonceRef.current,
        });
      } else {
        // 'newQuery'
        setOpenRequest({ sql: '', run: false, nonce: openRequestNonceRef.current });
      }
    },
    [connectedId, defaultRowLimit],
  );

  const openNew = useCallback(() => {
    setEditing(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((view: DbConnectionView) => {
    setEditing(view);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditing(null);
  }, []);

  /* ── Spec #3121 (P7), ST-4 — selection projection + action seam ────────────── */

  const handleQuerySelectionChange = useCallback(
    (tabId: string | null, resultSetId: string | null) => {
      setActiveTabId(tabId);
      setActiveResultSetId(resultSetId);
    },
    [],
  );

  // §D.4 — kinds/ids in the fixed order connection, table, query, resultSet.
  const selection = useMemo(
    () =>
      buildDatabaseClientSelection({
        connectionId: activeId,
        tableId: selectedNode?.id ?? null,
        queryId: activeTabId,
        resultSetId: activeResultSetId,
      }),
    [activeId, selectedNode?.id, activeTabId, activeResultSetId],
  );

  // Publish through the host's `refreshContext` seam — availability flips with no remount, no
  // poll, and WITHOUT moving the place cursor (D-UI-1 / R-12).
  const publishSelection = navigation?.publishSelection;
  useEffect(() => {
    publishSelection?.(selection);
  }, [publishSelection, selection]);

  // The surface's action verbs delegate to these LIVE callbacks through one latest-value ref,
  // so a declaration never captures stale React state.
  const actionsRef = useRef({
    connections,
    activeId,
    connectedId,
    selectedNode,
    handleDelete,
    handleDisconnect,
    reload,
    openNew,
    openEdit,
    handleNodeAction,
  });
  actionsRef.current = {
    connections,
    activeId,
    connectedId,
    selectedNode,
    handleDelete,
    handleDisconnect,
    reload,
    openNew,
    openEdit,
    handleNodeAction,
  };

  useEffect(
    () =>
      registerDatabaseClientActionHandlers({
        connectionNew: () => {
          actionsRef.current.openNew();
          return true;
        },
        connectionEdit: (connectionId) => {
          const view = actionsRef.current.connections.find((entry) => entry.id === connectionId);
          if (view === undefined) return false;
          actionsRef.current.openEdit(view);
          return true;
        },
        connectionDelete: (connectionId) => {
          const view = actionsRef.current.connections.find((entry) => entry.id === connectionId);
          if (view === undefined) return false;
          void actionsRef.current.handleDelete(view);
          return true;
        },
        connectionDisconnect: () => {
          if (actionsRef.current.activeId === null) return false;
          void actionsRef.current.handleDisconnect();
          return true;
        },
        connectionRetry: () => {
          void actionsRef.current.reload();
          return true;
        },
        schemaViewColumns: () => runNodeAction('viewColumns'),
        schemaOpenData: () => runNodeAction('openData'),
        schemaNewQuery: () => runNodeAction('newQuery'),
      }),
    // ONE registration for this mount; the ref keeps every closure current.
    [],
  );

  function runNodeAction(action: DbSchemaNodeAction): boolean {
    const current = actionsRef.current;
    if (current.selectedNode === null || current.connectedId === null) return false;
    current.handleNodeAction(action, current.selectedNode);
    return true;
  }

  return (
    <Flex
      data-testid="db-client-root"
      direction="column"
      height="100%"
      minHeight={0}
      bg="bg.canvas"
      onKeyDown={
        navigation === null
          ? undefined
          : (event) => handleDatabaseClientKeyDown(event, navigation.host)
      }
    >
      <Flex ref={splitRowRef} flex="1" minHeight={0}>
        {/* Left: connections + schema tree (+ inspector when a node is selected) */}
        <VStack
          align="stretch"
          width={`${leftWidth}px`}
          flexShrink={0}
          minHeight={0}
          gap={2}
          p={2}
          bg="bg.canvas"
        >
          {formOpen ? (
            <Box flexShrink={0} maxHeight="70%" overflowY="auto">
              <ConnectionForm
                initial={editing}
                onSaved={(view) => void handleSaved(view)}
                onCancel={closeForm}
              />
            </Box>
          ) : (
            <>
              <Box
                flexShrink={0}
                height={`${connHeight}px`}
                minHeight={0}
                display="flex"
              >
                <ConnectionsPanel
                  connections={connections}
                  loading={loadingConnections}
                  error={connectionsError}
                  activeConnectionId={activeId}
                  connectedConnectionId={connectedId}
                  statuses={statuses}
                  onSelect={handleSelect}
                  onNew={openNew}
                  onEdit={openEdit}
                  onDelete={(view) => void handleDelete(view)}
                  onRetry={() => void reload()}
                />
              </Box>
              <ResizableSplitter
                orientation="horizontal"
                direction="start"
                value={connHeight}
                min={connLimits.min}
                max={effectiveConnMax}
                onChange={handleConnChange}
                onDragChange={setLiveConnHeight}
                ariaLabel="Resize connections and schema"
                testId="db-resize-handle-connections-schema"
              />
            </>
          )}

          <Box flex="1" minHeight={0}>
            <SchemaTree
              connectionId={connectedId}
              onSelect={setSelectedNode}
              onNodesChange={setSchemaNodes}
              onNodeAction={handleNodeAction}
            />
          </Box>

          {selectedNode ? (
            <Box
              height="35%"
              minHeight="120px"
              flexShrink={0}
              borderTopWidth="1px"
              borderColor="border.default"
            >
              <SchemaInspector connectionId={connectedId} node={selectedNode} />
            </Box>
          ) : null}
        </VStack>

        {/* Left sidebar ↔ workspace divider */}
        <ResizableSplitter
          orientation="vertical"
          direction="start"
          value={leftWidth}
          min={leftLimits.min}
          max={effectiveLeftMax}
          onChange={handleLeftChange}
          onDragChange={setLiveLeft}
          ariaLabel="Resize left sidebar"
          testId="db-resize-handle-left-sidebar"
        />

        {/* Centre: query workspace */}
        <Box flex="1" minWidth={0} minHeight={0}>
          <QueryTabs
            connectionId={connectedId}
            schemaNodes={schemaNodes}
            pageSize={pageSize}
            defaultRowLimit={defaultRowLimit}
            onConnectionLost={handleConnectionLost}
            externalSql={externalSql}
            openRequest={openRequest}
            onQueryComplete={handleQueryComplete}
            onActiveSqlChange={setActiveSql}
            onSelectionChange={handleQuerySelectionChange}
            editorHeight={layout.editorResultsHeight}
            onEditorHeightChange={handleEditorHeightChange}
            renderExport={(activeSet, running) => (
              <ExportMenu
                columns={activeSet?.columns ?? []}
                rows={activeSet?.rows ?? []}
                disabled={running}
              />
            )}
          />
        </Box>

        {/* Workspace ↔ right sidebar divider */}
        <ResizableSplitter
          orientation="vertical"
          direction="end"
          value={rightWidth}
          min={rightLimits.min}
          max={effectiveRightMax}
          onChange={handleRightChange}
          onDragChange={setLiveRight}
          ariaLabel="Resize right sidebar"
          testId="db-resize-handle-right-sidebar"
        />

        {/* Right: history + saved queries */}
        <VStack
          align="stretch"
          width={`${rightWidth}px`}
          flexShrink={0}
          minHeight={0}
          gap={2}
          p={2}
          bg="bg.canvas"
        >
          <Box flex="1" minHeight={0}>
            <HistoryPanel
              connectionId={activeId}
              onReRun={loadSqlIntoEditor}
              refreshKey={historyRefresh}
            />
          </Box>
          <Box flex="1" minHeight={0}>
            <SavedQueriesPanel
              connectionId={activeId}
              currentSql={activeSql}
              onOpen={loadSqlIntoEditor}
            />
          </Box>
        </VStack>
      </Flex>

      {/* Persistent status / live region + relocated disconnect (recognition over recall) */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py={1}
        flexShrink={0}
        borderTopWidth="1px"
        borderColor="border.default"
        bg="bg.subtle"
        minHeight="24px"
      >
        <Box
          data-testid="db-status-operation"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          flex="1"
          minWidth={0}
          fontSize="xs"
          color="fg.muted"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {statusMessage}
        </Box>
        {connectedId !== null ? (
          <Button
            data-testid="db-disconnect"
            size="xs"
            variant="outline"
            flexShrink={0}
            onClick={() => void handleDisconnect()}
          >
            <LuUnplug size={12} />
            Disconnect
          </Button>
        ) : null}
      </Flex>

      {/* Spec #3121 (P7), ST-4 — the navigation footer is the THIRD and LAST flex child of
          `db-client-root`, after the shipped status strip (UI/UX §3.1). No wrapper, no layout
          restructure, no new testid. Rendered only inside the provider (the product path). */}
      {navigation === null ? null : <DatabaseClientNavigationFooter />}
    </Flex>
  );
};

export class DatabaseClientFeature extends FredoApplicationClass {
  readonly id = 'database-client';
  readonly name = 'SQL Studio';
  readonly icon = LuDatabase;
  readonly showable = true;
  readonly hasSettings = true;

  render() {
    return (
      <DatabaseClientNavigationProvider>
        <DatabaseClientFeatureView />
      </DatabaseClientNavigationProvider>
    );
  }

  renderSettings() {
    return <DatabaseClientSettings />;
  }
}

export const databaseClientFeature = new DatabaseClientFeature();
