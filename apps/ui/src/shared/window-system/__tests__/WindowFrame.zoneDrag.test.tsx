/**
 * WindowFrame — chord-drag snap gesture (Spec #2980 ST-5, R-3.1/R-3.2/R-3.3/
 * R-3.4).
 *
 * The zone-drag path is entered at `handleHeaderPointerDown` when the zone
 * layout is ENABLED, has an ACTIVE layout, and the pointer's modifier flags match
 * the configured activation chord (`matchesZoneChord`). The frame then drives the
 * ST-1 store (`beginZoneDrag` → `updateZoneDragPointer` → `endZoneDrag(true)`),
 * sets `data-zone-drag="true"`, and NEVER touches its own float geometry. A
 * window-level Escape cancels without a geometry write; a release over no zone
 * leaves the assignment unchanged. When the drag is not eligible (disabled / no
 * active layout / chord not held) the shipped float drag runs unchanged.
 *
 * jsdom has no layout engine, so the frame's measured workspace
 * (`[data-testid="workspace"]`) is stubbed at the prototype level. jsdom (v24)
 * does not implement `PointerEvent`, so the MouseEvent-backed polyfill below
 * restores the coordinate/modifier transport the gesture relies on in WebView2
 * (mirrors `PaneGestures.test.tsx`). The store's own workspace is reported
 * separately via `setZoneLayoutWorkspace` (viewport-coord zone resolution).
 *
 * `settingsService` is mocked (the zone store persists through it) so the suite
 * stays host-agnostic and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowFrame } from '../WindowFrame';
import {
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
  subscribeWindows,
} from '../windowStore';
import {
  getZoneLayoutSnapshot,
  resetZoneLayoutStoreForTests,
  saveZoneLayout,
  setActiveZoneLayout,
  setZoneLayoutEnabled,
  setZoneLayoutWorkspace,
} from '../zoneLayoutStore';
import { buildTemplateZones, type ZoneLayout } from '../zoneLayout';
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

// jsdom (v24) does not implement PointerEvent — a MouseEvent-backed polyfill
// restores `clientX`/`clientY` + the modifier flags the gesture reads.
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

const WINDOW_ID = 'mission-monitor';
const TITLE = 'Mission Monitor';
const LAYOUT_ID = 'l1';
const ZONE_WS = { left: 0, top: 0, width: 1000, height: 800 };

/** The frame's measured workspace (its `parentElement`) — mutable per test. */
let workspaceSize = { width: 0, height: 0 };

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

/** Renders one store-backed frame inside a measurable workspace container. */
function FrameHarness({ id }: { id: string }) {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  const win = windows.find((w) => w.id === id);
  return <div data-testid="workspace">{win ? <WindowFrame window={win} /> : null}</div>;
}

/** Open a window through the real store; `isMaximized` default ⇒ full-bleed. */
function openEntry(overrides: Partial<OpenWindowParams> = {}): void {
  openWindow({
    id: WINDOW_ID,
    title: TITLE,
    icon: <span data-testid="feature-icon" />,
    component: <div data-testid="feature-content">feature body</div>,
    canClose: true,
    canMaximize: true,
    canMinimize: true,
    ...overrides,
  });
}

function columnsLayout(): ZoneLayout {
  return { id: LAYOUT_ID, name: 'Work', template: 'columns', zones: buildTemplateZones('columns') };
}

/** Enable layout management and assign the 2-zone columns layout. */
function seedEnabledActiveLayout(): void {
  setZoneLayoutEnabled(true);
  const layout = saveZoneLayout(columnsLayout());
  setActiveZoneLayout(layout.id);
}

function renderFrame(): HTMLElement {
  renderWithChakra(<FrameHarness id={WINDOW_ID} />);
  return screen.getByTestId(`window-frame-${WINDOW_ID}`);
}

function headerOf(surface: HTMLElement): HTMLElement {
  const header = surface.querySelector<HTMLElement>('.fredo-window__header');
  if (!header) throw new Error('window header did not render');
  return header;
}

