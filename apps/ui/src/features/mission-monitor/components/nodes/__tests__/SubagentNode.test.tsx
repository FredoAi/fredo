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
 *   component source (grep-style assertion);
 * - #2770 ST-2 (AC-1/AC-4/AC-5): nested (depth ≥ 2) cards swap the identity
 *   accent to `var(--accent-nested-subagent)` + 3px inset tier stripe; the
 *   aria-label gains the `(nested)` qualifier; level-1/flat cards render
 *   byte-identical (R-1/R-2/R-10/R-11).
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
    // #2770 ST-2: the nested accent is consumed ONLY via the CSS var (never a
    // raw value); the level-1 parity var stays present alongside it.
    expect(source).toContain('var(--accent-nested-subagent)');
    expect(source).toContain('var(--accent-subagent)');
  });
});

describe('SubagentNode nested rendering + a11y (#2770 ST-2 / R-1, R-2, R-10, R-11)', () => {
  /** Render with payload overrides (depth/sessionMaxDepth drive the nested branches). */
  function renderWith(overrides: Record<string, unknown>) {
    return render(
      <SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', overrides))} />,
    );
  }

  it('R-1: swaps the identity-accent surfaces to var(--accent-nested-subagent) at depth ≥ 2 and prepends the 3px inset tier stripe', () => {
    const { container } = renderWith({ depth: 2, sessionMaxDepth: 2, nestedCount: 1 });
    const node = screen.getByRole('article') as HTMLElement;

    // Title bar: LuBot icon + title text carry the nested accent.
    const iconSpan = node.querySelector('svg')!.parentElement as HTMLElement;
    expect(iconSpan.style.color).toBe('var(--accent-nested-subagent)');
    expect(screen.getByText('Subagent · explore').style.color).toBe('var(--accent-nested-subagent)');

    // INSTRUCTION label + the two accent-tinted content-box borders
    // (color-mix tint via the shared `tint()` helper — #2770 round 5: the old
    // `var(--x)28` alpha-append is invalid CSS and dropped by the browser).
    expect(screen.getByText('── INSTRUCTION ──').style.color).toBe('var(--accent-nested-subagent)');
    const boxes = container.querySelectorAll('.nowheel');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLElement).style.border).toBe('1px solid color-mix(in srgb, var(--accent-nested-subagent) 16%, transparent)');
    expect((boxes[1] as HTMLElement).style.border).toBe('1px solid color-mix(in srgb, var(--accent-nested-subagent) 16%, transparent)');
    // Pattern-class regression guard: the invalid var() alpha-append signature
    // must never survive in an emitted declaration (jsdom stores the raw
    // string, so this pins the emission contract exactly).
    expect((boxes[0] as HTMLElement).style.border).not.toMatch(/var\(--[a-z-]+\)[0-9a-fA-F]/);

    // The 3px inset tier stripe is prepended to the container box-shadow —
    // INSIDE the card rect; the border stays the neutral #2748 contract and
    // the handles stay neutral (never on border/handles/glow).
    expect(node.getAttribute('style')).toContain('inset 3px 0 0 var(--accent-nested-subagent)');
    expect(node.style.border).toBe('1.5px solid var(--border-color)');
    const handle = container.querySelector('[data-testid="handle-target-left"]') as HTMLElement;
    expect(handle.style.background).toBe('var(--border-color)');
  });

  it('R-2: the unselected nested card emits the stripe + a color-mix soft shadow — never a var() alpha-append (#2770 round 5)', () => {
    // jsdom cannot compute paint (FIXB5's job), so this pins the EXACT
    // emission contract: `inset 3px …` stripe prefix unchanged verbatim (the
    // layout.deep-tree.test.ts:541 constant depends on it) + the soft shadow
    // as a color-mix() tint. `var(--border-color)33` is INVALID CSS — var()
    // substitution splices tokens without re-lexing, the appended digits stay
    // a separate token, and the browser drops the WHOLE comma-list (which is
    // why the valid stripe prefix never painted in round 4).
    renderWith({ depth: 2, sessionMaxDepth: 2 });
    const node = screen.getByRole('article') as HTMLElement;
    expect(node.style.boxShadow).toBe(
      'inset 3px 0 0 var(--accent-nested-subagent), 0 2px 8px color-mix(in srgb, var(--border-color) 20%, transparent)',
    );
    // Pattern-class regression guard: the invalid alpha-append signature
    // (`var(--x)` immediately followed by hex digits) must never survive in
    // any emitted box-shadow declaration.
    expect(node.style.boxShadow).not.toMatch(/var\(--[a-z-]+\)[0-9a-fA-F]/);
  });

  it('R-10 flat parity: a level-1 card (depth 1) takes NO nested branch — every accent stays var(--accent-subagent), no stripe', () => {
    const { container } = renderWith({ depth: 1, sessionMaxDepth: 1 });
    const node = screen.getByRole('article') as HTMLElement;

    const iconSpan = node.querySelector('svg')!.parentElement as HTMLElement;
    expect(iconSpan.style.color).toBe('var(--accent-subagent)');
    expect(screen.getByText('Subagent · explore').style.color).toBe('var(--accent-subagent)');
    expect(screen.getByText('── INSTRUCTION ──').style.color).toBe('var(--accent-subagent)');
    const boxes = container.querySelectorAll('.nowheel');
    expect((boxes[0] as HTMLElement).style.border).toBe('1px solid color-mix(in srgb, var(--accent-subagent) 16%, transparent)');
    expect((boxes[1] as HTMLElement).style.border).toBe('1px solid color-mix(in srgb, var(--accent-subagent) 16%, transparent)');
    expect(node.getAttribute('style')).not.toContain('accent-nested-subagent');
    expect(node.getAttribute('style')).not.toContain('inset 3px 0 0');
  });

  it('R-10 flat parity: a flat-session card (depth undefined) renders byte-identical to the pre-#2770 node', () => {
    const { container } = renderWith({});
    const node = screen.getByRole('article') as HTMLElement;

    expect(screen.getByRole('article').getAttribute('aria-label')).toBe('Subagent · explore');
    const iconSpan = node.querySelector('svg')!.parentElement as HTMLElement;
    expect(iconSpan.style.color).toBe('var(--accent-subagent)');
    const boxes = container.querySelectorAll('.nowheel');
    expect((boxes[0] as HTMLElement).style.border).toBe('1px solid color-mix(in srgb, var(--accent-subagent) 16%, transparent)');
    expect(node.getAttribute('style')).not.toContain('accent-nested-subagent');
    expect(node.getAttribute('style')).not.toContain('inset 3px 0 0');
  });

  it('R-11: the aria-label distinguishes nested at depth ≥ 2 while depth-1/flat labels stay byte-identical', () => {
    // depth ≥ 2 → the (nested) qualifier + level.
    renderWith({ depth: 2, sessionMaxDepth: 2 });
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe(
      'Subagent (nested) · explore · level 2',
    );

    cleanup();
    // depth 1 → unchanged (`Subagent · name · level 1`).
    renderWith({ depth: 1, sessionMaxDepth: 1 });
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe('Subagent · explore · level 1');

    cleanup();
    // depth undefined (flat) → unchanged.
    renderWith({});
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe('Subagent · explore');
  });

  it('R-2: the compact L3+ variant carries the nested accent on icon + title + stripe; the summary line stays var(--text-secondary)', () => {
    renderWith({ depth: 3, sessionMaxDepth: 3, nestedCount: 2 });
    const node = screen.getByRole('article') as HTMLElement;

    // Compact variant: no full anatomy.
    expect(screen.queryByText('── INSTRUCTION ──')).toBeNull();

    const iconSpan = node.querySelector('svg')!.parentElement as HTMLElement;
    expect(iconSpan.style.color).toBe('var(--accent-nested-subagent)');
    expect(screen.getByText('Subagent · explore').style.color).toBe('var(--accent-nested-subagent)');
    // The stripe is container-level, so it applies to the compact variant too.
    expect(node.getAttribute('style')).toContain('inset 3px 0 0 var(--accent-nested-subagent)');

    // The summary line keeps its neutral text token (1840 → "1.8k").
    const summary = screen.getByLabelText('0 tools, 2 nested, 1.8k tokens') as HTMLElement;
    expect(summary.style.color).toBe('var(--text-secondary)');
  });

  // ── #2770 R-10: compact-variant awaiting state (child warm-up window) ──────

  it('R-10: a compact card in the awaiting state renders the loading dots with an awaiting aria-label — never "0 tools"', () => {
    // status 'working' + no output = the child's warm-up window (isAwaiting).
    render(
      <SubagentNode {...makeNodeProps(makeMonitorNodeData('working', { depth: 3, sessionMaxDepth: 3, output: '' }))} />,
    );

    const awaiting = screen.getByLabelText('Awaiting child activity') as HTMLElement;
    expect(awaiting).toBeDefined();
    // The loading-dots affordance renders in place of the zeros line.
    expect(awaiting.textContent).toContain('●');
    expect(awaiting.querySelectorAll('span').length).toBeGreaterThanOrEqual(3);
    // The literal zeros summary (and its "0 tools" aria-label) must NOT render
    // while awaiting — a warm-up child must never read as broken.
    expect(screen.queryByLabelText('0 tools, 0 nested, 0 tokens')).toBeNull();
    expect(screen.queryByText(/0 tools · 0 nested · 0 tok/)).toBeNull();
  });

  it('R-10: a completed compact card with genuinely zero child activity renders the literal zeros line (legitimate terminal state)', () => {
    // status 'inactive' (completed) + no output + no child data — the card is
    // NOT awaiting, so the literal summary renders even though all zeros.
    render(
      <SubagentNode {...makeNodeProps(makeMonitorNodeData('inactive', { depth: 3, sessionMaxDepth: 3, output: '', childTokens: 0 }))} />,
    );

    const summary = screen.getByLabelText('0 tools, 0 nested, 0 tokens') as HTMLElement;
    expect(summary.textContent).toBe('0 tools · 0 nested · 0 tok');
    expect(screen.queryByLabelText('Awaiting child activity')).toBeNull();
  });

  it('R-10: a compact card whose child data landed while still working renders the real figures, not dots', () => {
    // Tools delivered but no final output yet — real data beats the awaiting
    // affordance only when the node is not in the working-no-output state…
    // status stays 'working' WITH output → not awaiting → figures render.
    render(
      <SubagentNode {...makeNodeProps(makeMonitorNodeData('working', {
        depth: 3, sessionMaxDepth: 3,
        output: 'partial result',
        tools: [{ toolName: 'bash', input: 'ls', output: 'files', correlationId: 't1', startTime: '', totalTokens: 0, inputTokens: 0, reasoningTokens: 0, outputTokens: 0 }],
      }))} />,
    );

    expect(screen.queryByLabelText('Awaiting child activity')).toBeNull();
    expect(screen.getByLabelText('1 tools, 0 nested, 1.8k tokens')).toBeDefined();
  });
});
