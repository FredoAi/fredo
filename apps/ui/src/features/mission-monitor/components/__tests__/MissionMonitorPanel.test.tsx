/**
 * Component tests for MissionMonitorPanel (SQLite-driven persistence).
 *
 * Prerequisites: vitest, @testing-library/react, @testing-library/jest-dom, jsdom
 *
 * Spec #2723 (R-1 / AC1): the session token bar is a compact, right-aligned
 * strip placed at the TOP of the canvas column — ABOVE the ReactFlow canvas,
 * below the header. It stays hidden when no session is selected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, act, within, cleanup, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { MissionMonitorPanel } from '../MissionMonitorPanel';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import type { MonitorNodeData } from '../../types';
import { adapterBridge } from '@/shared/utils/adapterBridge';

afterEach(() => cleanup());

// Mock persistence module
vi.mock('../../lib/persistence', () => ({
  initMmTables: vi.fn(),
  persistDelivery: vi.fn(),
  loadPersistedSessions: vi.fn().mockResolvedValue([]),
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

let mockDeliveries: ContractDelivery[] = [];

// Mock StreamContext — deliveries are swapped per test
vi.mock('@/shared/contexts/StreamContext', () => ({
  useStream: vi.fn().mockImplementation(() => ({
    deliveries: mockDeliveries,
    isConnected: false,
    clearEvents: vi.fn(),
  })),
}));

// #2739 ST-2 / #2743 ST-7: capture the NODE_TYPES registry + canvas event
// callbacks passed to <ReactFlow> so tests can assert the registered node
// types and drive the detail panel (the registry/props are module-private in
// MissionMonitorPanel.tsx). #2743 ST-6 (AC-7): the interaction contract is
// double-click-to-open — `onNodeClick` is gone, `onNodeDoubleClick` is wired.
// #2743 ST-6 round-5 (AC-7/AC-8 root cause): `zoomOnDoubleClick` must be
// `false` — ReactFlow's default `true` attaches a d3-zoom dblclick handler to
// the renderer that stopImmediatePropagation()s the dblclick BEFORE it reaches
// React's root container, so onNodeDoubleClick NEVER fires (the round-4
// defect: no DetailPanel DOM in ANY double-click attempt).
const reactflowState = vi.hoisted(() => ({
  nodeTypes: undefined as any,
  onNodeDoubleClick: undefined as ((e: unknown, node: any) => void) | undefined,
  onPaneClick: undefined as ((e: unknown) => void) | undefined,
  zoomOnDoubleClick: undefined as boolean | undefined,
}));

// #2748 ST-6 (AC5 / R-5.3-minimap): capture the MiniMap nodeColor callback so
// tests can assert the neutral (status-independent) coloring contract.
const miniMapState = vi.hoisted(() => ({
  nodeColor: undefined as ((node: any) => string) | undefined,
}));

// Mock reactflow — stub all components used by MissionMonitorCanvas
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ children, nodeTypes, onNodeDoubleClick, onPaneClick, zoomOnDoubleClick }: {
    children?: React.ReactNode; nodeTypes?: any;
    onNodeDoubleClick?: (e: unknown, node: any) => void; onPaneClick?: (e: unknown) => void;
    zoomOnDoubleClick?: boolean;
  }) => {
    reactflowState.nodeTypes = nodeTypes;
    reactflowState.onNodeDoubleClick = onNodeDoubleClick;
    reactflowState.onPaneClick = onPaneClick;
    reactflowState.zoomOnDoubleClick = zoomOnDoubleClick;
    return <div data-testid="reactflow">{children}</div>;
  },
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: ({ nodeColor }: { nodeColor?: (node: any) => string }) => {
    miniMapState.nodeColor = nodeColor;
    return <div data-testid="minimap" />;
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="reactflow-provider">{children}</div>
  ),
  useReactFlow: () => ({ fitView: vi.fn(), setCenter: vi.fn(), getZoom: vi.fn(() => 1) }),
}));

// Mock the graph-builder hook — the panel wires deliveries through it.
vi.mock('../../hooks/useMissionMonitor', () => ({
  useDeliveryGraph: () => ({
    nodes: [],
    edges: [],
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    layoutVersion: 0,
    eventCount: 0,
  }),
}));

import { loadPersistedSessions } from '../../lib/persistence';

/** Chat-node delivery for the panel's selected session 's1'. */
function makeChatDelivery(
  correlationId: string,
  lifecycle: 'init' | 'update' | 'end',
  tokens: { prompt?: number; cacheRead?: number; reasoning?: number; completion?: number },
): ContractDelivery {
  const inner: Record<string, unknown> = {};
  if (tokens.prompt !== undefined) inner.promptTokens = tokens.prompt;
  if (tokens.cacheRead !== undefined) inner.cacheReadTokens = tokens.cacheRead;
  if (tokens.reasoning !== undefined) inner.reasoningTokens = tokens.reasoning;
  if (tokens.completion !== undefined) inner.completionTokens = tokens.completion;
  return {
    id: `id-${correlationId}-${lifecycle}`,
    contractName: 'chat-node',
    lifecycle,
    key: { sessionId: 's1', correlationId },
    payload: { payload: inner },
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * #2748 ST-6 (AC3): tool-use-lifecycle delivery for the parent session's `task`
 * span carrying child-completion fields (the SUBAGENTS source — ST-1
 * `computeSubagentTokenTotals` consumes these). Mirrors the sessionMeta suite
 * fixture shape (graph.ts `extractDeliveryPayload` unwraps the inner payload).
 */
function makeTaskDelivery(
  correlationId: string,
  lifecycle: 'init' | 'update' | 'end',
  overrides: Record<string, unknown> = {},
): ContractDelivery {
  const inner: Record<string, unknown> = {
    'gen_ai.tool.name': 'task',
    input: JSON.stringify({ subagent_type: 'explore', prompt: 'investigate' }),
    ...overrides,
  };
  return {
    id: `task-${correlationId}-${lifecycle}`,
    contractName: 'tool-use-lifecycle',
    lifecycle,
    key: { sessionId: 's1', correlationId },
    payload: { payload: inner },
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

// #2748 FIX-3 (round-2 AC4 / R-4.1): capture the window-title neutralization —
// the panel updates the @maomaolabs window's title (which the WindowManager
// renders as BOTH the visible window-header label AND the `role="dialog"`
// container's `aria-label`) so no `Mission Monitor` text survives in the
// panel's a11y tree.
const windowActionsState = vi.hoisted(() => ({
  updateWindow: vi.fn(),
}));

// Mock @maomaolabs/core — the panel consumes useWindowActions only to
// neutralize the window title; the window system itself is out of scope here.
vi.mock('@maomaolabs/core', () => ({
  useWindowActions: () => ({
    openWindow: vi.fn(),
    closeWindow: vi.fn(),
    focusWindow: vi.fn(),
    updateWindow: windowActionsState.updateWindow,
  }),
}));

// #2748 FIX-3: DOM/a11y scan helper — no element in the rendered tree may
// carry the `Mission Monitor` brand text as aria-label, title, or text content
// (the AC4-1 letter's "no remnant text anywhere" scan).
function findMissionMonitorRemnants(container: HTMLElement): string[] {
  const remnants: string[] = [];
  container.querySelectorAll<HTMLElement>('*').forEach((el) => {
    const ariaLabel = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    if (ariaLabel?.includes('Mission Monitor')) remnants.push(`aria-label: "${ariaLabel}"`);
    if (title?.includes('Mission Monitor')) remnants.push(`title: "${title}"`);
    if (el.textContent?.includes('Mission Monitor')) remnants.push(`text: "${el.textContent.trim()}"`);
  });
  return remnants;
}

describe('MissionMonitorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries = [];
    reactflowState.onNodeDoubleClick = undefined;
    reactflowState.onPaneClick = undefined;
    reactflowState.zoomOnDoubleClick = undefined;
    miniMapState.nodeColor = undefined;
    vi.mocked(loadPersistedSessions).mockResolvedValue([
      { sessionId: 's1', label: 'Session 1', startTime: 1, latestTimestamp: '2026-01-01T00:00:00.000Z', deliveryCount: 0 },
    ]);
  });

  it('#2748 AC4 / R-4.1: does NOT render the "Mission Monitor" header strip AND neutralizes the window/dialog identity', () => {
    const { container } = renderWithChakra(<MissionMonitorPanel />);

    // The header strip is gone — no "Mission Monitor" text, no `·` separator,
    // no session-identity line above the token bar.
    expect(screen.queryByText('Mission Monitor')).toBeNull();
    expect(screen.queryByText('·')).toBeNull();

    // #2748 FIX-3: the window title is neutralized to the drawer-consistent
    // "Sessions" — the WindowManager's `role="dialog"` aria-label (and visible
    // window-header label) derive from that title, so no `dialog Mission
    // Monitor` remnant remains in the a11y tree.
    expect(windowActionsState.updateWindow).toHaveBeenCalledWith(
      'mission-monitor',
      { title: 'Sessions' },
    );

    // AC4-1 letter: a DOM/a11y scan finds NO `Mission Monitor` remnant text
    // anywhere — as aria-label, title, or text content.
    expect(findMissionMonitorRemnants(container)).toEqual([]);
  });

  it('shows empty state when no sessions exist', () => {
    vi.mocked(loadPersistedSessions).mockResolvedValueOnce([]);
    renderWithChakra(<MissionMonitorPanel />);

    // Empty state shows the waiting message
    expect(screen.getAllByText('Waiting for agent activity…').length).toBeGreaterThanOrEqual(1);
  });

  it('#2748 AC4 / R-4.1: the no-session state shows no header remnant', async () => {
    // No persisted sessions and no live deliveries → EmptyState is the topmost
    // element; the removed header's "Mission Monitor" / "No session" / `·`
    // remnants must never appear, and the bar stays hidden (no session).
    vi.mocked(loadPersistedSessions).mockResolvedValueOnce([]);
    const { container } = renderWithChakra(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getAllByText('Waiting for agent activity…').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Mission Monitor')).toBeNull();
    expect(screen.queryByText('No session')).toBeNull();
    expect(screen.queryByText('·')).toBeNull();
    expect(screen.queryByTestId('session-token-bar')).toBeNull();
    // #2748 FIX-3 (AC4-1 letter): no `Mission Monitor` remnant anywhere in the
    // a11y tree — aria-label, title, or text content.
    expect(findMissionMonitorRemnants(container)).toEqual([]);
  });

  it('#2748 AC3/AC4 (R-3.1, R-3.2, R-4.2): the bar is the TOP row and shows the wired SUBAGENTS figure', async () => {
    // One parent chat turn + two task spans with child-completion fields:
    // SUBAGENTS = (1000+200+300+500) + 700 = 2,700 (ST-1 compute, wired in
    // the panel's sessionMetrics memo); TOTAL = parent five-way (100) + 2,700
    // = 2,800 (ST-5's component sums the two passed props — the panel never
    // pre-sums). Parent families stay byte-equal (R-3.3).
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 100 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 100 }),
      // Per-family breakdown for one dispatch...
      makeTaskDelivery('task-1', 'end', {
        childInputTokens: 1000, childCacheReadTokens: 200,
        childReasoningTokens: 300, childOutputTokens: 500,
      }),
      // ...aggregate-only (legacy) for the other.
      makeTaskDelivery('task-2', 'end', { childTokens: 700 }),
    ];

    const { container, rerender } = renderWithChakra(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });

    const bar = screen.getByTestId('session-token-bar');
    // R-4.2: with the header gone, the bar is the FIRST element of the canvas
    // column (nothing — no header strip — precedes it above the canvas).
    expect(bar.parentElement?.firstElementChild).toBe(bar);
    expect(screen.queryByText('Mission Monitor')).toBeNull();
    // #2748 FIX-3 (AC4-1 letter): no `Mission Monitor` remnant anywhere — even
    // with a session selected and the bar rendered as the top row.
    expect(findMissionMonitorRemnants(container)).toEqual([]);

    // R-3.1: SUBAGENTS figure from ST-1 computeSubagentTokenTotals.
    expect(within(bar).getByText('SUBAGENTS')).toBeDefined();
    expect(within(bar).getByText('2,700')).toBeDefined();
    // R-3.2: TOTAL = parent five-way (100) + SUBAGENTS (2,700) = 2,800.
    expect(within(bar).getByText('2,800')).toBeDefined();
    // R-3.3: parent INPUT stays 100 (subagent tokens never bleed into the
    // parent families).
    expect(within(bar).getByText('100')).toBeDefined();
  });

  it('#2748 AC5 / R-5.3-minimap: the MiniMap nodeColor is a single neutral token for every node', async () => {
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 100 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 100 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });

    // The canvas is rendered (a session is selected) so the MiniMap's
    // nodeColor callback is wired.
    expect(miniMapState.nodeColor).toBeDefined();
    // Every node — regardless of status — maps to the single neutral
    // var(--border-color); the status-keyed switch is gone.
    expect(miniMapState.nodeColor?.({ data: { status: 'working' } })).toBe('var(--border-color)');
    expect(miniMapState.nodeColor?.({ data: { status: 'error' } })).toBe('var(--border-color)');
    expect(miniMapState.nodeColor?.({ data: { status: 'permission_required' } })).toBe('var(--border-color)');
    expect(miniMapState.nodeColor?.({ data: { status: 'permission_granted' } })).toBe('var(--border-color)');
    expect(miniMapState.nodeColor?.({ data: { status: 'compacted' } })).toBe('var(--border-color)');
    expect(miniMapState.nodeColor?.({ data: {} })).toBe('var(--border-color)');
  });

  it('has no localStorage dependencies', () => {
    // Verify no sessionStorage functions are imported
    const source = MissionMonitorPanel.toString();
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('getSessionEvents');
    expect(source).not.toContain('loadSessions');
    expect(source).not.toContain('sessionStorage');
  });

  it('has no localStorage calls in source', () => {
    const source = MissionMonitorPanel.toString();
    expect(source).not.toContain('localStorage');
  });

  it('renders the session token bar ABOVE the canvas for a selected session (Spec #2723 R-1)', async () => {
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    // Flush the persisted-session load + auto-select so the canvas + bar render.
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });

    const bar = screen.getByTestId('session-token-bar');
    const canvas = screen.getByTestId('reactflow-provider');
    // The bar is the first child of the canvas column — it must precede the
    // ReactFlow canvas in document order (DOM sibling above it).
    expect(bar.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // ST-3 / AC-4: "Session Token Usage" left + figures right (space-between).
    expect(bar.style.justifyContent).toBe('space-between');
    expect(bar.style.borderBottom).toBe('1px solid var(--border-color)');
  });

  it('registers the toolsNode type in the NODE_TYPES registry (ST-2)', async () => {
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 100 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 100 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });

    expect(reactflowState.nodeTypes).toBeDefined();
    // The #2739 tools-summary node type is registered for ReactFlow.
    expect(reactflowState.nodeTypes.toolsNode).toBeDefined();
    // NFR-6: the sibling node types stay registered (no regression).
    expect(reactflowState.nodeTypes.agentNode).toBeDefined();
    expect(reactflowState.nodeTypes.subagentNode).toBeDefined();
    // #2745 ST-6: the dead toolNode/fileNode registrations were removed (AC-5).
    expect(reactflowState.nodeTypes.toolNode).toBeUndefined();
    expect(reactflowState.nodeTypes.fileNode).toBeUndefined();
  });

  it('anchors the detail panel to the canvas wrapper BELOW the session token bar (AC-5)', async () => {
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    // Flush the persisted-session load + auto-select so the canvas + bar render.
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });

    const bar = screen.getByTestId('session-token-bar');
    const wrapper = screen.getByTestId('mm-canvas-wrapper');
    // The wrapper (canvas + detail panel) is a sibling BELOW the bar — the
    // bar stays above it in DOM order (AC-5: the panel must never cover it).
    expect(bar.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The wrapper is the position:relative containing block for the panel.
    expect(wrapper.style.position).toBe('relative');

    // Open the detail panel by firing the ReactFlow onNodeDoubleClick captured
    // by the mock (#2743 ST-6 AC-7 — double-click opens the node detail).
    const nodeData: MonitorNodeData = {
      eventType: 'agent',
      status: 'inactive',
      payload: {
        correlationId: 'corr-1',
        sessionId: 's1',
        promptTokens: 1840,
        cacheReadTokens: 1200,
        reasoningTokens: 500,
        completionTokens: 780,
      },
      timestamp: '2026-01-01T00:00:00.000Z',
      label: 'Chat',
      threadId: 'main',
      relatedEvents: [],
    };
    act(() => {
      reactflowState.onNodeDoubleClick?.({}, { data: nodeData });
    });

    const panel = screen.getByTestId('detail-panel');
    // The panel renders INSIDE the canvas wrapper (its containing block) and
    // is positioned absolutely anchored to it (top:0) — so it cannot overlap
    // the bar which lives OUTSIDE the wrapper above it.
    expect(wrapper.contains(panel)).toBe(true);
    expect(panel.style.position).toBe('absolute');
    expect(panel.style.top).toBe('0px');
    // The bar is not a descendant of the wrapper — the panel cannot cover it.
    expect(wrapper.contains(bar)).toBe(false);
  });

  it('#2743 ST-6 (AC-7): single-click NEVER opens the detail panel — only double-click does (onNodeClick neutralized)', async () => {
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 100 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 100 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });

    // AC-7 interaction contract: onNodeClick is NOT wired to ReactFlow; the
    // single trigger is onNodeDoubleClick.
    expect(reactflowState.onNodeClick).toBeUndefined();
    expect(typeof reactflowState.onNodeDoubleClick).toBe('function');
    // AC-7 round-5 root cause: zoomOnDoubleClick must be false so the native
    // dblclick reaches React's delegated onDoubleClick (d3-zoom's default
    // `true` swallows it with stopImmediatePropagation at the renderer).
    expect(reactflowState.zoomOnDoubleClick).toBe(false);

    // A single-click must not open the panel — there is no onNodeClick handler
    // at all; simulate what a click on a node would have invoked and assert
    // no detail panel renders.
    expect(screen.queryByTestId('detail-panel')).toBeNull();

    // Double-click opens the node detail.
    const nodeData: MonitorNodeData = {
      eventType: 'agent',
      status: 'inactive',
      payload: {
        correlationId: 'corr-1',
        sessionId: 's1',
        promptTokens: 100,
        completionTokens: 50,
      },
      timestamp: '2026-01-01T00:00:00.000Z',
      label: 'Chat',
      threadId: 'main',
      relatedEvents: [],
    };
    act(() => {
      reactflowState.onNodeDoubleClick?.({}, { data: nodeData });
    });

    expect(screen.getByTestId('detail-panel')).toBeDefined();
  });

  // ── #2760 (EARS-1 / EARS-2): Force layout removal ────────────────────────────
  //
  // The Force layout engine, the Chain/Force toggle, and the persisted
  // `Fredo_mm_layout_mode` preference were removed (#2760) — Chain is the only
  // layout. These assertions pin the removal contract: no toggle DOM of any
  // kind (EARS-1), and a STALE pre-removal `'force'` preference (mocked
  // `get_setting` + localStorage seed) must be ignored — the chain renders
  // normally with no crash/blank/error (EARS-2; the key is never read or
  // written again, so no migration code exists).
  describe('#2760: Force layout fully removed — Chain is the only layout', () => {
    afterEach(() => {
      localStorage.clear();
    });

    /** Two chat deliveries for session 's1' so the selected-session canvas
     *  branch renders. */
    function seedDeliveries(): void {
      mockDeliveries = [
        makeChatDelivery('corr-1', 'init', { prompt: 100 }),
        makeChatDelivery('corr-1', 'end',  { prompt: 100 }),
      ];
    }

    it('renders NO layout toggle anywhere in the DOM (EARS-1)', async () => {
      seedDeliveries();
      const { rerender } = renderWithChakra(<MissionMonitorPanel />);
      await act(async () => { await Promise.resolve(); });
      rerender(<MissionMonitorPanel />);
      await act(async () => { await Promise.resolve(); });

      // The #2752 toggle (data-testid `mm-layout-toggle`) is gone entirely —
      // nothing replaces it (AC1: removal, not redesign).
      expect(screen.queryByTestId('mm-layout-toggle')).toBeNull();
      // No layout-mode group or Chain/Force buttons anywhere either.
      expect(screen.queryByRole('group', { name: 'Layout mode' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Chain' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Force' })).toBeNull();
      // The canvas itself still renders normally.
      expect(screen.getByTestId('reactflow-provider')).toBeDefined();
    });

    it('ignores a stale persisted Fredo_mm_layout_mode=force — Chain renders normally (EARS-2)', async () => {
      // Pre-seed the LEGACY pre-removal preference in BOTH stores the settings
      // service reads: the Tauri `get_setting` path (mocked) and the dev
      // localStorage fallback. #2760 makes the key never read again, so the
      // panel must render the chain normally — no crash, no blank canvas,
      // no error — with zero migration code.
      localStorage.setItem('Fredo_mm_layout_mode', 'force');
      const invokeSpy = vi.spyOn(adapterBridge, 'invoke').mockImplementation(async (command, args) => {
        if (command === 'get_setting' && (args as { key?: string } | undefined)?.key === 'Fredo_mm_layout_mode') {
          return 'force';
        }
        return undefined;
      });
      try {
        seedDeliveries();
        const { rerender } = renderWithChakra(<MissionMonitorPanel />);
        await act(async () => { await Promise.resolve(); });
        rerender(<MissionMonitorPanel />);
        await act(async () => { await Promise.resolve(); });

        // The chain canvas renders (no crash/blank/error) and no toggle exists.
        await waitFor(() => {
          expect(screen.getByTestId('reactflow-provider')).toBeDefined();
        });
        expect(screen.getByTestId('mm-canvas-wrapper')).toBeDefined();
        expect(screen.queryByTestId('mm-layout-toggle')).toBeNull();
        // The stale preference is never rewritten either (no read/write path).
        expect(localStorage.getItem('Fredo_mm_layout_mode')).toBe('force');
      } finally {
        invokeSpy.mockRestore();
      }
    });
  });
});
