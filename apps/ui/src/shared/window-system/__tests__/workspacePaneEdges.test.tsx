/**
 * WorkspacePane edge-behavior tests — Spec #2949 ST-6 (R9/R10) + ST-7 (R12).
 *
 * Pins the degradation, reflow and keyboard contracts on the real
 * `WindowManager` render:
 *
 *   - R9 — a placement with no matching open window renders a `role="status"`
 *     degraded slot (`workspace-pane-degraded-<id>`) with visible "App not
 *     available" text and a Close-slot control; siblings keep their exact rects;
 *     no divider is produced for the degraded slot; nothing throws.
 *   - R10 — minimizing keeps the `PaneSlot` and renders the empty-slot restore
 *     affordance (`workspace-slot-restore-<id>`); restoring re-tiles the pane.
 *     Closing a pane drops the placement and reflows the freed space into the
 *     sibling (no orphan divider).
 *   - R12 — Arrow keys move focus between panes, with a boundary no-op; the
 *     divider keeps its own Arrow-resize (the pane handler never hijacks it);
 *     panes/dividers stay Tab-reachable and the focus cue is not colour-only.
 *
 * jsdom has no layout engine, so the measured tiling region is stubbed at the
 * prototype level for `[data-testid="workspace-tiles"]`. `settingsService` is
 * mocked (the layout store persists through it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '../WindowManager';
import {
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '../windowStore';
import {
  addPane,
  getLayoutSnapshot,
  resetWorkspaceLayoutStoreForTests,
  setLayoutWorkspace,
} from '../workspaceLayoutStore';
import { DIVIDER_KEYBOARD_STEP } from '../PaneDivider';
import type { OpenWindowParams } from '../windowTypes';

vi.mock('../../../features/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../features/settings')>();
  return {
    ...actual,
    settingsService: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const WS = { width: 1000, height: 800 };

function rectOf(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function openFeature(id: string, overrides: Partial<OpenWindowParams> = {}): void {
  openWindow({
    id,
    title: id.toUpperCase(),
    icon: <span data-testid={`icon-${id}`} />,
    component: <div data-testid={`content-${id}`}>{id} body</div>,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    isMaximized: false,
    ...overrides,
  });
}

/** Two tiled panes side by side: `a` left, `b` right. */
function twoPanes(): void {
  openFeature('a');
  openFeature('b');
  addPane('a', 'left');
  addPane('b', 'right');
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
  setLayoutWorkspace(WS);
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'workspace-tiles') {
        return rectOf(WS.width, WS.height);
      }
      return rectOf(0, 0);
    });
});

afterEach(() => {
  rectSpy.mockRestore();
  cleanup();
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
});

describe('WorkspacePane — degraded slot (R9)', () => {
  it('renders a role="status" App-not-available slot and keeps sibling rects', () => {
    openFeature('a');
    addPane('ghost', 'left');
    addPane('a', 'right');

    const { container } = renderWithChakra(<WindowManager />);

    const degraded = screen.getByTestId('workspace-pane-degraded-ghost');
    expect(degraded.getAttribute('role')).toBe('status');
    expect(degraded.textContent).toContain('App not available');

    // The open sibling pane keeps its exact (right-half) rect.
    const paneA = screen.getByTestId('workspace-pane-a');
    expect(paneA.style.left).toBe('500px');
    expect(paneA.style.width).toBe('500px');

    // A degraded slot must NOT produce a divider.
    expect(container.querySelectorAll('[data-testid^="pane-divider-"]')).toHaveLength(0);
  });

  it('closes the placement from the degraded slot and reflows the sibling', () => {
    openFeature('a');
    addPane('ghost', 'left');
    addPane('a', 'right');
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-degraded-close-ghost'));

    expect(screen.queryByTestId('workspace-pane-degraded-ghost')).toBeNull();
    const paneA = screen.getByTestId('workspace-pane-a');
    expect(paneA.style.left).toBe('0px');
    expect(paneA.style.width).toBe('1000px');
  });

  it('renders every unknown placement without throwing', () => {
    addPane('ghost-one', 'left');
    addPane('ghost-two', 'right');

    renderWithChakra(<WindowManager />);

    expect(screen.getByTestId('workspace-pane-degraded-ghost-one')).toBeTruthy();
    expect(screen.getByTestId('workspace-pane-degraded-ghost-two')).toBeTruthy();
  });
});

