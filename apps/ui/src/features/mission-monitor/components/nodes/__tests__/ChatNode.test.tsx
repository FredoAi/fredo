/**
 * Component tests for ChatNode — Spec #2723 (R-2 / AC2) compact single-line
 * token row.
 *
 * Verifies the five-way stacked cells (Spec #2717) are replaced by ONE compact
 * single-line, right-aligned row carrying the same five categories with:
 * - abbreviated labels `In:`/`Ca:`/`Re:`/`Ou:`/`Σ:` (full labels only in
 *   aria-labels — the full-label stacked format is gone);
 * - display-only k-format for values ≥ 1,000 (`1.2k`, `85k`), raw below;
 * - every figure's aria-label carries the FULL comma-formatted number
 *   (formatTokenCount) — never the abbreviated display (QA Q-2.1);
 * - R-3.1: Total = Input + Cache + Reasoning + Output exactly (cacheWrite
 *   carried but never displayed/summed);
 * - R-3.3: zero AND absent categories render as `0` — never NaN, negative, or
 *   a mislabeled figure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData } from '../../../types';
import { ChatNode } from '../ChatNode';
import { formatCompactTokenCount } from '../../../lib/graph';
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

describe('ChatNode compact single-line token row (#2723 R-2 / AC2)', () => {
  it('renders five abbreviated figures — In:/Ca:/Re:/Ou:/Σ: — with display-only k-format values', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 1840,
      completionTokens: 780,
      reasoningTokens: 500,
      cacheReadTokens: 1200,
      cacheWriteTokens: 999,
    }))} />);

    // Abbreviated labels per the UI/UX spec — the full-label five-way stacked
    // format is gone (R-2: "SHALL NOT render the five-way stacked format").
    expect(screen.getByText('In:')).toBeDefined();
    expect(screen.getByText('Ca:')).toBeDefined();
    expect(screen.getByText('Re:')).toBeDefined();
    expect(screen.getByText('Ou:')).toBeDefined();
    expect(screen.getByText('Σ:')).toBeDefined();
    expect(screen.queryByText('Input')).toBeNull();
    expect(screen.queryByText('Cache')).toBeNull();
    expect(screen.queryByText('Reasoning')).toBeNull();
    expect(screen.queryByText('Output')).toBeNull();
    expect(screen.queryByText('Total')).toBeNull();

    // Display-only k-format: ≥ 1,000 → `1.8k`-style (one decimal), < 1,000 raw.
    expect(screen.getByText('1.8k')).toBeDefined(); // 1840 → 1.84 → "1.8"
    expect(screen.getByText('1.2k')).toBeDefined(); // 1200
    expect(screen.getByText('500')).toBeDefined();  // < 1,000 raw
    expect(screen.getByText('780')).toBeDefined();  // < 1,000 raw
    // R-3.1: Total = 1,840 + 1,200 + 500 + 780 = 4,320 → 4.32 → "4.3k".
    expect(screen.getByText('4.3k')).toBeDefined();
    // G-023: cacheWrite carried but never displayed.
    expect(screen.queryByText('999')).toBeNull();
  });

  it('keeps all five figures in ONE single-line row — direct children of the bottomBar group', () => {
    const { container } = render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 1840,
      completionTokens: 780,
      reasoningTokens: 500,
      cacheReadTokens: 1200,
    }))} />);

    const bottomBar = container.querySelector(`.${styles.bottomBar}`);
    expect(bottomBar).not.toBeNull();
    // Screen-reader group carries the breakdown context (UI/UX a11y spec).
    expect(bottomBar!.getAttribute('role')).toBe('group');
    expect(bottomBar!.getAttribute('aria-label')).toBe('Node token breakdown');
    // Exactly five figure children — no nested row/cell wrappers (the stacked
    // format's `.counterRow`/`.counterCell` structure is gone).
    const figures = bottomBar!.querySelectorAll(`.${styles.compactFigure}`);
    expect(figures.length).toBe(5);
    // R-3.3: the bottom bar renders figures — never a '—' placeholder (the
    // node's empty-content '—' placeholders live outside the bottom bar).
    expect(bottomBar!.textContent).not.toContain('—');
  });

  it('annotates EVERY figure with the FULL comma-formatted number — aria-label never abbreviated', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 1840,
      completionTokens: 780,
      reasoningTokens: 500,
      cacheReadTokens: 1200,
    }))} />);

    expect(screen.getByLabelText('Input tokens: 1,840')).toBeDefined();
    expect(screen.getByLabelText('Cache tokens: 1,200')).toBeDefined();
    expect(screen.getByLabelText('Reasoning tokens: 500')).toBeDefined();
    expect(screen.getByLabelText('Output tokens: 780')).toBeDefined();
    expect(screen.getByLabelText('Total tokens: 4,320')).toBeDefined();

    // The aria-label figure wraps the compact display (label+value inline).
    expect(screen.getByLabelText('Input tokens: 1,840').textContent).toBe('In:1.8k');
    expect(screen.getByLabelText('Cache tokens: 1,200').textContent).toBe('Ca:1.2k');
    expect(screen.getByLabelText('Total tokens: 4,320').textContent).toBe('Σ:4.3k');
  });

  it('renders zero for absent cache/reasoning categories (R-3.3) — never NaN or "—"', () => {
    const { container } = render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 100,
      completionTokens: 50,
      // reasoningTokens / cacheReadTokens absent from the payload.
    }))} />);

    expect(screen.getByText('Ca:')).toBeDefined();
    expect(screen.getByText('Re:')).toBeDefined();
    // Both zero categories render the literal digit 0 (no '—' state).
    const zeroCells = screen.getAllByText('0');
    expect(zeroCells.length).toBeGreaterThanOrEqual(2);
    // Total = 100 + 0 + 0 + 50 = 150.
    expect(screen.getByText('150')).toBeDefined();
    expect(screen.queryByText('NaN')).toBeNull();
    // R-3.3: the token bottom bar renders figures — never a '—' placeholder
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

// ── formatCompactTokenCount (Spec #2723 R-2 display-only formatter) ────────────

describe('formatCompactTokenCount (Spec #2723 R-2)', () => {
  it('returns raw numbers for values < 1,000', () => {
    expect(formatCompactTokenCount(0)).toBe('0');
    expect(formatCompactTokenCount(340)).toBe('340');
    expect(formatCompactTokenCount(999)).toBe('999');
  });

  it('returns one-decimal k-format for 1,000–9,999 (trailing .0 dropped)', () => {
    expect(formatCompactTokenCount(1_000)).toBe('1k');   // 1.0 → "1"
    expect(formatCompactTokenCount(1_240)).toBe('1.2k');
    expect(formatCompactTokenCount(8_500)).toBe('8.5k');
  });

  it('returns whole k-format for values ≥ 10,000', () => {
    expect(formatCompactTokenCount(10_000)).toBe('10k');
    expect(formatCompactTokenCount(85_000)).toBe('85k');
    expect(formatCompactTokenCount(12_180)).toBe('12k');
  });
});
