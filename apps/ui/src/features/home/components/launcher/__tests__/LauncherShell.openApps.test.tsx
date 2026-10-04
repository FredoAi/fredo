/**
 * Spec #2954 ST-2 — the in-launcher "Open apps" row HOST wiring.
 *
 * Pins the host contract the shell owns (ST-1 pinned the presentational row):
 *   1. The row renders IMMEDIATELY above the grid when
 *      `engaged && !paletteActive && windows > 0`, listing exactly the open
 *      windows (R-2).
 *   2. The row is ABSENT at rest (not engaged).
 *   3. The row is ABSENT in `>` palette mode (the action list replaces the grid).
 *   4. The row is ABSENT at 0 windows (and the grid still renders — a non-vacuous
 *      absence, R-1 edge).
 *   5. The relocated arrange control (`[data-testid="dock-arrange"]`, #2949 AC1)
 *      renders on the row's heading line and dispatches `arrangeOpenWindows()`.
 *   6. Activate dispatches `focusWindow(id)` (top-window no-op guard); close
 *      dispatches `closeWindow(id)` (R-3).
 *   7. The companion reply band is measured (numeric `barrierTop`) in BOTH the
 *      row-present and row-absent states (G-253).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { WindowEntry } from '@/shared/window-system/windowTypes';
import { LauncherShell } from '../LauncherShell';

// LauncherShell reads the live connection flag via useConnectionStatus (no
// StreamProvider in this isolated harness) — stub the one consumer.
vi.mock('@/shared/contexts/StreamContext', () => ({
  useConnectionStatus: () => ({ isConnected: true }),
}));

const companionMock = vi.hoisted(() => ({
  current: {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    replyInFlight: false,
    queuedSendCount: 0,
  },
}));
vi.mock('@/shared/contexts/CompanionContext', () => ({
  useCompanion: () => companionMock.current,
}));

// Capture the props handed to the seated entity so the reply-band hand-off is
// observable (the band is internal state, never a DOM attribute).
const companionEntityMock = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: (props: Record<string, unknown>) => {
    companionEntityMock.props.push(props);
    return null;
  },
  askActiveCompanion: vi.fn(() => ({ outcome: 'dispatched' as const })),
  askActiveCompanionWithAudio: vi.fn(() => ({ outcome: 'dispatched' as const })),
}));

// The open-window list + the window actions are host inputs — a hoisted mutable
// holder lets each case pick the open set without re-mocking the module.
const windowsMock = vi.hoisted(() => ({ current: [] as WindowEntry[] }));
vi.mock('@/shared/window-system/useWindows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/window-system/useWindows')>();
  return { ...actual, useWindows: () => windowsMock.current };
});

const actionsMock = vi.hoisted(() => ({
  current: { focusWindow: vi.fn(), closeWindow: vi.fn() },
}));
vi.mock('@/shared/window-system/useWindowActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/window-system/useWindowActions')>();
  return { ...actual, useWindowActions: () => actionsMock.current };
});

// The relocated arrange entry dispatches the ONE shared store action — spy it.
const arrangeMock = vi.hoisted(() => ({ fn: vi.fn(() => 0) }));
vi.mock('@/shared/window-system/workspaceLayoutStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/shared/window-system/workspaceLayoutStore')>();
  return { ...actual, arrangeOpenWindows: arrangeMock.fn };
});

function win(over: Partial<WindowEntry> = {}): WindowEntry {
  return {
    id: 'mission-monitor',
    title: 'Mission Monitor',
    icon: null,
    component: null,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: false,
    isMinimized: false,
    focused: false,
    zIndex: 1,
    ...over,
  };
}

const searchbox = () => screen.getByRole('searchbox');

const renderShell = () =>
  renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);

/** Engage the grid the way the shipped bar does (real focus on the searchbox). */
const engage = () => {
  const input = searchbox();
  act(() => {
    input.focus();
    fireEvent.focus(input);
  });
};

const type = (value: string) => {
  act(() => {
    fireEvent.change(searchbox(), { target: { value } });
  });
};

