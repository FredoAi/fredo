/**
 * Pane move-to-region + divider resize gesture tests — Spec #2949 ST-3
 * (R3, R4, and the R5 CONTINUOUS-STATE line / G-123).
 *
 * Pins the core interaction end-to-end through the real render:
 *
 *   - R3 — the move grip enters move mode and portals all NINE region drop
 *     targets (`pane-region-${region}` + `data-pane-drop-region`); clicking a
 *     zone commits `movePane`, Arrow+Enter commits via keyboard, Escape cancels
 *     the whole gesture without touching the arrangement.
 *   - R4 — one `<PaneDivider>` renders per `computeDividers` shared edge with the
 *     binding separator contract; pointer drag resizes BOTH adjacent panes with
 *     their combined extent held constant; Arrow keys resize by a fixed step.
 *   - R5 — the gesture is wrapped in `beginLayoutGesture`/`endLayoutGesture`:
 *     the live snapshot mutates on the coalesced frame while persistence is
 *     suppressed for the whole drag and written exactly once on release; Escape
 *     restores the pre-drag geometry.
 *
 * jsdom has no layout engine, so the measured tiling region is stubbed at the
 * prototype level for `[data-testid="workspace-tiles"]` (mirrors
 * `WindowManager.test.tsx`). `settingsService` is mocked (the layout store
 * persists through it) so the suite stays host-agnostic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowManager } from '../WindowManager';
import { openWindow, resetWindowStoreForTests } from '../windowStore';
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

import { settingsService } from '../../../features/settings';

const setMock = settingsService.set as unknown as ReturnType<typeof vi.fn>;

// jsdom (v24) does not implement PointerEvent, so `fireEvent.pointerMove` would
// drop `clientX`/`clientY` and every drag would read a NaN/0 delta. A
// MouseEvent-backed polyfill restores the coordinate transport the gesture code
// legitimately relies on in a real WebView2.
class TestPointerEvent extends MouseEvent {
  public pointerId: number;

  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 0;
  }
}

if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  (window as unknown as { PointerEvent: typeof TestPointerEvent }).PointerEvent = TestPointerEvent;
}

const WS = { width: 1000, height: 800 };

/** The nine binding region drop targets, in canonical order. */
const REGIONS = [
  'center',
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

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

/** Two tiled panes: `a` left, `b` right → one shared vertical edge. */
function renderTwoPanes(): void {
  openFeature('a');
  openFeature('b');
  addPane('a', 'left');
  addPane('b', 'right');
  renderWithChakra(<WindowManager />);
}

/** Flush one animation frame (the coalescing boundary of a drag). */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(() => resolve(), 0);
      }
    });
  });
}

