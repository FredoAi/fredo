/**
 * lifeEngine — the canvas-2D renderer for the Life desktop background, and the
 * ONE bounded `requestAnimationFrame` driver in the whole feature (Spec #2915,
 * ST-3).
 *
 * Responsibilities:
 *   - own the simulation + the canvas backing store, sized device-pixel-ratio
 *     aware but bounded to `LIFE_DPR_MAX` × the CSS viewport (a LINEAR ratio);
 *   - resolve the two paint colours from the LIVE theme CSS custom properties
 *     (`--body-bg` ground, `--accent-strong` cell) — never a colour literal and
 *     never a `var(--x)NN` alpha-append;
 *   - drive generations at `LIFE_STEP_MS` through EXACTLY ONE rAF handle, with
 *     the policy re-seed on the same grid (no blank frame);
 *   - tear down completely: `destroy()` cancels the rAF and releases the canvas.
 *
 * The reduced-motion leg never starts: `createLifeEngine({reducedMotion: true})`
 * paints one seeded frame and the engine schedules ZERO rAF/timers. The React
 * binding (`LifeBackgroundCanvas.tsx`) owns the `ResizeObserver`,
 * `visibilitychange` listener and theme `MutationObserver` so it can mirror the
 * `data-life-*` hooks; `destroy()` is its single teardown entry point.
 *
 * No `setInterval`, no colour literal, no `@keyframes`.
 */

import {
  LIFE_CELL_PX,
  LIFE_COLS_MAX,
  LIFE_DPR_MAX,
  LIFE_ROWS_MAX,
  LIFE_STEP_MS,
} from './lifeConstants';
import { createLifeSimulation, type LifeSimulation } from './lifeSimulation';

/** The two theme colours the paint consumes, resolved live (never literals). */
export interface LifeTokens {
  /** Backdrop ground — `--body-bg`. */
  ground: string;
  /** Live-cell colour — `--accent-strong`. */
  cell: string;
}

export interface LifeEngineOptions {
  canvas: HTMLCanvasElement;
  /** True ⇒ paint exactly one seeded frame and schedule NOTHING. */
  reducedMotion: boolean;
  /** The per-load seed stamped as `data-life-seed`. */
  seed: number;
}

export interface LifeEngine {
  /** Animated leg only — schedules exactly ONE rAF handle (idempotent). */
  start(): void;
  /** Cancel the pending rAF, retain the grid state. */
  stop(): void;
  /** Exactly one generation + paint (the pure-test seam). */
  step(): void;
  /** Re-derive the grid (≤ caps) + backing store (≤ `LIFE_DPR_MAX` × CSS px). */
  resize(cssWidth: number, cssHeight: number): void;
  /** Re-read the live tokens and repaint (theme/accent change). */
  setTokens(tokens: LifeTokens): void;
  /** Policy-driven re-randomisation on the same grid (no blank frame). */
  reseed(): void;
  /** Cancel the rAF, release the canvas backing store; terminal. */
  destroy(): void;
  readonly running: boolean;
  readonly runningAttr: 'true' | 'false';
  readonly generation: number;
  readonly seed: number;
}

/** The default grid for a canvas whose size is not yet measurable (px). */
const FALLBACK_CSS_WIDTH = 320;
const FALLBACK_CSS_HEIGHT = 200;

/**
 * PURE grid derivation: one cell per `LIFE_CELL_PX` CSS px, clamped to
 * `LIFE_COLS_MAX × LIFE_ROWS_MAX` (EARS-14). Exported so the caps are pinned
 * without touching the canvas.
 */
export function deriveLifeGrid(
  cssWidth: number,
  cssHeight: number,
): { cols: number; rows: number } {
  const cols = Math.min(LIFE_COLS_MAX, Math.max(1, Math.ceil(cssWidth / LIFE_CELL_PX)));
  const rows = Math.min(LIFE_ROWS_MAX, Math.max(1, Math.ceil(cssHeight / LIFE_CELL_PX)));
  return { cols, rows };
}

/** Read one live theme custom property, falling back to its token reference. */
function readToken(
  computed: CSSStyleDeclaration | null,
  name: string,
  reference: string,
): string {
  if (computed) {
    const value = computed.getPropertyValue(name).trim();
    if (value) return value;
  }
  return reference;
}

/**
 * Resolve the two paint colours from the LIVE computed theme custom properties
 * inherited by `canvas` (`--body-bg` / `--accent-strong`). In a themed host the
 * values are the resolved theme colours; if the properties are unavailable the
 * token REFERENCE is returned (never a hardcoded colour literal), so the engine
 * source carries zero hex/rgb/hsl and zero `var(--x)NN`.
 */
export function resolveLifeTokens(canvas: HTMLCanvasElement): LifeTokens {
  let computed: CSSStyleDeclaration | null = null;
  try {
    if (typeof getComputedStyle === 'function') computed = getComputedStyle(canvas);
  } catch {
    computed = null;
  }
  return {
    ground: readToken(computed, '--body-bg', 'var(--body-bg)'),
    cell: readToken(computed, '--accent-strong', 'var(--accent-strong)'),
  };
}

