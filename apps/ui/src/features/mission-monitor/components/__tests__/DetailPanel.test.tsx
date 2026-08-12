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
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    expect(screen.getAllByText('Hello, can you help me?').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Sure, here is the plan.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Let me reason about this...').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('claude-sonnet-4').length).toBeGreaterThanOrEqual(1);
  });

  it('hides THOUGHTS row when agentThinking is absent', () => {
    renderWithChakra(
      <DetailPanel
        data={makeAgentData({ agentThinking: '', model: undefined })}
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
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    // 100 prompt + 50 completion = 150 total.
    expect(screen.getAllByText('100').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('50').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('150').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the five-way token rows — Input / Cache / Reasoning / Output / Total — with the #2717 arithmetic', () => {
    renderWithChakra(
      <DetailPanel
        data={makeAgentData({
          promptTokens: 100,
          completionTokens: 50,
          reasoningTokens: 25,
          cacheReadTokens: 200,
          cacheWriteTokens: 999,
        })}
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
        data={makeAgentData({ reasoningTokens: undefined, cacheReadTokens: undefined })}
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

// ── R-2: width persistence + resize (#2707) ────────────────────────────────────

describe('DetailPanel width persistence & resize (R-2)', () => {
  it('mounts at the width saved in settings (AC2)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '420');
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('420px');
    });
  });

  it('clamps a saved width above the max to 520 (NB-3)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '9999');
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('520px');
    });
  });

  it('clamps a saved width below the min to 240 (NB-3)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '10');
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('240px');
    });
  });

  it('falls back to the default width for corrupt saved values (NB-2)', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, 'not-a-number');
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('300px');
    });
  });

  it('falls back to the default width when nothing is saved (NB-2)', async () => {
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-panel').style.width).toBe('300px');
    });
  });

  it('resizes live during the drag and commits once on pointer-up (AC2)', async () => {
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

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
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    const panel = screen.getByTestId('detail-panel');
    await waitFor(() => expect(panel.style.width).toBe('300px'));

    const handle = screen.getByTestId('detail-panel-resize-handle');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(panel.style.width).toBe('320px');
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('320');
  });

  it('keyboard resize: End snaps to the max width (AC2)', async () => {
    renderWithChakra(<DetailPanel data={makeAgentData()} onClose={() => {}} />);

    const panel = screen.getByTestId('detail-panel');
    await waitFor(() => expect(panel.style.width).toBe('300px'));

    const handle = screen.getByTestId('detail-panel-resize-handle');
    fireEvent.keyDown(handle, { key: 'End' });

    expect(panel.style.width).toBe('520px');
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('520');
  });
});
