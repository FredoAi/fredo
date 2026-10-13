/**
 * Component tests for ResizableSplitter — Spec #3049, ST-2.
 *
 * Pins the binding interaction contract shared by all four SQL Studio splits:
 * role="separator" + ARIA, pointer-capture drag with a live clamped value and a
 * SINGLE commit on release, keyboard steps / Home / End / Shift-step, Escape
 * cancels an in-progress drag, and no `user-select` override leaks after release.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ResizableSplitter, clampSplitSize } from '../ResizableSplitter';
import type { ResizableSplitterProps } from '../ResizableSplitter';

/**
 * Build a pointer event with clientX/clientY/pointerId explicitly defined. jsdom
 * does not propagate PointerEvent init props onto the created event, so a plain
 * bubbling Event with the properties defined is the reliable simulation.
 */
function makePointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number },
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, 'clientX', { value: init.clientX ?? 0, configurable: true });
  Object.defineProperty(ev, 'clientY', { value: init.clientY ?? 0, configurable: true });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1, configurable: true });
  return ev;
}

afterEach(() => {
  cleanup();
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});

beforeEach(() => {
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});

interface HarnessProps extends Partial<ResizableSplitterProps> {
  onChange: (px: number) => void;
}

function renderSplitter(props: HarnessProps) {
  const merged: ResizableSplitterProps = {
    orientation: 'vertical',
    direction: 'start',
    value: 300,
    min: 220,
    max: 560,
    ariaLabel: 'Resize left sidebar',
    testId: 'test-resize-handle',
    ...props,
  };
  return renderWithChakra(<ResizableSplitter {...merged} />);
}

describe('ResizableSplitter — ARIA separator contract (GA-7)', () => {
  it('renders a focusable role="separator" with orientation + value bounds and the testId', () => {
    renderSplitter({ onChange: vi.fn() });

    const handle = screen.getByTestId('test-resize-handle');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize left sidebar');
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
    expect(handle.getAttribute('aria-valuemin')).toBe('220');
    expect(handle.getAttribute('aria-valuemax')).toBe('560');
    expect(handle.tabIndex).toBe(0);
  });

  it('reflects a horizontal orientation for a row split', () => {
    renderSplitter({
      onChange: vi.fn(),
      orientation: 'horizontal',
      value: 220,
      min: 120,
      max: 720,
      ariaLabel: 'Resize editor and results',
      testId: 'test-row-handle',
    });

    const handle = screen.getByTestId('test-row-handle');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.getAttribute('aria-valuenow')).toBe('220');
    expect(handle.getAttribute('aria-valuemin')).toBe('120');
    expect(handle.getAttribute('aria-valuemax')).toBe('720');
  });
});

describe('ResizableSplitter — pointer drag commits once, clamped (GA-5, GA-7)', () => {
  it('tracks the live value during the drag and commits exactly once on pointerup', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');

    // Grab at x=400 with a committed size of 300 (direction 'start', +ΔX).
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent(handle, makePointerEvent('pointermove', { clientX: 450 })); // +50
    expect(onChange).not.toHaveBeenCalled();
    // Live aria reflects the in-flight value (300 + 50), not the committed prop.
    expect(handle.getAttribute('aria-valuenow')).toBe('350');

    fireEvent(handle, makePointerEvent('pointermove', { clientX: 470 })); // +70
    expect(handle.getAttribute('aria-valuenow')).toBe('370');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent(handle, makePointerEvent('pointerup', { clientX: 470 }));
    // Exactly one commit, carrying the final clamped size.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(370);
  });

  it('clamps at the max when dragged past it and commits the max (no rubber-band)', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 5000 }));

    expect(handle.getAttribute('aria-valuenow')).toBe('560');
    fireEvent(handle, makePointerEvent('pointerup', { clientX: 5000 }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(560);
  });

  it('clamps at the min when dragged below it and commits the min', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: -5000 }));

    expect(handle.getAttribute('aria-valuenow')).toBe('220');
    fireEvent(handle, makePointerEvent('pointerup', { clientX: -5000 }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(220);
  });

  it("direction 'end' grows with a negative ΔX (right sidebar on the end side)", () => {
    const onChange = vi.fn();
    renderSplitter({ onChange, direction: 'end', value: 280, min: 200, max: 520 });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    // Handle moves left (ΔX = -50) → the end-side pane grows by +50.
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 350 }));
    expect(handle.getAttribute('aria-valuenow')).toBe('330');

    fireEvent(handle, makePointerEvent('pointerup', { clientX: 350 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(330);
  });

  it("horizontal orientation resizes along ΔY and commits once", () => {
    const onChange = vi.fn();
    renderSplitter({
      onChange,
      orientation: 'horizontal',
      direction: 'start',
      value: 220,
      min: 120,
      max: 720,
    });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientY: 300 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientY: 360 })); // +60
    expect(handle.getAttribute('aria-valuenow')).toBe('280');

    fireEvent(handle, makePointerEvent('pointerup', { clientY: 360 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(280);
  });

  it('a stray second pointerup does not re-commit', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 450 }));
    fireEvent(handle, makePointerEvent('pointerup', { clientX: 450 }));
    fireEvent(handle, makePointerEvent('pointerup', { clientX: 450 }));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('pointercancel commits the clamped value once', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 440 }));
    fireEvent(handle, makePointerEvent('pointercancel', { clientX: 440 }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(340);
  });
});

