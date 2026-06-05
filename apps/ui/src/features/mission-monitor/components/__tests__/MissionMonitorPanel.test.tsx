/**
 * PREREQUISITE:
 * This test file uses vitest + @testing-library/react.
 * Install with: pnpm --filter @fredo/ui add -D vitest @testing-library/react @testing-library/jest-dom
 *
 * Component tests for MissionMonitorPanel.
 *
 * REQ-COMP-2: MissionMonitorPanel renders header and WaitingState when no
 * session is active. REQ-COMP-3: Component does not crash with ReactFlowProvider
 * context under mocked reactflow.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { MissionMonitorPanel } from '../MissionMonitorPanel';

// Mock StreamContext — empty events, not connected
vi.mock('@/shared/contexts/StreamContext', () => ({
  useStream: vi.fn().mockReturnValue({
    events: [],
    isConnected: false,
    clearEvents: vi.fn(),
  }),
}));

// Mock useSessionHistory — empty sessions list so WaitingState is shown
vi.mock('../hooks/useSessionHistory', () => ({
  useSessionHistory: vi.fn().mockReturnValue({
    sessions: [],
    refreshSessions: vi.fn(),
    deleteSession: vi.fn(),
    finalizeSession: vi.fn(),
  }),
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
  useReactFlow: () => ({ fitView: vi.fn() }),
}));

describe('MissionMonitorPanel', () => {
  it('renders header with "Mission Monitor" text', async () => {
    renderWithChakra(<MissionMonitorPanel />);

    // Header text is always rendered
    expect(screen.getByText('Mission Monitor')).toBeInTheDocument();
  });

  it('displays WaitingState when no session is selected', async () => {
    renderWithChakra(<MissionMonitorPanel />);

    // WaitingState shows spinner and "Waiting for events…" text
    await waitFor(() => {
      expect(screen.getByText('Waiting for events…')).toBeInTheDocument();
    });
  });
});
