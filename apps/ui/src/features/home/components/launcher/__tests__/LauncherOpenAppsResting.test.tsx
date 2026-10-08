/**
 * Spec #2954 ST-5 — continuous-state invariant pin (R-1 / G-123).
 *
 * R-1 is a CONTINUOUS-STATE requirement, not a single happy-path snapshot: the
 * "no persistent open-apps chrome" condition must hold in EVERY launcher state.
 * ST-1 pinned the presentational row; ST-2 pinned its host wiring; ST-3 removed
 * the persistent dock. This pin asserts the ABSENCE those changes must sustain
 * across the full state matrix:
 *
 *   - resting (launcher NOT engaged), with 0 and with >0 open windows
 *   - engaged with 0 open windows — the row is ABSENT, never an empty
 *     `| OPEN APPS` container (the R-1 edge / G-123 line)
 *   - engaged with a non-empty query and 0 windows — still ABSENT
 *   - `>` palette mode with open windows — ABSENT (the action list replaces the grid)
 *   - engaged with >0 windows — positive control: the row IS on the surface, so
 *     the absence scans elsewhere are not vacuously passing on an empty tree
 *
 * and, in EVERY one of those states, that none of the removed persistent-dock
 * hooks (`[data-testid="app-dock"]`, `[data-dock-entry]`, `[data-dock-item]`,
 * `.dock-close`) render anywhere.
 *
 * Scope guard: this file does NOT re-implement the row (ST-1) or the dock
 * removal (ST-3) — it only pins the continuous absence.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

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

// The seated entity is never asserted here — render nothing so the harness is
// deterministic (the reply-band hand-off is pinned by the ST-2 suite).
vi.mock('@/shared/components/companion', () => ({
  CompanionEntity: () => null,
  askActiveCompanion: vi.fn(() => ({ outcome: 'dispatched' as const })),
  askActiveCompanionWithAudio: vi.fn(() => ({ outcome: 'dispatched' as const })),
}));

// The open-window list is the host input — a hoisted holder lets each state pick
// its open set without re-mocking the module.
const windowsMock = vi.hoisted(() => ({ current: [] as WindowEntry[] }));
vi.mock('@/shared/window-system/useWindows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/window-system/useWindows')>();
  return { ...actual, useWindows: () => windowsMock.current };
});

// The row host reads the window actions only when it renders — mock the hook so
// the engaged-with-windows positive control mounts without a provider.
const actionsMock = vi.hoisted(() => ({
  current: { focusWindow: vi.fn(), closeWindow: vi.fn() },
}));
vi.mock('@/shared/window-system/useWindowActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/window-system/useWindowActions')>();
  return { ...actual, useWindowActions: () => actionsMock.current };
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

const ROW_TESTID = 'launcher-open-apps';
const HEADING_TESTID = 'launcher-open-apps-heading';

/**
 * The removed persistent-dock hooks (ST-3). R-1 / AC1: none may render in any
 * state — resting, engaged, or otherwise.
 */
const REMOVED_PERSISTENT_CHROME = [
  '[data-testid="app-dock"]',
  '[data-dock-entry]',
  '[data-dock-item]',
  '.dock-close',
] as const;

/** R-1: the open-apps row (and its heading) must be ABSENT — never an empty container. */
function expectNoOpenAppsRow(): void {
  expect(screen.queryByTestId(ROW_TESTID)).toBeNull();
  expect(screen.queryByTestId(HEADING_TESTID)).toBeNull();
}

/** R-1 / AC1: no removed persistent open-apps chrome anywhere in the tree. */
function expectNoPersistentChrome(): void {
  for (const selector of REMOVED_PERSISTENT_CHROME) {
    expect(
      document.querySelector(selector),
      `removed persistent open-apps chrome "${selector}" must not render`,
    ).toBeNull();
  }
}

const searchbox = () => screen.getByRole('searchbox');

const renderShell = () =>
  renderWithChakra(<LauncherShell showableFeatures={[]} onOpenFeature={vi.fn()} />);

/** Engage the launcher the way the shipped bar does (real focus on the searchbox). */
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
  companionMock.current = {
    state: { isVisible: false, isAway: false, isAutoHidden: false, isInUse: false },
    voiceEnabled: true,
    replyInFlight: false,
    queuedSendCount: 0,
  };
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

describe('LauncherShell — R-1 continuous resting invariant', () => {
  it('resting (NOT engaged) with open windows: no open-apps row, no persistent chrome', () => {
    windowsMock.current = [win({ id: 'mission-monitor', title: 'Mission Monitor' })];
    renderShell();

    // Non-vacuous: the launcher surface itself is rendered (the command bar).
    expect(searchbox()).toBeInTheDocument();

    expectNoOpenAppsRow();
    expectNoPersistentChrome();
  });

  it('resting (NOT engaged) with zero windows: no open-apps row, no persistent chrome', () => {
    windowsMock.current = [];
    renderShell();

    expect(searchbox()).toBeInTheDocument();

    expectNoOpenAppsRow();
    expectNoPersistentChrome();
  });

  it('engaged with ZERO windows: the row is ABSENT (not an empty container), no persistent chrome', () => {
    windowsMock.current = [];
    const { container } = renderShell();
    engage();

    // Non-vacuous: the engaged launcher still renders its grid at 0 windows, so
    // the absence above is a real absence, not a failure to render the surface.
    expect(container.querySelector('#fredo-launcher-grid')).not.toBeNull();

    expectNoOpenAppsRow();
    expectNoPersistentChrome();
  });

  it('engaged with a non-empty query and ZERO windows: still ABSENT (no empty container)', () => {
    windowsMock.current = [];
    renderShell();
    engage();
    type('mission');

    expectNoOpenAppsRow();
    expectNoPersistentChrome();
  });

  it('`>` palette mode with open windows: the row is ABSENT, no persistent chrome', () => {
    windowsMock.current = [win({ id: 'mission-monitor', title: 'Mission Monitor' })];
    renderShell();
    engage();
    type('>');

    expectNoOpenAppsRow();
    expectNoPersistentChrome();
  });

  it('engaged with open windows: the row renders (positive control) and STILL no persistent chrome', () => {
    windowsMock.current = [win({ id: 'mission-monitor', title: 'Mission Monitor' })];
    renderShell();
    engage();

    // Positive control — the row IS on the surface now, proving the absence
    // scans above are not vacuously passing on a tree that renders nothing.
    expect(screen.getByTestId(ROW_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(HEADING_TESTID)).toHaveTextContent('| OPEN APPS');

    // ...and the retired persistent dock hooks never reappear alongside it.
    expectNoPersistentChrome();
  });
});
