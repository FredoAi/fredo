/**
 * #2915 ST-5 — the Life subsystem's OWN bounded-loop pin.
 *
 * The pre-#2915 background module is pinned to "zero rAF / zero setInterval"
 * across its declarative CSS-recipe slices. Life necessarily breaks that
 * category: it is the ONE engine-backed kind, so its loop guarantee is stated
 * here instead — exactly ONE bounded `requestAnimationFrame` handle on the
 * animated leg, ZERO scheduling on the reduced-motion static leg, cancel while
 * hidden, and complete teardown on unmount. A source-grep pin closes the door on
 * an unbounded timer or a colour literal sneaking into the Life slice.
 *
 * The recipe-module pins (`__tests__/background.invariants.test.tsx`) scan an
 * explicit `MODULE_PATHS` file list that never includes this sibling `life/`
 * directory, so they stay BYTE-IDENTICAL — no re-scope, no widening.
 *
 * This file is `.ts` (no JSX): the React binding is invoked through
 * `React.createElement`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import { createLifeEngine } from '../lifeEngine';
import { LifeBackgroundCanvas } from '../LifeBackgroundCanvas';

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

const fakeContext = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
  globalAlpha: 1,
};

let pendingRaf: FrameRequestCallback | null = null;
let rafCount = 0;
let cancelCount = 0;

/** Install the ONLY frame-loop oracle: a per-frame rAF handle counter. */
function installRafSpies(): void {
  pendingRaf = null;
  rafCount = 0;
  cancelCount = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
    (callback: FrameRequestCallback): number => {
      pendingRaf = callback;
      rafCount += 1;
      return rafCount;
    },
  );
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((): void => {
    pendingRaf = null;
    cancelCount += 1;
  });
}

function stubCanvasContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => fakeContext as unknown as CanvasRenderingContext2D,
  );
}

/** A ResizeObserver jsdom does not implement — records its own teardown. */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor() {
    ResizeObserverStub.instances.push(this);
  }
}

/** A MutationObserver that records `disconnect()` (the theme-recolour observer). */
class MutationObserverStub {
  static instances: MutationObserverStub[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
  constructor() {
    MutationObserverStub.instances.push(this);
  }
}

let hiddenValue = false;

beforeEach(() => {
  hiddenValue = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hiddenValue,
  });
  ResizeObserverStub.instances = [];
  MutationObserverStub.instances = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as unknown as { hidden?: boolean }).hidden;
  pendingRaf = null;
});

/* -------------------------------------------------------------------------- */
/* (a) animated leg — exactly ONE rAF per frame                               */
/* -------------------------------------------------------------------------- */

