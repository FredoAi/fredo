/**
 * WindowManager partition tests — Spec #2980 ST-4 (rewritten from #2949 ST-2).
 *
 * Pins the render partition the zoned workspace is built on:
 *
 *   - an open window with NO assignment renders as the existing freeform
 *     `WindowFrame` (R-3.3 / R-5.2 — the full-bleed default is untouched);
 *   - a window holding an assignment in the active layout renders as a
 *     `WorkspacePane` at its `resolveZoneRect` px rect, and two of them are
 *     visible SIMULTANEOUSLY (R-4.3);
 *   - the pane carries the binding `workspace-pane-*` DOM contract (zone id /
 *     layout id / window id / role / aria / tabIndex / focused + float/close
 *     controls);
 *   - maximizing (float control) leaves the zoned layer for the full-bleed
 *     frame (R-5.2), and the sibling pane survives;
 *   - the retired arrangement toolbar is never rendered (R-5.1).
 *
 * jsdom has no layout engine, so `[data-testid="workspace-layout"]` is stubbed
 * at the prototype level. `settingsService` is mocked (the zone store persists
 * through it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '../WindowManager';
import { focusWindow, openWindow, resetWindowStoreForTests } from '../windowStore';
import {
  assignWindowToZone,
  resetZoneLayoutStoreForTests,
  saveZoneLayout,
  setActiveZoneLayout,
  setZoneLayoutEnabled,
} from '../zoneLayoutStore';
import { buildTemplateZones, resolveZoneRect } from '../zoneLayout';
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
const GAP = 8;
const LAYOUT_ID = 'layout-work';
const ZONES = buildTemplateZones('columns', { columns: 2 });

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

/** Open a real kernel-store window; `isMaximized: false` ⇒ floating. */
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

function setupZones(assignments: Record<string, string> = {}): void {
  saveZoneLayout({ id: LAYOUT_ID, name: 'Work', template: 'columns', zones: ZONES });
  setActiveZoneLayout(LAYOUT_ID);
  setZoneLayoutEnabled(true);
  for (const [windowId, zoneId] of Object.entries(assignments)) {
    assignWindowToZone(windowId, zoneId);
  }
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetZoneLayoutStoreForTests();
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'workspace-layout') {
        return rectOf(WS.width, WS.height);
      }
      return rectOf(0, 0);
    });
});

afterEach(() => {
  rectSpy.mockRestore();
  cleanup();
  resetWindowStoreForTests();
  resetZoneLayoutStoreForTests();
});

describe('WindowManager — render partition (R-4.3, R-5.2)', () => {
  it('renders an unassigned window as the existing freeform frame (R-3.3)', () => {
    openFeature('a', { isMaximized: false });
    setupZones({});

    const { container } = renderWithChakra(<WindowManager />);

    expect(screen.getByTestId('window-frame-a')).toBeTruthy();
    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-layout"]')).not.toBeNull();
  });

  it('renders two assigned windows as simultaneous panes that share the workspace (R-4.3)', () => {
    openFeature('a', { isMaximized: false });
    openFeature('b', { isMaximized: false });
    setupZones({ a: ZONES[0].id, b: ZONES[1].id });

    const { container } = renderWithChakra(<WindowManager />);

    const paneA = screen.getByTestId('workspace-pane-a');
    const paneB = screen.getByTestId('workspace-pane-b');
    expect(paneA).toBeTruthy();
    expect(paneB).toBeTruthy();

    const left = resolveZoneRect(WS, ZONES[0], GAP);
    const right = resolveZoneRect(WS, ZONES[1], GAP);
    expect(paneA.style.left).toBe(`${left.x}px`);
    expect(paneA.style.width).toBe(`${left.width}px`);
    expect(paneB.style.left).toBe(`${right.x}px`);
    expect(parseFloat(paneA.style.width)).toBeLessThan(WS.width);
    expect(screen.queryByTestId('window-frame-a')).toBeNull();

    // The binding tiling layer CONTAINS both panes.
    const layer = container.querySelector('[data-testid="workspace-layout"]') as HTMLElement;
    expect(layer.contains(paneA)).toBe(true);
    expect(layer.contains(paneB)).toBe(true);
  });

  it('keeps a maximized assigned window full-bleed (R-5.2)', () => {
    openFeature('a'); // full-bleed default
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('window-frame-a').style.width).toBe('100%');
  });
});

describe('WorkspacePane — binding DOM contract', () => {
  it('exposes zone / layout / window / role / aria / tabIndex / focused + controls', () => {
    openFeature('a', { isMaximized: false });
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);

    const pane = screen.getByTestId('workspace-pane-a');
    expect(pane.getAttribute('data-zone-id')).toBe(ZONES[0].id);
    expect(pane.getAttribute('data-zone-layout-id')).toBe(LAYOUT_ID);
    expect(pane.getAttribute('data-zone-window-id')).toBe('a');
    expect(pane.getAttribute('role')).toBe('region');
    expect(pane.getAttribute('aria-label')).toBe('A');
    expect(pane.getAttribute('data-focused')).toBe('true');
    expect(pane.tabIndex).toBe(0);

    expect(screen.getByTestId('workspace-pane-float-a')).toBeTruthy();
    expect(screen.getByTestId('workspace-pane-close-a')).toBeTruthy();

    // The window's component renders inside the pane content region.
    expect(
      screen.getByTestId('workspace-pane-content-a').contains(screen.getByTestId('content-a')),
    ).toBe(true);
  });

  it('renders no retired grip or region-overlay hooks', () => {
    openFeature('a', { isMaximized: false });
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('workspace-pane-move-a')).toBeNull();
    expect(screen.queryByTestId(/^pane-region-/)).toBeNull();
    expect(screen.queryByTestId(/^pane-divider-/)).toBeNull();
  });
});

describe('WindowManager — pane controls (R-5.2)', () => {
  it('the float control un-zones the pane into the full-bleed frame', () => {
    openFeature('a', { isMaximized: false });
    openFeature('b', { isMaximized: false });
    setupZones({ a: ZONES[0].id, b: ZONES[1].id });

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('workspace-pane-float-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('window-frame-a').style.width).toBe('100%');
    // The sibling pane is untouched.
    expect(screen.getByTestId('workspace-pane-b')).toBeTruthy();
  });

  it('a minimized assigned window keeps its zone as a hidden frame', () => {
    openFeature('a', { isMaximized: false });
    setupZones({ a: ZONES[0].id });
    focusWindow('a', { minimize: true });

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('workspace-empty-slot-a')).toBeTruthy();
    const frame = screen.getByTestId('window-frame-a');
    expect(getComputedStyle(frame).display).toBe('none');
  });
});

describe('WindowManager — retired toolbar (R-5.1)', () => {
  it('never renders the arrangement toolbar', () => {
    openFeature('a', { isMaximized: false });
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('workspace-toolbar')).toBeNull();
    expect(screen.queryByTestId('workspace-arrange')).toBeNull();
    expect(screen.queryByTestId('workspace-announcer')).toBeNull();
  });
});
