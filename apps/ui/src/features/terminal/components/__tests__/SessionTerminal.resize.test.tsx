/**
 * Spec 2934 round-3 FX-5 (AC2 / R-2.4) — window/pane resize → `resize_pty`.
 * Spec 2940 ST-2 (AC1 / R-1.4, R-1.6) — continuous re-fit + fit receipt (C-2).
 *
 * A container resize must re-fit the ACTIVE terminal so its `term.onResize`
 * pushes `resize_pty{sessionId, rows, cols}` for that session only, and must
 * publish the APPLIED grid through the optional `onFit(cols, rows)` receipt
 * after every applied fit (never from a 0×0 box). The pin drives a stubbed
 * `ResizeObserver` (jsdom does not implement one) against the REAL
 * `SessionTerminal` and a mocked `ghostty-web` whose `fit()` resizes the
 * observed box (mirroring the shipped FitAddon, which only emits when the
 * computed grid changes).
 *
 * Rows:
 *   1. active session + a real box → `resize_pty` for that session;
 *   2. inactive session → no fit, no `resize_pty` (a silent fit would leave the
 *      PTY stale for the later activation);
 *   3. active session + a 0×0 box → no fit, no `resize_pty`;
 *   4. `onFit` publishes the applied dims after a resize, and tracks a second
 *      resize (continuous follow, R-1.6);
 *   5. `onFit` is never called from a 0×0 box;
 *   6. the canvas host carries `data-testid="terminal-canvas-host-<sessionId>"`.
 *
 * Spec #2942 ST-5 adds two rows:
 *   7. (ii) ONE unconditional settling `resize_pty` after the mount fit, even
 *      when ghostty reports an UNCHANGED grid (the "forced resize" behind the
 *      residual "OpenCode TUI doesn't fill the pane" defect, made deterministic)
 *      — and it stays exactly one (the dedupe);
 *   8. (iv) a transiently too-small box (the documented 71×4 latch) is never
 *      fitted, published, or pushed.
 *
 * The receipt assertions are scoped to THIS component's callback (G-222) — no
 * global/order-dependent quantity is asserted.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';

const ghostty = vi.hoisted(() => ({
  fitCalls: 0,
  resizeCb: null as ((size: { cols: number; rows: number }) => void) | null,
  opened: null as HTMLElement | null,
}));

vi.mock('ghostty-web', () => {
  class FitAddon {
    private terminal: { cols: number; rows: number; resize(cols: number, rows: number): void } | null =
      null;

    activate(terminal: {
      cols: number;
      rows: number;
      resize(cols: number, rows: number): void;
    }): void {
      this.terminal = terminal;
    }

    fit(): void {
      ghostty.fitCalls++;
      const el = ghostty.opened;
      // A 0×0 box yields no computed grid and no resize (the component also
      // refuses to fit a 0×0 box; both sides agree).
      if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return;
      const cols = Math.floor(el.clientWidth / 8);
      const rows = Math.floor(el.clientHeight / 16);
      // Mirror the shipped FitAddon: a fit that yields the current grid is a
      // no-op (no resize, no `onResize`).
      if (this.terminal && this.terminal.cols === cols && this.terminal.rows === rows) return;
      this.terminal?.resize(cols, rows);
    }

    dispose() {}
  }
  class Terminal {
    cols = 80;
    rows = 24;
    loadAddon(addon: { activate?: (terminal: Terminal) => void }): void {
      addon.activate?.(this);
    }
    open(el: HTMLElement) {
      ghostty.opened = el;
    }
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      ghostty.resizeCb?.({ cols, rows });
    }
    onResize(cb: (size: { cols: number; rows: number }) => void) {
      ghostty.resizeCb = cb;
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
  }
  return { init: async () => {}, Terminal, FitAddon };
});

import { SessionTerminal } from '../SessionTerminal';

/** A ResizeObserver jsdom does not implement — the test fires it by hand. */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  observed: Element[] = [];
  disconnect = vi.fn();
  unobserve = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe = (el: Element): void => {
    this.observed.push(el);
  };

  /** Deliver a resize notification exactly as the browser would. */
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const invoke = vi.fn(async (command: string) => {
  if (command === 'get_pty_buffer') return [];
  return undefined;
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function setBox(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
}

function renderTerminal(active: boolean) {
  return renderWithChakra(<SessionTerminal sessionId="a" active={active} />);
}

beforeEach(() => {
  ghostty.fitCalls = 0;
  ghostty.resizeCb = null;
  ghostty.opened = null;
  ResizeObserverStub.instances = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  adapterBridge.setInvoke(invoke as never);
  adapterBridge.setListen((async () => () => {}) as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Spec 2934 FX-5 — window resize re-fits the active terminal only', () => {
  it('pushes resize_pty for the active session on a container resize', async () => {
    renderTerminal(true);
    await waitFor(() => expect(ResizeObserverStub.instances).toHaveLength(1));
    // Let the mount rAF fit settle (the initial box is 0×0 → no emit).
    await nextFrame();

    const el = ghostty.opened;
    expect(el).not.toBeNull();
    setBox(el!, 800, 384);

    invoke.mockClear();
    ResizeObserverStub.instances[0].trigger();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('resize_pty', {
        sessionId: 'a',
        rows: 24,
        cols: 100,
      }),
    );
  });

  it('never fits or resizes an inactive session on a container resize', async () => {
    renderTerminal(false);
    await waitFor(() => expect(ResizeObserverStub.instances).toHaveLength(1));
    await nextFrame();

    setBox(ghostty.opened!, 800, 384);
    const fitsBefore = ghostty.fitCalls;
    invoke.mockClear();

    ResizeObserverStub.instances[0].trigger();
    await nextFrame();
    await nextFrame();

    expect(ghostty.fitCalls).toBe(fitsBefore);
    expect(invoke).not.toHaveBeenCalledWith('resize_pty', expect.anything());
  });

  it('never fits or resizes when the observed box is 0×0', async () => {
    renderTerminal(true);
    await waitFor(() => expect(ResizeObserverStub.instances).toHaveLength(1));
    await nextFrame();

    // The box stays 0×0 (jsdom default).
    const fitsBefore = ghostty.fitCalls;
    invoke.mockClear();

    ResizeObserverStub.instances[0].trigger();
    await nextFrame();
    await nextFrame();

    expect(ghostty.fitCalls).toBe(fitsBefore);
    expect(invoke).not.toHaveBeenCalledWith('resize_pty', expect.anything());
  });
});

describe('Spec 2940 ST-2 — fit receipt (onFit) + canvas host hook', () => {
  it('publishes the applied dims via onFit after a resize and tracks a second resize', async () => {
    const onFit = vi.fn();
    renderWithChakra(<SessionTerminal sessionId="a" active onFit={onFit} />);
    await waitFor(() => expect(ResizeObserverStub.instances).toHaveLength(1));
    await nextFrame();

    setBox(ghostty.opened!, 800, 384);
    onFit.mockClear();
    ResizeObserverStub.instances[0].trigger();

    await waitFor(() => expect(onFit).toHaveBeenCalledWith(100, 24));

    // Continuous follow (R-1.6): a second pane size publishes the new grid.
    setBox(ghostty.opened!, 400, 320);
    onFit.mockClear();
    ResizeObserverStub.instances[0].trigger();

    await waitFor(() => expect(onFit).toHaveBeenCalledWith(50, 20));
  });

  it('never publishes a fit receipt from a zero-size box', async () => {
    const onFit = vi.fn();
    renderWithChakra(<SessionTerminal sessionId="a" active onFit={onFit} />);
    await waitFor(() => expect(ResizeObserverStub.instances).toHaveLength(1));
    await nextFrame();

    // The box stays 0×0 (jsdom default).
    onFit.mockClear();
    ResizeObserverStub.instances[0].trigger();
    await nextFrame();
    await nextFrame();

    expect(onFit).not.toHaveBeenCalled();
  });

  it('renders the canvas host with the session-scoped testid', async () => {
    const { getByTestId } = renderWithChakra(<SessionTerminal sessionId="s-42" active />);

    const host = getByTestId('terminal-canvas-host-s-42');
    expect(host).toBeInTheDocument();
    await waitFor(() => expect(ghostty.opened).toBe(host));
  });
});

/**
 * Spec 2942 ST-5 (ii)/(iv) — the settling push + the too-small-box floor.
 *
 * (ii) ONE unconditional `resize_pty` follows the mount fit even when ghostty's
 * FitAddon reports NO grid change (it is a no-op for an equal grid), which is the
 * deterministic form of the tester-proven "forced resize" behind the residual
 * "OpenCode TUI doesn't fill the pane" defect. (iv) The box floor: a transiently
 * tiny box (the documented 71×4 latch) is never fitted, published, or pushed.
 */
describe('Spec 2942 ST-5 — settling resize_pty + too-small-box floor', () => {
  /** This component's OWN `resize_pty` calls (never a global count — G-222). */
  const resizeCalls = () =>
    invoke.mock.calls.filter(([command]: unknown[]) => command === 'resize_pty');

  it('pushes exactly ONE settling resize_pty after the mount fit even when the grid is unchanged', async () => {
    // A box whose fitted grid EQUALS the terminal's initial 80×24 → the FitAddon
    // reports no change, so only the settling push can seed the PTY.
    const origWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    const origHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 384 });
    try {
      renderTerminal(true);

      await waitFor(() => expect(resizeCalls()).toHaveLength(1));
      expect(resizeCalls()[0]).toEqual(['resize_pty', { sessionId: 'a', rows: 24, cols: 80 }]);

      // The dedupe holds: a later mount/activation settling pass never re-pushes.
      await nextFrame();
      await nextFrame();
      expect(resizeCalls()).toHaveLength(1);
    } finally {
      if (origWidth) Object.defineProperty(Element.prototype, 'clientWidth', origWidth);
      if (origHeight) Object.defineProperty(Element.prototype, 'clientHeight', origHeight);
    }
  });

  it('never fits, publishes, or pushes from a transiently too-small box (the 71×4 latch)', async () => {
    const onFit = vi.fn();
    renderWithChakra(<SessionTerminal sessionId="a" active onFit={onFit} />);
    await waitFor(() => expect(ResizeObserverStub.instances).toHaveLength(1));
    await nextFrame();

    // The documented #2934 latch: a box below the floor in BOTH dimensions.
    setBox(ghostty.opened!, 71, 4);
    onFit.mockClear();

    ResizeObserverStub.instances[0].trigger();
    await nextFrame();
    await nextFrame();
    await nextFrame();

    expect(onFit).not.toHaveBeenCalled();
    expect(resizeCalls()).toHaveLength(0);
  });
});
