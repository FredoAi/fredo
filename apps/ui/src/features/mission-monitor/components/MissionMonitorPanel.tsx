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
import { computeSessionTokenTotals } from '../lib/counters';
import { SessionHistoryDrawer } from './SessionHistoryDrawer';
import { SessionTokenBar } from './SessionTokenBar';
import { NodeFocusProvider } from './NodeFocusContext';
import { DetailPanel } from './DetailPanel';
import { ChatNode }          from './nodes/ChatNode';
import { SubagentNode }      from './nodes/SubagentNode';
import { ToolNode }          from './nodes/ToolNode';
import { FileNode }          from './nodes/FileNode';
import { ToolsNode }         from './nodes/ToolsNode';
import type { MonitorNodeData } from '../types';
import { EMPTY_STATE_JOKES } from '../lib/graph';
import { deliverySessionId } from '../lib/graph';
import { initMmTables, persistDelivery, loadPersistedDeliveries, createDeliveryWatermark, nextUnseenDeliveries, type DeliveryWatermarkState } from '../lib/persistence';

// Referentially stable — all five node types
const NODE_TYPES: NodeTypes = {
  agentNode: ChatNode as any,
  subagentNode: SubagentNode as any,
  toolNode: ToolNode as any,
  fileNode: FileNode as any,
  // #2739 ST-2: the tools-summary node (GRAPH_NODE_TYPE_MAP['tools'] =
  // 'toolsNode', types.ts:83) — ST-1's builder emits `tools-<corrId>` nodes
  // with this type (registered here so ReactFlow can render them).
  toolsNode: ToolsNode as any,
};

// ── Auto-center constants (#2700 ST2) ─────────────────────────────────────────
// REQ-6: coalesce rapid arrivals — each new chat node resets a single debounce
// timer; when it fires, the camera centers once on the newest node of the burst
// (no per-node animation restart, no jarring jumps).
const CENTER_DEBOUNCE_MS = 300;
// Camera animation duration for auto-center; reduced to 0 (instant snap) when
// the user prefers reduced motion (accessibility).
const CENTER_DURATION_MS = 500;
// Fallback chat-node size used to compute the geometric center before ReactFlow
// has measured the rendered node (REQ-5). ChatNode renders a content-sized box
// with minWidth 420 / maxWidth 540 (#2743 AC-6 — scaled from 280/360).
const DEFAULT_CHAT_NODE_WIDTH = 480;
const DEFAULT_CHAT_NODE_HEIGHT = 240;

