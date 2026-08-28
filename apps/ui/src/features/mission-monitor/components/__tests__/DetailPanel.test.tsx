/**
 * Component tests for DetailPanel — #2688 AC4 rows + #2707 R-2 width persistence.
 *
 * Verifies the INPUT / OUTPUT / THOUGHTS / MODEL rows render for agent nodes,
 * that absent sections are hidden (not rendered empty), and that the panel
 * width is persisted (saved width on mount, clamp, corrupt-value fallback)
 * and drag-resizable with a single commit on pointer-up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DetailPanel } from '../DetailPanel';
import type { MonitorNodeData } from '../../types';
import type { ToolCallSummary } from '../../lib/graph';

const PANEL_WIDTH_KEY = 'Fredo_mm_detail_panel_width';

/**
 * Build a pointer event with clientX/pointerId explicitly defined. jsdom does
 * not propagate PointerEvent init props onto the created event, so a plain
 * bubbling Event with the properties defined is the reliable simulation.
 */
function makePointerEvent(
  type: string,
  init: { clientX: number; pointerId?: number },
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, 'clientX', { value: init.clientX, configurable: true });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1, configurable: true });
  return ev;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => cleanup());

function makeAgentData(overrides: Partial<MonitorNodeData['payload']> = {}): MonitorNodeData {
  return {
    eventType: 'agent',
    status: 'inactive',
    payload: {
      userMessage: 'Hello, can you help me?',
      agentReply: 'Sure, here is the plan.',
      agentThinking: 'Let me reason about this...',
      model: 'claude-sonnet-4',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
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

describe('DetailPanel agent rows (#2688 AC4)', () => {
  it('renders INPUT, OUTPUT, THOUGHTS and MODEL rows when present', () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    expect(screen.getAllByText('Hello, can you help me?').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Sure, here is the plan.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Let me reason about this...').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('claude-sonnet-4').length).toBeGreaterThanOrEqual(1);
  });

  it('hides THOUGHTS row when agentThinking is absent', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({ agentThinking: '', model: undefined })}}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('Let me reason about this...')).toBeNull();
    expect(screen.queryByText('claude-sonnet-4')).toBeNull();
    // Input/output still render.
    expect(screen.getAllByText('Hello, can you help me?').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Sure, here is the plan.').length).toBeGreaterThanOrEqual(1);
  });

  it('renders token rows for agent nodes', () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    // 100 prompt + 50 completion = 150 total.
    expect(screen.getAllByText('100').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('50').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('150').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the five-way token rows — Input / Cache / Reasoning / Output / Total — with the #2717 arithmetic', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({
          promptTokens: 100,
          completionTokens: 50,
          reasoningTokens: 25,
          cacheReadTokens: 200,
          cacheWriteTokens: 999,
        })}}
        onClose={() => {}}
      />,
    );

    // Per-category figures (R-2): byte-identical labels, five rows. 'Input'
    // and 'Output' labels also exist on the content rows (#2688 AC4), so they
    // are matched as sets.
    expect(screen.getAllByText('Input').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Cache')).toBeDefined();
    expect(screen.getByText('Reasoning')).toBeDefined();
    expect(screen.getAllByText('Output').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Total')).toBeDefined();
    expect(screen.getAllByText('100').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('200').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('25').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('50').length).toBeGreaterThanOrEqual(1);
    // R-3.1: Total = 100 + 200 + 25 + 50 = 375 (cacheWrite 999 NEVER summed).
    expect(screen.getAllByText('375').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('999')).toBeNull();
  });

  it('renders zero for absent cache/reasoning categories (R-3.3) with a correct Total', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({ reasoningTokens: undefined, cacheReadTokens: undefined })}}
        onClose={() => {}}
      />,
    );

    // Input 100 + Cache 0 + Reasoning 0 + Output 50 = Total 150.
    expect(screen.getAllByText('100').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('50').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('150').length).toBeGreaterThanOrEqual(1);
    // Cache and Reasoning rows render their label + literal 0 (no '—' state).
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2);
  });
});

// ── #2750 ST-2 (AC2): no node-status chrome for node targets ──────────────────
//
// Double-clicking ANY node opens the detail panel with no status badge or
// Status row — #2748 removed node status from the graph nodes, so the panel
// must not re-add it. Per-tool success/error outcome indicators inside a tool
// call are untouched (the tool-call path keeps its badge + Status row).