describe('#2915 ST-5 (a) — animated leg: exactly ONE bounded rAF', () => {
  it('schedules exactly one handle per frame and cancels the pending handle on stop()', () => {
    installRafSpies();
    stubCanvasContext();

    const canvas = document.createElement('canvas');
    const engine = createLifeEngine({ canvas, reducedMotion: false, seed: 11 });
    engine.resize(240, 160);
    // Creating + resizing paints a frame but never schedules one.
    expect(rafCount).toBe(0);

    engine.start();
    expect(engine.running).toBe(true);
    expect(engine.runningAttr).toBe('true');
    expect(rafCount).toBe(1);

    // One frame later the driver holds exactly ONE successor — never a fan-out.
    expect(pendingRaf).not.toBeNull();
    pendingRaf!(1000);
    expect(rafCount).toBe(2);

    engine.stop();
    expect(engine.running).toBe(false);
    expect(cancelCount).toBe(1);

    // stop() is idempotent: no handle left to cancel a second time.
    engine.stop();
    expect(cancelCount).toBe(1);

    engine.destroy();
    expect(cancelCount).toBe(1);
    expect(rafCount).toBe(2);
  });

  it('cancels the in-flight handle on destroy() and never schedules again', () => {
    installRafSpies();
    stubCanvasContext();

    const canvas = document.createElement('canvas');
    const engine = createLifeEngine({ canvas, reducedMotion: false, seed: 12 });
    engine.start();
    expect(rafCount).toBe(1);

    engine.destroy();
    expect(cancelCount).toBe(1);

    // Terminal: a destroyed engine can never re-arm the loop.
    engine.start();
    expect(rafCount).toBe(1);
    expect(engine.running).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* (b) static leg — ZERO rAF / timers                                         */
/* -------------------------------------------------------------------------- */

describe('#2915 ST-5 (b) — reduced-motion static leg: one seeded frame, zero scheduling', () => {
  it('paints one seed frame and schedules NO rAF / setTimeout / setInterval', () => {
    installRafSpies();
    stubCanvasContext();
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    const canvas = document.createElement('canvas');
    const engine = createLifeEngine({ canvas, reducedMotion: true, seed: 13 });
    engine.resize(240, 160);
    engine.start();
    engine.step();

    expect(rafCount).toBe(0);
    expect(cancelCount).toBe(0);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(engine.running).toBe(false);
    expect(engine.runningAttr).toBe('false');
  });

  it('the binding renders the static hooks with NOTHING scheduled', () => {
    installRafSpies();
    stubCanvasContext();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderWithChakra(React.createElement(LifeBackgroundCanvas, { animated: false }));
    const canvas = screen.getByTestId('desktop-backdrop-life-canvas');

    expect(canvas).toHaveAttribute('data-life-motion', 'static');
    expect(canvas).toHaveAttribute('data-life-running', 'false');
    expect(rafCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* (c) visibility — cancel while hidden, resume on visible                    */
/* -------------------------------------------------------------------------- */

describe('#2915 ST-5 (c) — the loop cancels while hidden and resumes on visible', () => {
  it('cancels the frame handle on hidden and re-arms it on restore', async () => {
    installRafSpies();
    stubCanvasContext();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    renderWithChakra(React.createElement(LifeBackgroundCanvas, { animated: true }));
    const canvas = screen.getByTestId('desktop-backdrop-life-canvas');

    await waitFor(() => expect(canvas).toHaveAttribute('data-life-running', 'true'));
    expect(rafCount).toBeGreaterThan(0);
    const cancelsBeforeHide = cancelCount;

    hiddenValue = true;
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(canvas).toHaveAttribute('data-life-running', 'false'));
    expect(cancelCount).toBeGreaterThan(cancelsBeforeHide);

    const rafsWhileHidden = rafCount;
    hiddenValue = false;
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(canvas).toHaveAttribute('data-life-running', 'true'));
    expect(rafCount).toBeGreaterThan(rafsWhileHidden);
  });
});

/* -------------------------------------------------------------------------- */
/* (d) teardown — destroy() cancels everything and removes the observers      */
/* -------------------------------------------------------------------------- */

describe('#2915 ST-5 (d) — destroy() cancels everything and removes observers', () => {
  it('unmount cancels the frame, disconnects both observers and detaches the listener', () => {
    installRafSpies();
    stubCanvasContext();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal('MutationObserver', MutationObserverStub);
    const removeListenerSpy = vi.spyOn(document, 'removeEventListener');

    const view = renderWithChakra(
      React.createElement(LifeBackgroundCanvas, { animated: true }),
    );
    expect(rafCount).toBeGreaterThan(0);
    expect(ResizeObserverStub.instances).toHaveLength(1);
    expect(MutationObserverStub.instances).toHaveLength(1);

    view.unmount();

    expect(cancelCount).toBeGreaterThan(0);
    expect(ResizeObserverStub.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(MutationObserverStub.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* (e) source-grep pin — no unbounded timer, no colour literal                */
/* -------------------------------------------------------------------------- */

/**
 * The Life slice's authored implementation files (the `__tests__` siblings are
 * excluded — they legitimately CONTAIN literal-shaped regexes as oracles).
 */
const LIFE_SOURCE_PATHS = [
  'src/features/home/components/background/life/lifeConstants.ts',
  'src/features/home/components/background/life/lifePatterns.ts',
  'src/features/home/components/background/life/lifeSimulation.ts',
  'src/features/home/components/background/life/lifeEngine.ts',
  'src/features/home/components/background/life/LifeBackgroundCanvas.tsx',
  'src/features/home/components/background/life/LifeThumbnail.tsx',
] as const;

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/** Strip comments so prose/issue refs (`#2915`) are exempt from the literal scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('#2915 ST-5 (e) — Life slice source pin', () => {
  it('ships no setInterval / setTimeout and no colour literal or var(--x)NN append', () => {
    for (const path of LIFE_SOURCE_PATHS) {
      const code = stripComments(readSource(path));
      expect(code, `${path}: setInterval`).not.toMatch(/setInterval/);
      expect(code, `${path}: setTimeout`).not.toMatch(/setTimeout/);
      expect(code, `${path}: hex literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${path}: rgb()/rgba() literal`).not.toMatch(/\brgba?\s*\(/);
      expect(code, `${path}: hsl()/hsla() literal`).not.toMatch(/\bhsla?\s*\(/);
      expect(code, `${path}: var(--x)NN alpha-append`).not.toMatch(/var\(--[a-z0-9-]+\)\d/);
    }
  });

  it('mounts the frame loop ONLY in the engine module (no rAF in the thumbnail)', () => {
    const loopPaths = LIFE_SOURCE_PATHS.filter((path) =>
      stripComments(readSource(path)).includes('requestAnimationFrame'),
    );
    expect(loopPaths).toEqual(['src/features/home/components/background/life/lifeEngine.ts']);
    expect(stripComments(readSource(LIFE_SOURCE_PATHS[5]))).not.toMatch(/requestAnimationFrame/);
  });
});