beforeEach(() => {
  windowsMock.current = [];
  actionsMock.current = { focusWindow: vi.fn(), closeWindow: vi.fn() };
  companionEntityMock.props = [];
  companionMock.current = {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    replyInFlight: false,
    queuedSendCount: 0,
  };
  arrangeMock.fn.mockClear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LauncherShell — Open-apps row gating (R-2 / R-1 edge)', () => {
  it('renders the row immediately above the grid when engaged with open windows', () => {
    windowsMock.current = [
      win({ id: 'mission-monitor', title: 'Mission Monitor', focused: true, zIndex: 2 }),
      win({ id: 'query-viewer', title: 'Query Viewer', zIndex: 1 }),
    ];
    const { container } = renderShell();
    engage();

    const row = screen.getByTestId('launcher-open-apps');
    expect(row).toHaveAttribute('role', 'region');
    expect(row).toHaveAttribute('aria-label', 'Open apps');
    expect(screen.getByTestId('launcher-open-apps-heading')).toHaveTextContent('| OPEN APPS');

    // Exactly the open windows — no more, no fewer.
    expect(screen.getAllByTestId(/^launcher-open-app-entry-/)).toHaveLength(2);
    expect(screen.getByTestId('launcher-open-app-entry-mission-monitor')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-open-app-entry-query-viewer')).toBeInTheDocument();

    // The grid is present and the row precedes it in document order.
    const grid = container.querySelector('#fredo-launcher-grid');
    expect(grid).not.toBeNull();
    expect(row.compareDocumentPosition(grid as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is ABSENT at rest (launcher not engaged)', () => {
    windowsMock.current = [win()];
    renderShell();
    expect(screen.queryByTestId('launcher-open-apps')).toBeNull();
  });

  it('is ABSENT in `>` palette mode (the action list replaces the grid)', () => {
    windowsMock.current = [win()];
    renderShell();
    engage();
    type('>');

    expect(screen.queryByTestId('launcher-open-apps')).toBeNull();
    // The palette list replaced the grid — the row's host surface is gone.
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('is ABSENT at 0 windows while engaged — and the grid still renders (non-vacuous)', () => {
    windowsMock.current = [];
    const { container } = renderShell();
    engage();

    expect(screen.queryByTestId('launcher-open-apps')).toBeNull();
    expect(container.querySelector('#fredo-launcher-grid')).not.toBeNull();
  });
});

describe('LauncherShell — relocated arrange control (#2949 AC1)', () => {
  it('renders on the row heading line and dispatches arrangeOpenWindows()', () => {
    windowsMock.current = [win()];
    renderShell();
    engage();

    const heading = screen.getByTestId('launcher-open-apps-heading');
    const arrange = screen.getByTestId('dock-arrange');
    expect(arrange).toHaveAttribute('aria-label', 'Arrange windows');
    // On the heading line: the heading's flex row contains the control.
    expect(heading.parentElement?.contains(arrange)).toBe(true);
    expect(within(heading.parentElement as HTMLElement).getByTestId('dock-arrange')).toBe(arrange);

    fireEvent.click(arrange);
    expect(arrangeMock.fn).toHaveBeenCalledTimes(1);
  });
});

describe('LauncherShell — host focus/close dispatch (R-3)', () => {
  it('activate dispatches focusWindow(id); close dispatches closeWindow(id)', () => {
    const target = win({ id: 'query-viewer', title: 'Query Viewer' });
    windowsMock.current = [target];
    renderShell();
    engage();

    fireEvent.click(screen.getByTestId('launcher-open-app-entry-query-viewer'));
    expect(actionsMock.current.focusWindow).toHaveBeenCalledWith('query-viewer');

    fireEvent.click(screen.getByTestId('launcher-open-app-close-query-viewer'));
    expect(actionsMock.current.closeWindow).toHaveBeenCalledWith('query-viewer');
    // The close never doubles as an activate.
    expect(actionsMock.current.focusWindow).toHaveBeenCalledTimes(1);
  });

  it('activate is a NO-OP for an already-focused, non-minimized window', () => {
    windowsMock.current = [win({ id: 'mission-monitor', focused: true, isMinimized: false })];
    renderShell();
    engage();

    fireEvent.click(screen.getByTestId('launcher-open-app-entry-mission-monitor'));
    expect(actionsMock.current.focusWindow).not.toHaveBeenCalled();
  });
});

describe('LauncherShell — reply band measured in both row states (G-253)', () => {
  const seatCompanion = () => {
    companionMock.current.state = {
      isVisible: true,
      isAway: false,
      isAutoHidden: false,
      isInUse: false,
    };
  };

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const lastSeatBand = () => {
    const seated = companionEntityMock.props.filter((p) => p.surface === 'seat');
    expect(seated.length).toBeGreaterThan(0);
    return seated[seated.length - 1].replyBounds as Record<string, unknown>;
  };

  it('hands a numeric barrierTop with the row PRESENT (windows > 0)', async () => {
    seatCompanion();
    windowsMock.current = [win()];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderShell();
    engage();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const band = lastSeatBand();
    expect(band.barrierTop).toEqual(expect.any(Number));
    expect(Number.isFinite(band.barrierTop as number)).toBe(true);
  });

  it('hands a numeric barrierTop with the row ABSENT (windows = 0)', async () => {
    seatCompanion();
    windowsMock.current = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderShell();
    engage();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const band = lastSeatBand();
    expect(band.barrierTop).toEqual(expect.any(Number));
    expect(Number.isFinite(band.barrierTop as number)).toBe(true);
  });
});
