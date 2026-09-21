/**
 * #2915 ST-3 — Life canvas engine + React binding unit pin.
 *
 * Pins the ONE bounded rAF driver (exactly one handle per frame, cancelled on
 * stop/destroy), the reduced-motion static leg (one seeded frame, ZERO
 * rAF/timers), the visibility pause/resume hook, the live token resolution
 * (var() references — never a colour literal), and the grid/DPR bounds.
 *
 * #2925 ST-4 — extends the token pins to the dimmed paint contract: the
 * `--life-cell`/`--life-dim` resolution (with the `--accent-strong` fallback),
 * the `dim` field, the EXACTLY-ONE final full-frame scrim, and the
 * `LIFE_CONTRAST_MIN` guard reverting to the untransformed pair below the floor.
 *
 * jsdom has no 2D context, so the engine's paint path is driven through a stub
 * context; the loop/teardown behaviour under test is independent of pixels.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import {
  LIFE_COLS_MAX,
  LIFE_CONTRAST_MIN,
  LIFE_DPR_MAX,
  LIFE_ROWS_MAX,
} from '../lifeConstants';
import { createLifeEngine, deriveLifeGrid, resolveLifeTokens } from '../lifeEngine';
import { LifeBackgroundCanvas } from '../LifeBackgroundCanvas';

const fakeContext = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
  globalAlpha: 1,
};

let pendingRaf: FrameRequestCallback | null = null;
let rafIdCounter = 0;
let rafSpy: ReturnType<typeof vi.spyOn>;
let cancelSpy: ReturnType<typeof vi.spyOn>;

function installRafSpies(): void {
  pendingRaf = null;
  rafIdCounter = 0;
  rafSpy = vi
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback): number => {
      pendingRaf = callback;
      rafIdCounter += 1;
      return rafIdCounter;
    });
  cancelSpy = vi
    .spyOn(globalThis, 'cancelAnimationFrame')
    .mockImplementation((): void => {
      pendingRaf = null;
    });
}

function stubCanvasContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => fakeContext as unknown as CanvasRenderingContext2D,
  );
}

/** A ResizeObserver jsdom does not implement (the binding guards for it). */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let hiddenValue = false;

beforeEach(() => {
  hiddenValue = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hiddenValue,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as unknown as { hidden?: boolean }).hidden;
  pendingRaf = null;
});

describe('#2915 ST-3 — bounded grid + DPR', () => {
  it('derives the grid one cell per LIFE_CELL_PX, clamped to the hard caps', () => {
    expect(LIFE_COLS_MAX).toBe(160);
    expect(LIFE_ROWS_MAX).toBe(100);
    expect(deriveLifeGrid(100000, 100000)).toEqual({
      cols: LIFE_COLS_MAX,
      rows: LIFE_ROWS_MAX,
    });
    expect(deriveLifeGrid(1, 1)).toEqual({ cols: 1, rows: 1 });
  });

  it('bounds the backing store to LIFE_DPR_MAX × the CSS viewport (linear)', () => {
    expect(LIFE_DPR_MAX).toBe(1.5);
    installRafSpies();
    stubCanvasContext();
    vi.stubGlobal('devicePixelRatio', 3);

    const canvas = document.createElement('canvas');
    const engine = createLifeEngine({ canvas, reducedMotion: true, seed: 1 });
    engine.resize(200, 100);

    expect(canvas.width).toBe(Math.round(200 * LIFE_DPR_MAX));
    expect(canvas.height).toBe(Math.round(100 * LIFE_DPR_MAX));
    expect(canvas.width / 200).toBeLessThanOrEqual(LIFE_DPR_MAX);
    expect(canvas.height / 100).toBeLessThanOrEqual(LIFE_DPR_MAX);
  });
});

