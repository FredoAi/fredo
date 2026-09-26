/**
 * WindowManager tiling-render tests — Spec #2949 ST-2 (R1, R2, R13).
 *
 * Pins the render partition the tiled workspace is built on:
 *
 *   - an open window with NO placement still renders as the existing freeform
 *     `WindowFrame` (R13 — the full-bleed default is untouched);
 *   - a placed, non-maximized, non-minimized window renders as a
 *     `WorkspacePane` at its slot rect, and two of them are visible
 *     SIMULTANEOUSLY without either covering the whole workspace (R1);
 *   - the pane carries the binding `workspace-pane-*` DOM contract (region /
 *     window-id / role / aria / tabIndex / focused + move/float/close controls);
 *   - maximizing (float control) leaves the tiling layer for the full-bleed
 *     frame (R13), and the remaining pane survives;
 *   - the arrangement entry (`workspace-arrange`) places every open
 *     non-minimized window and clears full-bleed (R2).
 *
 * jsdom has no layout engine, so the measured tiling region is stubbed at the
 * prototype level for `[data-testid="workspace-tiles"]` (the element the
 * manager measures via `ResizeObserver`). `settingsService` is mocked (the
 * layout store persists through it) so the suite stays host-agnostic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '../WindowManager';
import {
  focusWindow,
  openWindow,
  resetWindowStoreForTests,
} from '../windowStore';
import {
  addPane,
  resetWorkspaceLayoutStoreForTests,
  setLayoutWorkspace,
} from '../workspaceLayoutStore';
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

/** Open a real kernel-store window; `isMaximized` omitted ⇒ full-bleed default. */
function openFeature(id: string, overrides: Partial<OpenWindowParams> = {}): void {
  openWindow({
    id,
    title: id.toUpperCase(),
    icon: <span data-testid={`icon-${id}`} />,
    component: <div data-testid={`content-${id}`}>{id} body</div>,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    ...overrides,
  });
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
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

describe('WindowManager — render partition (R1, R13)', () => {
  it('renders an un-slotted window as the existing freeform frame (R13 default)', () => {
    openFeature('a');
    const { container } = renderWithChakra(<WindowManager />);

    expect(screen.getByTestId('window-frame-a')).toBeTruthy();
    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    // The tiling layer exists but holds no pane for an un-slotted window.
    expect(container.querySelector('[data-testid="workspace-layout"]')).not.toBeNull();
  });

  it('renders two placed windows as simultaneous panes that share the workspace (R1)', () => {
    setLayoutWorkspace(WS);
    openFeature('a', { isMaximized: false });
    openFeature('b', { isMaximized: false });
    addPane('a', 'left');
    addPane('b', 'right');

    const { container } = renderWithChakra(<WindowManager />);

    const paneA = screen.getByTestId('workspace-pane-a');
    const paneB = screen.getByTestId('workspace-pane-b');
    expect(paneA).toBeTruthy();
    expect(paneB).toBeTruthy();

    // Neither is a full-bleed frame, and the two render side by side.
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
    expect(paneA.style.width).toBe('500px');
    expect(paneA.style.left).toBe('0px');
    expect(paneB.style.left).toBe('500px');
    expect(paneB.style.width).toBe('500px');
    expect(parseFloat(paneA.style.width)).toBeLessThan(WS.width);

    // The binding tiling layer CONTAINS both panes.
    const layer = container.querySelector('[data-testid="workspace-layout"]') as HTMLElement;
    expect(layer.contains(paneA)).toBe(true);
    expect(layer.contains(paneB)).toBe(true);
  });

  it('keeps a maximized window with a placement full-bleed (R13)', () => {
    setLayoutWorkspace(WS);
    openFeature('a'); // full-bleed default
    addPane('a', 'left');

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('window-frame-a').style.width).toBe('100%');
  });

  it('leaves a minimized placed window on the frame path (hidden)', () => {
    setLayoutWorkspace(WS);
    openFeature('a', { isMaximized: false });
    addPane('a', 'left');
    focusWindow('a', { minimize: true });

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    const frame = screen.getByTestId('window-frame-a');
    expect(getComputedStyle(frame).display).toBe('none');
  });
});

describe('WorkspacePane — binding DOM contract', () => {
  it('exposes region / window-id / role / aria / tabIndex / focused + controls', () => {
    setLayoutWorkspace(WS);
    openFeature('a', { isMaximized: false });
    addPane('a', 'left');

    renderWithChakra(<WindowManager />);

    const pane = screen.getByTestId('workspace-pane-a');
    expect(pane.getAttribute('data-pane-region')).toBe('left');
    expect(pane.getAttribute('data-pane-window-id')).toBe('a');
    expect(pane.getAttribute('role')).toBe('region');
    expect(pane.getAttribute('aria-label')).toBe('A');
    expect(pane.getAttribute('data-focused')).toBe('true');
    expect(pane.tabIndex).toBe(0);

    expect(screen.getByTestId('workspace-pane-move-a')).toBeTruthy();
    expect(screen.getByTestId('workspace-pane-float-a')).toBeTruthy();
    expect(screen.getByTestId('workspace-pane-close-a')).toBeTruthy();

    // The window's component renders inside the pane content region.
    expect(screen.getByTestId('workspace-pane-content-a').contains(screen.getByTestId('content-a'))).toBe(true);
  });
});

describe('WindowManager — pane controls (R13)', () => {
  it('the float control un-tiles the pane into the full-bleed frame', () => {
    setLayoutWorkspace(WS);
    openFeature('a', { isMaximized: false });
    openFeature('b', { isMaximized: false });
    addPane('a', 'left');
    addPane('b', 'right');

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('workspace-pane-float-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('window-frame-a').style.width).toBe('100%');
    // The sibling pane is untouched.
    expect(screen.getByTestId('workspace-pane-b')).toBeTruthy();
  });

  it('the close control closes the window and drops its placement', () => {
    setLayoutWorkspace(WS);
    openFeature('a', { isMaximized: false });
    openFeature('b', { isMaximized: false });
    addPane('a', 'left');
    addPane('b', 'right');

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('workspace-pane-close-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
    expect(screen.getByTestId('workspace-pane-b')).toBeTruthy();
  });
});

describe('WindowManager — arrangement entry (R2)', () => {
  it('renders the toolbar only while a window is open', () => {
    renderWithChakra(<WindowManager />);
    expect(screen.queryByTestId('workspace-toolbar')).toBeNull();

    act(() => {
      openFeature('a');
    });
    expect(screen.getByTestId('workspace-toolbar')).toBeTruthy();
  });

  it('arrange places every open non-minimized window and clears full-bleed', () => {
    openFeature('a'); // full-bleed default
    openFeature('b');
    openFeature('c', { isMaximized: true });
    focusWindow('c', { minimize: true }); // minimized ⇒ excluded

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('workspace-arrange'));

    expect(screen.getByTestId('workspace-pane-a')).toBeTruthy();
    expect(screen.getByTestId('workspace-pane-b')).toBeTruthy();
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
    expect(screen.queryByTestId('window-frame-b')).toBeNull();
    // Minimized window is neither arranged nor rendered as a pane.
    expect(screen.queryByTestId('workspace-pane-c')).toBeNull();
  });
});