// Accessibility: honor prefers-reduced-motion — camera moves snap (duration 0)
// instead of animating when the user has requested reduced motion.
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

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

  const { fitView, setCenter, getZoom } = useReactFlow();

  // ── Auto-center: track seen node IDs; coalesce-center the NEWEST new ─────
  // chat node (#2700 ST2 — REQ-3/4/6). Non-chat nodes (subagent/tool/file)
  // are still tracked in `seen` (so hadPriorNodes stays correct) but never
  // trigger centering. The first node of a session is covered by the 0→N
  // initial fitView below — it never triggers a per-node center.
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  const centerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCenterIdRef = useRef<string | null>(null);
  const nodesRef = useRef<Node[]>([]);

  // REQ-5: center the node's geometric center at the user's current zoom —
  // no zoom reset, no zoom-to-fit surrounding context. Use the node's
  // measured dimensions (ReactFlow fills width/height once rendered); fall
  // back to the default chat-node size before measurement.
  const centerOnNode = useCallback((node: Node) => {
    if (!setCenter) return;
    const width = node.width ?? DEFAULT_CHAT_NODE_WIDTH;
    const height = node.height ?? DEFAULT_CHAT_NODE_HEIGHT;
    const zoom = getZoom ? getZoom() : 1;
    const duration = prefersReducedMotion() ? 0 : CENTER_DURATION_MS;
    setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom, duration });
  }, [setCenter, getZoom]);

  useEffect(() => {
    nodesRef.current = nodes;

    const seen = seenNodeIdsRef.current;
    const hadPriorNodes = seen.size > 0;
    // REQ-4: the newest new agent node of a render batch is the LAST entry of
    // the merged nodes array (the graph builder appends in arrival order), so
    // keep overwriting `newestFound` — the last new agent node wins.
    let newestFound: Node | null = null;
    for (const node of nodes) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        if (node.id.startsWith('agent-')) {
          newestFound = node;
        }
      }
    }

    // Only auto-center if we already had tracked nodes (skip initial-load
    // flood) and only for chat (agent) nodes.
    if (!newestFound || !hadPriorNodes || !setCenter) return;

    // REQ-6: coalesce rapid arrivals — each new chat node resets a 300ms
    // debounce; when it fires, center the latest new node (pendingCenterIdRef
    // holds the newest id because every reset overwrites it). At most one
    // center animation per arrival batch.
    if (centerDebounceRef.current) {
      clearTimeout(centerDebounceRef.current);
    }
    pendingCenterIdRef.current = newestFound.id;
    centerDebounceRef.current = setTimeout(() => {
      centerDebounceRef.current = null;
      const id = pendingCenterIdRef.current;
      pendingCenterIdRef.current = null;
      if (!id) return;
      // Resolve the node at fire time so ReactFlow's measured dimensions
      // (filled in on a later render) are used when available.
      const target = nodesRef.current.find((n) => n.id === id);
      if (target) centerOnNode(target);
    }, CENTER_DEBOUNCE_MS);
  }, [nodes, setCenter, centerOnNode]);

  // REQ-6: never leave a pending auto-center debounce across unmounts.
  useEffect(() => {
    return () => {
      if (centerDebounceRef.current) {
        clearTimeout(centerDebounceRef.current);
        centerDebounceRef.current = null;
      }
      pendingCenterIdRef.current = null;
    };
  }, []);

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
      // #2700 ST2 (REQ-6): cancel any in-flight auto-center debounce scheduled
      // for the previous session so stale centers never fire after a switch.
      if (centerDebounceRef.current) {
        clearTimeout(centerDebounceRef.current);
        centerDebounceRef.current = null;
      }
      pendingCenterIdRef.current = null;
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
          noWheelClassName="nowheel"
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

  // ── Session token totals (Spec #2717 R-1, Spec #2723 R-1) ──────────────────
  // Top-strip figures derived from the same deliveries the graph builder
  // consumes, with the same last-wins-per-composite-key rule (R-3.2), so
  // Σ per-node == session figure by construction. O(N) over mergedDeliveries,
  // memoized on the two deps — no polling, no new IPC. Empty sessionId (no
  // selection) yields all-zero totals; the bar is hidden separately when no
  // session is selected.
  const sessionTokenTotals = useMemo(
    () => computeSessionTokenTotals(mergedDeliveries, selectedSessionId ?? ''),
    [mergedDeliveries, selectedSessionId],
  );

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
            flex: 1, minHeight: 0,
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Session token totals top strip (Spec #2723 R-1) — first child
                of the canvas column, above the ReactFlow canvas (below the
                header). A layout sibling (flexShrink: 0), never an overlay, so
                it cannot obscure the ReactFlow canvas. Hidden when no session
                is selected (this branch only renders with one selected). */}
            {selectedSessionId && (
              <SessionTokenBar
                promptTokens={sessionTokenTotals.inputTokens}
                cacheReadTokens={sessionTokenTotals.cacheReadTokens}
                reasoningTokens={sessionTokenTotals.reasoningTokens}
                completionTokens={sessionTokenTotals.outputTokens}
                totalTokens={sessionTokenTotals.totalTokens}
              />
            )}

            {/* AC-5: canvas + detail panel live in a position:relative wrapper
                BELOW the bar (the bar stays a flex-shrink-0 sibling above it).
                The panel's absolute top:0 anchors to THIS wrapper — its
                containing block — so it can never overlay or cover the bar. */}
            <div
              data-testid="mm-canvas-wrapper"
              style={{ flex: 1, minHeight: 0, position: 'relative' }}
            >
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
          </div>
        )}
      </div>
    </div>
  );
};
