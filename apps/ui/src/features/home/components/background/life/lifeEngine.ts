/**
 * lifeEngine — the canvas-2D renderer for the Life desktop background, and the
 * ONE bounded `requestAnimationFrame` driver in the whole feature (Spec #2915,
 * ST-3).
 *
 * Responsibilities:
 *   - own the simulation + the canvas backing store, sized device-pixel-ratio
 *     aware but bounded to `LIFE_DPR_MAX` × the CSS viewport (a LINEAR ratio);
 *   - resolve the THREE paint tokens from the LIVE theme CSS custom properties
 *     (`--body-bg` ground, `--life-cell` dimmed cell, `--life-dim` scrim) —
 *     never a colour literal and never a `var(--x)NN` alpha-append;
 *   - paint ground → cells → EXACTLY ONE field-wide `--life-dim` scrim
 *     (`fillRect` over the finished frame), so the ground and the cells dim
 *     together and the cell-vs-ground ratio is preserved;
 *   - enforce the `LIFE_CONTRAST_MIN` legibility guard at token-resolution time
 *     (never per frame): if the resolved dimmed cell-vs-ground WCAG ratio falls
 *     below 3, paint the untransformed pair (`--accent-strong` cells, no scrim);
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
  LIFE_CONTRAST_MIN,
  LIFE_DPR_MAX,
  LIFE_ROWS_MAX,
  LIFE_STEP_MS,
} from './lifeConstants';
import { createLifeSimulation, type LifeSimulation } from './lifeSimulation';

/** The three theme tokens the paint consumes, resolved live (never literals). */
export interface LifeTokens {
  /** Backdrop ground — `--body-bg`. */
  ground: string;
  /** Live-cell colour — `--life-cell` (the dimmed `--accent-strong` expression). */
  cell: string;
  /** Field-wide scrim painted once over ground+cells — `--life-dim`. */
  dim: string;
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

/* -------------------------------------------------------------------------- */
/* #2925 ST-2 — WCAG contrast guard (token-resolution time only, never per     */
/* frame). It parses only the colour shapes the live theme can produce: hex,   */
/* rgb()/rgba(), `transparent`, and the `color-mix(in srgb, …)` expressions    */
/* the provider registers. Anything unrecognised yields null → the guard is    */
/* skipped and the authored dimmed pair is kept (fail-safe).                   */
/* -------------------------------------------------------------------------- */

interface LifeRgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function parseHexColor(value: string): LifeRgb | null {
  const hex = value.slice(1);
  let r: number;
  let g: number;
  let b: number;
  let a = 1;
  if (hex.length === 3 || hex.length === 4) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
    if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
  } else if (hex.length === 6 || hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
    if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
  } else {
    return null;
  }
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return { r, g, b, a };
}

function parseRgbFunction(value: string): LifeRgb | null {
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const parts = value.slice(open + 1, close).split(/[\s,/]+/).filter(Boolean);
  const channels = parts.slice(0, 3).map(Number);
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return null;
  }
  let alpha = parts.length >= 4 ? Number(parts[3]) : 1;
  if (!Number.isFinite(alpha)) alpha = 1;
  return {
    r: clampChannel(channels[0]),
    g: clampChannel(channels[1]),
    b: clampChannel(channels[2]),
    a: alpha,
  };
}

/** Split a comma list at parenthesis depth 0 (so nested `color-mix()` survives). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Resolve any supported CSS colour string to sRGB channels (+ alpha). */
function resolveLifeColor(value: string): LifeRgb | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (trimmed.startsWith('#')) return parseHexColor(trimmed);
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('rgb')) return parseRgbFunction(trimmed);
  if (lower.startsWith('color-mix')) return parseColorMix(trimmed);
  return null;
}

/** A `color-mix(in srgb, …)` stop: a resolved colour plus its optional weight. */
function parseMixStop(text: string): { color: LifeRgb; pct: number | null } | null {
  const trimmed = text.trim();
  const weightMatch = /(\d+(?:\.\d+)?)%\s*$/.exec(trimmed);
  const pct = weightMatch ? Number(weightMatch[1]) : null;
  const colorText = (weightMatch ? trimmed.slice(0, weightMatch.index) : trimmed).trim();
  const color = resolveLifeColor(colorText);
  return color ? { color, pct } : null;
}