describe('DetailPanel node-status removal (#2750 ST-2 / AC2)', () => {
  it('renders NO status badge or Status row for an agent node', () => {
    renderWithChakra(
      <DetailPanel target={{ kind: 'node', data: makeAgentData({ status: 'error' })} } onClose={() => {}} />,
    );

    // The error status must NOT surface anywhere in the node detail view.
    expect(screen.queryByText('error')).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
    // Content rows still render.
    expect(screen.getAllByText('Hello, can you help me?').length).toBeGreaterThanOrEqual(1);
  });

  it('renders NO status badge or Status row for a subagent node', () => {
    const subagentData: MonitorNodeData = {
      eventType: 'subagent',
      status: 'inactive',
      payload: {
        name: 'explore',
        instruction: 'investigate the codebase',
        output: 'findings here',
        childSessionId: 'child-1',
        childTokens: 100,
        childCost: 0.0234,
        childMessages: 3,
        parentCorrelationId: 'parent-1',
        correlationId: 'sub-1',
        sessionId: 's1',
      },
      timestamp: '2026-01-01T00:00:00.000Z',
      label: 'Subagent',
      threadId: 'main',
      relatedEvents: [],
    };
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: subagentData }} onClose={() => {}} />);

    expect(screen.queryByText('Status')).toBeNull();
    // The subagent's Child Usage Cost row (AC5 baseline) still renders.
    expect(screen.getByText('$0.0234')).toBeDefined();
  });
});

// ── #2750 ST-4 (AC5): the node's Estimated Cost row ───────────────────────────
//
// The agent-node detail view shows the node's per-node Estimated Cost —
// byte-identical to the ChatNode cost row ($X.XXXX en-US comma-grouped,
// 4 decimals) and read from the RAW payload costUsd (absent → '—', never
// through normalizeCost). Subagent nodes keep their Child Usage Cost row.

describe('DetailPanel Estimated Cost row (#2750 ST-4 / AC5)', () => {
  it('renders the agent node costUsd as $X.XXXX (byte-identical to the ChatNode row)', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({ costUsd: 0.1234 })}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('Estimated Cost')).toBeDefined();
    expect(screen.getByText('$0.1234')).toBeDefined();
  });

  it('renders the absent-state em-dash when the agent payload has no costUsd', () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    const row = screen.getByText('Estimated Cost').closest('div');
    expect(row!.textContent).toContain('—');
    expect(screen.queryByText(/\$0\.0000/)).toBeNull();
  });
});

// ── Spec #2723 (R-6 / AC6): timing rows use span-derived payload times ────────
//
// The OTLP adapter injects startTime/endTime (RFC3339 UTC from
// startTimeUnixNano/endTimeUnixNano) into the payload; the graph builder
// prefers them over delivery timestamps. The DetailPanel Start row must come
// from agentPayload.startTime (falling back to the delivery timestamp when the
// payload lacks it), and the End row from agentPayload.endTime (falling back
// to the end-delivery timestamp — streaming spans render Start-only).

describe('DetailPanel timing rows (#2723 R-6 / AC6)', () => {
  it('renders Start/End from payload-derived startTime/endTime (not the delivery timestamp)', () => {
    const payloadStart = '2026-01-02T10:30:00.000Z';
    const payloadEnd = '2026-01-02T10:31:30.000Z';
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({ startTime: payloadStart, endTime: payloadEnd })}}
        onClose={() => {}}
      />,
    );

    const startCell = new Date(payloadStart).toLocaleTimeString();
    const endCell = new Date(payloadEnd).toLocaleTimeString();
    expect(screen.getAllByText(startCell).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(endCell).length).toBeGreaterThanOrEqual(1);
    // The delivery timestamp (2026-01-01T00:00:00.000Z) must NOT be used.
    expect(screen.queryByText(new Date('2026-01-01T00:00:00.000Z').toLocaleTimeString())).toBeNull();
  });

  it('falls back to the delivery timestamp for Start when payload lacks startTime', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({ endTime: '2026-01-02T10:31:30.000Z' })}}
        onClose={() => {}}
      />,
    );

    // No payload startTime → Start renders the node delivery timestamp.
    const startCell = new Date('2026-01-01T00:00:00.000Z').toLocaleTimeString();
    expect(screen.getAllByText(startCell).length).toBeGreaterThanOrEqual(1);
  });

  it('renders Start-only (no End row) when the payload lacks endTime', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({ startTime: '2026-01-02T10:30:00.000Z' })}}
        onClose={() => {}}
      />,
    );

    const startCell = new Date('2026-01-02T10:30:00.000Z').toLocaleTimeString();
    expect(screen.getAllByText(startCell).length).toBeGreaterThanOrEqual(1);
    // End row absent → the "End" label never renders.
    expect(screen.queryByText('End')).toBeNull();
  });

  it('keeps Duration computed from the payload-derived times (formatDuration unchanged)', () => {
    const payloadStart = '2026-01-02T10:30:00.000Z';
    const payloadEnd = '2026-01-02T10:31:30.000Z';
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'node', data: makeAgentData({ startTime: payloadStart, endTime: payloadEnd })}}
        onClose={() => {}}
      />,
    );

    // 90 seconds → "1m 30s" (formatDuration unchanged, DetailPanel.tsx:38-48).
    expect(screen.getAllByText('1m 30s').length).toBeGreaterThanOrEqual(1);
  });
});