describe('#2915 ST-3 — ONE bounded rAF driver', () => {
  it('schedules exactly one rAF per frame and cancels it on stop/destroy', () => {
    installRafSpies();
    stubCanvasContext();

    const canvas = document.createElement('canvas');
    const engine = createLifeEngine({ canvas, reducedMotion: false, seed: 1 });
    engine.resize(240, 160);
    // Creating/resizing paints a frame but never schedules one.
    expect(rafSpy).not.toHaveBeenCalled();
    expect(engine.running).toBe(false);

    engine.start();
    expect(engine.running).toBe(true);
    expect(engine.runningAttr).toBe('true');
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // One frame later the driver has scheduled exactly ONE successor.
    const firstFrame = pendingRaf;
    expect(firstFrame).not.toBeNull();
    firstFrame!(1000);
    expect(rafSpy).toHaveBeenCalledTimes(2);

    engine.stop();
    expect(engine.running).toBe(false);
    expect(engine.runningAttr).toBe('false');
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    engine.destroy();
    expect(rafSpy).toHaveBeenCalledTimes(2);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent — never more than one live handle', () => {
    installRafSpies();
    stubCanvasContext();
    const canvas = document.createElement('canvas');
    const engine = createLifeEngine({ canvas, reducedMotion: false, seed: 2 });
    engine.start();
    engine.start();
    engine.start();
    expect(rafSpy).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('advances generations at the step cadence', () => {
    installRafSpies();
    stubCanvasContext();
    const canvas = document.createElement('canvas');
    const engine = createLifeEngine({ canvas, reducedMotion: false, seed: 3 });
    engine.resize(240, 160);
    engine.start();

    // The first frame advances immediately (no dead interval on start).
    pendingRaf!(0);
    expect(engine.generation).toBe(1);
    // A frame inside the step interval does not advance again.
    pendingRaf!(100);
    expect(engine.generation).toBe(1);
    // A frame clear of the interval advances exactly one generation.
    pendingRaf!(1000);
    expect(engine.generation).toBe(2);
    engine.destroy();
  });
});

describe('#2915 ST-3 — reduced motion: static frame, zero scheduling', () => {
  it('paints one seeded frame with ZERO rAF/timers', () => {
    const canvas = document.createElement('canvas');
    installRafSpies();
    stubCanvasContext();
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    const engine = createLifeEngine({ canvas, reducedMotion: true, seed: 7 });
    engine.resize(240, 160);
    engine.setTokens({
      ground: 'var(--body-bg)',
      cell: 'var(--accent-strong)',
      dim: 'transparent',
    });
    engine.start();
    engine.step();

    expect(rafSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(engine.running).toBe(false);
    expect(engine.runningAttr).toBe('false');
  });
});

describe('#2915 ST-3 — live token resolution', () => {
  it('returns var() token references, never a colour literal', () => {
    const canvas = document.createElement('canvas');
    const tokens = resolveLifeTokens(canvas);

    expect(tokens.ground).toContain('var(--body-bg)');
    expect(tokens.cell).toContain('var(--accent-strong)');
    for (const value of [tokens.ground, tokens.cell, tokens.dim]) {
      expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(value).not.toMatch(/\brgba?\s*\(/);
      expect(value).not.toMatch(/\bhsla?\s*\(/);
      expect(value).not.toMatch(/var\(--[a-z0-9-]+\)\d/);
    }
  });

  it('reads the LIVE custom property when the host provides one', () => {
    const canvas = document.createElement('canvas');
    canvas.style.setProperty('--accent-strong', 'var(--test-accent)');
    expect(resolveLifeTokens(canvas).cell).toBe('var(--test-accent)');
  });

  it('setTokens repaints without touching the loop', () => {
    const canvas = document.createElement('canvas');
    installRafSpies();
    stubCanvasContext();
    const engine = createLifeEngine({ canvas, reducedMotion: false, seed: 5 });
    engine.start();
    const scheduled = rafSpy.mock.calls.length;
    engine.setTokens({
      ground: 'var(--body-bg)',
      cell: 'var(--accent-strong)',
      dim: 'transparent',
    });
    expect(rafSpy.mock.calls.length).toBe(scheduled);
    engine.destroy();
  });
});

describe('#2925 ST-4 — dimmed paint contract', () => {
  /** One recorded op: the `fillStyle` in force when a `fillRect` was painted. */
  interface PaintOp {
    style: string;
    width: number;
    height: number;
  }

  /**
   * A 2D-context stub that records `(fillStyle, fillRect)` pairs in call order —
   * the seam that proves the scrim's count/order without pixels.
   */
  function stubRecordingContext(): { ops: PaintOp[] } {
    const ops: PaintOp[] = [];
    const recording = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      globalAlpha: 1,
      fillStyle: '',
      fillRect(_x: number, _y: number, width: number, height: number): void {
        ops.push({ style: String(this.fillStyle), width, height });
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => recording as unknown as CanvasRenderingContext2D,
    );
    return { ops };
  }

  it('resolves --life-cell in preference to --accent-strong and reads --life-dim', () => {
    const canvas = document.createElement('canvas');
    canvas.style.setProperty('--life-cell', 'var(--test-life-cell)');
    canvas.style.setProperty('--accent-strong', 'var(--test-accent)');
    canvas.style.setProperty('--life-dim', 'var(--test-dim)');

    const tokens = resolveLifeTokens(canvas);
    expect(tokens.ground).toBe('var(--body-bg)');
    expect(tokens.cell).toBe('var(--test-life-cell)');
    expect(tokens.dim).toBe('var(--test-dim)');
  });

  it('falls back to --accent-strong + transparent when --life-cell is absent', () => {
    const canvas = document.createElement('canvas');
    canvas.style.setProperty('--accent-strong', 'var(--test-accent)');

    const tokens = resolveLifeTokens(canvas);
    expect(tokens.cell).toBe('var(--test-accent)');
    expect(tokens.dim).toBe('transparent');
  });

  it('paints ground, cells, then EXACTLY ONE full-frame dim scrim', () => {
    const canvas = document.createElement('canvas');
    canvas.style.setProperty('--body-bg', 'var(--test-ground)');
    canvas.style.setProperty('--accent-strong', 'var(--test-accent)');
    canvas.style.setProperty('--life-cell', 'var(--test-cell)');
    canvas.style.setProperty('--life-dim', 'var(--test-dim)');
    const { ops } = stubRecordingContext();

    const engine = createLifeEngine({ canvas, reducedMotion: true, seed: 21 });
    ops.length = 0;
    engine.resize(240, 160);

    const scrimOps = ops.filter((op) => op.style === 'var(--test-dim)');
    expect(scrimOps).toHaveLength(1);
    expect(scrimOps[0].width).toBe(canvas.width);
    expect(scrimOps[0].height).toBe(canvas.height);
    // The scrim is the LAST op — nothing paints over the finished frame.
    expect(ops[ops.length - 1]).toEqual(scrimOps[0]);

    // Exactly two full-frame fills: the ground and the single dim scrim.
    const fullFrame = ops.filter(
      (op) => op.width === canvas.width && op.height === canvas.height,
    );
    expect(fullFrame).toHaveLength(2);
    expect(fullFrame[0].style).toBe('var(--test-ground)');
    expect(fullFrame[1].style).toBe('var(--test-dim)');
  });

  it('LIFE_CONTRAST_MIN guard reverts to the untransformed pair below the floor', () => {
    expect(LIFE_CONTRAST_MIN).toBe(3);
    const canvas = document.createElement('canvas');
    canvas.style.setProperty('--body-bg', '#000000');
    canvas.style.setProperty('--accent-strong', '#ffffff');
    canvas.style.setProperty('--life-cell', '#070707');
    canvas.style.setProperty('--life-dim', 'rgba(0, 0, 0, 0.12)');

    const tokens = resolveLifeTokens(canvas);
    expect(tokens.cell).toBe('#ffffff');
    expect(tokens.dim).toBe('transparent');
    expect(tokens.ground).toBe('#000000');
  });

  it('evaluates the nested color-mix cell expression and reverts when below the floor', () => {
    const canvas = document.createElement('canvas');
    canvas.style.setProperty('--body-bg', '#000000');
    canvas.style.setProperty('--accent-strong', '#ffffff');
    canvas.style.setProperty(
      '--life-cell',
      'color-mix(in srgb, color-mix(in srgb, #202020 80%, #000000 20%) 80%, #000000 20%)',
    );
    canvas.style.setProperty('--life-dim', 'rgba(0, 0, 0, 0.12)');

    const tokens = resolveLifeTokens(canvas);
    expect(tokens.cell).toBe('#ffffff');
    expect(tokens.dim).toBe('transparent');
  });

  it('keeps the dimmed pair when the resolved ratio clears the floor', () => {
    const canvas = document.createElement('canvas');
    canvas.style.setProperty('--body-bg', '#000000');
    canvas.style.setProperty('--accent-strong', '#ff0000');
    canvas.style.setProperty('--life-cell', 'color-mix(in srgb, #ffffff 80%, #000000 20%)');
    canvas.style.setProperty('--life-dim', 'rgba(0, 0, 0, 0.12)');

    const tokens = resolveLifeTokens(canvas);
    expect(tokens.cell).toBe('color-mix(in srgb, #ffffff 80%, #000000 20%)');
    expect(tokens.dim).toBe('rgba(0, 0, 0, 0.12)');
  });

  it('resolves a fully-substituted THIRD-level nested --life-cell (the neutral leg)', () => {
    // The browser's computed `--life-cell` is the substituted token stream:
    // `--accent-strong` (a color-mix) AND `--life-neutral` (a color-mix) both
    // nest inside the outer color-mix — three levels deep. The recursive parser
    // must resolve it; otherwise the guard would fail-safe and never fire.
    const keep = document.createElement('canvas');
    keep.style.setProperty('--body-bg', '#ffffff');
    keep.style.setProperty('--accent-strong', '#00d1d1');
    keep.style.setProperty(
      '--life-cell',
      'color-mix(in srgb, color-mix(in srgb, #00d1d1 55%, #0c1117 45%) 65%, color-mix(in srgb, #0c1117 70%, #ffffff 30%) 35%)',
    );
    keep.style.setProperty('--life-dim', 'rgba(0, 0, 0, 0.072)');

    const kept = resolveLifeTokens(keep);
    // Above the floor the dimmed (nested) pair is kept — the guard PARSED it.
    expect(kept.cell).toBe(
      'color-mix(in srgb, color-mix(in srgb, #00d1d1 55%, #0c1117 45%) 65%, color-mix(in srgb, #0c1117 70%, #ffffff 30%) 35%)',
    );
    expect(kept.dim).toBe('rgba(0, 0, 0, 0.072)');

    const fallback = document.createElement('canvas');
    fallback.style.setProperty('--body-bg', '#000000');
    fallback.style.setProperty('--accent-strong', '#ffffff');
    fallback.style.setProperty(
      '--life-cell',
      'color-mix(in srgb, color-mix(in srgb, #202020 55%, #101010 45%) 65%, color-mix(in srgb, #101010 70%, #000000 30%) 35%)',
    );
    fallback.style.setProperty('--life-dim', 'rgba(0, 0, 0, 0.072)');

    const reverted = resolveLifeTokens(fallback);
    // Below the floor the same nested shape reverts to the untransformed pair.
    expect(reverted.cell).toBe('#ffffff');
    expect(reverted.dim).toBe('transparent');
  });
});

describe('#2915 ST-3 — React binding data-life-* hooks', () => {
  it('renders the inert canvas with the animated hooks and cancels while hidden', async () => {
    installRafSpies();
    stubCanvasContext();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderWithChakra(<LifeBackgroundCanvas animated />);
    const canvas = screen.getByTestId('desktop-backdrop-life-canvas');

    expect(canvas).toHaveAttribute('data-background-layer', 'life-field');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).toHaveAttribute('data-life-motion', 'animated');
    expect(canvas).toHaveAttribute('data-life-running', 'true');
    expect(canvas.getAttribute('data-life-seed')).toMatch(/^\d+$/);
    expect(getComputedStyle(canvas).pointerEvents).toBe('none');
    expect(rafSpy).toHaveBeenCalled();

    hiddenValue = true;
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(canvas).toHaveAttribute('data-life-running', 'false'));
    expect(cancelSpy).toHaveBeenCalled();

    hiddenValue = false;
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(canvas).toHaveAttribute('data-life-running', 'true'));
  });

  it('renders the static leg with NO loop scheduled', () => {
    installRafSpies();
    stubCanvasContext();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderWithChakra(<LifeBackgroundCanvas animated={false} />);
    const canvas = screen.getByTestId('desktop-backdrop-life-canvas');

    expect(canvas).toHaveAttribute('data-life-motion', 'static');
    expect(canvas).toHaveAttribute('data-life-running', 'false');
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('tears the engine down on unmount (cancels the pending frame)', () => {
    installRafSpies();
    stubCanvasContext();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    const view = renderWithChakra(<LifeBackgroundCanvas animated />);
    expect(rafSpy).toHaveBeenCalled();
    view.unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