/** Let the debounced persistence write land. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

function slotOf(windowId: string) {
  return getLayoutSnapshot().activeSlots.find((slot) => slot.windowId === windowId)!;
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetWorkspaceLayoutStoreForTests();
  setLayoutWorkspace(WS);
  setMock.mockClear();
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

describe('WorkspacePane — move-to-region (R3)', () => {
  it('enters move mode from the grip and renders all nine region drop zones', () => {
    renderTwoPanes();

    fireEvent.click(screen.getByTestId('workspace-pane-move-a'));

    for (const region of REGIONS) {
      const zone = screen.getByTestId(`pane-region-${region}`);
      expect(zone.getAttribute('data-pane-drop-region')).toBe(region);
      expect(zone.getAttribute('data-hovered')).toBe(region === 'left' ? 'true' : 'false');
    }
    expect(screen.getByTestId('workspace-announcer')).toBeTruthy();
    expect(getLayoutSnapshot().dragging).toBe(true);
  });

  it('commits a clicked region through movePane and ends the gesture', async () => {
    renderTwoPanes();
    setMock.mockClear(); // ignore the pre-gesture structural write

    fireEvent.click(screen.getByTestId('workspace-pane-move-a'));
    fireEvent.click(screen.getByTestId('pane-region-top'));

    const moved = slotOf('a');
    expect(moved.region).toBe('top');
    expect(moved.rect).toEqual({ x: 0, y: 0, width: 500, height: 400 });
    expect(screen.queryByTestId('pane-region-top')).toBeNull();
    expect(getLayoutSnapshot().dragging).toBe(false);

    await wait(250);
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it('navigates regions with Arrow keys and commits with Enter', () => {
    renderTwoPanes();

    fireEvent.click(screen.getByTestId('workspace-pane-move-a'));
    const overlay = screen.getByTestId('pane-move-overlay-a');
    fireEvent.keyDown(overlay, { key: 'ArrowDown' }); // left → bottom-left
    fireEvent.keyDown(overlay, { key: 'Enter' });

    expect(slotOf('a').region).toBe('bottom-left');
    expect(screen.queryByTestId('pane-region-center')).toBeNull();
  });

  it('cancels move mode on Escape without moving the pane', async () => {
    renderTwoPanes();
    const before = getLayoutSnapshot().activeSlots.map((slot) => ({
      ...slot,
      rect: { ...slot.rect },
    }));

    fireEvent.click(screen.getByTestId('workspace-pane-move-a'));
    fireEvent.keyDown(screen.getByTestId('pane-move-overlay-a'), { key: 'Escape' });

    expect(screen.queryByTestId('pane-region-center')).toBeNull();
    expect(getLayoutSnapshot().activeSlots).toEqual(before);
    expect(getLayoutSnapshot().dragging).toBe(false);
  });
});

describe('PaneDivider — render + DOM contract (R4)', () => {
  it('renders one separator handle per shared edge with the binding hooks', () => {
    renderTwoPanes();

    const divider = screen.getByTestId('pane-divider-vertical:a:b');
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-label')).toBe('Resize panes');
    expect(divider.getAttribute('data-dragging')).toBe('false');
    expect(divider.tabIndex).toBe(0);
  });
});

describe('PaneDivider — pointer drag (R4/R5)', () => {
  it('resizes both panes live with a constant combined extent, no persist mid-gesture', async () => {
    renderTwoPanes();
    setMock.mockClear();

    const divider = screen.getByTestId('pane-divider-vertical:a:b');
    fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    expect(getLayoutSnapshot().dragging).toBe(true);

    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 600, clientY: 400 });
    await flushFrame();

    expect(slotOf('a').rect.width).toBe(600);
    expect(slotOf('b').rect.x).toBe(600);
    expect(slotOf('b').rect.width).toBe(400);
    expect(slotOf('a').rect.width + slotOf('b').rect.width).toBe(1000);
    expect(getLayoutSnapshot().dragging).toBe(true);
    expect(setMock).not.toHaveBeenCalled(); // suppressed for the whole gesture

    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 600, clientY: 400 });
    expect(getLayoutSnapshot().dragging).toBe(false);

    await wait(250);
    expect(setMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(setMock.mock.calls[0][1] as string);
    expect(payload.activeSlots.map((s: { windowId: string }) => s.windowId)).toEqual(['a', 'b']);
  });

  it('coalesces multiple moves into the latest frame delta', async () => {
    renderTwoPanes();

    const divider = screen.getByTestId('pane-divider-vertical:a:b');
    fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 560, clientY: 400 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 620, clientY: 400 });
    await flushFrame();

    // One coalesced frame applies the latest pending delta only.
    expect(slotOf('a').rect.width).toBe(620);
    expect(slotOf('b').rect.x).toBe(620);
    expect(slotOf('a').rect.width + slotOf('b').rect.width).toBe(1000);

    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 620, clientY: 400 });
    expect(getLayoutSnapshot().dragging).toBe(false);
  });

  it('Escape during a drag restores the pre-drag geometry and ends the gesture', async () => {
    renderTwoPanes();
    const divider = screen.getByTestId('pane-divider-vertical:a:b');

    fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 580, clientY: 400 });
    await flushFrame();
    expect(slotOf('a').rect.width).toBe(580);

    fireEvent.keyDown(divider, { key: 'Escape' });

    expect(slotOf('a').rect).toEqual({ x: 0, y: 0, width: 500, height: 800 });
    expect(slotOf('b').rect).toEqual({ x: 500, y: 0, width: 500, height: 800 });
    expect(getLayoutSnapshot().dragging).toBe(false);
    expect(divider.getAttribute('data-dragging')).toBe('false');
  });
});

describe('PaneDivider — keyboard resize (R4/R12)', () => {
  it('ArrowRight grows the before pane by the fixed step, combined extent constant', async () => {
    renderTwoPanes();
    setMock.mockClear();

    fireEvent.keyDown(screen.getByTestId('pane-divider-vertical:a:b'), { key: 'ArrowRight' });

    expect(slotOf('a').rect.width).toBe(500 + DIVIDER_KEYBOARD_STEP);
    expect(slotOf('b').rect.x).toBe(500 + DIVIDER_KEYBOARD_STEP);
    expect(slotOf('a').rect.width + slotOf('b').rect.width).toBe(1000);
    expect(getLayoutSnapshot().dragging).toBe(false);

    await wait(250);
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});