// ── #2743 ST-6 (AC-8): the scoped per-tool detail view ────────────────────────
//
// Double-clicking an embedded tool accordion item (#2764: in the chat node's
// or a subagent's `── TOOLS (N) ──` section) opens the detail panel scoped to
// THAT tool call (the `{ kind: 'tool-call' }` target union): header
// `🔧 toolName` + Status / Duration / Input / Output rows for that call —
// never a generic or all-tools view. (#2764 ST-2: the standalone ToolsNode
// node-detail view was removed with the node class.)

function makeToolCallData(overrides: Partial<ToolCallSummary> = {}): ToolCallSummary {
  return {
    toolName: 'bash',
    input: 'ls -la',
    output: 'total 48',
    inputTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    correlationId: 't1',
    startTime: '2026-01-02T10:00:00.000Z',
    endTime: '2026-01-02T10:00:01.200Z',
    ...overrides,
  };
}

describe('DetailPanel scoped tool-call view (#2743 ST-6 / AC-8)', () => {
  it('renders the scoped header 🔧 toolName — never a generic or all-tools view', () => {
    renderWithChakra(
      <DetailPanel target={{ kind: 'tool-call', call: makeToolCallData(), sessionId: 's1' }} onClose={() => {}} />,
    );

    expect(screen.getByText('🔧 bash')).toBeDefined();
    // AC-8: never the generic/all-tools ToolsSummaryView.
    expect(screen.queryByText('Tools Summary')).toBeNull();
    expect(screen.queryByText('Calls')).toBeNull();
    expect(screen.queryByText('Total Tokens')).toBeNull();
  });

  it('renders Status / Duration / Input / Output rows for THAT call only', () => {
    renderWithChakra(
      <DetailPanel
        target={{
          kind: 'tool-call',
          call: makeToolCallData({ input: 'ls -la apps', output: 'total 48', durationMs: 1200, success: true }),
          sessionId: 's1',
        }}
        onClose={() => {}}
      />,
    );

    // Status — Succeeded (success === true; also rendered as the header badge).
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThanOrEqual(1);
    // Duration from duration_ms → '1.2s' (the same formatToolDuration the
    // accordion item uses — duration_ms first).
    expect(screen.getByText('1.2s')).toBeDefined();
    // That call's own Input / Output rows.
    expect(screen.getByText('ls -la apps')).toBeDefined();
    expect(screen.getByText('total 48')).toBeDefined();
  });

  it('a failed call shows the Failed status (error text / success=false)', () => {
    renderWithChakra(
      <DetailPanel
        target={{
          kind: 'tool-call',
          call: makeToolCallData({ error: 'exit code 1', success: false, durationMs: 3000 }),
          sessionId: 's1',
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1);
    // Duration still renders for the failed call (3000ms → '3.0s').
    expect(screen.getByText('3.0s')).toBeDefined();
  });

  it('an in-progress call (no end, no outcome) shows In progress and a — duration', () => {
    renderWithChakra(
      <DetailPanel
        target={{
          kind: 'tool-call',
          call: makeToolCallData({ startTime: '2026-01-02T10:00:00.000Z', endTime: undefined, durationMs: undefined, success: undefined }),
          sessionId: 's1',
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getAllByText('In progress').length).toBeGreaterThanOrEqual(1);
    const durationRow = screen.getByText('Duration').closest('div');
    expect(durationRow!.textContent).toContain('—');
  });

  it('duration falls back to the startTime/endTime delta (restored/legacy deliveries)', () => {
    renderWithChakra(
      <DetailPanel
        target={{
          kind: 'tool-call',
          call: makeToolCallData({ durationMs: undefined, startTime: '2026-01-02T10:00:00.000Z', endTime: '2026-01-02T10:00:00.450Z' }),
          sessionId: 's1',
        }}
        onClose={() => {}}
      />,
    );

    // 450ms delta → '450ms'.
    expect(screen.getByText('450ms')).toBeDefined();
  });

  // ── #2764 AC4 (FR-4): the missing-details safe absent-state ──
  it('#2764 AC4: a call with NO detail data renders the safe absent-state — — rows, no crash, no blank panel, and the data-absent hint', () => {
    renderWithChakra(
      <DetailPanel
        target={{
          kind: 'tool-call',
          call: makeToolCallData({
            toolName: 'bash',
            input: '',
            output: '',
            durationMs: undefined,
            startTime: undefined,
            endTime: undefined,
            // Neither success nor error carried (restored/legacy call).
            success: undefined,
            error: undefined,
          }),
          sessionId: 's1',
        }}
        onClose={() => {}}
      />,
    );

    // The panel shell + all rows render (never a blank panel / crash).
    expect(screen.getByTestId('detail-panel')).toBeDefined();
    // Status: the shared outcome rule — no error AND no endTime → 'In progress'
    // (a completed call without outcome markers reads as Succeeded).
    expect(screen.getAllByText('In progress').length).toBeGreaterThanOrEqual(1);
    // Duration: no duration_ms and no usable start/end delta → '—'.
    const durationRow = screen.getByText('Duration').closest('div');
    expect(durationRow!.textContent).toContain('—');
    // Input / Output: empty strings degrade to '—'.
    expect(screen.getByText('Input').closest('div')!.textContent).toContain('—');
    expect(screen.getByText('Output').closest('div')!.textContent).toContain('—');
    // Both input AND output empty → the one-line data-absent hint.
    expect(screen.getByText('No call details were captured for this tool call.')).toBeDefined();
    expect(screen.queryByText('NaN')).toBeNull();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  it('#2764 AC4: a call WITH detail data does NOT show the data-absent hint', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'tool-call', call: makeToolCallData(), sessionId: 's1' }}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('No call details were captured for this tool call.')).toBeNull();
  });

  it('#2764 AC4: an empty toolName falls back to "Unknown tool" in the header', () => {
    renderWithChakra(
      <DetailPanel
        target={{ kind: 'tool-call', call: makeToolCallData({ toolName: '' }), sessionId: 's1' }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('🔧 Unknown tool')).toBeDefined();
  });
});

// ── AC-5: panel-below-top-bar positioning contract (#2743 ST-7) ───────────────
//
// The panel keeps `position: absolute; top: 0; right: 0; bottom: 0`. The
// canvas wrapper rendered BELOW the session token bar in MissionMonitorPanel is
// `position: relative`, so it becomes the panel's containing block — the panel
// anchors to the canvas area, never to the bar. These assertions pin that
// contract so a future refactor cannot silently change the anchoring.

describe('DetailPanel absolute anchoring contract (AC-5)', () => {
  it('keeps position:absolute anchored top/right/bottom to its containing block', () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    const panel = screen.getByTestId('detail-panel');
    expect(panel.style.position).toBe('absolute');
    expect(panel.style.top).toBe('0px');
    expect(panel.style.right).toBe('0px');
    expect(panel.style.bottom).toBe('0px');
  });

  it('keeps width resizable — the persisted width is applied on the absolute panel', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '420');
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('420px');
    });
  });
});

