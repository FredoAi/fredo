/**
 * Component tests for MissionMonitorPanel (SQLite-driven persistence).
 *
 * Prerequisites: vitest, @testing-library/react, @testing-library/jest-dom, jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { MissionMonitorPanel } from '../MissionMonitorPanel';

// Mock persistence module
vi.mock('../../lib/persistence', () => ({
  initMmTables: vi.fn(),
  persistDelivery: vi.fn(),
  loadPersistedSessions: vi.fn().mockResolvedValue([]),
  deleteSessionFromStore: vi.fn(),
  loadPersistedDeliveries: vi.fn(),
}));

// Mock StreamContext — empty deliveries
vi.mock('@/shared/contexts/StreamContext', () => ({
  useStream: vi.fn().mockReturnValue({
    deliveries: [],
    isConnected: false,
    clearEvents: vi.fn(),
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
  it('renders header with "Mission Monitor" text', () => {
    renderWithChakra(<MissionMonitorPanel />);

    expect(screen.getAllByText('Mission Monitor').length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state when no sessions exist', () => {
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
});
