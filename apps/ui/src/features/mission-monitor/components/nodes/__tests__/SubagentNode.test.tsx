/**
 * Component tests for SubagentNode — #2745 ST-5 (AC-1) rich node.
 *
 * Verifies the revived RICH SubagentNode renders from a full
 * `SubagentNodePayload` (the ST-4 builder's delivery shape):
 * - title `Subagent · <name>` with the LuBot icon + `—` fallback when name is
 *   empty;
 * - `── INSTRUCTION ──` scrollable box (maxHeight 96) + `── OUTPUT ──` mono box
 *   (maxHeight 160) with `loadingDots` while working / `—` when empty;
 * - deterministic duration via `formatToolDuration` (never a render-time clock);
 * - Token Usage row (bottomBar pattern): TOTAL figure from `childTokens`,
 *   comma-formatted en-US, full value in the aria-label, zero-guarded;
 * - Estimated Cost row (costRow pattern): `$X.XXXX` for a delivered cost,
 *   `—` when absent (never 0 for absent);
 * - child-session link chip (mono childSessionId + LuExternalLink) with the
 *   `Open subagent session <id>` aria-label; hidden while childSessionId is
 *   undefined;
 * - `role="article"` + keyboard-open (Enter → DetailPanel) + the
 *   `target-left`/`source-right` handle pair (the #2766 mirrored contract —
 *   nested dispatches source from `source-right`);
 * - #2748 ST-7 (AC-5): NO status badge / status text / working pulse on the
 *   node (R-5.1/R-5.3) — the border is plain neutral `var(--border-color)`
 *   regardless of status, and the node aria-label carries no status token;
 * - AC-1 theming: zero hardcoded hex/rgba/minWidth/maxWidth literals in the
 *   component source (grep-style assertion).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CSSProperties } from 'react';
import type { NodeProps } from 'reactflow';
import type { MonitorNodeData } from '../../../types';
import { SubagentNode } from '../SubagentNode';
import { NodeFocusProvider } from '../../NodeFocusContext';
import type { DetailOpenTarget } from '../../../lib/graph';

// SubagentNode renders ReactFlow Handles — stub them so the node can be
// asserted in isolation (no ReactFlow provider needed). The stub keeps the
// `id`/`type`/`position`/`style` props so the handles are assertable (incl.
// their neutral `var(--border-color)` fill, #2748 AC-5).
vi.mock('reactflow', () => ({
  Handle: ({ id, type, position, style }: { id?: string; type?: string; position?: string; style?: CSSProperties }) => (
    <div data-testid={`handle-${id ?? 'default'}`} data-type={type} data-position={position} style={style} />
  ),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

// The vitest config does not enable `globals`, so RTL's auto-cleanup hook
// never runs — without an explicit cleanup the rendered nodes accumulate in
// document.body across cases and text queries find duplicates.
afterEach(() => cleanup());

/** A full ST-4-built SubagentNodePayload (name/instruction from the parsed
 *  task args, output + child-completion fields from the delivered payload). */
function makeSubagentPayload(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    name: 'explore',
    instruction: 'Investigate marker e2e-2745-8f3c1d2a',
    output: '<task id="ses_child" state="completed">CHILD-e2e-2745-8f3c1d2a</task>',
    durationMs: 1200,
    startTime: '2026-08-15T10:00:00.000Z',
    endTime: '2026-08-15T10:00:01.200Z',
    childSessionId: 'ses_child_8f3c1d2a',
    childAgent: 'explore',
    childTokens: 1840,
    childCost: 0.0234,
    childMessages: 12,
    parentCorrelationId: 'corr-parent',
    correlationId: 'corr-task',
    sessionId: 's1',
    ...overrides,
  };
}

function makeMonitorNodeData(
  status: MonitorNodeData['status'],
  payloadOverrides: Record<string, unknown> = {},
): MonitorNodeData {
  return {
    eventType: 'subagent',
    status,
    payload: makeSubagentPayload(payloadOverrides),
    timestamp: '2026-08-15T10:00:01.250Z',
    label: 'Subagent · explore',
    threadId: 'main',
    relatedEvents: [],
  };
}

