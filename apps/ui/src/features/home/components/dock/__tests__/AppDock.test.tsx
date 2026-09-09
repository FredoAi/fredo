/**
 * AppDock AC5-a evidence-completion test (Spec #2838 round-2 fix).
 *
 * Round-1 left AC5-a / R-9 / F-28 (≥6 open apps — the rail scrolls/clips with
 * no dead input and no entry lost) UNVERIFIED because the shipped feature
 * catalog cannot open ≥6 DISTINCT in-dock windows live (kernel single-instance
 * cap + 4-showable grid). The QA plan's pre-sanctioned contingency for that
 * leg is a component-level evidence strategy ("store-level entry-set
 * reconciliation + unit check"), so this file drives `AppDock` with a mocked
 * 8-entry window list and asserts the AC5-a observables against the rendered
 * DOM.
 *
 * Zero product-code changes: `AppDock.tsx` / `DockEntry.tsx` / the window
 * engine are exercised as-is. The window-system hooks are mocked (the
 * established MissionMonitorPanel / SessionTokenBar seam) and framer-motion's
 * `useReducedMotion` is neutralized so the rail renders in jsdom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { act } from '@testing-library/react';
import React from 'react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { WindowEntry } from '@/shared/window-system/windowTypes';
import { AppDock, EDGE_ZONE_PX, DOCK_BOTTOM_KEEP_ZONE_PX, HIDE_DELAY_MS } from '../AppDock';
import { dockEntryLabel } from '../DockEntry';
import { setDockPosition, getDockPosition, resetDockPositionStoreForTests } from '../dockPositionStore';

// ── Mock state (vi.hoisted — referenced by vi.mock factories, mutable per test) ──

const dockState = vi.hoisted(() => ({
  /** Materialized fixture entries (assigned in beforeEach — React not ready during hoist). */
  entries: [] as WindowEntry[],
}));

const actionsState = vi.hoisted(() => ({
  openWindow: vi.fn(),
  closeWindow: vi.fn(),
  focusWindow: vi.fn(),
  updateWindow: vi.fn(),
}));

vi.mock('@/shared/window-system/useWindows', () => ({
  useWindows: () => dockState.entries,
}));

vi.mock('@/shared/window-system/useWindowActions', () => ({
  useWindowActions: () => actionsState,
}));

// The dock's position store persists through settingsService. Mock it so the
// bottom-orientation tests can drive `setDockPosition('bottom')` without a
// Tauri host (same seam as dockPositionStore.test.ts) — the store move + notify
// is synchronous, only the persistence is stubbed.
vi.mock('../../../../settings', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('sidebar'),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

// AppDock reads framer-motion's useReducedMotion unguarded — neutralize it for
// jsdom (established precedent, e.g. MissionMonitorPanel.autofocus.test.tsx).
vi.mock('framer-motion', () => ({ useReducedMotion: () => false }));

// ── Fixture ───────────────────────────────────────────────────────────────────

/** Distinct fixture ids — the AC5-a ≥6 overflow threshold is 8. */
const FIXTURE_IDS = ['app-alpha', 'app-bravo', 'app-charlie', 'app-delta', 'app-echo', 'app-foxtrot', 'app-golf', 'app-hotel'];
/** Distinct titles, one per id. */
const FIXTURE_TITLES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];

function buildEntries(count: number): WindowEntry[] {
  const icon = () => React.createElement('svg');
  return Array.from({ length: count }, (_, i) => ({
    id: FIXTURE_IDS[i],
    title: FIXTURE_TITLES[i],
    icon: icon(),
    component: icon(),
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: false,
    // One focused top entry (index 0, NOT minimized → activation no-op) and
    // one minimized entry (last index → label coverage).
    isMinimized: i === count - 1,
    focused: i === 0,
    zIndex: i + 1,
  }));
}