/** Evaluate the exact `color-mix(in srgb, A p%, B q%)` form the provider emits. */
function parseColorMix(value: string): LifeRgb | null {
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const inner = value.slice(open + 1, close).trim();
  if (!inner.startsWith('in srgb')) return null;
  const comma = inner.indexOf(',');
  if (comma < 0) return null;
  const stops = splitTopLevel(inner.slice(comma + 1));
  if (stops.length !== 2) return null;
  const first = parseMixStop(stops[0]);
  const second = parseMixStop(stops[1]);
  if (!first || !second) return null;
  // A missing weight defaults to "the remaining share"; both missing = 50/50.
  const firstPct = first.pct ?? (second.pct === null ? 50 : 100 - second.pct);
  const secondPct = second.pct ?? (first.pct === null ? 50 : 100 - first.pct);
  const total = firstPct + secondPct;
  if (!(total > 0)) return null;
  const firstWeight = firstPct / total;
  const secondWeight = secondPct / total;
  return {
    r: first.color.r * firstWeight + second.color.r * secondWeight,
    g: first.color.g * firstWeight + second.color.g * secondWeight,
    b: first.color.b * firstWeight + second.color.b * secondWeight,
    a: first.color.a * firstWeight + second.color.a * secondWeight,
  };
}

/** sRGB gamma-decode (WCAG 2.x). */
function lifeSrgbToLinear(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB triple. */
function lifeRelativeLuminance(color: LifeRgb): number {
  return (
    0.2126 * lifeSrgbToLinear(color.r) +
    0.7152 * lifeSrgbToLinear(color.g) +
    0.0722 * lifeSrgbToLinear(color.b)
  );
}

/** WCAG contrast ratio between two colours. */
function lifeContrastRatio(a: LifeRgb, b: LifeRgb): number {
  const luminanceA = lifeRelativeLuminance(a);
  const luminanceB = lifeRelativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Resolve the THREE paint tokens from the LIVE computed theme custom properties
 * inherited by `canvas` (`--body-bg` ground, `--life-cell` dimmed cell,
 * `--life-dim` scrim). In a themed host the values are the resolved theme
 * colours; if a property is unavailable the token REFERENCE is returned (never a
 * hardcoded colour literal), so the engine source carries zero hex/rgb/hsl and
 * zero `var(--x)NN`.
 *
 * The `--life-cell` fallback is the resolved `--accent-strong` value — exactly
 * the "untransformed cell" the guard reverts to. The `LIFE_CONTRAST_MIN` guard
 * runs HERE (token resolution, never per frame): if the resolved cell-vs-ground
 * WCAG ratio falls below the floor, the untransformed pair is returned
 * (`--accent-strong` cell, no scrim). If either colour is unparseable the
 * authored dimmed pair is kept (fail-safe — never guess a breach).
 */
export function resolveLifeTokens(canvas: HTMLCanvasElement): LifeTokens {
  let computed: CSSStyleDeclaration | null = null;
  try {
    if (typeof getComputedStyle === 'function') computed = getComputedStyle(canvas);
  } catch {
    computed = null;
  }
  const ground = readToken(computed, '--body-bg', 'var(--body-bg)');
  const accentStrong = readToken(computed, '--accent-strong', 'var(--accent-strong)');
  const lifeCell = readToken(computed, '--life-cell', '');
  const dim = readToken(computed, '--life-dim', 'transparent');
  // No derived cell token registered (a host/tests without the provider pass):
  // behave exactly like #2915 — untransformed cells, no contrast guard.
  if (!lifeCell) return { ground, cell: accentStrong, dim };

  const groundRgb = resolveLifeColor(ground);
  const cellRgb = resolveLifeColor(lifeCell);
  if (
    groundRgb &&
    cellRgb &&
    groundRgb.a > 0 &&
    cellRgb.a > 0 &&
    lifeContrastRatio(cellRgb, groundRgb) < LIFE_CONTRAST_MIN
  ) {
    return { ground, cell: accentStrong, dim: 'transparent' };
  }
  return { ground, cell: lifeCell, dim };
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

    // #2925 ST-2 (M1) — EXACTLY ONE field-wide scrim over the finished frame.
    // `--life-dim` is a translucent black, so ground AND cells dim together and
    // the cell-vs-ground ratio is preserved. Constant cost: one extra fillRect,
    // no per-cell alpha, no second pass, no allocation. When the contrast guard
    // falls back it resolves to the `transparent` keyword — a no-op fill here.
    ctx.fillStyle = tokens.dim;
    ctx.fillRect(0, 0, width, height);
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
