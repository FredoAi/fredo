import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import { useDeliveryGraph } from '../hooks/useMissionMonitor';
import { useDeliverySessions } from '../hooks/useSessionHistory';
import { SessionHistoryDrawer } from './SessionHistoryDrawer';
import { NodeFocusProvider } from './NodeFocusContext';
import { DetailPanel } from './DetailPanel';
import { ChatNode }          from './nodes/ChatNode';
import { SubagentNode }      from './nodes/SubagentNode';
import { ToolNode }          from './nodes/ToolNode';
import { FileNode }          from './nodes/FileNode';
import type { MonitorNodeData } from '../types';
import { EMPTY_STATE_JOKES } from '../lib/graph';
import { deliverySessionId } from '../lib/graph';
import { initMmTables, persistDelivery, loadPersistedDeliveries, createDeliveryWatermark, nextUnseenDeliveries, type DeliveryWatermarkState } from '../lib/persistence';

// Referentially stable — all four node types
const NODE_TYPES: NodeTypes = {
  agentNode: ChatNode as any,
  subagentNode: SubagentNode as any,
  toolNode: ToolNode as any,
  fileNode: FileNode as any,
};

// ── Empty state ───────────────────────────────────────────────────────────────

const EmptyState: React.FC = () => {
  const joke = useMemo(
    () => EMPTY_STATE_JOKES[Math.floor(Math.random() * EMPTY_STATE_JOKES.length)],
    [],
  );

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16,
      color: '#4b5563', background: '#0c0c1a',
      animation: 'fade-in 0.5s ease',
    }}>
      <style>{`@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div style={{
        width: 48, height: 48, borderRadius: '50%',
        border: '2px solid #6366f133', borderTopColor: '#6366f1',
        animation: 'spin 1.4s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        maxWidth: 360, textAlign: 'center',
        fontSize: 11, color: '#6b7280', lineHeight: 1.6, fontStyle: 'italic',
      }}>
        "{joke}"
      </div>
      <span style={{
        fontSize: 10, color: '#4b5563',
        letterSpacing: '0.06em', marginTop: 8,
      }}>
        Waiting for agent activity…
      </span>
    </div>
  );
};

// ── No session selected state ─────────────────────────────────────────────────

const NoSessionSelected: React.FC = () => (
  <div style={{
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 10,
    color: '#4b5563', background: '#0c0c1a',
  }}>
    <span style={{ fontSize: 24, opacity: 0.3 }}>◈</span>
    <span style={{ fontSize: 11, color: '#6b7280' }}>
      Select a session from the sidebar to view its graph
    </span>
  </div>
);

// ── Inner canvas ──────────────────────────────────────────────────────────────

interface CanvasProps {
  sessionId: string;
  deliveries: ReturnType<typeof useStream>['deliveries'];
  onNodeClick: (data: MonitorNodeData | null) => void;
}

const MissionMonitorCanvas: React.FC<CanvasProps> = ({
  sessionId, deliveries, onNodeClick,
}) => {
  const { nodes, edges, onNodesChange, onEdgesChange } = useDeliveryGraph({
    deliveries,
    sessionId,
  });

  const { fitView, setCenter } = useReactFlow();

  // ── Auto-focus: track seen node IDs, scroll + select new nodes ─────────
  const seenNodeIdsRef = useRef<Set<string>>(new Set());

  // #2688 ST5 (AC3): scope auto-focus to CHAT (agent) nodes. The vertical
  // chat chain places the newest node deterministically at the top, so
  // centering it keeps the current turn in view. Non-chat nodes
  // (subagent/tool/file) are still tracked in `seen` (so hadPriorNodes stays
  // correct) but never trigger setCenter.
  useEffect(() => {
    const seen = seenNodeIdsRef.current;
    const hadPriorNodes = seen.size > 0;
    let newFound: Node | null = null;
    for (const node of nodes) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        if (!newFound && node.id.startsWith('agent-')) {
          newFound = node;
        }
      }
    }
    // Only auto-focus if we already had tracked nodes (skip initial-load flood)
    if (newFound && hadPriorNodes && setCenter) {
      const { x, y } = newFound.position;
      setCenter(x + 100, y + 150, { zoom: 1, duration: 500 });
    }
  }, [nodes, setCenter]);

  // ── Consolidated auto-fit: sessions & 0→N transitions ────────────────────
  const prevSessionIdRef = useRef<string | null>(null);
  const prevNodeCountRef = useRef<number>(0);
  const hasAutoCenteredRef = useRef<boolean>(false);

  useEffect(() => {
    // Reset all guards when session changes (includes first mount where
    // prevSessionIdRef.current === null triggers sessionChanged = true)
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      seenNodeIdsRef.current = new Set();
      hasAutoCenteredRef.current = false;
      prevNodeCountRef.current = 0;
    }

    // Detect 0→N transition: only fire fitView once per session when the
    // first set of nodes arrive (prev === 0). Incremental updates (N→N+M)
    // where hasAutoCenteredRef.current is already true are suppressed,
    // preserving the user's manual pan/zoom position.
    const prevCount = prevNodeCountRef.current;
    prevNodeCountRef.current = nodes.length;

    if (!hasAutoCenteredRef.current && nodes.length > 0 && prevCount === 0) {
      hasAutoCenteredRef.current = true;
      const timer = setTimeout(() => {
        fitView({ padding: 0.2, duration: 200 });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [sessionId, nodes.length, fitView]);

  return (
    <NodeFocusProvider value={onNodeClick}>
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          minZoom={0.3} maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          selectNodesOnDrag={false}
          panOnDrag={true}
          zoomOnScroll={true}
          preventScrolling={true}
          defaultEdgeOptions={{ hidden: false }}
          proOptions={{ hideAttribution: true }}
          style={{ background: '#0c0c1a' }}
          onNodeClick={(_, node) => {
            onNodeClick(node.data as MonitorNodeData);
          }}
          onPaneClick={() => {
            onNodeClick(null);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e1e3a" />
          <Controls style={{ background: '#12121f', border: '1px solid #1e1e3a', borderRadius: '6px' }} />
          <MiniMap
            style={{ background: '#12121f', border: '1px solid #1e1e3a' }}
            nodeColor={(node) => {
              const s = (node.data as MonitorNodeData)?.status;
              if (s === 'working')             return '#a855f7';
              if (s === 'error')               return '#ef4444';
              if (s === 'permission_required') return '#eab308';
              if (s === 'permission_granted')  return '#22c55e';
              if (s === 'permission_denied')   return '#f97316';
              if (s === 'compacted')           return '#475569';
              return '#334155';
            }}
            maskColor="#0c0c1a99"
          />
        </ReactFlow>
      </div>
    </NodeFocusProvider>
  );
};

// ── Outer panel ───────────────────────────────────────────────────────────────

export const MissionMonitorPanel: React.FC = () => {
  const { deliveries } = useStream();
  const {
    sessions,
    filteredSessions,
    selectedSessionId,
    selectSession,
    deleteSession,
    searchFilter,
    setSearchFilter,
    userPickedRef,
  } = useDeliverySessions();

  const [drawerOpen, setDrawerOpen] = useState(true);

  // ── Persistence restore state ──────────────────────────────────────────────
  const [restoredDeliveries, setRestoredDeliveries] = useState<ContractDelivery[]>([]);

  // Initialize SQLite tables on mount
  useEffect(() => {
    initMmTables();
  }, []);

  // Persist new deliveries to SQLite (serialized to eliminate concurrent races).
  // ST11: shrink-safe watermark — the StreamContext deliveries array is TTL-shrunk
  // from the front (DELIVERY_TTL_MS=300s, 60s sweep). A bare count cursor would go
  // stale below a shrink and silently strand deliveries appended afterwards
  // (round-6 signature: 2 rows persisted out of 5 chat spans). The watermark
  // (count cursor + delivery-id Set) resets on shrink and re-derives the delta
  // idempotently, so persistence can never skip a delivery that is in the array.
  const persistedWatermarkRef = useRef<DeliveryWatermarkState>(createDeliveryWatermark());

  useEffect(() => {
    const newDeliveries = nextUnseenDeliveries(deliveries, persistedWatermarkRef.current);
    if (newDeliveries.length === 0) return;
    // Serialize persistence calls to eliminate concurrent race conditions
    (async () => {
      for (const d of newDeliveries) {
        await persistDelivery(d);
      }
    })();
  }, [deliveries.length]);

  // ── Persistence restore: load persisted deliveries when session changes ──
  useEffect(() => {
    // Clear previous session's restored deliveries immediately
    setRestoredDeliveries([]);

    if (!selectedSessionId) return;

    let cancelled = false;

    (async () => {
      try {
        const loaded = await loadPersistedDeliveries(selectedSessionId);
        if (!cancelled) {
          setRestoredDeliveries(loaded);
        }
      } catch (err) {
        console.warn('[MM] Failed to load persisted deliveries:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedSessionId]);

  // ── Auto-select new sessions ──────────────────────────────────────────────
  // When a new sessionId appears in deliveries and no session is selected,
  // auto-select it so the user sees the graph immediately instead of the
  // "No session selected" empty state.
  const knownSessionIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const d of deliveries) {
      const sid = deliverySessionId(d);
      if (sid && !knownSessionIdsRef.current.has(sid)) {
        knownSessionIdsRef.current.add(sid);
        if (!selectedSessionId && !userPickedRef.current) {
          selectSession(sid);
        }
        break;
      }
    }
  }, [deliveries, selectedSessionId, selectSession, userPickedRef]);

  // ── Merge restored deliveries with live deliveries (dedup by ID) ────────
  // REQ-6: Filter restored deliveries against live deliveries by delivery.id
  // so no duplicate nodes appear. Append restored after live so the
  // incremental graph builder's index-based cursor (lastSessionProcessedRef
  // in useMissionMonitor.ts tracks a count) treats them correctly — restored
  // deliveries must come after live deliveries to preserve append-only ordering.
  const mergedDeliveries = useMemo(() => {
    if (restoredDeliveries.length === 0) return deliveries;

    const liveIds = new Set(deliveries.map(d => d.id));
    const uniqueRestored = restoredDeliveries.filter(d => !liveIds.has(d.id));

    return [...deliveries, ...uniqueRestored];
  }, [deliveries, restoredDeliveries]);

  const handleDeleteSession = useCallback((id: string) => {
    deleteSession(id);
  }, [deleteSession]);

  // ── Detail Panel state ────────────────────────────────────────────────────
  const [focusedNode, setFocusedNode] = useState<MonitorNodeData | null>(null);

  const handleNodeClick = useCallback((data: MonitorNodeData | null) => {
    setFocusedNode(data);
  }, []);

  const activeSession = sessions.find((s) => s.sessionId === selectedSessionId);

  const isEmpty = sessions.length === 0;

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: '#0c0c1a',
    }}>
      {/* Header — only title + session label */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '6px 14px', background: '#12121f',
        borderBottom: '1px solid #1e1e3a', flexShrink: 0,
      }}>
        <span style={{
          fontSize: '10px', color: '#6366f1', fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase',
        }}>
          Mission Monitor
        </span>
        <span style={{ fontSize: '10px', color: '#4b5563' }}>·</span>
        <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>
          {activeSession?.label ?? (selectedSessionId ? selectedSessionId.slice(0, 8) + '…' : 'No session')}
        </span>
      </div>

      {/* Body */}
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row',
        position: 'relative',
      }}>
        <SessionHistoryDrawer
          sessions={sessions}
          filteredSessions={filteredSessions}
          selectedSessionId={selectedSessionId}
          onSelect={selectSession}
          onDelete={handleDeleteSession}
          open={drawerOpen}
          onToggle={() => setDrawerOpen((v) => !v)}
          searchFilter={searchFilter}
          onSearchChange={setSearchFilter}
        />

        {/* Canvas or state */}
        {isEmpty ? (
          <EmptyState />
        ) : !selectedSessionId ? (
          <NoSessionSelected />
        ) : (
          <div style={{
            flex: 1, minHeight: 0, position: 'relative',
            display: 'flex', flexDirection: 'column',
          }}>
            <ReactFlowProvider>
              <MissionMonitorCanvas
                sessionId={selectedSessionId}
                deliveries={mergedDeliveries}
                onNodeClick={handleNodeClick}
              />
            </ReactFlowProvider>

            {/* Detail Panel */}
            {focusedNode && (
              <DetailPanel data={focusedNode} onClose={() => setFocusedNode(null)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