/** The fraction of a cell left blank on each edge (a visual grid seam). */
const CELL_GAP_FRACTION = 0.14;

/** Create the Life canvas engine bound to `options.canvas`. */
export function createLifeEngine(options: LifeEngineOptions): LifeEngine {
  const { canvas, reducedMotion, seed } = options;

  const initialWidth =
    Number.isFinite(canvas.clientWidth) && canvas.clientWidth > 0
      ? canvas.clientWidth
      : FALLBACK_CSS_WIDTH;
  const initialHeight =
    Number.isFinite(canvas.clientHeight) && canvas.clientHeight > 0
      ? canvas.clientHeight
      : FALLBACK_CSS_HEIGHT;

  const initialGrid = deriveLifeGrid(initialWidth, initialHeight);
  let simulation: LifeSimulation = createLifeSimulation({
    cols: initialGrid.cols,
    rows: initialGrid.rows,
    seed,
  });
  let tokens: LifeTokens = resolveLifeTokens(canvas);
  let context: CanvasRenderingContext2D | null = null;
  let rafId: number | null = null;
  let running = false;
  let destroyed = false;
  let reseedCount = 0;
  let lastStepAt = Number.NEGATIVE_INFINITY;

  function getContext(): CanvasRenderingContext2D | null {
    if (context) return context;
    try {
      context = canvas.getContext('2d');
    } catch {
      context = null;
    }
    return context;
  }

  function paint(): void {
    const ctx = getContext();
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = tokens.ground;
    ctx.fillRect(0, 0, width, height);

    const { cols, rows } = simulation;
    const cellWidth = width / cols;
    const cellHeight = height / rows;
    const gapX = cellWidth * CELL_GAP_FRACTION;
    const gapY = cellHeight * CELL_GAP_FRACTION;
    const cellDrawWidth = Math.max(1, cellWidth - gapX * 2);
    const cellDrawHeight = Math.max(1, cellHeight - gapY * 2);
    const cells = simulation.snapshot();
    ctx.fillStyle = tokens.cell;
    for (let row = 0; row < rows; row++) {
      const rowOffset = row * cols;
      for (let col = 0; col < cols; col++) {
        if (cells[rowOffset + col] !== 1) continue;
        ctx.fillRect(
          col * cellWidth + gapX,
          row * cellHeight + gapY,
          cellDrawWidth,
          cellDrawHeight,
        );
      }
    }
  }

  function nextReseedSeed(): number {
    reseedCount += 1;
    return (seed + Math.imul(reseedCount, 0x9e3779b1)) >>> 0;
  }

  function reseedInternal(): void {
    simulation.reseed(nextReseedSeed());
  }

  /** One generation; apply the re-seed policy; repaint. */
  function advance(): void {
    if (destroyed) return;
    simulation.step();
    if (simulation.shouldReseed()) reseedInternal();
    paint();
  }

  function scheduleFrame(): void {
    if (destroyed || !running || rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    rafId = requestAnimationFrame(frame);
  }

  function frame(timestamp: number): void {
    rafId = null;
    if (destroyed || !running) return;
    if (timestamp - lastStepAt >= LIFE_STEP_MS) {
      lastStepAt = timestamp;
      advance();
    }
    scheduleFrame();
  }

  function start(): void {
    if (destroyed || reducedMotion || running) return;
    running = true;
    lastStepAt = Number.NEGATIVE_INFINITY;
    scheduleFrame();
  }

  function stop(): void {
    running = false;
    if (rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function resize(cssWidth: number, cssHeight: number): void {
    if (destroyed) return;
    const width = Math.max(1, Math.floor(cssWidth));
    const height = Math.max(1, Math.floor(cssHeight));
    const ratio =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio
        : 1;
    const dpr = Math.min(LIFE_DPR_MAX, ratio > 0 ? ratio : 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    if (canvas.style) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const grid = deriveLifeGrid(width, height);
    if (grid.cols !== simulation.cols || grid.rows !== simulation.rows) {
      simulation = createLifeSimulation({ cols: grid.cols, rows: grid.rows, seed });
    }
    paint();
  }

  function setTokens(next: LifeTokens): void {
    if (destroyed) return;
    tokens = next;
    paint();
  }

  function step(): void {
    if (destroyed) return;
    lastStepAt = Number.NEGATIVE_INFINITY;
    advance();
  }

  function reseed(): void {
    if (destroyed) return;
    reseedInternal();
    paint();
  }

  function destroy(): void {
    if (destroyed) return;
    stop();
    destroyed = true;
    context = null;
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      // Canvas already detached — nothing to release.
    }
  }

  // Initial seeded frame (no rAF) and the DPR-bounded backing store.
  resize(initialWidth, initialHeight);

  return {
    start,
    stop,
    step,
    resize,
    setTokens,
    reseed,
    destroy,
    get running() {
      return running;
    },
    get runningAttr() {
      return running ? 'true' : 'false';
    },
    get generation() {
      return simulation.generation;
    },
    get seed() {
      return seed;
    },
  };
}
