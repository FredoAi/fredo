/**
 * Component tests for MissionMonitorPanel auto-focus (#2688 ST5 / AC3).
 *
 * Verifies that the canvas pans to center the newest CHAT (agent) node, that
 * the first node of a session does NOT trigger setCenter (initial-load uses
 * fitView), and that non-chat nodes never trigger setCenter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { Node } from 'reactflow';
import type { MonitorNodeData } from '../../types';

// ── Controlled mocks ──────────────────────────────────────────────────────────

let mockNodes: Node<MonitorNodeData>[] = [];
const mockSetCenter = vi.fn();
const mockFitView = vi.fn();

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
  useReactFlow: () => ({ fitView: mockFitView, setCenter: mockSetCenter }),
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

function makeAgentNode(id: string, y: number): Node<MonitorNodeData> {
  return {
    id,
    type: 'agentNode',
    position: { x: 0, y },
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

describe('MissionMonitorPanel auto-focus (#2688 ST5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNodes = [];
  });

  /** Establishes the selected session with zero nodes before any node batch. */
  async function establishSession(rerender: (ui: React.ReactElement) => void) {
    // Flush the persisted-session load so the session auto-selects with no
    // nodes yet — the canvas mounts and resets its seen set on session change.
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
  }

  it('does not setCenter for the first chat node of a session (initial load uses fitView)', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    // Push the first agent node after the session is selected.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);

    // setCenter is NOT called for the first node.
    expect(mockSetCenter).not.toHaveBeenCalled();
  });

  it('pans to center a new chat node when the session already had nodes', async () => {
    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0)];
    });
    rerender(<MissionMonitorPanel />);
    expect(mockSetCenter).not.toHaveBeenCalled();

    // Second chat node arrives → session already had nodes → setCenter.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0), makeAgentNode('agent-2', -260)];
    });
    rerender(<MissionMonitorPanel />);

    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    const [x, y] = mockSetCenter.mock.calls[0];
    expect(x).toBe(0 + 100);
    expect(y).toBe(-260 + 150);
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

    // A tool node arrives — tracked but never triggers setCenter.
    await act(async () => {
      mockNodes = [makeAgentNode('agent-1', 0), makeToolNode('tool-1')];
    });
    rerender(<MissionMonitorPanel />);

    expect(mockSetCenter).not.toHaveBeenCalled();
  });
});
