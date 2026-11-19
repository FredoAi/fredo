/**
 * #3151 ST-6 (AC3 / R-3.5, Q-21) — Mission Monitor selects a session by POINTER.
 *
 * The navigation engine is gone: no command rail, no activity trail, no place
 * cursor and no `s`/`n`/`p` strokes remain. The panel's primary controls are
 * still reachable by pointer: the session drawer's `.mm-session-row` rows select
 * a session, and a canvas double-click opens `detail-panel`.
 *
 * No `shared/navigation` import may appear in this file (AC1's literal
 * predicate).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { MissionMonitorSession } from '../lib/graph';

const sessionsState = vi.hoisted(() => ({
  sessions: [] as MissionMonitorSession[],
  selectedSessionId: null as string | null,
  selectSession: vi.fn(),
}));

// The declared-table session list is the panel's list source; mock the hook so
// the drawer renders a deterministic two-session list.
vi.mock('../hooks/useSessionHistory', () => ({
  useDeliverySessions: () => ({
    sessions: sessionsState.sessions,
    filteredSessions: sessionsState.sessions,
    selectedSessionId: sessionsState.selectedSessionId,
    selectSession: sessionsState.selectSession,
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    searchFilter: '',
    setSearchFilter: vi.fn(),
    settled: true,
    error: null,
  }),
}));

// The per-session activity watch feeds the canvas + token bar.
vi.mock('../hooks/useSessionActivityWatch', () => ({
  useSessionActivityWatch: () => ({
    chatRows: new Map(),
    toolUseRows: new Map(),
    epoch: 1,
    error: null,
    ready: true,
  }),
}));

const reactflowState = vi.hoisted(() => ({
  onNodeDoubleClick: undefined as ((e: unknown, node: unknown) => void) | undefined,
}));

// Mock reactflow — capture the node double-click seam that opens the detail panel.
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({
    children,
    onNodeDoubleClick,
  }: {
    children?: React.ReactNode;
    onNodeDoubleClick?: (e: unknown, node: unknown) => void;
  }) => {
    reactflowState.onNodeDoubleClick = onNodeDoubleClick;
    return <div data-testid="reactflow">{children}</div>;
  },
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: () => <div data-testid="minimap" />,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="reactflow-provider">{children}</div>
  ),
  useReactFlow: () => ({ fitView: vi.fn(() => true), setCenter: vi.fn(), getZoom: vi.fn(() => 1) }),
}));

// The graph builder is not the subject here — an empty graph is enough.
vi.mock('../hooks/useMissionMonitor', () => ({
  useDeliveryGraph: () => ({
    nodes: [],
    edges: [],
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    layoutVersion: 0,
    eventCount: 0,
  }),
}));

vi.mock('@/shared/contexts/StreamContext', () => ({
  useStream: () => ({ deliveries: [], health: 'healthy', isConnected: true, clearEvents: vi.fn() }),
}));

vi.mock('@/shared/window-system/useWindowActions', () => ({
  useWindowActions: () => ({
    openWindow: vi.fn(),
    closeWindow: vi.fn(),
    focusWindow: vi.fn(),
    updateWindow: vi.fn(),
  }),
}));

import { MissionMonitorPanel } from '../components/MissionMonitorPanel';
function monitorSession(sessionId: string, label: string): MissionMonitorSession {
  return {
    sessionId,
    label,
    startTime: 1,
    latestTimestamp: '2026-01-01T00:00:00.000Z',
    deliveryCount: 1,
    customName: label,
  } as unknown as MissionMonitorSession;
}

beforeEach(() => {
  reactflowState.onNodeDoubleClick = undefined;
  sessionsState.sessions = [monitorSession('s1', 'First session'), monitorSession('s2', 'Second session')];
  sessionsState.selectedSessionId = 's1';
  sessionsState.selectSession.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('#3151 R-3.5 — Mission Monitor primary control, pointer only', () => {
  it('selects a session from the drawer row and opens the detail panel by double-click', async () => {
    renderWithChakra(<MissionMonitorPanel />);

    // ── select: the drawer lists the sessions as pointer rows ───────────────
    const rows = document.querySelectorAll<HTMLElement>('.mm-session-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].getAttribute('aria-label')).toBe('Second session');

    fireEvent.click(rows[1]);
    expect(sessionsState.selectSession).toHaveBeenCalledWith('s2');

    // ── detail: a canvas double-click opens the detail panel ────────────────
    expect(screen.queryByTestId('detail-panel')).toBeNull();
    act(() => {
      reactflowState.onNodeDoubleClick?.({}, {
        id: 'agent-corr-1',
        type: 'agentNode',
        position: { x: 0, y: 0 },
        data: {
          eventType: 'agent',
          status: 'inactive',
          payload: {
            correlationId: 'corr-1',
            sessionId: 's1',
            userMessage: 'Hello',
            agentReply: 'Sure, here is the plan.',
            promptTokens: 10,
            completionTokens: 5,
          },
          timestamp: '2026-01-01T00:00:00.000Z',
          label: 'Chat',
          threadId: 'main',
          relatedEvents: [],
        },
      });
    });
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });
});
