/**
 * WorkspacePane edge-behavior tests — Spec #2980 ST-4 (rewritten from #2949).
 *
 * Pins the degradation / empty / control contracts on the real
 * `WindowManager` zoned render:
 *
 *   - R-4.4 — an active-layout assignment whose window is not open renders a
 *     `role="status"` degraded zone (`zone-degraded-<id>`) with visible "App not
 *     available" text and a token-first "Remove from zone" control; siblings
 *     keep their exact rects; nothing throws.
 *   - R-4.4 — minimizing keeps the assignment and renders the empty-slot restore
 *     affordance (`workspace-empty-slot-<id>` + `workspace-slot-restore-<id>`);
 *     restoring re-renders the pane.
 *   - R-5.2 — closing a pane drops the window AND its zone assignment; the float
 *     control maximizes into the full-bleed frame.
 *
 * jsdom has no layout engine, so `[data-testid="workspace-layout"]` is stubbed
 * at the prototype level. `settingsService` is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '../WindowManager';
import { getWindowSnapshot, openWindow, resetWindowStoreForTests } from '../windowStore';
import {
  assignWindowToZone,
  getZoneLayoutSnapshot,
  resetZoneLayoutStoreForTests,
  saveZoneLayout,
  setActiveZoneLayout,
  setZoneLayoutEnabled,
} from '../zoneLayoutStore';
import { buildTemplateZones, resolveZoneRect } from '../zoneLayout';
import type { OpenWindowParams } from '../windowTypes';

vi.mock('../../../applications/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../applications/settings')>();
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

describe('WorkspacePane — degraded zone (R-4.4)', () => {
  it('renders a role="status" App-not-available zone and keeps sibling rects', () => {
    openFeature('a');
    setupZones({ ghost: ZONES[0].id, a: ZONES[1].id });

    const { container } = renderWithChakra(<WindowManager />);

    const degraded = screen.getByTestId('zone-degraded-ghost');
    expect(degraded.getAttribute('role')).toBe('status');
    expect(degraded.textContent).toContain('App not available');
    expect(screen.getByTestId('zone-degraded-remove-ghost').textContent).toContain(
      'Remove from zone',
    );

    // The open sibling pane keeps its exact (right-half) rect.
    const paneA = screen.getByTestId('workspace-pane-a');
    const right = resolveZoneRect(WS, ZONES[1], GAP);
    expect(paneA.style.left).toBe(`${right.x}px`);
    expect(paneA.style.width).toBe(`${right.width}px`);

    // No retired divider hooks are produced.
    expect(container.querySelectorAll('[data-testid^="pane-divider-"]')).toHaveLength(0);
  });

  it('removes the assignment from the degraded zone', () => {
    setupZones({ ghost: ZONES[0].id });
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('zone-degraded-remove-ghost'));

    expect(screen.queryByTestId('zone-degraded-ghost')).toBeNull();
    expect(getZoneLayoutSnapshot().assignments).toEqual([]);
  });

  it('renders every unknown assignment without throwing', () => {
    setupZones({ 'ghost-one': ZONES[0].id, 'ghost-two': ZONES[1].id });

    renderWithChakra(<WindowManager />);

    expect(screen.getByTestId('zone-degraded-ghost-one')).toBeTruthy();
    expect(screen.getByTestId('zone-degraded-ghost-two')).toBeTruthy();
  });
});

describe('WorkspacePane — minimize / close (R-4.4, R-5.2)', () => {
  it('minimizing keeps the assignment and renders the empty-slot restore affordance', () => {
    openFeature('a');
    openFeature('b');
    setupZones({ a: ZONES[0].id, b: ZONES[1].id });
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-pane-minimize-a'));

    // The pane leaves the render, but its assignment survives.
    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('workspace-empty-slot-a')).toBeTruthy();
    const restore = screen.getByTestId('workspace-slot-restore-a');
    expect(restore).toBeTruthy();
    expect(getZoneLayoutSnapshot().assignments.map((entry) => entry.windowId)).toEqual(['a', 'b']);
    // The sibling stays an interactive pane.
    expect(screen.getByTestId('workspace-pane-b')).toBeTruthy();

    // Restoring re-renders the pane.
    fireEvent.click(restore);
    expect(screen.getByTestId('workspace-pane-a')).toBeTruthy();
    expect(screen.queryByTestId('workspace-empty-slot-a')).toBeNull();
  });

  it('closing a pane drops the window and its assignment', () => {
    openFeature('a');
    openFeature('b');
    setupZones({ a: ZONES[0].id, b: ZONES[1].id });
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-pane-close-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
    expect(getWindowSnapshot().some((win) => win.id === 'a')).toBe(false);
    expect(getZoneLayoutSnapshot().assignments.map((entry) => entry.windowId)).toEqual(['b']);
    // A cleared assignment never degrades into a placeholder.
    expect(screen.queryByTestId('zone-degraded-a')).toBeNull();
  });

  it('the float control maximizes the pane and clears no assignment', () => {
    openFeature('a');
    setupZones({ a: ZONES[0].id });
    renderWithChakra(<WindowManager />);

    fireEvent.click(screen.getByTestId('workspace-pane-float-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('window-frame-a').style.width).toBe('100%');
    expect(getZoneLayoutSnapshot().assignments.map((entry) => entry.windowId)).toEqual(['a']);
  });
});
