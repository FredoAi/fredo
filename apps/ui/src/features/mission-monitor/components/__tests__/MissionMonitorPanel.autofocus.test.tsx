/**
 * Component tests for MissionMonitorPanel auto-center (#2688 ST5 / #2700 ST2).
 *
 * Verifies that the canvas coalesce-centers the NEWEST chat (agent) node of a
 * render batch at its geometric center while preserving the user's current
 * zoom (REQ-4/REQ-5), that rapid arrivals are debounced into a single center
 * (REQ-6), that the first node of a session does NOT trigger setCenter
 * (initial-load uses fitView), that non-chat nodes never trigger setCenter,
 * and that prefers-reduced-motion snaps instead of animating.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, cleanup } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { Node } from 'reactflow';
import type { MonitorNodeData } from '../../types';
import { loadPersistedSessions } from '../../lib/persistence';

// #2700 ST2 — mirror the panel's constants so assertions pin the intended
// behavior (geometric center + debounce window + animation duration).
// #2743 AC-6: the fallback chat-node size scaled with the ~1.5× wider nodes
// (panel DEFAULT_CHAT_NODE_WIDTH 320→480, DEFAULT_CHAT_NODE_HEIGHT 200→240).
const CENTER_DEBOUNCE_MS = 300;
const DEFAULT_CHAT_NODE_WIDTH = 480;
const DEFAULT_CHAT_NODE_HEIGHT = 240;
const CENTER_DURATION_MS = 500;
// #2743 ST-9 — mirror the panel's consolidated auto-fit timing constants
// (AC-13): deferred fit settle + bounded node-presence poll window.
const FIT_SETTLE_MS = 100;
const FIT_WAIT_POLL_MS = 100;
const FIT_WAIT_MAX_MS = 1000;

// ── Controlled mocks ──────────────────────────────────────────────────────────

let mockNodes: Node<MonitorNodeData>[] = [];
const mockSetCenter = vi.fn();
const mockFitView = vi.fn();
const mockGetZoom = vi.fn(() => 1.25);

// Captures the canvas's ReactFlow handlers so tests can simulate a single-click
// selection (must NOT refit) without rendering a real ReactFlow instance.
const reactflowHandlers = vi.hoisted(() => ({
  onNodeClick: undefined as ((event: unknown, node: { data: MonitorNodeData }) => void) | undefined,
  onPaneClick: undefined as (() => void) | undefined,
}));

vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({
    children, onNodeClick, onPaneClick,
  }: {
    children?: React.ReactNode;
    onNodeClick?: (event: unknown, node: { data: MonitorNodeData }) => void;
    onPaneClick?: () => void;
  }) => {
    reactflowHandlers.onNodeClick = onNodeClick;
    reactflowHandlers.onPaneClick = onPaneClick;
    return <div data-testid="reactflow">{children}</div>;
  },
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: () => <div data-testid="minimap" />,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="reactflow-provider">{children}</div>
  ),
  useReactFlow: () => ({
    fitView: mockFitView,
    setCenter: mockSetCenter,
    getZoom: mockGetZoom,
  }),
}));

vi.mock('../../hooks/useMissionMonitor', () => ({
  useDeliveryGraph: () => ({
    nodes: mockNodes,
    edges: [],
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    layoutVersion: 0,
    eventCount: mockNodes.length,
  }),
}));

// Mock persistence — one persisted session so the canvas renders with a
// selected session.
vi.mock('../../lib/persistence', () => ({
  initMmTables: vi.fn(),
  persistDelivery: vi.fn(),
  loadPersistedSessions: vi.fn().mockResolvedValue([
    { sessionId: 's1', label: 'Session 1', startTime: 1, latestTimestamp: '2026-01-01T00:00:00.000Z', deliveryCount: 0 },
  ]),
  deleteSessionFromStore: vi.fn(),
  loadPersistedDeliveries: vi.fn().mockResolvedValue([]),
  markSessionDeleted: vi.fn(),
  isSessionDeleted: vi.fn(() => false),
  // ST11: real implementations — pure watermark helpers used by the panel.
  createDeliveryWatermark: () => ({ cursor: 0, seenIds: new Set() }),
  nextUnseenDeliveries: (deliveries, state) => {
    if (deliveries.length < state.cursor) state.cursor = 0;
    if (deliveries.length <= state.cursor) return [];
    const slice = deliveries.slice(state.cursor);
    state.cursor = deliveries.length;
    const unseen = slice.filter((d) => !state.seenIds.has(d.id));
    for (const d of unseen) state.seenIds.add(d.id);
    return unseen;
  },
}));

// Mock StreamContext — no live deliveries (the graph is driven via the mocked hook).
vi.mock('@/shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    deliveries: [],
    isConnected: false,
    clearEvents: vi.fn(),
  })),
}));

import { MissionMonitorPanel } from '../MissionMonitorPanel';

// `measured` simulates ReactFlow having measured a rendered node (fills the
// node's width/height — used by the REQ-5 geometric-center computation).
function makeAgentNode(
  id: string,
  y: number,
  measured?: { width: number; height: number },
): Node<MonitorNodeData> {
  return {
    id,
    type: 'agentNode',
    position: { x: 0, y },
    ...(measured ? { width: measured.width, height: measured.height } : {}),
    data: {
      eventType: 'agent',
      status: 'inactive',
      payload: { userMessage: 'hi', agentReply: '', agentThinking: '', promptTokens: 0, completionTokens: 0, totalTokens: 0, correlationId: id, sessionId: 's1' },
      timestamp: '2026-01-01T00:00:00.000Z',
      label: 'Chat',
      threadId: 'main',
      relatedEvents: [],
    },
  };
}

function makeToolNode(id: string): Node<MonitorNodeData> {
  return {
    id,
    type: 'toolNode',
    position: { x: 0, y: 0 },
    data: {
      eventType: 'tool',
      status: 'inactive',
      payload: {},
      timestamp: '2026-01-01T00:00:00.000Z',
      label: 'Tool',
      threadId: 'main',
      relatedEvents: [],
    },
  };
}

describe('MissionMonitorPanel auto-center (#2688 ST5 / #2700 ST2)', () => {
  beforeEach(() => {
    // Control the 300ms coalescing debounce deterministically.
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockNodes = [];
    // Deterministic single-session default (clearAllMocks keeps the factory's
    // mockResolvedValue implementation — reset it here so per-test overrides
    // never leak across tests).
    vi.mocked(loadPersistedSessions).mockResolvedValue([
      { sessionId: 's1', label: 'Session 1', startTime: 1, latestTimestamp: '2026-01-01T00:00:00.000Z', deliveryCount: 0 },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // RTL auto-cleanup does not run (vitest globals are off) — unmount the
    // previous render so screen queries never match stale rows from a prior
    // test (cross-test DOM accumulation made the session-switch test flaky).
    cleanup();
  });

  /** Establishes the selected session with zero nodes before any node batch. */
  async function establishSession(rerender: (ui: React.ReactElement) => void) {
    // Flush the persisted-session load so the session auto-selects with no
    // nodes yet — the canvas mounts and resets its seen set on session change.
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
  }

  /** Fires the coalescing debounce so the scheduled center lands. */
  async function flushDebounce() {
    await act(async () => {
      vi.advanceTimersByTime(CENTER_DEBOUNCE_MS);
    });
  }

  it('does not setCenter for the first chat node of a session (initial load uses fitView)', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    // Push the first agent node after the session is selected.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);

    // Even after the full debounce window, setCenter is NOT called for the
    // first node of a session — the 0→N initial fitView owns that transition.
    await flushDebounce();
    expect(mockSetCenter).not.toHaveBeenCalled();
  });

  it('centers a single new chat node at its geometric center, preserving zoom', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);
    expect(mockSetCenter).not.toHaveBeenCalled();

    // Second chat node arrives → session already had nodes → debounced center.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0), makeAgentNode('agent-2', 260)];
    });
    rerender(<MissionMonitorPanel />);

    // Debounce: nothing fires synchronously.
    expect(mockSetCenter).not.toHaveBeenCalled();

    await flushDebounce();

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const [x, y, options] = mockSetCenter.mock.calls[0];
    // Geometric center of agent-2: position + half the fallback default size
    // (no measured dimensions yet → 480×240 defaults).
    expect(x).toBe(0 + DEFAULT_CHAT_NODE_WIDTH / 2);
    expect(y).toBe(260 + DEFAULT_CHAT_NODE_HEIGHT / 2);
    // REQ-5: the user's current zoom is preserved — no forced zoom reset.
    expect(options.zoom).toBe(1.25);
    expect(options.duration).toBe(CENTER_DURATION_MS);
  });

  it('centers the LAST new agent node of a batch (newest wins, REQ-4)', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);

    // Three chat nodes arrive in ONE render batch (a batched live export).
    await act(async () => {
      mockNodes = [
        makeAgentNode('agent-1', 0),
        makeAgentNode('agent-2', 260),
        makeAgentNode('agent-3', 520),
      ];
    });
    rerender(<MissionMonitorPanel />);

    await flushDebounce();

    // One center for the batch, targeting the NEWEST node (agent-3), not the
    // first new node of the batch (agent-2).
    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const [x, y] = mockSetCenter.mock.calls[0];
    expect(x).toBe(0 + DEFAULT_CHAT_NODE_WIDTH / 2);
    expect(y).toBe(520 + DEFAULT_CHAT_NODE_HEIGHT / 2);
  });

  it('coalesces rapid successive arrivals into a single center on the newest node (REQ-6)', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);

    // agent-2 arrives and schedules a center.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0), makeAgentNode('agent-2', 260)];
    });
    rerender(<MissionMonitorPanel />);

    // agent-3 arrives WITHIN the debounce window — resets the timer; the
    // pending center for agent-2 must never fire.
    await act(async () => {
      vi.advanceTimersByTime(CENTER_DEBOUNCE_MS / 2);
    });
    rerender(<MissionMonitorPanel />);

    await act(async () => {
      mockNodes = [
        makeAgentNode('agent-1', 0),
        makeAgentNode('agent-2', 260),
        makeAgentNode('agent-3', 520),
      ];
    });
    rerender(<MissionMonitorPanel />);

    await flushDebounce();

    // Exactly ONE center animation for the whole burst, on the newest node.
    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const [x, y] = mockSetCenter.mock.calls[0];
    expect(x).toBe(0 + DEFAULT_CHAT_NODE_WIDTH / 2);
    expect(y).toBe(520 + DEFAULT_CHAT_NODE_HEIGHT / 2);
  });

  it('uses measured node dimensions for the geometric center when available (REQ-5)', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);

    // agent-2 carries ReactFlow-measured dimensions (360×240).
    await act(async () => {
      mockNodes = [
        makeAgentNode('agent-1', 0),
        makeAgentNode('agent-2', 260, { width: 360, height: 240 }),
      ];
    });
    rerender(<MissionMonitorPanel />);

    await flushDebounce();

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const [x, y] = mockSetCenter.mock.calls[0];
    expect(x).toBe(0 + 360 / 2);
    expect(y).toBe(260 + 240 / 2);
  });

  it('does not setCenter when only non-chat nodes arrive', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    // Seed one agent node so hadPriorNodes is true.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);
    expect(mockSetCenter).not.toHaveBeenCalled();

    // A tool node arrives — tracked but never triggers setCenter, even after
    // the full debounce window.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0), makeToolNode('tool-1')];
    });
    rerender(<MissionMonitorPanel />);

    await flushDebounce();
    expect(mockSetCenter).not.toHaveBeenCalled();
  });

  it('snaps instantly (duration 0) when prefers-reduced-motion is enabled', async () => {
    // Accessibility: a reduced-motion user gets an instant snap, not an
    // animated camera transition. Zoom is still preserved.
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0), makeAgentNode('agent-2', 260)];
    });
    rerender(<MissionMonitorPanel />);

    await flushDebounce();

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const [, , options] = mockSetCenter.mock.calls[0];
    expect(options.duration).toBe(0);
    expect(options.zoom).toBe(1.25);
  });

  // ── AC-13 / #2743 ST-9: once-per-session-activation auto-fit ─────────────
  // The consolidated auto-fit fires fitView({ padding: 0.2, duration: 200 })
  // deterministically ONCE per session activation — app open with a selected
  // session AND every explicit session switch — including sessions that
  // already have nodes (restored deliveries). Incremental N→N+M arrivals and
  // single-click selection never refit.

  /** Flushes the fit settle window (FIT_SETTLE_MS + one poll). */
  async function flushFit() {
    await act(async () => {
      vi.advanceTimersByTime(FIT_SETTLE_MS + FIT_WAIT_POLL_MS);
    });
  }

  it('fits the view once when the app opens with a selected session that already has nodes (restored deliveries, AC-13)', async () => {
    // Restored deliveries: the session already has nodes when the canvas
    // mounts (mockNodes populated before the persisted-session load settles).
    // The nodes carry ReactFlow-measured dimensions — the fit waits for a
    // measured node before firing (AC-13 round-3 hardening: fitView on an
    // unmeasured graph silently no-ops and leaves a stale viewport).
    mockNodes = [
      makeAgentNode('agent-1', 0, { width: 480, height: 240 }),
      makeAgentNode('agent-2', 260, { width: 480, height: 240 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await flushFit();

    // Exactly one fit for the session activation — no 0→N transition needed.
    expect(mockFitView).toHaveBeenCalledTimes(1);
    expect(mockFitView).toHaveBeenCalledWith({ padding: 0.2, duration: 200 });
  });

  it('fits the view exactly once per explicit session switch (AC-13)', async () => {
    // Two persisted sessions: s1 is newer (auto-selected), s2 is older.
    vi.mocked(loadPersistedSessions).mockResolvedValue([
      { sessionId: 's1', label: 'Session 1', startTime: 2, latestTimestamp: '2026-01-02T00:00:00.000Z', deliveryCount: 0 },
      { sessionId: 's2', label: 'Session 2', startTime: 1, latestTimestamp: '2026-01-01T00:00:00.000Z', deliveryCount: 0 },
    ]);
    mockNodes = [makeAgentNode('agent-1', 0, { width: 480, height: 240 })];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender); // s1 auto-selected

    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(1);

    // Click a drawer session row (the delete button's parent row carries the
    // onSelect handler). Scoped via the row's label text so the panel header's
    // active-session label (same text) can never collide.
    const clickSessionRow = (label: string) => {
      const deleteBtn = screen
        .getAllByTitle('Delete session')
        .find((b) => b.parentElement?.textContent?.includes(label));
      expect(deleteBtn?.parentElement).toBeTruthy();
      fireEvent.click(deleteBtn!.parentElement!);
    };

    // Explicit switch to s2 — exactly one more fit.
    await act(async () => { clickSessionRow('Session 2'); });
    rerender(<MissionMonitorPanel />);

    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(2);

    // Switch back to s1 — another activation, another single fit.
    await act(async () => { clickSessionRow('Session 1'); });
    rerender(<MissionMonitorPanel />);

    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(3);
  });

  it('does NOT refit on incremental N→N+M arrivals (only session activation fires, AC-13)', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    // First batch arrives — the session-activation fit fires once (nodes carry
    // measured dims so the fit can compute real bounds).
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0, { width: 480, height: 240 })];
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(1);

    // Incremental arrivals on the SAME session must NOT refit (the user's
    // manual pan/zoom is preserved; only session activation fires).
    await act(async () => {
      mockNodes = [
        makeAgentNode('agent-1', 0),
        makeAgentNode('agent-2', 260),
        makeAgentNode('agent-3', 520),
      ];
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(1);
  });

  it('does NOT refit on single-click node selection (AC-13 interaction invariant)', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0, { width: 480, height: 240 })];
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(1);

    // Single-click selection → setFocusedNode only (session unchanged) → the
    // fit must NOT re-fire.
    await act(async () => {
      reactflowHandlers.onNodeClick?.({} as MouseEvent, { data: makeAgentNode('agent-1', 0).data });
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(1);
  });

  it('fits with duration 0 when prefers-reduced-motion is enabled (AC-13)', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    mockNodes = [makeAgentNode('agent-1', 0, { width: 480, height: 240 })];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(1);
    expect(mockFitView).toHaveBeenCalledWith({ padding: 0.2, duration: 0 });
  });

  it('fires the pending activation fit when the session\u2019s first MEASURED nodes arrive after the poll cap (0→N backstop, AC-13)', async () => {
    // Round-3 AC-13 root cause: restored deliveries can finish loading AFTER
    // the fit poll's bounded window. The fit must NOT be lost — the 0→N
    // backstop fires the pending activation fit the moment the first measured
    // nodes appear.
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender); // session selected, zero nodes yet

    // Let the bounded fit poll elapse with no nodes → the activation fit is
    // marked PENDING (never a silent no-op on an empty graph).
    await act(async () => {
      vi.advanceTimersByTime(FIT_SETTLE_MS + FIT_WAIT_MAX_MS + FIT_WAIT_POLL_MS);
    });
    expect(mockFitView).not.toHaveBeenCalled();

    // Restored deliveries finally arrive — with measured dimensions.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0, { width: 480, height: 240 })];
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();

    expect(mockFitView).toHaveBeenCalledTimes(1);
    expect(mockFitView).toHaveBeenCalledWith({ padding: 0.2, duration: 200 });
  });

  it('does not fit and does not crash when no session is selected (AC-13 edge)', async () => {
    vi.mocked(loadPersistedSessions).mockResolvedValue([]);

    renderWithChakra(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });
    await flushFit();

    expect(mockFitView).not.toHaveBeenCalled();
  });

  it('AC-13 round-5: large restored session — waits for the FULL node set to be measured before fitting (no partial-bounds fit)', async () => {
    // Round-4 AC-13 defect: for a 66-node restored session the fit fired when
    // only the FIRST few nodes were measured, computing bounds over a partial
    // graph — the later-arriving nodes landed outside the viewport ("6/66
    // nodes in viewport at scale(0.3)"). The activation fit must wait for the
    // COMPLETE node set to carry measured dimensions (ReactFlow's fitView
    // itself requires `every(n => n.width && n.height)` or silently no-ops).
    const nodes = Array.from({ length: 66 }, (_, i) =>
      makeAgentNode(`agent-${i}`, i * 260, i < 6 ? { width: 480, height: 240 } : undefined),
    );
    mockNodes = nodes;

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    // All 66 nodes are present but only the first 6 measured — even past the
    // full poll cap the fit must NOT fire on the partial set (it is marked
    // PENDING instead).
    await act(async () => {
      vi.advanceTimersByTime(FIT_SETTLE_MS + FIT_WAIT_MAX_MS + FIT_WAIT_POLL_MS);
    });
    expect(mockFitView).not.toHaveBeenCalled();

    // ReactFlow finishes measuring the remaining nodes.
    await act(async () => {
      mockNodes = nodes.map((n) => ({ ...n, width: 480, height: 240 }));
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();

    // Exactly ONE activation fit, over the complete 66-node set.
    expect(mockFitView).toHaveBeenCalledTimes(1);
    expect(mockFitView).toHaveBeenCalledWith({ padding: 0.2, duration: 200 });
  });

  it('AC-13 round-5: bounded completion fit — re-frames ONCE when the node set grows during the same activation (never per-delivery)', async () => {
    // The activation fit fires on the first fully-measured batch. A material
    // node-set growth DURING the same activation (e.g. a second restored
    // batch, or measured live arrivals) triggers exactly ONE completion fit —
    // bounded by completionFitEpochRef, never on every streaming delivery.
    mockNodes = [makeAgentNode('agent-1', 0, { width: 480, height: 240 })];
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);
    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(1);

    // Second batch arrives AND is measured → one completion fit re-frames the
    // grown set.
    await act(async () => {
      mockNodes = [
        makeAgentNode('agent-1', 0, { width: 480, height: 240 }),
        makeAgentNode('agent-2', 260, { width: 480, height: 240 }),
        makeAgentNode('agent-3', 520, { width: 480, height: 240 }),
      ];
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(2);

    // A third batch must NOT refit again — the completion fit is bounded to
    // exactly one per activation (no refit jitter on streaming arrivals).
    await act(async () => {
      mockNodes = [
        makeAgentNode('agent-1', 0, { width: 480, height: 240 }),
        makeAgentNode('agent-2', 260, { width: 480, height: 240 }),
        makeAgentNode('agent-3', 520, { width: 480, height: 240 }),
        makeAgentNode('agent-4', 780, { width: 480, height: 240 }),
      ];
    });
    rerender(<MissionMonitorPanel />);
    await flushFit();
    expect(mockFitView).toHaveBeenCalledTimes(2);
  });
});