describe('WorkspacePane — minimize / close reflow (R10)', () => {
  it('minimizing keeps the PaneSlot and renders the empty-slot restore affordance', () => {
    twoPanes();
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-pane-minimize-a'));

    // The pane leaves the render, but its slot survives.
    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('workspace-empty-slot-a')).toBeTruthy();
    const restore = screen.getByTestId('workspace-slot-restore-a');
    expect(restore).toBeTruthy();
    expect(getLayoutSnapshot().activeSlots.map((s) => s.windowId)).toEqual(['a', 'b']);
    // The sibling stays an interactive pane.
    expect(screen.getByTestId('workspace-pane-b')).toBeTruthy();

    // Restoring re-tiles the pane.
    fireEvent.click(restore);
    expect(screen.getByTestId('workspace-pane-a')).toBeTruthy();
    expect(screen.queryByTestId('workspace-empty-slot-a')).toBeNull();
  });

  it('closing a pane drops its placement and reflows the sibling (no orphan divider)', () => {
    twoPanes();
    const { container } = renderWithChakra(<WindowManager />);
    expect(container.querySelector('[data-testid="pane-divider-vertical:a:b"]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('workspace-pane-close-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    const paneB = screen.getByTestId('workspace-pane-b');
    expect(paneB.style.left).toBe('0px');
    expect(paneB.style.width).toBe('1000px');
    expect(container.querySelectorAll('[data-testid^="pane-divider-"]')).toHaveLength(0);
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
  });

  it('closing the last pane clears the arrangement (plain desktop)', () => {
    openFeature('a');
    addPane('a', 'center');
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-pane-close-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(getLayoutSnapshot().activeSlots).toEqual([]);
  });
});

describe('WorkspacePane — keyboard reachability (R12)', () => {
  it('moves focus to the neighbouring pane with Arrow keys', () => {
    twoPanes();
    renderWithChakra(<WindowManager />);

    const paneA = screen.getByTestId('workspace-pane-a');
    const paneB = screen.getByTestId('workspace-pane-b');
    paneA.focus();

    fireEvent.keyDown(paneA, { key: 'ArrowRight' });

    expect(document.activeElement).toBe(paneB);
    expect(getWindowSnapshot().find((w) => w.id === 'b')?.focused).toBe(true);
  });

  it('is a boundary no-op at the last pane (no focus trap)', () => {
    twoPanes();
    renderWithChakra(<WindowManager />);

    const paneB = screen.getByTestId('workspace-pane-b');
    paneB.focus();
    fireEvent.keyDown(paneB, { key: 'ArrowRight' });

    expect(document.activeElement).toBe(paneB);
  });

  it('never hijacks the divider Arrow-resize', () => {
    twoPanes();
    renderWithChakra(<WindowManager />);

    fireEvent.keyDown(screen.getByTestId('pane-divider-vertical:a:b'), { key: 'ArrowRight' });

    const a = getLayoutSnapshot().activeSlots.find((s) => s.windowId === 'a')!;
    expect(a.rect.width).toBe(500 + DIVIDER_KEYBOARD_STEP);
  });

  it('keeps panes and the divider Tab-reachable with a non-colour-only focus cue', () => {
    twoPanes();
    renderWithChakra(<WindowManager />);

    const paneA = screen.getByTestId('workspace-pane-a');
    expect(paneA.tabIndex).toBe(0);
    expect(paneA.getAttribute('role')).toBe('region');

    const divider = screen.getByTestId('pane-divider-vertical:a:b');
    expect(divider.tabIndex).toBe(0);
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-label')).toBe('Resize panes');

    // The focused pane (the last opened = b) marks its title (weight + colour
    // change), so the cue is never colour-only.
    const focusedPane = screen.getByTestId('workspace-pane-b');
    expect(focusedPane.getAttribute('data-focused')).toBe('true');
    expect(focusedPane.querySelector('[data-focused-title="true"]')).not.toBeNull();
  });
});
