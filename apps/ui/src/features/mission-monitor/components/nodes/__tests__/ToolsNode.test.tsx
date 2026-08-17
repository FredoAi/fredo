/**
 * Component tests for ToolsNode — #2739 ST-2 + #2743 ST-5 + #2748 ST-7.
 *
 * Verifies the tools-summary node rendered by the ST-1 association pass:
 * - title bar: wrench icon, "Tools · {N} calls", right-aligned Σ of the
 *   per-call totals (AC1/AC2 semantics);
 * - one Chakra v3 Accordion item per tool call — collapsed: neutral outcome
 *   dot (#2748 AC-5 — the #2743 AC-9 colored indicators are neutralized:
 *   every call renders an identical plain `var(--border-color)` dot with no
 *   status aria-label and no pulse animation) + tool name + right-aligned
 *   per-tool duration (AC-10: duration_ms → start/end delta → '—'); expanded:
 *   input/output in chat-node-style scrollable boxes (AC3, `nowheel` — no
 *   wheel-zoom capture);
 * - #2743 AC-1: NO per-call token figure beside any tool entry and NO
 *   "Exchange tokens:" summary row anywhere in the node;
 * - #2748 AC-5: plain neutral node chrome — `1.5px solid var(--border-color)`
 *   on `var(--card-bg)` regardless of status, no glow/status classes, neutral
 *   handles;
 * - zero-token rendering for opencode tool spans (Architect D-1);
 * - theming: text via theme CSS vars, zero hardcoded hex/rgba in the
 *   component (NFR-9 + #2748 R-5.4).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CSSProperties } from 'react';
import type { NodeProps } from 'reactflow';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { MonitorNodeData } from '../../../types';
import type { ToolCallSummary, ToolsNodePayload, DetailOpenTarget } from '../../../lib/graph';
import { ToolsNode } from '../ToolsNode';
import { NodeFocusProvider } from '../../NodeFocusContext';

// ToolsNode renders ReactFlow Handles — stub them so the accordion can be
// asserted in isolation (no ReactFlow provider needed). The stub keeps the
// `id`/`style` props so the additive `target-left` handle is assertable (incl.
// its neutral `var(--border-color)` fill, #2748 AC-5).
vi.mock('reactflow', () => ({
  Handle: ({ id, style }: { id?: string; style?: CSSProperties }) => (
    <div data-testid={`handle-${id ?? 'default'}`} style={style} />
  ),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

afterEach(() => cleanup());

function makeToolCall(overrides: Partial<ToolCallSummary> = {}): ToolCallSummary {
  return {
    toolName: 'bash',
    input: 'ls -la apps/ui/src',
    output: 'total 48\ndrwxr-xr-x  5 user  staff  160 Jan 1 12:00 .',
    inputTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    correlationId: 'tool-1',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function makeToolsPayload(overrides: Partial<ToolsNodePayload> = {}): ToolsNodePayload {
  return {
    toolCalls: [],
    parentCorrelationId: 'chat-corr-1',
    correlationId: 'tools-chat-corr-1',
    sessionId: 's1',
    ...overrides,
  };
}

function makeNodeProps(
  payload: ToolsNodePayload,
  overrides: Partial<MonitorNodeData> = {},
): NodeProps<MonitorNodeData> {
  return {
    id: payload.correlationId,
    data: {
      eventType: 'tools',
      status: 'inactive',
      payload: payload as unknown as Record<string, any>,
      timestamp: '2026-01-01T00:00:00.000Z',
      label: `Tools · ${payload.toolCalls.length} calls`,
      threadId: 'main',
      relatedEvents: [],
      ...overrides,
    },
    selected: false,
    type: 'toolsNode',
    isConnectable: true,
    zIndex: 1,
    xPos: 0,
    yPos: 0,
    dragging: false,
    targetPosition: 'left' as const,
    sourcePosition: 'right' as const,
    width: 300,
    height: 200,
  };
}

describe('ToolsNode title bar (#2739 ST-2, AC1/AC2)', () => {
  it('renders "Tools · N calls" — the title total-token Σ was dropped (#2743 ST-4), the total survives in the node a11y label', () => {
    renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({ toolName: 'bash', totalTokens: 2100, correlationId: 't1' }),
        makeToolCall({ toolName: 'read_file', totalTokens: 850, correlationId: 't2' }),
        makeToolCall({ toolName: 'grep', totalTokens: 9500, correlationId: 't3' }),
      ],
    }))} />);

    expect(screen.getByText('Tools · 3 calls')).toBeDefined();
    // 63b6837 dropped the title-bar Σ of the per-call totals — it must NOT
    // render (a stale assertion for the removed figure is a false positive).
    expect(screen.queryByText('Σ 12,450')).toBeNull();
    expect(screen.queryByLabelText('Total tokens: 12,450')).toBeNull();
    // The per-call totals still drive the node a11y label (full figures, no k/M).
    expect(screen.getByRole('group', { name: 'Tools summary — 3 calls, 12,450 tokens' })).toBeDefined();
  });
});

describe('ToolsNode accordion (#2739 ST-2, AC2/AC3, NFR-2/4; #2743 ST-5 AC-9/AC-10)', () => {
  it('renders ONE collapsed item per tool call — indicator + tool name + duration', () => {
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({ toolName: 'bash', input: 'cmd-bash', durationMs: 2100, correlationId: 't1' }),
        makeToolCall({ toolName: 'read_file', input: 'cmd-read', durationMs: 850, correlationId: 't2' }),
        makeToolCall({ toolName: 'grep', input: 'cmd-grep', durationMs: 9500, correlationId: 't3' }),
      ],
    }))} />);

    expect(screen.getByText('bash')).toBeDefined();
    expect(screen.getByText('read_file')).toBeDefined();
    expect(screen.getByText('grep')).toBeDefined();
    // AC-10: duration_ms-driven figures — 2100 → '2.1s', 850 → '850ms',
    // 9500 → '9.5s'. Per-call token figure is GONE (AC-1 / #2743) — no
    // digit-prefixed "<n> tokens" string remains beside any entry (the
    // "Exchange tokens:" footer label is a different, ST-4-owned surface).
    expect(screen.getByText('2.1s')).toBeDefined();
    expect(screen.getByText('850ms')).toBeDefined();
    expect(screen.getByText('9.5s')).toBeDefined();
    expect(screen.queryByText(/\d[\d,]* tokens/)).toBeNull();
    // #2748 ST-7 (AC-5): the per-call outcome dots are NEUTRALIZED — no status
    // aria-label (Succeeded/Failed/In progress) anywhere; every call renders an
    // identical plain `var(--border-color)` dot with no pulse animation.
    expect(screen.queryByLabelText('Succeeded')).toBeNull();
    expect(screen.queryByLabelText('Failed')).toBeNull();
    expect(screen.queryByLabelText('In progress')).toBeNull();
    const dots = container.querySelectorAll('[data-testid="tool-call-outcome-dot"]');
    expect(dots.length).toBe(3);
    for (const dot of Array.from(dots)) {
      expect((dot as HTMLElement).style.background).toBe('var(--border-color)');
      expect((dot as HTMLElement).style.animation).toBe('');
    }
    // Collapsed by default (NFR-4): every trigger reports aria-expanded=false
    // and every item content stays hidden. The `hidden` attribute is the
    // reliable signal — jsdom text queries match hidden content and zag omits
    // `data-state` during "skip" animation states.
    const triggers = container.querySelectorAll('[data-part="item-trigger"]');
    expect(triggers.length).toBe(3);
    for (const trigger of Array.from(triggers)) {
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    }
    const contents = container.querySelectorAll('[data-part="item-content"]');
    expect(contents.length).toBe(3);
    for (const content of Array.from(contents)) {
      expect(content.hasAttribute('hidden')).toBe(true);
    }
  });

  it('#2748 ST-7 (AC-5): a failed call and a succeeded call render IDENTICAL neutral dots — no status color, no status aria-label', () => {
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({ toolName: 'failing_tool', error: 'exit code 1', success: false, correlationId: 't1' }),
        makeToolCall({ toolName: 'ok_tool', success: true, correlationId: 't2' }),
      ],
    }))} />);

    // No status text/labels anywhere (R-5.1).
    expect(screen.queryByLabelText('Failed')).toBeNull();
    expect(screen.queryByLabelText('Succeeded')).toBeNull();
    // Both dots are plain neutral `var(--border-color)` (R-5.3) — byte-identical
    // across outcomes (AC5-2).
    const dots = container.querySelectorAll('[data-testid="tool-call-outcome-dot"]');
    expect(dots.length).toBe(2);
    for (const dot of Array.from(dots)) {
      const el = dot as HTMLElement;
      expect(el.style.background).toBe('var(--border-color)');
      expect(el.style.animation).toBe('');
    }
  });

  it('#2748 ST-7 (AC-5): a tool WITHOUT an error marker renders the same neutral dot (no status default)', () => {
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        // Restored/legacy call: neither success nor error carried — the AC-9
        // outcome derivation is no longer rendered on the node (AC-5).
        makeToolCall({ toolName: 'legacy_tool', durationMs: undefined, correlationId: 't1' }),
      ],
    }))} />);

    expect(screen.queryByLabelText('Succeeded')).toBeNull();
    const dot = container.querySelector('[data-testid="tool-call-outcome-dot"]') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe('var(--border-color)');
    expect(dot.style.animation).toBe('');
  });

  it('#2748 ST-7 (AC-5): an in-progress call renders the same neutral dot — no pulsing accent, no animation', () => {
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({ toolName: 'running', startTime: '2026-01-01T00:00:00.000Z', endTime: undefined, correlationId: 't1' }),
      ],
    }))} />);

    expect(screen.queryByLabelText('In progress')).toBeNull();
    const dot = container.querySelector('[data-testid="tool-call-outcome-dot"]') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe('var(--border-color)');
    expect(dot.style.animation).toBe('');
  });

  it('AC-10: duration falls back to the startTime/endTime delta and renders — when both absent', () => {
    renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        // 1500ms delta → '1.5s' (no duration_ms carried — restored delivery).
        makeToolCall({ toolName: 'delta_tool', durationMs: undefined, startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:01.500Z', correlationId: 't1' }),
        // Neither duration_ms nor timestamps → '—'.
        makeToolCall({ toolName: 'no_time', durationMs: undefined, startTime: undefined, endTime: undefined, correlationId: 't2' }),
      ],
    }))} />);

    const deltaTrigger = screen.getByText('delta_tool').closest('button')!;
    expect(within(deltaTrigger).getByLabelText('1.5s')).toBeDefined();
    const noTimeTrigger = screen.getByText('no_time').closest('button')!;
    expect(within(noTimeTrigger).getByLabelText('—')).toBeDefined();
  });

  it('expands an item to reveal its input and output in chat-node-style boxes', async () => {
    const user = userEvent.setup();
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({
          toolName: 'bash',
          input: 'ls -la apps/ui/src',
          output: 'total 48',
          totalTokens: 2100,
          correlationId: 't1',
        }),
      ],
    }))} />);

    const trigger = screen.getByText('bash').closest('button');
    expect(trigger).not.toBeNull();
    const content = container.querySelector('[data-part="item-content"]');
    expect(content).not.toBeNull();
    // Default collapsed (NFR-4).
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    expect(content!.hasAttribute('hidden')).toBe(true);

    // userEvent dispatches the focus event ark-ui's accordion machine needs to
    // leave its `idle` state before it processes TRIGGER.CLICK (fireEvent.click
    // alone never toggles the item).
    await user.click(screen.getByText('bash'));

    expect(trigger!.getAttribute('aria-expanded')).toBe('true');
    expect(content!.hasAttribute('hidden')).toBe(false);
    // AC3: the tool's input and output text render on expand.
    expect(screen.getByText('ls -la apps/ui/src')).toBeDefined();
    expect(screen.getByText('total 48')).toBeDefined();
    // INPUT / OUTPUT section labels.
    expect(screen.getByText('── INPUT ──')).toBeDefined();
    expect(screen.getByText('── OUTPUT ──')).toBeDefined();
    // Wheel-safe scrollable boxes (nowheel — no canvas zoom capture).
    expect(content!.querySelector('.nowheel')).not.toBeNull();
  });

  it('keeps multiple items expandable simultaneously (multiple=true)', async () => {
    const user = userEvent.setup();
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({ toolName: 'bash', input: 'cmd-1', totalTokens: 100, correlationId: 't1' }),
        makeToolCall({ toolName: 'grep', input: 'cmd-2', totalTokens: 200, correlationId: 't2' }),
      ],
    }))} />);

    await user.click(screen.getByText('bash'));
    await user.click(screen.getByText('grep'));

    const triggers = container.querySelectorAll('[data-part="item-trigger"]');
    expect(triggers.length).toBe(2);
    for (const trigger of Array.from(triggers)) {
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
    }
    const contents = container.querySelectorAll('[data-part="item-content"]');
    expect(contents.length).toBe(2);
    for (const content of Array.from(contents)) {
      expect(content.hasAttribute('hidden')).toBe(false);
    }
  });
});

describe('ToolsNode #2743 AC-1 removal (per-tool tokens + Exchange tokens footer)', () => {
  it('renders NO "Exchange tokens:" row and NO exchange figures anywhere in the node', () => {
    renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [makeToolCall({ totalTokens: 2100 })],
    }))} />);

    // AC-1: the "Exchange tokens:" footer and its label table are gone.
    expect(screen.queryByText('Exchange tokens:')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Exchange token breakdown' })).toBeNull();
    expect(screen.queryByLabelText('Exchange input tokens: 6,020')).toBeNull();
    expect(screen.queryByLabelText('Exchange total tokens: 10,210')).toBeNull();
    // 63b6837 also dropped the title-bar Σ of the per-call totals — no
    // exchange figures OR title total render anywhere in the node.
    expect(screen.queryByText('Σ 2,100')).toBeNull();
  });

  it('applies the 420px minimum / 540px maximum width to the rendered container (AC-6 render-time width contract)', () => {
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [makeToolCall({ totalTokens: 2100 })],
    }))} />);

    const node = container.querySelector('[data-part="root"]')?.parentElement
      ?? container.querySelector('[role="group"]');
    // The node container is the role=group div carrying the inline width
    // styles (ToolsNode containerStyle — minWidth 420 / maxWidth 540, AC-6).
    const group = container.querySelector('[role="group"]') as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.style.minWidth).toBe('420px');
    expect(group.style.maxWidth).toBe('540px');
  });
});

describe('ToolsNode zero-token rendering (#2739 D-1, #2743 AC-1)', () => {
  it('renders NO title total-token Σ and the absent-state duration (—) for tool spans without timing — never NaN/undefined, no per-call "0 tokens" figure', () => {
    renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [makeToolCall({ toolName: 'read', totalTokens: 0, durationMs: undefined, startTime: undefined, endTime: undefined })],
    }))} />);

    // AC-1: no per-call token figure even for zero-token calls.
    expect(screen.queryByText('0 tokens')).toBeNull();
    // 63b6837 dropped the title-bar Σ (node-level figure) — assert its absence.
    expect(screen.queryByText('Σ 0')).toBeNull();
    // AC-10: neither duration_ms nor timestamps → '—', never NaN/undefined.
    const trigger = screen.getByText('read').closest('button')!;
    expect(within(trigger).getByText('—')).toBeDefined();
    expect(screen.queryByText('NaN')).toBeNull();
    expect(screen.queryByText('undefined')).toBeNull();
  });
});

describe('ToolsNode chrome & theming (#2739 NFR-9, D-5; #2748 ST-7 AC-5)', () => {
  it('uses a plain neutral border and the additive target-left handle', () => {
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [makeToolCall({ toolName: 'read', totalTokens: 0 })],
    }))} />);

    // D-5: the summary edge enters on the left via the `target-left` handle.
    expect(screen.getByTestId('handle-target-left')).toBeDefined();
    // #2748 ST-7 (AC-5): node chrome is plain neutral — `1.5px solid
    // var(--border-color)` on `var(--card-bg)`, NEVER the tools accent
    // (#f97316) or any status color. The handle is neutral too.
    const node = screen.getByRole('group', { name: 'Tools summary — 1 calls, 0 tokens' });
    expect(node.style.border).toBe('1.5px solid var(--border-color)');
    expect(node.style.background).toBe('var(--card-bg)');
    expect(node.style.border).not.toContain('rgb(249, 115, 22)');
    const handle = container.querySelector('[data-testid="handle-target-left"]') as HTMLElement;
    expect(handle.style.background).toBe('var(--border-color)');
    // No status aria-labels anywhere on the node (R-5.1).
    expect(screen.queryByLabelText('Succeeded')).toBeNull();
    expect(screen.queryByLabelText('Failed')).toBeNull();
    expect(screen.queryByLabelText('In progress')).toBeNull();
  });
});

describe('ToolsNode accordion-item double-click (#2743 ST-6 / AC-8)', () => {
  it('double-clicking an item opens the SCOPED tool-call target (stopPropagation — never the node detail)', async () => {
    const user = userEvent.setup();
    let received: DetailOpenTarget | null = null;
    const onFocus = (target: DetailOpenTarget) => { received = target; };

    const call = makeToolCall({ toolName: 'bash', error: 'exit code 1', success: false, correlationId: 't1' });
    renderWithChakra(
      <NodeFocusProvider value={onFocus}>
        <ToolsNode {...makeNodeProps(makeToolsPayload({ toolCalls: [call], sessionId: 's1' }))} />
      </NodeFocusProvider>,
    );

    await user.dblClick(screen.getByText('bash'));

    // AC-8: the detail target is scoped to THAT tool call — never a node/generic target.
    expect(received).not.toBeNull();
    expect(received!.kind).toBe('tool-call');
    if (received!.kind === 'tool-call') {
      expect(received!.call.correlationId).toBe('t1');
      expect(received!.call.toolName).toBe('bash');
      expect(received!.sessionId).toBe('s1');
    }
  });

  it('a plain single click does NOT open any detail target', async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();

    renderWithChakra(
      <NodeFocusProvider value={onFocus}>
        <ToolsNode {...makeNodeProps(makeToolsPayload({
          toolCalls: [makeToolCall({ toolName: 'bash', correlationId: 't1' })],
          sessionId: 's1',
        }))} />
      </NodeFocusProvider>,
    );

    await user.click(screen.getByText('bash'));

    expect(onFocus).not.toHaveBeenCalled();
  });
});
