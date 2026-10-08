/**
 * Component tests for ToolCallAccordionItem — #2739 ST-2 + #2743 ST-5 +
 * #2764 ST-2/ST-3.
 *
 * The shared item renders ONE accordion row per ToolCallSummary in the
 * embedded `── TOOLS (N) ──` sections (ChatNode's own calls and a
 * SubagentNode's child calls — the shared component means the two surfaces
 * can never drift, FR-5). Verifies:
 * - collapsed: outcome dot (#2743 AC-9 — success → `var(--status-success)`,
 *   error → `var(--status-error)`, in-progress → `var(--accent-primary)`, via
 *   the shared `getToolCallOutcome` so it can never drift from the DetailPanel
 *   scoped status row; the dot is decorative — no status aria-label) + tool
 *   name + right-aligned per-tool duration (AC-10: duration_ms → start/end
 *   delta → '—');
 * - expanded: input/output in chat-node-style scrollable boxes (AC3,
 *   `nowheel` — no wheel-zoom capture);
 * - #2743 AC-1: NO per-call token figure anywhere in the item;
 * - #2764 ST-3 (FR-2): double-click on the TRIGGER or the EXPANDED info
 *   content opens the SCOPED tool-call detail target (stopPropagation —
 *   ReactFlow's onNodeDoubleClick never fires); single click never opens
 *   any detail (FR-6 — accordion toggle only);
 * - theming: text via theme CSS vars, zero hardcoded hex/rgba in the
 *   component (NFR-9 + #2748 R-5.4).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { ToolCallSummary, DetailOpenTarget } from '../../../lib/graph';
import { Accordion } from '@chakra-ui/react';
import { ToolCallAccordionItem } from '../ToolCallAccordionItem';
import { NodeFocusProvider } from '../../NodeFocusContext';

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

/** Render one or more items in the SAME uncontrolled accordion the embedded
 *  `── TOOLS (N) ──` sections use (ChatNode / SubagentNode anatomy). */
function renderItem(
  call: ToolCallSummary,
  options: { onFocus?: (target: DetailOpenTarget) => void; index?: number } = {},
) {
  const onFocus = options.onFocus ?? (() => {});
  return renderWithChakra(
    <NodeFocusProvider value={onFocus}>
      <Accordion.Root multiple defaultValue={[]} variant="plain">
        <ToolCallAccordionItem
          key={call.correlationId || `tool-${options.index ?? 0}`}
          call={call}
          index={options.index ?? 0}
          onOpenDetail={() => onFocus({ kind: 'tool-call', call, sessionId: 's1' })}
        />
      </Accordion.Root>
    </NodeFocusProvider>,
  );
}