function makeNodeProps(data: MonitorNodeData): NodeProps<MonitorNodeData> {
  return {
    id: 'subagent-corr-task',
    data,
    selected: false,
    type: 'subagentNode',
    isConnectable: true,
    zIndex: 1,
    xPos: -564,
    yPos: 0,
    dragging: false,
    targetPosition: 'right' as const,
    sourcePosition: 'left' as const,
    width: 420,
    height: 400,
  };
}

describe('SubagentNode rich rendering (#2745 ST-5 / AC-1)', () => {
  it('renders the title "Subagent · name" with a `—` fallback for an empty name', () => {
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive'))} />);

    expect(screen.getByText('Subagent · explore')).toBeDefined();
    // The container aria-label carries the name for AT (full value, never
    // truncated). #2748 ST-7 (AC-5): NO `— <status>` suffix — status tokens are
    // gone from the aria-label (R-5.1).
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe('Subagent · explore');

    cleanup();
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { name: '' }))} />);
    expect(screen.getByText('Subagent · —')).toBeDefined();
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe('Subagent · —');
  });

  it('renders the INSTRUCTION and OUTPUT sections with their labels and content', () => {
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive'))} />);

    expect(screen.getByText('── INSTRUCTION ──')).toBeDefined();
    expect(screen.getByText('Investigate marker e2e-2745-8f3c1d2a')).toBeDefined();
    expect(screen.getByText('── OUTPUT ──')).toBeDefined();
    // formatSubagentOutput strips the opencode angle-bracket control tags while
    // preserving the inner content (user-friendly output).
    expect(screen.getByText('CHILD-e2e-2745-8f3c1d2a')).toBeDefined();
    expect(screen.queryByText(/<task/)).toBeNull();
  });

  it('renders the deterministic duration via formatToolDuration (never a clock)', () => {
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive'))} />);

    // durationMs 1200 → "1.2s" (formatToolDuration — deterministic).
    expect(screen.getByText('1.2s')).toBeDefined();
    expect(screen.getByLabelText('Duration 1.2s')).toBeDefined();
  });

  it('shows loadingDots in the OUTPUT box while working with no output, and `—` when empty', () => {
    const { container } = render(
      <SubagentNode {...makeNodeProps(makeMonitorNodeData('working', { output: '' }))} />,
    );

    // Two `.nowheel` boxes (INSTRUCTION first, OUTPUT second in DOM order).
    const boxes = container.querySelectorAll('.nowheel');
    expect(boxes.length).toBe(2);
    const outputBox = boxes[1];
    expect(outputBox).not.toBeNull();
    expect(outputBox.textContent).toContain('●');
    expect(outputBox.querySelectorAll('span').length).toBeGreaterThanOrEqual(3);

    cleanup();
    // Empty output, NOT working → the documented empty-state '—' (never blank).
    const { container: idleContainer } = render(
      <SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { output: '' }))} />,
    );
    const idleBox = idleContainer.querySelectorAll('.nowheel')[1];
    expect(idleBox).not.toBeNull();
    expect(idleBox.textContent).toContain('—');
  });

  it('renders the Token Usage row — comma-formatted TOTAL figure from childTokens with the full aria-label', () => {
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { childTokens: 1840 }))} />);

    expect(screen.getByText('Token Usage')).toBeDefined();
    // 1840 → "1,840" (en-US comma grouping — never k/M).
    expect(screen.getByText('1,840')).toBeDefined();
    expect(screen.getByLabelText('Total tokens: 1,840')).toBeDefined();
    expect(screen.getByRole('group', { name: 'Node token breakdown' })).toBeDefined();
  });

  it('renders the five-way breakdown INPUT/CACHE/REASONING/OUTPUT/TOTAL when the per-family fields are delivered', () => {
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', {
      childInputTokens: 100,
      childCacheReadTokens: 200,
      childReasoningTokens: 300,
      childOutputTokens: 400,
    }))} />);

    expect(screen.getByLabelText('Input tokens: 100')).toBeDefined();
    expect(screen.getByLabelText('Cache tokens: 200')).toBeDefined();
    expect(screen.getByLabelText('Reasoning tokens: 300')).toBeDefined();
    expect(screen.getByLabelText('Output tokens: 400')).toBeDefined();
    // TOTAL = the sum of the four displayed families (cache WRITE never displayed).
    expect(screen.getByLabelText('Total tokens: 1,000')).toBeDefined();
  });

  it('zero-guards the token figures — absent/NaN renders 0, never NaN', () => {
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { childTokens: Number.NaN }))} />);

    // INPUT/CACHE/REASONING/OUTPUT each render 0; TOTAL falls back to 0.
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('NaN')).toBeNull();
    expect(screen.getByLabelText('Total tokens: 0')).toBeDefined();
  });

  it('renders the Estimated Cost row — $X.XXXX for a delivered cost, `—` when absent', () => {
    // Delivered cost 0.0234 → "$0.0234" (4-decimal en-US).
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { childCost: 0.0234 }))} />);
    expect(screen.getByText('Estimated Cost')).toBeDefined();
    expect(screen.getByText('$0.0234')).toBeDefined();
    expect(screen.getByLabelText('Estimated cost: $0.0234')).toBeDefined();

    cleanup();
    // Absent childCost → the absent-state '—' (never 0, never a hardcoded figure).
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { childCost: undefined }))} />);
    const costRow = screen.getByRole('group', { name: 'Estimated cost' });
    expect(costRow.textContent).toContain('—');
    expect(costRow.textContent).not.toContain('$');
  });

  it('renders $0.0000 for a delivered zero cost — never a hardcoded literal', () => {
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { childCost: 0 }))} />);

    const costRow = screen.getByRole('group', { name: 'Estimated cost' });
    expect(costRow.textContent).toContain('$0.0000');
    expect(costRow.textContent).not.toContain('—');
  });

  it('does NOT render the child-session id in the node (kept in the payload for the session link)', () => {
    // Human decision: the childSessionId stays in the payload (the detail/session
    // link needs it) but is never shown as a chip in the node — the raw id is
    // noise on a graph node.
    render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive'))} />);

    expect(screen.queryByLabelText(/Open subagent session/)).toBeNull();
    expect(screen.queryByText(/ses_child_8f3c1d2a/)).toBeNull();
  });

  it('#2748 ST-7 (AC-5 / R-5.1, R-5.2, R-5.3): renders NO status badge/text and NO working pulse; the border is plain neutral across statuses', () => {
    // Every status renders the SAME neutral chrome — no badge text, no pulse
    // dot, neutral `var(--border-color)` border and handle.
    const statuses = ['working', 'inactive', 'error', 'compacted'] as const;
    for (const status of statuses) {
      cleanup();
      const { container } = render(<SubagentNode {...makeNodeProps(makeMonitorNodeData(status))} />);

      // R-5.1: no status badge text anywhere on the node.
      expect(screen.queryByText('WORKING')).toBeNull();
      expect(screen.queryByText('DONE')).toBeNull();
      expect(screen.queryByText('FAILED')).toBeNull();
      expect(screen.queryByText('COMPACTED')).toBeNull();
      expect(screen.queryByText('PERMISSION REQUIRED')).toBeNull();
      // R-5.3: no working pulse dot (no 8px accent dot in the title bar).
      expect(screen.queryByLabelText('Subagent working')).toBeNull();

      // The node aria-label carries no status token (no `— <badge>` suffix) —
      // the name is the only content after the `Subagent · ` prefix.
      const aria = screen.getByRole('article').getAttribute('aria-label');
      expect(aria).toBe('Subagent · explore');
      expect(aria).not.toContain('DONE');
      expect(aria).not.toContain('FAILED');
      expect(aria).not.toContain('WORKING');

      // R-5.2: border is `1.5px solid var(--border-color)` for every status
      // (compacted keeps only the dashed style — still neutral, still a token).
      const nodeEl = container.querySelector(`[role="article"]`) as HTMLElement;
      if (status === 'compacted') {
        expect(nodeEl.style.border).toBe('1.5px dashed var(--border-color)');
      } else {
        expect(nodeEl.style.border).toBe('1.5px solid var(--border-color)');
      }

      // R-5.3: the target handle is neutral `var(--border-color)` — never a
      // status color.
      const handle = container.querySelector('[data-testid="handle-target-left"]') as HTMLElement;
      expect(handle).not.toBeNull();
      expect(handle.style.background).toBe('var(--border-color)');
    }
  });

  it('is a keyboard-focusable article (role=article) and opens the node detail on Enter', () => {
    const data = makeMonitorNodeData('inactive');
    let received: DetailOpenTarget | null = null;
    const onFocus = (target: DetailOpenTarget) => { received = target; };

    render(
      <NodeFocusProvider value={onFocus}>
        <SubagentNode {...makeNodeProps(data)} />
      </NodeFocusProvider>,
    );

    const container = screen.getByRole('article');
    expect(container).toBeDefined();
    expect(container.getAttribute('tabindex')).toBe('0');
    expect(container.getAttribute('title')).toBe('Double-click to view details');

    fireEvent.keyDown(container, { key: 'Enter' });
    expect(received).not.toBeNull();
    expect(received!.kind).toBe('node');
    if (received!.kind === 'node') {
      expect(received!.data.payload).toBe(data.payload);
    }
  });

  it('renders `target-left` plus the `source-right` handle (#2762 nested edge source, #2766 mirrored contract)', () => {
    const { container } = render(<SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive'))} />);

    const handle = container.querySelector('[data-testid="handle-target-left"]');
    expect(handle).not.toBeNull();
    expect(handle!.getAttribute('data-type')).toBe('target');
    expect(handle!.getAttribute('data-position')).toBe('left');
    // #2762 ST-3: the node is no longer terminal — the `source-right` handle
    // sources ITS OWN nested-subagent edges (root edges keep explicit
    // handles, so root rendering is unchanged). #2766 ST-2 mirrored the
    // handle contract with the companion-column move to the RIGHT.
    const sourceHandle = container.querySelector('[data-testid="handle-source-right"]');
    expect(sourceHandle).not.toBeNull();
    expect(sourceHandle!.getAttribute('data-type')).toBe('source');
    expect(sourceHandle!.getAttribute('data-position')).toBe('right');
    expect(container.querySelectorAll('[data-testid^="handle-"]')).toHaveLength(2);
  });
});

