/**
 * Component tests for ChatNode — Spec #2717 (R-2) five-way token row.
 *
 * Verifies that the collapsed single `⬡ in / out / total` line is replaced by
 * five labeled figures (Input / Cache / Reasoning / Output / Total) with:
 * - R-3.1: Total = Input + Cache + Reasoning + Output exactly (cacheWrite
 *   carried but never displayed/summed);
 * - R-3.3: zero AND absent categories render as label + `0` — never NaN,
 *   negative, or a mislabeled figure;
 * - R-3.4: figures ≥ 1,000 use en-US comma formatting (formatTokenCount).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData } from '../../../types';
import { ChatNode } from '../ChatNode';
import styles from '../MonitorNode.module.css';

// ChatNode renders ReactFlow Handles — stub them so the token row can be
// asserted in isolation (no ReactFlow provider needed).
vi.mock('reactflow', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));

// The vitest config does not enable `globals`, so RTL's auto-cleanup hook
// never runs — without an explicit cleanup the rendered nodes accumulate in
// document.body across cases and text queries find duplicates.
afterEach(() => cleanup());

function makeMonitorNodeData(overrides: Record<string, unknown> = {}): MonitorNodeData {
  return {
    eventType: 'agent',
    status: 'inactive',
    payload: {
      userMessage: '',
      agentReply: '',
      agentThinking: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
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

function makeNodeProps(data: MonitorNodeData): NodeProps<MonitorNodeData> {
  return {
    id: 'agent-corr-1',
    data,
    selected: false,
    type: 'agentNode',
    isConnectable: true,
    zIndex: 1,
    xPos: 0,
    yPos: 0,
    dragging: false,
    targetPosition: 'top' as const,
    sourcePosition: 'bottom' as const,
    width: 300,
    height: 200,
  };
}

describe('ChatNode five-way token row (#2717 R-2)', () => {
  it('renders five labeled figures — Input / Cache / Reasoning / Output / Total — with comma formatting', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 1840,
      completionTokens: 780,
      reasoningTokens: 500,
      cacheReadTokens: 1200,
      cacheWriteTokens: 999,
    }))} />);

    expect(screen.getByText('Input')).toBeDefined();
    expect(screen.getByText('Cache')).toBeDefined();
    expect(screen.getByText('Reasoning')).toBeDefined();
    expect(screen.getByText('Output')).toBeDefined();
    expect(screen.getByText('Total')).toBeDefined();

    // R-3.4: ≥ 1,000 → en-US comma formatting.
    expect(screen.getByText('1,840')).toBeDefined();
    expect(screen.getByText('1,200')).toBeDefined();
    expect(screen.getByText('500')).toBeDefined();
    expect(screen.getByText('780')).toBeDefined();
    // R-3.1: Total = 1,840 + 1,200 + 500 + 780 = 4,320.
    expect(screen.getByText('4,320')).toBeDefined();
    // G-023: cacheWrite carried but never displayed.
    expect(screen.queryByText('999')).toBeNull();
  });

  it('renders zero for absent cache/reasoning categories (R-3.3) — never NaN or "—"', () => {
    const { container } = render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 100,
      completionTokens: 50,
      // reasoningTokens / cacheReadTokens absent from the payload.
    }))} />);

    expect(screen.getByText('Cache')).toBeDefined();
    expect(screen.getByText('Reasoning')).toBeDefined();
    // Both zero categories render the literal digit 0 (no '—' state).
    const zeroCells = screen.getAllByText('0');
    expect(zeroCells.length).toBeGreaterThanOrEqual(2);
    // Total = 100 + 0 + 0 + 50 = 150.
    expect(screen.getByText('150')).toBeDefined();
    expect(screen.queryByText('NaN')).toBeNull();
    // R-3.3: the token bottom bar renders label + 0 — never a '—' placeholder
    // (the node's empty-content '—' placeholders live outside the bottom bar).
    const bottomBar = container.querySelector(`.${styles.bottomBar}`);
    expect(bottomBar).not.toBeNull();
    expect(bottomBar!.textContent).not.toContain('—');
  });

  it('guards negative or non-numeric figures to 0 (R-3.3) — never a negative cell', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: -5,
      completionTokens: 50,
      reasoningTokens: Number.NaN,
      cacheReadTokens: 200,
    }))} />);

    // promptTokens -5 and NaN reasoning both normalize to 0.
    expect(screen.getByText('200')).toBeDefined();
    expect(screen.getByText('50')).toBeDefined();
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('-5')).toBeNull();
    expect(screen.queryByText('NaN')).toBeNull();
    // Total = 0 + 200 + 0 + 50 = 250.
    expect(screen.getByText('250')).toBeDefined();
  });
});
