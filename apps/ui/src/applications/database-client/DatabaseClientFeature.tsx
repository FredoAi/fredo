import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Flex, VStack } from '@chakra-ui/react';
import { LuDatabase, LuUnplug } from 'react-icons/lu';
import { FredoApplicationClass } from '../../shared/classes';
import { ConnectionForm } from './components/ConnectionForm';
import {
  ConnectionsPanel,
  type ConnectionStatus,
} from './components/ConnectionsPanel';
import { DatabaseClientSettings } from './components/DatabaseClientSettings';
import { ExportMenu } from './components/ExportMenu';
import { HistoryPanel } from './components/HistoryPanel';
import { QueryTabs } from './components/QueryTabs';
import { ResizableSplitter, RESIZE_HIT_AREA } from './components/ResizableSplitter';
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
import {
  DBCLIENT_LAYOUT_LIMITS,
  EDITOR_MIN,
  WORKSPACE_MIN,
  appendHistory,
  clearConnectionData,
  loadPrefs,
} from './lib/storage';
import { useDbClientLayout } from './lib/useDbClientLayout';
import type { DbConnectionView, SchemaNode } from './lib/types';

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
  const [activeSql, setActiveSql] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [defaultRowLimit, setDefaultRowLimit] = useState(100);
  const [statusMessage, setStatusMessage] = useState('');

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

  // Effective (container-aware) tier-2 max. The static `DBCLIENT_LAYOUT_LIMITS`
  // still bounds what is PERSISTED (ST-1's `commit`); these bounds only limit the
  // live drag so the workspace/downstream pane keeps its floor. When the
  // container is unmeasured (jsdom / first paint) the static max applies.
  const leftLimits = DBCLIENT_LAYOUT_LIMITS.leftSidebarWidth;
  const rightLimits = DBCLIENT_LAYOUT_LIMITS.rightSidebarWidth;
  const connLimits = DBCLIENT_LAYOUT_LIMITS.connectionsSchemaHeight;
  const handleBand = Number.parseInt(RESIZE_HIT_AREA, 10);
  const effectiveLeftMax =
    rowWidth > 0
      ? Math.max(
          leftLimits.min,
          Math.min(leftLimits.max, rowWidth - rightLimits.min - WORKSPACE_MIN - 2 * handleBand),
        )
      : leftLimits.max;
  const effectiveRightMax =
    rowWidth > 0
      ? Math.max(
          rightLimits.min,
          Math.min(rightLimits.max, rowWidth - leftLimits.min - WORKSPACE_MIN - 2 * handleBand),
        )
      : rightLimits.max;
  const effectiveConnMax =
    rowHeight > 0
      ? Math.max(Math.min(connLimits.max, rowHeight - EDITOR_MIN - handleBand), connLimits.min)
      : connLimits.max;

  const leftWidth = liveLeft ?? layout.leftSidebarWidth;
  const rightWidth = liveRight ?? layout.rightSidebarWidth;
  const connHeight = liveConnHeight ?? layout.connectionsSchemaHeight;

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

  return (
    <Flex
      data-testid="db-client-root"
      direction="column"
      height="100%"
      minHeight={0}
      bg="bg.canvas"
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
            onQueryComplete={handleQueryComplete}
            onActiveSqlChange={setActiveSql}
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
    return <DatabaseClientFeatureView />;
  }

  renderSettings() {
    return <DatabaseClientSettings />;
  }
}

export const databaseClientFeature = new DatabaseClientFeature();
