import React, { useState, useEffect, useCallback } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  type NodeTypes,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import { useMissionMonitor } from '../hooks/useMissionMonitor';
import { useSessionHistory } from '../hooks/useSessionHistory';
import { loadContracts } from '../lib/sessionStorage';
import type { StoredSessionContracts } from '../lib/sessionStorage';
import { SessionHistoryDrawer } from './SessionHistoryDrawer';
import { NodeFocusProvider } from './NodeFocusContext';
import { FocusWindow } from './FocusWindow';
import { ChatNode }          from './nodes/ChatNode';
import { SubagentNode }      from './nodes/SubagentNode';
import type { MonitorNodeData } from '../types';

// Referentially stable outside component
const NODE_TYPES: NodeTypes = {
  chatNode: ChatNode as any,
  subagentNode: SubagentNode as any,
};

// ── Inner canvas ──────────────────────────────────────────────────────────────

interface CanvasProps {
  sessionId: string;
  startTime: number;
  sessionContracts: StoredSessionContracts | null;
  onFocusNode: (data: MonitorNodeData) => void;
}

const MissionMonitorCanvas: React.FC<CanvasProps> = ({
  sessionId, startTime, sessionContracts, onFocusNode,
}) => {
  const { nodes, edges, onNodesChange, onEdgesChange } = useMissionMonitor(
    { sessionId, startTime },
    sessionContracts
  );

  return (
    <NodeFocusProvider value={onFocusNode}>
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

// ── Empty / waiting state ─────────────────────────────────────────────────────

const WaitingState: React.FC = () => (
  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#4b5563', background: '#0c0c1a' }}>
    <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid #6366f133', borderTopColor: '#6366f1', animation: 'spin 1.4s linear infinite' }} />
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    <span style={{ fontSize: 11, color: '#6b7280', letterSpacing: '0.06em' }}>Waiting for events…</span>
  </div>
);

// ── Outer panel ───────────────────────────────────────────────────────────────

export const MissionMonitorPanel: React.FC = () => {
  const { events } = useStream();
  const { sessions, refreshSessions, deleteSession } = useSessionHistory();

  // Refresh session list whenever stream events change
  useEffect(() => {
    refreshSessions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // ── Session selection ─────────────────────────────────────────────────────
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Whether the user has manually picked a session (prevents auto-jump)
  const userPickedRef = React.useRef(false);

  // Auto-select the most recent session when the list updates
  useEffect(() => {
    if (sessions.length === 0) return;
    if (!userPickedRef.current) {
      setSelectedSessionId(sessions[0].sessionId);
    }
  }, [sessions]);

  const [drawerOpen, setDrawerOpen] = useState(true);

  const handleSelectSession = useCallback((id: string) => {
    userPickedRef.current = true;
    setSelectedSessionId(id);
  }, []);

  const handleDeleteSession = useCallback((id: string) => {
    deleteSession(id);
    if (selectedSessionId === id) {
      userPickedRef.current = false;
      setSelectedSessionId(sessions.find((s) => s.sessionId !== id)?.sessionId ?? null);
    }
  }, [deleteSession, selectedSessionId, sessions]);

  // ── Focus Window state ────────────────────────────────────────────────────
  const [focusedNode, setFocusedNode] = useState<MonitorNodeData | null>(null);

  const activeSession = sessions.find((s) => s.sessionId === selectedSessionId);
  const sessionContracts = selectedSessionId ? loadContracts(selectedSessionId) : null;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0c0c1a' }}>
      {/* Header — only title + session label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 14px', background: '#12121f', borderBottom: '1px solid #1e1e3a', flexShrink: 0 }}>
        <span style={{ fontSize: '10px', color: '#6366f1', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Mission Monitor
        </span>
        <span style={{ fontSize: '10px', color: '#4b5563' }}>·</span>
        <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>
          {activeSession?.label ?? (selectedSessionId ? selectedSessionId.slice(0, 8) + '…' : 'Waiting')}
        </span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', position: 'relative' }}>
        <SessionHistoryDrawer
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          open={drawerOpen}
          onToggle={() => setDrawerOpen((v) => !v)}
        />

        {/* Canvas or waiting state */}
        {!selectedSessionId ? (
          <WaitingState />
        ) : (
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <ReactFlowProvider>
              <MissionMonitorCanvas
                sessionId={selectedSessionId}
                startTime={activeSession?.startTime ?? 0}
                sessionContracts={sessionContracts}
                onFocusNode={setFocusedNode}
              />
            </ReactFlowProvider>

            {/* Focus Window overlay */}
            {focusedNode && (
              <FocusWindow data={focusedNode} onClose={() => setFocusedNode(null)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
