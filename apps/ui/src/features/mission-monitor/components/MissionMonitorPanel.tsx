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
import { EMPTY_STATE_JOKES } from '../lib/contract';
import { initMmTables, persistDelivery } from '../lib/persistence';

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

  useEffect(() => {
    const seen = seenNodeIdsRef.current;
    const hadPriorNodes = seen.size > 0;
    let newFound: Node | null = null;
    for (const node of nodes) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        if (!newFound) {
          newFound = node;
        }
      }
    }
    // Only auto-focus if we already had tracked nodes (skip initial-load flood)
    if (newFound && hadPriorNodes && setCenter) {
      const { x, y } = newFound.position;
      setCenter(x + 100, y + 150, { zoom: 1, duration: 500 });
      onNodeClick(newFound.data as MonitorNodeData);
    }
  }, [nodes, onNodeClick, setCenter]);

  // ── Auto-fit on session switch ─────────────────────────────────────────
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== sessionId) {
      // Session changed — reset seen-node tracking for the new session
      seenNodeIdsRef.current = new Set();
      // Short delay to let ReactFlow render before fitting
      const timer = setTimeout(() => {
        fitView({ padding: 0.2, duration: 300 });
      }, 100);
      prevSessionIdRef.current = sessionId;
      return () => clearTimeout(timer);
    }
    prevSessionIdRef.current = sessionId;
  }, [sessionId, fitView]);

  // ── Auto-fit on node count change ──────────────────────────────────────
  const prevNodeCountRef = useRef<number>(0);

  useEffect(() => {
    const prev = prevNodeCountRef.current;
    prevNodeCountRef.current = nodes.length;

    // Skip initial mount (0 → N); only fire when both prev and current are
    // non-zero and the count actually changed
    if (prev !== 0 && nodes.length !== 0 && prev !== nodes.length) {
      fitView({ padding: 0.2, duration: 300 });
    }
  }, [nodes.length, fitView]);

  return (
    <NodeFocusProvider value={onNodeClick}>
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          minZoom={0.3} maxZoom={2}
          onlyRenderVisibleElements={true}
          nodesDraggable={false}
          nodesConnectable={false}
          panOnDrag={true}
          zoomOnScroll={true}
          preventScrolling={true}
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

  // Initialize SQLite tables on mount
  useEffect(() => {
    initMmTables();
  }, []);

  // Persist new deliveries to SQLite
  const persistedCountRef = useRef<number>(0);

  useEffect(() => {
    const prevCount = persistedCountRef.current;
    if (deliveries.length > prevCount) {
      // Persist each new delivery
      const newDeliveries = deliveries.slice(prevCount);
      for (const d of newDeliveries) {
        persistDelivery(d);
      }
      persistedCountRef.current = deliveries.length;
    }
  }, [deliveries.length]);

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
                deliveries={deliveries}
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
