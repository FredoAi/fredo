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
import { screen, act, cleanup } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { MissionMonitorPanel } from '../MissionMonitorPanel';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

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

// Mock reactflow — stub all components used by MissionMonitorCanvas
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="reactflow">{children}</div>
  ),
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: () => <div data-testid="minimap" />,
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

describe('MissionMonitorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries = [];
    vi.mocked(loadPersistedSessions).mockResolvedValue([
      { sessionId: 's1', label: 'Session 1', startTime: 1, latestTimestamp: '2026-01-01T00:00:00.000Z', deliveryCount: 0 },
    ]);
  });

  it('renders header with "Mission Monitor" text', () => {
    renderWithChakra(<MissionMonitorPanel />);

    expect(screen.getAllByText('Mission Monitor').length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state when no sessions exist', () => {
    vi.mocked(loadPersistedSessions).mockResolvedValueOnce([]);
    renderWithChakra(<MissionMonitorPanel />);

    // Empty state shows the waiting message
    expect(screen.getAllByText('Waiting for agent activity…').length).toBeGreaterThanOrEqual(1);
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
    // Right-aligned compact strip.
    expect(bar.style.justifyContent).toBe('flex-end');
    expect(bar.style.borderBottom).toBe('1px solid var(--border-color)');
  });
});