// ── R-2: width persistence + resize (#2707) ────────────────────────────────────

describe('DetailPanel width persistence & resize (R-2)', () => {
  it('mounts at the width saved in settings (AC2)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '420');
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('420px');
    });
  });

  it('clamps a saved width above the max to 520 (NB-3)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '9999');
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('520px');
    });
  });

  it('clamps a saved width below the min to 240 (NB-3)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '10');
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('240px');
    });
  });

  it('falls back to the default width for corrupt saved values (NB-2)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, 'not-a-number');
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('300px');
    });
  });

  it('falls back to the default width when nothing is saved (NB-2)', async () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('300px');
    });
  });

  it('resizes live during the drag and commits once on pointer-up (AC2)', async () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    const panel = screen.getByTestId('detail-panel');
    await waitFor(() => expect(panel.style.width).toBe('300px'));

    const handle = screen.getByTestId('detail-panel-resize-handle');

    // jsdom does not propagate PointerEvent init props (clientX/pointerId),
    // so dispatch native events with the properties defined explicitly.
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 350 }));
    // Live drag: 300 + (400 - 350) = 350.
    expect(panel.style.width).toBe('350px');

    fireEvent(handle, makePointerEvent('pointerup', { clientX: 350 }));
    expect(panel.style.width).toBe('350px');
    // The clamped value is persisted exactly once, at drag end.
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('350');
  });

  it('keyboard resize: ArrowRight steps the width and persists (AC2)', async () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    const panel = screen.getByTestId('detail-panel');
    await waitFor(() => expect(panel.style.width).toBe('300px'));

    const handle = screen.getByTestId('detail-panel-resize-handle');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(panel.style.width).toBe('320px');
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('320');
  });

  it('keyboard resize: End snaps to the max width (AC2)', async () => {
    renderWithChakra(<DetailPanel target={{ kind: 'node', data: makeAgentData() }} onClose={() => {}} />);

    const panel = screen.getByTestId('detail-panel');
    await waitFor(() => expect(panel.style.width).toBe('300px'));

    const handle = screen.getByTestId('detail-panel-resize-handle');
    fireEvent.keyDown(handle, { key: 'End' });

    expect(panel.style.width).toBe('520px');
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('520');
  });
});