function revealDock(): void {
  // The rail is visibility:hidden at rest; reveal via the dock's real input
  // path (a passive document pointermove in the left-edge zone). RTL's
  // fireEvent.pointerMove does not set clientX on the jsdom event, so a raw
  // MouseEvent (type 'pointermove') is dispatched — the exact event class the
  // dock listens for.
  act(() => {
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 0 }));
  });
}

/** All entry (icon) buttons in DOM/store order. */
function entryButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-dock-entry]'));
}

/** All dock rows in DOM/store order. */
function dockRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-dock-item]'));
}

afterEach(() => cleanup());

describe('AppDock AC5-a (≥6 apps — scroll/clip, no entry lost, every entry reachable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDockPositionStoreForTests();
    dockState.entries = buildEntries(8);
  });

  it('configures the overflow container and graceful-clip rows (maxHeight + overflowY auto + flex-shrink 0)', () => {
    const { container } = renderWithChakra(<AppDock />);
    revealDock();

    const region = screen.getByRole('region', { name: 'Open applications' });
    expect(region).toBeDefined();

    const list = container.querySelector<HTMLElement>('[role="list"]');
    expect(list).not.toBeNull();
    if (list) {
      // Chakra v3 renders these style props as Emotion classes, so read the
      // computed style (jsdom resolves the injected stylesheet).
      expect(getComputedStyle(list).maxHeight).toBe('min(480px, calc(100vh - 176px))');
      expect(getComputedStyle(list).overflowY).toBe('auto');
    }

    // Every row keeps its fixed height and refuses to squash (scroll/clip
    // instead of collapsing rows when the container shrinks).
    const rows = dockRows(container);
    expect(rows.length).toBe(8);
    rows.forEach((row) => {
      expect(getComputedStyle(row).flexShrink).toBe('0');
    });
  });

  it('renders every fixture entry exactly once, in store order, with no duplicate or missing rows', () => {
    const { container } = renderWithChakra(<AppDock />);
    revealDock();

    const rows = dockRows(container);
    const buttons = entryButtons(container);

    expect(rows.length).toBe(8);
    expect(buttons.length).toBe(8);

    // One row + one icon button per fixture id — no duplicates, none dropped.
    const ids = rows.map((row) => row.getAttribute('data-dock-item')).filter(Boolean);
    expect(ids.length).toBe(8);

    // Accessible names follow dockEntryLabel(title + state) in STORE order.
    const expectedLabels = dockState.entries.map((win) => dockEntryLabel(win));
    const actualLabels = buttons.map((btn) => btn.getAttribute('aria-label'));
    expect(actualLabels).toEqual(expectedLabels);

    // The focused top entry carries aria-current; the minimized tail entry is
    // labelled with its minimized state.
    expect(buttons[0].getAttribute('aria-current')).toBe('step');
    expect(buttons[7].getAttribute('aria-label')).toBe('Hotel (minimized)');
  });

  it('dispatches focusWindow per entry-button click, no-ops the focused top window, and End reaches the last entry', () => {
    const { container } = renderWithChakra(<AppDock />);
    revealDock();
    const buttons = entryButtons(container);

    // Focused top entry (index 0): the consumer-side guard must no-op.
    fireEvent.click(buttons[0]);
    expect(actionsState.focusWindow).not.toHaveBeenCalled();

    // Every other entry is reachable — clicking dispatches focusWindow(id) once.
    for (let i = 1; i < buttons.length; i += 1) {
      fireEvent.click(buttons[i]);
    }
    for (let i = 1; i < dockState.entries.length; i += 1) {
      expect(actionsState.focusWindow).toHaveBeenCalledWith(dockState.entries[i].id);
    }
    expect(actionsState.focusWindow).toHaveBeenCalledTimes(7);

    // Roving keyboard model: End from the first entry reaches the LAST entry
    // (the ≥6-th entry is reachable without loss).
    vi.clearAllMocks();
    act(() => {
      buttons[0].focus();
    });
    act(() => {
      fireEvent.keyDown(buttons[0], { key: 'End' });
    });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe(
      dockEntryLabel(dockState.entries[dockState.entries.length - 1]),
    );
  });

  it('closes only the targeted entry from the overflow region; the rest remain in order after re-render', () => {
    const { container, rerender } = renderWithChakra(<AppDock />);
    revealDock();
    const rows = dockRows(container);
    const lastRow = rows[rows.length - 1];
    const lastId = dockState.entries[dockState.entries.length - 1].id;

    const closeBtn = lastRow.querySelector<HTMLElement>('.dock-close');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn?.getAttribute('aria-label')).toBe(`Close ${FIXTURE_TITLES[FIXTURE_TITLES.length - 1]}`);

    act(() => {
      fireEvent.click(closeBtn as HTMLElement);
    });
    expect(actionsState.closeWindow).toHaveBeenCalledTimes(1);
    expect(actionsState.closeWindow).toHaveBeenCalledWith(lastId);
    // Close must target ONLY that app — no other entry's close fired.
    expect(actionsState.focusWindow).not.toHaveBeenCalled();

    // Store shrinks to 7 (fixture swap = the store's removal semantics) →
    // re-render: closed id gone, other 7 rows remain in store order.
    dockState.entries = buildEntries(7);
    rerender(<AppDock />);
    revealDock();

    const remaining = dockRows(container);
    expect(remaining.length).toBe(7);
    const remainingButtons = entryButtons(container);
    expect(remainingButtons.length).toBe(7);
    const remainingLabels = remainingButtons.map((btn) => btn.getAttribute('aria-label'));
    expect(remainingLabels).toEqual(dockState.entries.map((win) => dockEntryLabel(win)));
    expect(remainingLabels.some((label) => label?.includes(FIXTURE_TITLES[7]))).toBe(false);
  });
});

