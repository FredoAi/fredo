/**
 * Component tests for ChatNode — #2743 ST-2 (AC-2/3/4/12) full-label,
 * comma-formatted token row + estimated cost row.
 *
 * Verifies the token row renders:
 * - full labels INPUT / CACHE / REASONING / OUTPUT / TOTAL (no abbreviated
 *   `In:`/`Ca:`/`Re:`/`Ou:`/`Σ:` — AC-3);
 * - every displayed value via `formatTokenCount` — comma-grouped en-US for
 *   ≥ 1,000, raw below; no k/M abbreviation anywhere on the node (AC-2);
 * - "Token Usage" at the LEFT of the row with the figures at the RIGHT (AC-4);
 * - every figure's aria-label carries the FULL comma-formatted number
 *   (QA Q-2.1 / graph.ts:62-63);
 * - R-3.1: Total = Input + Cache + Reasoning + Output exactly (cacheWrite
 *   carried but never displayed/summed);
 * - R-3.3: zero AND absent categories render as `0` — never NaN, negative, or
 *   a mislabeled figure;
 * - the estimated-cost row below the token row: a delivered `costUsd` renders
 *   comma-formatted `$X.XXXX`, absent renders `—` (AC-12, no hardcoded figure).
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

describe('ChatNode full-label comma-formatted token row (#2743 ST-2 / AC-2/3/4)', () => {
  it('renders five full labels — INPUT/CACHE/REASONING/OUTPUT/TOTAL — with comma-formatted values', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 1840,
      completionTokens: 780,
      reasoningTokens: 500,
      cacheReadTokens: 1200,
      cacheWriteTokens: 999,
    }))} />);

    // Full labels per the AC-3 — no abbreviated `In:`/`Ca:`/`Re:`/`Ou:`/`Σ:`
    // anywhere on the node.
    expect(screen.getByText('INPUT')).toBeDefined();
    expect(screen.getByText('CACHE')).toBeDefined();
    expect(screen.getByText('REASONING')).toBeDefined();
    expect(screen.getByText('OUTPUT')).toBeDefined();
    expect(screen.getByText('TOTAL')).toBeDefined();
    expect(screen.queryByText('In:')).toBeNull();
    expect(screen.queryByText('Ca:')).toBeNull();
    expect(screen.queryByText('Re:')).toBeNull();
    expect(screen.queryByText('Ou:')).toBeNull();
    expect(screen.queryByText('Σ:')).toBeNull();
    expect(screen.queryByText('Σ')).toBeNull();

    // Display-only comma format (AC-2): ≥ 1,000 → `toLocaleString('en-US')`,
    // < 1,000 raw. No k/M abbreviation anywhere.
    expect(screen.getByText('1,840')).toBeDefined(); // 1840 → "1,840"
    expect(screen.getByText('1,200')).toBeDefined(); // 1200 → "1,200"
    expect(screen.getByText('500')).toBeDefined();  // < 1,000 raw
    expect(screen.getByText('780')).toBeDefined();  // < 1,000 raw
    // R-3.1: Total = 1,840 + 1,200 + 500 + 780 = 4,320 → "4,320".
    expect(screen.getByText('4,320')).toBeDefined();
    // G-023: cacheWrite carried but never displayed.
    expect(screen.queryByText('999')).toBeNull();
  });

  it('keeps the "Token Usage" left label with the five figures grouped at the right (AC-4)', () => {
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
    // Left title renders inside the bottom bar.
    expect(screen.getByText('Token Usage')).toBeDefined();
    // Exactly five figure children inside the right-side figures group — no
    // nested row/cell wrappers from the old stacked format.
    const figures = bottomBar!.querySelectorAll(`.${styles.compactFigure}`);
    expect(figures.length).toBe(5);
    // The left title is a sibling of the figures group, not a figure.
    expect(bottomBar!.querySelector(`.${styles.bottomBarTitle}`)?.textContent).toBe('Token Usage');
    expect(bottomBar!.querySelector(`.${styles.bottomBarFigures}`)?.children.length).toBe(5);
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

    // The visible figure is the full label + the comma-formatted value (no
    // k/M abbreviation — graph.ts:62-63: aria-labels keep full values).
    expect(screen.getByLabelText('Input tokens: 1,840').textContent).toBe('INPUT1,840');
    expect(screen.getByLabelText('Cache tokens: 1,200').textContent).toBe('CACHE1,200');
    expect(screen.getByLabelText('Total tokens: 4,320').textContent).toBe('TOTAL4,320');
  });

  it('renders zero for absent cache/reasoning categories (R-3.3) — never NaN or "—"', () => {
    const { container } = render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      promptTokens: 100,
      completionTokens: 50,
      // reasoningTokens / cacheReadTokens absent from the payload.
    }))} />);

    expect(screen.getByText('CACHE')).toBeDefined();
    expect(screen.getByText('REASONING')).toBeDefined();
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

// ── #2743 ST-2 AC-12: the estimated-cost row ───────────────────────────────────
//
// The node displays the exchange's estimated cost from the delivered
// `cost_usd` (ST-1 puts `costUsd` on AgentNodePayload, set ONLY when the
// delivery carries a valid non-negative number). A delivered figure renders
// `$X.XXXX` (comma-grouped en-US, 4 decimals); absent renders '—' — never a
// hardcoded dollar figure.

describe('ChatNode estimated-cost row (#2743 ST-2 AC-12)', () => {
  it('renders the comma-formatted cost figure for a delivered costUsd', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      costUsd: 0.0234,
    }))} />);

    expect(screen.getByText('Estimated Cost')).toBeDefined();
    expect(screen.getByText('$0.0234')).toBeDefined();
  });

  it('renders a comma-grouped figure for a large delivered costUsd', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      costUsd: 1234.5678,
    }))} />);

    // toLocaleString('en-US', {min/max 4 fraction digits}) → "1,234.5678".
    expect(screen.getByText('$1,234.5678')).toBeDefined();
  });

  it('renders $0.0000 for a delivered zero cost — never a hardcoded literal', () => {
    // ST-1 sets costUsd ONLY when the delivery carries a valid number, so a
    // delivered 0 is distinguishable from absence and must render the
    // telemetry value (QA AC-12: no displayed figure hardcoded).
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      costUsd: 0,
    }))} />);

    const costRow = screen.getByLabelText('Estimated cost').closest('div');
    expect(costRow).not.toBeNull();
    expect(costRow!.textContent).toContain('$0.0000');
    // The delivered-zero row shows the telemetry value, never the absent '—'.
    expect(costRow!.textContent).not.toContain('—');
  });

  it('renders the absent-state em-dash when costUsd is absent — no hardcoded figure', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      // no costUsd in the payload → restored/legacy delivery, absent.
    }))} />);

    const costRow = screen.getByLabelText('Estimated cost').closest('div');
    expect(costRow).not.toBeNull();
    expect(costRow!.textContent).toContain('—');
    expect(costRow!.textContent).not.toContain('$');
  });

  it('keeps the cost row aria-label with the full comma-formatted figure', () => {
    render(<ChatNode {...makeNodeProps(makeMonitorNodeData({
      userMessage: 'turn-1',
      costUsd: 0.5,
    }))} />);

    expect(screen.getByLabelText('Estimated cost: $0.5000')).toBeDefined();
  });
});

// ── formatCompactTokenCount (Spec #2723 R-2 display-only formatter) ────────────
// The graph.ts helper itself is untouched (still exported); only the ChatNode
// surface stops using it (ST-2 drops the k/M abbreviation from the node).

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
