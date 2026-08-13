/**
 * Tests for the SessionTokenBar component and its MissionMonitorPanel wiring —
 * Spec #2723 (R-1 / AC1): session token bar moved to the TOP of the main view,
 * right-aligned, compact single-line strip.
 *
 * Component level: five figures in fixed order with abbreviated display labels
 * (`In:`/`Ca:`/`Re:`/`Ou:`/`Σ`) and full comma-formatted VALUES (byte-identical
 * to the #2717 figure set — zero/absent categories render as `0`, never
 * dropped); full labels preserved in every value's aria-label; right-aligned;
 * compact height (~23px vs ~48px — 4px 14px padding, 9px values / 11px Total);
 * Total visually distinct (theme vars — no hardcoded colors).
 *
 * Panel level: the bar renders at the TOP of the canvas column (ABOVE the
 * ReactFlow canvas, below the header) for a selected session with values
 * computed by `computeSessionTokenTotals` from the same deliveries the graph
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

describe('SessionTokenBar (Spec #2723 R-1)', () => {
  it('renders five figures in fixed order with abbreviated labels and comma formatting (R-3.4)', () => {
    render(
      <SessionTokenBar
        promptTokens={1840}
        cacheReadTokens={1200}
        reasoningTokens={500}
        completionTokens={780}
        totalTokens={4320}
      />,
    );

    const bar = screen.getByTestId('session-token-bar');
    expect(bar).toBeDefined();

    // Abbreviated display labels, fixed order Input → Cache → Reasoning →
    // Output → (separator) → Total (`Σ`).
    const labels = within(bar).getAllByText(/^(In:|Ca:|Re:|Ou:|Σ)$/);
    expect(labels.map((el) => el.textContent)).toEqual(['In:', 'Ca:', 'Re:', 'Ou:', 'Σ']);

    // en-US comma formatting (R-3.4) for values ≥ 1,000; raw below —
    // byte-identical VALUES to the #2717 bottom bar (Q-1.1).
    expect(within(bar).getByText('1,840')).toBeDefined();
    expect(within(bar).getByText('1,200')).toBeDefined();
    expect(within(bar).getByText('500')).toBeDefined();
    expect(within(bar).getByText('780')).toBeDefined();
    expect(within(bar).getByText('4,320')).toBeDefined();
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
    expect(within(bar).getByText('Ca:')).toBeDefined();
    expect(within(bar).getByText('Re:')).toBeDefined();
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
    expect(within(bar).getByLabelText('Total tokens: 3,420')).toBeDefined();
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

  it('is a compact right-aligned single-line strip (R-1 / Q-1.1 / Q-1.2)', () => {
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
    // Right-aligned single row (R-1).
    expect(bar.style.display).toBe('flex');
    expect(bar.style.justifyContent).toBe('flex-end');
    expect(bar.style.flexWrap).not.toBe('wrap');
    // Compact height budget: 4px + 14px content + 4px + 1px border = ~23px.
    expect(bar.style.padding).toBe('4px 14px');
    expect(bar.style.gap).toBe('12px');
    // Top strip: border-bottom (replaces the #2717 border-top).
    expect(bar.style.borderBottom).toBe('1px solid var(--border-color)');
    expect(bar.style.borderTop).toBe('');
    expect(bar.style.flexShrink).toBe('0');

    // Category values 9px; Total value 11px (smaller than the #2717 13px).
    const inputValue = container.querySelector('[aria-label="Input tokens: 1,840"]') as HTMLElement;
    expect(inputValue.style.fontSize).toBe('9px');
    const totalValue = container.querySelector('[aria-label="Total tokens: 4,320"]') as HTMLElement;
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

    const totalValue = container.querySelector('[aria-label="Total tokens: 15"]') as HTMLElement;
    expect(totalValue).not.toBeNull();
    expect(totalValue.style.fontWeight).toBe('700');
    expect(totalValue.style.color).toBe('var(--accent-primary)');
    expect(totalValue.style.fontSize).toBe('11px');

    // The bar container uses the theme header background + bottom border.
    const bar = container.querySelector('[data-testid="session-token-bar"]') as HTMLElement;
    expect(bar.style.background).toBe('var(--header-bg)');
    expect(bar.style.borderBottom).toBe('1px solid var(--border-color)');
    // Never a hardcoded hex/rgba on the bar or its cells.
    expect(bar.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
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
): ContractDelivery {
  const inner: Record<string, unknown> = {};
  if (tokens.prompt !== undefined) inner.promptTokens = tokens.prompt;
  if (tokens.cacheRead !== undefined) inner.cacheReadTokens = tokens.cacheRead;
  if (tokens.cacheWrite !== undefined) inner.cacheWriteTokens = tokens.cacheWrite;
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

    const labels = within(bar).getAllByText(/^(In:|Ca:|Re:|Ou:|Σ)$/);
    expect(labels.map((el) => el.textContent)).toEqual(['In:', 'Ca:', 'Re:', 'Ou:', 'Σ']);
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
    expect(within(bar).getByText('Ca:')).toBeDefined();
    expect(within(bar).getByText('Re:')).toBeDefined();
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
    // Right-aligned strip (R-1).
    expect(bar.style.justifyContent).toBe('flex-end');
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
});