// ── Bottom-orientation behavior (Spec #2848 ST-3b) ─────────────────────────────
// The bottom-center dock mirrors the sidebar reveal/keep + roving model on the
// Y axis. These tests drive `AppDock` in the `position: 'bottom'` store state
// (set BEFORE render — the position is read at mount) and exercise the real
// document-pointermove input path with a raw MouseEvent (the same seam the
// sidebar reveal tests use) so the covered-branch edge-peek machine, the
// orientation-aware predicates, and the roving keys are all exercised as-is.

function bottomRevealPointerMove(): void {
  // Bottom reveal zone: `clientY >= innerHeight - EDGE_ZONE_PX`. Dispatch the
  // raw MouseEvent class the dock listens for (jsdom fireEvent does not set
  // coordinates).
  document.dispatchEvent(
    new MouseEvent('pointermove', { clientX: window.innerWidth / 2, clientY: window.innerHeight - EDGE_ZONE_PX }),
  );
}

function bottomAboveKeepZonePointerMove(): void {
  // Above the bottom keep-zone band (inside the reveal axis but far from the
  // docked edge) — the pointer "left" the dock + its keep zone.
  document.dispatchEvent(
    new MouseEvent('pointermove', {
      clientX: window.innerWidth / 2,
      clientY: window.innerHeight - DOCK_BOTTOM_KEEP_ZONE_PX - 50,
    }),
  );
}