/** Flush one animation frame (the float drag's coalescing boundary). */
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

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetZoneLayoutStoreForTests();
  setZoneLayoutWorkspace(ZONE_WS);
  workspaceSize = { width: 0, height: 0 };
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'workspace') {
        return rectOf(workspaceSize.width, workspaceSize.height);
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

// ── R-3.1 / R-3.2 — eligible chord-drag enters the zone path + commits ────────

describe('WindowFrame — eligible chord-drag (R-3.1/R-3.2)', () => {
  it('enters the zone-drag path, sets data-zone-drag, tracks the zone, and commits on release', () => {
    seedEnabledActiveLayout();
    openEntry({ isMaximized: false });
    workspaceSize = { width: 1000, height: 800 };
    const surface = renderFrame();
    const header = headerOf(surface);

    expect(surface.getAttribute('data-zone-drag')).toBeNull();

    fireEvent.pointerDown(header, {
      pointerId: 1,
      button: 0,
      altKey: true,
      clientX: 250,
      clientY: 400,
    });

    // The ST-1 store actions ran (state transitions are only reachable via them).
    expect(getZoneLayoutSnapshot().dragActive).toBe(true);
    expect(getZoneLayoutSnapshot().dragWindowId).toBe(WINDOW_ID);
    expect(surface.getAttribute('data-zone-drag')).toBe('true');

    fireEvent.pointerMove(header, { pointerId: 1, clientX: 250, clientY: 400 });
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBe('zone-0');

    fireEvent.pointerMove(header, { pointerId: 1, clientX: 750, clientY: 400 });
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBe('zone-1');

    fireEvent.pointerUp(header, { pointerId: 1, clientX: 750, clientY: 400 });

    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(getZoneLayoutSnapshot().assignments).toEqual([
      { windowId: WINDOW_ID, layoutId: LAYOUT_ID, zoneId: 'zone-1' },
    ]);
    expect(surface.getAttribute('data-zone-drag')).toBeNull();
  });

  it('enters the zone path on the default full-bleed window without touching geometry', () => {
    seedEnabledActiveLayout();
    openEntry(); // isMaximized omitted ⇒ full-bleed default (the AC3 demo state)
    const surface = renderFrame();
    const header = headerOf(surface);

    expect(surface.style.width).toBe('100%');

    fireEvent.pointerDown(header, {
      pointerId: 1,
      button: 0,
      altKey: true,
      clientX: 250,
      clientY: 400,
    });

    expect(getZoneLayoutSnapshot().dragActive).toBe(true);
    expect(surface.getAttribute('data-zone-drag')).toBe('true');

    fireEvent.pointerMove(header, { pointerId: 1, clientX: 500, clientY: 400 });

    // A zone drag NEVER writes the frame's float geometry (R-3.4 trivially holds).
    expect(surface.style.width).toBe('100%');
    expect(surface.style.left).toBe('0px');

    fireEvent.pointerUp(header, { pointerId: 1, clientX: 500, clientY: 400 });
    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(surface.getAttribute('data-zone-drag')).toBeNull();
  });

  it('leaves the assignment unchanged when released over no zone', () => {
    seedEnabledActiveLayout();
    openEntry({ isMaximized: false });
    const surface = renderFrame();
    const header = headerOf(surface);

    fireEvent.pointerDown(header, {
      pointerId: 1,
      button: 0,
      altKey: true,
      clientX: 500,
      clientY: 400,
    });
    // x=500 is the inter-zone gap gutter → no zone under the pointer.
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 500, clientY: 400 });
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBeNull();

    fireEvent.pointerUp(header, { pointerId: 1, clientX: 500, clientY: 400 });

    expect(getZoneLayoutSnapshot().assignments).toEqual([]);
  });
});

// ── R-3.4 — window-level Escape cancels without a geometry write ──────────────