describe('SubagentNode AC-1 theming — zero hardcoded color/width literals', () => {
  it('has no hex/rgba/minWidth/maxWidth literals in the component source', () => {
    // vitest runs with cwd = apps/ui; resolve the component source relative to
    // it (import.meta.url is not a file scheme under this workspace setup).
    const rawSource = readFileSync(
      resolve(process.cwd(), 'src/features/mission-monitor/components/nodes/SubagentNode.tsx'),
      'utf8',
    );
    // Strip comments so spec references (#2745 …) and doc prose about the dead
    // component's colors never false-positive the literal grep.
    const source = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // No hex colors (#12121f / #6366f1 / #0a0a18 …).
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // No rgba(...) / rgb(...) literals.
    expect(source).not.toMatch(/rgba?\(/);
    // No inline width bounds (the shared SUBAGENT_NODE_MIN/MAX_WIDTH constants
    // from lib/layout.ts are consumed instead).
    expect(source).not.toMatch(/minWidth:\s*\d/);
    expect(source).not.toMatch(/maxWidth:\s*\d/);
    // The shared constants are imported (single-sourced, never re-declared).
    expect(source).toContain('SUBAGENT_NODE_MIN_WIDTH');
    expect(source).toContain('SUBAGENT_NODE_MAX_WIDTH');
  });
});
