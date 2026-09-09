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
import { AppDock } from '../AppDock';
import { dockEntryLabel } from '../DockEntry';

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
