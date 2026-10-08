/**
 * WindowManager zone-partition tests — Spec #2980 ST-4 (R-3.1, R-4.3, R-4.4,
 * R-5.1). Pins the zoned render path on the real manager:
 *
 *   - the retired arrangement chrome (`workspace-toolbar`, presets,
 *     `workspace-arrange`, `workspace-announcer`, `layout-menu-button`) is ABSENT
 *     (R-5.1);
 *   - an open window with NO assignment renders as the freeform float (R-3.3);
 *   - an assigned open window renders as `workspace-pane-<id>` at its
 *     `resolveZoneRect` px rect with `data-zone-id`/`data-zone-layout-id` (R-4.3);
 *   - the zone overlay + one target per zone appear ONLY while `dragActive`
 *     (R-3.1);
 *   - an assignment whose window is not open renders `zone-degraded-<id>`
 *     (R-4.4);
 *   - a minimized zoned pane renders `workspace-empty-slot-<id>` + restore;
 *   - the measured workspace is reported through `setZoneLayoutWorkspace`.
 *
 * jsdom has no layout engine, so `[data-testid="workspace-layout"]` is stubbed
 * at the prototype level. `settingsService` is mocked (the zone store persists
 * through it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '../WindowManager';
import { openWindow, resetWindowStoreForTests } from '../windowStore';
import {
  assignWindowToZone,
  beginZoneDrag,
  cancelZoneDrag,
  getZoneLayoutWorkspace,
  resetZoneLayoutStoreForTests,
  saveZoneLayout,
  setActiveZoneLayout,
  setZoneLayoutEnabled,
  updateZoneDragPointer,
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

/** Enable management, save + assign a 2-zone layout, and place `assignments`. */
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

describe('WindowManager — retired arrangement chrome (R-5.1)', () => {
  it('renders no toolbar / presets / arrange / announcer / layout menu', () => {
    openFeature('a');
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);

    for (const testid of [
      'workspace-toolbar',
      'workspace-arrange',
      'workspace-announcer',
      'workspace-preset-single',
      'workspace-preset-columns-2',
      'layout-menu-button',
    ]) {
      expect(screen.queryByTestId(testid), `${testid} must be absent`).toBeNull();
    }
    // The zone overlay is not mounted outside a drag gesture.
    expect(screen.queryByTestId('zone-overlay')).toBeNull();
  });
});

describe('WindowManager — zone partition (R-4.3, R-3.3)', () => {
  it('renders a window with NO assignment as the freeform frame', () => {
    openFeature('a');
    setupZones({});

    renderWithChakra(<WindowManager />);

    expect(screen.getByTestId('window-frame-a')).toBeTruthy();
    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
  });

  it('renders an assigned open window as a zone pane at resolveZoneRect', () => {
    openFeature('a');
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);

    const pane = screen.getByTestId('workspace-pane-a');
    expect(pane.getAttribute('data-zone-id')).toBe(ZONES[0].id);
    expect(pane.getAttribute('data-zone-layout-id')).toBe(LAYOUT_ID);
    const rect = resolveZoneRect(WS, ZONES[0], GAP);
    expect(pane.style.left).toBe(`${rect.x}px`);
    expect(pane.style.top).toBe(`${rect.y}px`);
    expect(pane.style.width).toBe(`${rect.width}px`);
    expect(pane.style.height).toBe(`${rect.height}px`);
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
  });

  it('renders two assigned windows as simultaneous panes in their zones', () => {
    openFeature('a');
    openFeature('b');
    setupZones({ a: ZONES[0].id, b: ZONES[1].id });

    renderWithChakra(<WindowManager />);

    const left = resolveZoneRect(WS, ZONES[0], GAP);
    const right = resolveZoneRect(WS, ZONES[1], GAP);
    expect(screen.getByTestId('workspace-pane-a').style.left).toBe(`${left.x}px`);
    expect(screen.getByTestId('workspace-pane-b').style.left).toBe(`${right.x}px`);
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
    expect(screen.queryByTestId('window-frame-b')).toBeNull();
  });

  it('renders NO pane while layout management is disabled', () => {
    openFeature('a');
    saveZoneLayout({ id: LAYOUT_ID, name: 'Work', template: 'columns', zones: ZONES });
    setActiveZoneLayout(LAYOUT_ID);
    assignWindowToZone('a', ZONES[0].id);
    // enabled stays false (store default) — the assignment is inert (R-3.3).

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('window-frame-a')).toBeTruthy();
  });

  it('reports the measured workspace via setZoneLayoutWorkspace', () => {
    openFeature('a');
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);

    expect(getZoneLayoutWorkspace()).toEqual({
      left: 0,
      top: 0,
      width: WS.width,
      height: WS.height,
    });
  });
});