describe('AppDock bottom orientation (Spec #2848 ST-3b — render, roving, reveal/keep on the Y axis)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetDockPositionStoreForTests();
    dockState.entries = buildEntries(8);
    // Drive the dock to the bottom position BEFORE mount (the component reads
    // the module store at render time). settingsService is mocked — the store
    // move + subscriber notify is synchronous, only the persistence is stubbed.
    await act(async () => {
      await setDockPosition('bottom');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDockPositionStoreForTests();
  });

  it('renders the bottom-anchored centered dock (fixed bottom inset + centered + horizontal pill + horizontal list flow)', () => {
    const { container } = renderWithChakra(<AppDock />);
    act(() => {
      bottomRevealPointerMove();
    });

    const region = screen.getByRole('region', { name: 'Open applications' });
    expect(region).toBeDefined();

    // Bottom-center anchoring: `bottom: 12px` resting inset + `left: 50%`.
    expect(getComputedStyle(region).bottom).toBe('12px');
    expect(getComputedStyle(region).left).toBe('50%');

    // The pill (the region's direct child) is a horizontal track of pill height.
    const pill = region.firstElementChild as HTMLElement | null;
    expect(pill).not.toBeNull();
    if (pill) {
      expect(getComputedStyle(pill).height).toBe('52px');
      expect(getComputedStyle(pill).flexDirection).toBe('row');
    }

    // The entry list flows horizontally (overflowX auto past the width clamp).
    const list = container.querySelector<HTMLElement>('[role="list"]');
    expect(list).not.toBeNull();
    if (list) {
      expect(getComputedStyle(list).flexDirection).toBe('row');
      expect(getComputedStyle(list).overflowX).toBe('auto');
    }
  });

  it('roves with ArrowLeft/ArrowRight (not ArrowUp/ArrowDown) when the position is bottom', () => {
    const { container } = renderWithChakra(<AppDock />);
    act(() => {
      bottomRevealPointerMove();
    });
    const buttons = entryButtons(container);

    // Focus a middle entry (index 1) — a real keyboard-roving start point.
    act(() => {
      buttons[1].focus();
    });
    expect(document.activeElement).toBe(buttons[1]);

    // ArrowLeft roves back to index 0.
    act(() => {
      fireEvent.keyDown(buttons[1], { key: 'ArrowLeft' });
    });
    expect(document.activeElement).toBe(buttons[0]);

    // ArrowRight roves forward.
    act(() => {
      fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
    });
    expect(document.activeElement).toBe(buttons[1]);
    act(() => {
      fireEvent.keyDown(buttons[1], { key: 'ArrowRight' });
    });
    expect(document.activeElement).toBe(buttons[2]);

    // The vertical arrows do NOT rove in the bottom orientation.
    act(() => {
      fireEvent.keyDown(buttons[2], { key: 'ArrowDown' });
    });
    expect(document.activeElement).toBe(buttons[2]);
    act(() => {
      fireEvent.keyDown(buttons[2], { key: 'ArrowUp' });
    });
    expect(document.activeElement).toBe(buttons[2]);

    // Home/End reach the first/last entry (unchanged semantics).
    act(() => {
      fireEvent.keyDown(buttons[2], { key: 'End' });
    });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    act(() => {
      fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Home' });
    });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('reveals when the pointer reaches the bottom edge (covered desktop → edge-peek on the Y axis)', () => {
    renderWithChakra(<AppDock />);

    // Covered desktop (non-minimized windows): the dock starts off-canvas and
    // out of the a11y tree.
    expect(screen.queryByRole('region', { name: 'Open applications' })).toBeNull();

    act(() => {
      bottomRevealPointerMove();
    });
    const region = screen.getByRole('region', { name: 'Open applications' });
    expect(region).toBeVisible();
  });

  it('hides after the pointer leaves the bottom keep zone for the hide-delay grace', () => {
    vi.useFakeTimers();
    renderWithChakra(<AppDock />);

    act(() => {
      bottomRevealPointerMove();
    });
    const region = screen.getByRole('region', { name: 'Open applications' });
    expect(region).toBeVisible();

    // Pointer moves above the bottom keep-zone band → the hide timer arms.
    act(() => {
      bottomAboveKeepZonePointerMove();
    });
    // Before the grace elapses the dock is still revealed.
    expect(screen.getByRole('region', { name: 'Open applications' })).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS);
    });
    expect(screen.queryByRole('region', { name: 'Open applications' })).toBeNull();
  });
});