describe('ToolCallAccordionItem collapsed anatomy (#2739 ST-2, NFR-2/4; #2743 ST-5 AC-9/AC-10)', () => {
  it('renders the tool name + per-tool duration and collapses by default', () => {
    const { container } = renderItem(makeToolCall({ toolName: 'bash', input: 'cmd-bash', durationMs: 2100, correlationId: 't1' }));

    expect(screen.getByText('bash')).toBeDefined();
    // AC-10: duration_ms → '2.1s'. No per-call token figure anywhere (AC-1).
    expect(screen.getByText('2.1s')).toBeDefined();
    expect(screen.queryByText(/\d[\d,]* tokens/)).toBeNull();
    // Per-call outcome dot reflects the call's real status via the shared
    // getToolCallOutcome: a completed call renders `var(--status-success)`.
    // Dots carry NO status aria-label (decorative).
    expect(screen.queryByLabelText('Succeeded')).toBeNull();
    const dot = container.querySelector('[data-testid="tool-call-outcome-dot"]') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe('var(--status-success)');
    expect(dot.style.animation).toBe('');
    // Collapsed by default (NFR-4): the trigger reports aria-expanded=false
    // and the item content stays hidden (jsdom text queries match hidden
    // content — the `hidden` attribute is the reliable signal).
    const trigger = container.querySelector('[data-part="item-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    const content = container.querySelector('[data-part="item-content"]');
    expect(content).not.toBeNull();
    expect(content!.hasAttribute('hidden')).toBe(true);
  });

  it('#2743 AC-9: a failed call and a succeeded call render DIFFERENT status dots — error → status-error, success → status-success', () => {
    const { container } = renderWithChakra(
      <NodeFocusProvider value={() => {}}>
        <Accordion.Root multiple defaultValue={[]} variant="plain">
          <ToolCallAccordionItem
            key="t1" index={0}
            call={makeToolCall({ toolName: 'failing_tool', error: 'exit code 1', success: false, correlationId: 't1' })}
            onOpenDetail={() => {}}
          />
          <ToolCallAccordionItem
            key="t2" index={1}
            call={makeToolCall({ toolName: 'ok_tool', success: true, correlationId: 't2' })}
            onOpenDetail={() => {}}
          />
        </Accordion.Root>
      </NodeFocusProvider>,
    );

    // No status text/labels anywhere (decorative dots — the status is conveyed
    // by color, consistent with the DetailPanel scoped status row).
    expect(screen.queryByLabelText('Failed')).toBeNull();
    expect(screen.queryByLabelText('Succeeded')).toBeNull();
    const dots = container.querySelectorAll('[data-testid="tool-call-outcome-dot"]');
    expect(dots.length).toBe(2);
    const failed = dots[0] as HTMLElement;
    const succeeded = dots[1] as HTMLElement;
    // Error → `var(--status-error)`; success → `var(--status-success)`.
    expect(failed.style.background).toBe('var(--status-error)');
    expect(succeeded.style.background).toBe('var(--status-success)');
    expect(failed.style.animation).toBe('');
    expect(succeeded.style.animation).toBe('');
  });

  it('#2743 AC-9: a tool WITHOUT an error marker renders the success dot (no error → succeeded)', () => {
    const { container } = renderItem(makeToolCall({ toolName: 'legacy_tool', durationMs: undefined, correlationId: 't1' }));

    expect(screen.queryByLabelText('Succeeded')).toBeNull();
    const dot = container.querySelector('[data-testid="tool-call-outcome-dot"]') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe('var(--status-success)');
    expect(dot.style.animation).toBe('');
  });

  it('#2743 AC-9: an in-progress call (no endTime, no success) renders the accent dot — no pulse animation', () => {
    const { container } = renderItem(makeToolCall({ toolName: 'running', startTime: '2026-01-01T00:00:00.000Z', endTime: undefined, correlationId: 't1' }));

    expect(screen.queryByLabelText('In progress')).toBeNull();
    const dot = container.querySelector('[data-testid="tool-call-outcome-dot"]') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe('var(--accent-primary)');
    expect(dot.style.animation).toBe('');
  });

  it('AC-10: duration falls back to the startTime/endTime delta and renders — when both absent', () => {
    renderWithChakra(
      <NodeFocusProvider value={() => {}}>
        <Accordion.Root multiple defaultValue={[]} variant="plain">
          <ToolCallAccordionItem
            key="t1" index={0}
            // 1500ms delta → '1.5s' (no duration_ms carried — restored delivery).
            call={makeToolCall({ toolName: 'delta_tool', durationMs: undefined, startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:01.500Z', correlationId: 't1' })}
            onOpenDetail={() => {}}
          />
          <ToolCallAccordionItem
            key="t2" index={1}
            // Neither duration_ms nor timestamps → '—'.
            call={makeToolCall({ toolName: 'no_time', durationMs: undefined, startTime: undefined, endTime: undefined, correlationId: 't2' })}
            onOpenDetail={() => {}}
          />
        </Accordion.Root>
      </NodeFocusProvider>,
    );

    const deltaTrigger = screen.getByText('delta_tool').closest('button')!;
    expect(within(deltaTrigger).getByLabelText('1.5s')).toBeDefined();
    const noTimeTrigger = screen.getByText('no_time').closest('button')!;
    expect(within(noTimeTrigger).getByLabelText('—')).toBeDefined();
  });
});

describe('ToolCallAccordionItem expanded content (#2739 ST-2 AC3)', () => {
  it('expands to reveal its input and output in chat-node-style boxes', async () => {
    const user = userEvent.setup();
    const { container } = renderItem(makeToolCall({
      toolName: 'bash',
      input: 'ls -la apps/ui/src',
      output: 'total 48',
      totalTokens: 2100,
      correlationId: 't1',
    }));

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
    const { container } = renderWithChakra(
      <NodeFocusProvider value={() => {}}>
        <Accordion.Root multiple defaultValue={[]} variant="plain">
          <ToolCallAccordionItem
            key="t1" index={0}
            call={makeToolCall({ toolName: 'bash', input: 'cmd-1', totalTokens: 100, correlationId: 't1' })}
            onOpenDetail={() => {}}
          />
          <ToolCallAccordionItem
            key="t2" index={1}
            call={makeToolCall({ toolName: 'grep', input: 'cmd-2', totalTokens: 200, correlationId: 't2' })}
            onOpenDetail={() => {}}
          />
        </Accordion.Root>
      </NodeFocusProvider>,
    );

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

  it('renders zero-token calls honestly — no per-call token figure, absent duration —, never NaN/undefined', () => {
    renderItem(makeToolCall({ toolName: 'read', totalTokens: 0, durationMs: undefined, startTime: undefined, endTime: undefined }));

    // AC-1: no per-call token figure even for zero-token calls.
    expect(screen.queryByText('0 tokens')).toBeNull();
    // AC-10: neither duration_ms nor timestamps → '—', never NaN/undefined.
    const trigger = screen.getByText('read').closest('button')!;
    expect(within(trigger).getByText('—')).toBeDefined();
    expect(screen.queryByText('NaN')).toBeNull();
    expect(screen.queryByText('undefined')).toBeNull();
  });
});

describe('ToolCallAccordionItem double-click interception (#2743 AC-8; #2764 ST-3 / FR-2)', () => {
  it('double-clicking the collapsed TRIGGER opens the SCOPED tool-call target (stopPropagation — never the node detail)', async () => {
    const user = userEvent.setup();
    let received: DetailOpenTarget | null = null;
    const onFocus = (target: DetailOpenTarget) => { received = target; };

    renderItem(makeToolCall({ toolName: 'bash', error: 'exit code 1', success: false, correlationId: 't1' }), { onFocus });

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

  it('#2764 ST-3: double-clicking the EXPANDED info content (INPUT/OUTPUT boxes) also opens the scoped tool-call target', async () => {
    // The #2764 double-click dead-end fix: the interception covers the WHOLE
    // item — a double-click on the expanded body must NOT bubble to ReactFlow's
    // onNodeDoubleClick (which would open/select the PARENT chat node).
    const user = userEvent.setup();
    let received: DetailOpenTarget | null = null;
    const onFocus = (target: DetailOpenTarget) => { received = target; };

    const { container } = renderItem(makeToolCall({
      toolName: 'bash',
      input: 'ls -la apps/ui/src',
      output: 'total 48',
      correlationId: 't1',
    }), { onFocus });

    // Expand the item first.
    await user.click(screen.getByText('bash'));
    const content = container.querySelector('[data-part="item-content"]');
    expect(content!.hasAttribute('hidden')).toBe(false);

    // Double-click INSIDE the expanded INPUT box content.
    await user.dblClick(screen.getByText('ls -la apps/ui/src'));

    expect(received).not.toBeNull();
    expect(received!.kind).toBe('tool-call');
    if (received!.kind === 'tool-call') {
      expect(received!.call.correlationId).toBe('t1');
      expect(received!.call.toolName).toBe('bash');
    }
  });

  it('a plain single click does NOT open any detail target (FR-6 — accordion toggle only)', async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();

    renderItem(makeToolCall({ toolName: 'bash', correlationId: 't1' }), { onFocus });

    await user.click(screen.getByText('bash'));

    expect(onFocus).not.toHaveBeenCalled();
  });
});