describe('WindowManager — zone overlay (R-3.1)', () => {
  it('shows the overlay + one target per zone only while dragActive', () => {
    openFeature('a');
    setupZones({});

    renderWithChakra(<WindowManager />);

    expect(screen.queryByTestId('zone-overlay')).toBeNull();

    act(() => {
      beginZoneDrag('a');
    });

    expect(screen.getByTestId('zone-overlay')).toBeTruthy();
    expect(screen.getAllByTestId(/^zone-target-/)).toHaveLength(ZONES.length);
    expect(screen.getByTestId('zone-announcer')).toBeTruthy();

    act(() => {
      cancelZoneDrag();
    });

    expect(screen.queryByTestId('zone-overlay')).toBeNull();
  });

  it('highlights the zone under the pointer during the drag', () => {
    openFeature('a');
    setupZones({});

    renderWithChakra(<WindowManager />);

    act(() => {
      beginZoneDrag('a');
    });
    // Zone 0's resolved rect starts at (gap/2, gap/2) — the top-left corner.
    act(() => {
      updateZoneDragPointer(GAP / 2, GAP / 2);
    });

    expect(screen.getByTestId(`zone-target-${ZONES[0].id}`).getAttribute('data-hovered')).toBe(
      'true',
    );
    expect(screen.getByTestId(`zone-target-${ZONES[1].id}`).getAttribute('data-hovered')).toBe(
      'false',
    );
  });
});

describe('WindowManager — degraded / empty zone placeholders (R-4.4)', () => {
  it('renders zone-degraded-<id> for an assignment whose window is closed', () => {
    setupZones({ ghost: ZONES[1].id });

    renderWithChakra(<WindowManager />);

    const degraded = screen.getByTestId('zone-degraded-ghost');
    expect(degraded.getAttribute('role')).toBe('status');
    expect(degraded.getAttribute('data-zone-id')).toBe(ZONES[1].id);
    expect(degraded.textContent).toContain('App not available');
  });

  it('removes a degraded assignment from the zone', () => {
    setupZones({ ghost: ZONES[1].id });

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('zone-degraded-remove-ghost'));

    expect(screen.queryByTestId('zone-degraded-ghost')).toBeNull();
  });

  it('renders a minimized zoned pane as workspace-empty-slot + restore', () => {
    openFeature('a');
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('workspace-pane-minimize-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('workspace-empty-slot-a')).toBeTruthy();

    fireEvent.click(screen.getByTestId('workspace-slot-restore-a'));
    expect(screen.getByTestId('workspace-pane-a')).toBeTruthy();
    expect(screen.queryByTestId('workspace-empty-slot-a')).toBeNull();
  });
});

describe('WindowManager — pane controls keep the kernel contract (R-5.2)', () => {
  it('the float control maximizes the pane into the full-bleed frame', () => {
    openFeature('a');
    setupZones({ a: ZONES[0].id });

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('workspace-pane-float-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.getByTestId('window-frame-a').style.width).toBe('100%');
  });

  it('the close control closes the window and clears its assignment', () => {
    openFeature('a');
    openFeature('b');
    setupZones({ a: ZONES[0].id, b: ZONES[1].id });

    renderWithChakra(<WindowManager />);
    fireEvent.click(screen.getByTestId('workspace-pane-close-a'));

    expect(screen.queryByTestId('workspace-pane-a')).toBeNull();
    expect(screen.queryByTestId('window-frame-a')).toBeNull();
    expect(screen.queryByTestId('zone-degraded-a')).toBeNull();
    expect(screen.getByTestId('workspace-pane-b')).toBeTruthy();
  });
});