describe('ResizableSplitter — keyboard resizing (GA-7 a11y)', () => {
  it('ArrowRight / ArrowLeft step 16px on the vertical axis and commit each step', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(316);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(284);
  });

  it('Shift+Arrow uses the 64px step', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    fireEvent.keyDown(screen.getByTestId('test-resize-handle'), { key: 'ArrowRight', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(364);
  });

  it('Home jumps to min and End jumps to max', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(220);

    fireEvent.keyDown(handle, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(560);
  });

  it('ArrowDown / ArrowUp step on the horizontal axis', () => {
    const onChange = vi.fn();
    renderSplitter({
      onChange,
      orientation: 'horizontal',
      value: 220,
      min: 120,
      max: 720,
    });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(236);

    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(204);
  });

  it("Arrow keys move the divider along the axis for a 'end' split", () => {
    const onChange = vi.fn();
    renderSplitter({ onChange, direction: 'end', value: 280, min: 200, max: 520 });

    const handle = screen.getByTestId('test-resize-handle');
    // ArrowLeft moves the divider left → the end-side pane grows.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(296);
  });

  it('Escape cancels an in-progress drag without committing', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 450 }));
    expect(handle.getAttribute('aria-valuenow')).toBe('350');

    fireEvent.keyDown(document, { key: 'Escape' });

    // No commit, and the live override is dropped back to the committed prop.
    expect(onChange).not.toHaveBeenCalled();
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
  });
});

describe('ResizableSplitter — clean release (GA-7)', () => {
  it('sets user-select + resize cursor during the drag and restores both on release', () => {
    renderSplitter({ onChange: vi.fn() });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('col-resize');

    fireEvent(handle, makePointerEvent('pointerup', { clientX: 400 }));
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('uses the row-resize cursor override for a horizontal split', () => {
    renderSplitter({ onChange: vi.fn(), orientation: 'horizontal' });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientY: 200 }));
    expect(document.body.style.cursor).toBe('row-resize');

    fireEvent(handle, makePointerEvent('pointercancel', { clientY: 200 }));
    expect(document.body.style.cursor).toBe('');
  });

  it('cancelling with Escape restores body overrides (no residual user-select)', () => {
    renderSplitter({ onChange: vi.fn() });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 450 }));
    expect(document.body.style.userSelect).toBe('none');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });
});

describe('ResizableSplitter — live drag channel (GA-1…GA-4 enablement)', () => {
  it('reports every in-flight move through onDragChange without committing', () => {
    const onChange = vi.fn();
    const onDragChange = vi.fn();
    renderSplitter({ onChange, onDragChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 450 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 500 }));

    expect(onDragChange).toHaveBeenNthCalledWith(1, 350);
    expect(onDragChange).toHaveBeenNthCalledWith(2, 400);
    // Live moves never commit.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent(handle, makePointerEvent('pointerup', { clientX: 500 }));
    // onDragChange is not re-fired on release.
    expect(onDragChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(400);
  });
});

describe('clampSplitSize', () => {
  it('clamps below min, above max, and rounds within range', () => {
    expect(clampSplitSize(10, 220, 560)).toBe(220);
    expect(clampSplitSize(9999, 220, 560)).toBe(560);
    expect(clampSplitSize(340.6, 220, 560)).toBe(341);
  });

  it('maps a non-finite value to the min', () => {
    expect(clampSplitSize(Number.NaN, 220, 560)).toBe(220);
    expect(clampSplitSize(Number.POSITIVE_INFINITY, 220, 560)).toBe(220);
  });
});

// ── Spec #3049 (ST-4): additional contract pins ───────────────────────────────
//
// The lost-capture path is a second commit route (GA-7 "clean release");
// `preventDefault` on pointerdown is the AC-5 "dragging never selects text"
// contract at the event level; and a boundary keyboard step must clamp and
// commit exactly once.

describe('ResizableSplitter — lost capture & interaction guards (GA-7)', () => {
  it('commits exactly once when pointer capture is lost, and a later pointerup does not double-commit', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange });

    const handle = screen.getByTestId('test-resize-handle');
    fireEvent(handle, makePointerEvent('pointerdown', { clientX: 400 }));
    fireEvent(handle, makePointerEvent('pointermove', { clientX: 500 }));
    fireEvent(handle, makePointerEvent('lostpointercapture', { clientX: 500 }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(400);
    // Overrides are cleared on the lost-capture path too.
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');

    fireEvent(handle, makePointerEvent('pointerup', { clientX: 500 }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('prevents the pointerdown default so a drag never starts a text selection', () => {
    renderSplitter({ onChange: vi.fn() });
    const handle = screen.getByTestId('test-resize-handle');
    const down = makePointerEvent('pointerdown', { clientX: 400 });
    fireEvent(handle, down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('clamps a keyboard step at the boundary and commits exactly once per key', () => {
    const onChange = vi.fn();
    renderSplitter({ onChange, value: 550, min: 220, max: 560 });

    fireEvent.keyDown(screen.getByTestId('test-resize-handle'), { key: 'ArrowRight' });
    // 550 + 16 = 566 → clamped to the 560 boundary, one commit.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(560);
  });
});