// ── Round-2 FD-4 (F-3 / E-9 fix regressions) ─────────────────────────────────
// FD-1 boot hydration: AppDock's first mount must trigger the module store's
// once-only `hydrateDockPosition()`, so a persisted 'bottom' renders the bottom
// pill WITHOUT any Settings mount. FD-2: the active entry's bar axis follows the
// orientation (left-edge `inset 3px 0` in the sidebar, bottom-edge
// `inset 0 -3px` in the bottom bar).

import { settingsService } from '../../../../settings';

describe('AppDock boot hydration (Spec #2848 round-2 FD-1 — F-3 regression)', () => {
  beforeEach(() => {
    resetDockPositionStoreForTests();
    // The persisted value ('bottom') is what AppDock's mount hydration must read.
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue('bottom');
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('mounts AppDock with settingsService.get resolving "bottom" and renders the bottom pill WITHOUT any Settings mount', async () => {
    dockState.entries = buildEntries(8);

    renderWithChakra(<AppDock />);

    // AppDock's boot mount effect fires hydration → the async settingsService.get
    // resolves 'bottom' → notify() → re-render to the bottom pill. Flush the
    // microtask chain inside act.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The persisted position was applied WITHOUT any Settings surface.
    expect(getDockPosition()).toBe('bottom');
    expect(screen.queryByRole('combobox', { name: 'Dock position' })).toBeNull();

    // Reveal the dock (covered desktop starts off-canvas) and assert the BOTTOM
    // pill geometry — the F-3 observable at boot.
    act(() => {
      bottomRevealPointerMove();
    });
    const region = screen.getByRole('region', { name: 'Open applications' });
    expect(region).toBeDefined();
    expect(getComputedStyle(region).bottom).toBe('12px');
    expect(getComputedStyle(region).left).toBe('50%');
    const pill = region.firstElementChild as HTMLElement | null;
    expect(pill).not.toBeNull();
    if (pill) {
      expect(getComputedStyle(pill).height).toBe('52px');
      expect(getComputedStyle(pill).flexDirection).toBe('row');
    }
  });
});

describe('AppDock active-bar axis (Spec #2848 round-2 FD-2 — E-9 regression)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetDockPositionStoreForTests();
    dockState.entries = buildEntries(8);
    // Default persisted value ('sidebar') — the sidebar leg of this describe
    // relies on hydration resolving the DEFAULT so the store never flips.
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue('sidebar');
  });

  it('renders the left-edge bar (`inset 3px 0`) on the active entry in the SIDEBAR orientation', () => {
    const { container } = renderWithChakra(<AppDock />);
    act(() => {
      revealDock();
    });
    // The dock is in the default sidebar store state → hydration is a no-op
    // (settingsService.get resolves 'sidebar' via the module mock).
    const buttons = entryButtons(container);
    const activeBtn = buttons[0]; // buildEntries: index 0 is focused + not minimized
    expect(activeBtn.getAttribute('aria-current')).toBe('step');
    // The `css` prop emits an Emotion class → read the resolved cascade from
    // jsdom's injected stylesheet (same read the existing maxHeight assertions use).
    expect(getComputedStyle(activeBtn).boxShadow).toBe('inset 3px 0 0 0 var(--accent-primary)');
  });

  it('renders the bottom-edge bar (`inset 0 -3px`) on the active entry in the BOTTOM orientation', async () => {
    await act(async () => {
      await setDockPosition('bottom');
    });
    const { container } = renderWithChakra(<AppDock />);
    act(() => {
      bottomRevealPointerMove();
    });
    const buttons = entryButtons(container);
    expect(buttons.length).toBe(8);
    const activeBtn = buttons[0];
    expect(activeBtn.getAttribute('aria-current')).toBe('step');
    expect(getComputedStyle(activeBtn).boxShadow).toBe('inset 0 -3px 0 0 var(--accent-primary)');
  });
});
