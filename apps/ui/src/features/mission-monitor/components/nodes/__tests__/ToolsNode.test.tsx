/**
 * Component tests for ToolsNode — #2739 ST-2.
 *
 * Verifies the tools-summary node rendered by the ST-1 association pass:
 * - title bar: wrench icon, "Tools · {N} calls", right-aligned Σ of the
 *   per-call totals (AC1/AC2 semantics);
 * - one Chakra v3 Accordion item per tool call — collapsed: tool name;
 *   expanded: input/output in chat-node-style scrollable boxes (AC3,
 *   `nowheel` — no wheel-zoom capture);
 * - #2743 AC-1: NO per-call token figure beside any tool entry and NO
 *   "Exchange tokens:" summary row anywhere in the node;
 * - zero-token rendering for opencode tool spans (Architect D-1);
 * - theming: text via theme CSS vars, node chrome via the tool accent
 *   (NFR-9) — no new hardcoded hex in the component.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeProps } from 'reactflow';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { MonitorNodeData } from '../../../types';
import type { ToolCallSummary, ToolsNodePayload } from '../../../lib/graph';
import { ToolsNode } from '../ToolsNode';

// ToolsNode renders ReactFlow Handles — stub them so the accordion can be
// asserted in isolation (no ReactFlow provider needed). The stub keeps the
// `id` prop so the additive `target-left` handle is assertable.
vi.mock('reactflow', () => ({
  Handle: ({ id }: { id?: string }) => <div data-testid={`handle-${id ?? 'default'}`} />,
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
  it('renders "Tools · N calls" with the Σ of the per-call totals (formatTokenCount)', () => {
    renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({ toolName: 'bash', totalTokens: 2100, correlationId: 't1' }),
        makeToolCall({ toolName: 'read_file', totalTokens: 850, correlationId: 't2' }),
        makeToolCall({ toolName: 'grep', totalTokens: 9500, correlationId: 't3' }),
      ],
    }))} />);

    expect(screen.getByText('Tools · 3 calls')).toBeDefined();
    // Σ = 2,100 + 850 + 9,500 = 12,450 (en-US commas — NFR-2, no k/M).
    expect(screen.getByText('Σ 12,450')).toBeDefined();
    expect(screen.getByLabelText('Total tokens: 12,450')).toBeDefined();
    // Node a11y label carries the same full figures.
    expect(screen.getByRole('group', { name: 'Tools summary — 3 calls, 12,450 tokens' })).toBeDefined();
  });
});

describe('ToolsNode accordion (#2739 ST-2, AC2/AC3, NFR-2/4)', () => {
  it('renders ONE collapsed item per tool call — tool name only (#2743 AC-1: no per-call token figure)', () => {
    const { container } = renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [
        makeToolCall({ toolName: 'bash', input: 'cmd-bash', totalTokens: 2100, correlationId: 't1' }),
        makeToolCall({ toolName: 'read_file', input: 'cmd-read', totalTokens: 850, correlationId: 't2' }),
        makeToolCall({ toolName: 'grep', input: 'cmd-grep', totalTokens: 9500, correlationId: 't3' }),
      ],
    }))} />);

    expect(screen.getByText('bash')).toBeDefined();
    expect(screen.getByText('read_file')).toBeDefined();
    expect(screen.getByText('grep')).toBeDefined();
    // #2743 AC-1: no per-call token figure beside ANY tool entry.
    expect(screen.queryByText('2,100 tokens')).toBeNull();
    expect(screen.queryByText('850 tokens')).toBeNull();
    expect(screen.queryByText('9,500 tokens')).toBeNull();
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
    // Non-goal: the title-bar Σ of the per-call totals is UNCHANGED.
    expect(screen.getByText('Σ 2,100')).toBeDefined();
  });
});

describe('ToolsNode zero-token rendering (#2739 D-1, #2743 AC-1)', () => {
  it('renders the title-bar Σ honestly for opencode tool spans — never NaN/undefined, and NO per-call "0 tokens" figure', () => {
    renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [makeToolCall({ toolName: 'read', totalTokens: 0 })],
    }))} />);

    // AC-1: no per-call token figure even for zero-token calls.
    expect(screen.queryByText('0 tokens')).toBeNull();
    expect(screen.getByText('Σ 0')).toBeDefined();
    expect(screen.queryByText('NaN')).toBeNull();
    expect(screen.queryByText('undefined')).toBeNull();
  });
});

describe('ToolsNode chrome & theming (#2739 NFR-9, D-5)', () => {
  it('uses the tool accent border and the additive target-left handle', () => {
    renderWithChakra(<ToolsNode {...makeNodeProps(makeToolsPayload({
      toolCalls: [makeToolCall({ toolName: 'read', totalTokens: 0 })],
    }))} />);

    // D-5: the summary edge enters on the left via the `target-left` handle.
    expect(screen.getByTestId('handle-target-left')).toBeDefined();
    // Node chrome: 1.5px solid orange (rgb(249, 115, 22)) — the tools accent.
    const node = screen.getByRole('group', { name: 'Tools summary — 1 calls, 0 tokens' });
    expect(node.style.border).toContain('1.5px solid');
    expect(node.style.border).toContain('rgb(249, 115, 22)');
  });
});
