import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
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
import { useWindowActions } from '@maomaolabs/core';
import { useEventRows } from '../../../shared/hooks/useEventRows';
import { tint } from '../../../shared/utils/colorTint';
import { useDeliveryGraph, type RowGraphSources } from '../hooks/useMissionMonitor';
import { useDeliverySessions } from '../hooks/useSessionHistory';
import { computeSessionMetrics } from '../lib/counters';
import { computeSubagentTokenTotals, computeSubagentCostTotals } from '../lib/sessionMeta';
import { SessionHistoryDrawer } from './SessionHistoryDrawer';
import { SessionTokenBar } from './SessionTokenBar';
import { NodeFocusProvider } from './NodeFocusContext';
import { DetailPanel } from './DetailPanel';
import { ChatNode }          from './nodes/ChatNode';
import { SubagentNode }      from './nodes/SubagentNode';
import type { MonitorNodeData } from '../types';
import { EMPTY_STATE_JOKES, GHOST_SESSION_COPY } from '../lib/graph';
import type { DetailOpenTarget } from '../lib/graph';
import { initMmTables } from '../lib/persistence';

// Referentially stable — all node types
const NODE_TYPES: NodeTypes = {
  agentNode: ChatNode as any,
  subagentNode: SubagentNode as any,
  // #2764 ST-2: the standalone `toolsNode` registration was removed with the
  // ToolsNode class — tool calls embed inside the chat node (AgentNodePayload.tools).
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

// ── AC-13 round-6 root cause: the minZoom CLAMP, not a never-firing fit ─────
// ReactFlow's fitView computes the zoom that frames every measured node and
// then CLAMPS it to [minZoom, maxZoom] (getViewportForBounds: `zoom = min(
// width/(boundsW*(1+padding)), height/(boundsH*(1+padding)))` → clamp).
// The large restored session `ses_044bb36d7ffeeh5kwPSzvQ1Aum` is a ~24,000px
// tall chat chain (66 nodes × ~388px measured pitch: 66 × 360 fallback + 28
// gap, with content nodes measuring taller). Framing it in a ~700–767px
// viewport requires zoom ≈ 0.026 — far BELOW the old `minZoom={0.3}`. Every
// fit (activation fit, completion fit, and the built-in ReactFlow Controls
// fit button) therefore produced the byte-identical clamped transform
// `translate(706.4px,-3246.95px) scale(0.3)` (scale(0.3) == minZoom exactly —
// the signature of a SUCCESSFUL fit that was clamped, not a fit that never
// fired) and only ~6 of the 66 nodes were visible. Round-5's
// `nodesFullyMeasured` gate is correct and necessary, but insufficient: the
// fit fires, ReactFlow frames the full set at a zoom it then clamps to 0.3.
// Lowering the floor lets fitView actually zoom out far enough to frame the
// complete graph. 0.01 frames a ~64,000px graph in a ~767px viewport — solid
// headroom over the 66-node stress session AND the QA M3 (≥15 nodes) fixture,
// while small fresh sessions (fits at ~0.4) are completely unaffected.
const MIN_FIT_ZOOM = 0.01;

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

// AC-13 round-5: ReactFlow's fitView computes bounds over ALL store nodes but
// silently no-ops (returns false) unless EVERY node has measured dimensions
// (@reactflow/core fitView: `nodesInitialized = nodes.every(n => n.width &&
// n.height)`). Firing fitView while only the first few nodes are measured
// either frames a partial graph or leaves the stale viewport untouched — the
// round-4 AC-13 defect (large restored session: 6/66 nodes in viewport).
// This helper is the "complete node set is ready to be framed" signal: at
// least one node exists AND every current node carries a real measured size.
function nodesFullyMeasured(nodeList: Node[]): boolean {
  return nodeList.length > 0 && nodeList.every(
    (n) => typeof n.width === 'number' && n.width > 0 &&
           typeof n.height === 'number' && n.height > 0,
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
// #2748 AC-4: tokenized in this pass (was hardcoded hex #0c0c1a/#4b5563/#6366f1/
// #6b7280) — theme tokens only (var(--body-bg), var(--text-secondary),
// var(--accent-primary) + alpha suffix) so the empty state follows the user's
// light/dark/accent theme. The tokenized components/EmptyState.tsx (Chakra)
// stays the shared feature empty state; this inline one is the panel's spinner
// variant and now resolves through the same tokens.

const EmptyState: React.FC = () => {
  const joke = useMemo(
    () => EMPTY_STATE_JOKES[Math.floor(Math.random() * EMPTY_STATE_JOKES.length)],
    [],
  );

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16,
      color: 'var(--text-secondary)', background: 'var(--body-bg)',
      animation: 'fade-in 0.5s ease',
    }}>
      <style>{`@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div style={{
        width: 48, height: 48, borderRadius: '50%',
        border: `2px solid ${tint('var(--accent-primary)', 20)}`, borderTopColor: 'var(--accent-primary)',
        animation: 'spin 1.4s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        maxWidth: 360, textAlign: 'center',
        fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, fontStyle: 'italic',
      }}>
        "{joke}"
      </div>
      <span style={{
        fontSize: 10, color: 'var(--text-secondary)',
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
    color: 'var(--text-secondary)', background: 'var(--body-bg)',
  }}>
    <span style={{ fontSize: 24, opacity: 0.3 }}>◈</span>
    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
      Select a session from the sidebar to view its graph
    </span>
  </div>
);

// ── Ghost-session explanatory state (Spec #2791, G-074) ───────────────────────
// A session whose telemetry rows have landed (chat/tool rows present) but whose
// activity produced NO graph nodes is the G-074 ghost — it must NEVER render a
// silent blank canvas (AC1/AC2). This state is rendered INSTEAD of <ReactFlow>
// for the ghost; the legitimate pre-stream transient (NO landed rows yet) is
// NOT this state and keeps the existing blank canvas, unchanged (AC3).
// Theme tokens only (no hardcoded hex/rgba — the tint, heading, body and
// surface all resolve through the theming feature via var()/tint()); no canvas
// chrome (Background/Controls/MiniMap); a11y: semantic <h2> heading + a region
// with an accessible name.
const GhostSessionState: React.FC = () => (
  <div
    role="region"
    aria-label={GHOST_SESSION_COPY.heading}
    style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12,
      background: 'var(--card-bg)',
    }}
  >
    <div
      aria-hidden="true"
      style={{
        width: 44, height: 44, borderRadius: '50%',
        backgroundColor: tint('var(--accent-primary)', 20),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <span style={{ fontSize: 18, color: 'var(--accent-primary)' }}>◌</span>
    </div>
    <h2
      style={{
        margin: 0, fontSize: 14, fontWeight: 600,
        color: 'var(--text-primary)', textAlign: 'center',
      }}
    >
      {GHOST_SESSION_COPY.heading}
    </h2>
    <p style={{
      maxWidth: 360, margin: 0, textAlign: 'center',
      fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6,
    }}>
      {GHOST_SESSION_COPY.body}
    </p>
  </div>
);

// ── Inner canvas ──────────────────────────────────────────────────────────────

interface CanvasProps {
  sessionId: string;
  /** #2788 P4.2: the typed-row source (subscribed once at the panel level). */
  rows: RowGraphSources;
  onFocusTarget: (target: DetailOpenTarget | null) => void;
  /** #2762 ST-3 (D-6): lifted orphan count — the builder is the authority on
   *  which child-session calls never resolved a parent SubagentNode; the panel
   *  renders the figure on the SessionTokenBar. */
  onUnattributedCount?: (count: number) => void;
}

const MissionMonitorCanvas: React.FC<CanvasProps> = ({
  sessionId, rows, onFocusTarget, onUnattributedCount,
}) => {
  // #2788 P4.2: the graph's data source — typed RTDB rows with replay (the
  // persisted snapshot restores as full-row inserts; replay replaces the v1
  // hydration path for the graph). Shared module-scoped row store.
  // G-074 (#2791): the hook also exposes `ready` (per-query replay-complete
  // marker) and `hasLandedRows` (the selected session has landed rows) — the
  // ghost-predicate inputs.
  const {
    nodes, edges, onNodesChange, onEdgesChange, unattributedCount, ready, hasLandedRows,
  } = useDeliveryGraph({
    sessionId,
    rows,
  });

  // ── G-074 ghost predicate (Spec #2791 AC1/AC2/AC3) ─────────────────────────
  // The ghost signature: the session's replay has settled (`ready`), its
  // telemetry rows have landed (`hasLandedRows`), YET the derived node set is
  // empty. Rendering <ReactFlow> for this combination would produce a SILENT
  // blank canvas — instead we surface the explicit explanatory state. When
  // NOT a ghost — including the legitimate pre-stream transient
  // (`nodes.length === 0 && !hasLandedRows`), which behaves exactly as today —
  // the existing render path is untouched (AC3). `!!` coerces the hook-returned
  // booleans defensively (a test stub that omits them short-circuits to false,
  // never a spurious ghost).
  const isGhost = !!ready && nodes.length === 0 && !!hasLandedRows;

  // #2762 ST-3 (D-6): push the builder's orphan count up when it CHANGES
  // (ref-guarded — same-value pushes are skipped, so no render loop).
  const lastUnattributedRef = useRef(-1);
  useEffect(() => {
    if (!onUnattributedCount || lastUnattributedRef.current === unattributedCount) return;
    lastUnattributedRef.current = unattributedCount;
    onUnattributedCount(unattributedCount);
  }, [unattributedCount, onUnattributedCount]);

  const { fitView, setCenter, getZoom, getViewport } = useReactFlow();

  // ── Auto-center: track seen node IDs; coalesce-center the NEWEST new ─────
  // chat node (#2700 ST2 — REQ-3/4/6). Non-chat nodes (subagent/tool/file)
  // are still tracked in `seen` (so hadPriorNodes stays correct) but never
  // trigger centering. The first node of a session is covered by the 0→N
  // initial fitView below — it never triggers a per-node center.
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  const centerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCenterIdRef = useRef<string | null>(null);
  const nodesRef = useRef<Node[]>([]);
  // #2770 R-9: viewport size source for the off-viewport reveal check — the
  // ReactFlow wrapper fills this div, so clientWidth/clientHeight are the
  // viewport's pixel size.
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);

  // ── Consolidated auto-fit state: once per session activation (AC-13) ───────
  // #2743 ST-9: replaced the 0→N node-count transition detector, which (a) was
  // keyed on nodes.length (Spec #275/#523 anti-pattern — .length changes on
  // every ADD_DELIVERY dispatch) and (b) let a stale pre-switch node set
  // consume its one-shot guard, so a session that ALREADY had nodes (restored
  // deliveries) never fit on open/switch. The activation signal is a monotonic
  // session-activation epoch: +1 per sessionId change (mount with a selected
  // session AND every explicit switch). Exactly ONE deferred fitView fires per
  // epoch — after the graph has nodes to fit (restored deliveries load async,
  // so the fire waits — bounded — for node presence via the nodes ref, never
  // as an effect dep) and after ReactFlow has measured them. Incremental
  // N→N+M arrivals never refit (the epoch does not advance), so the user's
  // manual pan/zoom is never fought on streaming updates.
  //
  // One-shot-per-epoch fit guards:
  // - `firedFitEpochRef` — the epoch for which a REAL fit (at least one
  //   MEASURED node) was emitted. Only one real fit per session activation.
  // - `pendingFitEpochRef` — an activation whose bounded poll elapsed with no
  //   measured node yet (restored deliveries still loading). The auto-center
  //   effect's 0→N backstop below fires the fit the moment the session's first
  //   measured nodes arrive — the "restored-delivery gap" the round-3 AC-13
  //   FAIL reproduced (nodes existed but none were visible in the viewport).
  const prevFitSessionIdRef = useRef<string | null>(null);
  const [fitEpoch, setFitEpoch] = useState(0);
  // Fit timing constants (mirrored by MissionMonitorPanel.autofocus.test.tsx).
  const FIT_SETTLE_MS = 100;
  const FIT_WAIT_POLL_MS = 100;
  const FIT_WAIT_MAX_MS = 1000;
  const firedFitEpochRef = useRef(0);
  const pendingFitEpochRef = useRef(0);
  // AC-13 round-5: the node-set size when the activation fit fired for the
  // current epoch, plus the epoch for which the bounded completion fit fired.
  // Together they guarantee the completion fit (a re-frame when the node set
  // grows during the SAME activation) fires at most once per activation —
  // never on every streaming delivery (Spec #275/#523).
  const fitNodeCountRef = useRef(0);
  const completionFitEpochRef = useRef(0);

  // Referentially stable fit trigger — honors prefers-reduced-motion (duration
  // 0 snap) identically across the poll path and the 0→N backstop path.
  // AC-13 round-6: returns whether ReactFlow actually APPLIED the fit.
  // ReactFlow's fitView returns false when a node is still unmeasured at the
  // exact call instant (it checks `nodes.every(n => n.width && n.height)` on
  // its store at call time) — so a caller that consumes its one-shot on a
  // silent no-op loses the activation fit forever. `!== false` keeps `true`
  // (real success) AND `undefined` (unit-test mock) as "applied", while an
  // explicit `false` (real no-op) is a retryable failure.
  //
  // AC-13 round-6 root cause: ReactFlow CLAMPS the computed fit zoom to
  // [minZoom, maxZoom] (getViewportForBounds). The 66-node restored session is
  // ~24,000px tall; framing it in a ~767px viewport needs zoom ≈ 0.026, which
  // the old store minZoom of 0.3 clamped to exactly scale(0.3) — every fit
  // (activation, completion, built-in Controls button) produced the byte-
  // identical clamped transform. Passing minZoom explicitly makes the auto-fit
  // self-contained (frames the full set regardless of the `<ReactFlow>`
  // minZoom prop); the prop is ALSO lowered below so the built-in Controls fit
  // button and manual wheel-zoom share the same floor.
  const fitSessionView = useCallback((): boolean => {
    const duration = prefersReducedMotion() ? 0 : 200;
    return fitView({ padding: 0.2, duration, minZoom: MIN_FIT_ZOOM }) !== false;
  }, [fitView]);


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

    // #2770 R-9 helper: is the node's rect (flow coords → screen via the
    // current viewport transform) entirely OUTSIDE the canvas viewport?
    // Position/transform math per G-040/G-055 (layout coords, never
    // zoom-scaled rects read from the DOM). Unmeasured nodes use the chat
    // fallback size — subagent cards render 420–540px wide, so the fallback
    // bounds are conservative.
    const isNodeOffViewport = (node: Node): boolean => {
      const vp = getViewport ? getViewport() : null;
      const container = canvasContainerRef.current;
      if (!vp || !container) return false;
      const viewW = container.clientWidth;
      const viewH = container.clientHeight;
      if (viewW <= 0 || viewH <= 0) return false;
      const w = node.width ?? DEFAULT_CHAT_NODE_WIDTH;
      const h = node.height ?? DEFAULT_CHAT_NODE_HEIGHT;
      const x0 = node.position.x * vp.zoom + vp.x;
      const y0 = node.position.y * vp.zoom + vp.y;
      const x1 = (node.position.x + w) * vp.zoom + vp.x;
      const y1 = (node.position.y + h) * vp.zoom + vp.y;
      return x1 < 0 || y1 < 0 || x0 > viewW || y0 > viewH;
    };

    const seen = seenNodeIdsRef.current;
    const hadPriorNodes = seen.size > 0;
    // REQ-4: the newest new agent node of a render batch is the LAST entry of
    // the merged nodes array (the graph builder appends in arrival order), so
    // keep overwriting `newestFound` — the last new agent node wins.
    let newestFound: Node | null = null;
    // #2770 R-9: the newest never-seen `subagent-` node landing OUTSIDE the
    // current viewport (the deep-node camera-reveal candidate).
    let newestRevealCandidate: Node | null = null;
    for (const node of nodes) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        if (node.id.startsWith('agent-')) {
          newestFound = node;
        } else if (node.id.startsWith('subagent-') && isNodeOffViewport(node)) {
          newestRevealCandidate = node;
        }
      }
    }

    // ── AC-13 0→N pending-fit backstop (round-3/round-5 hardening) ──────────
    // The bounded fit poll may elapse before a freshly-restored session's
    // deliveries finish loading (slow SQLite / large session). When that
    // session's node set finally arrives AND is FULLY MEASURED, fire the
    // pending activation fit exactly once. Round-5: the gate is now
    // `nodesFullyMeasured` — a partial set (only the first few nodes
    // measured) must NOT consume the activation fit, because ReactFlow's
    // fitView silently no-ops unless every node has dimensions; firing on a
    // partial set frames only that subset (the round-4 large-session defect:
    // "6/66 nodes in viewport"). Guarded by pendingFitEpochRef +
    // firedFitEpochRef so exactly one fit per activation: incremental N→N+M
    // arrivals never refit (the pending flag is cleared the moment the fit
    // fires — `hadPriorNodes` is deliberately NOT a gate here: a restored
    // batch arrives with all nodes at once and ReactFlow measures them
    // progressively, so the first nodes-change that satisfies the fully
    // measured gate may come AFTER the seen-set is already populated).
    const pendingEpoch = pendingFitEpochRef.current;
    const allNodesReady = nodesFullyMeasured(nodes);
    // AC-13 round-6: the pending fit is consumed ONLY when ReactFlow actually
    // APPLIES it. `fitSessionView()` returns false when fitView no-ops (a store
    // node still unmeasured at the call instant) — a false return must leave
    // the pending flag set so the next nodes change (measurement landing)
    // re-attempts. This closes the "fit fires but ReactFlow rejects it with no
    // retry" never-fires path.
    if (pendingEpoch > 0 && pendingEpoch === fitEpoch && allNodesReady && fitSessionView()) {
      pendingFitEpochRef.current = 0;
      firedFitEpochRef.current = fitEpoch;
      fitNodeCountRef.current = nodes.length;
      console.debug(`[mission-monitor] auto-fit: activation fit applied via 0→N backstop (epoch ${fitEpoch}, ${nodes.length} nodes)`);
    }

    // ── AC-13 completion fit (round-5): a large RESTORED session can arrive
    // in a single delivery batch while ReactFlow measures the nodes
    // progressively. If the activation fit fired on a PARTIAL set (the
    // bounded poll's best-effort fallback below), the remaining measured
    // nodes land outside the viewport. Re-fit deterministically ONCE per
    // activation when the node set grows materially after the activation fit
    // — but still never on every streaming delivery (Spec #275/#523): gated
    // by fitNodeCountRef (count at the activation fit) + completionFitEpochRef
    // (at most one completion fit per activation).
    const activationNodeCount = fitNodeCountRef.current;
    let completionFiredThisRun = false;
    if (
      fitEpoch > 0 &&
      firedFitEpochRef.current === fitEpoch &&
      completionFitEpochRef.current !== fitEpoch &&
      activationNodeCount > 0 &&
      nodes.length > activationNodeCount &&
      allNodesReady &&
      // AC-13 round-6: only a REAL apply consumes the completion slot. If
      // ReactFlow rejects at this instant (store node unmeasured), the next
      // nodes change retries — the completion fit can never be silently lost.
      fitSessionView()
    ) {
      completionFitEpochRef.current = fitEpoch;
      fitNodeCountRef.current = nodes.length;
      completionFiredThisRun = true;
      console.debug(`[mission-monitor] auto-fit: completion fit applied (epoch ${fitEpoch}, ${nodes.length} nodes)`);
    }

    // ── #2770 R-9: deep-node camera reveal (one-time, live-arrival path) ────
    // When BOTH per-activation fits are already spent and a NEVER-SEEN
    // `subagent-` node landed OUTSIDE the current viewport (a mid-run L3+ card
    // at x≈1692 — the reopened defect's exact "not showing anything" surface),
    // reveal it ONCE by panning the camera to it through the SAME coalescing,
    // duration and prefers-reduced-motion contract as the chat-node
    // auto-center below (`centerOnNode` keeps the user's current zoom — the
    // reveal NEVER changes zoom). Never re-reveals for already-seen nodes, so
    // the user's manual pan/zoom is never fought; a node scanned in a run
    // where a fit just fired (or is about to frame the full set) is excluded —
    // the fits own the camera on those batches. Restored/full-history sessions
    // are exempt by construction: their whole node set arrives before the
    // activation fit and is framed by it.
    const bothFitsSpent =
      fitEpoch > 0 &&
      firedFitEpochRef.current === fitEpoch &&
      completionFitEpochRef.current === fitEpoch &&
      !completionFiredThisRun;
    if (bothFitsSpent && !newestFound && newestRevealCandidate) {
      newestFound = newestRevealCandidate;
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
  }, [nodes, setCenter, centerOnNode, fitEpoch, fitSessionView, getViewport]);

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

  // ── Consolidated auto-fit: once per session activation (AC-13) ────────────
  // #2743 ST-9: replaced the 0→N node-count transition detector, which (a) was
  // keyed on nodes.length (Spec #275/#523 anti-pattern — .length changes on
  // every ADD_DELIVERY dispatch) and (b) let a stale pre-switch node set
  // consume its one-shot guard, so a session that ALREADY had nodes (restored
  // deliveries) never fit on open/switch. The activation signal is now a
  // monotonic session-activation epoch: +1 per sessionId change (mount with a
  // selected session AND every explicit switch). Exactly ONE deferred fitView
  // fires per epoch — after the graph has nodes to fit (restored deliveries
  // load async, so the fire waits — bounded — for node presence via the nodes
  // ref, never as an effect dep) and after ReactFlow has measured them.
  // Incremental N→N+M arrivals never refit (the epoch does not advance), so
  // the user's manual pan/zoom is never fought on streaming updates.
  // Session activation: reset the per-session auto-center guards (seen-set +
  // in-flight center debounce — #2700 ST2 REQ-6), clear the fit one-shot
  // guards, and advance the fit epoch. Runs on mount-with-a-session and on
  // every explicit session switch only.
  useEffect(() => {
    if (prevFitSessionIdRef.current === sessionId) return;
    prevFitSessionIdRef.current = sessionId;

    seenNodeIdsRef.current = new Set();
    // Cancel any in-flight auto-center debounce scheduled for the previous
    // session so stale centers never fire after a switch.
    if (centerDebounceRef.current) {
      clearTimeout(centerDebounceRef.current);
      centerDebounceRef.current = null;
    }
    pendingCenterIdRef.current = null;

    firedFitEpochRef.current = 0;
    pendingFitEpochRef.current = 0;
    fitNodeCountRef.current = 0;
    completionFitEpochRef.current = 0;

    setFitEpoch((e) => e + 1);
  }, [sessionId]);

  // One deferred fitView per epoch. The effect is keyed on the epoch only —
  // never on nodes.length or deliveries — so a fresh node (N→N+M) can never
  // re-trigger a fit (the user's manual pan/zoom position is preserved).
  //
  // AC-13 round-3 hardening: the fit must fire AFTER ReactFlow has MEASURED
  // the freshly-switched nodes. ReactFlow's fitView computes bounds from the
  // measured node dimensions (filled in via the 'dimensions' change once the
  // nodes render); firing on a graph whose nodes carry no measured dims yet is
  // a silent no-op that leaves the stale viewport — exactly the round-3
  // symptom ("4 nodes existed but 0 were visible in viewport").
  //
  // AC-13 round-5 hardening: ReactFlow's fitView silently returns false
  // unless EVERY store node has a measured width+height
  // (`nodesInitialized = nodes.every(n => n.width && n.height)`). The round-4
  // gate ("at least one measured node") therefore fired fitView on a PARTIAL
  // set for a large restored session: the fit either no-op'd or framed only
  // the measured subset, leaving the later-arriving nodes outside the
  // viewport (round-4 AC-13 defect: "66 nodes, only 6 in viewport"). The poll
  // now waits for the COMPLETE node set to be measured (`nodesFullyMeasured`)
  // before emitting the activation fit — a restored-delivery session's full
  // node set arrives in one batch, so this frames every node. If the bounded
  // poll elapses before the set is fully measured (slow restore / a set still
  // growing), the epoch is marked PENDING and the auto-center effect's 0→N
  // backstop + the bounded completion fit fire once the complete measured set
  // is present — so a restored-delivery session ALWAYS gets its activation
  // fit over the full graph.
  useEffect(() => {
    if (fitEpoch === 0) return;

    const epoch = fitEpoch;
    const maxPolls = Math.ceil(FIT_WAIT_MAX_MS / FIT_WAIT_POLL_MS);
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fireWhenReady = () => {
      // Superseded by a newer activation (a switch landed before we fired).
      if (fitEpoch !== epoch) return;
      // A real fit was already emitted for this epoch (the 0→N backstop beat
      // the poll) — never double-fire the activation fit.
      if (firedFitEpochRef.current === epoch) return;

      const nodeList = nodesRef.current;
      const allReady = nodesFullyMeasured(nodeList);

      // AC-13 round-6: the fit must actually SUCCEED, not just be attempted.
      // ReactFlow's fitView returns false when a store node is still
      // unmeasured at the call instant (its own `nodes.every(...)` check runs
      // against the store at call time, which can lag our props gate by one
      // render). A false return means the transform was NOT applied — keep
      // polling (bounded) instead of consuming the one-shot and leaving the
      // stale viewport (the "fit fires but ReactFlow rejects it" never-fires
      // path). `!== false` treats the unit-test mock's `undefined` as success.
      if (allReady && fitSessionView()) {
        pendingFitEpochRef.current = 0;
        firedFitEpochRef.current = epoch;
        fitNodeCountRef.current = nodeList.length;
        console.debug(`[mission-monitor] auto-fit: activation fit applied (epoch ${epoch}, ${nodeList.length} nodes)`);
        return;
      }

      if (polls < maxPolls) {
        polls += 1;
        timer = setTimeout(fireWhenReady, FIT_WAIT_POLL_MS);
        return;
      }

      // Poll cap reached before the node set was FULLY measured / the fit was
      // accepted (restored deliveries still loading, or a large graph still
      // being measured). Do NOT emit fitView on a partial set — ReactFlow's
      // fitView would silently no-op (or frame only the measured subset). Mark
      // the epoch PENDING; the auto-center effect's 0→N backstop / completion
      // fit fire the activation fit the moment the complete measured set is
      // present (AC-13 round-5) AND ReactFlow accepts it (round-6).
      pendingFitEpochRef.current = epoch;
      console.debug(`[mission-monitor] auto-fit: activation fit deferred (poll cap, epoch ${epoch})`);
    };

    timer = setTimeout(fireWhenReady, FIT_SETTLE_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [fitEpoch, fitSessionView]);

  return (
    <NodeFocusProvider value={onFocusTarget}>
      <div
        ref={canvasContainerRef}
        style={{ width: '100%', height: '100%', position: 'relative' }}
      >
        {/* G-074 (#2791): the ghost session renders the explicit explanatory
            state INSTEAD of <ReactFlow> — never a silent blank canvas. */}
        {isGhost ? (
          <GhostSessionState />
        ) : (
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          // AC-13 round-6 root cause: the previous minZoom={0.3} CLAMPED every
          // fit of the ~24,000px-tall 66-node restored session to scale(0.3),
          // leaving only ~6/66 nodes visible (transform byte-identical across
          // rounds AND after the built-in fit button — a clamped success, not
          // a never-fired fit). Lowering the floor to MIN_FIT_ZOOM lets fitView
          // zoom out far enough to frame the complete graph. Small fresh
          // sessions are unaffected (they fit at ~0.4).
          minZoom={MIN_FIT_ZOOM} maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          selectNodesOnDrag={false}
          panOnDrag={true}
          zoomOnScroll={true}
          // #2743 ST-6 round-5 (AC-7/AC-8): zoomOnDoubleClick must be FALSE —
          // ReactFlow's default `true` attaches a d3-zoom `dblclick.zoom`
          // handler to the renderer element that calls
          // `preventDefault()` + `stopImmediatePropagation()` on the dblclick
          // BEFORE it bubbles to React's root container, where `onDoubleClick`
          // (and therefore `onNodeDoubleClick`) is delegated. With the default,
          // double-clicking a node NEVER fires `onNodeDoubleClick` — the round-4
          // AC-7/AC-8 defect ("no DetailPanel DOM in ANY attempt"). Disabling
          // double-click-to-zoom lets the dblclick event propagate normally so
          // the node's `onDoubleClick` handler fires.
          zoomOnDoubleClick={false}
          preventScrolling={true}
          noWheelClassName="nowheel"
          defaultEdgeOptions={{ hidden: false }}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'var(--body-bg)' }}
          // #2743 ST-6 (AC-7): single-click NEVER opens the detail panel —
          // only double-click does (ReactFlow onNodeDoubleClick is the single
          // node trigger; the node-internal onDoubleClick handlers in the node
          // components were removed so it never fires twice).
          onNodeDoubleClick={(_, node) => {
            onFocusTarget({ kind: 'node', data: node.data as MonitorNodeData });
          }}
          onPaneClick={() => {
            onFocusTarget(null);
          }}
        >
          {/* #2748 ST-6 (AC-5 / theming NFR): canvas chrome uses theme tokens
              only — the hardcoded dark-hex canvas surfaces were replaced with
              var() tokens so the graph follows the user's light/dark/accent
              theme (ReactFlow bg → var(--body-bg); Background dots →
              color-mix tint of var(--border-color); Controls/MiniMap surfaces
              → var(--card-bg) / var(--border-color); MiniMap mask → color-mix
              tint of var(--body-bg)). #2770 round 5: the tints use the shared
              `tint()` helper — `var(--x)NN` alpha-append is INVALID CSS (the
              browser drops the whole declaration at computed-value time). */}
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tint('var(--border-color)', 20)} />
          <Controls style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: '6px' }} />
          <MiniMap
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)' }}
            // #2748 ST-6 (AC5 / R-5.3-minimap): the nodeColor callback is
            // neutralized — a single neutral theme token for EVERY node,
            // regardless of status. Status-keyed minimap coloring is removed
            // (the node-status switch is gone); the selection ring on the
            // canvas itself remains the only selection signal.
            nodeColor={() => 'var(--border-color)'}
            maskColor={tint('var(--body-bg)', 60)}
          />
        </ReactFlow>
        )}
      </div>
    </NodeFocusProvider>
  );
};

// ── Outer panel ───────────────────────────────────────────────────────────────

export const MissionMonitorPanel: React.FC = () => {
  // ── #2788 P4.3: the typed-row source for EVERYTHING in the panel ──────────
  // Graph + session metrics + session list all read the shared module-scoped
  // row store via `useEventRows(..., { replay: true })` — the persisted
  // snapshot restores as full-row inserts and live patches continue on the
  // same path (one rendering path for restored + live, UI/UX parity
  // constraint 3). `useDeliverySessions` holds its own Chat subscription for
  // its `ready` gate; duplicate envelopes dedupe by row key (idempotent).
  const chatRows = useEventRows('Chat', {}, { replay: true });
  const toolUseRows = useEventRows('ToolUse', {}, { replay: true });
  const {
    sessions,
    filteredSessions,
    selectedSessionId,
    selectSession,
    followSession,
    deleteSession,
    renameSession,
    searchFilter,
    setSearchFilter,
    userPickedRef,
  } = useDeliverySessions();

  // ── #2748 FIX-3 (round-2 AC4 / R-4.1): the window/dialog identity remnant ──
  // ST-6 removed the in-panel `Mission Monitor · <date> · <sessionId>` header
  // strip, but the feature window's chrome identity survived: `Home.tsx` opens
  // every feature window with `openWindow({ title: feature.name })`, and
  // @maomaolabs/core's WindowManager renders that title as BOTH the visible
  // window-header label AND the `role="dialog"` container's `aria-label`
  // (dist/index.es.js:969-970) — so the a11y tree still exposed `dialog
  // Mission Monitor` (tester round-1 FAIL, AC4). The AC4 letter requires NO
  // `Mission Monitor` text anywhere in the panel's a11y tree. Neutralize the
  // window title to the drawer-consistent "Sessions" (the drawer's "Sessions"
  // header is the only remaining self-identification per the UI/UX spec).
  const { updateWindow } = useWindowActions();
  useLayoutEffect(() => {
    updateWindow('mission-monitor', { title: 'Sessions' });
  }, [updateWindow]);

  const [drawerOpen, setDrawerOpen] = useState(true);

  // ── #2762 ST-3 (D-6): orphaned child-session events ────────────────────────
  // The canvas's graph builder is the authority on which collected
  // child-session calls never resolved a parent SubagentNode; the count is
  // lifted here and rendered on the SessionTokenBar as `⚠ N unattributed`
  // (only when N > 0 — D-6/R-8: suppressed from the canvas, never silent).
  const [unattributedCount, setUnattributedCount] = useState(0);
  const handleUnattributedCount = useCallback((count: number) => setUnattributedCount(count), []);

  // Initialize SQLite tables on mount
  useEffect(() => {
    initMmTables();
  }, []);

  // ── Auto-follow new sessions (#2758 round-22 C1) ──────────────────────────
  // Belt-and-suspenders layer over the hook's authoritative follow effect.
  // A NEWLY SEEN sessionId in the Chat row store is FOLLOWED even when another
  // session is already auto-selected — but NEVER over an explicit user pick
  // (row click flips userPickedRef). First pass seeds the known set:
  // everything observable at mount predates this panel instance and must not
  // steal focus. Uses followSession (NOT selectSession) so userPickedRef stays
  // false; membership of the target in `sessions` excludes deleted sessions
  // (REQ-3). Keyed on the row-store EPOCH — never on map identity/size (the
  // #523-cycle-1 no-loop rule).
  const knownSessionIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (knownSessionIdsRef.current === null) {
      const seed = new Set<string>();
      for (const row of chatRows.rows.values()) {
        const sid = row.sessionId;
        if (sid) seed.add(sid);
      }
      knownSessionIdsRef.current = seed;
      return;
    }

    const known = knownSessionIdsRef.current;
    let newestNewSid: string | null = null;
    // Map iteration order is row-key insertion order = arrival order — the
    // LAST newly seen sessionId wins when several appear in one batch.
    for (const row of chatRows.rows.values()) {
      const sid = row.sessionId;
      if (sid && !known.has(sid)) {
        newestNewSid = sid;
      }
    }

    if (newestNewSid === null) return;

    if (userPickedRef.current) {
      // Explicit pick active — burn the pending sessionId so it cannot steal
      // focus after a later deselect/reset (same policy as the hook).
      known.add(newestNewSid);
      return;
    }

    if (sessions.some((s) => s.sessionId === newestNewSid)) {
      known.add(newestNewSid);
      followSession(newestNewSid);
    }
    // Deliberately NOT adding non-followed new sids to the known set: until the
    // derived list catches up they retry on the next epoch bump —
    // mirrors the hook's self-healing policy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatRows.epoch, sessions, followSession, userPickedRef]);

  // ── Session metrics (Spec #2717 R-1, #2723 R-1, #2743 ST-3 / AC-12) ───────
  // Top-strip figures derived from the same TYPED ROWS the graph builder
  // consumes (P4.2), with the row store's one-row-per-key semantics replacing
  // the v1 last-wins-per-composite-key dedupe (R-3.2), so Σ per-node ==
  // session figure by construction. `computeSessionMetrics` extends the token
  // totals with the session's ESTIMATED COST (Σ per-row costUsd) and TOTAL
  // MESSAGES (distinct chat keys) under the identical
  // composited-child-exclusion rule (the `compositedChildSessionId` column).
  // Memoized on the monotonic row-store epochs — never on map identity/size
  // (the #523-cycle-1 no-loop rule). Empty sessionId (no selection) yields
  // all-zero totals; the bar is hidden separately when no session is selected.
  // #2748 ST-6 (AC3 / R-3.1 compute): the SUBAGENTS figure is computed HERE —
  // `computeSubagentTokenTotals` (over the session's own `task` rows,
  // build/plan excluded) — and passed to the bar as `subagentTokens`;
  // `totalTokens` stays the parent five-way (ST-5's component sums the two
  // for the TOTAL headline — never pre-sum here).
  // #2750 ST-1 (AC1): the ESTIMATED COST becomes parent + subagent spend —
  // `computeSubagentCostTotals` (Σ normalizeCost(childCost) over task rows,
  // build/plan excluded) is added to `totalCostUsd` at the prop site below.
  // Combined HERE in the panel — the SessionTokenBar contract stays a single
  // combined `estimatedCost` figure (UI/UX: ONE figure, `$X.XXXX`; the
  // parenthetical in its title/aria-label documents the inclusion).
  // No-subagent sessions sum `+ 0` and render byte-unchanged (AC1-2).
  // #2788 P4.3: the row sources were subscribed at the top of the component —
  // `useEventRows('Chat' | 'ToolUse', { replay: true })` over the shared
  // module-scoped row store. The memo re-derives on the monotonic epochs.
  const rowSources = useMemo(
    () => ({ chat: chatRows, toolUse: toolUseRows }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatRows.epoch, toolUseRows.epoch, chatRows.error, toolUseRows.error],
  );
  const sessionMetrics = useMemo(
    () => {
      const chatRowList = [...rowSources.chat.rows.values()];
      const toolRowList = [...rowSources.toolUse.rows.values()];
      const parent = computeSessionMetrics(chatRowList, selectedSessionId ?? '');
      const subagentTokens = computeSubagentTokenTotals(toolRowList, selectedSessionId ?? '');
      const subagentCost = computeSubagentCostTotals(toolRowList, selectedSessionId ?? '');
      // #2750 round-6 (AC1): the ESTIMATED COST combine is computed HERE as one
      // deterministic memoized value (`parent.totalCostUsd + subagentCost`) —
      // byte-exact `$X.XXXX` via the SessionTokenBar formatter.
      return {
        ...parent,
        subagentTokens,
        subagentCost,
        estimatedCost: parent.totalCostUsd + subagentCost,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowSources, selectedSessionId],
  );

  const handleDeleteSession = useCallback((id: string) => {
    deleteSession(id);
  }, [deleteSession]);

  // ── Detail Panel state (#2743 ST-6 / AC-7, AC-8) ─────────────────────────
  // The open target is a `DetailOpenTarget` union: a node (opened by ReactFlow
  // onNodeDoubleClick — single-click never opens) or a scoped tool call (opened
  // by double-clicking a ToolsNode accordion item). `null` = panel closed.
  const [focusTarget, setFocusTarget] = useState<DetailOpenTarget | null>(null);

  const handleFocusTarget = useCallback((target: DetailOpenTarget | null) => {
    setFocusTarget(target);
  }, []);

  const isEmpty = sessions.length === 0;

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--body-bg)',
    }}>
      {/* #2748 ST-6 (AC4 / R-4.1): the `Mission Monitor · <label | sessionId>`
          header strip is REMOVED — the SessionTokenBar (which already carries
          `background: var(--header-bg)` + `borderBottom: 1px solid
          var(--border-color)`) is now the panel's top row (R-4.2). The
          drawer's "Sessions" header remains the only self-identification.
          The removed header also carried the "No session" placeholder text —
          gone with the strip. */}

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
          // #2748 ST-6 (AC2): wire the hook's renameSession into the drawer's
          // optional onRename prop (ST-4's inline rename UI).
          onRename={renameSession}
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
                of the canvas column, above the ReactFlow canvas. A layout
                sibling (flexShrink: 0), never an overlay, so it cannot obscure
                the ReactFlow canvas. Hidden when no session is selected (this
                branch only renders with one selected). #2748 ST-6 (AC4): with
                the header gone this strip IS the top row of the main view
                (R-4.2). #2748 ST-6 (AC3): `totalTokens` stays the PARENT
                five-way as today — `subagentTokens` is passed separately and
                ST-5's component sums them for the TOTAL headline (never
                pre-sum here — R-3.2). */}
            {selectedSessionId && (
              <SessionTokenBar
                promptTokens={sessionMetrics.inputTokens}
                cacheReadTokens={sessionMetrics.cacheReadTokens}
                reasoningTokens={sessionMetrics.reasoningTokens}
                completionTokens={sessionMetrics.outputTokens}
                totalTokens={sessionMetrics.totalTokens}
                subagentTokens={sessionMetrics.subagentTokens}
                estimatedCost={sessionMetrics.estimatedCost}
                totalMessages={sessionMetrics.totalMessages}
                unattributedEvents={unattributedCount}
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
                rows={rowSources}
                onFocusTarget={handleFocusTarget}
                onUnattributedCount={handleUnattributedCount}
              />
            </ReactFlowProvider>

            {/* Detail Panel */}
            {focusTarget && (
              <DetailPanel target={focusTarget} onClose={() => setFocusTarget(null)} />
            )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
