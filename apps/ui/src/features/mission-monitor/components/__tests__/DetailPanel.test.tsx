/**
 * Component tests for DetailPanel — #2688 AC4 rows.
 *
 * Verifies the INPUT / OUTPUT / THOUGHTS / MODEL rows render for agent nodes
 * and that absent sections are hidden (not rendered empty).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DetailPanel } from '../DetailPanel';
import type { MonitorNodeData } from '../../types';

afterEach(() => cleanup());

function makeAgentData(overrides: Partial<MonitorNodeData['payload']> = {}): MonitorNodeData {
  return {
    eventType: 'agent',
    status: 'inactive',
    payload: {
      userMessage: 'Hello, can you help me?',
      agentReply: 'Sure, here is the plan.',
      agentThinking: 'Let me reason about this...',
      model: 'claude-sonnet-4',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      correlationId: 'corr-1',
      sessionId: 's1',
      ...overrides,
    },
    timestamp: '2026-01-01T00:00:00.000Z',
    label: 'Chat',
    threadId: 'main',
    relatedEvents: [],
  };
}

describe('DetailPanel agent rows (#2688 AC4)', () => {
  it('renders INPUT, OUTPUT, THOUGHTS and MODEL rows when present', () => {
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    expect(screen.getAllByText('Hello, can you help me?').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Sure, here is the plan.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Let me reason about this...').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('claude-sonnet-4').length).toBeGreaterThanOrEqual(1);
  });

  it('hides THOUGHTS row when agentThinking is absent', () => {
    renderWithChakra(
      <DetailPanel
        data={makeAgentData({ agentThinking: '', model: undefined })}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('Let me reason about this...')).toBeNull();
    expect(screen.queryByText('claude-sonnet-4')).toBeNull();
    // Input/output still render.
    expect(screen.getAllByText('Hello, can you help me?').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Sure, here is the plan.').length).toBeGreaterThanOrEqual(1);
  });

  it('renders token rows for agent nodes', () => {
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    // 100 prompt + 50 completion = 150 total.
    expect(screen.getAllByText('100').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('50').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('150').length).toBeGreaterThanOrEqual(1);
  });
});
