/**
 * Tests for the SessionTokenBar component and its MissionMonitorPanel wiring —
 * Spec #2723 (R-1 / AC1): session token bar moved to the TOP of the main view.
 * #2743 (ST-3 / AC-2/3/4/12): full display labels (INPUT/CACHE/REASONING/
 * OUTPUT/TOTAL — no abbreviations), "Session Token Usage" left title with the
 * figures right (`justify-content: space-between`), and the session's
 * ESTIMATED COST + TOTAL MESSAGES figures fed from `computeSessionMetrics`.
 * #2748 (ST-5 / AC3): a SUBAGENTS figure joins between OUTPUT and TOTAL and
 * TOTAL becomes parent five-way + subagent tokens (R-3.2) while
 * INPUT/CACHE/REASONING/OUTPUT stay parent-only (R-3.3).
 *
 * Component level: figures in fixed order with full display labels and
 * comma-formatted VALUES (byte-identical to the #2717 figure set — zero/absent
 * categories render as `0`, never dropped); full labels preserved in every
 * value's aria-label; compact height (~23px vs ~48px — 4px 14px padding, 9px
 * values / 11px Total); Total visually distinct; cost/messages use the
 * ST-1 derived figures (theme vars — no hardcoded colors).
 *
 * Panel level: the bar renders at the TOP of the canvas column (ABOVE the
 * ReactFlow canvas, below the header) for a selected session with values
 * computed by `computeSessionMetrics` from the same deliveries the graph
 * consumes; it is hidden when no session is selected; absent token categories
 * render as `0`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { act } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import { SessionTokenBar } from '../SessionTokenBar';

afterEach(() => cleanup());

// ── SessionTokenBar component — pure presentational ───────────────────────────

describe('SessionTokenBar (Spec #2723 R-1 / #2743 ST-3 / #2748 ST-5)', () => {
  it('renders the figures in fixed order with full labels and comma formatting (AC-3, R-3.2)', () => {
    render(
      <SessionTokenBar
        promptTokens={1840}
        cacheReadTokens={1200}
        reasoningTokens={500}
        completionTokens={780}
        totalTokens={4320}
        subagentTokens={9876}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    expect(bar).toBeDefined();

    // Full display labels, fixed order Input → Cache → Reasoning → Output →
    // (separator) → Subagents → Total → Estimated Cost → Total Messages —
    // no abbreviated labels anywhere on the bar.
    const labels = within(bar).getAllByText(/^(INPUT|CACHE|REASONING|OUTPUT|SUBAGENTS|TOTAL)$/);
    expect(labels.map((el) => el.textContent)).toEqual([
      'INPUT', 'CACHE', 'REASONING', 'OUTPUT', 'SUBAGENTS', 'TOTAL',
    ]);

    // en-US comma formatting (R-3.4) for values ≥ 1,000; raw below —
    // byte-identical VALUES to the #2717 bottom bar (Q-1.1).
    expect(within(bar).getByText('1,840')).toBeDefined();
    expect(within(bar).getByText('1,200')).toBeDefined();
    expect(within(bar).getByText('500')).toBeDefined();
    expect(within(bar).getByText('780')).toBeDefined();
    expect(within(bar).getByText('9,876')).toBeDefined();
    // R-3.2: Total = 1840 + 1200 + 500 + 780 + 9876 = 14,196.
    expect(within(bar).getByText('14,196')).toBeDefined();
  });

  it('renders zero values as the literal digit 0 (R-3.3)', () => {
    render(
      <SessionTokenBar
        promptTokens={100}
        cacheReadTokens={0}
        reasoningTokens={0}
        completionTokens={50}
        totalTokens={150}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    expect(within(bar).getByText('CACHE')).toBeDefined();
    expect(within(bar).getByText('REASONING')).toBeDefined();
    const zeros = within(bar).getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(2);
    expect(within(bar).getByText('150')).toBeDefined();
    expect(within(bar).queryByText('NaN')).toBeNull();
  });

  it('annotates each value span with a full-label aria-label (accessibility)', () => {
    render(
      <SessionTokenBar
        promptTokens={3420}
        cacheReadTokens={0}
        reasoningTokens={0}
        completionTokens={0}
        totalTokens={3420}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    expect(within(bar).getByLabelText('Input tokens: 3,420')).toBeDefined();
    expect(within(bar).getByLabelText('Cache tokens: 0')).toBeDefined();
    expect(within(bar).getByLabelText('Reasoning tokens: 0')).toBeDefined();
    expect(within(bar).getByLabelText('Output tokens: 0')).toBeDefined();
    expect(within(bar).getByLabelText('Total tokens (parent + subagents): 3,420')).toBeDefined();
  });

  it('groups the figures with role="group" + "Session token breakdown" (accessibility)', () => {
    render(
      <SessionTokenBar
        promptTokens={10}
        cacheReadTokens={0}
        reasoningTokens={0}
        completionTokens={5}
        totalTokens={15}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toBe('Session token breakdown');
  });

  it('is a compact single-line strip with "Session Token Usage" left + figures right (AC-4)', () => {
    const { container } = render(
      <SessionTokenBar
        promptTokens={1840}
        cacheReadTokens={1200}
        reasoningTokens={500}
        completionTokens={780}
        totalTokens={4320}
      />,
    );

    const bar = container.querySelector('[data-testid="session-token-bar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    // AC-4: left title + right figures — `space-between` (ST-3 flip from the
    // #2723 right-only `flex-end`), single row.
    expect(bar.style.display).toBe('flex');
    expect(bar.style.justifyContent).toBe('space-between');
    expect(bar.style.flexWrap).not.toBe('wrap');
    // Compact height budget: 4px + 14px content + 4px + 1px border = ~23px.
    expect(bar.style.padding).toBe('4px 14px');
    expect(bar.style.gap).toBe('16px');
    // Top strip: border-bottom (replaces the #2717 border-top).
    expect(bar.style.borderBottom).toBe('1px solid var(--border-color)');
    expect(bar.style.borderTop).toBe('');
    expect(bar.style.flexShrink).toBe('0');

    // The left title renders first, before any figure.
    const title = within(bar).getByText('Session Token Usage');
    expect(title).toBeDefined();
    const firstFigure = within(bar).getByText('INPUT');
    expect(bar.contains(title) && bar.contains(firstFigure)).toBe(true);
    expect(title.compareDocumentPosition(firstFigure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Category values 9px; Total value 11px (smaller than the #2717 13px).
    const inputValue = within(bar).getByLabelText('Input tokens: 1,840');
    expect(inputValue.style.fontSize).toBe('9px');
    // Resolve by aria-label: jsdom's CSS engine does not reliably parse `(`
    // inside attribute-selector values, so querySelector is avoided here.
    const totalValue = within(bar).getByLabelText('Total tokens (parent + subagents): 4,320');
    expect(totalValue.style.fontSize).toBe('11px');
  });

  it('styles Total distinctly with theme tokens only (G-023 — no hardcoded colors)', () => {
    const { container } = render(
      <SessionTokenBar
        promptTokens={10}
        cacheReadTokens={0}
        reasoningTokens={0}
        completionTokens={5}
        totalTokens={15}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    const totalValue = within(bar).getByLabelText('Total tokens (parent + subagents): 15');
    expect(totalValue).toBeDefined();
    expect(totalValue.style.fontWeight).toBe('700');
    expect(totalValue.style.color).toBe('var(--accent-primary)');
    expect(totalValue.style.fontSize).toBe('11px');

    // The bar container uses the theme header background + bottom border.
    const barEl = container.querySelector('[data-testid="session-token-bar"]') as HTMLElement;
    expect(barEl.style.background).toBe('var(--header-bg)');
    expect(barEl.style.borderBottom).toBe('1px solid var(--border-color)');
    // Never a hardcoded hex/rgba on the bar or its cells.
    expect(barEl.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it('renders the session ESTIMATED COST and TOTAL MESSAGES figures (ST-3 / AC-12)', () => {
    render(
      <SessionTokenBar
        promptTokens={1840}
        cacheReadTokens={1200}
        reasoningTokens={500}
        completionTokens={780}
        totalTokens={4320}
        estimatedCost={0.1234}
        totalMessages={42}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    // ESTIMATED COST — $X.XXXX comma-grouped en-US, same format as ChatNode.
    // #2750 ST-1 (AC1): the figure is ONE combined parent+subagents number
    // (the panel pre-sums); the parenthetical lives in the aria-label/title.
    expect(within(bar).getByText('ESTIMATED COST')).toBeDefined();
    expect(within(bar).getByText('$0.1234')).toBeDefined();
    expect(within(bar).getByLabelText('Estimated cost (parent + subagents): $0.1234')).toBeDefined();
    // TOTAL MESSAGES — distinct chat composite keys.
    expect(within(bar).getByText('TOTAL MESSAGES')).toBeDefined();
    expect(within(bar).getByText('42 msgs')).toBeDefined();
    expect(within(bar).getByLabelText('Total messages: 42')).toBeDefined();
  });

  it('renders the cost/messages absent-state em-dash when not provided — no hardcoded figure', () => {
    render(
      <SessionTokenBar
        promptTokens={10}
        cacheReadTokens={0}
        reasoningTokens={0}
        completionTokens={5}
        totalTokens={15}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    // No estimatedCost/totalMessages props → the absent-state '—' (never a
    // hardcoded $0.00 / 0 figure).
    expect(within(bar).getByLabelText('Estimated cost: unavailable')).toBeDefined();
    expect(within(bar).getByLabelText('Total messages: unavailable')).toBeDefined();
    expect(within(bar).queryByText(/\$0\.0000/)).toBeNull();
  });

  // ── #2748 ST-5 / AC3 — SUBAGENTS figure + parent-inclusive TOTAL ─────────────

  it('renders the SUBAGENTS figure with comma formatting, full aria-label and separator styling (#2748 ST-5)', () => {
    const { container } = render(
      <SessionTokenBar
        promptTokens={1840}
        cacheReadTokens={1200}
        reasoningTokens={500}
        completionTokens={780}
        totalTokens={4320}
        subagentTokens={1234}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    // Label present in the fixed order and the value comma-formatted via
    // formatTokenCount (never the k-abbreviation).
    expect(within(bar).getByText('SUBAGENTS')).toBeDefined();
    expect(within(bar).getByText('1,234')).toBeDefined();
    // Full comma-formatted value in the aria-label (existing convention).
    expect(within(bar).getByLabelText('Subagents tokens: 1,234')).toBeDefined();
    // Title documents the subagent-only semantics.
    const subagentsValue = container.querySelector('[aria-label="Subagents tokens: 1,234"]') as HTMLElement;
    expect(subagentsValue.title).toBe(
      "Tokens consumed by the session's subagents (not included in INPUT/CACHE/REASONING/OUTPUT)",
    );
    // Styled like the INPUT..OUTPUT figures (9px mono value, primary text)…
    expect(subagentsValue.style.fontSize).toBe('9px');
    expect(subagentsValue.style.color).toBe('var(--text-primary)');
    // …but with the subagent accent label…
    const subagentsLabel = within(bar).getByText('SUBAGENTS');
    expect(subagentsLabel.style.color).toBe('var(--accent-subagent)');
    // …and a left border separator (the TOTAL separator pattern).
    const figure = subagentsLabel.parentElement as HTMLElement;
    expect(figure.style.borderLeft).toBe('1px solid var(--border-color)');
    expect(figure.style.paddingLeft).toBe('16px');
  });

  it('makes TOTAL the parent five-way + SUBAGENTS figure (R-3.2)', () => {
    render(
      <SessionTokenBar
        promptTokens={1840}
        cacheReadTokens={1200}
        reasoningTokens={500}
        completionTokens={780}
        totalTokens={4320}
        subagentTokens={9876}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    // 4320 + 9876 = 14,196 — parent five-way + subagents, not the parent alone.
    expect(within(bar).getByText('14,196')).toBeDefined();
    expect(within(bar).getByLabelText('Total tokens (parent + subagents): 14,196')).toBeDefined();
    const totalValue = within(bar).getByLabelText('Total tokens (parent + subagents): 14,196');
    expect(totalValue.title).toBe('Total tokens (parent + subagents): 14,196');
    // Largest/boldest treatment preserved (11px, weight 700, accent, mono).
    expect(totalValue.style.fontSize).toBe('11px');
    expect(totalValue.style.fontWeight).toBe('700');
    expect(totalValue.style.color).toBe('var(--accent-primary)');
  });

  it('keeps INPUT/CACHE/REASONING/OUTPUT parent-only when subagents are present (R-3.3)', () => {
    render(
      <SessionTokenBar
        promptTokens={1840}
        cacheReadTokens={1200}
        reasoningTokens={500}
        completionTokens={780}
        totalTokens={4320}
        subagentTokens={9876}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    // Byte-identical to the pre-#2748 parent-only values — the subagent total
    // flows only into SUBAGENTS + TOTAL, never into the parent families.
    expect(within(bar).getByText('1,840')).toBeDefined();
    expect(within(bar).getByText('1,200')).toBeDefined();
    expect(within(bar).getByText('500')).toBeDefined();
    expect(within(bar).getByText('780')).toBeDefined();
    expect(within(bar).getByLabelText('Input tokens: 1,840')).toBeDefined();
    expect(within(bar).getByLabelText('Cache tokens: 1,200')).toBeDefined();
    expect(within(bar).getByLabelText('Reasoning tokens: 500')).toBeDefined();
    expect(within(bar).getByLabelText('Output tokens: 780')).toBeDefined();
  });

  it('renders SUBAGENTS 0 for a session with no subagents (zero SUBAGENTS)', () => {
    render(
      <SessionTokenBar
        promptTokens={100}
        cacheReadTokens={0}
        reasoningTokens={0}
        completionTokens={50}
        totalTokens={150}
        subagentTokens={0}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    expect(within(bar).getByText('SUBAGENTS')).toBeDefined();
    expect(within(bar).getByLabelText('Subagents tokens: 0')).toBeDefined();
    // TOTAL stays exactly the parent total when subagents are zero.
    expect(within(bar).getByText('150')).toBeDefined();
    expect(within(bar).getByLabelText('Total tokens (parent + subagents): 150')).toBeDefined();
    expect(within(bar).queryByText('NaN')).toBeNull();
  });

  it('renders SUBAGENTS 0 when the subagentTokens prop is absent (ST-6 wiring window)', () => {
    render(
      <SessionTokenBar
        promptTokens={100}
        cacheReadTokens={0}
        reasoningTokens={0}
        completionTokens={50}
        totalTokens={150}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    expect(within(bar).getByLabelText('Subagents tokens: 0')).toBeDefined();
    expect(within(bar).getByLabelText('Total tokens (parent + subagents): 150')).toBeDefined();
  });
});

// ── Panel-level wiring — MissionMonitorPanel renders the bar at the TOP ───────

let mockDeliveries: ContractDelivery[] = [];

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

vi.mock('../../lib/persistence', () => ({
  initMmTables: vi.fn(),
  persistDelivery: vi.fn(),
  loadPersistedSessions: vi.fn().mockResolvedValue([
    { sessionId: 's1', label: 'Session 1', startTime: 1, latestTimestamp: '2026-01-01T00:00:00.000Z', deliveryCount: 0 },
  ]),
  deleteSessionFromStore: vi.fn(),
  loadPersistedDeliveries: vi.fn().mockResolvedValue([]),
  loadPersistedChildDeliveries: vi.fn().mockResolvedValue([]),
  markSessionDeleted: vi.fn(),
  isSessionDeleted: vi.fn(() => false),
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

vi.mock('@/shared/contexts/StreamContext', () => ({
  useStream: vi.fn(() => ({
    deliveries: mockDeliveries,
    isConnected: false,
    clearEvents: vi.fn(),
  })),
}));

import { MissionMonitorPanel } from '../MissionMonitorPanel';
import { loadPersistedSessions } from '../../lib/persistence';

/** Chat-node delivery for the panel's selected session 's1'. */
function makeChatDelivery(
  correlationId: string,
  lifecycle: 'init' | 'update' | 'end',
  tokens: { prompt?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; completion?: number },
  costUsd?: number,
): ContractDelivery {
  const inner: Record<string, unknown> = {};
  if (tokens.prompt !== undefined) inner.promptTokens = tokens.prompt;
  if (tokens.cacheRead !== undefined) inner.cacheReadTokens = tokens.cacheRead;
  if (tokens.cacheWrite !== undefined) inner.cacheWriteTokens = tokens.cacheWrite;
  if (tokens.reasoning !== undefined) inner.reasoningTokens = tokens.reasoning;
  if (tokens.completion !== undefined) inner.completionTokens = tokens.completion;
  if (costUsd !== undefined) inner.cost_usd = costUsd;
  return {
    id: `id-${correlationId}-${lifecycle}`,
    contractName: 'chat-node',
    lifecycle,
    key: { sessionId: 's1', correlationId },
    payload: { payload: inner },
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

/** Task tool-use-lifecycle delivery for the panel's selected session 's1'
 *  (#2750 ST-1 / AC1): carries the child-cost the subagent share sums. */
function makeTaskDelivery(
  correlationId: string,
  lifecycle: 'init' | 'end',
  childCost: number,
  args: Record<string, string> = { subagent_type: 'explore', prompt: 'investigate' },
): ContractDelivery {
  return {
    id: `task-${correlationId}-${lifecycle}`,
    contractName: 'tool-use-lifecycle',
    lifecycle,
    key: { sessionId: 's1', correlationId },
    payload: { payload: { 'gen_ai.tool.name': 'task', input: JSON.stringify(args), childCost } },
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('MissionMonitorPanel — session token top bar wiring (Spec #2723 R-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliveries = [];
  });

  /** Flushes the persisted-session load so the canvas + bar render. */
  async function establishSession(rerender: (ui: React.ReactElement) => void) {
    await act(async () => { await Promise.resolve(); });
    rerender(<MissionMonitorPanel />);
    await act(async () => { await Promise.resolve(); });
  }

  it('renders the bar with five categories for a selected session, computed from deliveries (R-1, R-3.2)', async () => {
    // One turn → init + end pair with identical figures (G-011): the bar must
    // show the per-turn values once (no double-count).
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    const bar = screen.getByTestId('session-token-bar');
    expect(bar).toBeDefined();

    const labels = within(bar).getAllByText(/^(INPUT|CACHE|REASONING|OUTPUT|TOTAL)$/);
    expect(labels.map((el) => el.textContent)).toEqual(['INPUT', 'CACHE', 'REASONING', 'OUTPUT', 'TOTAL']);
    // Last-wins dedupe: init+end pair counted ONCE → 1,840 / 1,200 / 500 / 780 / 4,320.
    expect(within(bar).getByText('1,840')).toBeDefined();
    expect(within(bar).getByText('1,200')).toBeDefined();
    expect(within(bar).getByText('500')).toBeDefined();
    expect(within(bar).getByText('780')).toBeDefined();
    // R-3.1: Total = 1840 + 1200 + 500 + 780 = 4,320.
    expect(within(bar).getByText('4,320')).toBeDefined();
  });

  it('renders zero for absent cache/reasoning categories (R-3.3) — never NaN', async () => {
    // No cacheRead / reasoning fields on the wire → categories sum to 0.
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 100, completion: 50 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 100, completion: 50 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    const bar = screen.getByTestId('session-token-bar');
    expect(within(bar).getByText('CACHE')).toBeDefined();
    expect(within(bar).getByText('REASONING')).toBeDefined();
    const zeros = within(bar).getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(2);
    expect(within(bar).getByText('150')).toBeDefined();
    expect(within(bar).queryByText('NaN')).toBeNull();
  });

  it('places the bar ABOVE the ReactFlow canvas (top of the main view, R-1 / Q-1.1)', async () => {
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
      makeChatDelivery('corr-1', 'end',  { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    const bar = screen.getByTestId('session-token-bar');
    const canvas = screen.getByTestId('reactflow-provider');
    expect(bar).toBeDefined();
    expect(canvas).toBeDefined();
    // The bar must precede the canvas in document order (DOM sibling above it).
    expect(bar.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // ST-3 / AC-4: "Session Token Usage" left + figures right (space-between).
    expect(bar.style.justifyContent).toBe('space-between');
  });

  it('wires the session ESTIMATED COST and TOTAL MESSAGES from computeSessionMetrics (ST-3 / AC-12)', async () => {
    // Two turns → two distinct chat keys, each carrying a cost_usd. The bar
    // must show the summed session cost and the distinct-key message count
    // (last-wins: init+end per key counts once — G-011).
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }, 0.01),
      makeChatDelivery('corr-1', 'end',  { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }, 0.01),
      makeChatDelivery('corr-2', 'init', { prompt: 27, completion: 10 }, 0.0234),
      makeChatDelivery('corr-2', 'end',  { prompt: 27, completion: 10 }, 0.0234),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    const bar = screen.getByTestId('session-token-bar');
    expect(bar).toBeDefined();
    // ESTIMATED COST: $0.0100 + $0.0234 → $0.0334 (comma-grouped, 4 decimals).
    expect(within(bar).getByText('ESTIMATED COST')).toBeDefined();
    expect(within(bar).getByText('$0.0334')).toBeDefined();
    // TOTAL MESSAGES: 2 distinct chat keys.
    expect(within(bar).getByText('TOTAL MESSAGES')).toBeDefined();
    expect(within(bar).getByText('2 msgs')).toBeDefined();
  });

  it('includes the subagent cost share in ESTIMATED COST (ST-1 / AC1)', async () => {
    // Parent chat turns: $0.0100 + $0.0234 = $0.0334. One task dispatch with
    // childCost $0.0456 → ESTIMATED COST = parent + subagent = $0.0790. The
    // build/plan internal agents are excluded (AC-4 semantics).
    mockDeliveries = [
      makeChatDelivery('corr-1', 'init', { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }, 0.01),
      makeChatDelivery('corr-1', 'end',  { prompt: 1840, cacheRead: 1200, reasoning: 500, completion: 780 }, 0.01),
      makeChatDelivery('corr-2', 'init', { prompt: 27, completion: 10 }, 0.0234),
      makeChatDelivery('corr-2', 'end',  { prompt: 27, completion: 10 }, 0.0234),
      makeTaskDelivery('task-1', 'init', 0),
      makeTaskDelivery('task-1', 'end', 0.0456),
      makeTaskDelivery('task-2', 'end', 0.5, { subagent_type: 'build' }),
      makeTaskDelivery('task-3', 'end', 0.5, { subagent_type: 'plan' }),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    const bar = screen.getByTestId('session-token-bar');
    expect(bar).toBeDefined();
    // $0.0334 (parent) + $0.0456 (explore subagent) = $0.0790; build/plan are
    // excluded from the share. SUBAGENTS tokens remain 0 (no childTokens) —
    // the token figure is untouched by this change (NFR-3).
    expect(within(bar).getByText('ESTIMATED COST')).toBeDefined();
    expect(within(bar).getByText('$0.0790')).toBeDefined();
    expect(within(bar).getByLabelText('Estimated cost (parent + subagents): $0.0790')).toBeDefined();
  });

  it('hides the bar when no session is selected', async () => {
    // No persisted sessions and no live deliveries → the empty state renders;
    // the token bar must never appear (AC1 — hidden when NO session selected).
    vi.mocked(loadPersistedSessions).mockResolvedValueOnce([]);
    mockDeliveries = [];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    expect(screen.queryByTestId('session-token-bar')).toBeNull();
  });

  it('#2750 round-6 (AC1): reproduces the round-5 fixture session byte-exactly — TWO parent chat spans + one task span → ESTIMATED COST $0.0023', async () => {
    // Session `ses_fed7699aaffejpWUiOZM4y2eai` (round-5 AC1 fail): the tester
    // summed ONE parent chat span (0.0001225168) + the task childCost
    // (0.0020461224) and expected `$0.0022` — but the session has a SECOND
    // parent chat span (the reply turn `_3`, cost_usd 0.0000982352; the
    // dispatch turn `_2` stays in the session metrics per NFR-4). True parent
    // total = 0.0001225168 + 0.0000982352 = 0.000220752; byte-exact session
    // cost = 0.000220752 + 0.0020461224 = 0.0022668744 → `$0.0023`. The bar
    // displayed `$0.0023` — this test pins that byte-exact display for the
    // exact fixture numbers (parent-side + subagent-side are each pinned in
    // counters.test.ts / sessionMeta.test.ts).
    mockDeliveries = [
      // Dispatch turn `_2` (parent chat span 1).
      makeChatDelivery('corr-1', 'init', { prompt: 28, completion: 141 }, 0.0001225168),
      makeChatDelivery('corr-1', 'end',  { prompt: 28, completion: 141 }, 0.0001225168),
      // Task dispatch — the user-requested subagent (childCost byte-exact).
      makeTaskDelivery('task-1', 'init', 0.0020461223999999997),
      makeTaskDelivery('task-1', 'end', 0.0020461223999999997),
      // Reply turn `_3` (parent chat span 2).
      makeChatDelivery('corr-2', 'init', { prompt: 134, completion: 24 }, 0.0000982352),
      makeChatDelivery('corr-2', 'end',  { prompt: 134, completion: 24 }, 0.0000982352),
    ];

    const { rerender } = renderWithChakra(<MissionMonitorPanel />);
    await establishSession(rerender);

    const bar = screen.getByTestId('session-token-bar');
    expect(bar).toBeDefined();
    // Byte-exact: 0.000220752 (parent) + 0.0020461224 (subagent) = 0.0022668744
    // → `$0.0023`. The round-5 tester's `$0.0022` was an incomplete parent sum.
    expect(within(bar).getByText('$0.0023')).toBeDefined();
    expect(within(bar).getByLabelText('Estimated cost (parent + subagents): $0.0023')).toBeDefined();
    expect(within(bar).queryByText('$0.0022')).toBeNull();
  });
});