describe('WindowFrame — Escape cancels the zone drag (R-3.4)', () => {
  it('cancels on the window-level keydown, leaves geometry and assignment unchanged', () => {
    seedEnabledActiveLayout();
    openEntry({ isMaximized: false });
    workspaceSize = { width: 1000, height: 800 };
    const surface = renderFrame();
    const header = headerOf(surface);

    const beforeLeft = surface.style.left;
    const beforeWidth = surface.style.width;

    fireEvent.pointerDown(header, {
      pointerId: 1,
      button: 0,
      altKey: true,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 750, clientY: 400 });
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBe('zone-1');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(getZoneLayoutSnapshot().hoveredZoneId).toBeNull();
    expect(getZoneLayoutSnapshot().assignments).toEqual([]);
    expect(surface.getAttribute('data-zone-drag')).toBeNull();
    expect(surface.style.left).toBe(beforeLeft);
    expect(surface.style.width).toBe(beforeWidth);
  });

  it('does not end the gesture on a non-Escape key', () => {
    seedEnabledActiveLayout();
    openEntry({ isMaximized: false });
    const surface = renderFrame();
    const header = headerOf(surface);

    fireEvent.pointerDown(header, {
      pointerId: 1,
      button: 0,
      altKey: true,
      clientX: 300,
      clientY: 300,
    });

    fireEvent.keyDown(window, { key: 'a' });
    expect(getZoneLayoutSnapshot().dragActive).toBe(true);

    fireEvent.pointerUp(header, { pointerId: 1, clientX: 300, clientY: 300 });
  });
});

// ── R-3.3 — non-eligible drag is the shipped float path ───────────────────────

describe('WindowFrame — non-eligible drag runs the shipped float path (R-3.3)', () => {
  it('runs the float drag when the chord is not held', async () => {
    seedEnabledActiveLayout();
    openEntry({ isMaximized: false });
    workspaceSize = { width: 1000, height: 800 };
    const surface = renderFrame();
    const header = headerOf(surface);

    const beforeLeft = surface.style.left;

    // No chord modifier held → not eligible despite enabled + active layout.
    fireEvent.pointerDown(header, { pointerId: 1, button: 0, clientX: 300, clientY: 300 });

    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(surface.getAttribute('data-zone-drag')).toBeNull();
    // The shipped float gesture is the one running.
    expect(surface.className).toContain('fredo-window__surface--gesture');

    fireEvent.pointerMove(header, { pointerId: 1, clientX: 400, clientY: 300 });
    await flushFrame();
    expect(surface.style.left).not.toBe(beforeLeft);

    fireEvent.pointerUp(header, { pointerId: 1, clientX: 400, clientY: 300 });
    expect(surface.className).not.toContain('--gesture');
    // The float drag never enters the zone store.
    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
  });

  it('runs the float drag when layout management is disabled', () => {
    // Enabled stays false; a layout exists but is inactive.
    saveZoneLayout(columnsLayout());
    openEntry({ isMaximized: false });
    const surface = renderFrame();
    const header = headerOf(surface);

    fireEvent.pointerDown(header, {
      pointerId: 1,
      button: 0,
      altKey: true,
      clientX: 250,
      clientY: 400,
    });

    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(surface.getAttribute('data-zone-drag')).toBeNull();
    expect(surface.className).toContain('fredo-window__surface--gesture');
  });

  it('runs the float drag when no layout is active', () => {
    setZoneLayoutEnabled(true); // enabled, but activeLayoutId stays null
    openEntry({ isMaximized: false });
    const surface = renderFrame();
    const header = headerOf(surface);

    fireEvent.pointerDown(header, {
      pointerId: 1,
      button: 0,
      altKey: true,
      clientX: 250,
      clientY: 400,
    });

    expect(getZoneLayoutSnapshot().dragActive).toBe(false);
    expect(surface.getAttribute('data-zone-drag')).toBeNull();
    expect(surface.className).toContain('fredo-window__surface--gesture');
  });
});
